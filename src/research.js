// In-campaign tech unlock gating -- SEA:R's research progression (see FEATURE_RESEARCH.md's
// SEA:R section) crossed with RimWorld's research tree. Before this, every single buildable in
// input.js's TOOLS array was placeable at tick 0, so a settlement's whole tech ceiling was just
// "how much scrap do you have" -- there was no sense of a campaign advancing.
//
// Design notes:
//  - The SURVIVAL CORE stays free forever (walls/fences/doors/beds/tables/turrets/traps/
//    generator/wire/zones). A fresh colony must never be helpless: gating a turret behind
//    research would just be a slow death sentence on wave 1, which isn't progression, it's a
//    difficulty bug. Those live here as `startsUnlocked` nodes purely so the panel can show the
//    player what they already have rather than presenting a tree with mystery gaps in it.
//  - Everything GATED is a force-multiplier or a late-game system (surveillance, plumbing,
//    truck fuel tiers, tesla, recycling, nuclear, armory). Losing access to them at tick 0 costs
//    you optimisation, never viability.
//  - The conquest/world-map layer (worldmap.js) is deliberately NOT part of this tree. It's a
//    separate meta-progression axis and entangling the two would make expansion feel like a tech
//    unlock rather than a strategic choice.
//  - Every node also carries a `techLevel` (1-4, roughly Neolithic/Medieval/Industrial/Reactor-Age
//    in RimWorld terms), inferred straight from this file's own pre-existing "gated tier N"
//    comment groups above (the always-available core is folded into tier 1 alongside the cheap
//    gated tier-1 nodes -- both represent "day one, or nearly", so they share a level). See
//    colonyTechLevel()/colonyTechLevelFromState() below: a highest-unlocked-node aggregate other
//    systems (or a future one) can gate late-game content on without needing to know individual
//    node ids, mirroring how real RimWorld gates some buildables/events on colony techLevel
//    rather than one specific research project.
//  - One existing high-tier node (fission, tier 3) ALSO acts as a research-speed meta-effect --
//    see META_RESEARCH_SPEED_NODE_ID's doc comment down by tickResearch() for why that specific
//    node was picked and how the multiplier is applied.

// Passive trickle, per alive citizen per tick. Alive-citizen count is the readily-available
// existing signal (world.tick already computes it for the game-over check), and scaling by it
// gives research the right pressure: a colony that keeps people alive advances, a colony
// bleeding citizens stalls out. At the 24-citizen starting roster this is 0.06 points/tick, so
// the cheapest node lands ~500 ticks in and the whole tree is ~13k ticks of uninterrupted
// survival -- deliberately longer than a typical run, so choices in the tree actually matter.
export const RESEARCH_PER_CITIZEN_TICK = 0.0025;

// Meta research-speed node -- see tickResearch() below for where this multiplier is actually
// applied, and the doc comment on the 'fission' entry in RESEARCH_NODES for why fission
// specifically was picked to carry this effect. Declared up here (ahead of RESEARCH_NODES) so
// fission's own `desc` string below can reference the real number instead of a hardcoded "25%"
// that could silently drift out of sync with the actual multiplier.
export const META_RESEARCH_SPEED_NODE_ID = 'fission';
export const META_RESEARCH_SPEED_MULT = 1.25;

// Finance branch's ongoing-cost node (real PA anchor: LowerTaxes1->LowerTaxes2, research.txt) --
// declared up here for the same reason META_RESEARCH_SPEED_MULT is: the node's own `desc` string
// below quotes the real percentage rather than a hardcoded copy that could drift. Deliberately a
// single modest node rather than PA's real two-step chain -- see the Finance branch's doc comment
// further down for the full "why conservative" reasoning.
export const LOWER_TAXES_NODE_ID = 'lower_taxes';
export const LOWER_TAXES_DISCOUNT = 0.06; // 6% off every future BUILD_COST purchase, permanently

