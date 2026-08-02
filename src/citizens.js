// Ported/condensed from SD.Sim (CitizenStore, NeedsDecaySystem, NeedsMoodBreakTickGroup,
// SocialInteractionSystem). Struct-of-arrays store, same shape as the C# CitizenStore.
import { randomTrait, ageBandFor } from './traits.js';
import { roomContaining, RoomRole } from './rooms.js';
import { randomBackstory, randomPassions } from './backstories.js';
import { isWateredAt } from './water.js';
import { StaffRoleKind } from './core.js';
import { epidemicHungerMultFor, epidemicRestMultFor } from './epidemic.js';
import { augmentHungerMultFor, augmentRestMultFor, augmentBreakThresholdOffsetFor } from './augments.js';
import { rollInspiration, INSPIRATION_CHECK_INTERVAL } from './inspirations.js';

export const CitizenFlags = Object.freeze({
  None: 0,
  Dead: 1 << 0,
  OnBreak: 1 << 1,
  Downed: 1 << 2, // incapacitated but alive (RimWorld-style) -- see siege.js for the transition rules
  Drafted: 1 << 3, // RimWorld-style manual control -- see draft.js for the full command system this
                    // flag gates. A drafted citizen is pulled out of jobs.js's autonomous
                    // priority state machine entirely (jobs.js checks this flag first thing in
                    // tickJobs) and only moves/fights on a direct player order.
  Lieutenant: 1 << 4, // factions.js's clique lieutenant hierarchy -- one member per ~5-8
                       // clique-mates promoted, purely a status flag (no distinct AI behavior of
                       // its own yet), surfaced in the inspector/debug the same way OnBreak/
                       // Downed/Drafted already are.
});

const DOWNED_RECOVERY_RATE = 0.0015; // per tick, passive -- no dedicated first-aid job yet
// The near-zero health floor every Downed-transition site clamps to (siege.js's contact damage/
// nuclear hazard/held-citizen escalation all use this exact 0.05 literal) -- named here so
// tickNeedsAndMood's own defensive re-floor (see its doc comment, guarding against weather.js's
// lightning strike being the one site that doesn't apply it) references the same value by name
// instead of a second magic-number copy.
const DOWNED_MIN_HEALTH = 0.05;
// Exported so coverageplans.js's Medical Response Plan call-in can stabilize a downed citizen to
// exactly the same "no longer incapacitated" bar this file already uses, rather than duplicating
// the number.
export const DOWNED_RECOVER_THRESHOLD = 0.3;
// First-aid tending (jobs.js's JobState.SeekingTend/Tending): a citizen with construction or
// combat skill invested can walk to and actively tend a Downed ally, swapping the passive rate
// above for this one -- real RimWorld tending gives roughly a 4x recovery-speed bonus over
// untended healing, mirrored here as a flat 4x (0.0015 * 4 = 0.006). store.beingTended (set by
// jobs.js's Tending job tick, read-then-cleared here every tick -- see the doc comment at its use
// below) is the single signal this file needs; it doesn't need to know jobs.js's JobState values.
// NOTE: this is no longer just a speed bonus -- see UNTENDED_BLEED_RATE below. An untended Downed
// citizen now slowly loses health instead of passively recovering, so this recovery rate (and
// whether a tender reaches them at all) is now the actual difference between surviving and dying.
const TEND_RECOVERY_RATE = 0.006;
// Infirmary bonus (rooms.js RoomRole.Medical, PA full prefab/object catalog): a tended citizen
// recovers faster while inside a validated Medical room (a Medical zone + at least 1 Medical Bed,
// see rooms.js's classifyRoomRole) -- RimWorld's real hospital-bed medical-tend-quality bonus is
// the closest real analog, mirrored here as a flat 2x on top of the active-tend rate (only
// stacks with an actual tender present; an untended Downed citizen gets no bonus from merely
// lying in the room, matching "Medical" being about treatment quality, not passive rest).
const MEDICAL_ROOM_TEND_MULT = 2;

// ---------------------------------------------------------------- untended bleed-out (RimWorld's
// real bleedRate-on-untended-wounds pattern). Previously an untended Downed citizen only ever
// recovered -- just slower than a tended one (DOWNED_RECOVERY_RATE vs TEND_RECOVERY_RATE above) --
// so there was no real stakes to leaving someone down; tending only sped up an outcome that was
// already guaranteed. UNTENDED_BLEED_RATE replaces that passive recovery with a slow health LOSS
// instead whenever nobody is actively tending, so tending now decides survival, not just speed.
// Deliberately tiny: a citizen goes Downed at health ~0.05 (every Downed-transition site in
// siege.js/weather.js clamps to that same near-zero floor), so this has to leave a real, multi-
// minute window before bleeding out, not a death sentence in a few seconds --
// 0.05 / UNTENDED_BLEED_RATE = 5000 ticks (~500s at this project's 10Hz tick rate) from a
// fresh downing to death with zero tending at all, "usually survivable if help arrives reasonably
// soon" per the design brief, genuinely fatal only after a long, sustained neglect. Chosen
// deliberately conservative (err slow, not fast) given SESSION_HANDOFF.md's own caution that this
// codebase's Downed/tending interactions have produced an unexplained balance regression before
// (the reverted Hygiene ambient-floor pass) -- this is also a NEW `alive[i] = 0` site (a fourth,
// alongside siege.js's three combat/hazard ones), worth remembering the next time survival-time is
// traced across a soak.
const UNTENDED_BLEED_RATE = 0.00001;

// ---------------------------------------------------------------- wound infection (RimWorld's real
// untended-wound infection risk). A SEPARATE, distinctly-named mechanic from sickness.js's
// sickSeverity (a generic illness any living citizen can roll) and epidemic.js's epidemicStage (a
// proximity-spread contagion) -- this one only ever exists on a currently-Downed citizen, tracks
// via its own severity scalar (woundInfectionSeverity, 0 = none, >0 = infected, same shape as
// sickSeverity), and clears the moment they recover (v1 scope -- no lingering post-recovery illness
// modeled, that would mean overlapping with sickness.js's own separate disease pipeline). Tending
// materially cuts BOTH the onset chance and reverses the ongoing severity climb (a citizen actively
// being fought for doesn't just recover HP faster, their infection risk profile flips direction
// entirely), giving TEND_RECOVERY_RATE's existing recovery-speed bonus a second, independent reason
// to matter.
const WOUND_INFECTION_CHANCE_PER_TICK = 0.00003; // per tick, while Downed + untended + not yet infected
const WOUND_INFECTION_START_SEVERITY = 0.15;
const WOUND_INFECTION_PROGRESS_RATE = 0.00004;   // per tick, severity climb while untended
const WOUND_INFECTION_RECOVER_RATE = 0.0002;     // per tick, severity decline while actively tended -- ~5x
                                                  // the untended climb rate, so tending clearly wins
const WOUND_INFECTION_MAX_SEVERITY = 1;
// Extra per-tick health loss = current severity * this rate, layered on top of UNTENDED_BLEED_RATE
// above (not a replacement for it) -- applies regardless of tended status this exact tick, only the
// severity trajectory (growing vs receding) depends on that. At the small starting severity
// (0.15) this is barely perceptible (an infection just starting doesn't kill fast); only after a
// long stretch of total neglect (severity approaching WOUND_INFECTION_MAX_SEVERITY) does it become
// a meaningfully faster bleed -- an escalating cost for prolonged neglect, not a second death timer
// running in parallel from tick 1.
const WOUND_INFECTION_HEALTH_DRAIN_RATE = 0.00002;

// ---------------------------------------------------------------- permanent scars (RimWorld's real
// permanent-injury pattern, condensed to a single stacking maxHealth-ceiling reduction rather than a
// body-part/injury-type catalog this codebase doesn't model). A small chance on every recovery from
// Downed -- tended or not -- of a lasting mark: getting back up from a near-death low doesn't always
// mean healing clean. Deliberately rare and small per-instance, and floored (SCAR_MIN_MAX_HEALTH) so
// a citizen who keeps surviving close calls can't be ground down to a permanently one-hit-from-dead
// state by this alone.
const SCAR_CHANCE = 0.08; // per recovery-from-Downed event
const SCAR_MAX_HEALTH_PENALTY = 0.04; // permanent maxHealth reduction per scar
const SCAR_MIN_MAX_HEALTH = 0.6; // floor -- at 0.04/scar this takes 10 scars to reach, genuinely rare

// ---------------------------------------------------------------- skill rust (RimWorld's real
// skill-decay-from-disuse, which GreatMemory halves -- see traits.js's skillRustMult doc comment).
// citizens.js's own skillCombat/skillConstruction only ever increased before this -- tracked here as
// a slow per-tick decay once a skill hasn't gained in a long while. Detected via a snapshot-diff
// (store._skillCombatSnapshot/_skillConstructionSnapshot below) rather than requiring every skill-
// gain call site across the codebase (jobs.js's Building/Harvesting/Processing/Farming/Restaurant,
// siege.js's tickStaffCombat kill bonus, draft.js's drafted-attack bonus, programs.js's Skills
// Workshop/Guard Response Training) to explicitly reset a "last used" timer -- this file only owns
// citizens.js/jobs.js/traits.js/backstories.js, so a design requiring hooks in siege.js/draft.js/
// programs.js wasn't viable anyway. Each tick, if a skill's current value is still exactly what it
// was last tick (no gain happened anywhere), the "ticks since use" counter advances; any gain at all
// resets it to 0. Deliberately tuned conservative per the design brief ("err on the side of too
// slow") -- a multi-thousand-tick idle grace period before ANY decay starts, then a tiny per-tick
// rate: SKILL_RUST_RATE * SKILL_RUST_IDLE_TICKS-worth of continuous disuse loses far less than a
// single BUILD_SKILL_GAIN (0.02, jobs.js) regains, so this should read as a slow multi-thousand-tick
// background trend in a soak test, never a moment-to-moment swing.
const SKILL_RUST_IDLE_TICKS = 3000; // ticks of zero gain before decay starts at all
const SKILL_RUST_RATE = 0.00001;    // per tick, once past the idle grace period (see traits.js's
                                     // skillRustMult for the per-trait multiplier on this)
