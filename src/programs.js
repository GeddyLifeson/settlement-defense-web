// Structured Group Programs -- direct port of Prison Architect's real reform-program schema
// (reform_programs.txt: SessionCost, Places, SessionLength, NumSessions, Difficulty, a
// Room+Teacher+Equipment requirement, an Intake mode), reskinned non-carceral per this project's
// explicit rule (SESSION_HANDOFF.md: never frame anything as a prison). The schema itself is
// genuinely genre-neutral -- "a scheduled group class that ticks down a named need for a whole
// group, staffed by a role, capacity-limited" describes a settlement's own skills class / group
// counseling / community circle just as well as a prison's -- only the labels change.
//
// Intake mode: PA supports Voluntary/Referral/Mandatory. This port only implements Voluntary --
// citizens choose to attend the same way they choose to eat/sleep/recreate (jobs.js's Idle
// branch), gated by the citizen actually having something to gain (see the per-kind gate
// functions below). Referral/Mandatory would mean the game *assigning* attendance, which has no
// analog anywhere else in this citizen-autonomy-first codebase and isn't needed for the ask.
//
// Session-length conversion: PA's SessionLength is real minutes on a 60-240 range. This project's
// day/night cycle (schedule.js's DAY_NIGHT_CYCLE_TICKS = 2400) represents one 24-hour day, so
// 1 real minute = 2400 / (24*60) = 5/3 ticks. Every PROGRAM_DEFS sessionLengthTicks below is that
// conversion applied to a value PA's own real data uses, not an arbitrary tuning pick.
import { StaffRoleKind } from './core.js';
import { RoomRole } from './rooms.js';
import { ScheduleBlock } from './schedule.js';
import { addMoodEvent } from './citizens.js';

const MINUTES_TO_TICKS = 2400 / (24 * 60); // see doc comment above

export const ProgramKind = Object.freeze({
  SkillsWorkshop: 'skills_workshop',
  WellnessCounseling: 'wellness_counseling',
  CommunityCircle: 'community_circle',
  // Community Gathering (RimWorld Ideology DLC's real Party/Festival mechanic, reskinned
  // non-carceral): a scheduled ONE-TIME group event, not an ongoing multi-session course like the
  // three programs above. Rides the exact same ProgramSite/isSiteStaffed/findJoinableSite/
  // completeSession machinery -- the only real difference is numSessions: 1 below (so
  // completeSession's existing "course complete" check fires the instant a single session ends)
  // and there's no per-tick applyAttendingTick effect for this kind at all (see that function --
  // it simply has no branch for CommunityGathering, so attending it discharges nothing tick by
  // tick). The payoff is entirely in the one-shot mood event fired by completeSession below,
  // magnitude gated by the room's own computeRoomStats().quality at the moment the session ends.
  CommunityGathering: 'community_gathering',
  // Staff training-program track (Prison Architect reform_programs_dlc.txt's real staff-facing
  // training tracks, distinct from every program above -- those are all citizen-facing). Reuses
  // the exact same ProgramSite/room-role/staffing/session-loop machinery; the only real
  // difference is WHO can attend (security.js's tickStaffTraining dispatches on-duty
  // Guard/Sniper/Monitor staff directly, since staff never reach jobs.js's Idle branch --
  // world.js's isStaffOnDutyAt gates them out of the citizen-facing findJoinableSite path
  // entirely) and the payoff (combat-skill gain plus, on full-course graduation, a real reduction
  // in this specific staffer's own bribery odds -- see completeSession below).
  GuardResponseTraining: 'guard_response_training',
  // Care Clinic (item 4): real PA anchor is Methadone (reform_programs.txt), the one program in
  // PA's real table flagged BOTH Repeatable and Passive -- an always-on maintenance loop with no
  // pass/fail graduation, distinct from every kind above (SkillsWorkshop/WellnessCounseling/
  // CommunityCircle all run a fixed multi-session "course" that ends in a graduation outcome;
  // CommunityGathering is a single one-shot event). See PROGRAM_DEFS' entry below and
  // completeSession()'s dedicated (lack of a) branch for this kind for how that's actually
  // expressed inside this file's existing session-loop machinery, without touching jobs.js at all.
  CareClinic: 'care_clinic',
});

