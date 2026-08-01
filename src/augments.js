// Scavenged Augments -- installable permanent stat boosts, each with a genuine tradeoff.
//
// Scope note: inspired by the well-known GENERAL CONCEPT behind a famous RimWorld content-
// expansion mod category (installable bionic/cybernetic augmentations that give a colonist a
// permanent stat boost, often with a real tradeoff or cost) -- described from that category's
// public reputation only, NOT from its actual code, item names, or text. Everything below is
// original: this project's own systems/conventions, fitted to this project's SEA:R salvage-tech
// aesthetic (a "salvaged rig" bolted on by a survivor with some construction skill) rather than
// a medical-sci-fi bionic-implant framing.
//
// Distinct from ranks.js on purpose -- read that file's own header first. Rank is EARNED via
// accumulated skillConstruction+skillCombat and is pure upside (every tier's workSpeedMult/
// healthMult both go up, never down). An augment is PURCHASED directly with scrap, any time a
// citizen is alive and has a free slot -- no skill gate at all -- and every augment carries a
// genuine permanent downside alongside its upside, so installing one (and choosing which) is a
// real build tradeoff, not a strict power increase the way ranking up is.
//
// Applied via the exact same multiplier-field/null-safe-default-1 convention as traits.js/
// ranks.js/traits.js's AGE_BANDS: augmentWorkSpeedMultFor / augmentHealthMultFor /
// augmentSocialGainMultFor / augmentDamageMultFor / augmentHungerMultFor / augmentRestMultFor /
// augmentBreakThresholdOffsetFor each fold every augment currently installed on citizen i into
// the SAME rate expressions jobs.js/siege.js/citizens.js already build from trait/age-band/rank
// multipliers -- multiplies in (adds in, for the one additive offset) alongside them, never
// replaces or short-circuits any existing term.
import { spend, canAfford, BUILD_COST } from './economy.js';

// A citizen can carry at most this many installed augments at once, regardless of how many
// distinct AUGMENTS exist below -- keeps stacking bounded (real power creep control) rather than
// "eventually buy every augment for every citizen".
export const AUGMENT_SLOT_CAP = 2;

// Each augment's `costKind` is a real key in economy.js's BUILD_COST table, so a purchase runs
// through the exact same canAfford/spend/finance-ledger/trader-voucher/coverage-plan-discount
// machinery every structure purchase (and citizens.js's Vest, the closest existing per-citizen-
// purchase precedent) already uses -- not a parallel economy.
export const AUGMENTS = [
  {
    id: 'combatRig',
    name: 'Salvaged Combat Rig',
    costKind: 'augment_combat',
    // Upside: scavenged armor plating + a reflex booster -- tougher to put down, and hits harder
    // while armed (siege.js's tickStaffCombat, guard/sniper personal damage).
    healthMult: 1.25,
    damageMult: 1.20,
    // Tradeoff: the rig's servo whine and the constant low-grade discomfort of wearing it make a
    // citizen worse company and quicker to crack under strain -- less Recreation refill
    // (jobs.js's socialGainMult site) and a raised mood-break threshold (citizens.js, stacks with
    // traits.js's own Neurotic/Steady offset rather than overriding it).
    socialGainMult: 0.7,
    breakThresholdOffset: 0.06,
    tradeoffText: '-30% social refill, +0.06 break threshold (cracks under strain more easily)',
    upsideText: '+25% health, +20% combat damage',
  },
  {
    id: 'servoLimb',
    name: 'Salvaged Servo-Limb',
    costKind: 'augment_work',
    // Upside: a scavenged industrial servo arm -- real work-speed gain across every jobs.js rate
    // chain (build/harvest/clean/process/farm/restaurant).
    workSpeedMult: 1.30,
    // Tradeoff: the same bulk that makes it good at swinging a wrench makes for a worse fit
    // taking a hit -- reduced healthMult, citizens.js/siege.js's shared damage-reduction chain.
    healthMult: 0.85,
    tradeoffText: '-15% health (takes more damage per hit)',
    upsideText: '+30% work speed',
  },
  {
    id: 'enduranceRig',
    name: 'Salvaged Endurance Rig',
    costKind: 'augment_endurance',
    // Upside: a scavenged metabolic regulator -- slower to actually feel hunger/fatigue.
    hungerMult: 0.75,
    restMult: 0.75,
    // Tradeoff: bulky and awkward, throttles fine work a little.
    workSpeedMult: 0.9,
    tradeoffText: '-10% work speed (bulky, awkward rig)',
    upsideText: '-25% hunger decay, -25% rest decay',
  },
];

