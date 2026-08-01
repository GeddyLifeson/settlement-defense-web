// ============================================================================================
// forcejob.js -- RimWorld-style "Prioritize" one-shot job override.
//
// RimWorld lets the player right-click an UNDRAFTED colonist and "Prioritize" a specific job --
// forcing them to do THIS blueprint/haul/etc next, jumping the autonomous priority queue, without
// drafting them out of the AI entirely (drafting is draft.js's separate, much bigger hammer: full
// manual control, no autonomy at all until undrafted). Force Job is much smaller: "do this one
// thing next, then resume normal autonomous priority" -- a single pending override consumed the
// next time jobs.js's tickJobs evaluates that citizen's Idle branch, then cleared either way.
//
// PUBLIC INTERFACE:
//   ForceJobKind: { Blueprint, Node, Room, Workshop }
//   forceJob(world, citizenId, targetKind, targetRef) -> bool
//   clearForcedJob(store, i) -> void
//   tryClaimForcedJob(store, i, world, idOf) -> bool   (called from jobs.js's Idle branch)
//   pickClosestUndraftedCitizen(world, citizenIds, targetX, targetY) -> id|null  (multi-select
//     "same target, only the closest one" rule, see input.js's wiring for why)
//
// DESIGN NOTES for whoever builds on this next:
//   - Storage lives on citizens.js's CitizenStore: forcedJobKind[i] (a ForceJobKind string or
//     null) + _forcedJobRef (a plain object map, index -> target object, same non-typed-array
//     precedent as jobState's own _jobRef) -- NOT draft.js's orderKind/orderTargetX/Y/
//     orderAttackIndex, a genuinely different concept: an order is executed by draft.js's own
//     tickDrafted every single tick for as long as it's active; a forced job is consumed ONCE by
//     jobs.js's normal tickJobs/claim machinery and then behaves exactly like any other
//     autonomously-claimed job from that point on (travels, works, completes, releases its claim
//     the same way findNearestBlueprint/findNearestNode/etc.-claimed jobs always have) -- no
//     separate execution loop needed here, it rides the existing SeekingX/X state pairs.
//   - One-shot, always consumed: tryClaimForcedJob clears forcedJobKind/_forcedJobRef the moment
//     it's called, whether or not the claim actually succeeds (the target may have vanished, been
//     claimed by someone else, or a room may have stopped being messy since the order was given)
//     -- there is no "retry next tick" loop, matching RimWorld's own Prioritize, which silently
//     drops the order if the job can no longer be done rather than nagging forever.
//   - Interrupts in-progress work immediately: forceJob calls jobs.js's releaseCurrentJobClaim if
//     the citizen isn't already Idle, exactly like draft.js's draftCitizen does when drafting a
//     citizen mid-task -- so the override genuinely jumps the queue THIS tick instead of waiting
//     for whatever they were doing to wrap up naturally.
//   - Refuses a drafted citizen outright (returns false) -- a drafted citizen never reaches
//     jobs.js's tickJobs Idle branch at all (see that function's isDraftedAt skip), so a forced
//     job on one would just sit unconsumed forever. input.js's own gesture-routing already only
//     offers Force Job when nothing in the current selection is drafted, but forceJob defends this
//     invariant itself too, rather than trusting every future caller to pre-filter correctly.
// ============================================================================================
import { JobState, releaseCurrentJobClaim } from './jobs.js';
import { roomCentroid } from './rooms.js';

export const ForceJobKind = Object.freeze({
  Blueprint: 'blueprint',
  Node: 'node',
  Room: 'room',
  Workshop: 'workshop',
});

function _forceJobFindCitizenIndexById(citizens, id) {
  for (let i = 0; i < citizens.count; i++) if (citizens.id[i] === id) return i;
  return -1;
}

export function clearForcedJob(store, i) {
  store.forcedJobKind[i] = null;
  store._forcedJobRef[i] = null;
}