// PROGRAM_DEFS: the balance table, PA's real numbers (per the task doc) converted into this
// project's scrap economy (~40x smaller than PA's dollar economy, so PA's -100..-500 SessionCost
// becomes roughly 3-15 scrap) and tick scale (see MINUTES_TO_TICKS above). `roomRole` is the
// rooms.js RoomRole a session must be held inside a *validated* instance of (rooms.js's
// classifyRoomRole/computeRoomStats already gate this the same way Dining/Bedroom do); `staffRole`
// is the core.js StaffRoleKind that must be assigned (via the existing StaffRoster/tickStaffDuty
// plumbing, see world.js) and physically present in that room for the program to run at all.
export const PROGRAM_DEFS = Object.freeze({
  [ProgramKind.SkillsWorkshop]: Object.freeze({
    label: 'Skills Workshop',
    staffRole: StaffRoleKind.Foreman,
    roomRole: RoomRole.Training, // see rooms.js's RoomRole.Training / zones.js's ZoneKind.Training -- named
                                  // "Training" not "Workshop" to avoid colliding with the unrelated
                                  // 'workshop' materials-processing Structure kind elsewhere in this codebase
    sessionCost: 8,                              // PA SessionCost -200 / ~40x-smaller economy
    places: 4,                                    // PA Places 1-20, picked a small-group value
    sessionLengthTicks: Math.round(120 * MINUTES_TO_TICKS), // PA SessionLength 120 real-minutes
    numSessions: 3,                                // PA NumSessions 2-5
    scheduleBlock: ScheduleBlock.Work,             // a workshop is work-adjacent, runs during Work
    // Direct construction-skill boost per tick attended, tuned so a full session's worth of
    // attendance (sessionLengthTicks) grants a gain on the same order as one full BUILD_SKILL_GAIN
    // tick-up from jobs.js -- i.e. attending is a real, if modest, alternative path to the skill
    // gain a citizen would otherwise only get from actually building/harvesting.
    skillGainPerTick: 0.02 / Math.round(120 * MINUTES_TO_TICKS) * 6,
    requires: [], // item 3: no prerequisite -- the entry-level vocational track
  }),
  [ProgramKind.WellnessCounseling]: Object.freeze({
    label: 'Wellness Counseling',
    // item 3 (qualification-gated chains): real PA anchor -- GeneralEducation requires
    // Qualification FoundationEducation. Mirrored here directly on citizen completion rather than
    // a separate Qualification token (this project has no such token system, and the task's own
    // framing -- "mirroring how research.js's own nodes already have a requires[] array" -- is
    // satisfied just as well by requiring the prerequisite PROGRAM's own completion). A citizen
    // needs baseline group trust from Community Circle before qualifying for deeper 1-on-1-style
    // counseling. Enforced in findJoinableSite() below via programPrereqsMet() -- see that
    // function's doc comment for the graduation-tracking it reads from.
    requires: [ProgramKind.CommunityCircle],
    staffRole: StaffRoleKind.Psychologist,
    roomRole: RoomRole.RecreationRoom, // reuses the existing Recreation Room validation -- see
                                        // the doc comment in rooms.js: only Workshop needed adding.
    sessionCost: 5,                               // PA SessionCost -100ish
    places: 3,                                     // small-group counseling
    sessionLengthTicks: Math.round(90 * MINUTES_TO_TICKS), // PA SessionLength 60-120 real-minutes
    numSessions: 6,                                // PA NumSessions 5-10
    scheduleBlock: ScheduleBlock.Recreation,
    difficultyPct: 45,                             // PA Difficulty 0-60 graduation-chance stat, task asked 40-50%
    moodGainPerTick: 0.00025,                      // continuous calming effect while attending
    graduationMoodBonus: 0.2,                      // one-off bump on a successful full-course graduation
  }),
  [ProgramKind.CommunityCircle]: Object.freeze({
    label: 'Community Circle',
    requires: [], // item 3: no prerequisite -- the entry-level social track WellnessCounseling gates on

    staffRole: StaffRoleKind.Facilitator,
    roomRole: RoomRole.RecreationRoom, // same reuse reasoning as Wellness Counseling above
    sessionCost: 4,                                // PA SpiritualGuidance/FaithProgram SessionCost, low end
    places: 8,                                     // a real group class, not 1-on-1
    sessionLengthTicks: Math.round(90 * MINUTES_TO_TICKS),
    numSessions: 4,
    scheduleBlock: ScheduleBlock.Recreation,
    // ProgressEffect calming + EffectChargeRate 1.0 + DischargeNeed (PA's real FaithProgram/
    // SpiritualGuidance mechanic, the one explicitly called out to port directly): attending
    // passively discharges a named need for every attendee, every tick, for the whole session --
    // reskinned as satisfying `social` (the direct analog of PA's calming discharge target) at
    // REFILL_RATE-ish speed, plus `hydration` a little too (this codebase's own newer need, see
    // citizens.js -- a community gathering plausibly has refreshments), on top of a genuine mood
    // buff. Both keep decaying normally the instant a citizen leaves, same as every other need.
    socialDischargePerTick: 0.04,
    hydrationDischargePerTick: 0.015,
    moodGainPerTick: 0.0003,
  }),
  [ProgramKind.CommunityGathering]: Object.freeze({
    label: 'Community Gathering',
    requires: [], // item 3: no prerequisite -- a real "everyone's invited" event, same as real PA parties
    staffRole: StaffRoleKind.Organizer,
    roomRole: RoomRole.RecreationRoom, // same reuse reasoning as Wellness Counseling/Community
                                        // Circle above -- a gathering is a Recreation-block event,
                                        // no dedicated "hall" Structure/RoomRole exists or is needed
    sessionCost: 3,                               // PA analog: a light one-off social event, cheaper
                                                    // than the ongoing-discharge programs above
    places: 8,                                     // a real group event -- matches Community Circle's size
    sessionLengthTicks: Math.round(60 * MINUTES_TO_TICKS), // one scheduled block, ~1 real hour
    numSessions: 1,                                // ONE-TIME: the "course" completes the instant
                                                     // the single session ends -- see completeSession
    scheduleBlock: ScheduleBlock.Recreation,
    // RimWorld Ideology's real Party/Festival mood range is roughly -3 (poor venue) / -1 (mediocre)
    // / +8 (good) / +16 (great) on RimWorld's own mood-point scale -- scaled 1:1 onto this
    // project's 0-1 mood scale (i.e. /100) per the task brief, tiered off the room's
    // computeRoomStats().quality (0..1) at the moment the session ends. See
    // GATHERING_MOOD_TIERS/gatheringMoodMagnitude below -- kept here as documentation of the real
    // anchor numbers, the actual tier table lives next to the function that reads it.
    gatheringMoodDurationTicks: 1000, // ~half this project's DAY_NIGHT_CYCLE_TICKS -- a festival's
                                       // afterglow (or letdown) fades over the following day, not
                                       // instantly and not forever
  }),
  [ProgramKind.GuardResponseTraining]: Object.freeze({
    label: 'Guard Response Training',
    // item 3: no prerequisite. Dispatched entirely by security.js's tickStaffTraining rather than
    // this file's own findJoinableSite() (see the ProgramKind.GuardResponseTraining doc comment
    // above), so a requires[] entry here would need that separate, unowned call site to check
    // programPrereqsMet() itself -- left empty rather than adding data nothing currently enforces.
    requires: [],
    staffRole: StaffRoleKind.Instructor,
    // Reuses Skills Workshop's RoomRole.Training -- a training room can validate BOTH a citizen
    // Skills Workshop site and this staff-facing site at once (syncProgramSites makes one
    // ProgramSite per (room, matching kind) pair), same as how RecreationRoom already hosts three
    // different citizen program kinds simultaneously above. No dedicated "armory classroom" role
    // is needed for this.
    roomRole: RoomRole.Training,
    sessionCost: 6,                                // between Community Circle (4) and Skills Workshop (8)
    places: 2,                                      // a small drill pairing, not a whole-roster muster
    sessionLengthTicks: Math.round(90 * MINUTES_TO_TICKS), // PA SessionLength 60-120 real-minutes, same range as Wellness/Community Circle
    numSessions: 4,
    scheduleBlock: ScheduleBlock.Work,              // a duty-shift drill, not off-hours recreation
    // Direct combat-skill boost per tick attended -- same shape/scale as SkillsWorkshop's
    // skillGainPerTick above but targeting skillCombat, the stat this trainee's actual job (guard
    // duty) draws on.
    skillGainPerTick: 0.02 / Math.round(90 * MINUTES_TO_TICKS) * 6,
  }),
  [ProgramKind.CareClinic]: Object.freeze({
    label: 'Care Clinic',
    // item 3: gated behind Wellness Counseling rather than left ungated -- "ongoing maintenance
    // care once initial counseling is behind you" mirrors Methadone's own real-world maintenance-
    // therapy framing, and (unlike gating an already-ungated PRE-EXISTING program) adding a
    // prerequisite to a brand-new program can't regress any existing colony's access to anything.
    requires: [ProgramKind.WellnessCounseling],
    // No dedicated "nurse"/"clinician" StaffRoleKind exists in core.js (not owned by this pass) --
    // reuses Wellness Counseling's Psychologist, the closest existing wellness-adjacent role, same
    // "reuse rather than invent" precedent RoomRole.RecreationRoom already sets by hosting three
    // different program kinds above. Real staffing tension as a result: a single Psychologist can
    // staff either this OR Wellness Counseling at once, not both -- an intentional scarcity, not a
    // bug.
    staffRole: StaffRoleKind.Psychologist,
    // RoomRole.Medical (the Infirmary -- rooms.js's Medical zone + >=1 Medical Bed gate), not
    // RecreationRoom again -- an ongoing wellness-maintenance loop belongs in the same room that
    // already passively speeds citizen health recovery, and gives this kind a genuinely distinct
    // room requirement from every other citizen-facing program above.
    roomRole: RoomRole.Medical,
    sessionCost: 2,                                // cheap -- real PA Methadone sits near the bottom of its whole SessionCost table
    places: 6,                                      // an open drop-in clinic, not a small-group session
    sessionLengthTicks: Math.round(60 * MINUTES_TO_TICKS), // a short "dose"/visit -- shortest session of any program here
    // Real PA anchor: Methadone is Repeatable + Passive (reform_programs.txt) -- an always-on
    // maintenance loop with no course-complete graduation event at all. This engine's dispatch
    // model (jobs.js's SeekingProgram/Attending) has no room-free "Passive" concept to plug into
    // without touching jobs.js (not owned by this pass), so the closest faithful expression fully
    // achievable from programs.js alone is: numSessions: 1 (a short, low-barrier single "visit"
    // rather than a multi-session course) + a permissive citizenBenefits() gate (see below) that
    // stays true well short of the mood ceiling, so a citizen who still qualifies simply walks
    // right back in for another short visit the moment they're free -- functionally repeatable
    // through the existing Idle -> SeekingProgram -> Attending -> Idle loop, no special-cased
    // "requeue" logic needed. completeSession() below has no dedicated branch for this kind --
    // see the doc comment there for why that's deliberate, not an oversight.
    numSessions: 1,
    scheduleBlock: ScheduleBlock.Recreation,
    repeatable: true, // self-documenting marker only -- no code branches on this flag; the
                      // repeat behavior emerges from numSessions:1 + the permissive gate above
    passive: true,    // self-documenting marker only -- no pass/fail graduation payoff exists for
                      // this kind, see completeSession()'s doc comment
    // Deliberately smaller than Wellness Counseling's 0.00025 -- a light maintenance top-up, not a
    // substitute for real counseling. Bounded by the same Math.min(1, ...) clamp every other mood
    // effect in this file already uses (applyAttendingTick below), so it can never compound past a
    // full mood bar no matter how many visits stack up.
    moodGainPerTick: 0.00015,
  }),
});

