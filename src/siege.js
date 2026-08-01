// Ported/condensed from SD.Siege (wave spawner, AttackerStore, turret/fence/trap placement +
// combat resolution, scrap rewards).
import { SCRAP_PER_KILL, BUILD_COST } from './economy.js';
import { CitizenFlags } from './citizens.js';
import { isPoweredAt, hasPoweredBonus } from './power.js';
import { PASSION_GAIN_MULT } from './backstories.js';
import { WEAPON_TIERS } from './security.js';

// ---------------------------------------------------------------- enemy archetypes
// RimWorld/SEA:R-style raider roster: every attacker used to be identical except for a flat
// health multiplier scaled by wave number, so no defense layout was ever better or worse than
// another. Four archetypes with genuinely different stat shapes give waves texture and make the
// damage-type table below actually matter.
export const AttackerKind = Object.freeze({
  Grunt: 0,
  Brute: 1,
  Skirmisher: 2,
  Boss: 3,
});

// healthMult/speedMult/damageMult multiply the baseline constants further down this file.
// contactRange: a Boss reaches further than everyone else, which (because tickAttackerVsCitizens
// damages EVERY citizen inside contact range) reads as a cleaving area attack rather than the
// single-target poke a Grunt makes -- that's the Boss's "unique attack".
//
// combatPower: RimWorld-style raid-budget cost (see WaveSpawner.fillWaveBudget below). Loosely
// justified from this table's own stats rather than copied from RimWorld's real numbers --
// Grunt is the 1.0/1.0/1.0 baseline so it anchors the unit cost (35, matching RimWorld's
// cheapest tier). Brute's health*damage product is ~2.5x Grunt's (1.8*1.4=2.52) and its 0.65
// kinetic resistance makes it materially tankier against turrets specifically (the primary
// defense), so it costs roughly 2x Grunt (70) rather than the full 2.5x -- its 0.5 speed is a
// real downside that keeps it from costing as much as its raw stats alone would suggest.
// Skirmisher's raw health*damage product is LOWER than Grunt's (0.45*0.7=0.315) -- it dies fast
// to focus fire -- but its 1.9x speed means it closes distance and gets more contact ticks in
// before turrets/staff can respond, which is a real threat dimension the flat stats don't
// capture; priced above Grunt (45) for that mobility, well below Brute since it still melts
// under sustained fire. Boss is priced highest by a wide margin (150): 5x health, 2.2x damage,
// AND a 1.3 contactRange that cleaves every citizen in range per tick (not a single-target poke
// like the other three) -- a compounding multiplier, not just an additive stat bump.
//
// BALANCE-CRITICAL, soak-tested. A first pass at (Brute 2.6hp/0.5-kinetic, Boss 9.0hp, 12% boss
// roll) dropped hands-off survival ~28% below the same-build baseline and put a Boss in over half
// of all waves. These numbers were swept until three-seed mean survival matched the pre-archetype
// baseline of the same build almost exactly (21.0k vs 21.0k ticks). Retune only against a fresh
// A/B soak -- the effective toughness of a Brute is healthMult x its kinetic ARMOR_RATING below,
// not healthMult alone, so the two tables have to move together.
export const ATTACKER_ARCHETYPES = Object.freeze([
  { name: 'Grunt',      healthMult: 1.0,  speedMult: 1.0, damageMult: 1.0, contactRange: 0.5, combatPower: 35 },
  { name: 'Brute',      healthMult: 1.8,  speedMult: 0.5, damageMult: 1.4, contactRange: 0.6, combatPower: 70 },
  { name: 'Skirmisher', healthMult: 0.45, speedMult: 1.9, damageMult: 0.7, contactRange: 0.5, combatPower: 45 },
  { name: 'Boss',       healthMult: 5.0,  speedMult: 0.7, damageMult: 2.2, contactRange: 1.3, combatPower: 150 },
]);

export function archetypeOf(kind) {
  return ATTACKER_ARCHETYPES[kind] || ATTACKER_ARCHETYPES[AttackerKind.Grunt];
}

export function costOf(kind) {
  return archetypeOf(kind).combatPower;
}

// ---------------------------------------------------------------- weapon / armor damage types
// RimWorld's ACTUAL armor mechanic (Stats_Apparel.xml / DamageArmorCategoryDefs.xml), not a flat
// multiplier table: effectiveArmor = armorRating% - armorPenetration%, roll 0-100 --
//   roll <  effectiveArmor/2        -> full deflect, zero damage
//   effectiveArmor/2 <= roll <= effectiveArmor -> damage HALVED and converted to a generic
//                                       physical hit (RimWorld converts to Blunt; we don't model
//                                       a separate blunt-armor stat, so this is a reporting label,
//                                       see resolveArmorRoll's `outcome`)
//   roll >  effectiveArmor          -> full damage passes through
// Condensed to three legible damage types instead of RimWorld's full sharp/blunt/heat matrix.
//
//   Kinetic   -- turrets, guard sidearms, K9 bites (the bread-and-butter defense)
//   Explosive -- traps (one-shot burst placements)
//   Energy    -- tesla coils, sniper rifles (expensive/slow, but shreds heavy armor)
// Blunt exists only as the reported outcome-conversion label above; nothing deals it and no
// archetype has Blunt armor, so it never needs a table lookup of its own.
export const DamageType = Object.freeze({
  Kinetic: 0,
  Explosive: 1,
  Energy: 2,
  Blunt: 3,
});

// [kind][damageType] -> armor rating, 0-100 (same units as armorPenetration below, so
// effectiveArmor = armor - penetration lands on the roll's own 0-100 scale). This REPLACES the
// old flat RESISTANCE multiplier table but was deliberately chosen to reproduce the same
// rock-paper-scissors relationships *on average* -- see the big comment above
// ATTACKER_ARCHETYPES; the matchups matter more than the literal old numbers.
//   Brute: heavy plate (high Kinetic armor) shrugs off bullets on average, but has almost no
//     Explosive armor -- a mine still reliably blows through -> bring traps.
//   Skirmisher: near-zero Kinetic armor (bullets tear it up on average) but real Explosive armor
//     (fast enough to be mostly clear of the blast radius) -- traps are wasted on it.
//   Boss: solid armor against both Kinetic and Explosive; effectively unarmored against Energy --
//     the answer is tesla/snipers, not more turrets or traps.
export const ARMOR_RATING = Object.freeze([
  /* Grunt      */ Object.freeze([20, 20, 20]),
  /* Brute      */ Object.freeze([70, 5,  20]),
  /* Skirmisher */ Object.freeze([5,  75, 20]),
  /* Boss       */ Object.freeze([55, 35, 0]),
]);

// [kind][damageType] -> extra multiplier applied ONLY on a full-damage hit that lands with
// effectiveArmor <= 0 (i.e. the archetype has no armor advantage at all against that damage type
// -- deflect/half-damage are impossible in that case, so every hit is already guaranteed "full").
// This is where the old table's >1.0 "vulnerable" entries live now, since a pure armor-vs-
// penetration roll can only ever fully stop, halve, or pass damage through -- it can't amplify it.
// Undefined/missing entries default to 1.0 (no bonus, matches the old table's baseline 1.0s).
const VULNERABILITY = Object.freeze({
  // Brute vs Explosive: old table was a flat 1.75x (mines are its hard counter).
  1: Object.freeze([1, 1.75, 1]),
  // Skirmisher vs Kinetic: old table was a flat 1.35x (unarmored, bullets tear it up).
  2: Object.freeze([1.35, 1, 1]),
  // Boss vs Energy: old table was a flat 1.5x (energy weapons are the intended answer).
  3: Object.freeze([1, 1, 1.5]),
});

