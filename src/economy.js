// Scrap economy: build costs and combat rewards. Condensed from SD.Siege's scrap balancing.
export const BUILD_COST = {
  wall: 2,
  fence: 3,
  trap: 15,
  turret: 25,
  bed: 8,
  table: 6,
  door: 5,
  generator: 30,
  garage_recycling: 45,
  garage_garbage: 35,
  watchtower: 20,
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
