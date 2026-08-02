// Scrap economy: build costs and combat rewards. Condensed from SD.Siege's scrap balancing.
import { coveragePlanDiscountMult } from './coverageplans.js';
import { researchBuildCostMultiplier } from './research.js';

export const BUILD_COST = {
  wall: 2,
  wire: 1, // power conduit -- deliberately near-free so long runs are a layout problem, not a cost one
  pump: 28, // water source, see water.js -- priced close to generator since it's the analogous grid root
  pipe: 1, // water conduit, mirrors wire's near-free long-run pricing, see water.js
  // Valve (real Prison Architect water-network connector, see water.js's water_isConductor/
  // VALVE_FREEZE_CHANCE): joins the pipe/pump flood-fill exactly like pipe does, priced a bit
  // above pipe's near-free 1 (it's a discrete junction fixture, not a per-tile run cost) but
  // well below pump's 28 -- it has no pump's source role, just connectivity, so it shouldn't
  // approach source pricing.
  valve: 4,
  fence: 3,
  trap: 15,
  // Trap variety (RimWorld's real deadfall/IED-trap-tier split): trap (above) is kept exactly as
  // it always was for save-compat -- these are ADDITIONAL sub-kinds, not a replacement, same
  // "bare kind kept, new variants added" precedent as garage_recycling/garage_garbage's fuel
  // split above. trap_spike is a cheap melee/Blunt single-target deadfall (real RimWorld spike
  // trap: cheap, wood-tier); trap_explosive is a costlier small-radius Explosive trap that can
  // catch more than one attacker at once, priced above plain trap for that AoE upside. See
  // siege.js's TRAP_KINDS for the actual damage/radius numbers.
  trap_spike: 8,
  trap_explosive: 24,
  turret: 25,
  // Turret tiers (RimWorld's real mini-turret/autocannon/sniper-turret roster, each a genuine
  // tradeoff instead of a strict upgrade): 'turret' above is kept exactly as it always was for
  // save-compat AND because world.js still spawns it directly as the wave-4 starter turret --
  // these three are ADDITIONAL toolbar options. turret_mini: cheap/short-range, priced below
  // plain turret. turret_auto: longer range and harder-hitting than plain turret, but can't
  // engage a target inside its minRange (siege.js's TURRET_TIERS) -- the real autocannon
  // can't-hit-close-targets tradeoff. turret_sniper: the priciest, longest range, single heavy
  // shot, and the most expensive ammo-per-shot (siege.js's AMMO_PER_SHOT_TURRET_SNIPER) -- real
  // RimWorld anchor: a sniper-tier turret trades rate-of-fire and cost for range and alpha strike.
  turret_mini: 15,
  turret_auto: 38,
  turret_sniper: 58,
  // Mortar (RimWorld's real indirect-fire siege weapon): long range, inaccurate (scatter around
  // the target point rather than a guaranteed hit, see siege.js's MORTAR_SCATTER_RADIUS), high
  // per-shot damage, slow reload, expensive ammo (AMMO_PER_SHOT_MORTAR) -- priced above every
  // turret tier including sniper, matching its real-RimWorld role as the most expensive, highest
  // ceiling defense structure in the roster.
  mortar: 65,
  bed: 8,
  table: 6,
  door: 5,
  // Storage/Medical room roles (rooms.js RoomRole.Storage/Medical): cheap furniture-only additions,
  // no new mechanic. Shelf priced in the same cheap-furniture tier as table (PA-scale ~$6 anchor).
  // Medical Bed is priced at 2.5x plain Bed's cost (PA real anchor per the task brief).
  shelf: 6,
  medical_bed: 20,
  generator: 30,
  generator_nuclear: 90, // expensive: high-reward wireless power radius, but risks the waste hazard, see siege.js
  // SEA:R multi-source power economy (FEATURE_RESEARCH.md): each variant trades cost/pollution/
  // siting against the plain generator instead of being a strict upgrade -- see world.js's
  // pollution tick and power.js's isSource for how each one's tradeoff is actually enforced.
  generator_coal: 18, // cheapest of the bunch -- "worse plain generator", see its higher pollution-per-tick in world.js
  generator_wind: 35, // zero pollution, but only acts as a power source when sited on open ground (power.js)
  generator_solar: 40, // zero pollution, but only acts as a power source in open sky, not inside an enclosed room (power.js)
  waste_storage: 15, // cheap containment building -- keep nuclear generators worth building near it
  garage_recycling: 45, // bare kind kept for save-compat; defaults to 'gas' fuel, same cost as garage_recycling_gas
  garage_garbage: 35, // bare kind kept for save-compat; defaults to 'gas' fuel, same cost as garage_garbage_gas
  // SEA:R truck fuel-type tradeoff (see vehicles.js FUEL_TYPES / FEATURE_RESEARCH.md): each
  // garage kind now comes in 4 fuel variants, costed off the base garage price by fuel
  // costMult (fossil cheapest/dirtiest ... electric priciest/cleanest-but-power-hungry).
  garage_recycling_fossil: 34,
  garage_recycling_gas: 45,
  garage_recycling_ethanol: 52,
  garage_recycling_electric: 63,
  garage_garbage_fossil: 26,
  garage_garbage_gas: 35,
  garage_garbage_ethanol: 40,
  garage_garbage_electric: 49,
  watchtower: 20,
  floodlight: 12,
  tesla: 40,
  recycling_center: 55,
  camera: 8,
  monitor_station: 12,
  // Armory (FEATURE_RESEARCH.md's Prison Architect section, see security.js WEAPON_TIERS):
  // unlocks Rifle-tier issuance for every Guard/Sniper on the roster; a second Armory unlocks
  // Heavy tier. Priced between a turret (25) and a garage (35+) since it's a force multiplier
  // on personnel you've already paid upkeep for, not a direct combat structure of its own.
  armory: 32,
  // Processing station (real Prison Architect materials.txt: SheetMetal price -10 -> two staffed
  // workshop stations (WorkshopSaw/WorkshopPress, -1500 each) -> LicensePlate price -20, an exact
  // 2x raw-to-finished uplift). This project's dollar economy runs roughly 40x PA's, so anchored
  // off the existing garage tier (garage_recycling: 45 / garage_garbage: 35) instead of scaling
  // PA's -1500 literally. See jobs.js's Processing job for the raw-scrap-in/Components-out chain.
  workshop: 40,
  // Battery/power-switch (power.js's storage + manual-breaker mechanics, RimWorld's PowerNet
  // Battery/PowerSwitch): battery priced between the plain generator (30) and nuclear (90) tiers,
  // reflecting real utility (stores/discharges into the overload math) without being a source of
  // its own. Power switch is cheap on purpose, same "cheap relative to a real combat structure"
  // logic as RimWorld's real PowerSwitch being far cheaper than a turret -- it's a control tool,
  // not a defense or generation upgrade.
  battery: 50,
  power_switch: 6,
  // Rat Trap (rats.js, real Prison Architect infestation countermeasure): cheap, single-purpose
  // counter-buildable -- priced below a real combat trap (15) since it does nothing against
  // attackers, just catches rats at rats.js's real 65% rate.
  rat_trap: 10,
  // Stabilizer Beacon (anomaly.js): the "real in-game response" to anomaly pressure -- adds
  // extra passive decay to the meter while built and undestroyed, stacking up to
  // STABILIZER_MAX_STACKS. Priced in the same cheap single-purpose-counter-buildable tier as Rat
  // Trap, for the same reason: it does nothing against attackers, purely a hazard-management tool.
  stabilizer: 18,
  // Shrine (RimWorld Ideology DLC's real altar buildable): a single-tier, beauty-only passive
  // building -- no function beyond a flat Beauty contribution to whatever room it's placed inside
  // (see rooms.js's BEAUTY_BY_KIND.shrine). Priced between door (5) and monitor_station (12) --
  // similar cost tier to the other small single-purpose decor/sensor buildables (camera: 8,
  // table: 6), reflecting that it's cheap to place but purely cosmetic, not a functional upgrade.
  shrine: 10,
  // Vest (citizens.js's hasVest / siege.js's CITIZEN_VEST_ARMOR_RATING/resolveCitizenArmorRoll):
  // a per-CITIZEN purchase, not a structure -- world.buyVest spends this once per citizen equipped.
  // Priced with door (5)/table (6) rather than a combat structure like trap (15)/turret (25): it's
  // real, measured protection (see siege.js's comment on the average-damage reduction it buys a
  // vested citizen) but civilian-grade personal gear, not a defense placement of its own.
  vest: 10,
  // Shield (siege.js's EnergyShield -- a separate absorb-before-armor layer, purchasable
  // alongside Vest, not instead of it): priced above SPECIALIST_WEAPON_COST (security.js, 60)
  // to keep guaranteed damage negation the top-tier personal-gear purchase, above Vest's
  // civilian-grade mitigation-roll protection.
  shield: 75,
  // Fitness Station (PA needs.txt Exercise -- see citizens.js's EXERCISE_DECAY / jobs.js's
  // SeekingExercise-Exercising job / rooms.js's RoomRole.Gymnasium): ONE consolidated buildable
  // standing in for PA's whole real gym-equipment catalog (Treadmill/TyreApparatus/PullUpBars/
  // PushUpStones/GymMat, ~10 objects), same consolidation precedent as every other buildable here
  // representing a PA/RimWorld category rather than each individual real object. Priced cheap,
  // same tier as bed (8)/door (5) -- a needs-refill fixture, not a combat or utility structure.
  fitness_station: 9,
  // Lightning Rod (weather.js's Lightning Storm calamity, real Prison Architect calamity_settings.txt
  // mitigation item): cheap on purpose -- a real PA lightning rod is a small, inexpensive counter-
  // buildable, same "cheap, single-purpose counter" pricing logic as rat_trap/stabilizer above.
  lightning_rod: 14,
  // Fabrication Bay (drones.js -- RimWorld Biotech's mech-companion labor drone, see that
  // module's header comment): unlocks drone capacity, matching the "a building unlocks capacity,
  // not a per-unit purchase" pattern security.js's tickArmoryIssuance already established for
  // Armory/weapon tiers. Priced in the garage/workshop mid tier (garage_garbage_gas: 35,
  // workshop: 40, garage_recycling_gas: 45) -- a real strategic investment, not a cheap add-on.
  fabrication_bay: 48,
  // Farm Plot (research.js's Agronomy node, jobs.js's Farming job): a renewable citizen-tended
  // producer, priced near Fitness Station/Rat Trap's cheap single-purpose tier (9-15) rather than
  // a combat or utility structure -- the real payoff is the ongoing tended cycle, not the
  // placement itself.
  farm_plot: 16,
  // Restaurant (Prison Architect real prefab catalog's Restaurant+Bakery combo -- Fridge/Cooker/
  // DoughMixer/DisplayCounter/ShopCounter/CakeStand consolidated into ONE representative
  // buildable, same consolidation precedent as Fitness Station standing in for PA's whole gym-
  // equipment catalog above): a staffed station generating steady scrap "retail income" once a
  // citizen mans it, distinct from Farm Plot's renewable-tending loop and Workshop's raw-input
  // conversion chain -- see jobs.js's Restaurant job for the no-raw-input, staffed-for-a-trickle
  // shape (closest existing precedent is Recycling Center's passive-but-staffed-for-a-bonus
  // pattern, adapted here to require staffing rather than just existing unstaffed). Priced in the
  // same staffed-producer tier as Workshop (40) / Recycling Center (55), between the two since it
  // needs a worker (unlike Recycling Center) but has no raw-scrap input cost to net against
  // (unlike Workshop).
  restaurant: 46,
  // Checkpoint (real PA DLC prefab catalog: ScannerMachine/MetalDetector/CheckPoint, reskinned
  // with zero carceral framing -- a security screening chokepoint, not a prison search station).
  // See security.js's isNearCheckpoint/CHECKPOINT_DIVERSION_REDUCTION and factions.js's
  // CHECKPOINT_CONSEQUENCE_REDUCTION for the real mechanical hook: reduces a corrupt staffer's
  // scrap diversion and a rival clique's unmet-demand consequence severity, but only for whoever
  // actually passes within its radius. Priced in the same cheap single-purpose-counter-buildable
  // tier as Rat Trap (10)/Stabilizer (18)/Lightning Rod (14) -- it does nothing against attackers,
  // purely a corruption/unrest-management tool.
  checkpoint: 16,
  // Cinema (real PA DLC prefab catalog: WatchCinema provider, see jobs.js's tickCinemas/
  // CINEMA_RANGE for the group-broadcast mechanic this buildable actually runs). Priced above
  // plain Recreation-zone furniture (bed 8/table 6/fitness_station 9) since it's a broadcast
  // building that benefits every citizen within a 10-tile radius simultaneously rather than one
  // occupant at a time -- closer to Tesla Coil's (40) "hits everyone in range" niche than a
  // single-citizen fixture, but priced below it since Cinema is passive furniture with no combat
  // upkeep. Landed in the same tier as Watchtower (20)/Recycling Center-adjacent buildings.
  cinema: 26,
  // Power Exporter (real PA DLC mechanic -- Transformer/PowerExportMeter/QuickConnect -- see
  // power.js's tickPowerExporters for the full surplus-gated trickle mechanic): converts a
  // segment's genuine spare generator capacity into scrap. Priced in the same power-utility tier
  // as Battery (50) -- a real strategic investment requiring an already-built surplus of
  // generation to pay off at all, not a cheap add-on like Wire/Power Switch.
  power_exporter: 42,
  // Scavenged Augments (augments.js -- inspired by the well-known "installable permanent
  // stat-boost with a real tradeoff" CONCEPT from RimWorld's bionic/cybernetic mod category,
  // reskinned to this project's own SEA:R scavenged-tech aesthetic, see that file's header
  // comment). A per-CITIZEN purchase like Vest above, not a structure -- world.buyAugment spends
  // one of these once per citizen per augment slot. Priced above Vest (10) since each carries a
  // real permanent upside, roughly in the trap/turret combat-structure tier for the combat rig,
  // the garage/workshop mid tier for the work-speed servo-limb (a genuine economic investment,
  // not a cheap add-on), and between the two for the endurance rig.
  augment_combat: 26,
  augment_work: 30,
  augment_endurance: 22,
  // Shower (citizens.js's HYGIENE_DECAY, RimWorld QoL-mod-style hygiene need -- see jobs.js's
  // findNearestShower/JobState.Bathing): a cheap needs-refill fixture, same tier as Fitness
  // Station (9)/Bed (8) -- but unlike either of those, it does nothing at all unless it's also
  // connected to the water grid (an extra pump/pipe run cost the player has to actually pay for
  // it to function, not baked into this price).
  shower: 8,
};

