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
