// Ported/condensed from SD.Sim (CitizenStore, NeedsDecaySystem, NeedsMoodBreakTickGroup,
// SocialInteractionSystem). Struct-of-arrays store, same shape as the C# CitizenStore.
import { randomTrait } from './traits.js';
import { roomContaining } from './rooms.js';
import { randomBackstory, randomPassions } from './backstories.js';
import { isWateredAt } from './water.js';

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
// Retuned this pass toward real Prison Architect data: Food/Sleep/Recreation (the closest real
// equivalent trio) sit on a near-1:1:1 TimeToFailure ratio, vs. this project's previous
// ~1:0.6:0.4 (HUNGER:REST:SOCIAL = 0.0005:0.0003:0.0002). Moved partway toward 1:1:1 rather than
// all the way -- soak-tested via window.__debug (see SESSION_HANDOFF.md) to confirm citizens
// still reliably reach a zone before a need bottoms out; the previous session already hit and
// fixed a real ~12x-too-fast regression here, so this stays inside the low end of the requested
// 0.00045-0.0005 / 0.0004-0.0005 ranges rather than pushing to the top of them.
export const REST_DECAY = 0.00045;
const SOCIAL_DECAY = 0.0004;
const ON_DUTY_SOCIAL_FULFILLMENT = 0.6; // guards/snipers get partial social fulfillment on duty
// RimWorld's real MentalBreakThreshold default is 0.35 on the same 0-1 scale this project already
// uses (directly comparable, not a unit conversion) -- the previous 0.12 was roughly a third of
// that, meaning citizens tolerated far more misery than the source material before cracking.
// Real per-citizen range is 0.01-0.50 (RimWorld's Neurotic/calm trait spectrum); this project
// already has that spectrum via traits.js's breakThresholdOffset (+0.08/+0.12 Neurotic,
// -0.08 Steady), applied on top of this base in tickNeedsAndMood below -- so the "per-citizen
// stat" half of the ask was already cheap to get from the existing trait system rather than
// needing a whole new field.
const BREAK_MOOD_THRESHOLD = 0.35;

// ---------------------------------------------------------------- hydration (PA's Hydration need)
// Real Prison Architect data: Hydration sits on nearly the same decay profile as Food (Priority 8,
// TimeToAction 960 / TimeToFailure 1440 -- the same ballpark as Food's own numbers) but is
// satisfied almost instantly by a single action (-15 to -30 per use) rather than a slow sustained
// zone refill. Reusing water.js's existing flood-fill pipe graph (built for Food/Recreation zone
// refill bonuses and the Recycling Center) as the fixture: standing on/adjacent to a watered tile
// bursts hydration back up fast, matching "satisfied almost instantly"; walking away and it just
// resumes its slow per-tick drain like every other need. No new structure kind needed -- this is
// explicitly non-carceral, just "citizens need to drink," and it's free plumbing this codebase
// already has.
export const HYDRATION_DECAY = 0.00045; // close to HUNGER_DECAY, per the real PA ratio noted above
const HYDRATION_BURST_REFILL = 0.2; // per tick while on/adjacent to a watered tile -- ~5 ticks to fill from empty
// Mood impact: folded into the eased avgNeed average in tickNeedsAndMood below, alongside
// hunger/rest/social, rather than a separate raw additive term -- see that function's doc
// comment for why an earlier raw-additive version of this destabilized a fresh colony badly.

// ---------------------------------------------------------------- hunger spiral (malnutrition)
// RimWorld's real malnutrition ramps hungerRateFactorOffset 0.5 -> 0.6 across its severity stages
// (a mild compounding ramp, not a cliff) once a pawn has been starving for a while. Mirrored here
// as a small decay multiplier that ramps up the longer hunger stays pinned near zero, and resets
// the moment hunger recovers above the near-zero band.
const HUNGER_SPIRAL_THRESHOLD = 0.05; // "near-zero" band that starts the ramp
const HUNGER_SPIRAL_RAMP_TICKS = 600; // ticks of sustained near-zero hunger to reach the full ramp
const HUNGER_SPIRAL_MAX_MULT = 1.2; // RimWorld's 0.5->0.6 is a 20% relative increase; mirrored 1:1

