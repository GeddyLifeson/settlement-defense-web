// Ported/condensed from SD.Siege (wave spawner, AttackerStore, turret/fence/trap placement +
// combat resolution, scrap rewards).
import { SCRAP_PER_KILL } from './economy.js';
import { CitizenFlags } from './citizens.js';

export class AttackerStore {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.health = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
  }

  spawn(x, y, health = 1) {
    if (this.count >= this.capacity) {
      // recycle a dead slot rather than growing, matches the fixed-capacity C# store
      for (let i = 0; i < this.count; i++) {
        if (!this.alive[i]) {
          this.x[i] = x; this.y[i] = y; this.health[i] = health; this.alive[i] = 1;
          return i;
        }
      }
      return -1;
    }
    const i = this.count++;
    this.x[i] = x; this.y[i] = y; this.health[i] = health; this.alive[i] = 1;
    return i;
  }

  isAliveAt(i) {
    return this.alive[i] === 1;
  }
}

export class Structure {
  constructor(kind, x, y, opts = {}) {
    this.kind = kind; // 'turret' | 'fence' | 'trap' | 'bed' | 'table' | 'door' | 'generator' | 'wall'
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
  }
}

export class WaveSpawner {
  constructor(grid) {
    this.grid = grid;
    this.nextWaveTick = 300; // 30s at 10Hz, first wave grace period
    this.waveNumber = 0;
    this.strengthFactor = 1; // set by director.js each tick
    this.cycleMult = 1; // storyteller-personality breather-length multiplier
    this.doubleChance = 0.1; // odds of immediately queuing a second wave close behind
  }

  spawnOneWave(currentTick, attackers, rng) {
    this.waveNumber++;
    const count = Math.round((2 + Math.min(10, this.waveNumber * 1.5)) * this.strengthFactor);
    for (let n = 0; n < count; n++) {
      const edge = Math.floor(rng() * 4);
      let x, y;
      if (edge === 0) { x = 0; y = rng() * this.grid.height; }
      else if (edge === 1) { x = this.grid.width - 1; y = rng() * this.grid.height; }
      else if (edge === 2) { x = rng() * this.grid.width; y = 0; }
      else { x = rng() * this.grid.width; y = this.grid.height - 1; }
      attackers.spawn(x, y, (1 + this.waveNumber * 0.1) * Math.max(0.7, this.strengthFactor));
    }
  }

  tick(currentTick, attackers, rng) {
    if (currentTick < this.nextWaveTick) return;
    this.spawnOneWave(currentTick, attackers, rng);
    if (rng() < this.doubleChance) this.spawnOneWave(currentTick, attackers, rng); // Cassandra-style back-to-back

    const delay = (600 - Math.min(300, this.waveNumber * 15)) * this.cycleMult;
    this.nextWaveTick = currentTick + Math.round(delay / this.strengthFactor);
  }
}

const TURRET_RANGE = 8;
const TURRET_COOLDOWN_TICKS = 8;
const TURRET_DAMAGE = 0.35;
const POWER_RANGE = 10; // generators were previously decorative (pollution cost, no consumer side)
const POWERED_DAMAGE_MULT = 1.5;
const POWERED_RANGE_MULT = 1.25;

