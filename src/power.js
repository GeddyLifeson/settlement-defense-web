// Power as a real connected wire graph, ported from Prison Architect's utilities grid (see
// FEATURE_RESEARCH.md: "Power/water as a real wired-graph network"). PA runs power from a
// station out along wire conduits; anything not physically on the wire run gets nothing, no
// matter how close it is. That connectivity rule is the part worth porting -- this replaces
// the old "any generator within POWER_RANGE" radius stub, which made adjacency irrelevant.
//
// The graph is a flood-fill over orthogonally-adjacent conductor tiles (generators + wires),
// same shape as rooms.js's detectRooms, and is recomputed only when the conductor layout
// actually changes -- mirroring the _roomsWallSignature check in world.js's tick().
const POWER_NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const TILE_STRIDE = 100000; // packs (tx, ty) into one integer key; maps are far smaller than this

export function powerTileKey(x, y) {
  return Math.floor(x) * TILE_STRIDE + Math.floor(y);
}

// SEA:R multi-source power economy (FEATURE_RESEARCH.md): coal is a straight cost/pollution
// tradeoff (see economy.js/world.js) and plugs into the grid exactly like a plain generator --
// no siting condition. Wind and solar DO carry a real siting condition though, and this codebase
// has no elevation or roof/indoor concept to check against (see grid.js's TerrainKind -- just
// Bare/Soil/Rock/Water -- and rooms.js's enclosed-room flood-fill, which is the closest thing to
// "indoors" that exists). Rather than invent fake elevation/roof data, each substitutes the
// honest nearest equivalent already in the sim:
//   - Wind ("needs high ground"): substituted with "needs open, unobstructed ground" -- no other
//     structure within WIND_CLEARANCE_RADIUS (wires/pipes excluded, since a turbine still needs a
//     wire run out to actually deliver anywhere; it's other buildings crowding the site that
//     count as the obstruction). Sited badly, it simply doesn't act as a power source at all this
//     tick -- a stark but honest and easily-verified stand-in for "reduced output", given this
//     engine's power model is a binary source/no-source graph (power.js has no notion of partial
//     wattage to reduce).
//   - Solar ("needs open sky"): substituted with "not built inside a detected enclosed room" (see
//     rooms.js's detectRooms -- a room is by definition walled-in on every side, the closest
//     analog to "roofed/indoors" this codebase has). world.js's tick() stamps s._openSky onto
//     every generator_solar structure each tick (mirroring the s._staffed pattern already used
//     for monitor_station); isSource below just reads it back. Same binary source/no-source
//     tradeoff as wind above, for the same reason.
const WIND_CLEARANCE_RADIUS = 2.5;

// Exported (rather than kept private like isSource/isConductor) so world.js's tick() can stamp
// s._windSited onto each generator_wind structure purely for render.js to read back and tint the
// turbine blades -- the power graph itself (isSource below) always recomputes this live and never
// depends on the stamped flag, so there's no lag in what actually gets powered, only in the paint.
export function isWindSited(s, structures) {
  for (const other of structures) {
    if (other === s || other.kind === 'wire' || other.kind === 'pipe' || other.destroyed) continue;
    if (Math.hypot(other.x - s.x, other.y - s.y) <= WIND_CLEARANCE_RADIUS) return false;
  }
  return true;
}

// Any generator variant counts as a source (plain 'generator', 'generator_nuclear', ...) so new
// generator types plug into the grid without needing to be listed here -- except wind/solar,
// which are only sources when their siting condition (above) actually holds.
function isSource(s, structures) {
  if (s.kind === 'generator_wind') return isWindSited(s, structures);
  if (s.kind === 'generator_solar') return s._openSky !== false; // see world.js's tick(), defaults true until the first room pass
  return s.kind === 'generator' || s.kind.startsWith('generator_');
}

// Power switch (Prison Architect's manual breaker idea): a conductor tile the player can toggle
// off to deliberately split a segment in two without physically removing wire -- real manual
// control over the graph, not cosmetic. Battery (below) is always a conductor when built: it sits
// "on the wire" like RimWorld's PowerNet batteries, never a source of its own (isSource stays
// false for it), just a pass-through node that also happens to store/release energy.
function isConductor(s, structures) {
  if (s.kind === 'power_switch') return s.switchedOn !== false && !s.destroyed && !s.underConstruction;
  return (s.kind === 'wire' || s.kind === 'battery' || isSource(s, structures)) && !s.destroyed && !s.underConstruction;
}

