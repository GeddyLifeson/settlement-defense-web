// Ported from SD.Presentation/SimWorldHost.cs -- owns one SimWorld, steps it at a fixed
// 10 Hz tick rate independent of frame rate, and renders every frame.
import { SimWorld } from './world.js';
import { Renderer } from './render.js';
import { InputController, TOOLS } from './input.js';
import { isNight } from './schedule.js';
import { worldMap } from './worldmap.js';
import { playBuildComplete, playWaveAlert, playTurretFire, playKill, playCitizenDowned, isMuted, toggleMute } from './audio.js';

const SECONDS_PER_TICK = 0.1;
const SAVE_KEY = 'settlement-defense-save';

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
  audio: { isMuted, toggleMute, playBuildComplete, playTurretFire, playKill, playWaveAlert, playCitizenDowned },
};

// ---------------------------------------------------------------- toolbar (built once)
const toolbarEl = document.getElementById('toolbar');
for (const t of TOOLS) {
  const btn = document.createElement('div');
  btn.className = 'tool-btn';
  btn.dataset.tool = t.tool ?? '';
  btn.innerHTML = `<span><span class="key">[${t.key}]</span>${t.label}</span>` +
    (t.cost != null ? `<span class="cost">$${t.cost}</span>` : '');
  btn.addEventListener('click', () => input.setTool(t.tool));
  toolbarEl.appendChild(btn);
}

function syncToolbarHighlight() {
  for (const btn of toolbarEl.children) {
    const btnTool = btn.dataset.tool || null;
    btn.classList.toggle('active', btnTool === input.tool);
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
  document.getElementById('insp-name').textContent = c.name[sel];
  document.getElementById('insp-role').textContent = `${role} · ${c.trait[sel]?.name ?? ''}`;
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
    `Combat: ${skillLevel(c.skillCombat[sel])} · Construction: ${skillLevel(c.skillConstruction[sel])}`;
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
  const pollutionEl = document.getElementById('stat-pollution');
  pollutionEl.textContent = Math.round(world.pollution);
  pollutionEl.classList.toggle('danger', world.pollution > 150);
  const night = isNight(world.timeOfDay);
  document.getElementById('stat-daynight-icon').textContent = night ? '🌙' : '☀';
  document.getElementById('stat-daynight').textContent = (night ? 'Night ' : 'Day ') + Math.round(world.timeOfDay * 100) + '%';
  pauseBtn.textContent = world.paused ? '▶ Resume' : '⏸ Pause';
  pauseBtn.classList.toggle('active', world.paused);
  document.getElementById('speed-label').textContent = speedMultiplier + 'x';
}

function countAlive(count, isAliveAt) {
  let n = 0;
  for (let i = 0; i < count; i++) if (isAliveAt(i)) n++;
  return n;
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

  if (toastTimer > 0) { toastTimer--; if (toastTimer === 0) toastEl.classList.remove('show'); }
}

// setInterval instead of requestAnimationFrame: rAF is paused entirely in backgrounded/
// non-visible tabs in some embedding contexts, which would silently freeze the sim. A fixed
// 10Hz interval matches the tick rate directly and isn't subject to that pause.
setInterval(frame, SECONDS_PER_TICK * 1000);
