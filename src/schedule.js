// Day/night "Duty Roster" scheduling -- genre-neutral cousin of Prison Architect's "Regime"
// (see FEATURE_RESEARCH.md's PA section): a global cycle of Sleep/Work/Recreation blocks that
// biases citizen behavior (jobs.js tickJobs) toward the "right" activity for the time of day,
// without overriding the needs-driven fallback -- a starving/exhausted citizen still breaks
// schedule to eat/sleep, see the CRITICAL_* overrides in jobs.js.

export const ScheduleBlock = Object.freeze({
  Sleep: 0,
  Work: 1,
  Recreation: 2,
});

// Full day/night cycle length in ticks. At 10Hz that's 240s (4 minutes) real time -- picked to
// be a handful of siege.js WaveSpawner intervals (30-60s each, see WaveSpawner.tick's `delay`)
// so a siege can plausibly land at any point in the cycle, including squarely at night, rather
// than the two systems drifting completely out of sync with each other.
export const DAY_NIGHT_CYCLE_TICKS = 2400;

// Default global regime -- every citizen follows this until per-citizen overrides exist (see
// FEATURE_RESEARCH.md stretch goal). Expressed as fractions of the cycle, matching
// SimWorld.timeOfDay's 0-1 range. Two Sleep blocks straddle midnight/cycle-wrap; two short
// Recreation blocks bookend the workday, PA-Regime-style.
const DEFAULT_SCHEDULE = [
  { start: 0.00, end: 0.22, block: ScheduleBlock.Sleep },
  { start: 0.22, end: 0.30, block: ScheduleBlock.Recreation },
  { start: 0.30, end: 0.80, block: ScheduleBlock.Work },
  { start: 0.80, end: 0.88, block: ScheduleBlock.Recreation },
  { start: 0.88, end: 1.00, block: ScheduleBlock.Sleep },
];

export function getScheduleBlock(timeOfDay, schedule = DEFAULT_SCHEDULE) {
  const t = ((timeOfDay % 1) + 1) % 1; // defensive wrap, timeOfDay should already be in [0,1)
  for (const b of schedule) if (t >= b.start && t < b.end) return b.block;
  return ScheduleBlock.Work;
}

// Convenience for UI (main.js topbar indicator) -- "night" as the sun/moon icon cares about it,
// which is a bit wider than the strict Sleep block so dusk/dawn read visually as night too.
export function isNight(timeOfDay) {
  const t = ((timeOfDay % 1) + 1) % 1;
  return t < 0.25 || t >= 0.85;
}

// Per-citizen Schedule override (RimWorld Schedule-tab style, the stretch goal referenced in the
// doc comment above -- now built). Lets the player pin one specific citizen to a fixed behavior
// bias regardless of the colony-wide cycle, e.g. force a citizen toward Work priority through the
// night, or toward Recreation/Sleep during the colony's normal workday. Values mirror
// ScheduleBlock exactly, offset by +1 so 0 can mean "no override" -- citizens.js's
// scheduleOverride field is a Uint8Array (zero-init), matching the same "0 means untouched"
// convention hasWorkPriorities/workPriority* already established for the per-citizen Work
// Priorities table.
export const ScheduleOverride = Object.freeze({
  None: 0,
  Sleep: ScheduleBlock.Sleep + 1,
  Work: ScheduleBlock.Work + 1,
  Recreation: ScheduleBlock.Recreation + 1,
});

export const SCHEDULE_OVERRIDE_LABELS = {
  [ScheduleOverride.None]: 'Colony schedule',
  [ScheduleOverride.Sleep]: 'Sleep (forced)',
  [ScheduleOverride.Work]: 'Work (forced)',
  [ScheduleOverride.Recreation]: 'Recreation (forced)',
};

// Resolves the effective schedule block jobs.js should use for one citizen this tick: their own
// override if the player has set one, otherwise the colony-wide block computed from
// world.timeOfDay via getScheduleBlock above. jobs.js's tickJobs calls this once per citizen and
// reuses the result everywhere it previously used the raw colony block (the Sleep-block
// interrupt check, the Idle-branch threshold bias, and findJoinableSite's scheduleBlock param) --
// so a citizen with no override (the default, every existing citizen/save) behaves byte-for-byte
// as before this feature existed.
export function effectiveScheduleBlock(overrideValue, colonyBlock) {
  if (overrideValue == null || overrideValue === ScheduleOverride.None) return colonyBlock;
  return overrideValue - 1;
}
