// Ported from SD.Presentation/SimWorldHost.cs -- owns one SimWorld, steps it at a fixed
// 10 Hz tick rate independent of frame rate, and renders every frame.
import { SimWorld, STARTER_NAMES } from './world.js';
import { Renderer, ROLE_COLOR, CITIZEN_SKIN } from './render.js';
import { InputController, TOOLS } from './input.js';
import { topbarIconUri } from './assets.js';
import { isNight, ScheduleOverride, SCHEDULE_OVERRIDE_LABELS } from './schedule.js';
import { PASSION_ICON, randomBackstory, randomPassions } from './backstories.js';
import { randomTrait } from './traits.js';
import { worldMap, EXPANSION_FUEL_COST, MAX_TRAVEL_RANGE } from './worldmap.js';
import {
  playBuildComplete, playWaveAlert, playTurretFire, playKill, playCitizenDowned,
  playMoodBreak, playRandomEventCue,
  playUnrestTier1, playUnrestTier2, playUnrestTier3, playUnrestResolve,
  playProgramComplete, playFactionSatisfied, playFactionUnmet, playCorruptDiscovered,
  playRatTierChange, playSevereWeatherOnset,
  isMuted, toggleMute, getVolume, setVolume, getMasterGainValue,
} from './audio.js';
import { WeatherKind, tryWandererEvent, tryBlightEvent, tryResourceGiftEvent, tryTraderEvent, tryMassFireEvent, isHazardActive, hazardRefillMult, tickHazardCondition, HAZARD_EARLIEST_TICK, HAZARD_MIN_REFIRE_TICKS } from './weather.js';
import { WEAPON_TIERS, fireCorruptStaff, forceCorruptionRoll, forceActivateCorruption, CORRUPTION_FIRE_REWARD, K9_UPGRADE_SCRAP_COST } from './security.js';
import { forceHeldCitizenCrisis } from './siege.js';
import { buildCost } from './economy.js'; // vest purchase price display, see the inspector's Buy Vest button
import { canInspectDelivery, canSearchDelivery } from './supplies.js'; // tainted-delivery banner gating, see updateSupplyAlert below
import { AggressionPreset, makeRng, rngInt, StaffRoleKind } from './core.js';
import { STORYTELLERS } from './director.js';
import {
  RESEARCH_NODES, isNodeUnlocked, isToolUnlocked, researchBlockedReason, tryResearch,
  colonyTechLevelFromState, TECH_LEVEL_NAMES,
} from './research.js';
import {
  initOnboarding, maybeStartTutorial, startTutorial, stopTutorial, isTutorialActive,
  toggleHelp, isHelpOpen, hasSeenTutorial, resetTutorialSeen, TUTORIAL_SEEN_KEY, TUTORIAL_STEPS,
} from './tutorial.js';
import { WORK_CATEGORY_ORDER, WORK_CATEGORY_LABELS, WORK_CATEGORY_FIELD } from './jobs.js';
import { PROGRAM_DEFS, PROGRAM_ORDER, isSiteStaffed, assignProgramStaff } from './programs.js';
import {
  GRANT_DEFS, GRANT_ORDER, CharterKind, charterStatus, InvestmentTerm, startInvestment, resolveText,
  INVEST_COST, INVEST_SHORT_TICKS, INVEST_LONG_TICKS, INVEST_SHORT_PAYOUT, INVEST_LONG_PAYOUT,
} from './grants.js';
import { computeCitizenUnrestScore } from './citizens.js';
import { QuestKind, acceptQuest, declineQuest } from './quests.js';
import {
  COVERAGE_PLAN_DEFS, COVERAGE_PLAN_ORDER, isPlanActive, purchaseCoveragePlan,
  isCallInReady, callInLiveCount, triggerCallIn,
} from './coverageplans.js';
import { RANKS, rankOf, canRankUp, tryRankUp } from './ranks.js';
import { AUGMENTS, AUGMENT_SLOT_CAP, hasAugment, augmentCountFor, canBuyAugment } from './augments.js';
import {
  DRONE_CATEGORIES, DRONE_COST, DRONE_GESTATION_TICKS, droneCapacity, droneSlotsUsed,
  queueDroneFabrication,
} from './drones.js';
import { draftCitizen, undraftCitizen, isDrafted, OrderKind } from './draft.js';
import { CLIQUES, DEMAND_BASE_TARGET, DEMAND_ESCALATED_TARGET } from './factions.js';
import {
  roomContaining, impressivenessLabel, beautyLabel, cleanlinessLabel, ROOM_ROLE_LABEL,
} from './rooms.js';
import {
  ACHIEVEMENTS, getMeta, isAchievementUnlocked, setAchievementUnlockedCallback,
  checkResearchAchievements, checkWaveAchievements, checkConquestAchievements, checkTameAchievement,
  noteStructureBuilt, recordGameAbandoned,
} from './metaprogress.js';

const SECONDS_PER_TICK = 0.1;
const SAVE_KEY = 'settlement-defense-save';
// Autosave lives in its own localStorage key, deliberately separate from SAVE_KEY -- it must
// never silently clobber the player's manual save. (If a future multi-slot save scheme lands
// here, this should move into a reserved "autosave" slot in that scheme instead; as of this
// writing main.js has no SAVE_SLOTS/saveToSlot machinery, so a dedicated key is the simplest
// thing that can't collide with it.)
const AUTOSAVE_KEY = 'settlement-defense-autosave';
// ~2 minutes of real time at 1x speed (10 ticks/sec) -- roughly two wave cycles early game (see
// siege.js WaveSpawner: first wave at tick 300, subsequent gap 300-600 ticks), more once the
// speed multiplier is cranked up. Frequent enough that a crash/refresh rarely costs much, rare
// enough it isn't a meaningful perf/IO concern.
const AUTOSAVE_INTERVAL_TICKS = 1200;
// Multi-slot save scheme: one localStorage key holding a JSON array of SLOT_COUNT entries
// (each either null or { meta, data }), rather than one key per slot -- a single read/write
// keeps loadSlots()/persistSlots() atomic and trivial. Deliberately its own key, separate from
// both SAVE_KEY (the legacy single quick-save, still used by F5/F9/topbar Save-Load) and
// AUTOSAVE_KEY -- loadSlots() migrates a pre-existing SAVE_KEY save into slot 0 the first time
// it's touched (see loadSlots() below) so nothing from before this landed gets orphaned, but
// otherwise the three schemes don't read or write each other's keys.
const SLOTS_KEY = 'settlement-defense-save-slots';
const SLOT_COUNT = 5;
// Maps a WeatherKind string (weather.js) to a topbar glyph name (assets.js's TOPBAR_ICONS) --
// replaces the old emoji lookup table 1:1, same fallback-to-Clear behavior on an unrecognized key.
const WEATHER_ICON = { Clear: 'weatherClear', Rain: 'weatherRain', Cold: 'weatherCold', Heatwave: 'weatherHeatwave' };

// Static topbar stat icons (element id -> assets.js TOPBAR_ICONS name) that never change once
// set. Day/night and weather are handled separately in updateTopbar() below since their glyph
// swaps with live state; everything here is baked in once at boot by initTopbarIcons().
const STATIC_TOPBAR_ICONS = {
  'stat-scrap-icon': 'scrap',
  'stat-pollution-icon': 'pollution',
  'stat-population-icon': 'population',
  'stat-attackers-icon': 'attackers',
  'stat-wave-icon': 'wave',
  'stat-unrest-icon': 'unrest',
  'stat-grading-icon': 'grading',
  'stat-research-icon': 'research',
};

// Swaps an <span class="icon"> element's content for a real hand-drawn SVG <img> glyph (see
// assets.js's TOPBAR_ICONS / topbarIconUri) -- called once per icon at boot for the static set,
// and again on demand for the two state-driven icons (day/night, weather) whenever their state
// changes. Alt text carries the accessible label since the glyph itself has no text.
function setTopbarIcon(elId, iconName, alt) {
  const el = document.getElementById(elId);
  if (!el) return;
  let img = el.querySelector('img');
  if (!img) {
    img = document.createElement('img');
    img.className = 'icon-svg';
    el.appendChild(img);
  }
  const uri = topbarIconUri(iconName);
  if (img.src !== uri) img.src = uri;
  img.alt = alt || iconName;
}

function initTopbarIcons() {
  for (const [elId, iconName] of Object.entries(STATIC_TOPBAR_ICONS)) {
    setTopbarIcon(elId, iconName, iconName);
  }
}
initTopbarIcons();

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);
renderer.resize();
window.addEventListener('resize', () => renderer.resize());

// Wires SimWorld's presentation-audio callback hooks (see world.js's onXxx fields / audio.js's
// module doc comment) to the procedural sound cues. Must be re-run every time `world` is
// reassigned (restart/load/expandTo all construct a fresh SimWorld), since the hooks live on the
// instance, not anywhere global.
function attachAudioHooks(w) {
  w.onBuildComplete = (structure) => { playBuildComplete(); noteStructureBuilt(structure.kind); };
  w.onWaveIncoming = () => playWaveAlert();
  w.onTurretFire = () => playTurretFire();
  w.onKill = () => playKill();
  w.onCitizenDowned = () => playCitizenDowned();
  w.onCitizenOnBreak = () => playMoodBreak();
  // Weather changes + one-off random events (weather.js/factions.js/rats.js/security.js/jobs.js)
  // surface as a toast, same mechanism as every other player-visible notification in this file,
  // AND get discriminated by playRandomEventCue's text matching for the 6 new PA-catalog cues
  // (unrest x4/program/faction/corrupt/rats/severe-weather) that share this one hook.
  w.onRandomEvent = (text) => { showToast(text); playRandomEventCue(text); };
}

// LAZY BOOT: no SimWorld exists until the player starts or loads one from the title screen (see
// startGame/showTitleScreen below). `world` is null for the whole time the title screen is up, so
// every consumer of it -- frame(), the panel refreshers, the minimap click handler -- has to
// tolerate null. frame() early-returns, which covers the bulk of them.
let world = null;

// Remembered so restart()/the game-over "Start a New Settlement" button rebuild the settlement
// the player actually configured, rather than snapping back to a hardcoded 64x64 Calm map.
// Seeded with the historical defaults for the case where a save was loaded straight from title.
let lastNewGameConfig = { width: 64, height: 64, aggression: 'Calm', startingCitizens: 24, storyteller: 'Cassandra' };

let speedMultiplier = 1;
let toastTimer = 0;
const toastEl = document.getElementById('toast');

// Tick the current world was at for the last successful autosave -- compared against
// world.currentTick each frame to decide when the next one is due. Reset in startGame() so a
// freshly loaded/restarted world gets a full interval before its first autosave rather than
// firing immediately just because currentTick - 0 already exceeds the interval.
let lastAutosaveTick = 0;

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastTimer = 20; // frames, ~2s at 10Hz
}

// Quiet autosave tell -- deliberately NOT showToast (see #autosave-indicator's CSS comment in
// index.html): it fires every ~2 minutes of active play and a full-weight toast every time would
// be noise. Own element, own timer, same frame()-driven countdown pattern as toastTimer above.
let autosaveIndicatorTimer = 0;
const autosaveIndicatorEl = document.getElementById('autosave-indicator');
function showAutosaveIndicator() {
  autosaveIndicatorEl.textContent = 'Autosaved';
  autosaveIndicatorEl.classList.add('show');
  autosaveIndicatorTimer = 15; // frames, ~1.5s at 10Hz -- shorter/subtler than the toast's 2s
}

// ---------------------------------------------------------------- achievement unlock toast
// metaprogress.js's cross-run achievements (see that module's header comment) surface here the
// instant one unlocks (setAchievementUnlockedCallback below, called from checkXxxAchievements/
// recordGameEnd, all of which run at an event/milestone site, never every tick). Deliberately its
// own element/timer rather than routing through showToast()/toastEl -- an achievement unlock can
// land in the same frame as an ordinary toast (e.g. "Researched: X" and a research-tree-complete
// achievement firing together) and neither should clobber the other; a bit longer-lived and more
// celebratory than the plain toast, but still small and non-blocking per the task's "don't build
// something heavyweight" ask.
let achievementToastTimer = 0;
const achievementToastEl = document.getElementById('achievement-toast');
function showAchievementToast(ach) {
  achievementToastEl.innerHTML = `<span class="ach-icon">🏆</span><span><b>Achievement Unlocked</b><br>${ach.name}</span>`;
  achievementToastEl.classList.add('show');
  achievementToastTimer = 35; // frames, ~3.5s at 10Hz -- a bit longer than the plain toast's 2s
}
setAchievementUnlockedCallback(showAchievementToast);

const input = new InputController(canvas, renderer, () => world, (s) => { speedMultiplier = s; }, showToast);

window.__debug = {
  getWorld: () => world, input, renderer, worldMap,
  // ---- game lifecycle (see the "title screen / lifecycle" section below) ----
  // These are THE interface other menu/save work should hook into rather than reaching into
  // module state: startGame(w) hands any SimWorld off to gameplay, showTitleScreen() tears the
  // running game down and returns to the menu, and isInGame() distinguishes the two states.
  startGame: (w) => startGame(w),
  showTitleScreen: () => showTitleScreen(),
  isInGame: () => world != null,
  newGame: (opts) => beginSettlement(opts),
  // Customize Starting Colonists (see main.js's "customize starting colonists" section) -- exposed
  // for verification/testing the same way every other title-screen flow above is: showColonistSetup
  // rolls (or reuses) pendingRoster and shows the panel, getPendingRoster reads its live state,
  // rerollColonist re-rolls one slot the same way the panel's own button does.
  showColonistSetup: () => showColonistSetup(),
  hideColonistSetup: () => hideColonistSetup(),
  getPendingRoster: () => pendingRoster,
  rerollColonist: (i) => { pendingRoster[i] = rollColonistPreview(i); renderColonistGrid(); return pendingRoster[i]; },
  hasSave: () => hasSave(),
  save: () => save(),
  load: () => load(),
  restart: () => restart(),
  SAVE_KEY,
  // Generic confirm-before-destructive-action dialog (#confirm-dialog). Other UI work (e.g. a
  // pause menu's "Quit to title" button) should call this rather than building its own modal --
  // confirmAction(message, onConfirm) shows the shared dialog and only runs onConfirm if the
  // player clicks Confirm. confirmRestart/confirmedLoad are the two gates this file wires itself;
  // exposed too in case another agent wants the exact same wording/behaviour for New/Load.
  confirmAction: (message, onConfirm) => confirmAction(message, onConfirm),
  confirmRestart: () => confirmRestart(),
  confirmedLoad: () => confirmedLoad(),
  // Autosave (see the "autosave" section below): separate slot from the manual save above.
  hasAutosave: () => hasAutosave(),
  autosave: () => autosave(),
  loadAutosave: () => loadAutosave(),
  confirmedLoadAutosave: () => confirmedLoadAutosave(),
  AUTOSAVE_KEY,
  AUTOSAVE_INTERVAL_TICKS,
  // Multi-slot save/load (see the "save slots" section below) -- same console-verification
  // pattern as the rest of this object. listSlots() returns the raw [{meta,data}|null, ...]
  // array so a test script can read metadata without opening the panel.
  saveSlots: {
    SLOTS_KEY, SLOT_COUNT,
    list: () => loadSlots(),
    save: (idx) => saveToSlot(idx),
    load: (idx) => loadFromSlot(idx),
    delete: (idx) => deleteSlot(idx),
    toggle: (v) => toggleSaveLoad(v),
  },
  // File-backed backup (Download/Upload Save, #saveload panel) -- same console-verification
  // pattern as saveSlots above. downloadSave() triggers a real browser download when a game is
  // running. importSaveJson(text)/importSaveFile(file) drive the exact same parse-validate-
  // deserialize-startGame path the Upload button's file picker uses, so a test script can exercise
  // it without a real file dialog (construct a File/Blob and pass it to importSaveFile).
  downloadSave: () => downloadSave(),
  importSaveJson: (text) => importSaveJson(text),
  importSaveFile: (file) => importSaveFile(file),
  isPlausibleSaveJson: (parsed) => isPlausibleSaveJson(parsed),
  // conquest-layer handles for console verification (see SESSION_HANDOFF.md's verification pattern)
  toggleWorldMap: (v) => toggleWorldMap(v),
  expandTo: (id) => expandTo(id),
  // Budget report overlay (world.js's finance ledger) -- same console-verification pattern as
  // toggleWorldMap above.
  toggleFinance: (v) => toggleFinance(v),
  // Research/tech-tree handles (research.js) -- same console-verification pattern.
  toggleResearch: (v) => toggleResearch(v),
  // Onboarding handles (tutorial.js) -- same console-verification pattern as the overlays above.
  // resetTutorialSeen() + newGame() is the "pretend I've never played" repro.
  tutorial: {
    SEEN_KEY: TUTORIAL_SEEN_KEY,
    steps: TUTORIAL_STEPS,
    start: () => startTutorial(),
    stop: (seen) => stopTutorial(seen),
    isActive: () => isTutorialActive(),
    hasSeen: () => hasSeenTutorial(),
    reset: () => resetTutorialSeen(),
  },
  toggleHelp: (v) => toggleHelp(v),
  isHelpOpen: () => isHelpOpen(),
  research: () => world.research,
  researchNodes: RESEARCH_NODES,
  isToolUnlocked: (tool) => isToolUnlocked(world.research, tool),
  doResearch: (id) => tryResearch(world.research, id),
  audio: {
    isMuted, toggleMute, getVolume, setVolume, getMasterGainValue,
    playBuildComplete, playTurretFire, playKill, playWaveAlert, playCitizenDowned,
    // PA-catalog cues added this pass (see audio.js) -- exposed here for the same soak-test-time
    // manual-trigger convenience the original 5 cues already have.
    playUnrestTier1, playUnrestTier2, playUnrestTier3, playUnrestResolve, playMoodBreak,
    playProgramComplete, playFactionSatisfied, playFactionUnmet, playCorruptDiscovered,
    playRatTierChange, playSevereWeatherOnset, playRandomEventCue,
  },
  // Settings/Options panel (see the "settings" section below) -- reachable from the title screen's
  // main menu and, in-game, from the pause menu's Settings button (that button was built by a
  // concurrent agent looking for exactly this openSettings/toggleSettings hook name). Also exposes
  // the live-mutation handles directly so a soak test can change/verify difficulty without going
  // through the DOM at all.
  openSettings: () => toggleSettings(true),
  toggleSettings: (v) => toggleSettings(v),
  setAggressionLive: (v) => setAggressionLive(v),
  setStorytellerLive: (v) => setStorytellerLive(v),
  setHighContrast: (v) => setHighContrast(v),
  isHighContrast: () => renderer.highContrast,
  setUiScale: (v) => setUiScale(v),
  // weather.js verification handles: force a weather state directly, or force-roll a one-off
  // event without waiting on its normal timer/odds.
  weather: {
    kinds: WeatherKind,
    force: (kind) => { world.weather = kind; },
    triggerWanderer: () => tryWandererEvent(world),
    triggerBlight: () => tryBlightEvent(world),
    triggerTrader: () => tryTraderEvent(world),
    triggerMassFire: () => tryMassFireEvent(world),
    // New this pass: resource-gift windfall (real RimWorld ResourcePodCrash) -- force-roll it
    // directly against world.resourceNodes without waiting on the normal event timer/odds.
    triggerResourceGift: () => tryResourceGiftEvent(world),
    // New this pass: toxic-fallout map-wide hazard (real ToxicFallout/VolcanicWinter-style rare,
    // late-game-gated, long-refire-gap condition -- see weather.js's tickHazardCondition header
    // comment). isActive/refillMult/tick expose the real gated state directly for console
    // verification (fast-forward world.currentTick + call tick() repeatedly to test the gates
    // without soaking out 10,000+ real ticks); EARLIEST_TICK/MIN_REFIRE_TICKS are the real
    // constants the gate itself checks, exposed so a test script doesn't have to hardcode them.
    hazard: {
      isActive: () => isHazardActive(world),
      refillMult: () => hazardRefillMult(world),
      ticksRemaining: () => world._hazardTicksRemaining,
      lastEndTick: () => world._hazardLastEndTick,
      EARLIEST_TICK: HAZARD_EARLIEST_TICK,
      MIN_REFIRE_TICKS: HAZARD_MIN_REFIRE_TICKS,
      tick: () => tickHazardCondition(world),
    },
  },
  // metaprogress.js cross-run stats/achievements -- console-verification pattern matching every
  // other feature above (toggle the panel directly, read the live lifetime numbers, and force a
  // check function without waiting on the real event so a soak test doesn't have to grind out
  // 10,000 real ticks/16 real regions/etc. to see an unlock).
  meta: {
    ACHIEVEMENTS,
    getMeta: () => getMeta(),
    isUnlocked: (id) => isAchievementUnlocked(id),
    toggleStats: (v) => toggleStats(v),
    // Force-fire a check without waiting on the real trigger -- e.g. set world.waveSpawner.waveNumber
    // then call checkWave() rather than soaking out 20 real waves.
    checkWave: () => checkWaveAchievements(world),
    checkResearch: () => checkResearchAchievements(world.research, RESEARCH_NODES),
    checkConquest: () => checkConquestAchievements(worldMap),
    checkTame: () => checkTameAchievement(),
  },
  // Corrupt/bribable staff (security.js) -- console-verification pattern matching every other
  // feature above. The real periodic roll only fires every ~24000 ticks (10 in-game days), far
  // too long for a manual soak test, so force* bypasses the wait without duplicating the logic.
  security: {
    CORRUPTION_FIRE_REWARD,
    isCorruptEligible: (id) => world.roster.isCorruptEligible(id),
    isCorruptActive: (id) => world.roster.isCorruptActive(id),
    isCorruptDiscovered: (id) => world.roster.isCorruptDiscovered(id),
    fire: (citizenId) => fireCorruptStaff(world, citizenId),
    forceRoll: () => forceCorruptionRoll(world),
    forceActivate: (citizenId) => forceActivateCorruption(world, citizenId),
    // Non-lethal takedown (WeaponTier.StunBaton) -- console-verification helpers so a soak test
    // doesn't have to wait on the real ~40% stun-chance roll or the 1-in-game-hour cooldown.
    K9_UPGRADE_SCRAP_COST,
    dogs: () => world.dogs,
    upgradeDog: (citizenId) => world.upgradeDog(citizenId),
    isStunnedAt: (attackerIdx) => world.attackers.isStunnedAt(attackerIdx),
    stunTicksRemaining: (attackerIdx) => world.attackers.stunTicksRemaining[attackerIdx],
    isTrainingGraduated: (citizenId) => world.roster.isTrainingGraduated(citizenId),
    programSites: () => world.programSites,
    assignProgramStaff: (siteIndex, citizenId) => assignProgramStaff(world, world.programSites[siteIndex], citizenId),
  },
  // Held-citizen crisis (siege.js) -- same console-verification pattern. force() bypasses the
  // unrest-tier/probability gates so a soak test doesn't have to grind out a genuine tier-3 unrest
  // crisis (which itself requires a sustained mood crash over hundreds of ticks) just to see it.
  crisis: {
    getEvent: () => world.heldCitizenEvent,
    force: () => forceHeldCitizenCrisis(world),
  },
  // Labor drones (drones.js) -- same console-verification pattern as every other feature above.
  // queue()/toggle() drive the exact same functions the Fabrication panel's buttons use, so a
  // soak test can fabricate a drone of a specific category without clicking through the UI.
  drones: {
    DRONE_CATEGORIES, DRONE_COST, DRONE_GESTATION_TICKS,
    capacity: () => droneCapacity(world.structures),
    used: () => droneSlotsUsed(world),
    queue: (category) => queueDroneFabrication(world, category),
    list: () => world.drones,
    fabricationQueue: () => world.droneFabricationQueue,
    toggle: (v) => toggleDronesPanel(v),
  },
};

// ---------------------------------------------------------------- toolbar (categorized, built once)
// Restructured from a single flat scrolling list (26+ items, hard to scan) into a two-level
// category -> item-list -> detail-before-commit UI -- the same information hierarchy live-observed
// in Super Energy Apocalypse: Recycled's build panel (category icon row, then that category's
// buildables, then a detail readout before placing). Only the STRUCTURE is adopted; every pixel
// here (colors, icons, layout classes) is this project's own -- see the CSS in index.html.
// Every hotkey binding in input.js's TOOLS/TOOL_KEYS is completely untouched by this rework: a
// keypress still calls input.setTool() directly, and syncToolbarHighlight() below just makes the
// two-level UI follow along so the right category/detail is visible after a hotkey press too.
const toolbarEl = document.getElementById('toolbar');

