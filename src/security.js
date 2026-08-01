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
// Staff training-program dispatch (see tickStaffTraining near the bottom of this file):
// programs.js comes AFTER security.js in build.py's ORDER, same "later-ordered module, function-
// body-only usage" shape as the JobState import from jobs.js right above (jobs.js itself imports
// FROM security.js already -- TAME_CHANCE_PER_TICK etc -- so this is the exact same already-
// proven-safe circular-import pattern, not a new risk).
import { PROGRAM_DEFS, isSiteStaffed, roomPostFor } from './programs.js';

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
  // Non-lethal takedown weapon (real PA anchor: StunBaton, cost 350, 40% stun chance, 1hr
  // cooldown -- see WEAPON_TIERS.StunBaton below for how the 1hr converts onto this project's
  // tick rate). Deliberately NOT part of the Sidearm->Rifle->Heavy armory-stock progression
  // (WEAPON_TIER_ORDER below) -- it's a distinct tactical choice a player opts a specific
  // guard/sniper into via the existing manual-override system, not a strictly-better tier that
  // more Armories should auto-issue.
  StunBaton: 'StunBaton',
});

// penetrationBonus (0-100, same units as siege.js's ARMOR_RATING/armorPenetration scale): added
// on top of GUARD_PENETRATION(15)/SNIPER_PENETRATION(40) in siege.js's tickStaffCombat (and
// draft.js's drafted-combat mirror of the same pipeline) -- a higher tier doesn't just hit
// harder, it also punches through more armor, same real-anchor shape as RimWorld's own gun
// spread (armorPenetrationBase runs roughly 0 -> 0.35 across its tiers, i.e. 0-35 on this
// project's 0-100 scale). Sidearm stays +0 so an unarmoried roster's penetration is byte-for-byte
// unchanged from before this field existed.
export const WEAPON_TIERS = Object.freeze({
  [WeaponTier.Sidearm]: Object.freeze({ label: 'Sidearm', damageMult: 1,    rangeMult: 1,    cooldownMult: 1,    penetrationBonus: 0 }),
  [WeaponTier.Rifle]:   Object.freeze({ label: 'Rifle',   damageMult: 1.6,  rangeMult: 1.15, cooldownMult: 1.15, penetrationBonus: 10 }),
  [WeaponTier.Heavy]:   Object.freeze({ label: 'Heavy',   damageMult: 2.4,  rangeMult: 0.8,  cooldownMult: 1.75, penetrationBonus: 20 }),
  // Stun Baton (see WeaponTier.StunBaton above). damageMult: 0 -- siege.js's tickStaffCombat
  // special-cases `nonLethal` tiers to skip damageAttacker entirely and roll stunChance instead,
  // so damageMult never actually multiplies anything, but it's kept at the honest value (this
  // weapon deals zero lethal damage) rather than left undefined. rangeMult 0.85: a baton is a
  // shorter-reach tool than a firearm, real tradeoff for the utility it buys. cooldownMult 25:
  // GUARD_COOLDOWN(4 ticks) * 25 = 100 ticks = exactly 1 in-game hour at this project's
  // GAME_DAY_TICKS(2400)/24 = 100-ticks-per-hour rate -- the real "1hr cooldown" anchor, not an
  // arbitrary tuning pick. stunDurationTicks(30) is deliberately much shorter than the cooldown
  // (a "brief" incapacitation per the task brief, not a lockdown) -- picked in the same
  // neighborhood as siege.js's HELD_CITIZEN_BEAT_PAUSE_TICKS(30), this project's existing
  // "~3-second dramatic beat" unit.
  [WeaponTier.StunBaton]: Object.freeze({
    label: 'Stun Baton', damageMult: 0, rangeMult: 0.85, cooldownMult: 25, penetrationBonus: 0,
    nonLethal: true, stunChance: 0.4, stunDurationTicks: 30,
  }),
});