// ---------------------------------------------------------------- stacking mood events (RimWorld
// "Thought" mechanic, condensed). A small per-citizen list of {magnitude, startTick,
// durationTicks, stackKey}; magnitude decays linearly to zero over its duration and every live
// event's current (decayed) magnitude is summed into mood alongside, not instead of, the existing
// need-average term above. stackKey caps how many copies of the *same* kind of event a citizen can
// be carrying at once (RimWorld's stackLimit, real range 1-5) -- once at the cap, the oldest copy
// of that key is dropped to make room for the new one rather than piling up unboundedly.
export const MOOD_EVENT_STACK_LIMITS = {
  witnessedDeath: 3,
  finishedBuild: 2,
};
const DEFAULT_MOOD_EVENT_STACK_LIMIT = 3;

// Adds a mood event to citizen i's stack, dropping the oldest same-stackKey entry first if
// already at that key's stack limit. currentTick is stamped as startTick so tickNeedsAndMood can
// linearly decay it to zero by startTick + durationTicks.
export function addMoodEvent(store, i, currentTick, { magnitude, durationTicks, stackKey }) {
  if (!store.moodEvents[i]) store.moodEvents[i] = [];
  const list = store.moodEvents[i];
  const limit = MOOD_EVENT_STACK_LIMITS[stackKey] ?? DEFAULT_MOOD_EVENT_STACK_LIMIT;
  const sameKey = [];
  for (let k = 0; k < list.length; k++) if (list[k].stackKey === stackKey) sameKey.push(k);
  if (sameKey.length >= limit) {
    // Drop the oldest (lowest startTick) same-key entry to make room.
    let oldestIdx = sameKey[0];
    for (const idx of sameKey) if (list[idx].startTick < list[oldestIdx].startTick) oldestIdx = idx;
    list.splice(oldestIdx, 1);
  }
  list.push({ magnitude, startTick: currentTick, durationTicks, stackKey });
}

// ---------------------------------------------------------------- break severity tiers
// RimWorld-style: how far below threshold mood was at the moment of the break decides its
// severity, and the break then runs for that tier's own duration (a "mean time before recovery"
// timer) rather than clearing the instant mood ticks back up 0.1 like the old flat hysteresis
// band did. Mild = short and barely slows the citizen; Extreme = long and roughly halves their
// work/travel rate. Depth bands are deliberately generous (most breaks that do trigger should
// land Mild/Moderate) since BREAK_MOOD_THRESHOLD itself already only fires deep in a bad run.
const BREAK_TIERS = [
  { name: 'mild', minDepth: 0, durationTicks: 250, rateMult: 0.75 },
  { name: 'moderate', minDepth: 0.08, durationTicks: 600, rateMult: 0.55 },
  { name: 'severe', minDepth: 0.2, durationTicks: 1200, rateMult: 0.3 },
];

function breakTierForDepth(depth) {
  let tier = BREAK_TIERS[0];
  for (const t of BREAK_TIERS) if (depth >= t.minDepth) tier = t;
  return tier;
}

// Per-tick work/travel rate multiplier for a citizen currently on break -- replaces the old flat
// ON_BREAK_RATE_MULT constant everywhere jobs.js used it. Returns 1 (no penalty) if not on break.
export function breakRateMultFor(store, i) {
  if (!store.isOnBreakAt(i)) return 1;
  return BREAK_TIERS[store.breakSeverity[i]]?.rateMult ?? BREAK_TIERS[0].rateMult;
}

// ---------------------------------------------------------------- cross-need work-speed throttle
// Mirrors RimWorld's real StatPart_Food / StatPart_Rest work-speed factors: urgently hungry x0.9,
// starving x0.7; tired x0.96, very tired x0.92, exhausted x0.8. Multiplicative with everything
// else (break severity, unrest, trait workSpeedMult) -- jobs.js's build/harvest rate calcs apply
// this alongside those, not instead of them.
const HUNGER_URGENT_THRESHOLD = 0.18; // matches jobs.js's CRITICAL_HUNGER_OVERRIDE
const HUNGER_URGENT_MULT = 0.9;
const HUNGER_STARVING_THRESHOLD = 0.05;
const HUNGER_STARVING_MULT = 0.7;
const REST_TIRED_THRESHOLD = 0.4; // matches jobs.js's SEEK_REST_THRESHOLD
const REST_TIRED_MULT = 0.96;
const REST_VERY_TIRED_THRESHOLD = 0.25;
const REST_VERY_TIRED_MULT = 0.92;
const REST_EXHAUSTED_THRESHOLD = 0.1;
const REST_EXHAUSTED_MULT = 0.8;

