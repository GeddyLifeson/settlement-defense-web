// Real Eat/Sleep/Harvest/Build job execution, condensed from SD.Sim's job-priority system:
// citizens with low hunger/rest walk to the nearest matching zone and refill there; citizens
// with nothing urgent pending instead work the colony's economy -- finishing player-placed
// blueprints first (Prison-Architect-style "you ordered it, someone builds it"), then
// harvesting scrap nodes when nothing needs building (RimWorld-style raw-material gathering).
import { ZoneKind } from './zones.js';
import { findUndrivenVehicle, boardVehicle } from './vehicles.js';
import { roomContaining, RoomRole } from './rooms.js';
import { getScheduleBlock, ScheduleBlock } from './schedule.js';
import { Passion, PASSION_GAIN_MULT } from './backstories.js';
import { isWateredAt } from './water.js';
import { TAME_CHANCE_PER_TICK, TAME_MAX_TICKS, DOG_POPULATION_CAP } from './security.js';
import { checkTameAchievement } from './metaprogress.js';

const ROOM_REFILL_BONUS = 1.3; // RimWorld/PA-style: an actually-enclosed room works better than open ground
// Water grid payoff (water.js): a Food or Recreation zone tile fed by a pump/pipe run refills
// hunger/social faster, same "provisioned area works better" precedent as ROOM_REFILL_BONUS
// above -- running water on top of four walls stacks multiplicatively with it, it doesn't
// replace it. No Bedroom bonus: rest isn't naturally a "running water" need the way eating/
// recreating are, and power.js's turret/tesla/watchtower trio didn't need a bedroom analogue
// either -- every consumer type doesn't have to take every utility.
const WATER_REFILL_BONUS = 1.25;

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
  SeekingAnimal: 13, // RimWorld-style taming, see security.js's wild-animal helpers and FEATURE_RESEARCH.md
  Taming: 14,
});

// Work Priorities (RimWorld Work-tab-style, see citizens.js's hasWorkPriorities/workPriority*
// fields and main.js's Work Priorities panel). One category per non-needs JobState pair below --
// deliberately no categories without a corresponding behavior. Order here doubles as the
// legacy/default fixed priority ladder's order (Construction > Hauling > Harvesting > Animal),
// so equal-priority ties in a citizen's custom order break the same way the untouched ladder
// already does.
export const WorkCategory = Object.freeze({
  Construction: 0, // SeekingBuild / Building
  Hauling: 1,       // SeekingVehicle / Driving
  Harvesting: 2,    // SeekingScrap / Harvesting
  Animal: 3,        // SeekingAnimal / Taming
});
export const WORK_CATEGORY_ORDER = [
  WorkCategory.Construction, WorkCategory.Hauling, WorkCategory.Harvesting, WorkCategory.Animal,
];
export const WORK_CATEGORY_LABELS = {
  [WorkCategory.Construction]: 'Construction',
  [WorkCategory.Hauling]: 'Hauling',
  [WorkCategory.Harvesting]: 'Harvesting',
  [WorkCategory.Animal]: 'Animal Handling',
};
// Per-citizen priority field name for each category, matching citizens.js's CitizenStore fields.
export const WORK_CATEGORY_FIELD = {
  [WorkCategory.Construction]: 'workPriorityConstruction',
  [WorkCategory.Hauling]: 'workPriorityHauling',
  [WorkCategory.Harvesting]: 'workPriorityHarvesting',
  [WorkCategory.Animal]: 'workPriorityAnimal',
};

const SEEK_SOCIAL_THRESHOLD = 0.35;
const SEEK_HUNGER_THRESHOLD = 0.45;
const SEEK_REST_THRESHOLD = 0.4;
const SATISFIED_THRESHOLD = 0.85;

