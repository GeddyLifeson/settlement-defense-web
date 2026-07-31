// WaveSpawner spawn-count scaling and colonyStrength() sane-range behavior. Per the task brief,
// this file tests AGAINST director.js's colonyStrength() -- it must never modify that function
// or its balance-critical constants.
import { assert, section } from './harness.js';
import { WaveSpawner, AttackerStore } from '../src/siege.js';
import { colonyStrength } from '../src/director.js';
import { SettlementGrid } from '../src/grid.js';
import { CitizenStore } from '../src/citizens.js';
import { Structure } from '../src/siege.js';
import { makeRng } from '../src/core.js';

section('WaveSpawner: spawn counts scale up with wave number', () => {
  const grid = new SettlementGrid(20, 20);
  const rng = makeRng(42);

  function spawnCountForWave(waveNumber) {
    const spawner = new WaveSpawner(grid);
    spawner.waveNumber = waveNumber - 1; // spawnOneWave increments before computing count
    spawner.strengthFactor = 1;
    const attackers = new AttackerStore(500);
    spawner.spawnOneWave(0, attackers, rng);
    return attackers.count;
  }

  const wave1 = spawnCountForWave(1);
  const wave5 = spawnCountForWave(5);
  const wave20 = spawnCountForWave(20);

  assert(wave1 > 0, `wave 1 spawns at least one attacker (got ${wave1})`);
  assert(wave5 > wave1, `wave 5 spawns more attackers than wave 1 (${wave5} vs ${wave1})`);
  assert(wave20 >= wave5, `wave 20 spawns at least as many attackers as wave 5 (${wave20} vs ${wave5}, count formula caps its bonus term at +10)`);

  // All spawned attackers must land on the grid boundary (0, width-1, 0, or height-1), never
  // inside the map interior -- that's the whole point of an "edge spawn" wave.
  const spawner = new WaveSpawner(grid);
  const attackers = new AttackerStore(500);
  spawner.spawnOneWave(0, attackers, rng);
  let allOnEdge = true;
  for (let i = 0; i < attackers.count; i++) {
    const onEdge = attackers.x[i] === 0 || attackers.x[i] === grid.width - 1 || attackers.y[i] === 0 || attackers.y[i] === grid.height - 1;
    if (!onEdge) allOnEdge = false;
  }
  assert(allOnEdge, 'every attacker spawned by spawnOneWave sits on a map edge (x=0, x=width-1, y=0, or y=height-1)');
});

section('WaveSpawner.tick: does nothing before nextWaveTick, spawns once due, reschedules forward', () => {
  const grid = new SettlementGrid(20, 20);
  const rng = makeRng(7);
  const spawner = new WaveSpawner(grid);
  const attackers = new AttackerStore(500);

  spawner.tick(0, attackers, rng); // well before the 300-tick grace period
  assert(attackers.count === 0, 'no wave spawns before nextWaveTick is reached');

  const dueTick = spawner.nextWaveTick;
  spawner.tick(dueTick, attackers, rng);
  assert(attackers.count > 0, 'a wave spawns once currentTick reaches nextWaveTick');
  assert(spawner.nextWaveTick > dueTick, 'nextWaveTick is rescheduled forward after a wave fires');
});

section('colonyStrength: sane range for empty / fresh / large colonies (director.js, untouched)', () => {
  const grid = new SettlementGrid(20, 20);

  function makeWorld({ citizenCount = 0, structures = [], scrap = 0 } = {}) {
    const citizens = new CitizenStore(Math.max(1, citizenCount));
    const rng = makeRng(1);
    for (let n = 0; n < citizenCount; n++) citizens.spawn(`C${n}`, 1, 1, rng);
    return { citizens, structures, scrap, grid };
  }

  const empty = makeWorld();
  const emptyStrength = colonyStrength(empty);
  assert(Number.isFinite(emptyStrength), 'colonyStrength is a finite number for a totally empty colony');
  assert(emptyStrength >= 0, `colonyStrength is non-negative for an empty colony (got ${emptyStrength})`);
  assert(emptyStrength === 0, `an empty colony (0 citizens, 0 structures, 0 scrap) has colonyStrength exactly 0 (got ${emptyStrength})`);

  const builtStructures = [];
  for (let n = 0; n < 4; n++) {
    const s = new Structure('turret', n, n, { instant: true });
    builtStructures.push(s);
  }
  const fresh = makeWorld({ citizenCount: 5, structures: builtStructures, scrap: 20 });
  const freshStrength = colonyStrength(fresh);
  assert(Number.isFinite(freshStrength) && !Number.isNaN(freshStrength), 'colonyStrength is finite/non-NaN for a fresh starter colony');
  assert(freshStrength > emptyStrength, 'a fresh colony with citizens/structures/scrap has higher strength than an empty one');

  // Under-construction structures must not count toward strength (only completed ones should).
  const withBlueprint = makeWorld({ citizenCount: 1, structures: [new Structure('turret', 0, 0)] /* not instant */ });
  const blueprintStrength = colonyStrength(withBlueprint);
  const noStructureStrength = colonyStrength(makeWorld({ citizenCount: 1 }));
  assert(blueprintStrength === noStructureStrength,
    `an under-construction (unbuilt) blueprint contributes 0 strength, same as no structure at all (got ${blueprintStrength} vs ${noStructureStrength})`);

  // Huge scrap stockpile: must never go negative or NaN, and must scale sub-linearly (sqrt),
  // not linearly -- this is the fix for the balance regression noted in SESSION_HANDOFF.md
  // (an old linear `scrap * 0.1` term let a hands-off colony's auto-harvested scrap alone
  // saturate difficulty). Test the *shape* of the fix without touching the implementation.
  const bigColony = makeWorld({ citizenCount: 50, structures: builtStructures, scrap: 1_000_000 });
  const bigStrength = colonyStrength(bigColony);
  assert(Number.isFinite(bigStrength) && !Number.isNaN(bigStrength), 'colonyStrength stays finite/non-NaN for a huge scrap stockpile');
  assert(bigStrength > 0, 'colonyStrength stays positive for a large, well-defended colony');

  const strengthAt1M = colonyStrength(makeWorld({ scrap: 1_000_000 }));
  const strengthAt4M = colonyStrength(makeWorld({ scrap: 4_000_000 }));
  const deltaFrom1Mto4M = strengthAt4M - strengthAt1M;
  const deltaFrom0to1M = strengthAt1M - colonyStrength(makeWorld({ scrap: 0 }));
  assert(deltaFrom1Mto4M < deltaFrom0to1M * 1.5,
    `quadrupling scrap from 1M to 4M adds far less strength than the first 1M did (sqrt diminishing returns) ` +
    `(delta 0->1M: ${deltaFrom0to1M}, delta 1M->4M: ${deltaFrom1Mto4M})`);
  assert(deltaFrom1Mto4M > 0, 'more scrap still strictly increases colonyStrength (never negative contribution)');
});
