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

// Any generator variant counts as a source (plain 'generator', 'generator_nuclear', ...) so new
// generator types plug into the grid without needing to be listed here.
function isSource(s) {
  return s.kind === 'generator' || s.kind.startsWith('generator_');
}

function isConductor(s) {
  return (s.kind === 'wire' || isSource(s)) && !s.destroyed && !s.underConstruction;
}

// Cheap order-sensitive hash of every live conductor's tile+kind, so the O(n) rebuild only runs
// when a wire/generator is built, finished, or destroyed -- not every tick for every turret.
function layoutSignature(structures) {
  let h = 17;
  for (let i = 0; i < structures.length; i++) {
    const s = structures[i];
    if (!isConductor(s)) continue;
    h = (Math.imul(h, 31) + powerTileKey(s.x, s.y) + (isSource(s) ? 7 : 3)) | 0;
  }
  return h;
}

let _cachedSignature = null;
let _cachedEnergized = new Set();

function computeEnergized(structures) {
  const conductors = new Set();
  const sources = [];
  for (const s of structures) {
    if (!isConductor(s)) continue;
    const k = powerTileKey(s.x, s.y);
    conductors.add(k);
    if (isSource(s)) sources.push(k);
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
