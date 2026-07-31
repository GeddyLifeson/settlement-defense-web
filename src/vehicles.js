// Vehicles, the Super Energy Apocalypse: Recycled side of the mashup -- garbage/recycling
// trucks. Unlike the first pass, these don't spawn on their own: a citizen has to build the
// garage (blueprint, same construction pipeline as everything else) and then a citizen has to
// drive it. An undriven truck just sits parked at its garage.
import { isPowered } from './siege.js';

const VEHICLE_SPEED = 0.11;
const GARBAGE_BONUS_MIN = 15, GARBAGE_BONUS_MAX = 40;
const DRIVER_ENTER_RANGE = 0.5;
const BASE_WORK_TIMER = 20;

// SEA:R's truck fuel-type tradeoff (see FEATURE_RESEARCH.md): each truck picks one of four
// fuels at garage-build time (garage variant, see economy.js/input.js), a genuine tradeoff
// rather than a strict-best choice:
//  - fossil: cheapest garage, but the dirtiest -- every haul cycle belches real exhaust
//    pollution on top of whatever the haul itself does.
//  - gas: the "best all-around" middle ground -- moderate cost, low exhaust.
//  - ethanol: clean exhaust, but it's brewed from the settlement's food surplus -- completing
//    a haul temporarily saps the Food zone's refill rate (there's no bulk food-stockpile
//    resource in this codebase to drain directly, so this is the most honest portable stand-in).
//  - electric: cleanest exhaust of all, but energy-hungry -- a haul only runs at full speed if
//    the garage is actually powered (world.isPowered, same connected-power-graph turrets use);
//    unpowered, the work phase drags on far longer.
export const FUEL_TYPES = Object.freeze({
  fossil:   { label: 'Fossil Fuel', costMult: 0.75, exhaustPollution: 3.5,  ethanolPenalty: false, requiresPower: false },
  gas:      { label: 'Natural Gas', costMult: 1.0,  exhaustPollution: 1.0,  ethanolPenalty: false, requiresPower: false },
  ethanol:  { label: 'Ethanol',     costMult: 1.15, exhaustPollution: 0.3,  ethanolPenalty: true,   requiresPower: false },
  electric: { label: 'Electric',    costMult: 1.4,  exhaustPollution: 0.05, ethanolPenalty: false, requiresPower: true },
});
export const DEFAULT_FUEL_TYPE = 'gas';
const ETHANOL_PENALTY_TICKS = 150; // ~15s at the 10Hz tick rate -- Food zone refill roughly halved meanwhile
const UNPOWERED_ELECTRIC_WORK_MULT = 2.5; // an electric truck with no generator feeding its garage crawls

// Garage build-toolbar kinds are 'garage_<recycling|garbage>_<fuel>' (plus the original bare
// 'garage_recycling'/'garage_garbage' kept working as a 'gas' default for save-compat and for
// any other in-flight work still referencing the un-suffixed kind). Centralized here so
// world.js's structure-filter pass and input.js's toolbar stay in sync off one source of truth.
export function parseGarageKind(kind) {
  if (kind === 'garage_recycling') return { truckKind: 'recycling', fuelType: DEFAULT_FUEL_TYPE };
  if (kind === 'garage_garbage') return { truckKind: 'garbage', fuelType: DEFAULT_FUEL_TYPE };
  const m = /^garage_(recycling|garbage)_(fossil|gas|ethanol|electric)$/.exec(kind);
  return m ? { truckKind: m[1], fuelType: m[2] } : null;
}

export class Vehicle {
  constructor(kind, garageX, garageY, fuelType = DEFAULT_FUEL_TYPE) {
    this.kind = kind; // 'recycling' | 'garbage'
    this.fuelType = fuelType; // 'fossil' | 'gas' | 'ethanol' | 'electric', see FUEL_TYPES above
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
export function spawnParkedVehicle(world, kind, x, y, fuelType = DEFAULT_FUEL_TYPE) {
  world.vehicles.push(new Vehicle(kind, x, y, fuelType));
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
      if (dist < 0.6) {
        v.phase = 'working';
        const fuel = FUEL_TYPES[v.fuelType] || FUEL_TYPES[DEFAULT_FUEL_TYPE];
        // Electric's "energy-hungry" bite: without a generator actually feeding the garage,
        // the haul takes far longer -- the same connected-power-graph check turrets use, not a
        // fake stat.
        v.workTimer = (fuel.requiresPower && !isPowered(world.structures, v.garageX, v.garageY))
          ? BASE_WORK_TIMER * UNPOWERED_ELECTRIC_WORK_MULT : BASE_WORK_TIMER;
      }
      else { v.x += (dx / dist) * VEHICLE_SPEED; v.y += (dy / dist) * VEHICLE_SPEED; }
      continue;
    }

    if (v.phase === 'working') {
      v.workTimer--;
      if (v.workTimer <= 0) {
        const fuel = FUEL_TYPES[v.fuelType] || FUEL_TYPES[DEFAULT_FUEL_TYPE];
        // Every completed haul burns fuel regardless of what the haul itself does -- fossil
        // trucks visibly dirty the air as they work, gas trucks a little, ethanol/electric
        // almost none. This is on top of (not instead of) the garbage truck's own
        // pollution-reduction below, so a cheap fossil garbage truck is a real net-worse
        // cleaner than a gas or electric one despite costing less to build.
        world.pollution = Math.max(0, world.pollution + fuel.exhaustPollution);
        if (fuel.ethanolPenalty) world.ethanolPenaltyTimer = ETHANOL_PENALTY_TICKS;
        if (v.kind === 'recycling' && v.targetNode && !v.targetNode.depleted) {
          world.addScrap(Math.round(v.targetNode.amount), 'haul');
          v.targetNode.amount = 0;
          v.targetNode.depleted = true;
        } else {
          // Garbage trucks haul off waste rather than scrap -- SEA:R's actual mechanic (see
          // FEATURE_RESEARCH.md): a real pollution reduction plus a small scrap side-benefit
          // from whatever's recoverable, not primarily a scrap-generation vehicle.
          world.pollution = Math.max(0, world.pollution - (25 + world.rng() * 20));
          world.addScrap(GARBAGE_BONUS_MIN + Math.floor(world.rng() * (GARBAGE_BONUS_MAX - GARBAGE_BONUS_MIN)), 'haul');
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
