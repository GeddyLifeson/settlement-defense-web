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
// Three plans, each mapped onto a real, already-existing crisis this project's own systems produce:
//  - Fire Response Plan: discounts the flammable furniture kinds fire.js already tracks (bed/
//    table/door -- the actual things that can catch fire, sold as a fireproofing-retrofit
//    discount, not an arbitrary bundle) and unlocks a firefighter call-in usable once 2+
//    structures are actually on fire (fire.js's `onFire` flag), extinguishing all of them at once.
//  - Medical Response Plan: discounts the Infirmary's real furniture requirement (rooms.js's
//    RoomRole.Medical / medical_bed) and unlocks an emergency-responder call-in usable once 3+
//    citizens are actually Downed (citizens.js's CitizenFlags.Downed), instantly stabilizing all
//    of them -- mirrors PA's real Injuries>=10 threshold pattern at a scale that fits this
//    project's much smaller colony sizes.
//  - Security Response Plan: discounts the combat/defense buildable tier (turret/watchtower/
//    armory -- siege.js's structures and security.js's weapon-issuance building, the real
//    "defense" category as opposed to Fire/Medical's crisis-response categories) and unlocks a
//    tactical-reinforcement call-in gated on siege.js's real live attacker headcount (an active
//    siege -- there is no standalone "wave in progress" flag anywhere in this codebase, but a live
//    attacker count above a real threshold only ever happens while a wave is actually on the
//    field, which is exactly the crisis PA's own emergency-response plans key off). Activating it
//    applies a real, temporary, measurable accuracy boost to every turret and staff defender (the
//    same `accuracyMult` choke point weather.js's real weather-accuracy penalty already uses --
//    see world.js's tick(), siege.js's rollsHit) for a short window, mirroring RimWorld/PA's own
//    "temporary backup" framing (FireHeli/EliteOpsHeli/ParamedicsHeli/SoldiersHeli) without
//    inventing a parallel combat-numbers system the way draft.js's header comment specifically
//    warned future work not to do.
//
// Three more plan types, ported from real PA data this project didn't have yet (coverage_plans.txt/
// ratsystem.txt/calamity_settings.txt), added in a later pass. Same "discount + threshold-gated
// call-in" bundle shape as the three above, each mapped onto a real, already-existing system this
// project's own code produces rather than an invented one:
//  - Pest Control Plan: real PA's PestControlPlan (gated on RatEnabled) triggers a PestControl/
//    AirPestControl call-in once Rat infestation level >= 10. rats.js already tracks a live 0-100
//    `world.ratInfestation` level with a real Medium tier at exactly 10 (rats.js's ratTier/RatTier,
//    TIER_MEDIUM) -- ported directly as this plan's call-in threshold (10, on rats.js's own real
//    scale, not a re-derived number) rather than a synthetic one. Discounts rat_trap (economy.js),
//    the one real rat-countermeasure buildable; the call-in itself takes the "trigger an active
//    response" half of the task's either/or (not "raise passive trap effectiveness") since that's
//    the one achievable without reaching into rats.js's own tickRats loop, which this file doesn't
//    own -- instantly clears every live rat and zeroes the infestation level, same "instant full
//    resolution of a real crisis state" shape as Fire/Medical's own call-ins.
//  - Unrest Response Plan: real PA's HealthSafetyPlan actually bundles Paramedics (already ported
//    above as Medical Response) AND a separate RiotPolice/EliteOps response gated on a rioting/
//    unrest metric >= 10. world.js's own real unrest system (this.unrestLevel/unrestActive/
//    unrestTier, see that file's UNREST_* doc comment) is the metric factions.js's clique
//    consequences (applyUnmetConsequence/applyGraffitiCleanupConsequence) already feed into via
//    world.unrestLevel -- unrestActive is the real, hysteresis-gated "a sustained crisis is
//    genuinely underway" flag that system computes for exactly this purpose (world.js keeps its own
//    trigger/resolve thresholds private, so this reads the already-computed public boolean rather
//    than re-deriving or duplicating a magic number this file doesn't own). Discounts checkpoint
//    (economy.js/security.js's isNearCheckpoint), the real buildable factions.js's own unrest-
//    consequence-reduction mechanic is keyed off. The call-in zeroes world.unrestLevel -- world.js's
//    own periodic _updateUnrest tick (every GRADING_INTERVAL_TICKS, ~3s) then resolves
//    unrestActive/unrestTier and any resolution-reward eligibility through its OWN existing logic,
//    same "own the one state machine, everyone else just nudges the input" respect this file
//    already shows tickSecurityResponse's countdown.
//  - Storm Recovery Plan: real PA's RoadMaintenance/ReconstructionSpecialists/DrainageSpecialists
//    trigger on calamity-surface/damage/flooding thresholds tied to DeepFreeze/Heatwave/
//    LightningStorm. This project's closest real analog is weather.js's Lightning Storm calamity
//    (tickLightningStorm), which does real, measurable structural damage -- power-network
//    structures hit by a strike (LIGHTNING_STRUCTURE_DAMAGE) and lightning-ignited flammable
//    furniture (bed/table/door, the same fire.js target set weather.js's own tickThunderstorm
//    reuses). Discounts lightning_rod (weather.js's real PA-style mitigation buildable); the
//    call-in triggers once enough of those real targets are sitting damaged-but-not-destroyed
//    (siege.js's own Structure health convention: full health is 1, or 0.6 for a fence) and
//    instantly restores them to full health, the "repair/recovery from weather damage" the task
//    asked for -- this engine has no separate repair-cost table distinct from BUILD_COST, so an
//    instant structural-health restore is the honest equivalent of "reconstruction specialists"
//    rather than inventing a parallel repair-economy this codebase doesn't have.
//
// Two dimensions from the task brief were evaluated and deliberately NOT added:
//  - wageDiscount: real PA plans also discount themed staff WAGES, not just buildable costs. This
//    project has no ongoing per-citizen/per-role cost anywhere (grepped wage/salary/stipend/
//    payroll/upkeep across the whole src/ tree -- zero hits; economy.js's only recurring costs are
//    one-time buildable purchases, already covered by `discounts` below). Adding a `wageDiscount`
//    field with nothing behind it would be a fake knob, so it's skipped rather than invented.
//  - Training-program discount: programs.js's PROGRAM_DEFS does define a `sessionCost` per program,
//    but it's never actually deducted from world.scrap anywhere in this codebase (grepped
//    `sessionCost` project-wide -- its only other use is a display-only string in main.js's
//    tooltip). There's no real spend here for a coverage-plan discount to hook into without either
//    adding a new deduction to programs.js or changing main.js's display math, and this task owns
//    neither file -- skipped rather than wiring a discount onto a number nothing ever actually
//    charges.
import { CitizenFlags, DOWNED_RECOVER_THRESHOLD } from './citizens.js';