// Marks targetRef as citizen citizenId's next forced job -- see file header for the full
// interrupt/one-shot semantics. Returns false (no-op) if citizenId doesn't resolve to a living,
// currently-undrafted citizen, or targetKind isn't one of ForceJobKind's values.
export function forceJob(world, citizenId, targetKind, targetRef) {
  if (!Object.values(ForceJobKind).includes(targetKind) || !targetRef) return false;
  const store = world.citizens;
  const i = _forceJobFindCitizenIndexById(store, citizenId);
  if (i < 0 || !store.isAliveAt(i) || store.isDraftedAt(i)) return false;
  // Interrupt whatever this citizen is doing right now -- same "instant, not next-natural-break"
  // release draft.js's draftCitizen uses when drafting a citizen mid-task. A forced job that only
  // took effect once the citizen happened to go Idle on their own wouldn't be jumping the queue.
  if (store.jobState[i] !== JobState.Idle) {
    releaseCurrentJobClaim(store, i, (idx) => world.idOf(idx));
  }
  store.forcedJobKind[i] = targetKind;
  store._forcedJobRef[i] = targetRef;
  return true;
}

// Called from jobs.js's Idle branch, right after the critical-hunger override check and before
// every other need/program/work-priority check below it -- a pending forced job jumps the entire
// autonomous ladder (Construction/Processing/Hauling/Harvesting/Animal/Cleaning, and a citizen's
// own Work Priorities override if they have one) but NOT a genuine starvation emergency, same
// "real crisis still wins" precedent CRITICAL_HUNGER_OVERRIDE already sets for everything else in
// that branch. Always consumes the pending job (clearForcedJob runs regardless of outcome) so a
// stale target can't sit there re-attempting forever.
export function tryClaimForcedJob(store, i, world, idOf) {
  const kind = store.forcedJobKind[i];
  if (!kind) return false;
  const target = store._forcedJobRef[i];
  clearForcedJob(store, i);

  if (kind === ForceJobKind.Blueprint) {
    if (!target || target.destroyed || !target.underConstruction) return false;
    if (target.claimedBy != null && target.claimedBy !== idOf(i)) return false; // beaten to it
    target.claimedBy = idOf(i);
    store.jobState[i] = JobState.SeekingBuild;
    store.targetX[i] = target.x; store.targetY[i] = target.y;
    store._jobRef[i] = target;
    return true;
  }
  if (kind === ForceJobKind.Node) {
    if (!target || target.depleted) return false;
    store.jobState[i] = JobState.SeekingScrap;
    store.targetX[i] = target.x; store.targetY[i] = target.y;
    store._jobRef[i] = target;
    return true;
  }
  if (kind === ForceJobKind.Room) {
    if (!target || !world.rooms.includes(target)) return false;
    const centroid = roomCentroid(target, world.grid);
    store.jobState[i] = JobState.SeekingClean;
    store.targetX[i] = centroid.x; store.targetY[i] = centroid.y;
    store._jobRef[i] = target;
    return true;
  }
  if (kind === ForceJobKind.Workshop) {
    if (!target || target.destroyed || target.underConstruction || target.workerId != null) return false;
    target.workerId = idOf(i);
    store.jobState[i] = JobState.SeekingWorkshop;
    store.targetX[i] = target.x; store.targetY[i] = target.y;
    store._jobRef[i] = target;
    return true;
  }
  return false;
}

// Multi-citizen rule (input.js's right-click wiring, see that file's header comment on why): when
// several undrafted citizens are selected and the player right-clicks a single job target, only
// the CLOSEST one should get the forced job -- forcing the same blueprint/room/station onto
// multiple citizens at once doesn't make sense given jobs.js's own single-claim `claimedBy`/
// `workerId` pattern (a resource node has no claim field, but "several citizens all forced onto
// the same node" is still a wasted order, not a useful one, same reasoning). Returns the closest
// living, undrafted citizen's id, or null if citizenIds is empty or none currently qualify.
export function pickClosestUndraftedCitizen(world, citizenIds, targetX, targetY) {
  const store = world.citizens;
  let bestId = null, bestDist = Infinity;
  for (const id of citizenIds) {
    const i = _forceJobFindCitizenIndexById(store, id);
    if (i < 0 || !store.isAliveAt(i) || store.isDraftedAt(i)) continue;
    const d = Math.hypot(store.x[i] - targetX, store.y[i] - targetY);
    if (d < bestDist) { bestDist = d; bestId = id; }
  }
  return bestId;
}
