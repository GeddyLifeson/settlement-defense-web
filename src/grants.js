// Outpost Charter Contracts (grants.js) -- non-carceral port of Prison Architect's real
// grants.lua mechanic (SESSION_HANDOFF.md: already researched, findings summarized there before
// this file existed). Real PA shape being ported: a parent objective carries the actual reward
// and stays hidden until its prerequisites are met (Objective.SetPreRequisite); its child
// objectives are a free checklist with no reward of their own; a scaling grant ladder is unlocked
// strictly in sequence; and a separate time-locked investment instrument lets the player pay in
// now and collect more later. Reskinned as contracts issued by whatever regional authority
// oversees a civil settlement -- no prison, inmate, warden, or corrections language anywhere, per
// this project's explicit non-carceral rule.
//
// Real numbers this was scaled from (task doc, anchored to economy.js's own comment that this
// project's scrap economy runs roughly 1/40th of Prison Architect's dollar scale):
//  - Bootstrap contract: PA's real starter grant pays 10,000-20,000 for a handful of basic
//    conditions met at zero upfront cost -- here, 250-500 (this file pays the midpoint, 375) for
//    7 basic conditions, still zero cost to the player.
//  - Capacity-tier ladder: PA's real population-scaling grant chain runs 50->100->200->500
//    people. This project's population can't climb anywhere near that far above its starting
//    size (weather.js's wanderer-joins event is capped at ~1.15x the starting roster, and the
//    separate Refugee Wagon in world.js only replenishes combat losses back toward ~0.9x of
//    starting size -- see both files' own comments) -- so rather than literally scaling PA's
//    50/100/200/500 by a constant factor (which would put the top rungs permanently unreachable
//    for a normal 24-40-citizen run), the ladder here targets peak-alive-citizen counts that are
//    actually reachable at that colony size, while keeping the same "each rung roughly doubles
//    the difficulty of the last" shape PA's own 50->100->200->500 progression has.
//  - Investment instrument: PA's real Deposit Box pays in $5,000, waits 4,320 or 10,080 real
//    minutes (3 or 7 days), pays out $16,000. Here: pay in 125 scrap (5,000/40), wait 1,080 ticks
//    short-term or 2,520 ticks long-term (the task's own tick figures, in the same ballpark as
//    schedule.js's DAY_NIGHT_CYCLE_TICKS=2400-per-day so the two terms read as "under a day" vs
//    "about a day"), long-term pays out 400 (16,000/40, the literal scaled figure) -- short-term
//    pays a genuinely smaller multiple (220) since real investment instruments pay less for
//    tying up capital for less time, not the same reward on a shorter clock.
//  - Emergency bailout: PA's real gate is cash<=500, cashflow<=0, debt>=10000, population>=30.
//    This project has no debt field, so "debt" is reskinned as a sustained scrap deficit read
//    straight off world.finance.history (world.js's existing budget-report snapshots) rather than
//    inventing a parallel resource. The genuine "rescue with strings attached" part of PA's own
//    version survives the port: this grant does NOT pay out the moment the crisis gate opens --
//    it sits pending until the settlement's own finances demonstrably recover, so it rewards
//    successful crisis management rather than just handing over free scrap the instant things
//    look bad.
//
// Second research pass (this session): real grants.lua also has several condition TYPES this file
// had no equivalent for yet -- Objective.RequireObjects (staffing quota), RequireManufactured
// (cumulative production quota), RequireResearched (research-gated), the live-count form of
// Objective.Requires (a job-assignment count read right now, not cumulative), the AtMost form of
// Objective.Requires (a suppressed/ceiling stat, the inverse of every threshold above), and a
// cumulative event-occurrence count. Eight new charters below cover all six, reusing existing data
// hooks throughout rather than inventing new tracking: security.js's StaffRoster.kindOf/isStaff/
// isOffDuty (already read the same way by world.js's own _isMonitorStaffed), jobs.js's JobState
// enum values and world.finance.processingScrap (already tallies the 'workshop' Processing job's
// completed-unit payouts, see world.js's addScrap -- no new counter needed for a manufacturing
// quota), research.js's world.research.unlocked map, world.unrestLevel (already a live 0..1
// gauge), and world.ratsCaught/world.attackersKilled (already-tracked lifetime event counters, see
// rats.js/world.js's addScrap). Same no-cross-file-import convention as the rest of this file (see
// zoneTileCount's ZoneKind magic-number-plus-comment precedent below) -- every new hook here reads
// a public field or method already hanging off `world`, nothing is imported from jobs.js/
// research.js/security.js/core.js.

const CHARTER_REWARD_BOOTSTRAP = 375; // midpoint of the task's 250-500 range, see header comment

