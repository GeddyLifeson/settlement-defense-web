// Ported from SD.Headless/SimWorld.cs -- the composition root that owns every store/system
// and advances them one fixed tick at a time (10 Hz, matching ARCHITECTURE.md section 2).
import { makeRng, AggressionPreset, StaffRoleKind } from './core.js';
import { SettlementGrid } from './grid.js';
import { CitizenStore, tickNeedsAndMood, tickWander, CitizenFlags, addMoodEvent } from './citizens.js';
import { JobState } from './jobs.js';
import { StaffRoster, tickStaffDuty, tickStaffOffDuty, tickDogs, maybeSpawnWildAnimal, tickWildAnimals, tickDogBreeding, tickArmoryIssuance, tickStaffCorruption, tickStaffTraining, upgradeDog, tickAmmoProduction, AMMO_BASE_CAPACITY } from './security.js';
import {
  AttackerStore, Structure, WaveSpawner, tickAttackers, tickTurrets,
  tickAttackerVsCitizens, tickStaffCombat, tickNuclearHazard, isNuclearContained,
  NUCLEAR_WASTE_RATE, ArrivalMethod, maybeTriggerHeldCitizenCrisis, tickHeldCitizenCrisis,
  tickSuppression,
} from './siege.js';
import { ZoneGrid, ZoneKind } from './zones.js';
import { tickJobs, isOnJob, tickCinemas } from './jobs.js';
import { tickDrones, tickDroneFabrication, Drone, bumpDroneIdCounter } from './drones.js';
import { tickDrafted } from './draft.js';
import { RelationshipWeb } from './relationships.js';
import { directWaveSpawner } from './director.js';
import { TRAITS } from './traits.js';
import { scatterNodes, maybeSpawnNode, ResourceNode } from './resources.js';
import { tickVehicles, spawnParkedVehicle, parseGarageKind } from './vehicles.js';
import { detectRooms, roomContaining, computeRoomStats } from './rooms.js';
import { isWateredAt } from './water.js';
import { isWindSited, hasPoweredBonus, isSegmentOverloadedAt, overloadedSupplyKeys, OVERLOAD_FIRE_CHANCE_PER_TICK, tickBatteries, tickPowerExporters } from './power.js';
import { tickFireIgnition, tickFire, igniteStructure, FIRE_SPREAD_DIFFICULTY_MULT } from './fire.js';
import { DAY_NIGHT_CYCLE_TICKS } from './schedule.js';
import { FactionState, tickFactions, serializeFactions, deserializeFactions } from './factions.js';
import { tickWorldMap } from './worldmap.js';
import { createResearchState, tickResearch, serializeResearch, deserializeResearch, isNodeUnlocked } from './research.js';
import { initWeather, tickWeather, tickRandomEvents, tickThunderstorm, weatherWanderSpeedMult, weatherAccuracyMult, weatherMoveSpeedMult, isHeatwaveSlowdownActive, HEATWAVE_WANDER_SPEED_MULT, tickLightningStorm, lightningStormMoveMult, tickHazardCondition } from './weather.js';
import { computeGrading, GRADING_INTERVAL_TICKS } from './grading.js';
import { canAfford, spend } from './economy.js'; // buyVest below -- see citizens.js's hasVest field
import { tryBuyAugment } from './augments.js'; // buyAugment below -- see citizens.js's augmentMask field
import { checkWaveAchievements, checkPopulationAchievement, recordGameEnd } from './metaprogress.js';
import { initRats, tickRatInfestation, tickRats, Rat } from './rats.js';
import { tickSickness } from './sickness.js';
import { initEpidemic, tickEpidemic, epidemicMoveMultFor } from './epidemic.js';
import { initAnomaly, tickAnomalyPressure, tickAnomalyEvents } from './anomaly.js';
import { tickPipeFreezing } from './water.js';
import { syncProgramSites } from './programs.js';
import { createGrantState, tickGrants, serializeGrants, deserializeGrants } from './grants.js';
import { initSupplies, tickSupplyDelivery, tickDependency, inspectDelivery, searchDelivery, forceTaintedDelivery } from './supplies.js';
import { securityResponseAccuracyMult, tickSecurityResponse } from './coverageplans.js';

// Exported: weather.js's wanderer-joins event draws from this same pool (via world._namePool)
// rather than importing it directly, to avoid a circular import (world.js already imports
// weather.js). Extended with 12 extra names beyond the starting 24 -- the default colony uses
// all 24 starter names immediately, so a wanderer event needs names past that to hand out,
// and a long soak test can see more than one join.
export const STARTER_NAMES = [
  'Marlon', 'Aisling', 'Niamh', 'Reeli', 'Cascade', 'Orrery', 'Motoko',
  'Briar', 'Ansel', 'Sable', 'Quinn', 'Vesper', 'Rowan', 'Isolde', 'Callan',
  'Freya', 'Bram', 'Elowen', 'Tavish', 'Maren', 'Cormac', 'Sorcha', 'Declan', 'Aoife',
  'Fintan', 'Saoirse', 'Eamon', 'Niall', 'Grainne', 'Cian', 'Roisin', 'Tadhg',
  'Aileen', 'Cathal', 'Brigid', 'Ruairi',
];

const RECYCLING_WATER_BONUS = 1.4; // see the pump/pipe check in the pollution tick below
// Recycling Throughput research node (real PA anchor: RecyclingIncentive, cost 2500/time 720 --
// see research.js's 'recycling_throughput' node): a real +40% multiplier on each Recycling
// Center's per-tick processing capacity once researched, applied on top of (not instead of) the
// existing water-grid bonus above -- both stack, same "provisioned beats unprovisioned, upgraded
// beats stock" logic as the rest of this system.
const RECYCLING_THROUGHPUT_RESEARCH_MULT = 1.4;
// Mood-event trigger radius for "witnessed a nearby combat death" (citizens.js's addMoodEvent,
// see the tickAttackerVsCitizens call below) -- generous enough that a citizen fleeing a raid
// still counts as having witnessed it, without being map-wide.
const WITNESS_DEATH_RADIUS = 6;

// Refugee Wagon (SEA:R's "Prisoner Bus" analog -- see FEATURE_RESEARCH.md's RETHINK/omit list:
// "Prisoner Bus (no equivalent, omit -- optional 'Refugee Wagon' analog if population-growth-
// via-arrivals is wanted)"). Distinct from weather.js's wanderer-joins event: that one is a flat
// rare roll regardless of population and adds one citizen near the core; this one is *reactive*
// -- it only turns on once losses have actually thinned the settlement below its starting size,
// arrives as a small group at the map edge (like a wave, but obviously friendly -- see siege.js's
// WaveSpawner edge-picking for the precedent), and has its own name pool (cycling with a numeric
// suffix once exhausted) so it never contends with the wanderer event's shared world._namePool.
const REFUGEE_NAMES = [
  'Torin', 'Wren', 'Iona', 'Faolan', 'Brynn', 'Saoirse', 'Eamon', 'Fintan',
  'Nessa', 'Cian', 'Aideen', 'Ruarc', 'Meara', 'Lorcan', 'Siobhan', 'Odhran',
];
const REFUGEE_GRACE_TICKS = 300;    // no wagon before the first wave's own grace period has passed
const REFUGEE_CHECK_INTERVAL = 500; // same order of magnitude as resources.js's maybeSpawnNode
const REFUGEE_CHANCE = 0.35;        // rolled once per check, only when the population gate below allows it
const REFUGEE_POP_FRACTION = 0.9;   // gate: only arrives while alive population is below this fraction of the starting count
const REFUGEE_MIN_GROUP = 1;
const REFUGEE_MAX_GROUP = 3;
const FINANCE_SNAPSHOT_INTERVAL = 300; // ticks between budget-report history snapshots, see finance comment below
const FINANCE_HISTORY_MAX = 20; // capped rolling window of finance snapshots kept for the trend sparkline

// Unrest (Prison Architect's riot state-machine, reframed genre-neutral): a COLONY-WIDE crisis
// distinct from an individual citizen's OnBreak (citizens.js -- that's a per-citizen speed/render
// state that fires whenever *one* citizen's own mood crashes). unrestLevel blends the fraction of
// the living population currently OnBreak with the Settlement Grading Wellbeing axis (grading.js
// -- reused rather than re-averaging mood a second time) and eases toward that blend each
// throttle step rather than snapping, same "slow trend, not a single bad tick" idea as
// citizens.js's mood easing. unrestActive only flips on once unrestLevel has sat at or above
// UNREST_TRIGGER_THRESHOLD for UNREST_SUSTAIN_TICKS running ticks (a genuine sustained crisis,
// not one bad reading) and resolves at a lower UNREST_RESOLVE_THRESHOLD (hysteresis, so it can't
// flicker on/off right at the boundary) -- there's no player action to "put it down", it resolves
// on its own once the same root causes an individual OnBreak already responds to (beds, food,
// room quality) improve. The actual penalty while active lives in jobs.js (UNREST_RATE_MULT),
// applied to every citizen's work/build/harvest/travel rate, not just the already-OnBreak ones --
// see that file's constant for the exact multiplier.
const UNREST_INTERVAL_TICKS = GRADING_INTERVAL_TICKS; // piggyback grading.js's own throttle cadence -- wellbeing only updates this often anyway
const UNREST_EASE = 0.15; // per UNREST_INTERVAL_TICKS step
const UNREST_TRIGGER_THRESHOLD = 0.55; // deliberately high -- this should be rare, not background noise
const UNREST_RESOLVE_THRESHOLD = 0.35;
const UNREST_SUSTAIN_TICKS = 600; // ~60s at 10Hz sustained at/above the trigger threshold before it actually flips on

// Unrest tiers (Prison Architect calamity_settings.txt's real 3-tier calamity shape, reframed
// genre-neutral): each tier ADDS a new consequence on top of the prior tier's, rather than just
// scaling the same penalty bigger. Tier 1 (UNREST_TRIGGER_THRESHOLD, above) is unchanged -- the
// existing UNREST_RATE_MULT colony-wide rate penalty (jobs.js) only. Tier 2 adds a periodic
// "acting out" scuffle event at whichever Food/Recreation zone has citizens actually present.
// Tier 3 is a stronger version of the same event (higher chance, real chance of downing someone)
// rather than a wholly new mechanic -- no held-citizen/corrupt-staff system exists yet in
// security.js/siege.js to build a genuinely distinct tier-3 consequence on top of (checked both
// files fresh before writing this), so escalating the existing event's severity is the honest
// scope here, matching how real PA's own Heatwave/Cold Snap tiers often just intensify the same
// failure mode at tier 3 rather than always introducing something brand new.
const UNREST_TIER2_THRESHOLD = 0.70;
const UNREST_TIER3_THRESHOLD = 0.85;
// Real PA numbers for the Food Fight event this is modeled on: ChanceOfFoodFight 30%,
// ChanceFoodCauseDamage 5%. Tier 3 scales both up rather than inventing a new roll.
const UNREST_EVENT_PARAMS = {
  2: { chanceOfEvent: 0.30, chanceCauseDamage: 0.05, label: 'scuffle' },
  3: { chanceOfEvent: 0.45, chanceCauseDamage: 0.15, label: 'brawl' },
};
const UNREST_EVENT_MOOD_HIT = 0.08;
const UNREST_EVENT_HEALTH_HIT = 0.1;
const UNREST_EVENT_DOWN_HEALTH = 0.2; // tier 3's damage roll downs the citizen instead of just hurting them

// Crisis-resolution reward (Prison Architect calamity_rewards.txt pattern: survive a crisis while
// keeping a real stat above a bar -> a genuine buff on resolution, not just penalty during).
// _unrestCrisisMinWellbeing tracks the worst grading.js Wellbeing reading seen at any point while
// unrestTier > 0; if it never dropped below UNREST_REWARD_WELLBEING_BAR, the colony earns a real
// temporary build/harvest speed boost the moment the crisis fully resolves back to tier 0.
const UNREST_REWARD_WELLBEING_BAR = 55; // grading.js's wellbeing axis is 0-100
const UNREST_REWARD_DURATION_TICKS = 1500; // ~150s at 10Hz
export const UNREST_REWARD_RATE_MULT = 1.15; // read by jobs.js wherever it already applies UNREST_RATE_MULT

