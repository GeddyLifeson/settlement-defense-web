// Ported/condensed from SD.Sim (CitizenStore, NeedsDecaySystem, NeedsMoodBreakTickGroup,
// SocialInteractionSystem). Struct-of-arrays store, same shape as the C# CitizenStore.
import { randomTrait } from './traits.js';
import { roomContaining } from './rooms.js';
import { randomBackstory, randomPassions } from './backstories.js';

export const CitizenFlags = Object.freeze({
  None: 0,
  Dead: 1 << 0,
  OnBreak: 1 << 1,
  Downed: 1 << 2, // incapacitated but alive (RimWorld-style) -- see siege.js for the transition rules
});

const DOWNED_RECOVERY_RATE = 0.0015; // per tick, passive -- no dedicated first-aid job yet
const DOWNED_RECOVER_THRESHOLD = 0.3;

// Exported so weather.js can scale its extra Cold/Heatwave decay proportionally to these base
// rates rather than hardcoding a second copy of the numbers.
export const HUNGER_DECAY = 0.0005;   // per tick (10 Hz), matches ARCHITECTURE.md "100ms/tick"
export const REST_DECAY = 0.0003;
const SOCIAL_DECAY = 0.0002;
const ON_DUTY_SOCIAL_FULFILLMENT = 0.6; // guards/snipers get partial social fulfillment on duty
const BREAK_MOOD_THRESHOLD = 0.12;

// Room quality -> mood (rooms.js's computeRoomStats, RimWorld-style beauty/cleanliness/
// impressiveness -> a 0..1 "quality" score). 0.5 is the neutral "no room / average room"
// baseline, so this term is signed: a genuinely nice room (quality near 1) gives a steady small
// positive nudge each tick, a bare/ugly one (quality near 0) gives a steady small negative nudge.
// Kept deliberately gentle -- this should read as a slow trend over many ticks in a soak test,
// not something that swamps the existing hunger/rest/social-driven mood swing in one tick.
const ROOM_MOOD_INFLUENCE = 0.02;

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
    this._jobRef = {}; // used by jobs.js: index -> blueprint/resource-node object currently targeted
    this.trait = new Array(capacity).fill(null);
    this.backstory = new Array(capacity).fill(null); // see backstories.js -- childhood/adult flavor pair + skill nudge
    this.passionCombat = new Uint8Array(capacity); // Passion tier (backstories.js), biases skillCombat gain rate
    this.passionConstruction = new Uint8Array(capacity); // Passion tier, biases skillConstruction gain rate
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
    const backstory = randomBackstory(rng);
    this.backstory[i] = backstory;
    this.skillCombat[i] = backstory.skillCombatStart ?? 0;
    this.skillConstruction[i] = backstory.skillConstructionStart ?? 0;
    const passions = randomPassions(rng, backstory);
    this.passionCombat[i] = passions.combat;
    this.passionConstruction[i] = passions.construction;
    return i;
  }

  isAliveAt(i) {
    return this.alive[i] === 1 && (this.flags[i] & CitizenFlags.Dead) === 0;
  }

  isDownedAt(i) {
    return (this.flags[i] & CitizenFlags.Downed) !== 0;
  }

  isOnBreakAt(i) {
    return (this.flags[i] & CitizenFlags.OnBreak) !== 0;
  }
}

// isStaffAt(i) -> bool, used to decide on-duty social fulfillment (guards/snipers don't
// need to be near others to stay socially fulfilled while working).
// world (optional, 5th arg) -- passed by world.js as `this` so a citizen's current room quality
// (rooms.js's roomContaining + computeRoomStats) can nudge their mood; omit it (e.g. in tests)
// and this term is simply skipped, matching the rest of this function's null-safe style.
export function tickNeedsAndMood(store, isStaffAt, rng, world) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;

    if (store.isDownedAt(i)) {
      // Incapacitated: needs don't spiral further while down, but health slowly recovers
      // (RimWorld-style "downed, not dead" reprieve -- no dedicated first-aid job yet, so
      // recovery is passive rather than requiring a medic to tend them).
      store.health[i] = Math.min(1, store.health[i] + DOWNED_RECOVERY_RATE);
      if (store.health[i] >= DOWNED_RECOVER_THRESHOLD) store.flags[i] &= ~CitizenFlags.Downed;
      continue;
    }

    const staffFulfillment = isStaffAt(i) ? ON_DUTY_SOCIAL_FULFILLMENT : 0;
    const trait = store.trait[i];

    store.hunger[i] = Math.max(0, store.hunger[i] - HUNGER_DECAY * (trait?.hungerMult ?? 1));
    store.rest[i] = Math.max(0, store.rest[i] - REST_DECAY * (trait?.restMult ?? 1));
    store.social[i] = Math.max(0, store.social[i] - SOCIAL_DECAY * (1 - staffFulfillment));

    const avgNeed = (store.hunger[i] + store.rest[i] + store.social[i]) / 3;
    // Mood eases toward the current need average rather than snapping, so a single bad tick
    // doesn't cause a break.
    store.mood[i] += (avgNeed - store.mood[i]) * 0.05;

    // Room quality (see ROOM_MOOD_INFLUENCE doc comment above): one roomContaining lookup per
    // citizen per tick, same cost/pattern as the ROOM_REFILL_BONUS lookups already done per
    // citizen per tick in jobs.js's Eating/Sleeping/Recreating states.
    if (world) {
      const room = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
      if (room) store.mood[i] += (room.quality - 0.5) * ROOM_MOOD_INFLUENCE;
    }
    store.mood[i] = Math.min(1, Math.max(0, store.mood[i]));

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
    if (store.isDownedAt(i)) continue;
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