export const CoveragePlanKind = Object.freeze({
  FireResponse: 'fire_response',
  MedicalResponse: 'medical_response',
  SecurityResponse: 'security_response',
  PestControl: 'pest_control',
  UnrestResponse: 'unrest_response',
  StormRecovery: 'storm_recovery',
});

// Tactical-reinforcement call-in tuning (Security Response Plan). Exported so world.js's tick()
// can read the multiplier and main.js/tests can assert on the exact numbers rather than a magic
// literal duplicated in two files.
export const SECURITY_RESPONSE_ACCURACY_MULT = 1.3; // +30% hit chance for turrets/staff, window only
export const SECURITY_RESPONSE_WINDOW_TICKS = 200; // ~20s at 10Hz -- a real but short emergency window

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
  [CoveragePlanKind.SecurityResponse]: Object.freeze({
    label: 'Security Response Plan',
    // Priced above the Fire/Medical bundles (25) and below a fabrication bay (48) -- a real
    // combat-tier utility bundle, deliberately the most expensive of the three since its themed
    // discount spans three buildables (vs. one or three cheap furniture kinds) and its call-in is
    // a colony-wide combat buff rather than a one-shot cleanup.
    cost: 30,
    // turret (economy.js: 25), watchtower (20), armory (32) -- the real defense/combat buildable
    // tier, as opposed to Fire/Medical's crisis-cleanup furniture. 30% off, a real discount but
    // shallower than Fire/Medical's 50% since it applies to three buildables instead of one kind.
    discounts: Object.freeze({ turret: 0.3, watchtower: 0.3, armory: 0.3 }),
    callIn: Object.freeze({
      label: 'Call In Tactical Reinforcements',
      description: `Boosts every turret and staff defender's accuracy by ${Math.round((SECURITY_RESPONSE_ACCURACY_MULT - 1) * 100)}% for a short window.`,
      threshold: 6, // live alive attackers -- only realistically crossed during an active siege wave
      thresholdNoun: 'attackers on the field',
    }),
  }),
  [CoveragePlanKind.PestControl]: Object.freeze({
    label: 'Pest Control Plan',
    // Cheaper than Fire/Medical (25) -- its themed buildable (rat_trap: 10) is itself the cheapest
    // single-purpose-counter tier in economy.js, same "priced relative to what it discounts" logic
    // as every other plan here.
    cost: 18,
    discounts: Object.freeze({ rat_trap: 0.5 }), // rats.js's real countermeasure buildable, 50% off
    callIn: Object.freeze({
      label: 'Call In Pest Control',
      description: 'Instantly clears every rat in the settlement and resets the infestation level.',
      threshold: 10, // real PA gate: Rat infestation level >= 10 -- rats.js's own Medium tier (ratTier/TIER_MEDIUM)
      thresholdNoun: 'rat infestation level',
    }),
  }),
  [CoveragePlanKind.UnrestResponse]: Object.freeze({
    label: 'Unrest Response Plan',
    // Single-buildable scope, same tier as Medical Response's own single-target discount.
    cost: 22,
    discounts: Object.freeze({ checkpoint: 0.5 }), // factions.js's real unrest-consequence-reduction buildable
    callIn: Object.freeze({
      label: 'Call In Rapid Response Team',
      description: "Instantly calms the settlement's unrest crisis.",
      threshold: 1, // world.js's real unrestActive flag (0/1) -- a genuine sustained crisis, not a momentary spike
      thresholdNoun: 'unrest crisis active',
    }),
  }),
  [CoveragePlanKind.StormRecovery]: Object.freeze({
    label: 'Storm Recovery Plan',
    cost: 20,
    discounts: Object.freeze({ lightning_rod: 0.5 }), // weather.js's real Lightning Storm mitigation buildable
    callIn: Object.freeze({
      label: 'Call In Reconstruction Crew',
      description: 'Instantly repairs every structure damaged by lightning strikes or storm-driven fires.',
      threshold: 2, // damaged-but-not-destroyed real weather-damage targets -- same small-colony scale as Fire Response's threshold
      thresholdNoun: 'storm-damaged structures',
    }),
  }),
});

