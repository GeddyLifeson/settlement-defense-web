// Player input: build palette, zone painting, pause/speed. This is what turns the sim into an
// actual game instead of a passive screensaver -- there was no player agency before this.
import { ZoneKind } from './zones.js';
import { BUILD_COST, spend, canAfford } from './economy.js';

export const TOOLS = [
  { key: '0', tool: null, label: 'Select', cost: null },
  { key: '1', tool: 'wall', label: 'Wall', cost: BUILD_COST.wall },
  { key: '2', tool: 'turret', label: 'Turret', cost: BUILD_COST.turret },
  { key: '3', tool: 'fence', label: 'Fence', cost: BUILD_COST.fence },
  { key: '4', tool: 'trap', label: 'Trap', cost: BUILD_COST.trap },
  { key: '5', tool: 'zone-food', label: 'Food Zone', cost: null },
  { key: '6', tool: 'zone-bedroom', label: 'Bedroom Zone', cost: null },
  { key: '7', tool: 'zone-recreation', label: 'Recreation Zone', cost: null },
];

const TOOL_KEYS = Object.fromEntries(TOOLS.map(t => [t.key, t.tool]));
TOOL_KEYS['Escape'] = null;

export class InputController {
  constructor(canvas, renderer, getWorld, onSpeedChange, onToast) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.getWorld = getWorld;
    this.onSpeedChange = onSpeedChange;
    this.onToast = onToast;
    this.tool = null;
    this.hoverGridX = null;
    this.hoverGridY = null;
    this.speedIndex = 1; // index into SPEEDS
    this.SPEEDS = [0, 1, 2, 4];
    this._painting = false;
    this.selectedCitizen = -1;

    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mousedown', (e) => this._onDown(e));
    canvas.addEventListener('mouseup', () => { this._painting = false; });
    canvas.addEventListener('mouseleave', () => { this.hoverGridX = null; this.hoverGridY = null; this._painting = false; });
    window.addEventListener('keydown', (e) => this._onKey(e));
  }

  setTool(tool) {
    this.tool = tool;
  }

  togglePause() {
    const w = this.getWorld();
    if (w) w.paused = !w.paused;
  }

  setSpeedIndex(i) {
    this.speedIndex = Math.max(0, Math.min(this.SPEEDS.length - 1, i));
    this.onSpeedChange?.(this.SPEEDS[this.speedIndex]);
  }

  _onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const [wx, wy] = this.renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    this.hoverWorldX = wx; this.hoverWorldY = wy;
    this.hoverGridX = Math.floor(wx);
    this.hoverGridY = Math.floor(wy);
    if (this._painting) this._place();
  }

  _onDown(e) {
    if (e.button !== 0) return;
    this._painting = true;
    this._place();
  }

  _place() {
    const world = this.getWorld();
    if (!world || this.hoverGridX == null) return;

    if (!this.tool) {
      this._pickCitizen(world);
      return;
    }

    const x = this.hoverGridX, y = this.hoverGridY;
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) return;

    if (this.tool.startsWith('zone-')) {
      const kind = { 'zone-food': ZoneKind.Food, 'zone-bedroom': ZoneKind.Bedroom, 'zone-recreation': ZoneKind.Recreation }[this.tool];
      world.zones.set(x, y, kind);
      return;
    }

    if (world.grid.wallThingId[world.grid.index(x, y)] !== 0) { this.onToast?.('Already occupied'); return; }
    for (const s of world.structures) {
      if (!s.destroyed && Math.floor(s.x) === x && Math.floor(s.y) === y) { this.onToast?.('Already occupied'); return; }
    }

    if (!canAfford(world, this.tool)) { this.onToast?.('Not enough scrap'); return; }
    spend(world, this.tool);
    if (this.tool === 'wall') {
      world.grid.setWall(x, y, 1);
    } else {
      world.build(this.tool, x + 0.5, y + 0.5);
    }
  }

  _pickCitizen(world) {
    let bestI = -1, bestDist = 0.8; // pick radius in world units
    for (let i = 0; i < world.citizens.count; i++) {
      if (!world.citizens.isAliveAt(i)) continue;
      const d = Math.hypot(world.citizens.x[i] - this.hoverWorldX, world.citizens.y[i] - this.hoverWorldY);
      if (d < bestDist) { bestDist = d; bestI = i; }
    }
    this.selectedCitizen = bestI;
  }

  _onKey(e) {
    if (e.key in TOOL_KEYS) { this.setTool(TOOL_KEYS[e.key]); return; }
    if (e.key === ' ') { e.preventDefault(); this.togglePause(); return; }
    if (e.key === '+' || e.key === '=') { this.setSpeedIndex(this.speedIndex + 1); return; }
    if (e.key === '-') { this.setSpeedIndex(this.speedIndex - 1); return; }
  }
}
