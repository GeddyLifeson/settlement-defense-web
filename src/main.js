// Ported from SD.Presentation/SimWorldHost.cs -- owns one SimWorld, steps it at a fixed
// 10 Hz tick rate independent of frame rate, and renders every frame.
import { SimWorld } from './world.js';
import { Renderer } from './render.js';
import { InputController, TOOLS } from './input.js';
import { isNight } from './schedule.js';
import { PASSION_ICON } from './backstories.js';
import { worldMap } from './worldmap.js';
import { playBuildComplete, playWaveAlert, playTurretFire, playKill, playCitizenDowned, isMuted, toggleMute } from './audio.js';
import { WeatherKind, tryWandererEvent, tryBlightEvent } from './weather.js';
import { WEAPON_TIERS } from './security.js';
import {
  RESEARCH_NODES, isNodeUnlocked, isToolUnlocked, researchBlockedReason, tryResearch,
} from './research.js';

const SECONDS_PER_TICK = 0.1;
const SAVE_KEY = 'settlement-defense-save';
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

let world = new SimWorld(64, 64, 12345, 'Calm', 24);
attachAudioHooks(world);
renderer.frameOnContent(world);

let speedMultiplier = 1;
let toastTimer = 0;
const toastEl = document.getElementById('toast');

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastTimer = 20; // frames, ~2s at 10Hz
}

const input = new InputController(canvas, renderer, () => world, (s) => { speedMultiplier = s; }, showToast);

window.__debug = {
  getWorld: () => world, input, renderer, worldMap,
  // conquest-layer handles for console verification (see SESSION_HANDOFF.md's verification pattern)
  toggleWorldMap: (v) => toggleWorldMap(v),
  expandTo: (id) => expandTo(id),
  // Budget report overlay (world.js's finance ledger) -- same console-verification pattern as
  // toggleWorldMap above.
  toggleFinance: (v) => toggleFinance(v),
  // Research/tech-tree handles (research.js) -- same console-verification pattern.
  toggleResearch: (v) => toggleResearch(v),
  research: () => world.research,
  researchNodes: RESEARCH_NODES,
  isToolUnlocked: (tool) => isToolUnlocked(world.research, tool),
  doResearch: (id) => tryResearch(world.research, id),
  audio: { isMuted, toggleMute, playBuildComplete, playTurretFire, playKill, playWaveAlert, playCitizenDowned },
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
    btn.classList.toggle('locked', !isToolUnlocked(world.research, btnTool));
  }
}

// ---------------------------------------------------------------- topbar controls
const pauseBtn = document.getElementById('btn-pause');
pauseBtn.addEventListener('click', () => input.togglePause());
document.getElementById('btn-speed-down').addEventListener('click', () => input.setSpeedIndex(input.speedIndex - 1));
document.getElementById('btn-speed-up').addEventListener('click', () => input.setSpeedIndex(input.speedIndex + 1));
document.getElementById('btn-save').addEventListener('click', () => save());
document.getElementById('btn-load').addEventListener('click', () => load());
document.getElementById('btn-restart').addEventListener('click', () => restart());
document.getElementById('btn-restart-modal').addEventListener('click', () => restart());
document.getElementById('btn-recenter').addEventListener('click', () => input.recenter());
document.getElementById('btn-worldmap').addEventListener('click', () => toggleWorldMap());
document.getElementById('btn-worldmap-close').addEventListener('click', () => toggleWorldMap(false));
document.getElementById('btn-finance').addEventListener('click', () => toggleFinance());
document.getElementById('btn-finance-close').addEventListener('click', () => toggleFinance(false));
document.getElementById('btn-research').addEventListener('click', () => toggleResearch());
document.getElementById('btn-research-close').addEventListener('click', () => toggleResearch(false));

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

// ---------------------------------------------------------------- minimap
const minimapEl = document.getElementById('minimap');
minimapEl.addEventListener('click', (e) => {
  const rect = minimapEl.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (minimapEl.width / rect.width);
  const my = (e.clientY - rect.top) * (minimapEl.height / rect.height);
  const wx = (mx / minimapEl.width) * world.width;
  const wy = (my / minimapEl.height) * world.height;
  renderer.jumpTo(wx, wy, world);
});

function save() {
  // The conquest map outlives any single SimWorld, so it's saved alongside the world payload
  // rather than inside it. SimWorld.deserialize ignores the extra key.
  localStorage.setItem(SAVE_KEY, JSON.stringify({ ...world.serialize(), worldMap: worldMap.serialize() }));
  showToast('Saved');
  console.log(`[SimWorldHost] Saved at tick ${world.currentTick}.`);
}

function load() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) { showToast('No save found'); return; }
  const parsed = JSON.parse(raw);
  world = SimWorld.deserialize(parsed);
  attachAudioHooks(world);
  if (parsed.worldMap) worldMap.deserialize(parsed.worldMap);
  renderer.frameOnContent(world);
  showToast('Loaded');
  console.log(`[SimWorldHost] Loaded from tick ${world.currentTick}.`);
}

function restart() {
  const seed = Math.floor(Math.random() * 0xffffffff);
  world = new SimWorld(64, 64, seed, 'Calm', 24);
  attachAudioHooks(world);
  renderer.frameOnContent(world);
  input.selectedCitizen = -1;
  input.selectedCitizens = [];
  console.log(`[SimWorldHost] New settlement, seed ${seed}.`);
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
  world = new SimWorld(64, 64, seed, 'Calm', 24);
  attachAudioHooks(world);
  renderer.frameOnContent(world);
  renderer.manualCamera = false;
  input.selectedCitizen = -1;
  input.selectedCitizens = [];
  lastLoggedCount = 0;
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
  if (e.key === 'F5') { e.preventDefault(); save(); }
  if (e.key === 'F9') { e.preventDefault(); load(); }
  if (e.key === 'r' || e.key === 'R') { restart(); }
});

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

let framesSinceReframe = 0;

function frame() {
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

  if (toastTimer > 0) { toastTimer--; if (toastTimer === 0) toastEl.classList.remove('show'); }
}

// setInterval instead of requestAnimationFrame: rAF is paused entirely in backgrounded/
// non-visible tabs in some embedding contexts, which would silently freeze the sim. A fixed
// 10Hz interval matches the tick rate directly and isn't subject to that pause.
setInterval(frame, SECONDS_PER_TICK * 1000);
