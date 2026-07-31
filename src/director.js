// Condensed from SD.Director: a storyteller that nudges wave timing/size to match colony
// strength, so the siege stays challenging without being unfair to a struggling colony.
export function colonyStrength(world) {
  let aliveCitizens = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) aliveCitizens++;

  let structureHealth = 0;
  for (const s of world.structures) if (!s.destroyed) structureHealth += s.health;

  return aliveCitizens * 2 + structureHealth * 3 + world.scrap * 0.1;
}

const AGGRESSION_MULTIPLIER = { Calm: 0.75, Standard: 1, Aggressive: 1.35 };

export function directWaveSpawner(world) {
  const strength = colonyStrength(world);
  const mult = AGGRESSION_MULTIPLIER[world.aggression] ?? 1;
  // Stronger colonies get shorter breathers and slightly bigger waves; weak colonies get
  // more breathing room, matching a RimWorld-style storyteller that chases player capability.
  world.waveSpawner.strengthFactor = Math.max(0.6, Math.min(1.8, (strength / 120) * mult));
}
