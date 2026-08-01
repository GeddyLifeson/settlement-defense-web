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

// ---------------------------------------------------------------- age bands (RimWorld Biotech
// LifeStageDef, condensed). Real RimWorld LifeStageDefs are just a bundle of flat multipliers
// keyed by age band (bodySize/health/speed/melee/hunger) -- the exact same shape as the trait
// multipliers above, so this is a second lookup table of the same kind rather than a parallel
// system. `age` (citizens.js) is ticks-since-spawn; maxAge is the upper (exclusive) tick bound
// for a band, Infinity for the last one. Looked up once per citizen per tick and multiplied
// straight into the SAME rate expressions jobs.js already builds from trait.workSpeedMult
// (`* ageBandFor(store.age[i]).workSpeedMult`) and siege.js's trait.healthMult (toughness --
// higher healthMult means LESS damage taken per hit, see siege.js's `DAMAGE / healthMult`).
//
// Real RimWorld pre-teen anchor (MoveSpeed x0.85) adapted directionally for an elder band: reduced
// work-speed (0.85-0.9 range, matching the ask) and a reduced health ceiling/toughness (elders take
// real hits harder, same shape as a Neurotic/Glutton downside trait). Compensating "wisdom"
// tradeoff, a genuine deliberate design call rather than pure decline: a real skill-gain-RATE
// bonus (not a starting-skill bonus -- an elder isn't smarter on day one, they just learn faster
// from the practice they're already getting, mirroring backstories.js's own Passion mechanic
// exactly, see PASSION_GAIN_MULT). Applied as `ageBandFor(store.age[i]).skillGainMult` alongside
// the existing PASSION_GAIN_MULT term at every skill-gain site in jobs.js/siege.js -- multiplicative
// with passion, not a replacement for it, same "stacks, doesn't override" convention as every other
// multiplier table in this file.
export const AGE_BANDS = [
  // Young: default band, every multiplier at baseline -- a citizen who never crosses either
  // threshold behaves byte-for-byte as if this feature didn't exist.
  { name: 'Young', maxAge: 20000, workSpeedMult: 1, healthMult: 1, skillGainMult: 1 },
  // Veteran: real RimWorld pre-teen MoveSpeed anchor (x0.85) landed at the gentler end of the
  // requested 0.85-0.9 workSpeedMult range; skillGainMult mirrors backstories.js's own Minor
  // Passion tier (1.5x) so "experience" reads on the same scale as the existing wisdom-adjacent
  // mechanic rather than inventing a new one.
  { name: 'Veteran', maxAge: 45000, workSpeedMult: 0.9, healthMult: 0.95, skillGainMult: 1.5 },
  // Elder: the top of the requested workSpeedMult range, a further-reduced health ceiling (more
  // toughness lost than Veteran, same direction as real RimWorld's old-age HP/immunity decline),
  // and a skillGainMult matching backstories.js's Burning Passion tier (2.5x) -- the "wisdom"
  // payoff is at its largest exactly where the physical decline is also at its largest, a genuine
  // tradeoff rather than a strict downgrade.
  { name: 'Elder', maxAge: Infinity, workSpeedMult: 0.85, healthMult: 0.88, skillGainMult: 2.5 },
];

export function ageBandFor(age) {
  for (const band of AGE_BANDS) if (age < band.maxAge) return band;
  return AGE_BANDS[AGE_BANDS.length - 1];
}