function vulnerabilityMult(kind, damageType) {
  const row = VULNERABILITY[kind];
  const m = row?.[damageType];
  return m === undefined ? 1 : m;
}

export function armorRatingOf(kind, damageType) {
  const row = ARMOR_RATING[kind] || ARMOR_RATING[AttackerKind.Grunt];
  const v = row[damageType];
  return v === undefined ? 20 : v;
}

// Live outcome tally, reset-able from the console for soak-testing (see SESSION_HANDOFF.md's
// window.__debug pattern -- this file's exports are plain globals in the flat bundle, so
// `armorStats` / `resetArmorStats()` are directly reachable from the browser console).
export const armorStats = { deflect: 0, half: 0, full: 0 };
export function resetArmorStats() {
  armorStats.deflect = 0; armorStats.half = 0; armorStats.full = 0;
}

// The actual 3-outcome roll described at the top of this section. `amount` is the pre-roll base
// damage; returns { dealt, outcome } where outcome is 'deflect' | 'half' | 'full' (reported as
// DamageType.Blunt-flavored when 'half', per the comment above). Tallies armorStats as a side
// effect so soak tests can confirm a real mix of outcomes rather than one branch always firing.
export function resolveArmorRoll(kind, damageType, amount, penetration, rng = Math.random) {
  const armor = armorRatingOf(kind, damageType);
  const effectiveArmor = armor - penetration;
  const roll = rng() * 100;
  let outcome, dealt;
  if (effectiveArmor > 0 && roll < effectiveArmor / 2) {
    outcome = 'deflect'; dealt = 0;
  } else if (effectiveArmor > 0 && roll <= effectiveArmor) {
    outcome = 'half'; dealt = amount * 0.5;
  } else {
    outcome = 'full'; dealt = amount * vulnerabilityMult(kind, damageType);
  }
  armorStats[outcome]++;
  return { dealt, outcome };
}

export class AttackerStore {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.health = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.kind = new Uint8Array(capacity); // AttackerKind enum, same SoA style as the rest
  }

  // `health` is the wave-scaled base health; the archetype's own healthMult is applied here so
  // callers (WaveSpawner, tests, console pokes) never have to remember to do it themselves.
  spawn(x, y, health = 1, kind = AttackerKind.Grunt) {
    const hp = health * archetypeOf(kind).healthMult;
    if (this.count >= this.capacity) {
      // recycle a dead slot rather than growing, matches the fixed-capacity C# store
      for (let i = 0; i < this.count; i++) {
        if (!this.alive[i]) {
          this.x[i] = x; this.y[i] = y; this.health[i] = hp; this.alive[i] = 1; this.kind[i] = kind;
          return i;
        }
      }
      return -1;
    }
    const i = this.count++;
    this.x[i] = x; this.y[i] = y; this.health[i] = hp; this.alive[i] = 1; this.kind[i] = kind;
    return i;
  }

  isAliveAt(i) {
    return this.alive[i] === 1;
  }

  archetypeAt(i) {
    return archetypeOf(this.kind[i]);
  }
}

// Weather-scaled hit roll (RimWorld WeatherDefs/Weathers.xml accuracy modifiers, see weather.js's
// weatherAccuracyMult): a single choke point every ranged/contact damage-resolution site below
// calls before actually applying damage, so a Fog/Rain/Snow/RainyThunderstorm accuracy penalty
// can never be forgotten at one of them, matching damageAttacker's role for resistance. Applied
// symmetrically -- turret/guard/sniper fire AND attacker hits vs citizens both roll against the
// same map-wide accuracyMult, same as RimWorld's single shared modifier rather than a one-sided
// player buff/debuff. accuracyMult defaults to 1 (always hits) so every call site remains
// backward-compatible for tests/console pokes that don't pass weather state.
export function rollsHit(rng, accuracyMult = 1) {
  return (rng ? rng() : Math.random()) < accuracyMult;
}

// Single choke point for every "something hurt an attacker" site in the codebase, so the
// armor-vs-penetration roll can never be forgotten at one of them. `penetration` is the dealing
// side's armorPenetration (0-100, same units as ARMOR_RATING -- see resolveArmorRoll above);
// `rng` defaults to Math.random so every existing call site (tests, console pokes, security.js's
// dog bites) keeps working without threading a seeded rng through, but real gameplay call sites
// below pass the world's own seeded `this.rng` for determinism/replay/save-load consistency.
// Returns true if this hit killed.
export function damageAttacker(attackers, i, amount, damageType = DamageType.Kinetic, penetration = 0, rng = Math.random) {
  if (!attackers.isAliveAt(i)) return false;
  const { dealt } = resolveArmorRoll(attackers.kind[i], damageType, amount, penetration, rng);
  attackers.health[i] -= dealt;
  if (attackers.health[i] <= 0) {
    attackers.alive[i] = 0;
    return true;
  }
  return false;
}

// Per-kind construction work, RimWorld-inspired (real RimWorld WorkToBuild spans roughly a 340x
// range from wire/conduit, the cheapest/fastest, up to watermill/geothermal-tier buildings) but
// compressed way down from that real spread so nothing is tediously slow at this game's ~10
// ticks/sec pace over a normal session -- see the buildWorkMultFor soak-test note in
// SESSION_HANDOFF.md for the numbers this was tuned against. Derived from each kind's BUILD_COST
// (economy.js) via sqrt, which keeps the low end near 1x (cheap structures build about as fast as
// they always did) while damping the high end so a $90 nuclear generator isn't 90x slower than a
// $1 wire, just meaningfully slower -- clamped to [1, 8] so even the priciest buildable finishes
// in well under two minutes at skill 0 (see jobs.js's BUILD_RATE). Roughly buckets into three
// tiers matching BUILD_COST's own tiers: cheap (wire/fence/door/pipe/wall, mult ~1-2), mid
// (trap/turret/generator/watchtower/pump/floodlight/armory, mult ~3.5-5.5), heavy
// (tesla/recycling_center/garage_*_electric/generator_nuclear, mult ~6-8).
const DEFAULT_BUILD_WORK_MULT = 2; // mid-tier fallback for any future kind added to BUILD_COST
                                    // (or economy.js entirely) without a soak-tested tier of its
                                    // own -- new buildables skew mid/heavy far more often than
                                    // "trivial", so this is a safer default than 1.
function buildWorkMultFor(kind) {
  const cost = BUILD_COST[kind];
  if (cost == null) return DEFAULT_BUILD_WORK_MULT;
  return Math.max(1, Math.min(8, Math.sqrt(cost)));
}

