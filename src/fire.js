// Fire spread crisis event -- ported/condensed from Prison Architect and SEA:R (see
// FEATURE_RESEARCH.md, both flag fire as a good siege-game crisis event; the mechanism itself
// isn't carceral, it's genre-neutral building-fire simulation, same as room detection).
//
// Ignition trigger (design choice): generators can spark a fire. This ties into the existing
// "generators are a tradeoff" mechanic already in world.js (power/turret boost vs. pollution
// cost) -- a generator malfunctioning and igniting something nearby is the same flavor of
// tradeoff, not a bolted-on unrelated system. An attacker/explosion-triggered fire was
// considered (also genre-appropriate) but generators-cause-fires was picked as more
// thematically consistent with what's already built.
//
// Extinguish design (deliberately simple, documented per the task brief): no dedicated
// firefighting job or citizen mechanic. Fire is self-limiting -- it only spreads to unburned
// flammable neighbors within a short range, each burning structure is destroyed (fully
// consumed) once its health reaches 0, and a fire with no flammable, unburned neighbor left in
// range simply has nothing further to spread to. This keeps the system cheap and safe against
// runaway spread (see tuning constants below) without needing a new citizen job type; a
// citizen-firefighter mechanic would be a reasonable follow-up but isn't needed for a rare,
// occasional threat.

// Flammability rule: wood/cloth/paper-ish furniture and building material catches; stone/metal/
// electrical things (turrets, generators, tesla coils, floodlights, watchtowers, fences -- "wire"
// per the task brief) do not.
//
// 'wall' is deliberately excluded despite being wood-ish and named in the task brief: this
// codebase's wall Structure isn't a durable, ongoing entity -- world.js's tick() folds any
// non-under-construction 'wall' into permanent, health-less grid terrain and drops the
// Structure object the very tick after it finishes building (see the `this.structures =
// this.structures.filter(...)` block), regardless of health/destroyed/onFire. An ignited wall
// would just silently lose its onFire flag into the void the same tick, never visibly burning
// down -- confirmed via a manual browser repro before settling on this exclusion. Beds/tables/
// doors don't have that lifecycle quirk; they stay real Structure objects for their whole life.
const FLAMMABLE_KINDS = new Set(['bed', 'table', 'door']);

// Tuned conservatively per the task brief: "a rare, occasional threat is better than one that
// dominates every playthrough". Scaled per-generator (not a flat per-tick roll) so more
// generators genuinely mean more risk -- consistent with pollution also scaling per-generator
// in world.js tick(). At 10 Hz, one generator rolls roughly once every ~9 real-world minutes on
// average before it sparks, and even then only catches if something flammable is nearby.
const IGNITION_CHANCE_PER_GENERATOR = 0.00003;
const IGNITION_SEARCH_RADIUS = 4; // generator sparks something flammable within this range

const FIRE_DAMAGE_PER_TICK = 0.01; // burning structure's health drains at this rate until destroyed
const SPREAD_CHECK_INTERVAL = 30; // ticks between spread rolls -- "a few ticks per cell" pacing
const SPREAD_RADIUS = 1.6; // reaches orthogonal + diagonal neighbor cells
const SPREAD_CHANCE = 0.18; // per eligible unburned neighbor, per check

export function isFlammable(kind) {
  return FLAMMABLE_KINDS.has(kind);
}

export function igniteStructure(s) {
  s.onFire = true;
  s.fireTicks = 0;
}

// Natural trigger: active (built, undestroyed) generators can spark a nearby flammable
// structure. Call once per tick from SimWorld.tick().
export function tickFireIgnition(structures, rng) {
  for (const g of structures) {
    if (g.kind !== 'generator' || g.destroyed || g.underConstruction) continue;
    if (rng() >= IGNITION_CHANCE_PER_GENERATOR) continue;

    let target = null;
    let candidateCount = 0;
    for (const s of structures) {
      if (!isFlammable(s.kind) || s.destroyed || s.underConstruction || s.onFire) continue;
      if (Math.hypot(s.x - g.x, s.y - g.y) > IGNITION_SEARCH_RADIUS) continue;
      candidateCount++;
      // reservoir sampling of size 1 -- picks a uniformly random eligible candidate without
      // needing to materialize an array of them every ignition roll
      if (rng() < 1 / candidateCount) target = s;
    }
    if (target) igniteStructure(target);
  }
}

// Damages every burning structure each tick (destroying it once fully consumed) and, every
// SPREAD_CHECK_INTERVAL ticks, rolls to spread to nearby unburned flammable structures. Fire is
// purely self-limiting -- see file header for why there's no firefighting mechanic.
export function tickFire(structures, rng) {
  for (const s of structures) {
    if (!s.onFire || s.destroyed) continue;

    s.fireTicks = (s.fireTicks || 0) + 1;
    s.health -= FIRE_DAMAGE_PER_TICK;
    if (s.health <= 0) {
      s.health = 0;
      s.destroyed = true;
      s.onFire = false; // fully consumed -- nothing left to burn
      continue;
    }

    if (s.fireTicks % SPREAD_CHECK_INTERVAL === 0) {
      for (const other of structures) {
        if (other === s || !isFlammable(other.kind)) continue;
        if (other.destroyed || other.underConstruction || other.onFire) continue;
        if (Math.hypot(other.x - s.x, other.y - s.y) > SPREAD_RADIUS) continue;
        if (rng() < SPREAD_CHANCE) igniteStructure(other);
      }
    }
  }
}
