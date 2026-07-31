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

function isConductor(s, structures) {
  return (s.kind === 'wire' || isSource(s, structures)) && !s.destroyed && !s.underConstruction;
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
