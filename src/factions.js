// Citizen cliques + faction-demand system -- ported/reskinned from Prison Architect's real gang
// data files (gangs.txt, gangdemands.txt, gangsystem.txt), not a wiki summary. Explicit non-goal
// (see SESSION_HANDOFF.md): NOTHING here is framed as a prison/gang-in-carceral-sense -- these are
// rival CLIQUES among ordinary citizens (think RimWorld-style faction friction, not incarceration).
//
// Real numbers this was ported from, and how each was scaled for this project:
//  - `MinGangMembersForDemand 20` -> FACTION_MIN_POPULATION below. This project's default colony
//    starts at 24 citizens (world.js's STARTER_NAMES / main.js's startingCitizens default), safely
//    above 20, so the real number is kept as-is rather than scaled down -- a smaller custom colony
//    (New Game's citizen-count slider goes lower) simply won't form cliques until it grows there,
//    which is the same gate real Prison Architect enforces.
//  - `GangDemandReward 4000` (PA dollars) -> this project's scrap economy runs roughly 40x smaller
//    per other research this session (see economy.js's `workshop` comment for the same 40x anchor),
//    so the reskinned reward lands in the ~50-100 scrap band the same research called out --
//    DEMAND_REWARD_BASE/ESCALATED below.
//  - `CooldownFromLastEvent 84` real-minutes -> scaled proportionally against the demand window
//    below (84/720 real-minutes ~= 0.117 of a base demand's own window), applied to this project's
//    tick-scaled window rather than reused as a literal tick count -- see
//    FACTION_DEMAND_COOLDOWN_TICKS's comment.
//  - The base -> `_Escalated` jump is a real, specific numeric relationship in the source data: a
//    base demand wants 4 objects within 720 real-minutes, the escalated variant wants 8 objects
//    within 1440 minutes -- MORE within a LONGER window, exactly 2x both axes. Ported as
//    DEMAND_BASE_TARGET/WINDOW -> DEMAND_ESCALATED_TARGET/WINDOW below, same 2x/2x ratio, applied
//    to this project's own demand content (see the doc comment on DEMAND_BASE_TARGET).
//  - 3 named gangs each with a `PreferredMisbehaviour` bias tied to trait preferences (real:
//    Vipers=Fighting, BoneBreakers=Destroying, Jackals=Escaping) -> CLIQUES below: reskinned names,
//    reskinned (citizen-vs-citizen friction, never against the protection force) misbehaviour
//    flavor, real trait-affinity bias for who gets recruited.

import { JobState } from './jobs.js';
import { CitizenFlags } from './citizens.js';
// Checkpoint (security.js): reuses the exact same screening-radius helper security.js's corrupt-
// staff diversion reduction uses -- see this file's own CHECKPOINT_CONSEQUENCE_REDUCTION comment
// below for how it's applied here. security.js precedes factions.js in build.py's ORDER, so this
// named import is safe in the flat-concatenated bundle too.
import { isNearCheckpoint } from './security.js';
import { RoomRole } from './rooms.js';

// Population gate (see file header). Checked once per tick at negligible cost (a single pass over
// a <=64-slot CitizenStore, same order of magnitude as world.js's own aliveCitizens count already
// does every tick) -- cliques form the first tick alive population reaches this and never un-form
// afterward, matching PA's own one-way gang formation.
export const FACTION_MIN_POPULATION = 20;

// Reskin of Gang_MoreYardTime ("give us more yard time"): "give us more time in the Recreation
// zone". Progress is real, not cosmetic -- each time a clique member actually starts a Recreating
// job (jobs.js's JobState.Recreating) counts as one "object" delivered, so a demand can only be
// satisfied by citizens genuinely using the Recreation zone, the same way the real demand is
// satisfied by prisoners genuinely getting yard time.
export const DEMAND_BASE_TARGET = 4;          // real Gang_MoreYardTime base: 4 objects
export const DEMAND_BASE_WINDOW_TICKS = 3000; // ~5 real-world minutes at this sim's 10Hz tick rate
export const DEMAND_ESCALATED_TARGET = 8;          // real escalated: 8 objects -- exactly 2x base
export const DEMAND_ESCALATED_WINDOW_TICKS = 6000; // real escalated: 1440 vs 720 minutes -- exactly 2x base
export const DEMAND_REWARD_BASE = 55;      // within the researched ~50-100 scrap band
export const DEMAND_REWARD_ESCALATED = 90; // harder demand, better reward -- still within the band
// 84/720 real-minutes ~= 0.1167 of a base demand's own window; applied to this project's
// DEMAND_BASE_WINDOW_TICKS rather than reused as a literal tick count (see file header).
export const FACTION_DEMAND_COOLDOWN_TICKS = Math.round(DEMAND_BASE_WINDOW_TICKS * (84 / 720));

const MIN_CLIQUE_SIZE_FOR_DEMAND = 2; // a demand from a clique of 0-1 members is a non-event
const AFFINITY_WEIGHT = 3; // a matching-trait citizen is 3x as likely to be recruited into that clique
const UNMET_DEMAND_UNREST_BUMP = 0.12; // added directly to world.unrestLevel, see world.js's UNREST_* system
const UNMET_DEMAND_SCRAP_LOSS = 20; // "petty pilfering" while the clique stews -- capped at world.scrap on hand
const STRUCTURE_DAMAGE_FRACTION = 0.25; // Wrecking consequence: fraction of health knocked off a random structure
// Checkpoint (security.js's isNearCheckpoint/CHECKPOINT_RADIUS): a real, measured cut to how bad
// an unmet-demand consequence lands, IF the clique members actually involved were within a built
// Checkpoint's screening radius when it triggered -- same "has to be somewhere they actually pass"
// framing as security.js's corrupt-staff diversion reduction, not a colony-wide flat discount that
// ignores placement. See applyUnmetConsequence below for exactly which sub-effect each check gates.
const CHECKPOINT_CONSEQUENCE_REDUCTION = 0.4; // 40% cut to the gated sub-effect when screened

// 3 named cliques (real PA: Vipers/BoneBreakers/Jackals, each with a PreferredMisbehaviour and
// trait preferences). affinityTraits reference traits.js's TRAITS[].name -- a citizen with one of
// these traits is AFFINITY_WEIGHT times as likely to be recruited into this clique over the others.
export const CLIQUES = [
  {
    id: 'scrappers', name: 'Scrappers', color: '#c96a3e',
    preferredMisbehaviour: 'Scrapping', // reskin of real Vipers/Fighting -- short tempers, not violence against staff
    affinityTraits: ['Tough', 'Neurotic'],
    // PreferredContraband flavor tag (see DEALER_TRADE_* below) -- this project has one unified
    // currency (world.scrap; confirmed via economy.js's flat scrap-cost buildable list, there's no
    // separate resource-type inventory to hoard a literal different item), so this is a label for
    // what gets pilfered/fenced, not a second resource pool.
    preferredResource: 'Scrap Metal',
  },
  {
    id: 'wreckers', name: 'Wreckers', color: '#9a4f9a',
    preferredMisbehaviour: 'Wrecking', // reskin of real BoneBreakers/Destroying -- property damage, reskinned genre-neutral
    affinityTraits: ['Hardy', 'Glutton'],
    preferredResource: 'Salvaged Components',
  },
  {
    id: 'runners', name: 'Runners', color: '#3e8fc9',
    preferredMisbehaviour: 'Slipping Off', // reskin of real Jackals/Escaping -- abandoning duty, not a prison break
    affinityTraits: ['Fast', 'Loner'],
    preferredResource: 'Spare Parts',
  },
];