// Capacity-tier population thresholds -- deliberately RELATIVE to world.startingCitizenCount
// rather than fixed absolute numbers. This engine hard-caps how far the living population can
// grow above wherever it started: weather.js's wanderer-joins event refuses once
// world.citizens.count >= startingCitizenCount * 1.15 (WANDERER_POPULATION_CAP_MULT), and the
// separate Refugee Wagon (world.js) only ever replenishes COMBAT LOSSES back toward ~90% of
// starting size, it never grows a colony past its start. A fixed ladder like PA's literal
// 50/100/200/500 (or even a naively-scaled-down flat version of it) would either be trivially
// true at tick 0 for a colony that started large, or permanently unreachable for one that started
// small -- neither is a real milestone. These factors instead target genuine growth above
// whatever this run actually started with, topping out just under the real 1.15x ceiling so the
// last rung is genuinely hard (mirrors PA's own top grant tier being the one real settlements
// rarely reach) without being mathematically impossible for any of New Game's 12-32 starting-
// citizen range.
const TIER_POPULATION_FACTORS = [1.04, 1.08, 1.12, 1.15];
const TIER_REWARDS = [70, 110, 170, 260]; // roughly doubling per rung, same shape as PA's own ladder

/** The peakAliveCitizens threshold for ladder rung `idx`, relative to this run's own starting
 *  size -- see TIER_POPULATION_FACTORS' doc comment above for why this can't be a flat constant. */
function tierPopulationThreshold(world, idx) {
  const start = world.startingCitizenCount || 24;
  // Math.max with start+idx+1 guarantees strictly-increasing, strictly-above-start thresholds
  // even at the smallest 12-citizen starting size, where the multiplicative factors alone would
  // round several rungs down to the exact same integer.
  return Math.max(start + idx + 1, Math.round(start * TIER_POPULATION_FACTORS[idx]));
}
const INVEST_COST = 125;
const INVEST_SHORT_TICKS = 1080;
const INVEST_LONG_TICKS = 2520;
const INVEST_SHORT_PAYOUT = 220;
const INVEST_LONG_PAYOUT = 400;

// Bailout crisis gate (see header comment for the debt->deficit reskin). world.finance.history
// (world.js) snapshots every FINANCE_SNAPSHOT_INTERVAL=300 ticks -- summing the last 3 entries'
// net looks back ~900 ticks, a genuinely sustained downturn rather than one bad snapshot, mirroring
// how UNREST_SUSTAIN_TICKS elsewhere in world.js requires a crisis to hold before it counts.
const BAILOUT_SCRAP_CEILING = 15; // "critically low" -- starting scrap is 50, cheapest real defense costs more than this
const BAILOUT_MIN_POPULATION = 18; // "decent-sized" -- flat floor (not relative to starting size like the tier ladder above), a colony worth saving regardless of how it started
const BAILOUT_DEFICIT_WINDOW = 3; // finance.history entries looked back for the sustained-deficit check
const BAILOUT_DEFICIT_FLOOR = -30; // summed net over that window must be at least this negative
const BAILOUT_REWARD = 300;
// Recovery bar the settlement has to clear on its own before the pending bailout actually pays --
// this is the "strings attached" half: unlocking is a crisis, completing requires genuine recovery.
const BAILOUT_RECOVERY_SCRAP = 60; // comfortably above the ceiling that triggered the crisis
const BAILOUT_RECOVERY_NET_FLOOR = 0; // summed recent net must be non-negative, i.e. no longer bleeding

// ---- Second-pass condition-type constants (see the header comment's second paragraph) ----

// Staffing quota (PA's real Objective.RequireObjects("Doctor", 2)): the starting roster already
// assigns 2 Guard + 2 Sniper the moment the colony has >3 starting citizens (world.js's
// constructor), so a target of 2 would be trivially already-met at tick 0 for most runs -- 3 is
// the smallest target that actually asks the player to grow the security detail past the default.
const GUARD_DETAIL_TARGET = 3;
const GUARD_DETAIL_REWARD = 90;

// Production quota (PA's real Objective.RequireManufactured("LicensePlate", 30) -- the exact same
// 30-unit figure is reused here). world.finance.processingScrap (world.js's addScrap) already
// tallies every completed workshop unit's payout cumulatively -- see the header comment -- so no
// new counter needs adding for this one. WORKSHOP_SCRAP_PER_UNIT mirrors jobs.js's own
// WORKSHOP_PROCESSED_PER_UNIT=10 as a local constant rather than an import, same convention
// zoneTileCount's ZoneKind comment below already sets for this file.
const WORKSHOP_UNITS_TARGET = 30;
const WORKSHOP_SCRAP_PER_UNIT = 10; // jobs.js's WORKSHOP_PROCESSED_PER_UNIT
const WORKSHOP_PROCESSING_TARGET = WORKSHOP_UNITS_TARGET * WORKSHOP_SCRAP_PER_UNIT;
const WORKSHOP_CONTRACT_REWARD = 150;

