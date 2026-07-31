// Condensed from RimWorld's AI Storyteller pattern (see FEATURE_RESEARCH.md): the three
// personalities are just different parameter sets over one scheduler, not three separate
// systems. Also folds in SEA:R's signature mechanic -- unmanaged pollution makes waves worse,
// a player-controlled difficulty input distinct from RimWorld's wealth-based one.
export function colonyStrength(world) {
  let aliveCitizens = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) aliveCitizens++;

  let structureHealth = 0;
  for (const s of world.structures) if (!s.destroyed && !s.underConstruction) structureHealth += s.health;

  // Scrap uses sqrt rather than a linear term. Idle citizens auto-harvest resource nodes even in
  // a completely hands-off colony (jobs.js's idle-fallback), so scrap keeps growing forever with
  // zero player action or actual defensive investment -- a linear term let banked scrap alone
  // saturate strengthFactor to its cap within a few thousand ticks (the root cause of a real
  // regression: hands-off survival time dropping from ~22-36k ticks to ~7-10k ticks, caught in
  // soak-testing). Sqrt keeps scrap a meaningful wealth signal without letting passive
  // accumulation alone drive difficulty as hard as actually-built defense/population.
  return aliveCitizens * 2 + structureHealth * 3 + Math.sqrt(world.scrap) * 1.5;
}

const AGGRESSION_MULTIPLIER = { Calm: 0.75, Standard: 1, Aggressive: 1.35 };

// cycleMult: multiplies the base wave-delay formula (bigger = longer breathers).
// doubleChance: odds a wave, once due, immediately schedules a second one close behind.
// strengthWeight: how much colony strength (vs. flat randomness) drives wave size/timing --
// Randy ignores it almost entirely, matching "no curve at all" in the source game.
// cycleMult tuned relative to 1.0 = the original pre-storyteller baseline (soak-tested at
// ~22-36 min hands-off survival); Cassandra sits AT that baseline rather than below it --
// "least forgiving of the three" should mean "no bonus breathing room", not "actively worse
// than the game was before storytellers existed". First-pass numbers here made ALL three
// personalities collapse a hands-off colony in ~12-17 min, a real regression caught in
// soak-testing -- these are the corrected values, re-verify after any further tuning.
export const STORYTELLERS = {
  Cassandra: { cycleMult: 1.0, doubleChance: 0.12, strengthWeight: 1.0 },
  Phoebe: { cycleMult: 1.8, doubleChance: 0.02, strengthWeight: 0.75 },
  Randy: { cycleMultMin: 0.7, cycleMultMax: 1.6, doubleChance: 0.08, strengthWeight: 0.15 }, // randomized per-wave, not fixed -- "no curve at all"
};

export function directWaveSpawner(world) {
  const strength = colonyStrength(world);
  const mult = AGGRESSION_MULTIPLIER[world.aggression] ?? 1;
  const teller = STORYTELLERS[world.storyteller] || STORYTELLERS.Cassandra;

  const strengthTerm = (strength / 120) * mult;
  const randomTerm = 0.7 + world.rng() * 0.9; // Randy leans almost entirely on this
  const blended = strengthTerm * teller.strengthWeight + randomTerm * (1 - teller.strengthWeight);

  // Pollution scales the danger multiplier upward -- mismanaged waste literally makes the
  // siege worse, independent of the storyteller's own curve.
  const pollutionTerm = 1 + Math.min(1.2, (world.pollution || 0) / 200);

  world.waveSpawner.strengthFactor = Math.max(0.5, Math.min(1.8, blended * pollutionTerm));
  world.waveSpawner.cycleMult = teller.cycleMultMin != null
    ? teller.cycleMultMin + world.rng() * (teller.cycleMultMax - teller.cycleMultMin)
    : teller.cycleMult;
  world.waveSpawner.doubleChance = teller.doubleChance;
}