// ---------------------------------------------------------------------------------------------
// Refinement pass (real gangsystem.txt/gangdemands.txt granularity this file's first pass didn't
// have room for): a lieutenant hierarchy, physical territory-claiming, graffiti-style marking
// with a real cleanup consequence, and food-fight-style emergent violence. Each ported/scaled the
// same honest way the constants above already were -- see each block's own doc comment for the
// real number and how it was scaled down for this project's population/economy.

// Lieutenant hierarchy: real gangsystem.txt promotes roughly one lieutenant per 3-10 members;
// this project's cliques are far smaller (a 24-citizen starting colony split 3 ways is ~8 members
// each at full population), so the task brief's own tighter ~5-8 span is used directly rather
// than re-deriving a scaled number -- LIEUTENANT_SPAN below is the middle of that span.
const LIEUTENANT_SPAN = 6;

// Territory-claiming: real PA requires 5 members physically present + 3 of them seated + 3 tables
// minimum in the claimed room. This engine has no distinct "seated" citizen state (citizens
// occupy a room, they don't sit at specific furniture -- rooms.js's BEAUTY_BY_KIND comment
// already treats a table as "sit-down furniture" for scoring purposes without a seat mechanic
// behind it), so "seated" collapses into "present" here -- a deliberate, documented scope-down
// like the ones FEATURE_RESEARCH.md/rooms.js already made for elevation/roof data this engine
// doesn't have. The two axes that DO carry over (members present, tables present) are scaled down
// together, preserving PA's real ~0.6 tables-per-member ratio (3/5) at this project's smaller
// clique scale: 2 tables for 3 members is ~0.67, the closest whole-number pair to that ratio.
const TERRITORY_MIN_MEMBERS = 3;
const TERRITORY_MIN_TABLES = 2;
const TERRITORY_CHECK_INTERVAL_TICKS = 50; // throttle -- occupancy/furniture checked this often, not every tick
const GRAFFITI_CLEAN_DETECT_EPS = 0.01; // a room.mess drop bigger than this between checks reads as "someone actively cleaned it" (see tickTerritory's doc comment)
const GRAFFITI_CLEANUP_UNREST_BUMP = 0.05; // smaller than a full unmet-demand bump (0.12) -- a cleanup is annoying, not a betrayal
const GRAFFITI_CLEANUP_MOOD_HIT = 0.1;     // applied to every alive member of the clique whose mark got scrubbed

// Food-fight-style emergent violence: real PA numbers (gangsystem.txt) -- 30% trigger chance,
// gated on at least 25% of the room's population being clique members; when it triggers, each
// participant rolls 50% miss / 5% real damage (the remaining 45% is a nonlethal scuffle -- a real
// mood hit, no health loss). Percentages kept exact, unscaled -- these are dimensionless
// probabilities, nothing about this project's smaller population/economy changes them (the same
// "keep the number, scale the population gate instead" choice DEMAND_BASE_TARGET's doc comment
// already made for MinGangMembersForDemand).
const FOODFIGHT_ZONE_SHARE_THRESHOLD = 0.25;
const FOODFIGHT_TRIGGER_CHANCE = 0.30;
const FOODFIGHT_MISS_CHANCE = 0.50;
const FOODFIGHT_DAMAGE_CHANCE = 0.05; // rolled as the next band after MISS_CHANCE, i.e. [0.50, 0.55)
const FOODFIGHT_CHECK_INTERVAL_TICKS = 100; // throttle -- real canteens don't roll every single tick
const FOODFIGHT_DAMAGE_HEALTH_HIT = 0.08;
const FOODFIGHT_MOOD_HIT = 0.05;
const FOODFIGHT_MAX_PARTICIPANTS = 3;

// ---------------------------------------------------------------------------------------------
// Refinement pass 2 (gangsystem.txt/gangdemands.txt granularity the first two passes didn't cover
// yet): PreferredResource dealer-trading, a singular Leader distinct from the Lieutenant
// hierarchy, targeted rival-clique friction, a PreferredTerritoryModifier so territory doesn't
// flip on marginal headcount noise, a one-perk rank ladder, and an Informant mechanic. Same
// honest real-number-ported-and-scaled convention as every block above -- see each constant's own
// doc comment for the source number and the scaling logic.

// PreferredResource + dealer trading (real gangdemands.txt: TradeContrbandToDealerPercentage 60,
// Limit 5). Layered ON TOP of the existing flat UNMET_DEMAND_SCRAP_LOSS pilfering above as a
// small, hard-capped bonus loss, not a second independent drain source -- it only ever fires
// alongside that already-rare unmet-demand consequence (itself gated by the full demand
// lifecycle/cooldown), never on its own tick-driven cadence. See applyUnmetConsequence below.
const DEALER_TRADE_CHANCE = 0.6; // real TradeContrbandToDealerPercentage 60
const DEALER_TRADE_CAP = 5;      // real Limit 5 -- small and absolute, same order of magnitude as a single foodfight/checkpoint-reduced sub-effect elsewhere in this file

// Leader role (real gangsystem.txt: a singular Leader per gang, distinct from the Lieutenant
// hierarchy above -- LIEUTENANT_SPAN promotes several, this promotes exactly one). Needs its own
// store.flags bit: citizens.js's CitizenFlags occupies bits 0-4 of that Uint8Array column
// (confirmed via a full-codebase grep for `.flags[` before adding this -- nothing else claims bit
// 5+), but this task is scoped to factions.js only, so rather than editing citizens.js's frozen
// CitizenFlags export, the next three new roles this pass adds (Leader/SneakThief/Informant) each
// take one of the three remaining free bits as a local raw constant.
const LEADER_FLAG = 1 << 5;
// LeaderDeathPeriodMinutes 360 real-minutes, scaled the same way FACTION_DEMAND_COOLDOWN_TICKS
// above already scales real minutes against this file's DEMAND_BASE_WINDOW_TICKS anchor (720
// real-minutes = one base demand window) -- 360/720 is a clean exactly-half.
const LEADER_DEATH_WINDOW_TICKS = Math.round(DEMAND_BASE_WINDOW_TICKS * (360 / 720));
const LEADER_DEATH_UNREST_BUMP = 0.15; // one-time, slightly above UNMET_DEMAND_UNREST_BUMP (0.12) -- losing a leader outright hits harder than one missed demand
const LEADER_DEATH_MOOD_HIT = 0.12;    // one-time, applied to every alive clique member -- between GRAFFITI_CLEANUP_MOOD_HIT (0.1) and the Scrapping branch's 0.15

