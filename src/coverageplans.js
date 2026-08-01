// Coverage Plans -- pre-purchased "insurance bundle" economy sink, ported directly from real
// Prison Architect data (see coverage_plans.txt / SESSION_HANDOFF.md's research note): a plan is
// bought once for an upfront scrap cost, permanently discounts a themed set of related
// buildables while active, AND unlocks an on-demand emergency call-in action that only fires once
// a real in-game threshold is crossed. PA's real examples are a cold-snap plan (discounted
// cold-related training/buildables + an emergency road-maintenance call-in) and a first-aid plan
// (discounted first-aid buildables + an emergency responder call-in gated at Injuries>=10). Both
// ported as genuinely economy-neutral bundles -- reskinned non-carceral per this project's
// explicit rule (SESSION_HANDOFF.md: never frame anything as a prison), no gameplay concept here
// is carceral in mechanism (a themed discount bundle + a threshold-gated one-shot response is
// exactly as applicable to a civil settlement as to anything else).
//
// Two plans, each mapped onto a real, already-existing crisis this project's own systems produce:
//  - Fire Response Plan: discounts the flammable furniture kinds fire.js already tracks (bed/
//    table/door -- the actual things that can catch fire, sold as a fireproofing-retrofit
//    discount, not an arbitrary bundle) and unlocks a firefighter call-in usable once 2+
//    structures are actually on fire (fire.js's `onFire` flag), extinguishing all of them at once.
//  - Medical Response Plan: discounts the Infirmary's real furniture requirement (rooms.js's
//    RoomRole.Medical / medical_bed) and unlocks an emergency-responder call-in usable once 3+
//    citizens are actually Downed (citizens.js's CitizenFlags.Downed), instantly stabilizing all
//    of them -- mirrors PA's real Injuries>=10 threshold pattern at a scale that fits this
//    project's much smaller colony sizes.
import { CitizenFlags, DOWNED_RECOVER_THRESHOLD } from './citizens.js';

export const CoveragePlanKind = Object.freeze({
  FireResponse: 'fire_response',
  MedicalResponse: 'medical_response',
});

export const COVERAGE_PLAN_DEFS = Object.freeze({
  [CoveragePlanKind.FireResponse]: Object.freeze({
    label: 'Fire Response Plan',
    // One-time purchase, priced between a turret (25) and a Tesla Coil (40) -- a real
    // colony-wide utility bundle, not a single structure.
    cost: 25,
    discounts: Object.freeze({ bed: 0.5, table: 0.5, door: 0.5 }), // fire.js's FLAMMABLE_KINDS, 50% off
    callIn: Object.freeze({
      label: 'Call In Firefighters',
      description: 'Instantly extinguishes every structure currently on fire.',
      threshold: 2, // active (onFire, undestroyed) structures required
      thresholdNoun: 'structures on fire',
    }),
  }),
  [CoveragePlanKind.MedicalResponse]: Object.freeze({
    label: 'Medical Response Plan',
    cost: 25,
    discounts: Object.freeze({ medical_bed: 0.5 }), // rooms.js's Infirmary furniture requirement, 50% off
    callIn: Object.freeze({
      label: 'Call In Emergency Responders',
      description: 'Instantly stabilizes every citizen currently downed.',
      threshold: 3, // downed citizens required -- PA's real Injuries>=10 pattern, scaled to this project's colony sizes
      thresholdNoun: 'citizens downed',
    }),
  }),
});

export const COVERAGE_PLAN_ORDER = [CoveragePlanKind.FireResponse, CoveragePlanKind.MedicalResponse];

/** True once `kind` has been purchased this run (persists via world.js's serialize/deserialize). */
export function isPlanActive(world, kind) {
  return !!(world.coveragePlans && world.coveragePlans.has(kind));
}

/** One-time purchase. Returns false (no-op, no spend) if already owned, unknown kind, or the
 *  colony can't afford it -- same canAfford-before-spend contract as economy.js's spend(). */
export function purchaseCoveragePlan(world, kind) {
  const def = COVERAGE_PLAN_DEFS[kind];
  if (!def) return false;
  if (!world.coveragePlans) world.coveragePlans = new Set();
  if (world.coveragePlans.has(kind)) return false;
  if (world.scrap < def.cost) return false;
  world.scrap -= def.cost;
  if (world.finance) world.finance.buildSpend += def.cost; // budget-report ledger, same convention as economy.js's spend()
  world.coveragePlans.add(kind);
  return true;
}

/** Combined discount multiplier for `buildKind` across every currently-active plan -- this is the
 *  actual point-of-sale hook, called from economy.js's buildCost() the same way trader-voucher
 *  discounts already are. Multiplicative in case a buildable ever appears in two plans at once
 *  (none currently overlap); returns 1 (no discount) if no active plan touches this buildable. */
export function coveragePlanDiscountMult(world, buildKind) {
  if (!world.coveragePlans || world.coveragePlans.size === 0) return 1;
  let mult = 1;
  for (const kind of world.coveragePlans) {
    const pct = COVERAGE_PLAN_DEFS[kind]?.discounts?.[buildKind];
    if (pct) mult *= (1 - pct);
  }
  return mult;
}

function activeFireCount(world) {
  let n = 0;
  for (const s of world.structures) if (s.onFire && !s.destroyed) n++;
  return n;
}

function downedCitizenCount(world) {
  let n = 0;
  for (let i = 0; i < world.citizens.count; i++) {
    if (world.citizens.isAliveAt(i) && world.citizens.isDownedAt(i)) n++;
  }
  return n;
}

/** Current live count feeding `kind`'s call-in threshold, regardless of purchase state -- so a UI
 *  panel can show real "N / threshold" progress even before the plan is bought. */
export function callInLiveCount(world, kind) {
  if (kind === CoveragePlanKind.FireResponse) return activeFireCount(world);
  if (kind === CoveragePlanKind.MedicalResponse) return downedCitizenCount(world);
  return 0;
}

/** True only when the plan is both purchased AND its real threshold is currently crossed -- the
 *  actual gate the task asked to verify (unavailable below threshold, available above it). */
export function isCallInReady(world, kind) {
  const def = COVERAGE_PLAN_DEFS[kind];
  if (!def || !isPlanActive(world, kind)) return false;
  return callInLiveCount(world, kind) >= def.callIn.threshold;
}

/** Fires `kind`'s one-time call-in bonus. Re-checks isCallInReady itself (not just trusting the
 *  caller's last-rendered UI state) so it can never silently no-op-succeed from a stale button.
 *  Returns true iff it actually applied an effect. */
export function triggerCallIn(world, kind) {
  if (!isCallInReady(world, kind)) return false;

  if (kind === CoveragePlanKind.FireResponse) {
    for (const s of world.structures) {
      if (s.onFire) { s.onFire = false; s.fireTicks = 0; }
    }
    return true;
  }

  if (kind === CoveragePlanKind.MedicalResponse) {
    const store = world.citizens;
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i) || !store.isDownedAt(i)) continue;
      store.health[i] = Math.max(store.health[i], DOWNED_RECOVER_THRESHOLD);
      store.flags[i] &= ~CitizenFlags.Downed;
      if (store.beingTended) store.beingTended[i] = 0;
      if (store.tendClaimedBy && store.tendClaimedBy[i] !== -1) store.tendClaimedBy[i] = -1;
    }
    return true;
  }

  return false;
}