// Research-gated (PA's real Objective.RequireResearched("Finance")). Surveillance (research.js)
// was picked over e.g. materials_processing since it keeps this charter's theme (a security/
// oversight investment) distinct from the workshop production-quota charter right above.
const SURVEILLANCE_RESEARCH_NODE_ID = 'surveillance'; // research.js's RESEARCH_NODES id
const RESEARCH_INITIATIVE_REWARD = 70;

// Live job-assignment count (PA's real Objective.Requires("PrisonerJobs", "Laundry", 3) --
// distinct from the staffing quota above: this counts citizens CURRENTLY in a civilian JobState
// this exact tick, not staff assigned a security.js role). Cleaning was picked as this project's
// closest analogue to PA's own menial-labor "Laundry" example.
const CLEANING_LIVE_TARGET = 2;
const LABOR_ASSIGNMENT_REWARD = 55;

// Suppressed-stat / AtMost ceilings (PA's real Objective.Requires("ExhaustedStaffPercent",
// "AtMost", 5) -- the inverse of every threshold above: reward for keeping an undesirable metric
// DOWN, not growing one up). Two metrics picked, per the task brief's "1-2 metrics that make sense
// to suppress": world.unrestLevel (already a live 0..1 gauge, world.js's _updateUnrest) and the
// fraction of the duty roster currently off-duty recovering fatigue (security.js's
// StaffRoster.isOffDuty -- this project's nearest real equivalent to PA's ExhaustedStaffPercent).
const CIVIL_ORDER_UNREST_CEILING = 0.3; // world.unrestLevel's own UNREST_TRIGGER_THRESHOLD (world.js) is 0.55, so this asks for genuinely calm, not just "not yet in crisis"
const CIVIL_ORDER_REWARD = 130;
const EXHAUSTED_STAFF_CEILING = 0.25; // real PA ceiling (5%) doesn't translate at this project's roster sizes (a handful of staff, not hundreds) -- see wellRestedMet's own doc comment
const WELL_RESTED_REWARD = 75;

// Event-occurrence-count (PA's real Objective.Requires("ContrabandFound", "Narcotics", 10)):
// cumulative count of a specific event happening over the run. Reuses world.ratsCaught (rats.js)
// and world.attackersKilled (world.js's addScrap) directly -- both already-tracked lifetime
// counters, see the header comment -- rather than adding new event-tracking infrastructure.
const RATS_CAUGHT_TARGET = 5;
const PEST_CONTROL_REWARD = 55;
const ATTACKERS_KILLED_TARGET = 20;
const DEFENDER_REWARD = 110;

export const CharterKind = Object.freeze({
  Bootstrap: 'bootstrap',
  TierOutpost: 'tier_outpost',
  TierWaystation: 'tier_waystation',
  TierDistrict: 'tier_district',
  TierRegion: 'tier_region',
  Bailout: 'bailout',
  GuardDetail: 'guard_detail',
  WorkshopContract: 'workshop_contract',
  ResearchInitiative: 'research_initiative',
  LaborAssignment: 'labor_assignment',
  CivilOrder: 'civil_order',
  WellRested: 'well_rested',
  PestControl: 'pest_control',
  Defender: 'defender',
});

const TIER_ORDER = [CharterKind.TierOutpost, CharterKind.TierWaystation, CharterKind.TierDistrict, CharterKind.TierRegion];

function completedCountOf(world, kind) {
  let n = 0;
  for (const s of world.structures) if (s.kind === kind && !s.underConstruction && !s.destroyed) n++;
  return n;
}

// Completed walls are a special case: grid.js/fire.js bake a finished wall Structure straight
// into the grid's permanent wallThingId terrain the tick after construction completes (see
// fire.js's own doc comment: "walls... fold into permanent grid terrain... and can't hold fire
// state") -- so a completed wall almost never actually shows up in world.structures by the time
// anything checks for it. Count real wall coverage off the grid directly instead of
// completedCountOf, which only ever sees a wall Structure during its brief post-completion,
// pre-fold window.
function wallTileCount(world) {
  let n = 0;
  const arr = world.grid.wallThingId;
  for (let i = 0; i < arr.length; i++) if (arr[i] !== 0) n++;
  return n;
}

function zoneTileCount(world, zoneKind) {
  let n = 0;
  const arr = world.zones.kind;
  for (let i = 0; i < arr.length; i++) if (arr[i] === zoneKind) n++;
  return n;
}

function aliveCitizenCount(world) {
  let n = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) n++;
  return n;
}

// ---- Second-pass data hooks (see the header comment's second paragraph) ----