export class SimWorld {
  constructor(width, height, seed, aggression = AggressionPreset.Calm, startingCitizens = 24) {
    this.width = width;
    this.height = height;
    this.seed = seed;
    this.aggression = aggression;
    this.rng = makeRng(seed);
    this.currentTick = 0;
    this.timeOfDay = 0.3; // Duty Roster day/night cycle, 0-1 fraction; start mid-morning (Work block)
    this.paused = false;
    this.gameOver = false;
    this.milestoneLog = [];
    // power.js's overload mechanic: tick-over-tick diff set so the milestone below logs only the
    // first tick a given segment/nuclear-bucket actually crosses into overload, not every tick it
    // stays there. Purely transient bookkeeping -- deliberately not part of save/load state.
    this._prevOverloadedSupply = new Set();
    this.pollution = 0; // SEA:R's signature mechanic -- unmanaged waste makes waves worse, see director.js
    this.nuclearWaste = 0; // separate hazard resource from a nuclear generator, see siege.js's NUCLEAR_* comment
    // Ammo economy (this session's ammo/suppression pass -- see security.js's tickAmmoProduction/
    // AMMO_* doc comment for the full design reasoning): a single global stockpile, same "one
    // running total" shape as scrap/pollution/nuclearWaste above, replenished by built Armories
    // (tickAmmoProduction, called in tick() below) and spent by tickTurrets/tickStaffCombat via
    // this.consumeAmmo(). Starts FULL at the zero-Armory base capacity (not some arbitrary number
    // that could exceed it) -- tickAmmoProduction clamps world.ammo to world.ammoCapacity every
    // tick, so seeding this any higher than AMMO_BASE_CAPACITY would just get silently clamped
    // back down on the very first tick, which is exactly the real bug this comment is warning the
    // next editor away from re-introducing (caught live in this pass's own soak-test verification).
    this.ammoCapacity = AMMO_BASE_CAPACITY;
    this.ammo = AMMO_BASE_CAPACITY;
    this.ethanolPenaltyTimer = 0; // ethanol-fuel truck tradeoff (vehicles.js) -- counts down after a haul, halving Food zone refill meanwhile
    this.storyteller = 'Cassandra'; // Cassandra | Phoebe | Randy, see director.js STORYTELLERS
    this.rooms = []; // enclosed-room flood-fill, see rooms.js -- recomputed only when walls change
    this._roomsWallSignature = null;
    this._namePool = STARTER_NAMES; // weather.js's wanderer event draws unused names from here

    this.grid = new SettlementGrid(width, height);
    this.zones = new ZoneGrid(width, height);
    this.citizens = new CitizenStore(64);
    this.attackers = new AttackerStore(1024);
    this.roster = new StaffRoster();
    this.structures = [];
    this.waveSpawner = new WaveSpawner(this.grid);
    this.relationships = new RelationshipWeb();
    this.scrap = 50;
    // Tech-unlock progression (research.js): passive Research Points, plus the set of unlocked
    // nodes. The survival-core buildables are unlocked in createResearchState, so a brand new
    // colony can still wall up and put down turrets on tick 0.
    this.research = createResearchState();
    this._lastWaveLogged = 0;
    // Coverage Plans (coverageplans.js): set of purchased plan kinds, one-time economy-sink
    // buildable-discount + threshold-gated call-in bundles. Empty Set is the fresh-colony default.
    this.coveragePlans = new Set();
    // Security Response Plan's tactical-reinforcement call-in: ticks remaining on its temporary
    // turret/staff accuracy-boost window (0 = inactive). Owned here rather than in
    // coverageplans.js since every other per-tick countdown in this project lives on `this`.
    this._securityResponseTicksLeft = 0;

    // Per-run counters feeding metaprogress.js's cross-run lifetime stats (see that module's
    // header comment) -- purely additive bookkeeping here, this world instance dies at
    // game-over/restart/quit-to-title same as everything else on it, but the numbers get folded
    // into localStorage's lifetime totals right before that happens (recordGameEnd/
    // recordGameAbandoned, called from this file's tick() and from main.js respectively).
    this.peakAliveCitizens = 0;   // highest alive-citizen count seen this run, updated in tick()
    this.attackersKilled = 0;     // count (not scrap) of attackers killed this run, see addScrap()
    this.scrapEarnedThisRun = 0;  // cumulative scrap EARNED this run, never decremented by spending -- distinct from this.scrap

    // Budget/finance ledger (Prison Architect's budget report, see FEATURE_RESEARCH.md): the
    // scrap economy itself is unchanged (still just world.scrap, a single running total) -- this
    // is purely a reporting layer on top, tallying WHERE scrap came from/went so a UI can show a
    // breakdown instead of just the bare number. Deliberately per-category running totals, not a
    // full itemized transaction log -- much cheaper to maintain given how many call sites feed
    // scrap in (siege.js kills, jobs.js harvesting, vehicles.js hauls, the recycling-center
    // trickle and conquest-layer trickle in this file, worldmap.js's supply lines) and plenty for
    // a budget report / trend sparkline.
    this.finance = {
      killScrap: 0,       // attacker kills: turrets, staff combat, traps, dogs (siege.js/security.js)
      harvestScrap: 0,    // citizens hand-harvesting resource nodes (jobs.js)
      haulScrap: 0,       // recycling/garbage truck completed hauls (vehicles.js)
      recyclingScrap: 0,  // passive Recycling Center trickle (this file, tick())
      conquestScrap: 0,   // held-region supply lines trickling scrap in (worldmap.js)
      processingScrap: 0, // net of the 'workshop' Processing job's raw-in/Components-out chain (jobs.js)
      farmScrap: 0,       // 'farm_plot' Farming job's per-cycle payout (jobs.js, research.js's Agronomy node)
      restaurantScrap: 0, // 'restaurant' Restaurant job's per-cycle retail-income payout (jobs.js)
      factionScrap: 0,    // rewards from satisfied clique demands (factions.js)
      grantScrap: 0,      // Outpost Charter Contract payouts + matured investments (grants.js)
      powerExportScrap: 0, // passive Power Exporter trickle off genuine grid surplus (power.js's tickPowerExporters)
      otherScrap: 0,      // catch-all for any future/uncategorized income source
      buildSpend: 0,      // total scrap spent on construction (economy.js spend())
      history: [],        // rolling snapshots of net scrap change, one per FINANCE_SNAPSHOT_INTERVAL
                           // ticks, capped at FINANCE_HISTORY_MAX entries -- enough for a trend sparkline
    };
    this._financeLastIncome = 0; // sum of all *Scrap categories as of the last snapshot
    this._financeLastExpense = 0; // buildSpend as of the last snapshot

    // Settlement Grading (non-carceral reframe of Prison Architect's 4-axis Grading tab, see
    // grading.js's header comment): purely a read-only reporting layer, recomputed periodically
    // in tick() below. Seeded with an optimistic default so the UI has something sane to show
    // before the first GRADING_INTERVAL_TICKS elapses; computeGrading() is also called once here
    // so a fresh colony shows its real scores immediately rather than placeholder 100s.
    this.grading = { safety: 100, wellbeing: 100, sustainability: 100, cohesion: 100 };
    this._gradingPrevScrap = this.scrap;

    // Unrest (see the UNREST_* constants' doc comment above): starts calm/inactive, updated by
    // _updateUnrest() below every UNREST_INTERVAL_TICKS.
    this.unrestLevel = 0;
    this.unrestActive = false;
    this._unrestAboveTicks = 0; // running count of ticks unrestLevel has sat at/above UNREST_TRIGGER_THRESHOLD
    // Tier escalation (see UNREST_TIER2/3_THRESHOLD above): unrestTier is 0 (calm)/1/2/3, each
    // tier's own above-ticks counter mirrors _unrestAboveTicks's sustained-duration gate one rung
    // up. _unrestCrisisMinWellbeing/unrestResolutionBuffTicks implement the calamity_rewards.txt
    // survive-well -> real buff pattern, see the doc comment above.
    this.unrestTier = 0;
    this._unrestTier2AboveTicks = 0;
    this._unrestTier3AboveTicks = 0;
    this._unrestCrisisMinWellbeing = Infinity;
    this.unrestResolutionBuffTicks = 0;

    // worldmap.js's arrival-mishap system (Odyssey LandingOutcomeDef-style, toned down): a fresh
    // settlement can land with a short work-speed debuff instead of/alongside a minor scrap loss.
    // main.js's expandTo() sets this to the mishap's duration right after constructing the new
    // SimWorld; tick() below counts it down. jobs.js's arrivalMishapRateMultFor() reads it the
    // same way unrestRateMultFor() reads unrestActive/unrestResolutionBuffTicks above.
    this.arrivalMishapTicks = 0;

    // Citizen cliques + faction demands (factions.js, reskinned Prison Architect gang-demand
    // system -- see that file's header comment for the real numbers this was ported from). Owns
    // its own state object (same "own store, ticked from here" pattern as this.roster/
    // this.waveSpawner); FactionState.formed stays false (no-op tickFactions calls) until alive
    // population first reaches FACTION_MIN_POPULATION.
    this.factions = new FactionState();

    // Held-citizen crisis (siege.js's maybeTriggerHeldCitizenCrisis/tickHeldCitizenCrisis,
    // reskinned Prison Architect riot_hostages/riot_roulette staged escalation): a citizen seized
    // at the top unrest tier, resolved over a few beats depending on whether security responds in
    // time. Owns its own small state object, same pattern as this.roster/this.waveSpawner/
    // this.factions -- see siege.js's own doc comment for the full mechanic.
    this.heldCitizenEvent = { active: false, citizenId: null, beat: 0, beatCount: 0, beatEndTick: 0, pauseUntilTick: null };
    this._heldCitizenCooldownUntil = 0;

    // Outpost Charter Contracts + time-locked investments (grants.js, reskinned Prison Architect
    // grants.lua): own small state object, same pattern as this.factions/this.heldCitizenEvent
    // above -- see grants.js's header comment for the full mechanic and the real numbers it was
    // scaled from.
    this.grants = createGrantState();

    // Presentation-layer audio hooks (see audio.js) -- optional callbacks the host app (main.js)
    // can assign after construction. Left null by default so world.js/siege.js never need to
    // know audio.js exists; called via optional chaining everywhere below.
    this.onBuildComplete = null; // (structure) => void, fires once when a blueprint finishes
    this.onWaveIncoming = null;  // () => void, fires when a new wave's "incoming" milestone posts
    this.onTurretFire = null;    // (structure) => void, fires when a turret/tesla actually shoots
    this.onKill = null;          // () => void, fires whenever an attacker is killed
    this.onCitizenDowned = null; // () => void, fires when a citizen goes down or dies to an attacker
    this.onRandomEvent = null;   // (text) => void, fires on a weather change or a one-off random event (weather.js)
    this.onCitizenOnBreak = null; // () => void, fires the instant a citizen newly enters CitizenFlags.OnBreak (citizens.js)

    initWeather(this); // sets this.weather / this._weatherTimer, see weather.js

    const count = Math.min(startingCitizens, STARTER_NAMES.length);
    this.startingCitizenCount = count; // Refugee Wagon's population gate below reacts to losses relative to this
    this._nextRefugeeNameIndex = 0;    // Refugee Wagon's own name-pool cursor, independent of _namePool above
    this._citizenIds = [];
    for (let n = 0; n < count; n++) {
      const x = 15 + (n % 8) * 2;
      const y = 15 + Math.floor(n / 8) * 2;
      const idx = this.citizens.spawn(STARTER_NAMES[n], x, y, this.rng);
      this._citizenIds.push(this.citizens.id[idx]);
    }

    this.dogs = [];
    this.wildAnimals = []; // untamed animals, distinct from world.dogs until jobs.js's Taming job succeeds -- see security.js
    // Structured Group Programs (programs.js): one ProgramSite per validated room matching a
    // program kind's roomRole -- see syncProgramSites, called from tick() right after room stats
    // recompute so a freshly-walled/staffed room is picked up the same tick it validates.
    this.programSites = [];
    if (count > 3) {
      // Small patrol loops (security.js's patrol-route support) rather than a single fixed
      // point -- each guard/sniper paces a couple tiles either side of their original post, still
      // well within GUARD_RANGE/SNIPER_RANGE (siege.js) so combat effectiveness is unchanged.
      this.roster.assign(this._citizenIds[0], StaffRoleKind.Sniper, [{ x: 12, y: 20 }, { x: 14, y: 20 }]);
      this.roster.assign(this._citizenIds[1], StaffRoleKind.Sniper, [{ x: 28, y: 20 }, { x: 30, y: 20 }]);
      this.roster.assign(this._citizenIds[2], StaffRoleKind.Guard, [{ x: 20, y: 13 }, { x: 22, y: 13 }]);
      this.roster.assign(this._citizenIds[3], StaffRoleKind.Guard, [{ x: 20, y: 27 }, { x: 22, y: 27 }]);
    }
    if (count > 4) {
      this.roster.assign(this._citizenIds[4], StaffRoleKind.K9Handler, { x: 21, y: 20 });
      this.dogs.push({ ownerId: this._citizenIds[4], x: 21, y: 20, cooldown: 0 });
    }

    for (const [tx, ty] of [[13, 20], [29, 20], [21, 13], [21, 27]]) {
      this.structures.push(new Structure('turret', tx, ty, { instant: true }));
    }

    // Default zones so the job system has somewhere to send citizens out of the box.
    for (let x = 17; x <= 20; x++) for (let y = 17; y <= 20; y++) this.zones.set(x, y, ZoneKind.Food);
    for (let x = 22; x <= 25; x++) for (let y = 17; y <= 20; y++) this.zones.set(x, y, ZoneKind.Bedroom);
    for (let x = 17; x <= 20; x++) for (let y = 22; y <= 23; y++) this.zones.set(x, y, ZoneKind.Recreation);
    // Training zone (programs.js's Skills Workshop -- see zones.js's ZoneKind.Training/rooms.js's
    // RoomRole.Training): same "unenclosed by default" precedent as the three zones above -- the
    // player still has to wall it in for it to validate as a Training Room, this just gives the
    // job system somewhere to point a citizen out of the box, same reasoning as those.
    for (let x = 22; x <= 25; x++) for (let y = 22; y <= 23; y++) this.zones.set(x, y, ZoneKind.Training);

    initRats(this); // rats.js -- infestation level/rat pool, see that file's header comment
    initEpidemic(this); // epidemic.js -- proximity-spread outbreak state, see that file's header comment
    initAnomaly(this); // anomaly.js -- colony-wide anomaly pressure meter, see that file's header comment
    initSupplies(this); // supplies.js -- tainted-delivery investigation state, see that file's header comment

    this.resourceNodes = scatterNodes(this.grid, this.rng, 16, 14, this.width / 2, this.height / 2);
    this.vehicles = [];
    this._nextVehicleTick = 200;

    // Labor drones (drones.js -- RimWorld Biotech's mech-companion analog): live drones and their
    // fabrication queue, same "own small array, ticked from here" shape as this.vehicles/this.dogs
    // above. Empty until the player builds a Fabrication Bay -- no drones exist on tick 0.
    this.drones = [];
    this.droneFabricationQueue = [];

    computeGrading(this); // real scores from tick 0, not the placeholder defaults set above
  }

