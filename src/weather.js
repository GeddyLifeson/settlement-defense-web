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
import { HUNGER_DECAY, REST_DECAY, CitizenFlags, addMoodEvent } from './citizens.js';
import { isFlammable, igniteStructure } from './fire.js';
import { TRADER_DISCOUNT_PCT, TRADER_VOUCHER_USES, TRADER_WINDOW_TICKS } from './economy.js';
import { setSolarFlareActive, gridLoadFraction, setRollingBlackoutActive } from './power.js';
import { FREEZE_TIER_TICKS } from './water.js';

// Fog/Snow (real accuracy/move-speed modifiers) and Thunderstorm (Dry/Rainy split) added per
// RimWorld's actual WeatherDefs/Weathers.xml data -- see weatherAccuracyMult/weatherMoveSpeedMult
// below and tickThunderstorm's lightning-ignition hookup into fire.js.
export const WeatherKind = Object.freeze({
  Clear: 'Clear', Rain: 'Rain', Cold: 'Cold', Heatwave: 'Heatwave',
  Fog: 'Fog', Snow: 'Snow',
  ThunderstormDry: 'ThunderstormDry', ThunderstormRainy: 'ThunderstormRainy',
  // FoggyRain/Eclipse/Aurora: three more real RimWorld WeatherDefs/GameConditionDefs, same
  // "port the mechanism, not the flavor" framing as everything else in this header. VolcanicWinter
  // (also real RimWorld data) is deliberately NOT a WeatherKind entry -- it's a sustained map-wide
  // CONDITION like ToxicFallout/SolarFlare further down this file, not a short weighted-roll state,
  // so it lives in that section instead with its own init/tick/isActive triplet.
  FoggyRain: 'FoggyRain', Eclipse: 'Eclipse', Aurora: 'Aurora',
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
  // FoggyRain: a genuine compound state (real RimWorld def combining Fog+Rain's own conditions),
  // weighted below plain Fog(1) since it needs both a damp AND a fog-forming stretch at once.
  [WeatherKind.FoggyRain, 0.6],
  // Eclipse/Aurora: both real, rare RimWorld sky conditions with no everyday-weather commonality --
  // weighted well below even ThunderstormDry(0.4), the previous rarest entry, matching the task
  // brief's "rare, short" (Eclipse) and "rare" (Aurora) framing.
  [WeatherKind.Eclipse, 0.15],
  [WeatherKind.Aurora, 0.15],
];

// ---------------------------------------------------------------- combat accuracy / move speed
// Real RimWorld WeatherDefs/Weathers.xml combat-accuracy modifiers (see task brief): Clear 1.0
// (no entry = no modifier), Rain 0.8, Fog 0.5 (the heaviest single modifier in the game), Snow
// (Hard) 0.8, RainyThunderstorm inherits Rain's 0.8/0.8 pair. DryThunderstorm carries no accuracy
// or move penalty of its own in the real game -- its danger is purely the unquenched lightning
// fires (see tickThunderstorm below), not a combat debuff.
// FoggyRain: real RimWorld combined-weather def, accuracy 0.5 (per the task brief -- reads as
// Fog's own 0.5 dominating the pair, same as RainyThunderstorm below inheriting Rain's number
// rather than the two penalties multiplying together). Eclipse: reuses this exact same
// table-driven mechanism Fog's own reduced-visibility entry already uses (per the task brief's
// "reuse Fog's reduced-visibility effect if reachable"), but at a deliberately MODEST value --
// 0.7, between Rain(0.8) and Fog(0.5) -- since an eclipse dims the map without the full
// zero-visibility haze Fog's own 0.5 represents; this specific number has no directly-cited real
// figure in the task brief and is an inferred, conservative estimate (flagged here the same way
// DEEP_FREEZE_WALK_SPEED_MULT's own doc comment flags its inferred number above).
const WEATHER_ACCURACY = Object.freeze({
  [WeatherKind.Rain]: 0.8,
  [WeatherKind.Fog]: 0.5,
  [WeatherKind.Snow]: 0.8,
  [WeatherKind.ThunderstormRainy]: 0.8,
  [WeatherKind.FoggyRain]: 0.5,
  [WeatherKind.Eclipse]: 0.7,
});

/** Map-wide combat-accuracy multiplier for the current weather -- applied symmetrically to
 *  turret/guard/sniper fire AND attacker hits vs citizens/structures (siege.js), matching
 *  RimWorld's single map-wide modifier rather than a one-sided player buff/debuff. */
export function weatherAccuracyMult(weather) {
  return WEATHER_ACCURACY[weather] ?? 1;
}

// Real RimWorld move-speed modifiers for the same weather states (Rain 0.9, Snow(Hard) 0.8,
// RainyThunderstorm 0.8 same as Rain+Snow stacked-equivalent per the task brief).
// FoggyRain: move-speed 0.9 per the task brief (matches plain Rain's own 0.9 -- the fog half of
// the pair doesn't carry an additional move penalty in the real data, same "one dominant number,
// not multiplied penalties" reading as its accuracy entry above). Eclipse deliberately has NO
// entry here -- it's a lighting/vision effect only (see WEATHER_ACCURACY above), not a footing
// hazard, so it falls through to this function's own `?? 1` default same as Clear/Cold/Heatwave.
const WEATHER_MOVE_SPEED = Object.freeze({
  [WeatherKind.Rain]: 0.9,
  [WeatherKind.Snow]: 0.8,
  [WeatherKind.ThunderstormRainy]: 0.8,
  [WeatherKind.FoggyRain]: 0.9,
});

/** Map-wide movement-speed multiplier for the current weather -- used for both citizen wander
 *  (world.js's tickWander call, previously Rain-only) and attacker approach speed (siege.js's
 *  tickAttackers), same symmetric application as accuracy above. */
export function weatherMoveSpeedMult(weather) {
  return WEATHER_MOVE_SPEED[weather] ?? 1;
}

const MIN_WEATHER_TICKS = 600;  // ~1 min at 10Hz
const MAX_WEATHER_TICKS = 1800; // ~3 min at 10Hz

// Per-kind duration multiplier, table-driven same shape as WEATHER_ACCURACY/WEATHER_MOVE_SPEED
// above -- defaults to 1 (the plain MIN/MAX_WEATHER_TICKS range) for every kind not listed. Only
// Eclipse gets an entry: the task brief calls it out as "short" specifically (real eclipses are a
// brief event, not a lingering weather stretch the way Fog/Rain/Cold are), so its rolled duration
// is compressed to well under a third of the normal range rather than sharing it.
const WEATHER_DURATION_MULT = Object.freeze({
  [WeatherKind.Eclipse]: 0.3,
});

function rollDuration(rng, kind) {
  const mult = WEATHER_DURATION_MULT[kind] ?? 1;
  const base = MIN_WEATHER_TICKS + Math.floor(rng() * (MAX_WEATHER_TICKS - MIN_WEATHER_TICKS));
  return Math.max(200, Math.round(base * mult)); // floored so even a short Eclipse still reads as a real interval, not a flicker
}

// ---------------------------------------------------------------- seasons
// This project previously had NO season/temperature concept at all -- pickWeather was flat
// weighted-random with no notion of time-of-year. Added here as a real cycle over
// world.currentTick, same "derive from the tick counter, no new per-tick bookkeeping" shape as
// schedule.js's DAY_NIGHT_CYCLE_TICKS (a plain modulo, no stored/advanced state of its own).
//
// YEAR LENGTH REASONING: SESSION_HANDOFF.md repeatedly anchors a healthy, hands-off game at
// ~22-36k ticks (its own established regression baseline, re-confirmed across many soak tests
// throughout that doc). A season system sized to that baseline needs to satisfy two competing
// pulls: (1) each individual season has to be long enough to host a real number of independent
// weather rolls -- MIN/MAX_WEATHER_TICKS above average out to ~1200 ticks per weather state, so a
// season shorter than that would mostly show at most one weather roll before the season itself
// changes, defeating the point of seasonal *variety* of weather; (2) the FULL year has to be
// short enough relative to 22-36k that a typical game actually sees every season, ideally more
// than once, rather than spending its whole lifetime stuck in Spring.
//
// SEASON_LENGTH_TICKS=3000 (~5 min real time at 10Hz) comfortably clears pull (1): ~2.5 average
// weather rolls per season, up to 5 at the shortest MIN_WEATHER_TICKS duration -- a season reads
// as "a stretch with its own weather character", not a single-roll coin flip. YEAR_LENGTH_TICKS
// (4 seasons * 3000 = 12000, ~20 min real time) clears pull (2): a 22k-tick game completes ~1.8
// years (every season at least once, most twice), a 36k-tick game completes ~3 years -- so both
// ends of the established healthy-game range see real seasonal repetition (Winter isn't a
// once-per-game novelty), without any single season dominating a whole playthrough the way a
// literal RimWorld year (60 real days) ported as one game-length year would.
export const Season = Object.freeze({
  Spring: 'Spring', Summer: 'Summer', Autumn: 'Autumn', Winter: 'Winter',
});

export const SEASON_LENGTH_TICKS = 3000;               // ~5 min at 10Hz -- see reasoning above
export const YEAR_LENGTH_TICKS = SEASON_LENGTH_TICKS * 4; // 12000 ticks, ~20 min at 10Hz

const SEASON_ORDER = [Season.Spring, Season.Summer, Season.Autumn, Season.Winter];

/** The current Season, derived purely from world.currentTick (no stored state, same "just do the
 *  modulo" shape as schedule.js's day/night cycle) -- games start in Spring at tick 0. */
export function currentSeason(world) {
  const t = ((world.currentTick % YEAR_LENGTH_TICKS) + YEAR_LENGTH_TICKS) % YEAR_LENGTH_TICKS;
  return SEASON_ORDER[Math.floor(t / SEASON_LENGTH_TICKS)];
}

// Rough numeric temperature proxy only -- per the task brief this doesn't need elaborate
// modeling (no real thermodynamics anywhere else in this codebase to hook into), just a stepped
// per-season value on a plain -1 (coldest) to 1 (hottest) scale, for any future UI/system that
// wants a single number rather than a Season string to key off of. NOT read by any existing
// weather-triggered system in this file (Cold/Heatwave/Deep Freeze all key off world.weather
// directly, unchanged) -- this is a new, additive export only.
const SEASON_TEMPERATURE = Object.freeze({
  [Season.Spring]: 0.1,
  [Season.Summer]: 0.9,
  [Season.Autumn]: -0.1,
  [Season.Winter]: -0.9,
});

/** Rough -1..1 numeric temperature proxy for the current season. See SEASON_TEMPERATURE comment
 *  above -- not an elaborate model, just a per-season constant. */
export function seasonalTemperature(world) {
  return SEASON_TEMPERATURE[currentSeason(world)];
}

// Per-season multiplier applied to WEATHER_WEIGHTS' base weights before a roll (see pickWeather
// below) -- structural gating (some entries multiplied to exactly 0 and excluded from the pool
// entirely, not just made rare) for the kinds that shouldn't be able to roll AT ALL in a given
// season, real weight adjustments for everything else. Every season keeps at least 6 of the 8
// WeatherKinds eligible (only Snow and one of Cold/Heatwave are ever hard-zeroed in any single
// season) specifically so pickWeather's existing same-as-last-time `exclude` filter can never run
// the pool dry -- see that function's own comment.
//
// Per-kind reasoning:
//  - Snow: real snow only in Winter. Zero everywhere else -- this is the one gate the task brief
//    calls out explicitly as the "Snow only in Winter" structural example.
//  - Heatwave: zeroed in Winter (a heatwave in winter isn't weather, it'd be a plot hole), sharply
//    UP in Summer (2.5x -- the season's signature hazard), a rare "unseasonable warm snap" in
//    Spring/Autumn (0.2x) rather than impossible, since real shoulder-season warm spells do happen.
//  - Cold: zeroed in Summer (mirrors Heatwave's Winter zero), sharply UP in Winter (2.5x -- Deep
//    Freeze's whole staged system is meant to actually matter there), a real-but-secondary presence
//    in Autumn (1x, cooling toward Winter) and a reduced "late cold snap" in Spring (0.5x, warming
//    out of Winter).
//  - Rain: up in Spring/Autumn (the wet shoulder seasons, 1.5x each), reduced in Summer (0.7x,
//    partly displaced by Heatwave/Thunderstorm) and cut hard in Winter (0.3x, partly displaced by
//    Snow -- winter precipitation should mostly read as snow, not rain).
//  - Fog: peaks in Autumn (1.6x, real "autumn mist" is the classic case) and stays elevated in
//    Spring (1.3x, morning mist), reduced in Summer (0.3x, fog needs cool damp air) and moderate in
//    Winter (0.8x, still real but not the season's signature).
//  - Thunderstorms (both variants): peak in Summer (real convective storms need summer heat --
//    1.5x Dry / 1.3x Rainy), present but reduced in Spring/Autumn (the real shoulder-season range),
//    and cut to a bare-minimum-but-nonzero trickle in Winter (0.1x each -- real winter thunder
//    happens, it's just rare, so this stays a hard "rare" rather than the "impossible" treatment
//    Heatwave/Snow's off-seasons get).
//  - Clear: never zeroed, kept close to its base weight in every season (0.1x range) so it stays
//    the common baseline case year-round exactly as WEATHER_WEIGHTS' own header comment intends.
const SEASON_WEATHER_MULT = Object.freeze({
  [Season.Spring]: Object.freeze({
    [WeatherKind.Clear]: 1, [WeatherKind.Rain]: 1.5, [WeatherKind.Cold]: 0.5, [WeatherKind.Heatwave]: 0.2,
    [WeatherKind.Fog]: 1.3, [WeatherKind.Snow]: 0,
    [WeatherKind.ThunderstormDry]: 0.5, [WeatherKind.ThunderstormRainy]: 1,
    // FoggyRain tracks its two parent conditions (Fog 1.3x, Rain 1.5x above) -- damp shoulder
    // season, elevated same as both. Eclipse: flat 1 in every season (see its own note under
    // Summer below -- a real astronomical event, not a seasonal one). Aurora: modest in Spring,
    // real aurora visibility rises as nights lengthen toward Winter.
    [WeatherKind.FoggyRain]: 1.3, [WeatherKind.Eclipse]: 1, [WeatherKind.Aurora]: 0.6,
  }),
  [Season.Summer]: Object.freeze({
    [WeatherKind.Clear]: 1.1, [WeatherKind.Rain]: 0.7, [WeatherKind.Cold]: 0, [WeatherKind.Heatwave]: 2.5,
    [WeatherKind.Fog]: 0.3, [WeatherKind.Snow]: 0,
    [WeatherKind.ThunderstormDry]: 1.5, [WeatherKind.ThunderstormRainy]: 1.3,
    // FoggyRain needs cool damp air same as plain Fog -- cut hard in Summer heat (0.2x, mirrors
    // Fog's own 0.3x). Eclipse: flat 1 -- a real solar/lunar eclipse's timing is orbital
    // mechanics, not a function of season, so it deliberately does NOT get the structural
    // per-season gating every other entry in this table has (this project has no orbital model to
    // key off of, so "no seasonal bias at all" is the honest equivalent). Aurora: near-silent in
    // Summer -- real auroras wash out against short, bright summer nights.
    [WeatherKind.FoggyRain]: 0.2, [WeatherKind.Eclipse]: 1, [WeatherKind.Aurora]: 0.15,
  }),
  [Season.Autumn]: Object.freeze({
    [WeatherKind.Clear]: 1, [WeatherKind.Rain]: 1.5, [WeatherKind.Cold]: 1, [WeatherKind.Heatwave]: 0.2,
    [WeatherKind.Fog]: 1.6, [WeatherKind.Snow]: 0,
    [WeatherKind.ThunderstormDry]: 0.4, [WeatherKind.ThunderstormRainy]: 0.8,
    // FoggyRain peaks here (1.4x) -- Autumn is both Fog's(1.6x) and Rain's(1.5x) own peak season,
    // so their compound reads as the year's likeliest window for it too. Eclipse: flat 1 (see
    // Summer note). Aurora: same as Spring, rising toward Winter's own peak below.
    [WeatherKind.FoggyRain]: 1.4, [WeatherKind.Eclipse]: 1, [WeatherKind.Aurora]: 0.6,
  }),
  [Season.Winter]: Object.freeze({
    [WeatherKind.Clear]: 1, [WeatherKind.Rain]: 0.3, [WeatherKind.Cold]: 2.5, [WeatherKind.Heatwave]: 0,
    [WeatherKind.Fog]: 0.8, [WeatherKind.Snow]: 3,
    [WeatherKind.ThunderstormDry]: 0.1, [WeatherKind.ThunderstormRainy]: 0.1,
    // FoggyRain: reduced same as plain Rain (0.5x, winter precipitation reads mostly as Snow, see
    // Snow's own header note). Eclipse: flat 1 (see Summer note). Aurora peaks here (1.4x) --
    // real aurora visibility is genuinely a long-dark-night phenomenon, so Winter is its one true
    // seasonal driver even though the underlying cause (solar activity) isn't seasonal at all.
    [WeatherKind.FoggyRain]: 0.5, [WeatherKind.Eclipse]: 1, [WeatherKind.Aurora]: 1.4,
  }),
});

/** Applies a season's multiplier table to the base WEATHER_WEIGHTS, dropping any entry the
 *  season zeroes out entirely (structural gating, not just "very rare") before the exclude
 *  filter runs. Falls back to the unmodified base weight for any season not found in the table
 *  (defensive only -- SEASON_WEATHER_MULT above covers all four Season values). */
function seasonalWeatherPool(season) {
  const mult = SEASON_WEATHER_MULT[season];
  return WEATHER_WEIGHTS
    .map(([k, w]) => [k, mult ? w * (mult[k] ?? 1) : w])
    .filter(([, w]) => w > 0);
}

// excludeHeatwave: true while VolcanicWinter (see that hazard's section far below) is active --
// the task brief calls VolcanicWinter "mutually exclusive with Heatwave" (real RimWorld: a
// severe-cold map condition and a heat-wave weather state can't sensibly coexist), so it's
// structurally zeroed out of the pool for the duration, the exact same "filter it out before the
// roll" shape the `exclude` (no-repeat) and season-gating (SEASON_WEATHER_MULT) filters already
// use just above -- not a bespoke branch inside the roll loop itself.
function pickWeather(rng, exclude, season, excludeHeatwave) {
  const pool = seasonalWeatherPool(season)
    .filter(([k]) => k !== exclude)
    .filter(([k]) => !(excludeHeatwave && k === WeatherKind.Heatwave));
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

// ---------------------------------------------------------------- Heatwave High tier (Overheated + electrical fire)
// Real Prison Architect calamities.txt HeatwaveHigh -- the top severity tier of the Heatwave
// calamity, reached the longer Heatwave weather persists uninterrupted (same "sustained duration"
// shape as isHeatwaveSlowdownActive just above, and water.js's Cold-side FREEZE_TIER_TICKS
// escalation -- FREEZE_TIER_TICKS[2]=900 is that file's own "tier 3" breakpoint, reused here for
// cross-system consistency rather than inventing a fresh number). Two real HeatwaveHigh effects
// ride this one shared gate: a genuinely worse "Overheated" heatstroke stage (heatstrokesystem.txt)
// and a real chance of an electrical fire starting on an electrical structure (calamities.txt).
const HEATWAVE_HIGH_SUSTAIN_TICKS = FREEZE_TIER_TICKS[2]; // 900 -- reuses Cold's own tier-3 breakpoint

/** True once Heatwave has been active for at least HEATWAVE_HIGH_SUSTAIN_TICKS in a row -- the
 *  real PA "HeatwaveHigh" top severity tier, strictly longer-sustained than
 *  isHeatwaveSlowdownActive's own HEATWAVE_SUSTAIN_TICKS(300) gate above. */
export function isHeatwaveHighActive(world) {
  return world.weather === WeatherKind.Heatwave && (world._weatherStreakTicks || 0) >= HEATWAVE_HIGH_SUSTAIN_TICKS;
}

// Two-stage heatstroke (real PA heatstrokesystem.txt): this project previously only ever applied
// the milder Heatstroke stage's speed factor (HEATWAVE_WANDER_SPEED_MULT=0.75 above), with no
// staged progression. Overheated is the real, harsher stage reached at HeatwaveHigh -- distinct
// from, and strictly worse than, the existing single-stage treatment on both axes real PA gives it.
export const HEATWAVE_OVERHEATED_SPEED_MULT = 0.5; // real PA speedFactor for the Overheated stage
// Real PA "needs-decay factor" 0.3 for the Overheated stage. Applied below as an ADDITIONAL
// fraction of REST_DECAY stacked on top of the existing HEAT_REST_EXTRA_OUTDOOR(0.8) (not a
// replacement) -- i.e. an Overheated, outdoor citizen loses rest at (0.8+0.3)=1.1x the base extra
// rate instead of plain Heatstroke's 0.8x, unambiguously worse on this axis too. (HEAT_REST_EXTRA_
// OUTDOOR is itself an invented "port the mechanism, not the literal number" figure, not a literal
// PA stat -- so the real 0.3 is applied relative to it as an increment rather than guessing what an
// absolute "needs decay factor" would mean against PA's own different needs model. Flagged as the
// one interpretive call in this item worth double-checking against heatstrokesystem.txt directly if
// that source text is ever available.)
export const HEATWAVE_OVERHEATED_REST_EXTRA_BONUS = 0.3;

/** Per-citizen walk-speed multiplier for the FULL two-stage heatstroke system (Heatstroke +
 *  Overheated) at a given position -- 1 indoors or with no Heatwave slowdown active at all,
 *  HEATWAVE_WANDER_SPEED_MULT(0.75) outdoors during plain Heatstroke, or the harsher
 *  HEATWAVE_OVERHEATED_SPEED_MULT(0.5) outdoors once HeatwaveHigh/Overheated is reached. This is
 *  an ADDITIVE export -- world.js's existing inline heat-speed ternary in its tickWander call
 *  (isHeatwaveSlowdownActive + HEATWAVE_WANDER_SPEED_MULT) is untouched and keeps working exactly
 *  as before; see this task's report for the one-line swap needed to actually surface the
 *  Overheated tier in movement. */
export function heatwaveWalkSpeedMultAt(world, x, y) {
  if (!isHeatwaveSlowdownActive(world)) return 1;
  if (roomContaining(world.rooms, world.grid, x, y)) return 1;
  return isHeatwaveHighActive(world) ? HEATWAVE_OVERHEATED_SPEED_MULT : HEATWAVE_WANDER_SPEED_MULT;
}

// ---------------------------------------------------------------- Heatwave electrical fire (HeatwaveHigh)
// Real PA calamities.txt HeatwaveHigh: a real per-tick chance of an electrical fire starting on an
// electrical structure once the calamity is at its top severity tier. Reuses isPowerStructureKind
// (defined further down this file, in the Lightning Storm calamity section -- a hoisted `function`
// declaration, so this forward reference is safe) as the same real target set (generator/wire/
// battery/power_switch), and reuses fire.js's EXISTING igniteStructure/tickFire machinery exactly
// like tryMassFireEvent and tickThunderstorm's lightning strikes already do elsewhere in this file
// -- fire.js's own already-running tickFire (called every tick from world.js alongside this file's
// own per-tick systems) picks up the ongoing per-tick burn-down automatically via its existing
// FIRE_DAMAGE_PER_TICK, so no separate damage number needs porting here: this IS "fire.js's existing
// damage model having a compatible unit to reuse" (a 0-1 structure-health burn-down), so per the
// task brief, no fire.js edit is needed and none was made (read read-only).
const ELECTRICAL_FIRE_CHECK_INTERVAL = 100; // same cadence as water.js's own FREEZE_CHECK_INTERVAL
const ELECTRICAL_FIRE_CHANCE = 0.05; // real PA ~5%, per check once HeatwaveHigh is active
const ELECTRICAL_FIRE_MAX_CONCURRENT = 2; // real PA cap -- a rare, contained threat, not a cascade

/** Rolls a real per-check chance of igniting one electrical structure while HeatwaveHigh (see
 *  isHeatwaveHighActive above) is active, capped at ELECTRICAL_FIRE_MAX_CONCURRENT simultaneous
 *  electrical fires from ANY source (a fire already burning from another cause still counts toward
 *  the cap -- don't stack independent fire sources past a sane ceiling). Call once per tick from
 *  tickWeather below. */
export function tickHeatwaveElectricalFire(world) {
  if (!isHeatwaveHighActive(world)) return;
  if (world.currentTick % ELECTRICAL_FIRE_CHECK_INTERVAL !== 0) return;

  const burning = world.structures.filter(s => isPowerStructureKind(s.kind) && s.onFire && !s.destroyed);
  if (burning.length >= ELECTRICAL_FIRE_MAX_CONCURRENT) return;
  if (world.rng() >= ELECTRICAL_FIRE_CHANCE) return;

  const candidates = world.structures.filter(s =>
    isPowerStructureKind(s.kind) && !s.destroyed && !s.underConstruction && !s.onFire);
  if (candidates.length === 0) return;

  const target = candidates[Math.floor(world.rng() * candidates.length)];
  igniteStructure(target);
  const label = target.kind.replace(/_/g, ' ');
  const text = `The heatwave sparks an electrical fire in a ${label}`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
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
      // Overheated (see HEATWAVE_OVERHEATED_REST_EXTRA_BONUS's doc comment above): an additional
      // needs-decay bonus stacked on top of the base outdoor fraction once HeatwaveHigh is reached
      // -- distinct from, and worse than, plain Heatstroke's flat 0.8x treatment.
      let outdoorFrac = HEAT_REST_EXTRA_OUTDOOR;
      if (!indoors && isHeatwaveHighActive(world)) outdoorFrac += HEATWAVE_OVERHEATED_REST_EXTRA_BONUS;
      const extra = REST_DECAY * (indoors ? HEAT_REST_EXTRA_INDOOR : outdoorFrac);
      store.rest[i] = Math.max(0, store.rest[i] - extra);
    }
  }
}

