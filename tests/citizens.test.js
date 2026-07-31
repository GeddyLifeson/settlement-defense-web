// Content assertions on CitizenStore (SoA) semantics and the needs/mood decay system.
import { assert, section } from './harness.js';
import { CitizenStore, CitizenFlags, tickNeedsAndMood } from '../src/citizens.js';
import { makeRng } from '../src/core.js';

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

  // Downed citizens: needs must NOT decay further, only health recovers.
  const store2 = new CitizenStore(1);
  const j = store2.spawn('Downed', 0, 0, rng);
  store2.flags[j] |= CitizenFlags.Downed;
  store2.health[j] = 0.1;
  store2.hunger[j] = 0.5;
  tickNeedsAndMood(store2, isStaffAt, rng);
  assert(store2.hunger[j] === 0.5, 'a downed citizen\'s hunger does not decay while downed');
  assert(store2.health[j] > 0.1, 'a downed citizen\'s health passively recovers each tick');

  // On-duty staff get partial social fulfillment, so social decays slower than an off-duty citizen.
  const store3 = new CitizenStore(2);
  const staffI = store3.spawn('Guard', 0, 0, rng);
  const civI = store3.spawn('Civ', 0, 0, rng);
  tickNeedsAndMood(store3, (idx) => idx === staffI, rng);
  assert(store3.social[staffI] > store3.social[civI],
    'on-duty staff social decays slower than an off-duty citizen in the same tick (ON_DUTY_SOCIAL_FULFILLMENT)');
});
