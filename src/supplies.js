// Tainted supply delivery -- ported from Prison Architect's real contraband.lua (see
// SESSION_HANDOFF.md's round-9 campaign-Lua notes and FEATURE_RESEARCH.md). The real script:
// a periodic supply delivery has a chance of hiding contraband; if unexamined it silently
// spreads a dependency/status-effect among the people who use the goods, discovered via a
// "dispose of the bad batch" objective, followed by a find-the-rest search objective with an
// intentionally PARTIAL target count (the real script only requires finding 3 of 6 spawned,
// acknowledging some get consumed before the player can act). Reskinned explicitly non-carceral
// per the task brief -- this is a bad/tainted supply shipment, not smuggled contraband in a
// carceral sense: no inmates, no contraband-as-crime framing, just a logistics/health hazard the
// player has to catch in time.
//
// Shape deliberately mirrors two existing systems rather than inventing new ones:
//  - The periodic-roll delivery/detection-window/investigate loop follows weather.js's one-off
//    random-event pattern (tryTraderEvent/tryBlightEvent -- a timer, a milestoneLog post, an
//    onRandomEvent callback) and world.js's buyVest-style player action convention (spend/flip
//    state, return { ok, reason }).
//  - The per-citizen dependency debuff (onset severity that decays back to 0 on its own, refreshed
//    stacking mood hit via addMoodEvent, a modest work-speed multiplier) is sickness.js's exact
//    "not lethal, self-resolving over time" shape, just triggered by a delivery-consumption event
//    instead of an independent per-citizen roll. NOT a full addiction economy -- one severity
//    float per citizen, one mood-event stack key, one rate multiplier, same footprint as sickness.
import { addMoodEvent } from './citizens.js';

// ---------------------------------------------------------------- delivery timing / taint odds
export const SUPPLY_DELIVERY_INTERVAL_TICKS = 1200; // ~2 min at 10Hz between deliveries
const SUPPLY_DELIVERY_INTERVAL_JITTER_TICKS = 400;  // spread so deliveries don't land on a fixed metronome
export const TAINT_CHANCE = 0.3; // real PA-style "small chance" -- most deliveries are just fine

// Window the player has to notice and dispose of a tainted delivery before anyone's used it --
// past this, it's "spreading" and the only remaining objective is the partial search-and-recover.
export const DETECTION_WINDOW_TICKS = 400; // ~40s at 10Hz

// Real PA ratio: 6 units spawn, only 3 are ever recoverable once missed (the rest already used).
export const SUPPLY_UNITS_TOTAL = 6;
export const SEARCH_RECOVER_COUNT = 3;

// Renamed with a file-scoped prefix -- collided with fire.js's own top-level SPREAD_CHECK_INTERVAL
// (build.py's flat-concatenation bundling puts every top-level const in one shared global scope,
// see SESSION_HANDOFF.md's "systemic bug class" note), same underscore/prefix-rename convention
// already used to resolve this exact bug shape elsewhere in this codebase (e.g. anomaly.js's
// ANOMALY_TIER_MEDIUM/_HIGH).
const SUPPLIES_SPREAD_CHECK_INTERVAL = 50; // ~5s cadence for consumption rolls once spreading, same order as rats.js's RAT_SPAWN_CHECK_INTERVAL
const SPREAD_CONSUME_CHANCE = 0.4; // per check, while spreading and units remain

// ---------------------------------------------------------------- per-citizen dependency debuff
export const DEPENDENCY_ONSET_SEVERITY = 0.5;
// Decays to 0 on its own over ~2000 ticks (~200s at 10Hz) -- "temporary", matching sickness.js's
// "never lethal, self-limiting" framing, just a longer wind-down than a flu case since this is
// meant to read as a real (if modest) consequence of a missed detection window.
const DEPENDENCY_RECOVER_PER_TICK = DEPENDENCY_ONSET_SEVERITY / 2000;
const DEPENDENCY_MOOD_MAGNITUDE = -0.1;
const DEPENDENCY_MOOD_DURATION_TICKS = 600; // refreshed every DEPENDENCY_CHECK_INTERVAL below so it never lapses mid-dependency
const DEPENDENCY_CHECK_INTERVAL = 300; // ~30s mood-refresh cadence, staggered per citizen (store._taintOffset)
// jobs.js multiplies this into the same rate chain sickRateMultFor already feeds (needsThrottleMultFor
// * ... * sickRateMultFor * dependencyRateMultFor) -- a real, modest work-speed penalty, not a hard stop.
export const DEPENDENCY_WORK_SPEED_MULT = 0.8;