// ---------------------------------------------------------------- Aurora mood boost
// Real RimWorld: Aurora is the one POSITIVE weather-like entry in the source data (real "Saw
// beautiful aurora" Thought, +3 mood) -- a genuine counterpart to this file's otherwise
// almost-entirely-negative roster (Rain/Cold/Heatwave/Fog/Snow/Thunderstorms all debuff
// something; only the unrelated one-off resourcegift/trader events were previously positive).
// Ported via citizens.js's own existing addMoodEvent stacking-Thought mechanic (see that file's
// "RimWorld Thought mechanic, condensed" header) rather than a bespoke mood field write --
// exactly the same reuse shape tryResourceGiftEvent above already used for Blight's inverse.
// AURORA_MOOD_MAGNITUDE=0.03 is the real RimWorld number (+3 out of 100), matching this codebase's
// own established "real points / 100" convention (see programs.js's own room-quality mood table
// for the same convention already in use). Refreshed every AURORA_MOOD_CHECK_INTERVAL ticks for
// as long as Aurora weather holds (own 1-deep stack cap in citizens.js's MOOD_EVENT_STACK_LIMITS,
// see that entry's own comment) so the boost reads as one continuous, bounded ambient effect for
// the sky's whole duration rather than compounding or lapsing between checks -- addMoodEvent's
// own linear decay (see citizens.js) then eases it back out naturally once Aurora ends and the
// refresh stops.
const AURORA_MOOD_CHECK_INTERVAL = 100; // same ~10s cadence as this file's other periodic checks
const AURORA_MOOD_MAGNITUDE = 0.03;      // real RimWorld Aurora Thought: +3/100
const AURORA_MOOD_DURATION_TICKS = 250;  // comfortably outlasts the refresh interval above so the
                                          // event never fully decays to 0 between refreshes

