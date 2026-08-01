// Epidemic -- a proximity-spread outbreak mechanic, ported from real Prison Architect
// tropicalfever_settings.txt data. Deliberately a DIFFERENT, worse, rarer mechanic than
// sickness.js's Flu-lite debuff, not a reskin of it:
//   - sickness.js: every healthy citizen independently rolls its own onset chance every check
//     (SICKNESS_CHANCE, no citizen-to-citizen interaction at all) and self-resolves in ~1-2 days,
//     hard-capped well below anything dangerous.
//   - epidemic.js (this file): gated on population, an outbreak has to actually START from a rare
//     index case, then genuinely SPREADS citizen-to-citizen via proximity (an infected citizen
//     within EPIDEMIC_SPREAD_RADIUS tiles of a healthy one rolls transmission -- a healthy citizen
//     who never comes near an infected one never catches it, unlike sickness.js's fully
//     independent rolls), escalates through two real severity stages with real need-decay
//     multipliers and a real movement-speed penalty at the worse stage, and has a genuine
//     immunity/mitigation item economy (Medical Bed short immunity, a Vaccine action for long
//     immunity) that measurably reduces reinfection -- none of which sickness.js has.
//
// Reuses rats.js's staggered-per-entity-roll pattern (each citizen's own _epidemicOffset spreads
// EPIDEMIC_CHECK_INTERVAL-cadence rolls off the same tick) and citizens.js's existing addMoodEvent
// stacking-mood-event system, same "don't invent a parallel mood mechanic" precedent every other
// periodic system in this codebase (rats.js/anomaly.js/sickness.js) already follows.
import { addMoodEvent } from './citizens.js';
import { DAY_NIGHT_CYCLE_TICKS } from './schedule.js';
import { roomContaining, RoomRole } from './rooms.js';

export const EpidemicStage = Object.freeze({ None: 0, Early: 1, Mid: 2 });

// ---------------------------------------------------------------- population gate + outbreak gap
// Real PA tropicalfever_settings.txt: gated on population >= 50, minimum 5 in-game days between
// separate outbreaks. This project's colony defaults to 24 starting citizens (world.js) and can
// grow somewhat past that via the Refugee Wagon/wanderer-join mechanics -- an order of magnitude
// below the hundred-plus-prisoner colonies PA's own gate was tuned against, same scaling problem
// rats.js's RAT_POPULATION_THRESHOLD (real 20 -> 16) and sickness.js already solved. Scaled down
// the same way, but deliberately kept noticeably HIGHER than rats.js's threshold (16) rather than
// matching it: the task brief is explicit that this needs to read as a genuinely rarer, worse
// event than the existing periodic-roll hazards, not just another one that clears the same low
// population bar -- a colony has to actually grow well past a comfortable starting size before an
// outbreak can even begin.
export const EPIDEMIC_POPULATION_THRESHOLD = 30;
export const EPIDEMIC_MIN_GAP_TICKS = 5 * DAY_NIGHT_CYCLE_TICKS; // real PA number, verbatim

// Staggered per-citizen check cadence (rats.js/sickness.js precedent). Kept in sync by hand with
// citizens.js's CitizenStore.spawn() hardcoded '40' literal for _epidemicOffset, same documented
// convention sickness.js's SICKNESS_CHECK_INTERVAL/citizens.js's hardcoded '50' already established
// (citizens.js loads before this file in build.py's ORDER and this file already imports
// addMoodEvent from citizens.js, so importing the constant back would be circular).
export const EPIDEMIC_CHECK_INTERVAL = 40;

// Onset: only rolled for a genuine index case (no one currently infected, gate+gap satisfied).
// Deliberately far rarer than sickness.js's SICKNESS_CHANCE (0.0015/check, per citizen) -- an
// outbreak should read as a dreaded rare event, not routine background noise like a cold.
const EPIDEMIC_ONSET_CHANCE = 0.00025; // per check, per eligible (healthy, non-immune) citizen

