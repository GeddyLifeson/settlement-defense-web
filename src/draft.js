// ============================================================================================
// draft.js -- RimWorld-style Draft/Undraft manual-control command system.
//
// PUBLIC INTERFACE (import these from other modules -- this is the whole surface later agents
// should build against; everything else in this file is a private implementation detail):
//   isDrafted(world, citizenId) -> bool
//   draftCitizen(world, citizenId) -> bool        (false if citizenId doesn't resolve to a living citizen)
//   undraftCitizen(world, citizenId) -> bool       (same)
//   issueMoveOrder(world, citizenIds, x, y) -> void        (citizenIds: array of citizen ids; ids
//                                                            that aren't drafted are silently skipped)
//   issueAttackOrder(world, citizenIds, targetAttackerIndex) -> void  (same skip rule; see the
//                                                            AttackerStore-index caveat below)
//   cancelOrder(world, citizenId) -> void          (drop the current order, citizen holds position)
//   tickDrafted(world) -> void                     (call once per tick from world.js's tick();
//                                                    owns ALL movement/combat for drafted citizens)
//
// DESIGN NOTES for whoever builds on this next:
//   - A drafted citizen is flagged via citizens.js's CitizenFlags.Drafted (store.isDraftedAt(i)).
//     jobs.js's tickJobs, security.js's tickStaffDuty/tickStaffOffDuty, siege.js's tickStaffCombat,
//     and world.js's tickWander skipIf callback ALL check this flag and skip a drafted citizen
//     entirely -- that is the "removed from autonomy" half of the system, already wired at each of
//     those call sites, nothing else to do there. This file owns the OTHER half: what a drafted
//     citizen actually does each tick (stand still by default, or execute whichever order -- Move
//     or Attack -- is currently active).
//   - Per-citizen order state (orderKind/orderTargetX/orderTargetY/orderAttackIndex) lives on
//     CitizenStore itself (citizens.js), as plain SoA fields -- same shape/precedent as jobState/
//     _jobRef. orderKind: 0 = none ("stand and hold"), 1 = Move, 2 = Attack.
//   - Attack orders target an INDEX into world.attackers (siege.js's AttackerStore), not a stable
//     id -- AttackerStore has no id field (nothing else in this codebase needed one; every existing
//     combat call site -- tickTurrets, tickStaffCombat, tickAttackers -- just uses the live index
//     the same tick it's found). This is a real, documented limitation: AttackerStore.spawn()
//     recycles a dead slot once the store is at its 1024 capacity, so in the extreme case a stored
//     orderAttackIndex could, a tick later, refer to a freshly-spawned unrelated attacker rather
//     than the original target. That requires 1024 simultaneously-live attackers, which no wave in
//     this game's balance ever approaches -- an accepted edge case, not something worth an
//     AttackerStore schema change to close for this pass. A future pass wanting a bulletproof fix:
//     give AttackerStore its own `id` Uint32Array (mirroring CitizenStore.id) and switch
//     orderAttackIndex to an orderAttackId + a linear resolve, same pattern citizens already use.
//   - Movement reuses the exact same straight-line-toward-target approach every other travel state
//     in this game already uses (jobs.js's Seeking* states, citizens.js's tickWander) -- this
//     project has no pathfinding/grid-routing at all (grid.js's SettlementGrid only tracks tile
//     passability for placement/wall-blocking purposes, see its isBlocked/inBounds), so "reuse
//     whatever pathing this project already has" means direct-line movement, same as everywhere
//     else a citizen or attacker moves in this codebase.
//   - Combat reuses siege.js's real damage pipeline (damageAttacker/rollsHit/DamageType) and the
//     same GUARD_*/SNIPER_* baseline stats tickStaffCombat uses for on-duty guards/snipers --
//     draft.js does not invent a second combat-numbers table. A drafted Guard/Sniper fights with
//     their real armory-issued weapon tier (security.js's WEAPON_TIERS, same as tickStaffCombat);
//     any other drafted citizen fights with the unarmed-civilian baseline (GUARD_RANGE/DAMAGE/
//     COOLDOWN/PENETRATION) -- RimWorld itself lets you draft and fight with any colonist, armed or
//     not, so this mirrors that rather than restricting attack orders to staff only.
// ============================================================================================
import { CitizenFlags } from './citizens.js';
import { releaseCurrentJobClaim, JOB_SPEED, ARRIVE_DIST } from './jobs.js';
import { clearForcedJob } from './forcejob.js';
import {
  nearestAliveAttacker, damageAttacker, rollsHit, DamageType,
  GUARD_RANGE, GUARD_DAMAGE, GUARD_COOLDOWN, GUARD_PENETRATION,
  SNIPER_RANGE, SNIPER_DAMAGE, SNIPER_COOLDOWN, SNIPER_PENETRATION,
} from './siege.js';
import { WEAPON_TIERS } from './security.js';
import { PASSION_GAIN_MULT } from './backstories.js';
import { SCRAP_PER_KILL } from './economy.js';