/** Refreshes a small, bounded, positive mood event on every living citizen for as long as Aurora
 *  weather is active -- the positive counterpart to Cold/Heatwave's extra need-decay in
 *  tickWeatherCitizenEffects just above. Call once per tick from tickWeather below. */
export function tickAuroraMoodBoost(world) {
  if (world.weather !== WeatherKind.Aurora) return;
  if (world.currentTick % AURORA_MOOD_CHECK_INTERVAL !== 0) return;

  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i) || store.isDownedAt(i)) continue;
    addMoodEvent(store, i, world.currentTick, {
      magnitude: AURORA_MOOD_MAGNITUDE, durationTicks: AURORA_MOOD_DURATION_TICKS, stackKey: 'aurora',
    });
  }
}

// ---------------------------------------------------------------- Deep Freeze staged frostbite/death
// Real Prison Architect deepfreezesystem.txt staged Deep Freeze exposure progression (see task
// brief): MinutesToFrozenBreath 50, MinutesToBlueSkin 120, MinutesToWalkSpeedReduction 180,
// MinutesToDeath 230, RecoveryRates 5. "Deep Freeze" is this project's existing Cold WeatherKind
// (same "port the mechanism, not the flavor" framing as the rest of this file) -- exposure is
// tracked per citizen, ratchets up only while Cold is active AND the citizen is outdoors (reusing
// the exact roomContaining sheltered-check tickWeatherCitizenEffects's Cold branch above already
// uses), and decays back down once no longer exposed, so ducking indoors is real, responsive
// counterplay -- not a silent passive drain like the rats-theft regression this same session hit.
//
// TICK-CONVERSION NOTE (read before touching any number below -- this is the number the task brief
// specifically warned a factor-of-10 error here would be a serious regression on):
// This project's tick rate is a literal, already-established 10Hz (SECONDS_PER_TICK = 0.1 in
// main.js; see also this file's own "~1 min at 10Hz" comments on MIN_WEATHER_TICKS/
// HAZARD_DURATION_MIN/SOLAR_FLARE_DURATION_MIN above), so a literal real-minutes-to-ticks
// conversion is 600 ticks/minute (10 ticks/sec * 60 sec/min). Applying that literally to PA's real
// minute values: FrozenBreath 50*600=30000, BlueSkin 120*600=72000, WalkSpeedReduction
// 180*600=108000, Death 230*600=138000 ticks.
//
// Those literal numbers are ARCHITECTURALLY UNREACHABLE in this project as shipped -- this was
// checked, not assumed, before picking the numbers actually used below. Cold is one of several
// WeatherKind states that cycle every MIN_WEATHER_TICKS-MAX_WEATHER_TICKS (600-1800 ticks, ~1-3
// min) and pickWeather() guarantees the next roll is never the same kind twice in a row, so a
// single continuous Cold spell can never exceed 1800 ticks -- ~1.3% of the literal 138000-tick
// death threshold. Worse, RecoveryRates(5) applied "whenever no longer exposed" decays 5 ticks per
// elapsed tick the instant Cold weather rolls away to something else; the shortest possible gap
// between two Cold spells is one full MIN_WEATHER_TICKS(600)-tick intervening weather state, which
// alone guarantees at least 5*600=3000 ticks of recovery -- already more than an entire max-length
// Cold spell (1800) could ever have accumulated. So with a literal conversion AND a literal
// "recovers whenever the weather isn't Cold" reading, exposure provably resets to exactly 0 between
// every single Cold spell no matter how small the thresholds are: cross-spell accumulation is
// mathematically impossible, and the mechanic would never fire in any real game.
//
// Two deliberate, documented departures from a literal transcription fix this without abandoning
// the real data's shape (the task brief's own "~230-minute-EQUIVALENT timeline" phrasing is read
// here as license to calibrate rather than transcribe verbatim):
//  1. Recovery only applies while the citizen is actually SHELTERED (indoors), not merely whenever
//     the CURRENT weather label isn't "Cold". An outdoor citizen doesn't warm up just because the
//     sky changed from Cold to Fog while they're still standing outside -- "no longer exposed" is
//     read as "found shelter", not "the weather ticker moved on". While outdoors and it's NOT Cold,
//     exposure holds steady (no gain, no loss) instead of accumulating or draining. This alone
//     makes cross-spell accumulation possible again (an outdoor worker who's never sent inside
//     keeps their progress between Cold snaps) without changing the RecoveryRate-vs-accumulation-
//     rate RATIO the source data specifies (still exactly 5x).
//  2. The four absolute thresholds are compressed (same 50:120:180:230 relative proportions, much
//     smaller absolute magnitude) so Death sits at roughly the outer edge of even a long, healthy
//     game for a citizen who is outdoors, unsheltered, during virtually this project's ENTIRE Cold
//     duty cycle (Cold's WEATHER_WEIGHTS share is 1.5 of 12.9 total = ~11.6% of all weather-ticks) --
//     i.e. reaching Death requires near-total, whole-game neglect of one specific citizen, not an
//     unlucky roll or a short lapse. At DEEP_FREEZE_DEATH_TICKS=4000 (exposed ticks, i.e. ticks that
//     were BOTH Cold and unsheltered), a permanently-neglected citizen needs ~4000/0.116 =~ 34,500
//     elapsed ticks -- at or beyond this project's own healthy 22-36k-tick full-game baseline (see
//     SESSION_HANDOFF.md), and well beyond its currently-regressed ~10-12k baseline. A citizen who
//     is sheltered even occasionally needs meaningfully longer than that, or never reaches it at
//     all (RecoveryRates keeps clawing back proportionally faster than accumulation).
const DEEP_FREEZE_RECOVERY_MULT = 5; // real PA RecoveryRates value -- exposure drains 5x faster
                                      // than it accumulates once a citizen is actually sheltered