/** Build-cost multiplier from the Lower Taxes node, 1 (no discount) if unresearched. NOT applied
 *  anywhere in this file -- research.js has no buildable-cost code of its own. economy.js's
 *  buildCost() (the one place BUILD_COST is actually priced, alongside the existing trader-voucher
 *  and Coverage Plan discounts) would need one line added: `cost *= researchBuildCostMultiplier(
 *  world.research);` right after its existing `cost *= coveragePlanDiscountMult(world, kind);` --
 *  see this file's own header/task notes for why that line isn't added here (economy.js isn't
 *  owned by this pass). Exported so that hook is a single multiply, not a re-derivation. */
export function researchBuildCostMultiplier(state) {
  return isNodeUnlocked(state, LOWER_TAXES_NODE_ID) ? (1 - LOWER_TAXES_DISCOUNT) : 1;
}

// Contraband Screening (Security branch, item 5) -- real PA anchor: research.txt has a
// Security-branch node priced -1000 with its own CostPerUse, distinct from every existing node
// near it (small_arms_doctrine gates a buildable, staff_vetting lowers the ODDS a staffer is even
// bribable in the first place). This one instead cuts how much an ALREADY-corrupt staffer can
// siphon per incident -- see security.js's CORRUPTION_DIVERSION_AMOUNT/CHECKPOINT_DIVERSION_
// REDUCTION for the existing rate this is designed to stack with multiplicatively, same "stacks
// rather than replaces" precedent as cctv_improvement/recycling_throughput above.
export const CONTRABAND_SCREENING_NODE_ID = 'contraband_screening';
export const CONTRABAND_SCREENING_DIVERSION_REDUCTION = 0.35;

/** Diversion-amount multiplier from the Contraband Screening node, 1 (no reduction) if
 *  unresearched. NOT applied anywhere in this file -- see the CONTRABAND_SCREENING_NODE_ID doc
 *  comment above and this file's task notes for the exact one-line security.js hook (that file
 *  isn't owned by this pass). */
export function contrabandScreeningDiversionMult(state) {
  return isNodeUnlocked(state, CONTRABAND_SCREENING_NODE_ID) ? (1 - CONTRABAND_SCREENING_DIVERSION_REDUCTION) : 1;
}

