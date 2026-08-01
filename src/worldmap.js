// World map / conquest layer -- the RimWorld-style planet map with a Helldivers-2-style
// per-region control meter, plus RimWorld's "settlements feed each other resources" idea.
//
// Design decision (deliberate scope control): there is exactly ONE live, ticking SimWorld at a
// time -- the "active" region. Every other region is just a small record (control %, owned flag,
// and a cheap summary snapshot of how that settlement looked when you left it). Running 16 live
// sims simultaneously would multiply every perf/serialization concern in the project by 16 for
// very little gameplay gain, and the ask ("take over one area, settlements give each other
// resources, a control meter per section") is satisfied without it.
//
// This module holds a single module-level `worldMap` singleton rather than hanging off SimWorld,
// because the map has to OUTLIVE any individual SimWorld -- expanding to a new region throws the
// old SimWorld away and constructs a fresh one, and the conquest progress must survive that.

import { checkConquestAchievements } from './metaprogress.js';

const GRID_COLS = 4;
const GRID_ROWS = 4;

// 16 region names, wasteland-flavored, ordered row-major to match the 4x4 layout.
const REGION_NAMES = [
  'Ashfall Reach', 'Rustwater', 'The Cinder Flats', 'Kestrel Basin',
  'Slagmouth', 'Verdigris Hollow', 'Tannery Row', 'Dead Signal Ridge',
  'Coalpit Yards', 'Marrowfield', 'The Long Quiet', 'Saltbreak',
  'Ironvale', 'Hollow Cistern', 'Greyspur', 'Last Ferry',
];

// Tuning. CONTROL_BASE is per-tick; the multipliers below typically land the total gain around
// 0.015-0.03/tick in a healthy colony, i.e. a region flips to fully-owned in roughly 4-7k ticks
// (~7-12 min at 10Hz), comfortably inside the 22-36k-tick hands-off survival baseline the
// director is balanced around, so conquest is achievable without trivializing the siege loop.
const CONTROL_BASE = 0.006;
// Scrap each already-owned region trickles into whichever region is currently active, per tick.
// This is the "settlements giving each other resources" half of the ask.
const TRICKLE_PER_OWNED_REGION = 0.02;

// --- Odyssey-anchored expansion tuning (real gravship numbers, scaled to this game's economy) ---
//
// RimWorld Odyssey gravships require a real chemfuel reserve banked before they'll launch at all
// (no fuel, no launch, full stop) -- EXPANSION_FUEL_COST mirrors that as a flat scrap toll charged
// against the settlement you're LEAVING, deducted in setActive() before the move is allowed to
// happen at all. 15 sits deliberately mid-table against this file's existing constants: cheaper
// than a garage (economy.js: 35-45) since expansion is a strategic-layer action not a building,
// but a real bite out of the ~50 scrap a fresh settlement starts with (world.js) so it's a
// genuine choice, not a rounding error.
export const EXPANSION_FUEL_COST = 15;

// Every real gravship launch risks a LandingOutcomeDef mishap (crashed pods, fuel leak, hull
// damage) -- not guaranteed, but frequent enough that a career of launches WILL eventually eat one.
// 17.5% (mid-point of the requested 15-20%) reproduces that "rare per-trip, inevitable over a
// campaign" feel without punishing a single expansion hard: about 1 in 4-6 launches. Toned down
// from RimWorld's real crash-landing stakes (ship damage, pawns downed/killed) to fit this game's
// much lower-stakes single-scrap-resource economy -- a minor scrap loss or a short work-speed
// debuff, never a citizen casualty.
export const MISHAP_CHANCE = 0.175;
export const MISHAP_SCRAP_LOSS = 8;       // flat scrap lost from the freshly-arrived settlement
export const MISHAP_DEBUFF_TICKS = 500;   // ~50s at 10Hz -- "shaken crew," not a lasting injury

// Multi-hop travel range, gated behind a persistent scrap-paid upgrade -- mirrors Odyssey's real
// per-ship thruster/fuel-tank upgrade slots, which are a small, hard-capped number, not an
// unbounded tech tree. travelRange starts at 1 (today's adjacency-only behavior, unchanged for a
// player who never upgrades) and can be raised up to MAX_TRAVEL_RANGE (1 base + 4 upgrades,
// mirroring the "capped small" ask). Cost escalates per upgrade, same shape as a real thruster
// refit getting pricier each additional slot.
export const MAX_TRAVEL_RANGE = 5;
export const RANGE_UPGRADE_BASE_COST = 25;
export const RANGE_UPGRADE_COST_STEP = 20;

export class Region {
  constructor(id, name, col, row) {
    this.id = id;
    this.name = name;
    this.col = col;
    this.row = row;
    this.neighbors = [];   // region ids, 4-directional adjacency
    this.control = 0;      // 0-100, the Helldivers-2-style liberation meter
    this.owned = false;    // control hit 100 at some point
    this.visited = false;  // has ever been the active region
    this.snapshot = null;  // cheap summary of that settlement's last known state
  }
}