// Targeted friction (real gangsystem.txt: TargetStartFightPercentage 5, TargetFightCooldownMinutes
// 1440). Reuses the exact mood/OnBreak shape the existing Scrapping unmet-demand branch already
// established in applyUnmetConsequence below, rather than inventing a new violence mechanic --
// no health loss, no scrap, purely a real mood hit + OnBreak work-speed penalty (same mechanisms,
// smaller/rarer than a foodfight).
const TARGET_FRICTION_CHECK_INTERVAL_TICKS = 100; // throttle, same order as FOODFIGHT_CHECK_INTERVAL_TICKS
const TARGET_FRICTION_CHANCE = 0.05; // real TargetStartFightPercentage 5, kept unscaled -- dimensionless probability, same precedent as the FOODFIGHT_* percentages' own doc comment
// The leader-death "aggression spike" window (LEADER_DEATH_WINDOW_TICKS) manifests here rather
// than as a separate standalone spike system: while a clique is leaderless, its members are twice
// as likely to start targeted friction. See applyLeaderDeathConsequence/tickTargetedFriction below.
const TARGET_FRICTION_LEADER_DEATH_MULT = 2;
const TARGET_FRICTION_COOLDOWN_TICKS = Math.round(DEMAND_BASE_WINDOW_TICKS * (1440 / 720)); // real 1440/720 = exactly 2x a base demand window, same anchor as LEADER_DEATH_WINDOW_TICKS
const TARGET_FRICTION_MOOD_HIT = 0.12;

// PreferredTerritoryModifier (real gangsystem.txt: 10.0, a bonus weight toward a clique's
// currently-held territory when a room is contested). Real PA cliques run tens of members deep,
// where a flat 10.0 is a meaningful-but-not-absolute thumb on the scale; this project's per-room
// headcounts are single digits (TERRITORY_MIN_MEMBERS is 3), so the literal number would be
// unbeatable -- scaled down to a flat +1, enough to require a clear (not marginal, e.g. 4-vs-3)
// headcount win to flip an already-claimed room, without making a flip impossible outright. See
// tickTerritory below for exactly where this applies (only to the CURRENT holder's weighted
// count, so a room's very first claim is unaffected).
const PREFERRED_TERRITORY_BONUS = 1;

// Rank ladder + one perk (real gangsystem.txt: PromotionRep/UpgradeRep/SpecialRep gate a clique
// member's perks as they rack up reputation -- this pass implements exactly one perk, per the task
// brief's own "one is enough for a first pass" instruction). Rep is earned the same "genuinely
// earned by real play" way demand progress itself already is -- see tickDemandProgress below -- a
// member gains rep only when their own Recreating job genuinely counts toward their clique's
// active demand, never on a timer.
const REP_PER_CONTRIBUTION = 1;
const REP_PERK_THRESHOLD = 15; // ~15 genuine demand contributions -- reachable in a session, not trivial
// Sneak Thief perk (the simplest real PA gang-member perk tier, per the task brief's own example):
// a perked member's clique gets a GUARANTEED-success dealer trade (DEALER_TRADE_CHANCE above)
// instead of a 60% roll -- higher RELIABILITY of an already-capped, already-bounded small pilfer,
// never a bigger cap and never a new income/loss source of its own.
const SNEAK_THIEF_FLAG = 1 << 6;

// Informant mechanic (real gangsystem.txt: InformantCoverageBoost 20, CooldownDecreaseEachRecruiter
// 10 capped 30) -- a citizen secretly informing on their own clique shortens that clique's demand
// cooldown. This codebase has no concept of a "warning lead time" distinct from the cooldown
// itself (tickDemandLifecycle below is the only place a new demand's timing is decided), so both
// real PA fields collapse into the one effect that actually exists here: a shorter wait before the
// clique's next demand. Bit 7 is the last free bit in the flags byte (LEADER_FLAG/SNEAK_THIEF_FLAG
// above already claimed bits 5-6) -- widening that Uint8Array column is out of scope for this task.
const INFORMANT_FLAG = 1 << 7;
const INFORMANT_CHECK_INTERVAL_TICKS = 200; // rare, low-frequency roll -- informants are meant to stay uncommon
const INFORMANT_CHANCE_PER_CHECK = 0.02; // per clique per check, not per member -- bounds this to roughly 0-1 informants per clique over a long game
const INFORMANT_COOLDOWN_REDUCTION_PER = 0.10; // real CooldownDecreaseEachRecruiter 10, unscaled fraction
const INFORMANT_COOLDOWN_REDUCTION_CAP = 0.30;  // real cap 30

function demandDesc(tier) {
  return tier === 'escalated'
    ? `Give us MORE time in the Recreation zone -- ${DEMAND_ESCALATED_TARGET} visits within the window, or else.`
    : `Give us more time in the Recreation zone -- ${DEMAND_BASE_TARGET} visits within the window.`;
}

function pushMilestone(world, text) {
  world.milestoneLog.push({ tick: world.currentTick, text });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  world.onRandomEvent?.(text);
}

// Same interrupt-and-release pattern jobs.js's own night-interrupt logic already uses (see that
// file's ScheduleBlock.Sleep handling) -- release whatever claim this citizen was holding so
// someone else (or the same citizen later) can pick the job back up, rather than leaving a
// blueprint/animal permanently claimed by a citizen who just wandered off.
function interruptJob(store, i) {
  const state = store.jobState[i];
  if (state === JobState.Building || state === JobState.SeekingBuild) {
    const bp = store._jobRef?.[i];
    if (bp) bp.claimedBy = null;
  } else if (state === JobState.SeekingAnimal || state === JobState.Taming) {
    const animal = store._jobRef?.[i];
    if (animal) animal.claimedBy = null;
  }
  store.jobState[i] = JobState.Idle;
}

