// Ported/condensed from SD.Sim (CitizenStore, NeedsDecaySystem, NeedsMoodBreakTickGroup,
// SocialInteractionSystem). Struct-of-arrays store, same shape as the C# CitizenStore.
import { randomTrait } from './traits.js';

export const CitizenFlags = Object.freeze({
  None: 0,
  Dead: 1 << 0,
  OnBreak: 1 << 1,
});

const HUNGER_DECAY = 0.006;   // per tick (10 Hz), matches ARCHITECTURE.md "100ms/tick"
const REST_DECAY = 0.0035;
const SOCIAL_DECAY = 0.0025;
const ON_DUTY_SOCIAL_FULFILLMENT = 0.6; // guards/snipers get partial social fulfillment on duty
const BREAK_MOOD_THRESHOLD = 0.12;

export class CitizenStore {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;
    this.id = new Uint32Array(capacity);
    this.name = new Array(capacity).fill('');
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.targetX = new Float32Array(capacity);
    this.targetY = new Float32Array(capacity);
    this.hunger = new Float32Array(capacity).fill(1);
    this.rest = new Float32Array(capacity).fill(1);
    this.social = new Float32Array(capacity).fill(1);
    this.mood = new Float32Array(capacity).fill(1);
    this.health = new Float32Array(capacity).fill(1);
    this.flags = new Uint8Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.jobState = new Uint8Array(capacity); // JobState from jobs.js
    this.skillCombat = new Float32Array(capacity);
    this.skillConstruction = new Float32Array(capacity);
    this._staffCooldown = new Float32Array(capacity); // used by siege.js tickStaffCombat
    this.trait = new Array(capacity).fill(null);
    this._nextId = 1;
  }

  spawn(name, x, y, rng = Math.random) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    const id = this._nextId++;
    this.id[i] = id;
    this.name[i] = name;
    this.x[i] = x; this.y[i] = y;
    this.targetX[i] = x; this.targetY[i] = y;
    this.hunger[i] = 1; this.rest[i] = 1; this.social[i] = 1; this.mood[i] = 1; this.health[i] = 1;
    this.flags[i] = CitizenFlags.None;
    this.alive[i] = 1;
    this.trait[i] = randomTrait(rng);
    return i;
  }

  isAliveAt(i) {
    return this.alive[i] === 1 && (this.flags[i] & CitizenFlags.Dead) === 0;
  }
}

// isStaffAt(i) -> bool, used to decide on-duty social fulfillment (guards/snipers don't
// need to be near others to stay socially fulfilled while working).
export function tickNeedsAndMood(store, isStaffAt, rng) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;

    const staffFulfillment = isStaffAt(i) ? ON_DUTY_SOCIAL_FULFILLMENT : 0;
    const trait = store.trait[i];

    store.hunger[i] = Math.max(0, store.hunger[i] - HUNGER_DECAY * (trait?.hungerMult ?? 1));
    store.rest[i] = Math.max(0, store.rest[i] - REST_DECAY * (trait?.restMult ?? 1));
    store.social[i] = Math.max(0, store.social[i] - SOCIAL_DECAY * (1 - staffFulfillment));

    const avgNeed = (store.hunger[i] + store.rest[i] + store.social[i]) / 3;
    // Mood eases toward the current need average rather than snapping, so a single bad tick
    // doesn't cause a break.
    store.mood[i] += (avgNeed - store.mood[i]) * 0.05;

    if (store.mood[i] < BREAK_MOOD_THRESHOLD) {
      store.flags[i] |= CitizenFlags.OnBreak;
    } else if (store.mood[i] > BREAK_MOOD_THRESHOLD + 0.1) {
      store.flags[i] &= ~CitizenFlags.OnBreak;
    }
  }
}

// Simple wander: citizens not on a job walk toward a random nearby point, matching the
// "idle wander" behavior visible in the Unity build's default scenario (no job system ported
// yet — this is deliberately simpler than SD.Sim's real Eat/Sleep job execution).
export function tickWander(store, grid, rng, speed = 0.04, skipIf = null) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (skipIf && skipIf(i)) continue;

    const dx = store.targetX[i] - store.x[i];
    const dy = store.targetY[i] - store.y[i];
    const dist = Math.hypot(dx, dy);
    if (dist < 0.15) {
      let tx, ty, tries = 0;
      do {
        tx = Math.max(1, Math.min(grid.width - 2, store.x[i] + (rng() - 0.5) * 10));
        ty = Math.max(1, Math.min(grid.height - 2, store.y[i] + (rng() - 0.5) * 10));
        tries++;
      } while (grid.isBlocked(tx | 0, ty | 0) && tries < 8);
      store.targetX[i] = tx;
      store.targetY[i] = ty;
    } else {
      store.x[i] += (dx / dist) * speed;
      store.y[i] += (dy / dist) * speed;
    }
  }
}
