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
import { isFlammable, igniteStructure } from './fire.js';

// Fog/Snow (real accuracy/move-speed modifiers) and Thunderstorm (Dry/Rainy split) added per
// RimWorld's actual WeatherDefs/Weathers.xml data -- see weatherAccuracyMult/weatherMoveSpeedMult
// below and tickThunderstorm's lightning-ignition hookup into fire.js.
export const WeatherKind = Object.freeze({
  Clear: 'Clear', Rain: 'Rain', Cold: 'Cold', Heatwave: 'Heatwave',
  Fog: 'Fog', Snow: 'Snow',
  ThunderstormDry: 'ThunderstormDry', ThunderstormRainy: 'ThunderstormRainy',
});

// Weighted so Clear is the common case -- weather is flavor + a modest modifier, not a constant
// stream of debuffs. Thunderstorms are the rarest of all (deliberately dangerous per the task
// brief, so they shouldn't be common) and Rainy is weighted slightly above Dry to match RimWorld's
// own DryThunderstorm/RainyThunderstorm relative commonality (rain is the more frequent variant).
const WEATHER_WEIGHTS = [
  [WeatherKind.Clear, 5],
  [WeatherKind.Rain, 2],
  [WeatherKind.Cold, 1.5],
  [WeatherKind.Heatwave, 1.5],
  [WeatherKind.Fog, 1],
  [WeatherKind.Snow, 1],
  [WeatherKind.ThunderstormDry, 0.4],
  [WeatherKind.ThunderstormRainy, 0.5],
];

// ---------------------------------------------------------------- combat accuracy / move speed
// Real RimWorld WeatherDefs/Weathers.xml combat-accuracy modifiers (see task brief): Clear 1.0
// (no entry = no modifier), Rain 0.8, Fog 0.5 (the heaviest single modifier in the game), Snow
// (Hard) 0.8, RainyThunderstorm inherits Rain's 0.8/0.8 pair. DryThunderstorm carries no accuracy
// or move penalty of its own in the real game -- its danger is purely the unquenched lightning
// fires (see tickThunderstorm below), not a combat debuff.
const WEATHER_ACCURACY = Object.freeze({
  [WeatherKind.Rain]: 0.8,
  [WeatherKind.Fog]: 0.5,
  [WeatherKind.Snow]: 0.8,
  [WeatherKind.ThunderstormRainy]: 0.8,
});

/** Map-wide combat-accuracy multiplier for the current weather -- applied symmetrically to
 *  turret/guard/sniper fire AND attacker hits vs citizens/structures (siege.js), matching
 *  RimWorld's single map-wide modifier rather than a one-sided player buff/debuff. */
export function weatherAccuracyMult(weather) {
  return WEATHER_ACCURACY[weather] ?? 1;
}

// Real RimWorld move-speed modifiers for the same weather states (Rain 0.9, Snow(Hard) 0.8,
// RainyThunderstorm 0.8 same as Rain+Snow stacked-equivalent per the task brief).
const WEATHER_MOVE_SPEED = Object.freeze({
  [WeatherKind.Rain]: 0.9,
  [WeatherKind.Snow]: 0.8,
  [WeatherKind.ThunderstormRainy]: 0.8,
});

/** Map-wide movement-speed multiplier for the current weather -- used for both citizen wander
 *  (world.js's tickWander call, previously Rain-only) and attacker approach speed (siege.js's
 *  tickAttackers), same symmetric application as accuracy above. */
export function weatherMoveSpeedMult(weather) {
  return WEATHER_MOVE_SPEED[weather] ?? 1;
}

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

// Rain/Snow/RainyThunderstorm: citizens amble slower underfoot -- hooks into tickWander's
// existing speed parameter (world.js passes this straight through), rather than a parallel
// movement system. Now a thin alias over the real WEATHER_MOVE_SPEED table above (previously
// Rain-only at a made-up 0.8 -- kept in sync with the real RimWorld numbers used for combat
// move-speed too, so citizen wander and attacker approach speed read the same weather the same
// way).
export function weatherWanderSpeedMult(weather) {
  return weatherMoveSpeedMult(weather);
}

