// Rat/vermin infestation, ported from Prison Architect's real rat system (ratsystem.txt). This
// REVERSES a prior scoping decision: FEATURE_RESEARCH.md / weather.js's header comment previously
// scoped infestation OUT as "a much bigger surface" needing "a new attacker-adjacent entity type
// wired through siege.js/render.js". On actually reading PA's real numbers instead of guessing at
// the shape from the wiki-level pass, that assessment was wrong: infestation is a lightweight
// threshold-driven system of flat percentage-chance rolls (steal/chew/dropping) on a small pool of
// wandering entities, MUCH closer to weather.js's own periodic-roll events than to a combat
// AI -- and explicitly NOT wired through siege.js's attacker/combat system at all (rats aren't
// hostile in that sense, they're a nuisance/economy drain). This file is deliberately simpler than
// vehicles.js's garage->driver->haul state machine: rats have no jobs.js hookup, no claim/board
// pattern, just a light cosmetic wander plus independent periodic-roll actions.
//
// Real numbers (ratsystem.txt): infestation 0-100, gated on population >= 20, Medium tier at 10,
// High tier at 50, MaxRats 75, steal-food 40% chance (3-15 units per steal), chew-wire 5% chance
// capped at 5/day, chew-fence 5% chance capped at 5/day, droppings 5/20/40% by tier, Rat Trap 65%
// catch chance / 12-tick escape window. This project's colony defaults to 24 starting citizens
// (world.js's STARTER_NAMES/constructor) -- an order of magnitude below the hundred-plus-prisoner
// colonies PA's own population gate and MaxRats were tuned against -- so the population threshold
// and the concurrent-rat cap are scaled down proportionally (16 and 8 respectively, see the
// constants below). Every percentage-roll number (steal/chew/catch chances, tier thresholds,
// escape-window length) is used verbatim: those are already scale-independent probabilities, not
// raw headcounts, so there's nothing to scale about them.
import { roomContaining } from './rooms.js';
import { DAY_NIGHT_CYCLE_TICKS } from './schedule.js';

export const RAT_POPULATION_THRESHOLD = 16; // scaled down from PA's real 20, see header comment
export const RAT_MAX_CONCURRENT = 8;        // scaled down from PA's real MaxRats 75

export const RatTier = Object.freeze({ Low: 'Low', Medium: 'Medium', High: 'High' });
const TIER_MEDIUM = 10; // real PA threshold, 0-100 scale
const TIER_HIGH = 50;   // real PA threshold, 0-100 scale

export function ratTier(level) {
  if (level >= TIER_HIGH) return RatTier.High;
  if (level >= TIER_MEDIUM) return RatTier.Medium;
  return RatTier.Low;
}

// Infestation grows slowly while the population gate holds, faster the more rats are already
// around (breeding pressure), and recedes once population drops back under the threshold (a small
// colony just doesn't have enough mess/scraps lying around to sustain a rat problem) -- same
// "grows under bad conditions, recedes under good ones" trend shape world.js's pollution/unrest
// already use.
const INFESTATION_GROWTH_BASE = 0.01;     // per tick while gated conditions hold
const INFESTATION_GROWTH_PER_RAT = 0.004; // extra per currently-alive rat
const INFESTATION_DECAY = 0.03;           // per tick once population drops back under threshold

const RAT_SPAWN_CHECK_INTERVAL = 50; // ~5s at 10Hz
const RAT_CHECK_INTERVAL = 30;       // ~3s at 10Hz -- cadence for each rat's periodic action roll
const RAT_WANDER_SPEED = 0.05;
const RAT_CHEW_RANGE = 1.5;          // how close a rat has to be to a wire/fence tile to gnaw it

