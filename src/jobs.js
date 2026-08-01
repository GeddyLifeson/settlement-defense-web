// Real Eat/Sleep/Harvest/Build job execution, condensed from SD.Sim's job-priority system:
// citizens with low hunger/rest walk to the nearest matching zone and refill there; citizens
// with nothing urgent pending instead work the colony's economy -- finishing player-placed
// blueprints first (Prison-Architect-style "you ordered it, someone builds it"), then
// harvesting scrap nodes when nothing needs building (RimWorld-style raw-material gathering).
import { ZoneKind } from './zones.js';
import { findUndrivenVehicle, boardVehicle } from './vehicles.js';
import { roomContaining, roomCentroid, RoomRole } from './rooms.js';
import { getScheduleBlock, ScheduleBlock, effectiveScheduleBlock } from './schedule.js';
import { Passion, PASSION_GAIN_MULT } from './backstories.js';
import { isWateredAt } from './water.js';
import { TAME_CHANCE_PER_TICK, TAME_MAX_TICKS, DOG_POPULATION_CAP } from './security.js';
import { checkTameAchievement } from './metaprogress.js';
import { breakRateMultFor, needsThrottleMultFor, addMoodEvent } from './citizens.js';
import { ageBandFor } from './traits.js';
import { rankWorkSpeedMultFor } from './ranks.js';
import { augmentWorkSpeedMultFor, augmentSocialGainMultFor } from './augments.js';
import { sickRateMultFor } from './sickness.js';
import { dependencyRateMultFor } from './supplies.js';
import { epidemicMoveMultFor } from './epidemic.js';
import { findJoinableSite, applyAttendingTick, completeSession, roomPostFor, isSiteStaffed, PROGRAM_DEFS } from './programs.js';
import { tryClaimForcedJob } from './forcejob.js';
import { hazardRefillMult, coldConstructionWorkRateMult, coldGardeningWorkRateMult } from './weather.js';
import { inspirationWorkSpeedMultFor } from './inspirations.js';

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
  SeekingClean: 15, // RimWorld-style Cleaning work type, see rooms.js's mess/.mess doc comment
  Cleaning: 16,
  // Materials-processing (Prison Architect's SheetMetal -> Workshop -> LicensePlate chain, see
  // siege.js's Structure 'workshop' kind / economy.js's BUILD_COST.workshop): a staffed station
  // that converts already-banked raw scrap into higher-value processed goods over time.
  SeekingWorkshop: 17,
  Processing: 18,
  // Structured Group Programs (programs.js -- Skills Workshop / Wellness Counseling / Community
  // Circle, a direct port of Prison Architect's real reform-program schema, reskinned
  // non-carceral). Voluntary attendance, same shape as SeekingRec/Recreating above: a citizen
  // walks to a staffed, scheduled-in program site and occupies it for the session length.
  SeekingProgram: 19,
  Attending: 20,
  // First-aid tending (citizens.js's TEND_RECOVERY_RATE, ~4x the passive DOWNED_RECOVERY_RATE --
  // real RimWorld tend-bonus ratio): a citizen with construction or combat skill invested walks to
  // and actively tends a Downed ally, same Seeking*/active-job pair shape as every other job above.
  // See tryClaimTend below for the eligibility gate and citizens.js's tickNeedsAndMood for how the
  // recovery-rate swap actually happens.
  SeekingTend: 21,
  Tending: 22,
  // Exercise (citizens.js's EXERCISE_DECAY, PA needs.txt's Exercise need): a citizen with a low
  // Exercise need walks directly to the new Fitness Station buildable (siege.js Structure kind
  // 'fitness_station') and refills there, same Seeking*/active-job pair shape as every other
  // need-fulfillment job above. See findNearestFitnessStation below for the structure-targeted
  // lookup (no zone-tile targeting like Food/Bedroom/Recreation -- the buildable itself is the
  // destination, matching the "a citizen actually uses the Fitness Station" requirement).
  SeekingExercise: 23,
  Exercising: 24,
  // Farming (research.js's Agronomy node, siege.js Structure kind 'farm_plot'): a citizen tends a
  // built, renewable Farm Plot over real time, same single-worker staffed-station shape as
  // SeekingWorkshop/Processing above (reuses Structure's generic workerId/_workTimer fields), but
  // distinct in one real way -- it doesn't consume a raw-material input to start a cycle, it just
  // pays out a food/scrap-equivalent trickle once enough tend-time has accumulated, then keeps
  // running for the same worker rather than needing to be re-claimed. See FARM_CYCLE_TICKS/
  // FARM_YIELD_PER_CYCLE below and tryClaimFarming/findNearestFarmPlot.
  SeekingFarm: 25,
  Farming: 26,
  // Restaurant (siege.js Structure kind 'restaurant', economy.js's BUILD_COST.restaurant): a
  // consolidated stand-in for Prison Architect's real Restaurant+Bakery retail-income mechanic --
  // "visitor traffic" isn't modeled as its own entity system here (would need a parallel
  // pathing/spawn pipeline for a purely cosmetic payoff), so the income is generated directly by a
  // staffed citizen instead, same single-worker staffed-station shape as SeekingWorkshop/
  // SeekingFarm above. Like Farming (and unlike Processing), it needs no raw-material input to
  // start a cycle -- just an idle citizen and real tend-time, see RESTAURANT_CYCLE_TICKS/
  // RESTAURANT_YIELD_PER_CYCLE below and tryClaimRestaurant/findNearestRestaurant.
  SeekingRestaurant: 27,
  Restaurant: 28,
  // Hygiene (citizens.js's HYGIENE_DECAY, RimWorld QoL-mod-style hygiene need): a citizen with low
  // Hygiene walks directly to the new Shower buildable (siege.js Structure kind 'shower'), same
  // Seeking*/active-job pair shape as Exercise/SeekingExercise above -- but with a real plumbing
  // dependency Exercise doesn't have: findNearestShower only ever targets a Shower that's actually
  // connected to the water grid (water.js's isWateredAt), and the Bathing state below re-checks
  // that connection every tick it's in use, so an unplumbed Shower never refills Hygiene at all.
  SeekingHygiene: 29,
  Bathing: 30,
});

// Work Priorities (RimWorld Work-tab-style, see citizens.js's hasWorkPriorities/workPriority*
// fields and main.js's Work Priorities panel). One category per non-needs JobState pair below --
// deliberately no categories without a corresponding behavior. Order here doubles as the
// legacy/default fixed priority ladder's order (Construction > Processing > Hauling > Harvesting >
// Animal > Cleaning), so equal-priority ties in a citizen's custom order break the same way the
// untouched ladder already does. Processing sits right after Construction: like Construction, it
// only ever has work available once the player has actually banked material for it (a built
// station + scrap on hand), so it's never competing with Hauling/Harvesting for an idle citizen's
// attention when there's genuinely nothing queued -- see tryClaimProcessing below. Cleaning is
// deliberately last: real RimWorld's own WorkTypeDefs give Cleaning a naturalPriority of 200, near
// the very bottom of its real 17-category list -- well below Construction/Hauling/Harvesting
// (PlantCutting-ish), ahead of only Research.
export const WorkCategory = Object.freeze({
  Construction: 0, // SeekingBuild / Building
  Processing: 1,   // SeekingWorkshop / Processing
  Hauling: 2,       // SeekingVehicle / Driving
  Harvesting: 3,    // SeekingScrap / Harvesting
  Animal: 4,        // SeekingAnimal / Taming
  Cleaning: 5,      // SeekingClean / Cleaning
});
export const WORK_CATEGORY_ORDER = [
  WorkCategory.Construction, WorkCategory.Processing, WorkCategory.Hauling, WorkCategory.Harvesting,
  WorkCategory.Animal, WorkCategory.Cleaning,
];
export const WORK_CATEGORY_LABELS = {
  [WorkCategory.Construction]: 'Construction',
  [WorkCategory.Processing]: 'Processing',
  [WorkCategory.Hauling]: 'Hauling',
  [WorkCategory.Harvesting]: 'Harvesting',
  [WorkCategory.Animal]: 'Animal Handling',
  [WorkCategory.Cleaning]: 'Cleaning',
};
// Per-citizen priority field name for each category, matching citizens.js's CitizenStore fields.
export const WORK_CATEGORY_FIELD = {
  [WorkCategory.Construction]: 'workPriorityConstruction',
  [WorkCategory.Processing]: 'workPriorityProcessing',
  [WorkCategory.Hauling]: 'workPriorityHauling',
  [WorkCategory.Harvesting]: 'workPriorityHarvesting',
  [WorkCategory.Animal]: 'workPriorityAnimal',
  [WorkCategory.Cleaning]: 'workPriorityCleaning',
};
// disabledWork lookup (traits.js's optional disabledWork array, RimWorld's real disabledWorkTags
// pattern -- see that file's top-of-file doc comment): plain key-name strings, NOT
// WORK_CATEGORY_LABELS' own display text just above (that has independent wording, e.g. 'Animal
// Handling' with a space) -- a separate small map so trait data stays decoupled from label copy.
const WORK_CATEGORY_NAME = {
  [WorkCategory.Construction]: 'Construction',
  [WorkCategory.Processing]: 'Processing',
  [WorkCategory.Hauling]: 'Hauling',
  [WorkCategory.Harvesting]: 'Harvesting',
  [WorkCategory.Animal]: 'Animal',
  [WorkCategory.Cleaning]: 'Cleaning',
};
// True if citizen i's trait flatly disallows this WorkCategory -- checked before a category is
// ever attempted, both by the Work Priorities custom-order loop and the legacy fixed ladder below,
// same "trait gate checked first" precedent as breakRateMultFor/needsThrottleMultFor elsewhere in
// this file's rate chains. Farming/Restaurant are deliberately NOT covered (they're not part of
// the WorkCategory enum at all -- see the existing "not yet part of the Work Priorities system"
// comments at their own tryClaim*/Idle-branch call sites below).
function isWorkDisabledFor(store, i, cat) {
  return !!store.trait[i]?.disabledWork?.includes(WORK_CATEGORY_NAME[cat]);
}

