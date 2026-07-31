// Cross-run meta-progression -- lifetime stats and achievements that survive every restart,
// game-over, and "Quit to Title", independent of any single settlement's save data.
//
// This is deliberately a FOURTH, independent localStorage key (META_KEY below), alongside
// main.js's SAVE_KEY / AUTOSAVE_KEY / SLOTS_KEY -- same reasoning as those three not sharing a
// key with each other (see main.js's header comments on each): wiping or overwriting a save must
// never touch lifetime totals, and finishing/losing a run must never touch save data. It is also
// independent of world.js's `world.finance` (a per-run budget ledger) and grading.js's live
// per-run Safety/Wellbeing/Sustainability/Cohesion score -- both of those die with the SimWorld on
// game-over/restart/quit-to-title; everything in this file is the opposite, it's what's left AFTER
// the SimWorld is gone.
//
// Two kinds of state:
//  - LIFETIME STATS: running totals that only ever grow, across every settlement ever played on
//    this browser (gamesPlayed, longestSurvivalTicks/Waves, mostCitizensAlive, lifetime kills,
//    lifetime scrap earned, the set of generator kinds ever built).
//  - ACHIEVEMENTS: a fixed list (see ACHIEVEMENTS below), each unlocked at most once and never
//    re-locked. `checked against real numbers in the game as of this writing -- see the doc
//    comment on each achievement below for where its threshold comes from (research.js's node
//    count, worldmap.js's region count, the five generator_* structure kinds, CitizenStore's
//    capacity).
//
// Hook points are event-driven, not polled every tick -- each check function below is called from
// an already-existing event/milestone site (world.js's wave-complete and game-over blocks,
// worldmap.js's region-owned flip, main.js's successful tryResearch(), jobs.js's taming
// completion, and main.js's onBuildComplete structure-finished hook), never from inside
// SimWorld.tick()'s main body itself.

const META_KEY = 'settlement-defense-meta';

// Five generator variants a colony can build (see research.js's 'scrap_power'/'alternative_power'/
// 'fission' nodes for where each unlocks) -- the full set as of this writing.
export const GENERATOR_KINDS = ['generator', 'generator_coal', 'generator_wind', 'generator_solar', 'generator_nuclear'];

/** @type {{id:string,name:string,desc:string}[]} */
export const ACHIEVEMENTS = [
  {
    id: 'survive_10k', name: 'Iron Grip',
    desc: 'Survive 10,000 ticks (~1000s at 1x speed) in a single settlement.',
  },
  {
    id: 'wave_20', name: 'Weathered the Storm',
    desc: 'Reach Wave 20 in a single settlement.',
  },
  {
    id: 'full_research', name: 'Master Engineers',
    // research.js's RESEARCH_NODES is 14 entries as of this writing (3 free "core" nodes shown
    // for legibility + 11 gated ones) -- "fully researched" means every one of them, not just the
    // gated tier, so the panel can legitimately say 100%.
    desc: 'Unlock every technology in the research tree.',
  },
  {
    id: 'conquest_3', name: 'Warlord',
    // worldmap.js's WorldMap is a fixed 4x4 = 16-region grid; 3 owned is an early-mid-campaign
    // milestone, not the whole map.
    desc: 'Control 3 regions on the Conquest Map.',
  },
  {
    id: 'conquest_all', name: 'One Wasteland, Under You',
    desc: 'Control all 16 regions on the Conquest Map.',
  },
  {
    id: 'tame_animal', name: 'Beast Tamer',
    desc: 'Successfully tame a wild animal.',
  },
  {
    id: 'all_generators', name: 'Power Broker',
    desc: 'Build every generator variant at least once, across any settlement (plain, coal, wind, solar, nuclear).',
  },
  {
    id: 'pop_30', name: 'Boomtown',
    desc: 'Have 30 citizens alive in one settlement at the same time.',
  },
  {
    id: 'games_10', name: 'Seasoned Settler',
    desc: 'Play 10 settlements to their end (game over or a fresh restart both count).',
  },
  {
    id: 'kills_100', name: 'Perimeter Held',
    desc: 'Kill 100 attackers, total, across every settlement.',
  },
  {
    id: 'scrap_5000', name: 'Scrap Baron',
    desc: 'Earn 5,000 scrap, total, across every settlement.',
  },
];
const ACHIEVEMENTS_BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));

function defaultMeta() {
  return {
    gamesPlayed: 0,
    longestSurvivalTicks: 0,
    longestSurvivalWaves: 0,
    mostCitizensAlive: 0,
    totalAttackersKilled: 0,
    totalScrapEarned: 0,
    builtGeneratorKinds: [], // lifetime set of GENERATOR_KINDS ever completed, any settlement
    achievements: {},        // id -> unix ms timestamp of unlock, absent/false = locked
  };
}

let meta = null;
// Set by main.js so an unlock can surface as a toast; left null so this module never assumes a
// UI exists (e.g. under a future headless/test harness).
let onUnlock = null;

export function setAchievementUnlockedCallback(fn) { onUnlock = fn; }