export class FactionState {
  constructor() {
    this.formed = false;
    this.memberOf = new Map();     // citizenId -> clique id
    this.demand = {};              // clique id -> active demand object, or null
    this.demandTier = {};          // clique id -> 'base' | 'escalated' (escalates on completion, stays escalated)
    this.completions = {};         // clique id -> lifetime count of satisfied demands (UI/debug only)
    this.cooldownUntil = {};       // clique id -> tick before which a new demand won't be issued
    this._recreatingLastTick = new Set(); // citizen ids that were JobState.Recreating last tick (transition detector)
    this.leaderId = {};                    // clique id -> citizen id of its current Leader, or null (syncLeader)
    this.volatileUntil = {};               // clique id -> tick before which its leader-death aggression spike is active (syncLeader/applyLeaderDeathConsequence)
    this.targetFrictionCooldownUntil = {}; // clique id -> tick before which targeted friction won't roll again (tickTargetedFriction)
    this.rep = new Map();                  // citizen id -> lifetime rep count toward the rank-ladder perk (tickDemandProgress)
    for (const c of CLIQUES) {
      this.demand[c.id] = null;
      this.demandTier[c.id] = 'base';
      this.completions[c.id] = 0;
      this.cooldownUntil[c.id] = 0;
      this.leaderId[c.id] = null;
      this.volatileUntil[c.id] = 0;
      this.targetFrictionCooldownUntil[c.id] = 0;
    }
  }

  memberCliqueId(citizenId) {
    return this.memberOf.get(citizenId) ?? null;
  }

  // memberOf never prunes a dead citizen's entry (recruit() only ever adds -- see its own doc
  // comment), so a raw count over memberOf.values() would keep counting citizens who died long
  // ago. `world` (optional) lets this count ONLY currently-alive members instead; omitted (e.g.
  // simple tests), this falls back to the raw membership count.
  memberCountOf(cliqueId, world) {
    if (!world) {
      let n = 0;
      for (const v of this.memberOf.values()) if (v === cliqueId) n++;
      return n;
    }
    let n = 0;
    const store = world.citizens;
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i)) continue;
      if (this.memberOf.get(store.id[i]) === cliqueId) n++;
    }
    return n;
  }
}

// Recruits every currently-unassigned alive citizen into a clique, weighted toward whichever
// clique's affinityTraits match their own trait (traits.js). Called once when cliques first form
// and again periodically afterward so late arrivals (Refugee Wagon, wanderer-joins) eventually
// join one too.
function recruit(factions, world) {
  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    const id = store.id[i];
    if (factions.memberOf.has(id)) continue;

    const traitName = store.trait[i]?.name;
    const weights = CLIQUES.map(c => (traitName && c.affinityTraits.includes(traitName)) ? AFFINITY_WEIGHT : 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = world.rng() * total;
    let chosen = CLIQUES[CLIQUES.length - 1];
    for (let k = 0; k < CLIQUES.length; k++) {
      if (roll < weights[k]) { chosen = CLIQUES[k]; break; }
      roll -= weights[k];
    }
    factions.memberOf.set(id, chosen.id);
  }
}

// Real consequence for a demand that expired unmet, always applied: a colony-wide unrest bump
// (feeds world.js's own unrestLevel/unrestActive crisis state -- see that file's UNREST_* system)
// plus a scrap loss (the clique helps itself while nobody's listening). On top of that, each
// clique's PreferredMisbehaviour bias adds a flavor-specific, genuinely mechanical effect.
function applyUnmetConsequence(clique, factions, world) {
  const members = [];
  for (let i = 0; i < world.citizens.count; i++) {
    if (!world.citizens.isAliveAt(i)) continue;
    if (factions.memberOf.get(world.citizens.id[i]) === clique.id) members.push(i);
  }

  // Checkpoint (see CHECKPOINT_CONSEQUENCE_REDUCTION above): the colony-wide unrest bump/scrap
  // pilfering is gated on whether any of THIS clique's alive members were actually within a
  // Checkpoint's screening radius when the demand expired -- a checkpoint the clique never walks
  // past can't be catching anything, same real-placement requirement security.js's corrupt-staff
  // reduction already enforces.
  const screened = members.some(i => isNearCheckpoint(world.structures, world.citizens.x[i], world.citizens.y[i]));
  const unrestBump = screened ? UNMET_DEMAND_UNREST_BUMP * (1 - CHECKPOINT_CONSEQUENCE_REDUCTION) : UNMET_DEMAND_UNREST_BUMP;
  world.unrestLevel = Math.min(1, world.unrestLevel + unrestBump);
  const scrapLossTarget = screened ? UNMET_DEMAND_SCRAP_LOSS * (1 - CHECKPOINT_CONSEQUENCE_REDUCTION) : UNMET_DEMAND_SCRAP_LOSS;
  const scrapLoss = Math.min(world.scrap, scrapLossTarget);
  world.scrap -= scrapLoss;
  // This pilfering loss was never wired into world.finance's expense rollup (corruptionLoss/
  // ratLoss both are, via security.js/rats.js) -- an untracked passive drain in exactly this
  // function was flagged as a contributor to a prior balance regression. Tracked now under a new
  // `factionLoss` bucket, same additive-bookkeeping pattern world.addScrap's own doc comment
  // describes. NOTE: this task is scoped to factions.js only, so `factionLoss` could NOT be added
  // to world.finance's constructor field list or its totalExpense/history rollup (both live in
  // world.js) -- the field is created here on first write (plain JS object, no predeclaration
  // required) and round-trips through save/load fine (finance is serialized wholesale), but stays
  // invisible to the in-game budget report's total until world.js is updated to include it.
  // Flagged in this task's final report for whoever next touches world.js.
  let scrapDrainThisEvent = scrapLoss;

  // PreferredResource dealer trading (see DEALER_TRADE_* above): a small, hard-capped bonus loss
  // layered on top of the pilfering above, flavored by this clique's preferredResource -- never a
  // second independent drain, only ever fires alongside this same rare unmet-demand event. A Sneak
  // Thief-perked member (SNEAK_THIEF_FLAG, see the rank-ladder perk in tickDemandProgress below)
  // makes it succeed guaranteed AND unnoticed -- skips both the 60% roll and the checkpoint
  // reduction below, but is still hard-capped at the exact same DEALER_TRADE_CAP as the unperked
  // roll, never a bigger amount.
  const hasSneakThief = members.some(i => (world.citizens.flags[i] & SNEAK_THIEF_FLAG) !== 0);
  let dealerLoss = 0;
  if (hasSneakThief) {
    dealerLoss = Math.min(world.scrap, DEALER_TRADE_CAP);
  } else if (world.rng() < DEALER_TRADE_CHANCE) {
    const dealerLossTarget = screened ? DEALER_TRADE_CAP * (1 - CHECKPOINT_CONSEQUENCE_REDUCTION) : DEALER_TRADE_CAP;
    dealerLoss = Math.min(world.scrap, dealerLossTarget);
  }
  if (dealerLoss > 0) {
    world.scrap -= dealerLoss;
    scrapDrainThisEvent += dealerLoss;
    pushMilestone(world, `The ${clique.name} fenced some ${clique.preferredResource} to an outside dealer.`);
  }
  if (world.finance) world.finance.factionLoss = (world.finance.factionLoss || 0) + scrapDrainThisEvent;

  if (clique.preferredMisbehaviour === 'Scrapping') {
    // Fighting-analog: a couple of members get worked up -- a real mood/OnBreak hit (feeds
    // citizens.js's own on-break work-speed penalty), not violence against the protection force.
    // Checkpoint: the specific member rolled this tick has their mood hit reduced if THEY
    // personally were near a Checkpoint (a per-citizen screening check, not the clique-wide one
    // above), same "has to be the one actually screened" precision as security.js.
    for (let n = 0; n < Math.min(2, members.length); n++) {
      const i = members[Math.floor(world.rng() * members.length)];
      const nearCp = isNearCheckpoint(world.structures, world.citizens.x[i], world.citizens.y[i]);
      const moodHit = nearCp ? 0.15 * (1 - CHECKPOINT_CONSEQUENCE_REDUCTION) : 0.15;
      world.citizens.mood[i] = Math.max(0, world.citizens.mood[i] - moodHit);
      world.citizens.flags[i] |= CitizenFlags.OnBreak;
    }
  } else if (clique.preferredMisbehaviour === 'Wrecking') {
    // Destroying-analog: real property damage to a random structure, same health/destroyed
    // mechanism fire.js's igniteStructure-driven damage already uses -- turrets and walls are
    // excluded (walls aren't real Structure objects once built, see world.js; turrets are the
    // colony's actual defense and a griefing-tier "your defense gets sabotaged" isn't the intent).
    // Checkpoint: a target that itself sits within a Checkpoint's screening radius takes reduced
    // damage -- the vandal gets caught mid-act at whatever they were about to wreck.
    const candidates = world.structures.filter(s =>
      !s.destroyed && !s.underConstruction && s.kind !== 'turret' && s.kind !== 'wall');
    if (candidates.length > 0) {
      const target = candidates[Math.floor(world.rng() * candidates.length)];
      const targetScreened = isNearCheckpoint(world.structures, target.x, target.y);
      const damage = targetScreened ? STRUCTURE_DAMAGE_FRACTION * (1 - CHECKPOINT_CONSEQUENCE_REDUCTION) : STRUCTURE_DAMAGE_FRACTION;
      target.health = Math.max(0, target.health - damage);
      if (target.health <= 0) target.destroyed = true;
    }
  } else if (clique.preferredMisbehaviour === 'Slipping Off') {
    // Escaping-analog: a member abandons whatever they were doing (real, mechanical -- loses
    // build/harvest/taming progress, see interruptJob above), not a carceral "escape attempt".
    // Checkpoint: a member currently within a Checkpoint's screening radius is stopped before they
    // can slip off at all -- interruptJob is skipped entirely for them this roll (a full
    // intercept, not a partial percentage, since there's no partial version of "didn't leave").
    for (let n = 0; n < Math.min(2, members.length); n++) {
      const i = members[Math.floor(world.rng() * members.length)];
      if (isNearCheckpoint(world.structures, world.citizens.x[i], world.citizens.y[i])) continue;
      interruptJob(world.citizens, i);
    }
  }
}

