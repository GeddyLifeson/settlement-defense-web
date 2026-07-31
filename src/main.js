// Ported from SD.Presentation/SimWorldHost.cs -- owns one SimWorld, steps it at a fixed
// 10 Hz tick rate independent of frame rate, and renders every frame.
import { SimWorld } from './world.js';
import { Renderer } from './render.js';
import { InputController, TOOLS } from './input.js';
import { isNight } from './schedule.js';
import { PASSION_ICON } from './backstories.js';
import { worldMap } from './worldmap.js';
import {
  playBuildComplete, playWaveAlert, playTurretFire, playKill, playCitizenDowned,
  isMuted, toggleMute, getVolume, setVolume, getMasterGainValue,
} from './audio.js';
import { WeatherKind, tryWandererEvent, tryBlightEvent } from './weather.js';
import { WEAPON_TIERS } from './security.js';
import { AggressionPreset } from './core.js';
import { STORYTELLERS } from './director.js';
import {
  RESEARCH_NODES, isNodeUnlocked, isToolUnlocked, researchBlockedReason, tryResearch,
} from './research.js';
import {
  initOnboarding, maybeStartTutorial, startTutorial, stopTutorial, isTutorialActive,
  toggleHelp, isHelpOpen, hasSeenTutorial, resetTutorialSeen, TUTORIAL_SEEN_KEY, TUTORIAL_STEPS,
} from './tutorial.js';

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
const WEATHER_ICON = { Clear: '🌤', Rain: '🌧', Cold: '❄', Heatwave: '🔥' };

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);
renderer.resize();
window.addEventListener('resize', () => renderer.resize());

// Wires SimWorld's presentation-audio callback hooks (see world.js's onXxx fields / audio.js's
// module doc comment) to the procedural sound cues. Must be re-run every time `world` is
// reassigned (restart/load/expandTo all construct a fresh SimWorld), since the hooks live on the
// instance, not anywhere global.
function attachAudioHooks(w) {
  w.onBuildComplete = () => playBuildComplete();
  w.onWaveIncoming = () => playWaveAlert();
  w.onTurretFire = () => playTurretFire();
  w.onKill = () => playKill();
  w.onCitizenDowned = () => playCitizenDowned();
  // Weather changes + one-off random events (weather.js) surface as a toast, same mechanism as
  // every other player-visible notification in this file.
  w.onRandomEvent = (text) => showToast(text);
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
  audio: { isMuted, toggleMute, getVolume, setVolume, getMasterGainValue, playBuildComplete, playTurretFire, playKill, playWaveAlert, playCitizenDowned },
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
  },
};

// ---------------------------------------------------------------- toolbar (built once)
const toolbarEl = document.getElementById('toolbar');
for (const t of TOOLS) {
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
  });
  toolbarEl.appendChild(btn);
}

// Local lookup rather than importing researchNodeForTool -- main.js only ever needs it for the
// toast label above and this keeps the import list to the tree/state helpers.
function researchNodeForToolLocal(tool) {
  return RESEARCH_NODES.find(n => n.unlocks.includes(tool)) || null;
}

