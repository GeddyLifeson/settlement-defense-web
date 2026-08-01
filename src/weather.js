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
import { HUNGER_DECAY, REST_DECAY, CitizenFlags } from './citizens.js';
import { isFlammable, igniteStructure } from './fire.js';
import { TRADER_DISCOUNT_PCT, TRADER_VOUCHER_USES, TRADER_WINDOW_TICKS } from './economy.js';

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
//
// Trader caravan (real RimWorld TraderCaravanArrival/VisitorGroup IncidentDefs, baseChance 4 --
// see FEATURE_RESEARCH.md) added as this event system's first genuinely POSITIVE economic entry;
// wanderer-joins is a population boost but not an economy one, and blight is purely negative --
// there was previously zero "good news" economic event. Same numeric-knob shape as
// tryBlightEvent (inverted: grant instead of destroy), no new entity/sprite/pathing needed. The
// actual discount math lives in economy.js (buildCost/spend) since that's the real point of sale.

const EVENT_CHECK_INTERVAL = 500; // ticks between event rolls
const EVENT_CHANCE = 0.06; // odds per check that *some* event fires -- rare, not spammy
const EVENT_WEIGHTS = [
  ['wanderer', 1],
  ['blight', 1],
  ['trader', 1],
  ['massfire', 0.3], // deliberately the rarest -- see tryMassFireEvent below, a genuine catastrophe tier
  ['resourcegift', 1], // real RimWorld ResourcePodCrash, baseChance 1.0, no cooldown -- see tryResourceGiftEvent below
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
  else if (kind === 'blight') tryBlightEvent(world);
  else if (kind === 'massfire') tryMassFireEvent(world);
  else if (kind === 'resourcegift') tryResourceGiftEvent(world);
  else tryTraderEvent(world);
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

const GIFT_GAIN_MIN = 0.4; // fraction of remaining headroom (maxAmount - amount) granted
const GIFT_GAIN_MAX = 0.7;

/** Picks a random resource node with headroom left (not already at maxAmount) and grants it a
 *  windfall -- a chunk of its remaining headroom, same shape as tryBlightEvent's loss roll but
 *  inverted (headroom filled instead of yield destroyed). Can fully replenish a depleted node
 *  (real RimWorld ResourcePodCrash: a literal fresh resource drop, not just "the existing node
 *  grows a bit"), un-depleting it if so. Returns true if a node was actually granted a gift. */
export function tryResourceGiftEvent(world) {
  const candidates = world.resourceNodes.filter(n => n.amount < n.maxAmount);
  if (candidates.length === 0) return false;

  const node = candidates[Math.floor(world.rng() * candidates.length)];
  const wasDepleted = node.depleted;
  const frac = GIFT_GAIN_MIN + world.rng() * (GIFT_GAIN_MAX - GIFT_GAIN_MIN);
  node.amount = Math.min(node.maxAmount, node.amount + (node.maxAmount - node.amount) * frac);
  if (wasDepleted && node.amount > 0) node.depleted = false;

  const text = wasDepleted
    ? 'A resource windfall replenishes a depleted node'
    : "A resource windfall boosts a node's yield";
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
  return true;
}

/** Grants a temporary discounted-build voucher (economy.js's buildCost/spend actually apply the
 *  discount at point-of-sale): the next TRADER_VOUCHER_USES buildable purchases within
 *  TRADER_WINDOW_TICKS cost TRADER_DISCOUNT_PCT less scrap. Re-rolling this event while one is
 *  already active just refreshes both the use-count and the window (no stacking discount %) --
 *  same "replace, don't stack" shape as re-rolling weather itself. Always succeeds (no
 *  candidate-availability gate like wanderer/blight have), matching real RimWorld's caravan
 *  events not requiring any colony precondition. */
export function tryTraderEvent(world) {
  world._traderVoucherUses = TRADER_VOUCHER_USES;
  world._traderVoucherExpireTick = world.currentTick + TRADER_WINDOW_TICKS;

  const text = `A trader caravan arrives -- next ${TRADER_VOUCHER_USES} buildables are ` +
    `${Math.round(TRADER_DISCOUNT_PCT * 100)}% off for a limited time`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
  return true;
}

// ---------------------------------------------------------------- mass-fire calamity
// Real Prison Architect calamity: a scripted MASS fire event -- an instant, multi-source
// outbreak (several simultaneous ignitions clustered around a few points), demanding an
// emergency response, distinct from fire.js's existing gradual model (tickFireIgnition rolls one
// spark off a generator; tickFire then spreads it slowly, one neighbor at a time, on a 30-tick
// check interval). This event bypasses both of those and ignites a whole cluster at once via the
// SAME igniteStructure/FLAMMABLE_KINDS primitives fire.js already exposes -- no parallel fire
// system, just a different, rarer, more severe trigger path into the one that already exists
// (once lit, these structures burn down and can still spread further through tickFire exactly
// like any other fire -- this event only owns the initial catastrophic outbreak, not the
// aftermath). Wired into the existing weighted event-roll (tickRandomEvents above) rather than a
// bespoke timer, same "one event system, more entries" shape as wanderer/blight/trader.
const MASS_FIRE_MIN_TARGETS = 2;    // below this there isn't enough kindling to read as "catastrophic" -- fizzles
const MASS_FIRE_MAX_TARGETS = 5;    // "up to several simultaneous ignitions", per the real calamity's scripted burst
const MASS_FIRE_CLUSTER_RADIUS = 6; // grid cells -- deliberately much wider than fire.js's own SPREAD_RADIUS=1.6
                                     // single-neighbor reach, so this reads as "a cluster catching at once", not
                                     // just a fast-forwarded version of the ordinary spread roll

/** Ignites up to MASS_FIRE_MAX_TARGETS flammable structures at once, clustered around a random
 *  anchor point, rather than fire.js's usual single-spark-then-slow-spread. Returns true if the
 *  event actually caught (false if there wasn't enough flammable kindling on the map right now to
 *  form a real cluster -- same fail-open shape as tryBlightEvent/tryWandererEvent above, so a
 *  colony with little flammable furniture just skips this roll rather than firing a degenerate
 *  one-structure "mass" fire). */
export function tryMassFireEvent(world) {
  const candidates = world.structures.filter(
    (s) => isFlammable(s.kind) && !s.destroyed && !s.underConstruction && !s.onFire
  );
  if (candidates.length < MASS_FIRE_MIN_TARGETS) return false;

  const anchor = candidates[Math.floor(world.rng() * candidates.length)];
  const byDistance = candidates
    .map((s) => ({ s, d: Math.hypot(s.x - anchor.x, s.y - anchor.y) }))
    .filter(({ s, d }) => s === anchor || d <= MASS_FIRE_CLUSTER_RADIUS)
    .sort((a, b) => a.d - b.d);
  if (byDistance.length < MASS_FIRE_MIN_TARGETS) return false;

  const targetCount = Math.min(MASS_FIRE_MAX_TARGETS, byDistance.length);
  for (let k = 0; k < targetCount; k++) igniteStructure(byDistance[k].s);

  const text = `A catastrophic fire breaks out -- ${targetCount} structures are ablaze at once, emergency response needed`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
  return true;
}

// ---------------------------------------------------------------- lightning storm calamity
// Real Prison Architect calamity_settings.txt "Lightning Storm" -- a genuinely different mechanic
// from RimWorld's thunderstorm weather above (tickThunderstorm), which only rolls ONE interval-
// based strike that can ignite a single flammable structure. The real PA calamity instead keeps
// rolling independent strike chances against three real target tiers for as long as the storm
// lasts: citizens caught outdoors, power-network structures, and bare ground -- tiered roughly
// 1/4/8% per the task brief. A Lightning Rod buildable (economy.js's BUILD_COST.lightning_rod,
// drawn in render.js) is the real PA-style mitigation item: 85% effective at deflecting a strike
// for any target within its protection radius. That same radius also halves this calamity's own
// movement-speed penalty ("gritted" = inside a rod's radius) -- one footprint serving both jobs,
// not two separate area concepts to track.
//
// Rides the same ThunderstormDry/ThunderstormRainy weather states tickThunderstorm already gates
// on (both are real "lightning storm" weather in the source data this project ports from) rather
// than adding a third, parallel weather kind -- but everything below is its own distinct system,
// called separately from world.js, with its own numbers and its own consequences.
export const LIGHTNING_ROD_RADIUS = 4; // grid cells -- same order of magnitude as FLOODLIGHT_RANGE (siege.js)
export const LIGHTNING_ROD_MITIGATION = 0.85; // real PA-scale mitigation: 85% reduction to strike chance
export const LIGHTNING_STRIKE_CHANCE_CITIZEN = 0.01;   // 1% -- citizens are the rarest, most protected target
export const LIGHTNING_STRIKE_CHANCE_STRUCTURE = 0.04; // 4% -- power-network structures (generator/wire/battery/...)
export const LIGHTNING_STRIKE_CHANCE_GROUND = 0.08;    // 8% -- bare ground, harmless but the most frequent roll
const LIGHTNING_STRIKE_INTERVAL_TICKS = 20; // rolled every ~2s at 10Hz, not every single tick -- an ongoing
                                             // hazard for as long as the storm lasts, not instant chaos on start
const LIGHTNING_CITIZEN_DAMAGE = 0.35; // real, substantial (comparable to a couple of stacked combat hits --
                                        // see siege.js's per-shot damage constants) but not a guaranteed kill
const LIGHTNING_STRUCTURE_DAMAGE = 0.5; // half health off a hit power structure -- can chain to destroy on a second strike
export const LIGHTNING_STORM_MOVE_PENALTY = 0.3; // 30% slower while a storm is active, ungritted
export const LIGHTNING_STORM_MOVE_PENALTY_GRITTED = LIGHTNING_STORM_MOVE_PENALTY / 2; // halved near a Lightning Rod

function isPowerStructureKind(kind) {
  return kind === 'wire' || kind === 'battery' || kind === 'power_switch' || kind.startsWith('generator');
}

function liveLightningRods(world) {
  return world.structures.filter(s => s.kind === 'lightning_rod' && !s.destroyed && !s.underConstruction);
}

function nearestLightningRodDist(rods, x, y) {
  let best = Infinity;
  for (const r of rods) {
    const d = Math.hypot(r.x - x, r.y - y);
    if (d < best) best = d;
  }
  return best;
}

function pushLightningMilestone(world, text) {
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
}

/** True while ThunderstormDry/Rainy is active -- the same weather gate tickThunderstorm above
 *  uses, so the Lightning Storm calamity is understood as riding that same real-world weather
 *  state, just with its own distinct per-tick strike/movement mechanics layered on top. */
export function isLightningStormActive(world) {
  return world.weather === WeatherKind.ThunderstormDry || world.weather === WeatherKind.ThunderstormRainy;
}

/** True if (x,y) is within a completed Lightning Rod's protection radius -- "gritted", per the
 *  file header, for both strike mitigation and the halved movement penalty. */
export function isGrittedAt(world, x, y) {
  const rods = liveLightningRods(world);
  if (rods.length === 0) return false;
  return nearestLightningRodDist(rods, x, y) <= LIGHTNING_ROD_RADIUS;
}

/** Per-citizen movement-speed multiplier during an active lightning storm -- 1 (no effect) if no
 *  storm is active, otherwise the real penalty above, halved for a gritted citizen. Same
 *  per-citizen-callback shape as isHeatwaveSlowdownActive's use in world.js's tickWander call
 *  (positional, not a flat map-wide scalar like Rain's WEATHER_MOVE_SPEED). */
export function lightningStormMoveMult(world, x, y) {
  if (!isLightningStormActive(world)) return 1;
  const penalty = isGrittedAt(world, x, y) ? LIGHTNING_STORM_MOVE_PENALTY_GRITTED : LIGHTNING_STORM_MOVE_PENALTY;
  return 1 - penalty;
}

/** Rolls the three real per-interval strike tiers (citizen/power-structure/ground) while a
 *  lightning storm is active. Call once per tick from SimWorld.tick(), alongside tickThunderstorm
 *  -- deliberately a separate function/system (see file header) since PA's real Lightning Storm
 *  calamity and RimWorld's thunderstorm weather are two distinct source mechanics being ported
 *  side by side rather than merged into one. */
export function tickLightningStorm(world) {
  if (!isLightningStormActive(world)) return;
  if (world.currentTick % LIGHTNING_STRIKE_INTERVAL_TICKS !== 0) return;

  const rods = liveLightningRods(world);

  // Citizen tier: only outdoor, alive, not-downed citizens are eligible -- a roof is real shelter,
  // same "indoors matters" logic as Cold/Heatwave's tickWeatherCitizenEffects above.
  if (world.rng() < LIGHTNING_STRIKE_CHANCE_CITIZEN) {
    const store = world.citizens;
    const candidates = [];
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i) || store.isDownedAt(i)) continue;
      if (roomContaining(world.rooms, world.grid, store.x[i], store.y[i])) continue; // sheltered indoors
      candidates.push(i);
    }
    if (candidates.length > 0) {
      const i = candidates[Math.floor(world.rng() * candidates.length)];
      const mitigated = rods.length > 0
        && nearestLightningRodDist(rods, store.x[i], store.y[i]) <= LIGHTNING_ROD_RADIUS
        && world.rng() < LIGHTNING_ROD_MITIGATION;
      if (!mitigated) {
        const healthMult = store.trait[i]?.healthMult ?? 1;
        store.health[i] = Math.max(0, store.health[i] - LIGHTNING_CITIZEN_DAMAGE / healthMult);
        if (store.health[i] <= 0.05) store.flags[i] |= CitizenFlags.Downed;
        pushLightningMilestone(world, `Lightning strikes ${store.name[i]}`);
      } else {
        pushLightningMilestone(world, `Lightning strikes near ${store.name[i]} -- a Lightning Rod draws it off harmlessly`);
      }
    }
  }

  // Power-structure tier: any live generator/wire/battery/power_switch (power.js's own
  // conductor/source set, mirrored here via isPowerStructureKind) -- excludes lightning_rod
  // itself, which is a passive mitigation item, not a "power-network" structure.
  if (world.rng() < LIGHTNING_STRIKE_CHANCE_STRUCTURE) {
    const candidates = world.structures.filter(s =>
      isPowerStructureKind(s.kind) && !s.destroyed && !s.underConstruction);
    if (candidates.length > 0) {
      const s = candidates[Math.floor(world.rng() * candidates.length)];
      const mitigated = rods.length > 0
        && nearestLightningRodDist(rods, s.x, s.y) <= LIGHTNING_ROD_RADIUS
        && world.rng() < LIGHTNING_ROD_MITIGATION;
      if (!mitigated) {
        s.health = Math.max(0, s.health - LIGHTNING_STRUCTURE_DAMAGE);
        if (s.health <= 0) s.destroyed = true;
        const label = s.kind.replace(/_/g, ' ');
        pushLightningMilestone(world, s.destroyed ? `Lightning destroys a ${label}` : `Lightning strikes a ${label}`);
      } else {
        pushLightningMilestone(world, 'Lightning strikes near the power grid -- a Lightning Rod draws it off harmlessly');
      }
    }
  }

  // Ground tier: real PA ground strikes are the highest-chance, lowest-consequence tier --
  // logged flavor only, nothing damaged. No Lightning Rod check needed since there's no
  // consequence to mitigate.
  if (world.rng() < LIGHTNING_STRIKE_CHANCE_GROUND) {
    pushLightningMilestone(world, 'Lightning strikes open ground');
  }
}

