// Player input: build palette, zone painting, pause/speed. This is what turns the sim into an
// actual game instead of a passive screensaver -- there was no player agency before this.
import { ZoneKind } from './zones.js';
import { BUILD_COST, spend, canAfford } from './economy.js';
import { isToolUnlocked, researchNodeForTool } from './research.js';
import { nearestAliveAttacker } from './siege.js';
import { issueMoveOrder, issueAttackOrder } from './draft.js';
import { forceJob, ForceJobKind, pickClosestUndraftedCitizen } from './forcejob.js';
import { roomContaining } from './rooms.js';
import { MESS_CLEAN_THRESHOLD } from './jobs.js';

// Draft/undraft order-issuing (draft.js): right-click auto-detects move-vs-attack by what's under
// the cursor -- an attacker within this pick radius (world units, same ballpark as _pickCitizen's
// own 0.8-unit citizen-pick radius below) means "attack this", anything else means "move here".
const ORDER_ATTACK_PICK_RADIUS = 0.9;
// Right-click-drag is already used for camera pan (see _onDown/_onMove below); a right-click-and-
// release-WITHOUT-drag is the separate "issue an order" gesture. Distinguished by total on-screen
// movement (pixels) between right-mousedown and right-mouseup staying under this threshold.
const RIGHT_CLICK_ORDER_THRESHOLD_PX = 6;

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
  // Battery/power switch (power.js's storage + manual-breaker mechanics). Every letter a-z and
  // digit 0-8 is already claimed by an existing tool -- '9' and the bracket keys are the first
  // free ones left, chosen over any modifier-key combo to keep single-keypress tool switching.
  { key: '9', tool: 'battery', label: 'Battery', cost: BUILD_COST.battery },
  // Power Switch doesn't just place -- clicking an EXISTING power_switch tile with this tool
  // selected toggles it instead (see _onDown below), so the same key both places new switches and
  // flips ones already built.
  { key: '[', tool: 'power_switch', label: 'Power Switch (click existing to toggle)', cost: BUILD_COST.power_switch },
  // Processing station (Prison Architect materials-chain analog, see jobs.js's Processing job /
  // siege.js's Structure 'workshop' kind): ']' is the next free key after power_switch claimed '['.
  { key: ']', tool: 'workshop', label: 'Processing Station', cost: BUILD_COST.workshop },
  // Training Zone (programs.js's Skills Workshop program, see zones.js's ZoneKind.Training /
  // rooms.js's RoomRole.Training) -- every letter/digit/bracket is claimed above, ';' is the next
  // free single-keypress key.
  { key: ';', tool: 'zone-training', label: 'Training Zone', cost: null },
  // Rat Trap (rats.js's real Prison Architect infestation countermeasure) -- ';' just claimed the
  // last easy punctuation key, "'" is the next free one.
  { key: "'", tool: 'rat_trap', label: 'Rat Trap', cost: BUILD_COST.rat_trap },
  // Restrict Area (RimWorld Restrict-tab style, see citizens.js's paintAllowedAreaMask/
  // isInAllowedArea and jobs.js's per-citizen allowedCheck): paints which cells the CURRENTLY
  // SELECTED citizen's autonomous pathing/job-seeking is confined to -- not a normal buildable
  // (cost: null, same as the zone tools), and _place() below special-cases it to write into
  // that one citizen's mask instead of the shared world.zones grid. "'" just claimed the last
  // easy punctuation key, ',' is the next free one.
  { key: ',', tool: 'restrict-area', label: 'Restrict Area (paints for the selected citizen)', cost: null },
  // Storage/Medical/Command room roles (rooms.js RoomRole.Storage/Medical/Command, PA full
  // prefab/object catalog): three new cheap zone+furniture room roles, same "zone + minimum
  // furniture" pattern as Bedroom/Dining/Recreation/Training. Every easy single-keypress key is
  // claimed above -- '.', '/', and '\\' are the last free punctuation keys.
  { key: '.', tool: 'zone-storage', label: 'Storage Zone', cost: null },
  { key: '/', tool: 'zone-medical', label: 'Medical Zone', cost: null },
  { key: '\\', tool: 'zone-command', label: 'Command Zone', cost: null },
  // '=' and '-' are already claimed by the speed-up/speed-down hotkeys (see _onKey below, checked
  // AFTER the TOOL_KEYS table so binding them here would silently break speed control) -- '`' and
  // shift-1 ('!') are the last free keys.
  { key: '`', tool: 'shelf', label: 'Shelf', cost: BUILD_COST.shelf },
  { key: '!', tool: 'medical_bed', label: 'Medical Bed', cost: BUILD_COST.medical_bed },
  // Stabilizer Beacon (anomaly.js's new colony-wide pressure meter, this pass's "real in-game
  // response" buildable) -- every unshifted single-keypress key is claimed above; '@' (shift+2)
  // is the next free one.
  { key: '@', tool: 'stabilizer', label: 'Stabilizer Beacon', cost: BUILD_COST.stabilizer },
  // Shrine (RimWorld Ideology DLC's real altar buildable, rooms.js's BEAUTY_BY_KIND.shrine): a
  // single-tier, beauty-only passive building -- every unshifted/shift-digit key is claimed
  // above, '#' (shift+3) is the next free one.
  { key: '#', tool: 'shrine', label: 'Shrine', cost: BUILD_COST.shrine },
  // Lightning Rod (weather.js's Lightning Storm calamity mitigation item, real Prison Architect
  // calamity_settings.txt buildable) -- every unshifted/shift-digit key up through '#' is claimed
  // above, '$' (shift+4) is the next free one.
  { key: '$', tool: 'lightning_rod', label: 'Lightning Rod', cost: BUILD_COST.lightning_rod },
  // Fabrication Bay (drones.js -- RimWorld Biotech's mech-companion labor drone): unlocks drone
  // capacity, same "a building unlocks capacity" pattern as Armory -- every unshifted/shift-digit
  // key up through '$' is claimed above, '%' (shift+5) is the next free one.
  { key: '%', tool: 'fabrication_bay', label: 'Fabrication Bay', cost: BUILD_COST.fabrication_bay },
  // Gymnasium room role (rooms.js RoomRole.Gymnasium, PA needs.txt Exercise need): same
  // "zone + minimum furniture" pattern as Storage/Medical/Command above -- Fitness Station is the
  // ONE new buildable (economy.js's BUILD_COST.fitness_station), standing in for PA's whole real
  // gym-equipment catalog. Every unshifted/shift-digit key up through '%' is claimed above, '^'
  // (shift+6) and '&' (shift+7) are the next free ones.
  { key: '^', tool: 'zone-gymnasium', label: 'Gymnasium Zone', cost: null },
  { key: '&', tool: 'fitness_station', label: 'Fitness Station', cost: BUILD_COST.fitness_station },
  // Farm Plot (research.js's Agronomy node, jobs.js's Farming job): a renewable citizen-tended
  // producer, distinct from the resource-node scrap-harvest loop. Every unshifted/shift-digit key
  // up through '&' is claimed above, '*' (shift+8) is the next free one.
  { key: '*', tool: 'farm_plot', label: 'Farm Plot', cost: BUILD_COST.farm_plot },
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

    // Right-click order gesture (draft.js): tracks total on-screen movement since a right-
    // mousedown so _onUp can tell an order-issuing click apart from a camera-pan drag -- see
    // RIGHT_CLICK_ORDER_THRESHOLD_PX above.
    this._rightDownX = null; this._rightDownY = null; this._rightMoved = false;

    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mousedown', (e) => this._onDown(e));
    canvas.addEventListener('mouseup', (e) => this._onUp(e));
    canvas.addEventListener('mouseleave', () => { this.hoverGridX = null; this.hoverGridY = null; this._painting = false; this._panning = false; this.marqueeActive = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag is pan, not a context menu
    canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this._onKey(e));

    // ---- Touch input (strictly additive; every mouse path above is untouched) ----------------
    // Touch is translated into the SAME internal state the mouse handlers use (_painting,
    // _panning, marquee*) by synthesizing {clientX, clientY, button} shims and feeding them to
    // _onDown/_onMove/_onUp -- so one-finger paint, one-finger marquee, tap-to-select and the
    // 0.5-world-unit click-vs-drag threshold all behave identically to mouse without a second
    // implementation. Only two-finger pan/pinch needs its own state, because there is no mouse
    // gesture that pans and zooms simultaneously.
    this._touchId = null;         // identifier of the single finger driving paint/marquee/tap
    this._touchTapX = 0; this._touchTapY = 0; this._touchTapT = 0;
    this._touchMoved = false;
    this._pinchDist = 0;          // distance between the two fingers on the previous move
    this._pinchMidX = 0; this._pinchMidY = 0;
    // passive:false on all four so preventDefault() actually suppresses the browser's native
    // scroll/pinch-zoom. These are bound to the canvas element only -- topbar/toolbar/panel DOM
    // buttons are outside it and keep their native tap->click behaviour untouched.
    canvas.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
    canvas.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    canvas.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: false });
    canvas.addEventListener('touchcancel', (e) => this._onTouchCancel(e), { passive: false });
  }

  // Mouse-event shim: the existing handlers only ever read clientX/clientY/button/preventDefault,
  // so a Touch can stand in for a MouseEvent verbatim.
  _touchAsMouse(t, button = 0) {
    return { clientX: t.clientX, clientY: t.clientY, button, preventDefault() {} };
  }

  _findTouch(list, id) {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  }

  // Drop whatever the single finger had armed, without committing it (used when a second finger
  // arrives and the gesture turns out to be a pan/pinch rather than a paint or marquee).
  _abortSingleTouch() {
    this._touchId = null;
    this._painting = false;
    this.marqueeActive = false;
  }

  _beginPinch(a, b) {
    this._pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this._pinchMidX = (a.clientX + b.clientX) / 2;
    this._pinchMidY = (a.clientY + b.clientY) / 2;
    this._panning = true;
  }

  _onTouchStart(e) {
    e.preventDefault(); // suppress native scroll/zoom/double-tap on the game canvas
    if (e.touches.length >= 2) {
      // Two (or more) fingers: pan + pinch. Cancel anything the first finger armed so a
      // two-finger gesture never leaves a stray blueprint or half-drawn marquee behind.
      if (this._touchId !== null) this._abortSingleTouch();
      this._beginPinch(e.touches[0], e.touches[1]);
      return;
    }
    if (this._touchId !== null) return; // already tracking a finger
    const t = e.changedTouches[0];
    if (!t) return;
    this._touchId = t.identifier;
    this._touchTapX = t.clientX; this._touchTapY = t.clientY;
    this._touchTapT = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._touchMoved = false;
    const shim = this._touchAsMouse(t, 0);
    // Seed the hover cell from THIS touch before dispatching. _onDown's build branch calls
    // _place() straight away and _place() reads hoverGridX/Y, which with a mouse is always fresh
    // because a mousedown is necessarily preceded by a mousemove over the canvas. A finger has no
    // such preamble, so without this the first tile of a touch-drag would be placed at whatever
    // the last mouse position happened to be (or nowhere at all on a touch-only device).
    this._updateHover(shim);
    // Left-button-down semantics: with a tool this starts painting and places immediately; with
    // the Select tool this runs _pickCitizen (so a tap already selects) and arms the marquee.
    this._onDown(shim);
  }

  _onTouchMove(e) {
    e.preventDefault();
    if (this._panning && e.touches.length >= 2) {
      const a = e.touches[0], b = e.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const midX = (a.clientX + b.clientX) / 2, midY = (a.clientY + b.clientY) / 2;
      // Pan by the midpoint delta -- same call the right/middle-drag pan uses.
      this.renderer.panByScreenDelta(midX - this._pinchMidX, midY - this._pinchMidY, this.getWorld());
      // Pinch: change in finger separation since the last move is the zoom factor, anchored at
      // the midpoint in canvas-local coordinates -- same call the wheel handler uses.
      if (this._pinchDist > 0 && dist > 0) {
        const factor = dist / this._pinchDist;
        if (Math.abs(factor - 1) > 0.002) {
          const rect = this.canvas.getBoundingClientRect();
          this.renderer.zoomAt(midX - rect.left, midY - rect.top, factor, this.getWorld());
        }
      }
      this._pinchDist = dist; this._pinchMidX = midX; this._pinchMidY = midY;
      return;
    }
    if (this._touchId === null) return;
    const t = this._findTouch(e.changedTouches, this._touchId);
    if (!t) return;
    if (Math.hypot(t.clientX - this._touchTapX, t.clientY - this._touchTapY) > 8) this._touchMoved = true;
    this._onMove(this._touchAsMouse(t, 0));
  }

  _onTouchEnd(e) {
    e.preventDefault();
    if (this._panning) {
      // Keep panning only while two fingers remain down; otherwise end the gesture. A finger
      // left over after a pinch does NOT fall through into paint/marquee -- that would drop
      // buildings the player never asked for.
      if (e.touches.length >= 2) { this._beginPinch(e.touches[0], e.touches[1]); return; }
      if (e.touches.length === 0) { this._panning = false; this._pinchDist = 0; }
      return;
    }
    if (this._touchId === null) return;
    const t = this._findTouch(e.changedTouches, this._touchId);
    if (!t) return;
    const dt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - this._touchTapT;
    this._touchId = null;
    // Tap = short + no real movement. _onDown already ran _pickCitizen for the Select tool (so
    // the selection is done), but fingers are imprecise and at high zoom a couple of stray
    // pixels can exceed _onUp's 0.5-world-unit marquee threshold and turn a tap into a 1-citizen
    // box-select. Disarming the marquee here keeps a tap a pure single pick.
    if (!this._touchMoved && dt < 400) this.marqueeActive = false;
    this._onUp(this._touchAsMouse(t, 0));
    this.hoverGridX = null; this.hoverGridY = null; // no lingering hover ghost after lift-off
  }

  _onTouchCancel(e) {
    if (e.cancelable) e.preventDefault();
    this._abortSingleTouch();
    this._panning = false;
    this._pinchDist = 0;
    this.hoverGridX = null; this.hoverGridY = null;
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
      if (this._rightDownX != null && !this._rightMoved) {
        const moved = Math.hypot(e.clientX - this._rightDownX, e.clientY - this._rightDownY);
        if (moved > RIGHT_CLICK_ORDER_THRESHOLD_PX) this._rightMoved = true;
      }
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
      // Order-issuing gesture tracking (draft.js) -- only right-click (button 2) can issue an
      // order, middle-click (button 1) is pan-only, same as before this feature existed.
      if (e.button === 2) { this._rightDownX = e.clientX; this._rightDownY = e.clientY; this._rightMoved = false; }
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

    // Power Switch (power.js's isConductor manual toggle): clicking an EXISTING switch tile with
    // this tool selected flips it on/off instead of failing "Already occupied" -- this only fires
    // on the initial mousedown, not on every _place() call while dragging/painting, so hovering
    // over an already-toggled switch during a paint-drag can't rapidly flip it back and forth.
    if (this.tool === 'power_switch') {
      this._updateHover(e);
      const world = this.getWorld();
      if (world && this.hoverGridX != null) {
        const x = this.hoverGridX, y = this.hoverGridY;
        const existing = world.structures.find(s => !s.destroyed && s.kind === 'power_switch' &&
          Math.floor(s.x) === x && Math.floor(s.y) === y);
        if (existing) {
          existing.switchedOn = existing.switchedOn === false ? true : false;
          this.onToast?.(existing.switchedOn ? 'Power switch: ON' : 'Power switch: OFF');
          return;
        }
      }
    }

    this._painting = true;
    this._place();
  }

  _onUp(e) {
    if (e.button === 2 || e.button === 1) {
      this._panning = false;
      // A right-click that ended without ever exceeding the drag threshold is an order-issuing
      // click, not a pan -- see RIGHT_CLICK_ORDER_THRESHOLD_PX's doc comment above.
      if (e.button === 2 && this._rightDownX != null && !this._rightMoved) this._tryIssueOrder(e);
      this._rightDownX = null; this._rightDownY = null; this._rightMoved = false;
      return;
    }
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
      const kind = {
        'zone-food': ZoneKind.Food, 'zone-bedroom': ZoneKind.Bedroom, 'zone-recreation': ZoneKind.Recreation,
        'zone-training': ZoneKind.Training, 'zone-storage': ZoneKind.Storage, 'zone-medical': ZoneKind.Medical,
        'zone-command': ZoneKind.Command, 'zone-gymnasium': ZoneKind.Gymnasium,
      }[this.tool];
      world.zones.set(x, y, kind);
      return;
    }

    // Restrict Area (RimWorld Restrict-tab style, see citizens.js's paintAllowedAreaCell): paints
    // into the CURRENTLY SELECTED citizen's own area mask, not the shared world.zones grid --
    // same click/drag paint gesture as the zone tools above, deliberately reusing that UX rather
    // than inventing a new one (per the task's own instruction). A single-citizen selection is
    // required (mirrors main.js's insp-restrict-btn, which only arms this tool from the
    // single-citizen inspector view); a marquee multi-select or no selection is a no-op toast,
    // not a silent failure.
    if (this.tool === 'restrict-area') {
      const sel = (this.selectedCitizens && this.selectedCitizens.length === 1) ? this.selectedCitizens[0] : this.selectedCitizen;
      if (sel < 0 || sel >= world.citizens.count || !world.citizens.isAliveAt(sel)) {
        this.onToast?.('Select one citizen first');
        return;
      }
      world.citizens.paintAllowedAreaCell(sel, world.grid.width, world.grid.height, x, y, true);
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

  // Right-click-and-release-without-drag order gesture (draft.js + forcejob.js): if the current
  // selection includes any drafted citizens, this issues either a move or an attack order
  // depending on what's under the cursor -- a live attacker within ORDER_ATTACK_PICK_RADIUS means
  // "attack this", otherwise it's a walkable-tile "move here". No separate mode-switch UI, per the
  // task spec -- auto-detected every time, same click gesture either way. Drafted selection always
  // wins this gesture (unchanged from before Force Job existed); only once nothing selected is
  // drafted does a right-click instead check for a valid Force-Job target under the cursor
  // (forcejob.js -- RimWorld-style "Prioritize" on an undrafted citizen). A no-op (not even a
  // toast) if neither applies, so a stray right-click-release over empty ground/an ineligible
  // selection behaves exactly like it did before either feature existed -- purely camera pan, no
  // side effect.
  _tryIssueOrder(e) {
    const world = this.getWorld();
    if (!world) return;
    const rect = this.canvas.getBoundingClientRect();
    const [wx, wy] = this.renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

    const draftedIds = this._draftedSelectionIds(world);
    if (draftedIds.length > 0) {
      const targetAttacker = nearestAliveAttacker(world.attackers, wx, wy, ORDER_ATTACK_PICK_RADIUS);
      if (targetAttacker >= 0) {
        issueAttackOrder(world, draftedIds, targetAttacker);
        this.onToast?.(`Attack order: ${draftedIds.length} citizen${draftedIds.length > 1 ? 's' : ''}`);
      } else {
        issueMoveOrder(world, draftedIds, wx, wy);
        this.onToast?.(`Move order: ${draftedIds.length} citizen${draftedIds.length > 1 ? 's' : ''}`);
      }
      return;
    }

    // Force Job (forcejob.js): only reachable when the selection contains zero drafted citizens.
    // Requires an actual valid job target under the cursor -- blueprint, resource node, messy
    // room, or unstaffed workshop station (see _findJobTargetAt) -- otherwise this stays a no-op
    // camera-pan-adjacent click, same as the drafted branch above when nothing's selected.
    const undraftedIds = this._undraftedSelectionIds(world);
    if (undraftedIds.length === 0) return;
    const target = this._findJobTargetAt(world, wx, wy);
    if (!target) return;
    // Multi-citizen rule (forcejob.js's pickClosestUndraftedCitizen doc comment): same target,
    // only the closest selected citizen actually gets forced onto it.
    const closestId = pickClosestUndraftedCitizen(world, undraftedIds, target.x, target.y);
    if (closestId == null) return;
    if (forceJob(world, closestId, target.kind, target.ref)) {
      this.onToast?.('Force job assigned');
    }
  }

  // The current selection (single-pick or marquee multi-select, see selectedCitizen/
  // selectedCitizens above) narrowed down to just the living, currently-drafted ones, as citizen
  // ids (draft.js's public interface takes ids, not store indices) -- shared by _tryIssueOrder
  // above and available for any future UI (e.g. a "Draft selection" button) that wants the same
  // narrowing logic.
  _draftedSelectionIds(world) {
    const indices = (this.selectedCitizens && this.selectedCitizens.length > 0)
      ? this.selectedCitizens
      : (this.selectedCitizen >= 0 ? [this.selectedCitizen] : []);
    const ids = [];
    for (const i of indices) {
      if (i < 0 || i >= world.citizens.count) continue;
      if (!world.citizens.isAliveAt(i) || !world.citizens.isDraftedAt(i)) continue;
      ids.push(world.citizens.id[i]);
    }
    return ids;
  }

  // Mirror of _draftedSelectionIds above, narrowed to the living, currently-UNDRAFTED ones instead
  // -- forcejob.js's Force Job is the undrafted counterpart to draft.js's move/attack orders, see
  // _tryIssueOrder above for how the two are routed off the same right-click gesture.
  _undraftedSelectionIds(world) {
    const indices = (this.selectedCitizens && this.selectedCitizens.length > 0)
      ? this.selectedCitizens
      : (this.selectedCitizen >= 0 ? [this.selectedCitizen] : []);
    const ids = [];
    for (const i of indices) {
      if (i < 0 || i >= world.citizens.count) continue;
      if (!world.citizens.isAliveAt(i) || world.citizens.isDraftedAt(i)) continue;
      ids.push(world.citizens.id[i]);
    }
    return ids;
  }

  // Job-target detection for the Force Job right-click gesture above. Small pick radius for
  // point-like targets (blueprint/node/workshop, same ballpark as ORDER_ATTACK_PICK_RADIUS/
  // _pickCitizen's citizen-pick radius); a messy room is instead hit-tested by "is this world
  // point actually inside an enclosed room with mess above the same threshold jobs.js's own
  // autonomous findNearestMessyRoom uses" (rooms.js's roomContaining), since a room has no single
  // point location the way a structure or node does. Returns { kind: ForceJobKind, ref, x, y } (x/y
  // being the target's own position, for pickClosestUndraftedCitizen's distance comparison) or
  // null if nothing valid is under the cursor. Blueprints/unstaffed workshops are checked before
  // resource nodes/messy rooms -- construction work outranking harvesting/cleaning is the existing
  // autonomous ladder's own order (jobs.js), mirrored here purely as a sensible pick-priority
  // tiebreak for the rare case the cursor lands on more than one candidate at once.
  _findJobTargetAt(world, wx, wy) {
    const PICK_RADIUS = 0.7;
    let bestKind = null, bestRef = null, bestDist = PICK_RADIUS;
    for (const s of world.structures) {
      if (s.destroyed) continue;
      const d = Math.hypot(s.x - wx, s.y - wy);
      if (d >= bestDist) continue;
      if (s.underConstruction) { bestDist = d; bestKind = ForceJobKind.Blueprint; bestRef = s; continue; }
      if (s.kind === 'workshop' && s.workerId == null) { bestDist = d; bestKind = ForceJobKind.Workshop; bestRef = s; continue; }
    }
    if (bestKind) return { kind: bestKind, ref: bestRef, x: bestRef.x, y: bestRef.y };

    for (const n of world.resourceNodes) {
      if (n.depleted) continue;
      const d = Math.hypot(n.x - wx, n.y - wy);
      if (d < PICK_RADIUS) return { kind: ForceJobKind.Node, ref: n, x: n.x, y: n.y };
    }

    const room = roomContaining(world.rooms, world.grid, wx, wy);
    if (room && (room.mess || 0) > MESS_CLEAN_THRESHOLD) {
      return { kind: ForceJobKind.Room, ref: room, x: wx, y: wy };
    }
    return null;
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
    // Draft/undraft the current selection (draft.js). SHIFT+D, same uppercase-only convention as
    // the other overlay hotkeys below -- lowercase 'd' is already the Coal Generator buildable's
    // hotkey. main.js supplies onToggleDraft, which draft/undraft-toggles every living citizen
    // currently selected (matches this file's own inspector-button behavior, see main.js).
    if (e.key === 'D') { this.onToggleDraft?.(); return; }
    if (e.key === 'M') { this.onToggleMap?.(); return; }
    // Budget report overlay (world.js's finance ledger, surfaced in main.js). SHIFT+B for the
    // same reason as SHIFT+M above -- lowercase 'b' is already the Bed buildable's hotkey.
    if (e.key === 'B') { this.onToggleFinance?.(); return; }
    // Research/tech tree overlay (research.js, surfaced in main.js). SHIFT+T, same
    // uppercase-only convention -- lowercase 't' is the Table buildable's hotkey. Note SHIFT+R
    // is NOT available: main.js binds both 'r' and 'R' to restart().
    if (e.key === 'T') { this.onToggleResearch?.(); return; }
    // Cliques/faction-demand overlay (factions.js, surfaced in main.js). SHIFT+F, same
    // uppercase-only convention -- lowercase 'f' is already the Floodlight buildable's hotkey.
    if (e.key === 'F') { this.onToggleFactions?.(); return; }
    // Structured Group Programs overlay (programs.js, surfaced in main.js). SHIFT+P, same
    // uppercase-only convention -- lowercase 'p' is already the Garbage Garage (Electric)
    // buildable's hotkey.
    if (e.key === 'P') { this.onTogglePrograms?.(); return; }
    // Outpost Charter Contracts overlay (grants.js, surfaced in main.js). SHIFT+G, same
    // uppercase-only convention -- lowercase 'g' is already the Generator buildable's hotkey.
    if (e.key === 'G') { this.onToggleGrants?.(); return; }
    // Fabrication/Drones overlay (drones.js, surfaced in main.js). SHIFT+N, same uppercase-only
    // convention -- lowercase 'n' is already the Garbage Garage (Fossil) buildable's hotkey.
    if (e.key === 'N') { this.onToggleDrones?.(); return; }
    // Coverage Plans overlay (coverageplans.js, surfaced in main.js). SHIFT+I, same
    // uppercase-only convention -- lowercase 'i' is already the Recycling Garage (Gas)
    // buildable's hotkey.
    if (e.key === 'I') { this.onToggleCoverage?.(); return; }
    // Onboarding reference panel (tutorial.js, surfaced in main.js). F1 and '?' are both free --
    // '?' is Shift+/ and appears in no TOOL_KEYS entry, and F1 collides with nothing here or in
    // main.js's F5/F9 save/load bindings. F1 needs preventDefault or the browser opens its own help.
    if (e.key === 'F1' || e.key === '?') { e.preventDefault(); this.onToggleHelp?.(); return; }
    if (e.key === 'Escape' && this.onToggleMap) { this.onCloseMap?.(); /* falls through to clear tool */ }
    if (e.key === 'Escape' && this.onToggleResearch) { this.onCloseResearch?.(); /* falls through to clear tool */ }
    if (e.key === 'Escape' && this.onToggleFinance) { this.onCloseFinance?.(); /* falls through to clear tool */ }
    if (e.key === 'Escape' && this.onToggleFactions) { this.onCloseFactions?.(); /* falls through to clear tool */ }
    if (e.key === 'Escape' && this.onTogglePrograms) { this.onClosePrograms?.(); /* falls through to clear tool */ }
    if (e.key === 'Escape' && this.onToggleGrants) { this.onCloseGrants?.(); /* falls through to clear tool */ }
    if (e.key === 'Escape' && this.onToggleDrones) { this.onCloseDrones?.(); /* falls through to clear tool */ }
    if (e.key === 'Escape' && this.onToggleCoverage) { this.onCloseCoverage?.(); /* falls through to clear tool */ }
    if (e.key in TOOL_KEYS) { this.setTool(TOOL_KEYS[e.key]); return; }
    if (e.key === ' ') { e.preventDefault(); this.togglePause(); return; }
    if (e.key === '+' || e.key === '=') { this.setSpeedIndex(this.speedIndex + 1); return; }
    if (e.key === '-') { this.setSpeedIndex(this.speedIndex - 1); return; }
  }
}