function syncToolbarHighlight() {
  for (const btn of toolbarEl.children) {
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
document.getElementById('btn-worldmap').addEventListener('click', () => toggleWorldMap());
document.getElementById('btn-worldmap-close').addEventListener('click', () => toggleWorldMap(false));
document.getElementById('btn-finance').addEventListener('click', () => toggleFinance());
document.getElementById('btn-finance-close').addEventListener('click', () => toggleFinance(false));
document.getElementById('btn-research').addEventListener('click', () => toggleResearch());
document.getElementById('btn-research-close').addEventListener('click', () => toggleResearch(false));

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

const settingsEl = document.getElementById('settings');
const settingsVolumeEl = document.getElementById('settings-volume');
const settingsVolumeValEl = document.getElementById('settings-volume-val');
const settingsAggressionEl = document.getElementById('settings-aggression');
const settingsStorytellerEl = document.getElementById('settings-storyteller');
const settingsDifficultyNoteEl = document.getElementById('settings-difficulty-note');
const settingsHighContrastEl = document.getElementById('settings-highcontrast');
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
      ['Help Reference', 'F1 or ?'], ['Deselect tool / close Map-Research-Budget', 'Escape'],
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

/** Set the --ui-scale CSS custom property (index.html's ".box { transform: scale(...) }") and
 *  persist it. Clamped to the same 85-150% range as the slider. */
function setUiScale(value) {
  const clamped = Math.max(0.85, Math.min(1.5, value));
  document.documentElement.style.setProperty('--ui-scale', String(clamped));
  try { localStorage.setItem(UISCALE_KEY, String(clamped)); } catch { /* best effort */ }
}
settingsTextSizeEl.addEventListener('input', () => {
  const pct = Number(settingsTextSizeEl.value);
  settingsTextSizeValEl.textContent = pct + '%';
  setUiScale(pct / 100);
});
(function initUiScale() {
  try {
    const stored = Number.parseFloat(localStorage.getItem(UISCALE_KEY));
    if (Number.isFinite(stored)) setUiScale(stored);
  } catch { /* default 1 via the CSS variable's own default */ }
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

function toggleWorldMap(force) {
  const show = force != null ? force : worldmapEl.classList.contains('hidden');
  worldmapEl.classList.toggle('hidden', !show);
  document.getElementById('btn-worldmap').classList.toggle('active', show);
  if (show) renderWorldMap();
}
input.onToggleMap = () => toggleWorldMap();
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
        renderResearch();
      });
      card.appendChild(btn);
    }
    researchGridEl.appendChild(card);
  }
  const doneCount = RESEARCH_NODES.filter(n => isNodeUnlocked(world.research, n.id)).length;
  researchSubEl.textContent =
    `${Math.floor(world.research.points)} research points banked · ` +
    `${doneCount} of ${RESEARCH_NODES.length} technologies known`;
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
    `${RESEARCH_NODES.filter(n => isNodeUnlocked(state, n.id)).length} of ${RESEARCH_NODES.length} technologies known`);
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
}

/** Move the operation: bank what we've got here, then stand up a FRESH SimWorld in the new
 *  region (new seed, same starting-citizen setup as any new settlement). The player is
 *  relocating, not managing two live sims. */
function expandTo(regionId) {
  worldMap.bankActive(world);
  if (!worldMap.setActive(regionId)) { showToast('Cannot expand there'); return; }
  const seed = Math.floor(Math.random() * 0xffffffff);
  // Same settings the player picked for this campaign (map size, aggression, storyteller) --
  // only the seed and the region change. startGame() does the camera/selection/log resets.
  startGame(makeWorld({ ...lastNewGameConfig, seed }));
  world.milestoneLog.push({ tick: 0, text: `Expedition established in ${worldMap.active.name}` });
  showToast(`Expanded to ${worldMap.active.name}`);
  console.log(`[WorldMap] Expanded to ${worldMap.active.name} (region ${regionId}), seed ${seed}.`);
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
  ['conquestScrap', '🗺 Conquest supply lines', 'income'],
  ['otherScrap', '❓ Other', 'income'],
  ['buildSpend', '🔨 Construction spend', 'expense'],
];

/** Rebuild the category rows + redraw the chart. Cheap enough (7 rows, one small canvas) to
 *  redraw wholesale on every open/refresh rather than diff, and it only runs while the overlay
 *  is actually open (see refreshFinance below). */
