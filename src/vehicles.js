// Vehicles, the Super Energy Apocalypse: Recycled side of the mashup -- garbage/recycling
// trucks that periodically roll in, haul off a resource node or battlefield scrap, and roll
// back out. Purely automatic (no player driving), matching SEA:R's background-hauler flavor
// rather than a controllable unit.
const VEHICLE_SPEED = 0.11;
const SPAWN_INTERVAL_MIN = 500, SPAWN_INTERVAL_MAX = 900;
const GARBAGE_BONUS_MIN = 15, GARBAGE_BONUS_MAX = 40;

export class Vehicle {
  constructor(kind, x, y) {
    this.kind = kind; // 'recycling' | 'garbage'
    this.x = x; this.y = y;
    this.phase = 'inbound'; // inbound -> working -> outbound
    this.workTimer = 0;
    this.targetNode = null;
  }
}

function edgePoint(grid, rng) {
  const edge = Math.floor(rng() * 4);
  if (edge === 0) return { x: 0, y: rng() * grid.height };
  if (edge === 1) return { x: grid.width - 1, y: rng() * grid.height };
  if (edge === 2) return { x: rng() * grid.width, y: 0 };
  return { x: rng() * grid.width, y: grid.height - 1 };
}

export function maybeSpawnVehicle(world) {
  if (world.currentTick < world._nextVehicleTick) return;
  world._nextVehicleTick = world.currentTick + SPAWN_INTERVAL_MIN +
    Math.floor(world.rng() * (SPAWN_INTERVAL_MAX - SPAWN_INTERVAL_MIN));

  const kind = world.rng() < 0.5 ? 'recycling' : 'garbage';
  const spawn = edgePoint(world.grid, world.rng);
  const v = new Vehicle(kind, spawn.x, spawn.y);

  if (kind === 'recycling') {
    const candidates = world.resourceNodes.filter(n => !n.depleted && n.amount > 10);
    v.targetNode = candidates.length ? candidates[Math.floor(world.rng() * candidates.length)] : null;
    if (!v.targetNode) return; // nothing worth hauling right now, skip this spawn
  } else {
    v.targetX = world.width / 2 + (world.rng() - 0.5) * 6;
    v.targetY = world.height / 2 + (world.rng() - 0.5) * 6;
  }
  world.vehicles.push(v);
}

export function tickVehicles(world) {
  for (let i = world.vehicles.length - 1; i >= 0; i--) {
    const v = world.vehicles[i];

    if (v.phase === 'inbound') {
      const tx = v.kind === 'recycling' ? v.targetNode?.x : v.targetX;
      const ty = v.kind === 'recycling' ? v.targetNode?.y : v.targetY;
      if (tx == null || (v.kind === 'recycling' && v.targetNode.depleted)) { v.phase = 'outbound'; continue; }
      const dx = tx - v.x, dy = ty - v.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.6) { v.phase = 'working'; v.workTimer = 20; }
      else { v.x += (dx / dist) * VEHICLE_SPEED; v.y += (dy / dist) * VEHICLE_SPEED; }
      continue;
    }

    if (v.phase === 'working') {
      v.workTimer--;
      if (v.workTimer <= 0) {
        if (v.kind === 'recycling' && v.targetNode && !v.targetNode.depleted) {
          world.addScrap(Math.round(v.targetNode.amount));
          v.targetNode.amount = 0;
          v.targetNode.depleted = true;
        } else {
          world.addScrap(GARBAGE_BONUS_MIN + Math.floor(world.rng() * (GARBAGE_BONUS_MAX - GARBAGE_BONUS_MIN)));
        }
        const exit = edgePoint(world.grid, world.rng);
        v.targetX = exit.x; v.targetY = exit.y;
        v.phase = 'outbound';
      }
      continue;
    }

    if (v.phase === 'outbound') {
      const dx = v.targetX - v.x, dy = v.targetY - v.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.6) { world.vehicles.splice(i, 1); continue; }
      v.x += (dx / dist) * VEHICLE_SPEED; v.y += (dy / dist) * VEHICLE_SPEED;
    }
  }
}
