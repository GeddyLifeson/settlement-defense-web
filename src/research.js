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

// Passive trickle, per alive citizen per tick. Alive-citizen count is the readily-available
// existing signal (world.tick already computes it for the game-over check), and scaling by it
// gives research the right pressure: a colony that keeps people alive advances, a colony
// bleeding citizens stalls out. At the 24-citizen starting roster this is 0.06 points/tick, so
// the cheapest node lands ~500 ticks in and the whole tree is ~13k ticks of uninterrupted
// survival -- deliberately longer than a typical run, so choices in the tree actually matter.
export const RESEARCH_PER_CITIZEN_TICK = 0.0025;

/** @type {{id:string,name:string,cost:number,desc:string,unlocks:string[],requires:string[],startsUnlocked?:boolean}[]} */
export const RESEARCH_NODES = [
  // ---- always-available core (cost 0, unlocked from tick 0, shown for legibility) ----
  {
    id: 'settlement_basics', name: 'Settlement Basics', cost: 0, startsUnlocked: true,
    desc: 'Shelter and furnishing. Known from the day you arrived.',
    unlocks: ['wall', 'fence', 'door', 'bed', 'table'], requires: [],
  },
  {
    id: 'field_defense', name: 'Field Defense', cost: 0, startsUnlocked: true,
    desc: 'Improvised perimeter weapons. Known from the day you arrived.',
    unlocks: ['turret', 'trap'], requires: [],
  },
  {
    id: 'scrap_power', name: 'Scrap Power', cost: 0, startsUnlocked: true,
    desc: 'Dirty combustion generators and hand-run conduit. Known from the day you arrived.',
    unlocks: ['generator', 'wire'], requires: [],
  },

  // ---- gated tier 1 ----
  {
    id: 'perimeter_lighting', name: 'Perimeter Lighting', cost: 30,
    desc: 'Floodlights that hold back the dark and the things moving in it.',
    unlocks: ['floodlight'], requires: [],
  },
  {
    id: 'early_warning', name: 'Early Warning', cost: 45,
    desc: 'Elevated spotting posts. Raiders stop being a surprise.',
    unlocks: ['watchtower'], requires: [],
  },
  {
    id: 'plumbing', name: 'Plumbing', cost: 50,
    desc: 'Pumps and pipe runs -- a water grid to feed zones and processing.',
    unlocks: ['pump', 'pipe'], requires: [],
  },
  {
    id: 'motor_pool', name: 'Motor Pool', cost: 60,
    desc: 'Fossil-burning haul trucks. Cheap, filthy, and better than carrying it yourself.',
    unlocks: ['garage_recycling_fossil', 'garage_garbage_fossil', 'garage_recycling', 'garage_garbage'],
    requires: [],
  },
  {
    // Real Prison Architect gates its whole SheetMetal -> WorkshopSaw -> WorkshopPress ->
    // LicensePlate chain behind a single PrisonLabour-equivalent research node, not one node per
    // station -- mirrored here as one gate for the whole processing chain rather than splitting it.
    id: 'materials_processing', name: 'Materials Processing', cost: 55,
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
    id: 'agronomy', name: 'Agronomy', cost: 55,
    desc: 'Tilled farm plots -- a citizen tending one produces a steady trickle of food/scrap, ' +
      'renewable rather than a depleting resource node.',
    unlocks: ['farm_plot'], requires: [],
  },

  // ---- gated tier 2 ----
  {
    id: 'small_arms_doctrine', name: 'Small Arms Doctrine', cost: 70,
    desc: 'An armory: standardised weapons issued to the duty roster instead of whatever they found.',
    unlocks: ['armory'], requires: ['field_defense'],
  },
  {
    id: 'staff_vetting', name: 'Staff Vetting', cost: 65,
    desc: 'Background checks before someone joins the duty roster. Doesn\'t stop a bribe outright, ' +
      'but cuts down how often someone slips through corruptible in the first place.',
    // Unlocks nothing buildable -- purely read by security.js's staff-corruption system, which
    // lowers the fraction of newly-assigned Guard/Sniper/Monitor staff flagged as bribable once
    // this is researched (see security.js's CORRUPTION_VETTED_RATIO).
    unlocks: [], requires: ['small_arms_doctrine'],
  },
  {
    id: 'surveillance', name: 'Surveillance', cost: 80,
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
    id: 'cctv_improvement', name: 'CCTV Improvement', cost: 50,
    desc: 'Better lenses and signal routing for the CCTV network -- cameras and the monitor '
      + 'station both see meaningfully further ahead of a wave.',
    unlocks: [], requires: ['surveillance'],
  },
  {
    id: 'refined_fuels', name: 'Refined Fuels', cost: 90,
    desc: 'Gas and ethanol drivetrains -- faster hauls, or cleaner ones.',
    unlocks: [
      'garage_recycling_gas', 'garage_garbage_gas',
      'garage_recycling_ethanol', 'garage_garbage_ethanol',
    ],
    requires: ['motor_pool'],
  },
  {
    id: 'waste_reclamation', name: 'Waste Reclamation', cost: 110,
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
    id: 'recycling_throughput', name: 'Recycling Throughput', cost: 125,
    desc: 'Sorting-line incentives and tuning for the Recycling Center -- meaningfully more '
      + 'pollution processed into scrap per tick, on every center you\'ve already built.',
    unlocks: [], requires: ['waste_reclamation'],
  },
  {
    id: 'alternative_power', name: 'Alternative Power', cost: 85,
    desc: 'Coal, wind, and solar generators -- each a real siting/cost tradeoff against the plain combustion generator, not a strict upgrade.',
    unlocks: ['generator_coal', 'generator_wind', 'generator_solar'], requires: ['scrap_power'],
  },

  // ---- gated tier 3 ----
  {
    id: 'high_voltage', name: 'High-Voltage Defense', cost: 130,
    desc: 'Tesla coils. Arc discharge across anything that gets close.',
    unlocks: ['tesla'], requires: ['perimeter_lighting', 'scrap_power'],
  },
  {
    id: 'electric_drivetrain', name: 'Electric Drivetrain', cost: 140,
    desc: 'Battery haul trucks. Zero-emission, but they want a powered garage.',
    unlocks: ['garage_recycling_electric', 'garage_garbage_electric'], requires: ['refined_fuels', 'high_voltage'],
  },
  {
    id: 'fission', name: 'Nuclear Fission', cost: 200,
    desc: 'Reactor theory and the shielded containment it demands, worked out and buildable -- '
      + 'the reactor itself is still a step further out.',
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
    id: 'reactor_engineering', name: 'Reactor Engineering', cost: 700,
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
  return { points: 0, unlocked };
}

export function isNodeUnlocked(state, nodeId) {
  return !!(state && state.unlocked && state.unlocked[nodeId]);
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

/** Passive accrual. Called once per world tick from world.js's tick(). */
export function tickResearch(world) {
  let alive = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) alive++;
  world.research.points += alive * RESEARCH_PER_CITIZEN_TICK;
}

export function serializeResearch(state) {
  return { points: state.points, unlocked: Object.keys(state.unlocked).filter(k => state.unlocked[k]) };
}

export function deserializeResearch(json) {
  const state = createResearchState();
  if (!json) return state;
  state.points = json.points || 0;
  for (const id of json.unlocked || []) if (RESEARCH_BY_ID[id]) state.unlocked[id] = true;
  return state;
}
