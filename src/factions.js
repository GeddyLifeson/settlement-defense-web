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

// 3 named cliques (real PA: Vipers/BoneBreakers/Jackals, each with a PreferredMisbehaviour and
// trait preferences). affinityTraits reference traits.js's TRAITS[].name -- a citizen with one of
// these traits is AFFINITY_WEIGHT times as likely to be recruited into this clique over the others.
export const CLIQUES = [
  {
    id: 'scrappers', name: 'Scrappers', color: '#c96a3e',
    preferredMisbehaviour: 'Scrapping', // reskin of real Vipers/Fighting -- short tempers, not violence against staff
    affinityTraits: ['Tough', 'Neurotic'],
  },
  {
    id: 'wreckers', name: 'Wreckers', color: '#9a4f9a',
    preferredMisbehaviour: 'Wrecking', // reskin of real BoneBreakers/Destroying -- property damage, reskinned genre-neutral
    affinityTraits: ['Hardy', 'Glutton'],
  },
  {
    id: 'runners', name: 'Runners', color: '#3e8fc9',
    preferredMisbehaviour: 'Slipping Off', // reskin of real Jackals/Escaping -- abandoning duty, not a prison break
    affinityTraits: ['Fast', 'Loner'],
  },
];

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
    for (const c of CLIQUES) {
      this.demand[c.id] = null;
      this.demandTier[c.id] = 'base';
      this.completions[c.id] = 0;
      this.cooldownUntil[c.id] = 0;
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
  world.unrestLevel = Math.min(1, world.unrestLevel + UNMET_DEMAND_UNREST_BUMP);
  const scrapLoss = Math.min(world.scrap, UNMET_DEMAND_SCRAP_LOSS);
  world.scrap -= scrapLoss;

  const members = [];
  for (let i = 0; i < world.citizens.count; i++) {
    if (!world.citizens.isAliveAt(i)) continue;
    if (factions.memberOf.get(world.citizens.id[i]) === clique.id) members.push(i);
  }

  if (clique.preferredMisbehaviour === 'Scrapping') {
    // Fighting-analog: a couple of members get worked up -- a real mood/OnBreak hit (feeds
    // citizens.js's own on-break work-speed penalty), not violence against the protection force.
    for (let n = 0; n < Math.min(2, members.length); n++) {
      const i = members[Math.floor(world.rng() * members.length)];
      world.citizens.mood[i] = Math.max(0, world.citizens.mood[i] - 0.15);
      world.citizens.flags[i] |= CitizenFlags.OnBreak;
    }
  } else if (clique.preferredMisbehaviour === 'Wrecking') {
    // Destroying-analog: real property damage to a random structure, same health/destroyed
    // mechanism fire.js's igniteStructure-driven damage already uses -- turrets and walls are
    // excluded (walls aren't real Structure objects once built, see world.js; turrets are the
    // colony's actual defense and a griefing-tier "your defense gets sabotaged" isn't the intent).
    const candidates = world.structures.filter(s =>
      !s.destroyed && !s.underConstruction && s.kind !== 'turret' && s.kind !== 'wall');
    if (candidates.length > 0) {
      const target = candidates[Math.floor(world.rng() * candidates.length)];
      target.health = Math.max(0, target.health - STRUCTURE_DAMAGE_FRACTION);
      if (target.health <= 0) target.destroyed = true;
    }
  } else if (clique.preferredMisbehaviour === 'Slipping Off') {
    // Escaping-analog: a member abandons whatever they were doing (real, mechanical -- loses
    // build/harvest/taming progress, see interruptJob above), not a carceral "escape attempt".
    for (let n = 0; n < Math.min(2, members.length); n++) {
      const i = members[Math.floor(world.rng() * members.length)];
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
  }
  factions._recreatingLastTick = nowRecreating;
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
        factions.cooldownUntil[clique.id] = world.currentTick + FACTION_DEMAND_COOLDOWN_TICKS;
        factions.demand[clique.id] = null;
        pushMilestone(world, `${clique.name} demand satisfied -- +${reward} scrap. They'll want more next time.`);
      } else if (world.currentTick >= active.deadlineTick) {
        applyUnmetConsequence(clique, factions, world);
        factions.cooldownUntil[clique.id] = world.currentTick + FACTION_DEMAND_COOLDOWN_TICKS;
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
    pushMilestone(world, 'Rival cliques have formed among the settlement\'s citizens.');
    return; // cliques exist now, but wait a tick before demands can start (matches other systems'
             // "form this tick, act next tick" convention, e.g. world.js's overload-milestone gate)
  }

  // Late arrivals (Refugee Wagon, wanderer-joins) get folded into an existing clique -- cheap
  // (Map.has check per alive citizen) so no throttle needed.
  recruit(factions, world);
  tickDemandProgress(factions, world);
  tickDemandLifecycle(factions, world);
}

export function serializeFactions(factions) {
  return {
    formed: factions.formed,
    memberOf: Array.from(factions.memberOf.entries()),
    demand: factions.demand,
    demandTier: factions.demandTier,
    completions: factions.completions,
    cooldownUntil: factions.cooldownUntil,
  };
}

export function deserializeFactions(json) {
  const factions = new FactionState();
  if (!json) return factions;
  factions.formed = json.formed || false;
  if (json.memberOf) factions.memberOf = new Map(json.memberOf);
  for (const c of CLIQUES) {
    if (json.demand && json.demand[c.id] !== undefined) factions.demand[c.id] = json.demand[c.id];
    if (json.demandTier && json.demandTier[c.id]) factions.demandTier[c.id] = json.demandTier[c.id];
    if (json.completions && json.completions[c.id] != null) factions.completions[c.id] = json.completions[c.id];
    if (json.cooldownUntil && json.cooldownUntil[c.id] != null) factions.cooldownUntil[c.id] = json.cooldownUntil[c.id];
  }
  return factions;
}