export const PROGRAM_ORDER = [
  ProgramKind.SkillsWorkshop, ProgramKind.WellnessCounseling, ProgramKind.CommunityCircle,
  ProgramKind.CommunityGathering, ProgramKind.GuardResponseTraining, ProgramKind.CareClinic,
];

// Community Gathering's mood-magnitude ladder (see the PROGRAM_DEFS.gatheringMoodDurationTicks
// doc comment above for the real RimWorld Party/Festival numbers this is anchored on): poor-quality
// venue gives a small negative, good-to-great gives the +0.08..+0.16 positive range the task brief
// asked for. Tiers checked ascending, last matching one wins (same pattern as citizens.js's
// breakTierForDepth).
const GATHERING_MOOD_TIERS = [
  { minQuality: 0, magnitude: -0.03 },   // poor room (RimWorld's -3 real points / 100)
  { minQuality: 0.3, magnitude: -0.01 }, // mediocre (RimWorld's -1 real points / 100)
  { minQuality: 0.5, magnitude: 0.08 },  // good (RimWorld's +8 real points / 100)
  { minQuality: 0.75, magnitude: 0.16 }, // great (RimWorld's +16 real points / 100)
];

export function gatheringMoodMagnitude(quality) {
  let magnitude = GATHERING_MOOD_TIERS[0].magnitude;
  for (const tier of GATHERING_MOOD_TIERS) {
    if (quality >= tier.minQuality) magnitude = tier.magnitude; else break;
  }
  return magnitude;
}