const SEEK_SOCIAL_THRESHOLD = 0.35;
const SEEK_HUNGER_THRESHOLD = 0.45;
const SEEK_REST_THRESHOLD = 0.4;
// Exercise (see citizens.js's EXERCISE_DECAY): same threshold as Rest -- "similar magnitude to
// Hunger/Rest" per the task brief, and Rest is this codebase's closest existing precedent for a
// need with no schedule-block bias of its own.
const SEEK_EXERCISE_THRESHOLD = 0.4;
// Hygiene (see citizens.js's HYGIENE_DECAY): same threshold as Rest/Exercise -- matching this
// codebase's existing "similar magnitude, similar threshold" precedent rather than inventing a
// distinct number for a need that decays at the same rate.
const SEEK_HYGIENE_THRESHOLD = 0.4;
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
// Exported: draft.js reuses these directly for move-order arrival/travel speed rather than
// inventing a second set of movement constants for manually-controlled citizens.
export const ARRIVE_DIST = 0.35;
export const JOB_SPEED = 0.09; // citizens hustle to zones -- travel time was the dominant cost in the needs loop

// Exported: drones.js reuses these two exact rates for its own Construction/Harvesting work
// loops rather than inventing parallel constants -- a drone builds/harvests at the flat
// (skill=0) rate a brand-new citizen would, see that file's header comment.
export const BUILD_RATE = 0.012; // per tick, scaled by construction skill below
const BUILD_SKILL_GAIN = 0.02;
export const HARVEST_RATE = 3; // scrap per tick pulled from a node
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

// Crisis-resolution reward (world.js's unrestResolutionBuffTicks -- Prison Architect
// calamity_rewards.txt's pattern: survive a crisis while keeping Wellbeing up -> a genuine
// temporary buff, not just downside during). Mirrors UNREST_RATE_MULT's own "small local
// constant, world.js is the source of truth for whether/how long it applies" pattern. In practice
// this and UNREST_RATE_MULT are never both active at once (the buff only starts counting down
// after world.unrestActive has already gone back to false on a good resolve), but
// unrestRateMultFor below stacks them multiplicatively anyway rather than assuming that.
const JOBS_UNREST_REWARD_RATE_MULT = 1.15;

function unrestRateMultFor(world) {
  let mult = world?.unrestActive ? UNREST_RATE_MULT : 1;
  if (world?.unrestResolutionBuffTicks > 0) mult *= JOBS_UNREST_REWARD_RATE_MULT;
  return mult;
}

// worldmap.js's arrival-mishap system (Odyssey LandingOutcomeDef-style, toned down -- see that
// file's constants block for the real-numbers rationale): a "debuff" mishap sets
// world.arrivalMishapTicks to a short countdown (world.js ticks it down) rather than harming a
// citizen directly, applied here as a flat work-speed penalty, same "small local constant,
// world.js owns the timer" pattern as UNREST_RATE_MULT/unrestRateMultFor above.
const ARRIVAL_MISHAP_RATE_MULT = 0.7;
function arrivalMishapRateMultFor(world) {
  return world?.arrivalMishapTicks > 0 ? ARRIVAL_MISHAP_RATE_MULT : 1;
}

// Exported: forcejob.js's right-click job-target detection (input.js) reuses this exact gate so
// a room only offers a Force-Clean target when findNearestMessyRoom's own autonomous claim would
// also consider it worth cleaning -- one threshold, not two drifting copies.
export const MESS_CLEAN_THRESHOLD = 0.15; // don't send a citizen to scrub a room that's only barely dusty
// Exported: drones.js reuses this exact rate rather than inventing a second cleaning-speed
// constant for its own, much simpler, needs-free work loop (see that file's header comment).
export const CLEAN_RATE = 0.01; // per tick reduction of room.mess while actively cleaning (rooms.js)
// Exported: drones.js reuses this exact arrival radius for the same reason CLEAN_RATE is exported
// above -- rooms.js's roomCentroid can land on a wall/furniture cell.
export const CLEAN_ARRIVE_DIST = 0.6; // rooms.js's roomCentroid can land on a wall/furniture cell; a looser arrival radius than ARRIVE_DIST avoids a citizen stalling trying to stand exactly on it

// Materials-processing station (real Prison Architect materials.txt: SheetMetal price -10 -> two
// staffed workshop stations -> LicensePlate price -20, an exact 2x raw-to-finished uplift; real
// ConstructionTime on those stations is 20 real-minutes -- mirrored here as 20 ticks per unit
// processed, not construction time of the station itself, which uses the normal BUILD_RATE path
// like any other blueprint). WORKSHOP_PROCESSED_PER_UNIT is exactly 2x WORKSHOP_RAW_PER_UNIT.
// Exported: drones.js's own Processing work loop reuses these three exact numbers rather than a
// parallel set -- a drone staffing a workshop station processes at the identical rate/economics
// a citizen would.
export const WORKSHOP_RAW_PER_UNIT = 5;        // scrap consumed from world.scrap to start one unit
export const WORKSHOP_PROCESSED_PER_UNIT = 10; // scrap paid out on completion -- the real 2x uplift
export const WORKSHOP_PROCESS_TICKS = 20;      // ticks to finish one unit once a worker is staffing it

// Farm Plot (siege.js Structure kind 'farm_plot', research.js's Agronomy node): a renewable,
// citizen-tended producer -- distinct from resource-node Harvesting (a finite deposit that
// depletes) and from Processing (consumes a raw-scrap input per unit). A Farm Plot needs no input:
// a tending citizen just accrues real tend-time via Structure's generic `_workTimer` field until a
// cycle completes, pays out FARM_YIELD_PER_CYCLE, and keeps running for the same worker into the
// next cycle. FARM_CYCLE_TICKS is priced between HARVEST_RATE's near-instant per-tick trickle and
// WORKSHOP_PROCESS_TICKS's 20-tick unit -- slower than either since it's meant to reward a citizen
// staying put on one plot rather than a quick in-and-out.
export const FARM_CYCLE_TICKS = 60;      // ticks of active tending to complete one growth cycle
export const FARM_YIELD_PER_CYCLE = 6;   // food/scrap-equivalent resource paid out per completed cycle
const FARM_SKILL_GAIN = 0.008;           // construction-skill trickle while tending, same family as HARVEST_SKILL_GAIN

// Restaurant (siege.js Structure kind 'restaurant'): same single-worker staffed-cycle shape as
// Farm Plot immediately above (reuses Structure's generic `_workTimer` field), tuned to a shorter
// cycle / smaller per-cycle payout than farming -- retail income is meant to read as a "steady
// trickle" rather than a periodic lump, and this is a standing income source with no separate
// research gate (unlike Farm Plot's Agronomy requirement), so it's deliberately not the single
// biggest per-worker payout in the economy.
export const RESTAURANT_CYCLE_TICKS = 40;      // ticks of active staffing to complete one service cycle
export const RESTAURANT_YIELD_PER_CYCLE = 3;   // scrap paid out per completed cycle -- "visitor traffic" retail income
const RESTAURANT_SKILL_GAIN = 0.006;           // construction-skill trickle while staffing, same family as FARM_SKILL_GAIN

// Cinema (siege.js Structure kind 'cinema', economy.js's BUILD_COST.cinema -- real Prison
// Architect DLC prefab data: WatchCinema provider, -5.0 Recreation + -1.0 Freedom-equivalent
// per use, BroadcastRange 10). Deliberately NOT a single-occupant zone-tile refill like
// bed/table/fitness_station above, and NOT a staffed retail cycle like Restaurant above --
// it's a group-broadcast building, same "every target in range, not one nearest target"
// mechanism siege.js's Tesla Coil already established for combat (TESLA_RANGE, the
// chains-to-every-attacker-in-range loop in tickTurrets). tickCinemas below is that same
// range-iteration pattern applied to citizens instead of attackers: no zone tile to path to,
// no worker to staff it, just "stand within range while it's showing and get refilled" --
// reused wholesale rather than inventing a second broadcast mechanism from scratch.
// CINEMA_RANGE: the real BroadcastRange stat (10), used directly -- this project's grid
// (64x64, see grid.js) is the same order of magnitude as the tile-scale every other range
// constant here already assumes (TESLA_RANGE 4.5, watchtower/floodlight radii in the
// single-digit-to-low-teens range), so no rescale is needed, unlike e.g. impressiveness
// labels elsewhere that DO need a scale factor onto a different numeric range.
export const CINEMA_RANGE = 10;
// A "showing" is a discrete broadcast event (mirrors WatchCinema's "per use" framing, and
// Tesla's own discrete per-activation-not-continuous shape) rather than a continuous trickle --
// every citizen in range at showtime gets refilled together, which is also what makes the
// "simultaneous, not nearest-only" behavior directly observable via before/after need snapshots.
export const CINEMA_SHOWTIME_INTERVAL_TICKS = 300; // ~30s at 10Hz between showings
// Real -5.0 Recreation per use (Sims-style 0..100 need scale) rescaled onto this project's 0..1
// Social need: 5/100 = 0.05 would barely register against SOCIAL_DECAY's ~0.0004/tick trickle
// over a 300-tick gap (~0.12 lost between showings), so scaled up proportionally to actually
// matter at this project's own numeric scale, same "keep the real ratio, not the raw number"
// approach FARM_YIELD_PER_CYCLE/RESTAURANT_YIELD_PER_CYCLE already took for their own real-data
// anchors above.
export const CINEMA_SOCIAL_REFILL = 0.3;
// Real -1.0 Freedom-equivalent per use: no Freedom need exists in this codebase, so the closest
// honest analogue is a small direct mood nudge (same "translate to the nearest existing axis"
// call rooms.js's shrine/Beauty and citizens.js's Ideology precept work already made) via the
// existing addMoodEvent system rather than inventing a second need.
const CINEMA_MOOD_MAGNITUDE = 0.04;
const CINEMA_MOOD_DURATION_TICKS = 400;

