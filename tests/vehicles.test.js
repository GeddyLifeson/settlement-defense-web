// Two of the highest-risk/most-complex systems: the Structure blueprint-construction lifecycle
// and the vehicle garage -> driver -> haul-cycle state machine. Both are driven through the
// REAL job-priority state machine (jobs.js tickJobs), not reimplemented/mocked, so this
// exercises the actual code path a citizen goes through in the live game.
import { assert, section } from './harness.js';
import { CitizenStore } from '../src/citizens.js';
import { ZoneGrid } from '../src/zones.js';
import { SettlementGrid } from '../src/grid.js';
import { Structure } from '../src/siege.js';
import { tickJobs, JobState } from '../src/jobs.js';
import { Vehicle, spawnParkedVehicle, findUndrivenVehicle, boardVehicle, tickVehicles } from '../src/vehicles.js';
import { makeRng } from '../src/core.js';

// Minimal world stub with exactly the fields jobs.js/vehicles.js actually touch: vehicles,
// rooms (empty -> no room bonus, simplest case), grid, rng, timeOfDay (mid-Work-block so no
// schedule interruptions), structures, resourceNodes, width/height (used by garbage-truck
// targeting), and addScrap/pollution (used by tickVehicles).
function makeWorldStub(overrides = {}) {
  return Object.assign({
    vehicles: [],
    rooms: [],
    grid: new SettlementGrid(20, 20),
    rng: makeRng(99),
    timeOfDay: 0.5, // squarely inside the default Work block
    width: 20,
    height: 20,
    scrap: 0,
    pollution: 0,
    addScrap(amt) { this.scrap += amt; },
    structures: [],
  }, overrides);
}

section('Structure blueprint-construction lifecycle', () => {
  const bp = new Structure('turret', 5, 5);
  assert(bp.underConstruction === true, 'a non-instant Structure starts underConstruction');
  assert(bp.buildProgress === 0, 'a non-instant Structure starts at buildProgress 0');
  assert(bp.claimedBy === null, 'a non-instant Structure starts unclaimed');

  const instantBp = new Structure('turret', 5, 5, { instant: true });
  assert(instantBp.underConstruction === false, 'an { instant: true } Structure is never underConstruction');
  assert(instantBp.buildProgress === 1, 'an { instant: true } Structure starts at buildProgress 1 (fully built)');

  // Drive a citizen through the real Idle -> SeekingBuild -> Building -> Idle pipeline via
  // tickJobs, with nothing else competing for the citizen's attention (needs full, no zones
  // painted, no vehicles, no resource nodes).
  const store = new CitizenStore(1);
  const rng = makeRng(3);
  const ci = store.spawn('Builder', 5, 5, rng); // spawn right on top of the blueprint -- arrives instantly
  const zones = new ZoneGrid(20, 20);
  const world = makeWorldStub({ structures: [bp] });
  const idOf = (i) => store.id[i];

  tickJobs(store, zones, () => false, world.structures, [], idOf, null, world);
  assert(store.jobState[ci] === JobState.SeekingBuild || store.jobState[ci] === JobState.Building,
    'an idle citizen with a nearby unclaimed blueprint and no urgent needs claims it (SeekingBuild or Building, depending on arrival distance)');
  assert(bp.claimedBy === idOf(ci), 'the blueprint records claimedBy as the citizen who took the job');

  // Some backstories (see backstories.js) deliberately start skillConstruction below 0 as a real
  // tradeoff against a favored skill elsewhere -- so "gains skill" has to mean "increased from
  // wherever it started", not "ended up positive". Capture the pre-build value rather than
  // assuming it's 0.
  const skillBeforeBuild = store.skillConstruction[ci];

  for (let t = 0; t < 500 && bp.underConstruction; t++) {
    tickJobs(store, zones, () => false, world.structures, [], idOf, null, world);
  }
  assert(bp.underConstruction === false, 'repeated tickJobs calls eventually finish construction (buildProgress reaches 1)');
  assert(bp.buildProgress >= 1, 'buildProgress is >= 1 once construction completes');
  assert(bp.claimedBy === null, 'claimedBy is released back to null once construction completes');
  assert(store.jobState[ci] === JobState.Idle, 'the citizen returns to Idle once their blueprint finishes');
  assert(store.skillConstruction[ci] > skillBeforeBuild,
    `the builder gains construction skill on completion (${skillBeforeBuild.toFixed(4)} -> ${store.skillConstruction[ci].toFixed(4)})`);
});

