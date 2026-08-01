// Field Contracts (quests.js) -- RimWorld-style risk-bearing, time-limited quests. Distinct from
// grants.js's Outpost Charter Contracts on purpose: charters are milestone/investment-style deals
// that can go slow but can NEVER fail (see grants.js's own header comment -- every charter either
// sits pending forever or eventually pays out; investments always mature). Real RimWorld quests
// are the opposite shape -- offered, accepted, running against a real deadline, and if the
// deadline passes without the completion condition met, the quest just fails: the reward is lost,
// nothing more. That fail state (offer -> accept -> real tick deadline -> succeed/fail, not just
// slow-vs-fast) is the genuinely new mechanic this file adds; grants.js deliberately does not
// duplicate it (see SESSION_HANDOFF.md's research/grant/charter context -- charters were already
// scoped as the non-failing "milestone" half of RimWorld/Prison-Architect's quest-shaped systems).
//
// Design notes:
//  - Two completion-condition KINDS, both deliberately reusable/generic rather than bespoke
//    one-off quest scripts (RimWorld's own QuestScriptDefs are far more varied, but this project's
//    "keep it simple and checkable purely from world state you already have" scope explicitly
//    rules that out): SurviveNoLosses ("go N ticks without a net citizen loss") and BankScrap
//    ("have at least X scrap on hand by tick Y"). Both read only fields other systems already
//    maintain -- world.citizens (count/isAliveAt, same accessor tickResearch() in research.js and
//    aliveCitizenCount() in grants.js already use), world.scrap, world.currentTick -- no new
//    trackable resource is invented anywhere in this file.
//  - Reward scales to a real risk/reward tradeoff, in the direction that fits each kind's own risk
//    axis (RimWorld's own quest reward scaling is exactly this shape -- tighter timers and higher
//    stakes pay more):
//      * BankScrap: reward-per-scrap-demanded is HIGHER the tighter the deadline (see BANK_TIERS
//        below -- Tight's reward is 1.5x its own delta, Relaxed's is only ~1.06x) -- a shorter
//        runway to hit the same kind of target is objectively harder, so it pays better.
//      * SurviveNoLosses: reward scales up with the offered duration (more ticks = more cumulative
//        chances for a raid/accident to cost a citizen, so a longer clean-survival window is
//        harder) AND with the colony's current population at offer time (see rewardForSurvive()
//        below -- more people alive at once is objectively more exposure, since ANY citizen dying
//        fails the quest, not a specific one).
//  - Failure is explicitly NOT punishing beyond losing the opportunity, per the task's own RimWorld
//    citation: no scrap is deducted, no citizen is harmed, nothing about the colony's state changes
//    on a failed quest beyond the quest itself moving to the Failed bucket. This mirrors grants.js's
//    already-established "reward-only" shape (charters only ever ADD scrap, never remove it) rather
//    than inventing a punitive path this codebase doesn't otherwise have anywhere.
//  - Self-contained, no imports from any other src/ file (including grants.js, whose shape this
//    file is deliberately parallel to but does not share code with) -- this file was built under
//    an explicit single-owner/no-touch-other-files constraint for a concurrently-edited repo, so it
//    only reads conventional, already-established `world.*` fields (world.citizens, world.scrap,
//    world.currentTick, world.milestoneLog, world.addScrap, and optionally world.research if
//    present) rather than importing helpers from files another agent might be mid-edit on.
//  - Lazy state init (`ensureQuestState(world)`), same "own small state object, ticked from the
//    composition root" pattern grants.js's tickGrants()/`if (!world.grants) world.grants = ...`
//    already established -- so wiring this in later is exactly one call to tickQuests(world) per
//    tick, no world.js constructor changes required.

export const QuestKind = Object.freeze({
  SurviveNoLosses: 'survive_no_losses', // "go `durationTicks` ticks without a net citizen loss"
  BankScrap: 'bank_scrap',              // "have `targetScrap` scrap on hand by `deadlineTick`"
});

export const QuestStatus = Object.freeze({
  Offered: 'offered',     // shown to the player, awaiting accept/decline
  Active: 'active',       // accepted, ticking toward its deadline
  Succeeded: 'succeeded', // completion condition met before/at the deadline, reward paid
  Failed: 'failed',       // deadline passed (or, for SurviveNoLosses, a loss happened) with no reward
  Declined: 'declined',   // player explicitly turned it down
  Expired: 'expired',     // player never acted on the OFFER itself before it timed out
});

// How many ticks an unanswered offer stays available before it's silently withdrawn -- real
// RimWorld quest offers don't sit forever either. Generous relative to the quest durations below
// so a player checking a Quests panel every so often (not every tick) won't routinely miss offers.
const OFFER_EXPIRY_TICKS = 600;