  idOf(i) { return this.citizens.id[i]; }
  isStaffAt(i) { return this.roster.isStaff(this.citizens.id[i]); }
  // A staff member currently clocked off (security.js's fatigue cycle) isn't "on duty" for the
  // purposes of holding a post/patrol, the on-duty social-fulfillment bonus, or jobs.js's
  // staff-skip check -- they're on an Eat/Sleep trip like any citizen until they recover.
  isStaffOnDutyAt(i) { return this.isStaffAt(i) && !this.roster.isOffDuty(this.citizens.id[i]); }

  // "Manned" means a live, non-downed citizen with StaffRoleKind.Monitor is actually standing at
  // the Monitor Station post, not just assigned on paper -- same physical-presence requirement
  // as Guard/Sniper posts (tickStaffDuty walks them there each tick).
  _isMonitorStaffed(monitorStation) {
    for (let i = 0; i < this.citizens.count; i++) {
      if (!this.citizens.isAliveAt(i) || this.citizens.isDownedAt(i)) continue;
      if (this.roster.kindOf(this.idOf(i)) !== StaffRoleKind.Monitor) continue;
      const dx = this.citizens.x[i] - monitorStation.x;
      const dy = this.citizens.y[i] - monitorStation.y;
      if (Math.hypot(dx, dy) <= 1.5) return true;
    }
    return false;
  }

  // `kind` buckets the change into world.finance's running totals for the budget report (see the
  // constructor comment above) -- purely additive bookkeeping, never affects the actual amount
  // applied to world.scrap. Callers that don't care (or a negative/zero amount, which shouldn't
  // happen here but would double-count if it did) just fall through uncategorized.
  addScrap(amount, kind) {
    this.scrap += amount;
    if (amount > 0 && this.finance) {
      if (kind === 'kill') { this.finance.killScrap += amount; this.attackersKilled++; }
      else if (kind === 'harvest') this.finance.harvestScrap += amount;
      else if (kind === 'haul') this.finance.haulScrap += amount;
      else if (kind === 'recycling') this.finance.recyclingScrap += amount;
      else if (kind === 'conquest') this.finance.conquestScrap += amount;
      else if (kind === 'processing') this.finance.processingScrap += amount;
      else if (kind === 'farm') this.finance.farmScrap += amount;
      else if (kind === 'restaurant') this.finance.restaurantScrap += amount;
      else if (kind === 'faction') this.finance.factionScrap += amount;
      else if (kind === 'grant') this.finance.grantScrap += amount;
      else if (kind === 'powerExport') this.finance.powerExportScrap += amount;
      else this.finance.otherScrap += amount;
      this.scrapEarnedThisRun += amount; // metaprogress.js's lifetime scrap-earned stat, see recordGameEnd()
    }
  }

  // Ammo economy (this session's pass, see the constructor's this.ammo comment + security.js's
  // tickAmmoProduction doc comment): the ONLY place anything ever subtracts from this.ammo --
  // siege.js's tickTurrets/tickStaffCombat are passed this bound as their consumeAmmo callback,
  // and only ever call it once they've already confirmed (via the read-only `ammo` number they're
  // also passed) that the stockpile covers the shot, so the `< amount` guard below is a safety net,
  // not the primary gate. Clamped at 0 rather than allowed to go negative, same convention as every
  // other single-running-total resource in this file.
  consumeAmmo(amount) {
    if (this.ammo < amount) return false;
    this.ammo = Math.max(0, this.ammo - amount);
    return true;
  }

  // Vest purchase (economy.js BUILD_COST.vest, citizens.js's hasVest flag, siege.js's
  // CITIZEN_VEST_ARMOR_RATING/resolveCitizenArmorRoll) -- the per-citizen counterpart to
  // security.js's armory-issued weapon tiers: no per-unit inventory here either, this is a
  // straightforward "spend scrap, flip this citizen's flag on" purchase, one Vest per citizen,
  // idempotent (buying a second Vest for an already-vested citizen is a no-op refusal, not a
  // wasted spend). Returns { ok: true } or { ok: false, reason }.
  buyVest(citizenId) {
    let idx = -1;
    for (let i = 0; i < this.citizens.count; i++) {
      if (this.citizens.id[i] === citizenId) { idx = i; break; }
    }
    if (idx < 0 || !this.citizens.isAliveAt(idx)) return { ok: false, reason: 'invalid' };
    if (this.citizens.isVestedAt(idx)) return { ok: false, reason: 'already' };
    if (!canAfford(this, 'vest')) return { ok: false, reason: 'cost' };
    spend(this, 'vest');
    this.citizens.hasVest[idx] = 1;
    const text = `${this.citizens.name[idx]} was equipped with a Vest`;
    this.milestoneLog.push({ tick: this.currentTick, text });
    if (this.milestoneLog.length > 20) this.milestoneLog.shift();
    return { ok: true };
  }

  // Scavenged Augment purchase (augments.js -- see that file's header for how this is distinct
  // from ranks.js's earned rank ladder). Resolves citizenId -> store index the same way buyVest
  // above does, then delegates the actual gate-check/spend/install to augments.js's
  // tryBuyAugment (canBuyAugment re-checked inside it, not just trusted from a stale UI paint --
  // same convention as ranks.js's tryRankUp). Returns { ok: true, def } or { ok: false, reason }.
  buyAugment(citizenId, augId) {
    let idx = -1;
    for (let i = 0; i < this.citizens.count; i++) {
      if (this.citizens.id[i] === citizenId) { idx = i; break; }
    }
    if (idx < 0) return { ok: false, reason: 'invalid' };
    const result = tryBuyAugment(this.citizens, idx, augId, this);
    if (result.ok) {
      const text = `${this.citizens.name[idx]} was fitted with a ${result.def.name}`;
      this.milestoneLog.push({ tick: this.currentTick, text });
      if (this.milestoneLog.length > 20) this.milestoneLog.shift();
    }
    return result;
  }

  // Tainted supply delivery (supplies.js -- ported from Prison Architect's real contraband.lua):
  // player-facing "dispose of the bad batch" / "search and recover" objectives. Bare references to
  // the module-level supplies.js imports of the same name -- same "class method body has no
  // implicit binding to its own name" precedent as upgradeDog below, verified working in this
  // codebase's bundled build already. Returns { ok, reason, ...detail }.
  inspectDelivery() {
    return inspectDelivery(this);
  }
  searchDelivery() {
    return searchDelivery(this);
  }
  // Debug/testing hook only (window.__debug.getWorld().forceTaintedDelivery()) -- bypasses the
  // delivery timer and TAINT_CHANCE roll to force one right now, same "force it and verify"
  // convention as mutating STORYTELLERS.Cassandra.doubleChance live from the console.
  forceTaintedDelivery() {
    return forceTaintedDelivery(this);
  }

  // Upgraded K9 tier (security.js's K9_UPGRADE_*/upgradeDog -- real PA RobotDog anchor). Looks up
  // the dog owned by citizenId (a K9Handler's assigned dog, security.js's assignDogHandler)
  // rather than taking a dog object directly, matching buyVest's citizenId-based call convention
  // above and keeping main.js's inspector button call site simple. Returns { ok, reason }.
  upgradeDog(citizenId) {
    const dog = this.dogs.find(d => d.ownerId === citizenId);
    if (!dog) return { ok: false, reason: 'invalid' };
    // Bare reference to the module-level upgradeDog import (security.js) -- a class method body
    // has no implicit binding to its own name (unlike a named function expression), so this
    // resolves to the free function, not a recursive self-call. Verified in the bundled build too
    // (build.py strips the import line but leaves security.js's `function upgradeDog(...)`
    // declaration as a global, which this same bare reference reaches identically).
    return upgradeDog(this, dog);
  }

  build(kind, x, y) {
    this.structures.push(new Structure(kind, x, y));
  }

  // Refugee Wagon's own name-pool cursor: cycles REFUGEE_NAMES, appending " 2", " 3", etc. once
  // it wraps so a very long soak test still gets distinct names instead of exact repeats.
  _nextRefugeeName() {
    const idx = this._nextRefugeeNameIndex++;
    const base = REFUGEE_NAMES[idx % REFUGEE_NAMES.length];
    const cycle = Math.floor(idx / REFUGEE_NAMES.length);
    return cycle > 0 ? `${base} ${cycle + 1}` : base;
  }

  // Refugee Wagon (see the REFUGEE_* constants' doc comment above): periodic, reactive
  // population-growth-via-arrivals. Gated three ways so it can't spam or overflow --
  // (1) currentTick % REFUGEE_CHECK_INTERVAL, same cadence pattern as resources.js's
  // maybeSpawnNode; (2) alive population must actually be below REFUGEE_POP_FRACTION of the
  // starting count, so a healthy/growing colony just doesn't roll; (3) CitizenStore's fixed
  // capacity (see citizens.js) is checked before spawning and the group size is clamped down to
  // whatever room is actually left, rather than spawn() silently failing partway through.
  _maybeSpawnRefugeeWagon() {
    if (this.currentTick < REFUGEE_GRACE_TICKS) return;
    if (this.currentTick % REFUGEE_CHECK_INTERVAL !== 0) return;

    let alive = 0;
    for (let i = 0; i < this.citizens.count; i++) if (this.citizens.isAliveAt(i)) alive++;
    if (alive >= this.startingCitizenCount * REFUGEE_POP_FRACTION) return;
    if (this.rng() >= REFUGEE_CHANCE) return;

    const remainingCapacity = this.citizens.capacity - this.citizens.count;
    if (remainingCapacity <= 0) return; // at capacity -- skip this check entirely rather than overflow

    let groupSize = REFUGEE_MIN_GROUP + Math.floor(this.rng() * (REFUGEE_MAX_GROUP - REFUGEE_MIN_GROUP + 1));
    groupSize = Math.min(groupSize, remainingCapacity);

    // Arrive at a random map edge, clustered loosely like a small group walking in together --
    // same edge-picking idea as siege.js's WaveSpawner, just friendly and much smaller.
    const edge = Math.floor(this.rng() * 4);
    let ex, ey;
    if (edge === 0) { ex = 1; ey = this.rng() * this.height; }
    else if (edge === 1) { ex = this.width - 2; ey = this.rng() * this.height; }
    else if (edge === 2) { ex = this.rng() * this.width; ey = 1; }
    else { ex = this.rng() * this.width; ey = this.height - 2; }

    const arrivedNames = [];
    for (let n = 0; n < groupSize; n++) {
      const name = this._nextRefugeeName();
      const x = Math.max(1, Math.min(this.width - 2, ex + (this.rng() - 0.5) * 2));
      const y = Math.max(1, Math.min(this.height - 2, ey + (this.rng() - 0.5) * 2));
      // CitizenStore.spawn assigns trait/backstory/passions itself (see citizens.js), same as
      // every starting citizen in the constructor above -- nothing extra needed here for that.
      const idx = this.citizens.spawn(name, x, y, this.rng);
      if (idx < 0) break; // capacity hit mid-loop; shouldn't happen given the clamp above, but stay safe
      this._citizenIds.push(this.citizens.id[idx]);
      arrivedNames.push(name);
    }
    if (arrivedNames.length === 0) return;

    const text = arrivedNames.length === 1
      ? `Refugee Wagon arrives -- ${arrivedNames[0]} joins the settlement`
      : `Refugee Wagon arrives -- ${arrivedNames.join(', ')} join the settlement`;
    this.milestoneLog.push({ tick: this.currentTick, text });
    if (this.milestoneLog.length > 20) this.milestoneLog.shift();
    this.onRandomEvent?.(text);
  }