// Broadcasts a "showing" to every citizen within CINEMA_RANGE of every active (built, not
// destroyed/under-construction) Cinema once every CINEMA_SHOWTIME_INTERVAL_TICKS -- called once
// per world tick from world.js, same call shape as siege.js's tickTurrets. Deliberately does NOT
// gate on jobState/allowedCheck/room role the way the zone-refill paths in tickJobs below do: a
// broadcast building's whole point (and the real DLC stat's point) is that a citizen doesn't have
// to interrupt what they're doing and path to a specific tile, they just have to be standing
// somewhere nearby when it airs -- so a citizen mid-Harvesting or mid-Building still benefits.
export function tickCinemas(structures, store, currentTick) {
  for (const s of structures) {
    if (s.kind !== 'cinema' || s.destroyed || s.underConstruction) continue;
    if (currentTick % CINEMA_SHOWTIME_INTERVAL_TICKS !== 0) continue;
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i)) continue;
      if (Math.hypot(store.x[i] - s.x, store.y[i] - s.y) > CINEMA_RANGE) continue;
      store.social[i] = Math.min(1, store.social[i] + CINEMA_SOCIAL_REFILL);
      addMoodEvent(store, i, currentTick, {
        magnitude: CINEMA_MOOD_MAGNITUDE, durationTicks: CINEMA_MOOD_DURATION_TICKS, stackKey: 'cinemaShowing',
      });
    }
  }
}

// First-aid tending (JobState.SeekingTend/Tending, see citizens.js's TEND_RECOVERY_RATE). No
// dedicated Medicine skill exists in this codebase and FEATURE_RESEARCH.md's precedent (see
// jobs.js's own Taming comment above) is not to add one just for a single job type -- construction
// skill (patching someone up is a hands-on fix-it task, same instinct as patching a wall) and
// combat skill (a citizen who's fought alongside the wounded knows real battlefield first aid) are
// both narratively defensible, so either qualifies rather than picking one over the other.
// TEND_SKILL_THRESHOLD reuses the exact "Novice" cutoff citizens.js's SKILL_INVESTED_THRESHOLD and
// main.js's SKILL_LEVELS already use -- "skill invested" means past that bar, not just whatever
// small (occasionally negative) starting nudge a backstory happens to give.
const TEND_SKILL_THRESHOLD = 0.15;
// Small chance-based variance on tend quality (RimWorld's real medicine-quality curve, mirrored
// here without an item-tier system): each tick spent actively tending has a small chance of a
// minor extra bonus/malus nudge to the patient's health, layered on top of the flat
// TEND_RECOVERY_RATE swap in citizens.js -- symmetric (bonus and malus equally likely), so it reads
// as "quality varies" rather than a hidden buff or nerf to the headline 4x number.
const TEND_VARIANCE_CHANCE = 0.02; // per tick, while actively Tending
const TEND_VARIANCE_MAG = 0.01;    // +/- health, applied on a variance-roll tick

export function isOnJob(store, i) {
  return store.jobState[i] !== JobState.Idle;
}

// Releases whatever job claim citizen i currently holds (blueprint.claimedBy, an animal's
// claimedBy, a workshop's workerId, a program site's attendeeIds entry) and snaps them back to
// Idle -- factored out of the Duty Roster sleep-interrupt block below so draft.js's draftCitizen
// can call the exact same release logic when a player drafts a citizen mid-task, rather than
// leaving a phantom claim behind that blocks everyone else from picking that job back up. A
// citizen with no active claim-bearing job (Idle, Eating/Sleeping/Recreating/Driving, or already
// Attacking/whatever draft.js itself put them in) is simply left alone -- state === Idle after the
// switch either way.
export function releaseCurrentJobClaim(store, i, idOf) {
  const state = store.jobState[i];
  if (state === JobState.Building || state === JobState.SeekingBuild) {
    const bp = store._jobRef?.[i];
    if (bp) bp.claimedBy = null;
  } else if (state === JobState.SeekingAnimal || state === JobState.Taming) {
    const animal = store._jobRef?.[i];
    if (animal) animal.claimedBy = null;
  } else if (state === JobState.SeekingWorkshop || state === JobState.Processing) {
    const station = store._jobRef?.[i];
    if (station) station.workerId = null;
  } else if (state === JobState.SeekingProgram || state === JobState.Attending) {
    const site = store._jobRef?.[i];
    if (site) {
      const idx = site.attendeeIds.indexOf(idOf(i));
      if (idx >= 0) site.attendeeIds.splice(idx, 1);
    }
    store.programSite[i] = null;
  } else if (state === JobState.SeekingTend || state === JobState.Tending) {
    const targetIdx = store._jobRef?.[i];
    if (targetIdx != null && store.tendClaimedBy[targetIdx] === idOf(i)) store.tendClaimedBy[targetIdx] = -1;
  } else if (state === JobState.SeekingFarm || state === JobState.Farming) {
    const plot = store._jobRef?.[i];
    if (plot && plot.workerId === idOf(i)) plot.workerId = null;
  } else if (state === JobState.SeekingRestaurant || state === JobState.Restaurant) {
    const station = store._jobRef?.[i];
    if (station && station.workerId === idOf(i)) station.workerId = null;
  }
  // Harvesting/SeekingScrap/SeekingVehicle/Cleaning/SeekingClean/Idle/Eating/Sleeping/
  // Recreating/Driving have no claim to release (findNearestNode/findUndrivenVehicle/
  // findNearestMessyRoom deliberately don't track claimedBy, see their own doc comments above).
  store.jobState[i] = JobState.Idle;
}

// One try-to-claim helper per WorkCategory, each doing exactly what the original inline Idle-
// branch code did for that job type (see the git history of tickJobs below) -- factored out so
// both the legacy fixed-order ladder and a citizen's custom Work Priorities order can call the
// same claim logic instead of drifting apart. Returns true (and mutates store/jobState/_jobRef)
// only if a job of that category was actually available and claimed this tick.
function tryClaimConstruction(store, i, structures, idOf, isAllowed) {
  const blueprint = findNearestBlueprint(structures, store.x[i], store.y[i], idOf(i), isAllowed);
  if (!blueprint) return false;
  blueprint.claimedBy = idOf(i);
  store.jobState[i] = JobState.SeekingBuild;
  store.targetX[i] = blueprint.x; store.targetY[i] = blueprint.y;
  store._jobRef[i] = blueprint;
  return true;
}

function tryClaimHauling(store, i, world, isAllowed) {
  const vehicle = findUndrivenVehicle(world.vehicles, store.x[i], store.y[i], isAllowed);
  if (!vehicle) return false;
  store.jobState[i] = JobState.SeekingVehicle;
  store.targetX[i] = vehicle.x; store.targetY[i] = vehicle.y;
  store._jobRef[i] = vehicle;
  return true;
}

function tryClaimHarvesting(store, i, resourceNodes, isAllowed) {
  const node = findNearestNode(resourceNodes, store.x[i], store.y[i], isAllowed);
  if (!node) return false;
  store.jobState[i] = JobState.SeekingScrap;
  store.targetX[i] = node.x; store.targetY[i] = node.y;
  store._jobRef[i] = node;
  return true;
}

function tryClaimAnimal(store, i, world, idOf, isAllowed) {
  const animal = findNearestTameableAnimal(world.wildAnimals || [], store.x[i], store.y[i], isAllowed);
  if (!animal) return false;
  animal.claimedBy = idOf(i);
  store.jobState[i] = JobState.SeekingAnimal;
  store.targetX[i] = animal.x; store.targetY[i] = animal.y;
  store._jobRef[i] = animal;
  return true;
}

function tryClaimCleaning(store, i, world, isAllowed) {
  const room = findNearestMessyRoom(world.rooms, world.grid, store.x[i], store.y[i], isAllowed);
  if (!room) return false;
  const target = roomCentroid(room, world.grid);
  store.jobState[i] = JobState.SeekingClean;
  store.targetX[i] = target.x; store.targetY[i] = target.y;
  store._jobRef[i] = room;
  return true;
}

// Only claims a station if there's actually raw scrap banked to feed it -- a citizen shouldn't
// walk across the map to stand at an idle workshop with nothing to process, same "is there
// genuinely work here" gate findNearestNode/findUndrivenVehicle apply implicitly by only
// existing when they have something to offer.
function tryClaimProcessing(store, i, structures, world, idOf, isAllowed) {
  if (world.scrap < WORKSHOP_RAW_PER_UNIT) return false;
  const station = findNearestWorkshop(structures, store.x[i], store.y[i], isAllowed);
  if (!station) return false;
  station.workerId = idOf(i);
  store.jobState[i] = JobState.SeekingWorkshop;
  store.targetX[i] = station.x; store.targetY[i] = station.y;
  store._jobRef[i] = station;
  return true;
}