/** @type {{id:string,name:string,cost:number,techLevel:number,desc:string,unlocks:string[],requires:string[],startsUnlocked?:boolean,costPerUse?:number,grantOnUnlock?:number}[]} */
export const RESEARCH_NODES = [
  // ---- always-available core (cost 0, unlocked from tick 0, shown for legibility) ----
  {
    id: 'settlement_basics', name: 'Settlement Basics', cost: 0, techLevel: 1, startsUnlocked: true,
    desc: 'Shelter and furnishing. Known from the day you arrived.',
    unlocks: ['wall', 'fence', 'door', 'bed', 'table'], requires: [],
  },
  {
    id: 'field_defense', name: 'Field Defense', cost: 0, techLevel: 1, startsUnlocked: true,
    desc: 'Improvised perimeter weapons. Known from the day you arrived.',
    unlocks: ['turret', 'trap'], requires: [],
  },
  {
    id: 'scrap_power', name: 'Scrap Power', cost: 0, techLevel: 1, startsUnlocked: true,
    desc: 'Dirty combustion generators and hand-run conduit. Known from the day you arrived.',
    unlocks: ['generator', 'wire'], requires: [],
  },

  // ---- gated tier 1 ----
  {
    id: 'perimeter_lighting', name: 'Perimeter Lighting', cost: 30, techLevel: 1,
    desc: 'Floodlights that hold back the dark and the things moving in it.',
    unlocks: ['floodlight'], requires: [],
  },
  {
    id: 'early_warning', name: 'Early Warning', cost: 45, techLevel: 1,
    desc: 'Elevated spotting posts. Raiders stop being a surprise.',
    unlocks: ['watchtower'], requires: [],
  },
  {
    id: 'plumbing', name: 'Plumbing', cost: 50, techLevel: 1,
    desc: 'Pumps and pipe runs -- a water grid to feed zones and processing.',
    unlocks: ['pump', 'pipe'], requires: [],
  },
  {
    id: 'motor_pool', name: 'Motor Pool', cost: 60, techLevel: 1,
    desc: 'Fossil-burning haul trucks. Cheap, filthy, and better than carrying it yourself.',
    unlocks: ['garage_recycling_fossil', 'garage_garbage_fossil', 'garage_recycling', 'garage_garbage'],
    requires: [],
  },
  {
    // Real Prison Architect gates its whole SheetMetal -> WorkshopSaw -> WorkshopPress ->
    // LicensePlate chain behind a single PrisonLabour-equivalent research node, not one node per
    // station -- mirrored here as one gate for the whole processing chain rather than splitting it.
    id: 'materials_processing', name: 'Materials Processing', cost: 55, techLevel: 1,
    desc: 'A staffed processing station -- raw scrap in, higher-value Components out.',
    unlocks: ['workshop'], requires: [],
  },
  {
    // Real PA anchor (needs.txt/production.txt materials pass): farming buildables carry real
    // Work-provider rates and feed the fertilizer/compost chain -- v1 here is deliberately just
    // the single production loop (one buildable, one citizen-tended cycle), not the full
    // multi-crop/fertilizer system that real data implies; see jobs.js's Farming job state.
    // Distinct from Harvesting: a resource NODE is a finite deposit that depletes, a Farm Plot is
    // a built, renewable producer a citizen returns to tend cycle after cycle.
    id: 'agronomy', name: 'Agronomy', cost: 55, techLevel: 1,
    desc: 'Tilled farm plots -- a citizen tending one produces a steady trickle of food/scrap, ' +
      'renewable rather than a depleting resource node.',
    unlocks: ['farm_plot'], requires: [],
  },

  // ---- Finance branch (item 2) ----
  // Real PA anchor (research.txt): BankLoans/ExtraGrant/LowerTaxes1->LowerTaxes2 -- the one real
  // branch that pays off directly in scrap rather than gating a buildable/multiplier on some OTHER
  // system, the way literally every node elsewhere in this tree does. Kept deliberately small:
  // this project has a documented history of balance regressions from economy-affecting additions,
  // so every number here is modest and, for the two grant nodes, applied through the EXISTING
  // 'grant' finance bucket (world.js's finance.grantScrap, already summed into the budget report's
  // total income alongside grants.js's Charter Contracts) -- see applyPendingUnlockGrants() near
  // tickResearch() below for exactly where/how `grantOnUnlock` actually pays out, and why it's
  // wired there instead of inside tryResearch(). Nothing here should read as an unexplained jump
  // in the scrap counter: both grants post through the same ledger category the budget report
  // already renders, and Lower Taxes' discount is a named, documented, permanent multiplier, not a
  // hidden one.
  {
    id: 'bank_loans', name: 'Bank Loans', cost: 40, techLevel: 1, grantOnUnlock: 18,
    desc: 'A line of credit against the settlement\'s future output -- the loan itself lands the '
      + 'moment the paperwork clears: +18 scrap, once.',
    unlocks: [], requires: [],
  },
  {
    id: 'extra_grant', name: 'Emergency Grant', cost: 70, techLevel: 1, grantOnUnlock: 30,
    desc: 'A one-time relief grant, no strings attached: +30 scrap the moment it\'s approved.',
    unlocks: [], requires: [],
  },
  {
    id: LOWER_TAXES_NODE_ID, name: 'Lower Taxes', cost: 90, techLevel: 2,
    desc: `Standing exemptions that shave ${Math.round(LOWER_TAXES_DISCOUNT * 100)}% off every `
      + 'future build\'s scrap cost, permanently -- stacks with an active trader voucher or '
      + 'Coverage Plan discount the same way those already stack with each other.',
    unlocks: [], requires: ['bank_loans'],
  },

  // ---- gated tier 2 ----
  {
    id: 'small_arms_doctrine', name: 'Small Arms Doctrine', cost: 70, techLevel: 2, costPerUse: 4,
    // costPerUse (item 1): real PA anchor -- Tazers/BodyArmour/TazersForEveryone each carry both a
    // one-time unlock Cost AND a CostPerUse charged every time the resulting item is actually
    // used. This node's repeatable "use" is an Armory (re)issuing a weapon tier to a staffer --
    // see security.js's tickArmoryIssuance (the `roster.equip(citizenId, ...)` calls). NOT wired
    // to that call site from this file -- see payPerUseCost()'s doc comment below for why, and the
    // exact one-line hook tickArmoryIssuance would need.
    desc: 'An armory: standardised weapons issued to the duty roster instead of whatever they '
      + 'found. Re-arming a staffer from the armory\'s stock costs a little scrap each time.',
    unlocks: ['armory'], requires: ['field_defense'],
  },
  {
    id: 'staff_vetting', name: 'Staff Vetting', cost: 65, techLevel: 2, costPerUse: 3,
    desc: 'Background checks before someone joins the duty roster. Doesn\'t stop a bribe outright, ' +
      'but cuts down how often someone slips through corruptible in the first place. Running a ' +
      'background check costs a little scrap per hire.',
    // Unlocks nothing buildable -- purely read by security.js's staff-corruption system, which
    // lowers the fraction of newly-assigned Guard/Sniper/Monitor staff flagged as bribable once
    // this is researched (see security.js's CORRUPTION_VETTED_RATIO). costPerUse (item 1): the
    // repeatable "use" here is the one-time-per-hire evaluation roll itself (security.js's
    // tickStaffCorruption, the `roster._corruptEvaluated`/`_corruptEligible` loop) -- already
    // naturally guarded against double-charging by that same _corruptEvaluated one-shot set. NOT
    // wired to that call site from this file, see payPerUseCost()'s doc comment below.
    unlocks: [], requires: ['small_arms_doctrine'],
  },
  {
    id: CONTRABAND_SCREENING_NODE_ID, name: 'Contraband Screening', cost: 150, techLevel: 2, costPerUse: 5,
    desc: 'Search procedures for anything moving through the settlement -- cuts how much an '
      + `already-corrupt staffer can quietly siphon per incident by ${Math.round(CONTRABAND_SCREENING_DIVERSION_REDUCTION * 100)}%, `
      + 'stacking with a physical Checkpoint\'s own reduction. Running a search costs a little scrap of its own.',
    // Unlocks nothing buildable -- see CONTRABAND_SCREENING_NODE_ID/contrabandScreeningDiversionMult()
    // above for the settlement-wide diversion-rate reduction this is meant to drive, and the exact
    // security.js hook (not wired from this file, that module isn't owned by this pass).
    unlocks: [], requires: ['staff_vetting'],
  },
  {
    id: 'surveillance', name: 'Surveillance', cost: 80, techLevel: 2,
    desc: 'CCTV cameras and a monitor station to man them.',
    unlocks: ['camera', 'monitor_station'], requires: ['early_warning'],
  },
  {
    // Real PA anchor: CCTVImprovement, cost 1000/time 180. Scaled against this tree's
    // established 30-700 range and priced relative to its prereq (surveillance, 80) the same way
    // the real file prices it as a follow-up upgrade to the base CCTV research, not a fresh
    // unlock -- unlocks nothing buildable, purely read by world.js's wave-warning-window calc
    // (CCTV_IMPROVEMENT_RESEARCH_MULT there), a real +35% boost to both the unmanned-camera and
    // staffed-monitor early-warning windows.
    id: 'cctv_improvement', name: 'CCTV Improvement', cost: 50, techLevel: 2,
    desc: 'Better lenses and signal routing for the CCTV network -- cameras and the monitor '
      + 'station both see meaningfully further ahead of a wave.',
    unlocks: [], requires: ['surveillance'],
  },
  {
    id: 'refined_fuels', name: 'Refined Fuels', cost: 90, techLevel: 2,
    desc: 'Gas and ethanol drivetrains -- faster hauls, or cleaner ones.',
    unlocks: [
      'garage_recycling_gas', 'garage_garbage_gas',
      'garage_recycling_ethanol', 'garage_garbage_ethanol',
    ],
    requires: ['motor_pool'],
  },
  {
    id: 'waste_reclamation', name: 'Waste Reclamation', cost: 110, techLevel: 2,
    desc: 'A recycling center that eats pollution and pays it back as scrap.',
    unlocks: ['recycling_center'], requires: ['plumbing'],
  },
  {
    // Real PA anchor: RecyclingIncentive, cost 2500/time 720 -- roughly 2.5x CCTVImprovement's
    // real cost and 4x its real time, mirrored here as a proportionally pricier follow-up than
    // cctv_improvement (50) above. Unlocks nothing buildable -- purely read by world.js's
    // pollution-tick recycling-capacity calc (RECYCLING_THROUGHPUT_RESEARCH_MULT there), a real
    // +40% multiplier on every Recycling Center's per-tick processing capacity, stacking with the
    // existing water-grid bonus rather than replacing it.
    id: 'recycling_throughput', name: 'Recycling Throughput', cost: 125, techLevel: 2,
    desc: 'Sorting-line incentives and tuning for the Recycling Center -- meaningfully more '
      + 'pollution processed into scrap per tick, on every center you\'ve already built.',
    unlocks: [], requires: ['waste_reclamation'],
  },
  {
    id: 'alternative_power', name: 'Alternative Power', cost: 85, techLevel: 2,
    desc: 'Coal, wind, and solar generators -- each a real siting/cost tradeoff against the plain combustion generator, not a strict upgrade.',
    unlocks: ['generator_coal', 'generator_wind', 'generator_solar'], requires: ['scrap_power'],
  },

  // ---- gated tier 3 ----
  {
    id: 'high_voltage', name: 'High-Voltage Defense', cost: 130, techLevel: 3,
    desc: 'Tesla coils. Arc discharge across anything that gets close.',
    unlocks: ['tesla'], requires: ['perimeter_lighting', 'scrap_power'],
  },
  {
    id: 'electric_drivetrain', name: 'Electric Drivetrain', cost: 140, techLevel: 3,
    desc: 'Battery haul trucks. Zero-emission, but they want a powered garage.',
    unlocks: ['garage_recycling_electric', 'garage_garbage_electric'], requires: ['refined_fuels', 'high_voltage'],
  },
  {
    // Doubles as this tree's research-speed META node (see META_RESEARCH_SPEED_NODE_ID's doc
    // comment below, near tickResearch): its own flavor text already frames fission as
    // *theoretical* work ("worked out", reactor itself still a step further out at
    // reactor_engineering) rather than a physical unlock, so it's the one existing node in the
    // tree that can plausibly carry a settlement-wide research-methodology payoff without
    // reskinning something combat/utility-flavored (Tesla coils, trucks) into a knowledge node.
    // Picked over the tier-4 capstone deliberately: reactor_engineering is the LAST node in the
    // tree, so a speed bonus attached there would have no future research left to accelerate;
    // fission still has reactor_engineering's full 700-point cost ahead of it, so the boost has
    // real runway to matter.
    id: 'fission', name: 'Nuclear Fission', cost: 200, techLevel: 3,
    desc: 'Reactor theory and the shielded containment it demands, worked out and buildable -- '
      + 'the reactor itself is still a step further out. The methodology also sharpens every '
      + `research project after it: +${Math.round((META_RESEARCH_SPEED_MULT - 1) * 100)}% research speed, permanently.`,
    unlocks: ['waste_storage'], requires: ['high_voltage', 'waste_reclamation'],
  },

  // ---- gated tier 4 (true capstone) ----
  // The tree's one deliberate cost outlier: ~23x the cheapest gated node (perimeter_lighting,
  // 30), echoing the real ~20-100x cheapest->capstone spreads Prison Architect's and RimWorld's
  // actual research trees show (see research.txt/research_dlc.txt) -- this project's tree is far
  // shorter than either, so the ratio is scaled down, but there was previously no genuine
  // capstone tier at all (fission at 200 was only ~6.6x the cheapest node). Deepens the chain
  // rather than widening it: both prereqs are themselves tier-3 nodes, so reaching this requires
  // the full high_voltage -> {fission, electric_drivetrain} convergence, not just two cheap
  // tier-1 picks. The reactor itself (generator_nuclear) -- previously the cheapest-priced
  // "endgame" unlock in the tree at fission's 200 -- moves here instead of staying at fission, so
  // the single most powerful generator in the game is now genuinely the most expensive thing to
  // reach, not a side effect of one mid-tree node.
  {
    id: 'reactor_engineering', name: 'Reactor Engineering', cost: 700, techLevel: 4,
    desc: 'Turning fission theory into a working reactor. Power output that dwarfs every other '
      + 'generator in the settlement -- assuming the containment and the grid around it can '
      + 'actually take the load.',
    unlocks: ['generator_nuclear'], requires: ['fission', 'electric_drivetrain'],
  },
];