export const OrderKind = Object.freeze({ None: 0, Move: 1, Attack: 2 });

// Group move-order formation spacing (world units, same scale as ARRIVE_DIST/the 0.8-unit citizen-
// pick radius in input.js) -- when 2+ drafted citizens are ordered to the same point, they'd
// otherwise all path to and stack on the exact same tile (colliding/blocking each other visually,
// even though this project has no real collision physics to get stuck on). A simple ring formation
// spreads them out instead: citizen 0 gets the exact clicked point, then each further citizen fans
// out onto a ring of `ring*6` evenly-spaced slots at `ring*FORMATION_SPACING` radius. Not meant to
// be a sophisticated RimWorld-style facing formation, just enough that a group order visibly reads
// as "the squad converges near here" rather than "everyone teleports onto one pixel".
const FORMATION_SPACING = 0.55;
function _formationOffset(index, total) {
  if (total <= 1 || index === 0) return [0, 0];
  let ring = 1, ringCapacity = 6;
  let idx = index;
  while (idx > ringCapacity) {
    idx -= ringCapacity;
    ring++;
    ringCapacity = ring * 6;
  }
  const angle = ((idx - 1) / ringCapacity) * Math.PI * 2;
  const radius = ring * FORMATION_SPACING;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

function _draftFindCitizenIndexById(citizens, id) {
  for (let i = 0; i < citizens.count; i++) if (citizens.id[i] === id) return i;
  return -1;
}

// ---------------------------------------------------------------- public interface

export function isDrafted(world, citizenId) {
  const i = _draftFindCitizenIndexById(world.citizens, citizenId);
  return i >= 0 && world.citizens.isDraftedAt(i);
}

// Drafts citizen `citizenId`: flips the Drafted flag and immediately releases whatever
// autonomous job (blueprint claim, workshop staffing, program attendance, etc.) they were mid-way
// through -- this is what makes the stop genuinely instant/mid-task rather than waiting for the
// next natural break point (releaseCurrentJobClaim, shared with jobs.js's own Duty-Roster sleep
// interrupt for exactly this reason -- see that function's doc comment in jobs.js).
// Returns false (no-op) if citizenId doesn't resolve to a currently-living citizen.
export function draftCitizen(world, citizenId) {
  const i = _draftFindCitizenIndexById(world.citizens, citizenId);
  if (i < 0 || !world.citizens.isAliveAt(i)) return false;
  const store = world.citizens;
  if (store.isDraftedAt(i)) return true; // already drafted, nothing to do
  releaseCurrentJobClaim(store, i, (idx) => world.idOf(idx));
  // Drop any pending Force Job too (forcejob.js) -- a drafted citizen never reaches jobs.js's
  // Idle branch (see that file's isDraftedAt skip), so a stale forced-job order would otherwise
  // sit unconsumed forever, and its render.js indicator would keep showing on a citizen the
  // player just took manual control of.
  clearForcedJob(store, i);
  store.flags[i] |= CitizenFlags.Drafted;
  store.orderKind[i] = OrderKind.None;
  store.orderAttackIndex[i] = -1;
  store.targetX[i] = store.x[i]; store.targetY[i] = store.y[i]; // hold position, no residual wander target
  return true;
}

// Undrafts citizen `citizenId`: clears the flag and any active order, handing them straight back
// to jobs.js's normal Idle branch next tick -- no special "resuming" state needed, Idle already
// re-evaluates needs/work from scratch every tick.
export function undraftCitizen(world, citizenId) {
  const i = _draftFindCitizenIndexById(world.citizens, citizenId);
  if (i < 0) return false;
  const store = world.citizens;
  store.flags[i] &= ~CitizenFlags.Drafted;
  store.orderKind[i] = OrderKind.None;
  store.orderAttackIndex[i] = -1;
  return true;
}

// Issues a move order to every drafted citizen in `citizenIds` (a plain array of citizen ids,
// e.g. from input.js's selectedCitizens/selectedCitizen mapped through world.idOf). Ids that
// don't resolve to a currently-drafted living citizen are silently skipped -- this is meant to be
// called directly off a multi-select without the caller having to pre-filter.
// When 2+ citizens actually receive the order, each gets a slightly different target point (see
// _formationOffset above) instead of the literal (x, y) so a group order reads as a coordinated
// move rather than everyone stacking on one tile. Resolved against the REAL post-filter headcount
// (not citizenIds.length), so a mixed selection with only one drafted citizen in it still gets the
// exact clicked point, not an off-center formation slot for a "group" of one.
export function issueMoveOrder(world, citizenIds, x, y) {
  const store = world.citizens;
  const targets = [];
  for (const id of citizenIds) {
    const i = _draftFindCitizenIndexById(store, id);
    if (i < 0 || !store.isAliveAt(i) || !store.isDraftedAt(i)) continue;
    targets.push(i);
  }
  for (let k = 0; k < targets.length; k++) {
    const i = targets[k];
    const [ox, oy] = _formationOffset(k, targets.length);
    store.orderKind[i] = OrderKind.Move;
    store.orderTargetX[i] = x + ox; store.orderTargetY[i] = y + oy;
    store.orderAttackIndex[i] = -1;
  }
}

// Issues an attack order to every drafted citizen in `citizenIds` against `targetAttackerIndex`
// (an index into world.attackers -- see the AttackerStore-index caveat in this file's header
// comment). Ids that don't resolve to a currently-drafted living citizen are silently skipped.
export function issueAttackOrder(world, citizenIds, targetAttackerIndex) {
  if (targetAttackerIndex == null || targetAttackerIndex < 0 || !world.attackers.isAliveAt(targetAttackerIndex)) return;
  const store = world.citizens;
  for (const id of citizenIds) {
    const i = _draftFindCitizenIndexById(store, id);
    if (i < 0 || !store.isAliveAt(i) || !store.isDraftedAt(i)) continue;
    store.orderKind[i] = OrderKind.Attack;
    store.orderAttackIndex[i] = targetAttackerIndex;
  }
}

// Drops the current order for one drafted citizen -- they hold position exactly where they are
// (RimWorld's "drafted, no order" stance) rather than resuming autonomy; undraftCitizen is the
// separate call for that.
export function cancelOrder(world, citizenId) {
  const i = _draftFindCitizenIndexById(world.citizens, citizenId);
  if (i < 0) return;
  const store = world.citizens;
  store.orderKind[i] = OrderKind.None;
  store.orderAttackIndex[i] = -1;
  store.targetX[i] = store.x[i]; store.targetY[i] = store.y[i];
}

// ---------------------------------------------------------------- per-tick simulation

// Called once per tick from world.js's tick(), after tickJobs/tickStaffDuty/tickStaffCombat (all
// of which already skip drafted citizens themselves, see this file's header comment) -- this is
// the only place a drafted citizen's position or the world's attacker health actually changes as
// a direct result of drafted state. A drafted citizen with no active order (orderKind === None)
// simply doesn't move and doesn't fight, matching RimWorld's own "drafted, standing at attention"
// baseline.
export function tickDrafted(world) {
  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (!store.isDraftedAt(i)) continue;
    if (store.isDownedAt(i)) continue; // downed, can't act on an order until recovered, same as every other combat/job system

    if (store.orderKind[i] === OrderKind.Move) {
      _tickMoveOrder(store, i);
    } else if (store.orderKind[i] === OrderKind.Attack) {
      _tickAttackOrder(world, i);
    }
    // OrderKind.None: stand and hold, nothing to do.
  }
}