// Weakest -> strongest; how far up this list a guard/sniper can be issued is gated by how many
// Armories the settlement has actually built (see tickArmoryIssuance). StunBaton is deliberately
// NOT in this progression list -- see its doc comment on WeaponTier above -- tickArmoryIssuance
// special-cases it separately, gated on "at least one Armory exists" rather than a stock rung.
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
    // Manual weapon-tier override (RimWorld-style "player picks this one's gear" ask): citizenId
    // -> WeaponTier the PLAYER explicitly requested, distinct from `_weaponById` above (which is
    // the tier they're actually currently carrying -- may lag behind the request, see
    // tickArmoryIssuance's queueing behavior). A citizen with no entry here is untouched and keeps
    // the fully-automatic armory-count-based assignment exactly as before -- this map only ever
    // holds staff the player has actually clicked an override for.
    this._manualWeaponById = new Map();
    this._patrolIndexById = new Map(); // citizenId -> index of the waypoint currently being walked to
    this._patrolPauseById = new Map(); // citizenId -> ticks spent paused at the current waypoint
    this._offDutyById = new Set(); // citizenId currently clocked off, recovering hunger/rest like a normal citizen

    // Corrupt/bribable staff (Prison Architect's "Crooked Guards", reskinned -- see the
    // tickStaffCorruption doc comment near the bottom of this file for the full mechanic).
    this._corruptEvaluated = new Set();     // citizenId already run through the one-time hire-ratio roll
    this._corruptEligible = new Set();      // citizenId flagged "crooked" -- capable of going actively corrupt
    this._corruptActiveUntil = new Map();   // citizenId -> tick an active bribe period ends
    this._corruptDiscovered = new Set();    // citizenId caught mid-bribe, awaiting the player firing them

    // Staff training-program track (programs.js's ProgramKind.GuardResponseTraining, see
    // tickStaffTraining near the bottom of this file): citizenId -> true once this staffer has
    // graduated the full course. Distinct from citizens.js's store.programSessionsDone (which
    // resets to 0 after every completed course, citizen-facing programs included) -- this is a
    // one-way "already trained" flag tickStaffTraining reads so it stops re-dispatching a
    // graduate, matching the task's "cheap item" scope: one course, not a repeatable grind.
    this._trainingGraduated = new Set();
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

  // ---- manual weapon-tier override (see tickArmoryIssuance) ----
  // Player-requested tier, or null if this staffer has never been manually touched (still fully
  // automatic).
  manualWeaponOf(citizenId) {
    return this._manualWeaponById.get(citizenId) ?? null;
  }

  setManualWeapon(citizenId, tier) {
    this._manualWeaponById.set(citizenId, tier);
  }

  // Hands a staffer back to fully-automatic armory-count-based assignment.
  clearManualWeapon(citizenId) {
    this._manualWeaponById.delete(citizenId);
  }

  // True while a manual override is set but the armory doesn't yet stock enough of that tier to
  // actually issue it -- tickArmoryIssuance falls back to the best tier it CAN issue in the
  // meantime and keeps re-checking every tick, so this flips false on its own once enough
  // Armories are built (or the player lowers the request).
  isManualWeaponPending(citizenId) {
    const requested = this._manualWeaponById.get(citizenId);
    if (requested == null) return false;
    return this._weaponById.get(citizenId) !== requested;
  }

  // ---- corrupt/bribable staff (see tickStaffCorruption below) ----
  isCorruptEligible(citizenId) { return this._corruptEligible.has(citizenId); }
  isCorruptActive(citizenId) { return this._corruptActiveUntil.has(citizenId); }
  isCorruptDiscovered(citizenId) { return this._corruptDiscovered.has(citizenId); }

  // ---- staff training (see tickStaffTraining below) ----
  isTrainingGraduated(citizenId) { return this._trainingGraduated.has(citizenId); }
  markTrainingGraduated(citizenId) { this._trainingGraduated.add(citizenId); }
}

