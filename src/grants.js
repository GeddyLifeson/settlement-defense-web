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

export const CharterKind = Object.freeze({
  Bootstrap: 'bootstrap',
  TierOutpost: 'tier_outpost',
  TierWaystation: 'tier_waystation',
  TierDistrict: 'tier_district',
  TierRegion: 'tier_region',
  Bailout: 'bailout',
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
});

export const GRANT_ORDER = [CharterKind.Bootstrap, ...TIER_ORDER, CharterKind.Bailout];

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
