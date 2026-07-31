// Scrap economy: build costs and combat rewards. Condensed from SD.Siege's scrap balancing.
export const BUILD_COST = {
  wall: 2,
  wire: 1, // power conduit -- deliberately near-free so long runs are a layout problem, not a cost one
  fence: 3,
  trap: 15,
  turret: 25,
  bed: 8,
  table: 6,
  door: 5,
  generator: 30,
  generator_nuclear: 90, // expensive: high-reward wireless power radius, but risks the waste hazard, see siege.js
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
};

export const SCRAP_PER_KILL = 4;

export function canAfford(world, kind) {
  return world.scrap >= (BUILD_COST[kind] || 0);
}

export function spend(world, kind) {
  const cost = BUILD_COST[kind] || 0;
  if (world.scrap < cost) return false;
  world.scrap -= cost;
  return true;
}
