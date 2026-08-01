// Labor drones -- RimWorld Biotech's mech-companion analog (see FEATURE_RESEARCH.md's Biotech
// research pass: "recommends mech-companion labor drones, cheapest/highest-value addition"). A
// drone is a tireless, non-needs-having autonomous worker, distinct from the K9 dog companion
// (security.js -- that one fights, doesn't work). Reskinned per SEA:R's salvage-tech aesthetic
// rather than "robot" sci-fi framing: a small mechanical fabrication unit, not an AI/android.
//
// Real RimWorld anchor numbers this was ported from, and how they map onto this project:
//  - Light worker mech: ~50 Steel + minor component to build, ~1800 work-amount (~2 in-game days
//    at RimWorld's day length) to construct, locked to exactly ONE WorkTypeDef per unit.
//  - This project's scrap economy runs far cheaper than RimWorld's (BUILD_COST tops out in the
//    40-90 range) and its "day" is DAY_NIGHT_CYCLE_TICKS=2400 ticks (schedule.js) -- RimWorld's
//    literal "~2 days" doesn't scale honestly onto that (it's calibrated to a much longer real
//    day length), so gestation is instead "a few hundred ticks" (matching this codebase's own
//    established scale for a meaningful-but-not-punishing wait, see economy.js's
//    TRADER_WINDOW_TICKS=400 for the same order of magnitude already used elsewhere).
//  - "Locked to exactly one work category" -> jobs.js's WorkCategory enum, reused directly rather
//    than inventing a parallel one.
//  - "Capacity gated by a building, not a per-unit purchase" -> mirrors security.js's
//    tickArmoryIssuance pattern exactly: count non-destroyed/non-underConstruction
//    'fabrication_bay' structures, each unlocks DRONE_SLOTS_PER_BAY more total drone capacity,
//    hard-capped so a maxed-out bay farm can't scale forever.
//
// Deliberately NOT supported: WorkCategory.Animal. A mechanical unit taming a wild animal reads
// as a thematic mismatch (RimWorld's own mechs can't do Animals work either -- it's gated off
// their WorkTypeDefs same as this), so drones offer the other five categories only. This module
// is placed after jobs.js in build.py's ORDER (needed for the flat-bundle top-level-reference
// rule every other file here already follows) so it can import jobs.js's WorkCategory/rate
// constants directly instead of duplicating them.
import {
  WorkCategory, WORK_CATEGORY_LABELS, ARRIVE_DIST, JOB_SPEED, MESS_CLEAN_THRESHOLD,
  BUILD_RATE, HARVEST_RATE, CLEAN_RATE, CLEAN_ARRIVE_DIST,
  WORKSHOP_RAW_PER_UNIT, WORKSHOP_PROCESSED_PER_UNIT, WORKSHOP_PROCESS_TICKS,
} from './jobs.js';
import { findUndrivenVehicle, boardVehicle } from './vehicles.js';
import { roomCentroid } from './rooms.js';

export const DRONE_COST = 30; // "~50 Steel + minor component" scaled onto this project's economy tier (see economy.js's BUILD_COST comment)
// "~1800 work-amount / ~2 in-game days" is RimWorld's own day-length-calibrated number -- NOT
// reused literally (see header comment). 420 ticks is ~1/5.7 of a DAY_NIGHT_CYCLE_TICKS=2400 day,
// squarely "a few hundred ticks" per the task brief -- a real, felt wait without being punishing.
export const DRONE_GESTATION_TICKS = 420;
export const DRONE_SLOTS_PER_BAY = 2; // one Fabrication Bay unlocks 2 drone slots, same "a building unlocks capacity" shape as tickArmoryIssuance
export const DRONE_SLOT_HARD_CAP = 12; // caps how far bay-stacking can push total capacity, same spirit as WEAPON_TIER_ORDER's own finite ladder in security.js
export const DRONE_SPEED = JOB_SPEED; // no stated reason a drone should out-walk a citizen -- same travel speed, tireless just means no needs-seeking detours

// Categories a mechanical labor drone can be locked to at creation -- see the header comment for
// why Animal is excluded. Order matches jobs.js's WORK_CATEGORY_ORDER minus Animal.
export const DRONE_CATEGORIES = [
  WorkCategory.Construction, WorkCategory.Processing, WorkCategory.Hauling,
  WorkCategory.Harvesting, WorkCategory.Cleaning,
];