const SKILL_RUST_EPSILON = 1e-6;    // float-precision slack for the "did it actually gain" comparison

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

// ---------------------------------------------------------------- exercise (PA's Exercise need)
// Real Prison Architect data (needs.txt): gym equipment refills Exercise in a fast burst while
// actively used -- Treadmill/TyreApparatus at the high end (-3.0/tick), PullUpBars/PushUpStones/
// GymMat at the low end (-0.3 to -1.5/tick) -- on top of a slow ambient per-tick drain, the same
// two-speed shape this codebase already uses for every other need (a slow *_DECAY drain here vs.
// jobs.js's REFILL_RATE fast active-use refill). Consolidated into ONE new buildable for v1 (the
// Fitness Station, siege.js Structure kind 'fitness_station') standing in for PA's whole ~10-object
// gym-equipment catalog, matching the same real-object-consolidation precedent every other
// buildable in this codebase already follows. No trait multiplier applied here (deliberately
// matching HYDRATION_DECAY just above -- the most recent need added, and also unmultiplied), and
// the decay rate itself is pinned to the same order of magnitude as HUNGER_DECAY/REST_DECAY per
// the "don't over-tune, match existing needs' proportions" brief rather than being independently
// tuned against PA's raw per-use numbers, which don't translate directly onto this project's
// per-tick decay model anyway.
export const EXERCISE_DECAY = 0.00045; // same order of magnitude as HUNGER_DECAY/REST_DECAY/HYDRATION_DECAY

// ---------------------------------------------------------------- hygiene (RimWorld QoL-mod-style need)
// A citizen needs to bathe periodically using a water-connected fixture, same "genre-neutral
// plumbing dependency" precedent water.js already established for Hydration/the Food-Recreation
// zone refill bonus/the Recycling Center throughput bonus. Decay pinned to the SAME order of
// magnitude as this codebase's other slow-decaying needs (Rest/Hydration/Exercise all sit at
// 0.00045, Hunger at 0.0005) rather than inventing a new curve -- this is deliberately the least
// original number in this whole feature, matched proportionally on purpose per the task brief.
// Refill is entirely job-driven (jobs.js's SeekingHygiene/Bathing states, walking a citizen to the
// new Shower buildable), same active-use shape as Exercise's Fitness Station rather than
// Hydration's passive isWateredAt burst -- a shower is something you have to actually go use, not
// ambient plumbing you happen to be standing near. The plumbing dependency is real and load-bearing
// here in a way Hydration's is not: Hydration refills from ANY watered tile just by standing on it,
// but a Shower only refills Hygiene if that specific Shower structure is itself connected to the
// water grid (see jobs.js's findNearestShower / the Bathing job's isWateredAt gate) -- an
// unconnected Shower is inert furniture, exactly the "real plumbing-dependency, not just a flat
// furniture piece" the task calls for.
export const HYGIENE_DECAY = 0.00045; // same order of magnitude as REST_DECAY/HYDRATION_DECAY/EXERCISE_DECAY
// NOTE (see SESSION_HANDOFF.md): a colony that never builds a Shower has no refill path for
// Hygiene at all (jobs.js's findNearestShower doc comment), so it's guaranteed to hit a hard 0 in
// a hands-off soak (confirmed: avgHygiene=0.00 by tick 2500, seed 42) and drive OnBreak/unrest up
// with it. An ambient-floor fix (same shape as the AMMO_BASE_PRODUCTION trickle) was tried and
// REVERTED: it measurably made survival time worse (seed 42: 11584 -> 7117 ticks), most likely
// because keeping citizens off OnBreak sends more of them out into harvest/patrol zones exposed
// to attacker combat, rather than sitting safely idle -- the actual interaction wasn't confirmed
// before running out of investigation budget this pass. Left as a genuine open problem, not
// something to re-attempt the same way without first understanding the OnBreak/combat-exposure
// link.

// ---------------------------------------------------------------- low-hygiene consequence
// Real, measurable consequence distinct from the mood hit every need already contributes via the
// avgNeed average below: low hygiene raises a citizen's chance of coming down sick (see
// sickness.js's tickSickness, which reads HYGIENE_SICK_THRESHOLD/HYGIENE_SICK_CHANCE_MULT below
// directly off this citizen's current store.hygiene value) rather than inventing a parallel penalty
// system -- reuses the sickness mechanic that already exists and is already tracked/visible
// (store.sickSeverity, the sick mood event, SICK_WORK_SPEED_MULT) instead of a disconnected new one.
export const HYGIENE_SICK_THRESHOLD = 0.3; // "poor hygiene" band -- roughly matches HUNGER_SPIRAL_THRESHOLD's
                                            // own "near-empty" framing, scaled up since hygiene refills in one
                                            // shower trip rather than needing a sustained near-zero spell
export const HYGIENE_SICK_CHANCE_MULT = 3; // real, meaningful multiplier on sickness.js's base per-check
                                            // onset chance -- not a token nudge

// ---------------------------------------------------------------- joy (RimWorld's real Joy need)
// Previously this codebase's "Social" need (SOCIAL_DECAY above, refilled at a Recreation zone) was
// already standing in for both RimWorld's real Recreation-activity Joy need AND its separate
// person-to-person Social need at once -- this pass gives Joy its own real, independently-tracked
// value rather than continuing to fold it into Social. A clean job-target already exists for it
// (jobs.js's Recreation zone / SeekingRec-Recreating states, the exact "Joy->Recreation if it
// exists" case this task called for) -- deliberately reuses that existing state pair wholesale
// (no new JobState added, see jobs.js's Recreating handler) rather than standing up a fully
// parallel SeekingJoy/Joying pipeline: Social and Joy already share the identical real-world
// destination (a Recreation zone), so a single visit refills both together, same as how a Dining
// Room visit already refills only Hunger even though a citizen could in principle socialize there
// too -- not every need gets its own dedicated trip. Same decay magnitude as SOCIAL_DECAY (they
// share a target, so there's no reason for one to run out faster than the other), but deliberately
// NOT given ON_DUTY_SOCIAL_FULFILLMENT's on-duty discount -- working a post is a real substitute
// for casual conversation (Social's own reasoning), but it isn't recreation, so an on-duty
// guard/sniper's Joy still drains normally.
export const JOY_DECAY = 0.0004; // matches SOCIAL_DECAY exactly -- shared target, shared pace