export const RESEARCH_BY_ID = Object.fromEntries(RESEARCH_NODES.map(n => [n.id, n]));

// tool kind -> node that unlocks it. Any tool NOT in this map (zones, Select, and anything a
// future agent adds without touching this file) is ungated by default -- fail-open, so a new
// buildable never becomes silently unplaceable just because nobody remembered research.js.
export const RESEARCH_GATE_BY_TOOL = (() => {
  const m = {};
  for (const n of RESEARCH_NODES) for (const t of n.unlocks) m[t] = n.id;
  return m;
})();

export function createResearchState() {
  const unlocked = {};
  for (const n of RESEARCH_NODES) if (n.startsUnlocked) unlocked[n.id] = true;
  // _grantsPaid: nodeId -> true once its grantOnUnlock (Finance branch, see RESEARCH_NODES above)
  // has actually been paid out -- see applyPendingUnlockGrants() near tickResearch() below. Tracked
  // separately from `unlocked` so a node can be unlocked (a permanent fact) independent of whether
  // its one-time cash payout has been applied yet (a one-tick-later fact) without conflating the two.
  return { points: 0, unlocked, _grantsPaid: {} };
}

export function isNodeUnlocked(state, nodeId) {
  return !!(state && state.unlocked && state.unlocked[nodeId]);
}