// Duty Roster scheduling (see schedule.js) biases which need-thresholds apply this tick --
// it never removes the fallback, it just widens/narrows the window before a citizen breaks off
// to handle a need. CRITICAL_* floors guarantee a citizen always eats/rests before the need
// actually bottoms out, even deep in a Work block (PA's Regime can starve inmates who skip
// mealtime; this deliberately can't).
const CRITICAL_HUNGER_OVERRIDE = 0.18;
const CRITICAL_REST_OVERRIDE = 0.12;
const SCHEDULE_SLEEP_REST_SEEK = 0.75; // during the Sleep block, head to bed well before exhausted
const SCHEDULE_RECREATION_SOCIAL_SEEK = 0.7; // during the Recreation block, socialize proactively
const SCHEDULE_WORK_THRESHOLD_MULT = 0.4; // during the Work block, only break for a need that's fairly urgent
const NIGHT_INTERRUPT_REST_THRESHOLD = 0.6; // Sleep block will pull a not-yet-exhausted citizen off a work task
const REFILL_RATE = 0.05; // per tick while occupying the zone
const ETHANOL_FOOD_REFILL_MULT = 0.5; // Food zone refill halved while world.ethanolPenaltyTimer counts down, see vehicles.js
const ARRIVE_DIST = 0.35;
const JOB_SPEED = 0.09; // citizens hustle to zones -- travel time was the dominant cost in the needs loop

const BUILD_RATE = 0.012; // per tick, scaled by construction skill below
const BUILD_SKILL_GAIN = 0.02;
const HARVEST_RATE = 3; // scrap per tick pulled from a node
const HARVEST_SKILL_GAIN = 0.01;
const ON_BREAK_RATE_MULT = 0.5; // low-mood citizens work/harvest/build/travel at half speed
// Unrest (world.js's UNREST_* constants/world.unrestActive -- Prison Architect's riot
// state-machine reframed genre-neutral, see world.js's doc comment for the trigger/resolve
// design): a COLONY-WIDE penalty distinct from ON_BREAK_RATE_MULT above -- applies to every
// citizen's work/build/harvest/travel rate while world.unrestActive is true, not just the
// citizens who happen to already be individually OnBreak. Stacks multiplicatively with
// ON_BREAK_RATE_MULT for a citizen who's both (0.5 * 0.7 = 0.35x), which is intentional --
// unrest hits hardest on top of an already-struggling citizen. Deliberately milder than the
// per-citizen break penalty (0.7 vs 0.5) since this is colony-wide and stacks on top of it.
const UNREST_RATE_MULT = 0.7;

export function isOnJob(store, i) {
  return store.jobState[i] !== JobState.Idle;
}

// One try-to-claim helper per WorkCategory, each doing exactly what the original inline Idle-
// branch code did for that job type (see the git history of tickJobs below) -- factored out so
// both the legacy fixed-order ladder and a citizen's custom Work Priorities order can call the
// same claim logic instead of drifting apart. Returns true (and mutates store/jobState/_jobRef)
// only if a job of that category was actually available and claimed this tick.
function tryClaimConstruction(store, i, structures, idOf) {
  const blueprint = findNearestBlueprint(structures, store.x[i], store.y[i], idOf(i));
  if (!blueprint) return false;
  blueprint.claimedBy = idOf(i);
  store.jobState[i] = JobState.SeekingBuild;
  store.targetX[i] = blueprint.x; store.targetY[i] = blueprint.y;
  store._jobRef[i] = blueprint;
  return true;
}

function tryClaimHauling(store, i, world) {
  const vehicle = findUndrivenVehicle(world.vehicles, store.x[i], store.y[i]);
  if (!vehicle) return false;
  store.jobState[i] = JobState.SeekingVehicle;
  store.targetX[i] = vehicle.x; store.targetY[i] = vehicle.y;
  store._jobRef[i] = vehicle;
  return true;
}

function tryClaimHarvesting(store, i, resourceNodes) {
  const node = findNearestNode(resourceNodes, store.x[i], store.y[i]);
  if (!node) return false;
  store.jobState[i] = JobState.SeekingScrap;
  store.targetX[i] = node.x; store.targetY[i] = node.y;
  store._jobRef[i] = node;
  return true;
}

function tryClaimAnimal(store, i, world, idOf) {
  const animal = findNearestTameableAnimal(world.wildAnimals || [], store.x[i], store.y[i]);
  if (!animal) return false;
  animal.claimedBy = idOf(i);
  store.jobState[i] = JobState.SeekingAnimal;
  store.targetX[i] = animal.x; store.targetY[i] = animal.y;
  store._jobRef[i] = animal;
  return true;
}

