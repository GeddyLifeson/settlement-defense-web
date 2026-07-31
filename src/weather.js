// RimWorld-style weather + one-off random events (see FEATURE_RESEARCH.md's RimWorld section,
// "Events" category: weather, extreme weather, wanderers, blight, infestation -- all called out
// there as genre-neutral simulation tech, same "port the mechanism, not the flavor" framing as
// room detection/fire). Weather cycles on a simple weighted random timer; each state hooks into
// an existing numeric knob rather than adding a parallel system, same philosophy as fire.js's
// "modest, real, not dominating" tuning. Events are one-off rolls that post to
// world.milestoneLog (existing event log, see world.js) and fire world.onRandomEvent (the same
// optional-callback pattern as onBuildComplete/onWaveIncoming) so main.js can also surface them
// as a toast.
import { roomContaining } from './rooms.js';
import { HUNGER_DECAY, REST_DECAY } from './citizens.js';

export const WeatherKind = Object.freeze({
  Clear: 'Clear', Rain: 'Rain', Cold: 'Cold', Heatwave: 'Heatwave',
});

// Weighted so Clear is the common case -- weather is flavor + a modest modifier, not a constant
// stream of debuffs.
const WEATHER_WEIGHTS = [
  [WeatherKind.Clear, 5],
  [WeatherKind.Rain, 2],
  [WeatherKind.Cold, 1.5],
  [WeatherKind.Heatwave, 1.5],
];

const MIN_WEATHER_TICKS = 600;  // ~1 min at 10Hz
const MAX_WEATHER_TICKS = 1800; // ~3 min at 10Hz

function rollDuration(rng) {
  return MIN_WEATHER_TICKS + Math.floor(rng() * (MAX_WEATHER_TICKS - MIN_WEATHER_TICKS));
}

function pickWeather(rng, exclude) {
  const pool = WEATHER_WEIGHTS.filter(([k]) => k !== exclude);
  const total = pool.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [k, w] of pool) {
    roll -= w;
    if (roll <= 0) return k;
  }
  return pool[pool.length - 1][0];
}

/** Call once from SimWorld's constructor to seed initial state. */
export function initWeather(world) {
  world.weather = WeatherKind.Clear;
  world._weatherTimer = rollDuration(world.rng);
}

// Rain: citizens amble slower underfoot -- hooks into tickWander's existing speed parameter
// (world.js passes this straight through), rather than a parallel movement system.
export const RAIN_WANDER_SPEED_MULT = 0.8;

export function weatherWanderSpeedMult(weather) {
  return weather === WeatherKind.Rain ? RAIN_WANDER_SPEED_MULT : 1;
}

// Cold/Heatwave: modest *extra* need decay on top of whatever tickNeedsAndMood already applied
// this tick, asymmetric by axis (cold -> hungrier faster burning calories to stay warm; heat ->
// harder to rest) so the two extremes read as mechanically distinct, not just palette swaps of
// each other. Being indoors in any enclosed room (rooms.js flood-fill) cuts the penalty most of
// the way back to normal, same "shelter matters" logic either direction -- this is the promised
// "reduce it if citizens are indoors" behavior, extended symmetrically to heat since a roof is
// shelter from both extremes.
const COLD_HUNGER_EXTRA_OUTDOOR = 0.8; // fraction of HUNGER_DECAY added on top, outdoors
const COLD_HUNGER_EXTRA_INDOOR = 0.15;
const HEAT_REST_EXTRA_OUTDOOR = 0.8; // fraction of REST_DECAY added on top, outdoors
const HEAT_REST_EXTRA_INDOOR = 0.15;

export function tickWeatherCitizenEffects(world) {
  const weather = world.weather;
  if (weather !== WeatherKind.Cold && weather !== WeatherKind.Heatwave) return;

  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i) || store.isDownedAt(i)) continue;
    const indoors = !!roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);

    if (weather === WeatherKind.Cold) {
      const extra = HUNGER_DECAY * (indoors ? COLD_HUNGER_EXTRA_INDOOR : COLD_HUNGER_EXTRA_OUTDOOR);
      store.hunger[i] = Math.max(0, store.hunger[i] - extra);
    } else {
      const extra = REST_DECAY * (indoors ? HEAT_REST_EXTRA_INDOOR : HEAT_REST_EXTRA_OUTDOOR);
      store.rest[i] = Math.max(0, store.rest[i] - extra);
    }
  }
}

/** Advances the weather timer and, on expiry, rolls a new (different) weather state; then
 *  applies the current weather's per-tick citizen effect (every tick, not just on change --
 *  Cold/Heatwave's extra decay is a continuous effect for as long as that state holds). Call
 *  once per tick from SimWorld.tick(), same pattern as the other periodic systems there. */