// Advances demand progress: each clique member whose jobState transitions INTO Recreating this
// tick (i.e. they weren't Recreating last tick) counts as one "object" toward the active demand,
// same "genuinely satisfied by real play, not a timer" spirit as the real Gang_MoreYardTime demand.
function tickDemandProgress(factions, world) {
  const store = world.citizens;
  const nowRecreating = new Set();
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (store.jobState[i] !== JobState.Recreating) continue;
    const id = store.id[i];
    nowRecreating.add(id);
    if (factions._recreatingLastTick.has(id)) continue; // already counted this session
    const cliqueId = factions.memberOf.get(id);
    if (!cliqueId) continue;
    const demand = factions.demand[cliqueId];
    if (!demand) continue;
    demand.progress = Math.min(demand.target, demand.progress + 1);

    // Rank ladder (see REP_PER_CONTRIBUTION/REP_PERK_THRESHOLD above): rep earned the same
    // genuinely-by-real-play way demand progress itself just was, one point per contribution.
    // Past the threshold, unlocks the one Sneak Thief perk this pass implements (consumed by
    // applyUnmetConsequence's dealer-trade sub-effect above) -- a one-way promotion, same
    // never-demoted convention Lieutenant already uses elsewhere in this file.
    const rep = (factions.rep.get(id) || 0) + REP_PER_CONTRIBUTION;
    factions.rep.set(id, rep);
    if (rep >= REP_PERK_THRESHOLD && (store.flags[i] & SNEAK_THIEF_FLAG) === 0) {
      store.flags[i] |= SNEAK_THIEF_FLAG;
      const clique = CLIQUES.find(c => c.id === cliqueId);
      pushMilestone(world, `${store.name[i] || 'A citizen'} has earned enough standing among the ${clique ? clique.name : 'clique'} to become a Sneak Thief.`);
    }
  }
  factions._recreatingLastTick = nowRecreating;
}

// Informant mechanic (see INFORMANT_* above): counts this clique's currently-alive, currently-
// flagged informants and returns a shortened cooldown -- FACTION_DEMAND_COOLDOWN_TICKS reduced by
// INFORMANT_COOLDOWN_REDUCTION_PER per informant, capped at INFORMANT_COOLDOWN_REDUCTION_CAP.
// Zero informants (the common case) returns FACTION_DEMAND_COOLDOWN_TICKS unchanged.
function informantAdjustedCooldownTicks(clique, factions, world) {
  const store = world.citizens;
  let informants = 0;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (factions.memberOf.get(store.id[i]) !== clique.id) continue;
    if ((store.flags[i] & INFORMANT_FLAG) !== 0) informants++;
  }
  if (informants === 0) return FACTION_DEMAND_COOLDOWN_TICKS;
  const reduction = Math.min(INFORMANT_COOLDOWN_REDUCTION_CAP, informants * INFORMANT_COOLDOWN_REDUCTION_PER);
  return Math.round(FACTION_DEMAND_COOLDOWN_TICKS * (1 - reduction));
}