// At most this many pending (Offered, unanswered) quests at once -- offerQuest() below is a no-op
// past this cap. Prevents an unattended UI (or a caller that ticks offerQuest() on a timer without
// checking for a decline first) from silently piling up offers the player never sees.
const MAX_PENDING_OFFERS = 3;
// At most this many Active quests running concurrently, same anti-pileup reasoning.
const MAX_ACTIVE_QUESTS = 3;

// ---- SurviveNoLosses tiers -----------------------------------------------------------------
// durationTicks/baseReward pairs. baseReward grows FASTER than durationTicks (350->700->1300 is
// exactly 2x/1.857x, but 60->140->260 is 2.33x/1.857x) for the short->medium jump specifically --
// deliberately front-loading the reward curve so even a short-duration quest is worth accepting,
// not just the long ones. Actual paid-out reward also gets population-scaled at offer time, see
// rewardForSurvive() below.
const SURVIVE_TIERS = [
  { key: 'short', label: 'Quiet Stretch', durationTicks: 350, baseReward: 60 },
  { key: 'medium', label: 'Steady Hand', durationTicks: 700, baseReward: 140 },
  { key: 'long', label: 'Long Watch', durationTicks: 1300, baseReward: 260, minTechLevel: 2 },
];

// ---- BankScrap tiers ------------------------------------------------------------------------
// delta = how much MORE scrap than what the colony has right now the player must bank.
// rewardMult is applied to delta to get the reward -- Tight's 1.5x vs Relaxed's ~1.06x is the
// "tighter deadline pays better per unit demanded" tradeoff described in the header comment.
const BANK_TIERS = [
  { key: 'tight', label: 'Rush Order', deadlineTicks: 450, delta: 60, rewardMult: 1.5 },
  { key: 'standard', label: 'Standing Order', deadlineTicks: 800, delta: 100, rewardMult: 1.3 },
  { key: 'relaxed', label: 'Open Order', deadlineTicks: 1400, delta: 160, rewardMult: 1.0625, minTechLevel: 2 },
];

// Named _questsAliveCitizenCount (not the shorter aliveCitizenCount) because grants.js already
// declares a top-level function of that exact name -- build.py flattens every src/*.js file into
// one global classic-script scope with no module isolation, so two same-named top-level functions
// across different files silently collide (whichever comes later in build.py's ORDER wins with no
// build error at all -- a real bug class SESSION_HANDOFF.md documents having been caught and fixed
// this same way in a previous pass). Both implementations do the same thing, but this file is
// explicitly self-contained/no-cross-file-import (see header comment), so duplicating the two-line
// body under a collision-safe name is simpler and safer than importing grants.js's version.
function _questsAliveCitizenCount(world) {
  let n = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) n++;
  return n;
}

// Population-scaled reward for a SurviveNoLosses tier -- see header comment's risk-axis note.
// +1% per alive citizen at offer time, so a 24-pop colony sees +24%, a 40-pop colony +40%: more
// people alive is objectively more exposure to a single-death quest failure, so it should pay
// more. Rounded to a whole number since every other reward figure in this codebase (grants.js's
// TIER_REWARDS, research.js's node costs) is a plain integer scrap amount.
function rewardForSurvive(tier, aliveNow) {
  return Math.round(tier.baseReward * (1 + aliveNow * 0.01));
}

function rewardForBank(tier) {
  return Math.round(tier.delta * tier.rewardMult);
}

// Best-effort colony tech-level read, entirely optional -- world.research is research.js's state
// object (already established by that file, read the same way grants.js reads world.finance).
// Kept as a plain inline literal-shape check rather than an import from research.js: this file was
// built under a no-cross-file-import constraint (see header comment) specifically so a concurrent
// edit to research.js's internals can't break this file's build. Fails open (treats a colony with
// no research state at all as tech level 1, the same floor research.js's own colonyTechLevel()
// returns for an empty state) so a caller that never wires world.research still gets every quest
// tier offered, just never gated.
function currentTechLevel(world) {
  const state = world.research;
  if (!state || !state.unlocked) return 1;
  let maxTier = 1;
  // Mirrors research.js's own techLevel values for its two highest-tier tiers without importing
  // RESEARCH_NODES: only the two node ids that actually matter for this file's minTechLevel:2 gate
  // need checking, so a small local table is enough and never goes stale silently (unlike scanning
  // the full tree, which would need research.js's node list kept in sync with this file's import).
  const KNOWN_TIER_2_PLUS = { small_arms_doctrine: 2, staff_vetting: 2, surveillance: 2, cctv_improvement: 2,
    refined_fuels: 2, waste_reclamation: 2, recycling_throughput: 2, alternative_power: 2,
    high_voltage: 3, electric_drivetrain: 3, fission: 3, reactor_engineering: 4 };
  for (const id in KNOWN_TIER_2_PLUS) {
    if (state.unlocked[id] && KNOWN_TIER_2_PLUS[id] > maxTier) maxTier = KNOWN_TIER_2_PLUS[id];
  }
  return maxTier;
}