// One ProgramSite per validated room matching a program kind's roomRole. Sites are synced (not
// rebuilt) so an assigned staffId/attendee list survives room stat recomputation each tick --
// keyed by the room object's identity, which rooms.js keeps stable between wall-layout changes
// (see world.js's wallSum-signature gate on detectRooms).
export class ProgramSite {
  constructor(kind, room) {
    this.kind = kind;
    this.room = room;
    this.staffId = null;      // citizenId assigned as this site's staffer, see assignProgramStaff
    this.attendeeIds = [];    // citizenIds currently Attending (jobs.js JobState.Attending)
  }
}

// Assigns citizenId as this program site's staffer via the existing StaffRoster plumbing --
// tickStaffDuty/tickStaffOffDuty (security.js) already know how to walk any roster member to a
// post and hold it / clock off for needs, so a Foreman/Psychologist/Facilitator needs zero new
// staff-AI code, just the same assign(citizenId, role, post) call Guard/Sniper/Monitor use.
export function assignProgramStaff(world, site, citizenId) {
  const def = PROGRAM_DEFS[site.kind];
  const post = roomPostFor(site.room, world.grid);
  world.roster.assign(citizenId, def.staffRole, post);
  site.staffId = citizenId;
}

// Exported so jobs.js can walk an attendee to the same point a staffer's post uses -- any cell in
// the room is a fine destination -- pick the first one deterministically (Set iteration order is
// insertion order, and detectRooms always inserts in the same scan order for a given wall layout)
// so neither the staffer's post nor an attendee's walk target jitters between room recomputes.
export function roomPostFor(room, grid) {
  const idx = room.cells.values().next().value;
  const x = idx % grid.width;
  const y = Math.floor(idx / grid.width);
  return { x: x + 0.5, y: y + 0.5 };
}

