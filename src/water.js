// Water/plumbing as a real connected pipe graph, mirroring power.js's wire grid exactly (see
// FEATURE_RESEARCH.md: "Power/water as a real wired-graph network" -- power got built first,
// this is the water half). Same PA-derived rule: a pump pushes water out along pipe conduits,
// and anything not physically on the pipe run gets nothing no matter how close it is to the
// pump -- adjacency to the network, not proximity to the source, is what matters.
//
// The graph is a flood-fill over orthogonally-adjacent conductor tiles (pumps + pipes), same
// shape as power.js's energizedTiles/rooms.js's detectRooms, and is recomputed only when the
// conductor layout actually changes -- mirroring power.js's water_layoutSignature check.
const WATER_NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const WATER_TILE_STRIDE = 100000; // packs (tx, ty) into one integer key; maps are far smaller than this

export function waterTileKey(x, y) {
  return Math.floor(x) * WATER_TILE_STRIDE + Math.floor(y);
}

function water_isSource(s) {
  return s.kind === 'pump';
}

function water_isConductor(s) {
  return (s.kind === 'pipe' || water_isSource(s)) && !s.destroyed && !s.underConstruction;
}

// Cheap order-sensitive hash of every live conductor's tile+kind, so the O(n) rebuild only runs
// when a pipe/pump is built, finished, or destroyed -- not every tick for every zone/consumer.
function water_layoutSignature(structures) {
  let h = 19;
  for (let i = 0; i < structures.length; i++) {
    const s = structures[i];
    if (!water_isConductor(s)) continue;
    h = (Math.imul(h, 31) + waterTileKey(s.x, s.y) + (water_isSource(s) ? 11 : 5)) | 0;
  }
  return h;
}

let _water_cachedSignature = null;
let _cachedWatered = new Set();

function computeWatered(structures) {
  const conductors = new Set();
  const sources = [];
  for (const s of structures) {
    if (!water_isConductor(s)) continue;
    const k = waterTileKey(s.x, s.y);
    conductors.add(k);
    if (water_isSource(s)) sources.push(k);
  }

  const watered = new Set();
  const queue = [];
  for (const k of sources) {
    if (watered.has(k)) continue;
    watered.add(k);
    queue.push(k);
  }
  while (queue.length) {
    const k = queue.pop();
    const tx = Math.floor(k / WATER_TILE_STRIDE);
    const ty = k - tx * WATER_TILE_STRIDE;
    for (const [dx, dy] of WATER_NEIGHBORS) {
      const nk = (tx + dx) * WATER_TILE_STRIDE + (ty + dy);
      if (watered.has(nk) || !conductors.has(nk)) continue;
      watered.add(nk);
      queue.push(nk);
    }
  }
  return watered;
}

// Set of tile keys actually carrying water right now: every pump, plus every pipe with an
// unbroken pipe path back to one. Cut the chain and the far half runs dry.
export function wateredTiles(structures) {
  const sig = water_layoutSignature(structures);
  if (sig !== _water_cachedSignature) {
    _water_cachedSignature = sig;
    _cachedWatered = computeWatered(structures);
  }
  return _cachedWatered;
}

// True if this tile is itself watered (i.e. it holds a live pipe/pump).
export function isTileWatered(structures, x, y) {
  return wateredTiles(structures).has(waterTileKey(x, y));
}

// A consumer is watered if it sits on, or orthogonally touches, a watered tile -- so a Food/
// Recreation zone tile or the Recycling Center can either hug the pump directly or be fed by a
// pipe run from across the map. No wireless-radius exception here (unlike power.js's nuclear
// generator) -- water has no equivalent "riskier source, bigger payoff" building yet.
export function isWateredAt(structures, x, y) {
  const watered = wateredTiles(structures);
  if (watered.size === 0) return false;
  const tx = Math.floor(x), ty = Math.floor(y);
  if (watered.has(tx * WATER_TILE_STRIDE + ty)) return true;
  for (const [dx, dy] of WATER_NEIGHBORS) {
    if (watered.has((tx + dx) * WATER_TILE_STRIDE + (ty + dy))) return true;
  }
  return false;
}