export class WorldMap {
  constructor(cols = GRID_COLS, rows = GRID_ROWS) {
    this.cols = cols;
    this.rows = rows;
    this.regions = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const id = row * cols + col;
        this.regions.push(new Region(id, REGION_NAMES[id] ?? `Region ${id}`, col, row));
      }
    }
    // 4-directional adjacency over the grid -- doesn't need to be real geography, it just needs
    // to make "expand to an adjacent region" a meaningful spatial choice.
    for (const r of this.regions) {
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = r.col + dc, rr = r.row + dr;
        if (c < 0 || rr < 0 || c >= cols || rr >= rows) continue;
        r.neighbors.push(rr * cols + c);
      }
    }
    // Start in the middle-ish of the map so there are neighbors in every direction.
    this.activeId = 5;
    this.regions[this.activeId].visited = true;
    this.expansionCount = 0;
    // Odyssey-anchored additions (see the constants block above for the real-numbers rationale):
    this.travelRange = 1;      // hop range for isExpandable -- 1 == original adjacency-only behavior
    this.pendingMishap = null; // set by setActive() when a launch mishap rolls; consumed by the
                                // caller once the fresh SimWorld exists (worldmap.js never
                                // imports world.js, so it can't apply the effect itself -- see
                                // setActive()'s own comment).
  }

  get active() { return this.regions[this.activeId] ?? null; }
  byId(id) { return this.regions[id] ?? null; }

  ownedCount() { return this.regions.reduce((n, r) => n + (r.owned ? 1 : 0), 0); }

  /** Shortest hop count from {activeId} ∪ {every owned region} to `id`, over the 4-directional
   *  adjacency graph, capped at travelRange+1 hops of search (cheap: 16 regions total). Returns
   *  Infinity if unreachable within that bound. At travelRange === 1 this reproduces the original
   *  "neighbor of active OR neighbor of an owned region" rule exactly. */
  _hopDistance(id) {
    const start = [this.activeId, ...this.regions.filter(r => r.owned).map(r => r.id)];
    const dist = new Map();
    let frontier = [];
    for (const s of start) { if (!dist.has(s)) { dist.set(s, 0); frontier.push(s); } }
    for (let hop = 0; hop < this.travelRange && frontier.length; hop++) {
      const next = [];
      for (const nid of frontier) {
        for (const adj of this.regions[nid].neighbors) {
          if (dist.has(adj)) continue;
          dist.set(adj, hop + 1);
          next.push(adj);
        }
      }
      frontier = next;
    }
    return dist.has(id) ? dist.get(id) : Infinity;
  }

  /** Regions you may expand into: not the active one, not already owned, reachable within
   *  travelRange hops of a region you hold (owned) or are currently standing in. travelRange
   *  starts at 1 (direct adjacency only, the original behavior) and can be raised via
   *  upgradeTravelRange(). */
  isExpandable(id) {
    const r = this.byId(id);
    if (!r || r.owned || id === this.activeId) return false;
    return this._hopDistance(id) <= this.travelRange;
  }

  expandableIds() { return this.regions.filter(r => this.isExpandable(r.id)).map(r => r.id); }

  /** Freeze what the active region looked like before we walk away from it. */
  bankActive(world) {
    const r = this.active;
    if (!r || !world) return;
    r.snapshot = summarize(world);
  }

  /** Move the operation. Caller is responsible for constructing the fresh SimWorld -- this
   *  module deliberately doesn't import world.js (would be a circular import, and world.js
   *  imports this).
   *
   *  `world` is the settlement you're LEAVING (still alive at call time, discarded right after).
   *  Mirrors a real gravship launch: EXPANSION_FUEL_COST must already be banked there, and it's
   *  spent whether or not it carries forward into the new settlement (it doesn't -- every fresh
   *  SimWorld starts at a fixed 50 scrap, see world.js) -- the toll is a real gate on the decision,
   *  same as RimWorld requiring chemfuel already loaded before a gravship will lift off at all.
   *  Refuses (returns false, no state changed) if either the destination isn't reachable or the
   *  fuel isn't there.
   *
   *  On a successful launch, rolls the LandingOutcomeDef-style arrival mishap and stashes the
   *  result on `this.pendingMishap` for the caller to apply once the new SimWorld for `id` exists
   *  (worldmap.js can't apply it directly -- no world.js import, see above). */
  setActive(id, world) {
    if (!this.isExpandable(id)) return false;
    if (!world || world.scrap < EXPANSION_FUEL_COST) return false;
    world.scrap -= EXPANSION_FUEL_COST;
    this.activeId = id;
    this.regions[id].visited = true;
    this.expansionCount++;
    this.pendingMishap = rollArrivalMishap();
    return true;
  }

  /** Scrap cost of the NEXT travel-range upgrade (escalates per level, same shape as a real
   *  thruster refit getting pricier each additional slot). */
  rangeUpgradeCost() {
    return RANGE_UPGRADE_BASE_COST + (this.travelRange - 1) * RANGE_UPGRADE_COST_STEP;
  }

  /** Spend scrap from `world` to raise travelRange by 1, capped at MAX_TRAVEL_RANGE. Refuses
   *  (returns false, no state changed) if already at the cap or scrap is short. */
  upgradeTravelRange(world) {
    if (this.travelRange >= MAX_TRAVEL_RANGE) return false;
    const cost = this.rangeUpgradeCost();
    if (!world || world.scrap < cost) return false;
    world.scrap -= cost;
    this.travelRange++;
    return true;
  }

  serialize() {
    return {
      cols: this.cols, rows: this.rows, activeId: this.activeId,
      expansionCount: this.expansionCount, travelRange: this.travelRange,
      regions: this.regions.map(r => ({
        id: r.id, control: r.control, owned: r.owned, visited: r.visited, snapshot: r.snapshot,
      })),
    };
  }

  deserialize(json) {
    if (!json || !Array.isArray(json.regions)) return;
    this.activeId = json.activeId ?? this.activeId;
    this.expansionCount = json.expansionCount ?? 0;
    this.travelRange = json.travelRange ?? 1;
    for (const rec of json.regions) {
      const r = this.byId(rec.id);
      if (!r) continue;
      r.control = rec.control ?? 0;
      r.owned = !!rec.owned;
      r.visited = !!rec.visited;
      r.snapshot = rec.snapshot ?? null;
    }
  }
}