// ---------------------------------------------------------------- toxic fallout hazard (map-wide)
// Real RimWorld anchor: ToxicFallout / VolcanicWinter -- both are sustained, MAP-WIDE CONDITIONS
// (durationRange in ticks, applied colony-wide the whole time they're up) rather than an instant
// one-off roll, which is what every entry in EVENT_WEIGHTS above resolves as in a single tick, and
// they're gated by a much longer refire gap than an ordinary incident (real Defs pair a long
// `daysBetweenIncidentsRange`/century-tier rarity with an early-game grace period so a fresh
// colony never sees one in its first hours) -- distinct in BOTH trigger cadence and effect from
// every WeatherKind above (those are frequent, short-lived, and hook accuracy/move-speed; this is
// rare, long-lived, late-game-only, and hooks the zone-refill-rate knob instead). Ported here as a
// temporary reduction to how fast zones refill citizen needs (jobs.js's REFILL_RATE, see
// hazardRefillMult below and its call sites in jobs.js) -- the real ToxicFallout kills outdoor
// plant life; this project has no farming system to reuse, so "the settlement's zones stop
// replenishing needs as well while toxic air blankets the map" is the honest genre-neutral
// equivalent, same "port the mechanism, not the flavor" framing as the rest of this file.
export const HAZARD_EARLIEST_TICK = 12000;    // real "not before" grace -- roughly a third into a
                                               // healthy 22-36k-tick game, so it reads as late-game
