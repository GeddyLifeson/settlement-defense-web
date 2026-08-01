// Inspirations (RimWorld's real random positive Mental State roll -- Inspired_Work/Frenzy_Work et
// al, condensed to a single kind for v1). Unlike a mental BREAK (citizens.js's BREAK_TIERS, a
// threshold-triggered NEGATIVE state that fires once mood drops too LOW), an Inspiration is a rare,
// chance-rolled POSITIVE event gated on a citizen's mood already being good -- same "staggered
// per-citizen roll" shape as sickness.js's onset check (citizens.js's _sickOffset/
// SICKNESS_CHECK_INTERVAL precedent) rather than BREAK_TIERS' continuous threshold, since RimWorld's
// own Inspired mental state really is a periodic random roll gated on decent psychological health,
// not a threshold crossing.
//
// v1 scope, per the design brief: one kind only -- a temporary work-speed multiplier (RimWorld's
// real Frenzy_Work is 1.8x for several in-game days, used verbatim below). jobs.js's Building/
// Harvesting/Processing/Farming/Restaurant/Cleaning rate chains all already multiply in
// breakRateMultFor/needsThrottleMultFor/sickRateMultFor/dependencyRateMultFor at the same call
// site -- inspirationWorkSpeedMultFor below slots into that exact same chain, same pattern.
//
// Ticked from citizens.js's tickNeedsAndMood (called every tick from world.js already, see that
// function's own call to rollInspiration below) rather than getting its own SimWorld.tick() entry
// point -- wiring this feature in needed zero changes to world.js's tick() sequencing. Deliberately
// has NO dependency on citizens.js (every access below goes through the passed-in `store` instance's
// own fields/methods, duck-typed, not an import) so citizens.js can safely import THIS file without
// any risk of the circular-import hazard documented on citizens.js's own _sickOffset field (that one
// exists because sickness.js imports FROM citizens.js -- this file doesn't, so there's nothing to
// avoid importing back).
//
// Store fields this relies on (added to CitizenStore in citizens.js, same SoA precedent as every
// other per-citizen timer in that file): `inspiredUntilTick` (Float32Array, a tick value -- currently
// inspired while world.currentTick < this, same "Until" convention as citizens.js's own
// epidemicImmuneUntil) and `_inspirationOffset` (Uint16Array, staggers the per-citizen roll the same
// way _sickOffset/_epidemicOffset already do).

export const INSPIRATION_CHECK_INTERVAL = 50; // same staggered-roll cadence as sickness.js's SICKNESS_CHECK_INTERVAL
// Deliberately rarer than SICKNESS_CHANCE (0.0015 per check) -- a positive standout event
// shouldn't fire more often than the mild debuff it's the mirror image of.
export const INSPIRATION_CHANCE = 0.0008; // per check, per eligible citizen
// RimWorld's own Inspired mental state requires decent psychological health to trigger at all --
// mirrored here via this project's existing 0-1 mood scale, set comfortably above citizens.js's
// BREAK_MOOD_THRESHOLD (0.35) so the two states can never contest the same mood range.
const INSPIRATION_MOOD_THRESHOLD = 0.65;
// "Several days" in RimWorld's real Frenzy_Work, scaled down to this project's much faster tick
// clock -- bounded, not a permanent buff (schedule.js's DAY_NIGHT_CYCLE_TICKS is on the order of a
// couple thousand ticks per in-game day, so this is a healthy multi-minute window, not a token blip).
const INSPIRATION_DURATION_TICKS = 1500;
export const INSPIRATION_WORK_SPEED_MULT = 1.8; // RimWorld's real Frenzy_Work multiplier, used verbatim

/** Staggered per-citizen roll for a NEW inspiration. Only ever starts one if the citizen isn't
 *  already inspired, isn't on break (RimWorld: a pawn already in a mental break can't also become
 *  Inspired -- the two states are mutually exclusive there too), and has strong mood. Call once per
 *  tick per living, non-downed citizen from citizens.js's tickNeedsAndMood -- a no-op most ticks
 *  (the stagger gate alone rejects 49/50 calls before the mood/chance rolls are even reached). */
export function rollInspiration(store, i, currentTick, rng) {
  if (store.inspiredUntilTick[i] > currentTick) return; // already inspired, nothing to roll
  if (store.isOnBreakAt(i)) return;
  const onStaggerCheck = (currentTick + (store._inspirationOffset[i] || 0)) % INSPIRATION_CHECK_INTERVAL === 0;
  if (!onStaggerCheck) return;
  if (store.mood[i] < INSPIRATION_MOOD_THRESHOLD) return;
  if (rng() < INSPIRATION_CHANCE) {
    store.inspiredUntilTick[i] = currentTick + INSPIRATION_DURATION_TICKS;
  }
}

/** Per-citizen work-speed multiplier while inspired -- jobs.js multiplies this into the SAME rate
 *  chain breakRateMultFor/needsThrottleMultFor/sickRateMultFor/dependencyRateMultFor already feed
 *  (Building/Harvesting/Processing/Farming/Restaurant/Cleaning). Returns 1 (no bonus, byte-for-byte
 *  the old behavior) whenever the citizen isn't currently inspired. */
export function inspirationWorkSpeedMultFor(store, i, currentTick) {
  return store.inspiredUntilTick[i] > currentTick ? INSPIRATION_WORK_SPEED_MULT : 1;
}