export class Structure {
  constructor(kind, x, y, opts = {}) {
    this.kind = kind; // 'turret' | 'fence' | 'trap' | 'bed' | 'table' | 'door' | 'generator' | 'wire' | 'wall' |
                      // 'generator_nuclear' | 'waste_storage' | 'generator_coal' | 'generator_wind' |
                      // 'generator_solar' | 'battery' | 'power_switch' (SEA:R multi-source power
                      // economy, see power.js's isSource) | 'workshop' (Prison Architect
                      // materials-chain analog, see jobs.js's Processing job)
    this.x = x; this.y = y;
    this.health = kind === 'fence' ? 0.6 : 1;
    this.destroyed = false;
    this.cooldown = 0;
    this.triggered = false; // traps: single-use
    // 'workshop' staffing (see jobs.js's Processing job, mirrors vehicles.js's Vehicle.driverId):
    // citizen id currently working this station, or null if unstaffed. Unused by other kinds.
    this.workerId = null;
    // 'workshop' work-in-progress countdown: ticks remaining to finish the unit currently being
    // processed (0 = idle/between units). Unused by other kinds.
    this._workTimer = 0;
    // Battery (power.js's storage mechanic, real RimWorld efficiency=0.5 tradeoff -- half of
    // stored power is lost on discharge): current charge, tickBatteries (power.js) is the only
    // thing that mutates this after construction.
    if (kind === 'battery') this.storedEnergy = 0;
    // Power switch (power.js's isConductor): manual on/off toggle for a conductor tile, flipped
    // by clicking an existing one with the Power Switch tool selected (see input.js _onDown).
    // Defaults on so a freshly-built switch doesn't silently dead-end the segment it's part of.
    if (kind === 'power_switch') this.switchedOn = true;
    // Blueprint/construction pipeline (RimWorld-style: place an order, a citizen builds it over
    // time instead of it appearing instantly) -- opts.instant skips this for the wave-4-starter
    // turrets so a fresh colony isn't defenseless while nobody has built anything yet.
    this.underConstruction = !opts.instant;
    this.buildProgress = opts.instant ? 1 : 0;
    this.claimedBy = null;
    // Per-kind construction-time multiplier, see buildWorkMultFor above -- jobs.js's Building
    // job state divides its per-tick progress rate by this. Computed here (not looked up fresh
    // every tick) so it's a stable, save/load-safe snapshot even if BUILD_COST balance changes
    // later; deserialize's Object.assign(new Structure(...), saved) leaves this alone when an
    // older save doesn't have the field, which correctly re-derives it from `kind` instead.
    this.buildWorkMult = buildWorkMultFor(kind);
    // Audio hook bookkeeping (world.js's structure-filter pass): tracks whether the
    // build-complete cue has already fired for this structure, so an instant/starter structure
    // (never actually "under construction") doesn't trigger it, and a real blueprint only
    // triggers it once, right when underConstruction flips false.
    this._builtNotified = !this.underConstruction;
  }
}

// RimWorld's raid "arrival methods": the same raid points spent a different way. Edge is the
// original walk-in-from-off-map behaviour; Tunnel drops the raiders straight into the settlement
// interior, bypassing the whole perimeter of fences/traps/turret kill-boxes.
export const ArrivalMethod = Object.freeze({
  Edge: 0,
  Tunnel: 1,
});

// Roster-composition rates, soak-tested alongside ATTACKER_ARCHETYPES/ARMOR_RATING -- see the
// balance note on ATTACKER_ARCHETYPES before touching any of these.
const BRUTE_RATE = 0.15;
const SKIRMISHER_RATE = 0.35;
const BOSS_MIN_WAVE = 8;
const BOSS_WAVE_GAP = 5;   // minimum waves between two Bosses
const BOSS_CHANCE = 0.05;  // per-attacker roll, only once the two gates above pass

const TUNNEL_MIN_WAVE = 4;          // no burrowing before the colony has had a chance to build anything
const TUNNEL_BASE_CHANCE = 0.08;
const TUNNEL_MAX_CHANCE = 0.35;
const TUNNEL_CLUSTER_RADIUS = 2.2;  // how tightly the emerging group is packed around the mouth

export class WaveSpawner {
  constructor(grid) {
    this.grid = grid;
    this.nextWaveTick = 300; // 30s at 10Hz, first wave grace period
    this.waveNumber = 0;
    this.strengthFactor = 1; // set by director.js each tick
    this.cycleMult = 1; // storyteller-personality breather-length multiplier
    this.doubleChance = 0.1; // odds of immediately queuing a second wave close behind
    this.lastArrival = ArrivalMethod.Edge; // for the event log / debug inspection
    this.lastTunnelPoint = null; // {x,y} of the most recent tunnel mouth, used by render.js
  }

  // Soak-tested and BALANCE-CRITICAL (see director.js's colonyStrength/strengthFactor). No
  // longer a literal spawn count -- see wavePoints() below, which reuses this exact expression
  // as a points budget denominated in Grunt-equivalents, so every existing tuning knob
  // (strengthFactor from director.js, the waveNumber*1.5 ramp) still drives difficulty exactly
  // the way it always did. Kept as its own method (rather than folded into wavePoints) because
  // tests/siege.test.js and the tunnel-wave 0.7x discount both still reason in these units.
  //
  // The bonus term used to cap at +10 (hit by wave ~7), which let strengthFactor's per-tick
  // variation invert the intended "later waves are at least as big" ordering once two waves were
  // far enough apart in wave number but close enough in the (now-flat) capped bonus -- e.g. wave 5
  // (bonus 7.5) vs wave 20 (bonus capped at 10, only a 1.26x margin) could flip if strengthFactor
  // happened to differ between the two. Capping the *ramp*, not the total, at 40 instead removes
  // that inversion risk across any realistic wave count this game reaches (soak tests top out well
  // under wave 40) while still bounding the term so it can't grow unboundedly forever.
  waveCount() {
    return Math.round((2 + Math.min(40, this.waveNumber * 1.5)) * this.strengthFactor);
  }

  waveBaseHealth() {
    return (1 + this.waveNumber * 0.1) * Math.max(0.7, this.strengthFactor);
  }

  // Points budget for one wave (RimWorld raid-points model), denominated in Grunt-equivalents
  // (costOf(Grunt) = 35) so waveCount()'s existing tuned scaling curve carries over unchanged --
  // this is purely a reinterpretation of the same number, not a new formula.
  wavePoints() {
    return this.waveCount() * costOf(AttackerKind.Grunt);
  }

  // Weighted, budget-aware archetype pick -- used by fillWaveBudget below, not called with a
  // finite remainingBudget from anywhere else. Boss keeps its original three-way gate (wave
  // floor, cooldown since the last one, per-roll chance) exactly as before, plus a new budget
  // gate (never picked if it doesn't fit what's left of the wave's points). Grunt/Skirmisher/
  // Brute are then chosen with the same BRUTE_RATE/SKIRMISHER_RATE weights as the old fixed-slot
  // system, restricted to whichever of them are both wave-unlocked AND affordable right now --
  // Grunt (the cheapest, always affordable once anything is) is always a candidate so this never
  // fails to resolve.
  rollKind(rng, bossAllowed, remainingBudget = Infinity) {
    const bossReady = this.waveNumber >= BOSS_MIN_WAVE &&
      (this._lastBossWave == null || this.waveNumber - this._lastBossWave >= BOSS_WAVE_GAP);
    if (bossAllowed && bossReady && remainingBudget >= costOf(AttackerKind.Boss) && rng() < BOSS_CHANCE) {
      this._lastBossWave = this.waveNumber;
      return AttackerKind.Boss;
    }

    const candidates = [[AttackerKind.Grunt, 1 - BRUTE_RATE - SKIRMISHER_RATE]];
    if (this.waveNumber >= 2 && remainingBudget >= costOf(AttackerKind.Skirmisher)) {
      candidates.push([AttackerKind.Skirmisher, SKIRMISHER_RATE]);
    }
    if (this.waveNumber >= 3 && remainingBudget >= costOf(AttackerKind.Brute)) {
      candidates.push([AttackerKind.Brute, BRUTE_RATE]);
    }
    const totalWeight = candidates.reduce((sum, [, w]) => sum + w, 0);
    let r = rng() * totalWeight;
    for (const [kind, w] of candidates) {
      if (r < w) return kind;
      r -= w;
    }
    return AttackerKind.Grunt;
  }