// Display names for colonyTechLevel()'s 1-4 integer tiers, for any future UI that wants to show
// "Tech Level: Established" rather than a bare number. Index 0 is unused/never returned (tier is
// always >= 1) so the array can be indexed directly by the tier number.
export const TECH_LEVEL_NAMES = ['', 'Foothold', 'Established', 'Industrial', 'Reactor Age'];

/** The colony's aggregate tech level: the highest `techLevel` among unlocked nodes, defaulting to
 *  1 (a brand-new colony already knows the free tier-1 core, so it's never below the floor).
 *  Aggregate-max rather than e.g. average or a full-tier-cleared rule, mirroring how RimWorld's
 *  own colony techLevel is really just "the most advanced thing this colony has demonstrated it
 *  can do" -- a single tier-4 unlock should count even if half of tier 2 was skipped entirely
 *  (this tree's DAG allows that: e.g. reaching high_voltage doesn't require staff_vetting).
 *  Accepts any iterable of unlocked node ids (an array, a Set, or Object.keys(state.unlocked)) so
 *  callers don't need to hand it a full research state -- see colonyTechLevelFromState() below
 *  for the convenience wrapper that does. */
export function colonyTechLevel(unlockedNodeIds) {
  const ids = unlockedNodeIds instanceof Set ? unlockedNodeIds : new Set(unlockedNodeIds || []);
  let maxTier = 1;
  for (const n of RESEARCH_NODES) {
    if (n.techLevel > maxTier && ids.has(n.id)) maxTier = n.techLevel;
  }
  return maxTier;
}

