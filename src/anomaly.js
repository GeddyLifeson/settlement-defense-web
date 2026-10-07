// Anomaly pressure: a colony-wide 0->1 float representing an unexplained, escalating instability
// building up around the settlement -- NOT framed as horror/monster content (explicit project
// non-goal, see SESSION_HANDOFF.md), just an emergent hazard the player has to manage, same as
// pollution/unrest already are. Directly follows round 9's Anomaly-DLC research recommendation
// (see SESSION_HANDOFF.md's ROUND 9 section): "an 'anomalous activity' meter exactly shaped like
// rats.js's existing pattern (periodic roll, tiered thresholds, one-off burst event)" -- explicitly
// NOT the fleshbeast entity roster (that's flagged there as a much bigger surface, a possible
// future "5th AttackerKind" if ever greenlit, not this pass). This file is deliberately as
// lightweight as rats.js: no new entity/pathing AI, no siege.js hookup, just a meter + periodic
// small-percentage-chance rolls with bounded consequences scaled by tier.
//
// Real-number anchor (real RimWorld Anomaly DLC): the Nociosphere's Activity meter climbs ~5% of
// its range per in-game day when conditions allow. Reused verbatim here as the growth *rate*
// (0.05/day), rescaled from RimWorld's day length to this project's own DAY_NIGHT_CYCLE_TICKS
// (schedule.js) rather than copying RimWorld's tick rate.
import { DAY_NIGHT_CYCLE_TICKS } from './schedule.js';
import { colonyStrength } from './director.js';
import { addMoodEvent } from './citizens.js';

export const AnomalyTier = Object.freeze({ Low: 'Low', Medium: 'Medium', High: 'High' });

// Tier thresholds on the 0..1 scale, deliberately proportioned the same way rats.js's real-PA
// 10/50-out-of-100 tier split is (Medium at 10%, High at 50%) -- same shape, different meter.
const ANOMALY_TIER_MEDIUM = 0.10;
const ANOMALY_TIER_HIGH = 0.50;

export function anomalyTier(level) {
  if (level >= ANOMALY_TIER_HIGH) return AnomalyTier.High;
  if (level >= ANOMALY_TIER_MEDIUM) return AnomalyTier.Medium;
  return AnomalyTier.Low;
}

// ---------------------------------------------------------------- growth/decay
const ANOMALY_GROWTH_PER_DAY = 0.05; // real RimWorld Nociosphere Activity rate, see header comment
const ANOMALY_GROWTH_PER_TICK = ANOMALY_GROWTH_PER_DAY / DAY_NIGHT_CYCLE_TICKS;
// Pressure only grows once the colony has "enough going on" to attract it -- reuses
// director.js's colonyStrength() directly (the same hazard-scaling signal that already drives
// wave difficulty) as the gate, rather than a second parallel strength metric. Gate value chosen
// well below the strengthTerm/120 normalization director.js uses internally, so a colony crosses
// this gate early (a handful of built structures + starting population), not only once heavily
// fortified -- this is meant to be a genuine ambient pressure, not an end-game-only mechanic.
const ANOMALY_STRENGTH_GATE = 40;
// Pollution boosts growth on top of the gate, using the exact same clamp/divisor shape as
// director.js's own pollutionTerm (`1 + Math.min(1.2, pollution / 200)`) -- reused for
// consistency, not reinvented, per the task's "reuse director.js's hazard-scaling pattern" brief.
const ANOMALY_POLLUTION_DIVISOR = 200;
const ANOMALY_POLLUTION_CAP = 1.2;
// Below the strength gate, pressure recedes -- same "grows under bad conditions, recedes under
// good ones" trend shape rats.js's own infestation level already uses. Decay is slower than
// growth (this is ambient background instability, not something that should vanish the instant a
// colony has a rough tick), but a Stabilizer Beacon (see below) adds real additional decay on
// top of this baseline.
const ANOMALY_DECAY_PER_TICK = ANOMALY_GROWTH_PER_TICK * 1.5;
// Stabilizer Beacon (this pass's new cheap buildable, see economy.js/input.js): the "real
// in-game response" the task asked for. Each undestroyed, fully-built beacon adds this much extra
// decay per tick, stacking up to STABILIZER_MAX_STACKS so building a second one genuinely helps
// but the player can't trivially zero the meter with a wall of them.
export const STABILIZER_DECAY_PER_TICK = ANOMALY_GROWTH_PER_TICK * 3;
export const STABILIZER_MAX_STACKS = 3;