  // Unrest (see the UNREST_* constants' doc comment above the class): throttled to
  // UNREST_INTERVAL_TICKS, same cadence grading.js's Wellbeing axis already updates on, so this
  // reads a fresh value each time rather than a stale one. Eases unrestLevel toward a target
  // blend of "how many citizens are OnBreak right now" and "how bad is Wellbeing right now",
  // then applies the sustained-duration + hysteresis gate described above to flip unrestActive.
  _updateUnrest() {
    if (this.currentTick % UNREST_INTERVAL_TICKS !== 0) return;

    let aliveCount = 0, onBreakCount = 0;
    for (let i = 0; i < this.citizens.count; i++) {
      if (!this.citizens.isAliveAt(i)) continue;
      aliveCount++;
      if (this.citizens.isOnBreakAt(i)) onBreakCount++;
    }
    const onBreakFraction = aliveCount > 0 ? onBreakCount / aliveCount : 0;
    const wellbeingDeficit = 1 - (this.grading?.wellbeing ?? 100) / 100;
    const target = Math.max(0, Math.min(1, 0.65 * onBreakFraction + 0.35 * wellbeingDeficit));
    this.unrestLevel += (target - this.unrestLevel) * UNREST_EASE;
    this.unrestLevel = Math.max(0, Math.min(1, this.unrestLevel));

    if (this.unrestLevel >= UNREST_TRIGGER_THRESHOLD) {
      this._unrestAboveTicks += UNREST_INTERVAL_TICKS;
    } else if (this.unrestLevel < UNREST_RESOLVE_THRESHOLD) {
      this._unrestAboveTicks = 0;
    }
    // Between the resolve and trigger thresholds, _unrestAboveTicks is left alone -- neither
    // building nor reset -- so a value oscillating right at the boundary doesn't get its
    // sustained-duration progress wiped by a single throttle-step dip.

    // Tier 2/3 escalation counters (see UNREST_TIER2/3_THRESHOLD's doc comment above): each
    // mirrors _unrestAboveTicks's own sustained-duration gate, one threshold up, and only
    // accumulates once the colony has already reached the tier below it.
    if (this.unrestTier >= 1 && this.unrestLevel >= UNREST_TIER2_THRESHOLD) {
      this._unrestTier2AboveTicks += UNREST_INTERVAL_TICKS;
    } else if (this.unrestLevel < UNREST_TIER2_THRESHOLD) {
      this._unrestTier2AboveTicks = 0;
    }
    if (this.unrestTier >= 2 && this.unrestLevel >= UNREST_TIER3_THRESHOLD) {
      this._unrestTier3AboveTicks += UNREST_INTERVAL_TICKS;
    } else if (this.unrestLevel < UNREST_TIER3_THRESHOLD) {
      this._unrestTier3AboveTicks = 0;
    }

    if (this.unrestTier === 0 && this._unrestAboveTicks >= UNREST_SUSTAIN_TICKS) {
      this.unrestTier = 1;
      this.unrestActive = true;
      this._unrestCrisisMinWellbeing = this.grading?.wellbeing ?? 100;
      const text = 'Unrest is spreading through the settlement';
      this.milestoneLog.push({ tick: this.currentTick, text });
      if (this.milestoneLog.length > 20) this.milestoneLog.shift();
      this.onRandomEvent?.(text);
    } else if (this.unrestTier === 1 && this._unrestTier2AboveTicks >= UNREST_SUSTAIN_TICKS) {
      this.unrestTier = 2;
      const text = 'Unrest is escalating -- tempers are fraying, expect scuffles breaking out';
      this.milestoneLog.push({ tick: this.currentTick, text });
      if (this.milestoneLog.length > 20) this.milestoneLog.shift();
      this.onRandomEvent?.(text);
    } else if (this.unrestTier === 2 && this._unrestTier3AboveTicks >= UNREST_SUSTAIN_TICKS) {
      this.unrestTier = 3;
      const text = 'Unrest has reached a breaking point -- real violence could break out';
      this.milestoneLog.push({ tick: this.currentTick, text });
      if (this.milestoneLog.length > 20) this.milestoneLog.shift();
      this.onRandomEvent?.(text);
    } else if (this.unrestTier > 0 && this.unrestLevel < UNREST_RESOLVE_THRESHOLD) {
      // Full resolve, from whichever tier it was at, back to calm -- hysteresis still gates this
      // on UNREST_RESOLVE_THRESHOLD alone (not a per-tier resolve point), same "it resolves once
      // the underlying causes improve" design as before tiers existed.
      const heldWellbeingHigh = this._unrestCrisisMinWellbeing >= UNREST_REWARD_WELLBEING_BAR;
      this.unrestTier = 0;
      this.unrestActive = false;
      this._unrestAboveTicks = 0;
      this._unrestTier2AboveTicks = 0;
      this._unrestTier3AboveTicks = 0;
      this._unrestCrisisMinWellbeing = Infinity;
      const text = 'The settlement has calmed';
      this.milestoneLog.push({ tick: this.currentTick, text });
      if (this.milestoneLog.length > 20) this.milestoneLog.shift();
      this.onRandomEvent?.(text);

      // Crisis-resolution reward (calamity_rewards.txt pattern, see the doc comment above): only
      // grants if Wellbeing genuinely never dropped below the bar at any point during the whole
      // crisis, not just at the resolving instant.
      if (heldWellbeingHigh) {
        this.unrestResolutionBuffTicks = UNREST_REWARD_DURATION_TICKS;
        const rewardText = 'The settlement pulled through with spirits high -- a burst of renewed energy boosts productivity';
        this.milestoneLog.push({ tick: this.currentTick, text: rewardText });
        if (this.milestoneLog.length > 20) this.milestoneLog.shift();
        this.onRandomEvent?.(rewardText);
      }
    }

    // Track the worst Wellbeing reading seen at any point during an active crisis -- read by the
    // resolve branch above the moment it fully calms back down.
    if (this.unrestTier > 0) {
      const wb = this.grading?.wellbeing ?? 100;
      if (wb < this._unrestCrisisMinWellbeing) this._unrestCrisisMinWellbeing = wb;
    }

    this._tickUnrestEvent();
  }

  // Tier 2/3 "acting out" event (Prison Architect calamity_settings.txt's Food Fight, reframed
  // genre-neutral, see the UNREST_EVENT_PARAMS doc comment above): rolled every time _updateUnrest
  // itself runs (already throttled to UNREST_INTERVAL_TICKS), so this reads as a periodic risk
  // rather than a one-shot the instant a tier is reached. Only fires against a citizen actually
  // present at a Food/Recreation zone right now (Eating/Recreating jobState) -- an empty zone has
  // no one to scuffle.
  _tickUnrestEvent() {
    if (this.unrestTier < 2) return;
    const params = UNREST_EVENT_PARAMS[this.unrestTier] || UNREST_EVENT_PARAMS[2];
    if (this.rng() >= params.chanceOfEvent) return;

    const candidates = [];
    for (let i = 0; i < this.citizens.count; i++) {
      if (!this.citizens.isAliveAt(i) || this.citizens.isDownedAt(i)) continue;
      const st = this.citizens.jobState[i];
      if (st === JobState.Eating || st === JobState.Recreating) candidates.push(i);
    }
    if (candidates.length === 0) return;
    const idx = candidates[Math.floor(this.rng() * candidates.length)];

    this.citizens.mood[idx] = Math.max(0, this.citizens.mood[idx] - UNREST_EVENT_MOOD_HIT);
    const causesDamage = this.rng() < params.chanceCauseDamage;
    let text;
    if (causesDamage && this.unrestTier >= 3) {
      // Tier 3's damage roll is the "more serious consequence" the task called for -- downs the
      // citizen (RimWorld-style downed-not-dead, already used everywhere else combat can down
      // someone) rather than just chipping health, same escalation shape as real PA's tiers each
      // unlocking a worse failure mode on top of the last.
      this.citizens.health[idx] = Math.min(this.citizens.health[idx], UNREST_EVENT_DOWN_HEALTH);
      this.citizens.flags[idx] |= CitizenFlags.Downed;
      text = `A ${params.label} breaks out -- ${this.citizens.name[idx]} is hurt and goes down`;
    } else if (causesDamage) {
      this.citizens.health[idx] = Math.max(0, this.citizens.health[idx] - UNREST_EVENT_HEALTH_HIT);
      text = `A ${params.label} breaks out -- ${this.citizens.name[idx]} gets hurt`;
    } else {
      text = `A ${params.label} breaks out near the food/rec area but no one is seriously hurt`;
    }
    this.milestoneLog.push({ tick: this.currentTick, text });
    if (this.milestoneLog.length > 20) this.milestoneLog.shift();
    this.onRandomEvent?.(text);
  }