/** Convenience wrapper: colonyTechLevel() straight off a research state object (state.unlocked is
 *  a {nodeId: true} map, not an array/Set -- this is the shape createResearchState()/tickResearch
 *  actually produce and what world.research holds). Fail-open to tier 1 if state is missing or
 *  malformed, same fail-open spirit as isToolUnlocked() above. */
export function colonyTechLevelFromState(state) {
  if (!state || !state.unlocked) return 1;
  return colonyTechLevel(Object.keys(state.unlocked).filter(id => state.unlocked[id]));
}

/** Whether the colony's aggregate tech level meets some late-game content's required tier -- a
 *  thin readability wrapper other systems (e.g. quests.js) can gate on without importing
 *  colonyTechLevelFromState + writing the >= themselves at every call site. */
export function meetsTechLevel(state, requiredTier) {
  return colonyTechLevelFromState(state) >= requiredTier;
}

/** Whether `state` currently grants the fission meta-node's research-speed bonus -- see
 *  META_RESEARCH_SPEED_NODE_ID/META_RESEARCH_SPEED_MULT above and tickResearch() below. Exported
 *  so anything that wants to show "research is boosted" in a UI doesn't need to know the specific
 *  node id backing the effect. */
export function researchSpeedMultiplier(state) {
  return isNodeUnlocked(state, META_RESEARCH_SPEED_NODE_ID) ? META_RESEARCH_SPEED_MULT : 1;
}

