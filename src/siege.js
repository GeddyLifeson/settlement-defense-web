// Ported/condensed from SD.Siege (wave spawner, AttackerStore, turret/fence/trap placement +
// combat resolution, scrap rewards).
import { SCRAP_PER_KILL } from './economy.js';
import { CitizenFlags } from './citizens.js';
import { isPoweredAt } from './power.js';
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
// BALANCE-CRITICAL, soak-tested. A first pass at (Brute 2.6hp/0.5-kinetic, Boss 9.0hp, 12% boss
// roll) dropped hands-off survival ~28% below the same-build baseline and put a Boss in over half
// of all waves. These numbers were swept until three-seed mean survival matched the pre-archetype
// baseline of the same build almost exactly (21.0k vs 21.0k ticks). Retune only against a fresh
// A/B soak -- the effective toughness of a Brute is healthMult x its kinetic RESISTANCE below,
// not healthMult alone, so the two tables have to move together.
export const ATTACKER_ARCHETYPES = Object.freeze([
  { name: 'Grunt',      healthMult: 1.0,  speedMult: 1.0, damageMult: 1.0, contactRange: 0.5 },
  { name: 'Brute',      healthMult: 1.8,  speedMult: 0.5, damageMult: 1.4, contactRange: 0.6 },
  { name: 'Skirmisher', healthMult: 0.45, speedMult: 1.9, damageMult: 0.7, contactRange: 0.5 },
  { name: 'Boss',       healthMult: 5.0,  speedMult: 0.7, damageMult: 2.2, contactRange: 1.3 },
]);

export function archetypeOf(kind) {
  return ATTACKER_ARCHETYPES[kind] || ATTACKER_ARCHETYPES[AttackerKind.Grunt];
}

// ---------------------------------------------------------------- weapon / armor damage types
// RimWorld's weapon-vs-armor system, condensed to three legible types instead of RimWorld's full
// sharp/blunt/heat matrix. The point is a real rock-paper-scissors, not flat multipliers on
// everything: exactly one archetype is the intended answer for each damage type, and the Grunt is
// a deliberate all-1.0 baseline so the table stays readable.
//
//   Kinetic   -- turrets, guard sidearms, K9 bites (the bread-and-butter defense)
//   Explosive -- traps (one-shot burst placements)
//   Energy    -- tesla coils, sniper rifles (expensive/slow, but shreds heavy armor)
export const DamageType = Object.freeze({
  Kinetic: 0,
  Explosive: 1,
  Energy: 2,
});

// [kind][damageType] -> incoming-damage multiplier. >1 = vulnerable, <1 = resistant.
// Brute: heavy plate shrugs off bullets, but it's slow and can't avoid a mine -> bring traps.
// Skirmisher: no armor at all so bullets tear it up, but it's fast enough to run out of blasts.
// Boss: the armor answer is energy weapons (tesla/snipers), not more turrets.
export const RESISTANCE = Object.freeze([
  /* Grunt      */ Object.freeze([1.0,  1.0,  1.0]),
  /* Brute      */ Object.freeze([0.65, 1.75, 1.0]),
  /* Skirmisher */ Object.freeze([1.35, 0.6,  1.0]),
  /* Boss       */ Object.freeze([0.7,  0.9,  1.5]),
]);