const STEAL_CHANCE = 0.40; // real PA number
// PA's raw 3-15 range was kept "verbatim" per a prior pass's reasoning that it already sits in
// the same order of magnitude as this project's build costs -- but that compared a single steal
// event to a one-time build cost, not to the REPEATED per-rat-per-interval rate against a
// concurrent-rat cap that WAS scaled down (RAT_MAX_CONCURRENT 75->8, ~9.4x). Only one side of
// that product (rat count) got scaled; the per-event amount didn't. Root-caused via a live
// per-source scrap-drain trace (instrumented Object.defineProperty on world.scrap, see
// SESSION_HANDOFF.md): tickRats alone accounted for 100% of the "flagged balance regression"
// scrap collapse to 0 by wave 2-3 in a hands-off 3000-tick soak (-1696 scrap, every other passive
// drain -- factions/epidemic/coverage-plans/grants/corruption -- contributed zero in that window
// since they're rarer/event-gated rather than a fixed per-tick roll across up to 8 concurrent
// rats). Scaling the amount down by the same ~9.4x factor already applied to rat count.
const STEAL_MIN = 1, STEAL_MAX = 2;

const CHEW_WIRE_CHANCE = 0.05;  // real PA number
const CHEW_FENCE_CHANCE = 0.05; // real PA number
const CHEW_DAILY_CAP = 5;       // real PA number -- a settlement-wide counter, not per-rat
const FENCE_CHEW_DAMAGE = 0.2;  // fraction of a fence's 0.6 base health (siege.js) per successful chew --
                                 // a couple of chews weakens a fence, several destroy it, same texture as
                                 // an attacker's FENCE_DAMAGE_PER_TICK chip damage

// Droppings (real PA 5/20/40% by tier) feed straight into rooms.js's real mess/cleanliness axis
// (see that file's MESS_* doc comment -- the Cleaning-job pass already landed room.mess) rather
// than a parallel dirt tracker, per the task's "hook into it if it exists" instruction.
const DROPPING_CHANCE_BY_TIER = { [RatTier.Low]: 0.05, [RatTier.Medium]: 0.20, [RatTier.High]: 0.40 };
const DROPPING_MESS_AMOUNT = 0.04; // per successful dropping event (rolled once per RAT_CHECK_INTERVAL, not every tick)

export const RAT_TRAP_CATCH_CHANCE = 0.65; // real PA number
export const RAT_TRAP_ESCAPE_TICKS = 12;   // real PA number
const RAT_TRAP_RANGE = 1.2;

export class Rat {
  constructor(x, y, offset) {
    this.x = x; this.y = y;
    this.targetX = x; this.targetY = y;
    this.escapeTimer = 0; // >0 right after wriggling free of a trap -- can't be re-rolled immediately
    this.alive = true;
    this._offset = offset; // staggers this rat's RAT_CHECK_INTERVAL roll off every other rat's
  }
}

/** Call once from SimWorld's constructor to seed initial state. */
export function initRats(world) {
  world.ratInfestation = 0;
  world.rats = [];
  world.ratsCaught = 0;
  world._ratWireChewsToday = 0;
  world._ratFenceChewsToday = 0;
  world._ratLastDayIndex = 0;
  world._lastRatTier = RatTier.Low;
}

function dayIndexOf(world) {
  // schedule.js's DAY_NIGHT_CYCLE_TICKS defines one in-game "day" -- reused here rather than a
  // second copy of the constant so the chew-cap's "per day" lines up with the same day the
  // topbar's sun/moon indicator shows.
  return Math.floor(world.currentTick / DAY_NIGHT_CYCLE_TICKS);
}

function countAliveCitizens(world) {
  let n = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) n++;
  return n;
}

// MinimumJanitorsForRatInfestation (real PA ratsystem.txt, =1): infestation growth also requires at
// least one citizen actually available to do cleaning work. This project has no distinct Janitor
// profession/role -- jobs.js's WorkCategory.Cleaning is a per-citizen work-priority TOGGLE any
// citizen can hold, not a hired role (see that file's WorkCategory doc comment), so the honest
// equivalent of "at least one janitor present" is "at least one alive citizen whose effective
// Cleaning priority isn't explicitly disabled". Reads citizens.js's real hasWorkPriorities/
// workPriorityCleaning fields directly: a citizen who's never opened the Work Priorities panel has
// hasWorkPriorities[i] === 0 and falls back to jobs.js's default ladder, which always includes
// Cleaning (see jobs.js's WORK_CATEGORY_ORDER comment) -- only an explicit workPriorityCleaning
// override of 0 actually removes them from consideration.
function anyCleaningEligibleCitizen(world) {
  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (!store.hasWorkPriorities[i] || store.workPriorityCleaning[i] > 0) return true;
  }
  return false;
}