// ---------------------------------------------------------------- proximity spread
// Real PA number: 2-tile infection radius. The exact per-time-window transmission percentage
// couldn't be re-verified in this session (the earlier round-9 research pass's raw PA archive
// extraction lived in a scratchpad temp dir that SESSION_HANDOFF.md itself flags as "may not
// survive a machine restart" -- it didn't). Tuned in its place to the same order of magnitude as
// this codebase's other real per-check probabilities (rats.js's 5-40% action rolls, sickness.js's
// 0.15% onset roll) but moderated down from the top of that range: with MULTIPLE infected citizens
// each getting their own roll against every nearby healthy citizen every check, chances compound
// fast, so this is set low enough that a single index case doesn't silently wipe a whole colony
// within a few check windows in soak testing, while still being clearly higher than sickness.js's
// onset chance -- contagion should visibly outpace an independent-roll illness once it starts.
export const EPIDEMIC_SPREAD_RADIUS = 2; // grid cells, real PA number, verbatim
const EPIDEMIC_SPREAD_CHANCE = 0.08; // per check, per infected-healthy pair within radius

// ---------------------------------------------------------------- 2-stage progression
// No real per-stage duration figure survived the lost extraction either (see the spread-chance
// caveat above) -- set to read as meaningfully longer/worse than sickness.js's ~1-day self-limiting
// course (onset/RECOVER there converges to ~1.04 days) without being so long a soak test can't
// observe both stages inside a normal run.
const EARLY_STAGE_DURATION_TICKS = Math.round(DAY_NIGHT_CYCLE_TICKS * 1.1);
const MID_STAGE_DURATION_TICKS = Math.round(DAY_NIGHT_CYCLE_TICKS * 0.9);
// Short natural immunity window granted on recovery, distinct from (and much shorter than) both
// the Medical Bed and Vaccine immunity items below -- purely to stop a just-recovered citizen from
// being re-infected on literally the next check while still standing next to other infected
// citizens, not a real PA number, just a sane "you don't get reinfected the instant you're better"
// guard.
const NATURAL_RECOVERY_IMMUNITY_TICKS = Math.round(DAY_NIGHT_CYCLE_TICKS * 0.5);

// Real need-decay multipliers (PA tropicalfever_settings.txt, exactly as given in the task brief):
// Food 1x (Early) -> 2.5x (Mid), Sleep 2x (Early) -> 5x (Mid). Consumed by citizens.js's
// tickNeedsAndMood as an extra multiplicative term on top of HUNGER_DECAY/REST_DECAY (and whatever
// trait.hungerMult/restMult is already stacked in there), the same "extra multiplier in the chain"
// shape every other per-citizen rate modifier in this codebase already uses (see
// needsThrottleMultFor/sickRateMultFor/breakRateMultFor).
const FOOD_MULT_EARLY = 1;
const FOOD_MULT_MID = 2.5;
const SLEEP_MULT_EARLY = 2;
const SLEEP_MULT_MID = 5;

// Real Mid-stage movement-speed cut (PA tropicalfever_settings.txt: 40%). Consumed by jobs.js's
// job-seeking walk speed and world.js's idle-wander speed -- see epidemicMoveMultFor below.
export const EPIDEMIC_MID_MOVE_SPEED_MULT = 0.6; // 1 - 0.4

// Mood impact (citizens.js's addMoodEvent stacking-Thought mechanic, same hookup sickness.js
// already uses): clearly worse than sickness.js's flat -0.08 once a case reaches Mid stage.
const EPIDEMIC_MOOD_MAGNITUDE_EARLY = -0.08; // same order as sickness.js's SICK_MOOD_MAGNITUDE
const EPIDEMIC_MOOD_MAGNITUDE_MID = -0.18; // clearly worse -- the "this is a real epidemic, not a cold" beat
const EPIDEMIC_MOOD_DURATION_TICKS = DAY_NIGHT_CYCLE_TICKS; // refreshed every check so it never lapses mid-illness