export const SCRAP_PER_KILL = 4;

// Trader-caravan random event (weather.js's tryTraderEvent, mirrors RimWorld's real
// TraderCaravanArrival/VisitorGroup IncidentDefs -- see weather.js's EVENT_WEIGHTS comment):
// a discounted-cost voucher on the next few buildables, active for a real-but-short window so a
// hands-off colony can't just bank it forever. Both the discount and the window are read here
// (the actual point-of-sale) rather than duplicated in weather.js.
export const TRADER_DISCOUNT_PCT = 0.4; // 40% off -- meaningful, not a rounding-error discount
export const TRADER_VOUCHER_USES = 3; // next N buildable purchases, whichever runs out first
export const TRADER_WINDOW_TICKS = 400; // ~40s at 10Hz -- "a few hundred ticks" per the task brief

/** True while a trader voucher is still live (uses remaining AND window not yet expired). */
export function traderVoucherActive(world) {
  return (world._traderVoucherUses || 0) > 0 && world.currentTick <= (world._traderVoucherExpireTick ?? -1);
}

/** The actual scrap cost of `kind` right now, discount included if a voucher is active. Exported
 *  so input.js's cost-preview UI can show the discounted price, not just canAfford/spend. */
export function buildCost(world, kind) {
  const base = BUILD_COST[kind] || 0;
  let cost = base;
  if (traderVoucherActive(world)) cost *= (1 - TRADER_DISCOUNT_PCT);
  // Coverage Plans (coverageplans.js): a purchased plan permanently discounts its themed
  // buildables -- stacks multiplicatively with a trader voucher, same as any other discount
  // layered on top of the base price.
  cost *= coveragePlanDiscountMult(world, kind);
  // LowerTaxes research node (research.js, real Prison Architect Finance branch): a flat,
  // permanent construction-cost discount once unlocked, stacks with the above like any other layer.
  cost *= researchBuildCostMultiplier(world.research);
  return Math.max(0, Math.round(cost));
}