// A site is "staffed" only if its assigned staffer is alive, not downed, not off-duty (security.js
// fatigue cycle), actually holds the right role (a save/room change could theoretically have
// stripped it), AND is physically standing inside the room -- same "hold the post, not just
// assigned on paper" bar world.js already applies to the Monitor Station (`_isMonitorStaffed`).
// This is the enforcement point the task explicitly asked to verify: no staffer physically present
// -> isSiteStaffed returns false -> tickPrograms below never lets anyone start Attending there.
export function isSiteStaffed(world, site) {
  if (site.staffId == null) return false;
  const def = PROGRAM_DEFS[site.kind];
  if (world.roster.kindOf(site.staffId) !== def.staffRole) return false;
  if (world.roster.isOffDuty(site.staffId)) return false;
  for (let i = 0; i < world.citizens.count; i++) {
    if (world.citizens.id[i] !== site.staffId) continue;
    if (!world.citizens.isAliveAt(i) || world.citizens.isDownedAt(i)) return false;
    const gx = Math.floor(world.citizens.x[i]), gy = Math.floor(world.citizens.y[i]);
    return world.grid.inBounds(gx, gy) && site.room.cells.has(world.grid.index(gx, gy));
  }
  return false; // staffId assigned but that citizen no longer exists (died and was pruned, etc.)
}