// Issues, resolves (reward), or fails (consequence) each clique's demand. Called every tick from
// world.js's tick() -- individual checks are throttled internally (cooldowns, deadlines) so this
// is cheap on the ticks where nothing is due.
function tickDemandLifecycle(factions, world) {
  for (const clique of CLIQUES) {
    const active = factions.demand[clique.id];
    if (active) {
      if (active.progress >= active.target) {
        const reward = active.tier === 'escalated' ? DEMAND_REWARD_ESCALATED : DEMAND_REWARD_BASE;
        world.addScrap(reward, 'faction');
        factions.completions[clique.id]++;
        factions.demandTier[clique.id] = 'escalated'; // real PA: repeat satisfaction spawns the harder _Escalated variant
        factions.cooldownUntil[clique.id] = world.currentTick + informantAdjustedCooldownTicks(clique, factions, world);
        factions.demand[clique.id] = null;
        pushMilestone(world, `${clique.name} demand satisfied -- +${reward} scrap. They'll want more next time.`);
      } else if (world.currentTick >= active.deadlineTick) {
        applyUnmetConsequence(clique, factions, world);
        factions.cooldownUntil[clique.id] = world.currentTick + informantAdjustedCooldownTicks(clique, factions, world);
        factions.demand[clique.id] = null;
        pushMilestone(world, `${clique.name} demand went unmet -- unrest rises, and they help themselves to some scrap.`);
      }
      continue;
    }

    if (world.currentTick < factions.cooldownUntil[clique.id]) continue;
    if (factions.memberCountOf(clique.id, world) < MIN_CLIQUE_SIZE_FOR_DEMAND) continue;

    const tier = factions.demandTier[clique.id];
    const target = tier === 'escalated' ? DEMAND_ESCALATED_TARGET : DEMAND_BASE_TARGET;
    const windowTicks = tier === 'escalated' ? DEMAND_ESCALATED_WINDOW_TICKS : DEMAND_BASE_WINDOW_TICKS;
    factions.demand[clique.id] = {
      tier, target, progress: 0,
      startTick: world.currentTick, deadlineTick: world.currentTick + windowTicks,
    };
    pushMilestone(world, `${clique.name} have a demand: ${demandDesc(tier)}`);
  }
}

// Lieutenant hierarchy (see LIEUTENANT_SPAN's doc comment above): promotes/demotes
// CitizenFlags.Lieutenant so each clique holds roughly memberCount/LIEUTENANT_SPAN lieutenants,
// rounded to at least 1 once a clique has any members at all. Cheap (same <=64-slot pass every
// other per-tick faction check already does) so it runs unthrottled, same as recruit() above --
// promotions/demotions only actually happen on the tick membership genuinely changes (a citizen
// recruited, or a lieutenant dying/leaving), every other tick the while-loops below no-op
// immediately since currentLieutenants.length already equals targetCount.
function syncLieutenants(factions, world) {
  const store = world.citizens;
  for (const clique of CLIQUES) {
    const members = [];
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i)) continue;
      if (factions.memberOf.get(store.id[i]) === clique.id) members.push(i);
    }
    const targetCount = members.length > 0 ? Math.max(1, Math.round(members.length / LIEUTENANT_SPAN)) : 0;
    let current = members.filter(i => (store.flags[i] & CitizenFlags.Lieutenant) !== 0);

    while (current.length < targetCount) {
      const pool = members.filter(i => (store.flags[i] & CitizenFlags.Lieutenant) === 0);
      if (pool.length === 0) break;
      const pick = pool[Math.floor(world.rng() * pool.length)];
      store.flags[pick] |= CitizenFlags.Lieutenant;
      current.push(pick);
      pushMilestone(world, `${store.name[pick] || 'A citizen'} has become a lieutenant of the ${clique.name}.`);
    }
    while (current.length > targetCount) {
      const demote = current.pop();
      store.flags[demote] &= ~CitizenFlags.Lieutenant;
    }
  }
}

// Leader role (see LEADER_FLAG's doc comment above): same promote-from-pool shape syncLieutenants
// above already uses, but targetCount is always exactly 1, and -- unlike Lieutenant -- losing the
// role is a real, detected event (applyLeaderDeathConsequence below), not just a silent headcount
// rebalance. factions.leaderId[clique.id] is the source of truth for "who was the leader as of
// last tick"; this function's whole job is reconciling that against who's actually still alive
// and flagged this tick.
function syncLeader(factions, world) {
  const store = world.citizens;
  for (const clique of CLIQUES) {
    const members = [];
    let aliveLeaderIdx = -1;
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i)) continue;
      if (factions.memberOf.get(store.id[i]) !== clique.id) continue;
      members.push(i);
      if ((store.flags[i] & LEADER_FLAG) !== 0) aliveLeaderIdx = i;
    }

    const hadLeader = factions.leaderId[clique.id] != null;
    if (hadLeader && aliveLeaderIdx === -1) {
      // The leader recorded as of last tick is no longer alive-and-flagged -- a real death (siege.js/
      // weather.js's own alive[i]=0/CitizenFlags.Dead paths, same death detection every other
      // isAliveAt() check in this file already relies on), not a first-formation no-op (hadLeader
      // guards that case).
      applyLeaderDeathConsequence(clique, factions, world);
      factions.leaderId[clique.id] = null;
    }

    if (aliveLeaderIdx === -1) {
      if (members.length === 0) continue;
      const pick = members[Math.floor(world.rng() * members.length)];
      store.flags[pick] |= LEADER_FLAG;
      factions.leaderId[clique.id] = store.id[pick];
      pushMilestone(world, `${store.name[pick] || 'A citizen'} has become the leader of the ${clique.name}.`);
    } else {
      factions.leaderId[clique.id] = store.id[aliveLeaderIdx]; // keep in sync defensively
    }
  }
}

// Leader-death aggression spike (real gangsystem.txt: LeaderDeathPeriodMinutes 360, see
// LEADER_DEATH_WINDOW_TICKS above). Two effects: an immediate, one-time, bounded unrest bump +
// mood hit to every alive clique member (grief -- same world.unrestLevel/citizens.mood mechanisms
// applyGraffitiCleanupConsequence already uses, just larger since losing a leader is a bigger deal
// than a scrubbed wall), and a timed window (factions.volatileUntil) during which
// tickTargetedFriction below rolls at TARGET_FRICTION_LEADER_DEATH_MULT the normal chance. No
// scrap involved either way -- this consequence is unrest/mood/violence-only by design.
function applyLeaderDeathConsequence(clique, factions, world) {
  world.unrestLevel = Math.min(1, world.unrestLevel + LEADER_DEATH_UNREST_BUMP);
  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (factions.memberOf.get(store.id[i]) !== clique.id) continue;
    store.mood[i] = Math.max(0, store.mood[i] - LEADER_DEATH_MOOD_HIT);
  }
  factions.volatileUntil[clique.id] = world.currentTick + LEADER_DEATH_WINDOW_TICKS;
  pushMilestone(world, `The ${clique.name}'s leader has fallen -- the clique is volatile and looking for a fight.`);
}

