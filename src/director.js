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
  trackCitizenDowned(world);

  const strength = colonyStrength(world);
  const mult = AGGRESSION_MULTIPLIER[world.aggression] ?? 1;
  const teller = STORYTELLERS[world.storyteller] || STORYTELLERS.Cassandra;

  const strengthTerm = (strength / 120) * mult;
  const randomTerm = 0.7 + world.rng() * 0.9; // Randy leans almost entirely on this
  const blended = strengthTerm * teller.strengthWeight + randomTerm * (1 - teller.strengthWeight);

  // Pollution scales the danger multiplier upward -- mismanaged waste literally makes the
  // siege worse, independent of the storyteller's own curve.
  const pollutionTerm = 1 + Math.min(1.2, (world.pollution || 0) / 200);

  // Early-game ramp + comeback mercy (both real RimWorld pacing behaviors, see the block below)
  // -- two more multiplicative knobs on strengthFactor, same shape as pollutionTerm above rather
  // than a parallel strength system.
  const rampTerm = earlyGameRampMult(world.currentTick);
  const mercyTerm = comebackMercyMult(world);

  world.waveSpawner.strengthFactor = Math.max(0.5, Math.min(1.8, blended * pollutionTerm * rampTerm * mercyTerm));
  world.waveSpawner.cycleMult = teller.cycleMultMin != null
    ? teller.cycleMultMin + world.rng() * (teller.cycleMultMax - teller.cycleMultMin)
    : teller.cycleMult;
  world.waveSpawner.doubleChance = teller.doubleChance;
}

// ---------------------------------------------------------------- comeback mercy + early ramp
// Real RimWorld pacing behaviors this ports (see task brief): (a) raid pressure backs off for
// several days after a colonist goes down -- the player isn't punished further while already
// reeling -- and (b) a fresh colony doesn't see full-strength raids from tick 0; strength ramps
// up over roughly the first ~40 days. Both apply as extra multiplicative terms on strengthFactor
// above, right alongside pollutionTerm, not a second strength system.
//
// Neither is scaled off schedule.js's DAY_NIGHT_CYCLE_TICKS (2400 ticks/day, tuned for visual
// day/night cycling) -- a literal "40 days * 2400 ticks/day" is 96000 ticks, which dwarfs a full
// hands-off game (weather.js's HAZARD_EARLIEST_TICK comment: "roughly a third into a healthy
// 22-36k-tick game", i.e. a full game tops out around 36000 ticks). Taken literally, the ramp
// would never actually finish inside a real playthrough and "reaches full strength" would never
// be observed -- the opposite of the real mechanic's intent (40 days is early game, not most of
// a RimWorld playthrough that commonly runs hundreds of days). Scaled instead against that same
// real, already-established 22-36k-tick game-length benchmark so the ramp reads as "early game"
// the same way HAZARD_EARLIEST_TICK reads as "late game" against the same anchor.
export const WAVE_RAMP_TICKS = 6000;      // ~1/5-1/6 of a healthy 22-36k-tick game -- early, not most of it
export const WAVE_RAMP_FLOOR = 0.7;       // real RimWorld number per the task brief: 70% at tick 0
export const MERCY_COOLDOWN_TICKS = 2500; // roughly 4-5 early wave cycles' worth of breathing room
                                           // (siege.js's WaveSpawner base delay is 300-600 ticks/wave
                                           // before cycleMult/strengthFactor scale it) -- "several
                                           // days" of real quiet reads here as "skip the next several
                                           // raids' worth of ramped-up pressure", not a game-spanning
                                           // phase the way the ramp above is
export const MERCY_STRENGTH_FLOOR = 0.7;  // same floor as the early ramp -- both are "colony
                                           // temporarily under strength", deliberately unified
                                           // rather than two arbitrary numbers

/** Linear ramp from WAVE_RAMP_FLOOR at tick 0 to 1.0 at WAVE_RAMP_TICKS and beyond -- real
 *  RimWorld raid scaling isn't full-strength from the moment a colony starts. */
function earlyGameRampMult(currentTick) {
  if (currentTick >= WAVE_RAMP_TICKS) return 1;
  const frac = Math.max(0, currentTick) / WAVE_RAMP_TICKS;
  return WAVE_RAMP_FLOOR + (1 - WAVE_RAMP_FLOOR) * frac;
}

/** Scans for a rise in the colony's currently-downed-citizen count since the last call and, if
 *  seen, stamps world.lastCitizenDownedTick. Self-contained polling rather than a callback hook:
 *  directWaveSpawner already runs every tick (world.js's tick(), same call site director.js has
 *  always used) and has the exact same read access to world.citizens that siege.js/citizens.js
 *  do -- see coverageplans.js's isAliveAt+isDownedAt convention, reused here. world.js already
 *  exposes an onCitizenDowned callback fired on the same transition (see that file, wired to
 *  audio in main.js), but chaining onto it would mean editing world.js/main.js's assignment,
 *  outside this task's owned files -- polling world.citizens directly avoids needing that.
 *  world.lastCitizenDownedTick is a plain public field; if a more precise hook is ever wired in
 *  from siege.js's own downed-transition code (see that file's onDowned callback) it can just
 *  set the same field directly instead, no change needed here. Known limitation of polling by
 *  count rather than by per-citizen transition: if one citizen recovers the exact same tick
 *  another goes down, the net count is unchanged and this misses the new-down event -- rare, and
 *  "several days of mercy" is flavor pacing, not a precision requirement. */
function trackCitizenDowned(world) {
  let downedCount = 0;
  for (let i = 0; i < world.citizens.count; i++) {
    if (world.citizens.isAliveAt(i) && world.citizens.isDownedAt(i)) downedCount++;
  }
  if (world._directorLastDownedCount == null) world._directorLastDownedCount = downedCount;
  if (downedCount > world._directorLastDownedCount) world.lastCitizenDownedTick = world.currentTick;
  world._directorLastDownedCount = downedCount;
}

/** Linear taper from MERCY_STRENGTH_FLOOR back to 1.0 over MERCY_COOLDOWN_TICKS after the most
 *  recent citizen-downed tick -- 1 (no effect) if nothing has gone down yet, or the window has
 *  already elapsed. */
function comebackMercyMult(world) {
  if (world.lastCitizenDownedTick == null) return 1;
  const sinceDowned = world.currentTick - world.lastCitizenDownedTick;
  if (sinceDowned >= MERCY_COOLDOWN_TICKS) return 1;
  const frac = Math.max(0, sinceDowned) / MERCY_COOLDOWN_TICKS;
  return MERCY_STRENGTH_FLOOR + (1 - MERCY_STRENGTH_FLOOR) * frac;
}
