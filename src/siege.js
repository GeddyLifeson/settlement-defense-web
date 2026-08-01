// Ported/condensed from SD.Siege (wave spawner, AttackerStore, turret/fence/trap placement +
// combat resolution, scrap rewards).
import { SCRAP_PER_KILL, BUILD_COST } from './economy.js';
import { CitizenFlags } from './citizens.js';
import { isPoweredAt, hasPoweredBonus } from './power.js';
import { PASSION_GAIN_MULT } from './backstories.js';
import { ageBandFor } from './traits.js';
import { WEAPON_TIERS, guardRankCombatMult } from './security.js';
import { rankHealthMultFor } from './ranks.js';
import { augmentHealthMultFor, augmentDamageMultFor } from './augments.js';

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

// Core 3-outcome roll, factored out so both the attacker-side roll (resolveArmorRoll, below) and
// the citizen-side roll (resolveCitizenArmorRoll, see the Vest section further down) share the
// exact same mechanism -- effectiveArmor = armor - penetration, one roll 0-100, three thresholds.
// Returns { outcome, fracMult } where fracMult is the fraction of `amount` that gets through
// (0 / 0.5 / 1) BEFORE any archetype-specific vulnerability multiplier is applied -- callers that
// have no such multiplier (citizens) can use fracMult directly.
function rollArmorMitigation(armor, penetration, rng) {
  const effectiveArmor = armor - penetration;
  const roll = rng() * 100;
  if (effectiveArmor > 0 && roll < effectiveArmor / 2) return { outcome: 'deflect', fracMult: 0 };
  if (effectiveArmor > 0 && roll <= effectiveArmor) return { outcome: 'half', fracMult: 0.5 };
  return { outcome: 'full', fracMult: 1 };
}

// The actual 3-outcome roll described at the top of this section. `amount` is the pre-roll base
// damage; returns { dealt, outcome } where outcome is 'deflect' | 'half' | 'full' (reported as
// DamageType.Blunt-flavored when 'half', per the comment above). Tallies armorStats as a side
// effect so soak tests can confirm a real mix of outcomes rather than one branch always firing.
export function resolveArmorRoll(kind, damageType, amount, penetration, rng = Math.random) {
  const armor = armorRatingOf(kind, damageType);
  const { outcome, fracMult } = rollArmorMitigation(armor, penetration, rng);
  const dealt = outcome === 'full' ? amount * vulnerabilityMult(kind, damageType) : amount * fracMult;
  armorStats[outcome]++;
  return { dealt, outcome };
}

// ---------------------------------------------------------------- citizen armor (Vest)
// Citizens previously had ZERO defense stat of any kind -- an attacker's contact damage was a
// flat subtraction with no armor roll at all, unlike every combat-side hit in this file. This is
// the fix: a purchasable/craftable Vest (economy.js BUILD_COST.vest, equipped per-citizen via
// world.buyVest -- see world.js/citizens.js's hasVest flag) grants a flat armor-rating bonus on
// this SAME ARMOR_RATING 0-100 scale, run through the exact rollArmorMitigation core above rather
// than a parallel mechanic. Real RimWorld anchor: Flak Vest's real ArmorRating_Sharp is ~1.00 on
// RimWorld's own 0-2ish scale (its "100%" reference point) -- CITIZEN_VEST_ARMOR_RATING (25) is
// picked proportionally on this project's scale, in the same neighborhood as a Grunt's own 20
// Kinetic armor rating (ARMOR_RATING[Grunt][Kinetic] above), i.e. "roughly as protected as the
// weakest raider archetype's own plate", a reasonable civilian-grade vest.
// ATTACKER_CONTACT_PENETRATION is 0 (not one of the gun-tier PENETRATION consts below) -- a raider's
// bare-handed/melee contact hit is not a piercing weapon, so it carries no penetration of its own;
// an unvested citizen (armorRating 0) still rolls effectiveArmor = 0-0 = 0, which the roll's own
// `effectiveArmor > 0` guard sends straight to 'full' every time -- i.e. byte-for-byte the same
// flat-damage behavior citizens had before this feature existed. Only a vested citizen (armorRating
// 25) ever sees a nonzero effectiveArmor and a real chance to deflect/halve a hit.
export const CITIZEN_VEST_ARMOR_RATING = 25;
const ATTACKER_CONTACT_PENETRATION = 0;

// Same live-tally pattern as armorStats above, kept as its own counter (not merged into armorStats)
// so a soak test can read "how did the citizen population's hits resolve" independently of the
// attacker-facing combat tally.
export const citizenArmorStats = { deflect: 0, half: 0, full: 0 };
export function resetCitizenArmorStats() {
  citizenArmorStats.deflect = 0; citizenArmorStats.half = 0; citizenArmorStats.full = 0;
}

// `amount` is the pre-roll base damage a citizen is about to take; `armorRating` is 0 for an
// unvested citizen, CITIZEN_VEST_ARMOR_RATING for a vested one (see tickAttackerVsCitizens below,
// which reads citizens.hasVest to decide which). Returns { dealt, outcome }, same shape as
// resolveArmorRoll -- citizens have no per-archetype vulnerability table, so 'full' is always a
// flat 1x rather than resolveArmorRoll's vulnerabilityMult lookup.
export function resolveCitizenArmorRoll(armorRating, penetration, amount, rng = Math.random) {
  const { outcome, fracMult } = rollArmorMitigation(armorRating, penetration, rng);
  citizenArmorStats[outcome]++;
  return { dealt: amount * fracMult, outcome };
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
    // Non-lethal takedown (security.js's WeaponTier.StunBaton, see applyStun/tickAttackers/
    // tickAttackerVsCitizens below): ticks remaining incapacitated. 0 = not stunned, the default
    // for every existing spawn call site (tests/console pokes) -- byte-for-byte the old
    // behavior for anyone who never gets stunned.
    this.stunTicksRemaining = new Uint16Array(capacity);
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
          this.stunTicksRemaining[i] = 0; // a recycled dead slot must not inherit a stale stun
          return i;
        }
      }
      return -1;
    }
    const i = this.count++;
    this.x[i] = x; this.y[i] = y; this.health[i] = hp; this.alive[i] = 1; this.kind[i] = kind;
    this.stunTicksRemaining[i] = 0;
    return i;
  }

  isAliveAt(i) {
    return this.alive[i] === 1;
  }

  isStunnedAt(i) {
    return this.stunTicksRemaining[i] > 0;
  }

  archetypeAt(i) {
    return archetypeOf(this.kind[i]);
  }
}