// Logical categories, inferred from economy.js's BUILD_COST grouping comments and each tool's own
// kind: Defense (blocks/damages attackers), Power & Water (the two mirrored utility grids),
// Economy & Vehicles (scrap/haul/production loop), Furniture (needs-refill objects), Security
// (early warning + armed-staff force multipliers), Zones (paint-only, no structure/cost).
const CATEGORY_ORDER = ['defense', 'power', 'economy', 'furniture', 'security', 'zones'];
const CATEGORY_LABEL = {
  defense: 'Defense', power: 'Power & Water', economy: 'Economy & Vehicles',
  furniture: 'Furniture', security: 'Security', zones: 'Zones',
};
// Plain unicode glyphs, same convention already used for #topbar's stat icons (🔩👥☠ etc.) --
// not artwork of any kind, just short original label glyphs for each category button.
const CATEGORY_ICON = {
  defense: '🛡', power: '⚡', economy: '🚚', furniture: '🛋', security: '👁', zones: '🧭',
};
const TOOL_CATEGORY = {
  wall: 'defense', turret: 'defense', fence: 'defense', trap: 'defense',
  floodlight: 'defense', tesla: 'defense', watchtower: 'defense', lightning_rod: 'defense',
  // Turret tiers + mortar + trap variety (siege.js's TURRET_TIERS/TRAP_KINDS) -- same defense
  // bucket as the buildables they're variants of.
  turret_mini: 'defense', turret_auto: 'defense', turret_sniper: 'defense', mortar: 'defense',
  trap_spike: 'defense', trap_explosive: 'defense',
  generator: 'power', generator_coal: 'power', generator_wind: 'power', generator_solar: 'power',
  generator_nuclear: 'power', waste_storage: 'power', wire: 'power', battery: 'power',
  power_switch: 'power', pump: 'power', pipe: 'power',
  power_exporter: 'power', // power.js's surplus-gated scrap trickle, same power-utility bucket as battery/power_switch
  garage_recycling_fossil: 'economy', garage_recycling_gas: 'economy',
  garage_recycling_ethanol: 'economy', garage_recycling_electric: 'economy',
  garage_garbage_fossil: 'economy', garage_garbage_gas: 'economy',
  garage_garbage_ethanol: 'economy', garage_garbage_electric: 'economy',
  recycling_center: 'economy', workshop: 'economy',
  fabrication_bay: 'economy', farm_plot: 'economy', restaurant: 'economy',
  bed: 'furniture', table: 'furniture', door: 'furniture',
  shelf: 'furniture', medical_bed: 'furniture', shrine: 'furniture', fitness_station: 'furniture',
  cinema: 'furniture', // group-broadcast entertainment fixture, same "Recreation-zone furniture" bucket as fitness_station
  shower: 'furniture', // Hygiene need's refill fixture, same needs-refill-furniture bucket as fitness_station
  camera: 'security', monitor_station: 'security', armory: 'security', rat_trap: 'security',
  stabilizer: 'security', // anomaly.js's counter-buildable, same "hazard-management, not combat" bucket as Rat Trap
  checkpoint: 'security', // security.js/factions.js's screening chokepoint, same corruption/unrest-management bucket
  'zone-food': 'zones', 'zone-bedroom': 'zones', 'zone-recreation': 'zones', 'zone-training': 'zones',
  'zone-storage': 'zones', 'zone-medical': 'zones', 'zone-command': 'zones', 'zone-gymnasium': 'zones',
  'restrict-area': 'zones', // paints a citizen's allowed area, same paint-gesture family as the zone tools
};
// One-line "Makes:"-style effect/description per buildable, written fresh in this project's own
// voice from each tool's real cost/effect in economy.js/BUILD_COST comments, siege.js, power.js,
// water.js, vehicles.js FUEL_TYPES -- not copied from any reference game's text.
const TOOL_BLURB = {
  wall: 'Blocks attacker movement and sight entirely. A citizen must walk over the blueprint and build it before it works.',
  turret: 'Automated gun; fires at any attacker in range. +50% damage and +25% range while powered.',
  fence: 'Soft barrier -- slows attackers crossing it instead of blocking them outright. Cheap perimeter filler.',
  trap: 'Hidden one-shot damage trap. No power needed, but it has to be re-armed after triggering.',
  floodlight: 'Soft barrier like Fence: slows attackers 35% inside its radius rather than stopping them.',
  tesla: 'Chains a shock to every attacker in range per activation -- crowd control, not a single-target upgrade.',
  watchtower: 'Extends early-warning lead time before a wave arrives (longer while powered).',
  lightning_rod: 'Deflects 85% of lightning strikes on anything nearby during a Lightning Storm, and halves the storm\'s movement-speed penalty in the same radius.',
  generator: 'Baseline power source. Feeds Wire to anything nearby that benefits from being powered.',
  generator_coal: 'Cheapest generator of the bunch, but pollutes more per tick than the plain model.',
  generator_wind: 'Zero pollution, but only counts as a power source when sited on open, unobstructed ground.',
  generator_solar: 'Zero pollution, but only counts as a power source under open sky -- not inside an enclosed room.',
  generator_nuclear: 'High-output wireless power radius, but accrues hazardous waste until a Waste Storage sits nearby.',
  waste_storage: 'Contains nuclear waste within its radius, keeping citizens and structures nearby safe from it.',
  wire: 'Near-free power conduit. Carries electricity from a generator to whatever is connected to the network.',
  battery: 'Stores and discharges power, buffering the grid against overload spikes.',
  power_switch: 'Manual breaker. Place a new one, or click an existing one with this tool to flip it on/off.',
  pump: 'Water source -- the root of the water grid, same role Generator plays for the power grid.',
  pipe: 'Near-free water conduit. Boosts Food/Recreation zone refill and the Recycling Center\'s throughput.',
  garage_recycling_fossil: 'Recycling truck garage, fossil fuel: cheapest to build, dirtiest per haul.',
  garage_recycling_gas: 'Recycling truck garage, gas fuel: balanced cost and pollution -- the default choice.',
  garage_recycling_ethanol: 'Recycling truck garage, ethanol fuel: clean, but temporarily dents Food zone refill after each haul.',
  garage_recycling_electric: 'Recycling truck garage, electric fuel: cleanest, but hauls crawl unless the garage itself is powered.',
  garage_garbage_fossil: 'Garbage truck garage, fossil fuel: cheapest to build, dirtiest per haul.',
  garage_garbage_gas: 'Garbage truck garage, gas fuel: balanced cost and pollution -- the default choice.',
  garage_garbage_ethanol: 'Garbage truck garage, ethanol fuel: clean, but temporarily dents Food zone refill after each haul.',
  garage_garbage_electric: 'Garbage truck garage, electric fuel: cleanest, but hauls crawl unless the garage itself is powered.',
  recycling_center: 'Passively trickles pollution into scrap over time. Complements the truck haul cycle, doesn\'t replace it.',
  workshop: 'Staffed processing station -- turns raw scrap into finished Components at a real 2x uplift.',
  bed: 'Lets a citizen sleep to refill Rest. Pair with a Bedroom Zone for the formal room-role bonus.',
  table: 'Lets citizens eat together, refilling Social and Rest. Pair with a Recreation/Dining zone for the room bonus.',
  door: 'Passable wall opening -- keeps a room enclosed for room-detection bonuses while still letting citizens through.',
  camera: 'Cheap, short-range early warning. Staff it with a Monitor Station for a much longer warning window.',
  monitor_station: 'Staffed CCTV hub -- roughly doubles the early-warning window versus an unmanned Camera.',
  armory: 'Auto-issues Rifle-tier weapons to every Guard/Sniper on the roster. A second Armory unlocks Heavy tier.',
  rat_trap: 'Catches rats before an infestation spreads. Does nothing against attackers -- vermin control only.',
  stabilizer: 'Passively decays the settlement\'s anomaly pressure meter. Does nothing against attackers -- hazard management only.',
  'zone-food': 'Marks ground for foraging/food production. Refills Hunger when a citizen visits.',
  'zone-bedroom': 'Marks ground as a bedroom area. Pair with a Bed on it for the formal room-role bonus.',
  'zone-recreation': 'Marks ground for recreation. Refills Social and Mood when a citizen visits.',
  'zone-training': 'Marks ground for the Skills Workshop program -- boosts skill-gain for citizens who use it.',
  'zone-storage': 'Marks ground as a Storage room. Pair with a Shelf for the formal room-role bonus.',
  'zone-medical': 'Marks ground as a Medical room. Pair with a Medical Bed for the formal room-role bonus.',
  'zone-command': 'Marks ground as a Command room. Requires an Armory and a Monitor Station together to validate.',
  'zone-gymnasium': 'Marks ground as a Gymnasium. Pair with a Fitness Station for the formal room-role bonus.',
  'restrict-area': 'Paints the allowed area for the currently-selected citizen -- their autonomous AI never leaves it, though a direct drafted order still can.',
  shelf: 'Storage room furniture. No mechanical effect on its own beyond validating the room role.',
  medical_bed: 'Medical room furniture -- doubles a downed citizen\'s recovery rate while they\'re tended inside a validated Medical room.',
  shrine: 'Pure beauty building -- raises a room\'s Beauty score, feeding the room-quality mood bonus.',
  fitness_station: 'Gymnasium room furniture. A citizen with low Exercise walks to and uses it to refill the need.',
  shower: 'Refills Hygiene when a citizen uses it -- but only works if connected to the water grid via Pump/Pipe. An unconnected Shower does nothing.',
  fabrication_bay: 'Unlocks capacity for labor drones -- tireless, needs-free workers locked to one work category each.',
  farm_plot: 'Staffed crop plot -- a tending citizen produces a steady scrap trickle each work cycle. Requires Agronomy research.',
  checkpoint: 'Screening chokepoint -- cuts a corrupt staffer\'s scrap diversion and reduces a rival clique\'s unmet-demand consequence, but only for whoever actually passes within its radius.',
  restaurant: 'Staffed retail counter -- once a citizen mans it, produces a steady scrap trickle from visitor traffic each service cycle. No raw material needed to start a cycle, and no research gate.',
  cinema: 'Group-broadcast entertainment. Every ~30s it airs a showing that refills Social for every citizen within a 10-tile radius at once -- no worker needed, no walking to a specific tile.',
  power_exporter: 'Sells genuine spare generator capacity on its segment for a slow scrap trickle. Never touches power real consumers need -- the trickle shrinks or stops the moment the surplus does.',
  turret_mini: 'Cheap, short-range gun. The affordable early pick -- less range and damage than a plain Turret, but costs less too.',
  turret_auto: 'Longer range and harder-hitting than a plain Turret, but cannot engage a target that gets inside its minimum range.',
  turret_sniper: 'Longest range, one heavy shot, slow reload -- and the most expensive ammo of any turret tier. The answer to armor at long range.',
  mortar: 'Indirect fire -- very long range, high damage, slow reload. Inaccurate: the shell scatters around its target rather than guaranteeing a hit.',
  trap_spike: 'Cheap melee deadfall. Equally (mediocre) effective against every attacker type -- no rock-paper-scissors matchup, just a cheap single-target hit.',
  trap_explosive: 'Costlier than a plain Trap, but its blast catches every attacker in a small radius, not just the one that triggered it.',
  demolish: 'Click an existing structure to remove it. An unfinished blueprint is cancelled outright; a finished structure refunds half its scrap cost.',
};

// ---- DOM scaffold (header + collapsible body: Select shortcut, category grid, item list, detail) ----
toolbarEl.innerHTML = `
  <div id="toolbar-head" title="Collapse/expand the build panel">
    <span class="tb-title">🔨 Build</span>
    <button id="toolbar-collapse-btn">&#9662;</button>
  </div>
  <div id="toolbar-body">
    <div id="toolbar-select-btn" class="tool-btn select-btn"><span><span class="key">[0]</span>Select</span></div>
    <div id="toolbar-demolish-btn" class="tool-btn demolish-btn"><span><span class="key">[X]</span>Demolish</span></div>
    <div id="toolbar-categories"></div>
    <div id="toolbar-items"></div>
    <div id="toolbar-detail"></div>
  </div>
`;
const toolbarBodyEl = document.getElementById('toolbar-body');
const toolbarCatsEl = document.getElementById('toolbar-categories');
const toolbarItemsEl = document.getElementById('toolbar-items');
const toolbarDetailEl = document.getElementById('toolbar-detail');

let tbCategory = null;   // currently-open category id, or null (category grid only)
let tbDetailTool = null; // currently-detailed tool string, or null (item list, not detail)

document.getElementById('toolbar-select-btn').addEventListener('click', () => {
  if (!world) return;
  input.setTool(null);
});

// Demolish (explicit project-owner ask): a dedicated always-visible top-level button, same
// treatment as Select above -- both are structure-INTERACTION tools rather than buildables, so
// neither fits (or needs) the category->items->detail hierarchy the rest of the palette uses.
// Still also a real TOOLS entry (input.js, key 'X') so it gets a working hotkey and shows up in
// the Keybindings reference panel automatically, same as every other tool.
document.getElementById('toolbar-demolish-btn').addEventListener('click', () => {
  if (!world) return;
  input.setTool('demolish');
});

document.getElementById('toolbar-collapse-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toolbarBodyEl.classList.toggle('hidden');
  document.getElementById('toolbar-collapse-btn').innerHTML =
    toolbarBodyEl.classList.contains('hidden') ? '&#9656;' : '&#9662;';
});
// Clicking anywhere on the header (not just the tiny arrow button) also toggles -- bigger, more
// discoverable hit target for the same collapse/expand action.
document.getElementById('toolbar-head').addEventListener('click', () => {
  document.getElementById('toolbar-collapse-btn').click();
});

for (const catId of CATEGORY_ORDER) {
  const b = document.createElement('div');
  b.className = 'tb-cat-btn';
  b.dataset.cat = catId;
  b.innerHTML = `<span class="tb-cat-icon">${CATEGORY_ICON[catId]}</span><span class="tb-cat-label">${CATEGORY_LABEL[catId]}</span>`;
  b.addEventListener('click', () => {
    tbCategory = catId;
    tbDetailTool = null;
    renderToolbarLower();
  });
  toolbarCatsEl.appendChild(b);
}

function renderToolbarLower() {
  // Detail view wins if a tool is selected; otherwise show the open category's item list;
  // otherwise (no category open) show neither -- just the category grid above.
  if (tbDetailTool) {
    toolbarItemsEl.classList.add('hidden');
    toolbarDetailEl.classList.remove('hidden');
    renderToolbarDetail();
  } else if (tbCategory) {
    toolbarDetailEl.classList.add('hidden');
    toolbarItemsEl.classList.remove('hidden');
    renderToolbarItems();
  } else {
    toolbarItemsEl.classList.add('hidden');
    toolbarDetailEl.classList.add('hidden');
  }
}

function renderToolbarItems() {
  toolbarItemsEl.innerHTML = '';
  const back = document.createElement('div');
  back.className = 'tb-items-back';
  back.textContent = '‹ Categories';
  back.addEventListener('click', () => { tbCategory = null; tbDetailTool = null; renderToolbarLower(); });
  toolbarItemsEl.appendChild(back);

  for (const t of TOOLS) {
    if (TOOL_CATEGORY[t.tool] !== tbCategory) continue;
    const btn = document.createElement('div');
    btn.className = 'tool-btn';
    btn.dataset.tool = t.tool ?? '';
    btn.innerHTML = `<span><span class="key">[${t.key}]</span>${t.label}</span>` +
      (t.cost != null ? `<span class="cost">$${t.cost}</span>` : '');
    // Research gate (research.js): clicking a locked tool doesn't select it at all -- it says why
    // and opens the Research panel, so the gate is discoverable rather than a dead button. The
    // authoritative gate is still input.js's _place(), this is just the UI mirroring it.
    btn.addEventListener('click', () => {
      if (!world) return; // toolbar is hidden pregame, but never trust that as the only guard
      if (!isToolUnlocked(world.research, t.tool)) {
        const node = researchNodeForToolLocal(t.tool);
        showToast(`Locked -- research "${node ? node.name : 'unknown'}" first`);
        toggleResearch(true);
        return;
      }
      input.setTool(t.tool);
      tbDetailTool = t.tool;
      renderToolbarLower();
    });
    toolbarItemsEl.appendChild(btn);
  }
}

function renderToolbarDetail() {
  const t = TOOLS.find(x => x.tool === tbDetailTool);
  if (!t) { toolbarDetailEl.innerHTML = ''; return; }
  const locked = world && !isToolUnlocked(world.research, t.tool);
  const costHtml = t.cost != null
    ? `<span class="tb-detail-cost"><span class="icon">🔩</span>${t.cost}</span>`
    : `<span class="tb-detail-cost tb-free">Free (paint-only)</span>`;
  toolbarDetailEl.innerHTML = `
    <div class="tb-detail-name">${t.label}</div>
    <div class="tb-detail-cost-row">${costHtml}</div>
    <div class="tb-detail-effect">${TOOL_BLURB[t.tool] || ''}</div>
    ${locked ? `<div class="tb-detail-locked">🔒 Research-locked -- see the Research panel.</div>` : ''}
    <button class="tb-detail-back">‹ Go Back</button>
  `;
  toolbarDetailEl.querySelector('.tb-detail-back').addEventListener('click', () => {
    tbDetailTool = null;
    renderToolbarLower();
  });
}

// Local lookup rather than importing researchNodeForTool -- main.js only ever needs it for the
// toast label above and this keeps the import list to the tree/state helpers.
function researchNodeForToolLocal(tool) {
  return RESEARCH_NODES.find(n => n.unlocks.includes(tool)) || null;
}

let tbLastSyncedTool; // undefined on purpose: forces one real sync pass on the very first frame
function syncToolbarHighlight() {
  document.getElementById('toolbar-select-btn')?.classList.toggle('active', input.tool === null);
  document.getElementById('toolbar-demolish-btn')?.classList.toggle('active', input.tool === 'demolish');

  // Follow a hotkey (or a New Game reset) that changed input.tool from outside this panel's own
  // clicks -- jump the category/item/detail view to match, so pressing a hotkey is just as
  // discoverable as clicking through the panel would have been. Every hotkey in input.js's
  // TOOL_KEYS keeps working identically either way; this only decides what the panel *shows*.
  if (input.tool !== tbLastSyncedTool) {
    tbLastSyncedTool = input.tool;
    if (input.tool) {
      tbCategory = TOOL_CATEGORY[input.tool] || tbCategory;
      tbDetailTool = input.tool;
    } else {
      tbDetailTool = null;
    }
    renderToolbarLower();
  }

  for (const b of toolbarCatsEl.children) {
    b.classList.toggle('active', b.dataset.cat === tbCategory);
  }
  for (const btn of toolbarItemsEl.children) {
    if (btn.dataset.tool === undefined) continue; // the "‹ Categories" back row
    const btnTool = btn.dataset.tool || null;
    btn.classList.toggle('active', btnTool === input.tool);
    btn.classList.toggle('locked', !isToolUnlocked(world?.research, btnTool));
  }
}

// ---------------------------------------------------------------- topbar controls
const pauseBtn = document.getElementById('btn-pause');
pauseBtn.addEventListener('click', () => { input.togglePause(); syncPauseMenu(); });
document.getElementById('btn-speed-down').addEventListener('click', () => input.setSpeedIndex(input.speedIndex - 1));
document.getElementById('btn-speed-up').addEventListener('click', () => input.setSpeedIndex(input.speedIndex + 1));
document.getElementById('btn-save').addEventListener('click', () => save());
document.getElementById('btn-load').addEventListener('click', () => confirmedLoad());
document.getElementById('btn-restart').addEventListener('click', () => confirmRestart());
document.getElementById('btn-restart-modal').addEventListener('click', () => restart());
document.getElementById('btn-recenter').addEventListener('click', () => input.recenter());

// Reports & Menus dropdown (index.html's #topbar-menu-dropdown -- see that file's comment on why
// this exists: the topbar was overflowing its own container once enough report panels existed,
// 2271px of buttons in a 1258px box with no visible scroll affordance). Every button inside the
// dropdown keeps its own original click listener (registered right below, unchanged) -- this only
// adds the open/close/outside-click/Escape behavior for the dropdown shell itself.
const topbarMenuBtn = document.getElementById('btn-topbar-menu');
const topbarMenuDropdown = document.getElementById('topbar-menu-dropdown');
function setTopbarMenuOpen(open) {
  topbarMenuDropdown.classList.toggle('hidden', !open);
  topbarMenuBtn.classList.toggle('active', open);
}
topbarMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setTopbarMenuOpen(topbarMenuDropdown.classList.contains('hidden'));
});
// Closing on any click inside the dropdown (after that button's own listener already ran) means
// picking "Research" both opens the Research panel AND closes this dropdown in one click, instead
// of leaving it hovering over the panel that just opened.
topbarMenuDropdown.addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') setTopbarMenuOpen(false);
});
document.addEventListener('click', (e) => {
  if (!topbarMenuDropdown.classList.contains('hidden') && !topbarMenuDropdown.contains(e.target) && e.target !== topbarMenuBtn) {
    setTopbarMenuOpen(false);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !topbarMenuDropdown.classList.contains('hidden')) setTopbarMenuOpen(false);
});

document.getElementById('btn-worldmap').addEventListener('click', () => toggleWorldMap());
document.getElementById('btn-worldmap-close').addEventListener('click', () => toggleWorldMap(false));
document.getElementById('btn-finance').addEventListener('click', () => toggleFinance());
document.getElementById('btn-finance-close').addEventListener('click', () => toggleFinance(false));
document.getElementById('btn-research').addEventListener('click', () => toggleResearch());
document.getElementById('btn-research-close').addEventListener('click', () => toggleResearch(false));
document.getElementById('btn-programs').addEventListener('click', () => toggleProgramsPanel());
document.getElementById('btn-programs-close').addEventListener('click', () => toggleProgramsPanel(false));
document.getElementById('btn-grants').addEventListener('click', () => toggleGrantsPanel());
document.getElementById('btn-grants-close').addEventListener('click', () => toggleGrantsPanel(false));
document.getElementById('btn-quests').addEventListener('click', () => toggleQuestsPanel());
document.getElementById('btn-quests-close').addEventListener('click', () => toggleQuestsPanel(false));
document.getElementById('btn-coverage').addEventListener('click', () => toggleCoveragePlansPanel());
document.getElementById('btn-coverage-close').addEventListener('click', () => toggleCoveragePlansPanel(false));
document.getElementById('btn-drones').addEventListener('click', () => toggleDronesPanel());
document.getElementById('btn-drones-close').addEventListener('click', () => toggleDronesPanel(false));
document.getElementById('btn-factions').addEventListener('click', () => toggleFactions());
document.getElementById('btn-factions-close').addEventListener('click', () => toggleFactions(false));

// ---------------------------------------------------------------- fullscreen toggle
// Wraps the Fullscreen API in try/catch and fails silently (toast instead of throw) -- some
// embedding contexts (iframes without allow="fullscreen", certain kiosk/webview setups) block it
// entirely or reject the returned promise, and that's not worth crashing the game over.
const fullscreenBtn = document.getElementById('btn-fullscreen');
function syncFullscreenButton() {
  fullscreenBtn.classList.toggle('active', document.fullscreenElement != null);
}
fullscreenBtn.addEventListener('click', () => {
  try {
    if (document.fullscreenElement) {
      const p = document.exitFullscreen();
      if (p && p.catch) p.catch(() => showToast('Fullscreen unavailable'));
    } else {
      const p = document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(() => showToast('Fullscreen unavailable'));
    }
  } catch {
    showToast('Fullscreen unavailable');
  }
});
document.addEventListener('fullscreenchange', syncFullscreenButton);