export function needsThrottleMultFor(store, i) {
  let mult = 1;
  const hunger = store.hunger[i];
  if (hunger < HUNGER_STARVING_THRESHOLD) mult *= HUNGER_STARVING_MULT;
  else if (hunger < HUNGER_URGENT_THRESHOLD) mult *= HUNGER_URGENT_MULT;
  const rest = store.rest[i];
  if (rest < REST_EXHAUSTED_THRESHOLD) mult *= REST_EXHAUSTED_MULT;
  else if (rest < REST_VERY_TIRED_THRESHOLD) mult *= REST_VERY_TIRED_MULT;
  else if (rest < REST_TIRED_THRESHOLD) mult *= REST_TIRED_MULT;
  return mult;
}

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
    this.hydration = new Float32Array(capacity).fill(1); // PA-style Hydration need, see HYDRATION_DECAY above
    this.mood = new Float32Array(capacity).fill(1);
    this.health = new Float32Array(capacity).fill(1);
    this.flags = new Uint8Array(capacity);
    this.alive = new Uint8Array(capacity);
    this._hungerSpiralTicks = new Float32Array(capacity); // ticks spent near-zero hunger, see HUNGER_SPIRAL_*
    this.moodEvents = new Array(capacity).fill(null); // index -> array of {magnitude, startTick, durationTicks, stackKey}, see addMoodEvent
    this.breakSeverity = new Uint8Array(capacity); // index into BREAK_TIERS, set when a break triggers
    this._breakTicksRemaining = new Float32Array(capacity); // MTB-style: break runs its own course instead of clearing on mood alone
    this.jobState = new Uint8Array(capacity); // JobState from jobs.js
    this.skillCombat = new Float32Array(capacity);
    this.skillConstruction = new Float32Array(capacity);
    this._staffCooldown = new Float32Array(capacity); // used by siege.js tickStaffCombat
    this._jobRef = {}; // used by jobs.js: index -> blueprint/resource-node object currently targeted
    this.trait = new Array(capacity).fill(null);
    this.backstory = new Array(capacity).fill(null); // see backstories.js -- childhood/adult flavor pair + skill nudge
    this.passionCombat = new Uint8Array(capacity); // Passion tier (backstories.js), biases skillCombat gain rate
    this.passionConstruction = new Uint8Array(capacity); // Passion tier, biases skillConstruction gain rate

    // Work Priorities (RimWorld Work-tab-style, see jobs.js's WorkCategory/tickJobs). All four
    // default to 0 (Uint8Array zero-init), but 0 in workPriority* means "disabled" while 0 in
    // hasWorkPriorities means "no override at all" -- those are deliberately different questions,
    // so hasWorkPriorities gates whether the workPriority* arrays are consulted. A citizen nobody
    // has ever opened the Work Priorities panel for has hasWorkPriorities[i] === 0 and jobs.js's
    // Idle branch runs its original fixed-order ladder for them, completely untouched. Only once
    // a citizen has been customized (see main.js's Work Priorities panel) does hasWorkPriorities
    // flip to 1 and these four arrays start mattering: each cell is 0 (never do this job) or a
    // 1-3 priority tier, lower number = higher priority (RimWorld's inverted-number convention).
    this.hasWorkPriorities = new Uint8Array(capacity);
    this.workPriorityConstruction = new Uint8Array(capacity); // JobState SeekingBuild/Building
    this.workPriorityProcessing = new Uint8Array(capacity); // JobState SeekingWorkshop/Processing
    this.workPriorityHauling = new Uint8Array(capacity); // JobState SeekingVehicle/Driving
    this.workPriorityHarvesting = new Uint8Array(capacity); // JobState SeekingScrap/Harvesting
    this.workPriorityAnimal = new Uint8Array(capacity); // JobState SeekingAnimal/Taming
    this.workPriorityCleaning = new Uint8Array(capacity); // JobState SeekingClean/Cleaning

    // Structured Group Programs (programs.js -- see jobs.js JobState.SeekingProgram/Attending).
    // programSite (not a typed array -- holds a live programs.js ProgramSite reference or null,
    // same non-typed-array precedent as _jobRef below) is which site citizen i is currently
    // walking to / attending; programSessionsDone counts completed sessions of the CURRENT course
    // at that site's program kind, reset to 0 once a course graduates or is abandoned (site
    // changes kind, or the citizen leaves mid-course); programAttendTicks is how far into the
    // CURRENT session citizen i is, reset every time a session completes.
    this.programSite = new Array(capacity).fill(null);
    this.programSessionsDone = new Uint8Array(capacity);
    this.programAttendTicks = new Float32Array(capacity);

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
    this.hunger[i] = 1; this.rest[i] = 1; this.social[i] = 1; this.hydration[i] = 1;
    this.mood[i] = 1; this.health[i] = 1;
    this.flags[i] = CitizenFlags.None;
    this.alive[i] = 1;
    this._hungerSpiralTicks[i] = 0;
    this.moodEvents[i] = [];
    this.breakSeverity[i] = 0;
    this._breakTicksRemaining[i] = 0;
    this.trait[i] = randomTrait(rng);
    const backstory = randomBackstory(rng);
    this.backstory[i] = backstory;
    this.skillCombat[i] = backstory.skillCombatStart ?? 0;
    this.skillConstruction[i] = backstory.skillConstructionStart ?? 0;
    const passions = randomPassions(rng, backstory);
    this.passionCombat[i] = passions.combat;
    this.passionConstruction[i] = passions.construction;
    // Equal-tier defaults so that if the Work Priorities panel ever flips hasWorkPriorities on
    // without the player touching every cell, the untouched cells tie-break in jobs.js's fixed
    // array order (Construction, Hauling, Harvesting, Animal) -- the same order the legacy ladder
    // already uses, so "just enabled overrides, changed nothing yet" reads as unchanged behavior.
    this.hasWorkPriorities[i] = 0;
    this.workPriorityConstruction[i] = 1;
    this.workPriorityProcessing[i] = 1;
    this.workPriorityHauling[i] = 1;
    this.workPriorityHarvesting[i] = 1;
    this.workPriorityAnimal[i] = 1;
    this.workPriorityCleaning[i] = 1;
    this.programSite[i] = null;
    this.programSessionsDone[i] = 0;
    this.programAttendTicks[i] = 0;
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