// Rebuilds world.programSites to have exactly one ProgramSite per (validated room, matching
// program kind) pair, preserving existing sites (and their staffId/attendeeIds) for rooms that
// are still validated the same way, and dropping sites for rooms that stopped validating (walls
// changed, zone repainted, etc.) -- attendees of a dropped site are left to jobs.js's normal
// dangling-_jobRef defensive check (mirrors Cleaning's `!world.rooms.includes(room)` bail) to fall
// back to Idle on their next tick.
export function syncProgramSites(world) {
  const kept = [];
  for (const room of world.rooms) {
    if (!room.roleValid) continue;
    for (const kind of PROGRAM_ORDER) {
      if (PROGRAM_DEFS[kind].roomRole !== room.role) continue;
      let site = (world.programSites || []).find(s => s.room === room && s.kind === kind);
      if (!site) site = new ProgramSite(kind, room);
      kept.push(site);
    }
  }
  world.programSites = kept;
}

// Per-kind gate: does citizen i currently stand to benefit from attending this program? Mirrors
// the existing SeekingRec-style need-threshold philosophy (jobs.js) rather than sending everyone
// idle at a workshop regardless of whether they'd gain anything.
function citizenBenefits(kind, store, i) {
  if (kind === ProgramKind.SkillsWorkshop) return store.skillConstruction[i] < 2.5; // below "Master", see main.js SKILL_LEVELS
  if (kind === ProgramKind.WellnessCounseling) return store.mood[i] < 0.75;
  if (kind === ProgramKind.CommunityCircle) return store.social[i] < 0.85 || (store.hydration != null && store.hydration[i] < 0.85);
  // Community Gathering: broader gate than the other three, matching a real "everyone's invited"
  // social event rather than a targeted need-refill -- benefits anyone not already thoroughly
  // content, same threshold style as WellnessCounseling's mood gate just above.
  if (kind === ProgramKind.CommunityGathering) return store.mood[i] < 0.9 || store.social[i] < 0.9;
  // Care Clinic (item 4): deliberately the most permissive threshold of any kind here -- a light
  // maintenance top-up should keep being "worth a visit" almost up to a full mood bar, unlike
  // WellnessCounseling's 0.75 (a real, meaningful deficit) -- see PROGRAM_DEFS' doc comment on
  // this kind for how that permissiveness is what actually makes it read as "repeatable" through
  // the existing dispatch loop.
  if (kind === ProgramKind.CareClinic) return store.mood[i] < 0.95;
  return false;
}

// ---- qualification-gated program chains (item 3) ----
// Real PA anchor: reform_programs.txt's GeneralEducation requires Qualification FoundationEducation
// / Carpentry requires Qualification WorkshopInduction. This project has no separate "Qualification"
// token system, so the prerequisite is checked directly against a citizen's own program-completion
// history -- see each PROGRAM_DEFS entry's `requires` array above (currently: WellnessCounseling
// requires CommunityCircle, CareClinic requires WellnessCounseling; everything else is ungated).
//
// world.programGraduations: citizenId -> Set<ProgramKind> of every program kind this citizen has
// ever completed at least once. Lazily created (mirrors world.programSites' own lazy-rebuild
// precedent in syncProgramSites above) rather than requiring world.js to declare it, since this
// file is the only one that reads or writes it -- same "attach state to `world` from the one file
// that owns it" pattern world.programSites itself already uses. NOT persisted across save/load:
// world.js's serialize()/deserialize() (not owned by this pass) would need a block mirroring how
// it already persists world.roster._corruptEligible (see world.js's serialize() near
// `eligible: Array.from(this.roster._corruptEligible)` and its matching deserialize() restore) to
// survive a reload -- without that, a reloaded save's citizens re-qualify for CareClinic/
// WellnessCounseling from scratch. Left as a known gap rather than worked around, since silently
// stuffing this into an existing serialized field would be a worse (harder to find) surprise than
// a documented one.
function markGraduated(world, citizenId, kind) {
  if (!world.programGraduations) world.programGraduations = new Map();
  let set = world.programGraduations.get(citizenId);
  if (!set) { set = new Set(); world.programGraduations.set(citizenId, set); }
  set.add(kind);
}

