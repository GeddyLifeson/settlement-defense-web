// Sickness -- real RimWorld Flu disease-progression numbers, rescaled to this project. A mild,
// self-limiting debuff (deliberately NOT a threat -- no organ-failure/body-part model exists in
// this codebase to justify a death path, so severity is hard-capped well below anything lethal).
// Staggered-per-entity-roll pattern reused verbatim from rats.js (see that file's Rat._offset):
// citizens.js's CitizenStore carries a `_sickOffset` field so SICKNESS_CHECK_INTERVAL citizens
// don't all roll on the exact same tick, and mood integration reuses citizens.js's addMoodEvent
// (the same stacking/decaying "Thought" mechanic every other mood event in this project already
// uses) rather than a parallel mood-blending mechanic.
import { addMoodEvent, HYGIENE_SICK_THRESHOLD, HYGIENE_SICK_CHANCE_MULT } from './citizens.js';
import { DAY_NIGHT_CYCLE_TICKS } from './schedule.js';

export const SICKNESS_CHECK_INTERVAL = 50; // per-citizen onset-roll/mood-refresh cadence -- keep in sync
                                            // with citizens.js's CitizenStore.spawn() '50' literal
export const SICKNESS_CHANCE = 0.0015;     // per check, per healthy citizen

// Real Flu day-rates (RimWorld), rescaled to this project's DAY_NIGHT_CYCLE_TICKS. Kept exactly as
// specified for traceability to the source data, but NOT applied as two simultaneous opposing
// per-tick forces (verified analytically before shipping: WORSEN is fractionally larger than
// RECOVER -- 0.2488 vs 0.2388/day -- so a flat per-tick sum of the two converges to a stable
// equilibrium pinned at maxSeverity and never actually returns to 0, contradicting "self-resolves
// in ~1-2 in-game days" no matter how the onset value is tuned: once clamped at the cap, WORSEN's
// extra contribution is wasted by the clamp while RECOVER keeps subtracting in full, so recovery
// only ever wins once a case is already pinned at the ceiling, and climbing there at a net +0.01
// severity/day takes on the order of 45+ days from a small onset value, not 1-2).
//
// Instead: WORSEN sets the ONE-TIME onset jump (one day's worth of unchecked worsening, the real
// SeverityPerDay figure, capped defensively at maxSeverity), and RECOVER governs the ongoing,
// monotonic per-tick decline back to 0 -- this uses both real numbers verbatim and meaningfully,
// avoids the equilibrium trap entirely (no two opposing forces ever fight over the same tick), and
// lands almost exactly on the "~1-2 in-game days" target by construction: onset (0.2488) / RECOVER
// (0.2388/day) = ~1.04 days to fully clear.
export const SICKNESS_WORSEN_PER_TICK = 0.2488 / DAY_NIGHT_CYCLE_TICKS;
export const SICKNESS_RECOVER_PER_TICK = 0.2388 / DAY_NIGHT_CYCLE_TICKS;

// Never lethal by design -- no organ-failure/body-part-damage path exists in this codebase to
// justify death from sickness, this is a debuff, not a threat. Hard-capped well below anything
// that could plausibly read as dangerous.
export const SICKNESS_MAX_SEVERITY = 0.6;

// jobs.js applies this alongside the existing needsThrottleMultFor multiplier chain (Building/
// Harvesting/Processing rate calcs) -- see that file's call sites.
export const SICK_WORK_SPEED_MULT = 0.85;

const SICK_MOOD_MAGNITUDE = -0.08;
const SICK_MOOD_DURATION_TICKS = 2400; // one in-game day (schedule.js's DAY_NIGHT_CYCLE_TICKS) --
                                        // refreshed every SICKNESS_CHECK_INTERVAL below so it never
                                        // lapses mid-illness even though illness itself typically
                                        // clears within ~1 day (see the progression comment above).

function refreshSickMood(store, i, currentTick) {
  addMoodEvent(store, i, currentTick, { magnitude: SICK_MOOD_MAGNITUDE, durationTicks: SICK_MOOD_DURATION_TICKS, stackKey: 'sick' });
}

/** Per-citizen work-speed multiplier while sick -- jobs.js multiplies this into the same rate
 *  chain needsThrottleMultFor already feeds. Returns 1 (no penalty) if not currently sick. */
export function sickRateMultFor(store, i) {
  return store.isSickAt(i) ? SICK_WORK_SPEED_MULT : 1;
}

/** Staggered onset roll for healthy citizens + continuous progression for sick ones. Call once
 *  per tick from SimWorld.tick(). */
export function tickSickness(world) {
  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.isDownedAt(i)) continue; // incapacitated citizens don't roll for or progress illness

    const onStaggerCheck = (world.currentTick + (store._sickOffset[i] || 0)) % SICKNESS_CHECK_INTERVAL === 0;

    if (!store.isSickAt(i)) {
      if (!onStaggerCheck) continue;
      // Hygiene consequence (citizens.js's HYGIENE_SICK_THRESHOLD/HYGIENE_SICK_CHANCE_MULT, the
      // real "poor hygiene has real consequences" hookup the new Hygiene need calls for): a
      // citizen who's gone unwashed multiplies their own onset roll for this check, rather than
      // inventing a parallel penalty system -- reuses this exact mechanic, doesn't reskin it.
      const hygieneMult = (store.hygiene?.[i] ?? 1) < HYGIENE_SICK_THRESHOLD ? HYGIENE_SICK_CHANCE_MULT : 1;
      if (world.rng() < SICKNESS_CHANCE * hygieneMult) {
        store.sickSeverity[i] = Math.min(SICKNESS_MAX_SEVERITY, SICKNESS_WORSEN_PER_TICK * DAY_NIGHT_CYCLE_TICKS);
        refreshSickMood(store, i, world.currentTick);
      }
      continue;
    }

    // Already sick: recovers a little every tick (the real, rescaled day-rate); mood event
    // refreshed on the same staggered cadence as the onset roll so it doesn't lapse mid-illness.
    store.sickSeverity[i] = Math.max(0, store.sickSeverity[i] - SICKNESS_RECOVER_PER_TICK);
    if (onStaggerCheck) refreshSickMood(store, i, world.currentTick);
  }
}