let _nextDroneId = 1;
// Drone ids are strings ('drone_N'), deliberately never colliding in type with citizen ids
// (plain numbers, see citizens.js's _nextId) -- any code that compares a claim's owner against
// idOf(i) (a number) for citizens naturally never matches a drone's string id, so drones and
// citizens can safely contend for the same blueprint/workshop/vehicle claim pool with zero extra
// bookkeeping.
function _nextDroneIdStr() { return `drone_${_nextDroneId++}`; }

/** Called once from world.js's deserialize() after restoring saved drones -- bumps the id
 *  counter past whatever the highest restored id was, so a freshly-fabricated drone after a
 *  load can never reuse an id a restored (still-alive) drone already holds a blueprint/vehicle/
 *  workshop claim under. */
export function bumpDroneIdCounter(drones) {
  for (const d of drones) {
    const n = parseInt(String(d.id).replace('drone_', ''), 10);
    if (Number.isFinite(n) && n >= _nextDroneId) _nextDroneId = n + 1;
  }
}

export class Drone {
  constructor(id, category, x, y) {
    this.id = id;
    this.category = category; // one WorkCategory, fixed for this drone's whole lifetime
    this.x = x; this.y = y;
    this.targetX = x; this.targetY = y;
    this.state = 'idle'; // idle -> seeking -> working|driving -> idle
    this.jobRef = null; // blueprint | vehicle | resourceNode | room | workshop structure, depending on category
    this._workshopTimer = 0; // Processing category's own work-in-progress timer, mirrors jobs.js station._workTimer
  }
}

/** Total drone capacity unlocked by built (not destroyed/under-construction) Fabrication Bays,
 *  hard-capped -- exact mirror of security.js's tickArmoryIssuance armoryCount pattern. */
export function droneCapacity(structures) {
  let bays = 0;
  for (const s of structures) {
    if (s.kind === 'fabrication_bay' && !s.destroyed && !s.underConstruction) bays++;
  }
  return Math.min(DRONE_SLOT_HARD_CAP, bays * DRONE_SLOTS_PER_BAY);
}

/** How many drone slots are currently spoken for -- live drones plus anything still gestating in
 *  the fabrication queue, so the player can't queue past capacity by spamming orders faster than
 *  gestation completes. */
export function droneSlotsUsed(world) {
  return (world.drones?.length || 0) + (world.droneFabricationQueue?.length || 0);
}

/** Attempts to queue one drone of `category` at the nearest built Fabrication Bay. Spends scrap
 *  immediately (same "pay up front, the thing itself arrives later" convention as a blueprint's
 *  citizen-construction time) -- returns a reason string on failure, null on success, so input.js/
 *  main.js can surface exactly why a queue attempt didn't go through. */
export function queueDroneFabrication(world, category) {
  if (!DRONE_CATEGORIES.includes(category)) return 'Invalid work category for a drone';
  const bay = world.structures.find(s => s.kind === 'fabrication_bay' && !s.destroyed && !s.underConstruction);
  if (!bay) return 'Build a Fabrication Bay first';
  if (droneSlotsUsed(world) >= droneCapacity(world.structures)) return 'No free drone capacity -- build another Fabrication Bay';
  if (world.scrap < DRONE_COST) return 'Not enough scrap';
  world.scrap -= DRONE_COST;
  if (world.finance) world.finance.buildSpend += DRONE_COST;
  world.droneFabricationQueue.push({ category, ticksRemaining: DRONE_GESTATION_TICKS, bayX: bay.x, bayY: bay.y });
  return null;
}

/** Advances the fabrication queue -- ticked every world tick like everything else in world.js's
 *  tick(). A completed order spawns a live Drone at its bay's position. If capacity has since
 *  shrunk (a bay was destroyed mid-gestation), the finished drone still spawns -- droneSlotsUsed
 *  already reserved its slot at queue time, and refunding/discarding a nearly-finished order over
 *  a since-lost bay would be a worse player experience than just letting it land. */