// ---------------------------------------------------------------- immunity items
// Medical Bed short immunity (real PA: 6 in-game hours) vs. a new Vaccine action's much longer
// immunity (real PA: 15 in-game days) -- the "quick passive protection" vs. "invest scrap for a
// real long-term shield" tradeoff the task brief asks for. schedule.js's DAY_NIGHT_CYCLE_TICKS
// represents one 24-hour in-game day, same conversion basis programs.js's MINUTES_TO_TICKS already
// establishes for real-world-unit-to-tick conversions in this codebase.
export const BED_IMMUNITY_TICKS = Math.round(DAY_NIGHT_CYCLE_TICKS * 6 / 24); // 6 real hours
export const VACCINE_IMMUNITY_TICKS = 15 * DAY_NIGHT_CYCLE_TICKS; // 15 in-game days, verbatim
export const VACCINE_COST = 6; // cheap -- same order as programs.js's PROGRAM_DEFS sessionCost figures

const BED_IMMUNITY_RADIUS = 1.2; // grid cells -- "resting in/right next to the bed", not room-wide
const BED_IMMUNITY_CHECK_INTERVAL = 20; // ~2s at 10Hz -- passive proximity refresh, cheap enough to run often

// Vaccine: an automatic passive action gated on standing inside a VALIDATED Infirmary (rooms.js's
// RoomRole.Medical, medical_bed-gated same as the room-role's own requirement) -- deliberately slow
// and low-chance (a deliberate "get vaccinated" action, not ambient like the bed's proximity
// immunity) and skipped for anyone already well-covered, so scrap isn't spent redundantly on a
// citizen who just got a bed refresh.
const VACCINE_CHECK_INTERVAL = 200; // ~20s at 10Hz
const VACCINE_CHANCE = 0.03; // per check, per eligible citizen standing in a validated Infirmary

/** Call once from SimWorld's constructor to seed initial state. */
export function initEpidemic(world) {
  world.epidemicActive = false;
  // Seeded far enough in the past that the 5-day gap doesn't block a colony's very first eligible
  // outbreak the moment it crosses the population gate.
  world._epidemicLastEndTick = -EPIDEMIC_MIN_GAP_TICKS;
}

// Named distinctly from rats.js's own same-shaped countAliveCitizens(world) helper -- this
// codebase's flat-bundle build (build.py) concatenates every src file into one global scope, so
// two same-named top-level functions in different files silently collide (the later one in
// build.py's ORDER wins, no error) -- a real bug class this project has hit before (see
// SESSION_HANDOFF.md's "systemic bug class" note). Caught via the project's own dedup sweep
// (`grep -oE "^(async function|function) [A-Za-z0-9_]+" game.bundle.js | sort | uniq -d`).
function _countAliveCitizensEpidemic(store) {
  let n = 0;
  for (let i = 0; i < store.count; i++) if (store.isAliveAt(i)) n++;
  return n;
}

function logEpidemicEvent(world, text) {
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
}

function refreshEpidemicMood(store, i, currentTick) {
  const magnitude = store.epidemicStage[i] === EpidemicStage.Mid ? EPIDEMIC_MOOD_MAGNITUDE_MID : EPIDEMIC_MOOD_MAGNITUDE_EARLY;
  addMoodEvent(store, i, currentTick, { magnitude, durationTicks: EPIDEMIC_MOOD_DURATION_TICKS, stackKey: 'epidemic' });
}

// ---------------------------------------------------------------- per-citizen rate hookups
// Consumed by citizens.js's tickNeedsAndMood -- extra multiplicative terms on HUNGER_DECAY/
// REST_DECAY, same "1 when not applicable" convention as sickRateMultFor/needsThrottleMultFor.
export function epidemicHungerMultFor(store, i) {
  const stage = store.epidemicStage[i];
  if (stage === EpidemicStage.Mid) return FOOD_MULT_MID;
  if (stage === EpidemicStage.Early) return FOOD_MULT_EARLY;
  return 1;
}
export function epidemicRestMultFor(store, i) {
  const stage = store.epidemicStage[i];
  if (stage === EpidemicStage.Mid) return SLEEP_MULT_MID;
  if (stage === EpidemicStage.Early) return SLEEP_MULT_EARLY;
  return 1;
}
// Consumed by jobs.js's job-seeking walk speed and world.js's idle-wander perCitizenMult -- only
// the worse (Mid) stage actually slows movement, matching the task brief's "Mid-stage movement
// speed cut" (Early stage has no movement penalty, same asymmetric-severity shape the real PA data
// gives Food/Sleep above).
export function epidemicMoveMultFor(store, i) {
  return store.epidemicStage[i] === EpidemicStage.Mid ? EPIDEMIC_MID_MOVE_SPEED_MULT : 1;
}