/** Whether citizenId has ever completed (graduated) a program of `kind` at least once. */
export function hasGraduated(world, citizenId, kind) {
  return !!world.programGraduations?.get(citizenId)?.has(kind);
}

/** Whether citizenId currently meets every prerequisite program kind for `kind`'s own
 *  PROGRAM_DEFS.requires -- the programs.js analog of research.js's researchPrereqsMet(). Fail-open
 *  (true) for a kind with an empty/missing requires array, same fail-open spirit as this file's
 *  other gates. */
export function programPrereqsMet(world, citizenId, kind) {
  const req = PROGRAM_DEFS[kind]?.requires;
  if (!req || req.length === 0) return true;
  return req.every(r => hasGraduated(world, citizenId, r));
}

// jobs.js's Idle branch calls this (after the basic-needs checks, before the fixed work ladder --
// see jobs.js's tryClaimProgram doc comment) to find an open, staffed, scheduled-in program site
// for citizen i to walk to. Returns the site if one was found and claimed (attendeeIds gains i's
// citizenId as a placeholder reservation -- see jobs.js SeekingProgram/Attending handling for how
// it actually gets added for real on arrival), or null.
// isAllowed: optional (x, y) -> bool predicate (jobs.js's per-citizen Allowed Area check) --
// checked against the site's actual post tile (roomPostFor), since that's where the citizen
// would actually have to walk to. Omitted for every pre-existing call site, byte-for-byte the
// old behavior.
export function findJoinableSite(world, store, i, scheduleBlock, isAllowed = null) {
  if (!world.programSites) return null;
  for (const site of world.programSites) {
    const def = PROGRAM_DEFS[site.kind];
    if (def.scheduleBlock !== scheduleBlock) continue;
    if (site.attendeeIds.length >= def.places) continue;
    if (!isSiteStaffed(world, site)) continue;
    if (!citizenBenefits(site.kind, store, i)) continue;
    // item 3: qualification gate -- a citizen who hasn't completed this kind's prerequisite
    // program(s) yet (PROGRAM_DEFS.requires, see programPrereqsMet()'s doc comment above) simply
    // skips this site, same "keep looking" shape as every other disqualifying check in this loop
    // rather than a hard error -- they may still be eligible for a DIFFERENT site later in the list.
    if (!programPrereqsMet(world, store.id[i], site.kind)) continue;
    if (isAllowed) {
      const post = roomPostFor(site.room, world.grid);
      if (!isAllowed(post.x, post.y)) continue;
    }
    return site;
  }
  return null;
}

// Per-tick effect application while citizen i is JobState.Attending at `site` -- called from
// jobs.js. Returns nothing; mutates store's need/skill/mood fields directly, same style as the
// Eating/Sleeping/Recreating/Building/Harvesting blocks it sits alongside.
export function applyAttendingTick(site, store, i) {
  const def = PROGRAM_DEFS[site.kind];
  if (site.kind === ProgramKind.SkillsWorkshop) {
    store.skillConstruction[i] += def.skillGainPerTick;
  } else if (site.kind === ProgramKind.WellnessCounseling) {
    store.mood[i] = Math.min(1, store.mood[i] + def.moodGainPerTick);
  } else if (site.kind === ProgramKind.CommunityCircle) {
    store.social[i] = Math.min(1, store.social[i] + def.socialDischargePerTick);
    if (store.hydration != null) store.hydration[i] = Math.min(1, store.hydration[i] + def.hydrationDischargePerTick);
    store.mood[i] = Math.min(1, store.mood[i] + def.moodGainPerTick);
  } else if (site.kind === ProgramKind.GuardResponseTraining) {
    store.skillCombat[i] += def.skillGainPerTick;
  } else if (site.kind === ProgramKind.CareClinic) {
    // Passive/repeatable (item 4) -- same bounded Math.min(1, ...) clamp as WellnessCounseling's
    // mood gain above, just a smaller per-tick trickle (see PROGRAM_DEFS' doc comment on this kind).
    store.mood[i] = Math.min(1, store.mood[i] + def.moodGainPerTick);
  }
}