export const DEEP_FREEZE_FROZEN_BREATH_TICKS = 870;  // cosmetic-only, real PA stage 1 (literal 50 min)
export const DEEP_FREEZE_BLUE_SKIN_TICKS = 2090;      // cosmetic-only, real PA stage 2 (literal 120 min)
export const DEEP_FREEZE_WALK_SPEED_TICKS = 3130;     // real move-speed penalty, real PA stage 3 (literal 180 min)
export const DEEP_FREEZE_DEATH_TICKS = 4000;          // real death, real PA stage 4 (literal 230 min)
export const DEEP_FREEZE_WALK_SPEED_MULT = 0.5; // NOT given an explicit value by the source data
                                                  // available for this task (only the four minute
                                                  // thresholds + RecoveryRates were provided) --
                                                  // this is an inferred, conservative estimate
                                                  // (worse than plain Heatstroke's 0.75, matching
                                                  // the harsher Overheated tier's own 0.5 above);
                                                  // flagged in this task's report as worth checking
                                                  // against deepfreezesystem.txt's real
                                                  // MoveSpeedFactor if that number is ever sourced.

/** Per-citizen Deep Freeze exposure timer, in ticks. Lazily sized to the CitizenStore's fixed
 *  capacity (world.citizens.capacity -- see world.js's `new CitizenStore(64)`; capacity never
 *  shrinks or reuses indices, see citizens.js's spawn(), so a plain capacity-sized array indexed
 *  identically to store's own per-citizen arrays is safe without needing a stable-id-keyed Map). */
function deepFreezeExposureArray(world) {
  const cap = world.citizens.capacity;
  if (!world._deepFreezeExposure || world._deepFreezeExposure.length < cap) {
    world._deepFreezeExposure = new Float32Array(cap);
  }
  return world._deepFreezeExposure;
}

function pushDeepFreezeMilestone(world, count, singular, plural) {
  const text = count === 1 ? singular : plural.replace('{n}', String(count));
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
}