const WORK_CATEGORY_CLAIM = {
  [WorkCategory.Construction]: (store, i, structures, resourceNodes, world, idOf) => tryClaimConstruction(store, i, structures, idOf),
  [WorkCategory.Hauling]: (store, i, structures, resourceNodes, world, idOf) => tryClaimHauling(store, i, world),
  [WorkCategory.Harvesting]: (store, i, structures, resourceNodes, world, idOf) => tryClaimHarvesting(store, i, resourceNodes),
  [WorkCategory.Animal]: (store, i, structures, resourceNodes, world, idOf) => tryClaimAnimal(store, i, world, idOf),
};

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

function findNearestTameableAnimal(wildAnimals, x, y) {
  let best = null, bestDist = Infinity;
  for (const a of wildAnimals) {
    if (a.claimedBy != null) continue; // someone's already taming this one
    const d = Math.hypot(a.x - x, a.y - y);
    if (d < bestDist) { bestDist = d; best = a; }
  }
  return best;
}

export function tickJobs(store, zones, staffOnDuty, structures, resourceNodes, idOf, onScrapGain, world) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.isDownedAt(i)) continue; // incapacitated, can't work until recovered
    if (staffOnDuty(i)) continue; // guards/snipers hold their post, no eat/sleep/work jobs

    // Duty Roster: a citizen deep in a work/harvest task at scheduled sleep-time gets pulled off
    // it to go find a bed, same as PA staff clearing a Regime block -- but only if they aren't
    // already close to exhausted (that path is handled below via the normal Idle/SeekingBed
    // branch regardless of schedule) and only for interruptible states; Driving and the
    // short Eating/Sleeping/Recreating fulfillment states are left to finish.
    const scheduleBlock = world ? getScheduleBlock(world.timeOfDay) : ScheduleBlock.Work;
    if (scheduleBlock === ScheduleBlock.Sleep && store.rest[i] < NIGHT_INTERRUPT_REST_THRESHOLD) {
      const interruptible = store.jobState[i];
      if (interruptible === JobState.Building || interruptible === JobState.SeekingBuild) {
        const bp = store._jobRef?.[i];
        if (bp) bp.claimedBy = null;
        store.jobState[i] = JobState.Idle;
      } else if (interruptible === JobState.Harvesting || interruptible === JobState.SeekingScrap
        || interruptible === JobState.SeekingVehicle) {
        store.jobState[i] = JobState.Idle;
      } else if (interruptible === JobState.SeekingAnimal || interruptible === JobState.Taming) {
        const animal = store._jobRef?.[i];
        if (animal) animal.claimedBy = null; // release it so someone else (or the same citizen later) can try again
        store.jobState[i] = JobState.Idle;
      }
    }

    const state = store.jobState[i];

    if (state === JobState.Idle) {
      // Schedule-biased thresholds -- Sleep block seeks a bed well before rest bottoms out,
      // Recreation block seeks company proactively, Work block narrows all three so a citizen
      // doesn't wander off mid-shift for anything short of a real need, and the CRITICAL_*
      // floors below stop that narrowing from ever becoming "never eats/sleeps at all".
      let restThreshold = SEEK_REST_THRESHOLD;
      let hungerThreshold = SEEK_HUNGER_THRESHOLD;
      let socialThreshold = SEEK_SOCIAL_THRESHOLD;
      if (scheduleBlock === ScheduleBlock.Sleep) {
        restThreshold = SCHEDULE_SLEEP_REST_SEEK;
      } else if (scheduleBlock === ScheduleBlock.Recreation) {
        socialThreshold = SCHEDULE_RECREATION_SOCIAL_SEEK;
      } else if (scheduleBlock === ScheduleBlock.Work) {
        restThreshold = Math.max(CRITICAL_REST_OVERRIDE, SEEK_REST_THRESHOLD * SCHEDULE_WORK_THRESHOLD_MULT);
        hungerThreshold = Math.max(CRITICAL_HUNGER_OVERRIDE, SEEK_HUNGER_THRESHOLD * SCHEDULE_WORK_THRESHOLD_MULT);
        socialThreshold = SEEK_SOCIAL_THRESHOLD * SCHEDULE_WORK_THRESHOLD_MULT;
      }

      // Starvation always wins the tie against a Sleep-block bed trip, regardless of check
      // order below -- a citizen shouldn't be walked past food to a bed because it's night.
      if (store.hunger[i] < CRITICAL_HUNGER_OVERRIDE) {
        const food = zones.nearestOfKind(ZoneKind.Food, store.x[i], store.y[i]);
        if (food) { store.jobState[i] = JobState.SeekingFood; store.targetX[i] = food.x; store.targetY[i] = food.y; continue; }
      }
      if (store.rest[i] < restThreshold) {
        const bed = zones.nearestOfKind(ZoneKind.Bedroom, store.x[i], store.y[i]);
        if (bed) { store.jobState[i] = JobState.SeekingBed; store.targetX[i] = bed.x; store.targetY[i] = bed.y; continue; }
      }
      if (store.hunger[i] < hungerThreshold) {
        const food = zones.nearestOfKind(ZoneKind.Food, store.x[i], store.y[i]);
        if (food) { store.jobState[i] = JobState.SeekingFood; store.targetX[i] = food.x; store.targetY[i] = food.y; continue; }
      }
      if (store.social[i] < socialThreshold) {
        const rec = zones.nearestOfKind(ZoneKind.Recreation, store.x[i], store.y[i]);
        if (rec) { store.jobState[i] = JobState.SeekingRec; store.targetX[i] = rec.x; store.targetY[i] = rec.y; continue; }
      }

      // Work Priorities override (RimWorld Work-tab-style, see citizens.js's hasWorkPriorities/
      // workPriority* fields and main.js's Work Priorities panel). Only a citizen the player has
      // actually opened that panel for takes this branch; everyone else falls through to the
      // original fixed ladder below completely untouched. Enabled categories (priority > 0) are
      // tried in ascending priority-number order (lower = higher priority, ties broken by
      // WORK_CATEGORY_ORDER, which is the same order the legacy ladder below uses), and a
      // category set to 0 is skipped entirely -- that citizen will never claim that kind of job,
      // even if it's the only thing available.
      if (store.hasWorkPriorities[i]) {
        const order = WORK_CATEGORY_ORDER
          .filter(cat => store[WORK_CATEGORY_FIELD[cat]][i] > 0)
          .sort((a, b) => store[WORK_CATEGORY_FIELD[a]][i] - store[WORK_CATEGORY_FIELD[b]][i]);
        for (const cat of order) {
          if (WORK_CATEGORY_CLAIM[cat](store, i, structures, resourceNodes, world, idOf)) break;
        }
        continue;
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
      const node = findNearestNode(resourceNodes, store.x[i], store.y[i]);

      // Passion tie-break (RimWorld-style): only when there's a genuine choice -- both an idle
      // truck and a harvestable node are actually available this tick -- a citizen who burns for
      // construction-adjacent work (harvesting gains skillConstruction, see below) very slightly
      // prefers picking at the node over driving. Doesn't touch the needs-first checks above, and
      // doesn't apply when only one option exists (that's not a "choice").
      if (vehicle && node && store.passionConstruction[i] === Passion.Burning) {
        store.jobState[i] = JobState.SeekingScrap;
        store.targetX[i] = node.x; store.targetY[i] = node.y;
        store._jobRef[i] = node;
        continue;
      }

      if (vehicle) {
        store.jobState[i] = JobState.SeekingVehicle;
        store.targetX[i] = vehicle.x; store.targetY[i] = vehicle.y;
        store._jobRef[i] = vehicle;
        continue;
      }

      if (node) {
        store.jobState[i] = JobState.SeekingScrap;
        store.targetX[i] = node.x; store.targetY[i] = node.y;
        store._jobRef[i] = node;
        continue;
      }

      // Taming (RimWorld-style, see security.js and FEATURE_RESEARCH.md): lowest-priority of all
      // the idle-fallback jobs -- an idle wild animal to approach only matters once there's
      // nothing else productive to do, same reasoning as vehicle/node above but one rung further
      // down, since taming doesn't feed the scrap economy the way those two do.
      const animal = findNearestTameableAnimal(world.wildAnimals || [], store.x[i], store.y[i]);
      if (animal) {
        animal.claimedBy = idOf(i);
        store.jobState[i] = JobState.SeekingAnimal;
        store.targetX[i] = animal.x; store.targetY[i] = animal.y;
        store._jobRef[i] = animal;
        continue;
      }
      continue;
    }

    if (state === JobState.SeekingFood || state === JobState.SeekingBed || state === JobState.SeekingRec
      || state === JobState.SeekingBuild || state === JobState.SeekingScrap || state === JobState.SeekingVehicle
      || state === JobState.SeekingAnimal) {
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
        if (state === JobState.SeekingAnimal) {
          store.jobState[i] = JobState.Taming;
          continue;
        }
        store.jobState[i] = state === JobState.SeekingFood ? JobState.Eating
          : state === JobState.SeekingBed ? JobState.Sleeping
          : state === JobState.SeekingRec ? JobState.Recreating
          : state === JobState.SeekingBuild ? JobState.Building
          : JobState.Harvesting;
      } else {
        const speed = JOB_SPEED * (store.trait[i]?.speedMult ?? 1) * (store.isOnBreakAt(i) ? ON_BREAK_RATE_MULT : 1)
          * (world?.unrestActive ? UNREST_RATE_MULT : 1);
        store.x[i] += (dx / dist) * speed;
        store.y[i] += (dy / dist) * speed;
      }
      continue;
    }

    if (state === JobState.Eating) {
      const eatRoom = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
      // Room-role gate (rooms.js's computeRoomStats/classifyRoomRole): the enclosed-room bonus
      // only applies to a room actually validated as a Dining Room (Food zone + >=1 table) --
      // an enclosed space with a Food zone but no table (or no room at all) still refills at the
      // baseline rate, same as open ground, rather than getting the bonus for four walls alone.
      const roomBonus = (eatRoom && eatRoom.role === RoomRole.DiningRoom && eatRoom.roleValid) ? ROOM_REFILL_BONUS : 1;
      const waterBonus = isWateredAt(structures, store.x[i], store.y[i]) ? WATER_REFILL_BONUS : 1;
      // Ethanol-fuel trucks (vehicles.js FUEL_TYPES.ethanol) brew clean fuel out of the
      // settlement's food surplus -- there's no bulk food-stockpile resource in this codebase
      // to drain directly, so the honest portable stand-in is a temporary hit to how fast the
      // Food zone actually refills hunger after each ethanol haul completes.
      const ethanolMult = world.ethanolPenaltyTimer > 0 ? ETHANOL_FOOD_REFILL_MULT : 1;
      store.hunger[i] = Math.min(1, store.hunger[i] + REFILL_RATE * roomBonus * waterBonus * ethanolMult);
      if (store.hunger[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Sleeping) {
      const sleepRoom = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
      // Same role gate as Eating above: only a validated Bedroom (Bedroom zone + >=1 bed) gets
      // the enclosed-room refill bonus -- four walls around an empty Bedroom zone is not a bed.
      const roomBonus = (sleepRoom && sleepRoom.role === RoomRole.Bedroom && sleepRoom.roleValid) ? ROOM_REFILL_BONUS : 1;
      store.rest[i] = Math.min(1, store.rest[i] + REFILL_RATE * roomBonus);
      if (store.rest[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Recreating) {
      const recRoom = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
      // Same role gate as Eating/Sleeping above: Recreation Room only requires the zone (see
      // classifyRoomRole's doc comment -- no furniture kind exists for it), so this mostly just
      // excludes an enclosed room with no Recreation zone at all from getting the bonus.
      const roomBonus = (recRoom && recRoom.role === RoomRole.RecreationRoom && recRoom.roleValid) ? ROOM_REFILL_BONUS : 1;
      const waterBonus = isWateredAt(structures, store.x[i], store.y[i]) ? WATER_REFILL_BONUS : 1;
      store.social[i] = Math.min(1, store.social[i] + REFILL_RATE * roomBonus * waterBonus * (store.trait[i]?.socialGainMult ?? 1));
      if (store.social[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Building) {
      const bp = store._jobRef?.[i];
      if (!bp || bp.destroyed || !bp.underConstruction) { store.jobState[i] = JobState.Idle; continue; }
      const buildRateMult = (store.isOnBreakAt(i) ? ON_BREAK_RATE_MULT : 1) * (world?.unrestActive ? UNREST_RATE_MULT : 1);
      bp.buildProgress = Math.min(1, (bp.buildProgress || 0) + BUILD_RATE * (1 + store.skillConstruction[i]) * buildRateMult);
      if (bp.buildProgress >= 1) {
        bp.underConstruction = false;
        bp.claimedBy = null;
        store.skillConstruction[i] += BUILD_SKILL_GAIN * PASSION_GAIN_MULT[store.passionConstruction[i]];
        store.jobState[i] = JobState.Idle;
      }
      continue;
    }

    if (state === JobState.Harvesting) {
      const node = store._jobRef?.[i];
      if (!node || node.depleted) { store.jobState[i] = JobState.Idle; continue; }
      const harvestRateMult = (store.isOnBreakAt(i) ? ON_BREAK_RATE_MULT : 1) * (world?.unrestActive ? UNREST_RATE_MULT : 1);
      const take = Math.min(HARVEST_RATE * harvestRateMult, node.amount);
      node.amount -= take;
      onScrapGain?.(take);
      store.skillConstruction[i] += HARVEST_SKILL_GAIN * 0.2 * PASSION_GAIN_MULT[store.passionConstruction[i]];
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

    if (state === JobState.Taming) {
      const animal = store._jobRef?.[i];
      if (!animal) { store.jobState[i] = JobState.Idle; continue; }
      animal.tameTicks = (animal.tameTicks || 0) + 1;
      // Flat per-tick roll (see security.js's TAME_CHANCE_PER_TICK doc comment for why this isn't
      // scaled by a skill -- no "Animals" skill exists and FEATURE_RESEARCH.md says not to add
      // one just for this). world.rng keeps this reproducible under the same seed as everything
      // else in the sim. Gated on the same DOG_POPULATION_CAP tickDogBreeding respects -- a long
      // soak session could otherwise keep taming freshly-spawned wild animals past the cap even
      // with zero breeding, which defeats the point of having one at all.
      if (world.dogs.length < DOG_POPULATION_CAP && world?.rng && world.rng() < TAME_CHANCE_PER_TICK) {
        const idx = world.wildAnimals.indexOf(animal);
        if (idx >= 0) world.wildAnimals.splice(idx, 1);
        // Joins world.dogs unowned -- exactly like a bred pup (security.js's tickDogBreeding),
        // it just sits until assigned to a K9Handler via the existing roster.assign() system,
        // same as the starting dog in world.js's constructor.
        world.dogs.push({ ownerId: null, x: animal.x, y: animal.y, cooldown: 0 });
        store.jobState[i] = JobState.Idle;
        // No milestone existed for a successful taming before this -- worth logging like every
        // other "something notable just happened" event (refugee arrivals, region control, etc.
        // in world.js/worldmap.js), and it's the natural event-driven hook point for
        // metaprogress.js's Beast Tamer achievement rather than polling world.dogs every tick.
        if (world?.milestoneLog) {
          world.milestoneLog.push({ tick: world.currentTick, text: `${store.name[i]} tames a wild animal` });
          if (world.milestoneLog.length > 20) world.milestoneLog.shift();
        }
        checkTameAchievement();
        continue;
      }
      if (animal.tameTicks >= TAME_MAX_TICKS) {
        // Gave up -- the animal flees rather than staying claimed (and tameable) forever.
        const idx = world.wildAnimals.indexOf(animal);
        if (idx >= 0) world.wildAnimals.splice(idx, 1);
        store.jobState[i] = JobState.Idle;
        continue;
      }
      continue;
    }
  }
}
