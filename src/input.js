// Player input: build palette, zone painting, pause/speed. This is what turns the sim into an
// actual game instead of a passive screensaver -- there was no player agency before this.
import { ZoneKind } from './zones.js';
import { BUILD_COST, spend, canAfford } from './economy.js';

const TOOL_KEYS = {
  '1': 'wall', '2': 'turret', '3': 'fence', '4': 'trap',
  '5': 'zone-food', '6': 'zone-bedroom', '7': 'zone-recreation',
  '0': null, 'Escape': null,
};

export class InputController {
  constructor(canvas, renderer, getWorld, onSpeedChange) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.getWorld = getWorld;
    this.onSpeedChange = onSpeedChange;
    this.tool = null;
    this.hoverGridX = null;
    this.hoverGridY = null;
    this.speedIndex = 1; // index into SPEEDS
    this.SPEEDS = [0, 1, 2, 4];
    this._painting = false;
    this.lastMessage = '';
    this.selectedCitizen = -1;

    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mousedown', (e) => this._onDown(e));
    canvas.addEventListener('mouseup', () => { this._painting = false; });
    canvas.addEventListener('mouseleave', () => { this.hoverGridX = null; this.hoverGridY = null; this._painting = false; });
    window.addEventListener('keydown', (e) => this._onKey(e));
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

    if (world.grid.wallThingId[world.grid.index(x, y)] !== 0) { this.lastMessage = 'occupied'; return; }
    for (const s of world.structures) {
      if (!s.destroyed && Math.floor(s.x) === x && Math.floor(s.y) === y) { this.lastMessage = 'occupied'; return; }
    }

    if (!canAfford(world, this.tool)) { this.lastMessage = 'not enough scrap'; return; }
    spend(world, this.tool);
    if (this.tool === 'wall') {
      world.grid.setWall(x, y, 1);
    } else {
      world.build(this.tool, x + 0.5, y + 0.5);
    }
    this.lastMessage = '';
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
    if (e.key in TOOL_KEYS) { this.tool = TOOL_KEYS[e.key]; return; }
    if (e.key === ' ') { e.preventDefault(); const w = this.getWorld(); if (w) w.paused = !w.paused; return; }
    if (e.key === '+' || e.key === '=') { this.speedIndex = Math.min(this.SPEEDS.length - 1, this.speedIndex + 1); this.onSpeedChange?.(this.SPEEDS[this.speedIndex]); return; }
    if (e.key === '-') { this.speedIndex = Math.max(0, this.speedIndex - 1); this.onSpeedChange?.(this.SPEEDS[this.speedIndex]); return; }
  }

  paletteText() {
    const lines = ['[1]Wall $' + BUILD_COST.wall, '[2]Turret $' + BUILD_COST.turret, '[3]Fence $' + BUILD_COST.fence,
      '[4]Trap $' + BUILD_COST.trap, '[5]FoodZone', '[6]BedZone', '[7]RecZone', '[0]Select'];
    return lines.map(l => this.tool && l.includes(`[${Object.keys(TOOL_KEYS).find(k => TOOL_KEYS[k] === this.tool)}]`) ? `*${l}*` : l).join('  ');
  }
}