// Cheap order-sensitive hash of every live conductor's tile+kind, so the O(n) rebuild only runs
// when a wire/generator is built, finished, or destroyed -- not every tick for every turret. Also
// changes whenever a wind/solar generator's siting eligibility flips (isSource reads live state
// for those two), so a turbine losing its clearance or a solar array losing open sky correctly
// triggers a recompute instead of coasting on a stale cached graph.
function layoutSignature(structures) {
  let h = 17;
  for (let i = 0; i < structures.length; i++) {
    const s = structures[i];
    if (!isConductor(s, structures)) continue;
    h = (Math.imul(h, 31) + powerTileKey(s.x, s.y) + (isSource(s, structures) ? 7 : 3)) | 0;
  }
  return h;
}

let _cachedSignature = null;
let _cachedEnergized = new Set();

function computeEnergized(structures) {
  const conductors = new Set();
  const sources = [];
  for (const s of structures) {
    if (!isConductor(s, structures)) continue;
    const k = powerTileKey(s.x, s.y);
    conductors.add(k);
    if (isSource(s, structures)) sources.push(k);
  }

  const energized = new Set();
  const queue = [];
  for (const k of sources) {
    if (energized.has(k)) continue;
    energized.add(k);
    queue.push(k);
  }
  while (queue.length) {
    const k = queue.pop();
    const tx = Math.floor(k / TILE_STRIDE);
    const ty = k - tx * TILE_STRIDE;
    for (const [dx, dy] of POWER_NEIGHBORS) {
      const nk = (tx + dx) * TILE_STRIDE + (ty + dy);
      if (energized.has(nk) || !conductors.has(nk)) continue;
      energized.add(nk);
      queue.push(nk);
    }
  }
  return energized;
}

// Set of tile keys that are actually carrying power right now: every generator, plus every wire
// with an unbroken wire path back to one. Cut the chain and the far half goes dark.
export function energizedTiles(structures) {
  const sig = layoutSignature(structures);
  if (sig !== _cachedSignature) {
    _cachedSignature = sig;
    _cachedEnergized = computeEnergized(structures);
  }
  return _cachedEnergized;
}

// True if this tile is itself energized (i.e. it holds a live wire/generator).
export function isTileEnergized(structures, x, y) {
  return energizedTiles(structures).has(powerTileKey(x, y));
}

// Nuclear generator's reward half (see siege.js's NUCLEAR_HAZARD_* comment for the risk half):
// it energizes everything within a short radius directly, no wire run required, unlike a plain
// generator which only reaches through the conductor graph above. That's the "significantly more
// power" payoff for the waste-containment risk it carries.
export const NUCLEAR_WIRELESS_RADIUS = 3;

function isNearActiveNuclearGenerator(structures, x, y) {
  for (const s of structures) {
    if (s.kind !== 'generator_nuclear' || s.destroyed || s.underConstruction) continue;
    if (Math.hypot(s.x - x, s.y - y) <= NUCLEAR_WIRELESS_RADIUS) return true;
  }
  return false;
}