  tick() {
    if (this.paused || this.gameOver) return;
    this.currentTick++;
    this.timeOfDay = (this.timeOfDay + 1 / DAY_NIGHT_CYCLE_TICKS) % 1; // Duty Roster clock, see schedule.js

    // Room stats (beauty/cleanliness/impressiveness -> quality, see rooms.js's computeRoomStats
    // doc comment): recomputed every tick against the *current* structures/pollution/fire state
    // -- unlike detectRooms' cell layout, a room's contents change far more often than its walls
    // do, so this can't be gated behind the wall-signature check below. Read by tickNeedsAndMood
    // just after, via roomContaining, to nudge a citizen's mood based on the room they're in.
    computeRoomStats(this.rooms, this.grid, this.structures, this, this.zones);
    // Structured Group Programs (programs.js): resync ProgramSites against the freshly-recomputed
    // room roles right after computeRoomStats (so a room that just validated/invalidated this
    // tick is picked up immediately) and before tickJobs, which is what actually walks citizens
    // to/from a site (jobs.js's SeekingProgram/Attending).
    syncProgramSites(this);

    tickNeedsAndMood(this.citizens, (i) => this.isStaffOnDutyAt(i), this.rng, this);
    // Off-duty check runs before tickJobs so a staff member whose fatigue/hunger just crossed
    // the threshold this tick immediately falls into jobs.js's normal Idle/SeekingFood/SeekingBed
    // handling below, rather than waiting a tick -- see security.js's tickStaffOffDuty doc comment.
    tickStaffOffDuty(this.citizens, this.roster, (i) => this.idOf(i), this.zones);
    // Staff training-program dispatch (programs.js's ProgramKind.GuardResponseTraining, see
    // security.js's tickStaffTraining doc comment): must run after tickStaffOffDuty (so it never
    // fights over the off-duty flag with a genuine food/rest dispatch this same tick) and before
    // tickJobs (so a freshly-set SeekingProgram state actually gets walked/processed this tick).
    tickStaffTraining(this, (i) => this.idOf(i));
    tickJobs(this.citizens, this.zones, (i) => this.isStaffOnDutyAt(i), this.structures, this.resourceNodes,
      (i) => this.idOf(i), (amt) => this.addScrap(amt, 'harvest'), this);
    // Cinema broadcast (jobs.js's tickCinemas, PA DLC prefab data's real WatchCinema provider):
    // group-refills Social for every citizen within CINEMA_RANGE at once, same range-iteration
    // shape as siege.js's tickTurrets Tesla chain -- run right after tickJobs so it sees this
    // tick's freshly-updated citizen positions, same ordering rationale as tickFactions below.
    tickCinemas(this.structures, this.citizens, this.currentTick);
    // Citizen cliques + faction demands (factions.js): reads this tick's freshly-updated jobState
    // (demand progress counts real JobState.Recreating transitions from tickJobs just above), and
    // runs before _updateUnrest() at the end of tick() so an unmet-demand unrest bump this tick is
    // visible to that same tick's threshold check rather than lagging a tick behind.
    tickFactions(this);
    tickStaffDuty(this.citizens, this.roster, (i) => this.idOf(i));
    // Armory issuance (security.js): cheap (roster-size loop, not per-citizen-store-slot), so
    // just re-derive every tick rather than hooking build-complete/destroy events -- a built or
    // destroyed Armory (and a freshly-assigned Guard/Sniper) all propagate within one tick.
    tickArmoryIssuance(this.roster, this.structures);
    // Ammo economy (security.js's tickAmmoProduction, see this.ammo's constructor doc comment):
    // same "cheap, just re-derive every tick" placement as armory issuance right above it, which
    // it's read alongside anyway (both scan this.structures for built Armories).
    tickAmmoProduction(this);
    // Corrupt/bribable staff (security.js's tickStaffCorruption, reskinned Prison Architect
    // "Crooked Guards"): cheap (roster-size loop, same order as armory issuance above) so it just
    // runs every tick rather than hooking specific staff-assignment call sites.
    tickStaffCorruption(this);
    // Held-citizen crisis (siege.js): rolls whether a new crisis starts (only at the top unrest
    // tier, see that file's doc comment), then advances any crisis already in progress. Placed
    // after tickStaffDuty above so a staff member who reached a fresh post this tick already has
    // their updated position counted toward "nearby" when a beat resolves this same tick.
    maybeTriggerHeldCitizenCrisis(this);
    tickHeldCitizenCrisis(this);
    // Rain (weather.js): citizens amble a bit slower underfoot -- same wander-speed knob every
    // other build passes through already, just weather-scaled. Heatwave's real penalty is
    // per-citizen (outdoors-only, see isHeatwaveSlowdownActive's doc comment), so it's supplied as
    // the extra perCitizenMult callback rather than folded into the flat `speed` scalar like Rain.
    // Lightning Storm's own movement penalty (weather.js's lightningStormMoveMult, "gritted" =
    // near a Lightning Rod) is also positional, same reasoning -- both stack multiplicatively into
    // one combined per-citizen callback below rather than needing two separate callback params.
    const heatwaveSlowdown = isHeatwaveSlowdownActive(this);
    tickWander(this.citizens, this.grid, this.rng, 0.04 * weatherWanderSpeedMult(this.weather),
      // Drafted citizens (draft.js) never idle-wander -- they stand and hold or execute a direct
      // order, see draft.js's tickDrafted (called below) for the only movement a drafted citizen
      // gets.
      (i) => this.isStaffAt(i) || isOnJob(this.citizens, i) || this.citizens.isDraftedAt(i),
      (i) => {
        const heat = heatwaveSlowdown
          ? (roomContaining(this.rooms, this.grid, this.citizens.x[i], this.citizens.y[i]) ? 1 : HEATWAVE_WANDER_SPEED_MULT)
          : 1;
        const lightning = lightningStormMoveMult(this, this.citizens.x[i], this.citizens.y[i]);
        // Epidemic Mid-stage movement-speed cut (epidemic.js, real PA tropicalfever_settings.txt
        // 40% penalty) -- idle wander needs its own hookup here since jobs.js's JOB_SPEED chain
        // only covers citizens actively seeking a job target, not the "nothing to do" wander path.
        const epidemic = epidemicMoveMultFor(this.citizens, i);
        return heat * lightning * epidemic;
      },
      // Allowed Area restriction (citizens.js's isInAllowedArea) -- an idle citizen's random
      // wander target has to be gated the same as every jobs.js-driven target, or a restricted
      // citizen with nothing to do would still drift out of their painted area. hasAllowedArea
      // short-circuits before touching the mask for the overwhelming majority of citizens who
      // have no restriction at all.
      (i, x, y) => !this.citizens.hasAllowedArea(i) || this.citizens.isInAllowedArea(i, this.grid.width, x, y));
    tickDogs(this.dogs, this.citizens, this.roster, this.attackers, (amt) => this.addScrap(amt, 'kill'), this.rng);
    // Taming/breeding (RimWorld animals, see FEATURE_RESEARCH.md and security.js): wild animals
    // wander and occasionally spawn like resource nodes below; jobs.js's Taming job moves a tamed
    // one from wildAnimals into this.dogs, and tickDogBreeding occasionally grows the dogs list
    // on its own once there are at least two, capped so it can't spiral.
    tickWildAnimals(this.wildAnimals, this.grid, this.rng);
    tickDogBreeding(this.dogs, this.rng, this.currentTick);
    this.relationships.tick(this.citizens, (i) => this.citizens.name[i], this.currentTick);

    // Weather + one-off random events (RimWorld's "Events" list -- see weather.js's header
    // comment and FEATURE_RESEARCH.md's RimWorld section). Runs after rooms/needs so the
    // Cold/Heatwave indoor check sees this tick's room state, and after tickWander so a weather
    // *change* this tick still affects this tick's movement via the call above.
    tickWeather(this);
    tickRandomEvents(this);
    // Thunderstorm lightning-ignition + rain-dousing (weather.js): runs before tickFireIgnition/
    // tickFire below so a strike this tick is visible to this same tick's fire damage/spread pass.
    tickThunderstorm(this);
    // Lightning Storm calamity (weather.js's tickLightningStorm, real Prison Architect
    // calamity_settings.txt Lightning Storm -- distinct system from the RimWorld-ported
    // thunderstorm-ignition mechanic just above, see that file's header comment): direct strike
    // rolls against citizens/power-structures/ground. Runs right after tickThunderstorm since both
    // read the same weather gate and this tick's just-updated weather state.
    tickLightningStorm(this);
    // Toxic-fallout hazard (weather.js's tickHazardCondition, real ToxicFallout/VolcanicWinter-
    // style rare, long-refire-gap, late-game-gated map-wide condition -- distinct system from the
    // weather states above, see that function's header comment): advances/ends an active hazard
    // or rolls a new one. Runs alongside the other weather/event systems; its own effect
    // (hazardRefillMult) is read directly by jobs.js's REFILL_RATE call sites, not applied here.
    tickHazardCondition(this);
    // Cold-weather pipe freezing (water.js): runs right after tickWeather so it reads this tick's
    // freshly-updated weather/_weatherStreakTicks, same ordering reasoning as tickThunderstorm above.
    tickPipeFreezing(this);

    // Rat/vermin infestation (rats.js -- see that file's header comment for why this reverses a
    // prior "too big a surface" scope-out): infestation-level trend + spawning, then per-rat
    // wander/trap-catch/steal-chew-dropping rolls. Runs after computeRoomStats/tickWeather so a
    // dropping event this tick sees this tick's real room list, and after tickWander so a citizen
    // reading is consistent with the same tick's other movement systems.
    tickRatInfestation(this);
    tickRats(this);

    // Sickness (sickness.js -- real RimWorld Flu day-rates, rescaled): staggered per-citizen
    // onset roll + progression, same "cheap periodic-roll system" grouping as rats just above.
    tickSickness(this);

    // Epidemic (epidemic.js -- real Prison Architect tropicalfever_settings.txt data): a
    // population-gated, proximity-spread outbreak, deliberately a different/worse/rarer mechanic
    // than sickness.js just above (see that file's header comment for the full contrast). Runs
    // right after tickSickness, same "cheap periodic-roll system" grouping.
    tickEpidemic(this);

    // Tainted supply delivery (supplies.js -- ported from Prison Architect's real contraband.lua,
    // see that file's header comment): delivery timer/detection-window/spread state machine, then
    // per-citizen dependency decay + mood refresh for anyone already affected. Same "cheap
    // periodic-roll system" grouping as sickness/epidemic just above.
    tickSupplyDelivery(this);
    tickDependency(this);

    // Anomaly pressure (anomaly.js -- see that file's header comment): a colony-wide 0->1 meter,
    // gated on colonyStrength/pollution (director.js's existing hazard-scaling pattern, reused as
    // the gate rather than a second parallel one), with periodic tier-scaled consequence rolls.
    // Runs right after rats for the same "cheap periodic-roll system" grouping, after
    // computeRoomStats/tickWeather so a Low-tier mess roll this tick sees this tick's real room
    // list, same ordering reasoning as tickRatInfestation above.
    tickAnomalyPressure(this);
    tickAnomalyEvents(this);

    maybeSpawnNode(this.resourceNodes, this.grid, this.rng, this.currentTick, this.width / 2, this.height / 2);
    maybeSpawnWildAnimal(this.wildAnimals, this.grid, this.rng, this.currentTick, this.width / 2, this.height / 2);
    this._maybeSpawnRefugeeWagon(); // population-growth-via-arrivals, see the method's doc comment above
    tickVehicles(this);
    // Labor drones (drones.js): fabrication queue advances first so a drone that finishes
    // gestating this tick is immediately available to tickDrones' own idle-claim pass the same
    // tick, rather than sitting idle-and-uncounted for one extra tick.
    tickDroneFabrication(this);
    tickDrones(this);
    if (this.ethanolPenaltyTimer > 0) this.ethanolPenaltyTimer--; // see vehicles.js FUEL_TYPES.ethanol
    // Crisis-resolution reward countdown (see UNREST_REWARD_* above) -- counts down independently
    // of unrestTier so it keeps applying for its full duration even if a fresh crisis starts again
    // shortly after resolving well.
    if (this.unrestResolutionBuffTicks > 0) this.unrestResolutionBuffTicks--;
    // worldmap.js arrival-mishap debuff countdown -- see this field's own doc comment above.
    if (this.arrivalMishapTicks > 0) this.arrivalMishapTicks--;

    // Pollution: generators produce power at the cost of waste (SEA:R's core tradeoff, see
    // FEATURE_RESEARCH.md); it decays slowly on its own but climbs faster than that decay once
    // you have more than a couple of generators running, so a garbage-truck haul run matters.
    let activeGenerators = 0;
    let activeCoalGenerators = 0;
    let recyclingCapacity = 0;
    let activeUncontainedNuclear = 0;
    for (const s of this.structures) {
      // Solar array siting (SEA:R multi-source power economy, see power.js's isSource doc
      // comment): this codebase has no roof/indoor concept, so "needs open sky" is substituted
      // with "not built inside a detected enclosed room" -- the closest analog to "indoors" this
      // sim has (rooms.js's detectRooms). Stamped every tick, mirroring the s._staffed pattern
      // world.js already uses for monitor_station, and read back by power.js's isSource so a
      // solar array only acts as a power source while it's actually in the open.
      if (s.kind === 'generator_solar') s._openSky = !roomContaining(this.rooms, this.grid, s.x, s.y);
      // Wind turbine siting: power.js's isSource always recomputes this live off the current
      // structures list (no lag in what actually gets powered) -- this stamp is purely so
      // render.js can tint the turbine blades without importing power.js's internals directly.
      if (s.kind === 'generator_wind') s._windSited = isWindSited(s, this.structures);
      if (s.destroyed || s.underConstruction) continue;
      if (s.kind === 'generator') activeGenerators++;
      // Coal (SEA:R): the "worse plain generator" tradeoff -- cheaper to build (economy.js) but
      // dirtier per-tick than a plain generator, tracked separately so its pollution rate can
      // differ from GENERATOR_POLLUTION_RATE below rather than reusing activeGenerators' count.
      else if (s.kind === 'generator_coal') activeCoalGenerators++;
      else if (s.kind === 'recycling_center') {
        // Water grid payoff (water.js): a Recycling Center fed by a pump/pipe run processes
        // pollution faster -- water pressure washing down the sorting line, same "provisioned
        // beats unprovisioned" logic as the Food/Recreation refill bonus in jobs.js, applied to
        // this consumer instead since it has no refill rate of its own to boost.
        {
          let cap = isWateredAt(this.structures, s.x, s.y) ? 0.4 * RECYCLING_WATER_BONUS : 0.4;
          if (isNodeUnlocked(this.research, 'recycling_throughput')) cap *= RECYCLING_THROUGHPUT_RESEARCH_MULT;
          recyclingCapacity += cap;
        }
      }
      else if (s.kind === 'generator_nuclear' && !isNuclearContained(this.structures, s)) activeUncontainedNuclear++;
    }
    // Recycling Center (SEA:R): a passive waste->resource sink distinct from garbage trucks --
    // trucks do one big haul-cycle drop, this trickles constantly in exchange for scrap, so both
    // remain worth building rather than one obsoleting the other.
    if (recyclingCapacity > 0) {
      const processed = Math.min(this.pollution, recyclingCapacity);
      this.pollution -= processed;
      this.addScrap(processed * 0.5, 'recycling');
    }
    // Coal's pollution-per-tick is deliberately worse than a plain generator's 0.03 (roughly
    // double) -- its whole tradeoff is "cheaper to build, dirtier to run", not a strict downgrade,
    // so the gap has to be big enough to matter. Wind/solar contribute nothing here at all --
    // their tradeoff is siting (power.js's isSource), not pollution.
    this.pollution = Math.max(0, this.pollution + activeGenerators * 0.03 + activeCoalGenerators * 0.07 - 0.01);

    // Nuclear waste (SEA:R): distinct from pollution above -- it only accrues while a nuclear
    // generator is uncontained, and it's not something a recycling center processes; the only
    // fix is a nearby waste_storage. tickNuclearHazard (siege.js) is what actually damages
    // citizens/structures in the meantime; this counter is the visible "how bad is it" readout.
    this.nuclearWaste = Math.max(0, this.nuclearWaste + activeUncontainedNuclear * NUCLEAR_WASTE_RATE - 0.02);
    tickNuclearHazard(this.structures, this.citizens);

    // Fire (Prison Architect/SEA:R crisis event, see FEATURE_RESEARCH.md and fire.js): active
    // generators can spark nearby flammable structures, which then burn and spread on their own.
    // Spread rate is scaled by the real Prison Architect Low/Medium/High difficulty-tier
    // multiplier (fire.js's FIRE_SPREAD_DIFFICULTY_MULT), wired to this world's existing
    // AggressionPreset knob rather than a new difficulty concept.
    tickFireIgnition(this.structures, this.rng);
    tickFire(this.structures, this.rng, FIRE_SPREAD_DIFFICULTY_MULT[this.aggression] ?? 1);

    // Battery storage (power.js's tickBatteries): charges off real segment surplus / discharges
    // to help cover a real deficit, at the real efficiency=0.5 loss on discharge. Runs BEFORE the
    // overload check below so a battery that has charge to give genuinely staves off overload the
    // same tick, not one tick late.
    tickBatteries(this.structures);

    // Power Exporter (power.js's tickPowerExporters, PA DLC Transformer/PowerExportMeter idea):
    // converts genuine spare segment capacity (same raw surplus number the battery charge check
    // above just used) into a slow scrap trickle. Runs right after batteries for the same reason --
    // reads this tick's real surplus fresh, never a stale/cached number -- and strictly before the
    // overload check below since it never contributes load of its own to that calculation.
    tickPowerExporters(this.structures, (amt) => this.addScrap(amt, 'powerExport'));

    // Power grid overload (Prison Architect's overload/explosion-risk mechanic, power.js): too
    // many powered turrets/tesla/watchtowers wired to too few/weak generators strains a segment.
    // hasPoweredBonus (siege.js's turret/tesla boost, watchtower's warning-window boost above)
    // already stops applying the bonus on an overloaded segment on its own every tick it's read --
    // the two things left to do here are (a) log a milestone the first tick a segment/nuclear
    // radius actually crosses into overload, and (b) roll the rare fire-risk consequence, reusing
    // fire.js's igniteStructure directly rather than a parallel damage system.
    const overloadedNow = overloadedSupplyKeys(this.structures);
    for (const key of overloadedNow) {
      if (this._prevOverloadedSupply.has(key)) continue;
      this.milestoneLog.push({
        tick: this.currentTick,
        text: 'Power grid overloaded -- powered consumers on that line lose their boost, and it now risks catching fire',
      });
      if (this.milestoneLog.length > 20) this.milestoneLog.shift();
    }
    this._prevOverloadedSupply = overloadedNow;
    if (overloadedNow.size > 0) {
      for (const s of this.structures) {
        // Battery/power_switch are real conductor tiles too (power.js's isConductor) -- a battery
        // carrying an overloaded segment's strain is exactly the "explodes under overload" hazard
        // real batteries have, so it needs the same fire-risk roll wire/generators already get.
        if (s.kind !== 'wire' && s.kind !== 'battery' && s.kind !== 'power_switch' && !s.kind.startsWith('generator')) continue;
        if (s.destroyed || s.underConstruction || s.onFire) continue;
        if (!isSegmentOverloadedAt(this.structures, s.x, s.y)) continue;
        if (this.rng() < OVERLOAD_FIRE_CHANCE_PER_TICK) igniteStructure(s);
      }
    }

    // Conquest layer (worldmap.js): advances THIS region's control meter based on how the
    // settlement is doing, and trickles scrap in from every other region you already hold.
    // Strictly additive on top of the scrap economy above -- it adds income, never gates it.
    tickWorldMap(this);

    // Research trickle (research.js): scaled by alive citizen count, so keeping people alive is
    // what advances the tech tree. Purely additive -- it gates nothing that already existed on
    // tick 0 and never touches scrap or the director's difficulty inputs.
    tickResearch(this);

    directWaveSpawner(this);
    // `this` is passed so WaveSpawner can read pollution/nuclearWaste when rolling the raid's
    // arrival method (edge walk-in vs. an interior tunnel breach) -- read-only, same
    // hazard-scales-danger pattern director.js uses.
    this.waveSpawner.tick(this.currentTick, this.attackers, this.rng, this);
    // Weather-scaled combat: real RimWorld WeatherDefs/Weathers.xml accuracy/move-speed
    // modifiers (weather.js's weatherAccuracyMult/weatherMoveSpeedMult), applied map-wide and
    // symmetrically -- turret/guard/sniper fire AND attacker hits vs citizens all roll against
    // this same accuracy multiplier, and attacker approach speed reads the same move-speed
    // multiplier citizen wander already used (see the Rain call above).
    // Security Response Plan's tactical-reinforcement call-in (coverageplans.js): a temporary,
    // defender-only accuracy boost folded into the exact same choke point weather's accuracy
    // penalty already uses -- turret/staff fire gets it, attacker-vs-citizen fire does NOT (see
    // tickAttackers below, which is never passed combatAccuracy), so this is a real one-sided
    // player buff, not a symmetric map-wide modifier like weather's.
    tickSecurityResponse(this);
    const combatAccuracy = weatherAccuracyMult(this.weather) * securityResponseAccuracyMult(this);
    const combatMoveSpeed = weatherMoveSpeedMult(this.weather);
    tickAttackers(this.attackers, this.structures, this.grid, this.width / 2, this.height / 2, this.citizens,
      (amt) => this.addScrap(amt, 'kill'), () => this.onKill?.(), combatMoveSpeed, this.rng);
    // Suppression (siege.js's tickSuppression, see its doc comment): re-derived off THIS tick's
    // freshly-updated attacker positions (tickAttackers just ran above), before tickTurrets/
    // tickStaffCombat read it back out for their own accuracy this same tick -- a turret/guard's
    // suppression this tick already reflects who's swarming it right now, not last tick's picture.
    tickSuppression(this.structures, this.attackers, this.citizens);
    tickTurrets(this.structures, this.attackers, (amt) => this.addScrap(amt, 'kill'), (s) => this.onTurretFire?.(s), () => this.onKill?.(), this.rng, combatAccuracy, this.ammo, (amt) => this.consumeAmmo(amt));
    tickStaffCombat(this.citizens, this.roster, (i) => this.idOf(i), this.attackers, (amt) => this.addScrap(amt, 'kill'), () => this.onKill?.(), this.rng, combatAccuracy, this.ammo, (amt) => this.consumeAmmo(amt));
    // Drafted citizens (draft.js -- RimWorld-style manual control): owns ALL movement/combat for
    // any citizen currently flagged Drafted (citizens.js's CitizenFlags.Drafted). Placed right
    // after tickStaffCombat so a drafted attack order resolves in the same "who fought this tick"
    // phase as every autonomous combat system above it, using the same damage pipeline/rng.
    tickDrafted(this);
    // Mood event trigger #1 (negative, see citizens.js's addMoodEvent/MOOD_EVENT_STACK_LIMITS):
    // a real death (not just a downing) inside WITNESS_DEATH_RADIUS gives every other living
    // citizen nearby a stacking, decaying morale hit -- RimWorld's real death-witnessed Thought,
    // scaled to this project's 0-1 mood range and tick rate.
    tickAttackerVsCitizens(this.attackers, this.citizens, (dx, dy, died) => {
      this.onCitizenDowned?.();
      if (died) {
        for (let w = 0; w < this.citizens.count; w++) {
          if (!this.citizens.isAliveAt(w)) continue;
          if (Math.hypot(this.citizens.x[w] - dx, this.citizens.y[w] - dy) > WITNESS_DEATH_RADIUS) continue;
          addMoodEvent(this.citizens, w, this.currentTick, { magnitude: -0.05, durationTicks: 2000, stackKey: 'witnessedDeath' });
        }
      }
    }, this.rng, combatAccuracy,
    // Combat-proximity signal (relationships.js's logFight/hasFightNearby, read by citizens.js's
    // computeCitizenUnrestScore's "Fighting Nearby" factor) -- fires once per citizen actually hit
    // this tick, distinct from the onDowned callback above which only fires on the downed/kill
    // transition.
    (x, y) => this.relationships.logFight(x, y, this.currentTick));

    // Wall blueprints live in this.structures like everything else (for the ghost render +
    // construction progress), but the actual passability/terrain effect lives on the grid --
    // apply it the tick a wall blueprint finishes, then drop the now-redundant entry. Garage
    // blueprints similarly hand off to a parked Vehicle the moment they finish, rather than
    // acting as a structure themselves once complete.
    this.structures = this.structures.filter(s => {
      // Build-complete audio cue: fires exactly once per structure, the tick underConstruction
      // flips false (instant/starter structures are pre-marked _builtNotified in the Structure
      // constructor so they never trigger this).
      if (!s.underConstruction && !s._builtNotified) {
        s._builtNotified = true;
        this.onBuildComplete?.(s);
      }
      if (s.kind === 'wall' && !s.underConstruction) {
        this.grid.setWall(Math.floor(s.x), Math.floor(s.y), 1);
        return false;
      }
      const garageKind = parseGarageKind(s.kind);
      if (garageKind && !s.underConstruction && !s._vehicleSpawned) {
        spawnParkedVehicle(this, garageKind.truckKind, s.x, s.y, garageKind.fuelType);
        s._vehicleSpawned = true;
      }
      return true;
    });

    // Critical-structure watchdog (genuinely missing before this pass): a destroyed generator,
    // water pump, or garage previously left the colony silently degraded (power outage, no more
    // watered tiles, no more haul cycle) with zero player notification -- every OTHER real threat
    // in this game (overload, nuclear hazard, lightning, riots) already logs a milestone/
    // onRandomEvent, this one didn't. Runs once per tick, after every system above that can set
    // `.destroyed = true` on a structure this same tick (nuclear hazard, fire, overload-fire,
    // fence/trap combat), so it never misses a loss. `_criticalLossLogged` lives on the structure
    // object itself (persisted below in serialize(), restored via deserialize()'s
    // Object.assign(new Structure(...), s) pattern) so a save/load round-trip doesn't re-fire the
    // same alert for an already-known loss.
    for (const s of this.structures) {
      if (!s.destroyed || s._criticalLossLogged) continue;
      const isGenerator = s.kind.startsWith('generator');
      const isPump = s.kind === 'pump';
      const isGarage = parseGarageKind(s.kind) != null;
      if (!isGenerator && !isPump && !isGarage) continue;
      s._criticalLossLogged = true;
      const label = isGenerator ? 'A generator' : isPump ? 'The water pump' : 'A garage';
      const text = `${label} was destroyed -- the colony has lost a load-bearing structure`;
      this.milestoneLog.push({ tick: this.currentTick, text });
      if (this.milestoneLog.length > 20) this.milestoneLog.shift();
      this.onRandomEvent?.(text);
    }

    let wallSum = 0;
    for (let i = 0; i < this.grid.wallThingId.length; i++) if (this.grid.wallThingId[i] !== 0) wallSum += i + 1;
    if (wallSum !== this._roomsWallSignature) {
      this._roomsWallSignature = wallSum;
      this.rooms = detectRooms(this.grid);
    }

    // Room-quality milestone (rooms.js's computeRoomStats): logged once per room object the tick
    // its quality first crosses a "genuinely nice" threshold, and re-armed if it later dips back
    // below so a room that's furnished, gutted, and re-furnished can log again. Room objects are
    // stable references between wall-layout changes (see the wallSum signature check below), so
    // a flag on the room itself is enough state -- no separate id-keyed tracking needed.
    const ROOM_QUALITY_MILESTONE_THRESHOLD = 0.75;
    for (const room of this.rooms) {
      if (room.quality >= ROOM_QUALITY_MILESTONE_THRESHOLD) {
        if (!room._loggedHighQuality) {
          room._loggedHighQuality = true;
          this.milestoneLog.push({
            tick: this.currentTick,
            text: `A room reached high quality (beauty ${room.beauty.toFixed(1)}, quality ${room.quality.toFixed(2)})`,
          });
          if (this.milestoneLog.length > 20) this.milestoneLog.shift();
        }
      } else {
        room._loggedHighQuality = false;
      }
    }

    if (this.waveSpawner.waveNumber > this._lastWaveLogged) {
      this._lastWaveLogged = this.waveSpawner.waveNumber;
      const tunnelled = this.waveSpawner.lastArrival === ArrivalMethod.Tunnel;
      this.milestoneLog.push({
        tick: this.currentTick,
        text: tunnelled
          ? `Wave ${this.waveSpawner.waveNumber} TUNNELLED IN -- breach inside the perimeter!`
          : `Wave ${this.waveSpawner.waveNumber} incoming`,
      });
      if (this.milestoneLog.length > 20) this.milestoneLog.shift();
      this.onWaveIncoming?.();
      // metaprogress.js's cross-run achievements (see that module's header comment) -- checked
      // right here rather than every tick, since a wave-complete is exactly the kind of milestone
      // event the survive-N-ticks / reach-wave-N thresholds should be evaluated against.
      checkWaveAchievements(this);
    }

    // Watchtowers (CCTV/early-warning analog, see FEATURE_RESEARCH.md) give advance notice of
    // an incoming wave before it actually spawns, rather than only finding out at spawn time.
    const watchtower = this.structures.find(s => s.kind === 'watchtower' && !s.destroyed && !s.underConstruction);
    // CCTV cameras (Prison Architect's "CCTV + manned-monitor bonus", see FEATURE_RESEARCH.md's
    // Prison Architect section) are a cheaper, shorter-range complement to the watchtower: an
    // unmanned camera sees less far ahead than even an unpowered watchtower, but a camera backed
    // by a staffed Monitor Station -- a citizen actually assigned to StaffRoleKind.Monitor and
    // physically holding that post, same "hold position" pattern tickStaffDuty already gives
    // Guard/Sniper -- closes most of that gap. That staffed-vs-unstaffed swing is the "manned
    // monitor bonus" the source material calls out specifically.
    const camera = this.structures.find(s => s.kind === 'camera' && !s.destroyed && !s.underConstruction);
    const monitorStation = this.structures.find(s => s.kind === 'monitor_station' && !s.destroyed && !s.underConstruction);
    const monitorStaffed = !!monitorStation && this._isMonitorStaffed(monitorStation);
    if (monitorStation) monitorStation._staffed = monitorStaffed; // render.js reads this for screen brightness

    // A powered watchtower (generator in range) sees further out in time, same pattern as the
    // powered-turret damage/range boost -- generators are now a real consumer-side upgrade
    // wherever they're built near, not just a pollution-producing decoration.
    let warningWindow = watchtower ? (hasPoweredBonus(this.structures, watchtower.x, watchtower.y) ? 90 : 50) : 0;
    let warningSource = watchtower ? 'watchtower' : null;
    if (camera) {
      // CCTV Improvement research node (real PA anchor: CCTVImprovement, cost 1000/time 180 --
      // see research.js's 'cctv_improvement' node): a real +35% early-warning window boost for
      // both the unmanned camera and the staffed-monitor case, once researched.
      const cctvMult = isNodeUnlocked(this.research, 'cctv_improvement') ? 1.35 : 1;
      const cameraWindow = (monitorStaffed ? 70 : 30) * cctvMult;
      if (cameraWindow > warningWindow) { warningWindow = cameraWindow; warningSource = monitorStaffed ? 'monitor' : 'camera'; }
    }

    if (warningSource && !this._warnedForWave &&
      this.waveSpawner.nextWaveTick - this.currentTick <= warningWindow && this.waveSpawner.nextWaveTick > this.currentTick) {
      this._warnedForWave = this.waveSpawner.waveNumber + 1;
      const text = warningSource === 'monitor'
        ? 'Manned monitor station spots raiders massing on CCTV -- wave incoming soon'
        : warningSource === 'camera'
          ? 'CCTV camera spots raiders massing -- wave incoming soon'
          : 'Watchtower spots raiders massing -- wave incoming soon';
      this.milestoneLog.push({ tick: this.currentTick, text });
      if (this.milestoneLog.length > 20) this.milestoneLog.shift();
    }
    if (this._warnedForWave && this._warnedForWave <= this.waveSpawner.waveNumber) this._warnedForWave = null;

    let aliveCitizens = 0;
    for (let i = 0; i < this.citizens.count; i++) if (this.citizens.isAliveAt(i)) aliveCitizens++;
    // metaprogress.js's "most citizens alive at once" lifetime stat + its Boomtown achievement --
    // only actually calls into that module when this run's peak just increased (population holds
    // steady or shrinks far more often than it grows), so this isn't a per-tick achievement check.
    if (aliveCitizens > this.peakAliveCitizens) {
      this.peakAliveCitizens = aliveCitizens;
      checkPopulationAchievement(this.peakAliveCitizens);
    }
    if (aliveCitizens === 0 && this.citizens.count > 0) {
      this.gameOver = true;
      this.milestoneLog.push({ tick: this.currentTick, text: 'GAME OVER -- the settlement has fallen' });
      // Roll this run's final numbers into metaprogress.js's lifetime totals right as the run ends
      // -- see that module's recordGameEnd doc comment for why this is the one authoritative
      // "did this settlement finish" call site (main.js's recordGameAbandoned covers the other
      // path, a run discarded while still alive).
      recordGameEnd(this);
    }

    // Outpost Charter Contracts + investment maturities (grants.js): runs here, after
    // peakAliveCitizens is updated just above, so the capacity-tier ladder's completeCheck reads
    // THIS tick's freshly-updated peak rather than lagging a full tick behind a population change
    // -- and before the finance snapshot just below, so a grant/investment payout this tick is
    // reflected in that same snapshot rather than the next one.
    tickGrants(this);

    // Finance history snapshot (budget report trend/sparkline, see the constructor's finance
    // comment): once per FINANCE_SNAPSHOT_INTERVAL ticks -- roughly one wave-cycle, matching the
    // 300-tick default wave spacing in siege.js's WaveSpawner -- record the net scrap change
    // (income minus expense) since the last snapshot, capped to the last FINANCE_HISTORY_MAX
    // entries so this can't grow unbounded over a long session.
    if (this.currentTick % FINANCE_SNAPSHOT_INTERVAL === 0) {
      const totalIncome = this.finance.killScrap + this.finance.harvestScrap + this.finance.haulScrap +
        this.finance.recyclingScrap + this.finance.conquestScrap + this.finance.processingScrap +
        this.finance.farmScrap + this.finance.restaurantScrap + this.finance.grantScrap +
        this.finance.powerExportScrap + this.finance.otherScrap;
      const totalExpense = this.finance.buildSpend;
      const net = (totalIncome - this._financeLastIncome) - (totalExpense - this._financeLastExpense);
      this.finance.history.push({ tick: this.currentTick, net, scrap: Math.round(this.scrap) });
      if (this.finance.history.length > FINANCE_HISTORY_MAX) this.finance.history.shift();
      this._financeLastIncome = totalIncome;
      this._financeLastExpense = totalExpense;
    }

    // Settlement Grading (grading.js): read-only reporting layer, throttled the same way as
    // resources.js's maybeSpawnNode/security.js's breed check above -- a modulo gate on
    // currentTick rather than every tick, since nothing downstream needs sub-second freshness.
    if (this.currentTick % GRADING_INTERVAL_TICKS === 0) computeGrading(this);

    // Unrest (see UNREST_* constants above and the _updateUnrest doc comment): runs right after
    // grading so it reads this tick's freshly-recomputed Wellbeing axis rather than a stale one
    // from before the throttle window advanced.
    this._updateUnrest();
  }