/** LandingOutcomeDef-style roll: MISHAP_CHANCE of anything firing at all, then a 50/50 split
 *  between the two toned-down outcomes described in the constants block above. Uses Math.random()
 *  rather than a SimWorld's deterministic rng -- this fires at a menu-driven decision point (the
 *  old world is about to be discarded, the new one doesn't exist yet), the same non-deterministic
 *  spot main.js's expandTo() already picks the new settlement's random seed from. */
function rollArrivalMishap() {
  if (Math.random() >= MISHAP_CHANCE) return null;
  if (Math.random() < 0.5) return { kind: 'scrapLoss', amount: MISHAP_SCRAP_LOSS };
  return { kind: 'debuff', ticks: MISHAP_DEBUFF_TICKS };
}

function summarize(world) {
  let alive = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) alive++;
  let built = 0;
  for (const s of world.structures) if (!s.destroyed && !s.underConstruction) built++;
  return {
    tick: world.currentTick,
    waves: world.waveSpawner?.waveNumber ?? 0,
    citizens: alive,
    scrap: Math.round(world.scrap),
    structures: built,
    fallen: !!world.gameOver,
  };
}

// The one live map instance. Flat-bundle friendly (build.py strips import/export, so this is a
// plain global in game.bundle.js and can be poked directly from the console for verification).
export const worldMap = new WorldMap();

/**
 * Called once per SimWorld.tick(). Two jobs:
 *  1. Push the active region's control meter up based on how the settlement is actually doing.
 *  2. Trickle scrap in from every OTHER fully-owned region (the resource-sharing part of the ask).
 * Additive only -- it never replaces or gates the existing scrap economy.
 */
export function tickWorldMap(world) {
  const wm = worldMap;
  const r = wm.active;
  if (!r || !world) return;

  let alive = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) alive++;
  const waves = world.waveSpawner?.waveNumber ?? 0;

  if (!r.owned) {
    // Same *signals* colonyStrength() reads (population, banked scrap) plus waves-survived,
    // recombined for a different purpose. Deliberately NOT calling colonyStrength() itself:
    // that function is balance-critical for the director and other work depends on it staying
    // stable, so this reads the raw world state instead of coupling to it.
    const popTerm = 0.3 + Math.min(1, alive / 12);           // 0.3 .. 1.3
    const waveTerm = 1 + waves * 0.2;                        // holding ground is the main driver
    const scrapTerm = 1 + Math.min(1, Math.sqrt(Math.max(0, world.scrap)) / 20); // 1 .. 2
    const gain = CONTROL_BASE * popTerm * waveTerm * scrapTerm;
    r.control = Math.min(100, r.control + gain);
    if (r.control >= 100) {
      r.owned = true;
      world.milestoneLog.push({ tick: world.currentTick, text: `${r.name} is fully under your control` });
      if (world.milestoneLog.length > 20) world.milestoneLog.shift();
      // metaprogress.js's Conquest achievements -- checked right here, the instant a region flips
      // to owned, rather than polled from tick().
      checkConquestAchievements(wm);
    }
  } else {
    r.control = 100;
  }

  // Supply lines: every other region you hold ships scrap to wherever you're currently standing.
  let others = 0;
  for (const o of wm.regions) if (o.owned && o.id !== r.id) others++;
  if (others > 0) world.addScrap(others * TRICKLE_PER_OWNED_REGION, 'conquest');

  // Keep the map's view of the active region fresh so the overlay shows live numbers.
  if ((world.currentTick & 15) === 0) r.snapshot = summarize(world);
}