function pushSupplyMilestone(world, text) {
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
}

/** Call once from SimWorld's constructor to seed initial state. */
export function initSupplies(world) {
  world.supplyDelivery = null;
  world._nextDeliveryTick = SUPPLY_DELIVERY_INTERVAL_TICKS + Math.floor((world.rng ?? Math.random)() * SUPPLY_DELIVERY_INTERVAL_JITTER_TICKS);
}

function spawnDelivery(world) {
  const tainted = world.rng() < TAINT_CHANCE;
  world.supplyDelivery = {
    tick: world.currentTick, tainted,
    disposed: false, spreading: false, searched: false,
    resolved: !tainted, // an untainted delivery needs no player action
    unitsTotal: SUPPLY_UNITS_TOTAL, unitsConsumed: 0, unitsRecovered: 0,
  };
  // Deliberately the SAME message whether or not it's tainted -- the whole point is the player
  // can't tell from the log, only by actually inspecting it (or letting it go and finding out the
  // hard way), matching the real PA script's "looks like an ordinary delivery" framing.
  pushSupplyMilestone(world, 'A supply delivery arrives');
}

function onsetDependency(world, i) {
  const store = world.citizens;
  store.dependencySeverity[i] = DEPENDENCY_ONSET_SEVERITY;
  addMoodEvent(store, i, world.currentTick, {
    magnitude: DEPENDENCY_MOOD_MAGNITUDE, durationTicks: DEPENDENCY_MOOD_DURATION_TICKS, stackKey: 'supplyDependency',
  });
  pushSupplyMilestone(world, `${store.name[i]} has developed a dependency on tainted supplies`);
}

/** Delivery timer + state-machine advance (detection-window expiry -> spreading -> per-check
 *  consumption rolls that actually onset the dependency debuff on a citizen). Call once per tick
 *  from SimWorld.tick(). Player actions (inspectDelivery/searchDelivery below) are the only other
 *  way this state changes. */
export function tickSupplyDelivery(world) {
  if (world._nextDeliveryTick == null) initSupplies(world);

  const d = world.supplyDelivery;
  if (d && d.tainted && !d.resolved) {
    const elapsed = world.currentTick - d.tick;
    if (!d.disposed && !d.spreading && elapsed > DETECTION_WINDOW_TICKS) {
      d.spreading = true;
      pushSupplyMilestone(world, 'The recent supply delivery was never inspected -- something in it seems to be making people unwell');
    }
    if (d.spreading && !d.searched && d.unitsConsumed < d.unitsTotal
        && world.currentTick % SUPPLIES_SPREAD_CHECK_INTERVAL === 0 && world.rng() < SPREAD_CONSUME_CHANCE) {
      const store = world.citizens;
      const candidates = [];
      for (let i = 0; i < store.count; i++) {
        if (!store.isAliveAt(i) || store.isDownedAt(i)) continue;
        if (store.isDependentAt(i)) continue; // already affected -- the next unit finds someone new
        candidates.push(i);
      }
      if (candidates.length > 0) {
        const i = candidates[Math.floor(world.rng() * candidates.length)];
        onsetDependency(world, i);
        d.unitsConsumed++;
        if (d.unitsConsumed >= d.unitsTotal) {
          pushSupplyMilestone(world, 'The tainted batch has been fully used up');
        }
      }
    }
  }

  // Only roll a new delivery once the previous one (if any) is fully resolved -- keeps exactly one
  // investigation live at a time, same "don't overlap/clobber state" reasoning as weather.js's
  // trader voucher re-roll (replace, don't stack).
  if ((!d || d.resolved) && world.currentTick >= world._nextDeliveryTick) {
    spawnDelivery(world);
    world._nextDeliveryTick = world.currentTick + SUPPLY_DELIVERY_INTERVAL_TICKS
      + Math.floor(world.rng() * SUPPLY_DELIVERY_INTERVAL_JITTER_TICKS);
  }
}

/** Per-citizen dependency decay + refreshed mood hit for anyone currently affected. Call once per
 *  tick from SimWorld.tick(), alongside tickSickness -- same "cheap periodic per-citizen pass"
 *  grouping. Onset itself happens in tickSupplyDelivery above, not here (this only progresses
 *  citizens who are already dependent). */
