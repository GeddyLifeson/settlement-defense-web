// Ported/condensed from SD.Security (StaffRoster, guard/sniper/K9 AI + alert-level FSM).
// StaffRoleKind.Monitor (added for the CCTV feature, see world.js's wave-warning logic and
// FEATURE_RESEARCH.md's Prison Architect section) reuses this same roster/post plumbing --
// tickStaffDuty below already walks any assigned staff to their post regardless of role, so a
// Monitor just needs an assign(citizenId, StaffRoleKind.Monitor, {x, y}) at a Monitor Station's
// location; no combat behavior of its own, it's read passively by world.js's staffed-check.
import { StaffRoleKind, rngInt } from './core.js';
// Damage-type plumbing lives in siege.js; K9 bites are Kinetic like a guard sidearm, so dogs are
// good at running down Skirmishers and poor at chewing through a Brute's plate.
import { damageAttacker, DamageType } from './siege.js';
import { JobState } from './jobs.js';
import { ZoneKind } from './zones.js';
// Staff Vetting research node (research.js) -- lowers the crooked-staff ratio, see the
// corruption section near the bottom of this file. research.js precedes security.js in
// build.py's ORDER, so this named import is safe in the flat-concatenated bundle too.
import { isNodeUnlocked } from './research.js';

export const AlertLevel = Object.freeze({
  Calm: 0,
  Alert: 1,
  Combat: 2,
});

// Armory weapon tiers (FEATURE_RESEARCH.md's Prison Architect section): a civilian defense
// force issuing weapons from an armory needs no reframing at all, it's already the game's
// premise. Each tier is a multiplier on a role's baseline GUARD_*/SNIPER_* stats (siege.js) --
// Sidearm is exactly that baseline (1x everywhere), so a roster with no Armory built plays
// identically to the old flat-constant behavior. Rifle and Heavy are real tradeoffs, not strict
// upgrades: more damage costs range and/or cooldown, matching the turret/tesla and dog/guard
// tradeoff framing already used elsewhere in siege.js.
export const WeaponTier = Object.freeze({
  Sidearm: 'Sidearm',
  Rifle: 'Rifle',
  Heavy: 'Heavy',
});

export const WEAPON_TIERS = Object.freeze({
  [WeaponTier.Sidearm]: Object.freeze({ label: 'Sidearm', damageMult: 1,    rangeMult: 1,    cooldownMult: 1 }),
  [WeaponTier.Rifle]:   Object.freeze({ label: 'Rifle',   damageMult: 1.6,  rangeMult: 1.15, cooldownMult: 1.15 }),
  [WeaponTier.Heavy]:   Object.freeze({ label: 'Heavy',   damageMult: 2.4,  rangeMult: 0.8,  cooldownMult: 1.75 }),
});

// Weakest -> strongest; how far up this list a guard/sniper can be issued is gated by how many
// Armories the settlement has actually built (see tickArmoryIssuance).
const WEAPON_TIER_ORDER = [WeaponTier.Sidearm, WeaponTier.Rifle, WeaponTier.Heavy];

// Patrol routes + staff fatigue (FEATURE_RESEARCH.md's Prison Architect section): `post` may be
// a single {x, y} (static hold-position, unchanged behavior / old save-file shape) or an ordered
// array of 2-4 waypoints a guard/sniper/monitor cycles through, pausing briefly at each -- see
// tickStaffDuty. Staff also carry a real off-duty cycle: tickStaffOffDuty below flips
// roster.isOffDuty when a staff member's hunger/rest (same CitizenStore fields every citizen
// has) crosses a threshold, at which point tickStaffDuty stops walking them and jobs.js's normal
// Eat/Sleep job states take over for them, same as any off-shift citizen, until they recover.
const PATROL_PAUSE_TICKS = 15; // dwell at each waypoint so a patrol reads as a beat, not a jitter
const OFFDUTY_REST_THRESHOLD = 0.35; // fatigue this low sends staff off duty to recover
const OFFDUTY_HUNGER_THRESHOLD = 0.35;

