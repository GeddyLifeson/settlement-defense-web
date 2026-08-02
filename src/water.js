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
  // 'valve' (real Prison Architect water-network connector) joins 'pipe' and the pump source as a
  // live conductor tile -- same flood-fill participation, just its own freeze-chance table (see
  // VALVE_FREEZE_CHANCE below).
  return (s.kind === 'pipe' || s.kind === 'valve' || water_isSource(s)) && !s.destroyed && !s.underConstruction && !s.frozen;
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
// Exported: weather.js reuses this exact set of duration breakpoints for its own Cold-tier-gated
// systems (Construction/Gardening work-rate reduction, Deep-Freeze-linked flu risk) so every
// "how far into a sustained Cold snap are we" tier check in this codebase agrees on the same three
// breakpoints, rather than each file inventing its own slightly-different escalation schedule.
export const FREEZE_TIER_TICKS = [0, 400, 900]; // ticks of continuous Cold before each tier below kicks in
const FREEZE_TIER_CHANCE = [0.07, 0.17, 0.30]; // real PA numbers, escalating with Cold duration
export const FREEZE_ADJACENT_BONUS = 0.05; // real PA number

function freezeTierChance(coldStreakTicks) {
  let chance = FREEZE_TIER_CHANCE[0];
  for (let i = 0; i < FREEZE_TIER_TICKS.length; i++) {
    if (coldStreakTicks >= FREEZE_TIER_TICKS[i]) chance = FREEZE_TIER_CHANCE[i];
  }
  return chance;
}

// Valve/pump freeze split (real Prison Architect pipefreezingsystem.txt-adjacent data, see task
// brief): valves freeze much more readily than plain pipe (0.35/0.65/0.90 vs pipe's 0.07/0.17/0.30
// above) and pumps freeze ONLY at the top Cold-duration tier, at a flat 0.50 -- distinct shapes,
// not just scaled-up pipe numbers. 'valve' is a real structure kind now (economy.js's BUILD_COST,
// input.js's toolbar) -- cheap water-network connector, joins the flood-fill exactly like pipe
// (see water_isConductor above) but rolls against this table instead of pipe's FREEZE_TIER_CHANCE.
export const VALVE_FREEZE_CHANCE = [0.35, 0.65, 0.90]; // real PA numbers, escalating with Cold duration, same tier breakpoints as FREEZE_TIER_TICKS
const PUMP_FREEZE_CHANCE_L3 = 0.50; // real PA number -- pumps never freeze at tier 1/2, only tier 3

function pumpFreezeChance(coldStreakTicks) {
  return coldStreakTicks >= FREEZE_TIER_TICKS[2] ? PUMP_FREEZE_CHANCE_L3 : 0;
}

function valveFreezeChance(coldStreakTicks) {
  let chance = VALVE_FREEZE_CHANCE[0];
  for (let i = 0; i < FREEZE_TIER_TICKS.length; i++) {
    if (coldStreakTicks >= FREEZE_TIER_TICKS[i]) chance = VALVE_FREEZE_CHANCE[i];
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
      if ((s.kind === 'pipe' || s.kind === 'pump' || s.kind === 'valve') && s.frozen) s.frozen = false;
    }
    return;
  }

  if (world.currentTick % FREEZE_CHECK_INTERVAL !== 0) return;

  const streak = world._weatherStreakTicks || 0;
  const chance = freezeTierChance(streak);

  const frozenKeys = new Set();
  for (const s of world.structures) {
    if ((s.kind === 'pipe' || s.kind === 'pump' || s.kind === 'valve') && s.frozen && !s.destroyed) frozenKeys.add(waterTileKey(s.x, s.y));
  }

  let frozeAny = false;
  for (const s of world.structures) {
    if (s.kind !== 'pipe' && s.kind !== 'pump' && s.kind !== 'valve') continue;
    if (s.destroyed || s.underConstruction || s.frozen) continue;
    // Pump uses its own distinct L3-only chance table (see pumpFreezeChance above); valve uses its
    // own much-higher-than-pipe table (see valveFreezeChance above); pipe keeps the existing,
    // already-verified-correct per-tier chance unchanged.
    let roll = s.kind === 'pump' ? pumpFreezeChance(streak) : s.kind === 'valve' ? valveFreezeChance(streak) : chance;
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