export function tickDependency(world) {
  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.dependencySeverity[i] <= 0) continue;
    store.dependencySeverity[i] = Math.max(0, store.dependencySeverity[i] - DEPENDENCY_RECOVER_PER_TICK);
    if (store.dependencySeverity[i] <= 0) continue; // resolved this tick -- no refresh needed
    const onStagger = (world.currentTick + (store._taintOffset[i] || 0)) % DEPENDENCY_CHECK_INTERVAL === 0;
    if (onStagger) {
      addMoodEvent(store, i, world.currentTick, {
        magnitude: DEPENDENCY_MOOD_MAGNITUDE, durationTicks: DEPENDENCY_MOOD_DURATION_TICKS, stackKey: 'supplyDependency',
      });
    }
  }
}

/** Per-citizen work-speed multiplier while dependent -- jobs.js multiplies this into the same rate
 *  chain sickRateMultFor already feeds. Returns 1 (no penalty) if not currently dependent. */
export function dependencyRateMultFor(store, i) {
  return store.isDependentAt(i) ? DEPENDENCY_WORK_SPEED_MULT : 1;
}

/** True while a tainted delivery is sitting undiscovered inside its detection window -- the
 *  window main.js's UI banner uses to show the "Inspect / Dispose" action. */
export function canInspectDelivery(world) {
  const d = world.supplyDelivery;
  return !!d && d.tainted && !d.resolved && !d.disposed && !d.spreading;
}

/** True once a tainted delivery has started spreading undetected -- the window main.js's UI
 *  banner uses to show the "Search & Recover" action. */
export function canSearchDelivery(world) {
  const d = world.supplyDelivery;
  return !!d && d.tainted && d.spreading && !d.searched;
}

// ---------------------------------------------------------------- player actions
// Both follow world.js's buyVest convention: real state change (or a real refusal reason), return
// { ok, reason } (plus a little extra detail callers can use for UI feedback).

/** "Dispose of the bad batch" objective -- only works inside the detection window, before it's
 *  had a chance to spread. Always safe to call on an untainted delivery too (just clears it, no
 *  consequence either way -- inspecting a clean delivery is a normal, harmless action). */
export function inspectDelivery(world) {
  const d = world.supplyDelivery;
  if (!d || d.resolved) return { ok: false, reason: 'none' };
  if (!d.tainted) {
    d.resolved = true;
    pushSupplyMilestone(world, 'The delivery checks out clean');
    return { ok: true, tainted: false };
  }
  if (d.spreading) return { ok: false, reason: 'too_late' };
  d.disposed = true;
  d.resolved = true;
  pushSupplyMilestone(world, 'The bad batch is found and disposed of before anyone could get hurt');
  return { ok: true, tainted: true, disposed: true };
}

/** "Search and recover" follow-up objective -- only available once a tainted delivery has gone
 *  undetected long enough to start spreading. Recovers a REAL PARTIAL amount (real PA ratio: 3 of
 *  6 spawned units, or whatever's left if consumption already ate into that) rather than 100% --
 *  citizens who already consumed a unit before this ran keep their dependency debuff, which only
 *  resolves via tickDependency's own natural decay, not this action. */
export function searchDelivery(world) {
  const d = world.supplyDelivery;
  if (!d || !d.tainted) return { ok: false, reason: 'none' };
  if (!d.spreading) return { ok: false, reason: 'not_spreading' };
  if (d.searched) return { ok: false, reason: 'already' };
  const remaining = d.unitsTotal - d.unitsConsumed;
  const recovered = Math.min(SEARCH_RECOVER_COUNT, remaining);
  d.unitsRecovered = recovered;
  d.unitsConsumed = d.unitsTotal; // whatever's left is pulled from circulation -- recovered or already used, either way no more onset rolls
  d.searched = true;
  d.resolved = true;
  pushSupplyMilestone(world, `Search recovers ${recovered} of ${d.unitsTotal} tainted units -- the rest had already been used`);
  return { ok: true, recovered, total: d.unitsTotal };
}

/** Debug/testing hook (window.__debug): forces a tainted delivery to arrive right now, bypassing
 *  the timer and the TAINT_CHANCE roll. Mirrors the "force it and verify" pattern used elsewhere
 *  in this project (e.g. STORYTELLERS.Cassandra.doubleChance mutated live from the console). */
export function forceTaintedDelivery(world) {
  if (world._nextDeliveryTick == null) initSupplies(world);
  world.supplyDelivery = {
    tick: world.currentTick, tainted: true,
    disposed: false, spreading: false, searched: false, resolved: false,
    unitsTotal: SUPPLY_UNITS_TOTAL, unitsConsumed: 0, unitsRecovered: 0,
  };
  pushSupplyMilestone(world, 'A supply delivery arrives');
  return world.supplyDelivery;
}