export class StaffRoster {
  constructor() {
    this._roleById = new Map(); // citizenId -> StaffRoleKind
    this._postById = new Map(); // citizenId -> array of 1-4 {x, y} waypoints (1 = static post)
    this._weaponById = new Map(); // citizenId -> WeaponTier, see tickArmoryIssuance
    this._patrolIndexById = new Map(); // citizenId -> index of the waypoint currently being walked to
    this._patrolPauseById = new Map(); // citizenId -> ticks spent paused at the current waypoint
    this._offDutyById = new Set(); // citizenId currently clocked off, recovering hunger/rest like a normal citizen

    // Corrupt/bribable staff (Prison Architect's "Crooked Guards", reskinned -- see the
    // tickStaffCorruption doc comment near the bottom of this file for the full mechanic).
    this._corruptEvaluated = new Set();     // citizenId already run through the one-time hire-ratio roll
    this._corruptEligible = new Set();      // citizenId flagged "crooked" -- capable of going actively corrupt
    this._corruptActiveUntil = new Map();   // citizenId -> tick an active bribe period ends
    this._corruptDiscovered = new Set();    // citizenId caught mid-bribe, awaiting the player firing them
  }

  // post may be a single {x, y} (backward compat / old save shape) or an array of 2-4 {x, y}
  // points defining a patrol loop.
  assign(citizenId, kind, post) {
    this._roleById.set(citizenId, kind);
    if (post) {
      this._postById.set(citizenId, Array.isArray(post) ? post : [post]);
      this._patrolIndexById.set(citizenId, 0);
      this._patrolPauseById.set(citizenId, 0);
    }
  }

  isStaff(citizenId) {
    return this._roleById.has(citizenId);
  }

  kindOf(citizenId) {
    return this._roleById.get(citizenId) || StaffRoleKind.None;
  }

  // Full waypoint list assigned to this staff member (length 1 for a static post), or undefined.
  postOf(citizenId) {
    return this._postById.get(citizenId);
  }

  // The single waypoint tickStaffDuty is walking this staff member toward right now.
  currentWaypoint(citizenId) {
    const points = this._postById.get(citizenId);
    if (!points || points.length === 0) return null;
    const idx = this._patrolIndexById.get(citizenId) || 0;
    return points[idx % points.length];
  }

  advancePatrol(citizenId) {
    const points = this._postById.get(citizenId);
    if (!points || points.length <= 1) return; // static post, nothing to cycle
    const idx = (this._patrolIndexById.get(citizenId) || 0) + 1;
    this._patrolIndexById.set(citizenId, idx % points.length);
  }

  isOffDuty(citizenId) {
    return this._offDutyById.has(citizenId);
  }

  setOffDuty(citizenId, offDuty) {
    if (offDuty) this._offDutyById.add(citizenId);
    else this._offDutyById.delete(citizenId);
  }

  // Sidearm is the implicit default for any Guard/Sniper who hasn't been issued anything yet
  // (or ever will be, if no Armory gets built) -- never null, so siege.js's tickStaffCombat
  // always has real tier stats to read.
  weaponOf(citizenId) {
    return this._weaponById.get(citizenId) || WeaponTier.Sidearm;
  }

  equip(citizenId, tier) {
    this._weaponById.set(citizenId, tier);
  }

  // ---- corrupt/bribable staff (see tickStaffCorruption below) ----
  isCorruptEligible(citizenId) { return this._corruptEligible.has(citizenId); }
  isCorruptActive(citizenId) { return this._corruptActiveUntil.has(citizenId); }
  isCorruptDiscovered(citizenId) { return this._corruptDiscovered.has(citizenId); }
}

// Armory issuance (scoped version per FEATURE_RESEARCH.md: no per-citizen pick-a-tier UI --
// simply, once assigned to Guard/Sniper AND an Armory exists, they're equipped with whatever
// tier the settlement's Armory count supports). Every built (not destroyed/under-construction)
// Armory unlocks one more rung of WEAPON_TIER_ORDER, so a second Armory is a real strategic
// payoff, not just a cosmetic duplicate. Runs every tick (world.js) so a freshly-assigned guard
// or a freshly-completed Armory both propagate immediately, and a destroyed Armory correctly
// downgrades everyone back rather than leaving them permanently over-equipped.
export function tickArmoryIssuance(roster, structures) {
  let armoryCount = 0;
  for (const s of structures) {
    if (s.kind === 'armory' && !s.destroyed && !s.underConstruction) armoryCount++;
  }
  const tierIndex = Math.min(WEAPON_TIER_ORDER.length - 1, armoryCount);
  const tier = WEAPON_TIER_ORDER[tierIndex];
  for (const [citizenId, kind] of roster._roleById.entries()) {
    if (kind !== StaffRoleKind.Guard && kind !== StaffRoleKind.Sniper) continue;
    roster.equip(citizenId, tier);
  }
}

