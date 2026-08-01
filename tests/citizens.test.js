// Content assertions on CitizenStore (SoA) semantics and the needs/mood decay system.
import { assert, section } from './harness.js';
import { CitizenStore, CitizenFlags, tickNeedsAndMood } from '../src/citizens.js';
import { makeRng } from '../src/core.js';
import { randomPassions, Passion } from '../src/backstories.js';

section('CitizenStore.spawn / isAliveAt / isDownedAt / isOnBreakAt', () => {
  const store = new CitizenStore(4);
  const rng = makeRng(1);

  const i0 = store.spawn('Alice', 3, 4, rng);
  assert(i0 === 0, 'first spawn returns slot index 0');
  assert(store.count === 1, 'count increments after spawn');
  assert(store.id[i0] > 0, 'spawned citizen gets a nonzero id');
  assert(store.x[i0] === 3 && store.y[i0] === 4, 'spawn position is recorded');
  assert(store.isAliveAt(i0) === true, 'freshly spawned citizen is alive');
  assert(store.isDownedAt(i0) === false, 'freshly spawned citizen is not downed');
  assert(store.isOnBreakAt(i0) === false, 'freshly spawned citizen is not on break');
  assert(store.hunger[i0] === 1 && store.rest[i0] === 1 && store.social[i0] === 1 && store.mood[i0] === 1,
    'needs/mood all start at 1 (fully satisfied)');

  // Two distinct citizens get distinct ids and slots.
  const i1 = store.spawn('Bob', 0, 0, rng);
  assert(i1 === 1, 'second spawn returns slot index 1');
  assert(store.id[i1] !== store.id[i0], 'distinct citizens get distinct ids');

  // Capacity is hard -- spawn() returns -1 rather than growing past it.
  store.spawn('C', 0, 0, rng);
  store.spawn('D', 0, 0, rng);
  const overflow = store.spawn('Overflow', 0, 0, rng);
  assert(overflow === -1, 'spawn() returns -1 once capacity is exhausted, does not grow the store');
  assert(store.count === 4, 'count does not exceed capacity after a rejected spawn');

  // Dead flag flips isAliveAt off even if the raw alive byte is untouched.
  store.flags[i0] |= CitizenFlags.Dead;
  assert(store.isAliveAt(i0) === false, 'isAliveAt is false once the Dead flag bit is set');
  store.flags[i0] &= ~CitizenFlags.Dead;

  // alive=0 also makes isAliveAt false (the two conditions are independently sufficient).
  store.alive[i1] = 0;
  assert(store.isAliveAt(i1) === false, 'isAliveAt is false when the alive byte is 0, regardless of flags');
  store.alive[i1] = 1;

  // Downed/OnBreak are independent bit flags, not mutually exclusive with each other or with alive.
  store.flags[i0] |= CitizenFlags.Downed;
  assert(store.isDownedAt(i0) === true, 'isDownedAt reflects the Downed bit');
  assert(store.isAliveAt(i0) === true, 'being downed does not by itself make a citizen not-alive');
  store.flags[i0] |= CitizenFlags.OnBreak;
  assert(store.isOnBreakAt(i0) === true, 'Downed and OnBreak flags can both be set simultaneously');
});