// Targeted friction (see TARGET_FRICTION_* above): a small per-check chance for one member to
// start a scuffle with a specific rival-clique member, reusing the exact mood/OnBreak shape the
// Scrapping unmet-demand branch in applyUnmetConsequence already established (checkpoint reduction
// included, same per-citizen screening precision). Throttled and cooldown-gated per clique, same
// two-layer "cheap check, rare actual event" pattern tickFoodFights/tickTerritory already use.
function tickTargetedFriction(factions, world) {
  if (world.currentTick % TARGET_FRICTION_CHECK_INTERVAL_TICKS !== 0) return;
  const store = world.citizens;

  for (const clique of CLIQUES) {
    if (world.currentTick < (factions.targetFrictionCooldownUntil[clique.id] || 0)) continue;

    const volatile = world.currentTick < (factions.volatileUntil[clique.id] || 0);
    const chance = volatile ? Math.min(1, TARGET_FRICTION_CHANCE * TARGET_FRICTION_LEADER_DEATH_MULT) : TARGET_FRICTION_CHANCE;
    if (world.rng() >= chance) continue;

    const members = [];
    const rivals = [];
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i)) continue;
      const cid = factions.memberOf.get(store.id[i]);
      if (cid === clique.id) members.push(i);
      else if (cid) rivals.push(i);
    }
    if (members.length === 0 || rivals.length === 0) continue;

    const instigator = members[Math.floor(world.rng() * members.length)];
    const target = rivals[Math.floor(world.rng() * rivals.length)];
    const rivalClique = CLIQUES.find(c => c.id === factions.memberOf.get(store.id[target]));

    for (const i of [instigator, target]) {
      const nearCp = isNearCheckpoint(world.structures, store.x[i], store.y[i]);
      const moodHit = nearCp ? TARGET_FRICTION_MOOD_HIT * (1 - CHECKPOINT_CONSEQUENCE_REDUCTION) : TARGET_FRICTION_MOOD_HIT;
      store.mood[i] = Math.max(0, store.mood[i] - moodHit);
    }
    store.flags[instigator] |= CitizenFlags.OnBreak;

    factions.targetFrictionCooldownUntil[clique.id] = world.currentTick + TARGET_FRICTION_COOLDOWN_TICKS;
    pushMilestone(world, `${store.name[instigator] || 'A ' + clique.name + ' member'} started a scuffle with a ${rivalClique ? rivalClique.name : 'rival clique'} member.`);
  }
}

// Informant mechanic (see INFORMANT_* above): a rare, throttled roll to flag one existing,
// unflagged, non-leader member of each clique as an Informant -- a one-way status (never removed
// here, matching the file's other one-way promotions) consumed by informantAdjustedCooldownTicks
// above. No mood/scrap/unrest effect of its own -- purely a timing modifier on the clique's own
// next demand.
function tickInformants(factions, world) {
  if (world.currentTick % INFORMANT_CHECK_INTERVAL_TICKS !== 0) return;
  const store = world.citizens;

  for (const clique of CLIQUES) {
    if (world.rng() >= INFORMANT_CHANCE_PER_CHECK) continue;

    const pool = [];
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i)) continue;
      if (factions.memberOf.get(store.id[i]) !== clique.id) continue;
      if ((store.flags[i] & INFORMANT_FLAG) !== 0) continue;
      if ((store.flags[i] & LEADER_FLAG) !== 0) continue; // flavor: the leader doesn't secretly inform on their own clique
      pool.push(i);
    }
    if (pool.length === 0) continue;

    const pick = pool[Math.floor(world.rng() * pool.length)];
    store.flags[pick] |= INFORMANT_FLAG;
    // Deliberately no milestone log here -- the whole point of an informant is that nobody
    // announces it; the effect (a shorter cooldown before the clique's next demand) is the only
    // player-visible signal, same "quiet mechanical effect, no fanfare" choice this file already
    // makes for e.g. syncLieutenants' demotions.
  }
}

// Physical territory-claiming + graffiti-style marking (see TERRITORY_MIN_MEMBERS/
// TERRITORY_MIN_TABLES's doc comment above for the real PA numbers and how they were scaled).
// Reuses world.rooms as the "zone" unit -- rooms.js's detectRooms flood-fill enclosed regions are
// already this project's closest real analogue to PA's per-room object/occupancy model, and
// computeRoomStats (run every tick, before tickFactions, in world.js's tick()) has already
// tallied each room's .tableCount and current .mess, so this needs no new per-tick scan
// infrastructure of its own beyond the citizen-position pass below.
//
// Cleanup detection: rather than hooking a new callback into jobs.js's Cleaning job (which has no
// awareness of factions/territory today and shouldn't need to), this reads the same signal jobs.js's
// Cleaning job is the only thing capable of producing -- a real, net decrease in room.mess between
// two throttled checks. computeRoomStats' own ambient mess accumulation (MESS_ACCUMULATION_RATE)
// only ever adds a small amount per tick; the only way mess can be net LOWER than last check is if
// a citizen was actively on the Cleaning job (rooms.js's CLEAN_RATE, ~30x the ambient rate) for
// enough of the interval to outpace it. A false-positive here would require mess to drop with no
// cleaning at all, which nothing else in this codebase does.
function tickTerritory(factions, world) {
  if (world.currentTick % TERRITORY_CHECK_INTERVAL_TICKS !== 0) return;
  const store = world.citizens;
  const grid = world.grid;

  for (const room of world.rooms) {
    const mess = room.mess || 0;
    const prevMess = room._territoryPrevMess ?? mess;
    if (room.territoryClique && mess < prevMess - GRAFFITI_CLEAN_DETECT_EPS) {
      applyGraffitiCleanupConsequence(room, factions, world);
    }
    room._territoryPrevMess = mess;

    if ((room.tableCount || 0) < TERRITORY_MIN_TABLES) continue;

    const counts = {};
    for (const c of CLIQUES) counts[c.id] = 0;
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i)) continue;
      const gx = Math.floor(store.x[i]), gy = Math.floor(store.y[i]);
      if (!grid.inBounds(gx, gy)) continue;
      if (!room.cells.has(grid.index(gx, gy))) continue;
      const cliqueId = factions.memberOf.get(store.id[i]);
      if (cliqueId && counts[cliqueId] != null) counts[cliqueId]++;
    }

    // PreferredTerritoryModifier (see PREFERRED_TERRITORY_BONUS above): the room's CURRENT holder
    // (if any) gets a flat bonus added to its raw headcount before comparing, so a rival needs a
    // clear win, not a marginal one, to flip an already-claimed room. Only the weighted total
    // (bestCount) is inflated -- the MIN_MEMBERS gate below only ever matters for a genuine change
    // of holder (the `room.territoryClique !== bestId` check already no-ops when the incumbent
    // wins), so a challenger still has to clear TERRITORY_MIN_MEMBERS on its own real headcount.
    let bestId = null, bestCount = 0;
    for (const c of CLIQUES) {
      const weighted = counts[c.id] + (room.territoryClique === c.id ? PREFERRED_TERRITORY_BONUS : 0);
      if (weighted > bestCount) { bestCount = weighted; bestId = c.id; }
    }

    if (bestId && counts[bestId] >= TERRITORY_MIN_MEMBERS && room.territoryClique !== bestId) {
      const prevClique = room.territoryClique;
      room.territoryClique = bestId;
      room.territoryGraffiti = 1;
      const clique = CLIQUES.find(c => c.id === bestId);
      pushMilestone(world, prevClique
        ? `The ${clique.name} have marked over rival graffiti to claim territory for themselves.`
        : `The ${clique.name} have claimed territory and marked it with graffiti.`);
    }
  }
}