// ---------------------------------------------------------------- comfort & beauty (RimWorld's
// real Comfort and Beauty needs/stats). Previously both were folded into one blunt, unlabeled
// room-quality mood nudge (see the old ROOM_MOOD_INFLUENCE raw-additive term this section
// replaces) rather than being real, separately-tracked needs the way Hunger/Rest/Social/etc. are.
// Neither has a clean job-target the way Joy does above (there's no "go stand somewhere beautiful"
// job, and shouldn't be one invented for this) -- both are genuinely AMBIENT: how comfortable/
// attractive a citizen's CURRENT surroundings happen to be, read passively off whatever room
// they're already standing in (or not) each tick, never a reason to travel anywhere on their own.
// Derived from rooms.js's already-computed per-room stats (computeRoomStats, called once per tick
// by world.js) rather than inventing a second scoring system:
//   - Comfort <- the average of that room's .cleanliness and .impressiveness (both already 0..1,
//     no rescale needed) -- "is this space clean and well-appointed", RimWorld's real Comfort stat
//     being furniture-quality-driven is the closest real analog this codebase's data supports.
//   - Beauty <- that room's own .beauty stat, which is a raw unbounded per-furniture sum (see
//     rooms.js's BEAUTY_BY_KIND/BEAUTY_LABELS, roughly -6..+100 across its named tiers), rescaled
//     onto this need's 0..1 scale by beautyNeedTarget() below.
// A citizen standing outside any room (or before rooms.js has run at all) eases toward 0.5 -- the
// same "neutral, not punished" baseline the OLD ROOM_MOOD_INFLUENCE term already used ("0.5 is the
// neutral 'no room / average room' baseline", see that constant's own doc comment) -- deliberately
// NOT 0, which would repeat the exact "un-plumbed Hydration pinned at 0 forever, dragging a
// hands-off colony's mood down permanently" failure mode this file's own HYDRATION_BURST_REFILL
// doc comment already describes and warns against. Both ease toward their current target at
// COMFORT_BEAUTY_EASE_RATE per tick (gentle, "slow trend over many ticks" -- same design goal the
// old ROOM_MOOD_INFLUENCE term itself stated) rather than snapping, so walking through one ugly
// room for a moment doesn't instantly tank a citizen's Beauty need.
const COMFORT_BEAUTY_EASE_RATE = 0.01;
const COMFORT_BEAUTY_NEUTRAL = 0.5; // outdoors / no room / rooms.js hasn't run yet
// Anchors Beauty's raw rooms.js scale onto this need's 0..1 scale: 0 (rooms.js's own "neutral"
// label cutoff, see BEAUTY_LABELS) maps to this need's 0.5 neutral point, +/- BEAUTY_NEED_SPAN maps
// to the 0/1 extremes -- wide enough that a single so-so item doesn't saturate this instantly, but
// narrow enough that an actually "beautiful"-labeled room (rooms.js's own +5.0 threshold) reads as
// genuinely close to fully satisfied rather than barely nudged.
const BEAUTY_NEED_SPAN = 6;
function beautyNeedTarget(roomBeauty) {
  return Math.max(0, Math.min(1, COMFORT_BEAUTY_NEUTRAL + roomBeauty / (BEAUTY_NEED_SPAN * 2)));
}
function comfortNeedTarget(room) {
  return (room.cleanliness + room.impressiveness) / 2;
}

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
  // Community Gathering (programs.js's ProgramKind.CommunityGathering, RimWorld Ideology's real
  // Party/Festival Thought): a one-time completion event, same low stack cap as finishedBuild --
  // a citizen shouldn't be able to carry more than a couple live "just had a gathering" (or "that
  // gathering was a letdown") thoughts at once.
  communityGathering: 2,
  // Aurora weather (weather.js's tickAuroraMoodBoost, real RimWorld Aurora thought): capped at 1
  // -- the event is refreshed on a short interval for as long as Aurora weather holds (see that
  // function's own comment), so there should only ever be one live copy at a time, not a pile of
  // near-duplicate refreshes compounding the magnitude.
  aurora: 1,
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
//
// Distinct per-tier BEHAVIOR (not just a rate multiplier), added this pass -- see
// SESSION_HANDOFF.md's "balance regression, part 2" section first, this is directly downstream of
// its caution: an earlier attempt to keep citizens off OnBreak entirely (an ambient Hygiene floor)
// was tried and REVERTED because it measurably made survival worse, best-guess reason being that
// OnBreak citizens sitting relatively idle/slowed are, if anything, an ACCIDENTAL survival
// mechanic -- they spend less time in exposed harvest/patrol/vehicle zones than a fully healthy
// colony would. Every behavior below was chosen to preserve or strengthen that accidental safety,
// never to work against it:
//   - mild: unchanged from before this pass -- purely the rateMult work/travel penalty below, via
//     breakRateMultFor. No new behavior, no new exposure change either way.
//   - moderate: self-isolation (see jobs.js's isModerateBreakAt gate in the Idle branch) -- a
//     citizen refuses new work orders (Construction/Processing/Hauling/Harvesting/Animal/Cleaning/
//     Farming/Restaurant) for the tier's bounded duration and instead heads to the nearest Bedroom
//     zone (this codebase's closest analog to "their own room" -- no per-citizen assigned-room
//     concept exists to reuse instead) and sits there, reusing the existing SeekingBed/Sleeping
//     states wholesale rather than inventing new travel/arrival machinery. This is STRICTLY safer
//     than today's behavior, not just neutral: today a moderate-depth break still lets a citizen
//     wander into Harvesting/Hauling/Cleaning at a reduced (0.55x) rate; this pass pulls them off
//     that work entirely and points them at an indoor zone instead. Needs-seeking (Food/Bed/Social/
//     Exercise/Hygiene/Tend) is deliberately left untouched -- the task asked for refusing WORK,
//     not refusing self-care, and gating needs too would risk a citizen starving mid-break for no
//     mechanical benefit.
//   - severe: reuses factions.js's applyUnmetConsequence 'Wrecking' shape (a single, bounded,
//     one-time property-damage event -- a fraction of health off ONE random non-defensive
//     structure) rather than inventing new violence, see the SEVERE_BREAK_DAMAGE_FRACTION doc
//     comment below for exactly why this is the safe end of that pattern, not the Scrapping
//     (mood/OnBreak) or Slipping Off (job-abandon) branches. Deliberately involves ZERO citizen
//     movement -- fires once, instantly, at the exact moment the break triggers, the citizen's own
//     position/job never changes because of it. This is the one place this pass could have
//     introduced a new death/exposure vector (SESSION_HANDOFF.md's explicit warning) and
//     deliberately doesn't: no new travel, no new zone, nothing that puts a citizen anywhere they
//     wouldn't otherwise already be.
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

// Exported so jobs.js's Idle-branch self-isolation gate can check "is this citizen's CURRENT
// break the moderate tier" by name rather than hardcoding BREAK_TIERS' array index (1) a second
// time in a different file -- same "predicate helper, not a raw index" precedent isOnBreakAt/
// isDraftedAt/isVestedAt already set on CitizenStore itself.
export function isModerateBreakAt(store, i) {
  return store.isOnBreakAt(i) && BREAK_TIERS[store.breakSeverity[i]]?.name === 'moderate';
}

// ---------------------------------------------------------------- severe break: bounded property
// damage (see BREAK_TIERS' 'severe' doc comment above for why this specific consequence, not a
// self-isolation/movement change, was chosen). Deliberately a SMALLER fraction than factions.js's
// own STRUCTURE_DAMAGE_FRACTION (0.25, the Wrecking clique-misbehavior consequence this mirrors):
// that mechanic is gated behind a whole clique's demand-timer expiring (rare, colony-scoped), while
// a severe INDIVIDUAL break can in principle trigger independently for many citizens during exactly
// the kind of colony-wide mood/unrest death-spiral SESSION_HANDOFF.md's balance-regression notes
// already flag as this project's most fragile scenario -- deliberately erring toward a smaller
// per-event magnitude rather than assuming the two are equally rare. Turret/wall excluded, same
// reasoning factions.js's Wrecking branch already gives: the colony's actual defense shouldn't get
// casually sabotaged by an individual's mental break. Fires ONCE per break-trigger event (i.e. the
// instant a citizen's mood crosses into severe-tier territory), never repeatedly over the break's
// 1200-tick duration -- a discrete event, not a per-tick drain, matching the same "one-shot, not a
// compounding rate" shape as the rats.js STEAL_MIN/MAX lesson this session's handoff already
// documents (an accidentally-repeating small drain was the actual root cause of the earlier
// balance regression). NOT implemented as a re-import of factions.js's own applyUnmetConsequence --
// citizens.js loads before factions.js in build.py's ORDER and factions.js already imports
// CitizenFlags from citizens.js, so importing back would be circular; this is a self-contained
// mirror of the same pattern instead, matching this file's existing "keep the two values in sync
// by hand" precedent for other cross-file constants (see _sickOffset/_epidemicOffset above).
const SEVERE_BREAK_DAMAGE_FRACTION = 0.08;

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

