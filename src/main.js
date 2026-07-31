// Ported from SD.Presentation/SimWorldHost.cs -- owns one SimWorld, steps it at a fixed
// 10 Hz tick rate independent of frame rate, and renders every frame.
import { SimWorld } from './world.js';
import { Renderer } from './render.js';
import { InputController } from './input.js';

const SECONDS_PER_TICK = 0.1;
const SAVE_KEY = 'settlement-defense-save';

const canvas = document.getElementById('game');
const hud = document.getElementById('hud');
const renderer = new Renderer(canvas);
renderer.resize();
window.addEventListener('resize', () => renderer.resize());

let world = new SimWorld(64, 64, 12345, 'Calm', 24);
renderer.frameOnContent(world);

let speedMultiplier = 1;
const input = new InputController(canvas, renderer, () => world, (s) => { speedMultiplier = s; });

window.__debug = { getWorld: () => world, input, renderer };

function save() {
  localStorage.setItem(SAVE_KEY, JSON.stringify(world.serialize()));
  console.log(`[SimWorldHost] Saved at tick ${world.currentTick}.`);
}

function load() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) { console.warn('[SimWorldHost] No save found.'); return; }
  world = SimWorld.deserialize(JSON.parse(raw));
  renderer.frameOnContent(world);
  console.log(`[SimWorldHost] Loaded from tick ${world.currentTick}.`);
}

function restart() {
  const seed = Math.floor(Math.random() * 0xffffffff);
  world = new SimWorld(64, 64, seed, 'Calm', 24);
  renderer.frameOnContent(world);
  console.log(`[SimWorldHost] New settlement, seed ${seed}.`);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'F5') { e.preventDefault(); save(); }
  if (e.key === 'F9') { e.preventDefault(); load(); }
  if (e.key === 'r' || e.key === 'R') { restart(); }
});

let framesSinceReframe = 0;

function frame() {
  for (let s = 0; s < speedMultiplier; s++) world.tick();

  renderer.draw(world, input);

  // Re-center the camera on the settlement periodically (not every frame -- avoids jitter
  // from single-citizen movement) so newly built structures/zones stay in view.
  framesSinceReframe++;
  if (framesSinceReframe > 50) { framesSinceReframe = 0; renderer.frameOnContent(world); }

  const aliveCitizens = countAlive(world.citizens.count, world.citizens.isAliveAt.bind(world.citizens));
  const aliveAttackers = countAlive(world.attackers.count, world.attackers.isAliveAt.bind(world.attackers));
  const state = world.gameOver ? 'GAME OVER' : world.paused ? 'PAUSED' : `speed x${speedMultiplier}`;
  const lastEvents = world.milestoneLog.slice(-3).map(e => e.text).join(' | ');

  let selectedInfo = '';
  const sel = input.selectedCitizen;
  if (sel >= 0 && sel < world.citizens.count && world.citizens.isAliveAt(sel)) {
    const c = world.citizens;
    const role = world.roster.isStaff(c.id[sel]) ? world.roster.kindOf(c.id[sel]) : 'Citizen';
    selectedInfo = `\n${c.name[sel]} (${role}) [${c.trait[sel]?.name ?? '?'}] | HP ${(c.health[sel] * 100).toFixed(0)}% | ` +
      `Hunger ${(c.hunger[sel] * 100).toFixed(0)}% Rest ${(c.rest[sel] * 100).toFixed(0)}% ` +
      `Social ${(c.social[sel] * 100).toFixed(0)}% Mood ${(c.mood[sel] * 100).toFixed(0)}% | ` +
      `CombatSkill ${c.skillCombat[sel].toFixed(2)}`;
  } else if (sel >= 0) {
    input.selectedCitizen = -1;
  }

  hud.textContent =
    `Tick ${world.currentTick} | ${state} | Citizens ${aliveCitizens} | Attackers ${aliveAttackers} | ` +
    `Scrap ${world.scrap} | Wave ${world.waveSpawner.waveNumber}\n` +
    `${input.paletteText()}\n` +
    `Space=pause  +/-=speed  F5/F9=save/load  R=restart\n` +
    (lastEvents ? `${lastEvents}` : '') +
    (input.lastMessage ? `  [${input.lastMessage}]` : '') +
    selectedInfo +
    (world.gameOver ? '\n\nGAME OVER -- press R to start a new settlement' : '');
}

function countAlive(count, isAliveAt) {
  let n = 0;
  for (let i = 0; i < count; i++) if (isAliveAt(i)) n++;
  return n;
}

// setInterval instead of requestAnimationFrame: rAF is paused entirely in backgrounded/
// non-visible tabs in some embedding contexts, which would silently freeze the sim. A fixed
// 10Hz interval matches the tick rate directly and isn't subject to that pause.
setInterval(frame, SECONDS_PER_TICK * 1000);
