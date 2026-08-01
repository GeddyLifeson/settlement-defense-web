// Content assertions on augments.js -- purchase gating, slot cap, and that both the upside AND
// the tradeoff of each augment actually reach the combined-multiplier getters other systems read.
import { assert, section } from './harness.js';
import { CitizenStore } from '../src/citizens.js';
import {
  AUGMENTS, AUGMENT_SLOT_CAP, hasAugment, augmentCountFor, canBuyAugment, tryBuyAugment,
  augmentWorkSpeedMultFor, augmentHealthMultFor, augmentSocialGainMultFor, augmentBreakThresholdOffsetFor,
} from '../src/augments.js';
import { makeRng } from '../src/core.js';

function fakeWorld(scrap) {
  return { scrap, finance: { buildSpend: 0 } };
}

section('augments.js: purchase gating and installed-set tracking', () => {
  const store = new CitizenStore(2);
  const rng = makeRng(3);
  const i = store.spawn('Aug Test', 0, 0, rng);

  assert(augmentCountFor(store, i) === 0, 'a fresh citizen starts with zero augments');
  assert(!hasAugment(store, i, 'combatRig'), 'a fresh citizen has no combatRig installed');

  const poor = fakeWorld(0);
  const check0 = canBuyAugment(store, i, 'combatRig', poor);
  assert(check0.ok === false, 'canBuyAugment refuses with insufficient scrap');

  const rich = fakeWorld(1000);
  const check1 = canBuyAugment(store, i, 'combatRig', rich);
  assert(check1.ok === true, 'canBuyAugment allows a valid, affordable purchase');

  const before = rich.scrap;
  const result = tryBuyAugment(store, i, 'combatRig', rich);
  assert(result.ok === true, 'tryBuyAugment succeeds when canBuyAugment allows it');
  assert(rich.scrap < before, 'tryBuyAugment actually spends real scrap');
  assert(hasAugment(store, i, 'combatRig'), 'combatRig is installed after a successful purchase');
  assert(augmentCountFor(store, i) === 1, 'installed count reflects the purchase');

  const dupe = tryBuyAugment(store, i, 'combatRig', rich);
  assert(dupe.ok === false && dupe.reason === 'already installed', 'buying the same augment twice on the same citizen is refused');
});

section('augments.js: slot cap enforcement', () => {
  const store = new CitizenStore(2);
  const rng = makeRng(4);
  const i = store.spawn('Cap Test', 0, 0, rng);
  const world = fakeWorld(10000);

  assert(AUGMENT_SLOT_CAP === 2, 'slot cap is the documented value (guards against a silent balance change)');
  assert(AUGMENTS.length >= 3, 'at least 3 augment types are defined per the task brief');

  let installed = 0;
  for (const def of AUGMENTS) {
    const r = tryBuyAugment(store, i, def.id, world);
    if (r.ok) installed++;
  }
  assert(installed === AUGMENT_SLOT_CAP, `only ${AUGMENT_SLOT_CAP} of ${AUGMENTS.length} augment types could be installed on one citizen`);
  assert(augmentCountFor(store, i) === AUGMENT_SLOT_CAP, 'installed count is pinned at the slot cap, not the full AUGMENTS length');

  const overflowCheck = canBuyAugment(store, i, AUGMENTS[AUGMENTS.length - 1].id, world);
  assert(overflowCheck.ok === false && overflowCheck.reason.includes('slots full'), 'a further purchase is refused once slots are full, with a reason naming the cap');
});

section('augments.js: both the upside AND the tradeoff reach the combined-multiplier getters', () => {
  const store = new CitizenStore(2);
  const rng = makeRng(5);
  const i = store.spawn('Tradeoff Test', 0, 0, rng);
  const world = fakeWorld(10000);

  // Baseline: no augments installed, every getter is the neutral no-op default.
  assert(augmentWorkSpeedMultFor(store, i) === 1, 'work speed mult is 1 with no augments');
  assert(augmentHealthMultFor(store, i) === 1, 'health mult is 1 with no augments');
  assert(augmentSocialGainMultFor(store, i) === 1, 'social gain mult is 1 with no augments');
  assert(augmentBreakThresholdOffsetFor(store, i) === 0, 'break threshold offset is 0 with no augments');

  const combatDef = AUGMENTS.find(a => a.id === 'combatRig');
  tryBuyAugment(store, i, 'combatRig', world);
  // Upside: health goes UP.
  assert(Math.abs(augmentHealthMultFor(store, i) - combatDef.healthMult) < 1e-9,
    'combatRig upside (healthMult) reaches augmentHealthMultFor exactly');
  // Tradeoff: social refill goes DOWN and break threshold offset goes UP (both real, both measured).
  assert(Math.abs(augmentSocialGainMultFor(store, i) - combatDef.socialGainMult) < 1e-9,
    'combatRig tradeoff (socialGainMult < 1) reaches augmentSocialGainMultFor exactly');
  assert(augmentSocialGainMultFor(store, i) < 1, 'combatRig social tradeoff is a real reduction, not a no-op');
  assert(Math.abs(augmentBreakThresholdOffsetFor(store, i) - combatDef.breakThresholdOffset) < 1e-9,
    'combatRig tradeoff (breakThresholdOffset > 0) reaches augmentBreakThresholdOffsetFor exactly');
  assert(augmentBreakThresholdOffsetFor(store, i) > 0, 'combatRig break-threshold tradeoff is a real increase (cracks more easily), not a no-op');

  // A second citizen with servoLimb: upside (work speed) and tradeoff (health) both stack in.
  const j = store.spawn('Tradeoff Test 2', 1, 1, rng);
  const workDef = AUGMENTS.find(a => a.id === 'servoLimb');
  tryBuyAugment(store, j, 'servoLimb', world);
  assert(augmentWorkSpeedMultFor(store, j) > 1, 'servoLimb upside (work speed) is a real increase');
  assert(Math.abs(augmentWorkSpeedMultFor(store, j) - workDef.workSpeedMult) < 1e-9,
    'servoLimb upside reaches augmentWorkSpeedMultFor exactly');
  assert(augmentHealthMultFor(store, j) < 1, 'servoLimb tradeoff (health down) is a real decrease, not a no-op');
  assert(Math.abs(augmentHealthMultFor(store, j) - workDef.healthMult) < 1e-9,
    'servoLimb tradeoff reaches augmentHealthMultFor exactly');

  // Every AUGMENTS entry declares at least one upside field and at least one distinct tradeoff
  // field -- guards against a future augment being added as a strict upgrade with no real cost.
  const UPSIDE_FIELDS = ['healthMult', 'workSpeedMult', 'damageMult', 'socialGainMult', 'hungerMult', 'restMult'];
  for (const def of AUGMENTS) {
    const better = UPSIDE_FIELDS.filter(f => def[f] != null && def[f] > 1 || (f === 'hungerMult' || f === 'restMult') && def[f] != null && def[f] < 1);
    const worse = UPSIDE_FIELDS.filter(f => def[f] != null && def[f] < 1 && f !== 'hungerMult' && f !== 'restMult')
      .concat(def.breakThresholdOffset > 0 ? ['breakThresholdOffset'] : []);
    assert(better.length > 0, `${def.name} declares at least one real upside field`);
    assert(worse.length > 0, `${def.name} declares at least one real tradeoff field (not a strict upgrade)`);
  }
});