export function tickWeather(world) {
  if (world._weatherTimer == null) initWeather(world);
  world._weatherTimer--;
  if (world._weatherTimer <= 0) {
    const next = pickWeather(world.rng, world.weather);
    world.weather = next;
    world._weatherTimer = rollDuration(world.rng);
    const text = `Weather turns to ${next}`;
    world.milestoneLog.push({ tick: world.currentTick, text });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    world.onRandomEvent?.(text);
  }

  tickWeatherCitizenEffects(world);
}

// ---------------------------------------------------------------- one-off random events
// Wanderer-joins and blight, per FEATURE_RESEARCH.md's RimWorld "Events" list. Infestation's
// genre-neutral equivalent (a burst of wild resource-guarding creatures) was scoped out of this
// pass -- it would need a new attacker-adjacent entity type wired through siege.js/render.js,
// which is a much bigger surface than a numeric-knob event, and this pass prioritized doing a
// solid job on the other two over a half-built third. Left as a natural follow-up.

const EVENT_CHECK_INTERVAL = 500; // ticks between event rolls
const EVENT_CHANCE = 0.06; // odds per check that *some* event fires -- rare, not spammy
const EVENT_WEIGHTS = [
  ['wanderer', 1],
  ['blight', 1],
];

export function tickRandomEvents(world) {
  if (world.currentTick % EVENT_CHECK_INTERVAL !== 0) return;
  if (world.rng() >= EVENT_CHANCE) return;

  const total = EVENT_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  let roll = world.rng() * total;
  let kind = EVENT_WEIGHTS[0][0];
  for (const [k, w] of EVENT_WEIGHTS) {
    roll -= w;
    if (roll <= 0) { kind = k; break; }
  }

  if (kind === 'wanderer') tryWandererEvent(world);
  else tryBlightEvent(world);
}

/** Spawns a new citizen near the settlement center using an unused name from the shared name
 *  pool (world._namePool -- see world.js's STARTER_NAMES, extended with extra names beyond the
 *  starting 24 so a long soak test doesn't run out). Returns true if a wanderer actually joined. */
// Population cap, distinct from the raw CitizenStore capacity check below: this event was
// firing with no ceiling of its own and, stacked with world.js's separate Refugee Wagon
// mechanic (which IS gated, only replenishing losses back up to ~90% of starting population),
// drove hands-off soak tests from 24 to 40+ citizens in ~10k ticks with zero combat losses --
// a real regression, since colonyStrength() scales directly off alive citizen count and no
// other system was scaling up to match. Cap wanderers to keep a healthy colony from ballooning;
// Refugee Wagon remains the mechanism for recovering from actual losses.
const WANDERER_POPULATION_CAP_MULT = 1.15;

export function tryWandererEvent(world) {
  const cap = (world.startingCitizenCount || 24) * WANDERER_POPULATION_CAP_MULT;
  if (world.citizens.count >= cap) return false;

  const pool = world._namePool || [];
  const used = new Set();
  for (let i = 0; i < world.citizens.count; i++) used.add(world.citizens.name[i]);
  const available = pool.filter(n => !used.has(n));
  if (available.length === 0) return false;

  const name = available[Math.floor(world.rng() * available.length)];
  const cx = Math.max(1, Math.min(world.width - 2, world.width / 2 + (world.rng() - 0.5) * 6));
  const cy = Math.max(1, Math.min(world.height - 2, world.height / 2 + (world.rng() - 0.5) * 6));
  const idx = world.citizens.spawn(name, cx, cy, world.rng);
  if (idx < 0) return false; // at capacity

  world._citizenIds.push(world.citizens.id[idx]);
  const text = `A wanderer named ${name} joins the settlement`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
  return true;
}

const BLIGHT_LOSS_MIN = 0.4; // fraction of remaining yield destroyed
const BLIGHT_LOSS_MAX = 0.7;

/** Picks a random non-depleted resource node and destroys a chunk of its remaining yield (can
 *  fully deplete it). Returns true if a node was actually hit. */
export function tryBlightEvent(world) {
  const candidates = world.resourceNodes.filter(n => !n.depleted && n.amount > 0);
  if (candidates.length === 0) return false;

  const node = candidates[Math.floor(world.rng() * candidates.length)];
  const frac = BLIGHT_LOSS_MIN + world.rng() * (BLIGHT_LOSS_MAX - BLIGHT_LOSS_MIN);
  node.amount = Math.max(0, node.amount - node.amount * frac);
  if (node.amount < 1) { node.amount = 0; node.depleted = true; }

  const text = node.depleted
    ? 'Blight wipes out a resource node'
    : "Blight reduces a resource node's yield";
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
  return true;
}