// Farm Plot (see findNearestFarmPlot/FARM_CYCLE_TICKS above): no scrap-on-hand gate, deliberately
// -- unlike tryClaimProcessing (which shouldn't send a citizen to stand at a station with nothing
// to process), a Farm Plot needs no input to be worth tending, it just needs an idle citizen.
function tryClaimFarming(store, i, structures, idOf, isAllowed) {
  const plot = findNearestFarmPlot(structures, store.x[i], store.y[i], isAllowed);
  if (!plot) return false;
  plot.workerId = idOf(i);
  store.jobState[i] = JobState.SeekingFarm;
  store.targetX[i] = plot.x; store.targetY[i] = plot.y;
  store._jobRef[i] = plot;
  return true;
}

// Restaurant (see findNearestRestaurant/RESTAURANT_CYCLE_TICKS above): same "no input-on-hand
// gate" shape as tryClaimFarming -- an unstaffed Restaurant is worth walking to purely because an
// idle citizen can staff it, no scrap needs to be banked first (unlike tryClaimProcessing).
function tryClaimRestaurant(store, i, structures, idOf, isAllowed) {
  const station = findNearestRestaurant(structures, store.x[i], store.y[i], isAllowed);
  if (!station) return false;
  station.workerId = idOf(i);
  store.jobState[i] = JobState.SeekingRestaurant;
  store.targetX[i] = station.x; store.targetY[i] = station.y;
  store._jobRef[i] = station;
  return true;
}

// Every claim lambda now takes an extra trailing isAllowed arg (the citizen's per-tick Allowed
// Area check built in tickJobs, see its own doc comment) and threads it straight through to its
// finder -- null for every citizen with no restriction painted, which every finder treats as "no
// filtering at all", byte-for-byte the old behavior.
const WORK_CATEGORY_CLAIM = {
  [WorkCategory.Construction]: (store, i, structures, resourceNodes, world, idOf, isAllowed) => tryClaimConstruction(store, i, structures, idOf, isAllowed),
  [WorkCategory.Processing]: (store, i, structures, resourceNodes, world, idOf, isAllowed) => tryClaimProcessing(store, i, structures, world, idOf, isAllowed),
  [WorkCategory.Hauling]: (store, i, structures, resourceNodes, world, idOf, isAllowed) => tryClaimHauling(store, i, world, isAllowed),
  [WorkCategory.Harvesting]: (store, i, structures, resourceNodes, world, idOf, isAllowed) => tryClaimHarvesting(store, i, resourceNodes, isAllowed),
  [WorkCategory.Animal]: (store, i, structures, resourceNodes, world, idOf, isAllowed) => tryClaimAnimal(store, i, world, idOf, isAllowed),
  [WorkCategory.Cleaning]: (store, i, structures, resourceNodes, world, idOf, isAllowed) => tryClaimCleaning(store, i, world, isAllowed),
};