/** Staggered onset/proximity-spread roll + stage progression for infected citizens, then the
 *  Medical Bed / Vaccine immunity passes. Call once per tick from SimWorld.tick(), after
 *  tickSickness (same "cheap periodic-roll system" grouping, see world.js's call site). */
export function tickEpidemic(world) {
  if (world.epidemicActive == null) initEpidemic(world);
  const store = world.citizens;

  let infectedCount = 0;
  for (let i = 0; i < store.count; i++) {
    if (store.isAliveAt(i) && store.epidemicStage[i] !== EpidemicStage.None) infectedCount++;
  }

  const wasActive = world.epidemicActive;
  world.epidemicActive = infectedCount > 0;
  if (wasActive && !world.epidemicActive) {
    world._epidemicLastEndTick = world.currentTick;
    logEpidemicEvent(world, 'The epidemic outbreak has run its course through the settlement');
  }

  const aliveCount = _countAliveCitizensEpidemic(store);
  const gated = aliveCount >= EPIDEMIC_POPULATION_THRESHOLD;
  const gapElapsed = (world.currentTick - world._epidemicLastEndTick) >= EPIDEMIC_MIN_GAP_TICKS;

  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.isDownedAt(i)) continue; // matches sickness.js's precedent -- incapacitated citizens don't roll/progress

    const stage = store.epidemicStage[i];

    if (stage === EpidemicStage.None) {
      const onCheck = (world.currentTick + (store._epidemicOffset[i] || 0)) % EPIDEMIC_CHECK_INTERVAL === 0;
      if (!onCheck) continue;
      if (store.epidemicImmuneUntil[i] > world.currentTick) continue; // bed/vaccine/natural immunity active

      if (infectedCount === 0) {
        // Index case: only while gate + 5-day gap both hold, and no one else is already carrying it.
        if (gated && gapElapsed && world.rng() < EPIDEMIC_ONSET_CHANCE) {
          store.epidemicStage[i] = EpidemicStage.Early;
          store.epidemicStageTicks[i] = 0;
          refreshEpidemicMood(store, i, world.currentTick);
          infectedCount++;
          logEpidemicEvent(world, 'An epidemic outbreak has begun in the settlement');
        }
        continue;
      }

      // Proximity spread: roll against every currently-infected citizen within EPIDEMIC_SPREAD_RADIUS.
      // This is the real citizen-to-citizen contagion sickness.js's independent-per-citizen rolls
      // don't have -- a citizen who never gets near an infected one is never at risk here.
      for (let j = 0; j < store.count; j++) {
        if (j === i || !store.isAliveAt(j) || store.epidemicStage[j] === EpidemicStage.None) continue;
        const dx = store.x[i] - store.x[j], dy = store.y[i] - store.y[j];
        if (dx * dx + dy * dy > EPIDEMIC_SPREAD_RADIUS * EPIDEMIC_SPREAD_RADIUS) continue;
        if (world.rng() < EPIDEMIC_SPREAD_CHANCE) {
          store.epidemicStage[i] = EpidemicStage.Early;
          store.epidemicStageTicks[i] = 0;
          refreshEpidemicMood(store, i, world.currentTick);
          infectedCount++;
          break;
        }
      }
      continue;
    }

    // Already infected: progress the stage timer every tick (continuous, not staggered -- matches
    // sickness.js's own per-tick progression once a case exists).
    store.epidemicStageTicks[i]++;
    if (stage === EpidemicStage.Early && store.epidemicStageTicks[i] >= EARLY_STAGE_DURATION_TICKS) {
      store.epidemicStage[i] = EpidemicStage.Mid;
      store.epidemicStageTicks[i] = 0;
      refreshEpidemicMood(store, i, world.currentTick); // re-stamp at the new, worse magnitude
      logEpidemicEvent(world, `${store.name[i]}'s condition has worsened to the Mid stage of the epidemic`);
      continue;
    }
    if (stage === EpidemicStage.Mid && store.epidemicStageTicks[i] >= MID_STAGE_DURATION_TICKS) {
      store.epidemicStage[i] = EpidemicStage.None;
      store.epidemicStageTicks[i] = 0;
      store.epidemicImmuneUntil[i] = world.currentTick + NATURAL_RECOVERY_IMMUNITY_TICKS;
      continue;
    }
    const onCheck = (world.currentTick + (store._epidemicOffset[i] || 0)) % EPIDEMIC_CHECK_INTERVAL === 0;
    if (onCheck) refreshEpidemicMood(store, i, world.currentTick);
  }

  applyBedImmunity(world);
  applyVaccination(world);
}