// Armory issuance. Originally (per FEATURE_RESEARCH.md) scoped as no per-citizen pick-a-tier UI
// -- every Guard/Sniper on the roster with no manual override just gets whatever tier the
// settlement's Armory count supports. That automatic behavior is UNCHANGED below for anyone the
// player hasn't touched. RimWorld-style manual override (later ask): a staffer with a
// `roster._manualWeaponById` entry gets THAT tier instead, but never above what current armory
// stock actually supports -- there's no per-unit weapon inventory in this game (an Armory unlocks
// a whole rung of WEAPON_TIER_ORDER for everyone, not N individual weapons), so "stock" for a
// tier here means "the armory count has unlocked that rung", the same real gate the automatic
// path already uses. If the player requests a tier stock doesn't support yet, this QUEUES the
// request (documented choice, not a straight reject): the staffer keeps the best tier stock
// currently allows and is auto-promoted to the requested tier the moment enough Armories exist,
// with zero further action needed -- natural to implement since this function already re-runs
// every tick anyway, and it means the player's choice is never silently lost or requires them to
// remember to re-click it later. Every built (not destroyed/under-construction) Armory unlocks
// one more rung of WEAPON_TIER_ORDER, so a second Armory is a real strategic payoff, not just a
// cosmetic duplicate. Runs every tick (world.js) so a freshly-assigned guard, a freshly-completed
// Armory, or a fresh manual override all propagate immediately, and a destroyed Armory correctly
// downgrades everyone (auto AND manual-but-now-unsupported) back rather than leaving them
// permanently over-equipped -- no weapon is ever "created out of thin air" beyond what the
// armory count actually backs.
export function tickArmoryIssuance(roster, structures) {
  let armoryCount = 0;
  for (const s of structures) {
    if (s.kind === 'armory' && !s.destroyed && !s.underConstruction) armoryCount++;
  }
  const stockTierIndex = Math.min(WEAPON_TIER_ORDER.length - 1, armoryCount);
  const autoTier = WEAPON_TIER_ORDER[stockTierIndex];
  for (const [citizenId, kind] of roster._roleById.entries()) {
    if (kind !== StaffRoleKind.Guard && kind !== StaffRoleKind.Sniper) continue;
    const manualTier = roster.manualWeaponOf(citizenId);
    if (manualTier == null) {
      roster.equip(citizenId, autoTier);
      continue;
    }
    // Stun Baton (WeaponTier.StunBaton): outside WEAPON_TIER_ORDER's stock-rung progression, so
    // it can't be looked up by index below. Real gate: needs at least one Armory built at all
    // (the same "an Armory is what lets you issue anything beyond bare hands" premise the
    // automatic path uses), independent of how many Armories -- a second/third Armory unlocks
    // Rifle/Heavy stock, not "more" non-lethal capability. Falls back to the best tier the armory
    // DOES support (same queueing behavior as an unsupported Rifle/Heavy request) if no Armory
    // exists yet.
    if (manualTier === WeaponTier.StunBaton) {
      roster.equip(citizenId, armoryCount >= 1 ? WeaponTier.StunBaton : autoTier);
      continue;
    }
    const manualIndex = WEAPON_TIER_ORDER.indexOf(manualTier);
    // Clamp to whatever the armory actually stocks right now -- issues the requested tier
    // immediately if stock covers it, otherwise the best available tier while the request queues.
    const grantedIndex = Math.min(manualIndex, stockTierIndex);
    roster.equip(citizenId, WEAPON_TIER_ORDER[grantedIndex]);
  }
}

// ---------------------------------------------------------------- ammo economy (this session's pass)
// Real design call (see siege.js's AMMO_PER_SHOT_* doc comment for the full reasoning): a single
// global stockpile (world.ammo/world.ammoCapacity), not a per-turret/per-guard inventory --
// consistent with how Armory-issued weapon TIERS already work roster-wide off a single
// armory-count-derived rung rather than per-unit stock. Production/capacity both scale with the
// number of built (not destroyed/under-construction) Armories, same "count real buildings, not a
// flag" pattern tickArmoryIssuance above already uses.
//
// AMMO_BASE_CAPACITY (a real starting reserve even with zero Armories, so a fresh colony's 4
// starter turrets aren't already dry the instant a wave arrives) + AMMO_CAPACITY_PER_ARMORY*N is
// the hard ceiling production can fill to; AMMO_PRODUCTION_PER_ARMORY*N is the per-tick trickle,
// same shape as world.js's own pollution-per-generator accumulation. Numbers picked against
// siege.js's real per-shot costs: a lone Armory's ~0.08/tick trickle (~4.8/game-minute at 10Hz)
// comfortably outpaces one turret's ~1-shot-per-TURRET_COOLDOWN_TICKS(8) burn rate in isolation,
// but a hands-off colony under sustained multi-defender fire (several turrets + guards/snipers all
// burning ammo every cooldown) will genuinely outrun a single Armory's production -- that gap is
// the whole point of the resource, verified via a real soak-test comparison (see the task's own
// verification checklist).
export const AMMO_BASE_CAPACITY = 40;
export const AMMO_CAPACITY_PER_ARMORY = 50;
export const AMMO_PRODUCTION_PER_ARMORY = 0.08;
// A zero-Armory colony (the hands-off soak-test baseline every prior balance pass this session
// was calibrated against -- see SESSION_HANDOFF.md) previously got literally 0 ammo regen forever
// once its starting AMMO_BASE_CAPACITY ran dry, permanently crippling turrets/guards to their
// dry-fire fallback for the rest of the game. Confirmed via a real 3-seed soak: survival collapsed
// from the established 22-36k tick range to ~11.4-12k, all wave 14. A small always-on trickle
// (1/4 of one Armory's own rate) keeps ammo scarcity real -- it still can't outrun sustained
// multi-defender fire on its own, so building an Armory stays a genuine, meaningful choice -- but
// stops an unattended colony's core defense from flatlining to zero regen permanently.
export const AMMO_BASE_PRODUCTION = 0.02;

