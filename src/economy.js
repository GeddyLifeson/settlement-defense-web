// Scrap economy: build costs and combat rewards. Condensed from SD.Siege's scrap balancing.
export const BUILD_COST = {
  wall: 2,
  wire: 1, // power conduit -- deliberately near-free so long runs are a layout problem, not a cost one
  pump: 28, // water source, see water.js -- priced close to generator since it's the analogous grid root
  pipe: 1, // water conduit, mirrors wire's near-free long-run pricing, see water.js
  fence: 3,
  trap: 15,
  turret: 25,
  bed: 8,
  table: 6,
  door: 5,
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
};

export const SCRAP_PER_KILL = 4;

export function canAfford(world, kind) {
  return world.scrap >= (BUILD_COST[kind] || 0);
}

export function spend(world, kind) {
  const cost = BUILD_COST[kind] || 0;
  if (world.scrap < cost) return false;
  world.scrap -= cost;
  if (world.finance) world.finance.buildSpend += cost; // budget-report ledger, see world.js's finance comment
  return true;
}