// Medical Bed short immunity (real PA: 6 in-game hours): any currently-healthy, not-currently-
// infected citizen standing on/right next to an undestroyed, fully-built medical_bed structure gets
// their immunity window pushed out to at least BED_IMMUNITY_TICKS from now -- refreshed, not
// stacked, same "while near the fixture" shape citizens.js's Hydration burst-refill (isWateredAt)
// already uses for a passive-proximity bonus.
function applyBedImmunity(world) {
  if (world.currentTick % BED_IMMUNITY_CHECK_INTERVAL !== 0) return;
  const structures = world.structures;
  if (!structures || structures.length === 0) return;
  const store = world.citizens;
  const beds = structures.filter(s => s.kind === 'medical_bed' && !s.destroyed && !s.underConstruction);
  if (beds.length === 0) return;

  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.epidemicStage[i] !== EpidemicStage.None) continue; // already sick -- immunity doesn't treat an active case
    for (const s of beds) {
      const dx = store.x[i] - s.x, dy = store.y[i] - s.y;
      if (dx * dx + dy * dy <= BED_IMMUNITY_RADIUS * BED_IMMUNITY_RADIUS) {
        store.epidemicImmuneUntil[i] = Math.max(store.epidemicImmuneUntil[i], world.currentTick + BED_IMMUNITY_TICKS);
        break;
      }
    }
  }
}

// Vaccine action (task brief: "a new cheap vaccine item/action at a Medical room for longer
// immunity"): an automatic, slow, low-chance roll for any healthy citizen standing inside a
// VALIDATED Infirmary (rooms.js's RoomRole.Medical, gated the same medical_bed-count requirement
// classifyRoomRole already enforces for the room role itself) -- costs VACCINE_COST scrap and grants
// the much longer VACCINE_IMMUNITY_TICKS window. Skips anyone already covered well past the bed's
// own short window so scrap isn't spent redundantly.
function applyVaccination(world) {
  if (world.currentTick % VACCINE_CHECK_INTERVAL !== 0) return;
  if (!world.rooms || !world.grid) return;
  const store = world.citizens;

  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i) || store.isDownedAt(i)) continue;
    if (store.epidemicStage[i] !== EpidemicStage.None) continue; // vaccine is prevention, not treatment
    if (store.epidemicImmuneUntil[i] > world.currentTick + BED_IMMUNITY_TICKS) continue; // already well-covered
    if ((world.scrap || 0) < VACCINE_COST) continue;

    const room = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
    if (!room || room.role !== RoomRole.Medical || !room.roleValid) continue;
    if (world.rng() >= VACCINE_CHANCE) continue;

    world.scrap -= VACCINE_COST;
    store.epidemicImmuneUntil[i] = world.currentTick + VACCINE_IMMUNITY_TICKS;
    logEpidemicEvent(world, `${store.name[i]} received a vaccine, granting long-term epidemic immunity`);
  }
}