// ---------------------------------------------------------------- pause menu
// Primary, obvious UI for "paused" -- world.paused going true (topbar Pause button OR the Space
// hotkey, see input.js's togglePause()/​_onKey) used to be just a button-label change with no
// visual indicator otherwise. syncPauseMenu() is polled once per frame() below (~100ms, matches
// the Space-hotkey path which doesn't go through a callback) plus called immediately after the
// topbar button's own click for snappiness.
const pausemenuEl = document.getElementById('pausemenu');
function syncPauseMenu() {
  if (!world) { pausemenuEl.classList.add('hidden'); return; }
  pausemenuEl.classList.toggle('hidden', !world.paused);
}
document.getElementById('btn-pause-resume').addEventListener('click', () => {
  input.togglePause();
  syncPauseMenu();
});
// Opens the multi-slot Save/Load panel (see the "save slots" section further down) rather than
// firing a quick single-slot save() -- the pause menu is the one in-game entry point spacious
// enough for a full slot picker, so it gets the richer flow; F5/topbar Save still do the quick
// single-slot save for players who just want one keypress. toggleSaveLoad is defined later in
// this file (with the rest of the #saveload wiring) but hoists as a function declaration.
document.getElementById('btn-pause-save').addEventListener('click', () => {
  pausemenuEl.classList.add('hidden');
  toggleSaveLoad(true);
});
// Opens the Settings panel (see the "settings" section further down) on top of the pause menu --
// same layering as btn-pause-save opening #saveload, deliberately not hiding #pausemenu first
// since Resume is still one click away underneath. toggleSettings is defined later in this file
// (with the rest of the #settings wiring) but hoists as a function declaration.
document.getElementById('btn-pause-settings').addEventListener('click', () => {
  toggleSettings(true);
});
// Quit to title always discards the running (unsaved) colony, so it always confirms first --
// same shared #confirm-dialog every other destructive action (New, Load-over-running-game) uses.
// confirmAction is defined further down (with the rest of the confirm-dialog wiring) but hoists
// as a function declaration, so it's callable here.
document.getElementById('btn-pause-quit').addEventListener('click', () => {
  confirmAction('Return to title screen? Unsaved progress will be lost.', () => {
    pausemenuEl.classList.add('hidden');
    showTitleScreen();
  });
});

// ---------------------------------------------------------------- settlement grading popover
// Non-carceral reframe of Prison Architect's 4-axis Grading tab (world.grading, see grading.js);
// purely a read-only display -- clicking just toggles the popover, nothing here writes to world.
const gradingPopoverEl = document.getElementById('grading-popover');
document.getElementById('stat-grading-btn').addEventListener('click', () => {
  gradingPopoverEl.classList.toggle('hidden');
});

const muteBtn = document.getElementById('btn-mute');
function syncMuteButton() {
  muteBtn.textContent = isMuted() ? '🔇 Muted' : '🔊 Sound';
  muteBtn.classList.toggle('active', isMuted());
}
muteBtn.addEventListener('click', () => { toggleMute(); syncMuteButton(); });
syncMuteButton();

// ---------------------------------------------------------------- settings / options panel
// Reachable from BOTH the title screen's main menu (#btn-title-settings, no SimWorld yet) and,
// in-game, the pause menu's Settings button above -- so like #saveload/#credits it is deliberately
// left out of showTitleScreen()'s in-game-only overlay-cleanup loop and out of body.pregame's
// hide-list in index.html. Four independent concerns share this one panel:
//   Audio          -- audio.js's continuous volume level (persisted there, see setVolume()).
//   Difficulty     -- LIVE mutation of world.aggression/world.storyteller on the running SimWorld.
//                     director.js's directWaveSpawner(world) (called once per tick from
//                     world.js's tick()) reads both fields fresh every call rather than caching
//                     them at construction, so writing straight to the live world is enough --
//                     verified by reading world.js's tick() and director.js directly rather than
//                     assuming it. Meaningless without a running world, so this section explains
//                     that instead of showing controls when world is null.
//                     NOT persisted -- these describe a choice already baked into the current
//                     run's save data (world.aggression/world.storyteller both serialize), so
//                     nothing extra is needed for it to survive a reload.
//                     Deliberately does NOT touch lastNewGameConfig -- that drives what [R]/New
//                     builds NEXT, a mid-run live tweak shouldn't silently change future settings.
//   Accessibility  -- highContrast (renderer.js flag, drives shape/pattern cues in render.js's
//                     _drawHumanoid/_drawZones) and uiScale (CSS custom property scaling every
//                     modal .box, index.html). Both persisted to localStorage.
//   Keybindings    -- read-only reference built once from input.js's TOOLS table plus the other
//                     hotkeys documented across input.js/main.js; nothing here is rebindable.
const HIGHCONTRAST_KEY = 'settlement-defense-highcontrast';
const UISCALE_KEY = 'settlement-defense-uiscale';
const UISCALE_AUTO_KEY = 'settlement-defense-uiscale-auto'; // '1'/'0'; unset (null) defaults to auto ON

const settingsEl = document.getElementById('settings');
const settingsVolumeEl = document.getElementById('settings-volume');
const settingsVolumeValEl = document.getElementById('settings-volume-val');
const settingsAggressionEl = document.getElementById('settings-aggression');
const settingsStorytellerEl = document.getElementById('settings-storyteller');
const settingsDifficultyNoteEl = document.getElementById('settings-difficulty-note');
const settingsHighContrastEl = document.getElementById('settings-highcontrast');
const settingsUiScaleAutoEl = document.getElementById('settings-uiscale-auto');
const settingsTextSizeEl = document.getElementById('settings-textsize');
const settingsTextSizeValEl = document.getElementById('settings-textsize-val');
const settingsKeybindsEl = document.getElementById('settings-keybinds');

function toggleSettings(force) {
  const show = force != null ? force : settingsEl.classList.contains('hidden');
  settingsEl.classList.toggle('hidden', !show);
  if (show) renderSettings();
}

/** Rebuild everything settings-dependent. Cheap (a handful of DOM nodes, only while the panel is
 *  actually open) so a full rebuild on every open is simpler than trying to diff -- this never
 *  runs on a timer, only on open, so there's no "don't destroy a button mid-click" concern the
 *  other overlays' refresh functions have to worry about. */
function renderSettings() {
  // Audio
  settingsVolumeEl.value = String(Math.round(getVolume() * 100));
  settingsVolumeValEl.textContent = Math.round(getVolume() * 100) + '%';

  // Difficulty -- only meaningful with a live world; the dropdowns still render (so the panel
  // isn't empty/confusing from the title screen) but are disabled with an explanatory note.
  settingsAggressionEl.innerHTML = AGGRESSION_CARDS.map(([value, name]) =>
    `<option value="${value}">${name}</option>`).join('');
  settingsStorytellerEl.innerHTML = STORYTELLER_CARDS.map(([value, name]) =>
    `<option value="${value}">${name}</option>`).join('');
  settingsAggressionEl.disabled = !world;
  settingsStorytellerEl.disabled = !world;
  if (world) {
    settingsAggressionEl.value = world.aggression;
    settingsStorytellerEl.value = world.storyteller;
    settingsDifficultyNoteEl.textContent =
      'Changes apply immediately to the running settlement -- the next wave-timing decision reads the new values.';
  } else {
    settingsDifficultyNoteEl.textContent =
      'Start or load a settlement to change its aggression/storyteller live. (New-settlement defaults are chosen on the setup screen instead.)';
  }

  // Accessibility
  settingsHighContrastEl.checked = renderer.highContrast;
  settingsUiScaleAutoEl.checked = isUiScaleAuto();
  const scalePct = Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale') || '1') * 100);
  settingsTextSizeEl.value = String(scalePct);
  settingsTextSizeValEl.textContent = scalePct + '%';

  // Keybindings -- built once per open from input.js's TOOLS table (build tools) plus the other
  // hotkeys documented across input.js's _onKey and this file's own keydown handler. Grouped for
  // scanability rather than dumped as one long list; nothing here is invented, every entry below
  // corresponds to a real binding in input.js/main.js as of this writing.
  const buildRows = TOOLS.map(t => `<div class="key-row"><span>${t.label}</span><span class="k">${t.key === ' ' ? 'Space' : t.key}</span></div>`).join('');
  const groups = [
    ['Camera', [
      ['Pan', 'Right/Middle-drag'], ['Zoom', 'Scroll'], ['Recenter', 'Topbar button'],
    ]],
    ['Menus', [
      ['Pause / Resume', 'Space'], ['Speed down / up', '- / +'],
      ['Conquest Map', 'Shift+M'], ['Budget Report', 'Shift+B'], ['Research', 'Shift+T'],
      ['Cliques', 'Shift+F'], ['Programs', 'Shift+P'], ['Fabrication (Drones)', 'Shift+N'],
      ['Help Reference', 'F1 or ?'], ['Deselect tool / close Map-Research-Budget-Cliques-Programs', 'Escape'],
    ]],
    ['Save / Load', [
      ['Quick Save', 'F5'], ['Quick Load', 'F9'], ['New Settlement', 'R'],
    ]],
  ];
  settingsKeybindsEl.innerHTML =
    `<div class="key-group"><h4>Build Tools</h4>${buildRows}</div>` +
    groups.map(([label, rows]) =>
      `<div class="key-group"><h4>${label}</h4>${rows.map(([k, v]) => `<div class="key-row"><span>${k}</span><span class="k">${v}</span></div>`).join('')}</div>`
    ).join('');
}

document.getElementById('btn-settings-close').addEventListener('click', () => toggleSettings(false));
document.getElementById('btn-title-settings').addEventListener('click', () => toggleSettings(true));

settingsVolumeEl.addEventListener('input', () => {
  const pct = Number(settingsVolumeEl.value);
  settingsVolumeValEl.textContent = pct + '%';
  setVolume(pct / 100);
});

/** Live-mutate the running world's attacker-aggression preset. No-ops without a world (the
 *  dropdown is disabled in that state, but window.__debug.setAggressionLive can still be called
 *  directly for console verification, so it's guarded here too). */
function setAggressionLive(value) {
  if (!world) return false;
  world.aggression = value;
  return true;
}
/** Live-mutate the running world's storyteller. Same guard/reasoning as setAggressionLive. */
function setStorytellerLive(value) {
  if (!world || !STORYTELLERS[value]) return false;
  world.storyteller = value;
  return true;
}
settingsAggressionEl.addEventListener('change', () => setAggressionLive(settingsAggressionEl.value));
settingsStorytellerEl.addEventListener('change', () => setStorytellerLive(settingsStorytellerEl.value));

/** Toggle render.js's high-contrast accessibility cues (shape/pattern, not just hue -- see
 *  render.js's constructor comment) and persist the choice. */
function setHighContrast(value) {
  renderer.highContrast = !!value;
  try { localStorage.setItem(HIGHCONTRAST_KEY, renderer.highContrast ? '1' : '0'); } catch { /* best effort */ }
}
settingsHighContrastEl.addEventListener('change', () => setHighContrast(settingsHighContrastEl.checked));
try { setHighContrast(localStorage.getItem(HIGHCONTRAST_KEY) === '1'); } catch { /* default false */ }

/** Apply the --ui-scale CSS custom property (index.html's ".box { transform: scale(...) }") and
 *  update the slider display, without touching persisted state. Clamped to the same 85-150%
 *  range as the slider, snapped to its 5% step so the slider/value label stay in sync whichever
 *  path (auto or manual) set it. */
function applyUiScale(value) {
  const clamped = Math.round(Math.max(0.85, Math.min(1.5, value)) * 20) / 20; // snap to 5% steps
  document.documentElement.style.setProperty('--ui-scale', String(clamped));
  const pct = Math.round(clamped * 100);
  settingsTextSizeEl.value = String(pct);
  settingsTextSizeValEl.textContent = pct + '%';
  return clamped;
}

/** Explicit manual override (dragging the slider): applies, persists as the fixed value, and
 *  switches auto-fit off (a manual choice should stick until the player re-enables auto-fit,
 *  same "explicit action wins over a passive default" precedent as setHighContrast). */
function setUiScale(value) {
  applyUiScale(value);
  try { localStorage.setItem(UISCALE_KEY, String(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')))); } catch { /* best effort */ }
  setUiScaleAuto(false, { skipReapply: true });
}

function isUiScaleAuto() {
  try {
    const v = localStorage.getItem(UISCALE_AUTO_KEY);
    return v === null ? true : v === '1'; // unset -> auto ON by default
  } catch { return true; }
}

/** Compute a sensible UI scale from the current viewport instead of always defaulting to 100%
 *  -- a laptop-size window gets a smaller UI so panels/text fit without overflow-scrolling, a
 *  larger/high-res window gets a mildly bigger one. Reference size (1280x800) is this project's
 *  baseline desktop layout (see the settings-panel/topbar CSS); min() of the two axis ratios so
 *  a narrow-but-tall or short-but-wide window doesn't get an oversized scale on its cramped axis.
 *  Snapped to the slider's own 5% step inside applyUiScale so it always lines up with a value the
 *  player could have chosen manually. */
function computeAutoUiScale() {
  const ratio = Math.min(window.innerWidth / 1280, window.innerHeight / 800);
  return Math.max(0.85, Math.min(1.5, ratio));
}

function setUiScaleAuto(enabled, opts = {}) {
  try { localStorage.setItem(UISCALE_AUTO_KEY, enabled ? '1' : '0'); } catch { /* best effort */ }
  if (enabled && !opts.skipReapply) applyUiScale(computeAutoUiScale());
  if (settingsUiScaleAutoEl) settingsUiScaleAutoEl.checked = enabled;
}

settingsUiScaleAutoEl.addEventListener('change', () => {
  if (settingsUiScaleAutoEl.checked) {
    setUiScaleAuto(true);
  } else {
    // Switching auto off keeps whatever scale was showing (now a manual override) rather than
    // silently resetting to some other value.
    setUiScaleAuto(false, { skipReapply: true });
    try { localStorage.setItem(UISCALE_KEY, String(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')))); } catch { /* best effort */ }
  }
});
settingsTextSizeEl.addEventListener('input', () => setUiScale(Number(settingsTextSizeEl.value) / 100));

let _uiScaleResizeTimer = null;
window.addEventListener('resize', () => {
  if (!isUiScaleAuto()) return;
  // Debounced -- a window drag fires many resize events, only the settled size matters.
  clearTimeout(_uiScaleResizeTimer);
  _uiScaleResizeTimer = setTimeout(() => applyUiScale(computeAutoUiScale()), 150);
});

(function initUiScale() {
  if (isUiScaleAuto()) {
    applyUiScale(computeAutoUiScale());
    return;
  }
  try {
    const stored = Number.parseFloat(localStorage.getItem(UISCALE_KEY));
    applyUiScale(Number.isFinite(stored) ? stored : 1);
  } catch { applyUiScale(1); }
})();

// ---------------------------------------------------------------- minimap
const minimapEl = document.getElementById('minimap');
minimapEl.addEventListener('click', (e) => {
  if (!world) return;
  const rect = minimapEl.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (minimapEl.width / rect.width);
  const my = (e.clientY - rect.top) * (minimapEl.height / rect.height);
  const wx = (mx / minimapEl.width) * world.width;
  const wy = (my / minimapEl.height) * world.height;
  renderer.jumpTo(wx, wy, world);
});

/** Whether a save exists at all -- drives the title screen's Continue/Load availability. Kept a
 *  function rather than a cached boolean so it stays correct after a mid-session save. */
function hasSave() {
  try { return localStorage.getItem(SAVE_KEY) != null; } catch { return false; }
}

function save() {
  if (!world) return false;
  // The conquest map outlives any single SimWorld, so it's saved alongside the world payload
  // rather than inside it. SimWorld.deserialize ignores the extra key.
  localStorage.setItem(SAVE_KEY, JSON.stringify({ ...world.serialize(), worldMap: worldMap.serialize(), savedAt: Date.now() }));
  showToast('Saved');
  console.log(`[SimWorldHost] Saved at tick ${world.currentTick}.`);
  return true;
}

/** Load the single save slot. Works both from the title screen (no world yet) and from inside a
 *  running game -- both paths funnel through startGame(), which is what actually installs the
 *  world and swaps the UI over. Returns true on success. */
function load() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) { showToast('No save found'); return false; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    console.error('[SimWorldHost] Save is corrupt:', err);
    showToast('Save is corrupt');
    return false;
  }
  const loaded = SimWorld.deserialize(parsed);
  if (parsed.worldMap) worldMap.deserialize(parsed.worldMap);
  startGame(loaded);
  showToast('Loaded');
  console.log(`[SimWorldHost] Loaded from tick ${world.currentTick}.`);
  return true;
}

// ---------------------------------------------------------------- autosave
// Separate slot from the manual save above (AUTOSAVE_KEY vs SAVE_KEY) -- autosave must never
// silently overwrite progress the player explicitly chose to save. Mirrors save()/load()'s shape
// exactly (same payload shape, same SimWorld.deserialize/startGame handoff) so the two slots stay
// interchangeable from the title screen's point of view.

/** Whether an autosave exists -- same role as hasSave() above, for the title screen's "Resume
 *  Autosave" button. */
function hasAutosave() {
  try { return localStorage.getItem(AUTOSAVE_KEY) != null; } catch { return false; }
}

/** Peek a save slot's headline stats (tick + wall-clock time it was written) without fully
 *  deserializing a SimWorld -- used only to decide which of the two slots is more recent for the
 *  title screen's savenote text. Returns null if the slot is empty/corrupt. */
function peekSaveMeta(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { tick: parsed.currentTick ?? 0, savedAt: parsed.savedAt ?? 0 };
  } catch { return null; }
}

/** Silently write the current world to the autosave slot. Called periodically from frame() (see
 *  AUTOSAVE_INTERVAL_TICKS) while a game is actively running -- never call this while paused or
 *  game-over, callers are expected to gate that themselves (frame() does). */
function autosave() {
  if (!world) return false;
  localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ...world.serialize(), worldMap: worldMap.serialize(), savedAt: Date.now() }));
  lastAutosaveTick = world.currentTick;
  showAutosaveIndicator();
  console.log(`[SimWorldHost] Autosaved at tick ${world.currentTick}.`);
  return true;
}

/** Load the autosave slot. Same shape/handoff as load(); kept a separate function (rather than
 *  parameterising load() by key) so the two slots can diverge later without entangling them. */
function loadAutosave() {
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if (!raw) { showToast('No autosave found'); return false; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    console.error('[SimWorldHost] Autosave is corrupt:', err);
    showToast('Autosave is corrupt');
    return false;
  }
  const loaded = SimWorld.deserialize(parsed);
  if (parsed.worldMap) worldMap.deserialize(parsed.worldMap);
  startGame(loaded);
  showToast('Resumed autosave');
  console.log(`[SimWorldHost] Resumed autosave from tick ${world.currentTick}.`);
  return true;
}

/** Gate for a "Resume Autosave" action taken while a game is already running (there is none today
 *  -- the button only exists on the title screen, where there's nothing live to lose -- but this
 *  mirrors confirmedLoad()'s shape in case a pause-menu entry point is added later). */
function confirmedLoadAutosave() {
  if (world) {
    confirmAction('Resume the autosave? Your current unsaved progress will be lost.', () => loadAutosave());
  } else {
    loadAutosave();
  }
}

// ---------------------------------------------------------------- save slots (multi-slot save/load)
// A small named-slot scheme layered ON TOP of the single-slot save()/load() above, not a
// replacement for it -- F5/F9/topbar Save/Load still read and write SAVE_KEY directly, unchanged,
// and autosave() still owns AUTOSAVE_KEY, unchanged. Storage shape: SLOTS_KEY holds one JSON array
// of SLOT_COUNT entries, each either null (empty) or { meta, data }. `data` is exactly the payload
// save()/load() already produce/consume (world.serialize() + worldMap.serialize()), so
// loadFromSlot() below hands it to SimWorld.deserialize() completely unchanged. `meta` is the
// small summary the slot list renders without having to deserialize a whole SimWorld just to show
// a row: wall-clock timestamp, tick, wave number, alive citizen count.

/** Count of currently-alive citizens from a save's raw JSON (not a live SimWorld) -- used both to
 *  build slot metadata from world.serialize() output and for the one-time legacy migration below,
 *  which only has raw JSON to work from, never a SimWorld instance. */
function countAliveInSaveJson(citizensJson) {
  if (!citizensJson) return 0;
  let n = 0;
  for (let i = 0; i < citizensJson.count; i++) if (citizensJson.alive[i]) n++;
  return n;
}

/** Read all slots from storage. Self-healing: missing/corrupt/short-array storage resets to
 *  SLOT_COUNT empty slots rather than throwing. Also performs a one-time migration the first time
 *  it's ever called: if slot 0 is empty and a legacy single SAVE_KEY save exists, that save is
 *  folded into slot 0 so nobody loses a save made before multi-slot support existed. The migration
 *  never fires once slot 0 has been written to via the new scheme (it only triggers on an empty
 *  slot 0), and it never touches or clears SAVE_KEY itself -- F5/F9/topbar Save/Load keep working
 *  exactly as before, independent of whatever's in the slots. */
function loadSlots() {
  let arr;
  try {
    const raw = localStorage.getItem(SLOTS_KEY);
    arr = raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('[SaveSlots] Slot data corrupt, resetting:', err);
    arr = null;
  }
  if (!Array.isArray(arr)) arr = [];
  arr = arr.slice(0, SLOT_COUNT);
  while (arr.length < SLOT_COUNT) arr.push(null);

  if (!arr[0]) {
    let legacyRaw;
    try { legacyRaw = localStorage.getItem(SAVE_KEY); } catch { legacyRaw = null; }
    if (legacyRaw) {
      try {
        const parsed = JSON.parse(legacyRaw);
        arr[0] = {
          meta: {
            timestamp: parsed.savedAt || Date.now(),
            tick: parsed.currentTick || 0,
            wave: parsed.waveNumber || 0,
            citizens: countAliveInSaveJson(parsed.citizens),
          },
          data: parsed,
        };
        persistSlots(arr);
        console.log('[SaveSlots] Migrated the legacy single-slot save into Slot 1.');
      } catch (err) {
        console.error('[SaveSlots] Legacy save corrupt, skipping migration:', err);
      }
    }
  }
  return arr;
}

function persistSlots(slots) {
  try {
    localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
  } catch (err) {
    console.error('[SaveSlots] Failed to write slots (storage full?):', err);
    showToast('Save failed -- storage full?');
  }
}

/** Save the current world into slot `idx`, overwriting whatever was there. */
function saveToSlot(idx) {
  if (!world) return false;
  const data = { ...world.serialize(), worldMap: worldMap.serialize(), savedAt: Date.now() };
  const slots = loadSlots();
  slots[idx] = {
    meta: {
      timestamp: Date.now(),
      tick: world.currentTick,
      wave: world.waveSpawner.waveNumber,
      citizens: countAlive(world.citizens.count, world.citizens.isAliveAt.bind(world.citizens)),
    },
    data,
  };
  persistSlots(slots);
  showToast(`Saved to Slot ${idx + 1}`);
  console.log(`[SaveSlots] Saved slot ${idx} at tick ${world.currentTick}.`);
  renderSaveLoad();
  return true;
}

/** Load slot `idx` and hand it to startGame() -- same deserialize/worldMap/startGame sequence
 *  save()/load() and autosave()/loadAutosave() already use above, just sourced from the slot
 *  array instead of a dedicated key. Closes the panel on success so the player sees the game. */
function loadFromSlot(idx) {
  const slots = loadSlots();
  const entry = slots[idx];
  if (!entry) { showToast('That slot is empty'); return false; }
  let loaded;
  try {
    loaded = SimWorld.deserialize(entry.data);
  } catch (err) {
    console.error(`[SaveSlots] Slot ${idx} is corrupt:`, err);
    showToast('Save is corrupt');
    return false;
  }
  if (entry.data.worldMap) worldMap.deserialize(entry.data.worldMap);
  startGame(loaded);
  toggleSaveLoad(false);
  showToast(`Loaded Slot ${idx + 1}`);
  console.log(`[SaveSlots] Loaded slot ${idx} at tick ${world.currentTick}.`);
  return true;
}

function deleteSlot(idx) {
  const slots = loadSlots();
  slots[idx] = null;
  persistSlots(slots);
  showToast(`Slot ${idx + 1} deleted`);
  renderSaveLoad();
}

// ---- Save/Load panel (#saveload in index.html) -- reachable from the title screen's own button
// AND from in-game via the pause menu's Save button (see the pause-menu section above, which
// points btn-pause-save here). Same full-screen-overlay convention as worldmap/finance/research,
// but deliberately not torn down by showTitleScreen()'s overlay-cleanup loop since it has to stay
// usable from the title screen too. ----
const saveloadEl = document.getElementById('saveload');
const saveloadRowsEl = document.getElementById('saveload-rows');