// Staffing quota data hook: counts LIVING, non-downed citizens currently assigned `roleLabel`
// (a security.js StaffRoleKind string, e.g. 'Guard') on the duty roster right now. Same
// citizens-store-scan-plus-roster-lookup shape world.js's own `_isMonitorStaffed` already uses for
// StaffRoleKind.Monitor -- world.idOf(i)/world.roster.kindOf(id) are both public methods, so this
// needs no import, just reading what's hanging off `world` like every other helper in this file.
function staffRoleCount(world, roleLabel) {
  let n = 0;
  for (let i = 0; i < world.citizens.count; i++) {
    if (!world.citizens.isAliveAt(i) || world.citizens.isDownedAt(i)) continue;
    if (world.roster.kindOf(world.idOf(i)) === roleLabel) n++;
  }
  return n;
}

// Production quota data hook: world.finance.processingScrap (world.js's addScrap, kind
// 'processing') already accumulates WORKSHOP_SCRAP_PER_UNIT for every unit the 'workshop'
// Processing job completes (jobs.js) -- it's a pure running total, never decremented, since the
// raw-material debit that starts a unit is booked with a negative amount and addScrap only
// categorizes positive amounts (see world.js's own addScrap doc comment). Dividing back out gives
// an exact whole-unit count without adding any new counter.
function processedUnitsDelivered(world) {
  const scrap = (world.finance && world.finance.processingScrap) || 0;
  return Math.floor(scrap / WORKSHOP_SCRAP_PER_UNIT);
}

// Research-gated data hook: mirrors research.js's isNodeUnlocked(state, nodeId) exactly (a
// one-line null-safe map lookup) rather than importing it, same no-cross-import convention as
// every other helper in this file -- world.research is the exact state object isNodeUnlocked
// itself expects, just read directly off `world`.
function researchNodeUnlocked(world, nodeId) {
  return !!(world.research && world.research.unlocked && world.research.unlocked[nodeId]);
}

// Live job-assignment count data hook: counts LIVING citizens whose store.jobState field equals
// `jobStateValue` THIS TICK (not a cumulative total) -- distinct from staffRoleCount above, which
// reads security.js's roster assignment, not jobs.js's per-tick JobState. jobStateValue is passed
// as jobs.js's own JobState enum's numeric value (e.g. 16 for JobState.Cleaning) with an inline
// comment at the call site, same magic-number-plus-comment convention zoneTileCount already uses
// for ZoneKind below.
function activeJobCount(world, jobStateValue) {
  let n = 0;
  for (let i = 0; i < world.citizens.count; i++) {
    if (!world.citizens.isAliveAt(i)) continue;
    if (world.citizens.jobState[i] === jobStateValue) n++;
  }
  return n;
}

// Suppressed-stat data hook (ExhaustedStaffPercent's nearest real equivalent here): fraction of
// the duty roster currently off-duty recovering fatigue (security.js's StaffRoster.isOffDuty,
// world.js's own isStaffOnDutyAt already reads isStaff+isOffDuty the same way). Returns -1
// (sentinel "not applicable") when the roster is empty -- a colony with no staff at all shouldn't
// trivially satisfy an AtMost-zero-exhaustion charter just because there's no one to exhaust; see
// wellRestedMet below for how callers treat the sentinel.
function exhaustedStaffFraction(world) {
  let total = 0, exhausted = 0;
  for (let i = 0; i < world.citizens.count; i++) {
    if (!world.citizens.isAliveAt(i)) continue;
    const id = world.idOf(i);
    if (!world.roster.isStaff(id)) continue;
    total++;
    if (world.roster.isOffDuty(id)) exhausted++;
  }
  return total > 0 ? exhausted / total : -1;
}

// AtMost ceiling wrapper: the real PA ExhaustedStaffPercent AtMost 5 gate translated to this
// project's much smaller roster sizes (a handful of staff, not hundreds, so a flat 5% ceiling
// would round to "zero staff may ever be off-duty simultaneously" -- see EXHAUSTED_STAFF_CEILING's
// own doc comment above for the rescale). The -1 sentinel (no staff on the roster at all) is
// treated as NOT met, not vacuously true -- an AtMost charter should reward genuine fatigue
// management, not an empty roster.
function wellRestedMet(world) {
  const f = exhaustedStaffFraction(world);
  return f >= 0 && f <= EXHAUSTED_STAFF_CEILING;
}

// Reusable checklist-item builder for an either/or condition slot (PA's real
// Objective.RequireObjectsWithAlt pattern: accept condition A OR B OR C as satisfying ONE
// checklist entry, rather than requiring literally all of them). Checklist items are already just
// { label, check(world) } (see BOOTSTRAP_CHECKLIST below) -- this is a thin composer over that
// exact shape, not a new structure, so completeCheck and the UI panel (main.js's renderGrants,
// which just calls resolveText(item.label, world) and item.check(world) on whatever it's handed)
// never need to know a given checklist entry is actually an OR of several sub-conditions
// underneath. `alts` is an array of { label, check(world) } sub-conditions; the composed label
// lists them "A, or B" and the composed check() is satisfied the instant ANY one alt's check() is.
function altChecklistItem(alts) {
  return {
    label: world => alts.map(a => resolveText(a.label, world)).join(', or '),
    check: world => alts.some(a => a.check(world)),
  };
}