// Guards/snipers/monitors walk their assigned route -- a single point holds position (matches
// the Unity build's "hold position" staff behavior); 2-4 points cycle as a patrol loop, pausing
// PATROL_PAUSE_TICKS at each stop before moving to the next. Off-duty staff (see
// tickStaffOffDuty) are skipped entirely -- jobs.js drives their Eat/Sleep trip that tick
// instead. Everyone else uses the general wander tick.
export function tickStaffDuty(store, roster, idOf, speed = 0.05) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.isDownedAt(i)) continue; // downed staff can't hold their post
    const id = idOf(i);
    if (!roster.isStaff(id)) continue;
    if (roster.isOffDuty(id)) continue; // clocked off recovering a need -- see tickStaffOffDuty

    const waypoint = roster.currentWaypoint(id);
    if (!waypoint) continue;

    const dx = waypoint.x - store.x[i];
    const dy = waypoint.y - store.y[i];
    const dist = Math.hypot(dx, dy);
    if (dist > 0.1) {
      store.x[i] += (dx / dist) * speed;
      store.y[i] += (dy / dist) * speed;
      roster._patrolPauseById.set(id, 0);
    } else {
      const pause = (roster._patrolPauseById.get(id) || 0) + 1;
      if (pause >= PATROL_PAUSE_TICKS) {
        roster.advancePatrol(id);
        roster._patrolPauseById.set(id, 0);
      } else {
        roster._patrolPauseById.set(id, pause);
      }
    }
    store.targetX[i] = store.x[i];
    store.targetY[i] = store.y[i];
  }
}

// Staff fatigue: guards/snipers/monitors carry the same hunger/rest fields as any citizen (see
// citizens.js tickNeedsAndMood, which decays them for staff same as everyone), but previously had
// no way to actually respond to it -- jobs.js's tickJobs unconditionally skips anyone
// roster.isStaff() covers, so staff would silently decay to 0 forever with zero recovery and zero
// gameplay consequence. This flips roster's off-duty flag when fatigue/hunger crosses a
// threshold and dispatches them straight to the nearest Food/Bedroom zone itself (see below);
// while off duty, world.js's staffOnDuty callback reports them as NOT on duty, so jobs.js's normal
// SeekingFood/Eating/SeekingBed/Sleeping state machine carries out that trip for them exactly
// like any citizen's, and tickStaffDuty (above) leaves them alone instead of walking them back to
// post.
//
// Dispatch is done directly here rather than just flipping the flag and letting jobs.js's own
// Idle branch notice the low need on its own: that branch's thresholds are deliberately narrowed
// during the Work schedule block (see jobs.js SCHEDULE_WORK_THRESHOLD_MULT) so a citizen mid-task
// doesn't break off for anything short of near-critical -- sensible for someone protecting an
// in-progress build/harvest job, but a guard/sniper has no such job to protect, just a post to
// leave, so that narrowing should never apply to them. Left to the generic Idle branch, an
// off-duty guard whose needs dipped moderately (not narrow-threshold-critical) would fall through
// past the food/bed checks entirely and pick up a blueprint/harvest job instead, wandering off
// indefinitely rather than taking the short break this feature intends -- caught in soak testing
// before this was changed to a direct dispatch.
// Sends citizen index i directly into jobs.js's SeekingFood/SeekingBed travel state, bypassing
// the Idle branch's own (schedule-narrowed) threshold checks entirely -- see the doc comment
// above. Returns false (and leaves the roster on-duty flag alone for the caller to reconsider) if
// no matching zone exists to send them to, so an off-duty citizen can't get stuck forever with
// nowhere to go.
function dispatchStaffToNeed(store, i, zones, wantFood) {
  const zone = zones.nearestOfKind(wantFood ? ZoneKind.Food : ZoneKind.Bedroom, store.x[i], store.y[i]);
  if (!zone) return false;
  store.jobState[i] = wantFood ? JobState.SeekingFood : JobState.SeekingBed;
  store.targetX[i] = zone.x; store.targetY[i] = zone.y;
  return true;
}