export const HAZARD_MIN_REFIRE_TICKS = 9000;  // long cooldown between occurrences -- VolcanicWinter-
                                               // tier rarity, not a frequent weather-cycle-style repeat
const HAZARD_CHECK_INTERVAL = 500;  // same roll cadence as tickRandomEvents above
const HAZARD_CHANCE = 0.03;         // per check, once eligible -- rarer than any single EVENT_WEIGHTS entry
const HAZARD_DURATION_MIN = 1200;   // ~2 min at 10Hz
const HAZARD_DURATION_MAX = 3000;   // ~5 min at 10Hz
export const HAZARD_REFILL_MULT = 0.55; // real, measurable colony-wide zone-refill penalty while active

/** Call once from SimWorld's constructor (or lazily from tickHazardCondition on first tick) to
 *  seed initial state -- same pattern as initWeather above. _hazardLastEndTick starts at -Infinity
 *  so the very first refire-gap check (currentTick - lastEndTick) reads as "long enough ago". */
export function initHazard(world) {
  world._hazardActive = false;
  world._hazardTicksRemaining = 0;
  world._hazardLastEndTick = -Infinity;
}

/** True while the toxic-fallout hazard is active. */
export function isHazardActive(world) {
  return !!world._hazardActive;
}

/** Map-wide zone-refill-rate multiplier -- 1 (no effect) when no hazard is active, otherwise the
 *  real penalty above. Read fresh every tick by jobs.js's REFILL_RATE call sites, same
 *  no-caching shape as weatherAccuracyMult/weatherMoveSpeedMult. */