function _tickMoveOrder(store, i) {
  const dx = store.orderTargetX[i] - store.x[i];
  const dy = store.orderTargetY[i] - store.y[i];
  const dist = Math.hypot(dx, dy);
  if (dist < ARRIVE_DIST) {
    store.orderKind[i] = OrderKind.None; // arrived -- order complete, awaiting the next one
    return;
  }
  // Same straight-line travel speed jobs.js's Seeking* states use (JOB_SPEED), scaled by the same
  // per-citizen speed trait every other travel state already respects -- a drafted citizen isn't
  // exempt from their own trait's speedMult just because they're under manual control.
  const speed = JOB_SPEED * (store.trait[i]?.speedMult ?? 1);
  store.x[i] += (dx / dist) * speed;
  store.y[i] += (dy / dist) * speed;
}

function _tickAttackOrder(world, i) {
  const store = world.citizens;
  const attackers = world.attackers;
  const targetI = store.orderAttackIndex[i];

  // Target already dead (killed by this citizen, a turret, another drafted citizen, etc.) --
  // order complete, same "arrived/done" resolution as a finished move order.
  if (targetI < 0 || !attackers.isAliveAt(targetI)) {
    store.orderKind[i] = OrderKind.None;
    store.orderAttackIndex[i] = -1;
    return;
  }

  // Weapon stats: a drafted Guard/Sniper fights with their real armory-issued tier (same source
  // tickStaffCombat in siege.js reads), any other drafted citizen fights unarmed-civilian
  // baseline -- see this file's header comment for why that's the deliberate choice, not a gap.
  const kind = world.roster.kindOf(world.idOf(i));
  const isSniper = kind === 'Sniper';
  const tier = (kind === 'Guard' || kind === 'Sniper')
    ? (WEAPON_TIERS[world.roster.weaponOf(world.idOf(i))] || WEAPON_TIERS.Sidearm)
    : WEAPON_TIERS.Sidearm;
  const range = (isSniper ? SNIPER_RANGE : GUARD_RANGE) * tier.rangeMult;
  const damage = (isSniper ? SNIPER_DAMAGE : GUARD_DAMAGE) * tier.damageMult;
  const cooldown = Math.round((isSniper ? SNIPER_COOLDOWN : GUARD_COOLDOWN) * tier.cooldownMult);
  const dtype = isSniper ? DamageType.Energy : DamageType.Kinetic;
  // Mirrors tickStaffCombat's weapon-tier penetration bonus (security.js WEAPON_TIERS) -- see
  // that function's comment in siege.js.
  const penetration = (isSniper ? SNIPER_PENETRATION : GUARD_PENETRATION) + (tier.penetrationBonus || 0);

  const dx = attackers.x[targetI] - store.x[i];
  const dy = attackers.y[targetI] - store.y[i];
  const dist = Math.hypot(dx, dy);

  if (dist > range) {
    // Not in range yet -- close the distance, same travel speed/trait handling as a move order.
    const speed = JOB_SPEED * (store.trait[i]?.speedMult ?? 1);
    store.x[i] += (dx / dist) * speed;
    store.y[i] += (dy / dist) * speed;
    return;
  }

  // In range: fight, same cooldown/hit-roll/damage pipeline tickStaffCombat uses.
  if (store._staffCooldown[i] > 0) { store._staffCooldown[i]--; return; }
  store._staffCooldown[i] = cooldown;
  if (rollsHit(world.rng, 1) && damageAttacker(attackers, targetI, damage, dtype, penetration, world.rng)) {
    store.skillCombat[i] += 0.05 * PASSION_GAIN_MULT[store.passionCombat[i]];
    world.addScrap?.(SCRAP_PER_KILL, 'kill'); // same reward every other kill source pays out
    world.onKill?.();
    store.orderKind[i] = OrderKind.None; // target down -- order complete
    store.orderAttackIndex[i] = -1;
  }
}