/** Call once from SimWorld's constructor to seed initial state. */
export function initAnomaly(world) {
  world.anomalyPressure = 0;
  world._lastAnomalyTier = AnomalyTier.Low;
  world._anomalyBurstUntil = 0; // >0 while a High-tier burst incident's short flavor window is live
  world._anomalyBurstStructureId = null; // index into world.structures the current/last burst hit, for render pulsing
}

function countActiveStabilizers(structures) {
  let n = 0;
  for (const s of structures) {
    if (s.kind === 'stabilizer' && !s.destroyed && !s.underConstruction) n++;
    if (n >= STABILIZER_MAX_STACKS) break;
  }
  return n;
}

/** Meter growth/decay + tier-crossing milestone log. Call once per tick from SimWorld.tick(). */
export function tickAnomalyPressure(world) {
  if (world.anomalyPressure == null) initAnomaly(world);

  const strength = colonyStrength(world);
  const gated = strength >= ANOMALY_STRENGTH_GATE;
  const stabilizers = countActiveStabilizers(world.structures);

  if (gated) {
    const pollutionBoost = 1 + Math.min(ANOMALY_POLLUTION_CAP, (world.pollution || 0) / ANOMALY_POLLUTION_DIVISOR);
    const growth = ANOMALY_GROWTH_PER_TICK * pollutionBoost;
    const decay = stabilizers * STABILIZER_DECAY_PER_TICK; // beacons still help even while gated-in
    world.anomalyPressure = Math.max(0, Math.min(1, world.anomalyPressure + growth - decay));
  } else {
    const decay = ANOMALY_DECAY_PER_TICK + stabilizers * STABILIZER_DECAY_PER_TICK;
    world.anomalyPressure = Math.max(0, world.anomalyPressure - decay);
  }

  const tier = anomalyTier(world.anomalyPressure);
  if (tier !== world._lastAnomalyTier) {
    world._lastAnomalyTier = tier;
    const text = tier === AnomalyTier.Low
      ? 'The anomaly pressure around the settlement has settled'
      : `Anomaly pressure has reached ${tier} levels`;
    world.milestoneLog.push({ tick: world.currentTick, text });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    world.onRandomEvent?.(text);
  }

  if (world._anomalyBurstUntil > 0 && world.currentTick >= world._anomalyBurstUntil) {
    world._anomalyBurstUntil = 0;
    world._anomalyBurstStructureId = null;
    const text = 'The instability burst has passed';
    world.milestoneLog.push({ tick: world.currentTick, text });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    world.onRandomEvent?.(text);
  }
}

// ---------------------------------------------------------------- periodic tier-scaled rolls
const ANOMALY_CHECK_INTERVAL = 40; // ~4s at 10Hz, same cadence family as rats.js's RAT_CHECK_INTERVAL

// Low tier: purely cosmetic -- feeds rooms.js's existing mess/cleanliness axis, same hookup
// rats.js's own droppings use, no new tracked resource.
const LOW_MESS_CHANCE = 0.05;
const LOW_MESS_AMOUNT = 0.03;

// Medium tier: a small real economic or mood cost, picked randomly between the two each time it
// fires so neither one alone defines the tier.
const MEDIUM_EVENT_CHANCE = 0.05;
const MEDIUM_SCRAP_DRAIN_MIN = 2, MEDIUM_SCRAP_DRAIN_MAX = 8;
const MEDIUM_MOOD_MAGNITUDE = -0.04;
const MEDIUM_MOOD_DURATION_TICKS = 1200;

