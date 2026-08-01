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

    let bestId = null, bestCount = 0;
    for (const c of CLIQUES) {
      if (counts[c.id] > bestCount) { bestCount = counts[c.id]; bestId = c.id; }
    }

    if (bestId && bestCount >= TERRITORY_MIN_MEMBERS && room.territoryClique !== bestId) {
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
    pushMilestone(world, 'Rival cliques have formed among the settlement\'s citizens.');
    return; // cliques exist now, but wait a tick before demands can start (matches other systems'
             // "form this tick, act next tick" convention, e.g. world.js's overload-milestone gate)
  }

  // Late arrivals (Refugee Wagon, wanderer-joins) get folded into an existing clique -- cheap
  // (Map.has check per alive citizen) so no throttle needed.
  recruit(factions, world);
  syncLieutenants(factions, world);
  tickDemandProgress(factions, world);
  tickDemandLifecycle(factions, world);
  tickTerritory(factions, world);
  tickFoodFights(factions, world);
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