// Bootstrap's 7-item checklist -- a free child objective per item, matching PA's real
// parent-objective-carries-the-reward/children-are-free shape (see header comment). Each entry is
// { label, check(world) } so the UI panel can render a live per-item tick/cross without the panel
// needing to know anything about what each condition actually means.
const BOOTSTRAP_CHECKLIST = [
  { label: 'At least one wall section built', check: w => wallTileCount(w) >= 1 },
  { label: 'At least one turret built', check: w => completedCountOf(w, 'turret') >= 1 },
  { label: 'At least one bed built', check: w => completedCountOf(w, 'bed') >= 1 },
  { label: 'A Food zone painted', check: w => zoneTileCount(w, 2 /* ZoneKind.Food */) >= 1 },
  { label: 'A Bedroom zone painted', check: w => zoneTileCount(w, 1 /* ZoneKind.Bedroom */) >= 1 },
  { label: 'At least 6 citizens alive', check: w => aliveCitizenCount(w) >= 6 },
  { label: 'Survived the first wave', check: w => w.waveSpawner.waveNumber >= 1 },
];

function bailoutGateMet(world) {
  if (world.scrap > BAILOUT_SCRAP_CEILING) return false;
  if (aliveCitizenCount(world) < BAILOUT_MIN_POPULATION) return false;
  const h = world.finance && world.finance.history ? world.finance.history : [];
  if (h.length < BAILOUT_DEFICIT_WINDOW) return false;
  const recentNet = h.slice(-BAILOUT_DEFICIT_WINDOW).reduce((sum, e) => sum + e.net, 0);
  return recentNet <= BAILOUT_DEFICIT_FLOOR;
}

function bailoutRecoveryMet(world) {
  if (world.scrap < BAILOUT_RECOVERY_SCRAP) return false;
  const h = world.finance && world.finance.history ? world.finance.history : [];
  if (h.length < BAILOUT_DEFICIT_WINDOW) return false;
  const recentNet = h.slice(-BAILOUT_DEFICIT_WINDOW).reduce((sum, e) => sum + e.net, 0);
  return recentNet >= BAILOUT_RECOVERY_NET_FLOOR;
}

// ---- Second-pass checklists (see the header comment's second paragraph). Each is a named
// constant, same "one shared array feeds both `checklist` and completeCheck" idiom
// BOOTSTRAP_CHECKLIST already establishes below, rather than the tier-ladder/Bailout pattern of a
// separate duplicate predicate function -- these all have exactly one (possibly either/or) slot,
// so there's no reason for the two to drift apart. ----

// Staffing quota (RequireObjects-style): either alt satisfies the one slot, see altChecklistItem's
// own doc comment above for why this demonstrates the RequireObjectsWithAlt pattern.
const GUARD_DETAIL_CHECKLIST = [altChecklistItem([
  { label: `At least ${GUARD_DETAIL_TARGET} citizens currently on Guard duty`, check: w => staffRoleCount(w, 'Guard') >= GUARD_DETAIL_TARGET },
  { label: `At least ${GUARD_DETAIL_TARGET} citizens currently on Sniper duty`, check: w => staffRoleCount(w, 'Sniper') >= GUARD_DETAIL_TARGET },
])];

// Production quota (RequireManufactured-style).
const WORKSHOP_CONTRACT_CHECKLIST = [
  { label: `At least ${WORKSHOP_UNITS_TARGET} processed units delivered off the workshop line (${WORKSHOP_PROCESSING_TARGET}+ scrap worth)`,
    check: w => processedUnitsDelivered(w) >= WORKSHOP_UNITS_TARGET },
];

// Research-gated (RequireResearched-style).
const RESEARCH_INITIATIVE_CHECKLIST = [
  { label: 'Surveillance research completed (CCTV cameras + monitor station unlocked)',
    check: w => researchNodeUnlocked(w, SURVEILLANCE_RESEARCH_NODE_ID) },
];

// Live job-assignment count (the counted, not-AtMost, form of Objective.Requires).
const LABOR_ASSIGNMENT_CHECKLIST = [
  { label: `At least ${CLEANING_LIVE_TARGET} citizens actively cleaning right now`,
    check: w => activeJobCount(w, 16 /* JobState.Cleaning, see jobs.js */) >= CLEANING_LIVE_TARGET },
];