export function tickStaffOffDuty(store, roster, idOf, zones) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.isDownedAt(i)) continue;
    const id = idOf(i);
    if (!roster.isStaff(id)) continue;

    const needsFood = store.hunger[i] < OFFDUTY_HUNGER_THRESHOLD;
    const needsRest = store.rest[i] < OFFDUTY_REST_THRESHOLD;

    if (!roster.isOffDuty(id)) {
      if (needsFood || needsRest) {
        roster.setOffDuty(id, true);
        // Whichever need is more urgent (lower current value) wins the first trip; the other
        // gets a second trip below once the first one completes, if it's still low by then.
        const wantFood = needsFood && (!needsRest || store.hunger[i] <= store.rest[i]);
        if (!dispatchStaffToNeed(store, i, zones, wantFood)) roster.setOffDuty(id, false);
      }
    } else if (store.jobState[i] === JobState.Idle) {
      // jobs.js's Eating/Sleeping loop ran the trip we dispatched to completion -- if the other
      // need is also still low, send a second trip before fully resuming, same as a citizen
      // handling one need at a time; otherwise, back to post/patrol.
      if (needsFood) { if (!dispatchStaffToNeed(store, i, zones, true)) roster.setOffDuty(id, false); }
      else if (needsRest) { if (!dispatchStaffToNeed(store, i, zones, false)) roster.setOffDuty(id, false); }
      else roster.setOffDuty(id, false);
    }
  }
}

// Guard/sniper engagement range in grid cells, and simple alert-level derivation from
// visible attacker count (Calm -> Alert -> Combat), matching the FSM's broad shape.
export function deriveAlertLevel(attackerAliveCount) {
  if (attackerAliveCount === 0) return AlertLevel.Calm;
  return AlertLevel.Combat;
}

const DOG_RANGE = 2.5; const DOG_DAMAGE = 0.08; const DOG_COOLDOWN = 3; const DOG_SPEED = 0.07;
// Bites carry the lowest armorPenetration of any damage source in the game (siege.js's
// TURRET/GUARD/TESLA/TRAP/SNIPER_PENETRATION constants) -- a dog is cheap/fast, not armor-piercing.
const DOG_PENETRATION = 10;

// K9 units: each dog follows its handler loosely and bites the nearest attacker in range,
// fast and cheap per-hit compared to a guard's sidearm -- matches the GDD's non-carceral
// civil-protection-force framing ("guards/snipers/K9/CCTV", never inmates).
// rng: threaded through to siege.js's armor-vs-penetration roll for determinism; defaults to
// Math.random so existing call sites (tests/console pokes) keep working unchanged.
export function tickDogs(dogs, citizens, roster, attackers, onScrap, rng = Math.random) {
  for (const dog of dogs) {
    const ownerIdx = findCitizenIndexById(citizens, dog.ownerId);
    if (ownerIdx < 0 || !citizens.isAliveAt(ownerIdx)) continue;

    const dx = citizens.x[ownerIdx] - dog.x;
    const dy = citizens.y[ownerIdx] - dog.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1.2) {
      dog.x += (dx / dist) * DOG_SPEED;
      dog.y += (dy / dist) * DOG_SPEED;
    }

    if (dog.cooldown > 0) { dog.cooldown--; continue; }
    let bestI = -1, bestDist = DOG_RANGE;
    for (let i = 0; i < attackers.count; i++) {
      if (!attackers.isAliveAt(i)) continue;
      const d = Math.hypot(attackers.x[i] - dog.x, attackers.y[i] - dog.y);
      if (d < bestDist) { bestDist = d; bestI = i; }
    }
    if (bestI >= 0) {
      dog.cooldown = DOG_COOLDOWN;
      if (damageAttacker(attackers, bestI, DOG_DAMAGE, DamageType.Kinetic, DOG_PENETRATION, rng)) onScrap?.(4);
    }
  }
}

function findCitizenIndexById(citizens, id) {
  for (let i = 0; i < citizens.count; i++) if (citizens.id[i] === id) return i;
  return -1;
}

