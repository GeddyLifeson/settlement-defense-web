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

const MINUTES_TO_TICKS = 2400 / (24 * 60); // see doc comment above

export const ProgramKind = Object.freeze({
  SkillsWorkshop: 'skills_workshop',
  WellnessCounseling: 'wellness_counseling',
  CommunityCircle: 'community_circle',
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
  }),
  [ProgramKind.WellnessCounseling]: Object.freeze({
    label: 'Wellness Counseling',
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
});

export const PROGRAM_ORDER = [ProgramKind.SkillsWorkshop, ProgramKind.WellnessCounseling, ProgramKind.CommunityCircle];

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
  return false;
}

// jobs.js's Idle branch calls this (after the basic-needs checks, before the fixed work ladder --
// see jobs.js's tryClaimProgram doc comment) to find an open, staffed, scheduled-in program site
// for citizen i to walk to. Returns the site if one was found and claimed (attendeeIds gains i's
// citizenId as a placeholder reservation -- see jobs.js SeekingProgram/Attending handling for how
// it actually gets added for real on arrival), or null.
export function findJoinableSite(world, store, i, scheduleBlock) {
  if (!world.programSites) return null;
  for (const site of world.programSites) {
    const def = PROGRAM_DEFS[site.kind];
    if (def.scheduleBlock !== scheduleBlock) continue;
    if (site.attendeeIds.length >= def.places) continue;
    if (!isSiteStaffed(world, site)) continue;
    if (!citizenBenefits(site.kind, store, i)) continue;
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
  if (site.kind === ProgramKind.WellnessCounseling) {
    graduated = (world.rng ? world.rng() : Math.random()) * 100 < def.difficultyPct;
    if (graduated) store.mood[i] = Math.min(1, store.mood[i] + def.graduationMoodBonus);
  }
  return { courseComplete: true, graduated };
}