/** Per-citizen Deep Freeze exposure ratchet + recovery + stage transitions (Blue Skin / Walk Speed
 *  Reduction / Death) -- see the header comment above for the full design rationale, including why
 *  the absolute thresholds are compressed from a literal minutes*600 conversion. Runs every tick
 *  regardless of current weather (a sheltered citizen needs to keep recovering even after Cold
 *  weather has since rolled away) -- unlike tickWeatherCitizenEffects's Cold/Heatwave-only early
 *  return, this has no early-out. Frozen Breath (the mildest, earliest cosmetic stage) is
 *  deliberately not logged individually -- purely cosmetic-only per the task brief, and Blue Skin
 *  just below it already gives the same order-of-magnitude advance warning. Blue Skin/Walk Speed
 *  crossings are coalesced into at most one milestone each per tick (rather than one per citizen)
 *  so a colony-wide neglect scenario -- exactly the kind of thing a hands-off soak test would
 *  surface -- can't flood the 20-entry milestoneLog the way a per-citizen message would. Call once
 *  per tick from tickWeather below. */
export function tickDeepFreezeExposure(world) {
  const store = world.citizens;
  const exposure = deepFreezeExposureArray(world);
  const coldActive = world.weather === WeatherKind.Cold;

  let newBlueSkin = 0, newWalkSpeed = 0;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i) || store.isDownedAt(i)) continue;

    const sheltered = !!roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
    const prev = exposure[i];

    if (coldActive && !sheltered) {
      exposure[i] = Math.min(DEEP_FREEZE_DEATH_TICKS, prev + 1);
    } else if (sheltered) {
      exposure[i] = Math.max(0, prev - DEEP_FREEZE_RECOVERY_MULT);
    }
    // else: outdoors but weather isn't Cold -- holds steady, see departure #1 in the header comment.

    const now = exposure[i];
    if (prev < DEEP_FREEZE_BLUE_SKIN_TICKS && now >= DEEP_FREEZE_BLUE_SKIN_TICKS) newBlueSkin++;
    if (prev < DEEP_FREEZE_WALK_SPEED_TICKS && now >= DEEP_FREEZE_WALK_SPEED_TICKS) newWalkSpeed++;

    if (prev < DEEP_FREEZE_DEATH_TICKS && now >= DEEP_FREEZE_DEATH_TICKS) {
      // Same Dead-flag + alive=0 + health=0 pattern citizens.js's own untended-bleed-out death and
      // this file's Lightning Storm damage tier already use -- a real, established death path in
      // this codebase, not a new one invented for this task.
      store.health[i] = 0;
      store.flags[i] |= CitizenFlags.Dead;
      store.alive[i] = 0;
      const text = `${store.name[i]} dies of hypothermia after prolonged, unsheltered exposure to the deep freeze`;
      world.milestoneLog.push({ tick: world.currentTick, text });
      if (world.milestoneLog.length > 20) world.milestoneLog.shift();
      world.onRandomEvent?.(text);
      continue;
    }
  }

  if (newBlueSkin > 0) {
    pushDeepFreezeMilestone(world, newBlueSkin,
      'A citizen turns blue from the cold -- get them somewhere warm',
      '{n} citizens turn blue from the cold -- get them somewhere warm');
  }
  if (newWalkSpeed > 0) {
    pushDeepFreezeMilestone(world, newWalkSpeed,
      'A citizen has real frostbite -- slowed, and at risk if left in the deep freeze much longer',
      '{n} citizens have real frostbite -- slowed, and at risk if left in the deep freeze much longer');
  }
}

/** Per-citizen walk-speed multiplier from Deep Freeze frostbite (real PA MinutesToWalkSpeedReduction
 *  stage) -- 1 (no effect) unless this citizen has crossed DEEP_FREEZE_WALK_SPEED_TICKS of
 *  accumulated exposure. NOT yet read anywhere -- world.js's tickWander call (the same
 *  perCitizenMult callback HEATWAVE_WANDER_SPEED_MULT/lightningStormMoveMult/epidemicMoveMultFor
 *  already feed into) needs one more term multiplied in; see this task's report for the exact
 *  one-line hook. */
export function deepFreezeWalkSpeedMult(world, i) {
  const exposure = world._deepFreezeExposure;
  if (!exposure || i >= exposure.length) return 1;
  return exposure[i] >= DEEP_FREEZE_WALK_SPEED_TICKS ? DEEP_FREEZE_WALK_SPEED_MULT : 1;
}

// ---------------------------------------------------------------- Deep Freeze work-rate reduction
// Real PA calamities.txt WorkRateReduction_Construction (0.5/0.25/0.1 by Cold-duration tier) and
// WorkRateReduction_Gardening (0.5/0.25/0.01). This project's Cold weather previously only ever
// touched hunger decay (tickWeatherCitizenEffects above) -- these are new, additive work-speed
// lookups. NOT yet read anywhere: jobs.js owns the actual work-rate math (BUILD_RATE's per-tick
// build-progress increment for Construction; Farm Plot's per-tick tend-progress increment for the
// closest match to PA's "Gardening" -- this project has no dedicated WorkCategory.Gardening, see
// that enum, read-only, which only has Construction/Processing/Hauling/Harvesting/Animal/Cleaning).
// See this task's report for the exact one-line hooks needed in jobs.js.
const COLD_WORK_RATE_CONSTRUCTION = [0.5, 0.25, 0.1];  // real PA numbers, indexed by Cold tier (0-2)
const COLD_WORK_RATE_GARDENING = [0.5, 0.25, 0.01];    // real PA numbers, indexed by Cold tier (0-2)

// Shared duration-tier lookup (same FREEZE_TIER_TICKS breakpoints water.js's own freeze chance and
// this file's flu-risk multiplier below use) -- tier 0 the instant Cold starts (FREEZE_TIER_TICKS[0]
// is 0), escalating to tier 2 at FREEZE_TIER_TICKS[2]=900 sustained ticks.
function coldSeverityTier(world) {
  const streak = world._weatherStreakTicks || 0;
  let tier = 0;
  for (let i = 0; i < FREEZE_TIER_TICKS.length; i++) {
    if (streak >= FREEZE_TIER_TICKS[i]) tier = i;
  }
  return tier;
}

/** Construction work-speed multiplier while Cold is active -- 1 (no effect) if not Cold, otherwise
 *  the real duration-tiered PA reduction above. */
export function coldConstructionWorkRateMult(world) {
  if (world.weather !== WeatherKind.Cold) return 1;
  return COLD_WORK_RATE_CONSTRUCTION[coldSeverityTier(world)];
}

/** Gardening (this project's Farm Plot tending) work-speed multiplier while Cold is active -- same
 *  shape as coldConstructionWorkRateMult above, real PA Gardening numbers (harsher at tier 3: 0.01
 *  vs Construction's 0.1). */
export function coldGardeningWorkRateMult(world) {
  if (world.weather !== WeatherKind.Cold) return 1;
  return COLD_WORK_RATE_GARDENING[coldSeverityTier(world)];
}

// ---------------------------------------------------------------- Deep-Freeze-linked flu risk
// Real PA calamities.txt FluOutbreak scales 0.5/0.3/0.1 by DeepFreeze tier (see task brief). Read
// literally that's a DESCENDING table (biggest bonus at the mildest tier), which would make flu
// LESS likely to spike at the most severe Cold tier -- the opposite of "Deep-Freeze-linked" risk
// INCREASING with severity, and inconsistent with every other tiered mechanic in this task (water.js's
// freeze chance, the work-rate reduction above), which all escalate with tier. Applied here in
// ASCENDING order instead (0.1/0.3/0.5 for tier 0/1/2) as an additive bonus fraction on top of
// sickness.js's base per-check onset chance (1.0 = no change, so tier-2 Cold makes a flu-onset
// check 1.5x as likely) -- flagged as the interpretive call it is, worth re-checking against
// calamities.txt directly if the real tier ordering is ever confirmed.
const FLU_RISK_TIER_BONUS = [0.1, 0.3, 0.5];

/** sickness.js reads this (not the other way around, per the task brief) to scale its own onset
 *  roll during Cold weather -- 1 (no change) outside Cold, escalating with the same Cold-duration
 *  tiers as everything else above. */
export function fluRiskMultiplier(world) {
  if (world.weather !== WeatherKind.Cold) return 1;
  return 1 + FLU_RISK_TIER_BONUS[coldSeverityTier(world)];
}

/** Advances the weather timer and, on expiry, rolls a new (different) weather state -- gated by
 *  the current Season (see currentSeason/SEASON_WEATHER_MULT above, e.g. Snow can only come up
 *  in Winter, Heatwave is far more likely in Summer) -- then applies the current weather's
 *  per-tick citizen effect (every tick, not just on change -- Cold/Heatwave's extra decay is a
 *  continuous effect for as long as that state holds). Call once per tick from SimWorld.tick(),
 *  same pattern as the other periodic systems there. */