export function isPowered(structures, x, y) {
  for (const s of structures) {
    if (s.kind !== 'generator' || s.destroyed || s.underConstruction) continue;
    if (Math.hypot(s.x - x, s.y - y) <= POWER_RANGE) return true;
  }
  return false;
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
export function tickAttackers(attackers, structures, grid, centerX, centerY, citizens, onScrap) {
  for (let i = 0; i < attackers.count; i++) {
    if (!attackers.isAliveAt(i)) continue;

    const blocker = findBlockingFence(structures, attackers.x[i], attackers.y[i]);
    if (blocker) {
      blocker.health -= FENCE_DAMAGE_PER_TICK;
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
      const speed = ATTACKER_SPEED * (inFloodlight ? FLOODLIGHT_SLOW_MULT : 1);
      attackers.x[i] += (dx / dist) * speed;
      attackers.y[i] += (dy / dist) * speed;
    }

    for (const t of structures) {
      if (t.kind !== 'trap' || t.triggered || t.underConstruction) continue;
      if (Math.hypot(attackers.x[i] - t.x, attackers.y[i] - t.y) < TRAP_TRIGGER_RANGE) {
        attackers.health[i] -= TRAP_DAMAGE;
        t.triggered = true; t.destroyed = true;
        if (attackers.health[i] <= 0) { attackers.alive[i] = 0; onScrap?.(SCRAP_PER_KILL); }
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

export function tickTurrets(structures, attackers, onScrap) {
  for (const s of structures) {
    if (s.kind !== 'turret' && s.kind !== 'tesla') continue;
    if (s.destroyed || s.underConstruction) continue;
    if (s.cooldown > 0) { s.cooldown--; continue; }

    const powered = isPowered(structures, s.x, s.y);
    const isTesla = s.kind === 'tesla';
    const range = (isTesla ? TESLA_RANGE : TURRET_RANGE) * (powered ? POWERED_RANGE_MULT : 1);
    const damage = (isTesla ? TESLA_DAMAGE : TURRET_DAMAGE) * (powered ? POWERED_DAMAGE_MULT : 1);

    if (isTesla) {
      // Chains to every attacker in range instead of picking one -- Tesla's SEA:R niche is
      // crowd control, not single-target DPS (that's what plain turrets are for).
      let hitAny = false;
      for (let i = 0; i < attackers.count; i++) {
        if (!attackers.isAliveAt(i)) continue;
        if (Math.hypot(attackers.x[i] - s.x, attackers.y[i] - s.y) > range) continue;
        hitAny = true;
        attackers.health[i] -= damage;
        if (attackers.health[i] <= 0) { attackers.alive[i] = 0; onScrap?.(SCRAP_PER_KILL); }
      }
      if (hitAny) s.cooldown = TESLA_COOLDOWN_TICKS;
      continue;
    }

    const bestI = nearestAliveAttacker(attackers, s.x, s.y, range);
    if (bestI >= 0) {
      attackers.health[bestI] -= damage;
      if (attackers.health[bestI] <= 0) { attackers.alive[bestI] = 0; onScrap?.(SCRAP_PER_KILL); }
      s.cooldown = TURRET_COOLDOWN_TICKS;
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
export function tickAttackerVsCitizens(attackers, citizens) {
  for (let i = 0; i < attackers.count; i++) {
    if (!attackers.isAliveAt(i)) continue;
    for (let c = 0; c < citizens.count; c++) {
      if (!citizens.isAliveAt(c)) continue;
      if (Math.hypot(attackers.x[i] - citizens.x[c], attackers.y[i] - citizens.y[c]) > ATTACKER_CONTACT_RANGE) continue;

      if (citizens.isDownedAt(c)) {
        citizens.flags[c] |= CitizenFlags.Dead;
        citizens.alive[c] = 0;
        continue;
      }

      const healthMult = citizens.trait[c]?.healthMult ?? 1;
      citizens.health[c] -= ATTACKER_CITIZEN_DAMAGE / healthMult;
      if (citizens.health[c] <= 0) {
        citizens.health[c] = 0.05;
        citizens.flags[c] |= CitizenFlags.Downed;
      }
    }
  }
}

// Guards/snipers fight back with their personal weapon (short/long range respectively),
// separate from turret coverage. Gains combat skill on a confirmed kill.
export function tickStaffCombat(citizens, roster, idOf, attackers, onScrap) {
  for (let i = 0; i < citizens.count; i++) {
    if (!citizens.isAliveAt(i)) continue;
    if (citizens.isDownedAt(i)) continue; // downed guards/snipers can't fight back
    const kind = roster.kindOf(idOf(i));
    if (kind !== 'Guard' && kind !== 'Sniper') continue;

    if (citizens._staffCooldown[i] > 0) { citizens._staffCooldown[i]--; continue; }

    const range = kind === 'Sniper' ? SNIPER_RANGE : GUARD_RANGE;
    const damage = kind === 'Sniper' ? SNIPER_DAMAGE : GUARD_DAMAGE;
    const cooldown = kind === 'Sniper' ? SNIPER_COOLDOWN : GUARD_COOLDOWN;

    const targetI = nearestAliveAttacker(attackers, citizens.x[i], citizens.y[i], range);
    if (targetI >= 0) {
      attackers.health[targetI] -= damage;
      citizens._staffCooldown[i] = cooldown;
      if (attackers.health[targetI] <= 0) {
        attackers.alive[targetI] = 0;
        citizens.skillCombat[i] += 0.05;
        onScrap?.(SCRAP_PER_KILL);
      }
    }
  }
}
