// Condensed personality traits, matching the RimWorld side of the GDD ("needs/mood/traits").
// Each citizen gets exactly one at spawn; traits are flavor + a small numeric nudge, not a
// deep system, since the core loop doesn't depend on them.
export const TRAITS = [
  { name: 'Tough', healthMult: 1.3, hungerMult: 1, restMult: 1, socialGainMult: 1 },
  { name: 'Fast', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, speedMult: 1.3 },
  { name: 'Sociable', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1.5 },
  { name: 'Insomniac', healthMult: 1, hungerMult: 1, restMult: 1.4, socialGainMult: 1 },
  { name: 'Glutton', healthMult: 1, hungerMult: 1.4, restMult: 1, socialGainMult: 1 },
  { name: 'Hardy', healthMult: 1.15, hungerMult: 0.85, restMult: 0.85, socialGainMult: 1 },
  { name: 'Loner', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 0.5 },
  { name: 'Steady', healthMult: 1, hungerMult: 0.9, restMult: 0.9, socialGainMult: 0.9 },
];

export function randomTrait(rng) {
  return TRAITS[Math.floor(rng() * TRAITS.length)];
}