// Suppressed-stat / AtMost ceilings (the AtMost form of Objective.Requires).
const CIVIL_ORDER_CHECKLIST = [
  { label: `Civil unrest held at or below ${Math.round(CIVIL_ORDER_UNREST_CEILING * 100)}%`,
    check: w => w.unrestLevel <= CIVIL_ORDER_UNREST_CEILING },
];
const WELL_RESTED_CHECKLIST = [
  { label: `No more than ${Math.round(EXHAUSTED_STAFF_CEILING * 100)}% of the duty roster fatigued at once`,
    check: wellRestedMet },
];

// Event-occurrence-count.
const PEST_CONTROL_CHECKLIST = [
  { label: `${RATS_CAUGHT_TARGET} rats caught in traps`, check: w => (w.ratsCaught || 0) >= RATS_CAUGHT_TARGET },
];
const DEFENDER_CHECKLIST = [
  { label: `${ATTACKERS_KILLED_TARGET} attackers killed defending the settlement`, check: w => (w.attackersKilled || 0) >= ATTACKERS_KILLED_TARGET },
];

// GRANT_DEFS: id -> definition. `unlockCheck` gates visibility/eligibility (PA's real
// SetPreRequisite hide-until-ready behavior); `completeCheck` gates the actual payout, which is
// the same moment as unlockCheck for every charter EXCEPT the bailout (see its own doc comment
// above) -- the two are deliberately kept as separate hooks rather than collapsed into one so
// that distinction is structural, not a special case bolted on somewhere else.
export const GRANT_DEFS = Object.freeze({
  [CharterKind.Bootstrap]: Object.freeze({
    label: 'Bootstrap Charter',
    desc: 'A no-cost founding contract from the regional authority -- clear the checklist below and the settlement is recognized as a going concern.',
    reward: CHARTER_REWARD_BOOTSTRAP,
    checklist: BOOTSTRAP_CHECKLIST,
    unlockCheck: () => true, // always visible from tick 0, same as PA's real starter grant
    completeCheck: world => BOOTSTRAP_CHECKLIST.every(item => item.check(world)),
    requires: null,
  }),
  ...Object.fromEntries(TIER_ORDER.map((kind, idx) => [kind, Object.freeze({
    label: ['Outpost Recognition', 'Waystation Charter', 'District Charter', 'Regional Charter'][idx],
    // desc/checklist label are functions, not plain strings: the actual population target is
    // relative to THIS run's own starting size (tierPopulationThreshold), so it can't be baked in
    // at module-load time the way every other charter's fixed-number text can be. See
    // renderGrants() in main.js for where these get called with the live world.
    desc: world => `Issued once the settlement has sustained at least ${tierPopulationThreshold(world, idx)} residents at once.`,
    reward: TIER_REWARDS[idx],
    checklist: [{
      label: world => `Peak population reached ${tierPopulationThreshold(world, idx)}`,
      check: w => w.peakAliveCitizens >= tierPopulationThreshold(w, idx),
    }],
    // Sequential unlock: each rung's checklist item only becomes checkable once the PRIOR rung in
    // the ladder is already completed -- mirrors PA's real scaling-grant chain, where a later
    // grant's own prerequisite is the earlier grant already being awarded, not just a bigger
    // number on its own. idx 0 (TierOutpost) requires Bootstrap.
    unlockCheck: (world, state) => idx === 0 ? isCompleted(state, CharterKind.Bootstrap) : isCompleted(state, TIER_ORDER[idx - 1]),
    completeCheck: world => world.peakAliveCitizens >= tierPopulationThreshold(world, idx),
    requires: idx === 0 ? CharterKind.Bootstrap : TIER_ORDER[idx - 1],
  })])),
  [CharterKind.Bailout]: Object.freeze({
    label: 'Emergency Stabilization Charter',
    desc: 'Only offered while the settlement is genuinely in financial trouble -- and only pays out once its own finances actually recover. Not free money.',
    reward: BAILOUT_REWARD,
    checklist: [
      { label: `Scrap on hand recovers above ${BAILOUT_RECOVERY_SCRAP}`, check: bailoutRecoveryMet },
      { label: 'Income trend turns non-negative again', check: bailoutRecoveryMet },
    ],
    unlockCheck: bailoutGateMet,
    completeCheck: bailoutRecoveryMet,
    requires: null,
  }),

  // ---- Second-pass charters (see the header comment's second paragraph). All except Civil Order
  // gate on Bootstrap already being fulfilled, same "Bootstrap is the true tick-0 starter,
  // everything else waits for it" convention the population-tier ladder above already
  // establishes -- Civil Order gates one rung further out (Outpost Recognition) since unrest needs
  // genuine elapsed time to have moved at all before "kept it low" means anything.
  [CharterKind.GuardDetail]: Object.freeze({
    label: 'Guard Detail Charter',
    desc: 'Issued once the security detail is staffed well past the founding minimum.',
    reward: GUARD_DETAIL_REWARD,
    checklist: GUARD_DETAIL_CHECKLIST,
    unlockCheck: (world, state) => isCompleted(state, CharterKind.Bootstrap),
    completeCheck: world => GUARD_DETAIL_CHECKLIST.every(item => item.check(world)),
    requires: CharterKind.Bootstrap,
  }),
  [CharterKind.WorkshopContract]: Object.freeze({
    label: 'Processed Goods Contract',
    desc: 'A standing order from the regional authority for finished workshop output.',
    reward: WORKSHOP_CONTRACT_REWARD,
    checklist: WORKSHOP_CONTRACT_CHECKLIST,
    unlockCheck: (world, state) => isCompleted(state, CharterKind.Bootstrap),
    completeCheck: world => WORKSHOP_CONTRACT_CHECKLIST.every(item => item.check(world)),
    requires: CharterKind.Bootstrap,
  }),
  [CharterKind.ResearchInitiative]: Object.freeze({
    label: 'Surveillance Initiative Charter',
    desc: 'Funds a settlement that has invested in its own oversight capability.',
    reward: RESEARCH_INITIATIVE_REWARD,
    checklist: RESEARCH_INITIATIVE_CHECKLIST,
    unlockCheck: (world, state) => isCompleted(state, CharterKind.Bootstrap),
    completeCheck: world => RESEARCH_INITIATIVE_CHECKLIST.every(item => item.check(world)),
    requires: CharterKind.Bootstrap,
  }),
  [CharterKind.LaborAssignment]: Object.freeze({
    label: 'Labor Assignment Charter',
    desc: 'Rewards keeping enough hands actively assigned to upkeep work right now.',
    reward: LABOR_ASSIGNMENT_REWARD,
    checklist: LABOR_ASSIGNMENT_CHECKLIST,
    unlockCheck: (world, state) => isCompleted(state, CharterKind.Bootstrap),
    completeCheck: world => LABOR_ASSIGNMENT_CHECKLIST.every(item => item.check(world)),
    requires: CharterKind.Bootstrap,
  }),
  [CharterKind.CivilOrder]: Object.freeze({
    label: 'Civil Order Charter',
    desc: 'Rewards a settlement that keeps unrest genuinely low, not just below crisis.',
    reward: CIVIL_ORDER_REWARD,
    checklist: CIVIL_ORDER_CHECKLIST,
    unlockCheck: (world, state) => isCompleted(state, CharterKind.TierOutpost),
    completeCheck: world => CIVIL_ORDER_CHECKLIST.every(item => item.check(world)),
    requires: CharterKind.TierOutpost,
  }),
  [CharterKind.WellRested]: Object.freeze({
    label: 'Duty Roster Welfare Charter',
    desc: 'Rewards a duty roster that isn\'t running itself into the ground.',
    reward: WELL_RESTED_REWARD,
    checklist: WELL_RESTED_CHECKLIST,
    unlockCheck: (world, state) => isCompleted(state, CharterKind.Bootstrap),
    completeCheck: world => WELL_RESTED_CHECKLIST.every(item => item.check(world)),
    requires: CharterKind.Bootstrap,
  }),
  [CharterKind.PestControl]: Object.freeze({
    label: 'Pest Control Charter',
    desc: 'A small standing bounty for keeping the vermin problem in check.',
    reward: PEST_CONTROL_REWARD,
    checklist: PEST_CONTROL_CHECKLIST,
    unlockCheck: (world, state) => isCompleted(state, CharterKind.Bootstrap),
    completeCheck: world => PEST_CONTROL_CHECKLIST.every(item => item.check(world)),
    requires: CharterKind.Bootstrap,
  }),
  [CharterKind.Defender]: Object.freeze({
    label: 'Perimeter Defense Charter',
    desc: 'Recognition for a settlement that has proven it can hold its own perimeter.',
    reward: DEFENDER_REWARD,
    checklist: DEFENDER_CHECKLIST,
    unlockCheck: (world, state) => isCompleted(state, CharterKind.Bootstrap),
    completeCheck: world => DEFENDER_CHECKLIST.every(item => item.check(world)),
    requires: CharterKind.Bootstrap,
  }),
});