function toggleSaveLoad(force) {
  const show = force != null ? force : saveloadEl.classList.contains('hidden');
  saveloadEl.classList.toggle('hidden', !show);
  if (show) { pendingDeleteIdx = -1; renderSaveLoad(); }
}

function fmtSlotTimestamp(ts) {
  if (!ts) return 'Unknown time';
  try { return new Date(ts).toLocaleString(); } catch { return 'Unknown time'; }
}

// Delete uses a local two-click "arm" pattern (click once to arm, click again on the same row to
// confirm) instead of routing through the shared #confirm-dialog -- keeps this panel
// self-contained rather than reaching into the confirm-dialog work landing in parallel. Any fresh
// render of the panel (opening it, saving, loading a different slot) resets the armed state.
let pendingDeleteIdx = -1;

/** Rebuild the slot list wholesale. SLOT_COUNT rows, only while the panel is open -- cheap enough
 *  not to bother diffing, same reasoning renderWorldMap()/renderResearch() use above. */
function renderSaveLoad() {
  const slots = loadSlots();
  saveloadRowsEl.innerHTML = '';
  slots.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'slot-row' + (entry ? '' : ' empty');

    const info = document.createElement('div');
    if (entry) {
      const m = entry.meta || {};
      info.innerHTML = `<div class="slot-name">Slot ${i + 1}</div>` +
        `<div class="slot-meta">${fmtSlotTimestamp(m.timestamp)} &middot; tick ${m.tick ?? '?'} &middot; ` +
        `wave ${m.wave ?? '?'} &middot; ${m.citizens ?? '?'} citizens</div>`;
    } else {
      info.innerHTML = `<div class="slot-name">Slot ${i + 1}</div><div class="slot-meta">Empty</div>`;
    }
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'slot-actions';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.disabled = !world;
    saveBtn.title = world ? `Save the current settlement to Slot ${i + 1}` : 'Start or load a settlement first';
    saveBtn.addEventListener('click', () => { pendingDeleteIdx = -1; saveToSlot(i); });
    actions.appendChild(saveBtn);

    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load';
    loadBtn.disabled = !entry;
    loadBtn.addEventListener('click', () => {
      pendingDeleteIdx = -1;
      if (world) {
        confirmAction(`Load Slot ${i + 1}? Your current unsaved progress will be lost.`, () => loadFromSlot(i));
      } else {
        loadFromSlot(i);
      }
    });
    actions.appendChild(loadBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.disabled = !entry;
    if (pendingDeleteIdx === i) {
      delBtn.textContent = 'Confirm?';
      delBtn.addEventListener('click', () => { pendingDeleteIdx = -1; deleteSlot(i); });
    } else {
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => { pendingDeleteIdx = i; renderSaveLoad(); });
    }
    actions.appendChild(delBtn);

    row.appendChild(actions);
    saveloadRowsEl.appendChild(row);
  });
}

document.getElementById('btn-saveload-close').addEventListener('click', () => toggleSaveLoad(false));
document.getElementById('btn-title-saveload').addEventListener('click', () => toggleSaveLoad(true));

// ---- File-backed backup (Download/Upload Save) --------------------------------------------
// Durable alternative to the localStorage-based slots/quicksave/autosave above: localStorage
// under a file:// origin (this project is built to be double-clicked, no server -- see build.py's
// header comment) is genuinely unreliable across browsers, so this writes/reads an actual .json
// file on disk instead. Reuses exactly the same payload shape as save()/saveToSlot() (world.serialize()
// + worldMap.serialize() + savedAt) and the same SimWorld.deserialize()/startGame() handoff every
// other load path uses -- this is purely a different transport for the identical data, not a
// second save format. Lives in the Save/Load panel (#saveload) so it's reachable from both the
// title screen and, in-game, the pause menu's Save button.

/** Cheap shape check on parsed JSON before handing it to SimWorld.deserialize() -- catches "picked
 *  the wrong file entirely" (an unrelated JSON file, a save from some other game) with a toast
 *  instead of an uncaught exception partway through deserialize(). Checks the same top-level keys
 *  world.serialize()/SimWorld.deserialize() actually read (see world.js), not an exhaustive schema. */
function isPlausibleSaveJson(parsed) {
  return !!parsed && typeof parsed === 'object' &&
    typeof parsed.width === 'number' && typeof parsed.height === 'number' &&
    parsed.citizens && typeof parsed.citizens === 'object' &&
    typeof parsed.citizens.count === 'number' && Array.isArray(parsed.citizens.alive) &&
    Array.isArray(parsed.structures) && Array.isArray(parsed.zones);
}

/** Trigger a browser download of the current settlement as a standalone .json file. Blob + a
 *  throwaway <a download> click -- the standard vanilla-JS pattern, no library. */