const AUGMENT_BY_ID = Object.fromEntries(AUGMENTS.map(a => [a.id, a]));

export function augmentDefFor(id) {
  return AUGMENT_BY_ID[id] ?? null;
}

// ---- per-citizen installed-set helpers -----------------------------------------------------
// store.augmentMask[i] is a bitmask, one bit per AUGMENTS index (same compact convention as
// citizens.js's CitizenFlags) -- plenty of headroom in a Uint8Array for 3 augment types.

export function hasAugment(store, i, augId) {
  const idx = AUGMENTS.findIndex(a => a.id === augId);
  if (idx < 0) return false;
  return ((store.augmentMask[i] ?? 0) & (1 << idx)) !== 0;
}

export function installedAugmentsFor(store, i) {
  const mask = store.augmentMask[i] ?? 0;
  const out = [];
  for (let idx = 0; idx < AUGMENTS.length; idx++) if (mask & (1 << idx)) out.push(AUGMENTS[idx]);
  return out;
}

export function augmentCountFor(store, i) {
  const mask = store.augmentMask[i] ?? 0;
  let n = 0;
  for (let idx = 0; idx < AUGMENTS.length; idx++) if (mask & (1 << idx)) n++;
  return n;
}

// Checks whether citizen i can buy augment augId right now, without spending anything -- used
// both by the actual purchase action below and by the inspector UI to show why a Purchase button
// is disabled, same "always show why" convention as ranks.js's canRankUp. Returns
// { ok: true, def } or { ok: false, reason }.
export function canBuyAugment(store, i, augId, world) {
  const def = augmentDefFor(augId);
  if (!def) return { ok: false, reason: 'unknown augment' };
  if (!store.isAliveAt(i)) return { ok: false, reason: 'not alive' };
  if (hasAugment(store, i, augId)) return { ok: false, reason: 'already installed' };
  if (augmentCountFor(store, i) >= AUGMENT_SLOT_CAP) {
    return { ok: false, reason: `augment slots full (${AUGMENT_SLOT_CAP} max)` };
  }
  if (!canAfford(world, def.costKind)) {
    return { ok: false, reason: `needs ${BUILD_COST[def.costKind] ?? 0} scrap` };
  }
  return { ok: true, def };
}

// Actually spends the scrap and installs augId on citizen i, if canBuyAugment allows it. Mirrors
// economy.js's spend() bookkeeping (world.finance.buildSpend, trader-voucher consumption) exactly,
// same convention as ranks.js's tryRankUp -- a one-time purchase like a structure buy, not an
// income event.
export function tryBuyAugment(store, i, augId, world) {
  const check = canBuyAugment(store, i, augId, world);
  if (!check.ok) return check;
  const idx = AUGMENTS.findIndex(a => a.id === augId);
  spend(world, check.def.costKind);
  store.augmentMask[i] = (store.augmentMask[i] ?? 0) | (1 << idx);
  return { ok: true, def: check.def };
}

// ---- combined multiplier getters -------------------------------------------------------------
// One per multiplier field: product across every installed augment (sum for the one additive
// field), same null-safe-default-1 (0 for the additive offset) convention every other multiplier
// table in this codebase already uses -- a citizen with zero augments reads byte-for-byte
// identical to before this feature existed.

function productOf(store, i, field) {
  let mult = 1;
  for (const a of installedAugmentsFor(store, i)) mult *= (a[field] ?? 1);
  return mult;
}

export function augmentWorkSpeedMultFor(store, i) { return productOf(store, i, 'workSpeedMult'); }
export function augmentHealthMultFor(store, i) { return productOf(store, i, 'healthMult'); }
export function augmentSocialGainMultFor(store, i) { return productOf(store, i, 'socialGainMult'); }
export function augmentDamageMultFor(store, i) { return productOf(store, i, 'damageMult'); }
export function augmentHungerMultFor(store, i) { return productOf(store, i, 'hungerMult'); }
export function augmentRestMultFor(store, i) { return productOf(store, i, 'restMult'); }

export function augmentBreakThresholdOffsetFor(store, i) {
  let sum = 0;
  for (const a of installedAugmentsFor(store, i)) sum += (a.breakThresholdOffset ?? 0);
  return sum;
}