export const GRANT_ORDER = [
  CharterKind.Bootstrap, ...TIER_ORDER, CharterKind.Bailout,
  CharterKind.GuardDetail, CharterKind.WorkshopContract, CharterKind.ResearchInitiative,
  CharterKind.LaborAssignment, CharterKind.CivilOrder, CharterKind.WellRested,
  CharterKind.PestControl, CharterKind.Defender,
];

// A def's `desc` and a checklist item's `label` are plain strings for most charters but functions
// of `world` for the tier ladder (see its own doc comment above) -- this is the one place that
// distinction has to be handled, so the UI panel (main.js) never needs to know which kind it got.
export function resolveText(value, world) {
  return typeof value === 'function' ? value(world) : value;
}

function isCompleted(state, id) {
  return !!(state.charters[id] && state.charters[id].completed);
}

export function createGrantState() {
  const charters = {};
  for (const id of GRANT_ORDER) charters[id] = { unlocked: false, completed: false, unlockedAtTick: null, completedAtTick: null };
  return { charters, investments: [] };
}

/** locked | available | completed, for the UI panel. */
export function charterStatus(world, id) {
  const st = world.grants.charters[id];
  if (st.completed) return 'completed';
  const def = GRANT_DEFS[id];
  if (id === CharterKind.Bailout) {
    // The bailout's own "unlocked" flag only means the crisis gate has been SEEN at least once --
    // it stays visible as pending even if scrap ticks back up above the ceiling before recovery
    // fully lands, so the player isn't punished for a single good tick mid-crisis.
    return st.unlocked ? 'available' : 'locked';
  }
  return def.unlockCheck(world, world.grants) ? 'available' : 'locked';
}