// Called when citizen i's session-length timer completes one full session at `site` (see jobs.js).
// sessionsDone is the running per-citizen count of completed sessions at THIS program kind
// (citizens.js's programSessionsDone, reset once a course is graduated or abandoned). Returns
// { courseComplete, graduated } so jobs.js knows whether to reset the counter / log a milestone.
export function completeSession(world, site, store, i, sessionsDone) {
  const def = PROGRAM_DEFS[site.kind];
  if (sessionsDone < def.numSessions) return { courseComplete: false, graduated: false };

  // Course complete -- Difficulty-style graduation roll (PA's real Difficulty stat, only
  // meaningfully used by Wellness Counseling here per the task's "40-50%-ish success chance"
  // framing; Skills Workshop/Community Circle always "graduate" since their whole benefit is the
  // continuous per-tick effect already applied above, not a pass/fail outcome).
  let graduated = true;
  let moodMagnitude;
  if (site.kind === ProgramKind.WellnessCounseling) {
    graduated = (world.rng ? world.rng() : Math.random()) * 100 < def.difficultyPct;
    if (graduated) store.mood[i] = Math.min(1, store.mood[i] + def.graduationMoodBonus);
  } else if (site.kind === ProgramKind.CommunityGathering) {
    // ONE-TIME completion mood event (see the ProgramKind.CommunityGathering doc comment above):
    // unlike every other program kind here, this has no continuous applyAttendingTick effect at
    // all -- the whole payoff is this single addMoodEvent, magnitude gated by the room's current
    // computeRoomStats().quality (site.room.quality, recomputed every tick by world.js before
    // programs are ticked, so this reads a fresh value, not a stale one from claim time).
    const quality = site.room?.quality ?? 0.5;
    moodMagnitude = gatheringMoodMagnitude(quality);
    graduated = moodMagnitude > 0; // reused purely as a "went well" flag for jobs.js's flavor text
    addMoodEvent(store, i, world.currentTick, {
      magnitude: moodMagnitude,
      durationTicks: def.gatheringMoodDurationTicks,
      stackKey: 'communityGathering',
    });
  } else if (site.kind === ProgramKind.GuardResponseTraining) {
    // Always "graduates" -- the combat-skill gain already happened tick-by-tick in
    // applyAttendingTick above, same always-succeeds framing as SkillsWorkshop/CommunityCircle.
    // Real PA anchor for the graduation payoff (task brief: "reducing corrupt-staff chance"):
    // clears this specific staffer's crooked-eligible flag on the roster if they had one --
    // security.js's tickStaffCorruption never rolls a bribe-activation for anyone not in
    // roster._corruptEligible, so this is a real, permanent, per-citizen reduction in their own
    // future bribery odds, not a colony-wide stat tweak.
    graduated = true;
    const citizenId = store.id[i];
    if (world.roster?.isCorruptEligible(citizenId)) {
      world.roster._corruptEligible.delete(citizenId);
    }
  }
  // Care Clinic (item 4) deliberately has NO branch above -- `graduated` stays at its `let
  // graduated = true;` default from the top of this function, same "always succeeds, the real
  // payoff already happened tick-by-tick in applyAttendingTick" shape as SkillsWorkshop/
  // CommunityCircle/GuardResponseTraining. There's no pass/fail roll and no one-time bonus to add
  // here (Real PA anchor: Methadone has no graduation outcome at all) -- see PROGRAM_DEFS' doc
  // comment on this kind for why jobs.js's caller resetting programSessionsDone[i] to 0 on
  // courseComplete just means "ready for another short visit," not "done forever."

  // item 3: record this graduation for programPrereqsMet() (see that function's doc comment above)
  // -- every kind here that actually reaches this point completed its course, so mark it
  // regardless of which branch (if any) ran above. WellnessCounseling is the one kind where
  // `graduated` can genuinely be false (its Difficulty roll failed) -- only a REAL graduation
  // should satisfy a downstream prerequisite like CareClinic's, so this is gated on `graduated`,
  // not on `courseComplete` alone.
  if (graduated) markGraduated(world, store.id[i], site.kind);
  return { courseComplete: true, graduated, moodMagnitude };
}