export function resistanceMult(kind, damageType) {
  const row = RESISTANCE[kind] || RESISTANCE[AttackerKind.Grunt];
  const m = row[damageType];
  return m === undefined ? 1 : m;
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

// Single choke point for every "something hurt an attacker" site in the codebase, so the
// resistance lookup can never be forgotten at one of them. Returns true if this hit killed.
export function damageAttacker(attackers, i, amount, damageType = DamageType.Kinetic) {
  if (!attackers.isAliveAt(i)) return false;
  attackers.health[i] -= amount * resistanceMult(attackers.kind[i], damageType);
  if (attackers.health[i] <= 0) {
    attackers.alive[i] = 0;
    return true;
  }
  return false;
}

export class Structure {
  constructor(kind, x, y, opts = {}) {
    this.kind = kind; // 'turret' | 'fence' | 'trap' | 'bed' | 'table' | 'door' | 'generator' | 'wire' | 'wall' |
                      // 'generator_nuclear' | 'waste_storage' | 'generator_coal' | 'generator_wind' |
                      // 'generator_solar' (SEA:R multi-source power economy, see power.js's isSource)
    this.x = x; this.y = y;
    this.health = kind === 'fence' ? 0.6 : 1;
    this.destroyed = false;
    this.cooldown = 0;
    this.triggered = false; // traps: single-use
    // Blueprint/construction pipeline (RimWorld-style: place an order, a citizen builds it over
    // time instead of it appearing instantly) -- opts.instant skips this for the wave-4-starter
    // turrets so a fresh colony isn't defenseless while nobody has built anything yet.
    this.underConstruction = !opts.instant;
    this.buildProgress = opts.instant ? 1 : 0;
    this.claimedBy = null;
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

// Roster-composition rates, soak-tested alongside ATTACKER_ARCHETYPES/RESISTANCE -- see the
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

  waveCount() {
    return Math.round((2 + Math.min(10, this.waveNumber * 1.5)) * this.strengthFactor);
  }

  waveBaseHealth() {
    return (1 + this.waveNumber * 0.1) * Math.max(0.7, this.strengthFactor);
  }

  // Roster composition by wave: pure Grunts early, Skirmishers join at wave 2, Brutes at 3, and a
  // single rare Boss becomes possible from wave 8 onward. Bosses are gated three ways -- at most
  // one per wave, a low per-attacker roll, AND a minimum gap of BOSS_WAVE_GAP waves since the last
  // one -- because with waves this frequent, "12% per attacker, one per wave" alone put a Boss in
  // over half of all waves in soak-testing. A Boss is meant to be an event.
  rollKind(rng, bossAllowed) {
    const bossReady = this.waveNumber >= BOSS_MIN_WAVE &&
      (this._lastBossWave == null || this.waveNumber - this._lastBossWave >= BOSS_WAVE_GAP);
    if (bossAllowed && bossReady && rng() < BOSS_CHANCE) {
      this._lastBossWave = this.waveNumber;
      return AttackerKind.Boss;
    }
    const r = rng();
    if (this.waveNumber >= 3 && r < BRUTE_RATE) return AttackerKind.Brute;
    if (this.waveNumber >= 2 && r < BRUTE_RATE + SKIRMISHER_RATE) return AttackerKind.Skirmisher;
    return AttackerKind.Grunt;
  }

  spawnOneWave(currentTick, attackers, rng) {
    this.waveNumber++;
    this.lastArrival = ArrivalMethod.Edge;
    const count = this.waveCount();
    const baseHealth = this.waveBaseHealth();
    let bossAllowed = true;
    for (let n = 0; n < count; n++) {
      const edge = Math.floor(rng() * 4);
      let x, y;
      if (edge === 0) { x = 0; y = rng() * this.grid.height; }
      else if (edge === 1) { x = this.grid.width - 1; y = rng() * this.grid.height; }
      else if (edge === 2) { x = rng() * this.grid.width; y = 0; }
      else { x = rng() * this.grid.width; y = this.grid.height - 1; }
      const kind = this.rollKind(rng, bossAllowed);
      if (kind === AttackerKind.Boss) bossAllowed = false;
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
    const count = Math.max(2, Math.round(this.waveCount() * 0.7));
    const baseHealth = this.waveBaseHealth();
    let bossAllowed = true;
    for (let n = 0; n < count; n++) {
      const ang = rng() * Math.PI * 2;
      const r = rng() * TUNNEL_CLUSTER_RADIUS;
      const x = Math.max(0, Math.min(this.grid.width - 1, mouth.x + Math.cos(ang) * r));
      const y = Math.max(0, Math.min(this.grid.height - 1, mouth.y + Math.sin(ang) * r));
      const kind = this.rollKind(rng, bossAllowed);
      if (kind === AttackerKind.Boss) bossAllowed = false;
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
export function tickAttackers(attackers, structures, grid, centerX, centerY, citizens, onScrap, onKill) {
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
      const speed = ATTACKER_SPEED * arch.speedMult * (inFloodlight ? FLOODLIGHT_SLOW_MULT : 1);
      attackers.x[i] += (dx / dist) * speed;
      attackers.y[i] += (dy / dist) * speed;
    }

    for (const t of structures) {
      if (t.kind !== 'trap' || t.triggered || t.underConstruction) continue;
      if (Math.hypot(attackers.x[i] - t.x, attackers.y[i] - t.y) < TRAP_TRIGGER_RANGE) {
        t.triggered = true; t.destroyed = true;
        // Traps are the game's Explosive source: the counter to armored Brutes, wasted on
        // Skirmishers (who mostly run clear of the blast).
        if (damageAttacker(attackers, i, TRAP_DAMAGE, DamageType.Explosive)) { onScrap?.(SCRAP_PER_KILL); onKill?.(); }
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

export function tickTurrets(structures, attackers, onScrap, onFire, onKill) {
  for (const s of structures) {
    if (s.kind !== 'turret' && s.kind !== 'tesla') continue;
    if (s.destroyed || s.underConstruction) continue;
    if (s.cooldown > 0) { s.cooldown--; continue; }

    const powered = isPowered(structures, s.x, s.y);
    const isTesla = s.kind === 'tesla';
    const range = (isTesla ? TESLA_RANGE : TURRET_RANGE) * (powered ? POWERED_RANGE_MULT : 1);
    const damage = (isTesla ? TESLA_DAMAGE : TURRET_DAMAGE) * (powered ? POWERED_DAMAGE_MULT : 1);
    // Tesla coils are the Energy source (armor-piercing, the answer to a Boss); plain turrets
    // are Kinetic (great against unarmored Skirmishers, poor against a Brute's plate).
    const dtype = isTesla ? DamageType.Energy : DamageType.Kinetic;

    if (isTesla) {
      // Chains to every attacker in range instead of picking one -- Tesla's SEA:R niche is
      // crowd control, not single-target DPS (that's what plain turrets are for).
      let hitAny = false;
      for (let i = 0; i < attackers.count; i++) {
        if (!attackers.isAliveAt(i)) continue;
        if (Math.hypot(attackers.x[i] - s.x, attackers.y[i] - s.y) > range) continue;
        hitAny = true;
        if (damageAttacker(attackers, i, damage, dtype)) { onScrap?.(SCRAP_PER_KILL); onKill?.(); }
      }
      if (hitAny) { s.cooldown = TESLA_COOLDOWN_TICKS; onFire?.(s); }
      continue;
    }

    const bestI = nearestAliveAttacker(attackers, s.x, s.y, range);
    if (bestI >= 0) {
      if (damageAttacker(attackers, bestI, damage, dtype)) { onScrap?.(SCRAP_PER_KILL); onKill?.(); }
      s.cooldown = TURRET_COOLDOWN_TICKS;
      onFire?.(s);
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
export function tickAttackerVsCitizens(attackers, citizens, onDowned) {
  for (let i = 0; i < attackers.count; i++) {
    if (!attackers.isAliveAt(i)) continue;
    // Per-archetype reach: a Boss's contactRange is wide enough that it hits every citizen in a
    // small area each tick (this loop damages everyone in range), which is its cleave attack.
    const arch = attackers.archetypeAt(i);
    const reach = arch.contactRange ?? ATTACKER_CONTACT_RANGE;
    for (let c = 0; c < citizens.count; c++) {
      if (!citizens.isAliveAt(c)) continue;
      if (Math.hypot(attackers.x[i] - citizens.x[c], attackers.y[i] - citizens.y[c]) > reach) continue;

      if (citizens.isDownedAt(c)) {
        citizens.flags[c] |= CitizenFlags.Dead;
        citizens.alive[c] = 0;
        onDowned?.();
        continue;
      }

      const healthMult = citizens.trait[c]?.healthMult ?? 1;
      citizens.health[c] -= (ATTACKER_CITIZEN_DAMAGE * arch.damageMult) / healthMult;
      if (citizens.health[c] <= 0) {
        citizens.health[c] = 0.05;
        citizens.flags[c] |= CitizenFlags.Downed;
        onDowned?.();
      }
    }
  }
}

// Guards/snipers fight back with their personal weapon (short/long range respectively),
// separate from turret coverage. Gains combat skill on a confirmed kill.
export function tickStaffCombat(citizens, roster, idOf, attackers, onScrap, onKill) {
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

    const targetI = nearestAliveAttacker(attackers, citizens.x[i], citizens.y[i], range);
    if (targetI >= 0) {
      citizens._staffCooldown[i] = cooldown;
      if (damageAttacker(attackers, targetI, damage, dtype)) {
        citizens.skillCombat[i] += 0.05 * PASSION_GAIN_MULT[citizens.passionCombat[i]];
        onScrap?.(SCRAP_PER_KILL);
        onKill?.();
      }
    }
  }
}