export function tickWeather(world) {
  if (world._weatherTimer == null) initWeather(world);
  world._weatherTimer--;
  if (world._weatherTimer <= 0) {
    const next = pickWeather(world.rng, world.weather, currentSeason(world), isVolcanicWinterActive(world));
    world.weather = next;
    world._weatherTimer = rollDuration(world.rng, next);
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
  // Aurora mood boost (see that function's header comment) -- own internal weather===Aurora
  // early-return, cheap to call unconditionally every tick like every other tick* function here.
  tickAuroraMoodBoost(world);
  // Deep Freeze per-citizen frostbite/death exposure (see that function's header comment) --
  // deliberately NOT gated on `weather === Cold` here, unlike tickWeatherCitizenEffects just
  // above: a sheltered citizen still needs to recover even once Cold weather has since rolled
  // away, so the function owns its own always-runs shape internally.
  tickDeepFreezeExposure(world);
  // Heatwave electrical fire (HeatwaveHigh calamity tier) -- own internal early-return, cheap to
  // call unconditionally every tick like every other tick* function in this file.
  tickHeatwaveElectricalFire(world);
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
  // SolarFlare-style blackout (see tickSolarFlareCondition below) is its own independent state
  // machine, not a variant of the toxic-fallout hazard above it -- piggybacked on this call
  // purely because world.js's tick() already calls tickHazardCondition every tick (see that
  // file's tick()) and this task's scope doesn't include adding a new call site there. Called
  // unconditionally, before any of the toxic-fallout early-returns below, so it still runs on
  // every tick regardless of that hazard's own active/inactive state.
  tickSolarFlareCondition(world);
  // Rolling Blackout + Faulty Wiring (real PA calamity_settings.txt, both real-GeneratorLoad-gated
  // -- see their own header comments below) -- piggybacked here for the exact same reason
  // SolarFlare is: world.js's tick() already calls tickHazardCondition every tick, and this task's
  // scope doesn't include adding a new call site there. Both own independent internal gating (an
  // inactive/below-threshold grid is a cheap no-op) so calling them unconditionally here, before
  // any of the toxic-fallout branches below, is safe and matches every other tick* function in
  // this file.
  tickRollingBlackoutCondition(world);
  tickFaultyWiring(world);
  // VolcanicWinter (real RimWorld anchor, see that section's own header comment far below) --
  // piggybacked here for the exact same reason SolarFlare/RollingBlackout/FaultyWiring already
  // are: world.js's tick() already calls tickHazardCondition every tick, and this task's scope
  // doesn't include adding a new call site there. Owns its own internal earliest-tick/refire
  // gating, so calling it unconditionally is cheap and safe, matching every other tick* function
  // in this file.
  tickVolcanicWinterCondition(world);

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

// ---------------------------------------------------------------- volcanic winter (severe-cold condition)
// Real RimWorld anchor: VolcanicWinter -- name-checked in the toxic-fallout header comment above
// as ToxicFallout's own real sibling condition, and ported the exact same way: a sustained,
// MAP-WIDE condition (own duration range, own long refire gap, own late-game-only grace),
// structurally identical to tickHazardCondition/tickSolarFlareCondition/
// tickRollingBlackoutCondition just above and below it (own private fields, own init/isActive/
// tick triplet, same milestoneLog-push-and-trim + onRandomEvent announcement shape). Two real
// VolcanicWinter traits distinguish it from those siblings and from the file's own regular
// WeatherKind roster:
//  1. Real VolcanicWinter is explicitly a LONGER, RARER condition than ToxicFallout in the source
//     data (RimWorld's own volcanic winter runs most of a full in-game year), so its timing
//     constants below are deliberately calibrated as the harsher/longer end of this file's
//     existing hazard-tuning range rather than reusing HAZARD_* wholesale.
//  2. Real VolcanicWinter is a severe-COLD condition, and real RimWorld explicitly cannot roll a
//     Heatwave incident while one is active (a heat wave during a volcanic winter isn't a
//     plausible roll) -- ported above via pickWeather's own excludeHeatwave parameter (see that
//     function's comment) rather than a bespoke check duplicated here, and its own severe-cold
//     effect below is table-driven off the SAME COLD_HUNGER_EXTRA_OUTDOOR/INDOOR constants
//     tickWeatherCitizenEffects already uses (just scaled up by VOLCANIC_WINTER_COLD_SEVERITY_MULT
//     below), not a parallel hunger-decay system of its own.
export const VOLCANIC_WINTER_EARLIEST_TICK = HAZARD_EARLIEST_TICK; // same late-game grace as toxic fallout
export const VOLCANIC_WINTER_MIN_REFIRE_TICKS = HAZARD_MIN_REFIRE_TICKS * 2; // rarer than toxic
                                                                               // fallout -- real
                                                                               // VolcanicWinter is
                                                                               // rarer even by that
                                                                               // hazard's own standard
const VOLCANIC_WINTER_CHECK_INTERVAL = HAZARD_CHECK_INTERVAL; // same roll cadence as toxic fallout
const VOLCANIC_WINTER_CHANCE = HAZARD_CHANCE * 0.5; // half as likely per check, on top of the
                                                      // doubled refire gap above -- genuinely rarer
                                                      // on both axes, not just a longer cooldown
const VOLCANIC_WINTER_DURATION_MIN = HAZARD_DURATION_MAX;      // 3000 -- starts where toxic
                                                                 // fallout's own max duration ends
const VOLCANIC_WINTER_DURATION_MAX = HAZARD_DURATION_MAX * 2;  // 6000 -- the single longest
                                                                 // condition in this file, matching
                                                                 // "long-duration" in the task brief
// Doubles COLD_HUNGER_EXTRA_OUTDOOR/INDOOR's fraction while active (see tickWeatherCitizenEffects
// above) -- applied by a small standalone effects pass below, unconditionally (independent of
// whatever world.weather actually rolled that tick), since real VolcanicWinter's severe cold is a
// map-wide temperature drop that doesn't wait for a separate "Cold" weather roll to also be
// active. If Cold weather DOES happen to be rolled at the same time, the two stack (tickWeather-
// CitizenEffects' own Cold branch plus this pass), which is the honest "even worse when it lines
// up with an actual cold snap" reading, not a bug to guard against.
export const VOLCANIC_WINTER_COLD_SEVERITY_MULT = 2;

/** Call once from SimWorld's constructor (or lazily from tickVolcanicWinterCondition on first
 *  tick), same pattern as initHazard/initSolarFlare above. */
export function initVolcanicWinter(world) {
  world._volcanicWinterActive = false;
  world._volcanicWinterTicksRemaining = 0;
  world._volcanicWinterLastEndTick = -Infinity;
  world.volcanicWinterActive = false;
}

/** True while the volcanic-winter severe-cold condition is active. */
export function isVolcanicWinterActive(world) {
  return !!world._volcanicWinterActive;
}

/** Per-citizen extra hunger-decay pass for VolcanicWinter's severe cold -- a thin, doubled
 *  reprise of tickWeatherCitizenEffects' own Cold branch (same sheltered/outdoor split via
 *  roomContaining), fired unconditionally while active rather than gated on world.weather===Cold.
 *  Called from tickVolcanicWinterCondition below. */
function tickVolcanicWinterColdEffects(world) {
  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i) || store.isDownedAt(i)) continue;
    const indoors = !!roomContaining(world.rooms, world.grid, store.x[i], store.y[i]);
    const frac = (indoors ? COLD_HUNGER_EXTRA_INDOOR : COLD_HUNGER_EXTRA_OUTDOOR) * VOLCANIC_WINTER_COLD_SEVERITY_MULT;
    store.hunger[i] = Math.max(0, store.hunger[i] - HUNGER_DECAY * frac);
  }
}

/** Advances an active volcanic winter's duration and ends it once expired (recording the end tick
 *  for the next refire-gap check), or -- while inactive -- rolls a new one once the earliest-tick
 *  grace and the (doubled) refire cooldown have elapsed. Exact same shape as
 *  tickSolarFlareCondition/tickRollingBlackoutCondition above. Called from tickHazardCondition
 *  above, alongside those two -- see that call site's own comment for why (world.js's tick()
 *  already calls tickHazardCondition every tick, and this task's scope doesn't add a new call
 *  site there). */
