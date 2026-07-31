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
  }

  get active() { return this.regions[this.activeId] ?? null; }
  byId(id) { return this.regions[id] ?? null; }

  ownedCount() { return this.regions.reduce((n, r) => n + (r.owned ? 1 : 0), 0); }

  /** Regions you may expand into: not the active one, not already owned, adjacent to a region
   *  you hold (owned) or are currently standing in. */
  isExpandable(id) {
    const r = this.byId(id);
    if (!r || r.owned || id === this.activeId) return false;
    return r.neighbors.some(nid => nid === this.activeId || this.regions[nid].owned);
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
   *  imports this). */
  setActive(id) {
    if (!this.isExpandable(id)) return false;
    this.activeId = id;
    this.regions[id].visited = true;
    this.expansionCount++;
    return true;
  }

  serialize() {
    return {
      cols: this.cols, rows: this.rows, activeId: this.activeId,
      expansionCount: this.expansionCount,
      regions: this.regions.map(r => ({
        id: r.id, control: r.control, owned: r.owned, visited: r.visited, snapshot: r.snapshot,
      })),
    };
  }

  deserialize(json) {
    if (!json || !Array.isArray(json.regions)) return;
    this.activeId = json.activeId ?? this.activeId;
    this.expansionCount = json.expansionCount ?? 0;
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