export function hazardRefillMult(world) {
  return isHazardActive(world) ? HAZARD_REFILL_MULT : 1;
}

/** Advances an active hazard's duration and ends it once expired (recording the end tick for the
 *  next refire-gap check), or -- while no hazard is active -- rolls a new one once BOTH the
 *  earliest-tick grace period and the minimum-refire gap since the last occurrence have elapsed.
 *  Call once per tick from SimWorld.tick(), alongside the other weather/event systems. */
export function tickHazardCondition(world) {
  if (world._hazardActive == null) initHazard(world);

  if (world._hazardActive) {
    world._hazardTicksRemaining--;
    if (world._hazardTicksRemaining <= 0) {
      world._hazardActive = false;
      world._hazardLastEndTick = world.currentTick;
      const text = 'Toxic fallout clears -- zones return to their normal refill rate';
      world.milestoneLog.push({ tick: world.currentTick, text });
      if (world.milestoneLog.length > 20) world.milestoneLog.shift();
      world.onRandomEvent?.(text);
    }
    return;
  }

  if (world.currentTick < HAZARD_EARLIEST_TICK) return;
  if (world.currentTick - world._hazardLastEndTick < HAZARD_MIN_REFIRE_TICKS) return;
  if (world.currentTick % HAZARD_CHECK_INTERVAL !== 0) return;
  if (world.rng() >= HAZARD_CHANCE) return;

  world._hazardActive = true;
  world._hazardTicksRemaining = HAZARD_DURATION_MIN
    + Math.floor(world.rng() * (HAZARD_DURATION_MAX - HAZARD_DURATION_MIN));
  const text = 'Toxic fallout blankets the settlement -- zones refill needs more slowly until it clears';
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
}
