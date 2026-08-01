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
  return (s.kind === 'pipe' || water_isSource(s)) && !s.destroyed && !s.underConstruction && !s.frozen;
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

// ---------------------------------------------------------------------------------------------
// Cold-weather pipe freezing, real Prison Architect numbers: the longer Cold weather persists
// uninterrupted, the more likely each live pipe/pump tile is to freeze solid on a given check,
// escalating through three real tiers (0.07/0.17/0.30) plus a +0.05 bonus when the tile sits
// orthogonally next to another tile that's already frozen (ice spreading along the same run,
// not an independent roll per tile). A frozen tile simply stops being a conductor (see
// water_isConductor above) -- no repair job needed, it thaws back out the instant Cold weather
// actually clears, same "wait out the weather" shape the real PA mechanic has. Flipping `.frozen`
// on a structure is enough to make wateredTiles() recompute: water_layoutSignature already skips
// non-conductors when hashing the layout, so a newly-frozen (or newly-thawed) tile changes the
// hash on its own, no separate cache-bust needed.
const FREEZE_CHECK_INTERVAL = 100; // ~10s at 10Hz -- rolled periodically, not every tick
const FREEZE_TIER_TICKS = [0, 400, 900]; // ticks of continuous Cold before each tier below kicks in
const FREEZE_TIER_CHANCE = [0.07, 0.17, 0.30]; // real PA numbers, escalating with Cold duration
export const FREEZE_ADJACENT_BONUS = 0.05; // real PA number

function freezeTierChance(coldStreakTicks) {
  let chance = FREEZE_TIER_CHANCE[0];
  for (let i = 0; i < FREEZE_TIER_TICKS.length; i++) {
    if (coldStreakTicks >= FREEZE_TIER_TICKS[i]) chance = FREEZE_TIER_CHANCE[i];
  }
  return chance;
}

/** Call once per tick from SimWorld.tick(), after weather.js's tickWeather so world.weather /
 *  world._weatherStreakTicks reflect this tick's state. Thaws every frozen pipe/pump instantly
 *  the moment Cold weather isn't active; otherwise rolls each live, not-yet-frozen tile against
 *  the current duration-scaled tier chance (+ the adjacency bonus). */
export function tickPipeFreezing(world) {
  if (world.weather !== 'Cold') {
    for (const s of world.structures) {
      if ((s.kind === 'pipe' || s.kind === 'pump') && s.frozen) s.frozen = false;
    }
    return;
  }

  if (world.currentTick % FREEZE_CHECK_INTERVAL !== 0) return;

  const streak = world._weatherStreakTicks || 0;
  const chance = freezeTierChance(streak);

  const frozenKeys = new Set();
  for (const s of world.structures) {
    if ((s.kind === 'pipe' || s.kind === 'pump') && s.frozen && !s.destroyed) frozenKeys.add(waterTileKey(s.x, s.y));
  }

  let frozeAny = false;
  for (const s of world.structures) {
    if (s.kind !== 'pipe' && s.kind !== 'pump') continue;
    if (s.destroyed || s.underConstruction || s.frozen) continue;
    let roll = chance;
    const tx = Math.floor(s.x), ty = Math.floor(s.y);
    for (const [dx, dy] of WATER_NEIGHBORS) {
      if (frozenKeys.has((tx + dx) * WATER_TILE_STRIDE + (ty + dy))) { roll += FREEZE_ADJACENT_BONUS; break; }
    }
    if (world.rng() < roll) { s.frozen = true; frozeAny = true; }
  }

  if (frozeAny) {
    const text = 'Cold snap freezes part of the water system';
    world.milestoneLog.push({ tick: world.currentTick, text });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    world.onRandomEvent?.(text);
  }
}
