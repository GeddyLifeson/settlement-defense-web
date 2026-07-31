// Real Eat/Sleep/Harvest/Build job execution, condensed from SD.Sim's job-priority system:
// citizens with low hunger/rest walk to the nearest matching zone and refill there; citizens
// with nothing urgent pending instead work the colony's economy -- finishing player-placed
// blueprints first (Prison-Architect-style "you ordered it, someone builds it"), then
// harvesting scrap nodes when nothing needs building (RimWorld-style raw-material gathering).
import { ZoneKind } from './zones.js';
import { findUndrivenVehicle, boardVehicle } from './vehicles.js';
import { roomContaining } from './rooms.js';

const ROOM_REFILL_BONUS = 1.3; // RimWorld/PA-style: an actually-enclosed room works better than open ground

export const JobState = Object.freeze({
  Idle: 0,
  SeekingFood: 1,
  Eating: 2,
  SeekingBed: 3,
  Sleeping: 4,
  SeekingRec: 5,
  Recreating: 6,
  SeekingBuild: 7,
  Building: 8,
  SeekingScrap: 9,
  Harvesting: 10,
  SeekingVehicle: 11,
  Driving: 12,
});

const SEEK_SOCIAL_THRESHOLD = 0.35;
const SEEK_HUNGER_THRESHOLD = 0.45;
const SEEK_REST_THRESHOLD = 0.4;
const SATISFIED_THRESHOLD = 0.85;
const REFILL_RATE = 0.05; // per tick while occupying the zone
const ARRIVE_DIST = 0.35;
const JOB_SPEED = 0.09; // citizens hustle to zones -- travel time was the dominant cost in the needs loop

const BUILD_RATE = 0.012; // per tick, scaled by construction skill below
const BUILD_SKILL_GAIN = 0.02;
const HARVEST_RATE = 3; // scrap per tick pulled from a node
const HARVEST_SKILL_GAIN = 0.01;

export function isOnJob(store, i) {
  return store.jobState[i] !== JobState.Idle;
}

