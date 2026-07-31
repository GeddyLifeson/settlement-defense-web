// Player input: build palette, zone painting, pause/speed. This is what turns the sim into an
// actual game instead of a passive screensaver -- there was no player agency before this.
import { ZoneKind } from './zones.js';
import { BUILD_COST, spend, canAfford } from './economy.js';
import { isToolUnlocked, researchNodeForTool } from './research.js';

export const TOOLS = [
  { key: '0', tool: null, label: 'Select', cost: null },
  { key: '1', tool: 'wall', label: 'Wall', cost: BUILD_COST.wall },
  { key: '2', tool: 'turret', label: 'Turret', cost: BUILD_COST.turret },
  { key: '3', tool: 'fence', label: 'Fence', cost: BUILD_COST.fence },
  { key: '4', tool: 'trap', label: 'Trap', cost: BUILD_COST.trap },
  { key: '5', tool: 'zone-food', label: 'Food Zone', cost: null },
  { key: '6', tool: 'zone-bedroom', label: 'Bedroom Zone', cost: null },
  { key: '7', tool: 'zone-recreation', label: 'Recreation Zone', cost: null },
  { key: 'b', tool: 'bed', label: 'Bed', cost: BUILD_COST.bed },
  { key: 't', tool: 'table', label: 'Table', cost: BUILD_COST.table },
  { key: 'y', tool: 'door', label: 'Door', cost: BUILD_COST.door },
  { key: 'g', tool: 'generator', label: 'Generator', cost: BUILD_COST.generator },
  { key: 'w', tool: 'wire', label: 'Wire', cost: BUILD_COST.wire },
  // Water/plumbing grid (water.js): mirrors the generator/wire pair exactly -- a pump is the
  // source, pipe is the conduit -- but feeds Food/Recreation zone refill rate and the Recycling
  // Center's pollution-processing rate instead of turrets/tesla/watchtower.
  { key: 'q', tool: 'pump', label: 'Water Pump', cost: BUILD_COST.pump },
  { key: 'z', tool: 'pipe', label: 'Pipe', cost: BUILD_COST.pipe },
  // SEA:R truck fuel-type tradeoff (vehicles.js FUEL_TYPES): each garage now comes in 4 fuel
  // variants instead of one -- fossil (cheap/dirty), gas (best all-around), ethanol (clean,
  // temporarily saps Food zone refill per haul), electric (cleanest, needs the garage powered
  // or hauls crawl). The bare 'garage_recycling'/'garage_garbage' kinds still exist in
  // economy.js/vehicles.js for save-compat but are no longer offered directly in the toolbar.
  { key: 'v', tool: 'garage_recycling_fossil', label: 'Recycling Garage (Fossil)', cost: BUILD_COST.garage_recycling_fossil },
  { key: 'i', tool: 'garage_recycling_gas', label: 'Recycling Garage (Gas)', cost: BUILD_COST.garage_recycling_gas },
  { key: 'e', tool: 'garage_recycling_ethanol', label: 'Recycling Garage (Ethanol)', cost: BUILD_COST.garage_recycling_ethanol },
  { key: 'l', tool: 'garage_recycling_electric', label: 'Recycling Garage (Electric)', cost: BUILD_COST.garage_recycling_electric },
  { key: 'n', tool: 'garage_garbage_fossil', label: 'Garbage Garage (Fossil)', cost: BUILD_COST.garage_garbage_fossil },
  { key: 'h', tool: 'garage_garbage_gas', label: 'Garbage Garage (Gas)', cost: BUILD_COST.garage_garbage_gas },
  { key: 'o', tool: 'garage_garbage_ethanol', label: 'Garbage Garage (Ethanol)', cost: BUILD_COST.garage_garbage_ethanol },
  { key: 'p', tool: 'garage_garbage_electric', label: 'Garbage Garage (Electric)', cost: BUILD_COST.garage_garbage_electric },
  { key: 'c', tool: 'watchtower', label: 'Watchtower', cost: BUILD_COST.watchtower },
  { key: 'f', tool: 'floodlight', label: 'Floodlight', cost: BUILD_COST.floodlight },
  { key: 'x', tool: 'tesla', label: 'Tesla Coil', cost: BUILD_COST.tesla },
  { key: 'r', tool: 'recycling_center', label: 'Recycling Center', cost: BUILD_COST.recycling_center },
  { key: 'k', tool: 'camera', label: 'CCTV Camera', cost: BUILD_COST.camera },
  { key: 'm', tool: 'monitor_station', label: 'Monitor Station', cost: BUILD_COST.monitor_station },
  { key: 'u', tool: 'generator_nuclear', label: 'Nuclear Generator', cost: BUILD_COST.generator_nuclear },
  { key: 'j', tool: 'waste_storage', label: 'Waste Storage', cost: BUILD_COST.waste_storage },
  // Armory (security.js WEAPON_TIERS/tickArmoryIssuance): once built, every Guard/Sniper on the
  // roster is automatically issued Rifle tier (a second Armory unlocks Heavy) -- no per-citizen
  // pick-a-tier UI, per FEATURE_RESEARCH.md's scoped version of the Prison Architect armory idea.
  { key: 'a', tool: 'armory', label: 'Armory', cost: BUILD_COST.armory },
  // SEA:R multi-source power economy (FEATURE_RESEARCH.md): coal/wind/solar generator variants,
  // each a real siting/tradeoff decision instead of a strict upgrade over plain 'generator' --
  // see economy.js's BUILD_COST comment and power.js's isSource for how each tradeoff is enforced.
  { key: 'd', tool: 'generator_coal', label: 'Coal Generator', cost: BUILD_COST.generator_coal },
  { key: 's', tool: 'generator_wind', label: 'Wind Turbine', cost: BUILD_COST.generator_wind },
  { key: '8', tool: 'generator_solar', label: 'Solar Array', cost: BUILD_COST.generator_solar },
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
    // Multi-select via marquee drag (Select tool only, see _onDown/_onUp): a plain click still
    // goes through selectedCitizen above and is untouched by any of this.
    this.selectedCitizens = [];
    this.marqueeActive = false;
    this.marqueeStartWorldX = 0; this.marqueeStartWorldY = 0;
    this.marqueeEndWorldX = 0; this.marqueeEndWorldY = 0;

    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mousedown', (e) => this._onDown(e));
    canvas.addEventListener('mouseup', (e) => this._onUp(e));
    canvas.addEventListener('mouseleave', () => { this.hoverGridX = null; this.hoverGridY = null; this._painting = false; this._panning = false; this.marqueeActive = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag is pan, not a context menu
    canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
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

  _updateHover(e) {
    const rect = this.canvas.getBoundingClientRect();
    const [wx, wy] = this.renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    this.hoverWorldX = wx; this.hoverWorldY = wy;
    this.hoverGridX = Math.floor(wx);
    this.hoverGridY = Math.floor(wy);
  }

  _onMove(e) {
    if (this._panning) {
      this.renderer.panByScreenDelta(e.clientX - this._panLastX, e.clientY - this._panLastY, this.getWorld());
      this._panLastX = e.clientX; this._panLastY = e.clientY;
      return;
    }
    this._updateHover(e);
    if (this._painting) this._place();
    // Marquee only ever runs with the Select tool (see _onDown) and never overlaps painting.
    if (this.marqueeActive) { this.marqueeEndWorldX = this.hoverWorldX; this.marqueeEndWorldY = this.hoverWorldY; }
  }

  _onDown(e) {
    // Right-click and middle-click drag the camera; left-click keeps its build/select role.
    // There was previously no way to move the camera by hand at all -- it was 100% auto-framed.
    if (e.button === 2 || e.button === 1) {
      e.preventDefault();
      this._panning = true;
      this._panLastX = e.clientX; this._panLastY = e.clientY;
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === null) {
      // Select tool: try an immediate single pick first (this is the existing plain-click path,
      // completely unchanged). Only if that pick lands on empty ground do we arm a possible
      // marquee drag -- if the mouseup never moves it stays a no-op deselect-click, exactly as
      // before this feature existed.
      this._updateHover(e);
      const world = this.getWorld();
      if (world) this._pickCitizen(world);
      this.selectedCitizens = [];
      if (this.selectedCitizen === -1 && world) {
        this.marqueeActive = true;
        this.marqueeStartWorldX = this.hoverWorldX; this.marqueeStartWorldY = this.hoverWorldY;
        this.marqueeEndWorldX = this.hoverWorldX; this.marqueeEndWorldY = this.hoverWorldY;
      }
      return;
    }

    this._painting = true;
    this._place();
  }

  _onUp(e) {
    if (e.button === 2 || e.button === 1) { this._panning = false; return; }
    this._painting = false;
    if (this.marqueeActive) {
      this.marqueeActive = false;
      const world = this.getWorld();
      const dx = this.marqueeEndWorldX - this.marqueeStartWorldX;
      const dy = this.marqueeEndWorldY - this.marqueeStartWorldY;
      // Below this distance it's a click, not a drag -- the single-pick from _onDown already
      // handled it (selected a citizen, or deselected on empty ground), so leave it alone.
      if (world && Math.hypot(dx, dy) > 0.5) {
        const x0 = Math.min(this.marqueeStartWorldX, this.marqueeEndWorldX);
        const x1 = Math.max(this.marqueeStartWorldX, this.marqueeEndWorldX);
        const y0 = Math.min(this.marqueeStartWorldY, this.marqueeEndWorldY);
        const y1 = Math.max(this.marqueeStartWorldY, this.marqueeEndWorldY);
        const picked = [];
        for (let i = 0; i < world.citizens.count; i++) {
          if (!world.citizens.isAliveAt(i)) continue;
          const cx = world.citizens.x[i], cy = world.citizens.y[i];
          if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) picked.push(i);
        }
        this.selectedCitizens = picked;
      }
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.renderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor, this.getWorld());
  }

  recenter() {
    const world = this.getWorld();
    if (world) this.renderer.recenter(world);
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

    // Tech gate (research.js) -- checked BEFORE the scrap check so a locked buildable reports the
    // real reason rather than a misleading "Not enough scrap". Fails open for ungated tools.
    if (!isToolUnlocked(world.research, this.tool)) {
      const node = researchNodeForTool(this.tool);
      this.onToast?.(`Locked -- research "${node ? node.name : 'unknown'}" first`);
      return;
    }

    if (!canAfford(world, this.tool)) { this.onToast?.('Not enough scrap'); return; }
    spend(world, this.tool);
    // Every buildable -- including walls -- is placed as a blueprint that a citizen has to
    // walk over and actually construct (see jobs.js JobState.Building), not instant placement.
    world.build(this.tool, x + 0.5, y + 0.5);
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
    // No world means the title screen is up (main.js boots lazily) -- every shortcut below is a
    // gameplay shortcut, and none of them should fire over a menu. The typing guard is for the
    // New Game setup form's seed box, where letters like 'b'/'t'/'m' are just text.
    if (!this.getWorld()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // Conquest map overlay (worldmap.js). Bound to SHIFT+M, not plain 'm' -- lowercase 'm' is
    // already the Monitor Station buildable's hotkey in TOOLS, so this deliberately only claims
    // the uppercase variant and lets 'm' fall through to the tool table below. main.js supplies
    // onToggleMap.
    if (e.key === 'M') { this.onToggleMap?.(); return; }
    // Budget report overlay (world.js's finance ledger, surfaced in main.js). SHIFT+B for the
    // same reason as SHIFT+M above -- lowercase 'b' is already the Bed buildable's hotkey.
    if (e.key === 'B') { this.onToggleFinance?.(); return; }
    // Research/tech tree overlay (research.js, surfaced in main.js). SHIFT+T, same
    // uppercase-only convention -- lowercase 't' is the Table buildable's hotkey. Note SHIFT+R
    // is NOT available: main.js binds both 'r' and 'R' to restart().
    if (e.key === 'T') { this.onToggleResearch?.(); return; }
    // Onboarding reference panel (tutorial.js, surfaced in main.js). F1 and '?' are both free --
    // '?' is Shift+/ and appears in no TOOL_KEYS entry, and F1 collides with nothing here or in
    // main.js's F5/F9 save/load bindings. F1 needs preventDefault or the browser opens its own help.
    if (e.key === 'F1' || e.key === '?') { e.preventDefault(); this.onToggleHelp?.(); return; }
    if (e.key === 'Escape' && this.onToggleMap) { this.onCloseMap?.(); /* falls through to clear tool */ }
    if (e.key === 'Escape' && this.onToggleResearch) { this.onCloseResearch?.(); /* falls through to clear tool */ }
    if (e.key === 'Escape' && this.onToggleFinance) { this.onCloseFinance?.(); /* falls through to clear tool */ }
    if (e.key in TOOL_KEYS) { this.setTool(TOOL_KEYS[e.key]); return; }
    if (e.key === ' ') { e.preventDefault(); this.togglePause(); return; }
    if (e.key === '+' || e.key === '=') { this.setSpeedIndex(this.speedIndex + 1); return; }
    if (e.key === '-') { this.setSpeedIndex(this.speedIndex - 1); return; }
  }
}