export function tickVolcanicWinterCondition(world) {
  if (world._volcanicWinterActive == null) initVolcanicWinter(world);

  if (world._volcanicWinterActive) {
    world._volcanicWinterTicksRemaining--;
    if (world._volcanicWinterTicksRemaining <= 0) {
      world._volcanicWinterActive = false;
      world._volcanicWinterLastEndTick = world.currentTick;
      const text = 'The volcanic winter finally breaks -- the deep cold lifts';
      world.milestoneLog.push({ tick: world.currentTick, text });
      if (world.milestoneLog.length > 20) world.milestoneLog.shift();
      world.onRandomEvent?.(text);
    } else {
      tickVolcanicWinterColdEffects(world);
    }
  } else if (
    world.currentTick >= VOLCANIC_WINTER_EARLIEST_TICK
    && world.currentTick - world._volcanicWinterLastEndTick >= VOLCANIC_WINTER_MIN_REFIRE_TICKS
    && world.currentTick % VOLCANIC_WINTER_CHECK_INTERVAL === 0
    && world.rng() < VOLCANIC_WINTER_CHANCE
  ) {
    world._volcanicWinterActive = true;
    world._volcanicWinterTicksRemaining = VOLCANIC_WINTER_DURATION_MIN
      + Math.floor(world.rng() * (VOLCANIC_WINTER_DURATION_MAX - VOLCANIC_WINTER_DURATION_MIN));
    const text = 'A volcanic winter settles over the settlement -- a long, severe cold, and no heatwave will break it';
    world.milestoneLog.push({ tick: world.currentTick, text });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    world.onRandomEvent?.(text);
  }

  world.volcanicWinterActive = !!world._volcanicWinterActive;
}

// ---------------------------------------------------------------- solar flare (grid blackout)
// Real RimWorld anchor: SolarFlare / GameCondition_DisableElectricity -- a sustained, MAP-WIDE
// condition (same category as ToxicFallout/VolcanicWinter above) that disables every electrical
// device on the map for its duration, real duration "about a day". This project already has a
// real wired power grid (power.js: generators/wires/batteries/switches, ported from Prison
// Architect's utilities grid), so unlike HAZARD_REFILL_MULT above (which had to substitute a
// genre-neutral equivalent for a mechanic -- outdoor plant death -- this codebase has no analog
// for), this one ports directly onto real, already-existing power-grid state: while active,
// power.js's isPoweredAt reports no power anywhere (see setSolarFlareActive, called below), which
// cascades into every real consumer of that check (turret/tesla/watchtower powered bonus,
// vehicles.js's electric-garage gate) with zero new gameplay code needed on this end -- this file
// only owns the condition's own timing/rolling, not how power state gets consumed downstream.
//
// Duration is NOT a literal "1 day * this project's DAY_NIGHT_CYCLE_TICKS(2400, schedule.js)"
// conversion -- that would be ~2400 ticks, i.e. roughly the same order of magnitude as this
// hazard's own HAZARD_DURATION_MAX above, when the real relationship is the opposite: RimWorld's
// SolarFlare (~1 day) is short compared to ToxicFallout/VolcanicWinter (days to a full season).
// Scaled instead as a fraction of HAZARD_DURATION_MIN/MAX proportional to that same real-game
// ratio (a solar flare reads as noticeably shorter than a toxic-fallout stretch, not equally
// long) -- shorter than a weather cycle's own MIN_WEATHER_TICKS even, so a blackout reads as a
// sharp, disruptive spike rather than a background state like Cold/Heatwave.
const SOLAR_FLARE_EARLIEST_TICK = 1500;     // modest "let the player get a generator up first"
                                             // grace -- real SolarFlare has no late-game-only gate
                                             // the way VolcanicWinter/ToxicFallout do, unlike
                                             // HAZARD_EARLIEST_TICK above
export const SOLAR_FLARE_MIN_REFIRE_TICKS = 3000; // much shorter cooldown than HAZARD_MIN_REFIRE_TICKS
                                                   // -- real SolarFlare isn't VolcanicWinter-tier rare
const SOLAR_FLARE_CHECK_INTERVAL = 500; // same roll cadence as the toxic-fallout hazard above
const SOLAR_FLARE_CHANCE = 0.02;        // per check, once eligible -- rare (task brief), but not
                                         // gated behind late-game the way toxic fallout is
const SOLAR_FLARE_DURATION_MIN = 500;   // ~50s at 10Hz
const SOLAR_FLARE_DURATION_MAX = 1000;  // ~100s at 10Hz -- see duration-ratio comment above

/** Call once from SimWorld's constructor (or lazily from tickSolarFlareCondition on first tick),
 *  same pattern as initHazard above. world.solarFlareActive is the public mirror of the private
 *  _solarFlareActive timer state -- power.js's isPoweredAt gate doesn't read either of these
 *  directly (see setSolarFlareActive there), but other files are free to read
 *  world.solarFlareActive for their own purposes (e.g. a UI banner) without needing a new
 *  power.js export. */
export function initSolarFlare(world) {
  world._solarFlareActive = false;
  world._solarFlareTicksRemaining = 0;
  world._solarFlareLastEndTick = -Infinity;
  world.solarFlareActive = false;
}

/** True while the solar-flare blackout is active. */
export function isSolarFlareActive(world) {
  return !!world._solarFlareActive;
}

/** Advances an active flare's duration and ends it once expired, or -- while inactive -- rolls a
 *  new one once both the earliest-tick grace and the refire cooldown have elapsed. Same shape as
 *  tickHazardCondition above, kept as an independent state machine (own fields, own constants)
 *  rather than folded into that one's toxic-fallout-specific branches. Mirrors this tick's result
 *  onto world.solarFlareActive and power.js's module-level flag (setSolarFlareActive) every call,
 *  regardless of which branch ran, so both stay correct even across the exact tick a flare starts
 *  or ends. Called from tickHazardCondition above (see that function's header comment for why). */
export function tickSolarFlareCondition(world) {
  if (world._solarFlareActive == null) initSolarFlare(world);

  if (world._solarFlareActive) {
    world._solarFlareTicksRemaining--;
    if (world._solarFlareTicksRemaining <= 0) {
      world._solarFlareActive = false;
      world._solarFlareLastEndTick = world.currentTick;
      const text = 'The solar flare passes -- power returns to the grid';
      world.milestoneLog.push({ tick: world.currentTick, text });
      if (world.milestoneLog.length > 20) world.milestoneLog.shift();
      world.onRandomEvent?.(text);
    }
  } else if (
    world.currentTick >= SOLAR_FLARE_EARLIEST_TICK
    && world.currentTick - world._solarFlareLastEndTick >= SOLAR_FLARE_MIN_REFIRE_TICKS
    && world.currentTick % SOLAR_FLARE_CHECK_INTERVAL === 0
    && world.rng() < SOLAR_FLARE_CHANCE
  ) {
    world._solarFlareActive = true;
    world._solarFlareTicksRemaining = SOLAR_FLARE_DURATION_MIN
      + Math.floor(world.rng() * (SOLAR_FLARE_DURATION_MAX - SOLAR_FLARE_DURATION_MIN));
    const text = 'A solar flare knocks out the grid -- no electrical device will draw power until it passes';
    world.milestoneLog.push({ tick: world.currentTick, text });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    world.onRandomEvent?.(text);
  }

  world.solarFlareActive = !!world._solarFlareActive;
  setSolarFlareActive(world._solarFlareActive);
}

// ---------------------------------------------------------------- rolling blackout (grid-overload calamity)
// Real Prison Architect calamity_settings.txt: RollingBlackoutLow/Medium/High -- gated (per the
// real data) on BOTH LightningStorm severity AND a real GeneratorLoad threshold, causing 60-360s
// outages. This port keeps the real GeneratorLoad half of that gate (power.js's new
// gridLoadFraction -- see that function's own comment for exactly how "total demand vs supply" is
// computed) and deliberately drops the LightningStorm-severity half: this hazard reads as a
// standalone, player-caused consequence of overbuilding a power-hungry grid on too little
// generation, not a second effect bolted onto the unrelated ThunderstormDry/Rainy weather states
// tickLightningStorm above already owns. ANDing two independent real triggers together would make
// an already rare, already punishing mechanic even rarer and muddier to read as "why did this
// happen" -- the opposite of the task brief's "keep this hazard real but bounded, and make it
// visible" instruction, and the same kind of invisible-compounding shape SESSION_HANDOFF.md's own
// balance-regression history warns against (see that file's "balance regression" sections) --
// picking ONE clear, legible cause (grid load) for ONE clear, legible consequence is the safer
// call here.
//
// Structurally this is exactly tickSolarFlareCondition's close cousin, per this task's brief: own
// timer fields (_rollingBlackout*), its own earliest-tick grace, its own min-refire cooldown, its
// own duration range, and the exact same milestone-announcement call shape (world.milestoneLog
// push + 20-entry trim + world.onRandomEvent?.()). The one real structural difference from
// SolarFlare is the extra ANDed precondition below (grid load must actually be high) --
// SolarFlare has no equivalent precondition, it's pure bad luck on a timer; this one additionally
// requires the player to have actually built (and overloaded) a real grid.
//
// GRID_LOAD_HIGH_THRESHOLD=0.75 is FaultyWiringDueToHighLoad's own real "75%+ grid load" number
// (see task brief and tickFaultyWiring below) -- shared here rather than inventing a second "what
// counts as high load" definition, since both calamities are real PA siblings gated on the exact
// same GeneratorLoad concept in the same source file.
export const GRID_LOAD_HIGH_THRESHOLD = 0.75; // real PA FaultyWiringDueToHighLoad threshold, shared by both hazards below