  // Real RimWorld-style raid composition: fill a points budget by repeatedly picking an
  // affordable archetype (weighted by rollKind above) until what's left can't afford even the
  // cheapest kind. Replaces the old "roll N independent fixed-percentage slots" approach, which
  // scaled attacker count and per-unit health together and could never trade "many weak" for
  // "few strong" within one wave -- a wave can now spend the same total threat budget as either a
  // dozen Grunts or a couple of Brutes plus some Skirmishers, whichever rollKind's weighted rolls
  // land on. `guard` bounds iterations purely defensively against a pathological infinite loop;
  // it never fires in practice since remaining strictly decreases by at least the cheapest cost
  // (35) each pass.
  fillWaveBudget(rng, totalPoints) {
    const kinds = [];
    let remaining = totalPoints;
    let bossAllowed = true;
    const cheapest = Math.min(...ATTACKER_ARCHETYPES.map(a => a.combatPower));
    let guard = 0;
    while (remaining >= cheapest && guard < 1000) {
      guard++;
      const kind = this.rollKind(rng, bossAllowed, remaining);
      const cost = costOf(kind);
      if (cost > remaining) break; // defensive; rollKind's own gating should already prevent this
      kinds.push(kind);
      remaining -= cost;
      if (kind === AttackerKind.Boss) bossAllowed = false;
    }
    return kinds;
  }

  spawnOneWave(currentTick, attackers, rng) {
    this.waveNumber++;
    this.lastArrival = ArrivalMethod.Edge;
    const kinds = this.fillWaveBudget(rng, this.wavePoints());
    const baseHealth = this.waveBaseHealth();
    for (const kind of kinds) {
      const edge = Math.floor(rng() * 4);
      let x, y;
      if (edge === 0) { x = 0; y = rng() * this.grid.height; }
      else if (edge === 1) { x = this.grid.width - 1; y = rng() * this.grid.height; }
      else if (edge === 2) { x = rng() * this.grid.width; y = 0; }
      else { x = rng() * this.grid.width; y = this.grid.height - 1; }
      attackers.spawn(x, y, baseHealth, kind);
    }
  }

  // Picks an unblocked interior cell somewhere between the settlement core and the midpoint to
  // the map edge -- far enough in that the raiders are already past any perimeter line, but not
  // literally on top of the citizen huddle every single time.
  pickTunnelPoint(rng) {
    const cx = this.grid.width / 2, cy = this.grid.height / 2;
    const maxR = Math.min(this.grid.width, this.grid.height) * 0.28;
    for (let attempt = 0; attempt < 24; attempt++) {
      const ang = rng() * Math.PI * 2;
      const r = 2 + rng() * maxR;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (!this.grid.inBounds(Math.floor(x), Math.floor(y))) continue;
      if (this.grid.isBlocked(Math.floor(x), Math.floor(y))) continue;
      return { x, y };
    }
    return { x: cx, y: cy };
  }

  // Tunnel arrival: one mouth, one tight cluster, no perimeter to chew through. Slightly smaller
  // headcount than an equivalent edge wave because it skips every layer of defense on the way in.
  spawnTunnelWave(currentTick, attackers, rng) {
    this.waveNumber++;
    this.lastArrival = ArrivalMethod.Tunnel;
    const mouth = this.pickTunnelPoint(rng);
    this.lastTunnelPoint = mouth;
    // Same 0.7x discount as before, now applied to the points budget rather than a raw headcount
    // -- floors at 2 Grunt-equivalents (70 points) so a tunnel wave never resolves to zero spawns.
    const points = Math.max(costOf(AttackerKind.Grunt) * 2, Math.round(this.wavePoints() * 0.7));
    const kinds = this.fillWaveBudget(rng, points);
    const baseHealth = this.waveBaseHealth();
    for (const kind of kinds) {
      const ang = rng() * Math.PI * 2;
      const r = rng() * TUNNEL_CLUSTER_RADIUS;
      const x = Math.max(0, Math.min(this.grid.width - 1, mouth.x + Math.cos(ang) * r));
      const y = Math.max(0, Math.min(this.grid.height - 1, mouth.y + Math.sin(ang) * r));
      attackers.spawn(x, y, baseHealth, kind);
    }
  }

  // Hazard-scaled tunnel odds, mirroring director.js's pollution-makes-waves-worse pattern
  // (read-only use of world.pollution/world.nuclearWaste -- colonyStrength() is untouched).
  tunnelChance(world) {
    if (this.waveNumber < TUNNEL_MIN_WAVE) return 0;
    const hazard = (world?.pollution || 0) + (world?.nuclearWaste || 0) * 2;
    return Math.min(TUNNEL_MAX_CHANCE, TUNNEL_BASE_CHANCE + hazard / 900);
  }

  _spawnWithArrival(currentTick, attackers, rng, world) {
    if (rng() < this.tunnelChance(world)) this.spawnTunnelWave(currentTick, attackers, rng);
    else this.spawnOneWave(currentTick, attackers, rng);
  }

  tick(currentTick, attackers, rng, world = null) {
    if (currentTick < this.nextWaveTick) return;
    this._spawnWithArrival(currentTick, attackers, rng, world);
    if (rng() < this.doubleChance) this._spawnWithArrival(currentTick, attackers, rng, world); // Cassandra-style back-to-back

    const delay = (600 - Math.min(300, this.waveNumber * 15)) * this.cycleMult;
    this.nextWaveTick = currentTick + Math.round(delay / this.strengthFactor);
  }
}

const TURRET_RANGE = 8;
const TURRET_COOLDOWN_TICKS = 8;
const TURRET_DAMAGE = 0.35;
const POWERED_DAMAGE_MULT = 1.5;
const POWERED_RANGE_MULT = 1.25;

// Real connected-graph power (power.js): a consumer is powered only if it touches a generator
// or a wire run that leads back to one. This replaced a radius stub where mere proximity to a
// generator was enough and wires didn't exist.
export function isPowered(structures, x, y) {
  return isPoweredAt(structures, x, y);
}

// Overload-aware gate for the powered *bonus* specifically (power.js's overload mechanic): true
// only when this tile is powered AND the segment/nuclear-radius feeding it isn't overloaded.
// isPowered above stays a plain connectivity check (vehicles.js's electric-garage gate reads it
// as "is there power at all", which overload deliberately doesn't cut) -- this is strictly for
// consumer-side bonus decisions like the turret/tesla boost below and world.js's watchtower
// warning-window boost.
export function isPoweredBonus(structures, x, y) {
  return hasPoweredBonus(structures, x, y);
}
const ATTACKER_SPEED = 0.03;
const ATTACKER_CITIZEN_DAMAGE = 0.008;
const ATTACKER_CONTACT_RANGE = 0.5;
const FENCE_CONTACT_RANGE = 0.7;
const FENCE_DAMAGE_PER_TICK = 0.015;
const TRAP_TRIGGER_RANGE = 0.5;
const TRAP_DAMAGE = 3; // instant-kill-ish burst
const GUARD_RANGE = 3.5; const GUARD_DAMAGE = 0.05; const GUARD_COOLDOWN = 4;
const SNIPER_RANGE = 9; const SNIPER_DAMAGE = 0.12; const SNIPER_COOLDOWN = 10;