function downloadSave() {
  if (!world) { showToast('Nothing to save yet'); return false; }
  const data = { ...world.serialize(), worldMap: worldMap.serialize(), savedAt: Date.now() };
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `settlement-${world.seed}-tick${world.currentTick}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Save downloaded');
  console.log(`[SimWorldHost] Downloaded save at tick ${world.currentTick} (${json.length} bytes).`);
  return true;
}

/** Actually perform the load once `parsed` has already passed isPlausibleSaveJson(). Shared tail
 *  end of both the real file-upload path and the confirm-dialog gate below. */
function loadParsedSave(parsed) {
  let loaded;
  try {
    loaded = SimWorld.deserialize(parsed);
  } catch (err) {
    console.error('[SimWorldHost] Uploaded save is corrupt:', err);
    showToast('That save file is corrupt');
    return false;
  }
  if (parsed.worldMap) worldMap.deserialize(parsed.worldMap);
  startGame(loaded);
  toggleSaveLoad(false);
  showToast('Save file loaded');
  console.log(`[SimWorldHost] Loaded uploaded save file at tick ${world.currentTick}.`);
  return true;
}

/** Gate for importing a file while a game may already be running -- mirrors confirmedLoad()'s
 *  shape exactly: skip the confirm dialog when there's nothing live to lose (title screen), show
 *  it when there is (in-game). */
function confirmedImportParsed(parsed) {
  if (world) {
    confirmAction('Load this save file? Your current unsaved progress will be lost.', () => loadParsedSave(parsed));
  } else {
    loadParsedSave(parsed);
  }
}

/** Validate + confirm-gate a JSON string read from an uploaded file (or handed in directly for
 *  console/test verification via window.__debug.importSaveJson). Returns false immediately on
 *  malformed JSON or an unrecognized shape (toast, not a crash); the confirm gate / actual load
 *  happens asynchronously past that point. */
function importSaveJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('[SimWorldHost] Uploaded file is not valid JSON:', err);
    showToast('That file is not valid JSON');
    return false;
  }
  if (!isPlausibleSaveJson(parsed)) {
    showToast('That file is not a settlement save');
    return false;
  }
  confirmedImportParsed(parsed);
  return true;
}

/** Read a File/Blob (from the file picker or, in tests, constructed directly) via FileReader and
 *  hand its text off to importSaveJson(). Split out from the file-input's change handler so
 *  window.__debug.importSaveFile(file) can drive the exact same path without a real picker. */
function importSaveFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => importSaveJson(String(reader.result));
  reader.onerror = () => showToast('Could not read that file');
  reader.readAsText(file);
}

document.getElementById('btn-saveload-download').addEventListener('click', () => downloadSave());
const saveloadFileInputEl = document.getElementById('saveload-file-input');
document.getElementById('btn-saveload-upload').addEventListener('click', () => saveloadFileInputEl.click());
saveloadFileInputEl.addEventListener('change', () => {
  const file = saveloadFileInputEl.files && saveloadFileInputEl.files[0];
  importSaveFile(file);
  saveloadFileInputEl.value = ''; // allow re-selecting the same filename later
});

/** Immediate fresh settlement, no trip back to the menu -- same behaviour the [R] key and the
 *  "New"/game-over buttons always had, except the map size / aggression / citizen count /
 *  storyteller now come from whatever the player configured for this run instead of a hardcoded
 *  64x64 Calm 24. Only the seed is rerolled. UNGATED -- callers that can discard a live colony
 *  (the topbar "New" button, the R/r hotkey) must go through confirmRestart() below instead; this
 *  raw function stays available for spots where confirmation doesn't make sense (game-over's
 *  "Start a New Settlement", which fires only once the current colony is already gone). */
function restart() {
  startGame(makeWorld({ ...lastNewGameConfig, seed: Math.floor(Math.random() * 0xffffffff) }));
  console.log(`[SimWorldHost] New settlement, seed ${world.seed}.`);
}

// ---------------------------------------------------------------- confirm dialog
// Generic confirm-before-destructive-action modal (#confirm-dialog in index.html), reusable for
// every "this will discard the running colony" action rather than one bespoke dialog per call
// site. confirmAction is exposed on window.__debug (see below) specifically so other in-flight UI
// work (e.g. a pause menu's "Quit to title" button) can call into this instead of building its own.
const confirmDialogEl = document.getElementById('confirm-dialog');
const confirmMessageEl = document.getElementById('confirm-message');
let pendingConfirm = null;

/** Show the shared confirm dialog with `message`; calls `onConfirm()` if the player clicks
 *  Confirm, does nothing (just closes) on Cancel. Only one confirmation can be pending at a time --
 *  a second call simply replaces the first, since only one destructive action can ever be
 *  in-flight from a single click. */
function confirmAction(message, onConfirm) {
  pendingConfirm = onConfirm;
  confirmMessageEl.textContent = message;
  confirmDialogEl.classList.remove('hidden');
}

function closeConfirmDialog() {
  confirmDialogEl.classList.add('hidden');
  pendingConfirm = null;
}

document.getElementById('btn-confirm-cancel').addEventListener('click', () => closeConfirmDialog());
document.getElementById('btn-confirm-ok').addEventListener('click', () => {
  const fn = pendingConfirm;
  closeConfirmDialog();
  if (fn) fn();
});

/** Gate for the topbar "New" button and the R/r hotkey -- the two places that can wipe a running
 *  colony with zero trip through the setup form. */
function confirmRestart() {
  confirmAction('Start a new settlement? Your current colony will be lost unless saved.', () => restart());
}

/** Gate for the topbar "Load" button. Loading while a game is already running discards its
 *  unsaved progress, same as restart -- but there is nothing to lose from the title screen (no
 *  world yet), so skip the dialog there and load immediately. */
function confirmedLoad() {
  if (world) {
    confirmAction('Load a saved settlement? Your current unsaved progress will be lost.', () => load());
  } else {
    load();
  }
}

/** The one place a SimWorld is constructed from a settings object. Storyteller is a plain field
 *  assignment (director.js reads world.storyteller), not a constructor argument. */
function makeWorld({ width, height, seed, aggression, startingCitizens, storyteller }) {
  const w = new SimWorld(width, height, seed >>> 0, aggression, startingCitizens);
  w.storyteller = storyteller;
  return w;
}

// ---------------------------------------------------------------- world map / conquest overlay
// DOM rather than Canvas: the map is pure UI (bars, labels, buttons), it isn't part of the game
// world's coordinate space, and it needs to match the existing .panel look exactly.
const worldmapEl = document.getElementById('worldmap');
const worldmapGridEl = document.getElementById('worldmap-grid');
const worldmapSubEl = document.getElementById('worldmap-sub');
const worldmapRangeLabelEl = document.getElementById('worldmap-range-label');
const btnUpgradeRangeEl = document.getElementById('btn-worldmap-upgrade-range');

function toggleWorldMap(force) {
  const show = force != null ? force : worldmapEl.classList.contains('hidden');
  worldmapEl.classList.toggle('hidden', !show);
  document.getElementById('btn-worldmap').classList.toggle('active', show);
  if (show) renderWorldMap();
}
input.onToggleMap = () => toggleWorldMap();

/** Refresh the "Upgrade travel range" row -- current range, next cost, capped/afford state. */
function refreshRangeRow() {
  if (!worldmapRangeLabelEl || !btnUpgradeRangeEl) return;
  const maxed = worldMap.travelRange >= MAX_TRAVEL_RANGE;
  worldmapRangeLabelEl.textContent = maxed
    ? `Travel range: ${worldMap.travelRange} (max)`
    : `Travel range: ${worldMap.travelRange} · next upgrade ${worldMap.rangeUpgradeCost()} scrap`;
  btnUpgradeRangeEl.disabled = maxed || world.scrap < worldMap.rangeUpgradeCost();
  btnUpgradeRangeEl.classList.toggle('hidden', maxed);
}
btnUpgradeRangeEl?.addEventListener('click', () => {
  if (worldMap.upgradeTravelRange(world)) {
    showToast(`Travel range upgraded to ${worldMap.travelRange}`);
    renderWorldMap();
  } else {
    showToast('Cannot upgrade travel range');
  }
});
input.onCloseMap = () => toggleWorldMap(false);
input.onToggleFinance = () => toggleFinance();
input.onCloseFinance = () => toggleFinance(false);

// ---------------------------------------------------------------- research / tech tree overlay
// Same full-screen-overlay-with-a-toggle-button convention as the conquest map and budget report
// above (DOM, not canvas -- it's pure UI, not part of the world's coordinate space).
const researchEl = document.getElementById('research');
const researchGridEl = document.getElementById('research-grid');
const researchSubEl = document.getElementById('research-sub');

// Bound here rather than at the overlay's definition to keep every input.on* hook together with
// the map/finance ones above.
function toggleResearch(force) {
  const show = force != null ? force : researchEl.classList.contains('hidden');
  researchEl.classList.toggle('hidden', !show);
  document.getElementById('btn-research').classList.toggle('active', show);
  if (show) renderResearch();
}
input.onToggleResearch = () => toggleResearch();
input.onCloseResearch = () => toggleResearch(false);

// ---------------------------------------------------------------- factions / clique demands overlay
// Same full-screen-overlay-with-a-toggle-button convention as the conquest map/budget/research
// overlays above (DOM, not canvas). See factions.js for the underlying system -- reskinned Prison
// Architect gang-demand system, 3 named cliques with real, mechanical demands/rewards/consequences.
const factionsEl = document.getElementById('factions');
const factionsGridEl = document.getElementById('factions-grid');
const factionsSubEl = document.getElementById('factions-sub');

function toggleFactions(force) {
  const show = force != null ? force : factionsEl.classList.contains('hidden');
  factionsEl.classList.toggle('hidden', !show);
  document.getElementById('btn-factions').classList.toggle('active', show);
  if (show) renderFactions();
}
input.onToggleFactions = () => toggleFactions();
input.onCloseFactions = () => toggleFactions(false);

// ---------------------------------------------------------------- draft/undraft (draft.js)
// Shared by the Shift+D hotkey (input.js's onToggleDraft) and the inspector's draft button (see
// its click handler near updateInspector below) -- both just need "toggle draft for whichever
// citizen(s) are currently selected", so this is the one place that logic lives. Mixed selections
// (some already drafted, some not) draft everyone if ANY are undrafted, same "unify to the
// majority action" convention RimWorld's own multi-select draft button uses, rather than a
// per-citizen toggle that could leave a marquee-selected group in a split state from one click.
function toggleDraftSelection() {
  const indices = (input.selectedCitizens && input.selectedCitizens.length > 0)
    ? input.selectedCitizens
    : (input.selectedCitizen >= 0 ? [input.selectedCitizen] : []);
  const alive = indices.filter(i => i >= 0 && i < world.citizens.count && world.citizens.isAliveAt(i));
  if (alive.length === 0) return;
  const anyUndrafted = alive.some(i => !isDrafted(world, world.citizens.id[i]));
  for (const i of alive) {
    const id = world.citizens.id[i];
    if (anyUndrafted) draftCitizen(world, id); else undraftCitizen(world, id);
  }
  showToast(anyUndrafted ? `Drafted ${alive.length}` : `Undrafted ${alive.length}`);
  updateInspector();
}
input.onToggleDraft = () => toggleDraftSelection();

/** Full rebuild of the clique cards -- cheap (3 cliques) to redraw wholesale, same "no diffing
 *  needed, small enough list" reasoning as renderResearch/renderWorldMap. Shows "not formed yet"
 *  guidance below FACTION_MIN_POPULATION rather than an empty panel, so the system is discoverable
 *  before it actually kicks in. */
function renderFactions() {
  const f = world.factions;
  factionsGridEl.innerHTML = '';
  if (!f || !f.formed) {
    factionsSubEl.textContent = `No cliques have formed yet -- they emerge once the settlement reaches 20 living citizens.`;
    return;
  }
  let aliveCount = 0;
  for (let i = 0; i < world.citizens.count; i++) if (world.citizens.isAliveAt(i)) aliveCount++;
  factionsSubEl.textContent = `${aliveCount} living citizens, sorted into ${CLIQUES.length} rival cliques.`;

  for (const clique of CLIQUES) {
    const memberCount = f.memberCountOf(clique.id, world);
    const demand = f.demand[clique.id];
    const card = document.createElement('div');
    card.className = 'node' + (demand ? ' available' : '');
    card.style.borderColor = clique.color;

    let body = `<div class="rname" style="color:${clique.color}">${clique.name}</div>` +
      `<div class="badge">${memberCount} members &middot; leans ${clique.preferredMisbehaviour}</div>`;

    if (demand) {
      const pct = Math.min(100, (demand.progress / demand.target) * 100);
      const ticksLeft = Math.max(0, demand.deadlineTick - world.currentTick);
      body += `<div class="desc">${demand.tier === 'escalated' ? 'ESCALATED demand' : 'Demand'}: more time in the Recreation zone.</div>` +
        `<div class="bar"><div class="bar-fill" style="width:${pct}%;background:${clique.color}"></div></div>` +
        `<div class="badge cost-line">${demand.progress} / ${demand.target} visits &middot; ${ticksLeft} ticks left</div>`;
    } else {
      const cooldownLeft = Math.max(0, f.cooldownUntil[clique.id] - world.currentTick);
      body += `<div class="desc">${cooldownLeft > 0 ? `Quiet for now -- next demand in ${cooldownLeft} ticks.` : 'No active demand.'}</div>` +
        `<div class="unlocks">Satisfied ${f.completions[clique.id]}x -- next demand will be ${f.demandTier[clique.id] === 'escalated' ? `ESCALATED (${DEMAND_ESCALATED_TARGET} visits)` : `base (${DEMAND_BASE_TARGET} visits)`}.</div>`;
    }
    card.innerHTML = body;
    factionsGridEl.appendChild(card);
  }
}

// While the overlay is open the sim keeps running behind it, so progress/cooldowns need to move --
// same "only redraw while visible" gate as refreshFinance/refreshResearchValues above. Structural
// rebuild every call (cheap, 3 cards) rather than diffing, same reasoning as renderFactions itself.
function refreshFactions() {
  if (factionsEl.classList.contains('hidden')) return;
  renderFactions();
}

// ---------------------------------------------------------------- structured group programs overlay
// Same full-screen-overlay-with-a-toggle-button convention as the panels above. One card per
// PROGRAM_DEFS kind (fixed 3, not per-site -- a settlement can have multiple validated rooms of
// the same kind, so the card aggregates across every current world.programSites entry of that
// kind rather than listing rooms individually, keeping this readable at a glance).
const programsEl = document.getElementById('programs');
const programsGridEl = document.getElementById('programs-grid');
const programsSubEl = document.getElementById('programs-sub');

function toggleProgramsPanel(force) {
  const show = force != null ? force : programsEl.classList.contains('hidden');
  programsEl.classList.toggle('hidden', !show);
  document.getElementById('btn-programs').classList.toggle('active', show);
  if (show) renderPrograms();
}
input.onTogglePrograms = () => toggleProgramsPanel();
input.onClosePrograms = () => toggleProgramsPanel(false);

function renderPrograms() {
  const sites = world.programSites || [];
  programsSubEl.textContent = `${sites.length} validated program room${sites.length === 1 ? '' : 's'} currently detected.`;
  programsGridEl.innerHTML = '';
  for (const kind of PROGRAM_ORDER) {
    const def = PROGRAM_DEFS[kind];
    const kindSites = sites.filter(s => s.kind === kind);
    const staffedSites = kindSites.filter(s => isSiteStaffed(world, s));
    const totalAttendees = kindSites.reduce((sum, s) => sum + s.attendeeIds.length, 0);
    const totalPlaces = kindSites.length * def.places;

    const card = document.createElement('div');
    let status, cls;
    if (kindSites.length === 0) { status = 'No validated room'; cls = 'blocked'; }
    else if (staffedSites.length === 0) { status = 'Unstaffed -- no sessions running'; cls = 'blocked'; }
    else { status = `Running -- ${staffedSites.length}/${kindSites.length} room(s) staffed`; cls = 'available'; }
    card.className = 'node' + (cls ? ` ${cls}` : '');

    const pct = totalPlaces > 0 ? Math.min(100, (totalAttendees / totalPlaces) * 100) : 0;
    card.innerHTML =
      `<div class="rname">${def.label}</div>` +
      `<div class="badge">${status}</div>` +
      `<div class="desc">${def.sessionCost} scrap/session &middot; ${def.numSessions} sessions &middot; ${def.places} places &middot; staffed by ${def.staffRole}</div>` +
      `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>` +
      `<div class="badge cost-line">${totalAttendees} / ${totalPlaces || def.places} attending now</div>` +
      `<div class="unlocks">Runs during the ${def.scheduleBlock === 0 ? 'Sleep' : def.scheduleBlock === 1 ? 'Work' : 'Recreation'} schedule block.</div>`;
    programsGridEl.appendChild(card);
  }
}

function refreshPrograms() {
  if (programsEl.classList.contains('hidden')) return;
  renderPrograms();
}

// ---------------------------------------------------------------- outpost charter contracts overlay (grants.js)
// Same full-screen-overlay-with-a-toggle-button convention as every panel above. One card per
// GRANT_ORDER entry (fixed 6: Bootstrap, the 4-rung population ladder, the Emergency Stabilization
// bailout), plus a standing Invest section below the grid for the time-locked instrument -- that
// one isn't milestone-gated, it's a player-initiated action available any time there's enough
// scrap on hand, so it doesn't fit the locked/available/completed card shape the others share.
const grantsEl = document.getElementById('grants');
const grantsGridEl = document.getElementById('grants-grid');
const grantsSubEl = document.getElementById('grants-sub');
const investSubEl = document.getElementById('invest-sub');
const investPendingEl = document.getElementById('invest-pending');
const btnInvestShort = document.getElementById('btn-invest-short');
const btnInvestLong = document.getElementById('btn-invest-long');

function toggleGrantsPanel(force) {
  const show = force != null ? force : grantsEl.classList.contains('hidden');
  grantsEl.classList.toggle('hidden', !show);
  document.getElementById('btn-grants').classList.toggle('active', show);
  if (show) renderGrants();
}
input.onToggleGrants = () => toggleGrantsPanel();
input.onCloseGrants = () => toggleGrantsPanel(false);

btnInvestShort.textContent = `Short-Term (${INVEST_SHORT_TICKS}t): pay ${INVEST_COST} -> get ${INVEST_SHORT_PAYOUT}`;
btnInvestLong.textContent = `Long-Term (${INVEST_LONG_TICKS}t): pay ${INVEST_COST} -> get ${INVEST_LONG_PAYOUT}`;
btnInvestShort.addEventListener('click', () => {
  const res = startInvestment(world, InvestmentTerm.Short);
  if (!res.ok) { showToast(res.reason); return; }
  showToast(`Invested ${INVEST_COST} scrap, matures in ${INVEST_SHORT_TICKS} ticks`);
  renderGrants();
});
btnInvestLong.addEventListener('click', () => {
  const res = startInvestment(world, InvestmentTerm.Long);
  if (!res.ok) { showToast(res.reason); return; }
  showToast(`Invested ${INVEST_COST} scrap, matures in ${INVEST_LONG_TICKS} ticks`);
  renderGrants();
});

/** Full rebuild of the charter cards + investment section. ~6 cards, only while the overlay is
 *  open -- same "cheap enough not to diff" reasoning as renderResearch/renderPrograms. */
function renderGrants() {
  const state = world.grants;
  grantsGridEl.innerHTML = '';
  let completedCount = 0;
  for (const id of GRANT_ORDER) {
    const def = GRANT_DEFS[id];
    const status = charterStatus(world, id);
    if (status === 'completed') completedCount++;
    const card = document.createElement('div');
    card.className = 'node' + (status === 'completed' ? ' done' : status === 'available' ? ' available' : ' blocked');

    const checklistHtml = def.checklist.map(item => {
      const ok = status === 'completed' || item.check(world, state);
      return `<div class="chk ${ok ? 'ok' : ''}">${ok ? '✓' : '○'} ${resolveText(item.label, world)}</div>`;
    }).join('');
    const doneN = def.checklist.filter(item => status === 'completed' || item.check(world, state)).length;
    const pct = def.checklist.length > 0 ? (doneN / def.checklist.length) * 100 : (status === 'completed' ? 100 : 0);

    const badge = status === 'completed' ? `Fulfilled (+${def.reward} scrap)`
      : status === 'available' ? 'Available -- clear the checklist'
        : id === CharterKind.Bailout ? 'Hidden until the settlement is in real trouble'
          : `Requires ${GRANT_DEFS[def.requires]?.label ?? 'a prior charter'}`;

    card.innerHTML =
      `<div class="rname">${def.label}</div>` +
      `<div class="badge">${badge}</div>` +
      `<div class="desc">${resolveText(def.desc, world)}</div>` +
      (status !== 'locked' ? `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>${checklistHtml}` : '') +
      `<div class="unlocks">Reward: ${def.reward} scrap</div>`;
    grantsGridEl.appendChild(card);
  }
  grantsSubEl.textContent = `${completedCount} / ${GRANT_ORDER.length} charters fulfilled &middot; ${Math.round(world.scrap)} scrap on hand`;

  investSubEl.textContent = `Pay ${INVEST_COST} scrap now, collect more later. Longer terms pay a bigger multiple.`;
  btnInvestShort.disabled = world.scrap < INVEST_COST;
  btnInvestLong.disabled = world.scrap < INVEST_COST;
  const pending = state.investments;
  investPendingEl.innerHTML = pending.length === 0 ? 'No pending investments.' : pending.map(inv =>
    `<div class="chk">${inv.term === InvestmentTerm.Short ? 'Short-term' : 'Long-term'}: ${inv.cost} staked -> ${inv.payout} in ${Math.max(0, inv.matureTick - world.currentTick)} ticks</div>`
  ).join('');
}

function refreshGrants() {
  if (grantsEl.classList.contains('hidden')) return;
  renderGrants();
}

// ---------------------------------------------------------------- field contracts overlay (quests.js)
// Real-deadline, real-fail-state timed quests -- distinct from the Charter Contracts panel above
// (charters can never fail). Two grids: pending offers (Accept/Decline) and currently-active
// contracts (read-only progress). offerQuest() itself is a no-op past MAX_PENDING_OFFERS, so the
// "Request Contract" button below is safe to spam.
const questsEl = document.getElementById('quests');
const questsOffersGridEl = document.getElementById('quests-offers-grid');
const questsActiveGridEl = document.getElementById('quests-active-grid');
const questsSubEl = document.getElementById('quests-sub');

function toggleQuestsPanel(force) {
  const show = force != null ? force : questsEl.classList.contains('hidden');
  questsEl.classList.toggle('hidden', !show);
  document.getElementById('btn-quests').classList.toggle('active', show);
  if (show) renderQuests();
}
input.onToggleQuests = () => toggleQuestsPanel();
input.onCloseQuests = () => toggleQuestsPanel(false);

function questProgressText(q) {
  const ticksLeft = Math.max(0, (q.deadlineTick ?? 0) - world.currentTick);
  if (q.kind === QuestKind.SurviveNoLosses) return `${ticksLeft} ticks left, no losses so far`;
  return `${Math.max(0, Math.round(q.targetScrap - world.scrap))} scrap short, ${ticksLeft} ticks left`;
}

/** Full rebuild of both grids -- cheap (a handful of small cards, only while open), same
 *  "cheap enough not to diff" reasoning as renderGrants/renderResearch. */
function renderQuests() {
  const state = world.quests;
  questsOffersGridEl.innerHTML = '';
  for (const offer of state.offers) {
    const card = document.createElement('div');
    card.className = 'node';
    const expiresIn = Math.max(0, offer.offerExpiresAtTick - world.currentTick);
    card.innerHTML =
      `<div class="rname">${offer.label}</div>` +
      `<div class="badge">+${offer.reward} scrap if completed</div>` +
      `<div class="desc">${offer.desc}</div>` +
      `<div class="unlocks">Offer expires in ${expiresIn} ticks if not answered</div>` +
      `<div class="quest-actions"><button class="accept">Accept</button><button class="decline">Decline</button></div>`;
    card.querySelector('.accept').addEventListener('click', () => {
      const res = acceptQuest(world, offer.id);
      if (!res.ok) showToast(res.reason);
      renderQuests();
    });
    card.querySelector('.decline').addEventListener('click', () => {
      declineQuest(world, offer.id);
      renderQuests();
    });
    questsOffersGridEl.appendChild(card);
  }
  if (state.offers.length === 0) {
    questsOffersGridEl.innerHTML = '<div class="desc">No contracts currently offered.</div>';
  }

  questsActiveGridEl.innerHTML = '';
  for (const q of state.active) {
    const card = document.createElement('div');
    card.className = 'node';
    card.innerHTML =
      `<div class="rname">${q.label}</div>` +
      `<div class="badge">+${q.reward} scrap on success</div>` +
      `<div class="desc">${questProgressText(q)}</div>`;
    questsActiveGridEl.appendChild(card);
  }
  if (state.active.length === 0) {
    questsActiveGridEl.innerHTML = '<div class="desc">No active contracts.</div>';
  }

  questsSubEl.textContent = `${state.active.length} active &middot; ${state.offers.length} offered &middot; ${Math.round(world.scrap)} scrap on hand`;
}

function refreshQuests() {
  if (questsEl.classList.contains('hidden')) return;
  renderQuests();
}

// ---------------------------------------------------------------- fabrication / labor drones overlay (drones.js)
// One card per DRONE_CATEGORIES entry with a "Fabricate" button (spends scrap immediately, queues
// gestation -- see queueDroneFabrication's own doc comment for why), plus a live capacity readout
// and a plain list of drones/queue entries below the grid. Deliberately not gated on a Fabrication
// Bay's existence to hide the panel -- opening it with no Bay built yet is exactly how a player
// discovers they need one (queueDroneFabrication's own reason string surfaces that on click).
const dronesEl = document.getElementById('drones');
const dronesGridEl = document.getElementById('drones-grid');
const dronesSubEl = document.getElementById('drones-sub');
const dronesActiveEl = document.getElementById('drones-active');

function toggleDronesPanel(force) {
  const show = force != null ? force : dronesEl.classList.contains('hidden');
  dronesEl.classList.toggle('hidden', !show);
  document.getElementById('btn-drones').classList.toggle('active', show);
  if (show) renderDrones();
}
input.onToggleDrones = () => toggleDronesPanel();
input.onCloseDrones = () => toggleDronesPanel(false);

function renderDrones() {
  const cap = droneCapacity(world.structures);
  const used = droneSlotsUsed(world);
  dronesGridEl.innerHTML = '';
  for (const cat of DRONE_CATEGORIES) {
    const card = document.createElement('div');
    card.className = 'node';
    card.innerHTML =
      `<div class="rname">${WORK_CATEGORY_LABELS[cat]} Drone</div>` +
      `<div class="desc">Locked to ${WORK_CATEGORY_LABELS[cat]} for its whole lifetime. No hunger/rest/social/mood -- works this one job category autonomously, tirelessly.</div>` +
      `<button data-cat="${cat}">Fabricate (${DRONE_COST} scrap, ${DRONE_GESTATION_TICKS}t)</button>`;
    const btn = card.querySelector('button');
    btn.disabled = used >= cap || world.scrap < DRONE_COST;
    btn.addEventListener('click', () => {
      const reason = queueDroneFabrication(world, cat);
      if (reason) { showToast(reason); return; }
      showToast(`Queued a ${WORK_CATEGORY_LABELS[cat]} drone -- gestating`);
      renderDrones();
    });
    dronesGridEl.appendChild(card);
  }
  dronesSubEl.textContent = `${used} / ${cap} drone capacity used &middot; ${Math.round(world.scrap)} scrap on hand` +
    (cap === 0 ? ' -- build a Fabrication Bay to unlock capacity' : '');

  const rows = [];
  for (const order of world.droneFabricationQueue) {
    rows.push(`<div class="row"><span class="cat">${WORK_CATEGORY_LABELS[order.category]} (gestating)</span><span>${order.ticksRemaining}t left</span></div>`);
  }
  for (const drone of world.drones) {
    const status = drone.state === 'idle' ? 'idle' : drone.state === 'seeking' ? 'travelling' : drone.state === 'driving' ? 'hauling' : 'working';
    rows.push(`<div class="row"><span class="cat">${WORK_CATEGORY_LABELS[drone.category]} drone</span><span>${status}</span></div>`);
  }
  dronesActiveEl.innerHTML = rows.length ? rows.join('') : 'No drones fabricated yet.';
}

function refreshDrones() {
  if (dronesEl.classList.contains('hidden')) return;
  renderDrones();
}

// ---------------------------------------------------------------- coverage plans overlay (coverageplans.js)
// Same full-screen-overlay-with-a-toggle-button convention as every panel above. One card per
// COVERAGE_PLAN_ORDER entry (fixed 2): a one-time Buy button while unpurchased, then a live
// threshold readout ("N / threshold structures on fire") and a Call In button once owned, gated
// on isCallInReady the exact same way Research's button is gated on affordableNow.
const coverageEl = document.getElementById('coverage');
const coverageGridEl = document.getElementById('coverage-grid');
const coverageSubEl = document.getElementById('coverage-sub');

function toggleCoveragePlansPanel(force) {
  const show = force != null ? force : coverageEl.classList.contains('hidden');
  coverageEl.classList.toggle('hidden', !show);
  document.getElementById('btn-coverage').classList.toggle('active', show);
  if (show) renderCoveragePlans();
}
input.onToggleCoverage = () => toggleCoveragePlansPanel();
input.onCloseCoverage = () => toggleCoveragePlansPanel(false);

function renderCoveragePlans() {
  coverageGridEl.innerHTML = '';
  let ownedCount = 0;
  for (const kind of COVERAGE_PLAN_ORDER) {
    const def = COVERAGE_PLAN_DEFS[kind];
    const owned = isPlanActive(world, kind);
    if (owned) ownedCount++;
    const ready = owned && isCallInReady(world, kind);
    const current = callInLiveCount(world, kind);
    const card = document.createElement('div');
    card.className = 'node' + (owned ? (ready ? ' available' : ' done') : (world.scrap >= def.cost ? '' : ' blocked'));
    card.dataset.planId = kind;

    const discountLine = Object.entries(def.discounts).map(([k, pct]) => `${k} -${Math.round(pct * 100)}%`).join(', ');
    const badge = !owned ? `Not purchased -- ${def.cost} scrap` : ready ? 'Call-in ready' : 'Purchased -- call-in not ready';

    card.innerHTML =
      `<div class="rname">${def.label}</div>` +
      `<div class="badge">${badge}</div>` +
      `<div class="desc">Discounts: ${discountLine}</div>` +
      `<div class="desc">${def.callIn.label} -- ${def.callIn.description}</div>` +
      `<div class="badge cost-line">${current} / ${def.callIn.threshold} ${def.callIn.thresholdNoun}</div>`;

    if (!owned) {
      const btn = document.createElement('button');
      btn.textContent = `Buy Plan (${def.cost})`;
      btn.disabled = world.scrap < def.cost;
      btn.addEventListener('click', () => {
        if (!purchaseCoveragePlan(world, kind)) { showToast('Not enough scrap for this plan'); return; }
        showToast(`Purchased: ${def.label}`);
        renderCoveragePlans();
      });
      card.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.textContent = def.callIn.label;
      btn.disabled = !ready;
      btn.addEventListener('click', () => {
        if (!triggerCallIn(world, kind)) { showToast('Call-in not ready yet'); return; }
        showToast(`${def.callIn.label}: dispatched`);
        renderCoveragePlans();
      });
      card.appendChild(btn);
    }
    coverageGridEl.appendChild(card);
  }
  coverageSubEl.textContent = `${ownedCount} / ${COVERAGE_PLAN_ORDER.length} plans purchased &middot; ${Math.round(world.scrap)} scrap on hand`;
}

/** Live progress while the overlay stays open -- same "only redraw while visible" gate as the
 *  other refresh* functions. Full rebuild every call: only 2 cards, cheap, and the readiness gate
 *  needs to flip a button's disabled state live as fires/downed-counts change tick to tick. */
function refreshCoveragePlans() {
  if (coverageEl.classList.contains('hidden')) return;
  renderCoveragePlans();
}

// ---------------------------------------------------------------- work priorities panel
// RimWorld Work-tab-style grid: every living citizen (row) x jobs.js's 4 non-needs WorkCategory
// columns (Construction/Hauling/Harvesting/Animal Handling). Reached from the citizen inspector's
// button (index.html #insp-workprio-btn) rather than the topbar -- this is a per-citizen roster
// tool, not a colony-wide report like Finance/Research. Same full-screen-overlay convention as
// those two, just with its own toggle wired here instead of an input.js hotkey (no existing key
// slot fit, and the inspector button is a perfectly discoverable entry point).
const workprioEl = document.getElementById('workprio');
const workprioTableEl = document.getElementById('workprio-table');

function toggleWorkPriorities(force) {
  const show = force != null ? force : workprioEl.classList.contains('hidden');
  workprioEl.classList.toggle('hidden', !show);
  if (show) renderWorkPriorities();
}
document.getElementById('insp-workprio-btn').addEventListener('click', () => toggleWorkPriorities());
document.getElementById('btn-workprio-close').addEventListener('click', () => toggleWorkPriorities(false));

// Rank Up (ranks.js) -- single-selection only, same convention as Schedule/Restrict Area/weapon
// tier below. canRankUp's gate is re-checked inside tryRankUp itself (not just trusted from the
// last inspector paint), so a stale button state from a mid-tick UI refresh can't spend scrap
// without actually clearing every requirement.
document.getElementById('insp-rankup-btn').addEventListener('click', () => {
  const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
  if (sel < 0 || !world.citizens.isAliveAt(sel)) return;
  const result = tryRankUp(world.citizens, sel, world);
  if (result.ok) showToast(`${world.citizens.name[sel]} promoted to ${result.rank.name}!`);
  updateInspector();
});

// Draft/undraft button (draft.js) -- shares toggleDraftSelection with the Shift+D hotkey, see
// that function's doc comment above.
document.getElementById('insp-draft-btn').addEventListener('click', () => toggleDraftSelection());

// Per-citizen Schedule override (schedule.js's ScheduleOverride) -- click-to-cycle
// None -> Sleep -> Work -> Recreation -> None. Single-selection only (mirrors the weapon-tier
// row and Work Priorities button, both of which also only ever act on one inspected citizen).
const SCHEDULE_OVERRIDE_CYCLE = [ScheduleOverride.None, ScheduleOverride.Sleep, ScheduleOverride.Work, ScheduleOverride.Recreation];
document.getElementById('insp-schedule-btn').addEventListener('click', () => {
  const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
  if (sel < 0 || sel >= world.citizens.count) return;
  const cur = world.citizens.scheduleOverride[sel];
  const idx = SCHEDULE_OVERRIDE_CYCLE.indexOf(cur);
  world.citizens.scheduleOverride[sel] = SCHEDULE_OVERRIDE_CYCLE[(idx + 1) % SCHEDULE_OVERRIDE_CYCLE.length];
  updateInspector();
});

// Allowed Area restriction (RimWorld Restrict-tab style, see input.js's 'restrict-area' tool /
// citizens.js's paintAllowedAreaCell). "Restrict Area" arms paint mode targeting whichever
// citizen is currently selected -- input.js reads input.selectedCitizen directly when painting,
// so this deliberately does NOT require re-selecting after entering paint mode. "Clear Area"
// removes the whole restriction and exits paint mode if it was active.
document.getElementById('insp-restrict-btn').addEventListener('click', () => {
  const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
  if (sel < 0 || sel >= world.citizens.count) return;
  input.setTool(input.tool === 'restrict-area' ? null : 'restrict-area');
  updateInspector();
  syncToolbarHighlight();
});
document.getElementById('insp-restrict-clear-btn').addEventListener('click', () => {
  const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
  if (sel < 0 || sel >= world.citizens.count) return;
  world.citizens.clearAllowedArea(sel);
  if (input.tool === 'restrict-area') { input.setTool(null); syncToolbarHighlight(); }
  updateInspector();
  showToast('Area restriction cleared');
});

// Corrupt/bribable staff (security.js): fires the currently-inspected citizen if (and only if)
// they've actually been caught -- updateInspector below is what shows/hides this button in the
// first place, so a click here always has a real discovered-corrupt id behind it.
document.getElementById('insp-fire-corrupt-btn').addEventListener('click', () => {
  const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
  if (sel < 0 || sel >= world.citizens.count) return;
  const citizenId = world.citizens.id[sel];
  const result = fireCorruptStaff(world, citizenId);
  if (result.ok) showToast(`Fired for corruption -- +${result.reward} scrap`);
});

// Vest purchase (world.js's buyVest / citizens.js's hasVest, siege.js's CITIZEN_VEST_ARMOR_RATING)
// -- the citizen-side counterpart to the manual weapon-tier row above, but a one-shot buy rather
// than a togglable tier since there's only one Vest, not a ladder. updateInspector below hides
// this once a citizen already has one.
document.getElementById('insp-buy-vest-btn')?.addEventListener('click', () => {
  const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
  if (sel < 0 || sel >= world.citizens.count) return;
  const citizenId = world.citizens.id[sel];
  const result = world.buyVest(citizenId);
  if (result.ok) { showToast('Vest equipped'); updateInspector(); }
  else if (result.reason === 'cost') showToast('Not enough scrap');
});

// Shield purchase (world.js's buyShield / citizens.js's hasShield) -- same one-shot-buy shape as
// the Vest button right above it, purchasable in addition to a Vest, not instead of it.
document.getElementById('insp-buy-shield-btn')?.addEventListener('click', () => {
  const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
  if (sel < 0 || sel >= world.citizens.count) return;
  const citizenId = world.citizens.id[sel];
  const result = world.buyShield(citizenId);
  if (result.ok) { showToast('Shield equipped'); updateInspector(); }
  else if (result.reason === 'cost') showToast('Not enough scrap');
});

// Upgraded K9 tier (security.js's upgradeDog/world.upgradeDog) -- only enabled/shown for a
// K9Handler with a real, not-yet-upgraded dog assigned, see updateInspector's insp-upgrade-dog-btn
// toggle below.
document.getElementById('insp-upgrade-dog-btn')?.addEventListener('click', () => {
  const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
  if (sel < 0 || sel >= world.citizens.count) return;
  const citizenId = world.citizens.id[sel];
  const result = world.upgradeDog(citizenId);
  if (result.ok) { showToast('K9 upgraded'); updateInspector(); }
  else if (result.reason === 'cost') showToast('Not enough scrap');
});

// Manual weapon-tier override buttons (security.js's StaffRoster.setManualWeapon/
// clearManualWeapon). Delegated on the row rather than one listener per tier button -- same
// pattern as the work-priority grid's per-cell clicks below, just a flat row instead of a grid.
document.getElementById('insp-weapon-row')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
  if (sel < 0 || sel >= world.citizens.count) return;
  const citizenId = world.citizens.id[sel];
  if (btn.id === 'insp-weapon-auto-btn') {
    world.roster.clearManualWeapon(citizenId);
  } else if (btn.dataset.tier) {
    world.roster.setManualWeapon(citizenId, btn.dataset.tier);
  } else {
    return;
  }
  updateInspector();
});

const WORKPRIO_CYCLE_MAX = 4; // priority tiers 1-4 (RimWorld's real Work-tab granularity), plus 0 (Off)

/** Full rebuild of the citizen x category grid. Only ever called while the overlay is open
 *  (toggleWorkPriorities/the per-cell click handler below), so a rebuild-on-every-click is cheap
 *  enough -- same "no diffing needed, small enough list" reasoning as renderResearch. Highlights
 *  and scrolls to whichever citizen was actually selected/inspected when the panel was opened
 *  (see toggleWorkPriorities), so the panel visibly reads as "this specific colonist's priorities"
 *  rather than a disconnected colony-wide report -- per the user's explicit complaint that this
 *  didn't feel tied to the selected citizen. */
function renderWorkPriorities() {
  const c = world.citizens;
  const highlightIdx = (input.selectedCitizens && input.selectedCitizens.length === 1)
    ? input.selectedCitizens[0]
    : (input.selectedCitizen >= 0 ? input.selectedCitizen : -1);
  workprioTableEl.innerHTML = '';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Citizen</th>' +
    WORK_CATEGORY_ORDER.map(cat => `<th>${WORK_CATEGORY_LABELS[cat]}</th>`).join('') +
    '<th></th></tr>';
  workprioTableEl.appendChild(thead);

  const tbody = document.createElement('tbody');
  let anyRows = false;
  for (let i = 0; i < c.count; i++) {
    if (!c.isAliveAt(i)) continue;
    anyRows = true;
    const tr = document.createElement('tr');
    if (i === highlightIdx) tr.className = 'wp-row-selected';
    const role = world.roster.isStaff(c.id[i]) ? world.roster.kindOf(c.id[i]) : 'Citizen';
    const nameTd = document.createElement('td');
    nameTd.innerHTML = `<div class="wp-name">${c.name[i]}</div><div class="wp-role">${role}</div>`;
    tr.appendChild(nameTd);

    for (const cat of WORK_CATEGORY_ORDER) {
      const td = document.createElement('td');
      const cell = document.createElement('div');
      const field = WORK_CATEGORY_FIELD[cat];
      const custom = c.hasWorkPriorities[i] === 1;
      const value = c[field][i];
      cell.className = 'wp-cell ' + (!custom ? 'wp-default' : value === 0 ? 'wp-off' : `wp-p${value}`);
      cell.textContent = !custom ? 'Default' : value === 0 ? 'Off' : String(value);
      cell.title = !custom
        ? 'Not customized -- this citizen still follows the original autonomous priority order. Click to start customizing.'
        : value === 0 ? 'Off -- this citizen never does this job.' : `Priority ${value} (lower = higher priority).`;
      cell.addEventListener('click', () => {
        // First click on a still-Default citizen turns on their override (equal-tier defaults on
        // every OTHER category, see citizens.js's spawn(), so clicking one cell doesn't leave the
        // other three silently uninitialized) and starts the clicked cell's own cycle fresh at 1
        // -- otherwise the pre-seeded equal-tier default of 1 would make the very first click jump
        // straight to 2, which reads as broken against the documented Off -> 1 -> 2 -> 3 cycle.
        if (c.hasWorkPriorities[i] !== 1) {
          c.hasWorkPriorities[i] = 1;
          c[field][i] = 1;
        } else {
          c[field][i] = (c[field][i] + 1) % (WORKPRIO_CYCLE_MAX + 1);
        }
        renderWorkPriorities();
      });
      td.appendChild(cell);
      tr.appendChild(td);
    }

    const resetTd = document.createElement('td');
    if (c.hasWorkPriorities[i] === 1) {
      const resetBtn = document.createElement('button');
      resetBtn.className = 'wp-reset';
      resetBtn.textContent = 'Reset';
      resetBtn.title = 'Clear this citizen\'s overrides and go back to the default autonomous order.';
      resetBtn.addEventListener('click', () => {
        c.hasWorkPriorities[i] = 0;
        c.workPriorityConstruction[i] = 1; c.workPriorityProcessing[i] = 1; c.workPriorityHauling[i] = 1;
        c.workPriorityHarvesting[i] = 1; c.workPriorityAnimal[i] = 1;
        c.workPriorityCleaning[i] = 1;
        renderWorkPriorities();
      });
      resetTd.appendChild(resetBtn);
    }
    tr.appendChild(resetTd);
    tbody.appendChild(tr);
  }
  workprioTableEl.appendChild(tbody);
  if (!anyRows) {
    const empty = document.createElement('div');
    empty.className = 'wp-empty';
    empty.textContent = 'No living citizens.';
    workprioTableEl.appendChild(empty);
  }
  if (highlightIdx >= 0) {
    const selectedRow = workprioTableEl.querySelector('.wp-row-selected');
    if (selectedRow) selectedRow.scrollIntoView({ block: 'center' });
  }
}

// ---------------------------------------------------------------- onboarding (tutorial.js)
// The guided tour and the reference panel own all of their own DOM/controls; main.js only has to
// bind the topbar button + hotkey and trigger the tour from the new-game path (see beginSettlement).
initOnboarding();
document.getElementById('btn-help').addEventListener('click', () => toggleHelp());
input.onToggleHelp = () => toggleHelp();

/** Full rebuild of the node grid. ~13 cards, only while the overlay is open -- cheap enough that
 *  diffing isn't worth it, but the live progress refresh below mutates in place so a rebuild on a
 *  timer can't destroy a "Research" button mid-click (same reasoning as renderWorldMap). */
function renderResearch() {
  const state = world.research;
  researchGridEl.innerHTML = '';
  for (const node of RESEARCH_NODES) {
    const done = isNodeUnlocked(state, node.id);
    const blocked = done ? null : researchBlockedReason(state, node);
    const affordableNow = !done && blocked === null;
    const card = document.createElement('div');
    card.className = 'node' + (done ? ' done' : affordableNow ? ' available' : ' blocked');
    card.dataset.nodeId = node.id;

    const badge = done ? (node.cost === 0 ? 'Innate' : 'Researched')
      : affordableNow ? 'Ready to research' : blocked;
    const pct = done ? 100 : node.cost === 0 ? 100 : Math.min(100, (state.points / node.cost) * 100);

    card.innerHTML =
      `<div class="rname">${node.name}</div>` +
      `<div class="badge">${badge}</div>` +
      `<div class="desc">${node.desc}</div>` +
      (node.cost > 0
        ? `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>` +
          `<div class="badge cost-line">${Math.floor(Math.min(state.points, node.cost))} / ${node.cost} pts</div>`
        : '') +
      `<div class="unlocks">Unlocks: ${node.unlocks.join(', ')}</div>`;

    if (!done) {
      const btn = document.createElement('button');
      btn.textContent = `Research (${node.cost})`;
      btn.disabled = !affordableNow;
      btn.addEventListener('click', () => {
        const res = tryResearch(world.research, node.id);
        if (!res.ok) { showToast(res.reason); return; }
        showToast(`Researched: ${node.name}`);
        world.milestoneLog.push({ tick: world.currentTick, text: `Research complete: ${node.name}` });
        if (world.milestoneLog.length > 20) world.milestoneLog.shift();
        checkResearchAchievements(world.research, RESEARCH_NODES);
        renderResearch();
      });
      card.appendChild(btn);
    }
    researchGridEl.appendChild(card);
  }
  const doneCount = RESEARCH_NODES.filter(n => isNodeUnlocked(world.research, n.id)).length;
  const techTier = colonyTechLevelFromState(world.research);
  researchSubEl.textContent =
    `${Math.floor(world.research.points)} research points banked · ` +
    `${doneCount} of ${RESEARCH_NODES.length} technologies known · ` +
    `Tech Level: ${TECH_LEVEL_NAMES[techTier] || techTier}`;
}

// Live progress while the overlay stays open. Structural rebuild only when the unlocked set
// actually changes, so the in-flight "Research" buttons survive.
let lastResearchSignature = '';
function refreshResearchValues() {
  if (researchEl.classList.contains('hidden')) return;
  const sig = RESEARCH_NODES.map(n => (isNodeUnlocked(world.research, n.id) ? '1' : '0')).join('');
  if (sig !== lastResearchSignature) { lastResearchSignature = sig; renderResearch(); return; }
  const state = world.research;
  researchSubEl.firstChild && (researchSubEl.textContent =
    `${Math.floor(state.points)} research points banked · ` +
    `${RESEARCH_NODES.filter(n => isNodeUnlocked(state, n.id)).length} of ${RESEARCH_NODES.length} technologies known · ` +
    `Tech Level: ${TECH_LEVEL_NAMES[colonyTechLevelFromState(state)] || colonyTechLevelFromState(state)}`);
  for (const card of researchGridEl.children) {
    const node = RESEARCH_NODES.find(n => n.id === card.dataset.nodeId);
    if (!node || node.cost === 0 || isNodeUnlocked(state, node.id)) continue;
    const fill = card.querySelector('.bar-fill');
    if (fill) fill.style.width = Math.min(100, (state.points / node.cost) * 100) + '%';
    const costLine = card.querySelector('.cost-line');
    if (costLine) costLine.textContent = `${Math.floor(Math.min(state.points, node.cost))} / ${node.cost} pts`;
    const btn = card.querySelector('button');
    if (btn) btn.disabled = researchBlockedReason(state, node) !== null;
  }
}

/** Rebuild the region grid. Cheap enough (16 cards) to redraw wholesale rather than diff, and
 *  it only runs while the overlay is actually open. */
function renderWorldMap() {
  worldmapGridEl.innerHTML = '';
  for (const r of worldMap.regions) {
    const isActive = r.id === worldMap.activeId;
    const expandable = worldMap.isExpandable(r.id);
    const card = document.createElement('div');
    card.className = 'region' +
      (isActive ? ' active' : '') + (r.owned ? ' owned' : '') +
      (expandable ? ' expandable' : '') +
      (!isActive && !r.owned && !expandable && !r.visited ? ' locked' : '');
    card.dataset.regionId = String(r.id);

    const badge = isActive ? 'Active Settlement'
      : r.owned ? 'Held'
      : expandable ? 'Adjacent'
      : r.visited ? 'Abandoned' : 'Out of reach';
    const pct = Math.round(r.control);
    const s = r.snapshot;
    const snapText = s
      ? `${s.citizens} citizens · ${s.waves} waves · ${s.scrap} scrap${s.fallen ? ' · fallen' : ''}`
      : 'No survey data';

    card.innerHTML =
      `<div class="rname">${r.name}</div>` +
      `<div class="badge">${badge}</div>` +
      `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>` +
      `<div class="pct"><span>Control</span><span>${pct}%</span></div>` +
      `<div class="snap">${snapText}</div>`;

    if (expandable) {
      const btn = document.createElement('button');
      btn.textContent = 'Expand here';
      btn.addEventListener('click', () => expandTo(r.id));
      card.appendChild(btn);
    }
    worldmapGridEl.appendChild(card);
  }
  const held = worldMap.ownedCount();
  const active = worldMap.active;
  const shipping = held - (active.owned ? 1 : 0);
  worldmapSubEl.textContent =
    `${held} of ${worldMap.regions.length} regions held · currently running ${active.name} ` +
    `(${Math.round(active.control)}% control)` +
    (shipping > 0 ? ` · ${shipping} allied settlement${shipping > 1 ? 's' : ''} shipping scrap in` : '');
  refreshRangeRow();
}

/** Move the operation: bank what we've got here, then stand up a FRESH SimWorld in the new
 *  region (new seed, same starting-citizen setup as any new settlement). The player is
 *  relocating, not managing two live sims. */
function expandTo(regionId) {
  worldMap.bankActive(world);
  // setActive() charges EXPANSION_FUEL_COST scrap against the settlement being left (mirrors a
  // real gravship needing chemfuel already banked before it'll launch) and refuses the move if
  // it's short -- give the player the real reason rather than a generic failure toast.
  if (!worldMap.isExpandable(regionId)) { showToast('Cannot expand there'); return; }
  if (world.scrap < EXPANSION_FUEL_COST) {
    showToast(`Not enough scrap to launch the expedition (need ${EXPANSION_FUEL_COST})`);
    return;
  }
  if (!worldMap.setActive(regionId, world)) { showToast('Cannot expand there'); return; }
  const seed = Math.floor(Math.random() * 0xffffffff);
  // Same settings the player picked for this campaign (map size, aggression, storyteller) --
  // only the seed and the region change. startGame() does the camera/selection/log resets.
  startGame(makeWorld({ ...lastNewGameConfig, seed }));
  world.milestoneLog.push({ tick: 0, text: `Expedition established in ${worldMap.active.name}` });
  showToast(`Expanded to ${worldMap.active.name}`);
  console.log(`[WorldMap] Expanded to ${worldMap.active.name} (region ${regionId}), seed ${seed}.`);
  // Apply the arrival mishap (if any) rolled by setActive() to the FRESH settlement -- worldmap.js
  // can't do this itself (no world.js import, avoids a circular import), so the caller applies it
  // once the new world actually exists. See worldmap.js's setActive()/rollArrivalMishap() comments.
  const mishap = worldMap.pendingMishap;
  worldMap.pendingMishap = null;
  if (mishap?.kind === 'scrapLoss') {
    world.scrap = Math.max(0, world.scrap - mishap.amount);
    world.milestoneLog.push({ tick: 0, text: `Rough landing: lost ${mishap.amount} scrap in transit` });
    showToast(`Mishap: lost ${mishap.amount} scrap on arrival`);
  } else if (mishap?.kind === 'debuff') {
    world.arrivalMishapTicks = mishap.ticks;
    world.milestoneLog.push({ tick: 0, text: 'Rough landing: crew shaken, work is slower for a while' });
    showToast('Mishap: crew shaken, work speed reduced temporarily');
  }
  renderWorldMap();
}

// While the overlay is open the sim keeps running behind it, so the meters need to move. This
// mutates the existing cards in place rather than re-running renderWorldMap() -- a full rebuild
// on a timer would destroy the "Expand here" button mid-click. A structural rebuild only happens
// when the owned-region set actually changes.
let lastOwnedSignature = '';
function refreshWorldMapValues() {
  if (worldmapEl.classList.contains('hidden')) return;
  const sig = worldMap.regions.map(r => (r.owned ? '1' : '0')).join('');
  if (sig !== lastOwnedSignature) { lastOwnedSignature = sig; renderWorldMap(); return; }
  for (const card of worldmapGridEl.children) {
    const r = worldMap.byId(Number(card.dataset.regionId));
    if (!r) continue;
    const pct = Math.round(r.control);
    card.querySelector('.bar-fill').style.width = pct + '%';
    card.querySelector('.pct').lastElementChild.textContent = pct + '%';
    if (r.snapshot) {
      const s = r.snapshot;
      card.querySelector('.snap').textContent =
        `${s.citizens} citizens · ${s.waves} waves · ${s.scrap} scrap${s.fallen ? ' · fallen' : ''}`;
    }
  }
  refreshRangeRow();
}

window.addEventListener('keydown', (e) => {
  // Never while the title screen is up: F5/F9/R would either no-op noisily or (in R's case)
  // silently start a game behind the menu. Also never while the player is typing into the setup
  // form's seed box -- 'r' is a legal character to type, not a restart request.
  if (!world || isTypingTarget(e.target)) return;
  if (e.key === 'F5') { e.preventDefault(); save(); }
  if (e.key === 'F9') { e.preventDefault(); confirmedLoad(); }
  if (e.key === 'r' || e.key === 'R') { confirmRestart(); }
});

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// ---------------------------------------------------------------- finance / budget report overlay
// DOM rows for the category breakdown (same reasoning as the world-map overlay above -- it's
// pure UI, not part of the game world's coordinate space), plus a small inline Canvas 2D
// sparkline (render.js's drawFinanceChart) for the rolling net-scrap-per-wave-cycle trend.
const financeEl = document.getElementById('finance');
const financeRowsEl = document.getElementById('finance-rows');
const financeSubEl = document.getElementById('finance-sub');
const financeChartRangeEl = document.getElementById('finance-chart-range');
const financeChartEl = document.getElementById('finance-chart');

function toggleFinance(force) {
  const show = force != null ? force : financeEl.classList.contains('hidden');
  financeEl.classList.toggle('hidden', !show);
  document.getElementById('btn-finance').classList.toggle('active', show);
  if (show) renderFinance();
}

const FINANCE_CATEGORIES = [
  ['killScrap', '☠ Kills (turrets/staff/traps/dogs)', 'income'],
  ['harvestScrap', '⛏ Harvesting', 'income'],
  ['haulScrap', '🚚 Vehicle hauls', 'income'],
  ['recyclingScrap', '♻ Recycling Center', 'income'],
  ['farmScrap', '🌾 Farm Plots', 'income'],
  ['conquestScrap', '🗺 Conquest supply lines', 'income'],
  ['factionScrap', '🤝 Clique demands', 'income'],
  ['grantScrap', '📜 Charter contracts & investments', 'income'],
  ['powerExportScrap', '⚡ Power Exporter trickle', 'income'],
  ['otherScrap', '❓ Other', 'income'],
  ['buildSpend', '🔨 Construction spend', 'expense'],
  ['corruptionLoss', '🕵 Corrupt-staff diversion', 'expense'],
  ['ratLoss', '🐀 Rat/vermin theft', 'expense'],
  ['factionLoss', '🤝 Clique demand losses', 'expense'],
  ['wageCost', '💰 Ranked staff wages', 'expense'],
];

/** Rebuild the category rows + redraw the chart. Cheap enough (7 rows, one small canvas) to
 *  redraw wholesale on every open/refresh rather than diff, and it only runs while the overlay
 *  is actually open (see refreshFinance below). */
function renderFinance() {
  const f = world.finance;
  if (!f) return;
  // Summed from FINANCE_CATEGORIES' own 'income' rows rather than hardcoding each key -- keeps
  // this total correct automatically as categories get added (factionScrap, see factions.js).
  const totalIncome = FINANCE_CATEGORIES.filter(([, , cls]) => cls === 'income').reduce((sum, [key]) => sum + f[key], 0);
  const totalExpense = FINANCE_CATEGORIES.filter(([, , cls]) => cls === 'expense').reduce((sum, [key]) => sum + f[key], 0);
  financeRowsEl.innerHTML = FINANCE_CATEGORIES.map(([key, label, cls]) =>
    `<div class="fin-row"><span class="label">${label}</span><span class="val ${cls}">${cls === 'expense' ? '-' : '+'}${Math.round(f[key])}</span></div>`
  ).join('') +
    `<div class="fin-row total"><span class="label">Net lifetime</span><span class="val ${totalIncome - totalExpense >= 0 ? 'income' : 'expense'}">` +
    `${Math.round(totalIncome - totalExpense)}</span></div>`;
  financeSubEl.textContent = `${Math.round(world.scrap)} scrap on hand · tick ${world.currentTick}`;
  const h = f.history;
  financeChartRangeEl.textContent = h.length > 0 ? `tick ${h[0].tick} - ${h[h.length - 1].tick}` : '';
  renderer.drawFinanceChart(world, financeChartEl);
}

// While the overlay is open the sim keeps running behind it, so the numbers need to move --
// same "only redraw while visible" gate as refreshWorldMapValues above.
function refreshFinance() {
  if (financeEl.classList.contains('hidden')) return;
  renderFinance();
}

// ---------------------------------------------------------------- inspector panel
const inspectorEl = document.getElementById('inspector');
function updateInspector() {
  // Marquee multi-select (see input.js InputController._onUp): still mostly an aggregate info
  // view (group averages + a name list) rather than per-citizen detail, but draft.js's command
  // system DOES apply group-wide here -- the draft button below drafts/undrafts the whole
  // selection together, and a drafted multi-select's right-click move/attack orders (input.js's
  // _tryIssueOrder) go to every drafted citizen in it at once.
  if (input.selectedCitizens && input.selectedCitizens.length > 1) {
    updateInspectorMulti(input.selectedCitizens);
    return;
  }
  // A marquee that swept up exactly one citizen shows the normal single-citizen detail view.
  const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
  if (sel < 0 || sel >= world.citizens.count || !world.citizens.isAliveAt(sel)) {
    if (sel >= 0) { input.selectedCitizen = -1; input.selectedCitizens = []; }
    inspectorEl.classList.add('hidden');
    return;
  }
  inspectorEl.classList.remove('hidden');
  const c = world.citizens;
  const role = world.roster.isStaff(c.id[sel]) ? world.roster.kindOf(c.id[sel]) : 'Citizen';
  // Armory-issued weapon tier (security.js WEAPON_TIERS) -- only meaningful for Guard/Sniper,
  // who are the only roles tickStaffCombat (siege.js) reads it for.
  const weaponLabel = (role === 'Guard' || role === 'Sniper')
    ? ` [${WEAPON_TIERS[world.roster.weaponOf(c.id[sel])]?.label ?? 'Sidearm'}]`
    : '';
  document.getElementById('insp-name').textContent = c.name[sel];
  document.getElementById('insp-role').textContent = `${role}${weaponLabel} · ${c.trait[sel]?.name ?? ''}`;
  const backstory = c.backstory[sel];
  const backstoryEl = document.getElementById('insp-backstory');
  if (backstory) {
    backstoryEl.textContent = `${backstory.childhood} → ${backstory.adult}`;
    backstoryEl.title = backstory.description;
  } else {
    backstoryEl.textContent = '';
    backstoryEl.title = '';
  }
  const statusEl = document.getElementById('insp-status');
  const isDiscoveredCorrupt = world.roster.isCorruptDiscovered(c.id[sel]);
  const drafted = c.isDraftedAt(sel);
  if (isDiscoveredCorrupt) {
    statusEl.textContent = 'Caught diverting supplies -- fire them below for a reward';
  } else if (c.isDownedAt(sel)) {
    statusEl.textContent = 'Downed';
  } else if (drafted) {
    // Order-progress readout (draft.js's orderKind) -- lets the player see at a glance whether a
    // drafted citizen is actively moving/fighting or just standing at attention awaiting an order.
    const ok = c.orderKind[sel];
    statusEl.textContent = ok === OrderKind.Move ? 'Drafted -- moving to order'
      : ok === OrderKind.Attack ? 'Drafted -- engaging target'
      : 'Drafted -- standing by (right-click a tile to move, right-click an attacker to engage)';
  } else if (c.isOnBreakAt(sel)) {
    statusEl.textContent = 'On Break (mood too low to work at full speed)';
  } else {
    statusEl.textContent = '';
  }
  document.getElementById('insp-fire-corrupt-btn').classList.toggle('hidden', !isDiscoveredCorrupt);
  // Vest purchase button (world.js's buyVest) -- hidden once already vested, same "one-shot
  // purchase, then disappears" convention as nothing else in this panel needing a fresh precedent.
  const buyVestBtn = document.getElementById('insp-buy-vest-btn');
  if (buyVestBtn) {
    const vested = c.isVestedAt(sel);
    buyVestBtn.classList.toggle('hidden', vested);
    buyVestBtn.textContent = `🛡️ Buy Vest (${buildCost(world, 'vest')} scrap)`;
  }
  // Shield purchase button (world.js's buyShield) -- same one-shot-purchase-then-disappears
  // convention as Buy Vest right above it.
  const buyShieldBtn = document.getElementById('insp-buy-shield-btn');
  if (buyShieldBtn) {
    const shielded = c.isShieldedAt(sel);
    buyShieldBtn.classList.toggle('hidden', shielded);
    buyShieldBtn.textContent = `🔷 Buy Shield (${buildCost(world, 'shield')} scrap)`;
  }
  // Upgraded K9 tier -- only meaningful for a K9Handler who actually has a dog assigned (should
  // always be true given security.js's assignDogHandler wires both sides together, but a dog
  // could in principle be missing on an old/hand-edited save, hence the explicit find() check
  // rather than assuming one exists). Hidden entirely once already upgraded, same one-shot-
  // purchase convention as the Vest button above.
  const upgradeDogBtn = document.getElementById('insp-upgrade-dog-btn');
  if (upgradeDogBtn) {
    const dog = role === 'K9Handler' ? world.dogs.find(d => d.ownerId === c.id[sel]) : null;
    upgradeDogBtn.classList.toggle('hidden', !dog || dog.upgraded);
    if (dog) upgradeDogBtn.textContent = `🐕 Upgrade K9 (${K9_UPGRADE_SCRAP_COST} scrap)`;
  }
  const draftBtn = document.getElementById('insp-draft-btn');
  draftBtn.textContent = drafted ? '🎯 Undraft' : '🎯 Draft';
  draftBtn.classList.toggle('active', drafted);
  // Per-citizen Schedule override (schedule.js) -- button label always names the CURRENT setting
  // (same "no separate description line" convention as the draft button above), and .active
  // marks any real override (colors it) so a glance at the panel shows whether this citizen is
  // pinned off the colony-wide cycle.
  const scheduleBtn = document.getElementById('insp-schedule-btn');
  scheduleBtn.classList.remove('hidden');
  const scheduleVal = c.scheduleOverride[sel];
  scheduleBtn.textContent = `🕒 Schedule: ${SCHEDULE_OVERRIDE_LABELS[scheduleVal] ?? 'Colony schedule'}`;
  scheduleBtn.classList.toggle('active', scheduleVal !== ScheduleOverride.None);
  // Allowed Area restriction (citizens.js's hasAllowedArea) -- "Clear Area" only shows once a
  // restriction actually exists, and the "Restrict Area" button highlights while its paint mode
  // is the currently-armed tool so the player can see they're mid-paint.
  const restrictBtn = document.getElementById('insp-restrict-btn');
  restrictBtn.parentElement?.classList.remove('hidden');
  const hasArea = c.hasAllowedArea(sel);
  restrictBtn.classList.toggle('active', input.tool === 'restrict-area');
  document.getElementById('insp-restrict-clear-btn').classList.toggle('hidden', !hasArea);
  setBar('hp', c.health[sel]);
  setBar('hunger', c.hunger[sel]);
  setBar('rest', c.rest[sel]);
  setBar('social', c.social[sel]);
  setBar('hydration', c.hydration[sel]);
  setBar('mood', c.mood[sel]);
  // Per-citizen unrest-contribution score (citizens.js's computeCitizenUnrestScore, Prison
  // Architect dynamicRep.txt-style) -- 0-100 like every other bar here, distinct from the
  // colony-wide unrestLevel shown in the topbar. Surfaces which specific citizen is closest to
  // "flipping" so the player has something concrete to target.
  setBar('unrest', computeCitizenUnrestScore(c, sel, world) / 100);
  document.getElementById('insp-skill').textContent =
    `Combat: ${skillLevel(c.skillCombat[sel])}${PASSION_ICON[c.passionCombat[sel]]} · ` +
    `Construction: ${skillLevel(c.skillConstruction[sel])}${PASSION_ICON[c.passionConstruction[sel]]}`;
  updateInspectorRank(sel);
  renderInspectorAugments(sel);
  updateInspectorWeapon(c.id[sel], role);
  updateInspectorRoom(c.x[sel], c.y[sel]);
}

// Citizen Rank (ranks.js). Shows the current rank name + accumulated skill (skillConstruction +
// skillCombat, ranks.js's combined "favor" stat) against the next tier's requirement, and enables
// the Rank Up button only when canRankUp() clears every gate (skill threshold, scrap cost, and --
// from tier 3 up -- a room-impressiveness "veteran's quarters" requirement). The button's title
// always names the specific unmet requirement rather than just disabling silently, so a player who
// hovers a grayed-out button can tell what's actually missing.
function updateInspectorRank(sel) {
  const c = world.citizens;
  const rank = rankOf(c, sel);
  const rankLineEl = document.getElementById('insp-rank-line');
  const rankBtn = document.getElementById('insp-rankup-btn');
  const check = canRankUp(c, sel, world);
  const isMax = c.citizenRank[sel] >= RANKS.length - 1;
  rankLineEl.textContent = isMax
    ? `Rank: ${rank.name} (maximum)`
    : `Rank: ${rank.name} -> ${RANKS[c.citizenRank[sel] + 1].name}`;
  rankBtn.classList.toggle('hidden', isMax);
  if (!isMax) {
    rankBtn.disabled = !check.ok;
    rankBtn.title = check.ok
      ? `Rank up to ${check.rank.name} for ${check.rank.scrapCost} scrap -- +${Math.round((check.rank.workSpeedMult - 1) * 100)}% work speed, +${Math.round((check.rank.healthMult - 1) * 100)}% health.`
      : `Rank Up: ${check.reason}`;
  }
}

// Scavenged Augments (augments.js -- see that file's header for how this is distinct from Rank
// above: PURCHASED with scrap, no skill gate, and every one carries a real permanent tradeoff
// alongside its upside). One row per AUGMENTS entry, always showing the full cost/upside/tradeoff
// readout so the player can see exactly what they're buying before they buy it, same "always show
// why" convention as updateInspectorRank above. An already-installed augment's row dims and hides
// its Purchase button; otherwise the button disables (with a title explaining exactly why) once
// canBuyAugment fails any gate -- unaffordable or the slot cap is already full.
function renderInspectorAugments(sel) {
  const c = world.citizens;
  const listEl = document.getElementById('insp-augments-list');
  const summaryEl = document.getElementById('insp-augments-summary');
  if (!listEl || !summaryEl) return;
  const count = augmentCountFor(c, sel);
  summaryEl.textContent = `Installed: ${count} / ${AUGMENT_SLOT_CAP} slots`;
  listEl.innerHTML = '';
  for (const def of AUGMENTS) {
    const installed = hasAugment(c, sel, def.id);
    const check = canBuyAugment(c, sel, def.id, world);
    const row = document.createElement('div');
    row.className = 'aug-row' + (installed ? ' installed' : '');
    const cost = buildCost(world, def.costKind);
    const head = document.createElement('div');
    head.className = 'aug-row-head';
    head.innerHTML = `<span>${def.name}</span><span>${installed ? 'Installed' : cost + ' scrap'}</span>`;
    row.appendChild(head);
    const upside = document.createElement('div');
    upside.className = 'aug-row-upside';
    upside.textContent = `+ ${def.upsideText}`;
    row.appendChild(upside);
    const tradeoff = document.createElement('div');
    tradeoff.className = 'aug-row-tradeoff';
    tradeoff.textContent = `- ${def.tradeoffText}`;
    row.appendChild(tradeoff);
    if (!installed) {
      const btn = document.createElement('button');
      btn.textContent = 'Install';
      btn.disabled = !check.ok;
      btn.title = check.ok ? `Install ${def.name} for ${cost} scrap.` : check.reason;
      btn.addEventListener('click', () => {
        const result = world.buyAugment(c.id[sel], def.id);
        if (result.ok) showToast(`${c.name[sel]} fitted with ${result.def.name}`);
        renderInspectorAugments(sel);
      });
      row.appendChild(btn);
    }
    listEl.appendChild(row);
  }
}

// Manual weapon-tier override (RimWorld-style "player picks this one's gear" -- security.js's
// StaffRoster.setManualWeapon/clearManualWeapon, tickArmoryIssuance honors it every tick). Only
// shown for Guard/Sniper, the only roles WEAPON_TIERS actually affects (siege.js's
// tickStaffCombat). A button per tier, highlighting whichever is currently equipped; clicking a
// tier the armory doesn't stock yet still sets the override (queued -- see tickArmoryIssuance's
// doc comment) and this readout shows "(queued)" until enough Armories exist to actually issue it.
const insWeaponRow = document.getElementById('insp-weapon-row');
const insWeaponButtons = insWeaponRow ? Array.from(insWeaponRow.querySelectorAll('button[data-tier]')) : [];
function updateInspectorWeapon(citizenId, role) {
  if (!insWeaponRow) return;
  if (role !== 'Guard' && role !== 'Sniper') {
    insWeaponRow.classList.add('hidden');
    return;
  }
  insWeaponRow.classList.remove('hidden');
  const equipped = world.roster.weaponOf(citizenId);
  const manual = world.roster.manualWeaponOf(citizenId);
  const pending = world.roster.isManualWeaponPending(citizenId);
  for (const btn of insWeaponButtons) {
    const tier = btn.dataset.tier;
    const isEquipped = tier === equipped;
    const isRequested = manual != null && tier === manual;
    btn.classList.toggle('active', isRequested ? true : (manual == null && isEquipped));
    btn.classList.toggle('queued', isRequested && pending);
    btn.textContent = (isRequested && pending) ? `${WEAPON_TIERS[tier].label} (queued)` : WEAPON_TIERS[tier].label;
  }
  const autoBtn = document.getElementById('insp-weapon-auto-btn');
  if (autoBtn) autoBtn.classList.toggle('active', manual == null);
}

// RimWorld-style flavor labels (rooms.js's impressivenessLabel/beautyLabel/cleanlinessLabel) next
// to the existing raw .beauty/.cleanliness/.impressiveness numbers -- cosmetic text only, the
// numbers stay so nothing is lost. Cleanliness and Impressiveness are genuine clamp01'd 0-1
// values (see rooms.js's computeRoomStats doc comment) so they get real inline bar-fills like
// every other 0-1 stat in this panel; Beauty is a raw unbounded sum (same doc comment, roughly
// -6..+15+), not a 0-1 range, so it stays a number+label line rather than a misleading bar.
// Reused by both the single-citizen inspector above (whichever room the selected citizen
// currently stands in) and nothing else yet -- there's no separate tile/structure inspector in
// this game to hook a second call site into.
function updateInspectorRoom(x, y) {
  const roleEl = document.getElementById('insp-room-role');
  const cleanRow = document.getElementById('insp-clean-row');
  const impressRow = document.getElementById('insp-impress-row');
  const beautyEl = document.getElementById('insp-beauty');
  const room = roomContaining(world.rooms, world.grid, x, y);
  if (!room) {
    roleEl.textContent = 'Not in an enclosed room';
    cleanRow.classList.add('hidden');
    impressRow.classList.add('hidden');
    beautyEl.textContent = '';
    return;
  }
  // world.js runs computeRoomStats() BEFORE the wall-signature check that (re)builds this.rooms
  // via detectRooms -- so a room detected fresh this very tick hasn't had its .beauty/.cleanliness/
  // .impressiveness populated yet and won't until next tick. Rare (one tick right after a wall
  // completes an enclosure) but real, so this guards rather than throwing on undefined.toFixed().
  if (room.beauty == null || room.cleanliness == null || room.impressiveness == null) {
    roleEl.textContent = 'Room stats settling...';
    cleanRow.classList.add('hidden');
    impressRow.classList.add('hidden');
    beautyEl.textContent = '';
    return;
  }
  const roleLabel = ROOM_ROLE_LABEL[room.role] ?? 'Unroofed Area';
  roleEl.textContent = roleLabel;
  cleanRow.classList.remove('hidden');
  impressRow.classList.remove('hidden');
  setBar('clean', room.cleanliness);
  setBar('impress', room.impressiveness);
  document.getElementById('insp-clean-pct').textContent = `${cleanlinessLabel(room.cleanliness)} (${Math.round(room.cleanliness * 100)}%)`;
  document.getElementById('insp-impress-pct').textContent = `${impressivenessLabel(room.impressiveness)} (${Math.round(room.impressiveness * 100)}%)`;
  beautyEl.textContent = `Beauty ${room.beauty.toFixed(1)} (${beautyLabel(room.beauty)})`;
}

function updateInspectorMulti(indices) {
  const c = world.citizens;
  const alive = indices.filter(i => i >= 0 && i < c.count && c.isAliveAt(i));
  if (alive.length === 0) {
    input.selectedCitizens = [];
    inspectorEl.classList.add('hidden');
    return;
  }
  inspectorEl.classList.remove('hidden');
  document.getElementById('insp-name').textContent = `${alive.length} citizens selected`;
  const names = alive.slice(0, 5).map(i => c.name[i]).join(', ');
  document.getElementById('insp-role').textContent = names + (alive.length > 5 ? `, +${alive.length - 5} more` : '');
  document.getElementById('insp-backstory').textContent = '';
  const draftedCount = alive.filter(i => c.isDraftedAt(i)).length;
  document.getElementById('insp-status').textContent = draftedCount > 0
    ? `${draftedCount}/${alive.length} drafted -- Group averages below`
    : 'Group averages below';
  document.getElementById('insp-fire-corrupt-btn').classList.add('hidden'); // no per-citizen action in a multi-select, see this function's own header comment above
  document.getElementById('insp-buy-vest-btn')?.classList.add('hidden'); // same per-citizen-only reasoning as the corrupt-fire button above
  document.getElementById('insp-weapon-row')?.classList.add('hidden'); // per-citizen weapon override, same reasoning as the corrupt-fire button above
  // Schedule override / Allowed Area are both single-citizen concepts (one override value, one
  // area mask per citizen) -- hidden in a multi-select rather than guessing which citizen a click
  // should act on, same reasoning as the weapon-tier row above.
  document.getElementById('insp-schedule-btn')?.classList.add('hidden');
  document.getElementById('insp-restrict-btn')?.parentElement?.classList.add('hidden');
  // Draft button in a multi-select: same "unify to majority action" toggle as toggleDraftSelection
  // itself -- shows Draft (about to draft everyone not yet drafted) unless the WHOLE selection is
  // already drafted, in which case it shows Undraft.
  const allDrafted = alive.length > 0 && draftedCount === alive.length;
  const draftBtnMulti = document.getElementById('insp-draft-btn');
  draftBtnMulti.textContent = allDrafted ? '🎯 Undraft' : '🎯 Draft';
  draftBtnMulti.classList.toggle('active', allDrafted);
  const avg = (arr) => alive.reduce((s, i) => s + arr[i], 0) / alive.length;
  setBar('hp', avg(c.health));
  setBar('hunger', avg(c.hunger));
  setBar('rest', avg(c.rest));
  setBar('social', avg(c.social));
  setBar('hydration', avg(c.hydration));
  setBar('mood', avg(c.mood));
  setBar('unrest', alive.reduce((s, i) => s + computeCitizenUnrestScore(c, i, world), 0) / alive.length / 100);
  document.getElementById('insp-skill').textContent = '';
  // Rank Up is a single-citizen action (one rank-up target, one scrap spend) -- hidden in a
  // multi-select rather than guessing which citizen a click should act on, same reasoning as the
  // weapon-tier row / Schedule / Restrict Area controls above.
  document.getElementById('insp-rank-line').textContent = '';
  document.getElementById('insp-rankup-btn').classList.add('hidden');
  // Augments are also a single-citizen purchase (one slot cap, one scrap spend) -- same
  // "select one citizen" reasoning as Rank Up above.
  document.getElementById('insp-augments-summary').textContent = 'Select one citizen to view/install augments';
  document.getElementById('insp-augments-list').innerHTML = '';
  document.getElementById('insp-room-role').textContent = 'Group averages -- select one citizen for room detail';
  document.getElementById('insp-clean-row').classList.add('hidden');
  document.getElementById('insp-impress-row').classList.add('hidden');
  document.getElementById('insp-beauty').textContent = '';
}

// Raw skill floats are unbounded accrual values (see jobs.js/siege.js gain rates), not
// meaningful to a player as-is -- bucket them into RimWorld-style named tiers instead of
// showing the number directly.
const SKILL_LEVELS = [
  [0.15, 'Novice'], [0.5, 'Competent'], [1.2, 'Skilled'], [2.5, 'Expert'], [Infinity, 'Master'],
];
function skillLevel(value) {
  for (const [threshold, name] of SKILL_LEVELS) if (value < threshold) return name;
  return 'Master';
}

function setBar(name, frac) {
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  document.getElementById(`insp-${name}`).style.width = pct + '%';
  document.getElementById(`insp-${name}-pct`).textContent = pct + '%';
}

// ---------------------------------------------------------------- event log + game over
const eventlogEl = document.getElementById('eventlog');
let lastLoggedCount = 0;
function updateEventLog() {
  if (world.milestoneLog.length === lastLoggedCount) return;
  lastLoggedCount = world.milestoneLog.length;
  eventlogEl.innerHTML = world.milestoneLog.slice(-4).map(e => `<div class="entry">${e.text}</div>`).join('');
}

// ---------------------------------------------------------------- tainted-delivery banner
// supplies.js's player-facing "dispose of the bad batch" / "search and recover" objectives --
// same lightweight #banner-with-buttons shape as #achievement-toast, but conditionally visible
// (not a fire-and-forget toast) for as long as an action is actually available, since the player
// needs a real window to notice and act rather than a message that scrolls past.
const supplyAlertEl = document.getElementById('supply-alert');
const supplyAlertTextEl = document.getElementById('supply-alert-text');
const supplyInspectBtn = document.getElementById('supply-inspect-btn');
const supplySearchBtn = document.getElementById('supply-search-btn');
supplyInspectBtn?.addEventListener('click', () => {
  if (!world) return;
  world.inspectDelivery();
});
supplySearchBtn?.addEventListener('click', () => {
  if (!world) return;
  world.searchDelivery();
});
function updateSupplyAlert() {
  if (!supplyAlertEl) return;
  const inspectable = canInspectDelivery(world);
  const searchable = canSearchDelivery(world);
  supplyAlertEl.classList.toggle('hidden', !inspectable && !searchable);
  if (!inspectable && !searchable) return;
  supplyInspectBtn.classList.toggle('hidden', !inspectable);
  supplySearchBtn.classList.toggle('hidden', !searchable);
  supplyAlertTextEl.textContent = inspectable
    ? 'A recent supply delivery hasn’t been checked yet.'
    : 'The recent delivery went unchecked -- some supplies may be tainted.';
}

const gameoverEl = document.getElementById('gameover');
function updateGameOver() {
  if (!world.gameOver) { gameoverEl.classList.add('hidden'); return; }
  gameoverEl.classList.remove('hidden');
  document.getElementById('gameover-detail').textContent =
    `Survived ${world.waveSpawner.waveNumber} waves, tick ${world.currentTick}.`;
}

// ---------------------------------------------------------------- topbar stats
function updateTopbar() {
  document.getElementById('stat-scrap').textContent = Math.round(world.scrap);
  document.getElementById('stat-citizens').textContent = countAlive(world.citizens.count, world.citizens.isAliveAt.bind(world.citizens));
  document.getElementById('stat-attackers').textContent = countAlive(world.attackers.count, world.attackers.isAliveAt.bind(world.attackers));
  document.getElementById('stat-wave').textContent = world.waveSpawner.waveNumber;
  document.getElementById('stat-research').textContent = Math.floor(world.research.points);
  const pollutionEl = document.getElementById('stat-pollution');
  pollutionEl.textContent = Math.round(world.pollution);
  pollutionEl.classList.toggle('danger', world.pollution > 150);
  // Ammo (this session's ammo/suppression pass, see world.js's this.ammo/this.ammoCapacity and
  // security.js's tickAmmoProduction) -- danger-red once the stockpile drops below one Sniper
  // shot's worth (siege.js's AMMO_PER_SHOT_SNIPER = 2), the real "about to start seeing fallback
  // states" threshold, not an arbitrary percentage.
  const ammoEl = document.getElementById('stat-ammo');
  if (ammoEl) {
    ammoEl.textContent = `${Math.round(world.ammo)}/${Math.round(world.ammoCapacity)}`;
    ammoEl.classList.toggle('danger', world.ammo < 2);
  }
  // Unrest (world.js's UNREST_* / world.unrestLevel/unrestActive): stays out of the topbar
  // entirely on a healthy colony (kept hidden below a "starting to matter" floor) rather than
  // showing a 0%/1% reading all the time -- this is meant to read as a rare warning, not
  // background noise, matching the crisis-not-clutter brief.
  const unrestWrapEl = document.getElementById('stat-unrest-wrap');
  const unrestVisible = world.unrestActive || world.unrestLevel > 0.15;
  unrestWrapEl.classList.toggle('hidden', !unrestVisible);
  if (unrestVisible) {
    const unrestEl = document.getElementById('stat-unrest');
    unrestEl.textContent = Math.round(world.unrestLevel * 100) + '%';
    unrestEl.classList.toggle('danger', world.unrestActive);
  }
  const night = isNight(world.timeOfDay);
  setTopbarIcon('stat-daynight-icon', night ? 'night' : 'day', night ? 'Night' : 'Day');
  document.getElementById('stat-daynight').textContent = (night ? 'Night ' : 'Day ') + Math.round(world.timeOfDay * 100) + '%';
  setTopbarIcon('stat-weather-icon', WEATHER_ICON[world.weather] || 'weatherClear', world.weather);
  document.getElementById('stat-weather').textContent = world.weather;
  pauseBtn.textContent = world.paused ? '▶ Resume' : '⏸ Pause';
  pauseBtn.classList.toggle('active', world.paused);
  document.getElementById('speed-label').textContent = speedMultiplier + 'x';
}

function countAlive(count, isAliveAt) {
  let n = 0;
  for (let i = 0; i < count; i++) if (isAliveAt(i)) n++;
  return n;
}

// ---------------------------------------------------------------- settlement grading popover
function setGradingBar(name, value) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const fillEl = document.getElementById(`grading-${name}`);
  const pctEl = document.getElementById(`grading-${name}-pct`);
  fillEl.style.width = pct + '%';
  pctEl.textContent = pct;
  fillEl.classList.toggle('low', pct < 40);
  fillEl.classList.toggle('mid', pct >= 40 && pct < 70);
}

function updateGrading() {
  const g = world.grading;
  if (!g) return;
  const avg = Math.round((g.safety + g.wellbeing + g.sustainability + g.cohesion) / 4);
  document.getElementById('stat-grading').textContent = avg;
  // Bars only need updating while the popover is actually open -- same "don't bother while
  // hidden" pattern refreshWorldMapValues uses for the conquest overlay above.
  if (!gradingPopoverEl.classList.contains('hidden')) {
    setGradingBar('safety', g.safety);
    setGradingBar('wellbeing', g.wellbeing);
    setGradingBar('sustainability', g.sustainability);
    setGradingBar('cohesion', g.cohesion);
  }
}

// ================================================================ title screen / lifecycle
// The boot sequence is lazy: nothing above ever constructs a SimWorld. Exactly two functions move
// the game between its two states, and both are on window.__debug for other UI work to call:
//
//   startGame(newWorld)  -- install a SimWorld and switch to gameplay. Everything that produces a
//                           world (Begin Settlement, Continue/Load, restart, conquest expansion)
//                           goes through here, so per-handoff resets live in ONE place.
//   showTitleScreen()    -- tear the running game down (world = null) and show the menu. This is
//                           what a pause-menu "Quit to title" wants.
//
// Anything that wants to add a new way to start a game (multi-slot loads, autosave resume, a
// scenario picker) only needs to build a SimWorld and hand it to startGame.

const titleEl = document.getElementById('titlescreen');
const titleMainEl = document.getElementById('title-main');
const titleSetupEl = document.getElementById('title-setup');

/** Hand a fully-constructed SimWorld off to gameplay. Idempotent per world; safe to call whether
 *  or not a game is already running (restart/expand both call it over a live world). */
function startGame(newWorld) {
  if (!newWorld) { console.warn('[SimWorldHost] startGame called without a world'); return null; }
  // metaprogress.js's lifetime stats (see that module's recordGameAbandoned doc comment): a
  // settlement that's about to be replaced (restart, load-over-a-running-game, conquest
  // expansion) without ever reaching its own game-over still banks its numbers -- this is the one
  // choke point every one of those paths already goes through, since they all end in a call here.
  // No-op if there's no previous world (title-screen "New Game"/"Continue") or it already
  // game-overed (recordGameEnd already banked it from world.js's tick()).
  if (world) recordGameAbandoned(world);
  world = newWorld;
  attachAudioHooks(world);
  lastAutosaveTick = world.currentTick; // full interval before the first autosave of this run

  // Keep the "what would restart() build?" config in step with whatever is actually running.
  // Everything but the starting head-count is recoverable from the world itself, which is what
  // makes [R]/New correct even for a settlement that arrived via a load rather than the setup
  // form (a save doesn't record what its starting population was, only its current one).
  lastNewGameConfig = {
    width: world.width, height: world.height,
    aggression: world.aggression, storyteller: world.storyteller,
    startingCitizens: lastNewGameConfig.startingCitizens,
  };

  // Per-handoff resets. The canvas has zero size while .pregame hides it, so resize() must run
  // AFTER the class comes off or frameOnContent would fit the camera to a 0x0 viewport.
  document.body.classList.remove('pregame');
  titleEl.classList.add('hidden');
  renderer.resize();
  renderer.manualCamera = false;
  renderer.frameOnContent(world);

  input.selectedCitizen = -1;
  input.selectedCitizens = [];
  input.tool = null;
  lastLoggedCount = 0;
  lastOwnedSignature = '';
  lastResearchSignature = '';
  eventlogEl.innerHTML = '';
  inspectorEl.classList.add('hidden');

  // Paint one frame's worth of UI immediately rather than waiting up to 100ms for the interval.
  updateTopbar();
  syncToolbarHighlight();
  updateEventLog();
  updateGrading();
  syncPauseMenu();
  return world;
}

/** Drop the running game and return to the menu. `world = null` is what actually stops the sim:
 *  frame() early-returns on it, so the tick loop keeps running but does nothing. */
function showTitleScreen() {
  // Same "bank a run that never reached its own game-over" reasoning as startGame() above --
  // Quit to Title is the other path that can discard a live settlement.
  if (world) recordGameAbandoned(world);
  world = null;
  document.body.classList.add('pregame');
  titleEl.classList.remove('hidden');
  titleMainEl.classList.remove('hidden');
  titleSetupEl.classList.add('hidden');
  // Any overlay left open by the game being torn down would otherwise reappear on the next start.
  for (const id of ['worldmap', 'finance', 'research', 'factions', 'programs', 'grants', 'quests', 'drones', 'workprio', 'gameover', 'grading-popover', 'inspector', 'confirm-dialog', 'pausemenu', 'help-panel']) {
    document.getElementById(id).classList.add('hidden');
  }
  // Quitting to title mid-tour shouldn't burn the first-run flag -- the player hasn't actually
  // dismissed it, the game went away underneath them. It'll fire again on their next new game.
  if (isTutorialActive()) stopTutorial(false);
  pendingConfirm = null;
  toastEl.classList.remove('show');
  toastTimer = 0;
  autosaveIndicatorEl.classList.remove('show');
  autosaveIndicatorTimer = 0;
  syncContinueAvailability();
}

// ---------------------------------------------------------------- setup form
const AGGRESSION_CARDS = [
  [AggressionPreset.Calm, 'Calm', 'Waves come noticeably lighter than the settlement warrants. Room to learn the systems.'],
  [AggressionPreset.Standard, 'Standard', 'Attackers scale straight off your settlement, no thumb on either scale.'],
  [AggressionPreset.Aggressive, 'Aggressive', 'Every wave hits well above weight. Defenses are not optional.'],
];

// Flavor text describes what each personality's parameter set (director.js STORYTELLERS) actually
// does, so the choice is legible rather than three names.
const STORYTELLER_CARDS = [
  ['Cassandra', 'Cassandra', 'Reads your settlement and paces pressure to match it. A steady, deliberate curve that scales directly with how strong you have grown -- the least forgiving of the three.'],
  ['Phoebe', 'Phoebe', 'Long breathers between waves and almost never sends two back to back. Still watches your strength, but leaves real time to build, plan and recover.'],
  ['Randy', 'Randy', 'No curve at all. Each cycle is rolled fresh and barely looks at how strong you are -- a quiet stretch, then two waves at once, for no reason whatsoever.'],
];

const setupWidthEl = document.getElementById('setup-width');
const setupHeightEl = document.getElementById('setup-height');
const setupCitizensEl = document.getElementById('setup-citizens');
const setupSeedEl = document.getElementById('setup-seed');
let setupAggression = AggressionPreset.Standard;
let setupStoryteller = 'Cassandra';

/** Radio-list rendering for the left-column setup options (aggression/storyteller): a vertical
 *  list of plain rows (dot + name only, no per-row description -- the SEA:R-style pattern this
 *  screen is following shows exactly one description line, next to whichever option is currently
 *  selected, not one per option). `descId`'s element is kept in sync with the selected entry's
 *  third tuple field on both initial render and every click. */
function buildRadioList(containerId, descId, cards, getSelected, onSelect, onChange) {
  const el = document.getElementById(containerId);
  const descEl = document.getElementById(descId);
  el.innerHTML = '';
  const syncDesc = () => {
    const sel = cards.find(([value]) => value === getSelected());
    descEl.textContent = sel ? sel[2] : '';
  };
  for (const [value, name] of cards) {
    const row = document.createElement('div');
    row.className = 'radio-option' + (value === getSelected() ? ' selected' : '');
    row.dataset.value = value;
    row.innerHTML = `<span class="dot"></span><span class="rname">${name}</span>`;
    row.addEventListener('click', () => {
      onSelect(value);
      for (const sib of el.children) sib.classList.toggle('selected', sib.dataset.value === value);
      syncDesc();
      if (onChange) onChange();
    });
    el.appendChild(row);
  }
  syncDesc();
}

function randomSeed() { return Math.floor(Math.random() * 0xffffffff); }

/** Plain-English summary of the current width/height pair -- this project's own voice, not
 *  copied from anywhere. Three rough bands (small/mid/large) plus the exact numbers, since the
 *  two sliders no longer carry their own per-field description now that Map Size is one field. */
function mapSizeDescription(width, height) {
  const avg = (width + height) / 2;
  const band = avg <= 60 ? 'A tight, easy-to-defend footprint -- short walks, short walls, less ground to lose.'
    : avg <= 80 ? 'A mid-sized settlement -- plenty of room to sprawl without turning defense into a full perimeter project.'
    : 'A sprawling settlement -- lots of room to build, but a lot more perimeter for attackers to probe.';
  return `${width} x ${height}. ${band}`;
}

function syncSetupLabels() {
  document.getElementById('setup-mapsize-val').textContent = `${setupWidthEl.value} x ${setupHeightEl.value}`;
  document.getElementById('setup-mapsize-desc').textContent =
    mapSizeDescription(Number(setupWidthEl.value), Number(setupHeightEl.value));
  document.getElementById('setup-citizens-val').textContent = setupCitizensEl.value;
}
for (const el of [setupWidthEl, setupHeightEl, setupCitizensEl]) {
  el.addEventListener('input', () => { syncSetupLabels(); drawSetupPreview(); });
}

// ---- Setup-screen preview (right column) ----------------------------------------------------
// Not a real terrain render (that's `render.js`'s job once a SimWorld exists) -- a lightweight,
// seeded, purely decorative sketch so the seed field isn't just a blind number. Uses the exact
// same seeded RNG (`makeRng`, core.js) the real world construction uses, so re-picking a seed here
// visibly changes the sketch the same way it'll visibly change the real settlement. Aspect ratio
// follows the current width/height, and the citizen-count dial changes how many "starting camp"
// dots cluster at the center, so all three right/left-column controls are reflected in one place.
const setupPreviewEl = document.getElementById('setup-preview');
const setupPreviewCtx = setupPreviewEl.getContext('2d');

function drawSetupPreview() {
  const w = setupPreviewEl.width, h = setupPreviewEl.height;
  const ctx = setupPreviewCtx;
  const mapW = Number(setupWidthEl.value) || 64;
  const mapH = Number(setupHeightEl.value) || 64;
  const typedSeed = Number.parseInt(setupSeedEl.value, 10);
  const seed = Number.isFinite(typedSeed) ? (typedSeed >>> 0) : 0;
  const rng = makeRng(seed);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#20301f';
  ctx.fillRect(0, 0, w, h);

  // Playable rect scaled to the map's aspect ratio, centered in the canvas.
  const margin = 8;
  const availW = w - margin * 2, availH = h - margin * 2;
  const aspect = mapW / mapH;
  let rectW = availW, rectH = availW / aspect;
  if (rectH > availH) { rectH = availH; rectW = availH * aspect; }
  const rx = (w - rectW) / 2, ry = (h - rectH) / 2;
  ctx.fillStyle = '#2c3d28';
  ctx.fillRect(rx, ry, rectW, rectH);
  ctx.strokeStyle = '#4a5c40';
  ctx.lineWidth = 1;
  ctx.strokeRect(rx + 0.5, ry + 0.5, rectW - 1, rectH - 1);

  // Scattered scrap-node-flavored dots -- count and placement both come from the seed, echoing
  // resources.js's ResourceNode scatter without duplicating its (much heavier) real logic.
  const nodeCount = 10 + rngInt(rng, 0, 6);
  ctx.fillStyle = '#8a7550';
  for (let i = 0; i < nodeCount; i++) {
    const px = rx + rngInt(rng, 2, Math.max(3, rectW - 2));
    const py = ry + rngInt(rng, 2, Math.max(3, rectH - 2));
    ctx.beginPath();
    ctx.arc(px, py, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // A small starting-camp cluster near the center, sized by the starting-citizen count.
  const citizens = Number(setupCitizensEl.value) || 24;
  const dotCount = Math.round(citizens / 2);
  const cx = rx + rectW / 2, cy = ry + rectH / 2;
  ctx.fillStyle = '#e8c15a';
  for (let i = 0; i < dotCount; i++) {
    const ang = rng() * Math.PI * 2;
    const dist = rng() * Math.min(rectW, rectH) * 0.16;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
}
setupSeedEl.addEventListener('input', drawSetupPreview);

/** Read the form into a settings object, sanitising anything the player typed. A non-numeric or
 *  empty seed falls back to a fresh random one rather than producing NaN. */
function readSetupForm() {
  const typedSeed = Number.parseInt(setupSeedEl.value, 10);
  return {
    width: Number(setupWidthEl.value),
    height: Number(setupHeightEl.value),
    startingCitizens: Number(setupCitizensEl.value),
    seed: Number.isFinite(typedSeed) ? (typedSeed >>> 0) : randomSeed(),
    aggression: setupAggression,
    storyteller: setupStoryteller,
  };
}

/** Applies a Customize Starting Colonists roster (see the section below) onto a just-constructed
 *  SimWorld's CitizenStore. `roster[i]` transplants directly onto store index i -- world.js's
 *  constructor spawns starting citizens in the same 0..count-1 order this preview roster was built
 *  in, so index i here is guaranteed to be the same citizen slot the preview card for i represented.
 *  Every field being written was itself produced by a real randomTrait/randomBackstory/
 *  randomPassions roll (see rollColonistPreview) -- this never invents a value, only moves which
 *  already-real roll landed on which starting citizen. */
function applyRosterOverride(w, roster) {
  const store = w.citizens;
  const n = Math.min(roster.length, store.count);
  for (let i = 0; i < n; i++) {
    const pick = roster[i];
    if (pick.name) store.name[i] = pick.name;
    store.trait[i] = pick.trait;
    store.backstory[i] = pick.backstory;
    store.passionCombat[i] = pick.passionCombat;
    store.passionConstruction[i] = pick.passionConstruction;
    store.skillCombat[i] = pick.skillCombat;
    store.skillConstruction[i] = pick.skillConstruction;
  }
}

/** Construct + start a settlement from an explicit settings object. Every field is optional and
 *  falls back to the current defaults, so `__debug.newGame({ storyteller: 'Randy' })` works.
 *  `opts.rosterOverride` (see "Customize Starting Colonists" below) is optional too -- when
 *  present, applyRosterOverride transplants it onto the freshly-spawned roster right after
 *  construction and before the world is handed to startGame(). */
function beginSettlement(opts = {}) {
  const cfg = {
    width: 64, height: 64, seed: randomSeed(),
    aggression: AggressionPreset.Standard, startingCitizens: 24, storyteller: 'Cassandra',
    ...opts,
  };
  if (!STORYTELLERS[cfg.storyteller]) cfg.storyteller = 'Cassandra';
  // startGame recovers width/height/aggression/storyteller from the world it is handed; the
  // starting head-count is the one thing it can't, so record it here before handing over.
  lastNewGameConfig.startingCitizens = cfg.startingCitizens;
  const newWorld = makeWorld(cfg);
  if (Array.isArray(opts.rosterOverride)) applyRosterOverride(newWorld, opts.rosterOverride);
  startGame(newWorld);
  console.log(`[SimWorldHost] New settlement ${cfg.width}x${cfg.height}, seed ${cfg.seed}, ` +
    `${cfg.startingCitizens} citizens, ${cfg.aggression}, storyteller ${cfg.storyteller}` +
    `${opts.rosterOverride ? ' (customized roster)' : ''}.`);
  // First-run onboarding (tutorial.js). Hooked HERE rather than in startGame() on purpose:
  // startGame is also the load/restart/conquest-expansion path, and a returning player loading a
  // save should never be handed a beginner's tour. No-ops after the first time (localStorage flag).
  maybeStartTutorial();
  return world;
}

/** Drives the title screen's Continue/Load/Resume-Autosave availability and the savenote blurb.
 *  Two independent slots (manual SAVE_KEY, periodic AUTOSAVE_KEY) can each be present or absent;
 *  when both exist the note calls out whichever is more recent (by wall-clock savedAt, falling
 *  back to tick if a slot predates the savedAt field) so the player isn't left guessing which
 *  button actually gets them further. */
function syncContinueAvailability() {
  const exists = hasSave();
  const autoExists = hasAutosave();
  const contBtn = document.getElementById('btn-title-continue');
  const loadBtn = document.getElementById('btn-title-load');
  const autoBtn = document.getElementById('btn-title-resume-autosave');
  contBtn.disabled = !exists;
  loadBtn.disabled = !exists;
  autoBtn.disabled = !autoExists;

  const noteEl = document.getElementById('title-savenote');
  if (!exists && !autoExists) {
    noteEl.textContent = 'No saved settlement yet -- start a new one.';
  } else if (exists && !autoExists) {
    noteEl.textContent = 'A saved settlement is waiting.';
  } else if (!exists && autoExists) {
    noteEl.textContent = 'No manual save yet -- an autosave is available to resume.';
  } else {
    const m = peekSaveMeta(SAVE_KEY);
    const a = peekSaveMeta(AUTOSAVE_KEY);
    const autoNewer = m && a ? a.savedAt > m.savedAt : a && !m;
    noteEl.textContent = autoNewer
      ? `Manual save (tick ${m ? m.tick : '?'}) and a more recent autosave (tick ${a ? a.tick : '?'}) are both available.`
      : `A saved settlement is waiting (autosave from tick ${a ? a.tick : '?'} also available).`;
  }
}

function showSetupScreen() {
  titleMainEl.classList.add('hidden');
  titleSetupEl.classList.remove('hidden');
  setupSeedEl.value = String(randomSeed()); // fresh random seed every time the form is opened
  syncSetupLabels();
  buildRadioList('setup-aggression', 'setup-aggression-desc', AGGRESSION_CARDS,
    () => setupAggression, (v) => { setupAggression = v; });
  buildRadioList('setup-storyteller', 'setup-storyteller-desc', STORYTELLER_CARDS,
    () => setupStoryteller, (v) => { setupStoryteller = v; });
  drawSetupPreview();
  // A fresh trip into New Game shouldn't carry a stale customization from a previous visit --
  // see the "Customize Starting Colonists" section below, showColonistSetup() re-rolls whenever
  // pendingRoster is null or its length no longer matches the citizen slider anyway, but clearing
  // it here also means Back-then-New-Game reads as a genuinely fresh setup, not a leftover roster.
  pendingRoster = null;
}

// ---------------------------------------------------------------- customize starting colonists
// Optional pre-start step (reachable from the setup screen's "Customize Starting Colonists"
// button below) -- shows the player the exact starting roster CitizenStore.spawn() would
// otherwise roll blind and unseen, using the SAME real randomTrait/randomBackstory/
// randomPassions functions (traits.js/backstories.js) that spawn() itself calls. Re-rolling a
// citizen here calls those same functions again; it never invents a parallel roll table, and it
// deliberately never lets the player type a skill value in directly -- only re-roll from the same
// pool, so a min-maxed roster isn't possible, matching the spirit of "control over outcome, not
// removing randomness as a resource."
let pendingRoster = null; // null = no customization pending; beginSettlement() rolls fresh as normal

/** One citizen's preview roll -- exactly what CitizenStore.spawn() would produce for starting
 *  citizen slot `index`, computed the same way (randomTrait/randomBackstory/randomPassions), just
 *  not yet written into a CitizenStore since no SimWorld exists yet at this point in the setup
 *  flow (see applyRosterOverride above, called once a world actually gets constructed). Uses
 *  Math.random rather than the setup form's seeded rng on purpose -- the seed drives real terrain/
 *  spawn generation once Start is pressed, and re-rolling a preview citizen here should feel like
 *  a genuine fresh roll, not a deterministic function of the seed field. */
function rollColonistPreview(index) {
  const trait = randomTrait(Math.random);
  const backstory = randomBackstory(Math.random);
  const passions = randomPassions(Math.random, backstory, trait);
  return {
    name: STARTER_NAMES[index] ?? `Colonist ${index + 1}`,
    trait, backstory,
    passionCombat: passions.combat,
    passionConstruction: passions.construction,
    skillCombat: backstory.skillCombatStart ?? 0,
    skillConstruction: backstory.skillConstructionStart ?? 0,
  };
}

function rollFreshRoster(count) {
  const roster = [];
  for (let i = 0; i < count; i++) roster.push(rollColonistPreview(i));
  return roster;
}

const colonistSetupEl = document.getElementById('colonist-setup');
const colonistGridEl = document.getElementById('colonist-setup-grid');

/** Builds one card's DOM for pendingRoster[i] -- a name field (renamable), the backstory pair
 *  (hover for its full flavor description, same title-attribute convention the inspector's own
 *  backstory line already uses), the trait name, a bucketed skill readout (skillLevel/PASSION_ICON,
 *  same convention the inspector panel uses so this reads consistently with the rest of the game),
 *  and a Re-roll button. */
function renderColonistCard(i) {
  const c = pendingRoster[i];
  const card = document.createElement('div');
  card.className = 'node';
  const nameEsc = c.name.replace(/"/g, '&quot;');
  const descEsc = c.backstory.description.replace(/"/g, '&quot;');
  card.innerHTML = `
    <canvas class="csprite" width="88" height="88"></canvas>
    <input class="cname-input" type="text" value="${nameEsc}" maxlength="24">
    <div class="backstory" title="${descEsc}">${c.backstory.childhood} &rarr; ${c.backstory.adult}</div>
    <div class="trait">${c.trait.name}</div>
    <div class="skills">Combat: ${skillLevel(c.skillCombat)}${PASSION_ICON[c.passionCombat]} &middot; Construction: ${skillLevel(c.skillConstruction)}${PASSION_ICON[c.passionConstruction]}</div>
    <button class="reroll-btn" type="button">🎲 Re-roll backstory/trait</button>
  `;
  // Sprite preview: reuses the exact same _drawHumanoid the live game draws citizens with (see
  // render.js), on a tiny standalone Renderer/canvas pair rather than a parallel drawing routine
  // -- so this preview can never visually drift from what the colonist actually looks like once
  // spawned. camX/camY stay 0 (Renderer's own default) so worldToScreen(0,0) lands exactly on the
  // canvas center; drawing the citizen at world (0,0) is what makes that centering work. Every
  // starting colonist has StaffRoleKind.None (no roster assignment happens until after spawn), so
  // the preview always uses the same base role color the live game would show for them at tick 0.
  // `i` doubles as the humanoid's hair-tone seed, matching how _drawCitizens seeds it with the
  // citizen's stable id -- gives the grid some visual variety without inventing a new seed scheme.
  const spriteCanvas = card.querySelector('.csprite');
  new Renderer(spriteCanvas)._drawHumanoid(0, 0, 2.0, ROLE_COLOR[StaffRoleKind.None], CITIZEN_SKIN, 1, false, 0, i);
  card.querySelector('.cname-input').addEventListener('input', (e) => {
    pendingRoster[i].name = e.target.value;
  });
  card.querySelector('.reroll-btn').addEventListener('click', () => {
    const keepName = pendingRoster[i].name; // re-rolling is about backstory/trait, not clobbering
    pendingRoster[i] = rollColonistPreview(i); // a name the player already typed in above
    pendingRoster[i].name = keepName;
    renderColonistGrid();
  });
  return card;
}

function renderColonistGrid() {
  colonistGridEl.innerHTML = '';
  for (let i = 0; i < pendingRoster.length; i++) colonistGridEl.appendChild(renderColonistCard(i));
}

function showColonistSetup() {
  const count = Number(setupCitizensEl.value) || 24;
  // Regenerate only if there's nothing pending yet or the citizen-count slider moved since the
  // last visit -- otherwise re-opening this screen (e.g. after Back) keeps whatever the player
  // already re-rolled/renamed rather than throwing it away.
  if (!pendingRoster || pendingRoster.length !== count) pendingRoster = rollFreshRoster(count);
  titleSetupEl.classList.add('hidden');
  colonistSetupEl.classList.remove('hidden');
  renderColonistGrid();
}

function hideColonistSetup() {
  colonistSetupEl.classList.add('hidden');
  titleSetupEl.classList.remove('hidden');
}

document.getElementById('btn-setup-customize').addEventListener('click', () => showColonistSetup());
document.getElementById('btn-colonist-back').addEventListener('click', () => hideColonistSetup());
// Fast-path skip, per the task's explicit ask: players who don't want to fuss with customization
// get a one-click "just roll it and go" that behaves exactly like the plain Start ▶ button always
// has (a completely fresh random roster, not whatever partial re-rolls/renames happened to be
// sitting in pendingRoster -- discarding it here is deliberate, this button means "never mind").
document.getElementById('btn-colonist-randomize-all').addEventListener('click', () => {
  pendingRoster = null;
  colonistSetupEl.classList.add('hidden');
  beginSettlement(readSetupForm());
});
document.getElementById('btn-colonist-confirm').addEventListener('click', () => {
  const roster = pendingRoster;
  pendingRoster = null;
  colonistSetupEl.classList.add('hidden');
  beginSettlement({ ...readSetupForm(), rosterOverride: roster });
});

document.getElementById('btn-title-new').addEventListener('click', () => showSetupScreen());
document.getElementById('btn-title-continue').addEventListener('click', () => load());
document.getElementById('btn-title-load').addEventListener('click', () => load());
// No world exists at the title screen, so nothing to confirm-overwrite -- loadAutosave() directly,
// same reasoning confirmedLoad() uses for the title-screen branch.
document.getElementById('btn-title-resume-autosave').addEventListener('click', () => loadAutosave());

// ---------------------------------------------------------------- statistics / achievements overlay
// Title-screen-only (see index.html's #statspanel), same reasoning as #credits directly below --
// no in-game entry point, so nothing to worry about across a startGame()/showTitleScreen()
// transition. Reads metaprogress.js's lifetime totals + ACHIEVEMENTS list directly; this panel is
// purely a display, it never writes to that module itself (all the writes happen at the
// event-driven call sites in world.js/worldmap.js/jobs.js/main.js's research handler above).
const statsEl = document.getElementById('statspanel');
const statsRowsEl = document.getElementById('stats-rows');
const statsAchievementsEl = document.getElementById('stats-achievements');
const statsSubEl = document.getElementById('stats-sub');

function fmtNum(n) { return Math.round(n || 0).toLocaleString(); }

function renderStats() {
  const m = getMeta();
  const rows = [
    ['Settlements played', fmtNum(m.gamesPlayed)],
    ['Longest survival', `${fmtNum(m.longestSurvivalTicks)} ticks (Wave ${fmtNum(m.longestSurvivalWaves)})`],
    ['Most citizens alive at once', fmtNum(m.mostCitizensAlive)],
    ['Attackers killed, lifetime', fmtNum(m.totalAttackersKilled)],
    ['Scrap earned, lifetime', fmtNum(m.totalScrapEarned)],
  ];
  statsRowsEl.innerHTML = rows.map(([label, val]) =>
    `<div class="stats-row"><span class="label">${label}</span><span class="val">${val}</span></div>`).join('');

  const unlockedCount = ACHIEVEMENTS.filter(a => isAchievementUnlocked(a.id)).length;
  statsSubEl.textContent = `${unlockedCount} of ${ACHIEVEMENTS.length} achievements unlocked`;

  statsAchievementsEl.innerHTML = ACHIEVEMENTS.map(a => {
    const unlocked = isAchievementUnlocked(a.id);
    const ts = unlocked ? new Date(m.achievements[a.id]).toLocaleDateString() : null;
    return `<div class="ach-card${unlocked ? ' done' : ''}">` +
      `<div class="ach-name">${unlocked ? '🏆' : '🔒'} ${a.name}</div>` +
      `<div class="ach-desc">${a.desc}</div>` +
      (unlocked ? `<div class="ach-date">Unlocked ${ts}</div>` : '') +
      `</div>`;
  }).join('');
}

function toggleStats(force) {
  const show = force != null ? force : statsEl.classList.contains('hidden');
  statsEl.classList.toggle('hidden', !show);
  if (show) renderStats();
}
document.getElementById('btn-title-stats').addEventListener('click', () => toggleStats(true));
document.getElementById('btn-stats-close').addEventListener('click', () => toggleStats(false));

// ---------------------------------------------------------------- credits / about overlay
// Title-screen-only (see index.html's #credits) -- there's no in-game entry point, so no need to
// worry about it being left open across a startGame()/showTitleScreen() transition.
const creditsEl = document.getElementById('credits');
document.getElementById('btn-title-credits').addEventListener('click', () => {
  creditsEl.classList.remove('hidden');
});
document.getElementById('btn-credits-close').addEventListener('click', () => {
  creditsEl.classList.add('hidden');
});
document.getElementById('btn-setup-back').addEventListener('click', () => {
  titleSetupEl.classList.add('hidden');
  titleMainEl.classList.remove('hidden');
});
document.getElementById('btn-setup-randomize').addEventListener('click', () => {
  setupSeedEl.value = String(randomSeed());
  drawSetupPreview();
});
// Prev/next "browse" arrows next to the preview thumbnail -- SEA:R's map-picker interaction
// pattern (arrows step through candidate maps), adopted here as stepping the seed by 1 so the
// player can nudge to a neighboring layout without retyping/rerolling the whole number.
document.getElementById('btn-setup-prev-seed').addEventListener('click', () => {
  const cur = Number.parseInt(setupSeedEl.value, 10);
  setupSeedEl.value = String(((Number.isFinite(cur) ? cur : 0) - 1) >>> 0);
  drawSetupPreview();
});
document.getElementById('btn-setup-next-seed').addEventListener('click', () => {
  const cur = Number.parseInt(setupSeedEl.value, 10);
  setupSeedEl.value = String(((Number.isFinite(cur) ? cur : 0) + 1) >>> 0);
  drawSetupPreview();
});
document.getElementById('btn-begin').addEventListener('click', () => beginSettlement(readSetupForm()));

let framesSinceReframe = 0;

function frame() {
  // No world means the title screen is up. The loop keeps running (so a startGame() from any
  // source picks straight back up) but there is nothing to tick, draw or update.
  if (!world) return;
  renderer.resize();
  for (let s = 0; s < speedMultiplier; s++) world.tick();

  renderer.draw(world, input);
  renderer.drawMinimap(world, minimapEl);

  framesSinceReframe++;
  if (framesSinceReframe > 50) {
    framesSinceReframe = 0;
    if (!renderer.manualCamera) renderer.frameOnContent(world);
  }

  updateTopbar();
  syncToolbarHighlight();
  updateInspector();
  updateEventLog();
  updateSupplyAlert();
  updateGameOver();
  refreshWorldMapValues();
  refreshResearchValues();
  refreshFinance();
  refreshFactions();
  refreshPrograms();
  refreshCoveragePlans();
  refreshGrants();
  refreshQuests();
  refreshDrones();
  updateGrading();
  syncPauseMenu();

  // Periodic autosave -- only while a game is actively being played. Paused: the player is
  // deliberately not progressing, nothing new to capture and no reason to disturb them. Game
  // over: the run is finished, further autosaves would just overwrite the final state with
  // itself. See AUTOSAVE_INTERVAL_TICKS above for why 1200.
  if (!world.paused && !world.gameOver && world.currentTick - lastAutosaveTick >= AUTOSAVE_INTERVAL_TICKS) {
    autosave();
  }

  if (toastTimer > 0) { toastTimer--; if (toastTimer === 0) toastEl.classList.remove('show'); }
  if (autosaveIndicatorTimer > 0) {
    autosaveIndicatorTimer--;
    if (autosaveIndicatorTimer === 0) autosaveIndicatorEl.classList.remove('show');
  }
  if (achievementToastTimer > 0) {
    achievementToastTimer--;
    if (achievementToastTimer === 0) achievementToastEl.classList.remove('show');
  }
}

// setInterval instead of requestAnimationFrame: rAF is paused entirely in backgrounded/
// non-visible tabs in some embedding contexts, which would silently freeze the sim. A fixed
// 10Hz interval matches the tick rate directly and isn't subject to that pause.
setInterval(frame, SECONDS_PER_TICK * 1000);

// ---------------------------------------------------------------- boot
// The only thing that runs on load. No SimWorld is constructed here -- the player picks.
showTitleScreen();