// Wires a tamed/bred dog (already in world.dogs) to a citizen the same way the starting dog is
// wired in world.js's constructor -- both the roster assignment (so tickStaffDuty/UI treat them
// as K9Handler and walk them to a post) and the dog's own ownerId (so tickDogs above knows who
// to follow) are needed; the roster system itself needs no changes to support a second dog.
export function assignDogHandler(roster, dog, citizenId, post) {
  roster.assign(citizenId, StaffRoleKind.K9Handler, post);
  dog.ownerId = citizenId;
}

// --- RimWorld-style taming/breeding (see FEATURE_RESEARCH.md's Animals section) ---
// A wild animal shares the dog's {x,y} shape but stays outside world.dogs (and outside the K9
// roster/combat loop entirely) until jobs.js's Taming job succeeds -- kept as a distinct array
// rather than a `tamed: false` flag on world.dogs, since dogs is specifically the
// roster-assignable/combat-ticked collection and a wild animal is neither of those things yet.
const WILD_ANIMAL_SPAWN_INTERVAL = 500; // ticks between spawn rolls -- cadence mirrors resources.js's maybeSpawnNode
const MAX_WILD_ANIMALS = 3; // concurrent untamed animals on the map at once
const WILD_ANIMAL_SPEED = 0.03;

export function maybeSpawnWildAnimal(wildAnimals, grid, rng, currentTick, avoidX, avoidY) {
  if (currentTick % WILD_ANIMAL_SPAWN_INTERVAL !== 0) return;
  if (wildAnimals.length >= MAX_WILD_ANIMALS) return;
  let tries = 0;
  while (tries < 30) {
    tries++;
    const x = Math.floor(rng() * grid.width);
    const y = Math.floor(rng() * grid.height);
    if (Math.hypot(x - avoidX, y - avoidY) < 8) continue;
    if (grid.isBlocked(x, y)) continue;
    wildAnimals.push({ x: x + 0.5, y: y + 0.5, targetX: x + 0.5, targetY: y + 0.5, claimedBy: null, tameTicks: 0 });
    return;
  }
}

// Wild animals wander like an idle citizen (see citizens.js tickWander) but freeze in place while
// a citizen is actively taming them (claimedBy set) -- otherwise jobs.js's Taming job could never
// get a stable "arrived" check, since the target would keep drifting mid-approach.
export function tickWildAnimals(wildAnimals, grid, rng, speed = WILD_ANIMAL_SPEED) {
  for (const animal of wildAnimals) {
    if (animal.claimedBy != null) continue;
    const dx = animal.targetX - animal.x;
    const dy = animal.targetY - animal.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.15) {
      let tx, ty, tries = 0;
      do {
        tx = Math.max(1, Math.min(grid.width - 2, animal.x + (rng() - 0.5) * 6));
        ty = Math.max(1, Math.min(grid.height - 2, animal.y + (rng() - 0.5) * 6));
        tries++;
      } while (grid.isBlocked(tx | 0, ty | 0) && tries < 8);
      animal.targetX = tx; animal.targetY = ty;
    } else {
      animal.x += (dx / dist) * speed;
      animal.y += (dy / dist) * speed;
    }
  }
}

// Flat per-tick taming chance -- no dedicated "Animals" skill exists yet (FEATURE_RESEARCH.md
// explicitly says not to add one just for this), so this is the "just a flat rate" option it
// calls out as acceptable. TAME_MAX_TICKS bounds how long a citizen will stick with a no-luck
// animal before it flees, so a job can't get permanently stuck.
export const TAME_CHANCE_PER_TICK = 0.004;
export const TAME_MAX_TICKS = 400;

// Bounds total world.dogs population so neither breeding nor ongoing taming can spiral --
// jobs.js's Taming success check reads this too (not just tickDogBreeding below), since a long
// soak session can otherwise keep taming freshly-spawned wild animals past any breeding-only cap.
export const DOG_POPULATION_CAP = 8;
const BREED_CHECK_INTERVAL = 300;
const BREED_CHANCE = 0.12;