/** The gating node for a build tool, or null if the tool is ungated. */
export function researchNodeForTool(tool) {
  const id = RESEARCH_GATE_BY_TOOL[tool];
  return id ? RESEARCH_BY_ID[id] : null;
}

/** Fail-open: unknown/ungated tools are always placeable. */
export function isToolUnlocked(state, tool) {
  if (!tool) return true;
  const id = RESEARCH_GATE_BY_TOOL[tool];
  if (!id) return true;
  return isNodeUnlocked(state, id);
}

export function researchPrereqsMet(state, node) {
  return node.requires.every(r => isNodeUnlocked(state, r));
}

/** Why a node can't be researched right now, or null if it can. */
export function researchBlockedReason(state, node) {
  if (isNodeUnlocked(state, node.id)) return 'Already researched';
  if (!researchPrereqsMet(state, node)) {
    const missing = node.requires.filter(r => !isNodeUnlocked(state, r)).map(r => RESEARCH_BY_ID[r].name);
    return `Requires ${missing.join(' + ')}`;
  }
  if (state.points < node.cost) return `Needs ${Math.ceil(node.cost - state.points)} more points`;
  return null;
}

/** Spend points to unlock a node. Returns { ok, reason }. */
export function tryResearch(state, nodeId) {
  const node = RESEARCH_BY_ID[nodeId];
  if (!node) return { ok: false, reason: 'No such research' };
  const blocked = researchBlockedReason(state, node);
  if (blocked) return { ok: false, reason: blocked };
  state.points -= node.cost;
  state.unlocked[node.id] = true;
  return { ok: true, node };
}

/** Passive accrual. Called once per world tick from world.js's tick(). Once the fission meta-node
 *  is unlocked, every future tick's accrual is multiplied by META_RESEARCH_SPEED_MULT -- this only
 *  ever speeds up research banked AFTER fission unlocks (the check reads the state that was just
 *  updated by tryResearch(), so it can't retroactively help the player reach fission itself
 *  faster), matching the "future research only" meta-node semantics real RimWorld research
 *  benches/passions have. */
export function tickResearch(world) {
  let alive = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) alive++;
  world.research.points += alive * RESEARCH_PER_CITIZEN_TICK * researchSpeedMultiplier(world.research);
  applyPendingUnlockGrants(world);
}