// Tesla coil (SEA:R): weaker per-hit than a plain turret but chains to every attacker in range
// each activation -- a crowd-control pick over a single-target DPS pick, not a strict upgrade.
const TESLA_RANGE = 4.5; const TESLA_DAMAGE = 0.12; const TESLA_COOLDOWN_TICKS = 14;

// armorPenetration per damage source, 0-100 (same units as ARMOR_RATING). Real per-weapon example
// this was benchmarked against: RimWorld's shotgun blast carries armorPenetrationBase 0.14 (i.e.
// 14 on this 0-100 scale) -- TURRET_PENETRATION/GUARD_PENETRATION sit in that same "conventional
// firearm" neighborhood. Traps/Tesla/Sniper are the game's three "answers to armor" (see the
// ARMOR_RATING/VULNERABILITY comments above), so they carry noticeably higher penetration than a
// plain turret or sidearm -- that's what makes them the correct counter-pick, not just flavor text.
const TURRET_PENETRATION = 20;
const TESLA_PENETRATION = 30;
const TRAP_PENETRATION = 35;
const GUARD_PENETRATION = 15;
const SNIPER_PENETRATION = 40;

// Floodlight (SEA:R's "soft wall" -- an area-denial light that slows rather than blocks, so it
// doesn't need its own health/destroy state like a fence does).
export const FLOODLIGHT_RANGE = 3.5;
export const FLOODLIGHT_SLOW_MULT = 0.35; // attacker speed multiplier while inside the radius

// Nuclear generator (SEA:R): the high-risk/high-reward power tier. Its reward is a wireless
// power-delivery radius -- consumers standing near it get powered without needing a wire run at
// all, unlike a plain generator which only reaches through the wire graph (power.js). Its risk is
// nuclear waste: a hazard resource distinct from world.pollution that, left uncontained, turns
// the ground around the generator into a damage-dealing zone (not just a visual tint like the
// smog haze). Building a `waste_storage` structure within NUCLEAR_CONTAINMENT_RADIUS neutralizes
// the hazard entirely -- no staffing requirement, per FEATURE_RESEARCH.md's simpler fallback.
export const NUCLEAR_HAZARD_RADIUS = 4;
export const NUCLEAR_CONTAINMENT_RADIUS = 5;
export const NUCLEAR_WASTE_RATE = 0.06; // world.nuclearWaste gained per uncontained nuclear generator per tick
const NUCLEAR_HAZARD_CITIZEN_DAMAGE = 0.02; // per tick while standing in an uncontained hazard zone
const NUCLEAR_HAZARD_STRUCTURE_DAMAGE = 0.01;

export function isNuclearContained(structures, gen) {
  return structures.some(s => s.kind === 'waste_storage' && !s.destroyed && !s.underConstruction &&
    Math.hypot(s.x - gen.x, s.y - gen.y) <= NUCLEAR_CONTAINMENT_RADIUS);
}

// Periodic hazard damage around any nuclear generator that isn't guarded by a nearby waste
// storage -- mirrors tickAttackerVsCitizens's downed-then-dead pattern for citizens, and the
// fence-damage/destroyed pattern (tickAttackers) for structures, so an unguarded reactor reads as
// a real threat rather than a stat debuff.
export function tickNuclearHazard(structures, citizens) {
  for (const gen of structures) {
    if (gen.kind !== 'generator_nuclear' || gen.destroyed || gen.underConstruction) continue;
    if (isNuclearContained(structures, gen)) continue;

    for (let c = 0; c < citizens.count; c++) {
      if (!citizens.isAliveAt(c)) continue;
      if (Math.hypot(citizens.x[c] - gen.x, citizens.y[c] - gen.y) > NUCLEAR_HAZARD_RADIUS) continue;
      if (citizens.isDownedAt(c)) {
        citizens.flags[c] |= CitizenFlags.Dead;
        citizens.alive[c] = 0;
        continue;
      }
      const healthMult = citizens.trait[c]?.healthMult ?? 1;
      citizens.health[c] -= NUCLEAR_HAZARD_CITIZEN_DAMAGE / healthMult;
      if (citizens.health[c] <= 0) {
        citizens.health[c] = 0.05;
        citizens.flags[c] |= CitizenFlags.Downed;
      }
    }

    for (const s of structures) {
      if (s === gen || s.kind === 'waste_storage' || s.destroyed || s.underConstruction) continue;
      if (Math.hypot(s.x - gen.x, s.y - gen.y) > NUCLEAR_HAZARD_RADIUS) continue;
      s.health -= NUCLEAR_HAZARD_STRUCTURE_DAMAGE;
      if (s.health <= 0) s.destroyed = true;
    }
  }
}

function nearestLivingCitizen(citizens, x, y) {
  let bestI = -1, bestDist = Infinity;
  for (let c = 0; c < citizens.count; c++) {
    if (!citizens.isAliveAt(c)) continue;
    const d = Math.hypot(citizens.x[c] - x, citizens.y[c] - y);
    if (d < bestDist) { bestDist = d; bestI = c; }
  }
  return bestI;
}

// Attackers hunt the nearest living citizen (falling back to the settlement center if the
// colony is somehow empty) and are blocked by un-destroyed fences/walls in their way; they
// chip away at the blocking structure instead of walking through it.
// weatherSpeedMult: map-wide movement-speed multiplier from weather.js's weatherMoveSpeedMult
// (Rain/Snow/RainyThunderstorm slow everyone down, attackers included -- RimWorld applies its
// move-speed modifier to every pawn on the map, not just the player's own colonists). Stacks
// multiplicatively with the existing floodlight slow, same as RimWorld stacking multiple speed
// factors. Defaults to 1 so every existing call site (tests, console pokes) is unaffected.
export function tickAttackers(attackers, structures, grid, centerX, centerY, citizens, onScrap, onKill, weatherSpeedMult = 1, rng = Math.random) {
  for (let i = 0; i < attackers.count; i++) {
    if (!attackers.isAliveAt(i)) continue;

    const arch = attackers.archetypeAt(i);

    const blocker = findBlockingFence(structures, attackers.x[i], attackers.y[i]);
    if (blocker) {
      blocker.health -= FENCE_DAMAGE_PER_TICK * arch.damageMult; // a Brute tears through fencing
      if (blocker.health <= 0) blocker.destroyed = true;
      continue;
    }

    const targetC = citizens ? nearestLivingCitizen(citizens, attackers.x[i], attackers.y[i]) : -1;
    const tx = targetC >= 0 ? citizens.x[targetC] : centerX;
    const ty = targetC >= 0 ? citizens.y[targetC] : centerY;
    const dx = tx - attackers.x[i];
    const dy = ty - attackers.y[i];
    const dist = Math.hypot(dx, dy);
    if (dist > ATTACKER_CONTACT_RANGE * 0.6) {
      const inFloodlight = structures.some(s => s.kind === 'floodlight' && !s.destroyed && !s.underConstruction &&
        Math.hypot(attackers.x[i] - s.x, attackers.y[i] - s.y) <= FLOODLIGHT_RANGE);
      const speed = ATTACKER_SPEED * arch.speedMult * (inFloodlight ? FLOODLIGHT_SLOW_MULT : 1) * weatherSpeedMult;
      attackers.x[i] += (dx / dist) * speed;
      attackers.y[i] += (dy / dist) * speed;
    }

    for (const t of structures) {
      if (t.kind !== 'trap' || t.triggered || t.underConstruction) continue;
      if (Math.hypot(attackers.x[i] - t.x, attackers.y[i] - t.y) < TRAP_TRIGGER_RANGE) {
        t.triggered = true; t.destroyed = true;
        // Traps are the game's Explosive source: the counter to armored Brutes, wasted on
        // Skirmishers (who mostly run clear of the blast).
        if (damageAttacker(attackers, i, TRAP_DAMAGE, DamageType.Explosive, TRAP_PENETRATION, rng)) { onScrap?.(SCRAP_PER_KILL); onKill?.(); }
      }
    }
  }
}