export const COVERAGE_PLAN_ORDER = [
  CoveragePlanKind.FireResponse, CoveragePlanKind.MedicalResponse, CoveragePlanKind.SecurityResponse,
  CoveragePlanKind.PestControl, CoveragePlanKind.UnrestResponse, CoveragePlanKind.StormRecovery,
];

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

/** Live alive-attacker headcount (siege.js's AttackerStore) -- the Security Response Plan's real
 *  active-siege-crisis gate. There's no standalone "wave in progress" flag anywhere in this
 *  codebase (WaveSpawner just spawns and lets tickAttackers/tickTurrets run each attacker down to
 *  zero over time), but a headcount above a real threshold only happens while a wave is actually
 *  on the field, so this is the honest live signal rather than a synthetic one. */
function activeAttackerCount(world) {
  let n = 0;
  const attackers = world.attackers;
  if (!attackers) return 0;
  for (let i = 0; i < attackers.count; i++) if (attackers.isAliveAt(i)) n++;
  return n;
}

/** rats.js's real live infestation level (0-100 scale) -- the Pest Control Plan's call-in gate. */
function ratInfestationLevel(world) {
  return world.ratInfestation || 0;
}

/** world.js's real, hysteresis-gated "a sustained unrest crisis is genuinely underway" flag,
 *  mirrored as 0/1 so it fits the same live-count/threshold shape every other call-in uses. */
function unrestActiveCount(world) {
  return world.unrestActive ? 1 : 0;
}

// siege.js's Structure constructor convention: every structure starts at health 1 except a fence,
// which starts at 0.6 (see that file's `this.health = kind === 'fence' ? 0.6 : 1`). Mirrored here
// rather than imported since siege.js doesn't export a standalone "full health for this kind"
// helper of its own.
function structureFullHealth(kind) {
  return kind === 'fence' ? 0.6 : 1;
}

// The real targets of weather.js's own Lightning Storm calamity: power-network structures hit by a
// direct strike (mirrors weather.js's own unexported isPowerStructureKind) and the lightning-
// ignited flammable furniture set (fire.js's bed/table/door, reused by weather.js's
// tickThunderstorm/tryMassFireEvent) -- the two real, already-existing sources of "weather damage"
// in this codebase, not an invented category.
function isWeatherRepairTargetKind(kind) {
  return kind === 'wire' || kind === 'battery' || kind === 'power_switch' || kind.startsWith('generator')
    || kind === 'bed' || kind === 'table' || kind === 'door';
}