function pickSpawnSpot(world) {
  // Loose scatter around the settlement core, same shape as security.js's wild-animal spawner --
  // rats show up near where the mess/food actually is, not at a random map corner.
  for (let tries = 0; tries < 12; tries++) {
    const x = Math.max(1, Math.min(world.width - 2, world.width / 2 + (world.rng() - 0.5) * 16));
    const y = Math.max(1, Math.min(world.height - 2, world.height / 2 + (world.rng() - 0.5) * 16));
    if (!world.grid.isBlocked(Math.floor(x), Math.floor(y))) return { x, y };
  }
  return { x: world.width / 2, y: world.height / 2 };
}

function nearestLiveStructure(structures, kind, x, y, maxRange) {
  let best = null, bestDist = maxRange;
  for (const s of structures) {
    if (s.kind !== kind || s.destroyed || s.underConstruction) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

/** Infestation-level trend + spawning. Call once per tick from SimWorld.tick(). */
export function tickRatInfestation(world) {
  if (world.ratInfestation == null) initRats(world);

  const alive = countAliveCitizens(world);
  // Real PA gate is population >= 20 AND MinimumJanitorsForRatInfestation (>= 1 janitor) -- see
  // anyCleaningEligibleCitizen's doc comment above for the honest equivalent this project uses for
  // the second half, since there's no distinct Janitor role/profession here.
  const gated = alive >= RAT_POPULATION_THRESHOLD && anyCleaningEligibleCitizen(world);
  if (gated) {
    const growth = INFESTATION_GROWTH_BASE + world.rats.length * INFESTATION_GROWTH_PER_RAT;
    world.ratInfestation = Math.min(100, world.ratInfestation + growth);
  } else {
    world.ratInfestation = Math.max(0, world.ratInfestation - INFESTATION_DECAY);
  }

  // Reset the daily chew caps at the start of a new in-game day.
  const day = dayIndexOf(world);
  if (day !== world._ratLastDayIndex) {
    world._ratLastDayIndex = day;
    world._ratWireChewsToday = 0;
    world._ratFenceChewsToday = 0;
  }

  const tier = ratTier(world.ratInfestation);
  if (tier !== world._lastRatTier) {
    world._lastRatTier = tier;
    if (gated || tier === RatTier.Low) {
      const text = tier === RatTier.Low ? 'The rat infestation has died down' : `Rat infestation has reached ${tier} levels`;
      world.milestoneLog.push({ tick: world.currentTick, text });
      if (world.milestoneLog.length > 20) world.milestoneLog.shift();
      world.onRandomEvent?.(text);
    }
  }

  // Spawning: only while gated, under the concurrent cap, and even then only some of the time --
  // a rolling chance scaled by tier so High infestation visibly produces rats faster than Medium.
  if (gated && world.currentTick % RAT_SPAWN_CHECK_INTERVAL === 0 && world.rats.length < RAT_MAX_CONCURRENT) {
    const spawnChance = tier === RatTier.High ? 0.5 : tier === RatTier.Medium ? 0.25 : 0.08;
    if (world.rng() < spawnChance) {
      const spot = pickSpawnSpot(world);
      world.rats.push(new Rat(spot.x, spot.y, Math.floor(world.rng() * RAT_CHECK_INTERVAL)));
    }
  }
}

/** Per-rat movement + Rat Trap catch check + periodic steal/chew/dropping rolls. Call once per
 *  tick from SimWorld.tick(), after tickRatInfestation. */
export function tickRats(world) {
  if (world.rats == null) initRats(world);

  for (const rat of world.rats) {
    if (!rat.alive) continue;
    if (rat.escapeTimer > 0) rat.escapeTimer--;

    // Light cosmetic wander -- same shape as citizens.js's tickWander but far cheaper (at most
    // RAT_MAX_CONCURRENT=8 entities) and with zero job-system hookup.
    const dx = rat.targetX - rat.x, dy = rat.targetY - rat.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.15) {
      rat.targetX = Math.max(1, Math.min(world.width - 2, rat.x + (world.rng() - 0.5) * 4));
      rat.targetY = Math.max(1, Math.min(world.height - 2, rat.y + (world.rng() - 0.5) * 4));
    } else {
      rat.x += (dx / dist) * RAT_WANDER_SPEED;
      rat.y += (dy / dist) * RAT_WANDER_SPEED;
    }

    // Rat Trap catch check: only once the rat isn't mid-escape-window from a previous near-miss.
    if (rat.escapeTimer <= 0) {
      const trap = nearestLiveStructure(world.structures, 'rat_trap', rat.x, rat.y, RAT_TRAP_RANGE);
      if (trap) {
        if (world.rng() < RAT_TRAP_CATCH_CHANCE) {
          rat.alive = false;
          world.ratsCaught = (world.ratsCaught || 0) + 1;
        } else {
          rat.escapeTimer = RAT_TRAP_ESCAPE_TICKS;
        }
      }
    }
    if (!rat.alive) continue;

    // Periodic action roll (steal/chew/dropping) -- throttled per-rat via its own stagger offset
    // so RAT_MAX_CONCURRENT rats don't all roll on the exact same tick every RAT_CHECK_INTERVAL.
    if ((world.currentTick + (rat._offset || 0)) % RAT_CHECK_INTERVAL !== 0) continue;

    // Steal food (real PA 40%): drains scrap directly -- this project's stand-in for a food
    // stockpile (see header comment), scaled to PA's own 3-15 range since that already sits in
    // the same order of magnitude as this project's scrap economy.
    if (world.scrap > 0 && world.rng() < STEAL_CHANCE) {
      const amount = STEAL_MIN + Math.floor(world.rng() * (STEAL_MAX - STEAL_MIN + 1));
      const actual = Math.min(world.scrap, amount);
      world.scrap -= actual;
      if (world.finance) world.finance.ratLoss = (world.finance.ratLoss || 0) + actual;
    }

    // Chew a power wire (real PA 5%, capped 5/day) -- cuts an actual power.js conductor tile using
    // its existing disconnection logic (a destroyed structure just isn't a conductor anymore, see
    // power.js's isConductor) rather than a parallel damage system.
    if (world._ratWireChewsToday < CHEW_DAILY_CAP && world.rng() < CHEW_WIRE_CHANCE) {
      const wire = nearestLiveStructure(world.structures, 'wire', rat.x, rat.y, RAT_CHEW_RANGE);
      if (wire) {
        wire.health = 0;
        wire.destroyed = true;
        world._ratWireChewsToday++;
        const text = 'Rats chewed through a power wire';
        world.milestoneLog.push({ tick: world.currentTick, text });
        if (world.milestoneLog.length > 20) world.milestoneLog.shift();
        world.onRandomEvent?.(text);
      }
    }

    // Chew a fence (real PA 5%, capped 5/day) -- partial structural damage, same health/destroyed
    // pattern siege.js's attacker-vs-fence chip damage already uses.
    if (world._ratFenceChewsToday < CHEW_DAILY_CAP && world.rng() < CHEW_FENCE_CHANCE) {
      const fence = nearestLiveStructure(world.structures, 'fence', rat.x, rat.y, RAT_CHEW_RANGE);
      if (fence) {
        fence.health -= FENCE_CHEW_DAMAGE;
        if (fence.health <= 0) fence.destroyed = true;
        world._ratFenceChewsToday++;
        const text = 'Rats gnawed through part of a fence';
        world.milestoneLog.push({ tick: world.currentTick, text });
        if (world.milestoneLog.length > 20) world.milestoneLog.shift();
        world.onRandomEvent?.(text);
      }
    }

    // Droppings (real PA 5/20/40% by tier) -- feeds rooms.js's mess/cleanliness axis directly.
    const dropChance = DROPPING_CHANCE_BY_TIER[ratTier(world.ratInfestation)];
    if (world.rng() < dropChance) {
      const room = roomContaining(world.rooms, world.grid, rat.x, rat.y);
      if (room) room.mess = Math.min(1, (room.mess || 0) + DROPPING_MESS_AMOUNT);
    }
  }

  // Drop caught rats out of the live list -- cheap, at most RAT_MAX_CONCURRENT entries.
  if (world.rats.some(r => !r.alive)) world.rats = world.rats.filter(r => r.alive);
}