function findBlockingFence(structures, x, y) {
  for (const s of structures) {
    if (s.kind !== 'fence' || s.destroyed || s.underConstruction) continue;
    if (Math.hypot(x - s.x, y - s.y) < FENCE_CONTACT_RANGE) return s;
  }
  return null;
}

// rng/accuracyMult: weather-scaled hit roll (see rollsHit above / weather.js's weatherAccuracyMult)
// -- the turret/tesla still fires and goes on cooldown on a miss (a shot was taken), it just
// doesn't connect, same as a real gun firing into fog. Both default to always-hit so every
// pre-existing call site (tests, console pokes) is unaffected.
export function tickTurrets(structures, attackers, onScrap, onFire, onKill, rng = Math.random, accuracyMult = 1) {
  for (const s of structures) {
    if (s.kind !== 'turret' && s.kind !== 'tesla') continue;
    if (s.destroyed || s.underConstruction) continue;
    if (s.cooldown > 0) { s.cooldown--; continue; }

    const powered = isPoweredBonus(structures, s.x, s.y);
    const isTesla = s.kind === 'tesla';
    const range = (isTesla ? TESLA_RANGE : TURRET_RANGE) * (powered ? POWERED_RANGE_MULT : 1);
    const damage = (isTesla ? TESLA_DAMAGE : TURRET_DAMAGE) * (powered ? POWERED_DAMAGE_MULT : 1);
    // Tesla coils are the Energy source (armor-piercing, the answer to a Boss); plain turrets
    // are Kinetic (great against unarmored Skirmishers, poor against a Brute's plate).
    const dtype = isTesla ? DamageType.Energy : DamageType.Kinetic;
    const penetration = isTesla ? TESLA_PENETRATION : TURRET_PENETRATION;

    if (isTesla) {
      // Chains to every attacker in range instead of picking one -- Tesla's SEA:R niche is
      // crowd control, not single-target DPS (that's what plain turrets are for). Each chained
      // target rolls its own hit chance -- a Tesla activating in fog can connect with some
      // attackers in the chain and whiff on others, same as any other weather-gated shot.
      let hitAny = false;
      for (let i = 0; i < attackers.count; i++) {
        if (!attackers.isAliveAt(i)) continue;
        if (Math.hypot(attackers.x[i] - s.x, attackers.y[i] - s.y) > range) continue;
        hitAny = true;
        if (rollsHit(rng, accuracyMult) && damageAttacker(attackers, i, damage, dtype, penetration, rng)) { onScrap?.(SCRAP_PER_KILL); onKill?.(); }
      }
      if (hitAny) { s.cooldown = TESLA_COOLDOWN_TICKS; onFire?.(s); }
      continue;
    }

    const bestI = nearestAliveAttacker(attackers, s.x, s.y, range);
    if (bestI >= 0) {
      s.cooldown = TURRET_COOLDOWN_TICKS;
      onFire?.(s);
      if (rollsHit(rng, accuracyMult) && damageAttacker(attackers, bestI, damage, dtype, penetration, rng)) { onScrap?.(SCRAP_PER_KILL); onKill?.(); }
    }
  }
}

function nearestAliveAttacker(attackers, x, y, maxRange) {
  let bestI = -1, bestDist = maxRange;
  for (let i = 0; i < attackers.count; i++) {
    if (!attackers.isAliveAt(i)) continue;
    const d = Math.hypot(attackers.x[i] - x, attackers.y[i] - y);
    if (d < bestDist) { bestDist = d; bestI = i; }
  }
  return bestI;
}

// Attackers in contact range of a living citizen deal damage each tick; citizen dies (Dead
// flag, permadeath per the RimWorld-style design) at 0 health.
// Downed-not-dead (RimWorld pattern, see FEATURE_RESEARCH.md): the first time a citizen's
// health hits 0 they go down but survive; if an attacker lands another hit on them while
// already down, that's when they actually die. Gives a real reprieve instead of instant
// permadeath on the first unlucky contact tick.
// rng/accuracyMult: same weather-scaled hit roll as tickTurrets/tickStaffCombat, applied to the
// attacker's side of the fight (RimWorld's accuracy modifier is a single map-wide number, not a
// one-sided player buff -- a foggy map makes the raiders miss citizens just as much as it makes
// turrets miss raiders). A miss skips both the downed-then-dead coup-de-grace check and fresh
// damage for that attacker/citizen pair this tick. Defaults to always-hit for backward
// compatibility with existing call sites.
// onDowned(x, y, died): fires on both a downing and an actual death, with the victim's last
// position and whether this specific event was the death (not just a downing) -- world.js uses
// the died=true case to trigger the "witnessed a nearby combat death" mood event (citizens.js's
// addMoodEvent) for any living citizen nearby, mirroring RimWorld's real death-witnessed Thought.
// onContact(x, y): optional, fires once per citizen actually hit this tick (any landed roll,
// including the downed-then-dead coup-de-grace), regardless of whether it downed/killed them.
// world.js wires this to relationships.js's logFight so citizens.js's computeCitizenUnrestScore
// has a real "Fighting Nearby" signal to read (Prison Architect dynamicRep.txt) instead of
// nothing at all -- distinct from onDowned above, which only fires on the downed/kill transition.
export function tickAttackerVsCitizens(attackers, citizens, onDowned, rng = Math.random, accuracyMult = 1, onContact = null) {
  for (let i = 0; i < attackers.count; i++) {
    if (!attackers.isAliveAt(i)) continue;
    // Per-archetype reach: a Boss's contactRange is wide enough that it hits every citizen in a
    // small area each tick (this loop damages everyone in range), which is its cleave attack.
    const arch = attackers.archetypeAt(i);
    const reach = arch.contactRange ?? ATTACKER_CONTACT_RANGE;
    for (let c = 0; c < citizens.count; c++) {
      if (!citizens.isAliveAt(c)) continue;
      if (Math.hypot(attackers.x[i] - citizens.x[c], attackers.y[i] - citizens.y[c]) > reach) continue;
      if (!rollsHit(rng, accuracyMult)) continue;
      onContact?.(citizens.x[c], citizens.y[c]);

      if (citizens.isDownedAt(c)) {
        const dx = citizens.x[c], dy = citizens.y[c];
        citizens.flags[c] |= CitizenFlags.Dead;
        citizens.alive[c] = 0;
        onDowned?.(dx, dy, true);
        continue;
      }

      const healthMult = citizens.trait[c]?.healthMult ?? 1;
      citizens.health[c] -= (ATTACKER_CITIZEN_DAMAGE * arch.damageMult) / healthMult;
      if (citizens.health[c] <= 0) {
        citizens.health[c] = 0.05;
        citizens.flags[c] |= CitizenFlags.Downed;
        onDowned?.(citizens.x[c], citizens.y[c], false);
      }
    }
  }
}