// Called once per world tick (world.js), same "cheap, just re-derive every tick" placement as
// tickArmoryIssuance right above it (armoryCount is already a fresh per-tick structures scan there;
// this is a second, equally cheap one rather than threading the count through as a shared param,
// keeping both functions independently callable/testable). A destroyed Armory correctly shrinks
// world.ammoCapacity immediately -- if that drops world.ammo above the new ceiling, it's clamped
// down rather than left "banked" above cap (mirrors world.js's own pollution/nuclearWaste
// clamp-to-current-cap conventions elsewhere in this file's neighborhood).
export function tickAmmoProduction(world) {
  let armoryCount = 0;
  for (const s of world.structures) {
    if (s.kind === 'armory' && !s.destroyed && !s.underConstruction) armoryCount++;
  }
  world.ammoCapacity = AMMO_BASE_CAPACITY + armoryCount * AMMO_CAPACITY_PER_ARMORY;
  world.ammo = Math.min(world.ammoCapacity, world.ammo + AMMO_BASE_PRODUCTION + armoryCount * AMMO_PRODUCTION_PER_ARMORY);
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
    // Drafted (draft.js): a drafted guard/sniper/monitor leaves their post entirely and follows
    // direct player orders instead -- same "pulled out of autonomy, even mid-task" rule jobs.js
    // applies, just for the staff-duty side of things.
    if (store.isDraftedAt(i)) continue;
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
    // Drafted (draft.js): no needs-seeking at all while drafted, same rule as jobs.js's tickJobs
    // -- a drafted citizen doesn't get auto-dispatched off duty for food/rest either.
    if (store.isDraftedAt(i)) continue;
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

// Upgraded K9 tier (real PA anchor: RobotDog -- ~0.75x health / 1.3x endurance / 1.3x range /
// 1.2x speed vs a normal dog). This project's dogs have no damage-taking system of their own --
// nothing in the sim currently attacks a K9 unit, tickDogs below is bite-out only -- so
// K9_UPGRADE_HEALTH_MULT is stored as real per-dog data (dog.healthMult, readable/verifiable via
// window.__debug) rather than gated behind a whole new dog-combat system this scope doesn't call
// for; endurance/range/speed are all real, immediately measurable effects on tickDogs below (a
// shorter cooldown between bites, a longer detection range, a faster follow speed).
export const K9_UPGRADE_HEALTH_MULT = 0.75;
export const K9_UPGRADE_ENDURANCE_MULT = 1.3; // cuts effective cooldown -- more bites per minute
export const K9_UPGRADE_RANGE_MULT = 1.3;
export const K9_UPGRADE_SPEED_MULT = 1.2;
// Priced with trap(15)/turret(25) (economy.js BUILD_COST) -- upgrading a dog you already own is a
// real strategic investment in an existing K9, not a cheap add-on.
export const K9_UPGRADE_SCRAP_COST = 25;

// Upgrades an already-tamed dog (any entry in world.dogs) in place. Mirrors world.buyVest's
// per-unit-purchase shape (spend scrap, flip a flag) rather than economy.js's structure-purchase
// path, since a dog isn't a Structure. Returns { ok: true } or { ok: false, reason }.
export function upgradeDog(world, dog) {
  if (!dog) return { ok: false, reason: 'invalid' };
  if (dog.upgraded) return { ok: false, reason: 'already' };
  if (world.scrap < K9_UPGRADE_SCRAP_COST) return { ok: false, reason: 'cost' };
  world.scrap -= K9_UPGRADE_SCRAP_COST;
  if (world.finance) world.finance.buildSpend += K9_UPGRADE_SCRAP_COST;
  dog.upgraded = true;
  dog.healthMult = K9_UPGRADE_HEALTH_MULT;
  return { ok: true };
}

// K9 units: each dog follows its handler loosely and bites the nearest attacker in range,
// fast and cheap per-hit compared to a guard's sidearm -- matches the GDD's non-carceral
// civil-protection-force framing ("guards/snipers/K9/CCTV", never inmates).
// rng: threaded through to siege.js's armor-vs-penetration roll for determinism; defaults to
// Math.random so existing call sites (tests/console pokes) keep working unchanged.
export function tickDogs(dogs, citizens, roster, attackers, onScrap, rng = Math.random) {
  for (const dog of dogs) {
    const ownerIdx = findCitizenIndexById(citizens, dog.ownerId);
    if (ownerIdx < 0 || !citizens.isAliveAt(ownerIdx)) continue;

    // Upgraded K9 stats (see K9_UPGRADE_* above) -- unupgraded dogs get exactly the old constants
    // unchanged, byte-for-byte, so this is backward compatible with every existing save/dog.
    const range = dog.upgraded ? DOG_RANGE * K9_UPGRADE_RANGE_MULT : DOG_RANGE;
    const speed = dog.upgraded ? DOG_SPEED * K9_UPGRADE_SPEED_MULT : DOG_SPEED;
    const cooldownMax = dog.upgraded ? Math.max(1, Math.round(DOG_COOLDOWN / K9_UPGRADE_ENDURANCE_MULT)) : DOG_COOLDOWN;

    const dx = citizens.x[ownerIdx] - dog.x;
    const dy = citizens.y[ownerIdx] - dog.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1.2) {
      dog.x += (dx / dist) * speed;
      dog.y += (dy / dist) * speed;
    }

    if (dog.cooldown > 0) { dog.cooldown--; continue; }
    let bestI = -1, bestDist = range;
    for (let i = 0; i < attackers.count; i++) {
      if (!attackers.isAliveAt(i)) continue;
      const d = Math.hypot(attackers.x[i] - dog.x, attackers.y[i] - dog.y);
      if (d < bestDist) { bestDist = d; bestI = i; }
    }
    if (bestI >= 0) {
      dog.cooldown = cooldownMax;
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

// --- Checkpoint (real PA DLC prefab catalog: ScannerMachine/MetalDetector/CheckPoint -- a
// screening chokepoint, reskinned with zero carceral framing: it's a security checkpoint for a
// civil settlement, not a prison search station) ---
//
// Real, measurable hook (not flavor text): a corrupt staffer's periodic scrap diversion (see
// tickStaffCorruption's active-bribe loop above) is reduced by CHECKPOINT_DIVERSION_REDUCTION
// whenever that staffer's current position is within CHECKPOINT_RADIUS of a built, undestroyed,
// non-under-construction Checkpoint -- the screening chokepoint genuinely has to be somewhere the
// staffer actually passes for it to catch anything, same "placed at a chokepoint" framing the task
// asked for. factions.js's applyUnmetConsequence reuses this same isNearCheckpoint/any-checkpoint-
// built helper for its own real reduction (see that file).
export const CHECKPOINT_RADIUS = 3.5; // grid cells -- same ballpark as DOG_RANGE(2.5)*K9_UPGRADE_RANGE_MULT(1.3), a screening post covers a real but modest area, not the whole map
export const CHECKPOINT_DIVERSION_REDUCTION = 0.65; // 65% cut to a corrupt staffer's per-siphon amount while screened

// True if `structures` contains at least one built (not destroyed, not under construction)
// Checkpoint within CHECKPOINT_RADIUS of (x, y). Exported so factions.js can reuse the exact same
// spatial check for its own unmet-demand consequence reduction, rather than re-deriving it.
export function isNearCheckpoint(structures, x, y) {
  for (const s of structures) {
    if (s.kind !== 'checkpoint' || s.destroyed || s.underConstruction) continue;
    if (Math.hypot(s.x - x, s.y - y) <= CHECKPOINT_RADIUS) return true;
  }
  return false;
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
      // Checkpoint (see isNearCheckpoint/CHECKPOINT_DIVERSION_REDUCTION above): a corrupt staffer
      // physically standing/patrolling within a Checkpoint's screening radius right now gets a
      // real, measured cut to what they're able to quietly siphon this tick.
      const screened = isNearCheckpoint(world.structures, store.x[idx], store.y[idx]);
      const baseAmt = Math.min(world.scrap, CORRUPTION_DIVERSION_AMOUNT);
      const amt = screened ? baseAmt * (1 - CHECKPOINT_DIVERSION_REDUCTION) : baseAmt;
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
  roster._manualWeaponById.delete(citizenId);
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

// --- Staff training-program track (Prison Architect reform_programs_dlc.txt's real staff-facing
// training tracks, distinct from programs.js's citizen-facing programs -- see
// ProgramKind.GuardResponseTraining there) ---
//
// Staff never reach jobs.js's Idle branch while on duty (world.js's isStaffOnDutyAt gates
// staffOnDuty(i) true for anyone not off-duty, and tickJobs's very first per-citizen check
// `if (staffOnDuty(i)) continue;` skips them entirely) -- so unlike a citizen, who opportunistically
// finds a joinable program site through jobs.js's own findJoinableSite call, an eligible
// Guard/Sniper/Monitor needs to be dispatched here directly, same shape as dispatchStaffToNeed's
// food/rest trip above. The trick: temporarily flip roster.setOffDuty(id, true) -- that's the one
// existing signal that makes world.js's isStaffOnDutyAt go false, which is what actually lets
// tickJobs process this citizen's SeekingProgram/Attending state machine (programs.js's exact same
// machinery every citizen-facing program already uses). tickStaffOffDuty's own existing "back to
// Idle -> resume on-duty if no food/rest need" branch (see above) then hands them back to
// tickStaffDuty's patrol automatically once jobs.js resets jobState to Idle -- no new "resume"
// code needed here, that plumbing already existed for the food/rest case and is generic.
const TRAINABLE_ROLES = new Set([StaffRoleKind.Guard, StaffRoleKind.Sniper, StaffRoleKind.Monitor]);

function findTrainingSite(world) {
  if (!world.programSites) return null;
  for (const site of world.programSites) {
    if (site.kind !== 'guard_response_training') continue;
    if (site.attendeeIds.length >= PROGRAM_DEFS[site.kind].places) continue;
    if (!isSiteStaffed(world, site)) continue;
    return site;
  }
  return null;
}

// Called once per world tick (world.js), after tickStaffOffDuty and before tickJobs -- same
// ordering reasoning as tickStaffOffDuty's own doc comment (the dispatch needs to land before
// tickJobs runs the same tick so the fresh SeekingProgram state actually gets walked). Cheap:
// bails instantly if no training site exists yet (the common case for most of a run), and even
// once one does, only iterates the (small) roster-eligible population, same cost shape as
// tickArmoryIssuance above.
export function tickStaffTraining(world, idOf) {
  if (!world.programSites || world.programSites.length === 0) return;
  const roster = world.roster;
  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i) || store.isDownedAt(i) || store.isDraftedAt(i)) continue;
    const id = idOf(i);
    if (!roster.isStaff(id)) continue;
    if (!TRAINABLE_ROLES.has(roster.kindOf(id))) continue;
    if (roster.isTrainingGraduated(id)) continue; // one course is enough, see the StaffRoster doc comment
    if (roster.isOffDuty(id)) continue; // busy with a genuine food/rest trip, don't interrupt it
    // On-duty staff's jobState is otherwise untouched by tickStaffDuty (it only moves store.x/y),
    // so Idle here means "currently just holding post/patrol, free to dispatch" -- same bar
    // dispatchStaffToNeed implicitly relies on for the food/rest case via the off-duty flag.
    if (store.jobState[i] !== JobState.Idle) continue;

    const site = findTrainingSite(world);
    if (!site) continue;

    const target = roomPostFor(site.room, world.grid);
    store.jobState[i] = JobState.SeekingProgram;
    store.targetX[i] = target.x; store.targetY[i] = target.y;
    store._jobRef[i] = site;
    store.programSite[i] = site;
    roster.setOffDuty(id, true);
  }
}