function findNearestBlueprint(structures, x, y, excludeClaimedBy) {
  let best = null, bestDist = Infinity;
  for (const s of structures) {
    if (!s.underConstruction || s.destroyed) continue;
    if (s.claimedBy != null && s.claimedBy !== excludeClaimedBy) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

function findNearestNode(nodes, x, y) {
  let best = null, bestDist = Infinity;
  for (const n of nodes) {
    if (n.depleted) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best;
}

export function tickJobs(store, zones, staffOnDuty, structures, resourceNodes, idOf, onScrapGain, world) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.isDownedAt(i)) continue; // incapacitated, can't work until recovered
    if (staffOnDuty(i)) continue; // guards/snipers hold their post, no eat/sleep/work jobs

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

      const blueprint = findNearestBlueprint(structures, store.x[i], store.y[i], idOf(i));
      if (blueprint) {
        blueprint.claimedBy = idOf(i);
        store.jobState[i] = JobState.SeekingBuild;
        store.targetX[i] = blueprint.x; store.targetY[i] = blueprint.y;
        store._jobRef[i] = blueprint;
        continue;
      }

      // Driving a built truck is checked before manual harvesting -- one haul cycle moves far
      // more scrap than one citizen picking at a node by hand, so an idle truck should win the
      // idle-citizen's attention. With resource nodes almost always available, checking this
      // after harvesting meant no citizen ever reached it in testing -- a real bug, not a
      // priority nuance.
      const vehicle = findUndrivenVehicle(world.vehicles, store.x[i], store.y[i]);
      if (vehicle) {
        store.jobState[i] = JobState.SeekingVehicle;
        store.targetX[i] = vehicle.x; store.targetY[i] = vehicle.y;
        store._jobRef[i] = vehicle;
        continue;
      }

      const node = findNearestNode(resourceNodes, store.x[i], store.y[i]);
      if (node) {
        store.jobState[i] = JobState.SeekingScrap;
        store.targetX[i] = node.x; store.targetY[i] = node.y;
        store._jobRef[i] = node;
        continue;
      }
      continue;
    }

    if (state === JobState.SeekingFood || state === JobState.SeekingBed || state === JobState.SeekingRec
      || state === JobState.SeekingBuild || state === JobState.SeekingScrap || state === JobState.SeekingVehicle) {
      const dx = store.targetX[i] - store.x[i];
      const dy = store.targetY[i] - store.y[i];
      const dist = Math.hypot(dx, dy);
      if (dist < ARRIVE_DIST) {
        if (state === JobState.SeekingVehicle) {
          const vehicle = store._jobRef[i];
          if (vehicle.driverId != null) { store.jobState[i] = JobState.Idle; continue; } // beaten to it
          boardVehicle(world, vehicle, idOf(i));
          store.jobState[i] = JobState.Driving;
          continue;
        }
        store.jobState[i] = state === JobState.SeekingFood ? JobState.Eating
          : state === JobState.SeekingBed ? JobState.Sleeping
          : state === JobState.SeekingRec ? JobState.Recreating
          : state === JobState.SeekingBuild ? JobState.Building
          : JobState.Harvesting;
      } else {
        const speed = JOB_SPEED * (store.trait[i]?.speedMult ?? 1);
        store.x[i] += (dx / dist) * speed;
        store.y[i] += (dy / dist) * speed;
      }
      continue;
    }

    if (state === JobState.Eating) {
      const roomBonus = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]) ? ROOM_REFILL_BONUS : 1;
      store.hunger[i] = Math.min(1, store.hunger[i] + REFILL_RATE * roomBonus);
      if (store.hunger[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Sleeping) {
      const roomBonus = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]) ? ROOM_REFILL_BONUS : 1;
      store.rest[i] = Math.min(1, store.rest[i] + REFILL_RATE * roomBonus);
      if (store.rest[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Recreating) {
      const roomBonus = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]) ? ROOM_REFILL_BONUS : 1;
      store.social[i] = Math.min(1, store.social[i] + REFILL_RATE * roomBonus * (store.trait[i]?.socialGainMult ?? 1));
      if (store.social[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Building) {
      const bp = store._jobRef?.[i];
      if (!bp || bp.destroyed || !bp.underConstruction) { store.jobState[i] = JobState.Idle; continue; }
      bp.buildProgress = Math.min(1, (bp.buildProgress || 0) + BUILD_RATE * (1 + store.skillConstruction[i]));
      if (bp.buildProgress >= 1) {
        bp.underConstruction = false;
        bp.claimedBy = null;
        store.skillConstruction[i] += BUILD_SKILL_GAIN;
        store.jobState[i] = JobState.Idle;
      }
      continue;
    }

    if (state === JobState.Harvesting) {
      const node = store._jobRef?.[i];
      if (!node || node.depleted) { store.jobState[i] = JobState.Idle; continue; }
      const take = Math.min(HARVEST_RATE, node.amount);
      node.amount -= take;
      onScrapGain?.(take);
      store.skillConstruction[i] += HARVEST_SKILL_GAIN * 0.2;
      if (node.amount <= 0) node.depleted = true;
      if (node.depleted) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Driving) {
      const vehicle = store._jobRef?.[i];
      // vehicles.js clears driverId itself once the haul cycle completes and it's back home --
      // that's the signal this citizen's shift is over, not a countdown tracked here.
      if (!vehicle || vehicle.driverId !== idOf(i)) {
        store.jobState[i] = JobState.Idle;
        if (vehicle) { store.x[i] = vehicle.garageX; store.y[i] = vehicle.garageY; store.targetX[i] = vehicle.garageX; store.targetY[i] = vehicle.garageY; }
        continue;
      }
      store.x[i] = vehicle.x; store.y[i] = vehicle.y; // riding along, hidden (render.js skips Driving citizens)
      continue;
    }
  }
}