  serialize() {
    return {
      width: this.width, height: this.height, seed: this.seed, aggression: this.aggression,
      currentTick: this.currentTick, scrap: this.scrap, gameOver: this.gameOver,
      finance: this.finance,
      startingCitizenCount: this.startingCitizenCount, nextRefugeeNameIndex: this._nextRefugeeNameIndex,
      pollution: this.pollution, nuclearWaste: this.nuclearWaste, ethanolPenaltyTimer: this.ethanolPenaltyTimer,
      // Ammo economy (this session's pass, see this.ammo's constructor doc comment) -- a real,
      // meaningful running total worth persisting, same as pollution/nuclearWaste just above.
      // ammoCapacity isn't strictly necessary to persist (tickAmmoProduction re-derives it fresh
      // every tick from the live Armory count regardless), but it's cheap and avoids a one-tick
      // "capacity briefly reads as the base default" flash right after a load, before tick() runs.
      ammo: this.ammo, ammoCapacity: this.ammoCapacity,
      storyteller: this.storyteller, timeOfDay: this.timeOfDay,
      unrestLevel: this.unrestLevel, unrestActive: this.unrestActive, unrestAboveTicks: this._unrestAboveTicks,
      unrestTier: this.unrestTier, unrestTier2AboveTicks: this._unrestTier2AboveTicks,
      unrestTier3AboveTicks: this._unrestTier3AboveTicks,
      unrestCrisisMinWellbeing: Number.isFinite(this._unrestCrisisMinWellbeing) ? this._unrestCrisisMinWellbeing : null,
      unrestResolutionBuffTicks: this.unrestResolutionBuffTicks,
      arrivalMishapTicks: this.arrivalMishapTicks,
      factions: serializeFactions(this.factions),
      // Coverage Plans (coverageplans.js): just the set of purchased plan-kind strings -- the
      // discount/call-in logic itself is all derived live from COVERAGE_PLAN_DEFS + real world
      // state, nothing else to persist.
      coveragePlans: Array.from(this.coveragePlans || []),
      securityResponseTicksLeft: this._securityResponseTicksLeft,
      heldCitizenEvent: this.heldCitizenEvent, heldCitizenCooldownUntil: this._heldCitizenCooldownUntil,
      peakAliveCitizens: this.peakAliveCitizens, attackersKilled: this.attackersKilled, scrapEarnedThisRun: this.scrapEarnedThisRun,
      research: serializeResearch(this.research),
      grants: serializeGrants(this.grants),
      weather: this.weather, weatherTimer: this._weatherTimer,
      // Trader-caravan voucher (weather.js's tryTraderEvent / economy.js's buildCost) -- persisted
      // so a save/load round-trip mid-window doesn't silently lose an active discount.
      traderVoucherUses: this._traderVoucherUses || 0, traderVoucherExpireTick: this._traderVoucherExpireTick ?? -1,
      waveNumber: this.waveSpawner.waveNumber, nextWaveTick: this.waveSpawner.nextWaveTick,
      citizens: {
        count: this.citizens.count,
        id: Array.from(this.citizens.id.slice(0, this.citizens.count)),
        name: this.citizens.name.slice(0, this.citizens.count),
        x: Array.from(this.citizens.x.slice(0, this.citizens.count)),
        y: Array.from(this.citizens.y.slice(0, this.citizens.count)),
        age: Array.from(this.citizens.age.slice(0, this.citizens.count)),
        hunger: Array.from(this.citizens.hunger.slice(0, this.citizens.count)),
        rest: Array.from(this.citizens.rest.slice(0, this.citizens.count)),
        social: Array.from(this.citizens.social.slice(0, this.citizens.count)),
        hydration: Array.from(this.citizens.hydration.slice(0, this.citizens.count)),
        exercise: Array.from(this.citizens.exercise.slice(0, this.citizens.count)),
        // Sickness (sickness.js) -- real, meaningful state (unlike _sickOffset, which is just
        // stagger noise re-derivable on load), so it's worth persisting.
        sickSeverity: Array.from(this.citizens.sickSeverity.slice(0, this.citizens.count)),
        // Tainted-supply dependency (supplies.js) -- real, meaningful state, same round-trip
        // reasoning as sickSeverity just above (unlike _taintOffset, pure stagger noise).
        dependencySeverity: Array.from(this.citizens.dependencySeverity.slice(0, this.citizens.count)),
        // Epidemic (epidemic.js) -- real, meaningful state (unlike _epidemicOffset, pure stagger
        // noise re-derivable on load), same round-trip reasoning as sickSeverity above.
        epidemicStage: Array.from(this.citizens.epidemicStage.slice(0, this.citizens.count)),
        epidemicStageTicks: Array.from(this.citizens.epidemicStageTicks.slice(0, this.citizens.count)),
        epidemicImmuneUntil: Array.from(this.citizens.epidemicImmuneUntil.slice(0, this.citizens.count)),
        mood: Array.from(this.citizens.mood.slice(0, this.citizens.count)),
        health: Array.from(this.citizens.health.slice(0, this.citizens.count)),
        alive: Array.from(this.citizens.alive.slice(0, this.citizens.count)),
        flags: Array.from(this.citizens.flags.slice(0, this.citizens.count)),
        skillCombat: Array.from(this.citizens.skillCombat.slice(0, this.citizens.count)),
        skillConstruction: Array.from(this.citizens.skillConstruction.slice(0, this.citizens.count)),
        // Citizen Rank (ranks.js) -- plain tier index, same round-trip pattern as skillCombat above.
        citizenRank: Array.from(this.citizens.citizenRank.slice(0, this.citizens.count)),
        // Scavenged Augments (augments.js) -- plain installed-set bitmask, same round-trip
        // pattern as citizenRank above (a real, player-paid-for purchase, worth persisting).
        augmentMask: Array.from(this.citizens.augmentMask.slice(0, this.citizens.count)),
        trait: this.citizens.trait.slice(0, this.citizens.count).map(t => t?.name ?? null),
      },
      roster: Array.from(this.roster._roleById.entries()).map(([id, kind]) => ({
        id, kind, post: this.roster._postById.get(id) || null,
        // Manual weapon-tier override (security.js) -- undefined for anyone the player hasn't
        // touched, so deserialize below only needs to call setManualWeapon when present.
        manualWeapon: this.roster._manualWeaponById.get(id) || null,
      })),
      // Corrupt/bribable staff (security.js's StaffRoster corruption state) -- persisted
      // separately from the roster array above so a save/load round-trip doesn't reset a staffer
      // mid-bribe back to clean, or forget who's already been evaluated against the hire ratio.
      staffCorruption: {
        evaluated: Array.from(this.roster._corruptEvaluated),
        eligible: Array.from(this.roster._corruptEligible),
        activeUntil: Array.from(this.roster._corruptActiveUntil.entries()),
        discovered: Array.from(this.roster._corruptDiscovered),
      },
      structures: this.structures.map(s => ({
        kind: s.kind, x: s.x, y: s.y, health: s.health, destroyed: s.destroyed,
        underConstruction: s.underConstruction, buildProgress: s.buildProgress,
        _vehicleSpawned: s._vehicleSpawned || false,
        onFire: s.onFire || false, fireTicks: s.fireTicks || 0,
        // Battery/power-switch state (power.js) -- Object.assign in deserialize below picks these
        // back up generically, but they have to actually be in the saved payload first.
        storedEnergy: s.storedEnergy, switchedOn: s.switchedOn,
        // 'workshop' staffing/work-in-progress (see siege.js's Structure fields, jobs.js's
        // Processing job) -- same "just pass the id through, don't try to re-resolve it" approach
        // as vehicles' driverId below.
        workerId: s.workerId ?? null, _workTimer: s._workTimer || 0,
        // Cold-weather pipe freeze state (water.js) -- picked back up generically by deserialize's
        // Object.assign, same pattern as storedEnergy/switchedOn above.
        frozen: s.frozen || false,
        // Critical-structure watchdog (see the tick() loop above) -- persisted so a reload of an
        // already-destroyed generator/pump/garage doesn't re-fire the "just destroyed" alert.
        _criticalLossLogged: s._criticalLossLogged || false,
      })),
      zones: Array.from(this.zones.kind),
      // upgraded/healthMult (security.js's K9_UPGRADE_* -- see upgradeDog): omitted entirely for
      // an unupgraded dog rather than written as false/undefined, so an old save round-trips
      // through a byte-diff tool identically to before this field existed.
      dogs: this.dogs.map(d => ({
        ownerId: d.ownerId, x: d.x, y: d.y,
        ...(d.upgraded ? { upgraded: true, healthMult: d.healthMult } : {}),
      })),
      wildAnimals: this.wildAnimals.map(a => ({ x: a.x, y: a.y })),
      resourceNodes: this.resourceNodes.map(n => ({ x: n.x, y: n.y, amount: n.amount, maxAmount: n.maxAmount, depleted: n.depleted })),
      // Rat infestation (rats.js): rats themselves are cheap flavor entities (at most
      // RAT_MAX_CONCURRENT=8), position-only is enough -- escapeTimer/wander target reset on load
      // same as a vehicle's mid-route state does above, not a correctness issue.
      ratInfestation: this.ratInfestation || 0,
      ratsCaught: this.ratsCaught || 0,
      rats: (this.rats || []).map(r => ({ x: r.x, y: r.y })),
      // Epidemic (epidemic.js): just the outbreak-gap bookkeeping -- epidemicActive itself is
      // re-derived from the per-citizen epidemicStage array the moment tickEpidemic next runs, so
      // it isn't worth persisting separately (same "derived, not stored" precedent this codebase
      // already applies to plenty of per-tick-recomputed flags).
      epidemicLastEndTick: this._epidemicLastEndTick,
      // Anomaly pressure (anomaly.js): a plain float + a tier label, no entity list to round-trip
      // (unlike rats above) -- the burst-flavor-window fields are intentionally NOT persisted, same
      // "resume as if just-passed" acceptance as the vehicle mid-haul note above.
      anomalyPressure: this.anomalyPressure || 0,
      // Tainted supply delivery (supplies.js) -- the whole investigation-state object round-trips
      // as plain JSON (no live references inside it), same "just persist the object" simplicity as
      // world.finance/world.heldCitizenEvent elsewhere in this file.
      supplyDelivery: this.supplyDelivery || null,
      nextDeliveryTick: this._nextDeliveryTick || 0,
      // targetNode isn't serialized (it's a live reference into resourceNodes) -- a vehicle
      // mid-haul on save resumes as if just-departed rather than mid-route. Acceptable: it's a
      // few seconds of game time, not a correctness bug like the duplicate-vehicle-on-load one
      // this was written alongside (garages need _vehicleSpawned persisted, see above).
      vehicles: this.vehicles.map(v => ({
        kind: v.kind, fuelType: v.fuelType, garageX: v.garageX, garageY: v.garageY, x: v.x, y: v.y,
        driverId: v.driverId, phase: v.driverId == null ? 'parked' : 'inbound', workTimer: 0,
      })),
      // Labor drones (drones.js) -- jobRef isn't serialized (a live reference into
      // structures/vehicles/resourceNodes/rooms, same "resume as if just-departed" acceptance as
      // a vehicle's targetNode above); every drone loads back to idle and reclaims its own work
      // the next tick via tickDrones' normal idle-claim pass.
      drones: this.drones.map(d => ({ id: d.id, category: d.category, x: d.x, y: d.y })),
      droneFabricationQueue: this.droneFabricationQueue.map(o => ({ ...o })),
    };
  }