// Two tamed animals occasionally produce a pup, no citizen action required beyond having tamed
// the initial pair -- deliberately simple (flat chance-per-check against a hard population cap)
// rather than a full needs/pregnancy model, matching the scope the task called for.
export function tickDogBreeding(dogs, rng, currentTick) {
  if (currentTick % BREED_CHECK_INTERVAL !== 0) return;
  if (dogs.length < 2 || dogs.length >= DOG_POPULATION_CAP) return;
  if (rng() >= BREED_CHANCE) return;
  const aIdx = rngInt(rng, 0, dogs.length);
  let bIdx = rngInt(rng, 0, dogs.length);
  let tries = 0;
  while (bIdx === aIdx && tries < 5) { bIdx = rngInt(rng, 0, dogs.length); tries++; }
  const a = dogs[aIdx], b = dogs[bIdx];
  dogs.push({ ownerId: null, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, cooldown: 0 });
}

// --- Corrupt/bribable staff (Prison Architect's "Crooked Guards" -- crookedguards_settings.txt,
// reskinned as an integrity problem in a civil protection force, never a prison mechanic) ---
//
// Real numbers this was ported from, and how they map onto this project's tick rate/economy:
//  - "Corrupt Every Nth Hired Guard 6" / "Crooked Guards to Normal Guards Ratio 0.1667": every
//    corruption-eligible staff member assigned to the roster (Guard/Sniper/Monitor -- the roles
//    that actually stand a post with something worth diverting, unlike a K9Handler) is evaluated
//    exactly once, the first tick they're seen, with a CORRUPTION_BASE_RATIO (1/6) chance of
//    being permanently flagged "crooked". That flag doesn't mean they're actively doing anything
//    yet -- see the periodic roll below.
//  - "30% chance per ~10-real-day interval": PA's real-day pacing translated onto this project's
//    own day length (schedule.js's DAY_NIGHT_CYCLE_TICKS = 2400 ticks/day at 10Hz, hardcoded
//    below rather than imported -- see the note on CORRUPTION_ROLL_INTERVAL_TICKS) -- every 10
//    in-game days, every currently-eligible-but-not-already-active crooked staffer rolls a 30%
//    chance to actually go active and start a bribe period.
//  - "48 real-hours" bribe duration -> 2 of this project's days (4800 ticks). While active, the
//    corrupt staffer secretly diverts a small amount of scrap from the settlement's stockpile,
//    same "quiet drain" shape as the real mechanic's contraband smuggling, reskinned as scrap
//    diversion since this settlement has no prisoners to smuggle contraband to.
//  - "Reward for firing a corrupt guard ~500" -> scaled ~40x down to this project's scrap economy
//    (BUILD_COST tops out in the 40-90 range for most buildables) -> CORRUPTION_FIRE_REWARD (13).
//
// Population gate: Prison Architect's real settings gate this off total guard count; the task
// spec asks to gate on faction/clique population >=10 if a concurrently-developed src/factions.js
// exists by the time this lands. Re-checked right before wiring this into world.js -- factions.js
// DOES now exist (a concurrent pass built it this session), so this hooks into it via
// corruptionPopulationGateMet below rather than the plain-citizen-count fallback. No import of
// factions.js needed here (avoids any bundler-ordering question, see the GAME_DAY_TICKS note
// above) -- it just duck-types world.factions, which is undefined/absent for any world built
// before factions.js existed, in which case it falls back to total living citizen population.
const CORRUPTION_POP_GATE = 10;