// Room quality -> mood: PREVIOUSLY a single blunt raw-additive term reading rooms.js's combined
// .quality score directly (0.5 neutral baseline, signed nudge above/below it). REMOVED this pass
// and replaced by the real, separately-tracked Comfort and Beauty needs above (COMFORT_BEAUTY_*,
// comfortNeedTarget/beautyNeedTarget) -- those now fold into avgNeed in tickNeedsAndMood below the
// same way Hunger/Rest/Social/etc. already do, which supersedes this term entirely rather than
// stacking a second room-derived mood influence on top of it (double-counting the same
// cleanliness/impressiveness/beauty data through two different mood pathways would make Comfort/
// Beauty's real magnitude impossible to reason about in a soak test). This doc comment is kept as
// a pointer for anyone who remembers the old constant name.

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
    // Age (RimWorld Biotech LifeStageDef-style, see traits.js's AGE_BANDS): ticks-since-spawn,
    // NOT wall-clock/real age -- a starting citizen gets a randomized starting age (spawn() below)
    // so the colony isn't uniformly "born at tick 0", then increments by 1 every tick for every
    // alive citizen (tickNeedsAndMood below, same per-tick loop everything else in this file
    // already walks) regardless of downed/on-break state -- aging is passive and doesn't pause for
    // an incapacitated citizen, same convention as DOWNED_RECOVERY_RATE's passive recovery above.
    this.age = new Float32Array(capacity);
    this.hunger = new Float32Array(capacity).fill(1);
    this.rest = new Float32Array(capacity).fill(1);
    this.social = new Float32Array(capacity).fill(1);
    this.hydration = new Float32Array(capacity).fill(1); // PA-style Hydration need, see HYDRATION_DECAY above
    this.exercise = new Float32Array(capacity).fill(1); // PA-style Exercise need, see EXERCISE_DECAY above
    this.hygiene = new Float32Array(capacity).fill(1); // RimWorld QoL-mod-style Hygiene need, see HYGIENE_DECAY above
    this.joy = new Float32Array(capacity).fill(1); // RimWorld-style Joy need, see JOY_DECAY above -- shares Social's Recreation-zone target
    // Comfort/Beauty (see COMFORT_BEAUTY_* doc comment above): ambient, room-derived needs, no
    // decay constant of their own -- they ease toward whatever the citizen's current room reads
    // as (or COMFORT_BEAUTY_NEUTRAL if outside any room) every tick in tickNeedsAndMood, rather
    // than draining independently the way every *_DECAY need above does.
    this.comfort = new Float32Array(capacity).fill(1);
    this.beauty = new Float32Array(capacity).fill(1);
    this.mood = new Float32Array(capacity).fill(1);
    this.health = new Float32Array(capacity).fill(1);
    // Permanent scars (see SCAR_* doc comment above) -- health's real ceiling, normally 1 for
    // every citizen who's never been Downed. Every place health recovery is clamped upward
    // (this file's Downed-branch recovery, jobs.js's TEND_VARIANCE bonus) clamps against THIS
    // field, not a hardcoded 1, so a scar's reduced ceiling actually sticks.
    this.maxHealth = new Float32Array(capacity).fill(1);
    // Wound infection (see WOUND_INFECTION_* doc comment above) -- 0 = none, >0 = currently
    // infected, same shape as sickSeverity below but scoped only to a currently-Downed citizen.
    this.woundInfectionSeverity = new Float32Array(capacity);
    // Vest armor (siege.js's CITIZEN_VEST_ARMOR_RATING/resolveCitizenArmorRoll, economy.js
    // BUILD_COST.vest) -- 1 once a citizen has been equipped via world.buyVest, 0 (Uint8Array
    // zero-init) otherwise. Read by siege.js's tickAttackerVsCitizens every contact-damage tick;
    // read here rather than a Set so it's a plain SoA field like every other per-citizen combat
    // stat in this store (health, skillCombat, ...).
    this.hasVest = new Uint8Array(capacity);
    // Shield (EnergyShield, siege.js's tickAttackerVsCitizens/tickShieldRecharge): a separate
    // absorb-before-armor layer purchasable alongside (not instead of) Vest -- hasShield mirrors
    // hasVest's exact convention, shieldEnergy is the current absorb pool (0..CITIZEN_SHIELD_CAPACITY,
    // siege.js), shieldBrokenTicks counts down the post-break recharge lockout.
    this.hasShield = new Uint8Array(capacity);
    this.shieldEnergy = new Float32Array(capacity);
    this.shieldBrokenTicks = new Uint16Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.alive = new Uint8Array(capacity);
    // "Just became Downed" edge detector for tickNeedsAndMood's own defensive health floor (see
    // that function's justDowned doc comment) -- 1 while the citizen was Downed as of the END of
    // the last tickNeedsAndMood call, 0 otherwise.
    this._wasDownedLastTick = new Uint8Array(capacity);
    this._hungerSpiralTicks = new Float32Array(capacity); // ticks spent near-zero hunger, see HUNGER_SPIRAL_*
    // Sickness (sickness.js -- real RimWorld Flu numbers, rescaled): 0 = healthy, >0 = currently
    // sick. _sickOffset staggers the per-citizen onset-roll/mood-refresh check the same way
    // rats.js's Rat._offset staggers each rat's periodic-action roll, so SICKNESS_CHECK_INTERVAL
    // citizens don't all roll on the exact same tick. Hardcoded modulus (50) rather than importing
    // sickness.js's SICKNESS_CHECK_INTERVAL constant here -- citizens.js loads before sickness.js
    // in build.py's ORDER and sickness.js already imports addMoodEvent from this file, so importing
    // back would be circular; keep the two values in sync by hand if either ever changes.
    this.sickSeverity = new Float32Array(capacity);
    this._sickOffset = new Uint16Array(capacity);
    // Epidemic (epidemic.js -- real Prison Architect tropicalfever_settings.txt data): a
    // DIFFERENT, worse, rarer mechanic than sickness.js above -- proximity-spread contagion with
    // 2-stage severity, not an independent-per-citizen roll. epidemicStage: 0 = healthy, 1 =
    // Early, 2 = Mid (epidemic.js's EpidemicStage). epidemicStageTicks: ticks spent in the
    // CURRENT stage, drives the Early->Mid->recovered progression. epidemicImmuneUntil: a tick
    // value -- immune to new infection while world.currentTick < this (Medical Bed/Vaccine/
    // natural-recovery immunity, see epidemic.js). _epidemicOffset staggers the per-citizen
    // check the same way _sickOffset above does; hardcoded modulus (40) rather than importing
    // epidemic.js's EPIDEMIC_CHECK_INTERVAL constant here, same circularity-avoidance convention
    // _sickOffset's doc comment above already established (epidemic.js also imports addMoodEvent
    // from this file) -- keep the two values in sync by hand if either ever changes.
    this.epidemicStage = new Uint8Array(capacity);
    this.epidemicStageTicks = new Float32Array(capacity);
    this.epidemicImmuneUntil = new Float32Array(capacity);
    this._epidemicOffset = new Uint16Array(capacity);
    // Tainted-supply dependency (supplies.js -- ported from Prison Architect's real
    // contraband.lua, see that file's header comment): 0 = unaffected, >0 = currently dependent,
    // same shape as sickSeverity just above. _taintOffset staggers the per-citizen mood-refresh
    // check the same way _sickOffset does for sickness (onset itself isn't staggered -- it's
    // driven directly by supplies.js's delivery-consumption roll, not an independent per-citizen
    // timer, see that file's tickSupplyDelivery).
    this.dependencySeverity = new Float32Array(capacity);
    this._taintOffset = new Uint16Array(capacity);
    this.moodEvents = new Array(capacity).fill(null); // index -> array of {magnitude, startTick, durationTicks, stackKey}, see addMoodEvent
    this.breakSeverity = new Uint8Array(capacity); // index into BREAK_TIERS, set when a break triggers
    this._breakTicksRemaining = new Float32Array(capacity); // MTB-style: break runs its own course instead of clearing on mood alone
    this.jobState = new Uint8Array(capacity); // JobState from jobs.js
    this.skillCombat = new Float32Array(capacity);
    this.skillConstruction = new Float32Array(capacity);
    // Skill rust (see SKILL_RUST_* doc comment above): snapshot of each skill's value as of the
    // last tick's check (used to detect "did this skill gain anywhere since last tick", regardless
    // of which file did the gaining) and a running "ticks since it last gained" counter per skill.
    // Both reset together every tick in tickNeedsAndMood -- see that function's own skill-rust block.
    this._skillCombatSnapshot = new Float32Array(capacity);
    this._skillConstructionSnapshot = new Float32Array(capacity);
    this._ticksSinceCombatUse = new Float32Array(capacity);
    this._ticksSinceConstructionUse = new Float32Array(capacity);
    // Citizen Rank / Prestige (ranks.js -- RimWorld Royalty-style seniority ladder, condensed
    // non-carceral). Index into ranks.js's RANKS array, 0 = 'Settler' (starting rank, no bonus).
    // A plain Uint8Array like breakSeverity above -- 7 tiers fits comfortably, no need for a
    // wider type.
    this.citizenRank = new Uint8Array(capacity);
    // Scavenged Augments (augments.js -- purchased, not earned, distinct from citizenRank above,
    // see that file's header comment). Bitmask, one bit per augments.js AUGMENTS index -- same
    // compact convention as CitizenFlags/breakSeverity, plenty of headroom for the handful of
    // augment types this feature defines.
    this.augmentMask = new Uint8Array(capacity);
    this._staffCooldown = new Float32Array(capacity); // used by siege.js tickStaffCombat
    // Weapon warmup tracking (siege.js's staffStillWarmingUp/tickStaffCombat, GUARD_WARMUP_TICKS/
    // SNIPER_WARMUP_TICKS): _staffWarmupTarget[i] is which attacker index this citizen is currently
    // aiming at (-1 = nobody), _staffWarmup[i] is the countdown (in ticks) left before that aim
    // completes. Pre-existing gap fixed incidentally while verifying this task's own changes --
    // siege.js already read/wrote BOTH fields (added when the weapon-warmup mechanic landed, whose
    // own doc comment explicitly flagged "not added here, out of this session's scope") but neither
    // was ever allocated on CitizenStore, so ANY tick where a Guard/Sniper had a live target in
    // range crashed tickStaffCombat outright (`Cannot set properties of undefined`) -- not
    // introduced by this task's own moderate-break/severe-break/Joy/Comfort/Beauty work, but it
    // blocked soak-testing that work at all (a fresh colony starts with 2 Guards + 2 Snipers
    // already on duty, see world.js), so fixed here rather than left broken. -1 default on the
    // target field matches the "-1 = no target/claim" convention tendClaimedBy/orderAttackIndex
    // above already use; the countdown field's 0 (Int32Array zero-init) default correctly reads as
    // "not currently warming up" the first time staffStillWarmingUp ever runs for a citizen.
    this._staffWarmupTarget = new Int32Array(capacity).fill(-1);
    this._staffWarmup = new Int32Array(capacity);
    // Suppression (this session's ammo/suppression pass, see siege.js's tickSuppression/
    // suppressionAccuracyMult): 0-1, builds while a citizen is actually being hit by attacker fire
    // (siege.js's tickAttackerVsCitizens increments it directly on a landed roll against them) and
    // decays on its own during a lull (tickSuppression, called once per world tick). Read by
    // tickStaffCombat to penalize a suppressed Guard/Sniper's own return-fire accuracy -- sustained
    // incoming fire measurably makes a defender worse at shooting back, not just chip their health.
    // Every citizen carries this (not just staff) since a plain citizen getting shot at is exactly
    // as suppressed in principle -- staff are simply the only role that currently reads it back out
    // for a gameplay effect, matching the task's "(or citizen)" scope note.
    this.suppression = new Float32Array(capacity);
    // Out-of-ammo fallback flag (security.js's Armory ammo economy, see siege.js's
    // AMMO_PER_SHOT_GUARD/AMMO_PER_SHOT_SNIPER + GUARD_FALLBACK_* constants): 0 = fighting with a
    // loaded weapon at full stats, 1 = the settlement's ammo stockpile couldn't cover this
    // Guard/Sniper's last shot attempt, so tickStaffCombat downgraded them to the melee fallback
    // (short range, reduced damage/penetration, zero ammo cost) rather than disabling them
    // outright. Purely a debug/UI-readable mirror of tickStaffCombat's own per-tick decision, not
    // itself authoritative -- re-derived fresh every tick, never read as an input anywhere.
    this.outOfAmmo = new Uint8Array(capacity);
    this._jobRef = {}; // used by jobs.js: index -> blueprint/resource-node object currently targeted
    // First-aid tending (jobs.js's JobState.SeekingTend/Tending, see TEND_RECOVERY_RATE above).
    // tendClaimedBy: -1 = no tender assigned, else the tender's stable id (idOf(i), NOT an index
    // -- same "id, not index" precedent as blueprint.claimedBy elsewhere) currently walking to or
    // actively tending this Downed citizen. Prevents two citizens converging on the same patient,
    // same role findNearestBlueprint's claimedBy plays for construction. beingTended: a plain
    // per-tick flag (0/1), set by jobs.js's Tending handler and read-then-cleared by
    // tickNeedsAndMood below every tick -- see that function's doc comment for the exact ordering.
    this.tendClaimedBy = new Int32Array(capacity).fill(-1);
    this.beingTended = new Uint8Array(capacity);
    this.trait = new Array(capacity).fill(null);
    this.backstory = new Array(capacity).fill(null); // see backstories.js -- childhood/adult flavor pair + skill nudge
    this.passionCombat = new Uint8Array(capacity); // Passion tier (backstories.js), biases skillCombat gain rate
    this.passionConstruction = new Uint8Array(capacity); // Passion tier, biases skillConstruction gain rate

    // Inspirations (inspirations.js -- see that file's header comment): inspiredUntilTick is a
    // tick value, same "Until" convention as epidemicImmuneUntil above -- currently inspired while
    // world.currentTick < this. _inspirationOffset staggers the per-citizen roll the same way
    // _sickOffset/_epidemicOffset above already do.
    this.inspiredUntilTick = new Float32Array(capacity);
    this._inspirationOffset = new Uint16Array(capacity);

    // Work Priorities (RimWorld Work-tab-style, see jobs.js's WorkCategory/tickJobs). All four
    // default to 0 (Uint8Array zero-init), but 0 in workPriority* means "disabled" while 0 in
    // hasWorkPriorities means "no override at all" -- those are deliberately different questions,
    // so hasWorkPriorities gates whether the workPriority* arrays are consulted. A citizen nobody
    // has ever opened the Work Priorities panel for has hasWorkPriorities[i] === 0 and jobs.js's
    // Idle branch runs its original fixed-order ladder for them, completely untouched. Only once
    // a citizen has been customized (see main.js's Work Priorities panel) does hasWorkPriorities
    // flip to 1 and these four arrays start mattering: each cell is 0 (never do this job) or a
    // 1-4 priority tier, lower number = higher priority (RimWorld's inverted-number convention --
    // matches RimWorld's real Work-tab granularity of Off/1/2/3/4, not a coarser tier scheme).
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

    // Draft/undraft order state (draft.js -- RimWorld-style manual control, see CitizenFlags.
    // Drafted above). Kept as its own small set of arrays, same SoA precedent as everything else
    // in this store, rather than a non-typed-array object per citizen -- there's exactly one
    // active order per citizen at a time, so this is cheap and matches jobState's own shape.
    // orderKind: 0 = none (drafted but idle, "stand and hold"), 1 = Move, 2 = Attack.
    this.orderKind = new Uint8Array(capacity);
    this.orderTargetX = new Float32Array(capacity);
    this.orderTargetY = new Float32Array(capacity);
    // Index into world.attackers (AttackerStore, siege.js) for an Attack order -- NOT a stable
    // id (AttackerStore has no id field, see draft.js's header comment for why this is an
    // accepted, documented simplification), -1 means "no attack order".
    this.orderAttackIndex = new Int32Array(capacity).fill(-1);

    // Force Job pending state (forcejob.js -- RimWorld-style "Prioritize", see that file's header
    // comment for the full design). forcedJobKind[i] is a ForceJobKind string ('blueprint'/'node'/
    // 'room'/'workshop') or null; _forcedJobRef (a plain object map, index -> target object, same
    // non-typed-array precedent as _jobRef above) holds the actual blueprint/node/room/station
    // reference. Deliberately separate from jobState/_jobRef (the ACTIVE job) and from
    // orderKind/orderTargetX/Y (draft.js's very different always-on manual-control orders) -- this
    // is a one-shot future instruction consumed once by jobs.js's tickJobs Idle branch, then
    // cleared, whether or not the claim actually succeeds.
    this.forcedJobKind = new Array(capacity).fill(null);
    this._forcedJobRef = {};

    // Per-citizen Schedule override (schedule.js's ScheduleOverride) -- RimWorld Schedule-tab
    // style. 0 (Uint8Array zero-init) = ScheduleOverride.None = no override, the colony-wide
    // schedule.js cycle applies exactly as before this feature existed. Only a citizen the player
    // has explicitly set an override for (see main.js's inspector control) ever reads as nonzero.
    this.scheduleOverride = new Uint8Array(capacity);

    // Per-citizen Allowed Area restriction (RimWorld Restrict-tab style). null (the Array default
    // below) = unrestricted, identical to every citizen's behavior before this feature existed.
    // Once the player paints an area for a citizen (main.js's "Restrict Area" tool, reusing
    // zones.js's per-cell paint UX pattern -- see input.js), this becomes a Uint8Array(width*height)
    // bitmask (1 = allowed cell) lazily allocated by paintAllowedAreaCell below. One mask per
    // citizen, not a shared grid -- these are expected to be painted for at most a handful of
    // citizens at once, not the whole colony, so the per-citizen memory cost is trivial.
    this.allowedAreaMask = new Array(capacity).fill(null);

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
    // Randomized starting age: 2000-24000 ticks, spanning most of the Young band (see
    // traits.js's AGE_BANDS -- Young/Veteran cutoff is 20000) with some overlap into Veteran, so a
    // freshly-spawned colony already reads as a mixed-age population rather than everyone being
    // "born" at tick 0 together.
    this.age[i] = 2000 + rng() * 22000;
    this.hunger[i] = 1; this.rest[i] = 1; this.social[i] = 1; this.hydration[i] = 1; this.exercise[i] = 1;
    this.hygiene[i] = 1;
    this.joy[i] = 1; this.comfort[i] = 1; this.beauty[i] = 1;
    this.mood[i] = 1; this.health[i] = 1;
    this.maxHealth[i] = 1; // no scars yet -- see SCAR_* doc comment above
    this.woundInfectionSeverity[i] = 0;
    this.flags[i] = CitizenFlags.None;
    this.hasVest[i] = 0;
    this.hasShield[i] = 0; this.shieldEnergy[i] = 0; this.shieldBrokenTicks[i] = 0;
    this.alive[i] = 1;
    this._wasDownedLastTick[i] = 0;
    this._hungerSpiralTicks[i] = 0;
    this.sickSeverity[i] = 0;
    this._sickOffset[i] = Math.floor(rng() * 50); // keep '50' in sync with sickness.js's SICKNESS_CHECK_INTERVAL
    this.epidemicStage[i] = 0;
    this.epidemicStageTicks[i] = 0;
    this.epidemicImmuneUntil[i] = 0;
    this._epidemicOffset[i] = Math.floor(rng() * 40); // keep '40' in sync with epidemic.js's EPIDEMIC_CHECK_INTERVAL
    this.dependencySeverity[i] = 0;
    this._taintOffset[i] = Math.floor(rng() * 300); // keep '300' in sync with supplies.js's DEPENDENCY_CHECK_INTERVAL
    this.moodEvents[i] = [];
    this.breakSeverity[i] = 0;
    this._breakTicksRemaining[i] = 0;
    this.trait[i] = randomTrait(rng);
    const backstory = randomBackstory(rng);
    this.backstory[i] = backstory;
    this.skillCombat[i] = backstory.skillCombatStart ?? 0;
    this.skillConstruction[i] = backstory.skillConstructionStart ?? 0;
    // Skill rust (see SKILL_RUST_* doc comment above): snapshot starts equal to the starting
    // skill value (no "gain" to detect until it actually moves above this), idle counters at 0.
    this._skillCombatSnapshot[i] = this.skillCombat[i];
    this._skillConstructionSnapshot[i] = this.skillConstruction[i];
    this._ticksSinceCombatUse[i] = 0;
    this._ticksSinceConstructionUse[i] = 0;
    this.citizenRank[i] = 0; // ranks.js RANKS[0] 'Settler' -- everyone starts here
    this.augmentMask[i] = 0; // augments.js -- no augments installed at spawn
    const passions = randomPassions(rng, backstory, this.trait[i]);
    this.passionCombat[i] = passions.combat;
    this.passionConstruction[i] = passions.construction;
    // Inspirations (inspirations.js) -- not inspired at spawn; offset staggers the per-citizen
    // roll check the same way _sickOffset/_epidemicOffset above do. Unlike those two (which
    // hardcode their interval's numeric value + a "keep in sync by hand" comment, since
    // sickness.js/epidemic.js import FROM citizens.js and importing back would be circular),
    // this file safely imports INSPIRATION_CHECK_INTERVAL directly -- inspirations.js has no
    // dependency on citizens.js at all, see that file's header comment.
    this.inspiredUntilTick[i] = 0;
    this._inspirationOffset[i] = Math.floor(rng() * INSPIRATION_CHECK_INTERVAL);
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
    this.orderKind[i] = 0;
    this.orderTargetX[i] = x; this.orderTargetY[i] = y;
    this.orderAttackIndex[i] = -1;
    this.forcedJobKind[i] = null;
    this._forcedJobRef[i] = null;
    this.scheduleOverride[i] = 0;
    this.allowedAreaMask[i] = null;
    this.tendClaimedBy[i] = -1;
    this.beingTended[i] = 0;
    this._staffWarmupTarget[i] = -1;
    this._staffWarmup[i] = 0;
    return i;
  }

  isAliveAt(i) {
    return this.alive[i] === 1 && (this.flags[i] & CitizenFlags.Dead) === 0;
  }

  isDownedAt(i) {
    return (this.flags[i] & CitizenFlags.Downed) !== 0;
  }

  isSickAt(i) {
    return this.sickSeverity[i] > 0;
  }

  // Epidemic (epidemic.js) -- distinct from isSickAt above. stage > 0 means Early or Mid.
  isEpidemicInfectedAt(i) {
    return this.epidemicStage[i] > 0;
  }

  isEpidemicImmuneAt(i, currentTick) {
    return this.epidemicImmuneUntil[i] > currentTick;
  }

  isDependentAt(i) {
    return this.dependencySeverity[i] > 0;
  }

  // Wound infection (see WOUND_INFECTION_* doc comment above) -- distinct from isSickAt/
  // isEpidemicInfectedAt above, only ever nonzero on a currently-Downed citizen.
  isWoundInfectedAt(i) {
    return this.woundInfectionSeverity[i] > 0;
  }

  // Inspirations (inspirations.js) -- same "Until" comparison convention as isEpidemicImmuneAt
  // above. jobs.js reads inspirationWorkSpeedMultFor(store, i, currentTick) directly rather than
  // this method for its own rate-chain multiplier, but this is the cheap glance check for
  // anything (a future UI hook, e.g.) that just needs a yes/no.
  isInspiredAt(i, currentTick) {
    return this.inspiredUntilTick[i] > currentTick;
  }

  isOnBreakAt(i) {
    return (this.flags[i] & CitizenFlags.OnBreak) !== 0;
  }

  isDraftedAt(i) {
    return (this.flags[i] & CitizenFlags.Drafted) !== 0;
  }

  // Vest armor (see hasVest field above / siege.js's resolveCitizenArmorRoll).
  isVestedAt(i) {
    return this.hasVest[i] === 1;
  }

  isShieldedAt(i) {
    return this.hasShield[i] === 1;
  }

  // Force Job pending (forcejob.js) -- true from the moment forceJob() marks a target until
  // jobs.js's tickJobs Idle branch consumes it (claim success or failure), same "cheap glance
  // check" convention as isDraftedAt/isOnBreakAt above. Used by render.js for the pending-order
  // indicator and by forcejob.js itself.
  hasForcedJobAt(i) {
    return !!this.forcedJobKind[i];
  }

  // ---- Allowed Area restriction (RimWorld Restrict-tab style) -----------------------------
  hasAllowedArea(i) {
    return this.allowedAreaMask[i] != null;
  }

  // True if (x, y) is inside citizen i's painted area, or if they have no restriction at all
  // (the default -- every citizen behaves exactly as before this feature existed unless the
  // player has explicitly painted an area for them). gridWidth is passed in rather than stored
  // on the store itself since CitizenStore has no grid reference of its own (same reason
  // paintAllowedAreaCell below takes width/height as params instead of caching them).
  isInAllowedArea(i, gridWidth, x, y) {
    const mask = this.allowedAreaMask[i];
    if (!mask) return true;
    const gx = Math.floor(x), gy = Math.floor(y);
    if (gx < 0 || gy < 0) return false;
    const idx = gy * gridWidth + gx;
    if (idx < 0 || idx >= mask.length) return false;
    return mask[idx] === 1;
  }

  // Paints (allowed=true) or erases (allowed=false) one grid cell of citizen i's restriction
  // mask, lazily allocating it on first paint -- mirrors zones.js's ZoneGrid.set, the existing
  // player-painted-area UX pattern this feature reuses (see input.js's 'restrict-area' tool).
  paintAllowedAreaCell(i, gridWidth, gridHeight, x, y, allowed) {
    if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) return;
    if (!this.allowedAreaMask[i]) this.allowedAreaMask[i] = new Uint8Array(gridWidth * gridHeight);
    this.allowedAreaMask[i][y * gridWidth + x] = allowed ? 1 : 0;
  }

  // Clears citizen i's restriction entirely -- back to "can go anywhere", the default.
  clearAllowedArea(i) {
    this.allowedAreaMask[i] = null;
  }
}