// isAllowed: optional (x, y) -> bool predicate (jobs.js's per-citizen Allowed Area check).
// Omitted for every pre-existing call site, byte-for-byte the old behavior.
function findNearestBlueprint(structures, x, y, excludeClaimedBy, isAllowed = null) {
  let best = null, bestDist = Infinity;
  for (const s of structures) {
    if (!s.underConstruction || s.destroyed) continue;
    if (s.claimedBy != null && s.claimedBy !== excludeClaimedBy) continue;
    if (isAllowed && !isAllowed(s.x, s.y)) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

function findNearestNode(nodes, x, y, isAllowed = null) {
  let best = null, bestDist = Infinity;
  for (const n of nodes) {
    if (n.depleted) continue;
    if (isAllowed && !isAllowed(n.x, n.y)) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best;
}

// No claimedBy tracking here, deliberately -- same pattern as findNearestNode above (multiple
// citizens converging on the same resource node is an accepted non-issue, not a bug to fix), and
// a room being cleaned by more than one citizen at once is even less of a problem since .mess
// just floors at 0 instead of going negative.
function findNearestMessyRoom(rooms, grid, x, y, isAllowed = null) {
  let best = null, bestDist = Infinity;
  for (const room of rooms) {
    if ((room.mess || 0) < MESS_CLEAN_THRESHOLD) continue;
    const c = roomCentroid(room, grid);
    if (isAllowed && !isAllowed(c.x, c.y)) continue;
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < bestDist) { bestDist = d; best = room; }
  }
  return best;
}

function findNearestWorkshop(structures, x, y, isAllowed = null) {
  let best = null, bestDist = Infinity;
  for (const s of structures) {
    if (s.kind !== 'workshop' || s.destroyed || s.underConstruction) continue;
    if (s.workerId != null) continue; // already staffed
    if (isAllowed && !isAllowed(s.x, s.y)) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

// Farm Plot (siege.js Structure kind 'farm_plot'): single-worker exclusivity, same shape as
// findNearestWorkshop above -- one citizen tends one plot at a time.
function findNearestFarmPlot(structures, x, y, isAllowed = null) {
  let best = null, bestDist = Infinity;
  for (const s of structures) {
    if (s.kind !== 'farm_plot' || s.destroyed || s.underConstruction) continue;
    if (s.workerId != null) continue; // already staffed
    if (isAllowed && !isAllowed(s.x, s.y)) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

// Restaurant (siege.js Structure kind 'restaurant'): single-worker exclusivity, same shape as
// findNearestFarmPlot/findNearestWorkshop above -- one citizen staffs one Restaurant at a time.
function findNearestRestaurant(structures, x, y, isAllowed = null) {
  let best = null, bestDist = Infinity;
  for (const s of structures) {
    if (s.kind !== 'restaurant' || s.destroyed || s.underConstruction) continue;
    if (s.workerId != null) continue; // already staffed
    if (isAllowed && !isAllowed(s.x, s.y)) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

// No staffing exclusivity, deliberately -- unlike findNearestWorkshop above (single-worker
// 'workshop' station), a Fitness Station is closer in spirit to a zone tile: any number of
// citizens can use it to refill Exercise at once, matching how zones.nearestOfKind never gates on
// "already occupied" either.
function findNearestFitnessStation(structures, x, y, isAllowed = null) {
  let best = null, bestDist = Infinity;
  for (const s of structures) {
    if (s.kind !== 'fitness_station' || s.destroyed || s.underConstruction) continue;
    if (isAllowed && !isAllowed(s.x, s.y)) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

// Shower (siege.js Structure kind 'shower', economy.js's BUILD_COST.shower): same no-staffing-
// exclusivity shape as findNearestFitnessStation above, but with a real, load-bearing extra gate --
// isWateredAt(structures, s.x, s.y) -- so a Shower with no live pipe/pump run to it is never even
// offered as a destination, the same way a garage with no built vehicle isn't offered by
// findUndrivenVehicle. This is the actual "plumbing dependency, not a flat furniture piece"
// requirement: a colony with Showers built but no water grid just never sends anyone to use them,
// same "not yet functional, so not yet a job" precedent every other gated finder in this file sets.
function findNearestShower(structures, x, y, isAllowed = null) {
  let best = null, bestDist = Infinity;
  for (const s of structures) {
    if (s.kind !== 'shower' || s.destroyed || s.underConstruction) continue;
    if (!isWateredAt(structures, s.x, s.y)) continue; // not connected to the water grid -- inert
    if (isAllowed && !isAllowed(s.x, s.y)) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

function findNearestTameableAnimal(wildAnimals, x, y, isAllowed = null) {
  let best = null, bestDist = Infinity;
  for (const a of wildAnimals) {
    if (a.claimedBy != null) continue; // someone's already taming this one
    if (isAllowed && !isAllowed(a.x, a.y)) continue;
    const d = Math.hypot(a.x - x, a.y - y);
    if (d < bestDist) { bestDist = d; best = a; }
  }
  return best;
}

// Downed-ally targets are other citizens in the SAME store, not a separate list -- unlike every
// finder above (structures/nodes/vehicles/animals/rooms), this walks store.count directly. Returns
// an index (not an id): CitizenStore never compacts/removes slots on death (dead citizens just stay
// isAliveAt()===false forever at their original index, see citizens.js), so a raw index is exactly
// as stable a reference as the object references every other finder above returns -- safe to hold
// in _jobRef the same way. Excludes the tender's own index and anyone already claimed by a
// different tender (store.tendClaimedBy, an id -- see citizens.js's doc comment on that field).
function findNearestDownedAlly(store, tenderIdx, x, y, isAllowed = null) {
  let best = -1, bestDist = Infinity;
  for (let j = 0; j < store.count; j++) {
    if (j === tenderIdx) continue;
    if (!store.isAliveAt(j) || !store.isDownedAt(j)) continue;
    if (store.tendClaimedBy[j] !== -1) continue; // already being tended (or walked to) by someone else
    if (isAllowed && !isAllowed(store.x[j], store.y[j])) continue;
    const d = Math.hypot(store.x[j] - x, store.y[j] - y);
    if (d < bestDist) { bestDist = d; best = j; }
  }
  return best;
}

// First-aid tending eligibility: construction OR combat skill past the Novice bar (see
// TEND_SKILL_THRESHOLD's doc comment above for why either qualifies). Checked before the (cheap
// but not free) store.count scan for a downed ally, same "cheap gate first" ordering every other
// tryClaim* above uses.
function tryClaimTend(store, i, world, idOf, isAllowed) {
  if (store.skillConstruction[i] < TEND_SKILL_THRESHOLD && store.skillCombat[i] < TEND_SKILL_THRESHOLD) return false;
  const targetIdx = findNearestDownedAlly(store, i, store.x[i], store.y[i], isAllowed);
  if (targetIdx < 0) return false;
  store.tendClaimedBy[targetIdx] = idOf(i);
  store.jobState[i] = JobState.SeekingTend;
  store.targetX[i] = store.x[targetIdx]; store.targetY[i] = store.y[targetIdx];
  store._jobRef[i] = targetIdx;
  return true;
}

export function tickJobs(store, zones, staffOnDuty, structures, resourceNodes, idOf, onScrapGain, world) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.isDownedAt(i)) continue; // incapacitated, can't work until recovered
    // Drafted (draft.js -- RimWorld-style manual control, see citizens.js's CitizenFlags.Drafted):
    // pulled out of the autonomous priority state machine entirely, even mid-task. draft.js's own
    // tickDrafted (called separately from world.js) owns all movement/combat for a drafted citizen
    // from here on; this is the one, single place that removal happens, so undrafting later just
    // means this check stops firing and the citizen falls right back into Idle same as always.
    if (store.isDraftedAt(i)) continue;
    if (staffOnDuty(i)) continue; // guards/snipers hold their post, no eat/sleep/work jobs

    // Duty Roster: a citizen deep in a work/harvest task at scheduled sleep-time gets pulled off
    // it to go find a bed, same as PA staff clearing a Regime block -- but only if they aren't
    // already close to exhausted (that path is handled below via the normal Idle/SeekingBed
    // branch regardless of schedule) and only for interruptible states; Driving and the
    // short Eating/Sleeping/Recreating fulfillment states are left to finish.
    // Per-citizen Schedule override (schedule.js's ScheduleOverride, RimWorld Schedule-tab style):
    // effectiveScheduleBlock returns the citizen's own pinned block if the player has set one,
    // otherwise the colony-wide block computed from world.timeOfDay -- every use of scheduleBlock
    // below (this Sleep-interrupt check, the Idle-branch threshold bias, and findJoinableSite)
    // transparently respects it. Default (no override) is byte-for-byte the old behavior.
    const colonyScheduleBlock = world ? getScheduleBlock(world.timeOfDay) : ScheduleBlock.Work;
    const scheduleBlock = effectiveScheduleBlock(store.scheduleOverride[i], colonyScheduleBlock);

    // Allowed Area restriction (RimWorld Restrict-tab style, see citizens.js's isInAllowedArea):
    // a single (x, y) -> bool closure built once per citizen per tick, threaded through every
    // autonomous target-selection call below (zone lookups, blueprint/node/vehicle/animal/room/
    // program-site finders). null for the vast majority of citizens (no restriction painted),
    // which every finder treats as "no filtering at all" -- byte-for-byte the old behavior. Does
    // NOT gate draft.js's move/attack orders (those run in a separate tickDrafted pass, never
    // through tickJobs) -- a direct drafted order is explicit player intent and always wins,
    // exactly as the task spec requires.
    const allowedCheck = (world && store.hasAllowedArea(i))
      ? (ax, ay) => store.isInAllowedArea(i, world.grid.width, ax, ay)
      : null;
    if (scheduleBlock === ScheduleBlock.Sleep && store.rest[i] < NIGHT_INTERRUPT_REST_THRESHOLD) {
      const interruptible = store.jobState[i];
      if (interruptible === JobState.Building || interruptible === JobState.SeekingBuild
        || interruptible === JobState.Harvesting || interruptible === JobState.SeekingScrap
        || interruptible === JobState.SeekingVehicle
        || interruptible === JobState.Cleaning || interruptible === JobState.SeekingClean
        || interruptible === JobState.SeekingAnimal || interruptible === JobState.Taming
        || interruptible === JobState.SeekingWorkshop || interruptible === JobState.Processing
        || interruptible === JobState.SeekingProgram || interruptible === JobState.Attending
        || interruptible === JobState.SeekingFarm || interruptible === JobState.Farming
        || interruptible === JobState.SeekingRestaurant || interruptible === JobState.Restaurant) {
        releaseCurrentJobClaim(store, i, idOf);
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
        const food = zones.nearestOfKind(ZoneKind.Food, store.x[i], store.y[i], allowedCheck);
        if (food) { store.jobState[i] = JobState.SeekingFood; store.targetX[i] = food.x; store.targetY[i] = food.y; continue; }
      }

      // Force Job (forcejob.js -- RimWorld-style "Prioritize", player-issued one-shot override,
      // see input.js's right-click-on-a-job-target wiring): jumps every check below -- the soft
      // rest/hunger/social thresholds, Structured Group Programs, and the whole Work-Priorities/
      // legacy-ladder autonomy -- but NOT the genuine starvation emergency just above, same "a
      // real crisis still wins" precedent CRITICAL_HUNGER_OVERRIDE already sets for the rest of
      // this branch. tryClaimForcedJob always consumes the pending order (success or failure), so
      // a stale target (vanished/claimed elsewhere since the order was given) just falls through
      // to normal evaluation this same tick rather than leaving the citizen doing nothing.
      if (store.forcedJobKind[i] && tryClaimForcedJob(store, i, world, idOf)) continue;

      // First-aid tending (JobState.SeekingTend/Tending, see TEND_SKILL_THRESHOLD/tryClaimTend
      // above): checked near the top of the ladder, right after the two genuine emergencies
      // (starvation, an explicit Force Job order) and before the citizen's own soft need
      // thresholds -- a Downed ally recovering 4x faster is worth a construction/combat-skilled
      // citizen's next few seconds even ahead of their own not-yet-critical hunger/rest/social.
      // tryClaimTend no-ops instantly (skill gate, then a cheap scan) when no one's down or this
      // citizen isn't eligible, so this never taxes a healthy colony's Idle branch meaningfully.
      if (tryClaimTend(store, i, world, idOf, allowedCheck)) continue;

      if (store.rest[i] < restThreshold) {
        const bed = zones.nearestOfKind(ZoneKind.Bedroom, store.x[i], store.y[i], allowedCheck);
        if (bed) { store.jobState[i] = JobState.SeekingBed; store.targetX[i] = bed.x; store.targetY[i] = bed.y; continue; }
      }
      if (store.hunger[i] < hungerThreshold) {
        const food = zones.nearestOfKind(ZoneKind.Food, store.x[i], store.y[i], allowedCheck);
        if (food) { store.jobState[i] = JobState.SeekingFood; store.targetX[i] = food.x; store.targetY[i] = food.y; continue; }
      }
      // Structured Group Programs (programs.js): voluntary attendance, checked BEFORE the plain
      // SeekingRec social check right below -- Community Circle's whole mechanic is discharging
      // the social need faster than an ordinary Recreation zone tile (see programs.js's
      // socialDischargePerTick vs. jobs.js's own REFILL_RATE), so a citizen with genuinely low
      // social needs to actually reach it as an option rather than the plain-Recreation branch
      // claiming them first every time (that's exactly what happened before this was moved here
      // -- caught in soak testing). Still strictly after hunger/rest above, matching PA's own
      // priority (Hydration/Food/Sleep outrank Recreation-tier needs). findJoinableSite returns
      // null unless a site of the right program kind exists, is scheduled-in for this timeOfDay
      // block, is actually staffed (a citizen physically holding the required role's post), has
      // an open place, and this citizen would genuinely benefit -- so this never fires for an
      // unstaffed program, satisfying the "no program runs without its staffer" requirement.
      if (world) {
        const site = findJoinableSite(world, store, i, scheduleBlock, allowedCheck);
        if (site) {
          const target = roomPostFor(site.room, world.grid);
          store.jobState[i] = JobState.SeekingProgram;
          store.targetX[i] = target.x; store.targetY[i] = target.y;
          store._jobRef[i] = site;
          store.programSite[i] = site;
          continue;
        }
      }

      if (store.social[i] < socialThreshold) {
        const rec = zones.nearestOfKind(ZoneKind.Recreation, store.x[i], store.y[i], allowedCheck);
        if (rec) { store.jobState[i] = JobState.SeekingRec; store.targetX[i] = rec.x; store.targetY[i] = rec.y; continue; }
      }

      // Exercise (citizens.js's EXERCISE_DECAY, PA's Exercise need): checked right after Social,
      // same "soft need, not a genuine emergency" tier as Rest/Hunger/Social above it -- targets
      // the Fitness Station buildable directly (findNearestFitnessStation) rather than a zone
      // tile, since v1 has no zone-tile refill path for Exercise the way Food/Bedroom/Recreation
      // do. No-ops (falls through to Work Priorities/the legacy ladder below) if no Fitness
      // Station has been built yet -- a colony with no gym just never seeks this, same "not yet
      // buildable, so not yet a job" precedent findNearestWorkshop/findUndrivenVehicle already set.
      if (store.exercise[i] < SEEK_EXERCISE_THRESHOLD) {
        const station = findNearestFitnessStation(structures, store.x[i], store.y[i], allowedCheck);
        if (station) {
          store.jobState[i] = JobState.SeekingExercise;
          store.targetX[i] = station.x; store.targetY[i] = station.y;
          store._jobRef[i] = station;
          continue;
        }
      }

      // Hygiene (citizens.js's HYGIENE_DECAY, RimWorld QoL-mod-style hygiene need): same tier as
      // Exercise right above it -- targets the Shower buildable directly (findNearestShower)
      // rather than a zone tile. findNearestShower already filters to only water-connected Showers
      // (see that function's doc comment), so this naturally no-ops (falls through, same as no
      // Fitness Station built yet) if the colony has no Shower at all, or has Showers but none of
      // them are actually plumbed -- a citizen simply never seeks out a non-functional Shower.
      if (store.hygiene[i] < SEEK_HYGIENE_THRESHOLD) {
        const shower = findNearestShower(structures, store.x[i], store.y[i], allowedCheck);
        if (shower) {
          store.jobState[i] = JobState.SeekingHygiene;
          store.targetX[i] = shower.x; store.targetY[i] = shower.y;
          store._jobRef[i] = shower;
          continue;
        }
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
          .filter(cat => store[WORK_CATEGORY_FIELD[cat]][i] > 0 && !isWorkDisabledFor(store, i, cat))
          .sort((a, b) => store[WORK_CATEGORY_FIELD[a]][i] - store[WORK_CATEGORY_FIELD[b]][i]);
        for (const cat of order) {
          if (WORK_CATEGORY_CLAIM[cat](store, i, structures, resourceNodes, world, idOf, allowedCheck)) break;
        }
        continue;
      }

      // disabledWork (traits.js, RimWorld's real disabledWorkTags pattern -- see isWorkDisabledFor's
      // own doc comment above): checked once per category, right before that category's finder
      // would otherwise run, same "trait gate first" placement the Work Priorities branch above
      // already uses.
      const constructionDisabled = isWorkDisabledFor(store, i, WorkCategory.Construction);
      const blueprint = constructionDisabled ? null : findNearestBlueprint(structures, store.x[i], store.y[i], idOf(i), allowedCheck);
      if (blueprint) {
        blueprint.claimedBy = idOf(i);
        store.jobState[i] = JobState.SeekingBuild;
        store.targetX[i] = blueprint.x; store.targetY[i] = blueprint.y;
        store._jobRef[i] = blueprint;
        continue;
      }

      // Processing (Prison Architect materials-chain analog, see WORKSHOP_* constants above and
      // siege.js's Structure 'workshop' kind): checked right after Construction, before Hauling/
      // Harvesting -- if there's already scrap sitting in the bank, upgrading it into more value
      // at a built station is a better use of an idle citizen's next few seconds than going to
      // gather more raw material that just piles up further behind it. tryClaimProcessing already
      // no-ops when there's no scrap banked or no unstaffed station, so this never steals an idle
      // citizen away from real hauling/harvesting work when there's nothing to process yet.
      if (!isWorkDisabledFor(store, i, WorkCategory.Processing) && tryClaimProcessing(store, i, structures, world, idOf, allowedCheck)) continue;

      // Farming (Agronomy research node, see FARM_CYCLE_TICKS above): checked right after
      // Processing, same "a built staffed producer beats going to fetch more raw material" logic
      // -- a Farm Plot needing a worker is exactly as ready-to-use as an unstaffed workshop with
      // scrap on hand. Not yet part of the Work Priorities system (WorkCategory in jobs.js only
      // covers Construction/Processing/Hauling/Harvesting/Animal/Cleaning) -- a v1 scope choice,
      // so a citizen with a custom priority order set (store.hasWorkPriorities[i]) won't reach
      // this branch (see the `continue` a few lines above); only the legacy fixed-ladder citizens
      // below do, same "not yet buildable, so not yet a job" precedent as everything else this
      // ladder gates on the buildable actually existing.
      if (tryClaimFarming(store, i, structures, idOf, allowedCheck)) continue;

      // Restaurant (see RESTAURANT_CYCLE_TICKS above): checked right after Farming, same "a built
      // staffed producer beats going to fetch more raw material" logic and same v1 scope note --
      // not yet part of the Work Priorities system, so only legacy fixed-ladder citizens reach
      // this branch (a citizen with a custom priority order set never reaches this line, see the
      // `continue` a few lines above).
      if (tryClaimRestaurant(store, i, structures, idOf, allowedCheck)) continue;

      // Driving a built truck is checked before manual harvesting -- one haul cycle moves far
      // more scrap than one citizen picking at a node by hand, so an idle truck should win the
      // idle-citizen's attention. With resource nodes almost always available, checking this
      // after harvesting meant no citizen ever reached it in testing -- a real bug, not a
      // priority nuance.
      const vehicle = isWorkDisabledFor(store, i, WorkCategory.Hauling) ? null : findUndrivenVehicle(world.vehicles, store.x[i], store.y[i], allowedCheck);
      const node = isWorkDisabledFor(store, i, WorkCategory.Harvesting) ? null : findNearestNode(resourceNodes, store.x[i], store.y[i], allowedCheck);

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
      const animal = isWorkDisabledFor(store, i, WorkCategory.Animal) ? null : findNearestTameableAnimal(world.wildAnimals || [], store.x[i], store.y[i], allowedCheck);
      if (animal) {
        animal.claimedBy = idOf(i);
        store.jobState[i] = JobState.SeekingAnimal;
        store.targetX[i] = animal.x; store.targetY[i] = animal.y;
        store._jobRef[i] = animal;
        continue;
      }

      // Cleaning (RimWorld's real WorkTypeDefs.naturalPriority=200, near the very bottom of its
      // real 17-category list -- below Construction/Hauling/Harvesting, ahead of only Research):
      // lowest rung of the whole idle-fallback ladder, one further down than Taming. A mess only
      // gets swept once there's genuinely nothing else productive for an idle citizen to do.
      const messyRoom = isWorkDisabledFor(store, i, WorkCategory.Cleaning) ? null : findNearestMessyRoom(world.rooms, world.grid, store.x[i], store.y[i], allowedCheck);
      if (messyRoom) {
        const target = roomCentroid(messyRoom, world.grid);
        store.jobState[i] = JobState.SeekingClean;
        store.targetX[i] = target.x; store.targetY[i] = target.y;
        store._jobRef[i] = messyRoom;
        continue;
      }
      continue;
    }

    if (state === JobState.SeekingFood || state === JobState.SeekingBed || state === JobState.SeekingRec
      || state === JobState.SeekingBuild || state === JobState.SeekingScrap || state === JobState.SeekingVehicle
      || state === JobState.SeekingAnimal || state === JobState.SeekingClean || state === JobState.SeekingWorkshop
      || state === JobState.SeekingProgram || state === JobState.SeekingTend || state === JobState.SeekingExercise
      || state === JobState.SeekingFarm || state === JobState.SeekingRestaurant || state === JobState.SeekingHygiene) {
      const dx = store.targetX[i] - store.x[i];
      const dy = store.targetY[i] - store.y[i];
      const dist = Math.hypot(dx, dy);
      // SeekingClean targets a room centroid (rooms.js's roomCentroid), which can land on a wall
      // or furniture cell the citizen can never stand exactly on -- CLEAN_ARRIVE_DIST gives that
      // case a looser radius than every other Seeking* target's exact-tile ARRIVE_DIST.
      const arriveDist = state === JobState.SeekingClean ? CLEAN_ARRIVE_DIST : ARRIVE_DIST;
      if (dist < arriveDist) {
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
        if (state === JobState.SeekingTend) {
          const targetIdx = store._jobRef[i];
          // Re-check on arrival, same "beaten to it / patient moved on" bar as SeekingVehicle/
          // SeekingWorkshop/SeekingProgram above -- the patient can recover (or die) during the
          // walk over, or (defensively) end up claimed by someone else if state ever desyncs.
          if (targetIdx == null || !store.isAliveAt(targetIdx) || !store.isDownedAt(targetIdx)
            || store.tendClaimedBy[targetIdx] !== idOf(i)) {
            store.jobState[i] = JobState.Idle;
            continue;
          }
          store.jobState[i] = JobState.Tending;
          continue;
        }
        if (state === JobState.SeekingClean) {
          store.jobState[i] = JobState.Cleaning;
          continue;
        }
        if (state === JobState.SeekingWorkshop) {
          const station = store._jobRef[i];
          if (station.workerId !== idOf(i)) { store.jobState[i] = JobState.Idle; continue; } // beaten to it
          store.jobState[i] = JobState.Processing;
          continue;
        }
        if (state === JobState.SeekingFarm) {
          const plot = store._jobRef[i];
          if (plot.workerId !== idOf(i)) { store.jobState[i] = JobState.Idle; continue; } // beaten to it
          store.jobState[i] = JobState.Farming;
          continue;
        }
        if (state === JobState.SeekingRestaurant) {
          const station = store._jobRef[i];
          if (station.workerId !== idOf(i)) { store.jobState[i] = JobState.Idle; continue; } // beaten to it
          store.jobState[i] = JobState.Restaurant;
          continue;
        }
        if (state === JobState.SeekingProgram) {
          const site = store._jobRef[i];
          const def = PROGRAM_DEFS[site.kind];
          // Re-check on arrival, not just at claim time -- capacity/staffing can have changed
          // during the walk over (another citizen filled the last place, or the staffer clocked
          // off). Beaten to it -> back to Idle rather than occupying a phantom place.
          if (site.attendeeIds.length >= def.places || !isSiteStaffed(world, site)) {
            store.programSite[i] = null;
            store.jobState[i] = JobState.Idle;
            continue;
          }
          if (!site.attendeeIds.includes(idOf(i))) site.attendeeIds.push(idOf(i));
          store.programAttendTicks[i] = 0;
          store.jobState[i] = JobState.Attending;
          continue;
        }
        store.jobState[i] = state === JobState.SeekingFood ? JobState.Eating
          : state === JobState.SeekingBed ? JobState.Sleeping
          : state === JobState.SeekingRec ? JobState.Recreating
          : state === JobState.SeekingBuild ? JobState.Building
          : state === JobState.SeekingExercise ? JobState.Exercising
          : state === JobState.SeekingHygiene ? JobState.Bathing
          : JobState.Harvesting;
      } else {
        const speed = JOB_SPEED * (store.trait[i]?.speedMult ?? 1) * breakRateMultFor(store, i)
          * unrestRateMultFor(world) * arrivalMishapRateMultFor(world) * epidemicMoveMultFor(store, i);
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
      // Toxic-fallout hazard (weather.js, real ToxicFallout/VolcanicWinter-style rare map-wide
      // condition): 1 (no effect) unless it's currently active, same "read fresh every tick"
      // shape as roomBonus/waterBonus/ethanolMult above.
      store.hunger[i] = Math.min(1, store.hunger[i] + REFILL_RATE * roomBonus * waterBonus * ethanolMult * hazardRefillMult(world));
      if (store.hunger[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Sleeping) {
      const sleepRoom = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
      // Same role gate as Eating above: only a validated Bedroom (Bedroom zone + >=1 bed) gets
      // the enclosed-room refill bonus -- four walls around an empty Bedroom zone is not a bed.
      const roomBonus = (sleepRoom && sleepRoom.role === RoomRole.Bedroom && sleepRoom.roleValid) ? ROOM_REFILL_BONUS : 1;
      store.rest[i] = Math.min(1, store.rest[i] + REFILL_RATE * roomBonus * hazardRefillMult(world));
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
      store.social[i] = Math.min(1, store.social[i] + REFILL_RATE * roomBonus * waterBonus * (store.trait[i]?.socialGainMult ?? 1) * augmentSocialGainMultFor(store, i) * hazardRefillMult(world));
      if (store.social[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Exercising) {
      // Defensive bail, same shape as Building's destroyed-blueprint check and Processing's
      // destroyed-station check below -- a Fitness Station can be destroyed mid-use.
      const station = store._jobRef?.[i];
      if (!station || station.destroyed || station.underConstruction) { store.jobState[i] = JobState.Idle; continue; }
      const exRoom = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
      // Same role gate as Eating/Sleeping/Recreating above: the enclosed-room bonus only applies
      // to a room actually validated as a Gymnasium (Gymnasium zone + >=1 Fitness Station, see
      // rooms.js's classifyRoomRole) -- an unroofed Fitness Station still refills Exercise (the
      // buildable itself is what's required, matching "a citizen actually uses the Fitness
      // Station"), just at the baseline rate rather than the enclosed-room bonus rate.
      const roomBonus = (exRoom && exRoom.role === RoomRole.Gymnasium && exRoom.roleValid) ? ROOM_REFILL_BONUS : 1;
      store.exercise[i] = Math.min(1, store.exercise[i] + REFILL_RATE * roomBonus * hazardRefillMult(world));
      if (store.exercise[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Bathing) {
      // Defensive bail, same shape as Exercising's destroyed-station check above -- a Shower can
      // be destroyed mid-use.
      const shower = store._jobRef?.[i];
      if (!shower || shower.destroyed || shower.underConstruction) { store.jobState[i] = JobState.Idle; continue; }
      // The REAL plumbing dependency: re-checked every tick, not just at claim time -- a pump can
      // be destroyed, a segment cut, or (weather.js's Cold snap, see water.js's tickPipeFreezing)
      // a pipe can freeze solid WHILE a citizen is mid-shower. An unconnected Shower simply does
      // not refill Hygiene at all -- no partial credit, no fallback rate, matching "a Shower with
      // no water connection shouldn't work" exactly. Citizen just stands there idly using it until
      // either it refills (connected) or they give up and go back to Idle next tick (unconnected).
      if (!isWateredAt(structures, shower.x, shower.y)) { store.jobState[i] = JobState.Idle; continue; }
      // No dedicated Bathroom room role exists yet (see rooms.js's RoomRole -- Gymnasium is the
      // newest one), so this simply refills at the baseline rate every un-roled use case gets,
      // same as Eating/Sleeping/Recreating/Exercising's own un-roled fallback.
      store.hygiene[i] = Math.min(1, store.hygiene[i] + REFILL_RATE * hazardRefillMult(world));
      if (store.hygiene[i] >= SATISFIED_THRESHOLD) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Building) {
      const bp = store._jobRef?.[i];
      if (!bp || bp.destroyed || !bp.underConstruction) { store.jobState[i] = JobState.Idle; continue; }
      // needsThrottleMultFor (citizens.js): RimWorld's real StatPart_Food/StatPart_Rest
      // work-speed factors -- urgently hungry/tired citizens build measurably slower even before
      // they're miserable enough to actually go on break.
      const buildRateMult = breakRateMultFor(store, i) * unrestRateMultFor(world) * arrivalMishapRateMultFor(world)
        * (store.trait[i]?.workSpeedMult ?? 1) * ageBandFor(store.age[i]).workSpeedMult * rankWorkSpeedMultFor(store, i) * augmentWorkSpeedMultFor(store, i) * needsThrottleMultFor(store, i) * sickRateMultFor(store, i) * dependencyRateMultFor(store, i) * inspirationWorkSpeedMultFor(store, i, world?.currentTick ?? 0)
        // Deep Freeze Construction work-rate reduction (weather.js, real PA deepfreezesystem.txt).
        * coldConstructionWorkRateMult(world);
      // bp.buildWorkMult (siege.js's Structure, per-kind construction work) slows the flat
      // BUILD_RATE down for pricier buildings -- default 1 covers any pre-existing structure
      // from a save saved before this field existed.
      bp.buildProgress = Math.min(1, (bp.buildProgress || 0) + BUILD_RATE * (1 + store.skillConstruction[i]) * buildRateMult / (bp.buildWorkMult || 1));
      if (bp.buildProgress >= 1) {
        bp.underConstruction = false;
        bp.claimedBy = null;
        store.skillConstruction[i] += BUILD_SKILL_GAIN * (PASSION_GAIN_MULT[store.passionConstruction[i]] ?? 1) * ageBandFor(store.age[i]).skillGainMult;
        store.jobState[i] = JobState.Idle;
        // Mood event trigger #2 (positive, see citizens.js's addMoodEvent/MOOD_EVENT_STACK_LIMITS):
        // finishing a build is a small, stacking, decaying morale boost -- RimWorld-scaled
        // magnitude (+0.04 on this project's 0-1 mood scale) over a modest ~400-tick window.
        if (world) addMoodEvent(store, i, world.currentTick, { magnitude: 0.04, durationTicks: 400, stackKey: 'finishedBuild' });
      }
      continue;
    }

    if (state === JobState.Harvesting) {
      const node = store._jobRef?.[i];
      if (!node || node.depleted) { store.jobState[i] = JobState.Idle; continue; }
      const harvestRateMult = breakRateMultFor(store, i) * unrestRateMultFor(world) * arrivalMishapRateMultFor(world)
        * (store.trait[i]?.workSpeedMult ?? 1) * ageBandFor(store.age[i]).workSpeedMult * rankWorkSpeedMultFor(store, i) * augmentWorkSpeedMultFor(store, i) * needsThrottleMultFor(store, i) * sickRateMultFor(store, i) * dependencyRateMultFor(store, i) * inspirationWorkSpeedMultFor(store, i, world?.currentTick ?? 0);
      const take = Math.min(HARVEST_RATE * harvestRateMult, node.amount);
      node.amount -= take;
      onScrapGain?.(take);
      store.skillConstruction[i] += HARVEST_SKILL_GAIN * 0.2 * (PASSION_GAIN_MULT[store.passionConstruction[i]] ?? 1) * ageBandFor(store.age[i]).skillGainMult;
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

    if (state === JobState.Cleaning) {
      const room = store._jobRef?.[i];
      // A room can vanish out from under a Cleaning citizen if the wall layout changes mid-job
      // (detectRooms rebuilds this.rooms, see world.js) -- same defensive bail as Building's
      // destroyed-blueprint check and Harvesting's depleted-node check above.
      if (!room || !world.rooms.includes(room)) { store.jobState[i] = JobState.Idle; continue; }
      const cleanRateMult = breakRateMultFor(store, i) * unrestRateMultFor(world) * arrivalMishapRateMultFor(world) * (store.trait[i]?.workSpeedMult ?? 1) * ageBandFor(store.age[i]).workSpeedMult * rankWorkSpeedMultFor(store, i) * augmentWorkSpeedMultFor(store, i) * inspirationWorkSpeedMultFor(store, i, world?.currentTick ?? 0);
      room.mess = Math.max(0, (room.mess || 0) - CLEAN_RATE * cleanRateMult);
      if (room.mess <= 0) store.jobState[i] = JobState.Idle;
      continue;
    }

    if (state === JobState.Tending) {
      const targetIdx = store._jobRef?.[i];
      // Defensive bail, same shape as Cleaning's vanished-room check above -- the patient can
      // recover (citizens.js's tickNeedsAndMood runs BEFORE tickJobs every tick, so a health
      // crossing DOWNED_RECOVER_THRESHOLD this same tick is already reflected in isDownedAt here),
      // die, or (defensively) end up reassigned if state ever desyncs.
      if (targetIdx == null || !store.isAliveAt(targetIdx) || !store.isDownedAt(targetIdx)
        || store.tendClaimedBy[targetIdx] !== idOf(i)) {
        if (targetIdx != null && store.tendClaimedBy[targetIdx] === idOf(i)) store.tendClaimedBy[targetIdx] = -1;
        store.jobState[i] = JobState.Idle;
        continue;
      }
      // The signal citizens.js's tickNeedsAndMood reads NEXT tick to swap the passive
      // DOWNED_RECOVERY_RATE for the ~4x TEND_RECOVERY_RATE -- see that function's own doc comment
      // for the exact one-tick-lag ordering (tickNeedsAndMood always runs before tickJobs).
      store.beingTended[targetIdx] = 1;
      // Small chance-based variance on tend quality (echoing RimWorld's real medicine-quality
      // curve without an item-tier system): a rare extra nudge to the patient's health, symmetric
      // bonus/malus, layered on top of the flat rate swap above rather than replacing it.
      if (world?.rng && world.rng() < TEND_VARIANCE_CHANCE) {
        const bonus = world.rng() < 0.5 ? -TEND_VARIANCE_MAG : TEND_VARIANCE_MAG;
        // Capped against maxHealth (citizens.js's permanent-scars feature), not a hardcoded 1 --
        // a scarred citizen's ceiling is genuinely lower, and this bonus roll shouldn't be able
        // to punch through it.
        store.health[targetIdx] = Math.min(store.maxHealth[targetIdx] ?? 1, Math.max(0, store.health[targetIdx] + bonus));
      }
      continue;
    }

    if (state === JobState.Processing) {
      const station = store._jobRef?.[i];
      // Defensive bail, same shape as Building's destroyed-blueprint check and Cleaning's
      // vanished-room check above -- a station can be destroyed mid-shift, or (defensively) end
      // up staffed by someone else if state ever gets out of sync.
      if (!station || station.destroyed || station.underConstruction || station.workerId !== idOf(i)) {
        store.jobState[i] = JobState.Idle;
        continue;
      }
      // Start a fresh unit: consume the raw scrap up front (an honest "raw material committed to
      // work-in-progress" moment, mirroring how a real workshop ties up its input the instant the
      // job starts, not just when it finishes) -- if the bank's run dry since this citizen was
      // dispatched, release the station rather than idling here forever.
      if ((station._workTimer || 0) <= 0) {
        if (world.scrap < WORKSHOP_RAW_PER_UNIT) {
          station.workerId = null;
          store.jobState[i] = JobState.Idle;
          continue;
        }
        world.addScrap(-WORKSHOP_RAW_PER_UNIT, 'processing');
        station._workTimer = WORKSHOP_PROCESS_TICKS;
      }
      const processRateMult = breakRateMultFor(store, i) * unrestRateMultFor(world) * arrivalMishapRateMultFor(world)
        * (store.trait[i]?.workSpeedMult ?? 1) * ageBandFor(store.age[i]).workSpeedMult * rankWorkSpeedMultFor(store, i) * augmentWorkSpeedMultFor(store, i) * needsThrottleMultFor(store, i) * sickRateMultFor(store, i) * dependencyRateMultFor(store, i) * inspirationWorkSpeedMultFor(store, i, world?.currentTick ?? 0);
      station._workTimer -= processRateMult;
      if (station._workTimer <= 0) {
        station._workTimer = 0;
        // The real 2x raw-to-finished uplift (SheetMetal -10 -> LicensePlate -20): paid out as
        // scrap directly (see SESSION_HANDOFF.md's chosen integration -- no separate inventory/
        // hauling system exists for a distinct "Components" resource, so this is the option that
        // actually integrates with the rest of the economy instead of adding a parallel one).
        world.addScrap(WORKSHOP_PROCESSED_PER_UNIT, 'processing');
        store.skillConstruction[i] += HARVEST_SKILL_GAIN * (PASSION_GAIN_MULT[store.passionConstruction[i]] ?? 1) * ageBandFor(store.age[i]).skillGainMult;
      }
      continue;
    }

    if (state === JobState.Farming) {
      const plot = store._jobRef?.[i];
      // Defensive bail, same shape as Processing's destroyed-station check above -- a Farm Plot
      // can be destroyed mid-tend, or (defensively) end up worked by someone else if state ever
      // gets out of sync.
      if (!plot || plot.destroyed || plot.underConstruction || plot.workerId !== idOf(i)) {
        store.jobState[i] = JobState.Idle;
        continue;
      }
      // No raw-input gate here, deliberately (see tryClaimFarming's doc comment) -- tending just
      // accrues real time toward the next cycle, using Structure's generic `_workTimer` field the
      // same way 'workshop' does for its own work-in-progress countdown.
      const farmRateMult = breakRateMultFor(store, i) * unrestRateMultFor(world) * arrivalMishapRateMultFor(world)
        * (store.trait[i]?.workSpeedMult ?? 1) * ageBandFor(store.age[i]).workSpeedMult * rankWorkSpeedMultFor(store, i) * augmentWorkSpeedMultFor(store, i) * needsThrottleMultFor(store, i) * sickRateMultFor(store, i) * dependencyRateMultFor(store, i) * inspirationWorkSpeedMultFor(store, i, world?.currentTick ?? 0)
        // Deep Freeze Gardening work-rate reduction (weather.js, real PA deepfreezesystem.txt --
        // this project's Farm Plot tending is the real Gardening work type's closest equivalent).
        * coldGardeningWorkRateMult(world);
      plot._workTimer = (plot._workTimer || 0) + farmRateMult;
      if (plot._workTimer >= FARM_CYCLE_TICKS) {
        plot._workTimer = 0;
        // Paid out as scrap (see FARM_YIELD_PER_CYCLE's doc comment -- no separate Food-stockpile
        // resource exists in this codebase, same "integrate with the economy that actually exists"
        // choice the Processing job already made for its own Components output). The worker stays
        // assigned into the next cycle rather than being released -- a Farm Plot is a standing job,
        // not a one-shot claim like a blueprint or a single workshop unit.
        world.addScrap(FARM_YIELD_PER_CYCLE, 'farm');
        store.skillConstruction[i] += FARM_SKILL_GAIN * (PASSION_GAIN_MULT[store.passionConstruction[i]] ?? 1) * ageBandFor(store.age[i]).skillGainMult;
      }
      continue;
    }

    if (state === JobState.Restaurant) {
      const station = store._jobRef?.[i];
      // Defensive bail, same shape as Farming's destroyed-plot check above -- a Restaurant can be
      // destroyed mid-shift, or (defensively) end up staffed by someone else if state ever gets
      // out of sync.
      if (!station || station.destroyed || station.underConstruction || station.workerId !== idOf(i)) {
        store.jobState[i] = JobState.Idle;
        continue;
      }
      // No raw-input gate here either, deliberately -- retail income comes from "visitor traffic"
      // paying the staffed citizen directly, not from any stock this settlement has to feed in
      // (that's what distinguishes this from Processing's raw-scrap-in chain). Reuses Structure's
      // generic `_workTimer` field, same as workshop/farm_plot's own work-in-progress countdown.
      const restaurantRateMult = breakRateMultFor(store, i) * unrestRateMultFor(world) * arrivalMishapRateMultFor(world)
        * (store.trait[i]?.workSpeedMult ?? 1) * ageBandFor(store.age[i]).workSpeedMult * rankWorkSpeedMultFor(store, i) * augmentWorkSpeedMultFor(store, i) * needsThrottleMultFor(store, i) * sickRateMultFor(store, i) * dependencyRateMultFor(store, i) * inspirationWorkSpeedMultFor(store, i, world?.currentTick ?? 0);
      station._workTimer = (station._workTimer || 0) + restaurantRateMult;
      if (station._workTimer >= RESTAURANT_CYCLE_TICKS) {
        station._workTimer = 0;
        // Paid out as scrap under its own 'restaurant' finance category (world.js's addScrap) --
        // a genuinely distinct income bucket from farmScrap/processingScrap, not folded into
        // either. The worker stays assigned into the next cycle, same standing-job precedent as
        // Farm Plot -- a Restaurant isn't a one-shot claim like a blueprint or a single workshop
        // unit.
        world.addScrap(RESTAURANT_YIELD_PER_CYCLE, 'restaurant');
        store.skillConstruction[i] += RESTAURANT_SKILL_GAIN * (PASSION_GAIN_MULT[store.passionConstruction[i]] ?? 1) * ageBandFor(store.age[i]).skillGainMult;
      }
      continue;
    }

    if (state === JobState.Attending) {
      const site = store._jobRef?.[i];
      // Defensive bail, same shape as Building/Cleaning/Processing above -- a site can disappear
      // out from under an attendee if the room stops validating mid-session (wall/zone change) or
      // the staffer leaves post, same "no program runs without its staffer" bar checked at claim
      // and arrival time above, re-checked continuously here too.
      if (!site || !world.programSites || !world.programSites.includes(site) || !isSiteStaffed(world, site)) {
        if (site) {
          const idx = site.attendeeIds.indexOf(idOf(i));
          if (idx >= 0) site.attendeeIds.splice(idx, 1);
        }
        store.programSite[i] = null;
        store.jobState[i] = JobState.Idle;
        continue;
      }
      applyAttendingTick(site, store, i);
      store.programAttendTicks[i] = (store.programAttendTicks[i] || 0) + 1;
      const def = PROGRAM_DEFS[site.kind];
      if (store.programAttendTicks[i] >= def.sessionLengthTicks) {
        store.programAttendTicks[i] = 0;
        store.programSessionsDone[i] = (store.programSessionsDone[i] || 0) + 1;
        const { courseComplete, graduated } = completeSession(world, site, store, i, store.programSessionsDone[i]);
        const idx = site.attendeeIds.indexOf(idOf(i));
        if (idx >= 0) site.attendeeIds.splice(idx, 1);
        store.programSite[i] = null;
        store.jobState[i] = JobState.Idle;
        if (courseComplete) {
          store.programSessionsDone[i] = 0;
          // Staff training (programs.js's ProgramKind.GuardResponseTraining, dispatched by
          // security.js's tickStaffTraining, never through this Idle-branch's own
          // findJoinableSite path): mark the graduate on the roster so tickStaffTraining stops
          // re-dispatching them -- see that function's doc comment for why it needs its own
          // "already done" tracking distinct from a citizen's programSessionsDone counter alone.
          if (site.kind === 'guard_response_training') world.roster?.markTrainingGraduated?.(idOf(i));
          if (world?.milestoneLog) {
            const suffix = site.kind === 'wellness_counseling' ? (graduated ? ' -- graduated' : ' -- did not graduate this time')
              : site.kind === 'community_gathering' ? (graduated ? ' -- had a great time' : ' -- didn\'t go so well') : '';
            const text = `${store.name[i]} completes ${def.label}${suffix}`;
            world.milestoneLog.push({ tick: world.currentTick, text });
            if (world.milestoneLog.length > 20) world.milestoneLog.shift();
            world.onRandomEvent?.(text);
          }
        }
      }
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