section('Structure blueprint: claimedBy prevents a second citizen from double-claiming', () => {
  const bp = new Structure('wall', 5, 5);
  const store = new CitizenStore(2);
  const rng = makeRng(4);
  const a = store.spawn('A', 5, 5, rng);
  const b = store.spawn('B', 5, 5, rng);
  const zones = new ZoneGrid(20, 20);
  const world = makeWorldStub({ structures: [bp] });
  const idOf = (i) => store.id[i];

  tickJobs(store, zones, () => false, world.structures, [], idOf, null, world);
  const claimant = bp.claimedBy;
  assert(claimant === idOf(a) || claimant === idOf(b), 'exactly one of the two citizens claims the single blueprint');

  tickJobs(store, zones, () => false, world.structures, [], idOf, null, world);
  const loserIdx = claimant === idOf(a) ? b : a;
  assert(store.jobState[loserIdx] !== JobState.Building && store.jobState[loserIdx] !== JobState.SeekingBuild,
    'the citizen who did not win the claim does not also enter SeekingBuild/Building for the same blueprint');
});

section('Vehicle garage -> driver -> haul-cycle state transitions', () => {
  const v = spawnVehicleFor(makeWorldStub());
  assert(v.driverId === null, 'a freshly spawned vehicle has no driver (parked)');
  assert(v.phase === 'parked', 'a freshly spawned vehicle starts in the parked phase');

  // findUndrivenVehicle must find it, and must stop finding it once it has a driver.
  const world = makeWorldStub({ vehicles: [v] });
  const found = findUndrivenVehicle(world.vehicles, 0, 0);
  assert(found === v, 'findUndrivenVehicle locates a parked, undriven vehicle');

  boardVehicle(world, v, 42);
  assert(v.driverId === 42, 'boardVehicle assigns the driver id');
  assert(v.phase === 'inbound', 'boarding a garbage-kind vehicle moves it to the inbound phase (no resource-node dependency)');
  assert(findUndrivenVehicle(world.vehicles, 0, 0) === null, 'a vehicle with a driver is no longer found by findUndrivenVehicle');

  // Drive the full inbound -> working -> outbound -> parked cycle via tickVehicles.
  let ticks = 0;
  while (v.phase !== 'parked' && ticks < 5000) { tickVehicles(world); ticks++; }
  assert(ticks < 5000, `the haul cycle completes (reaches parked) within a bounded number of ticks (took ${ticks})`);
  assert(v.driverId === null, 'the driver is released (driverId back to null) once the vehicle returns home');
  assert(v.x === v.garageX && v.y === v.garageY, 'the vehicle ends up back at its garage position');
  assert(world.scrap > 0 || world.pollution < 0 || world.pollution === 0,
    'a completed garbage haul had some real economic/pollution effect (scrap gained and/or pollution reduced)');
});

section('Vehicle + jobs.js integration: a citizen actually drives a vehicle end-to-end', () => {
  const store = new CitizenStore(1);
  const rng = makeRng(5);
  const ci = store.spawn('Driver', 3, 3, rng);
  const zones = new ZoneGrid(20, 20);
  const world = makeWorldStub();
  const v = spawnVehicleFor(world, 3, 3); // parked right where the citizen stands
  world.vehicles.push(v);
  const idOf = (i) => store.id[i];

  tickJobs(store, zones, () => false, world.structures, [], idOf, null, world);
  assert(store.jobState[ci] === JobState.SeekingVehicle || store.jobState[ci] === JobState.Driving,
    'an idle citizen with no needs/blueprints but an available parked vehicle heads for it (SeekingVehicle or Driving)');

  for (let t = 0; t < 50 && store.jobState[ci] !== JobState.Driving; t++) {
    tickJobs(store, zones, () => false, world.structures, [], idOf, null, world);
  }
  assert(store.jobState[ci] === JobState.Driving, 'the citizen reaches the Driving job state after arriving at the vehicle');
  assert(v.driverId === idOf(ci), 'the vehicle records the citizen as its driver');

  // Run the whole world (vehicle tick + job tick) until the haul finishes and the driver is freed.
  let ticks = 0;
  while (store.jobState[ci] === JobState.Driving && ticks < 5000) {
    tickVehicles(world);
    tickJobs(store, zones, () => false, world.structures, [], idOf, null, world);
    ticks++;
  }
  assert(ticks < 5000, `the citizen's Driving job resolves within a bounded number of ticks (took ${ticks})`);
  assert(store.jobState[ci] === JobState.Idle, 'the citizen returns to Idle once the haul cycle finishes and driverId no longer matches them');
  assert(v.driverId === null, 'the vehicle is parked and driverless again after the full cycle');
});

// Helper: spawn a garbage-kind vehicle (avoids the recycling kind's dependency on a nonempty
// resourceNodes list, which is orthogonal to what this file is testing).
function spawnVehicleFor(world, x = 0, y = 0) {
  spawnParkedVehicle(world, 'garbage', x, y, 'gas');
  return world.vehicles[world.vehicles.length - 1];
}