// ---------------------------------------------------------------- per-citizen unrest score
// Prison Architect dynamicRep.txt's per-prisoner riot-proneness, reframed genre-neutral: built
// additively from state this codebase already tracks per-citizen, calibrated directly against
// the REAL boilingpoint_settings.txt weight table (see SESSION_HANDOFF.md's round-9 research
// notes): Good Room Quality -40 (the single biggest protective factor in the real data), Armed
// Guard Presence +30, Is Riled Up +20, Has Withdrawal +40, Fighting Nearby +10, Is Violent +15,
// Per Program Passed -5. Deliberately a SEPARATE per-citizen readout from world.js's colony-wide
// unrestLevel blend -- one citizen can carry a high score here well before the aggregate ever
// crosses a tier threshold, which is the point: it gives the player (and future features)
// something concrete to target instead of the pure aggregate. Surfaced in the inspector panel,
// see main.js.
//
// Calibration pass (this session): the four factors this codebase already modeled (Riled Up,
// Violent, Fighting Nearby, Room Quality) already matched the real magnitudes/signs exactly --
// no change needed there. But TWO real factors were entirely unmodeled (an effective weight of 0
// vs. the real 30 and 40), which is the actual mis-proportion worth fixing: Armed Guard Presence
// and Has Withdrawal. Both are now wired to real per-citizen state this codebase already tracks
// rather than adding new fields:
//   - Armed Guard Presence: an on-duty Guard/Sniper (security.js's StaffRoster) within sight --
//     reskinned as "an armed protector working nearby is itself a tension factor", the same
//     ambient-provocation reading the real data gives it, not a judgment about the guard.
//   - Has Withdrawal: this codebase's closest analog to PA's drug-withdrawal craving is the
//     hunger spiral (citizens.js's _hungerSpiralTicks -- sustained near-zero hunger, a real
//     "crashing need" state already tracked per-citizen, see HUNGER_SPIRAL_* above).
const UNREST_SCORE_RILED_UP = 20;       // currently OnBreak -- PA's "Is Riled Up" is also a live state, not a trait
const UNREST_SCORE_VOLATILE_TRAIT = 15; // Neurotic (raised break threshold, see traits.js) is this codebase's
                                         // closest trait-based analog to PA's Violent trait -- both mean "flips
                                         // into distress more easily than average"
