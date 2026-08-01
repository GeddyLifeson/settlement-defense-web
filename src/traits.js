// Condensed personality traits, matching the RimWorld side of the GDD ("needs/mood/traits").
// Each citizen gets exactly one at spawn; traits are flavor + a small numeric nudge, not a
// deep system, since the core loop doesn't depend on them.
// workSpeedMult: RimWorld's Industriousness spectrum (WorkSpeedGlobal) -- multiplies build/harvest
// rate in jobs.js. Real offsets: -0.35 slothful / -0.20 lazy / +0.20 hard worker / +0.35 industrious,
// applied here as multipliers around 1.0 (e.g. +0.35 -> 1.35). Undefined/omitted == 1 (no change),
// same null-safe convention as the other per-trait multipliers below.
//
// breakThresholdOffset: RimWorld's Neurotic spectrum (MentalBreakThreshold) -- added to the base
// BREAK_MOOD_THRESHOLD in citizens.js before the on-break check, so a positive offset means this
// citizen starts breaking down at a *higher* mood (breaks more easily) and a negative offset means
// they tolerate lower mood before breaking. Real range +0.08 to +0.14 (Neurotic); we also allow a
// small negative for the calm counterpart. Undefined/omitted == 0 (no change).
export const TRAITS = [
  { name: 'Tough', healthMult: 1.3, hungerMult: 1, restMult: 1, socialGainMult: 1 },
  { name: 'Fast', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, speedMult: 1.3 },
  { name: 'Sociable', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1.5 },
  { name: 'Insomniac', healthMult: 1, hungerMult: 1, restMult: 1.4, socialGainMult: 1 },
  { name: 'Glutton', healthMult: 1, hungerMult: 1.4, restMult: 1, socialGainMult: 1 },
  { name: 'Hardy', healthMult: 1.15, hungerMult: 0.85, restMult: 0.85, socialGainMult: 1 },
  { name: 'Loner', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 0.5 },
  // Steady: already a calmer, more even-keeled flavor (reduced hunger/rest/social decay) -- paired
  // here with a negative breakThresholdOffset (RimWorld-style: harder to push into a mental break).
  { name: 'Steady', healthMult: 1, hungerMult: 0.9, restMult: 0.9, socialGainMult: 0.9, breakThresholdOffset: -0.08 },
  // Industriousness spectrum (work speed only, no needs/mood nudge -- matches RimWorld's own
  // Industriousness trait, which is purely a WorkSpeedGlobal modifier).
  { name: 'Industrious', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, workSpeedMult: 1.35 },
  { name: 'Hard Worker', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, workSpeedMult: 1.2 },
  { name: 'Lazy', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, workSpeedMult: 0.65 },
  // Neurotic: the real RimWorld tradeoff pairing -- breaks down more easily (raised break
  // threshold) but works faster while stable, so it's a genuine risk/reward pick rather than a
  // strict downgrade.
  { name: 'Neurotic', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, workSpeedMult: 1.15, breakThresholdOffset: 0.12 },
];

export function randomTrait(rng) {
  return TRAITS[Math.floor(rng() * TRAITS.length)];
}
