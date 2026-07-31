// Ported from SD.Presentation/SimWorldHost.cs -- owns one SimWorld, steps it at a fixed
// 10 Hz tick rate independent of frame rate, and renders every frame.
import { SimWorld } from './world.js';
import { Renderer } from './render.js';
import { InputController, TOOLS } from './input.js';

const SECONDS_PER_TICK = 0.1;
const SAVE_KEY = 'settlement-defense-save';

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);
renderer.resize();
window.addEventListener('resize', () => renderer.resize());

let world = new SimWorld(64, 64, 12345, 'Calm', 24);
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

window.__debug = { getWorld: () => world, input, renderer };

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

function save() {
  localStorage.setItem(SAVE_KEY, JSON.stringify(world.serialize()));
  showToast('Saved');
  console.log(`[SimWorldHost] Saved at tick ${world.currentTick}.`);
}

function load() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) { showToast('No save found'); return; }
  world = SimWorld.deserialize(JSON.parse(raw));
  renderer.frameOnContent(world);
  showToast('Loaded');
  console.log(`[SimWorldHost] Loaded from tick ${world.currentTick}.`);
}

function restart() {
  const seed = Math.floor(Math.random() * 0xffffffff);
  world = new SimWorld(64, 64, seed, 'Calm', 24);
  renderer.frameOnContent(world);
  input.selectedCitizen = -1;
  console.log(`[SimWorldHost] New settlement, seed ${seed}.`);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'F5') { e.preventDefault(); save(); }
  if (e.key === 'F9') { e.preventDefault(); load(); }
  if (e.key === 'r' || e.key === 'R') { restart(); }
});

// ---------------------------------------------------------------- inspector panel
const inspectorEl = document.getElementById('inspector');
function updateInspector() {
  const sel = input.selectedCitizen;
  if (sel < 0 || sel >= world.citizens.count || !world.citizens.isAliveAt(sel)) {
    if (sel >= 0) input.selectedCitizen = -1;
    inspectorEl.classList.add('hidden');
    return;
  }
  inspectorEl.classList.remove('hidden');
  const c = world.citizens;
  const role = world.roster.isStaff(c.id[sel]) ? world.roster.kindOf(c.id[sel]) : 'Citizen';
  document.getElementById('insp-name').textContent = c.name[sel];
  document.getElementById('insp-role').textContent = `${role} · ${c.trait[sel]?.name ?? ''}`;
  setBar('hp', c.health[sel]);
  setBar('hunger', c.hunger[sel]);
  setBar('rest', c.rest[sel]);
  setBar('social', c.social[sel]);
  setBar('mood', c.mood[sel]);
  document.getElementById('insp-skill').textContent = `Combat skill: ${c.skillCombat[sel].toFixed(2)}`;
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
  document.getElementById('stat-scrap').textContent = world.scrap;
  document.getElementById('stat-citizens').textContent = countAlive(world.citizens.count, world.citizens.isAliveAt.bind(world.citizens));
  document.getElementById('stat-attackers').textContent = countAlive(world.attackers.count, world.attackers.isAliveAt.bind(world.attackers));
  document.getElementById('stat-wave').textContent = world.waveSpawner.waveNumber;
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

  framesSinceReframe++;
  if (framesSinceReframe > 50) { framesSinceReframe = 0; renderer.frameOnContent(world); }

  updateTopbar();
  syncToolbarHighlight();
  updateInspector();
  updateEventLog();
  updateGameOver();

  if (toastTimer > 0) { toastTimer--; if (toastTimer === 0) toastEl.classList.remove('show'); }
}

// setInterval instead of requestAnimationFrame: rAF is paused entirely in backgrounded/
// non-visible tabs in some embedding contexts, which would silently freeze the sim. A fixed
// 10Hz interval matches the tick rate directly and isn't subject to that pause.
setInterval(frame, SECONDS_PER_TICK * 1000);