export function canAfford(world, kind) {
  return world.scrap >= buildCost(world, kind);
}

export function spend(world, kind) {
  const cost = buildCost(world, kind);
  if (world.scrap < cost) return false;
  world.scrap -= cost;
  if (world.finance) world.finance.buildSpend += cost; // budget-report ledger, see world.js's finance comment
  if (traderVoucherActive(world)) world._traderVoucherUses -= 1; // one use consumed per purchase, discounted or not
  return true;
}

// Demolish refund (input.js's new Demolish tool -- this project previously had NO way to remove a
// placed structure or cancel an unfinished blueprint at all, an explicit project-owner ask).
// A finished structure refunds a real fraction of its cost rather than 100% (removing something
// you already got value from shouldn't be a free undo) or 0% (a misplaced structure would be a
// total loss, discouraging the player from ever using the tool) -- 50% lands in the middle, the
// same "meaningful but not free" fraction RimWorld's own deconstruct-for-partial-materials
// convention uses. Deliberately keyed off the FLAT BUILD_COST table, not the discount-aware
// buildCost() above -- a refund based on whatever discount happens to be active AT DEMOLISH TIME
// (trader voucher, coverage plan) rather than what was actually paid at build time would let a
// player build at full price then demolish during an active discount window for a bigger refund
// than they spent, a real scrap-generation exploit; the flat table has no such time-dependence.
// Ideally this would post to its own `world.finance.demolishRefund` ledger category (matching the
// existing ratLoss/corruptionLoss pattern), but world.js's finance object isn't owned by this
// task -- input.js instead applies the refund straight to `world.scrap`, see that file's
// `_removeStructureAt`. A finance-ledger category for this is a reasonable, low-risk follow-up
// for whoever next touches world.js.
export const DEMOLISH_REFUND_FRACTION = 0.5;

/** Scrap refunded for demolishing a FINISHED (not under-construction) structure of `kind`. An
 *  unbuilt blueprint refunds nothing -- input.js's Demolish tool deletes a blueprint outright
 *  without calling this at all (no cost was fully spent on it yet beyond what jobs.js's
 *  construction-progress tracking already accounts for). */
export function demolishRefund(kind) {
  return Math.round((BUILD_COST[kind] || 0) * DEMOLISH_REFUND_FRACTION);
}