const ROLLING_BLACKOUT_EARLIEST_TICK = SOLAR_FLARE_EARLIEST_TICK; // same modest "let the player
                                                                    // get a real grid up first"
                                                                    // grace as SolarFlare
const ROLLING_BLACKOUT_MIN_REFIRE_TICKS = SOLAR_FLARE_MIN_REFIRE_TICKS; // same cadence as
                                                                          // SolarFlare -- unlike
                                                                          // SolarFlare though, this
                                                                          // one is fully avoidable
                                                                          // (stop overloading the
                                                                          // grid), so a short
                                                                          // cooldown is the correct
                                                                          // incentive to fix the
                                                                          // load problem, not
                                                                          // something to soften
                                                                          // further
const ROLLING_BLACKOUT_CHECK_INTERVAL = SOLAR_FLARE_CHECK_INTERVAL; // same roll cadence as SolarFlare
const ROLLING_BLACKOUT_CHANCE = 0.08; // per check, once BOTH the grace/cooldown AND the real
                                       // grid-load gate are satisfied -- higher than SolarFlare's
                                       // 0.02 since the precondition itself (sustained 75%+ load)
                                       // is already the rare, player-caused part; once it's true
                                       // the consequence should read as a real near-term risk, not
                                       // a coin flip that can sit unresolved for thousands of ticks
                                       // while the player ignores an overloaded grid
// Real PA duration is given directly in seconds (60-360s), not minutes -- no ambiguous
// minutes-to-ticks conversion needed here (contrast Deep Freeze's own header comment above on why
// that conversion is dangerous when the source data isn't already tick/second-denominated). At
// this project's established 10Hz: 60s*10=600, 360s*10=3600.
const ROLLING_BLACKOUT_DURATION_MIN = 600;  // 60s at 10Hz -- real PA min outage
const ROLLING_BLACKOUT_DURATION_MAX = 3600; // 360s at 10Hz -- real PA max outage

/** Call once from SimWorld's constructor (or lazily from tickRollingBlackoutCondition on first
 *  tick), same pattern as initSolarFlare above. world.rollingBlackoutActive mirrors
 *  world.solarFlareActive's public-flag shape, for any future UI banner. */
export function initRollingBlackout(world) {
  world._rollingBlackoutActive = false;
  world._rollingBlackoutTicksRemaining = 0;
  world._rollingBlackoutLastEndTick = -Infinity;
  world.rollingBlackoutActive = false;
}

/** True while the rolling-blackout grid outage is active. */
export function isRollingBlackoutActive(world) {
  return !!world._rollingBlackoutActive;
}

/** Advances an active blackout's duration and ends it once expired (recording the end tick for
 *  the next refire-gap check), or -- while inactive -- rolls a new one once the earliest-tick
 *  grace, the refire cooldown, AND the real grid-load threshold are all satisfied. Exact same
 *  shape as tickSolarFlareCondition above with one extra ANDed precondition (the gridLoadFraction
 *  check). Mirrors this tick's result onto world.rollingBlackoutActive and power.js's
 *  module-level flag (setRollingBlackoutActive) every call, regardless of which branch ran, same
 *  reasoning as SolarFlare's own mirror step. Called from tickHazardCondition above, alongside
 *  tickSolarFlareCondition -- see that call site's own comment for why. */
export function tickRollingBlackoutCondition(world) {
  if (world._rollingBlackoutActive == null) initRollingBlackout(world);

  if (world._rollingBlackoutActive) {
    world._rollingBlackoutTicksRemaining--;
    if (world._rollingBlackoutTicksRemaining <= 0) {
      world._rollingBlackoutActive = false;
      world._rollingBlackoutLastEndTick = world.currentTick;
      const text = 'The rolling blackout ends -- power returns to the grid';
      world.milestoneLog.push({ tick: world.currentTick, text });
      if (world.milestoneLog.length > 20) world.milestoneLog.shift();
      world.onRandomEvent?.(text);
    }
  } else if (
    world.currentTick >= ROLLING_BLACKOUT_EARLIEST_TICK
    && world.currentTick - world._rollingBlackoutLastEndTick >= ROLLING_BLACKOUT_MIN_REFIRE_TICKS
    && world.currentTick % ROLLING_BLACKOUT_CHECK_INTERVAL === 0
    && gridLoadFraction(world.structures) >= GRID_LOAD_HIGH_THRESHOLD
    && world.rng() < ROLLING_BLACKOUT_CHANCE
  ) {
    world._rollingBlackoutActive = true;
    world._rollingBlackoutTicksRemaining = ROLLING_BLACKOUT_DURATION_MIN
      + Math.floor(world.rng() * (ROLLING_BLACKOUT_DURATION_MAX - ROLLING_BLACKOUT_DURATION_MIN));
    const text = 'The overloaded grid trips a rolling blackout -- no electrical device will draw power until it clears';
    world.milestoneLog.push({ tick: world.currentTick, text });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    world.onRandomEvent?.(text);
  }

  world.rollingBlackoutActive = !!world._rollingBlackoutActive;
  setRollingBlackoutActive(world._rollingBlackoutActive);
}

// ---------------------------------------------------------------- faulty wiring (grid-overload fire)
// Real Prison Architect calamity_settings.txt FaultyWiringDueToHighLoad -- a real chance of an
// electrical fire while grid load is sustained at GRID_LOAD_HIGH_THRESHOLD(0.75)+ (the same real
// threshold Rolling Blackout above gates on -- see that constant's own comment). Structurally this
// is tickHeatwaveElectricalFire's own close cousin (see that function's header comment further up
// this file), not SolarFlare's timer shape: same target set via isPowerStructureKind, same
// igniteStructure/fire.js reuse ("fire.js's own already-running tickFire picks up the ongoing
// per-tick burn-down automatically", exactly as that comment already explains), same concurrent-
// fire cap, same check-interval-instead-of-literal-every-tick calibration -- an ongoing per-tick
// RISK while a condition holds, not a sustained on/off state of its own.
//
// CALIBRATION NOTE: the real PA number (~3% per-tick chance) is PA's own tick rate, not this
// project's established 10Hz -- applying it to every single 10Hz tick literally would mean a
// colony sitting at 75%+ load has roughly a 1-(0.97)^10 =~ 26% chance of an electrical fire in the
// very first second it crosses the threshold, and a near-certainty within a few seconds. That's
// the same category of mistake the Deep Freeze header comment above warns about (a literal
// conversion producing a wildly-too-punishing result at this codebase's own tick rate) -- so, like
// tickHeatwaveElectricalFire's own ELECTRICAL_FIRE_CHECK_INTERVAL(100)/ELECTRICAL_FIRE_CHANCE(0.05)
// calibration right above it in this same file, the real 3% figure is applied per-CHECK (every 100
// ticks, ~10s, this file's own already-established cadence for this exact category of mechanic)
// rather than per raw tick -- the literal real number, just read against a check interval that has
// an actual equivalent meaning at this simulation rate.
const FAULTY_WIRING_CHECK_INTERVAL = ELECTRICAL_FIRE_CHECK_INTERVAL; // same 100-tick (~10s) cadence
                                                                       // as Heatwave's own electrical fire
const FAULTY_WIRING_CHANCE = 0.03; // real PA ~3% figure, applied per check -- see calibration note above

/** Rolls a real per-check chance of igniting one electrical structure while grid load is
 *  sustained at GRID_LOAD_HIGH_THRESHOLD+ (power.js's gridLoadFraction), capped at
 *  ELECTRICAL_FIRE_MAX_CONCURRENT simultaneous power-structure fires from ANY source -- shares
 *  that exact cap (and target pool) with tickHeatwaveElectricalFire above rather than a separate
 *  FaultyWiring-only ceiling, so the two real, independent PA calamities that both ignite the same
 *  isPowerStructureKind pool can't stack past one sane total ceiling between them (a rare,
 *  contained threat, not a cascade -- same reasoning as that constant's own doc comment). Call
 *  once per tick from tickHazardCondition above, alongside tickRollingBlackoutCondition -- see
 *  that call site's own comment for why. */
export function tickFaultyWiring(world) {
  if (world.currentTick % FAULTY_WIRING_CHECK_INTERVAL !== 0) return;
  if (gridLoadFraction(world.structures) < GRID_LOAD_HIGH_THRESHOLD) return;

  const burning = world.structures.filter(s => isPowerStructureKind(s.kind) && s.onFire && !s.destroyed);
  if (burning.length >= ELECTRICAL_FIRE_MAX_CONCURRENT) return;
  if (world.rng() >= FAULTY_WIRING_CHANCE) return;

  const candidates = world.structures.filter(s =>
    isPowerStructureKind(s.kind) && !s.destroyed && !s.underConstruction && !s.onFire);
  if (candidates.length === 0) return;

  const target = candidates[Math.floor(world.rng() * candidates.length)];
  igniteStructure(target);
  const label = target.kind.replace(/_/g, ' ');
  const text = `Faulty wiring from the overloaded grid sparks a fire in a ${label}`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
}