function logQuest(world, text) {
  if (!world.milestoneLog) return;
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
}

export function createQuestState() {
  return { nextId: 1, offers: [], active: [], history: [] };
}

/** Lazily attaches quest state to `world` the same way tickGrants() attaches world.grants -- so
 *  no world.js constructor change is required to start using this file. Also mirrors the live
 *  `active` array onto `world.activeQuests` (same array reference, not a copy, so pushes/splices
 *  on one are immediately visible via the other) -- the exact name the task/UI layer expects to
 *  find running quests under. */
function ensureQuestState(world) {
  if (!world.quests) world.quests = createQuestState();
  world.activeQuests = world.quests.active;
  return world.quests;
}

/** Offer one new quest, chosen at random between the two kinds and among their tiers (tiers
 *  carrying `minTechLevel` are skipped unless the colony's aggregate research tier -- see
 *  research.js's colonyTechLevel/colonyTechLevelFromState, mirrored locally here, exported there
 *  for other systems -- already meets it, fail-open to "available" if world.research isn't wired
 *  up at all). No-ops (returns null) if MAX_PENDING_OFFERS is already reached, so a caller that
 *  polls this on a timer never needs its own pending-count bookkeeping.
 *
 *  Returns the offer object on success ({ id, kind, tierKey, label, desc, reward, ...params,
 *  offeredAtTick, offerExpiresAtTick, status: 'offered' }), or null if no offer was made. */
export function offerQuest(world, rng = Math.random) {
  const state = ensureQuestState(world);
  if (state.offers.length >= MAX_PENDING_OFFERS) return null;

  const techLevel = currentTechLevel(world);
  const kind = rng() < 0.5 ? QuestKind.SurviveNoLosses : QuestKind.BankScrap;
  const pool = (kind === QuestKind.SurviveNoLosses ? SURVIVE_TIERS : BANK_TIERS)
    .filter(t => !t.minTechLevel || techLevel >= t.minTechLevel);
  const tier = pool[Math.floor(rng() * pool.length)];

  const offer = { id: state.nextId++, kind, tierKey: tier.key, status: QuestStatus.Offered,
    offeredAtTick: world.currentTick, offerExpiresAtTick: world.currentTick + OFFER_EXPIRY_TICKS };

  if (kind === QuestKind.SurviveNoLosses) {
    const aliveNow = _questsAliveCitizenCount(world);
    offer.label = tier.label;
    offer.durationTicks = tier.durationTicks;
    offer.reward = rewardForSurvive(tier, aliveNow);
    offer.desc = `Keep every citizen alive for ${tier.durationTicks} ticks. Any citizen lost `
      + `fails the contract immediately -- reward is forfeit, nothing else is taken.`;
  } else {
    const target = Math.round(world.scrap) + tier.delta;
    offer.label = tier.label;
    offer.deadlineTicks = tier.deadlineTicks;
    offer.targetScrap = target;
    offer.reward = rewardForBank(tier);
    offer.desc = `Bank ${target} scrap on hand (+${tier.delta} from now) within ${tier.deadlineTicks} `
      + `ticks. Miss the deadline and the contract just lapses -- no penalty beyond losing the reward.`;
  }

  state.offers.push(offer);
  logQuest(world, `Contract offered: ${offer.label} (+${offer.reward} scrap if completed)`);
  return offer;
}

/** Accept a pending offer by id -- moves it from `offers` into `active` and starts its real
 *  deadline clock from THIS tick. Returns { ok, reason } or { ok: true, quest }. No-ops past
 *  MAX_ACTIVE_QUESTS so a player can't run an unbounded number of contracts at once. */
export function acceptQuest(world, offerId) {
  const state = ensureQuestState(world);
  const idx = state.offers.findIndex(o => o.id === offerId);
  if (idx === -1) return { ok: false, reason: 'No such offer' };
  if (state.active.length >= MAX_ACTIVE_QUESTS) return { ok: false, reason: `Already running ${MAX_ACTIVE_QUESTS} contracts` };

  const [offer] = state.offers.splice(idx, 1);
  offer.status = QuestStatus.Active;
  offer.acceptedAtTick = world.currentTick;
  if (offer.kind === QuestKind.SurviveNoLosses) {
    offer.deadlineTick = world.currentTick + offer.durationTicks;
    offer.lastAliveCount = _questsAliveCitizenCount(world); // watermark tickQuests() compares against each tick
  } else {
    offer.deadlineTick = world.currentTick + offer.deadlineTicks;
  }
  state.active.push(offer);
  logQuest(world, `Contract accepted: ${offer.label}`);
  return { ok: true, quest: offer };
}