function corruptionPopulationGateMet(world) {
  if (world.factions) {
    // factions.js's FactionState tracks clique membership directly (memberOf: citizenId -> clique
    // id) -- that IS the "faction/clique population" the task spec asks to gate on, once cliques
    // have actually formed (they don't recruit anyone before FACTION_MIN_POPULATION, so
    // memberOf.size is 0 right up until formation, then jumps to the full alive population).
    return world.factions.formed && world.factions.memberOf.size >= CORRUPTION_POP_GATE;
  }
  let alive = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) alive++;
  return alive >= CORRUPTION_POP_GATE;
}
const CORRUPTION_ELIGIBLE_ROLES = new Set([StaffRoleKind.Guard, StaffRoleKind.Sniper, StaffRoleKind.Monitor]);
const CORRUPTION_BASE_RATIO = 1 / 6;    // "Crooked Guards to Normal Guards Ratio 0.1667"
const CORRUPTION_VETTED_RATIO = 0.10;   // reduced ratio once Staff Vetting (research.js) is unlocked
// Hardcoded rather than `import { DAY_NIGHT_CYCLE_TICKS } from './schedule.js'`: schedule.js
// comes AFTER security.js in build.py's ORDER, and these are top-level `const` expressions
// evaluated the instant this file's section of the flat-concatenated bundle runs -- importing a
// later-ordered module's binding here would read as undefined in the bundle (works fine as real
// ES modules, since those resolve lazily, but this project's file:// bundle doesn't). Keep this
// literal in sync with schedule.js's DAY_NIGHT_CYCLE_TICKS (2400) if that ever changes.
const GAME_DAY_TICKS = 2400;
const CORRUPTION_ROLL_INTERVAL_TICKS = 10 * GAME_DAY_TICKS; // "~10-real-day interval"
const CORRUPTION_ROLL_CHANCE = 0.30;
const CORRUPTION_BRIBE_DURATION_TICKS = 2 * GAME_DAY_TICKS; // "48 real-hours"
const CORRUPTION_DIVERSION_INTERVAL_TICKS = 60; // how often an active bribe siphons scrap
const CORRUPTION_DIVERSION_AMOUNT = 0.6; // small per-siphon amount -- a few scrap over a full bribe window
const CORRUPTION_DISCOVERY_CHECK_INTERVAL_TICKS = 240; // ~1 in-game hour (GAME_DAY_TICKS/10)
const CORRUPTION_DISCOVERY_CHANCE = 0.05; // per check, only while a bribe is actively running
export const CORRUPTION_FIRE_REWARD = 13; // real ~500, scaled ~40x to this project's scrap economy

function corruptionRatio(world) {
  return isNodeUnlocked(world.research, 'staff_vetting') ? CORRUPTION_VETTED_RATIO : CORRUPTION_BASE_RATIO;
}

// Called once per world tick (world.js). Cheap: iterates the roster (small) and, at most once
// every CORRUPTION_ROLL_INTERVAL_TICKS, the (small) eligible set -- never the full citizen store
// except via the one population-gate count and the per-active-bribe lookups below, both bounded
// by roster size in practice.
export function tickStaffCorruption(world) {
  const roster = world.roster;
  const store = world.citizens;

  if (!corruptionPopulationGateMet(world)) return;

  // One-time hire-ratio evaluation: any corruption-eligible-role staff member not yet evaluated
  // gets exactly one roll, right here, the first tick after they're seen on the roster --
  // functionally equivalent to rolling "at hire time" without needing every call site that ever
  // assigns a Guard/Sniper/Monitor (world.js's constructor, a future hire UI, deserialize) to
  // remember to hook into this system directly.
  for (const [id, kind] of roster._roleById.entries()) {
    if (!CORRUPTION_ELIGIBLE_ROLES.has(kind)) continue;
    if (roster._corruptEvaluated.has(id)) continue;
    roster._corruptEvaluated.add(id);
    if (world.rng() < corruptionRatio(world)) roster._corruptEligible.add(id);
  }

  // Periodic bribe-activation roll.
  if (world.currentTick % CORRUPTION_ROLL_INTERVAL_TICKS === 0) {
    for (const id of roster._corruptEligible) {
      if (roster._corruptActiveUntil.has(id)) continue; // already mid-bribe
      if (roster._corruptDiscovered.has(id)) continue;  // caught, awaiting the player firing them
      const idx = findCitizenIndexById(store, id);
      if (idx < 0 || !store.isAliveAt(idx)) continue;
      if (world.rng() < CORRUPTION_ROLL_CHANCE) {
        roster._corruptActiveUntil.set(id, world.currentTick + CORRUPTION_BRIBE_DURATION_TICKS);
      }
    }
  }

  // Active bribes: periodic scrap diversion + a chance of being caught.
  for (const [id, untilTick] of Array.from(roster._corruptActiveUntil.entries())) {
    const idx = findCitizenIndexById(store, id);
    if (idx < 0 || !store.isAliveAt(idx) || world.currentTick >= untilTick) {
      roster._corruptActiveUntil.delete(id); // bribe period lapsed naturally (still eligible for a future roll)
      continue;
    }
    if (world.currentTick % CORRUPTION_DIVERSION_INTERVAL_TICKS === 0) {
      const amt = Math.min(world.scrap, CORRUPTION_DIVERSION_AMOUNT);
      if (amt > 0) {
        world.scrap -= amt;
        world.finance.corruptionLoss = (world.finance.corruptionLoss || 0) + amt;
      }
    }
    if (!roster._corruptDiscovered.has(id) && world.currentTick % CORRUPTION_DISCOVERY_CHECK_INTERVAL_TICKS === 0) {
      if (world.rng() < CORRUPTION_DISCOVERY_CHANCE) {
        roster._corruptDiscovered.add(id);
        const name = store.name[idx];
        const text = `${name} was caught quietly diverting supplies -- fire them for a reward, or leave them on duty`;
        world.milestoneLog.push({ tick: world.currentTick, text });
        if (world.milestoneLog.length > 20) world.milestoneLog.shift();
        world.onRandomEvent?.(text);
      }
    }
  }
}

