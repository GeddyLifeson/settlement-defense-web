// Real Eat/Sleep job execution, condensed from SD.Sim's job-priority system: citizens with low
// hunger/rest walk to the nearest matching zone and refill there, instead of pure wander.
import { ZoneKind } from './zones.js';

export const JobState = Object.freeze({
  Idle: 0,
  SeekingFood: 1,
  Eating: 2,
  SeekingBed: 3,
  Sleeping: 4,
  SeekingRec: 5,
  Recreating: 6,
});

const SEEK_SOCIAL_THRESHOLD = 0.35;

const SEEK_HUNGER_THRESHOLD = 0.45;
const SEEK_REST_THRESHOLD = 0.4;
const SATISFIED_THRESHOLD = 0.85;
const REFILL_RATE = 0.05; // per tick while occupying the zone
const ARRIVE_DIST = 0.35;
const JOB_SPEED = 0.09; // citizens hustle to zones -- travel time was the dominant cost in the needs loop

export function isOnJob(store, i) {
  return store.jobState[i] !== JobState.Idle;
}

export function tickJobs(store, zones, staffOnDuty) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (staffOnDuty(i)) continue; // guards/snipers hold their post, no eat/sleep jobs

    const state = store.jobState[i];

    if (state === JobState.Idle) {
      if (store.rest[i] < SEEK_REST_THRESHOLD) {
        const bed = zones.nearestOfKind(ZoneKind.Bedroom, store.x[i], store.y[i]);
        if (bed) { store.jobState[i] = JobState.SeekingBed; store.targetX[i] = bed.x; store.targetY[i] = bed.y; continue; }
      }
      if (store.hunger[i] < SEEK_HUNGER_THRESHOLD) {
        const food = zones.nearestOfKind(ZoneKind.Food, store.x[i], store.y[i]);
        if (food) { store.jobState[i] = JobState.SeekingFood; store.targetX[i] = food.x; store.targetY[i] = food.y; continue; }
      }
      if (store.social[i] < SEEK_SOCIAL_THRESHOLD) {
        const rec = zones.nearestOfKind(ZoneKind.Recreation, store.x[i], store.y[i]);
        if (rec) { store.jobState[i] = JobState.SeekingRec; store.targetX[i] = rec.x; store.targetY[i] = rec.y; continue; }
      }
      continue;
    }

    if (state === JobState.SeekingFood || state === JobState.SeekingBed || state === JobState.SeekingRec) {
      const dx = store.targetX[i] - store.x[i];
      const dy = store.targetY[i] - store.y[i];
      const dist = Math.hypot(dx, dy);
      if (dist < ARRIVE_DIST) {
        store.jobState[i] = state === JobState.SeekingFood ? JobState.Eating
          : state === JobState.SeekingBed ? JobState.Sleeping
          : JobState.Recreating;
      } else {
        store.x[i] += (dx / dist) * JOB_SPEED;
        store.y[i] += (dy / dist) * JOB_SPEED;
      }
      continue;
    }

    if (state === JobState.Eating) {
      store.hunger[i] = Math.min(1, store.hunger[i] + REFILL_RATE);
      if (store.hunger[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Sleeping) {
      store.rest[i] = Math.min(1, store.rest[i] + REFILL_RATE);
      if (store.rest[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Recreating) {
      store.social[i] = Math.min(1, store.social[i] + REFILL_RATE);
      if (store.social[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }
  }
}