// ---------------------------------------------------------------- per-citizen unrest score
// Prison Architect dynamicRep.txt's per-prisoner riot-proneness, reframed genre-neutral: built
// additively from state this codebase already tracks per-citizen, mirroring the real file's
// factor list (Is Riled Up +20, Is Violent +15 (trait-based), Fighting Nearby +10, offset by
// Good Room Quality +40, Per Program Passed +5). Deliberately a SEPARATE per-citizen readout from
// world.js's colony-wide unrestLevel blend -- one citizen can carry a high score here well before
// the aggregate ever crosses a tier threshold, which is the point: it gives the player (and
// future features) something concrete to target instead of the pure aggregate. Surfaced in the
// inspector panel, see main.js.
const UNREST_SCORE_RILED_UP = 20;       // currently OnBreak -- PA's "Is Riled Up" is also a live state, not a trait
const UNREST_SCORE_VOLATILE_TRAIT = 15; // Neurotic (raised break threshold, see traits.js) is this codebase's
                                         // closest trait-based analog to PA's Violent trait -- both mean "flips
                                         // into distress more easily than average"
const UNREST_SCORE_FIGHT_NEARBY = 10;   // relationships.js's fight-event log, see hasFightNearby
const UNREST_SCORE_ROOM_QUALITY_OFFSET = 40; // scaled by the citizen's current room quality (rooms.js, 0..1)
const UNREST_SCORE_PROGRAM_OFFSET = 5;       // per skill track advanced past Novice -- this codebase's closest
                                              // analog to PA's "Per Program Passed" (see main.js's SKILL_LEVELS)
const SKILL_INVESTED_THRESHOLD = 0.15;       // matches main.js's SKILL_LEVELS Novice cutoff exactly