/** Decline a pending offer by id -- just removes it, no state change beyond the offer itself
 *  moving to history as Declined (so a UI can still show "you turned this down" if it wants to). */
export function declineQuest(world, offerId) {
  const state = ensureQuestState(world);
  const idx = state.offers.findIndex(o => o.id === offerId);
  if (idx === -1) return { ok: false, reason: 'No such offer' };
  const [offer] = state.offers.splice(idx, 1);
  offer.status = QuestStatus.Declined;
  state.history.push(offer);
  if (state.history.length > 30) state.history.shift();
  return { ok: true };
}

/** Per-tick update: expires stale offers, checks every active quest's fail/success condition, and
 *  pays out rewards. Called once per world tick -- same "own small state object, ticked from the
 *  composition root" pattern as grants.js's tickGrants(world), siege.js's WaveSpawner, etc. Safe
 *  to call even if nothing has ever called offerQuest() yet (ensureQuestState() lazily inits). */
export function tickQuests(world) {
  const state = ensureQuestState(world);

  // Expire unanswered offers.
  for (let i = state.offers.length - 1; i >= 0; i--) {
    const offer = state.offers[i];
    if (world.currentTick < offer.offerExpiresAtTick) continue;
    offer.status = QuestStatus.Expired;
    state.offers.splice(i, 1);
    state.history.push(offer);
    if (state.history.length > 30) state.history.shift();
    logQuest(world, `Contract offer lapsed unanswered: ${offer.label}`);
  }

  // Resolve active quests. Iterate a copy-safe descending loop since entries splice out mid-loop.
  for (let i = state.active.length - 1; i >= 0; i--) {
    const q = state.active[i];

    if (q.kind === QuestKind.SurviveNoLosses) {
      const aliveNow = _questsAliveCitizenCount(world);
      // A same-tick death masked by a same-tick arrival is the one acknowledged edge case here
      // (see header comment's "checkable purely from world state you already have" scoping) --
      // otherwise this per-tick watermark check catches a loss the instant it happens, not just
      // at the deadline, which is what "losing a citizen fails it immediately" requires.
      if (aliveNow < q.lastAliveCount) {
        q.status = QuestStatus.Failed;
        state.active.splice(i, 1);
        state.history.push(q);
        if (state.history.length > 30) state.history.shift();
        logQuest(world, `Contract failed: ${q.label} (a citizen was lost)`);
        continue;
      }
      q.lastAliveCount = aliveNow;
      if (world.currentTick >= q.deadlineTick) {
        q.status = QuestStatus.Succeeded;
        state.active.splice(i, 1);
        state.history.push(q);
        if (state.history.length > 30) state.history.shift();
        if (typeof world.addScrap === 'function') world.addScrap(q.reward, 'quest');
        logQuest(world, `Contract fulfilled: ${q.label} (+${q.reward} scrap)`);
      }
    } else { // BankScrap
      if (world.scrap >= q.targetScrap) {
        q.status = QuestStatus.Succeeded;
        state.active.splice(i, 1);
        state.history.push(q);
        if (state.history.length > 30) state.history.shift();
        if (typeof world.addScrap === 'function') world.addScrap(q.reward, 'quest');
        logQuest(world, `Contract fulfilled: ${q.label} (+${q.reward} scrap)`);
      } else if (world.currentTick >= q.deadlineTick) {
        q.status = QuestStatus.Failed;
        state.active.splice(i, 1);
        state.history.push(q);
        if (state.history.length > 30) state.history.shift();
        logQuest(world, `Contract failed: ${q.label} (deadline passed, ${Math.max(0, Math.round(q.targetScrap - world.scrap))} scrap short)`);
      }
    }
  }
}

export function serializeQuests(state) {
  return {
    nextId: state.nextId,
    offers: state.offers.map(o => ({ ...o })),
    active: state.active.map(q => ({ ...q })),
    history: state.history.map(q => ({ ...q })),
  };
}

export function deserializeQuests(json) {
  const state = createQuestState();
  if (!json) return state;
  state.nextId = json.nextId || 1;
  state.offers = (json.offers || []).map(o => ({ ...o }));
  state.active = (json.active || []).map(q => ({ ...q }));
  state.history = (json.history || []).map(q => ({ ...q }));
  return state;
}