  static deserialize(json) {
    const w = new SimWorld(json.width, json.height, json.seed, json.aggression, 0);
    w.currentTick = json.currentTick;
    w.scrap = json.scrap;
    w.gameOver = json.gameOver || false;
    // Refugee Wagon's population gate (see the REFUGEE_* constants' doc comment) needs the
    // *original* starting count, not the 0 passed to the constructor above (deserialize always
    // reconstructs citizens from json.citizens below rather than the constructor's own spawn
    // loop) -- without this a loaded save's gate compares against 0 and the wagon never fires.
    w.startingCitizenCount = json.startingCitizenCount || (json.citizens ? json.citizens.count : 0);
    w._nextRefugeeNameIndex = json.nextRefugeeNameIndex || 0;
    if (json.finance) {
      w.finance = { ...w.finance, ...json.finance };
      const totalIncome = w.finance.killScrap + w.finance.harvestScrap + w.finance.haulScrap +
        w.finance.recyclingScrap + w.finance.conquestScrap + w.finance.processingScrap +
        w.finance.farmScrap + w.finance.restaurantScrap + w.finance.grantScrap +
        w.finance.powerExportScrap + w.finance.otherScrap;
      w._financeLastIncome = totalIncome;
      w._financeLastExpense = w.finance.buildSpend;
    }
    w.pollution = json.pollution || 0;
    // Ammo economy -- pre-existing saves have no `ammo` key, so this falls back to the
    // constructor's already-set starting reserve (60) rather than 0, same "old save loads with the
    // new system just not-yet-active, not punitively empty" convention as every other resource
    // added later in this project (see research/grants/factions deserialize below for the same
    // pattern).
    w.ammo = json.ammo != null ? json.ammo : w.ammo;
    w.ammoCapacity = json.ammoCapacity || w.ammoCapacity;
    w.nuclearWaste = json.nuclearWaste || 0;
    w.ethanolPenaltyTimer = json.ethanolPenaltyTimer || 0;
    w.unrestLevel = json.unrestLevel || 0;
    w.unrestActive = json.unrestActive || false;
    w.unrestTier = json.unrestTier || 0;
    w._unrestTier2AboveTicks = json.unrestTier2AboveTicks || 0;
    w._unrestTier3AboveTicks = json.unrestTier3AboveTicks || 0;
    w._unrestCrisisMinWellbeing = json.unrestCrisisMinWellbeing != null ? json.unrestCrisisMinWellbeing : Infinity;
    w.unrestResolutionBuffTicks = json.unrestResolutionBuffTicks || 0;
    w.arrivalMishapTicks = json.arrivalMishapTicks || 0;
    w._unrestAboveTicks = json.unrestAboveTicks || 0;
    // Pre-factions saves have no `factions` key -- deserializeFactions falls back to a fresh,
    // unformed state (same "old save loads with the new system just not-yet-active" convention as
    // research/other systems added later in this project), rather than throwing.
    w.factions = deserializeFactions(json.factions);
    // Coverage Plans (coverageplans.js) -- pre-existing saves have no `coveragePlans` key, so this
    // falls back to the constructor's already-set empty Set, same convention as every other
    // system added later in this project.
    if (json.coveragePlans) w.coveragePlans = new Set(json.coveragePlans);
    w._securityResponseTicksLeft = json.securityResponseTicksLeft || 0;
    // Held-citizen crisis (siege.js) -- pre-existing saves have no `heldCitizenEvent` key, so this
    // falls back to the same inactive default the constructor already sets, same convention as
    // every other system added later in this project.
    w.heldCitizenEvent = json.heldCitizenEvent || w.heldCitizenEvent;
    w._heldCitizenCooldownUntil = json.heldCitizenCooldownUntil || 0;
    w.peakAliveCitizens = json.peakAliveCitizens || 0;
    w.attackersKilled = json.attackersKilled || 0;
    w.scrapEarnedThisRun = json.scrapEarnedThisRun || 0;
    w.storyteller = json.storyteller || 'Cassandra';
    // Pre-research saves have no `research` key -- deserializeResearch falls back to a fresh
    // state, so an old save loads with the survival core unlocked and 0 points rather than
    // throwing or silently locking everything.
    w.research = deserializeResearch(json.research);
    // Pre-grants saves have no `grants` key -- deserializeGrants falls back to a fresh state
    // (nothing unlocked/completed, no pending investments), same fallback pattern as research above.
    w.grants = deserializeGrants(json.grants);
    w.timeOfDay = json.timeOfDay != null ? json.timeOfDay : 0.3;
    w.weather = json.weather || 'Clear';
    w._weatherTimer = json.weatherTimer != null ? json.weatherTimer : w._weatherTimer;
    w._traderVoucherUses = json.traderVoucherUses || 0;
    w._traderVoucherExpireTick = json.traderVoucherExpireTick ?? -1;
    w.waveSpawner.waveNumber = json.waveNumber || 0;
    w.waveSpawner.nextWaveTick = json.nextWaveTick || 300;
    const c = json.citizens;
    w.citizens.count = c.count;
    for (let i = 0; i < c.count; i++) {
      w.citizens.id[i] = c.id[i];
      w.citizens.name[i] = c.name[i];
      w.citizens.x[i] = c.x[i]; w.citizens.y[i] = c.y[i];
      w.citizens.targetX[i] = c.x[i]; w.citizens.targetY[i] = c.y[i];
      // c.age is undefined for a save written before this feature existed -- fall back to a
      // mid-Young-band default (10000) rather than 0, so an old save doesn't suddenly load an
      // entire colony of newborns with no age variance at all.
      w.citizens.age[i] = c.age ? c.age[i] : 10000;
      w.citizens.hunger[i] = c.hunger[i]; w.citizens.rest[i] = c.rest[i]; w.citizens.social[i] = c.social[i];
      // Pre-hydration saves have no `hydration` key -- default to full rather than 0 so an old
      // save doesn't load every citizen already parched.
      w.citizens.hydration[i] = c.hydration ? c.hydration[i] : 1;
      // Pre-exercise saves have no `exercise` key -- same "default to full" convention as
      // hydration above, so an old save doesn't load every citizen already needing the gym.
      w.citizens.exercise[i] = c.exercise ? c.exercise[i] : 1;
      // Pre-sickness saves have no `sickSeverity` key -- default to 0 (healthy), same convention
      // as every other system added later in this project.
      w.citizens.sickSeverity[i] = c.sickSeverity ? c.sickSeverity[i] : 0;
      // _sickOffset isn't serialized (pure stagger noise, not real state, same convention as a
      // reloaded vehicle's mid-route reset) -- deserialize's per-index loop bypasses spawn()'s
      // own rng-based assignment, so re-derive a spread deterministically here rather than leaving
      // every loaded citizen pinned at the array's zero-init default (which would re-sync every
      // loaded citizen's onset-roll tick, defeating the point of staggering).
      w.citizens._sickOffset[i] = i % 50;
      // Pre-supplies saves have no `dependencySeverity` key -- default to 0 (unaffected), same
      // convention as sickSeverity above. _taintOffset is pure stagger noise, same non-serialized
      // re-derivation as _sickOffset just above (keep the modulus in sync with supplies.js's
      // DEPENDENCY_CHECK_INTERVAL).
      w.citizens.dependencySeverity[i] = c.dependencySeverity ? c.dependencySeverity[i] : 0;
      w.citizens._taintOffset[i] = i % 300;
      // Pre-epidemic saves have no `epidemicStage` key -- default to 0 (healthy, no active case),
      // same convention as sickSeverity/dependencySeverity above. _epidemicOffset is pure stagger
      // noise, same non-serialized re-derivation as _sickOffset/_taintOffset just above (keep the
      // modulus in sync with epidemic.js's EPIDEMIC_CHECK_INTERVAL).
      w.citizens.epidemicStage[i] = c.epidemicStage ? c.epidemicStage[i] : 0;
      w.citizens.epidemicStageTicks[i] = c.epidemicStageTicks ? c.epidemicStageTicks[i] : 0;
      w.citizens.epidemicImmuneUntil[i] = c.epidemicImmuneUntil ? c.epidemicImmuneUntil[i] : 0;
      w.citizens._epidemicOffset[i] = i % 40;
      w.citizens.mood[i] = c.mood[i]; w.citizens.health[i] = c.health[i]; w.citizens.alive[i] = c.alive[i];
      w.citizens.flags[i] = c.flags ? c.flags[i] : 0;
      w.citizens.skillCombat[i] = c.skillCombat ? c.skillCombat[i] : 0;
      w.citizens.skillConstruction[i] = c.skillConstruction ? c.skillConstruction[i] : 0;
      // Pre-rank saves have no `citizenRank` key -- default to tier 0 ('Settler'), same
      // "old save loads with the new system just not-yet-active" convention as every other
      // system added later in this project (see e.g. c.age/c.hydration fallbacks above).
      w.citizens.citizenRank[i] = c.citizenRank ? c.citizenRank[i] : 0;
      // Pre-augment saves have no `augmentMask` key -- default to 0 (no augments installed), same
      // "old save loads with the new system just not-yet-active" convention as citizenRank above.
      w.citizens.augmentMask[i] = c.augmentMask ? c.augmentMask[i] : 0;
      w.citizens.trait[i] = c.trait && c.trait[i] ? TRAITS.find(t => t.name === c.trait[i]) : null;
    }
    w.roster = new (Object.getPrototypeOf(w.roster).constructor)();
    for (const r of json.roster) {
      w.roster.assign(r.id, r.kind, r.post);
      // Pre-override saves have no `manualWeapon` key -- falls back to staying fully automatic,
      // same convention as every other system added later in this project.
      if (r.manualWeapon) w.roster.setManualWeapon(r.id, r.manualWeapon);
    }
    // Corrupt/bribable staff (security.js) -- pre-existing saves have no `staffCorruption` key,
    // so every restored staffer just starts as un-evaluated (identical to a world where
    // tickStaffCorruption hasn't looked at them yet), rather than throwing.
    if (json.staffCorruption) {
      const sc = json.staffCorruption;
      w.roster._corruptEvaluated = new Set(sc.evaluated || []);
      w.roster._corruptEligible = new Set(sc.eligible || []);
      w.roster._corruptActiveUntil = new Map(sc.activeUntil || []);
      w.roster._corruptDiscovered = new Set(sc.discovered || []);
    }
    w.structures = json.structures.map(s => {
      const built = Object.assign(new Structure(s.kind, s.x, s.y, { instant: true }), s);
      // The constructor's instant:true default marks _builtNotified true regardless of the real
      // (restored) underConstruction value -- recompute it here so a structure that was still
      // mid-build at save time can still fire its build-complete cue once it actually finishes.
      built._builtNotified = !built.underConstruction;
      return built;
    });
    if (json.zones) w.zones.kind.set(json.zones);
    if (json.dogs) w.dogs = json.dogs.map(d => ({ ...d, cooldown: 0 }));
    if (json.wildAnimals) {
      w.wildAnimals = json.wildAnimals.map(a => ({ x: a.x, y: a.y, targetX: a.x, targetY: a.y, claimedBy: null, tameTicks: 0 }));
    }
    if (json.vehicles) {
      // Citizen jobState isn't persisted (arrays default back to Idle on the fresh SimWorld
      // above), so a vehicle can't come back mid-haul with a valid driver -- every vehicle
      // loads parked; whoever was driving just needs to be reassigned by the job system.
      w.vehicles = json.vehicles.map(v => ({
        kind: v.kind, fuelType: v.fuelType || 'gas', garageX: v.garageX, garageY: v.garageY, x: v.garageX, y: v.garageY,
        driverId: null, phase: 'parked', workTimer: 0, targetNode: null,
      }));
    }
    // Labor drones (drones.js) -- pre-existing saves have no `drones`/`droneFabricationQueue`
    // keys, so this falls back to the fresh-colony empty defaults the constructor already set,
    // same convention as every other system added later in this project.
    if (json.drones) {
      w.drones = json.drones.map(d => new Drone(d.id, d.category, d.x, d.y));
      bumpDroneIdCounter(w.drones);
    }
    if (json.droneFabricationQueue) {
      w.droneFabricationQueue = json.droneFabricationQueue.map(o => ({ ...o }));
    }
    if (json.resourceNodes) {
      w.resourceNodes = json.resourceNodes.map(n => Object.assign(new ResourceNode(n.x, n.y, n.maxAmount), n));
    }
    // Rat infestation (rats.js) -- pre-existing saves have none of these keys, and initRats()
    // (already called inside the SimWorld constructor above) already left w.ratInfestation/rats
    // at their fresh-colony defaults, so an old save just loads with no rat problem yet rather
    // than throwing.
    if (json.ratInfestation != null) w.ratInfestation = json.ratInfestation;
    if (json.ratsCaught != null) w.ratsCaught = json.ratsCaught;
    if (json.rats) {
      w.rats = json.rats.map((r, idx) => Object.assign(new Rat(r.x, r.y, idx % 30), { x: r.x, y: r.y }));
    }
    // Epidemic (epidemic.js) -- pre-existing saves have no `epidemicLastEndTick` key, and
    // initEpidemic() (already called inside the SimWorld constructor above) already left it at
    // -EPIDEMIC_MIN_GAP_TICKS (gate-open default), same "old save loads with no problem yet"
    // convention as rats/anomaly above. epidemicActive is deliberately NOT restored here -- it's
    // re-derived from the per-citizen epidemicStage array the moment tickEpidemic next runs (see
    // the serialize() doc comment above).
    if (json.epidemicLastEndTick != null) w._epidemicLastEndTick = json.epidemicLastEndTick;
    // Anomaly pressure (anomaly.js) -- pre-existing saves have no `anomalyPressure` key, and
    // initAnomaly() (already called inside the SimWorld constructor above) already left it at 0,
    // same "old save loads with no problem yet" convention as rats above.
    if (json.anomalyPressure != null) w.anomalyPressure = json.anomalyPressure;
    // Tainted supply delivery (supplies.js) -- pre-existing saves have no `supplyDelivery` key,
    // and initSupplies() (already called inside the SimWorld constructor above) already left it at
    // its fresh-colony default (null, no delivery pending), same "old save loads with no problem
    // yet" convention as rats/anomaly above.
    if (json.supplyDelivery !== undefined) w.supplyDelivery = json.supplyDelivery;
    if (json.nextDeliveryTick != null) w._nextDeliveryTick = json.nextDeliveryTick;
    return w;
  }
}