// A consumer draws power if it sits on, or orthogonally touches, an energized tile -- so a
// turret can either hug the generator directly or be fed by a wire run from across the map --
// or if it's simply within a nuclear generator's wireless radius (no wire needed at all).
export function isPoweredAt(structures, x, y) {
  if (isNearActiveNuclearGenerator(structures, x, y)) return true;
  const energized = energizedTiles(structures);
  if (energized.size === 0) return false;
  const tx = Math.floor(x), ty = Math.floor(y);
  if (energized.has(tx * TILE_STRIDE + ty)) return true;
  for (const [dx, dy] of POWER_NEIGHBORS) {
    if (energized.has((tx + dx) * TILE_STRIDE + (ty + dy))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Overload risk (Prison Architect's power-grid overload mechanic). PA lets you wire too many
// powered fixtures onto too few/weak generators; the grid strains and eventually something pops.
// This ports the same idea onto the connected-graph model above: every generator variant
// contributes a fixed capacity to whichever segment (connected component of wire+generator
// tiles) it feeds, every powered consumer draws a fixed load from the segment it's fed by, and a
// segment whose total load exceeds its capacity is "overloaded" -- consumers on it lose the
// powered bonus (soft, always-correct, immediately visible) and, while it stays overloaded, its
// conductor tiles carry a small per-tick chance to catch fire (rare, escalating stakes -- reuses
// fire.js's igniteStructure/tickFire directly rather than a parallel damage system).
//
// Capacities are pulled from RimWorld's OWN ThingDefs_Buildings/Buildings_Power.xml wattages,
// scaled to this codebase's baseline of 5 for a plain generator (RimWorld's wood/chemfuel
// generator: 1000W). Ratios, not vibes:
//   generator_coal:   0.9x  (worse than plain -- see economy.js's "worse plain generator" cost
//                     comment, which this number now actually agrees with, unlike the old table)
//   generator_solar:  1.7x  (RimWorld solar: 1700W)
//   generator_wind:   2.3x  (RimWorld wind: 2300W -- genuinely beats solar, same as the real def)
//   generator_nuclear: highest tier, anchored above geothermal's 3.6x (RimWorld's biggest
//                     baseload single-tile source) since this codebase's nuclear generator is
//                     already a distinct high-risk/high-reward fictional tier (waste-hazard
//                     containment mechanic below), not a literal port of any one RimWorld def.
// Previously wind/solar sat at 2.5 -- BELOW the plain generator's 5 -- which was backwards: in
// RimWorld both renewables out-produce the baseline generator per-building, their real tradeoff is
// siting reliability (isSource above), not raw capacity. Fixed here; siting is still the thing
// that can drop them to zero, capacity is just what they deliver when actually sited.
const GENERATOR_CAPACITY = {
  generator: 5,
  generator_coal: 4.5,
  generator_nuclear: 19,
  generator_wind: 11.5,
  generator_solar: 8.5,
};

// Battery (RimWorld's PowerNet battery, storedEnergyMax=600/efficiency=0.5, scaled to this
// codebase's small integer capacity/load units): stores surplus capacity from its segment and
// releases it back when the segment is short, plugging straight into the connected-graph model
// above as an always-on conductor (isConductor) that is never itself a source (isSource stays
// false for it -- see the comment on isConductor). tickBatteries (called once per tick from
// world.js, BEFORE this tick's overload/hasPoweredBonus checks read it) is the only thing that
// mutates a battery structure's `storedEnergy`.
export const BATTERY_STORED_MAX = 20; // full charge, roughly 4x a plain generator's per-tick capacity
export const BATTERY_CHARGE_RATE = 1.2; // max stored-energy gained per tick from segment surplus
export const BATTERY_DISCHARGE_RATE = 1.2; // max stored-energy DRAWN per tick to help cover a deficit
// Real, measured tradeoff (RimWorld's actual battery efficiency stat): only half of what's drawn
// from storage actually reaches the grid -- the rest is lost. Charging is not lossy (mirrors
// RimWorld: the efficiency loss is on discharge, not charge).
export const BATTERY_EFFICIENCY = 0.5;

// Load each powered consumer draws once it's actually receiving the powered bonus (siege.js's
// POWERED_DAMAGE_MULT/POWERED_RANGE_MULT, world.js's watchtower warning-window boost). Tesla
// draws more than a plain turret -- it chains to every attacker in range on every activation
// (siege.js's TESLA_RANGE/TESLA_COOLDOWN_TICKS comment), the power-hungry crowd-control pick.
// Anything else that ever starts consuming the powered bonus defaults to a flat 1 rather than
// silently drawing nothing.
const CONSUMER_LOAD = { turret: 1, tesla: 1.5, watchtower: 1 };
const POWERED_CONSUMER_KINDS = new Set(Object.keys(CONSUMER_LOAD));
function consumerLoad(kind) {
  return CONSUMER_LOAD[kind] ?? 1;
}

// Rare, occasional threat, same tuning philosophy as fire.js's own ignition constants (see that
// file's header) -- but rolled per overloaded conductor tile per tick, and deliberately higher
// than a healthy generator's baseline spark chance (fire.js's IGNITION_CHANCE_PER_GENERATOR)
// since overload is itself an avoidable, player-caused condition, not ambient risk.
export const OVERLOAD_FIRE_CHANCE_PER_TICK = 0.0004;

function findSegmentIdForConsumer(x, y, segIdOf) {
  const tx = Math.floor(x), ty = Math.floor(y);
  const selfKey = tx * TILE_STRIDE + ty;
  if (segIdOf.has(selfKey)) return segIdOf.get(selfKey);
  for (const [dx, dy] of POWER_NEIGHBORS) {
    const k = (tx + dx) * TILE_STRIDE + (ty + dy);
    if (segIdOf.has(k)) return segIdOf.get(k);
  }
  return null;
}

// Flood-fills the same conductor graph as computeEnergized, but keeps each connected component
// (segment) distinct instead of merging them into one big energized set, and sums the capacity
// of every source-eligible generator each segment actually contains.
function computeSegments(structures) {
  const conductors = new Map(); // tileKey -> structure
  for (const s of structures) {
    if (!isConductor(s, structures)) continue;
    conductors.set(powerTileKey(s.x, s.y), s);
  }

  const segIdOf = new Map(); // tileKey -> segment id
  const segments = []; // { id, capacity, load }
  for (const [startKey] of conductors) {
    if (segIdOf.has(startKey)) continue;
    const id = segments.length;
    let capacity = 0;
    const queue = [startKey];
    segIdOf.set(startKey, id);
    while (queue.length) {
      const k = queue.pop();
      const cs = conductors.get(k);
      if (cs && isSource(cs, structures)) capacity += GENERATOR_CAPACITY[cs.kind] ?? 0;
      const tx = Math.floor(k / TILE_STRIDE);
      const ty = k - tx * TILE_STRIDE;
      for (const [dx, dy] of POWER_NEIGHBORS) {
        const nk = (tx + dx) * TILE_STRIDE + (ty + dy);
        if (!conductors.has(nk) || segIdOf.has(nk)) continue;
        segIdOf.set(nk, id);
        queue.push(nk);
      }
    }
    segments.push({ id, capacity, load: 0 });
  }
  return { segments, segIdOf };
}

// Same cheap-hash-gated caching pattern as energizedTiles above, folded to also change whenever
// a powered-consumer structure (turret/tesla/watchtower) is built, finished, destroyed, or moves
// -- since consumer load, not just the conductor layout, determines overload state.
function overloadSignature(structures) {
  let h = layoutSignature(structures);
  for (const s of structures) {
    if (!POWERED_CONSUMER_KINDS.has(s.kind) || s.destroyed || s.underConstruction) continue;
    h = (Math.imul(h, 31) + powerTileKey(s.x, s.y) + 5) | 0;
  }
  // Batteries' storedEnergy changes every tick they're actively charging/discharging, but their
  // tile position doesn't -- without folding charge level into the signature, the cache above
  // would never invalidate for a battery sitting still on an unchanged wire layout, and its
  // discharge contribution (addBatteryCapacity below) would go stale. Bucketed to one decimal so
  // floating-point noise doesn't thrash the cache every single tick.
  for (const s of structures) {
    if (s.kind !== 'battery' || s.destroyed || s.underConstruction) continue;
    h = (Math.imul(h, 31) + powerTileKey(s.x, s.y) + Math.round((s.storedEnergy ?? 0) * 10) + 11) | 0;
  }
  return h;
}

// Credits each segment with whatever its batteries can discharge RIGHT NOW (current stored
// charge, capped at BATTERY_DISCHARGE_RATE, after the real efficiency loss) -- read by both
// isSegmentOverloadedAt/hasPoweredBonus (via computeOverloadState below) so a charged battery
// genuinely staves off overload, not just cosmetically.
function addBatteryCapacity(segments, segIdOf, structures) {
  for (const s of structures) {
    if (s.kind !== 'battery' || s.destroyed || s.underConstruction) continue;
    const segId = segIdOf.get(powerTileKey(s.x, s.y));
    if (segId == null) continue;
    segments[segId].capacity += Math.min(BATTERY_DISCHARGE_RATE, s.storedEnergy ?? 0) * BATTERY_EFFICIENCY;
  }
}

function computeOverloadState(structures) {
  const { segments, segIdOf } = computeSegments(structures);
  addBatteryCapacity(segments, segIdOf, structures);
  const nuclearBuckets = new Map(); // nuclear generator tileKey -> wireless load fed to it
  const nuclearCapacity = GENERATOR_CAPACITY.generator_nuclear;

  for (const s of structures) {
    if (!POWERED_CONSUMER_KINDS.has(s.kind) || s.destroyed || s.underConstruction) continue;
    const load = consumerLoad(s.kind);

    // Nuclear's wireless radius takes precedence, matching isPoweredAt's own precedence above --
    // a consumer inside the radius draws from the reactor directly, not through the wire graph.
    let nuclearGen = null;
    for (const gen of structures) {
      if (gen.kind !== 'generator_nuclear' || gen.destroyed || gen.underConstruction) continue;
      if (Math.hypot(gen.x - s.x, gen.y - s.y) <= NUCLEAR_WIRELESS_RADIUS) { nuclearGen = gen; break; }
    }
    if (nuclearGen) {
      const key = powerTileKey(nuclearGen.x, nuclearGen.y);
      nuclearBuckets.set(key, (nuclearBuckets.get(key) ?? 0) + load);
      continue;
    }

    const segId = findSegmentIdForConsumer(s.x, s.y, segIdOf);
    if (segId != null) segments[segId].load += load;
  }

  return { segments, segIdOf, nuclearBuckets, nuclearCapacity };
}

let _cachedOverloadSignature = null;
let _cachedOverloadState = { segments: [], segIdOf: new Map(), nuclearBuckets: new Map(), nuclearCapacity: GENERATOR_CAPACITY.generator_nuclear };

function overloadState(structures) {
  const sig = overloadSignature(structures);
  if (sig !== _cachedOverloadSignature) {
    _cachedOverloadSignature = sig;
    _cachedOverloadState = computeOverloadState(structures);
  }
  return _cachedOverloadState;
}

// True if the segment (or nuclear wireless bucket) feeding this exact conductor tile (a wire or
// generator, not a consumer) is currently overloaded -- render.js uses this to tint the tile, and
// world.js's fire-risk roll and overload milestone log use it to find which tiles are at risk.
export function isSegmentOverloadedAt(structures, x, y) {
  const { segments, segIdOf, nuclearBuckets, nuclearCapacity } = overloadState(structures);
  const key = powerTileKey(x, y);
  const segId = segIdOf.get(key);
  if (segId != null && segments[segId].load > segments[segId].capacity) return true;
  const nuclearLoad = nuclearBuckets.get(key);
  if (nuclearLoad != null && nuclearLoad > nuclearCapacity) return true;
  return false;
}

// True if the consumer at (x, y) is powered AND the specific segment/nuclear-radius feeding it
// isn't overloaded -- this is the gate siege.js's turret/tesla damage-and-range boost and
// world.js's watchtower warning-window boost should check instead of plain isPoweredAt, so the
// bonus silently stops applying (rather than the consumer losing power outright) the moment its
// supply is overloaded.
export function hasPoweredBonus(structures, x, y) {
  if (!isPoweredAt(structures, x, y)) return false;
  const { segments, segIdOf, nuclearBuckets, nuclearCapacity } = overloadState(structures);

  let nuclearGen = null;
  for (const gen of structures) {
    if (gen.kind !== 'generator_nuclear' || gen.destroyed || gen.underConstruction) continue;
    if (Math.hypot(gen.x - x, gen.y - y) <= NUCLEAR_WIRELESS_RADIUS) { nuclearGen = gen; break; }
  }
  if (nuclearGen) {
    const load = nuclearBuckets.get(powerTileKey(nuclearGen.x, nuclearGen.y)) ?? 0;
    return load <= nuclearCapacity;
  }

  const segId = findSegmentIdForConsumer(x, y, segIdOf);
  if (segId == null) return true; // touching an energized tile with no tracked segment shouldn't happen, but fail open
  return segments[segId].load <= segments[segId].capacity;
}

// Set of stable string keys identifying every currently-overloaded segment/nuclear-bucket, for
// world.js's tick() to diff tick-over-tick and log a milestone only the first tick a given supply
// actually crosses into overload (not every tick it stays there).
export function overloadedSupplyKeys(structures) {
  const { segments, nuclearBuckets, nuclearCapacity } = overloadState(structures);
  const keys = new Set();
  for (const seg of segments) if (seg.load > seg.capacity) keys.add('seg:' + seg.id);
  for (const [k, load] of nuclearBuckets) if (load > nuclearCapacity) keys.add('nuc:' + k);
  return keys;
}

// ---------------------------------------------------------------------------------------------
// Battery storage tick (call once per world tick, BEFORE this tick's overload/hasPoweredBonus
// reads -- see world.js). Deliberately uses RAW generator capacity vs. load here (NOT
// addBatteryCapacity's battery-inclusive numbers above) to decide how much to charge/discharge --
// otherwise a battery would be reacting to a segment capacity that already includes its own
// pledged discharge, which is circular. This keeps it simple and one-directional: batteries
// charge off genuine generator surplus, and discharge to help cover genuine generator shortfall;
// what they contribute back to the overload check is a separate, later read (addBatteryCapacity).
export function computeSegmentLoads(structures) {
  const { segments, segIdOf } = computeSegments(structures);
  for (const s of structures) {
    if (!POWERED_CONSUMER_KINDS.has(s.kind) || s.destroyed || s.underConstruction) continue;
    // Same nuclear-wireless-bypass rule as computeOverloadState above: a consumer inside a
    // reactor's wireless radius draws from the reactor directly, never counted against a
    // wire-segment's battery here.
    let nearNuclear = false;
    for (const gen of structures) {
      if (gen.kind !== 'generator_nuclear' || gen.destroyed || gen.underConstruction) continue;
      if (Math.hypot(gen.x - s.x, gen.y - s.y) <= NUCLEAR_WIRELESS_RADIUS) { nearNuclear = true; break; }
    }
    if (nearNuclear) continue;
    const segId = findSegmentIdForConsumer(s.x, s.y, segIdOf);
    if (segId != null) segments[segId].load += consumerLoad(s.kind);
  }
  return { segments, segIdOf };
}

// Mutates every live battery's `storedEnergy` by one tick: charges from real surplus (generator
// capacity minus load, capped at BATTERY_CHARGE_RATE and remaining headroom, no loss), or
// discharges to help cover a real deficit (capped at BATTERY_DISCHARGE_RATE worth of DELIVERED
// power, which costs double that much in drawn storage per BATTERY_EFFICIENCY -- the real,
// measured "half of stored power is lost" tradeoff). A segment with multiple batteries just runs
// this per-battery in structure order -- simple, deterministic, good enough at this scale.
export function tickBatteries(structures) {
  const { segments, segIdOf } = computeSegmentLoads(structures);
  for (const s of structures) {
    if (s.kind !== 'battery' || s.destroyed || s.underConstruction) continue;
    if (s.storedEnergy == null) s.storedEnergy = 0;
    const segId = segIdOf.get(powerTileKey(s.x, s.y));
    if (segId == null) continue;
    const seg = segments[segId];
    const balance = seg.capacity - seg.load; // positive = surplus, negative = deficit
    if (balance > 0) {
      const room = BATTERY_STORED_MAX - s.storedEnergy;
      const charge = Math.min(BATTERY_CHARGE_RATE, balance, room);
      if (charge > 0) s.storedEnergy += charge;
    } else if (balance < 0) {
      const neededDelivered = Math.min(BATTERY_DISCHARGE_RATE, -balance);
      const neededDrawn = neededDelivered / BATTERY_EFFICIENCY;
      const drawn = Math.min(neededDrawn, s.storedEnergy);
      s.storedEnergy = Math.max(0, s.storedEnergy - drawn);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Power Exporter (real PA DLC mechanic -- Transformer/PowerExportMeter/QuickConnect -- ported
// honestly rather than reskinned: PA lets a segment with real spare capacity sell it off-site for
// money; this is that same idea applied to the flood-fill segment model above). A power_exporter
// structure is a consumer-shaped conductor-adjacent building (placed touching a wire/generator
// tile, same "on or orthogonally touching an energized tile" rule as a turret) that converts a
// slice of its segment's GENUINE spare capacity into a slow, real scrap trickle -- never power the
// grid actually needs.
//
// "Genuine spare capacity" is deliberately computeSegmentLoads' raw generator-capacity-minus-real-
// consumer-load balance -- the EXACT same number tickBatteries above already uses to decide
// whether a battery gets to charge this tick. Reusing it (rather than a parallel calculation)
// guarantees the exporter can never claim capacity a battery, a turret, or any other real consumer
// would have gotten instead: if it's not safe for a battery to draw on, it's not safe for this to
// export either.
//
// Two separate safety margins keep this from ever contributing to (or masking) a real overload:
//   1. POWER_EXPORT_RESERVE_MARGIN -- a flat amount of raw capacity held back, untouched, before
//      anything is exportable at all. Sized to roughly one plain generator's per-tick capacity (5)
//      so a segment has to have genuinely spare, not just momentarily-idle, headroom before the
//      exporter does anything.
//   2. Even past that margin, only POWER_EXPORT_FRACTION of what's left converts to scrap per
//      tick, capped at POWER_EXPORT_MAX_PER_TICK -- a real trickle, not a way to drain a segment's
//      headroom in a handful of ticks.
// Since computeSegmentLoads is recomputed fresh every call (not cached the way energizedTiles/
// overloadState are), the very tick a new downstream consumer comes online and eats into the
// segment's surplus, every exporter on that segment sees the smaller (or negative) balance and its
// trickle shrinks or drops to zero on that same tick -- it never keeps exporting off a stale
// number. If multiple exporters share one segment, each allocation is immediately folded back into
// that segment's `load` for the rest of this same pass, so a second exporter reading the same
// segment right after the first sees the already-reduced remainder rather than double-claiming the
// same slice of surplus.
export const POWER_EXPORT_RESERVE_MARGIN = 1.5;
export const POWER_EXPORT_FRACTION = 0.12;
export const POWER_EXPORT_MAX_PER_TICK = 0.15;

// Call once per world tick (world.js), any time after computeSegmentLoads' inputs for this tick
// are settled -- mirrors tickBatteries' calling convention, but this one reports out through
// `addScrap` (world.js's addScrap, bucketed under the 'powerExport' finance category) rather than
// mutating structures' own state, matching the recycling-center trickle's call shape in world.js's
// tick(). Also stamps `s._exportRate` on each exporter (0 when not currently exporting) purely for
// render.js to read back -- the glow/arrow on the sprite is only ever lit while a real trickle is
// actually flowing this tick, never a static "built" indicator.
export function tickPowerExporters(structures, addScrap) {
  let hasExporter = false;
  for (const s of structures) {
    if (s.kind === 'power_exporter' && !s.destroyed && !s.underConstruction) { hasExporter = true; break; }
  }
  if (!hasExporter) return; // cheap bail-out -- computeSegmentLoads is a full graph rebuild, skip it entirely on maps with none built

  const { segments, segIdOf } = computeSegmentLoads(structures);
  for (const s of structures) {
    if (s.kind !== 'power_exporter' || s.destroyed || s.underConstruction) continue;
    s._exportRate = 0;
    const segId = findSegmentIdForConsumer(s.x, s.y, segIdOf);
    if (segId == null) continue; // not actually touching the power grid -- exports nothing, per the task's gate
    const seg = segments[segId];
    const surplus = seg.capacity - seg.load - POWER_EXPORT_RESERVE_MARGIN;
    if (surplus <= 0) continue;
    const amount = Math.min(POWER_EXPORT_MAX_PER_TICK, surplus * POWER_EXPORT_FRACTION);
    if (amount <= 0) continue;
    seg.load += amount; // reserve this slice from any other exporter sharing the same segment this pass
    s._exportRate = amount;
    addScrap(amount, 'powerExport');
  }
}