export function tickDroneFabrication(world) {
  if (!world.droneFabricationQueue.length) return;
  for (const order of world.droneFabricationQueue) order.ticksRemaining--;
  const done = world.droneFabricationQueue.filter(o => o.ticksRemaining <= 0);
  if (!done.length) return;
  world.droneFabricationQueue = world.droneFabricationQueue.filter(o => o.ticksRemaining > 0);
  for (const order of done) {
    world.drones.push(new Drone(_nextDroneIdStr(), order.category, order.bayX, order.bayY));
    const label = WORK_CATEGORY_LABELS[order.category];
    world.milestoneLog.push({ tick: world.currentTick, text: `A ${label} drone rolls off the Fabrication Bay line` });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  }
}

// ---- per-category claim helpers, drone-side mirrors of jobs.js's tryClaim* functions above.
// Deliberately separate (not reused directly) -- jobs.js's versions operate on CitizenStore's SoA
// arrays (store.x[i]/store.jobState[i]/etc), drones are a small plain-object array like
// world.vehicles/world.dogs, so the call shape doesn't line up. Each one is a direct behavioral
// mirror of its jobs.js counterpart minus anything needs/skill-related (drones have neither).

function _claimBlueprint(drone, structures) {
  let best = null, bestDist = Infinity;
  for (const s of structures) {
    if (!s.underConstruction || s.destroyed || s.claimedBy != null) continue;
    const d = Math.hypot(s.x - drone.x, s.y - drone.y);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  if (!best) return false;
  best.claimedBy = drone.id;
  drone.jobRef = best; drone.targetX = best.x; drone.targetY = best.y; drone.state = 'seeking';
  return true;
}

function _claimHauling(drone, world) {
  const vehicle = findUndrivenVehicle(world.vehicles, drone.x, drone.y);
  if (!vehicle) return false;
  drone.jobRef = vehicle; drone.targetX = vehicle.x; drone.targetY = vehicle.y; drone.state = 'seeking';
  return true;
}

function _claimHarvesting(drone, resourceNodes) {
  let best = null, bestDist = Infinity;
  for (const n of resourceNodes) {
    if (n.depleted) continue;
    const d = Math.hypot(n.x - drone.x, n.y - drone.y);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  if (!best) return false;
  drone.jobRef = best; drone.targetX = best.x; drone.targetY = best.y; drone.state = 'seeking';
  return true;
}

function _claimCleaning(drone, world) {
  let best = null, bestDist = Infinity, bestCentroid = null;
  for (const room of world.rooms) {
    if ((room.mess || 0) < MESS_CLEAN_THRESHOLD) continue;
    const c = roomCentroid(room, world.grid);
    const d = Math.hypot(c.x - drone.x, c.y - drone.y);
    if (d < bestDist) { bestDist = d; best = room; bestCentroid = c; }
  }
  if (!best) return false;
  drone.jobRef = best; drone.targetX = bestCentroid.x; drone.targetY = bestCentroid.y; drone.state = 'seeking';
  return true;
}

function _claimProcessing(drone, structures, world) {
  if (world.scrap < WORKSHOP_RAW_PER_UNIT) return false;
  let best = null, bestDist = Infinity;
  for (const s of structures) {
    if (s.kind !== 'workshop' || s.destroyed || s.underConstruction || s.workerId != null) continue;
    const d = Math.hypot(s.x - drone.x, s.y - drone.y);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  if (!best) return false;
  best.workerId = drone.id;
  drone.jobRef = best; drone.targetX = best.x; drone.targetY = best.y; drone.state = 'seeking';
  return true;
}

const _CLAIM_BY_CATEGORY = {
  [WorkCategory.Construction]: (drone, structures, resourceNodes, world) => _claimBlueprint(drone, structures),
  [WorkCategory.Processing]: (drone, structures, resourceNodes, world) => _claimProcessing(drone, structures, world),
  [WorkCategory.Hauling]: (drone, structures, resourceNodes, world) => _claimHauling(drone, world),
  [WorkCategory.Harvesting]: (drone, structures, resourceNodes, world) => _claimHarvesting(drone, resourceNodes),
  [WorkCategory.Cleaning]: (drone, structures, resourceNodes, world) => _claimCleaning(drone, world),
};

/** Full per-drone tick: idle -> claim -> travel -> work -> idle, no needs/mood anywhere in the
 *  loop (that's the entire point -- see the header comment). Called once per world tick from
 *  world.js, same call shape as jobs.js's tickJobs. */
export function tickDrones(world) {
  for (const drone of world.drones) {
    if (drone.state === 'idle') {
      const claim = _CLAIM_BY_CATEGORY[drone.category];
      claim?.(drone, world.structures, world.resourceNodes, world);
      continue;
    }

    if (drone.state === 'seeking') {
      const arriveDist = drone.category === WorkCategory.Cleaning ? CLEAN_ARRIVE_DIST : ARRIVE_DIST;
      const dx = drone.targetX - drone.x, dy = drone.targetY - drone.y;
      const dist = Math.hypot(dx, dy);
      if (dist < arriveDist) {
        if (drone.category === WorkCategory.Hauling) {
          const vehicle = drone.jobRef;
          if (vehicle.driverId != null) { drone.jobRef = null; drone.state = 'idle'; continue; } // beaten to it
          boardVehicle(world, vehicle, drone.id);
          drone.state = 'driving';
          continue;
        }
        if (drone.category === WorkCategory.Processing) {
          const station = drone.jobRef;
          if (station.workerId !== drone.id) { drone.jobRef = null; drone.state = 'idle'; continue; } // beaten to it
        }
        drone.state = 'working';
      } else {
        drone.x += (dx / dist) * DRONE_SPEED;
        drone.y += (dy / dist) * DRONE_SPEED;
      }
      continue;
    }

    if (drone.state === 'driving') {
      const vehicle = drone.jobRef;
      if (!vehicle || vehicle.driverId !== drone.id) {
        // vehicles.js clears driverId itself once the haul completes and it's back home -- same
        // "that's the release signal" convention jobs.js's own Driving state uses.
        drone.state = 'idle'; drone.jobRef = null;
        if (vehicle) { drone.x = vehicle.garageX; drone.y = vehicle.garageY; }
        continue;
      }
      drone.x = vehicle.x; drone.y = vehicle.y; // riding along, hidden -- render.js skips a driving drone same as a driving citizen
      continue;
    }

    if (drone.state === 'working') {
      if (drone.category === WorkCategory.Construction) {
        const bp = drone.jobRef;
        if (!bp || bp.destroyed || !bp.underConstruction) { drone.state = 'idle'; drone.jobRef = null; continue; }
        bp.buildProgress = Math.min(1, (bp.buildProgress || 0) + BUILD_RATE / (bp.buildWorkMult || 1));
        if (bp.buildProgress >= 1) {
          bp.underConstruction = false;
          bp.claimedBy = null;
          drone.state = 'idle'; drone.jobRef = null;
          if (world) world.onBuildComplete?.(bp);
        }
        continue;
      }
      if (drone.category === WorkCategory.Harvesting) {
        const node = drone.jobRef;
        if (!node || node.depleted) { drone.state = 'idle'; drone.jobRef = null; continue; }
        const take = Math.min(HARVEST_RATE, node.amount);
        node.amount -= take;
        world.addScrap(take, 'harvest');
        if (node.amount <= 0) node.depleted = true;
        if (node.depleted) { drone.state = 'idle'; drone.jobRef = null; }
        continue;
      }
      if (drone.category === WorkCategory.Cleaning) {
        const room = drone.jobRef;
        if (!room || !world.rooms.includes(room)) { drone.state = 'idle'; drone.jobRef = null; continue; }
        room.mess = Math.max(0, (room.mess || 0) - CLEAN_RATE);
        if (room.mess <= 0) { drone.state = 'idle'; drone.jobRef = null; }
        continue;
      }
      if (drone.category === WorkCategory.Processing) {
        const station = drone.jobRef;
        if (!station || station.destroyed || station.underConstruction || station.workerId !== drone.id) {
          drone.state = 'idle'; drone.jobRef = null; continue;
        }
        if (drone._workshopTimer <= 0) {
          if (world.scrap < WORKSHOP_RAW_PER_UNIT) { station.workerId = null; drone.state = 'idle'; drone.jobRef = null; continue; }
          world.addScrap(-WORKSHOP_RAW_PER_UNIT, 'processing');
          drone._workshopTimer = WORKSHOP_PROCESS_TICKS;
        }
        drone._workshopTimer -= 1;
        if (drone._workshopTimer <= 0) {
          world.addScrap(WORKSHOP_PROCESSED_PER_UNIT, 'processing');
        }
        continue;
      }
    }
  }
}