// Guards/snipers fight back with their personal weapon (short/long range respectively),
// separate from turret coverage. Gains combat skill on a confirmed kill.
// rng/accuracyMult: same weather-scaled hit roll as tickTurrets -- a guard/sniper still fires and
// goes on cooldown on a miss, just doesn't connect. Skill gain only happens on a confirmed kill,
// which already requires a hit, so a foggy/rainy stretch also slows skill progression a little,
// same knock-on realism as RimWorld's own accuracy modifier. Defaults to always-hit.
export function tickStaffCombat(citizens, roster, idOf, attackers, onScrap, onKill, rng = Math.random, accuracyMult = 1) {
  for (let i = 0; i < citizens.count; i++) {
    if (!citizens.isAliveAt(i)) continue;
    if (citizens.isDownedAt(i)) continue; // downed guards/snipers can't fight back
    const kind = roster.kindOf(idOf(i));
    if (kind !== 'Guard' && kind !== 'Sniper') continue;

    if (citizens._staffCooldown[i] > 0) { citizens._staffCooldown[i]--; continue; }

    // Armory-issued weapon tier (security.js WEAPON_TIERS/tickArmoryIssuance) multiplies the
    // role's baseline stats -- Sidearm is 1x everywhere (identical to the old flat constants) for
    // any guard/sniper nobody's built an Armory for yet.
    const tier = WEAPON_TIERS[roster.weaponOf(idOf(i))] || WEAPON_TIERS.Sidearm;
    const range = (kind === 'Sniper' ? SNIPER_RANGE : GUARD_RANGE) * tier.rangeMult;
    const damage = (kind === 'Sniper' ? SNIPER_DAMAGE : GUARD_DAMAGE) * tier.damageMult;
    const cooldown = Math.round((kind === 'Sniper' ? SNIPER_COOLDOWN : GUARD_COOLDOWN) * tier.cooldownMult);
    // Guards carry conventional sidearms (Kinetic); snipers carry the long-range armor-piercing
    // rifle (Energy), so a sniper line is the personnel answer to Brutes/Bosses.
    const dtype = kind === 'Sniper' ? DamageType.Energy : DamageType.Kinetic;
    const penetration = kind === 'Sniper' ? SNIPER_PENETRATION : GUARD_PENETRATION;

    const targetI = nearestAliveAttacker(attackers, citizens.x[i], citizens.y[i], range);
    if (targetI >= 0) {
      citizens._staffCooldown[i] = cooldown;
      if (rollsHit(rng, accuracyMult) && damageAttacker(attackers, targetI, damage, dtype, penetration, rng)) {
        citizens.skillCombat[i] += 0.05 * PASSION_GAIN_MULT[citizens.passionCombat[i]];
        onScrap?.(SCRAP_PER_KILL);
        onKill?.();
      }
    }
  }
}

// --- Held-citizen crisis (Prison Architect's riot_hostages/riot_roulette staged-escalation
// pattern, reskinned -- see the header comment on this file's task: no hostage-taking-as-a-
// carceral-mechanic framing, just "a citizen is seized and threatened during a severe crisis",
// same shape as any real-world civil emergency) ---
//
// Real source pacing this was ported from: PA's actual riot hostage sequence advances through a
// handful of escalating beats separated by ~3-second real-time pauses, with the resolution of
// each beat genuinely varying -- some beats end safely, one beat carries the real stakes, it's
// never a single pass/fail stat check. Mapped onto this project's 10Hz tick rate:
//  - HELD_CITIZEN_BEAT_PAUSE_TICKS (30 ticks = 3s) is that literal beat-to-beat dramatic pause --
//    used as a real gap between a beat resolving and the next one's response window opening, so
//    the event log reads as a sequence of beats, not one instant resolution.
//  - HELD_CITIZEN_BEAT_WINDOW_TICKS is the player-actionable window *within* each beat -- long
//    enough that a player who's watching has a genuine chance to route security over (this is a
//    real-time sim, not a paused decision menu the way PA's negotiation screen is), short enough
//    that it's a real emergency, not a background task.
export const HeldCitizenOutcome = Object.freeze({ Safe: 'safe', Lost: 'lost' });

const HELD_CITIZEN_STAFF_REQUIRED = 2;        // "enough security staff nearby" -- see the task's own phrasing
const HELD_CITIZEN_RESPONSE_RADIUS = 3;       // grid cells around the held citizen that count as "nearby"
const HELD_CITIZEN_BEAT_WINDOW_TICKS = 150;   // ~15s at 10Hz -- the player-actionable window each beat
const HELD_CITIZEN_BEAT_PAUSE_TICKS = 30;     // ~3s real-time -- PA's actual beat-to-beat pacing, see above
const HELD_CITIZEN_MIN_BEATS = 2;
const HELD_CITIZEN_MAX_BEATS = 3;             // "2-3 escalating beats", per the task spec
// A beat with a timely security response doesn't automatically end the crisis outright -- it's a
// strong chance, not a guarantee, matching "some beats end safely" rather than "a good beat always
// ends it". The remaining chance just means this beat quietly continues rather than escalating.
const HELD_CITIZEN_SAFE_RESOLVE_CHANCE = 0.7;
const HELD_CITIZEN_ESCALATION_INJURY = 0.35;  // health fraction lost when a beat escalates unanswered
const HELD_CITIZEN_FINAL_LOSS_CHANCE = 0.4;   // real stakes: chance of genuinely losing the citizen at the last beat
const HELD_CITIZEN_CHECK_INTERVAL_TICKS = 100; // how often maybeTriggerHeldCitizenCrisis rolls at all
const HELD_CITIZEN_TRIGGER_CHANCE_PER_CHECK = 0.12; // per check, only while the population/unrest gates below pass
const HELD_CITIZEN_COOLDOWN_TICKS = 1200;     // no back-to-back crises the instant one resolves

function _findCitizenIndexById(citizens, id) {
  for (let i = 0; i < citizens.count; i++) if (citizens.id[i] === id) return i;
  return -1;
}