section('tickNeedsAndMood: decay direction and 0-1 clamping', () => {
  const store = new CitizenStore(2);
  const rng = makeRng(2);
  const i = store.spawn('Worker', 0, 0, rng);
  const isStaffAt = () => false;

  const hunger0 = store.hunger[i], rest0 = store.rest[i], social0 = store.social[i];
  tickNeedsAndMood(store, isStaffAt, rng);
  assert(store.hunger[i] < hunger0, 'hunger decays (decreases) over a tick for a non-downed citizen');
  assert(store.rest[i] < rest0, 'rest decays (decreases) over a tick');
  assert(store.social[i] < social0, 'social decays (decreases) over a tick');
  assert(store.mood[i] <= 1 && store.mood[i] >= 0, 'mood stays within [0,1] after a tick');

  // Run needs down to (and past) zero over many ticks -- must clamp at 0, never go negative.
  for (let t = 0; t < 10000; t++) tickNeedsAndMood(store, isStaffAt, rng);
  assert(store.hunger[i] === 0, 'hunger clamps at exactly 0, does not go negative');
  assert(store.rest[i] === 0, 'rest clamps at exactly 0, does not go negative');
  assert(store.social[i] === 0, 'social clamps at exactly 0, does not go negative');
  assert(store.mood[i] >= 0 && store.mood[i] <= 1, 'mood stays within [0,1] even after prolonged decay to zero needs');
  assert(store.mood[i] < 0.13, 'mood has eased down toward the (now ~0) need average after prolonged decay');
  assert(store.isOnBreakAt(i) === true, 'a citizen whose mood has collapsed below the break threshold is flagged OnBreak');

  // Downed citizens: needs must NOT decay further. Health behavior now depends on tended status
  // (citizens.js's UNTENDED_BLEED_RATE/TEND_RECOVERY_RATE) -- an untended citizen used to
  // passively recover too (just slower than a tended one), which meant tending only ever mattered
  // for SPEED, never survival. See citizens.js's UNTENDED_BLEED_RATE doc comment for why this
  // changed and how conservatively it's tuned.
  const store2 = new CitizenStore(1);
  const j = store2.spawn('Downed', 0, 0, rng);
  store2.flags[j] |= CitizenFlags.Downed;
  store2.health[j] = 0.1;
  store2.hunger[j] = 0.5;
  tickNeedsAndMood(store2, isStaffAt, rng);
  assert(store2.hunger[j] === 0.5, 'a downed citizen\'s hunger does not decay while downed');
  assert(store2.health[j] < 0.1, 'an UNTENDED downed citizen now slowly bleeds (loses health) each tick instead of auto-recovering');

  // An actively-tended downed citizen still recovers -- beingTended is read-then-cleared each
  // tick by tickNeedsAndMood (see that function's own doc comment on the exact ordering), so
  // setting it before the call simulates jobs.js's Tending job handler having run last tick.
  const store2b = new CitizenStore(1);
  const jb = store2b.spawn('Tended', 0, 0, rng);
  store2b.flags[jb] |= CitizenFlags.Downed;
  store2b.health[jb] = 0.1;
  store2b.beingTended[jb] = 1;
  tickNeedsAndMood(store2b, isStaffAt, rng);
  assert(store2b.health[jb] > 0.1, 'a downed citizen actively being tended still recovers each tick');

  // Untended bleed-out is genuinely fatal after prolonged neglect, and reuses the standard
  // Dead-flag + alive=0 pattern (siege.js's own convention) -- a real new death path, not a status
  // effect that just caps out.
  const store2c = new CitizenStore(1);
  const jc = store2c.spawn('Bleeding out', 0, 0, rng);
  store2c.flags[jc] |= CitizenFlags.Downed;
  store2c.health[jc] = 0.05;
  for (let t = 0; t < 20000 && store2c.isAliveAt(jc); t++) tickNeedsAndMood(store2c, isStaffAt, rng);
  assert(store2c.isAliveAt(jc) === false, 'a downed citizen left completely untended for a long time eventually dies');
  assert((store2c.flags[jc] & CitizenFlags.Dead) !== 0, 'death from untended bleed-out sets the Dead flag, same pattern as siege.js combat deaths');

  // Permanent scars: maxHealth starts at 1 and is never reduced by ordinary tended recovery.
  assert(store2b.maxHealth[jb] === 1, 'maxHealth defaults to 1 (no scars yet) for a freshly spawned citizen');

  // On-duty staff get partial social fulfillment, so social decays slower than an off-duty citizen.
  const store3 = new CitizenStore(2);
  const staffI = store3.spawn('Guard', 0, 0, rng);
  const civI = store3.spawn('Civ', 0, 0, rng);
  tickNeedsAndMood(store3, (idx) => idx === staffI, rng);
  assert(store3.social[staffI] > store3.social[civI],
    'on-duty staff social decays slower than an off-duty citizen in the same tick (ON_DUTY_SOCIAL_FULFILLMENT)');
});