/** Live count of real weather-damage targets currently sitting damaged-but-not-destroyed -- the
 *  Storm Recovery Plan's call-in gate. */
function weatherDamagedStructureCount(world) {
  let n = 0;
  for (const s of world.structures) {
    if (s.destroyed || s.underConstruction) continue;
    if (!isWeatherRepairTargetKind(s.kind)) continue;
    if (s.health < structureFullHealth(s.kind)) n++;
  }
  return n;
}

/** Current live count feeding `kind`'s call-in threshold, regardless of purchase state -- so a UI
 *  panel can show real "N / threshold" progress even before the plan is bought. */
export function callInLiveCount(world, kind) {
  if (kind === CoveragePlanKind.FireResponse) return activeFireCount(world);
  if (kind === CoveragePlanKind.MedicalResponse) return downedCitizenCount(world);
  if (kind === CoveragePlanKind.SecurityResponse) return activeAttackerCount(world);
  if (kind === CoveragePlanKind.PestControl) return ratInfestationLevel(world);
  if (kind === CoveragePlanKind.UnrestResponse) return unrestActiveCount(world);
  if (kind === CoveragePlanKind.StormRecovery) return weatherDamagedStructureCount(world);
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

  if (kind === CoveragePlanKind.SecurityResponse) {
    // Unlike Fire/Medical's instant cleanup, this is a temporary window buff -- set (not
    // extended/stacked) to a fresh SECURITY_RESPONSE_WINDOW_TICKS every activation, same
    // "re-triggering refreshes rather than stacks" convention as unrestResolutionBuffTicks
    // elsewhere in world.js.
    world._securityResponseTicksLeft = SECURITY_RESPONSE_WINDOW_TICKS;
    return true;
  }

  if (kind === CoveragePlanKind.PestControl) {
    // Instant full resolution, same shape as Fire/Medical -- clears every live rat (rats.js's own
    // tickRats catch-cleanup would otherwise only remove them one trap-catch at a time) and zeroes
    // the infestation level driving future spawns.
    const cleared = (world.rats || []).length;
    world.rats = [];
    world.ratsCaught = (world.ratsCaught || 0) + cleared;
    world.ratInfestation = 0;
    return true;
  }

  if (kind === CoveragePlanKind.UnrestResponse) {
    // Zeroes the input world.js's own real unrest system reads -- that system's periodic
    // _updateUnrest tick (every GRADING_INTERVAL_TICKS, ~3s) then resolves unrestActive/unrestTier
    // (and any resolution-reward eligibility) through its own existing logic, the same
    // "own the one state machine" respect this file already shows tickSecurityResponse's countdown
    // rather than reaching in and flipping unrestActive/unrestTier directly.
    world.unrestLevel = 0;
    return true;
  }

  if (kind === CoveragePlanKind.StormRecovery) {
    // Instant repair, same "instant full resolution of a real crisis state" shape as Fire/Medical --
    // restores every damaged-but-not-destroyed real weather-damage target back to full health.
    for (const s of world.structures) {
      if (s.destroyed || s.underConstruction) continue;
      if (!isWeatherRepairTargetKind(s.kind)) continue;
      const full = structureFullHealth(s.kind);
      if (s.health < full) s.health = full;
    }
    return true;
  }

  return false;
}

/** True while the Security Response call-in's temporary accuracy-boost window is still live --
 *  world.js's tick() reads this once per tick, world.js's serialize()/deserialize() persist the
 *  countdown itself. */
export function securityResponseWindowActive(world) {
  return (world._securityResponseTicksLeft || 0) > 0;
}

/** The actual accuracy-multiplier world.js's tick() folds into `combatAccuracy` before calling
 *  tickTurrets/tickStaffCombat -- 1 (no-op) once the window has expired, same "multiplier that
 *  degrades to identity" contract weather.js's weatherAccuracyMult already establishes. */
export function securityResponseAccuracyMult(world) {
  return securityResponseWindowActive(world) ? SECURITY_RESPONSE_ACCURACY_MULT : 1;
}

/** Decrements the call-in window countdown by one tick. Call once per tick from world.js's
 *  tick(), same "own the one countdown, everyone else just reads it" pattern as every other
 *  temporary-buff timer in this codebase (e.g. world.js's own unrestResolutionBuffTicks). */
export function tickSecurityResponse(world) {
  if (world._securityResponseTicksLeft > 0) world._securityResponseTicksLeft--;
}