// High tier: a short, bounded burst incident -- fixed chance, fixed short duration, a one-off
// scrap/structure-damage penalty, done. No new entity spawns, no continuing per-tick drain beyond
// the flavor window itself (the window is just how long the milestone/render pulse stays visible,
// the actual penalty is applied once at trigger).
const HIGH_BURST_CHANCE = 0.06;
const HIGH_BURST_DURATION_TICKS = 150; // ~15s at 10Hz -- "short duration" per the task brief
const HIGH_BURST_SCRAP_MIN = 8, HIGH_BURST_SCRAP_MAX = 25;
const HIGH_BURST_STRUCTURE_DAMAGE_FRAC = 0.35; // fraction of the target's CURRENT health
// After a burst resolves, some of the built-up pressure vents off with it -- a real, if passive,
// release valve distinct from the Stabilizer Beacon's active decay.
const HIGH_BURST_VENT_AMOUNT = 0.12;

function pickRandomLiveStructure(structures, rng) {
  const live = structures.filter(s => !s.destroyed && !s.underConstruction && s.kind !== 'wire' && s.kind !== 'pipe');
  if (live.length === 0) return null;
  return live[Math.floor(rng() * live.length)];
}

/** Per-tier periodic small-percentage-chance consequence rolls, throttled to ANOMALY_CHECK_INTERVAL
 *  (never every tick -- same cadence discipline rats.js/weather.js already use). Call once per
 *  tick from SimWorld.tick(), after tickAnomalyPressure so it reads this tick's freshly-updated
 *  tier. */
export function tickAnomalyEvents(world) {
  if (world.anomalyPressure == null) initAnomaly(world);
  if (world.currentTick % ANOMALY_CHECK_INTERVAL !== 0) return;

  const tier = anomalyTier(world.anomalyPressure);

  if (tier === AnomalyTier.Low) {
    if (world.rng() >= LOW_MESS_CHANCE) return;
    if (!world.rooms || world.rooms.length === 0) return;
    const room = world.rooms[Math.floor(world.rng() * world.rooms.length)];
    room.mess = Math.min(1, (room.mess || 0) + LOW_MESS_AMOUNT);
    return;
  }

  if (tier === AnomalyTier.Medium) {
    if (world.rng() >= MEDIUM_EVENT_CHANCE) return;
    if (world.rng() < 0.5 && world.scrap > 0) {
      const amount = MEDIUM_SCRAP_DRAIN_MIN + Math.floor(world.rng() * (MEDIUM_SCRAP_DRAIN_MAX - MEDIUM_SCRAP_DRAIN_MIN + 1));
      world.scrap = Math.max(0, world.scrap - amount);
      const text = 'An unexplained fault drains some banked scrap';
      world.milestoneLog.push({ tick: world.currentTick, text });
      if (world.milestoneLog.length > 20) world.milestoneLog.shift();
      world.onRandomEvent?.(text);
    } else {
      const alive = [];
      for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) alive.push(i);
      if (alive.length === 0) return;
      const i = alive[Math.floor(world.rng() * alive.length)];
      addMoodEvent(world.citizens, i, world.currentTick, {
        magnitude: MEDIUM_MOOD_MAGNITUDE, durationTicks: MEDIUM_MOOD_DURATION_TICKS, stackKey: 'anomalyUnease',
      });
    }
    return;
  }

  // High tier: only roll a fresh burst if one isn't already in its flavor window.
  if (world._anomalyBurstUntil > world.currentTick) return;
  if (world.rng() >= HIGH_BURST_CHANCE) return;

  const target = pickRandomLiveStructure(world.structures, world.rng);
  const scrapHit = HIGH_BURST_SCRAP_MIN + Math.floor(world.rng() * (HIGH_BURST_SCRAP_MAX - HIGH_BURST_SCRAP_MIN + 1));
  world.scrap = Math.max(0, world.scrap - scrapHit);
  let structureText = '';
  if (target) {
    target.health -= target.health * HIGH_BURST_STRUCTURE_DAMAGE_FRAC;
    if (target.health <= 0) { target.health = 0; target.destroyed = true; }
    structureText = ` and damages a ${target.kind.replace(/_/g, ' ')}`;
  }
  world._anomalyBurstUntil = world.currentTick + HIGH_BURST_DURATION_TICKS;
  world._anomalyBurstStructureId = world.structures.indexOf(target);
  world.anomalyPressure = Math.max(0, world.anomalyPressure - HIGH_BURST_VENT_AMOUNT);

  const text = `Instability bursts, draining ${scrapHit} scrap${structureText}`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
}