// Rolls whether a new held-citizen crisis starts this check. Gated on the settlement's most
// severe unrest tier: the task asks to check world.js fresh for a dedicated unrest-tier system
// before finalizing this and hook into its top tier if one exists. Re-checked right before wiring
// this into world.js -- a concurrent pass THIS session did add a real 3-tier escalation
// (`world.unrestTier`, 0/1/2/3, see world.js's UNREST_TIER2/3_THRESHOLD block), so this hooks
// into its top tier (3) rather than the plain `unrestActive` boolean fallback. `unrestTier` is
// guaranteed to exist on any world built after that pass landed; `world.unrestActive` is kept as
// a defensive fallback for a world/save predating unrest tiers entirely (unrestTier undefined).
export function maybeTriggerHeldCitizenCrisis(world) {
  if (world.heldCitizenEvent && world.heldCitizenEvent.active) return; // one crisis at a time
  if (world.currentTick % HELD_CITIZEN_CHECK_INTERVAL_TICKS !== 0) return;
  if (world._heldCitizenCooldownUntil && world.currentTick < world._heldCitizenCooldownUntil) return;
  const atTopTier = world.unrestTier != null ? world.unrestTier >= 3 : !!world.unrestActive;
  if (!atTopTier) return; // most-severe-tier gate, see the comment above
  if (world.rng() >= HELD_CITIZEN_TRIGGER_CHANCE_PER_CHECK) return;

  // Victim pool: a living, non-downed, non-staff citizen -- staff carry weapons and backup, a
  // plain citizen being seized mid-crisis is the scarier and more "civilian emergency" framing
  // this reskin wants (matches the task's "a citizen is seized" wording, not "a guard").
  const store = world.citizens;
  const candidates = [];
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i) || store.isDownedAt(i)) continue;
    if (world.roster.isStaff(store.id[i])) continue;
    candidates.push(i);
  }
  if (candidates.length === 0) return;
  const idx = candidates[Math.floor(world.rng() * candidates.length)];
  const citizenId = store.id[idx];

  const beatCount = HELD_CITIZEN_MIN_BEATS +
    (world.rng() < 0.5 ? HELD_CITIZEN_MAX_BEATS - HELD_CITIZEN_MIN_BEATS : 0); // 2 or 3
  world.heldCitizenEvent = {
    active: true, citizenId, beat: 1, beatCount,
    beatEndTick: world.currentTick + HELD_CITIZEN_BEAT_WINDOW_TICKS,
    pauseUntilTick: null,
  };
  const name = store.name[idx];
  const text = `${name} has been seized during the unrest -- get security there fast`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
}

// Advances an in-progress crisis. Called once per world tick (world.js), after
// maybeTriggerHeldCitizenCrisis -- cheap no-op when no crisis is active.
export function tickHeldCitizenCrisis(world) {
  const ev = world.heldCitizenEvent;
  if (!ev || !ev.active) return;

  const store = world.citizens;
  const idx = _findCitizenIndexById(store, ev.citizenId);
  if (idx < 0 || !store.isAliveAt(idx)) {
    // The held citizen died some other way mid-crisis (e.g. an attacker got through) -- the
    // crisis just ends; there's nothing left to resolve.
    _endHeldCitizenCrisis(world, HeldCitizenOutcome.Lost, null);
    return;
  }

  // Dramatic pause between beats (the literal ~3s PA pacing, see the header comment above).
  if (ev.pauseUntilTick != null) {
    if (world.currentTick < ev.pauseUntilTick) return;
    ev.pauseUntilTick = null;
    ev.beatEndTick = world.currentTick + HELD_CITIZEN_BEAT_WINDOW_TICKS;
    return;
  }

  if (world.currentTick < ev.beatEndTick) return; // this beat's response window is still open

  // Beat resolution: count on-duty security staff physically near the held citizen right now.
  const cx = store.x[idx], cy = store.y[idx];
  let staffNearby = 0;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i) || store.isDownedAt(i)) continue;
    if (!world.isStaffOnDutyAt(i)) continue;
    if (Math.hypot(store.x[i] - cx, store.y[i] - cy) <= HELD_CITIZEN_RESPONSE_RADIUS) staffNearby++;
  }
  const responded = staffNearby >= HELD_CITIZEN_STAFF_REQUIRED;

  if (responded && world.rng() < HELD_CITIZEN_SAFE_RESOLVE_CHANCE) {
    _endHeldCitizenCrisis(world, HeldCitizenOutcome.Safe, idx);
    return;
  }

  if (!responded) {
    // No timely response -- this beat escalates with a real injury (not just a scare), matching
    // "some beats end safely, some don't" rather than a single binary check deciding everything.
    const healthMult = store.trait[idx]?.healthMult ?? 1;
    store.health[idx] = Math.max(0.05, store.health[idx] - HELD_CITIZEN_ESCALATION_INJURY / healthMult);
    if (store.health[idx] <= 0.05) store.flags[idx] |= CitizenFlags.Downed;
    const name = store.name[idx];
    const text = `${name} is hurt -- security didn't reach them in time`;
    world.milestoneLog.push({ tick: world.currentTick, text });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  }

  if (ev.beat >= ev.beatCount) {
    // Final beat reached without a clean resolve -- real stakes: even a responded-but-unlucky
    // ending has a genuine chance of losing the citizen, not just a guaranteed reprieve for
    // showing up, mirroring the source material's "some beats end safely, some don't" shape.
    if (world.rng() < HELD_CITIZEN_FINAL_LOSS_CHANCE) {
      store.flags[idx] |= CitizenFlags.Dead;
      store.alive[idx] = 0;
      _endHeldCitizenCrisis(world, HeldCitizenOutcome.Lost, idx);
    } else {
      _endHeldCitizenCrisis(world, HeldCitizenOutcome.Safe, idx);
    }
    return;
  }

  ev.beat++;
  ev.pauseUntilTick = world.currentTick + HELD_CITIZEN_BEAT_PAUSE_TICKS;
  const name = store.name[idx];
  const text = `The situation with ${name} is escalating (beat ${ev.beat}/${ev.beatCount})`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
}

function _endHeldCitizenCrisis(world, outcome, idx) {
  const store = world.citizens;
  const name = idx != null && idx >= 0 ? store.name[idx] : 'The held citizen';
  const text = outcome === HeldCitizenOutcome.Safe
    ? `${name} is safe -- the crisis is over`
    : `${name} could not be saved`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
  world.heldCitizenEvent = { active: false, citizenId: null, beat: 0, beatCount: 0, beatEndTick: 0, pauseUntilTick: null };
  world._heldCitizenCooldownUntil = world.currentTick + HELD_CITIZEN_COOLDOWN_TICKS;
}

// Debug/soak-test helper (see main.js's window.__debug.crisis): forces a held-citizen crisis to
// start immediately, bypassing the unrest/population/probability gates in
// maybeTriggerHeldCitizenCrisis above -- unrestActive only turns on after a genuinely sustained
// mood crash (world.js's UNREST_SUSTAIN_TICKS), which isn't practical to sit through in a manual
// verification pass. Returns true if a crisis was started, false if one was already active or
// there's no valid non-staff citizen to seize.
export function forceHeldCitizenCrisis(world) {
  if (world.heldCitizenEvent && world.heldCitizenEvent.active) return false;
  const store = world.citizens;
  const candidates = [];
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i) || store.isDownedAt(i)) continue;
    if (world.roster.isStaff(store.id[i])) continue;
    candidates.push(i);
  }
  if (candidates.length === 0) return false;
  const idx = candidates[Math.floor(world.rng() * candidates.length)];
  const citizenId = store.id[idx];
  const beatCount = HELD_CITIZEN_MIN_BEATS + (world.rng() < 0.5 ? HELD_CITIZEN_MAX_BEATS - HELD_CITIZEN_MIN_BEATS : 0);
  world.heldCitizenEvent = {
    active: true, citizenId, beat: 1, beatCount,
    beatEndTick: world.currentTick + HELD_CITIZEN_BEAT_WINDOW_TICKS,
    pauseUntilTick: null,
  };
  const name = store.name[idx];
  const text = `${name} has been seized during the unrest -- get security there fast`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
  return true;
}