// Player-facing mitigation: fires a discovered-corrupt staffer off the roster entirely (back to
// being a plain citizen, not removed from the settlement -- this is a firing, not a punishment,
// matching the non-carceral framing) and grants the scrap reward. Only works once the staffer has
// actually been caught (see tickStaffCorruption's discovery roll above) -- a merely "eligible"
// (never-activated, or activated-but-undiscovered) staffer can't be preemptively fired on
// suspicion alone, mirroring the real mechanic's "reward for firing A corrupt guard" (i.e. one
// that's been caught), not a witch-hunt tool. Returns { ok, reward, kind } or { ok: false }.
export function fireCorruptStaff(world, citizenId) {
  const roster = world.roster;
  if (!roster._corruptDiscovered.has(citizenId)) return { ok: false };

  const kind = roster._roleById.get(citizenId);
  roster._corruptDiscovered.delete(citizenId);
  roster._corruptActiveUntil.delete(citizenId);
  roster._corruptEligible.delete(citizenId); // fired for cause -- no longer on the roster to be re-bribed
  roster._roleById.delete(citizenId);
  roster._postById.delete(citizenId);
  roster._weaponById.delete(citizenId);
  roster._patrolIndexById.delete(citizenId);
  roster._patrolPauseById.delete(citizenId);
  roster._offDutyById.delete(citizenId);

  world.addScrap(CORRUPTION_FIRE_REWARD);
  const idx = findCitizenIndexById(world.citizens, citizenId);
  const name = idx >= 0 ? world.citizens.name[idx] : 'A staffer';
  const text = `${name} was fired for corruption -- ${CORRUPTION_FIRE_REWARD} scrap reward`;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
  return { ok: true, reward: CORRUPTION_FIRE_REWARD, kind };
}

// Debug/soak-test helpers (see main.js's window.__debug.security): the real bribe-activation
// roll only runs every CORRUPTION_ROLL_INTERVAL_TICKS (~24000 ticks, 10 in-game days) -- far
// longer than a practical manual soak test. These let a verification pass force the same logic
// immediately without waiting, without duplicating it.
export function forceCorruptionRoll(world) {
  const roster = world.roster;
  const store = world.citizens;
  let activated = 0;
  for (const id of roster._corruptEligible) {
    if (roster._corruptActiveUntil.has(id)) continue;
    if (roster._corruptDiscovered.has(id)) continue;
    const idx = findCitizenIndexById(store, id);
    if (idx < 0 || !store.isAliveAt(idx)) continue;
    if (world.rng() < CORRUPTION_ROLL_CHANCE) {
      roster._corruptActiveUntil.set(id, world.currentTick + CORRUPTION_BRIBE_DURATION_TICKS);
      activated++;
    }
  }
  return activated;
}

// Forces a specific staffer straight to "active bribe" regardless of the eligibility/roll gates
// above -- for a soak test that wants to verify the diversion/discovery/fire loop deterministically
// rather than waiting on the 1-in-6 hire ratio and the 30% roll to both land.
export function forceActivateCorruption(world, citizenId) {
  const roster = world.roster;
  if (!roster.isStaff(citizenId)) return false;
  roster._corruptEvaluated.add(citizenId);
  roster._corruptEligible.add(citizenId);
  roster._corruptActiveUntil.set(citizenId, world.currentTick + CORRUPTION_BRIBE_DURATION_TICKS);
  return true;
}