// Single choke point for applying a non-lethal incapacitation (security.js's WeaponTier.StunBaton
// is the only current caller, via siege.js's own tickStaffCombat below) -- takes the max of any
// existing stun rather than stacking additively, so a second baton hit on an already-stunned
// target refreshes the duration instead of letting stuns compound into an effectively-permanent
// lock.
export function applyStun(attackers, i, ticks) {
  if (!attackers.isAliveAt(i)) return;
  attackers.stunTicksRemaining[i] = Math.max(attackers.stunTicksRemaining[i], ticks);
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
                      // materials-chain analog, see jobs.js's Processing job) | 'restaurant'
                      // (Prison Architect Restaurant+Bakery retail-income analog, see jobs.js's
                      // Restaurant job -- reuses this same workerId/_workTimer staffed-station pair)
    this.x = x; this.y = y;
    this.health = kind === 'fence' ? 0.6 : 1;
    this.destroyed = false;
    this.cooldown = 0;
    this.triggered = false; // traps: single-use
    // Suppression + out-of-ammo fallback (this session's ammo/suppression pass, see the doc
    // comments on tickSuppression/AMMO_PER_SHOT_TURRET near GUARD_RANGE above) -- only ever
    // meaningfully mutated for 'turret'/'tesla' kinds, but harmless (and simpler than a kind-gated
    // allocation) to carry on every Structure the same way `cooldown` already is. Neither is
    // persisted in world.js's serialize() -- transient combat state, same convention `cooldown`
    // itself already follows (a reload resumes as if the defender had a clean moment, not mid-burst).
    this.suppression = 0;
    this.outOfAmmo = false;
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

// ---------------------------------------------------------------- turret tiers
// RimWorld's real 3-tier turret roster (mini-turret / autocannon / sniper-turret), each a genuine
// tradeoff rather than a strict upgrade -- this project previously had exactly one generic
// 'turret' kind with flat range/damage. 'turret' stays in this table byte-for-byte identical to
// its own pre-existing TURRET_RANGE/TURRET_DAMAGE/TURRET_COOLDOWN_TICKS/TURRET_PENETRATION
// constants above/below -- both for save-compat (an old save's turret structures must keep
// behaving exactly as before) and because world.js still spawns 'turret' directly as the wave-4
// starter defense, untouched by this pass. turret_mini/turret_auto/turret_sniper are ADDITIONAL
// toolbar options (see economy.js's BUILD_COST comment for the cost side of each tradeoff):
//   turret_mini   -- cheap, short range, fast cooldown. The "always affordable early" pick.
//   turret_auto   -- longer range and harder-hitting than plain turret, but minRange means it
//                    literally cannot engage a target that's already inside that radius (real
//                    autocannon can't depress its barrel low enough for a close target) --
//                    tickTurrets below checks minRange via nearestAliveAttacker's new 4th arg.
//   turret_sniper -- longest range, one heavy single shot, slow cooldown, and (see
//                    AMMO_PER_SHOT_TURRET_SNIPER below) the most expensive ammo per shot of any
//                    turret tier -- the "answer to armor at long range" pick, same role Sniper
//                    staff already play per the GUARD_*/SNIPER_* section above.
// Table itself is built further down this file (see TURRET_TIERS below the armorPenetration
// section) purely so it can reference the real TURRET_PENETRATION/etc named constants instead of
// duplicating their literal values -- this comment lives here, next to TURRET_RANGE/TURRET_DAMAGE,
// because that's the more useful reading order.

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
// Exported: draft.js reuses these directly as the baseline "unarmed civilian" attack-order stats
// for any drafted citizen who isn't already a Guard/Sniper (see that file's tickDraftedCombat) --
// same conventional-sidearm ballpark as an unarmored guard, rather than inventing a second set of
// combat numbers for manually-controlled citizens.
export const GUARD_RANGE = 3.5;
export const GUARD_DAMAGE = 0.05;
export const GUARD_COOLDOWN = 4;
export const SNIPER_RANGE = 9;
export const SNIPER_DAMAGE = 0.12;
export const SNIPER_COOLDOWN = 10; // exported for draft.js, see GUARD_* comment above

// ---------------------------------------------------------------- ammo (this session's pass)
// Design call, documented per the task brief: a single global stockpile (world.ammo/
// world.ammoCapacity, see world.js's tickAmmoProduction import from security.js) rather than a
// per-turret/per-guard inventory. Reasoning: this project's Armory system already issues weapon
// TIERS roster-wide off a single armory-count-derived rung (security.js's tickArmoryIssuance),
// not a per-unit inventory -- a global ammo pool is the same shape of abstraction, consistent with
// how the rest of this game's "one shared stockpile" economy already works (scrap, pollution,
// nuclear waste, research points are all single running totals, never per-building ledgers).
// A dedicated resource distinct from scrap keeps ammo scarcity its own tactical pressure instead
// of just "spend scrap on bullets" -- see security.js's AMMO_PRODUCTION_PER_ARMORY for how the
// Armory buildable actually replenishes it.
export const AMMO_PER_SHOT_GUARD = 1;
export const AMMO_PER_SHOT_SNIPER = 2;   // bigger, longer-range rounds cost more per shot
export const AMMO_PER_SHOT_TURRET = 1;
export const AMMO_PER_SHOT_TESLA = 1.5;  // consumed once per activation (it chains to every
                                          // attacker in range that tick), not once per target --
                                          // a crowd-control shot is one battery discharge, not N

// Fallback ("dry") stats when the ammo stockpile can't cover a shot's cost -- not a full disable
// (the task explicitly calls that out): a Guard/Sniper falls back to a close-range melee scuffle
// (short reach, reduced damage, low penetration, and -- the whole point -- costs no ammo, so a
// stockpile-starved defender still contributes SOMETHING rather than standing there uselessly);
// a turret/tesla can't melee (it's mechanical), so its fallback is a heavily accuracy- and
// damage-penalized "dry-firing/sparking" shot that also costs no ammo. See tickStaffCombat/
// tickTurrets below for exactly where these apply.
export const GUARD_FALLBACK_RANGE = 1.4; // real melee reach, in ATTACKER_CONTACT_RANGE's neighborhood
export const GUARD_FALLBACK_DAMAGE_MULT = 0.35; // fists/knife vs. a loaded sidearm
export const GUARD_FALLBACK_PENETRATION = 5;
export const TURRET_FALLBACK_ACCURACY_MULT = 0.2; // jammed/dry-firing -- still occasionally connects
export const TURRET_FALLBACK_DAMAGE_MULT = 0.4;

// ---------------------------------------------------------------- suppression (this session's pass)
// Genuinely new tactical texture per the task brief, distinct from just "chip away at health":
// sustained incoming fire on a single defender builds a 0-1 suppression value (citizens.suppression
// for Guards/Snipers/any citizen actually getting hit, Structure.suppression for turret/tesla) that
// multiplies down their own accuracy -- a turret/guard getting swarmed measurably starts missing
// more, and recovers on its own once the attention moves elsewhere or the attackers are cleared.
// Two different real "incoming fire" signals feed it, since turrets never take literal damage from
// attackers in this engine's combat model (attackers only chip fences/hit citizens, see
// tickAttackers/tickAttackerVsCitizens): a citizen's suppression rises on an actual landed hit
// against them (tickAttackerVsCitizens increments it directly, see that function below); a turret/
// tesla's suppression rises from sustained attacker presence within its own engagement range
// (tickSuppression below) -- being swarmed by multiple hostiles at close range is the turret's
// analog of "under fire" even though this game has no turret-HP-vs-attacker-damage system to hook
// a literal hit-counter into.
export const SUPPRESSION_GAIN_PER_HIT = 0.32;             // citizen actually hit this tick
export const SUPPRESSION_GAIN_PER_ATTACKER_IN_RANGE = 0.05; // per live attacker in a turret/tesla's range, per tick
export const SUPPRESSION_DECAY_PER_TICK = 0.01;           // ~100 ticks (~10s at 10Hz) to fully recover from max during a real lull
export const SUPPRESSION_MAX_ACCURACY_PENALTY = 0.65;     // at suppression=1, accuracy is multiplied by (1-0.65)=0.35

// Shared accuracy-penalty curve, used by both tickTurrets (structure.suppression) and
// tickStaffCombat (citizens.suppression[i]) so the two systems can't drift out of sync.
export function suppressionAccuracyMult(suppression) {
  return 1 - Math.min(1, Math.max(0, suppression)) * SUPPRESSION_MAX_ACCURACY_PENALTY;
}

// Called once per world tick (world.js), after tickAttackers so a turret/tesla's range check sees
// this tick's freshly-updated attacker positions. Decays every tracked defender's suppression
// first (so it can't decay AND gain within the same tick in the wrong order relative to a fresh
// hit -- citizen suppression's fresh-hit gain happens later this same tick, inside
// tickAttackerVsCitizens, which correctly lands on top of this tick's decayed baseline), then
// re-derives turret/tesla suppression from live attacker proximity.
export function tickSuppression(structures, attackers, citizens) {
  for (const s of structures) {
    // Turret tiers (TURRET_TIERS, see the doc comment near TURRET_RANGE above): every tier shares
    // this same suppression mechanic, keyed off its own tier-specific range rather than the flat
    // TURRET_RANGE this used to hardcode -- 'turret' itself resolves to the exact same range it
    // always did (TURRET_TIERS.turret.range === TURRET_RANGE), so this is byte-for-byte unchanged
    // for any pre-existing turret/save. Mortar is deliberately NOT included -- indirect fire at a
    // remembered point isn't "under fire" in the same way a direct-fire emplacement is, and it
    // doesn't call rollsHit with accuracyMult at all (see tickTurrets' mortar branch).
    const tier = TURRET_TIERS[s.kind];
    const isTesla = s.kind === 'tesla';
    if (!tier && !isTesla) continue;
    if (s.destroyed || s.underConstruction) { s.suppression = 0; continue; }
    s.suppression = Math.max(0, (s.suppression || 0) - SUPPRESSION_DECAY_PER_TICK);
    const range = isTesla ? TESLA_RANGE : tier.range;
    let inRange = 0;
    for (let i = 0; i < attackers.count; i++) {
      if (!attackers.isAliveAt(i)) continue;
      if (Math.hypot(attackers.x[i] - s.x, attackers.y[i] - s.y) <= range) inRange++;
    }
    if (inRange > 0) s.suppression = Math.min(1, s.suppression + inRange * SUPPRESSION_GAIN_PER_ATTACKER_IN_RANGE);
  }
  for (let c = 0; c < citizens.count; c++) {
    citizens.suppression[c] = Math.max(0, citizens.suppression[c] - SUPPRESSION_DECAY_PER_TICK);
  }
}

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
export const GUARD_PENETRATION = 15; // exported for draft.js, see the GUARD_RANGE/DAMAGE/COOLDOWN comment above
export const SNIPER_PENETRATION = 40; // exported for draft.js, see GUARD_* comment above

// Trap variety: this project previously had exactly one generic 'trap' kind. 'trap' stays in this
// table byte-for-byte identical to its own pre-existing TRAP_DAMAGE/DamageType.Explosive/
// TRAP_PENETRATION/single-target behavior (radius: 0 means "only the attacker that stepped on it,
// same as before this table existed") -- for save-compat. trap_spike/trap_explosive are ADDITIONAL
// kinds (see economy.js's BUILD_COST comment for pricing):
//   trap_spike     -- cheap melee deadfall. Uses DamageType.Blunt, which until now existed only as
//                      resolveArmorRoll's half-damage OUTCOME LABEL and was never actually dealt by
//                      anything (see the DamageType enum's own doc comment up top) -- armorRatingOf
//                      falls back to its 20 default for every archetype on an out-of-table lookup
//                      (ARMOR_RATING's rows only have 3 real entries, Blunt is index 3), so a spike
//                      trap is equally mediocre against every archetype rather than a counter-pick
//                      to any one of them, a deliberate "cheap and simple, no rock-paper-scissors"
//                      niche distinct from the other two damage types' real matchups.
//   trap_explosive -- costlier small-radius Explosive trap: radius > 0 means the trigger loop in
//                      tickAttackers below damages EVERY live attacker within that radius of the
//                      trap, not just the one that stepped on it -- can catch a cluster at once,
//                      the real upside that justifies its higher price over plain trap.
const TRAP_KINDS = Object.freeze({
  trap:           { damage: TRAP_DAMAGE, type: DamageType.Explosive, penetration: TRAP_PENETRATION, radius: 0 },
  trap_spike:     { damage: 1.6, type: DamageType.Blunt,     penetration: 10,               radius: 0 },
  trap_explosive: { damage: 2.2, type: DamageType.Explosive, penetration: TRAP_PENETRATION,  radius: 1.2 },
});

// Turret tiers table (see the doc comment up near TURRET_RANGE/TURRET_DAMAGE for the design
// rationale) -- built here, not up there, purely so 'turret' can reference the real
// TURRET_PENETRATION constant instead of duplicating its literal value. Consumed by tickTurrets/
// tickSuppression below. ammoPerShot is per-tier (turret_sniper costs more per shot than the
// other three) -- see AMMO_PER_SHOT_TURRET_SNIPER's own doc comment below.
export const AMMO_PER_SHOT_TURRET_SNIPER = 3; // pricier round, same "bigger gun costs more per
                                               // shot" logic as AMMO_PER_SHOT_SNIPER for staff
const TURRET_TIERS = Object.freeze({
  turret:        { range: TURRET_RANGE, damage: TURRET_DAMAGE, cooldown: TURRET_COOLDOWN_TICKS, minRange: 0, penetration: TURRET_PENETRATION, ammoPerShot: AMMO_PER_SHOT_TURRET },
  turret_mini:   { range: 5,  damage: 0.18, cooldown: 6,  minRange: 0, penetration: 12, ammoPerShot: AMMO_PER_SHOT_TURRET },
  turret_auto:   { range: 11, damage: 0.45, cooldown: 10, minRange: 3, penetration: 22, ammoPerShot: AMMO_PER_SHOT_TURRET },
  turret_sniper: { range: 14, damage: 1.1,  cooldown: 24, minRange: 0, penetration: 45, ammoPerShot: AMMO_PER_SHOT_TURRET_SNIPER },
});

// Mortar (RimWorld's real indirect-fire siege weapon): long range, high per-shot damage, slow
// reload, and -- unlike every turret tier above -- genuinely inaccurate. Real RimWorld mortars
// target a ground cell (not a live pawn) and the shell scatters around that cell; this project has
// no "target a cell" UI, so tickTurrets below approximates it by targeting the nearest live
// attacker's CURRENT position and then scattering the actual impact point around THAT, which
// produces the same real behavior (the shot can miss the intended target, or catch a different
// nearby attacker instead) without needing new player-facing targeting UI. This project's turret
// targeting has never had a line-of-sight/wall-blocking check at all (nearestAliveAttacker below
// is a pure distance scan), so mortar's real "bypasses line of sight" trait has nothing to
// actually bypass here -- it's still implemented as a structurally distinct indirect-fire branch
// in tickTurrets (scatter-around-a-remembered-point, not a locked homing shot) rather than folded
// into the direct-fire path, so it behaves correctly if line-of-sight targeting is ever added to
// the direct-fire turrets later. Deliberately has NO minRange (unlike turret_auto) -- a real
// mortar's minimum range would create a dead zone that's actively bad for colony survival if a
// tunnel wave spawns close to it, and the task brief didn't ask for one on the mortar.
// Deliberately never damages citizens/structures on scatter (unlike the turret self-destruct
// explosion below) -- every other combat AoE in this file (turret, tesla chain, trap) only ever
// hits attackers, and a passive per-shot friendly-fire risk on a structure that fires
// automatically every tick is exactly the kind of new passive risk this session's balance-
// regression work says to avoid; scatter still matters because it can make the shot miss the
// intended target or land on a different nearby attacker instead of a guaranteed hit.
const MORTAR_RANGE = 16;
const MORTAR_DAMAGE = 1.6;
const MORTAR_COOLDOWN_TICKS = 40; // slow reload -- the longest cooldown of any defense structure
const MORTAR_SCATTER_RADIUS = 1.8; // impact point is a random point within this of the target's position
const MORTAR_BLAST_RADIUS = 1.3;   // AoE at the actual (scattered) impact point
const MORTAR_PENETRATION = 30;
export const AMMO_PER_SHOT_MORTAR = 4; // most expensive shot in the game -- real RimWorld mortar shells are a genuine ongoing cost

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

// ---------------------------------------------------------------- turret self-destruct on death
// Real RimWorld turret mechanic: a destroyed turret has a genuine chance of a residual explosion
// (its own capacitor/ammo cooking off) -- approximated here as a flat 50/50 roll, the real
// RimWorld number, since this project doesn't model per-weapon ammo-cook-off odds. Scoped to the
// turret family (TURRET_TIERS) + mortar only, per the task brief's explicit list -- NOT tesla
// (SEA:R's own thing, no real-RimWorld anchor for this) and NOT trap (already single-use/
// destroyed-on-trigger, a self-destruct-on-death roll would be redundant with its own explosion).
const TURRET_SELFDESTRUCT_CHANCE = 0.5;
const TURRET_SELFDESTRUCT_RADIUS = 1.3;     // small radius, similar neighborhood to trap_explosive's blast
const TURRET_SELFDESTRUCT_DAMAGE = 1.2;     // real damage against attackers caught in it -- not a scratch
const TURRET_SELFDESTRUCT_CITIZEN_MULT = 0.3; // citizens/structures take a much smaller fraction --
const TURRET_SELFDESTRUCT_STRUCTURE_MULT = 0.4; // see the doc comment on maybeTurretSelfDestruct below
const TURRET_SELFDESTRUCT_PENETRATION = 25;

function isTurretFamilyKind(kind) {
  return TURRET_TIERS[kind] != null || kind === 'mortar';
}

// Called once, right when a turret/mortar structure transitions destroyed=false -> true, from
// every site in this file capable of doing that -- currently only tickNuclearHazard's generic
// structure-damage loop below (turrets/mortars have no other in-file destruction path today: this
// engine's combat model never lets an attacker directly damage a turret, see the doc comment on
// SUPPRESSION near the top of this file). Exported so a FUTURE destruction path added elsewhere
// (e.g. world.js's own fire/overload-fire structure damage, referenced in that file's comments)
// can call this too instead of silently setting `.destroyed = true` and skipping the explosion --
// idempotent no-op on any non-turret-family kind, so it's always safe to call on ANY destroyed
// structure. `attackers` is optional (null-safe) since not every destruction call site has an
// AttackerStore handy -- the citizen/structure damage still applies even without it.
// Unlike every other combat AoE in this file (turret/tesla/trap, which only ever hit attackers),
// this ONE explosion is a real friendly-fire hazard, same as the RimWorld mechanic it's modeling
// -- it can hurt nearby citizens and structures too, just at a reduced fraction
// (TURRET_SELFDESTRUCT_CITIZEN_MULT/STRUCTURE_MULT) of the full attacker-facing damage, so "don't
// stand next to a dying turret" is a real but not devastating lesson. Kept a single, non-chaining
// roll (destroying a neighboring structure below does NOT re-roll its own self-destruct) so this
// can't cascade into wiping out an entire turret line from one lucky/unlucky roll.
export function maybeTurretSelfDestruct(s, structures, citizens, attackers, rng = Math.random, onScrap = null, onKill = null) {
  if (!isTurretFamilyKind(s.kind)) return;
  if (rng() >= TURRET_SELFDESTRUCT_CHANCE) return;

  if (attackers) {
    for (let j = 0; j < attackers.count; j++) {
      if (!attackers.isAliveAt(j)) continue;
      if (Math.hypot(attackers.x[j] - s.x, attackers.y[j] - s.y) > TURRET_SELFDESTRUCT_RADIUS) continue;
      if (damageAttacker(attackers, j, TURRET_SELFDESTRUCT_DAMAGE, DamageType.Explosive, TURRET_SELFDESTRUCT_PENETRATION, rng)) {
        onScrap?.(SCRAP_PER_KILL); onKill?.();
      }
    }
  }

  if (citizens) {
    for (let c = 0; c < citizens.count; c++) {
      if (!citizens.isAliveAt(c)) continue;
      if (Math.hypot(citizens.x[c] - s.x, citizens.y[c] - s.y) > TURRET_SELFDESTRUCT_RADIUS) continue;
      const armorRating = citizens.hasVest?.[c] ? CITIZEN_VEST_ARMOR_RATING : 0;
      const { dealt } = resolveCitizenArmorRoll(armorRating, 0, TURRET_SELFDESTRUCT_DAMAGE * TURRET_SELFDESTRUCT_CITIZEN_MULT, rng);
      citizens.health[c] -= dealt;
      if (citizens.health[c] <= 0) {
        citizens.health[c] = 0.05;
        citizens.flags[c] |= CitizenFlags.Downed;
      }
    }
  }

  for (const other of structures) {
    if (other === s || other.destroyed || other.underConstruction) continue;
    if (Math.hypot(other.x - s.x, other.y - s.y) > TURRET_SELFDESTRUCT_RADIUS) continue;
    other.health -= TURRET_SELFDESTRUCT_DAMAGE * TURRET_SELFDESTRUCT_STRUCTURE_MULT;
    if (other.health <= 0) other.destroyed = true; // not re-rolled -- see the no-chaining note above
  }
}

// Periodic hazard damage around any nuclear generator that isn't guarded by a nearby waste
// storage -- mirrors tickAttackerVsCitizens's downed-then-dead pattern for citizens, and the
// fence-damage/destroyed pattern (tickAttackers) for structures, so an unguarded reactor reads as
// a real threat rather than a stat debuff.
// attackers/rng (added for the turret self-destruct hook above, both optional/null-safe): the
// existing world.js call site passes neither (`tickNuclearHazard(this.structures, this.citizens)`,
// exactly 2 args), so the attacker-facing half of a self-destruct explosion triggered from THIS
// path is inert until world.js's owner adds `this.attackers, this.rng` to that call -- citizen/
// structure damage from the same explosion still works today since neither depends on attackers.
export function tickNuclearHazard(structures, citizens, attackers = null, rng = Math.random) {
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
      const healthMult = (citizens.trait[c]?.healthMult ?? 1) * ageBandFor(citizens.age[c]).healthMult * rankHealthMultFor(citizens, c) * augmentHealthMultFor(citizens, c);
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
      if (s.health <= 0) {
        s.destroyed = true;
        maybeTurretSelfDestruct(s, structures, citizens, attackers, rng);
      }
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
    // Non-lethal incapacitation (security.js's WeaponTier.StunBaton, see applyStun above): frozen
    // in place for the duration -- no movement, no fence-chewing, no trap-triggering this tick.
    // Ticks down here rather than a separate pass so a stunned attacker's clock only advances on
    // ticks it would otherwise have acted, matching the "briefly incapacitated" framing.
    if (attackers.stunTicksRemaining[i] > 0) { attackers.stunTicksRemaining[i]--; continue; }

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
      // Trap variety (TRAP_KINDS, see its doc comment above): 'trap' resolves to the exact same
      // damage/type/penetration/single-target behavior it always had, so this is byte-for-byte
      // unchanged for any pre-existing trap/save.
      const tk = TRAP_KINDS[t.kind];
      if (!tk || t.triggered || t.underConstruction) continue;
      if (Math.hypot(attackers.x[i] - t.x, attackers.y[i] - t.y) < TRAP_TRIGGER_RANGE) {
        t.triggered = true; t.destroyed = true;
        // Traps are (mostly) the game's Explosive source: the counter to armored Brutes, wasted on
        // Skirmishers (who mostly run clear of the blast) -- trap_spike is the one exception, see
        // its own doc comment above for why it deliberately skips that matchup entirely.
        if (tk.radius > 0) {
          // trap_explosive: hits every live attacker within radius, not just the one that
          // stepped on it -- can catch a whole cluster in one placement.
          for (let j = 0; j < attackers.count; j++) {
            if (!attackers.isAliveAt(j)) continue;
            if (Math.hypot(attackers.x[j] - t.x, attackers.y[j] - t.y) > tk.radius) continue;
            if (damageAttacker(attackers, j, tk.damage, tk.type, tk.penetration, rng)) { onScrap?.(SCRAP_PER_KILL); onKill?.(); }
          }
        } else if (damageAttacker(attackers, i, tk.damage, tk.type, tk.penetration, rng)) {
          onScrap?.(SCRAP_PER_KILL); onKill?.();
        }
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
// ammo/consumeAmmo (this session's ammo pass, see AMMO_PER_SHOT_TURRET/AMMO_PER_SHOT_TESLA and
// TURRET_FALLBACK_*'s doc comments above): `ammo` is the settlement's CURRENT stockpile (a plain
// number, not a callback -- read-only here, so tickTurrets can decide up front whether this
// activation can afford a real shot before it commits to firing), `consumeAmmo(amount)` is only
// actually invoked once a shot is genuinely taken (a target was found this tick) and only when
// the stockpile covered it -- a turret that finds no target never touches ammo at all, same as
// before this feature existed. Both default (Infinity / null) to "always has ammo, nothing to
// consume", so every pre-existing call site (tests, console pokes) keeps its exact old behavior.
export function tickTurrets(structures, attackers, onScrap, onFire, onKill, rng = Math.random, accuracyMult = 1, ammo = Infinity, consumeAmmo = null) {
  for (const s of structures) {
    // Turret tiers (TURRET_TIERS, see the doc comment near TURRET_RANGE above) + tesla + mortar
    // all share this one tick function -- 'turret'/'tesla' behave byte-for-byte as they always
    // did (TURRET_TIERS.turret === the old flat constants), turret_mini/turret_auto/turret_sniper
    // are new tiers, mortar is a structurally distinct indirect-fire branch handled first below.
    const tier = TURRET_TIERS[s.kind];
    const isTesla = s.kind === 'tesla';
    const isMortar = s.kind === 'mortar';
    if (!tier && !isTesla && !isMortar) continue;
    if (s.destroyed || s.underConstruction) continue;
    if (s.cooldown > 0) { s.cooldown--; continue; }

    if (isMortar) {
      // Indirect fire (see the MORTAR_* doc comment above): targets the nearest live attacker's
      // current position, then scatters the actual impact point around it -- deliberately NOT
      // run through rollsHit/accuracyMult at all, since a mortar's "miss" is scatter distance, not
      // a binary hit roll like every other weapon in this file. No powered bonus, no suppression
      // interaction -- a stationary indirect-fire tube isn't "aiming" the way a direct-fire
      // emplacement is.
      const targetI = nearestAliveAttacker(attackers, s.x, s.y, MORTAR_RANGE);
      if (targetI < 0) continue;
      const hasAmmo = ammo >= AMMO_PER_SHOT_MORTAR;
      s.cooldown = MORTAR_COOLDOWN_TICKS;
      onFire?.(s);
      s.outOfAmmo = !hasAmmo;
      if (!hasAmmo) continue; // dry -- a mortar has no melee fallback, it's a stationary tube
      consumeAmmo?.(AMMO_PER_SHOT_MORTAR);
      const ang = rng() * Math.PI * 2;
      const scatterDist = rng() * MORTAR_SCATTER_RADIUS;
      const landX = attackers.x[targetI] + Math.cos(ang) * scatterDist;
      const landY = attackers.y[targetI] + Math.sin(ang) * scatterDist;
      for (let j = 0; j < attackers.count; j++) {
        if (!attackers.isAliveAt(j)) continue;
        if (Math.hypot(attackers.x[j] - landX, attackers.y[j] - landY) > MORTAR_BLAST_RADIUS) continue;
        if (damageAttacker(attackers, j, MORTAR_DAMAGE, DamageType.Explosive, MORTAR_PENETRATION, rng)) { onScrap?.(SCRAP_PER_KILL); onKill?.(); }
      }
      continue;
    }

    const powered = isPoweredBonus(structures, s.x, s.y);
    // Range is NOT ammo-gated -- a mechanical turret's traverse/targeting doesn't shrink when it
    // runs dry, only the shot it actually puts out does (see damage/accuracy below).
    const range = (isTesla ? TESLA_RANGE : tier.range) * (powered ? POWERED_RANGE_MULT : 1);
    const baseDamage = (isTesla ? TESLA_DAMAGE : tier.damage) * (powered ? POWERED_DAMAGE_MULT : 1);
    // Tesla coils are the Energy source (armor-piercing, the answer to a Boss); plain/mini/auto/
    // sniper turrets are all Kinetic (great against unarmored Skirmishers, poor against a Brute's
    // plate) -- sniper-turret's edge against armor comes from its much higher penetration below,
    // not a different damage type, mirroring how staff Sniper vs Guard are differentiated too.
    const dtype = isTesla ? DamageType.Energy : DamageType.Kinetic;
    const penetration = isTesla ? TESLA_PENETRATION : tier.penetration;
    // Autocannon's minRange (see TURRET_TIERS/economy.js's doc comments): 0 for every other tier,
    // so this is a no-op for 'turret'/turret_mini/turret_sniper and byte-for-byte unchanged.
    const minRange = isTesla ? 0 : (tier.minRange || 0);
    // Suppression (see tickSuppression above): concentrated attacker presence in this turret's own
    // range degrades its own accuracy, on top of whatever the ammo state does.
    const supMult = suppressionAccuracyMult(s.suppression || 0);
    const ammoPerShot = isTesla ? AMMO_PER_SHOT_TESLA : tier.ammoPerShot;
    const hasAmmo = ammo >= ammoPerShot;
    const damage = hasAmmo ? baseDamage : baseDamage * TURRET_FALLBACK_DAMAGE_MULT;
    const effAccuracy = (hasAmmo ? accuracyMult : accuracyMult * TURRET_FALLBACK_ACCURACY_MULT) * supMult;

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
        if (rollsHit(rng, effAccuracy) && damageAttacker(attackers, i, damage, dtype, penetration, rng)) { onScrap?.(SCRAP_PER_KILL); onKill?.(); }
      }
      if (hitAny) {
        s.cooldown = TESLA_COOLDOWN_TICKS;
        onFire?.(s);
        s.outOfAmmo = !hasAmmo;
        if (hasAmmo) consumeAmmo?.(ammoPerShot); // one battery discharge per activation, not per chained target
      }
      continue;
    }

    const bestI = nearestAliveAttacker(attackers, s.x, s.y, range, minRange);
    if (bestI >= 0) {
      s.cooldown = tier.cooldown;
      onFire?.(s);
      s.outOfAmmo = !hasAmmo;
      if (hasAmmo) consumeAmmo?.(ammoPerShot);
      if (rollsHit(rng, effAccuracy) && damageAttacker(attackers, bestI, damage, dtype, penetration, rng)) { onScrap?.(SCRAP_PER_KILL); onKill?.(); }
    }
  }
}

// Exported so draft.js can reuse it for right-click "attack this target" detection (is there a
// live attacker under the cursor?) instead of re-implementing the same nearest-in-range scan.
// minRange (turret_auto's autocannon tradeoff, see TURRET_TIERS above): defaults to 0, so every
// pre-existing call site (draft.js, input.js, tickTurrets' tesla/mortar branches, tests) keeps
// its exact old "closest attacker within maxRange, full stop" behavior -- a target strictly closer
// than minRange is skipped entirely, same as if it were out of range on the far side.
export function nearestAliveAttacker(attackers, x, y, maxRange, minRange = 0) {
  let bestI = -1, bestDist = maxRange;
  for (let i = 0; i < attackers.count; i++) {
    if (!attackers.isAliveAt(i)) continue;
    const d = Math.hypot(attackers.x[i] - x, attackers.y[i] - y);
    if (d < minRange) continue;
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
export function tickAttackerVsCitizens(attackers, citizens, onDowned, rng = Math.random, accuracyMult = 1, onContact = null, roster = null, idOf = null) {
  for (let i = 0; i < attackers.count; i++) {
    if (!attackers.isAliveAt(i)) continue;
    // Non-lethal incapacitation (see applyStun/tickAttackers above): a stunned attacker can't
    // land a contact hit on anyone this tick either -- the whole point of the takedown.
    if (attackers.stunTicksRemaining[i] > 0) continue;
    // Per-archetype reach: a Boss's contactRange is wide enough that it hits every citizen in a
    // small area each tick (this loop damages everyone in range), which is its cleave attack.
    const arch = attackers.archetypeAt(i);
    const reach = arch.contactRange ?? ATTACKER_CONTACT_RANGE;
    for (let c = 0; c < citizens.count; c++) {
      if (!citizens.isAliveAt(c)) continue;
      if (Math.hypot(attackers.x[i] - citizens.x[c], attackers.y[i] - citizens.y[c]) > reach) continue;
      if (!rollsHit(rng, accuracyMult)) continue;
      onContact?.(citizens.x[c], citizens.y[c]);
      // Suppression (see tickSuppression's doc comment above): a landed hit, hostile or lethal or
      // not, is real sustained incoming fire against this specific citizen -- builds their
      // suppression directly (read back out by tickStaffCombat below for a Guard/Sniper's own
      // return-fire accuracy). Every citizen carries this field, not just staff, matching the
      // "(or citizen)" scope note in the task brief even though only staff currently act on it.
      citizens.suppression[c] = Math.min(1, (citizens.suppression[c] || 0) + SUPPRESSION_GAIN_PER_HIT);

      if (citizens.isDownedAt(c)) {
        const dx = citizens.x[c], dy = citizens.y[c];
        citizens.flags[c] |= CitizenFlags.Dead;
        citizens.alive[c] = 0;
        onDowned?.(dx, dy, true);
        continue;
      }

      // Guard rank promotion (security.js): Officer/Specialist toughness bonus, staff-only (a
      // plain citizen has no roster entry, guardRankCombatMult falls back to GuardRank.Base = 1x).
      // roster/idOf are optional (defensive default for any older/test caller) -- no-op to 1x when
      // absent, same backward-compatible pattern hasVest?.[c] just below already uses.
      const guardToughMult = roster && idOf ? guardRankCombatMult(roster, idOf(c)).healthMult : 1;
      const healthMult = (citizens.trait[c]?.healthMult ?? 1) * ageBandFor(citizens.age[c]).healthMult * rankHealthMultFor(citizens, c) * augmentHealthMultFor(citizens, c) * guardToughMult;
      const baseDamage = (ATTACKER_CITIZEN_DAMAGE * arch.damageMult) / healthMult;
      // Vest armor (see the "citizen armor (Vest)" section above) -- citizens.hasVest is a plain
      // Uint8Array duck-typed off the passed-in store, same access pattern as citizens.trait just
      // above, so this stays backward compatible with any older/test CitizenStore that predates
      // the field (hasVest undefined -> `?.[c]` reads undefined -> falsy -> armorRating 0, exactly
      // the old always-full-damage behavior).
      const armorRating = citizens.hasVest?.[c] ? CITIZEN_VEST_ARMOR_RATING : 0;
      const { dealt } = resolveCitizenArmorRoll(armorRating, ATTACKER_CONTACT_PENETRATION, baseDamage, rng);
      citizens.health[c] -= dealt;
      if (citizens.health[c] <= 0) {
        citizens.health[c] = 0.05;
        citizens.flags[c] |= CitizenFlags.Downed;
        onDowned?.(citizens.x[c], citizens.y[c], false);
      }
    }
  }
}

// ---------------------------------------------------------------- range-based accuracy falloff
// RimWorld's real 4-band accuracy-by-range system (Touch/Short/Medium/Long, each weapon defining
// its own AccuracyTouch/Short/Medium/Long) -- staff combat previously used one flat accuracyMult
// regardless of how far the target actually was, so a guard plinking at maximum range was exactly
// as reliable as one standing next to their target. Scoped to tickStaffCombat ONLY, per the task
// brief -- turret accuracy is untouched (turrets already have their own suppression/ammo accuracy
// modifiers and this project's turret balance is flagged BALANCE-CRITICAL elsewhere in this file;
// staff weapons were the explicit priority).
//
// Band edges are FRACTIONS of the shooter's own current range (post weapon-tier rangeMult), not
// fixed world-unit thresholds, so a Sniper's much longer range and a Guard's short range both get
// a full touch->long spread instead of a sniper's "medium" shot landing inside a guard's
// fixed-unit "long" band.
//
// Multiplier tuning was NOT picked from thin air: this project's real ATTACKER_SPEED/GUARD_RANGE/
// GUARD_COOLDOWN/SNIPER_RANGE/SNIPER_COOLDOWN constants were fed into a standalone approach-and-
// fire simulation (attacker enters range, guard/sniper fires every cooldown while the attacker
// keeps closing, same movement math tickAttackers uses) to find the REAL population-weighted
// distribution of shot distances across a Grunt/Skirmisher/Brute approach and a Sniper engagement
// -- roughly touch 9% / short 25% / medium 37% / long 29% of all shots fired. ACCURACY_BAND_MULT's
// four values were then chosen so that distribution's weighted average lands within ~2% of the old
// flat 1.0 baseline (1.30*.09 + 1.15*.25 + 1.00*.37 + 0.85*.29 ~= 1.02), per this session's own
// balance-regression concerns -- this is meant to add real "closer is more reliable" texture
// without silently nerfing (or buffing) overall staff-combat DPS. Monotonically decreasing with
// distance, same shape as RimWorld's own accuracy curve for most guns. Re-verify with a real soak
// if these are ever retuned -- this was a simulation of the MOVEMENT math, not a live engine soak.
export const ACCURACY_BAND_MULT = Object.freeze({ touch: 1.30, short: 1.15, medium: 1.0, long: 0.85 });
const ACCURACY_BAND_FRACTIONS = Object.freeze({ touch: 0.15, short: 0.4, medium: 0.75 }); // long = anything beyond medium's own fraction

/** Multiplier for a shot fired at `distance` out of a weapon's current `maxRange` -- combines
 *  multiplicatively with the existing weather/suppression/ammo accuracyMult chain, it does not
 *  replace any of them. Exported in case draft.js's drafted-combat mirror wants the same curve. */
export function rangeAccuracyMult(distance, maxRange) {
  if (maxRange <= 0) return ACCURACY_BAND_MULT.long;
  const frac = distance / maxRange;
  if (frac <= ACCURACY_BAND_FRACTIONS.touch) return ACCURACY_BAND_MULT.touch;
  if (frac <= ACCURACY_BAND_FRACTIONS.short) return ACCURACY_BAND_MULT.short;
  if (frac <= ACCURACY_BAND_FRACTIONS.medium) return ACCURACY_BAND_MULT.medium;
  return ACCURACY_BAND_MULT.long;
}

// ---------------------------------------------------------------- burst fire
// Real RimWorld multi-shot-per-activation mechanic for higher-tier guns (e.g. the real Assault
// Rifle's burstShotCount: 3) -- a flat 1-shot-per-activation left Rifle/Heavy Armory issuance a
// pure damage/range/cooldown multiplier with no "more rounds downrange" texture of its own. Keyed
// off the WEAPON TIER STRING (security.js's WeaponTier: 'Sidearm'/'Rifle'/'Heavy'/'StunBaton'),
// not a new field added to security.js's own WEAPON_TIERS table -- security.js is a different
// file/agent's scope this session, so this stays entirely inside siege.js rather than risking a
// concurrent edit collision there. Any tier not listed here (Sidearm, StunBaton) defaults to 1
// shot -- byte-for-byte the old behavior for anyone nobody's built a Rifle/Heavy Armory tier for.
const BURST_SHOTS_BY_WEAPON = Object.freeze({ Rifle: 2, Heavy: 3 });

// Guards/snipers fight back with their personal weapon (short/long range respectively),
// separate from turret coverage. Gains combat skill on a confirmed kill.
// rng/accuracyMult: same weather-scaled hit roll as tickTurrets -- a guard/sniper still fires and
// goes on cooldown on a miss, just doesn't connect. Skill gain only happens on a confirmed kill,
// which already requires a hit, so a foggy/rainy stretch also slows skill progression a little,
// same knock-on realism as RimWorld's own accuracy modifier. Defaults to always-hit.
// ammo/consumeAmmo (this session's ammo pass): same shape/defaults as tickTurrets above -- `ammo`
// is the settlement's current stockpile (read-only, used to decide up front which range/stats this
// tick's shot uses), `consumeAmmo(amount)` only actually fires once a real target was found and the
// stockpile covered the cost. Defaults (Infinity / null) keep every pre-existing call site
// unaffected.
export function tickStaffCombat(citizens, roster, idOf, attackers, onScrap, onKill, rng = Math.random, accuracyMult = 1, ammo = Infinity, consumeAmmo = null) {
  for (let i = 0; i < citizens.count; i++) {
    if (!citizens.isAliveAt(i)) continue;
    if (citizens.isDownedAt(i)) continue; // downed guards/snipers can't fight back
    // Drafted (draft.js): a drafted guard/sniper fights whatever the player specifically ordered
    // (draft.js's own tickDraftedCombat), not the nearest-target auto-engage below.
    if (citizens.isDraftedAt(i)) continue;
    const kind = roster.kindOf(idOf(i));
    if (kind !== 'Guard' && kind !== 'Sniper') continue;

    if (citizens._staffCooldown[i] > 0) { citizens._staffCooldown[i]--; continue; }

    // Armory-issued weapon tier (security.js WEAPON_TIERS/tickArmoryIssuance) multiplies the
    // role's baseline stats -- Sidearm is 1x everywhere (identical to the old flat constants) for
    // any guard/sniper nobody's built an Armory for yet. weaponKey (the raw string, e.g. 'Rifle')
    // kept alongside the resolved tier object -- BURST_SHOTS_BY_WEAPON above is keyed by this
    // string, not by the tier object itself.
    const weaponKey = roster.weaponOf(idOf(i));
    const tier = WEAPON_TIERS[weaponKey] || WEAPON_TIERS.Sidearm;
    // Suppression (see tickSuppression's doc comment above) -- read once, applied to whichever
    // branch below actually takes a shot (lethal or non-lethal).
    const supMult = suppressionAccuracyMult(citizens.suppression[i] || 0);

    // Stun Baton (security.js WeaponTier.StunBaton): a melee tool already -- the ammo mechanic
    // deliberately doesn't touch it (see AMMO_PER_SHOT_GUARD's doc comment), so this branch is
    // unchanged from before this feature existed except for the added suppression AND range-based
    // accuracy multipliers.
    if (tier.nonLethal) {
      const range = (kind === 'Sniper' ? SNIPER_RANGE : GUARD_RANGE) * tier.rangeMult;
      const targetI = nearestAliveAttacker(attackers, citizens.x[i], citizens.y[i], range);
      if (targetI >= 0) {
        citizens._staffCooldown[i] = Math.round((kind === 'Sniper' ? SNIPER_COOLDOWN : GUARD_COOLDOWN) * tier.cooldownMult);
        const dist = Math.hypot(attackers.x[targetI] - citizens.x[i], attackers.y[targetI] - citizens.y[i]);
        const rMult = rangeAccuracyMult(dist, range);
        if (rollsHit(rng, accuracyMult * supMult * rMult) && attackers.isAliveAt(targetI) && rng() < tier.stunChance) {
          applyStun(attackers, targetI, tier.stunDurationTicks);
        }
      }
      continue;
    }

    // Ammo fallback (see GUARD_FALLBACK_*'s doc comment above): checked BEFORE searching for a
    // target, since a dry weapon's much shorter melee range changes who's even in reach -- an
    // out-of-ammo guard shouldn't "snipe" a target 3+ tiles away with a fallback stat block that's
    // supposed to represent a close-quarters scuffle.
    const ammoPerShot = kind === 'Sniper' ? AMMO_PER_SHOT_SNIPER : AMMO_PER_SHOT_GUARD;
    const hasAmmo = ammo >= ammoPerShot;
    citizens.outOfAmmo[i] = hasAmmo ? 0 : 1;

    const baseDamage = kind === 'Sniper' ? SNIPER_DAMAGE : GUARD_DAMAGE;
    const range = hasAmmo ? (kind === 'Sniper' ? SNIPER_RANGE : GUARD_RANGE) * tier.rangeMult : GUARD_FALLBACK_RANGE;
    // Guard rank promotion (security.js, real Prison Architect guardrank_settings.txt): Officer/
    // Specialist attack-power bonus stacks on top of augment/tier/ammo-fallback multipliers.
    const damage = (hasAmmo ? baseDamage * tier.damageMult : baseDamage * GUARD_FALLBACK_DAMAGE_MULT)
      * augmentDamageMultFor(citizens, i) * guardRankCombatMult(roster, idOf(i)).attackMult;
    const cooldown = Math.round((kind === 'Sniper' ? SNIPER_COOLDOWN : GUARD_COOLDOWN) * (hasAmmo ? tier.cooldownMult : 1));
    // Guards carry conventional sidearms (Kinetic); snipers carry the long-range armor-piercing
    // rifle (Energy), so a sniper line is the personnel answer to Brutes/Bosses. A dry-fallback
    // melee scuffle is Kinetic regardless of role -- it's fists/a knife either way, not the
    // sniper's rifle anymore.
    const dtype = hasAmmo && kind === 'Sniper' ? DamageType.Energy : DamageType.Kinetic;
    // Weapon-tier penetration bonus (security.js WEAPON_TIERS.penetrationBonus) stacks on top of
    // the role's baseline -- Sidearm's +0 keeps this byte-for-byte identical to the pre-tier
    // constant for anyone nobody's built an Armory for yet, when ammo is available.
    const penetration = hasAmmo ? (kind === 'Sniper' ? SNIPER_PENETRATION : GUARD_PENETRATION) + (tier.penetrationBonus || 0) : GUARD_FALLBACK_PENETRATION;

    const targetI = nearestAliveAttacker(attackers, citizens.x[i], citizens.y[i], range);
    if (targetI >= 0) {
      citizens._staffCooldown[i] = cooldown;
      // Range-based accuracy falloff (see ACCURACY_BAND_MULT's doc comment above) -- distance is
      // measured once per activation, not re-measured per burst shot below (the target isn't
      // moving mid-tick).
      const dist = Math.hypot(attackers.x[targetI] - citizens.x[i], attackers.y[targetI] - citizens.y[i]);
      const rMult = rangeAccuracyMult(dist, range);
      // Burst fire (BURST_SHOTS_BY_WEAPON above): a dry fallback melee swing never bursts (no
      // ammo left to spend on extra shots, and it's fists/a knife, not a gun) -- Sidearm and any
      // future tier not listed there also default to the old single-shot behavior.
      const burstShots = hasAmmo ? (BURST_SHOTS_BY_WEAPON[weaponKey] || 1) : 1;
      let target = targetI;
      for (let shot = 0; shot < burstShots; shot++) {
        if (!attackers.isAliveAt(target)) break; // target's already down -- nothing left for the rest of this burst to hit
        const landed = rollsHit(rng, accuracyMult * supMult * rMult);
        // Ammo is spent on pulling the trigger (a real shot was taken), not just on a confirmed
        // hit -- same "a shot was fired" framing tickTurrets already uses for its own cooldown,
        // now applied per burst shot. A dry fallback melee swing costs nothing (burstShots is 1).
        if (hasAmmo) consumeAmmo?.(ammoPerShot);
        if (landed && damageAttacker(attackers, target, damage, dtype, penetration, rng)) {
          citizens.skillCombat[i] += 0.05 * PASSION_GAIN_MULT[citizens.passionCombat[i]] * ageBandFor(citizens.age[i]).skillGainMult;
          onScrap?.(SCRAP_PER_KILL);
          onKill?.();
          break; // target's dead -- rest of the burst has nothing left to hit
        }
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
    const healthMult = (store.trait[idx]?.healthMult ?? 1) * ageBandFor(store.age[idx]).healthMult * rankHealthMultFor(store, idx) * augmentHealthMultFor(store, idx);
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
