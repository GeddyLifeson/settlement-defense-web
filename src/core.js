// Ported from SD.Core (settlement_defense Unity project). Shared types and a seeded RNG so
// simulation runs are reproducible, matching the C# ulong-seed convention.

export function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngInt(rng, minInclusive, maxExclusive) {
  return minInclusive + Math.floor(rng() * (maxExclusive - minInclusive));
}

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function gridIndex(width, x, y) {
  return y * width + x;
}

export const AggressionPreset = Object.freeze({
  Calm: 'Calm',
  Standard: 'Standard',
  Aggressive: 'Aggressive',
});

export const StaffRoleKind = Object.freeze({
  None: 'None',
  Guard: 'Guard',
  Sniper: 'Sniper',
  K9Handler: 'K9Handler',
  Monitor: 'Monitor', // staffs a CCTV Monitor Station, see security.js / world.js wave-warning logic
});

export const TerrainKind = Object.freeze({
  Bare: 0,
  Soil: 1,
  Rock: 2,
  Water: 3,
});