// ---------------------------------------------------------------- heatwave movement penalty
// Real Prison Architect heatstrokeSpeedFactor: 0.75. Unlike Rain (a flat map-wide modifier the
// instant it starts, see WEATHER_MOVE_SPEED above), the real heatstroke penalty only applies once
// exposure has actually built up, and only outdoors -- so this is wired in separately rather than
// folded into weatherWanderSpeedMult's flat per-weather table. "Sustained" reuses the same
// world._weatherStreakTicks counter tickWeather maintains below for water.js's pipe-freeze tiers
// (how long the CURRENT weather state has held); "outdoor" reuses the same rooms.js enclosed-room
// check tickWeatherCitizenEffects already does for Cold/Heatwave's extra need-decay above. Applied
// from world.js as a per-citizen multiplier passed into citizens.js's tickWander (see that file's
// tickWander signature) rather than a flat scalar, since the indoor/outdoor split is per-citizen
// and a flat scalar can't express that -- but it's still the exact same "one constant multiplies
// the existing wander-speed knob" shape Rain's own code already uses, just evaluated per citizen.
export const HEATWAVE_WANDER_SPEED_MULT = 0.75; // real PA number
const HEATWAVE_SUSTAIN_TICKS = 300; // ~30s at 10Hz of continuous Heatwave before the slowdown kicks in

/** True once Heatwave has been the active weather for at least HEATWAVE_SUSTAIN_TICKS in a row.
 *  world.js reads this once per tick (cheap) rather than recomputing the streak duration itself. */
export function isHeatwaveSlowdownActive(world) {
  return world.weather === WeatherKind.Heatwave && (world._weatherStreakTicks || 0) >= HEATWAVE_SUSTAIN_TICKS;
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
    // How long the CURRENT weather state has held -- read by water.js's pipe-freeze tiers and
    // isHeatwaveSlowdownActive above, both of which escalate the longer their trigger weather
    // persists uninterrupted. Reset to 0 right as the state actually changes.
    world._weatherStreakTicks = 0;
    const text = `Weather turns to ${next}`;
    world.milestoneLog.push({ tick: world.currentTick, text });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    world.onRandomEvent?.(text);
  }
  world._weatherStreakTicks = (world._weatherStreakTicks || 0) + 1;

  tickWeatherCitizenEffects(world);
}

// ---------------------------------------------------------------- thunderstorms
// RimWorld's DryThunderstorm/RainyThunderstorm defs spawn lightning strikes on an
// `averageInterval` of ~1200 game ticks at RimWorld's real 60 Hz tick rate -- 1200/60 = 20 real
// seconds between strikes on average. Scaled proportionally to this project's 10 Hz tick rate
// (see world.js's header comment / ARCHITECTURE.md section 2, and SESSION_HANDOFF.md's "10Hz"
// references throughout): 1200 * (10/60) = 200 ticks. A strike doesn't guarantee an ignition
// (LIGHTNING_IGNITE_CHANCE below) and reuses fire.js's exact bed/table/door flammable-target set
// -- this is deliberately the *same* ignition mechanism as a sparking generator, just with no
// generator required to trigger it (a lightning strike can hit anywhere on the map), which is
// the "deliberately dangerous, nothing to put it out" half of the task brief for the Dry variant.
const LIGHTNING_INTERVAL_TICKS = Math.round(1200 * (10 / 60)); // = 200
const LIGHTNING_IGNITE_CHANCE = 0.35; // per interval, once due -- averageInterval is a mean, not a guarantee
// RainyThunderstorm: the rain that comes with it douses fires it (or anything else) starts, same
// as plain Rain extinguishing fire in the real game -- rolled per burning structure per tick
// rather than a flat "all fires out instantly" so a fire that just started has a beat before it's
// necessarily caught, same texture as fire.js's own per-tick damage/spread rolls.
const RAIN_DOUSE_CHANCE_PER_TICK = 0.12;

/** Thunderstorm hookup: lightning-strike ignition (both variants) + rain-dousing (Rainy variant
 *  only). Call once per tick from SimWorld.tick(), alongside tickFireIgnition/tickFire -- this
 *  runs before those so a strike this tick is visible to this same tick's tickFire damage pass. */
export function tickThunderstorm(world) {
  const weather = world.weather;
  const isDry = weather === WeatherKind.ThunderstormDry;
  const isRainy = weather === WeatherKind.ThunderstormRainy;
  if (!isDry && !isRainy) return;

  if (isRainy) {
    for (const s of world.structures) {
      if (!s.onFire || s.destroyed) continue;
      if (world.rng() < RAIN_DOUSE_CHANCE_PER_TICK) s.onFire = false; // doused -- nothing left burning to re-ignite off of
    }
  }

  if (world.currentTick % LIGHTNING_INTERVAL_TICKS !== 0) return;
  if (world.rng() >= LIGHTNING_IGNITE_CHANCE) return;

  const candidates = world.structures.filter(
    (s) => isFlammable(s.kind) && !s.destroyed && !s.underConstruction && !s.onFire
  );
  if (candidates.length === 0) return;
  const target = candidates[Math.floor(world.rng() * candidates.length)];
  igniteStructure(target);

  const text = isDry
    ? 'Lightning strikes and ignites a fire -- with no rain, nothing will put it out'
    : 'Lightning strikes and ignites a fire';
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
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