section('traits.js forcedPassion/conflictingPassion (backstories.js randomPassions)', () => {
  const rng = makeRng(7);

  // forcedPassion always resolves to Burning, regardless of the rng draw or backstory bias --
  // run it many times with different rng states to make sure it's a real override, not a biased
  // roll that just usually lands on Burning.
  let allBurningCombat = true;
  for (let t = 0; t < 50; t++) {
    const p = randomPassions(rng, null, { forcedPassion: { skill: 'combat' } });
    if (p.combat !== Passion.Burning) allBurningCombat = false;
  }
  assert(allBurningCombat, 'forcedPassion always resolves to Burning for its named skill, every roll');

  // forcedPassion on combat must not affect the OTHER skill's roll -- construction should still
  // vary across many draws (i.e. forcedPassion is scoped to exactly one named skill).
  const constructionResults = new Set();
  for (let t = 0; t < 50; t++) {
    const p = randomPassions(rng, null, { forcedPassion: { skill: 'combat' } });
    constructionResults.add(p.construction);
  }
  assert(constructionResults.size > 1, 'forcedPassion on one skill leaves the other skill rolling normally (varies across draws)');

  // conflictingPassion caps its named skill at Minor -- Burning should never appear for it across
  // many draws, even though the unrestricted roll would produce Burning some of the time.
  let anyBurningConflicting = false;
  for (let t = 0; t < 200; t++) {
    const p = randomPassions(rng, null, { conflictingPassion: 'combat' });
    if (p.combat === Passion.Burning) anyBurningConflicting = true;
  }
  assert(!anyBurningConflicting, 'conflictingPassion caps its named skill at Minor -- Burning never rolls for it');

  // With no trait override at all, Burning DOES appear across enough draws (sanity check that the
  // conflictingPassion test above is actually exercising a real cap, not a coincidentally-quiet RNG).
  let anyBurningUnrestricted = false;
  for (let t = 0; t < 200; t++) {
    const p = randomPassions(rng, null, null);
    if (p.combat === Passion.Burning) anyBurningUnrestricted = true;
  }
  assert(anyBurningUnrestricted, 'sanity check: an unrestricted roll does produce Burning sometimes (confirms the cap above is real)');
});

section('citizens.js skill rust (disuse decay)', () => {
  const rng = makeRng(11);

  // A skill that's never used should decay after the multi-thousand-tick idle grace period --
  // deliberately does NOT touch skillCombat/skillConstruction directly (that would itself count
  // as "use" via the snapshot-diff detector), just lets ticks pass.
  const store = new CitizenStore(1);
  const i = store.spawn('Idle Veteran', 0, 0, rng);
  store.skillCombat[i] = 1.0;
  store._skillCombatSnapshot[i] = 1.0; // re-baseline after the manual set above, same as a real gain would
  const isStaffAt = () => false;
  for (let t = 0; t < 6000; t++) tickNeedsAndMood(store, isStaffAt, rng);
  assert(store.skillCombat[i] < 1.0, 'an unused skillCombat value decays after a long enough idle stretch');
  assert(store.skillCombat[i] > 0.9, 'skill rust is a slow, conservative decay -- not a big loss over 6000 idle ticks');

  // A skill that keeps gaining (simulated here by bumping it directly every tick, standing in for
  // jobs.js/siege.js actually granting it) should NOT decay -- the snapshot-diff detector must see
  // each gain and keep resetting the idle counter.
  const store2 = new CitizenStore(1);
  const j = store2.spawn('Busy Worker', 0, 0, rng);
  store2.skillCombat[j] = 1.0;
  store2._skillCombatSnapshot[j] = 1.0;
  for (let t = 0; t < 6000; t++) {
    store2.skillCombat[j] += 0.0001; // stands in for a real gain from jobs.js/siege.js/etc.
    tickNeedsAndMood(store2, isStaffAt, rng);
  }
  assert(store2.skillCombat[j] > 1.0, 'a skillCombat value that keeps gaining every tick never rusts');
});