const UNREST_SCORE_FIGHT_NEARBY = 10;   // relationships.js's fight-event log, see hasFightNearby
const UNREST_SCORE_ROOM_QUALITY_OFFSET = 40; // scaled by the citizen's current room quality (rooms.js, 0..1) --
                                              // real PA's single LARGEST factor, matched 1:1 here already
const UNREST_SCORE_PROGRAM_OFFSET = 5;       // per skill track advanced past Novice -- this codebase's closest
                                              // analog to PA's "Per Program Passed" (see main.js's SKILL_LEVELS)
const SKILL_INVESTED_THRESHOLD = 0.15;       // matches main.js's SKILL_LEVELS Novice cutoff exactly
const UNREST_SCORE_ARMED_PRESENCE = 30; // real PA "Armed Guard Presence" weight, previously unmodeled (was 0)
const ARMED_PRESENCE_RADIUS = 4;        // grid cells -- same order of magnitude as this file's other
                                         // nearby-state checks (e.g. relationships.js's hasFightNearby radius)
const UNREST_SCORE_WITHDRAWAL = 40; // real PA "Has Withdrawal" weight, previously unmodeled (was 0) -- tied
                                     // for the single largest magnitude in the real table, alongside room quality

export function computeCitizenUnrestScore(store, i, world) {
  if (!store.isAliveAt(i)) return 0;
  let score = 0;
  const trait = store.trait[i];

  if (store.isOnBreakAt(i)) score += UNREST_SCORE_RILED_UP;
  if ((trait?.breakThresholdOffset ?? 0) > 0) score += UNREST_SCORE_VOLATILE_TRAIT;
  if (world?.relationships?.hasFightNearby?.(store.x[i], store.y[i], world.currentTick)) {
    score += UNREST_SCORE_FIGHT_NEARBY;
  }
  if ((store._hungerSpiralTicks?.[i] ?? 0) > 0) score += UNREST_SCORE_WITHDRAWAL;

  if (world?.roster?.isStaff && world?.isStaffAt) {
    for (let j = 0; j < store.count; j++) {
      if (j === i || !store.isAliveAt(j)) continue;
      if (!world.isStaffAt(j)) continue;
      const kind = world.roster.kindOf(store.id[j]);
      if (kind !== StaffRoleKind.Guard && kind !== StaffRoleKind.Sniper) continue;
      const dx = store.x[i] - store.x[j], dy = store.y[i] - store.y[j];
      if (dx * dx + dy * dy <= ARMED_PRESENCE_RADIUS * ARMED_PRESENCE_RADIUS) {
        score += UNREST_SCORE_ARMED_PRESENCE;
        break;
      }
    }
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

// Skill rust helper (see SKILL_RUST_* doc comment above) -- shared by both skillCombat and
// skillConstruction's identical snapshot-diff logic rather than duplicating the block twice.
// skillKey/snapshotKey/idleKey are CitizenStore field names (strings), so this stays a plain SoA
// read/write against store's own typed arrays, same access shape as every other per-citizen stat
// in this file. rustMult is the trait's skillRustMult (traits.js), 1 if the trait doesn't specify one.
function tickSkillRustFor(store, i, skillKey, snapshotKey, idleKey, rustMult) {
  const skill = store[skillKey], snapshot = store[snapshotKey], idle = store[idleKey];
  if (skill[i] > snapshot[i] + SKILL_RUST_EPSILON) {
    // Gained since last tick's check (from ANY source -- jobs.js/siege.js/draft.js/programs.js
    // all bump these skills independently) -- reset the disuse clock.
    idle[i] = 0;
  } else {
    idle[i]++;
    if (idle[i] > SKILL_RUST_IDLE_TICKS && skill[i] > 0) {
      skill[i] = Math.max(0, skill[i] - SKILL_RUST_RATE * rustMult);
    }
  }
  // Re-baseline the snapshot to whatever the skill is NOW (including any decay just applied
  // above) so next tick's comparison is against the current true value, not a stale pre-decay
  // one -- otherwise a real future gain could take several ticks to climb back above an inflated
  // old snapshot, masking renewed use as still-idle.
  snapshot[i] = skill[i];
}

// isStaffAt(i) -> bool, used to decide on-duty social fulfillment (guards/snipers don't
// need to be near others to stay socially fulfilled while working).
// world (optional, 5th arg) -- passed by world.js as `this` so a citizen's current room quality
// (rooms.js's roomContaining + computeRoomStats) can nudge their mood; omit it (e.g. in tests)
// and this term is simply skipped, matching the rest of this function's null-safe style.
export function tickNeedsAndMood(store, isStaffAt, rng, world) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;

    store.age[i]++;

    // "Just became Downed" edge detector (see the DOWNED_MIN_HEALTH re-floor use below) -- the
    // Downed flag itself is set directly by siege.js/weather.js/world.js, not through any
    // citizens.js function this file could hook, so this is the only way to tell "first tick of
    // being Downed" apart from "still Downed 4000 ticks later" from inside this file alone.
    const isDownedNow = store.isDownedAt(i);
    const justDowned = isDownedNow && !store._wasDownedLastTick[i];
    store._wasDownedLastTick[i] = isDownedNow ? 1 : 0;

    if (isDownedNow) {
      // Incapacitated: needs don't spiral further while down. Health recovers if actively tended,
      // or slowly BLEEDS if not (see UNTENDED_BLEED_RATE's doc comment -- this is the changed part;
      // it used to always recover, just slower when untended). store.beingTended[i] is set every
      // tick by jobs.js's Tending job handler (world.js calls tickNeedsAndMood *before* tickJobs
      // each tick, so this reads the PREVIOUS tick's tend status -- a harmless one-tick lag on a
      // per-tick-continuous system). Read it, then immediately clear it: if a tender is still
      // actively tending this same tick, jobs.js's Tending handler re-sets it before the next
      // tickNeedsAndMood call; if the tender left, it stays cleared and this falls straight back
      // to the untended bleed on the very next tick.
      // Defensive floor: every OTHER Downed-transition site (siege.js's contact damage/nuclear
      // hazard/held-citizen escalation) clamps health to a 0.05 minimum the instant it sets the
      // Downed flag, but weather.js's lightning strike doesn't (`Math.max(0, ...)`, can leave
      // health at literal 0 if the citizen was already wounded when struck) -- without this, the
      // untended-bleed logic below could read health<=0 on the very FIRST tick a citizen is
      // Downed and kill them instantly, defeating the entire "usually survivable if help arrives
      // reasonably soon" point of UNTENDED_BLEED_RATE above. Gated on justDowned (NOT applied every
      // tick) -- this is a one-time normalization at the moment of transition, not a floor that
      // would otherwise permanently block the untended bleed from ever working at all.
      if (justDowned && store.health[i] < DOWNED_MIN_HEALTH) store.health[i] = DOWNED_MIN_HEALTH;

      const tended = store.beingTended[i] === 1;
      store.beingTended[i] = 0;

      if (tended) {
        let recoveryRate = TEND_RECOVERY_RATE;
        // Infirmary bonus (see MEDICAL_ROOM_TEND_MULT doc comment above) -- only applies to an
        // actively-tended citizen who happens to be lying inside a validated Medical room.
        if (world?.rooms && world?.grid) {
          const room = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
          if (room && room.role === RoomRole.Medical && room.roleValid) recoveryRate *= MEDICAL_ROOM_TEND_MULT;
        }
        store.health[i] = Math.min(store.maxHealth[i], store.health[i] + recoveryRate);
        // Wound infection recedes under active treatment (see WOUND_INFECTION_* doc comment
        // above) -- tending beats it back down instead of just slowing its climb.
        if (store.woundInfectionSeverity[i] > 0) {
          store.woundInfectionSeverity[i] = Math.max(0, store.woundInfectionSeverity[i] - WOUND_INFECTION_RECOVER_RATE);
        }
      } else {
        // Untended bleed-out (see UNTENDED_BLEED_RATE's doc comment above): tending is now the
        // difference between recovering and dying, not just a speed bonus.
        store.health[i] = Math.max(0, store.health[i] - UNTENDED_BLEED_RATE);
        // Wound infection onset + progression (see WOUND_INFECTION_* doc comment above),
        // untended-only -- an active tender already gets the recede branch above instead.
        if (store.woundInfectionSeverity[i] > 0) {
          store.woundInfectionSeverity[i] = Math.min(WOUND_INFECTION_MAX_SEVERITY, store.woundInfectionSeverity[i] + WOUND_INFECTION_PROGRESS_RATE);
        } else if (rng() < WOUND_INFECTION_CHANCE_PER_TICK) {
          store.woundInfectionSeverity[i] = WOUND_INFECTION_START_SEVERITY;
        }
      }

      // Infection health drain (both branches -- an active infection hurts regardless of whether
      // someone's tending it THIS exact tick; only its severity trajectory, growing vs receding,
      // depends on tended status above).
      if (store.woundInfectionSeverity[i] > 0) {
        store.health[i] = Math.max(0, store.health[i] - WOUND_INFECTION_HEALTH_DRAIN_RATE * store.woundInfectionSeverity[i]);
      }

      // Death from bleed-out/infection while Downed and untended -- reuses the exact same
      // Dead-flag + alive=0 pattern siege.js's tickAttackerVsCitizens already uses for a
      // downed-then-hit coup-de-grace, just triggered from health hitting 0 via neglect instead
      // of a second attacker hit. A NEW `alive[i] = 0` site (siege.js has three combat/hazard
      // ones already) -- see UNTENDED_BLEED_RATE's doc comment above for why this is tuned
      // deliberately slow.
      if (store.health[i] <= 0) {
        store.health[i] = 0;
        store.flags[i] |= CitizenFlags.Dead;
        store.alive[i] = 0;
        store.woundInfectionSeverity[i] = 0;
        if (store.tendClaimedBy[i] !== -1) store.tendClaimedBy[i] = -1;
        if (world?.milestoneLog) {
          const text = `${store.name[i]} dies, untended and alone`;
          world.milestoneLog.push({ tick: world.currentTick, text });
          if (world.milestoneLog.length > 20) world.milestoneLog.shift();
          world.onRandomEvent?.(text);
        }
        continue;
      }

      if (store.health[i] >= DOWNED_RECOVER_THRESHOLD) {
        store.flags[i] &= ~CitizenFlags.Downed;
        store.woundInfectionSeverity[i] = 0; // clears on recovery -- v1 scope, see doc comment above
        if (store.tendClaimedBy[i] !== -1) store.tendClaimedBy[i] = -1; // recovered out from under an active tender
        // Permanent scars (see SCAR_* doc comment above): a small chance on every recovery from
        // Downed, tended or not.
        if (rng() < SCAR_CHANCE) {
          store.maxHealth[i] = Math.max(SCAR_MIN_MAX_HEALTH, store.maxHealth[i] - SCAR_MAX_HEALTH_PENALTY);
        }
      }
      continue;
    }

    const staffFulfillment = isStaffAt(i) ? ON_DUTY_SOCIAL_FULFILLMENT : 0;
    const trait = store.trait[i];

    // Skill rust (see SKILL_RUST_* doc comment above): snapshot-diff detects a gain from ANY
    // source (jobs.js/siege.js/draft.js/programs.js all bump skillCombat/skillConstruction in
    // different places) without needing a reset hook in each of those files. Applied to both
    // skills every tick, independent of the needs/mood logic below.
    tickSkillRustFor(store, i, 'skillCombat', '_skillCombatSnapshot', '_ticksSinceCombatUse', trait?.skillRustMult ?? 1);
    tickSkillRustFor(store, i, 'skillConstruction', '_skillConstructionSnapshot', '_ticksSinceConstructionUse', trait?.skillRustMult ?? 1);

    // Inspirations (inspirations.js) -- staggered per-citizen roll for a new one; a no-op most
    // ticks (see rollInspiration's own doc comment). currentTick defaults to 0 when no `world` is
    // passed (matches this function's existing `world?.currentTick ?? 0` convention used for mood
    // events below), which just means the stagger gate never advances -- an acceptable no-op
    // fallback for isolated/test call sites that don't pass a real world.
    rollInspiration(store, i, world?.currentTick ?? 0, rng);

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

    // Epidemic (epidemic.js) need-decay escalation -- real PA tropicalfever_settings.txt
    // multipliers (Food 1x->2.5x, Sleep 2x->5x across Early->Mid stage), stacked multiplicatively
    // on top of the trait/spiral multipliers already here, same "extra term in the chain" shape
    // every other per-citizen rate modifier in this file uses. Returns 1 (no-op) for a healthy
    // citizen, so this is a byte-for-byte no-op until epidemic.js actually infects someone.
    store.hunger[i] = Math.max(0, store.hunger[i] - HUNGER_DECAY * (trait?.hungerMult ?? 1) * spiralMult * epidemicHungerMultFor(store, i) * augmentHungerMultFor(store, i));
    store.rest[i] = Math.max(0, store.rest[i] - REST_DECAY * (trait?.restMult ?? 1) * epidemicRestMultFor(store, i) * augmentRestMultFor(store, i));
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

    // Exercise (see EXERCISE_DECAY doc comment above): pure ambient drain here, no passive burst
    // path like Hydration's isWateredAt check -- refill is entirely job-driven (jobs.js's
    // SeekingExercise/Exercising states, which walk a citizen to the new Fitness Station buildable
    // and refill at the same REFILL_RATE every other zone-seeking need uses), matching the
    // Hunger/Rest/Social precedent more closely than Hydration's passive-plumbing one.
    store.exercise[i] = Math.max(0, store.exercise[i] - EXERCISE_DECAY);

    // Hygiene (see HYGIENE_DECAY doc comment above): pure ambient drain here, same job-driven
    // refill shape as Exercise (jobs.js's SeekingHygiene/Bathing states walk a citizen to the new
    // Shower buildable) rather than Hydration's passive isWateredAt burst -- see HYGIENE_DECAY's
    // doc comment for why the plumbing dependency has to live on the Shower structure itself
    // rather than "any watered tile", unlike Hydration.
    store.hygiene[i] = Math.max(0, store.hygiene[i] - HYGIENE_DECAY);

    // Low-hygiene consequence (see HYGIENE_SICK_THRESHOLD/HYGIENE_SICK_CHANCE_MULT doc comment
    // above): sickness.js's tickSickness reads store.hygiene directly off this same array, so
    // nothing further is needed here beyond keeping the field itself up to date every tick.

    // Joy (see JOY_DECAY doc comment above): pure ambient drain, deliberately no staffFulfillment
    // discount (unlike Social just above) -- refill is entirely job-driven via jobs.js's existing
    // SeekingRec/Recreating states, which now refill Joy alongside Social on the same trip.
    store.joy[i] = Math.max(0, store.joy[i] - JOY_DECAY);

    // Comfort/Beauty (see COMFORT_BEAUTY_* doc comment above): ambient, room-derived, no decay of
    // their own -- each tick eases toward the current room's derived value (or the neutral
    // baseline if not currently inside any room / rooms.js hasn't run) rather than draining.
    // Computed here, BEFORE avgNeed below, so this tick's easing already feeds into this tick's
    // mood target -- same ordering precedent every other need above already follows.
    if (world?.rooms && world?.grid) {
      const room = roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
      const comfortTarget = room ? comfortNeedTarget(room) : COMFORT_BEAUTY_NEUTRAL;
      const beautyTarget = room ? beautyNeedTarget(room.beauty) : COMFORT_BEAUTY_NEUTRAL;
      store.comfort[i] += (comfortTarget - store.comfort[i]) * COMFORT_BEAUTY_EASE_RATE;
      store.beauty[i] += (beautyTarget - store.beauty[i]) * COMFORT_BEAUTY_EASE_RATE;
    } else {
      store.comfort[i] += (COMFORT_BEAUTY_NEUTRAL - store.comfort[i]) * COMFORT_BEAUTY_EASE_RATE;
      store.beauty[i] += (COMFORT_BEAUTY_NEUTRAL - store.beauty[i]) * COMFORT_BEAUTY_EASE_RATE;
    }

    // Hydration/Exercise/Hygiene/Joy/Comfort/Beauty all fold into the SAME eased need-average as
    // hunger/rest/social, not a separate raw additive nudge -- an earlier version of this added a
    // small unbounded (hydration-0.5)*weight term directly to mood every tick, same shape as the
    // OLD room-quality term this section's Comfort/Beauty replaced (see the removed
    // ROOM_MOOD_INFLUENCE doc comment above CitizenStore), but unlike a room (which simply has no
    // term at all until the citizen stands inside one) an un-plumbed colony has EVERY citizen's
    // hydration pinned at 0 for the entire early game, so that raw term permanently dragged mood
    // toward 0 tick after tick with nothing to counteract it -- caught in that pass's soak test
    // (population collapsed from 24 to 3 by tick ~9000 on a fresh Calm colony with no pump built
    // yet). Folding it into avgNeed instead means it only pulls mood toward a lower *target*
    // (proportionally diluted 1-in-9 now that Joy/Comfort/Beauty are included, was 1-in-6), which
    // the existing 0.05 easing already keeps gentle -- same bounded behavior as hunger/rest/social,
    // no separate uncapped accumulation path. Comfort/Beauty specifically ease toward
    // COMFORT_BEAUTY_NEUTRAL (0.5) rather than 0 when unmet, so a hands-off/no-rooms-built colony
    // sees these two new terms sit at the same neutral midpoint the old ROOM_MOOD_INFLUENCE term's
    // own baseline already used -- not a repeat of the hydration-pinned-at-0 failure mode.
    const avgNeed = (store.hunger[i] + store.rest[i] + store.social[i] + store.hydration[i] + store.exercise[i] + store.hygiene[i] + store.joy[i] + store.comfort[i] + store.beauty[i]) / 9;

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

    // Room quality's mood influence now flows entirely through the Comfort/Beauty terms already
    // folded into avgNeed above -- see the removed ROOM_MOOD_INFLUENCE doc comment above
    // CitizenStore for why the old direct raw-add here was removed rather than left stacked on
    // top of the new needs (double-counting the same rooms.js data through two pathways).

    store.mood[i] = Math.min(1, Math.max(0, store.mood[i]));

    // Per-trait offset (traits.js breakThresholdOffset, RimWorld's Neurotic-spectrum
    // MentalBreakThreshold) applied on top of whatever the base constant currently is -- read
    // fresh each tick from the trait object rather than baked into the constant, so this stays
    // correct no matter how BREAK_MOOD_THRESHOLD itself gets tuned.
    const effBreakThreshold = BREAK_MOOD_THRESHOLD + (trait?.breakThresholdOffset ?? 0) + augmentBreakThresholdOffsetFor(store, i);

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
      world?.onCitizenOnBreak?.();

      // Severe break: one-time, bounded property-damage consequence (see BREAK_TIERS' 'severe'
      // doc comment and SEVERE_BREAK_DAMAGE_FRACTION's doc comment above for the full reasoning).
      // Fires exactly once, right here at the moment of the trigger -- no movement, no new
      // exposure, matching the "existing property-damage consequence pattern, not new violence"
      // requirement.
      if (BREAK_TIERS[tierIdx].name === 'severe' && world?.structures) {
        const candidates = world.structures.filter(s =>
          !s.destroyed && !s.underConstruction && s.kind !== 'turret' && s.kind !== 'wall');
        if (candidates.length > 0) {
          const target = candidates[Math.floor(rng() * candidates.length)];
          target.health = Math.max(0, target.health - SEVERE_BREAK_DAMAGE_FRACTION);
          if (target.health <= 0) target.destroyed = true;
          if (world.milestoneLog) {
            const text = `${store.name[i]} has a severe mental break and damages the ${target.kind}`;
            world.milestoneLog.push({ tick: world.currentTick, text });
            if (world.milestoneLog.length > 20) world.milestoneLog.shift();
            world.onRandomEvent?.(text);
          }
        }
      }
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
// isAllowedAt: optional (i, x, y) -> bool (jobs.js/world.js's per-citizen Allowed Area check,
// see citizens.js's isInAllowedArea). Omitted for every pre-existing call site, byte-for-byte
// the old behavior. This is the one autonomous-movement path jobs.js's per-target filtering
// doesn't cover on its own (an idle citizen with no job just wanders to a random nearby point,
// not through any of jobs.js's finder functions) -- caught during this feature's own soak-test
// verification, see world.js's call site for the real closure passed in.
export function tickWander(store, grid, rng, speed = 0.04, skipIf = null, perCitizenMult = null, isAllowedAt = null) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.isDownedAt(i)) continue;
    if (skipIf && skipIf(i)) continue;

    const dx = store.targetX[i] - store.x[i];
    const dy = store.targetY[i] - store.y[i];
    const dist = Math.hypot(dx, dy);
    if (dist < 0.15) {
      let tx, ty, tries = 0, valid = false;
      do {
        tx = Math.max(1, Math.min(grid.width - 2, store.x[i] + (rng() - 0.5) * 10));
        ty = Math.max(1, Math.min(grid.height - 2, store.y[i] + (rng() - 0.5) * 10));
        tries++;
        valid = !grid.isBlocked(tx | 0, ty | 0) && (!isAllowedAt || isAllowedAt(i, tx, ty));
      } while (!valid && tries < 8);
      // Ran out of retries without ever landing a point inside a restricted citizen's area (a
      // small painted area, or bad luck) -- hold in place rather than wandering out. Matches
      // every other autonomous-target filter in this feature: "no valid option found" means
      // "don't move", never "fall back to ignoring the restriction".
      if (!valid && isAllowedAt) { tx = store.x[i]; ty = store.y[i]; }
      store.targetX[i] = tx;
      store.targetY[i] = ty;
    } else {
      const effSpeed = perCitizenMult ? speed * perCitizenMult(i) : speed;
      store.x[i] += (dx / dist) * effSpeed;
      store.y[i] += (dy / dist) * effSpeed;
    }
  }
}