function renderFinance() {
  const f = world.finance;
  if (!f) return;
  const totalIncome = f.killScrap + f.harvestScrap + f.haulScrap + f.recyclingScrap + f.conquestScrap + f.otherScrap;
  financeRowsEl.innerHTML = FINANCE_CATEGORIES.map(([key, label, cls]) =>
    `<div class="fin-row"><span class="label">${label}</span><span class="val ${cls}">${cls === 'expense' ? '-' : '+'}${Math.round(f[key])}</span></div>`
  ).join('') +
    `<div class="fin-row total"><span class="label">Net lifetime</span><span class="val ${totalIncome - f.buildSpend >= 0 ? 'income' : 'expense'}">` +
    `${Math.round(totalIncome - f.buildSpend)}</span></div>`;
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
  // Marquee multi-select (see input.js InputController._onUp) has no per-citizen command system
  // to hook into -- there's no "move here"/"build this" order in this game, citizens are fully
  // autonomous via jobs.js's priority system. So a 2+ selection is honestly just an aggregate
  // info view (group averages + a name list), not a fake commands UI.
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
  if (c.isDownedAt(sel)) {
    statusEl.textContent = 'Downed';
  } else if (c.isOnBreakAt(sel)) {
    statusEl.textContent = 'On Break (mood too low to work at full speed)';
  } else {
    statusEl.textContent = '';
  }
  setBar('hp', c.health[sel]);
  setBar('hunger', c.hunger[sel]);
  setBar('rest', c.rest[sel]);
  setBar('social', c.social[sel]);
  setBar('mood', c.mood[sel]);
  document.getElementById('insp-skill').textContent =
    `Combat: ${skillLevel(c.skillCombat[sel])}${PASSION_ICON[c.passionCombat[sel]]} · ` +
    `Construction: ${skillLevel(c.skillConstruction[sel])}${PASSION_ICON[c.passionConstruction[sel]]}`;
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
  document.getElementById('insp-status').textContent = 'Group averages below';
  const avg = (arr) => alive.reduce((s, i) => s + arr[i], 0) / alive.length;
  setBar('hp', avg(c.health));
  setBar('hunger', avg(c.hunger));
  setBar('rest', avg(c.rest));
  setBar('social', avg(c.social));
  setBar('mood', avg(c.mood));
  document.getElementById('insp-skill').textContent = '';
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
  const night = isNight(world.timeOfDay);
  document.getElementById('stat-daynight-icon').textContent = night ? '🌙' : '☀';
  document.getElementById('stat-daynight').textContent = (night ? 'Night ' : 'Day ') + Math.round(world.timeOfDay * 100) + '%';
  document.getElementById('stat-weather-icon').textContent = WEATHER_ICON[world.weather] || '🌤';
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
  world = null;
  document.body.classList.add('pregame');
  titleEl.classList.remove('hidden');
  titleMainEl.classList.remove('hidden');
  titleSetupEl.classList.add('hidden');
  // Any overlay left open by the game being torn down would otherwise reappear on the next start.
  for (const id of ['worldmap', 'finance', 'research', 'gameover', 'grading-popover', 'inspector', 'confirm-dialog', 'pausemenu', 'help-panel']) {
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

function buildCards(containerId, cards, getSelected, onSelect) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  for (const [value, name, desc] of cards) {
    const card = document.createElement('div');
    card.className = 'card' + (value === getSelected() ? ' selected' : '');
    card.dataset.value = value;
    card.innerHTML = `<div class="cname">${name}</div><div class="cdesc">${desc}</div>`;
    card.addEventListener('click', () => {
      onSelect(value);
      for (const sib of el.children) sib.classList.toggle('selected', sib.dataset.value === value);
    });
    el.appendChild(card);
  }
}

function randomSeed() { return Math.floor(Math.random() * 0xffffffff); }

function syncSetupLabels() {
  document.getElementById('setup-width-val').textContent = setupWidthEl.value;
  document.getElementById('setup-height-val').textContent = setupHeightEl.value;
  document.getElementById('setup-citizens-val').textContent = setupCitizensEl.value;
}
for (const el of [setupWidthEl, setupHeightEl, setupCitizensEl]) el.addEventListener('input', syncSetupLabels);

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

/** Construct + start a settlement from an explicit settings object. Every field is optional and
 *  falls back to the current defaults, so `__debug.newGame({ storyteller: 'Randy' })` works. */
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
  startGame(makeWorld(cfg));
  console.log(`[SimWorldHost] New settlement ${cfg.width}x${cfg.height}, seed ${cfg.seed}, ` +
    `${cfg.startingCitizens} citizens, ${cfg.aggression}, storyteller ${cfg.storyteller}.`);
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
  buildCards('setup-aggression', AGGRESSION_CARDS, () => setupAggression, (v) => { setupAggression = v; });
  buildCards('setup-storyteller', STORYTELLER_CARDS, () => setupStoryteller, (v) => { setupStoryteller = v; });
}

document.getElementById('btn-title-new').addEventListener('click', () => showSetupScreen());
document.getElementById('btn-title-continue').addEventListener('click', () => load());
document.getElementById('btn-title-load').addEventListener('click', () => load());
// No world exists at the title screen, so nothing to confirm-overwrite -- loadAutosave() directly,
// same reasoning confirmedLoad() uses for the title-screen branch.
document.getElementById('btn-title-resume-autosave').addEventListener('click', () => loadAutosave());

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
  updateGameOver();
  refreshWorldMapValues();
  refreshResearchValues();
  refreshFinance();
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
}

// setInterval instead of requestAnimationFrame: rAF is paused entirely in backgrounded/
// non-visible tabs in some embedding contexts, which would silently freeze the sim. A fixed
// 10Hz interval matches the tick rate directly and isn't subject to that pause.
setInterval(frame, SECONDS_PER_TICK * 1000);

// ---------------------------------------------------------------- boot
// The only thing that runs on load. No SimWorld is constructed here -- the player picks.
showTitleScreen();