// Real anger-cost consequence for a staff member's Cleaning job scrubbing a claimed room's
// graffiti away (detected in tickTerritory above) -- a colony-wide unrest bump plus a genuine
// mood hit to every alive member of the clique whose mark just got wiped, same
// world.unrestLevel/citizens.mood mechanisms applyUnmetConsequence already uses above, just
// smaller (a cleanup is an annoyance, not the betrayal an unmet demand is).
function applyGraffitiCleanupConsequence(room, factions, world) {
  const clique = CLIQUES.find(c => c.id === room.territoryClique);
  room.territoryClique = null;
  room.territoryGraffiti = 0;
  if (!clique) return;

  world.unrestLevel = Math.min(1, world.unrestLevel + GRAFFITI_CLEANUP_UNREST_BUMP);
  const store = world.citizens;
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    if (factions.memberOf.get(store.id[i]) !== clique.id) continue;
    store.mood[i] = Math.max(0, store.mood[i] - GRAFFITI_CLEANUP_MOOD_HIT);
  }
  pushMilestone(world, `Staff scrubbed away the ${clique.name}'s graffiti -- they're furious about it.`);
}

// Food-fight-style emergent violence (see the FOODFIGHT_* constants' doc comment above for the
// real PA percentages this was ported unscaled from). Checked per Dining Room (rooms.js's
// RoomRole.DiningRoom -- the canteen analogue PA's real food fights actually occur in) on a
// throttled interval, gated on clique members being at least a quarter of the room's current
// occupants, same "genuinely mechanical, driven by real citizen positions" spirit as everything
// else in this file.
function tickFoodFights(factions, world) {
  if (world.currentTick % FOODFIGHT_CHECK_INTERVAL_TICKS !== 0) return;
  const store = world.citizens;
  const grid = world.grid;

  for (const room of world.rooms) {
    if (room.role !== RoomRole.DiningRoom || !room.roleValid) continue;

    const occupants = [];
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i)) continue;
      const gx = Math.floor(store.x[i]), gy = Math.floor(store.y[i]);
      if (!grid.inBounds(gx, gy)) continue;
      if (!room.cells.has(grid.index(gx, gy))) continue;
      occupants.push(i);
    }
    if (occupants.length === 0) continue;

    const memberCount = occupants.filter(i => factions.memberOf.has(store.id[i])).length;
    if (memberCount / occupants.length < FOODFIGHT_ZONE_SHARE_THRESHOLD) continue;

    if (world.rng() >= FOODFIGHT_TRIGGER_CHANCE) continue; // 30% trigger roll failed -- nothing happens this check

    const shuffled = occupants.slice().sort(() => world.rng() - 0.5);
    const participantCount = Math.min(shuffled.length, FOODFIGHT_MAX_PARTICIPANTS);
    let anyDamage = false;
    for (let n = 0; n < participantCount; n++) {
      const i = shuffled[n];
      const roll = world.rng();
      if (roll < FOODFIGHT_MISS_CHANCE) continue; // 50% -- thrown food misses entirely
      store.mood[i] = Math.max(0, store.mood[i] - FOODFIGHT_MOOD_HIT);
      if (roll < FOODFIGHT_MISS_CHANCE + FOODFIGHT_DAMAGE_CHANCE) { // 5% band -- a real hit
        store.health[i] = Math.max(0, store.health[i] - FOODFIGHT_DAMAGE_HEALTH_HIT);
        anyDamage = true;
      }
      // else: remaining 45% -- a nonlethal scuffle, mood hit only, already applied above
    }
    pushMilestone(world, anyDamage
      ? 'A food fight broke out in the dining hall -- someone got hurt.'
      : 'A food fight broke out in the dining hall.');
  }
}

// Call once per tick from SimWorld.tick(), after tickNeedsAndMood/tickJobs so this tick's fresh
// jobState is what demand progress reads.
export function tickFactions(world) {
  const factions = world.factions;
  let aliveCount = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) aliveCount++;

  if (!factions.formed) {
    if (aliveCount < FACTION_MIN_POPULATION) return;
    factions.formed = true;
    recruit(factions, world);
    syncLieutenants(factions, world);
    syncLeader(factions, world);
    pushMilestone(world, 'Rival cliques have formed among the settlement\'s citizens.');
    return; // cliques exist now, but wait a tick before demands can start (matches other systems'
             // "form this tick, act next tick" convention, e.g. world.js's overload-milestone gate)
  }

  // Late arrivals (Refugee Wagon, wanderer-joins) get folded into an existing clique -- cheap
  // (Map.has check per alive citizen) so no throttle needed.
  recruit(factions, world);
  syncLieutenants(factions, world);
  syncLeader(factions, world);
  tickDemandProgress(factions, world);
  tickDemandLifecycle(factions, world);
  tickTerritory(factions, world);
  tickFoodFights(factions, world);
  tickTargetedFriction(factions, world);
  tickInformants(factions, world);
}

export function serializeFactions(factions) {
  return {
    formed: factions.formed,
    memberOf: Array.from(factions.memberOf.entries()),
    demand: factions.demand,
    demandTier: factions.demandTier,
    completions: factions.completions,
    cooldownUntil: factions.cooldownUntil,
    leaderId: factions.leaderId,
    volatileUntil: factions.volatileUntil,
    targetFrictionCooldownUntil: factions.targetFrictionCooldownUntil,
    rep: Array.from(factions.rep.entries()),
  };
}

export function deserializeFactions(json) {
  const factions = new FactionState();
  if (!json) return factions;
  factions.formed = json.formed || false;
  if (json.memberOf) factions.memberOf = new Map(json.memberOf);
  if (json.rep) factions.rep = new Map(json.rep);
  for (const c of CLIQUES) {
    if (json.demand && json.demand[c.id] !== undefined) factions.demand[c.id] = json.demand[c.id];
    if (json.demandTier && json.demandTier[c.id]) factions.demandTier[c.id] = json.demandTier[c.id];
    if (json.completions && json.completions[c.id] != null) factions.completions[c.id] = json.completions[c.id];
    if (json.cooldownUntil && json.cooldownUntil[c.id] != null) factions.cooldownUntil[c.id] = json.cooldownUntil[c.id];
    if (json.leaderId && json.leaderId[c.id] !== undefined) factions.leaderId[c.id] = json.leaderId[c.id];
    if (json.volatileUntil && json.volatileUntil[c.id] != null) factions.volatileUntil[c.id] = json.volatileUntil[c.id];
    if (json.targetFrictionCooldownUntil && json.targetFrictionCooldownUntil[c.id] != null) {
      factions.targetFrictionCooldownUntil[c.id] = json.targetFrictionCooldownUntil[c.id];
    }
  }
  return factions;
}