// Finance branch's one-time cash-on-unlock nodes (bank_loans/extra_grant, `grantOnUnlock` field on
// RESEARCH_NODES) pay out here rather than inside tryResearch() itself: every existing call site
// (main.js's research panel) invokes tryResearch(world.research, id) with just the research STATE,
// not a full `world` reference, so tryResearch has no way to reach world.addScrap without a
// signature change that main.js's call sites (not owned by this pass) would also need updating for.
// Piggybacking on tickResearch() instead -- which already runs every tick with a real `world`, see
// world.js's tick() -- needs zero changes anywhere else: the very next tick after a grant node
// unlocks, this notices it's newly-unlocked-but-unpaid and pays it exactly once, tracked via
// state._grantsPaid so a save/reload (or ten thousand more ticks) can never re-pay it.
function applyPendingUnlockGrants(world) {
  const state = world.research;
  if (!state._grantsPaid) state._grantsPaid = {}; // defensive -- an old save deserialized before
                                                     // this field existed still gets one here
  for (const n of RESEARCH_NODES) {
    if (!n.grantOnUnlock) continue;
    if (!isNodeUnlocked(state, n.id) || state._grantsPaid[n.id]) continue;
    state._grantsPaid[n.id] = true; // mark first -- addScrap has no way to reenter this, but this
                                     // is the same "mark before the side effect" defensive order
                                     // the rest of this codebase uses for one-shot flags
    world.addScrap(n.grantOnUnlock, 'grant');
  }
}

/** Deducts a node's per-use cost (item 1: small_arms_doctrine/staff_vetting/contraband_screening's
 *  `costPerUse` fields above) from world.scrap, real PA's "unlock once, pay again every time you
 *  actually use it" pattern (research.txt: Tazers/BodyArmour/TazersForEveryone). Deliberately NOT
 *  called from anywhere in this file -- research.js owns the unlock gate and the cost NUMBER, not
 *  the systems that would actually trigger a "use" (armory re-issuance and the corruption-hire
 *  roll both live in security.js, which this pass doesn't own). See each costPerUse node's own doc
 *  comment above for its exact intended call site. Folds the deduction into world.finance.buildSpend
 *  (no dedicated per-use-cost bucket exists in world.js's finance ledger, and world.js isn't owned
 *  by this pass either) so it stays inside the existing totalExpense sum (world.js's tick()) and
 *  shows up in the budget report, rather than draining world.scrap invisibly.
 *  Returns { ok, paid }: ok is false (paid 0) if the node has no costPerUse, isn't researched yet,
 *  or the colony can't currently cover it -- the caller decides what "can't afford it" should mean
 *  for its own action (block the use outright, or let it through as a rare freebie); this helper
 *  only reports the affordability check, it never assumes an outcome. */
export function payPerUseCost(world, nodeId) {
  const node = RESEARCH_BY_ID[nodeId];
  if (!node || !node.costPerUse) return { ok: false, paid: 0 };
  if (!isNodeUnlocked(world.research, nodeId)) return { ok: false, paid: 0 };
  if (world.scrap < node.costPerUse) return { ok: false, paid: 0 };
  world.scrap -= node.costPerUse;
  if (world.finance) world.finance.buildSpend = (world.finance.buildSpend || 0) + node.costPerUse;
  return { ok: true, paid: node.costPerUse };
}

export function serializeResearch(state) {
  return {
    points: state.points,
    unlocked: Object.keys(state.unlocked).filter(k => state.unlocked[k]),
    grantsPaid: Object.keys(state._grantsPaid || {}).filter(k => state._grantsPaid[k]),
  };
}

export function deserializeResearch(json) {
  const state = createResearchState();
  if (!json) return state;
  state.points = json.points || 0;
  for (const id of json.unlocked || []) if (RESEARCH_BY_ID[id]) state.unlocked[id] = true;
  for (const id of json.grantsPaid || []) if (RESEARCH_BY_ID[id]) state._grantsPaid[id] = true;
  return state;
}