/** Per-tick update: unlock/complete charters, pay out matured investments. Called once per world
 *  tick from world.js's tick(), same "own small state object, ticked from the composition root"
 *  pattern as world.factions/world.roster/world.waveSpawner. */
export function tickGrants(world) {
  if (!world.grants) world.grants = createGrantState();
  const state = world.grants;

  for (const id of GRANT_ORDER) {
    const st = state.charters[id];
    if (st.completed) continue;
    const def = GRANT_DEFS[id];
    if (!st.unlocked) {
      if (!def.unlockCheck(world, state)) continue;
      st.unlocked = true;
      st.unlockedAtTick = world.currentTick;
      world.milestoneLog.push({ tick: world.currentTick, text: `Charter available: ${def.label}` });
      if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    }
    if (def.completeCheck(world, state)) {
      st.completed = true;
      st.completedAtTick = world.currentTick;
      world.addScrap(def.reward, 'grant');
      world.milestoneLog.push({ tick: world.currentTick, text: `Charter fulfilled: ${def.label} (+${def.reward} scrap)` });
      if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    }
  }

  // Investment maturities -- see startInvestment below for the payer side. Iterate a copy since
  // completed entries are spliced out mid-loop.
  for (let i = state.investments.length - 1; i >= 0; i--) {
    const inv = state.investments[i];
    if (world.currentTick < inv.matureTick) continue;
    world.addScrap(inv.payout, 'grant');
    world.milestoneLog.push({ tick: world.currentTick, text: `Investment matured: +${inv.payout} scrap (staked ${inv.cost})` });
    if (world.milestoneLog.length > 20) world.milestoneLog.shift();
    state.investments.splice(i, 1);
  }
}

export const InvestmentTerm = Object.freeze({ Short: 'short', Long: 'long' });

/** Player-initiated: pay INVEST_COST now via the normal scrap pool (not economy.js's spend(),
 *  since this isn't a construction cost -- it just debits world.scrap and books it against
 *  finance.buildSpend so the budget report's net-lifetime math stays honest about where scrap
 *  went), lock it for the chosen term, receive more than was paid in once it matures. Returns
 *  { ok, reason }. */
export function startInvestment(world, term) {
  if (!world.grants) world.grants = createGrantState();
  if (world.scrap < INVEST_COST) return { ok: false, reason: `Needs ${INVEST_COST} scrap on hand` };
  const short = term === InvestmentTerm.Short;
  const ticks = short ? INVEST_SHORT_TICKS : INVEST_LONG_TICKS;
  const payout = short ? INVEST_SHORT_PAYOUT : INVEST_LONG_PAYOUT;
  world.scrap -= INVEST_COST;
  if (world.finance) world.finance.buildSpend += INVEST_COST; // reuses the budget report's expense bucket, see comment above
  world.grants.investments.push({ term, cost: INVEST_COST, payout, startTick: world.currentTick, matureTick: world.currentTick + ticks });
  world.milestoneLog.push({ tick: world.currentTick, text: `Invested ${INVEST_COST} scrap (${short ? 'short-term' : 'long-term'}), matures in ${ticks} ticks` });
  if (world.milestoneLog.length > 20) world.milestoneLog.shift();
  return { ok: true };
}

export function serializeGrants(state) {
  return {
    charters: Object.fromEntries(Object.entries(state.charters).map(([id, s]) => [id, { ...s }])),
    investments: state.investments.map(inv => ({ ...inv })),
  };
}

export function deserializeGrants(json) {
  const state = createGrantState();
  if (!json) return state;
  for (const id of GRANT_ORDER) if (json.charters && json.charters[id]) state.charters[id] = { ...state.charters[id], ...json.charters[id] };
  state.investments = (json.investments || []).map(inv => ({ ...inv }));
  return state;
}

export { INVEST_COST, INVEST_SHORT_TICKS, INVEST_LONG_TICKS, INVEST_SHORT_PAYOUT, INVEST_LONG_PAYOUT };
