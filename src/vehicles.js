// Vehicles, the Super Energy Apocalypse: Recycled side of the mashup -- garbage/recycling
// trucks. Unlike the first pass, these don't spawn on their own: a citizen has to build the
// garage (blueprint, same construction pipeline as everything else) and then a citizen has to
// drive it. An undriven truck just sits parked at its garage.
const VEHICLE_SPEED = 0.11;
const GARBAGE_BONUS_MIN = 15, GARBAGE_BONUS_MAX = 40;
const DRIVER_ENTER_RANGE = 0.5;

export class Vehicle {
  constructor(kind, garageX, garageY) {
    this.kind = kind; // 'recycling' | 'garbage'
    this.garageX = garageX; this.garageY = garageY;
    this.x = garageX; this.y = garageY;
    this.driverId = null;
    this.phase = 'parked'; // parked -> inbound -> working -> outbound -> parked
    this.workTimer = 0;
    this.targetNode = null;
  }
}

// Called when a garage blueprint finishes construction (see world.js) -- one vehicle per
// garage, parked and waiting for a driver.
export function spawnParkedVehicle(world, kind, x, y) {
  world.vehicles.push(new Vehicle(kind, x, y));
}

export function findUndrivenVehicle(vehicles, x, y) {
  let best = null, bestDist = Infinity;
  for (const v of vehicles) {
    if (v.driverId != null || v.phase !== 'parked') continue;
    const d = Math.hypot(v.x - x, v.y - y);
    if (d < bestDist) { bestDist = d; best = v; }
  }
  return best;
}

// Called by jobs.js once a citizen has walked up to a parked vehicle -- hands over the wheel
// and kicks off one haul cycle.
export function boardVehicle(world, vehicle, citizenId) {
  vehicle.driverId = citizenId;
  if (vehicle.kind === 'recycling') {
    const candidates = world.resourceNodes.filter(n => !n.depleted && n.amount > 10);
    vehicle.targetNode = candidates.length ? candidates[Math.floor(world.rng() * candidates.length)] : null;
    if (!vehicle.targetNode) { vehicle.phase = 'outbound'; vehicle.targetX = vehicle.garageX; vehicle.targetY = vehicle.garageY; return; }
  } else {
    vehicle.targetX = world.width / 2 + (world.rng() - 0.5) * 6;
    vehicle.targetY = world.height / 2 + (world.rng() - 0.5) * 6;
  }
  vehicle.phase = 'inbound';
}

export function tickVehicles(world) {
  for (const v of world.vehicles) {
    if (v.driverId == null) continue; // parked, waiting for a driver -- nothing to do

    if (v.phase === 'inbound') {
      const tx = v.kind === 'recycling' ? v.targetNode?.x : v.targetX;
      const ty = v.kind === 'recycling' ? v.targetNode?.y : v.targetY;
      if (tx == null || (v.kind === 'recycling' && v.targetNode.depleted)) {
        v.phase = 'outbound'; v.targetX = v.garageX; v.targetY = v.garageY; continue;
      }
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
        v.targetX = v.garageX; v.targetY = v.garageY;
        v.phase = 'outbound';
      }
      continue;
    }

    if (v.phase === 'outbound') {
      const dx = v.targetX - v.x, dy = v.targetY - v.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.6) {
        // Back home -- release the driver (jobs.js clears their Driving state next tick when
        // it sees driverId no longer matches them) and park until someone boards again.
        v.driverId = null;
        v.phase = 'parked';
        v.x = v.garageX; v.y = v.garageY;
        continue;
      }
      v.x += (dx / dist) * VEHICLE_SPEED; v.y += (dy / dist) * VEHICLE_SPEED;
    }
  }
}