function _loadMeta() {
  if (meta) return meta;
  try {
    const raw = localStorage.getItem(META_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    meta = { ...defaultMeta(), ...(parsed || {}) };
    meta.achievements = { ...(parsed && parsed.achievements) };
    meta.builtGeneratorKinds = Array.isArray(parsed && parsed.builtGeneratorKinds) ? parsed.builtGeneratorKinds : [];
  } catch (err) {
    console.error('[MetaProgress] Lifetime stats corrupt, resetting:', err);
    meta = defaultMeta();
  }
  return meta;
}

function _persistMeta() {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch (err) {
    console.error('[MetaProgress] Failed to write lifetime stats (storage full?):', err);
  }
}

/** Read-only snapshot for the Statistics/Achievements panel. Always the live object -- callers
 *  must not mutate it directly, everything here goes through the functions below. */
export function getMeta() { return _loadMeta(); }

export function isAchievementUnlocked(id) { return !!_loadMeta().achievements[id]; }

function _unlockAchievement(id) {
  const m = _loadMeta();
  if (m.achievements[id]) return false; // never re-locked, never double-fires the toast
  if (!ACHIEVEMENTS_BY_ID[id]) return false;
  m.achievements[id] = Date.now();
  _persistMeta();
  onUnlock?.(ACHIEVEMENTS_BY_ID[id]);
  return true;
}

// ---------------------------------------------------------------- event-driven check functions
// Each of these is called from exactly the existing milestone/event site named in its comment --
// never from inside the tick loop's main body -- so an achievement is only ever evaluated at the
// moment something relevant actually happened.

/** world.js, the wave-complete milestone site (this.waveSpawner.waveNumber just incremented). */
export function checkWaveAchievements(world) {
  if (world.currentTick >= 10000) _unlockAchievement('survive_10k');
  if (world.waveSpawner.waveNumber >= 20) _unlockAchievement('wave_20');
}

/** main.js, right after tryResearch() returns { ok: true } for a node. Takes the research state
 *  directly (not the whole world) so main.js's research-panel handler doesn't need an extra import. */
export function checkResearchAchievements(researchState, researchNodes) {
  if (researchNodes.every(n => !!researchState.unlocked[n.id])) _unlockAchievement('full_research');
}

/** worldmap.js, the instant a region's control meter hits 100 and r.owned flips true. */
export function checkConquestAchievements(worldMap) {
  const owned = worldMap.ownedCount();
  if (owned >= 3) _unlockAchievement('conquest_3');
  if (owned >= worldMap.regions.length) _unlockAchievement('conquest_all');
}

/** jobs.js, the instant a Taming job actually succeeds (animal moves from wildAnimals into dogs). */
export function checkTameAchievement() {
  _unlockAchievement('tame_animal');
}

/** main.js's onBuildComplete hook (world.js fires this once per structure, the tick
 *  underConstruction flips false). Lifetime-cumulative: the five generator kinds don't all have
 *  to exist in the same settlement at once, just each be built at least once, ever. */
export function noteStructureBuilt(kind) {
  if (!GENERATOR_KINDS.includes(kind)) return;
  const m = _loadMeta();
  if (!m.builtGeneratorKinds.includes(kind)) {
    m.builtGeneratorKinds.push(kind);
    _persistMeta();
  }
  if (GENERATOR_KINDS.every(k => m.builtGeneratorKinds.includes(k))) _unlockAchievement('all_generators');
}

/** world.js, called only when this run's peak alive-citizen count actually increases (guarded by
 *  the caller so this never fires on the common case of population holding steady or shrinking). */
export function checkPopulationAchievement(peakAliveCitizens) {
  const m = _loadMeta();
  if (peakAliveCitizens > m.mostCitizensAlive) {
    m.mostCitizensAlive = peakAliveCitizens;
    _persistMeta();
  }
  if (peakAliveCitizens >= 30) _unlockAchievement('pop_30');
}

/** world.js, the instant world.gameOver flips true (the settlement has fallen). Rolls this run's
 *  final numbers into the lifetime totals. Deliberately NOT called on a quit-to-title or a
 *  mid-run restart -- see recordAbandonedGame() below for that path -- so "games played" only
 *  counts runs that actually concluded one way or another, matching the games_10 achievement's
 *  "play 10 settlements to their end" wording. */
export function recordGameEnd(world) {
  const m = _loadMeta();
  m.gamesPlayed++;
  if (world.currentTick > m.longestSurvivalTicks) m.longestSurvivalTicks = world.currentTick;
  if (world.waveSpawner.waveNumber > m.longestSurvivalWaves) m.longestSurvivalWaves = world.waveSpawner.waveNumber;
  if (world.peakAliveCitizens > m.mostCitizensAlive) m.mostCitizensAlive = world.peakAliveCitizens;
  m.totalAttackersKilled += world.attackersKilled || 0;
  m.totalScrapEarned += world.scrapEarnedThisRun || 0;
  _persistMeta();
  if (m.gamesPlayed >= 10) _unlockAchievement('games_10');
  if (m.totalAttackersKilled >= 100) _unlockAchievement('kills_100');
  if (m.totalScrapEarned >= 5000) _unlockAchievement('scrap_5000');
}

/** main.js's confirmRestart()/quit-to-title/"New" path -- a run abandoned mid-game (not a real
 *  game-over) still deserves to count toward games_10 and bank its partial numbers, otherwise a
 *  player who never lets a settlement die would never accumulate lifetime stats at all. Same
 *  bookkeeping as recordGameEnd, just triggered from a different call site and guarded against
 *  double-counting a settlement that already game-overed (main.js only calls this for a world
 *  that's being discarded while still alive). */
export function recordGameAbandoned(world) {
  if (world.gameOver) return; // already counted via recordGameEnd
  recordGameEnd(world);
}