export function computeCitizenUnrestScore(store, i, world) {
  if (!store.isAliveAt(i)) return 0;
  let score = 0;
  const trait = store.trait[i];

  if (store.isOnBreakAt(i)) score += UNREST_SCORE_RILED_UP;
  if ((trait?.breakThresholdOffset ?? 0) > 0) score += UNREST_SCORE_VOLATILE_TRAIT;
  if (world?.relationships?.hasFightNearby?.(store.x[i], store.y[i], world.currentTick)) {
    score += UNREST_SCORE_FIGHT_NEARBY;
  }

  if (world?.rooms && world?.grid) {
    const room = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
    if (room) score -= (room.quality ?? 0) * UNREST_SCORE_ROOM_QUALITY_OFFSET;
  }

  let programsPassed = 0;
  if (store.skillConstruction[i] >= SKILL_INVESTED_THRESHOLD) programsPassed++;
  if (store.skillCombat[i] >= SKILL_INVESTED_THRESHOLD) programsPassed++;
  score -= programsPassed * UNREST_SCORE_PROGRAM_OFFSET;

  return Math.max(0, Math.min(100, score));
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

    // Hunger spiral (malnutrition, see HUNGER_SPIRAL_* doc comment above): ramps the effective
    // decay multiplier up a little the longer hunger sits pinned near zero, resets the instant
    // it recovers out of the near-zero band. Computed before the decay line below so this tick's
    // decay already reflects the current ramp.
    if (store.hunger[i] < HUNGER_SPIRAL_THRESHOLD) {
      store._hungerSpiralTicks[i] = Math.min(HUNGER_SPIRAL_RAMP_TICKS, store._hungerSpiralTicks[i] + 1);
    } else {
      store._hungerSpiralTicks[i] = 0;
    }
    const spiralMult = 1 + (HUNGER_SPIRAL_MAX_MULT - 1) * (store._hungerSpiralTicks[i] / HUNGER_SPIRAL_RAMP_TICKS);

    store.hunger[i] = Math.max(0, store.hunger[i] - HUNGER_DECAY * (trait?.hungerMult ?? 1) * spiralMult);
    store.rest[i] = Math.max(0, store.rest[i] - REST_DECAY * (trait?.restMult ?? 1));
    store.social[i] = Math.max(0, store.social[i] - SOCIAL_DECAY * (1 - staffFulfillment));

    // Hydration (see the HYDRATION_* doc comment above): slow drain like every other need, but a
    // watered tile (water.js's flood-fill pump/pipe graph -- the same plumbing Food/Recreation
    // zones already get a refill bonus from) bursts it back up fast rather than the sustained
    // per-tick zone refill the other needs use.
    if (world && isWateredAt(world.structures, store.x[i], store.y[i])) {
      store.hydration[i] = Math.min(1, store.hydration[i] + HYDRATION_BURST_REFILL);
    } else {
      store.hydration[i] = Math.max(0, store.hydration[i] - HYDRATION_DECAY);
    }

    // Hydration folds into the SAME eased need-average as hunger/rest/social, not a separate raw
    // additive nudge -- an earlier version of this added a small unbounded (hydration-0.5)*weight
    // term directly to mood every tick, same shape as the room-quality term below, but unlike a
    // room (which simply has no term at all until the citizen stands inside one) an un-plumbed
    // colony has EVERY citizen's hydration pinned at 0 for the entire early game, so that raw term
    // permanently dragged mood toward 0 tick after tick with nothing to counteract it -- caught in
    // this pass's soak test (population collapsed from 24 to 3 by tick ~9000 on a fresh Calm
    // colony with no pump built yet). Folding it into avgNeed instead means it only pulls mood
    // toward a lower *target* (proportionally diluted 1-in-4 rather than 1-in-3), which the
    // existing 0.05 easing already keeps gentle -- same bounded behavior as hunger/rest/social,
    // no separate uncapped accumulation path.
    const avgNeed = (store.hunger[i] + store.rest[i] + store.social[i] + store.hydration[i]) / 4;

    // Stacking mood events (RimWorld "Thought" mechanic, see addMoodEvent above): each live
    // event's magnitude decays linearly to zero over its duration. RimWorld recomputes mood fresh
    // from the sum of active thought offsets every time it's needed; this project's mood is
    // instead a persistent, smoothed value, so the event sum is folded into the SAME eased target
    // as avgNeed below rather than added on top of mood directly each tick -- adding it raw would
    // accumulate it tick after tick (a single -0.06 event pinned mood to 0 within ~15 ticks in
    // this pass's soak test, since the same decayed magnitude got re-added on every single tick
    // instead of only nudging where mood eases toward). Folded into the target, one active event
    // instead pulls the equilibrium mood down/up by roughly its own magnitude while live, then
    // eases back out as it decays -- bounded and consistent with how every other mood term here
    // already behaves. Expired events are pruned as they're summed.
    let eventSum = 0;
    const events = store.moodEvents[i];
    if (events && events.length) {
      for (let e = events.length - 1; e >= 0; e--) {
        const ev = events[e];
        const age = (world?.currentTick ?? 0) - ev.startTick;
        const remaining = 1 - age / ev.durationTicks;
        if (remaining <= 0) { events.splice(e, 1); continue; }
        eventSum += ev.magnitude * remaining;
      }
    }

    // Mood eases toward the current need average (plus any live mood events) rather than
    // snapping, so a single bad tick doesn't cause a break.
    store.mood[i] += (avgNeed + eventSum - store.mood[i]) * 0.05;

    // Room quality (see ROOM_MOOD_INFLUENCE doc comment above): one roomContaining lookup per
    // citizen per tick, same cost/pattern as the ROOM_REFILL_BONUS lookups already done per
    // citizen per tick in jobs.js's Eating/Sleeping/Recreating states. Pre-existing raw-add
    // pattern (not part of this pass's mood-event work) -- left as-is.
    if (world) {
      const room = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
      if (room) store.mood[i] += (room.quality - 0.5) * ROOM_MOOD_INFLUENCE;
    }

    store.mood[i] = Math.min(1, Math.max(0, store.mood[i]));

    // Per-trait offset (traits.js breakThresholdOffset, RimWorld's Neurotic-spectrum
    // MentalBreakThreshold) applied on top of whatever the base constant currently is -- read
    // fresh each tick from the trait object rather than baked into the constant, so this stays
    // correct no matter how BREAK_MOOD_THRESHOLD itself gets tuned.
    const effBreakThreshold = BREAK_MOOD_THRESHOLD + (trait?.breakThresholdOffset ?? 0);

    // Break severity tiers with MTB-style recovery (see BREAK_TIERS above): a break, once
    // triggered, counts down its own tier duration instead of clearing the instant mood recovers
    // past threshold+0.1 -- mirrors RimWorld's actual mental-break-runs-its-course behavior. A
    // citizen already on break can't be re-triggered into a new (possibly shorter) tier mid-break.
    if (store.isOnBreakAt(i)) {
      store._breakTicksRemaining[i]--;
      if (store._breakTicksRemaining[i] <= 0) {
        store.flags[i] &= ~CitizenFlags.OnBreak;
        store.breakSeverity[i] = 0;
      }
    } else if (store.mood[i] < effBreakThreshold) {
      const depth = effBreakThreshold - store.mood[i];
      const tierIdx = BREAK_TIERS.findIndex(t => t === breakTierForDepth(depth));
      store.flags[i] |= CitizenFlags.OnBreak;
      store.breakSeverity[i] = tierIdx;
      store._breakTicksRemaining[i] = BREAK_TIERS[tierIdx].durationTicks;
    }
  }
}

// Simple wander: citizens not on a job walk toward a random nearby point, matching the
// "idle wander" behavior visible in the Unity build's default scenario (no job system ported
// yet — this is deliberately simpler than SD.Sim's real Eat/Sleep job execution).
// perCitizenMult(i) -- optional, returns an extra per-citizen speed multiplier applied on top of
// `speed` (default 1 if omitted). weather.js's Heatwave outdoor-only slowdown (see
// isHeatwaveSlowdownActive/HEATWAVE_WANDER_SPEED_MULT) is the reason this exists: unlike Rain's
// flat per-weather multiplier (already baked into `speed` by world.js before this is called),
// Heatwave's real penalty only applies to citizens who are actually outdoors right now, which a
// single flat scalar for the whole population can't express -- this callback lets world.js supply
// that per-citizen variance without citizens.js needing to know anything about weather.js itself.
export function tickWander(store, grid, rng, speed = 0.04, skipIf = null, perCitizenMult = null) {
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
      const effSpeed = perCitizenMult ? speed * perCitizenMult(i) : speed;
      store.x[i] += (dx / dist) * effSpeed;
      store.y[i] += (dy / dist) * effSpeed;
    }
  }
}
