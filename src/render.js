// Renderer -- real SVG art (see assets.js) for the sprites that most benefit from actual curves
// and shading (humanoids, animals), Canvas 2D primitives everywhere else (structures, terrain,
// effects, and the animated per-frame parts of a humanoid like its legs). No AI-generated
// images anywhere; assets.js's SVGs are hand-authored template strings. Visual language borrows
// from RimWorld/Prison Architect: flat top-down grid, outlined silhouettes so units read
// clearly against the ground, and zone/room tints rather than photographic texture.
import { StaffRoleKind, TerrainKind } from './core.js';
import { ZONE_COLOR, ZoneKind } from './zones.js';
import { JobState, WorkCategory, FARM_CYCLE_TICKS, CINEMA_SHOWTIME_INTERVAL_TICKS } from './jobs.js';
import { isTileEnergized, isSegmentOverloadedAt, BATTERY_STORED_MAX } from './power.js';
import { isTileWatered, isWateredAt } from './water.js';
import { isNuclearContained, NUCLEAR_HAZARD_RADIUS } from './siege.js';
import { roomContaining, ROOM_ROLE_LABEL, RoomRole } from './rooms.js';
import { drawSprite } from './assets.js';
import { OrderKind } from './draft.js';
import { CLIQUES } from './factions.js';

// Parses either '#rrggbb' or 'rgb(a)(...)' into an [r,g,b] triple -- shade()/desaturate() need to
// compose (desaturate's rgb(...) output can be fed back into shade() for a highlight, e.g.
// _drawHumanoid's onBreak citizens), and a hex-only parser would silently break on that input.
function parseColor(str) {
  if (str[0] === '#') {
    const n = parseInt(str.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  return [0, 0, 0];
}

// Shifts a color toward black (amt<0) or white (amt>0) by `amt` (-1..1) -- used to derive a
// single solid highlight (or, elsewhere, a state-dependent tint) from a base color so callers
// only ever need to track one color per palette slot, not three.
function shade(hex, amt) {
  const [r, g, b] = parseColor(hex);
  const mix = (c) => Math.max(0, Math.min(255, Math.round(c + (amt > 0 ? (255 - c) : c) * amt)));
  return `#${[mix(r), mix(g), mix(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

const CELL = 24; // px per grid cell at zoom 1
// Bumped from the old rgba(20,16,12,0.75) toward near-opaque true near-black (style brief item 3)
// -- crisper silhouette separation at small sprite size, kept neutral rather than warm-tinted.
const OUTLINE = 'rgba(10,10,12,0.95)';
// Cinema (jobs.js's tickCinemas): how many ticks after a showtime the screen keeps its bright
// "actively airing" glow before fading back to a dim idle tint -- purely cosmetic, doesn't affect
// the real refill logic (which is a single instant at the exact showtime tick, see tickCinemas).
const CINEMA_SHOWING_GLOW_TICKS = 20;

// Style-brief item 1: baseline material colors desaturated ~15-25% off their original punchy
// values (computed by hand from the pre-brief hex constants). Full saturation is reserved for
// hazard/attention states (downed gray, onBreak desaturate(), the Boss's pulsing threat ring/
// crown), not baseline per-role appearance.
export const ROLE_COLOR = {
  [StaffRoleKind.Guard]: '#e1b93e',
  [StaffRoleKind.Sniper]: '#ba68cf',
  [StaffRoleKind.K9Handler]: '#e1b93e',
  [StaffRoleKind.Monitor]: '#67a4cd',
  // Structured Group Program staff (programs.js) -- distinct from the security-role palette above
  // so a Foreman/Psychologist/Facilitator reads visually apart from Guard/Sniper/Monitor at a
  // glance, same "role tints the citizen dot" convention.
  [StaffRoleKind.Foreman]: '#b9793f',
  [StaffRoleKind.Psychologist]: '#83bbbb',
  [StaffRoleKind.Facilitator]: '#c383c3',
  [StaffRoleKind.None]: '#d3cdbf',
};

// Baseline citizen/attacker skin tone (warm), desaturated ~20% from the original #e8c9a0 per the
// style brief's warm-vs-cool material split -- skin/hair stay warm, uniform/gear tints stay cool.
export const CITIZEN_SKIN = '#e1c8a8';

const ZONE_BORDER = {
  [ZoneKind.Bedroom]: '#5a6fb0',
  [ZoneKind.Food]: '#c98a2e',
  [ZoneKind.Recreation]: '#4a9e5f',
  [ZoneKind.Training]: '#c878c8',
};

// SEA:R truck fuel-type tradeoff (see vehicles.js FUEL_TYPES) -- a stripe color per fuel so the
// dirty/clean tradeoff reads at a glance in _drawVehicles below.
const FUEL_COLOR = {
  fossil: '#6b5334',
  gas: '#3d6fa8',
  ethanol: '#5fa83d',
  electric: '#3dd0d0',
};

// Labor drone "status eye" color per fixed WorkCategory (drones.js, see _drawDrones below) -- a
// drone never changes category after fabrication, so this is a stable at-a-glance job read, same
// spirit as FUEL_COLOR's stripe above. RGB triples (not CSS strings) so _drawDrones can inject a
// live alpha for the idle-vs-working pulse without string-parsing a color back apart.
const DRONE_EYE_COLOR = {
  [WorkCategory.Construction]: [230, 176, 60],  // amber, matches the workshop/finishedBuild accent family
  [WorkCategory.Processing]: [242, 201, 76],    // matches _drawStructureShape's workshop work-light
  [WorkCategory.Hauling]: [61, 111, 168],       // matches FUEL_COLOR.gas, the "hauling" blue this file already uses
  [WorkCategory.Harvesting]: [140, 128, 104],   // matches _drawResourceNodes' ore-deposit fill family
  [WorkCategory.Cleaning]: [130, 200, 190],     // cool teal, distinct from every other category's warm/blue tones
};

// Blend a hex color toward gray -- used to give OnBreak citizens a visibly washed-out look
// distinct from the flat gray used for Downed citizens (see _drawCitizens).
function desaturate(hex, amount) {
  const [r, g, b] = parseColor(hex);
  const gray = (r + g + b) / 3;
  const mix = (c) => Math.round(c + (gray - c) * amount);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

// Deterministic per-cell noise so the ground doesn't need an image asset to avoid looking flat.
function cellNoise(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Smooth value noise: bilinearly interpolates between noise sampled at integer lattice points,
// so shading blends continuously across cell boundaries instead of a per-cell checkerboard --
// "one big piece" rather than visibly tiled squares.
function smoothNoise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const n00 = cellNoise(x0, y0), n10 = cellNoise(x0 + 1, y0);
  const n01 = cellNoise(x0, y0 + 1), n11 = cellNoise(x0 + 1, y0 + 1);
  const sx = tx * tx * (3 - 2 * tx); // smoothstep, avoids visible diagonal creases from linear lerp
  const sy = ty * ty * (3 - 2 * ty);
  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 4;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camX = 0; this.camY = 0; this.zoom = 1;
    // Camera starts auto-framed every few seconds (main.js); once the player pans or zooms by
    // hand, auto-reframe stops fighting them for control until they click Recenter -- there was
    // previously no manual camera control at all, and re-snapping under the player mid-drag felt
    // broken.
    this.manualCamera = false;
    // Accessibility: scoped-down colorblind mode (see main.js's Settings panel). Rather than a
    // full palette redesign, this adds shape/pattern cues on top of the existing colors -- a
    // dashed orange ring under every attacker vs. a solid blue ring under every citizen (that
    // color pair stays distinguishable under the common red-green deficiencies), plus a distinct
    // dash pattern per zone kind in _drawZones -- so the citizen/attacker and zone-kind
    // distinctions no longer rely on hue alone. Toggled by main.js, not persisted here.
    this.highContrast = false;
  }

  panByScreenDelta(dxPx, dyPx, world) {
    this.camX -= dxPx / (CELL * this.zoom);
    this.camY -= dyPx / (CELL * this.zoom);
    this.manualCamera = true;
    if (world) this._clampCamToWorld(world);
  }

  zoomAt(screenX, screenY, factor, world) {
    const [wx, wy] = this.screenToWorld(screenX, screenY);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
    // keep the world point under the cursor stationary on screen rather than zooming toward camX/Y
    const [nx, ny] = this.screenToWorld(screenX, screenY);
    this.camX += wx - nx;
    this.camY += wy - ny;
    this.manualCamera = true;
    if (world) this._clampCamToWorld(world);
  }

  recenter(world) {
    this.manualCamera = false;
    this.frameOnContent(world);
  }

  resize() {
    // window.innerWidth/Height can briefly report 0 before layout settles in some embedding
    // contexts; falling back to a sane default avoids getting stuck with a 0x0 canvas forever
    // (nothing else would ever retry since main.js only calls this on the 'resize' event).
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  frameOnContent(world) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < world.citizens.count; i++) {
      if (!world.citizens.isAliveAt(i)) continue;
      minX = Math.min(minX, world.citizens.x[i]); maxX = Math.max(maxX, world.citizens.x[i]);
      minY = Math.min(minY, world.citizens.y[i]); maxY = Math.max(maxY, world.citizens.y[i]);
    }
    for (const s of world.structures) {
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    }
    if (!isFinite(minX)) { minX = 0; maxX = world.width; minY = 0; maxY = world.height; }
    const pad = 6;
    const w = (maxX - minX) + pad * 2;
    const h = (maxY - minY) + pad * 2;
    this.camX = (minX + maxX) / 2;
    this.camY = (minY + maxY) / 2;
    const zoomX = this.canvas.width / (w * CELL);
    const zoomY = this.canvas.height / (h * CELL);
    this.zoom = Math.max(0.4, Math.min(2.5, Math.min(zoomX, zoomY)));
    this._clampCamToWorld(world);
  }

  // Centering on the settlement's bounding box can point the camera at a spot close enough to
  // the map edge that the viewport shows raw off-map canvas background -- a stark dark void with
  // no ground, walls, or fog, since nothing is drawn there. Pull the camera back so the visible
  // area stays inside the map whenever the map is big enough to allow it (a map smaller than the
  // viewport still letterboxes evenly, which is fine).
  _clampCamToWorld(world) {
    const viewW = this.canvas.width / (CELL * this.zoom);
    const viewH = this.canvas.height / (CELL * this.zoom);
    this.camX = viewW >= world.width
      ? world.width / 2
      : Math.min(Math.max(this.camX, viewW / 2), world.width - viewW / 2);
    this.camY = viewH >= world.height
      ? world.height / 2
      : Math.min(Math.max(this.camY, viewH / 2), world.height - viewH / 2);
  }

  worldToScreen(x, y) {
    return [
      this.canvas.width / 2 + (x - this.camX) * CELL * this.zoom,
      this.canvas.height / 2 + (y - this.camY) * CELL * this.zoom,
    ];
  }

  screenToWorld(sx, sy) {
    return [
      this.camX + (sx - this.canvas.width / 2) / (CELL * this.zoom),
      this.camY + (sy - this.canvas.height / 2) / (CELL * this.zoom),
    ];
  }

  // World-space bounds of what's currently visible in the main viewport -- used by the minimap
  // to draw the "you are here" rectangle without duplicating the worldToScreen/screenToWorld math.
  getViewBounds() {
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(this.canvas.width, this.canvas.height);
    return { x0, y0, x1, y1 };
  }

  // Public entry point for jumping the camera to an arbitrary world point (e.g. a minimap
  // click) -- goes through the same manual-camera + clamp path as pan/zoom so it doesn't fight
  // the auto-reframe or walk the camera off the map edge.
  jumpTo(x, y, world) {
    this.camX = x;
    this.camY = y;
    this.manualCamera = true;
    this._clampCamToWorld(world);
  }

  draw(world, input) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._drawGround(world);
    this._drawZones(world);
    this._drawFactionTerritory(world);
    this._drawAllowedArea(world, input);
    this._drawResourceNodes(world);
    this._drawNuclearHazards(world);
    this._drawStructures(world);
    this._drawFire(world);
    this._drawCitizens(world);
    this._drawDogs(world);
    this._drawWildAnimals(world);
    this._drawRats(world);
    this._drawAttackers(world);
    this._drawVehicles(world);
    this._drawDrones(world);
    this._drawSmogHaze(world);
    if (input) {
      this._drawCursor(world, input);
      this._drawSelection(world, input);
      this._drawRoomLabel(world, input);
    }
  }

  // Fire crisis event (Prison Architect/SEA:R, see fire.js): burning structures get an animated
  // flame glyph -- a radial-gradient teardrop that flickers based on world.currentTick (fixed-
  // tick-driven, not wall-clock time, so it stays deterministic/pausable like everything else).
  _drawFire(world) {
    const ctx = this.ctx;
    for (const s of world.structures) {
      if (!s.onFire || s.destroyed) continue;
      const [sx, sy] = this.worldToScreen(s.x, s.y);
      const size = CELL * this.zoom * 0.85;
      const flicker = 0.7 + 0.3 * Math.sin(world.currentTick * 0.5 + s.x * 3 + s.y * 7);
      const h = size * (0.55 + 0.25 * flicker);

      ctx.save();
      ctx.globalAlpha = 0.88;
      const grad = ctx.createRadialGradient(sx, sy - h * 0.3, 1, sx, sy - h * 0.3, h * 0.65);
      grad.addColorStop(0, 'rgba(255,240,180,0.95)');
      grad.addColorStop(0.5, 'rgba(255,140,40,0.85)');
      grad.addColorStop(1, 'rgba(200,40,20,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(sx, sy - h);
      ctx.quadraticCurveTo(sx + size * 0.28 * flicker, sy - h * 0.5, sx, sy + size * 0.1);
      ctx.quadraticCurveTo(sx - size * 0.28 * flicker, sy - h * 0.5, sx, sy - h);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // SEA:R's tonal hook (see FEATURE_RESEARCH.md): mismanaged waste is a visible, worsening
  // liability, not just a background number -- a sickly haze that thickens with pollution.
  _drawSmogHaze(world) {
    const pollution = world.pollution || 0;
    if (pollution < 40) return;
    const ctx = this.ctx;
    const alpha = Math.min(0.35, (pollution - 40) / 400);
    ctx.fillStyle = `rgba(120,140,60,${alpha})`;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // Nuclear waste hazard (SEA:R): unlike the global smog haze above, this is a literal
  // damage-dealing area around any nuclear generator that isn't guarded by a nearby
  // waste_storage (see siege.js's tickNuclearHazard, which is what actually applies the damage
  // this is only the visual for). Sickly green/yellow warning tint, distinct from the smog's
  // duller olive so a player can tell "background pollution" from "stand here and take damage"
  // at a glance. Pulses subtly so it doesn't just look like a locked deep decal.
  _drawNuclearHazards(world) {
    const ctx = this.ctx;
    for (const s of world.structures) {
      if (s.kind !== 'generator_nuclear' || s.destroyed || s.underConstruction) continue;
      if (isNuclearContained(world.structures, s)) continue;
      const [sx, sy] = this.worldToScreen(s.x, s.y);
      const r = NUCLEAR_HAZARD_RADIUS * CELL * this.zoom;
      const pulse = 0.75 + 0.25 * Math.sin(world.currentTick * 0.15);
      const grad = ctx.createRadialGradient(sx, sy, r * 0.15, sx, sy, r);
      grad.addColorStop(0, `rgba(200,230,60,${0.28 * pulse})`);
      grad.addColorStop(0.7, `rgba(170,210,40,${0.16 * pulse})`);
      grad.addColorStop(1, 'rgba(170,210,40,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(210,235,90,${0.5 * pulse})`;
      ctx.lineWidth = Math.max(1, CELL * this.zoom * 0.04);
      ctx.setLineDash([CELL * this.zoom * 0.15, CELL * this.zoom * 0.1]);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _drawSelection(world, input) {
    const ctx = this.ctx;
    const r = CELL * this.zoom * 0.5;
    const ids = new Set();
    if (input.selectedCitizen != null && input.selectedCitizen >= 0) ids.add(input.selectedCitizen);
    if (input.selectedCitizens) for (const i of input.selectedCitizens) ids.add(i);
    for (const sel of ids) {
      if (sel < 0 || sel >= world.citizens.count || !world.citizens.isAliveAt(sel)) continue;
      const [sx, sy] = this.worldToScreen(world.citizens.x[sel], world.citizens.y[sel]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    this._drawMarquee(input);
  }

  // RimWorld/Prison Architect-style rubber-band select: only ever active with the Select tool
  // (armed in InputController._onDown, see input.js), a dashed rectangle from drag-start to the
  // live cursor position so the player can see what they're about to sweep up. Alt+drag switches
  // input.js's own gesture into mass-designation mode (forcejob.js, see input.js's
  // _massDesignate) instead of citizen-select -- colored orange here to match forcejob's own
  // pending-order glyph (`#ffb020`, the "!" above a citizen's head with a pending Force Job) so
  // the player reads "this drag means Force Job" at a glance, distinct from the default cyan
  // citizen-select box.
  _drawMarquee(input) {
    if (!input.marqueeActive) return;
    const dx = input.marqueeEndWorldX - input.marqueeStartWorldX;
    const dy = input.marqueeEndWorldY - input.marqueeStartWorldY;
    if (Math.hypot(dx, dy) < 0.15) return; // below this it's still just a click settling, not a drag
    const ctx = this.ctx;
    const [x0, y0] = this.worldToScreen(input.marqueeStartWorldX, input.marqueeStartWorldY);
    const [x1, y1] = this.worldToScreen(input.marqueeEndWorldX, input.marqueeEndWorldY);
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    ctx.save();
    if (input._marqueeDesignate) {
      ctx.fillStyle = 'rgba(255,176,32,0.14)';
      ctx.strokeStyle = '#ffb020';
    } else {
      ctx.fillStyle = 'rgba(127,215,255,0.12)';
      ctx.strokeStyle = '#7fd7ff';
    }
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // Rooms/zones read as painted floor material (Prison Architect's zone-tint-with-border
  // look) rather than a flat translucent wash -- a visible border is what actually reads as
  // "this is a designated area" at a glance, the fill alone didn't.
  _drawZones(world) {
    const ctx = this.ctx;
    const size = CELL * this.zoom;
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const kind = world.zones.get(x, y);
        if (kind === ZoneKind.None) continue;
        const [px, py] = this.worldToScreen(x, y);
        ctx.fillStyle = ZONE_COLOR[kind];
        ctx.fillRect(px, py, size + 1, size + 1);

        // Border only on edges touching a non-matching cell, so a solid zone reads as one
        // outlined region instead of a grid of individually-outlined squares.
        ctx.strokeStyle = ZONE_BORDER[kind];
        ctx.lineWidth = Math.max(1, size * 0.05);
        // High-contrast mode (main.js Settings panel): a distinct dash pattern per zone kind, so
        // the three zones stay distinguishable by pattern, not just by hue, for players who can't
        // easily tell the blue/orange/green fills apart.
        if (this.highContrast) {
          ctx.lineWidth = Math.max(2, size * 0.09);
          const dash = kind === ZoneKind.Bedroom ? [] : kind === ZoneKind.Food ? [size * 0.3, size * 0.15] : [size * 0.08, size * 0.08];
          ctx.setLineDash(dash);
        } else {
          ctx.setLineDash([]);
        }
        ctx.beginPath();
        if (world.zones.get(x, y - 1) !== kind) { ctx.moveTo(px, py); ctx.lineTo(px + size, py); }
        if (world.zones.get(x, y + 1) !== kind) { ctx.moveTo(px, py + size); ctx.lineTo(px + size, py + size); }
        if (world.zones.get(x - 1, y) !== kind) { ctx.moveTo(px, py); ctx.lineTo(px, py + size); }
        if (world.zones.get(x + 1, y) !== kind) { ctx.moveTo(px + size, py); ctx.lineTo(px + size, py + size); }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]); // don't leak the dash pattern into unrelated strokes drawn after this
  }

  // Clique territory / graffiti overlay (factions.js's tickTerritory) -- a claimed room's cells
  // get a persistent tint in that clique's own CLIQUES[].color, same per-cell fill+border
  // language _drawAllowedArea below already uses for a different "this area means something"
  // overlay. room.territoryClique is only ever set on world.rooms entries (rooms.js's
  // detectRooms), so this is a cheap iterate-claimed-rooms-only pass, not a full grid scan like
  // _drawZones/_drawAllowedArea have to do (zones/allowed-area are per-cell state; a room's
  // claim is one flag on the room object covering its whole cell set).
  _drawFactionTerritory(world) {
    if (!world.rooms || world.rooms.length === 0) return;
    const ctx = this.ctx;
    const size = CELL * this.zoom;
    const gw = world.grid.width;
    for (const room of world.rooms) {
      if (!room.territoryClique) continue;
      const clique = CLIQUES.find(c => c.id === room.territoryClique);
      if (!clique) continue;
      const [r, g, b] = parseColor(clique.color);
      ctx.fillStyle = `rgba(${r},${g},${b},0.18)`;
      ctx.strokeStyle = `rgba(${r},${g},${b},0.65)`;
      ctx.lineWidth = Math.max(1, size * 0.05);
      ctx.setLineDash(this.highContrast ? [size * 0.15, size * 0.1] : []);
      for (const idx of room.cells) {
        const x = idx % gw, y = Math.floor(idx / gw);
        const [px, py] = this.worldToScreen(x, y);
        ctx.fillRect(px, py, size + 1, size + 1);
        // Graffiti glyph: a small scrawled X per cell, cheap stand-in for hand-authored tag art
        // (this codebase's no-AI-art rule means every visual is Canvas-drawn primitives or
        // hand-authored SVG, same as everywhere else -- a scrawled mark is an honest fit for
        // "graffiti" at this sprite scale). Only drawn once per room (its first cell) rather than
        // once per cell, so a large claimed room doesn't turn into a wall of X's.
        if (idx === room.cells.values().next().value) {
          ctx.beginPath();
          ctx.moveTo(px + size * 0.3, py + size * 0.3);
          ctx.lineTo(px + size * 0.7, py + size * 0.7);
          ctx.moveTo(px + size * 0.7, py + size * 0.3);
          ctx.lineTo(px + size * 0.3, py + size * 0.7);
          ctx.stroke();
        }
      }
      // Border: only on edges touching a non-member cell, same "outline the region, not every
      // tile" convention _drawZones uses.
      ctx.beginPath();
      for (const idx of room.cells) {
        const x = idx % gw, y = Math.floor(idx / gw);
        const [px, py] = this.worldToScreen(x, y);
        if (!room.cells.has(idx - gw) || y === 0) { ctx.moveTo(px, py); ctx.lineTo(px + size, py); }
        if (!room.cells.has(idx + gw) || y === world.grid.height - 1) { ctx.moveTo(px, py + size); ctx.lineTo(px + size, py + size); }
        if (!room.cells.has(idx - 1) || x === 0) { ctx.moveTo(px, py); ctx.lineTo(px, py + size); }
        if (!room.cells.has(idx + 1) || x === gw - 1) { ctx.moveTo(px + size, py); ctx.lineTo(px + size, py + size); }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Allowed Area restriction overlay (RimWorld Restrict-tab style, citizens.js's allowedAreaMask)
  // -- shown for whichever single citizen is currently selected/inspected, not just while
  // actively painting, so the player can see an already-painted restriction at a glance. A
  // distinct amber tint (not any existing ZONE_COLOR hue) so it never reads as a fourth zone
  // kind. Deliberately NOT gated on input.tool === 'restrict-area' -- selecting a restricted
  // citizen should show their cage immediately, same as clicking one shows their needs bars.
  _drawAllowedArea(world, input) {
    if (!input) return;
    const sel = (input.selectedCitizens && input.selectedCitizens.length === 1) ? input.selectedCitizens[0] : input.selectedCitizen;
    if (sel < 0 || sel >= world.citizens.count || !world.citizens.hasAllowedArea(sel)) return;
    const ctx = this.ctx;
    const size = CELL * this.zoom;
    const gw = world.grid.width;
    const mask = world.citizens.allowedAreaMask[sel];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        if (mask[y * gw + x] !== 1) continue;
        const [px, py] = this.worldToScreen(x, y);
        ctx.fillStyle = 'rgba(224,168,96,0.22)';
        ctx.fillRect(px, py, size + 1, size + 1);
        ctx.strokeStyle = 'rgba(224,168,96,0.75)';
        ctx.lineWidth = Math.max(1, size * 0.05);
        ctx.setLineDash(this.highContrast ? [size * 0.15, size * 0.1] : []);
        ctx.beginPath();
        if (y === 0 || mask[(y - 1) * gw + x] !== 1) { ctx.moveTo(px, py); ctx.lineTo(px + size, py); }
        if (y === world.height - 1 || mask[(y + 1) * gw + x] !== 1) { ctx.moveTo(px, py + size); ctx.lineTo(px + size, py + size); }
        if (x === 0 || mask[y * gw + x - 1] !== 1) { ctx.moveTo(px, py); ctx.lineTo(px, py + size); }
        if (x === world.width - 1 || mask[y * gw + x + 1] !== 1) { ctx.moveTo(px + size, py); ctx.lineTo(px + size, py + size); }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  _drawCursor(world, input) {
    const ctx = this.ctx;
    if (!input.hoverGridX && input.hoverGridX !== 0) return;
    const [px, py] = this.worldToScreen(input.hoverGridX, input.hoverGridY);
    const size = CELL * this.zoom;
    ctx.strokeStyle = input.tool ? '#ffffff' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, size - 2, size - 2);
  }

  // Room-role hover label (rooms.js's computeRoomStats/classifyRoomRole, RimWorld/Prison
  // Architect's "hover a room to see what it is" convention): only shown while no build tool is
  // selected (so it doesn't fight with zone/structure placement feedback) and only when the
  // cursor is actually over an enclosed room detectRooms found. Shows the role name, and -- if
  // the room has a matching zone but is missing furniture -- what's missing, e.g.
  // "Bedroom (needs a bed)"; a room with no matching zone at all just doesn't get a label
  // (Unroofed Area is the quiet default, not something worth bannering over every plain room).
  _drawRoomLabel(world, input) {
    if (input.tool) return;
    if (!input.hoverGridX && input.hoverGridX !== 0) return;
    const room = roomContaining(world.rooms, world.grid, input.hoverGridX + 0.5, input.hoverGridY + 0.5);
    if (!room || !room.role || room.role === RoomRole.None) return;

    const label = ROOM_ROLE_LABEL[room.role] ?? 'Room';
    const text = room.roleValid
      ? label
      : `${label} (needs ${room.missingRequirements.join(', ')})`;

    const ctx = this.ctx;
    const [px, py] = this.worldToScreen(input.hoverGridX, input.hoverGridY);
    const size = CELL * this.zoom;
    const x = px + size / 2;
    const y = py - 6;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const padX = 6, padY = 3;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = room.roleValid ? 'rgba(24,22,20,0.85)' : 'rgba(90,30,20,0.85)';
    ctx.fillRect(x - w / 2 - padX, y - 14 - padY, w + padX * 2, 14 + padY * 2);
    ctx.strokeStyle = room.roleValid ? '#4a9e5f' : '#d95a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - w / 2 - padX, y - 14 - padY, w + padX * 2, 14 + padY * 2);
    ctx.fillStyle = '#f0ece4';
    ctx.fillText(text, x, y);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // Ground is pre-rendered once into an offscreen canvas with smooth (bilinearly-interpolated)
  // noise, so it reads as one continuous blended surface -- like a Minecraft grass block seen
  // from above, not a checkerboard of individually-colored tiles. Rebuilt only when the wall
  // layout changes (walls tint the ground dark), not every frame.
  _buildGroundCache(world) {
    const SUB = 4; // samples per cell edge in the cache -- enough to hide any per-cell seam
    const cw = world.width * SUB, ch = world.height * SUB;
    const cnv = document.createElement('canvas');
    cnv.width = cw; cnv.height = ch;
    const cctx = cnv.getContext('2d');
    const img = cctx.createImageData(cw, ch);

    for (let py = 0; py < ch; py++) {
      const gy = py / SUB;
      const cellY = Math.min(world.height - 1, Math.floor(gy));
      for (let px = 0; px < cw; px++) {
        const gx = px / SUB;
        const cellX = Math.min(world.width - 1, Math.floor(gx));
        const idx = world.grid.index(cellX, cellY);
        const kind = world.grid.terrain[idx];
        const hasWall = world.grid.wallThingId[idx] !== 0;

        let base = [0.5, 0.4, 0.28]; // dirt brown, matches the GDD's scavenged-settlement palette
        if (kind === TerrainKind.Soil) base = [0.4, 0.31, 0.20];
        else if (kind === TerrainKind.Rock) base = [0.47, 0.47, 0.49];
        else if (kind === TerrainKind.Water) base = [0.18, 0.35, 0.55];
        if (hasWall) base = [0.15, 0.14, 0.16];

        const n = smoothNoise(gx * 0.6, gy * 0.6); // low frequency -> broad soft blotches, not speckle
        const shade = 0.86 + n * 0.28;
        const o = (py * cw + px) * 4;
        img.data[o] = Math.round(base[0] * 255 * shade);
        img.data[o + 1] = Math.round(base[1] * 255 * shade);
        img.data[o + 2] = Math.round(base[2] * 255 * shade);
        img.data[o + 3] = 255;
      }
    }
    cctx.putImageData(img, 0, 0);
    this._groundCache = cnv;
    this._groundCacheWallSignature = this._wallSignature(world);
  }

  _wallSignature(world) {
    let sum = 0;
    for (let i = 0; i < world.grid.wallThingId.length; i++) if (world.grid.wallThingId[i] !== 0) sum += i + 1;
    return sum;
  }

  _drawGround(world) {
    const ctx = this.ctx;
    if (!this._groundCache || this._groundCacheWallSignature !== this._wallSignature(world)) {
      this._buildGroundCache(world);
    }
    const [x0, y0] = this.worldToScreen(0, 0);
    const size = CELL * this.zoom;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._groundCache, x0, y0, world.width * size, world.height * size);
  }

  // A handful of deterministic hair tones so a crowd of otherwise-identical role-colored
  // citizens still reads as individuals at a glance, without needing per-citizen sprite data --
  // picked purely from `seed` (the citizen/attacker's stable id or slot index).
  static HAIR_TONES = ['#2b2118', '#5c3b1e', '#8a6a3a', '#c9a35a', '#3a3a3a', '#7a2f1f'];

  // The torso+head silhouette is real SVG art (assets.js's humanoid_torso template, recolored
  // per palette via drawSprite) instead of hand-drawn Canvas paths -- proper curves and gradient
  // shading read far better than primitive shapes at this sprite size. Legs stay Canvas-drawn
  // since they're the part that animates every frame via the walk-bob; baking a walk cycle into
  // multiple SVG frames was tried and read worse here than the cheap procedural bob, so this
  // hybrid split (SVG for the static silhouette, primitives for per-frame motion + the shadow/
  // health-bar overlays) is deliberate, not a half-finished migration.
  _drawHumanoid(x, y, scale, bodyColor, headColor, healthFrac, isAttacker, tick = 0, seed = 0) {
    const ctx = this.ctx;
    const [sx, sy] = this.worldToScreen(x, y);
    const s = CELL * this.zoom * scale;
    const rr = (x0, y0, w, h, r) => {
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x0, y0, w, h, r); }
      else { ctx.beginPath(); ctx.rect(x0, y0, w, h); } // fallback for older engines, still correct
    };

    if (this.highContrast && isAttacker !== undefined) {
      // Shape/pattern cue independent of hue: solid blue ring = citizen, dashed orange ring =
      // attacker. Drawn under the shadow so it reads as a ground marker, not part of the body.
      ctx.save();
      ctx.strokeStyle = isAttacker ? '#ff9500' : '#33bbff';
      ctx.lineWidth = Math.max(1.5, s * 0.09);
      ctx.setLineDash(isAttacker ? [s * 0.14, s * 0.1] : []);
      ctx.beginPath();
      ctx.ellipse(sx, sy + s * 0.1, s * 0.34, s * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(sx, sy + s * 0.44, s * 0.3, s * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = Math.max(1, s * 0.06);
    ctx.strokeStyle = OUTLINE;

    // Alternating leg bob -- each leg's vertical offset swings opposite the other, cheap but
    // reads clearly as a walk cycle from a top-down view. Standing still (stride ~0) settles
    // back to the original symmetric pose.
    const phase = tick * 0.35 + seed * 6.28318;
    const stride = Math.sin(phase) * s * 0.05;
    ctx.fillStyle = bodyColor;
    rr(sx - s * 0.16, sy + s * 0.1 + stride, s * 0.12, s * 0.22, s * 0.04); ctx.fill(); ctx.stroke();
    rr(sx + s * 0.04, sy + s * 0.1 - stride, s * 0.12, s * 0.22, s * 0.04); ctx.fill(); ctx.stroke();

    // Torso+head: real SVG art (see assets.js's humanoid_torso template) recolored per palette.
    // Falls back to the old flat primitive shapes for the handful of frames before a brand-new
    // color combo's sprite finishes decoding (drawSprite returns false while unloaded) --
    // invisible in practice since the palette space is small (a few role colors x downed/
    // onBreak states) and every combo gets cached forever after its first appearance.
    const hair = Renderer.HAIR_TONES[Math.floor(seed * 977) % Renderer.HAIR_TONES.length];
    // Style brief item 2: flat base fill + one solid highlight shape (BODY_HI/HEAD_HI) instead of
    // a full-surface gradient -- see assets.js's humanoid_torso template, which now clips a small
    // highlight ellipse to the top ~20-30% of the torso/head silhouette rather than blending
    // top-to-bottom.
    const drew = drawSprite(ctx, 'humanoid_torso', {
      BODY: bodyColor, BODY_HI: shade(bodyColor, 0.3),
      HEAD: headColor, HEAD_HI: shade(headColor, 0.3),
      HAIR: hair, OUTLINE,
    }, sx, sy - s * 0.03, s * 0.85);
    if (!drew) {
      ctx.beginPath();
      ctx.moveTo(sx - s * 0.21, sy - s * 0.12);
      ctx.lineTo(sx + s * 0.21, sy - s * 0.12);
      ctx.quadraticCurveTo(sx + s * 0.19, sy + s * 0.16, sx + s * 0.15, sy + s * 0.16);
      ctx.lineTo(sx - s * 0.15, sy + s * 0.16);
      ctx.quadraticCurveTo(sx - s * 0.19, sy + s * 0.16, sx - s * 0.21, sy - s * 0.12);
      ctx.closePath();
      ctx.fillStyle = bodyColor; ctx.fill(); ctx.stroke();
      ctx.fillStyle = headColor;
      ctx.beginPath(); ctx.arc(sx, sy - s * 0.3, s * 0.21, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    if (healthFrac !== undefined && healthFrac < 0.98) {
      const barW = s * 0.5, barY = sy - s * 0.58;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(sx - barW / 2, barY, barW, s * 0.08);
      ctx.fillStyle = healthFrac > 0.5 ? '#5fd15f' : healthFrac > 0.25 ? '#e0c040' : '#e05050';
      ctx.fillRect(sx - barW / 2, barY, barW * Math.max(0, healthFrac), s * 0.08);
    }
  }

  _drawCitizens(world) {
    for (let i = 0; i < world.citizens.count; i++) {
      if (!world.citizens.isAliveAt(i)) continue;
      if (world.citizens.jobState[i] === JobState.Driving) continue; // riding inside a vehicle, drawn as part of it
      const id = world.citizens.id[i];
      const downed = world.citizens.isDownedAt(i);
      const onBreak = !downed && world.citizens.isOnBreakAt(i);
      // Sickness (sickness.js): piggybacks on this exact desaturate-tint pattern rather than a
      // new visual language -- onBreak already claims the tint when both apply (a citizen can be
      // sick AND on break at once), but the glyph below still shows independently either way.
      const sick = !downed && world.citizens.isSickAt(i);
      const drafted = world.citizens.isDraftedAt(i);
      const role = world.roster.isStaff(id) ? world.roster.kindOf(id) : StaffRoleKind.None;
      const baseColor = ROLE_COLOR[role] || ROLE_COLOR[StaffRoleKind.None];
      const color = downed ? '#6b6b6b' : onBreak ? desaturate(baseColor, 0.6) : sick ? desaturate(baseColor, 0.4) : baseColor;
      // Skin tone (#e1c8a8) is the desaturated-~20% baseline per the style brief; downed/onBreak
      // still branch off it exactly as before, just from the new muted base.
      const headColor = downed ? '#8a8a8a' : onBreak ? desaturate(CITIZEN_SKIN, 0.6) : sick ? desaturate(CITIZEN_SKIN, 0.4) : CITIZEN_SKIN;
      const [sx, sy] = this.worldToScreen(world.citizens.x[i], world.citizens.y[i]);
      this._drawHumanoid(world.citizens.x[i], world.citizens.y[i], downed ? 0.5 : 0.7, color, headColor, world.citizens.health[i], false, world.currentTick, id);
      if (sick) {
        // Small sickly-green "+" tell centered above the head -- distinct position (dead center)
        // and color (green, not onBreak's blue-gray "z" or forcejob's orange "!") from every other
        // above-head glyph so a sick citizen reads clearly even while also on break/drafted/etc.
        const s = CELL * this.zoom * 0.7;
        this.ctx.save();
        this.ctx.font = `bold ${Math.max(8, s * 0.34)}px sans-serif`;
        this.ctx.fillStyle = 'rgba(120,190,110,0.9)';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('+', sx, sy - s * 0.68);
        this.ctx.restore();
      }
      if (onBreak) {
        // Small "zzz" tell above the head so low-mood citizens read clearly at a glance,
        // distinct from the flat-gray Downed silhouette.
        const s = CELL * this.zoom * 0.7;
        this.ctx.save();
        this.ctx.font = `${Math.max(8, s * 0.32)}px sans-serif`;
        this.ctx.fillStyle = 'rgba(140,150,200,0.9)';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('z', sx + s * 0.32, sy - s * 0.62);
        this.ctx.restore();
      }
      // Force Job pending (forcejob.js -- RimWorld-style "Prioritize" one-shot order): a small
      // orange exclamation mark above the head, same "small glyph reads at a glance" convention
      // as onBreak's zzz right above -- distinct color/shape/position (opposite side from onBreak's
      // z) so the two can never be confused, even though in practice they can coexist (an
      // onBreak citizen can still have a pending forced job waiting for them). Cleared the moment
      // jobs.js's tickJobs actually claims (or fails to claim) the forced target, so this never
      // lingers once the citizen is genuinely en route.
      if (world.citizens.hasForcedJobAt(i)) {
        const s = CELL * this.zoom * 0.7;
        this.ctx.save();
        this.ctx.font = `bold ${Math.max(9, s * 0.4)}px sans-serif`;
        this.ctx.fillStyle = '#ffb020';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('!', sx - s * 0.32, sy - s * 0.62);
        this.ctx.restore();
      }
      // First-aid tending (jobs.js's JobState.Tending / citizens.js's TEND_RECOVERY_RATE): a small
      // green "+" above the head, same "small glyph reads at a glance" convention as onBreak's zzz
      // and Force Job's orange "!" above -- centered and slightly higher than those two (which sit
      // left/right at the same height) so all three can coexist without overlapping. Shown on the
      // TENDER (jobState === Tending, whether or not the render happens to catch a variance-roll
      // tick) and on the PATIENT (world.citizens.beingTended[i], set fresh by this same tick's
      // tickJobs Tending handler) -- one glyph style, two roles, so "an active tend is happening
      // right here" reads clearly from either citizen's position.
      if (world.citizens.jobState[i] === JobState.Tending || (downed && world.citizens.beingTended[i] === 1)) {
        const s = CELL * this.zoom * 0.7;
        this.ctx.save();
        this.ctx.font = `bold ${Math.max(9, s * 0.4)}px sans-serif`;
        this.ctx.fillStyle = '#5ec97a';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('+', sx, sy - s * 0.85);
        this.ctx.restore();
      }
      // Drafted (draft.js -- RimWorld-style manual control): a small ring under the citizen's
      // feet, same "state tint at a glance" convention as onBreak's zzz glyph and Downed's flat
      // gray above, rather than a whole new visual language. High-contrast mode gets a dashed
      // ring instead of solid, same accessibility pattern _drawZones uses for zone borders.
      if (drafted) {
        const s = CELL * this.zoom * 0.7;
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = '#4fd1ff';
        ctx.lineWidth = Math.max(1.5, s * 0.09);
        if (this.highContrast) ctx.setLineDash([s * 0.12, s * 0.1]);
        ctx.beginPath();
        ctx.ellipse(sx, sy + s * 0.42, s * 0.42, s * 0.16, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Active-order feedback (draft.js's orderKind -- 1 = Move, 2 = Attack): a thin line from
        // the citizen to their current order target, so a move/attack order in progress is
        // visibly distinct from a drafted-but-idle "standing at attention" citizen.
        const orderKind = world.citizens.orderKind[i];
        if (orderKind === OrderKind.Move) {
          const [tx, ty] = this.worldToScreen(world.citizens.orderTargetX[i], world.citizens.orderTargetY[i]);
          ctx.save();
          ctx.strokeStyle = 'rgba(79,209,255,0.6)';
          ctx.lineWidth = Math.max(1, s * 0.06);
          ctx.setLineDash([s * 0.15, s * 0.12]);
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
          ctx.restore();
        } else if (orderKind === OrderKind.Attack) {
          const targetI = world.citizens.orderAttackIndex[i];
          if (targetI >= 0 && world.attackers.isAliveAt(targetI)) {
            const [tx, ty] = this.worldToScreen(world.attackers.x[targetI], world.attackers.y[targetI]);
            ctx.save();
            ctx.strokeStyle = 'rgba(255,90,60,0.7)';
            ctx.lineWidth = Math.max(1, s * 0.06);
            ctx.setLineDash([s * 0.08, s * 0.08]);
            ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
            ctx.restore();
          }
        }
      }
    }
  }

  // Tamed dogs (world.dogs, roster-assignable/combat-capable) get a warm coat + a gold collar
  // ring; wild untamed animals (world.wildAnimals, see security.js/jobs.js's Taming job) reuse
  // the same silhouette in a duller, uncollared coat so "this one isn't yours yet" reads clearly
  // at a glance without needing a whole separate sprite.
  _drawDogs(world) {
    this._drawAnimal(world.dogs, '#745235', '#f2c026'); // coat desaturated ~15%; collar kept punchy on purpose, a small tamed-vs-wild accent
  }

  _drawWildAnimals(world) {
    this._drawAnimal(world.wildAnimals, '#8f8a76', null);
  }

  // Rats (rats.js) -- a small, plain Canvas primitive on purpose (this is deliberately the
  // "cheap" system this pass, no SVG asset needed): a dark ellipse body, a thin tail line, no
  // health bar/collar since rats have neither. Kept visually tiny and low-key so a handful of
  // them read as background nuisance, not a threat on par with attackers.
  _drawRats(world) {
    const ctx = this.ctx;
    for (const rat of world.rats || []) {
      if (!rat.alive) continue;
      const [sx, sy] = this.worldToScreen(rat.x, rat.y);
      const s = CELL * this.zoom * 0.18;
      ctx.fillStyle = '#3a332a';
      ctx.beginPath(); ctx.ellipse(sx, sy, s, s * 0.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = Math.max(1, s * 0.25);
      ctx.beginPath();
      ctx.moveTo(sx - s * 0.9, sy);
      ctx.lineTo(sx - s * 1.6, sy + s * 0.3);
      ctx.stroke();
    }
  }

  _drawAnimal(list, coatColor, collarColor) {
    const ctx = this.ctx;
    for (const dog of list || []) {
      const [sx, sy] = this.worldToScreen(dog.x, dog.y);
      const s = CELL * this.zoom * 0.4;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.32, s * 0.34, s * 0.1, 0, 0, Math.PI * 2); ctx.fill();

      const drew = drawSprite(ctx, 'animal_body', {
        COAT: coatColor, COAT_HI: shade(coatColor, 0.3), OUTLINE,
      }, sx, sy, s * 1.15);
      if (!drew) {
        // Same primitive fallback the humanoid uses while a brand-new coat color is still
        // decoding -- see _drawHumanoid's comment, identical rationale here.
        ctx.lineWidth = Math.max(1, s * 0.08);
        ctx.strokeStyle = OUTLINE;
        ctx.fillStyle = coatColor;
        ctx.beginPath(); ctx.ellipse(sx, sy, s * 0.32, s * 0.2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(sx + s * 0.28, sy - s * 0.05, s * 0.14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (collarColor) {
        ctx.strokeStyle = collarColor;
        ctx.lineWidth = Math.max(1, s * 0.1);
        ctx.beginPath();
        ctx.arc(sx + s * 0.31, sy - s * 0.07, s * 0.19, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // Per-archetype silhouettes (see siege.js's ATTACKER_ARCHETYPES): size and palette both shift
  // so the roster is readable at a glance mid-siege without reading a single number.
  //   Grunt      -- the original small dark-red raider (unchanged, the baseline)
  //   Brute      -- noticeably larger, heavy slate-plated
  //   Skirmisher -- smaller and lighter/oranger, reads as "fast and flimsy"
  //   Boss       -- much larger, violet, plus a pulsing threat ring and a spiked crown
  // Body/head colors desaturated ~20% from the original punchy values per the style brief; the
  // Boss's separate threat-ring/crown overlay (drawn below) is the deliberate full-saturation
  // "attention" accent, so its own baseline body/head color is muted like every other archetype.
  static ATTACKER_STYLES = [
    { scale: 0.6,  body: '#7c2626', head: '#b96f55' }, // Grunt
    { scale: 0.85, body: '#48443a', head: '#8a7961' }, // Brute
    { scale: 0.48, body: '#a0552c', head: '#d4a175' }, // Skirmisher
    { scale: 1.25, body: '#482658', head: '#c077d6' }, // Boss
  ];

  _drawAttackers(world) {
    const ctx = this.ctx;
    for (let i = 0; i < world.attackers.count; i++) {
      if (!world.attackers.isAliveAt(i)) continue;
      const kind = world.attackers.kind ? world.attackers.kind[i] : 0;
      const style = Renderer.ATTACKER_STYLES[kind] || Renderer.ATTACKER_STYLES[0];
      const isBoss = kind === 3;

      if (isBoss) {
        // Threat ring under the boss, pulsing off the wall clock so it's obvious even when the
        // sim is paused. Drawn before the body so it reads as ground marking, not an outline.
        const [bx, by] = this.worldToScreen(world.attackers.x[i], world.attackers.y[i]);
        const s = CELL * this.zoom * style.scale;
        const pulse = 0.75 + 0.25 * Math.sin(Date.now() / 220);
        ctx.save();
        ctx.strokeStyle = 'rgba(200,90,235,0.85)';
        ctx.lineWidth = Math.max(2, s * 0.09);
        ctx.beginPath();
        ctx.ellipse(bx, by + s * 0.42, s * 0.6 * pulse, s * 0.26 * pulse, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(150,40,190,0.18)';
        ctx.fill();
        ctx.restore();
      }

      this._drawHumanoid(world.attackers.x[i], world.attackers.y[i], style.scale,
        style.body, style.head, world.attackers.health[i], true, world.currentTick, i);

      if (isBoss) {
        // Spiked crown on top of the head so the boss is distinguishable even in a dense crowd
        // where the ground ring is occluded.
        const [bx, by] = this.worldToScreen(world.attackers.x[i], world.attackers.y[i]);
        const s = CELL * this.zoom * style.scale;
        ctx.save();
        ctx.fillStyle = '#f0c040';
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = Math.max(1, s * 0.05);
        ctx.beginPath();
        const baseY = by - s * 0.46, w = s * 0.34;
        ctx.moveTo(bx - w / 2, baseY);
        for (let k = 0; k < 3; k++) {
          ctx.lineTo(bx - w / 2 + w * (k + 0.5) / 3, baseY - s * 0.22);
          ctx.lineTo(bx - w / 2 + w * (k + 1) / 3, baseY);
        }
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    }
  }

  _drawStructures(world) {
    const ctx = this.ctx;
    this._structuresForPower = world.structures; // read back by the 'wire' shape for its lit/dark tint
    this._currentWeather = world.weather; // read back by the 'lightning_rod' shape for its storm-active radius ring
    this._droneQueueLength = world.droneFabricationQueue?.length || 0; // read back by the 'fabrication_bay' shape for its work-light pulse
    this._lastTick = world.currentTick; // read back by the 'cinema' shape for its active-showing glow
    for (const s of world.structures) {
      if (s.destroyed && (s.kind === 'trap' || s.kind === 'trap_spike' || s.kind === 'trap_explosive')) continue; // traps vanish once triggered
      const [sx, sy] = this.worldToScreen(s.x, s.y);
      const size = CELL * this.zoom * 0.85;

      if (s.kind !== 'fence' && s.kind !== 'wire' && s.kind !== 'pipe') {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        ctx.ellipse(sx, sy + size * 0.4, size * 0.35, size * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.save();
      if (s.underConstruction) ctx.globalAlpha = 0.4 + 0.3 * (s.buildProgress || 0);
      this._drawStructureShape(ctx, s, sx, sy, size);
      ctx.restore();

      if (s.underConstruction && (s.buildProgress || 0) > 0) {
        const barW = size * 0.9;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(sx - barW / 2, sy + size * 0.55, barW, size * 0.1);
        ctx.fillStyle = '#e0a336';
        ctx.fillRect(sx - barW / 2, sy + size * 0.55, barW * s.buildProgress, size * 0.1);
      }
    }
  }

  _drawStructureShape(ctx, s, sx, sy, size) {
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.strokeStyle = OUTLINE;

    // Overload warning ring (power.js's overload mechanic): drawn underneath the tile's own
    // shape so it reads as a hazard glow around the wire/generator, not a replacement paint job.
    // Pulses off the wall clock (same pattern as the boss threat-ring above) so it's still
    // visible while the sim is paused.
    if ((s.kind === 'wire' || s.kind === 'battery' || s.kind === 'power_switch' || s.kind.startsWith('generator')) &&
      !s.destroyed && !s.underConstruction &&
      isSegmentOverloadedAt(this._structuresForPower || [], s.x, s.y)) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 180);
      ctx.save();
      ctx.strokeStyle = `rgba(230,40,30,${0.5 + 0.4 * pulse})`;
      ctx.lineWidth = Math.max(2, size * 0.14);
      ctx.beginPath();
      ctx.arc(sx, sy, size * 0.62, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Frozen pipe/pump (water.js's Cold-weather freeze mechanic): a pale icy overlay ring so a
    // frozen tile reads distinctly from a merely-disconnected one (which the pipe/pump cases below
    // already dim to grey via isTileWatered/running -- frozen is a DIFFERENT reason to be dark,
    // worth telling apart at a glance). Static (no pulse) since this is a passive state, not an
    // active hazard warning like the overload ring above.
    if ((s.kind === 'pipe' || s.kind === 'pump') && s.frozen) {
      ctx.save();
      ctx.strokeStyle = 'rgba(180,225,245,0.85)';
      ctx.lineWidth = Math.max(1.5, size * 0.09);
      ctx.beginPath();
      ctx.arc(sx, sy, size * 0.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (s.kind === 'wall') {
      // Style-brief pass: slightly desaturated toward neutral gray (was a warmer brownish slab);
      // shading is now flat fill + a single upper-left highlight wedge baked into the template
      // (see assets.js's 'wall'), not a gradient.
      const fill = '#403e3a';
      const drew = drawSprite(ctx, 'wall', { FILL: fill, FILL_HI: shade(fill, 0.3), OUTLINE }, sx, sy, size);
      if (!drew) {
        ctx.fillStyle = fill;
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
        ctx.strokeRect(sx - size / 2, sy - size / 2, size, size);
      }
      return;
    }
    if (s.kind === 'fence') {
      // Left as an improved Canvas primitive, not an SVG sprite: fence renders as a continuous
      // line segment across the tile (not a centered icon), which doesn't fit drawSprite's
      // centered-silhouette model. Rounded caps + small post knobs are the "improvement" here.
      // Style-brief pass: desaturated ~20% from the old warm tan (rendering approach left alone
      // per instructions -- this is a color-only retune).
      const fenceColor = s.destroyed ? 'rgba(80,60,40,0.4)' : '#9c8062';
      ctx.strokeStyle = fenceColor;
      ctx.lineWidth = Math.max(2, size * 0.12);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx - size / 2, sy);
      ctx.lineTo(sx + size / 2, sy);
      ctx.stroke();
      ctx.fillStyle = fenceColor;
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.09, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (s.kind === 'trap' || s.kind === 'trap_spike' || s.kind === 'trap_explosive') {
      // trap_spike/trap_explosive (siege.js's TRAP_KINDS, real PA trap variety) reuse the
      // original single trap's sprite/color -- distinct per-kind art is a reasonable future
      // follow-up, but rendering as the wrong structure entirely (the generic turret fallback
      // below) would actively mislead the player, so this is the priority fix.
      const drew = drawSprite(ctx, 'trap',
        { FILL: 'rgba(140,20,20,0.55)', FILL_HI: 'rgba(190,40,30,0.55)', TEETH: 'rgba(230,200,180,0.7)', OUTLINE },
        sx, sy, size * 0.75);
      if (!drew) {
        ctx.fillStyle = 'rgba(140,20,20,0.55)';
        ctx.beginPath();
        ctx.arc(sx, sy, size * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      return;
    }
    if (s.kind === 'bed') {
      // Style pass: was a saturated blue frame ('#5a6fb0') with no wood read at all -- moved to
      // the wood-furniture family's desaturated warm ochre/tan per the style brief. Headboard is
      // a darker flat band (was the same color as the gradient's own dark stop); FRAME_HI is now
      // a small solid highlight wedge, not a full-surface gradient stop.
      const frame = '#8a7355';
      const drew = drawSprite(ctx, 'bed', {
        FRAME: frame, HEADBOARD: shade(frame, -0.22), FRAME_HI: shade(frame, 0.32),
        PILLOW: '#c2b490', OUTLINE,
      }, sx, sy, size);
      if (!drew) {
        ctx.fillStyle = frame;
        ctx.fillRect(sx - size * 0.4, sy - size * 0.3, size * 0.8, size * 0.6);
        ctx.strokeRect(sx - size * 0.4, sy - size * 0.3, size * 0.8, size * 0.6);
        ctx.fillStyle = '#c2b490';
        ctx.fillRect(sx - size * 0.4, sy - size * 0.3, size * 0.8, size * 0.18);
      }
      return;
    }
    if (s.kind === 'table') {
      // Style pass: desaturated ~20% from the old saturated ochre toward a muted warm tan.
      const fill = '#93794f';
      const drew = drawSprite(ctx, 'table', { FILL: fill, FILL_HI: shade(fill, 0.3), OUTLINE }, sx, sy, size);
      if (!drew) {
        ctx.fillStyle = fill;
        ctx.fillRect(sx - size * 0.4, sy - size * 0.28, size * 0.8, size * 0.56);
        ctx.strokeRect(sx - size * 0.4, sy - size * 0.28, size * 0.8, size * 0.56);
      }
      return;
    }
    if (s.kind === 'shelf') {
      // Storage room role (rooms.js RoomRole.Storage) -- left as a Canvas primitive, no new SVG
      // template, matching the "no new mechanic" v1 scope. Same wood-furniture family as
      // bed/table (desaturated warm tan) but drawn as stacked horizontal shelf boards rather than
      // a single flat surface, so it reads distinctly from a table at a glance.
      const fill = '#8a7355';
      ctx.fillStyle = fill;
      ctx.fillRect(sx - size * 0.38, sy - size * 0.4, size * 0.76, size * 0.8);
      ctx.strokeRect(sx - size * 0.38, sy - size * 0.4, size * 0.76, size * 0.8);
      ctx.strokeStyle = shade(fill, -0.3);
      ctx.lineWidth = Math.max(1, size * 0.045);
      for (const frac of [-0.13, 0.13]) {
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.38, sy + size * frac);
        ctx.lineTo(sx + size * 0.38, sy + size * frac);
        ctx.stroke();
      }
      ctx.strokeStyle = OUTLINE;
      return;
    }
    if (s.kind === 'medical_bed') {
      // Infirmary room role (rooms.js RoomRole.Medical) -- same frame/headboard/pillow layout as
      // the plain bed (bed's own visual family) but recolored clinical white/red-cross instead of
      // warm wood tones, so a Medical Bed reads as distinct at a glance from a regular Bed.
      const frame = '#d8d8d0';
      ctx.fillStyle = frame;
      ctx.fillRect(sx - size * 0.4, sy - size * 0.3, size * 0.8, size * 0.6);
      ctx.strokeRect(sx - size * 0.4, sy - size * 0.3, size * 0.8, size * 0.6);
      ctx.fillStyle = shade(frame, -0.25);
      ctx.fillRect(sx - size * 0.4, sy - size * 0.3, size * 0.8, size * 0.18);
      // Small red-cross marker -- the one clear "medical" signal on an otherwise plain bed shape.
      ctx.fillStyle = '#c23c3c';
      ctx.fillRect(sx - size * 0.06, sy - size * 0.02, size * 0.12, size * 0.22);
      ctx.fillRect(sx - size * 0.17, sy + size * 0.03, size * 0.34, size * 0.12);
      return;
    }
    if (s.kind === 'fitness_station') {
      // Gymnasium room role (rooms.js RoomRole.Gymnasium) -- left as a Canvas primitive, no new
      // SVG template, same "no new mechanic beyond the buildable itself" v1 scope as shelf/
      // medical_bed above. Drawn as a simple dumbbell (bar + two end weights) so it reads
      // distinctly from every other furniture silhouette at a glance.
      const fill = s.destroyed ? 'rgba(80,80,80,0.4)' : '#7a8a94';
      ctx.strokeStyle = fill;
      ctx.lineWidth = Math.max(2, size * 0.1);
      ctx.beginPath();
      ctx.moveTo(sx - size * 0.28, sy);
      ctx.lineTo(sx + size * 0.28, sy);
      ctx.stroke();
      ctx.fillStyle = fill;
      ctx.fillRect(sx - size * 0.36, sy - size * 0.22, size * 0.14, size * 0.44);
      ctx.fillRect(sx + size * 0.22, sy - size * 0.22, size * 0.14, size * 0.44);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(1, size * 0.05);
      ctx.strokeRect(sx - size * 0.36, sy - size * 0.22, size * 0.14, size * 0.44);
      ctx.strokeRect(sx + size * 0.22, sy - size * 0.22, size * 0.14, size * 0.44);
      return;
    }
    if (s.kind === 'shower') {
      // Hygiene need's refill fixture (citizens.js's HYGIENE_DECAY, jobs.js's findNearestShower/
      // JobState.Bathing) -- left as a Canvas primitive, no new SVG template, same "no new mechanic
      // beyond the buildable itself" v1 scope as fitness_station/shelf/medical_bed above. Drawn as
      // a showerhead (a post + a fanned nozzle) with a few drip lines that only appear while it's
      // actually connected to the water grid (water.js's isWateredAt) -- reusing
      // this._structuresForPower (set once per frame in _drawStructures, holds world.structures
      // despite the power-focused name, same reuse the 'pipe'/'pump' shapes below already make) so
      // the real plumbing dependency reads visually, not just mechanically: an unconnected Shower
      // looks visibly dry and grey, the same "dim/dark when not functional" language the pipe/pump
      // shapes already use for their own frozen/disconnected states.
      const connected = !s.destroyed && !s.underConstruction && isWateredAt(this._structuresForPower || [], s.x, s.y);
      const fill = s.destroyed ? 'rgba(80,80,80,0.4)' : connected ? '#6fa8c9' : '#5a6570';
      ctx.strokeStyle = fill;
      ctx.lineWidth = Math.max(2, size * 0.09);
      ctx.beginPath();
      ctx.moveTo(sx, sy + size * 0.32);
      ctx.lineTo(sx, sy - size * 0.12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx, sy - size * 0.12);
      ctx.lineTo(sx - size * 0.24, sy - size * 0.3);
      ctx.stroke();
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.ellipse(sx - size * 0.24, sy - size * 0.3, size * 0.16, size * 0.08, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(1, size * 0.04);
      ctx.beginPath();
      ctx.ellipse(sx - size * 0.24, sy - size * 0.3, size * 0.16, size * 0.08, -0.4, 0, Math.PI * 2);
      ctx.stroke();
      if (connected) {
        ctx.strokeStyle = 'rgba(120,190,230,0.8)';
        ctx.lineWidth = Math.max(1, size * 0.03);
        for (const dx of [-0.32, -0.24, -0.16]) {
          ctx.beginPath();
          ctx.moveTo(sx + dx * size, sy - size * 0.18);
          ctx.lineTo(sx + dx * size, sy - size * 0.02);
          ctx.stroke();
        }
      }
      return;
    }
    if (s.kind === 'farm_plot') {
      // Farm Plot (research.js's Agronomy node, jobs.js's Farming job): left as a Canvas
      // primitive, no new SVG template, same "no new mechanic beyond the buildable itself" v1
      // scope as fitness_station/shelf/medical_bed above. Tilled-soil square (a few furrow lines)
      // with a sprout that grows visibly taller as the current cycle's `_workTimer` approaches
      // FARM_CYCLE_TICKS, dimmed and un-staffed-looking when no citizen is tending it (s.workerId)
      // -- same "read the staffing state at a glance" idea as workshop/monitor_station.
      const staffed = s.workerId != null;
      const soil = s.destroyed ? 'rgba(80,70,50,0.4)' : staffed ? '#6b4f34' : '#4a3826';
      ctx.fillStyle = soil;
      ctx.fillRect(sx - size * 0.42, sy - size * 0.34, size * 0.84, size * 0.68);
      ctx.strokeRect(sx - size * 0.42, sy - size * 0.34, size * 0.84, size * 0.68);
      ctx.strokeStyle = shade(soil, -0.3);
      ctx.lineWidth = Math.max(1, size * 0.03);
      for (let fx = -0.28; fx <= 0.3; fx += 0.28) {
        ctx.beginPath();
        ctx.moveTo(sx + fx * size, sy - size * 0.34);
        ctx.lineTo(sx + fx * size, sy + size * 0.34);
        ctx.stroke();
      }
      if (!s.destroyed) {
        const growth = Math.min(1, (s._workTimer || 0) / FARM_CYCLE_TICKS);
        const sproutH = size * (0.1 + 0.3 * growth);
        ctx.strokeStyle = staffed ? '#6fae4a' : '#3f5c32';
        ctx.lineWidth = Math.max(2, size * 0.06);
        ctx.beginPath();
        ctx.moveTo(sx, sy + size * 0.28);
        ctx.lineTo(sx, sy + size * 0.28 - sproutH);
        ctx.stroke();
        if (staffed) {
          ctx.fillStyle = '#7fc356';
          ctx.beginPath();
          ctx.arc(sx, sy + size * 0.28 - sproutH, size * 0.07, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.strokeStyle = OUTLINE;
      return;
    }
    if (s.kind === 'restaurant') {
      // Restaurant (PA real Restaurant+Bakery retail-income analog, see jobs.js's Restaurant
      // job): left as a Canvas primitive, no new SVG template, same v1 scope as farm_plot/
      // workshop above -- a squat counter with a striped awning (a "storefront" read at a
      // glance), dimmed/awning-down when unstaffed (s.workerId) so the player can see at a
      // glance it needs a worker, same "read the staffing state at a glance" idea as
      // workshop/farm_plot/monitor_station. Warm red/cream retail palette, deliberately distinct
      // from workshop's cool industrial gray-blue and farm_plot's earthy soil brown.
      const staffed = s.workerId != null;
      const counter = s.destroyed ? 'rgba(90,70,60,0.4)' : staffed ? '#c9a876' : '#8a7355';
      const awning = s.destroyed ? 'rgba(90,50,50,0.4)' : staffed ? '#b23f3f' : '#6e3535';
      ctx.fillStyle = counter;
      ctx.fillRect(sx - size * 0.4, sy - size * 0.02, size * 0.8, size * 0.4);
      ctx.strokeRect(sx - size * 0.4, sy - size * 0.02, size * 0.8, size * 0.4);
      // Striped awning above the counter -- alternating awning/cream stripes, same "storefront"
      // silhouette a real restaurant/bakery counter reads as at a glance.
      const stripeW = size * 0.16;
      ctx.strokeStyle = OUTLINE;
      for (let sxOff = -size * 0.44, idx = 0; sxOff < size * 0.44; sxOff += stripeW, idx++) {
        ctx.fillStyle = idx % 2 === 0 ? awning : '#e8dcc4';
        ctx.fillRect(sx + sxOff, sy - size * 0.4, stripeW, size * 0.4);
      }
      ctx.strokeRect(sx - size * 0.44, sy - size * 0.4, size * 0.88, size * 0.4);
      if (staffed && !s.destroyed) {
        // Lit "OPEN" sign dot while a citizen is actively staffing it -- pulses gently, same
        // visual language as workshop's own work-light.
        const pulse = 0.55 + 0.35 * Math.sin(Date.now() / 220);
        ctx.fillStyle = `rgba(255,210,120,${pulse})`;
        ctx.beginPath(); ctx.arc(sx, sy + size * 0.18, size * 0.07, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = OUTLINE;
      return;
    }
    if (s.kind === 'door') {
      // Style pass: desaturated ~20% toward a muted warm-brown wood tone, consistent with bed/table.
      const panel = '#6f5c40';
      const drew = drawSprite(ctx, 'door', {
        FRAME: shade(panel, -0.3), PANEL: panel, PANEL_HI: shade(panel, 0.32), HANDLE: '#cbb87e', OUTLINE,
      }, sx, sy, size);
      if (!drew) {
        ctx.fillStyle = panel;
        ctx.fillRect(sx - size * 0.35, sy - size * 0.42, size * 0.7, size * 0.84);
        ctx.strokeRect(sx - size * 0.35, sy - size * 0.42, size * 0.7, size * 0.84);
      }
      return;
    }
    if (s.kind === 'workshop') {
      // Processing station (Prison Architect materials-chain analog, see jobs.js's Processing job
      // -- raw scrap in, Components out at 2x value). No SVG template exists for this yet, so it's
      // a plain-primitive fallback (same pattern as fence/wire/pipe): a squat industrial box with
      // a stack, dimmed and un-lit when unstaffed (s.workerId) so the player can see at a glance
      // that it needs a worker, same "read the staffing state at a glance" idea as monitor_station.
      // RESTYLE: material-based palette (metal/industrial processing gear trends cool gray-blue,
      // desaturated ~20% off the old warm-amber tones) + a small upper-left highlight rect
      // replacing the old flat-only fill, matching the highlight-facet convention used by the
      // SVG-templated economy/vehicle sprites below.
      const staffed = s.workerId != null;
      const fill = s.destroyed ? 'rgba(80,82,78,0.4)' : staffed ? '#6c7268' : '#4a4c46';
      ctx.fillStyle = fill;
      ctx.fillRect(sx - size * 0.42, sy - size * 0.38, size * 0.84, size * 0.76);
      ctx.strokeRect(sx - size * 0.42, sy - size * 0.38, size * 0.84, size * 0.76);
      ctx.fillStyle = shade(fill, 0.22);
      ctx.beginPath();
      ctx.moveTo(sx - size * 0.42, sy - size * 0.38);
      ctx.lineTo(sx - size * 0.06, sy - size * 0.38);
      ctx.lineTo(sx - size * 0.42, sy - size * 0.06);
      ctx.closePath();
      ctx.fill(); // upper-left highlight facet
      ctx.fillStyle = shade(fill, -0.2);
      ctx.fillRect(sx + size * 0.1, sy - size * 0.62, size * 0.14, size * 0.28); // stack
      if (staffed && !s.destroyed) {
        // Lit work-light while a citizen is actively staffing it -- pulses gently so it reads as
        // "running", same visual language as the overload-warning pulse ring above.
        const pulse = 0.55 + 0.35 * Math.sin(Date.now() / 220);
        ctx.fillStyle = `rgba(242,201,76,${pulse})`;
        ctx.beginPath(); ctx.arc(sx - size * 0.22, sy - size * 0.18, size * 0.09, 0, Math.PI * 2); ctx.fill();
      }
      return;
    }
    if (s.kind === 'garage_recycling' || s.kind === 'garage_garbage') {
      // RESTYLE: material-based palette split -- recycling handles metal/industrial sorting so
      // its garage trends desaturated cool gray-blue-green; garbage handles general/organic waste
      // so its garage trends desaturated warm ochre/tan. Both ~20% less saturated than the old
      // pure green/olive tones, matching the game-wide desaturation pass.
      const fill = s.kind === 'garage_recycling' ? '#3d564f' : '#5c5240';
      const drew = drawSprite(ctx, 'garage',
        { FILL: fill, FILL_HI: shade(fill, 0.25), DOOR: '#1a1a1a', OUTLINE }, sx, sy, size);
      if (!drew) {
        ctx.fillStyle = fill;
        ctx.fillRect(sx - size * 0.45, sy - size * 0.4, size * 0.9, size * 0.8);
        ctx.strokeRect(sx - size * 0.45, sy - size * 0.4, size * 0.9, size * 0.8);
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(sx - size * 0.3, sy - size * 0.1, size * 0.6, size * 0.42); // garage door opening
      }
      return;
    }
    if (s.kind === 'watchtower') {
      // Style-brief pass: watchtower is one of the named institutional/metal structures -- the
      // platform (its metal component) is pushed cooler/grayer than before; the wood support post
      // keeps its warmer tone (only desaturated slightly) since it isn't the "metal" part.
      const post = '#564a3e';
      const platform = '#7e8994';
      const drew = drawSprite(ctx, 'watchtower',
        { POST: post, PLATFORM: platform, PLATFORM_HI: shade(platform, 0.3), OUTLINE }, sx, sy - size * 0.15, size * 1.15);
      if (!drew) {
        ctx.fillStyle = post;
        ctx.fillRect(sx - size * 0.15, sy - size * 0.1, size * 0.3, size * 0.55); // support post
        ctx.fillStyle = platform;
        ctx.fillRect(sx - size * 0.4, sy - size * 0.5, size * 0.8, size * 0.35); // watch platform
        ctx.strokeRect(sx - size * 0.4, sy - size * 0.5, size * 0.8, size * 0.35);
      }
      return;
    }
    if (s.kind === 'camera') {
      // Cheap CCTV camera: a mounting post + a small angled lens housing with a "lit lens" dot,
      // deliberately smaller/plainer than the watchtower platform (cheaper, shorter-range).
      // Style pass: housing/post moved from neutral grey to a desaturated cool gray-blue
      // (security-tech family); destroyed-lens tint preserved exactly (still a visually distinct
      // dead-red vs live-blue), both desaturated ~20% to match.
      const lens = s.destroyed ? '#6b3a3a' : '#5f8fac';
      const housing = '#31363d';
      const drew = drawSprite(ctx, 'camera', {
        POST: '#4a5058', HOUSING: housing, HOUSING_HI: shade(housing, 0.35),
        LENS: lens, LENS_HI: shade(lens, 0.4), OUTLINE,
      }, sx, sy - size * 0.1, size * 1.1);
      if (!drew) {
        ctx.fillStyle = '#4a5058';
        ctx.fillRect(sx - size * 0.06, sy - size * 0.05, size * 0.12, size * 0.4); // mounting post
        ctx.save();
        ctx.translate(sx, sy - size * 0.32);
        ctx.rotate(-0.4);
        ctx.fillStyle = housing;
        ctx.fillRect(-size * 0.28, -size * 0.14, size * 0.5, size * 0.24);
        ctx.strokeRect(-size * 0.28, -size * 0.14, size * 0.5, size * 0.24);
        ctx.fillStyle = lens;
        ctx.beginPath();
        ctx.arc(size * 0.22, -size * 0.02, size * 0.07, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      return;
    }
    if (s.kind === 'monitor_station') {
      // A desk with a bank of CCTV screens -- staffed/unstaffed reads via screen brightness so
      // the "manned monitor bonus" is visible on the map, not just in the milestone log.
      // Style pass: desk desaturated toward a muted neutral-warm gray (was a saturated brown),
      // monitor bank moved to the same cool gray-blue family as the camera housing above (both
      // are "security tech"). The staffed/unstaffed/destroyed 3-way screen-color logic is
      // preserved exactly -- only the three tones themselves were desaturated ~15-20%, keeping
      // clear hue/lightness separation between all three states.
      const desk = '#54493a';
      const bank = '#31363d';
      const screen = s.destroyed ? '#333333' : (s._staffed ? '#6bb98f' : '#3f5766');
      const drew = drawSprite(ctx, 'monitor_station', {
        DESK: desk, DESK_HI: shade(desk, 0.32), BANK: bank,
        SCREEN: screen, SCREEN_HI: shade(screen, 0.4), OUTLINE,
      }, sx, sy, size);
      if (!drew) {
        ctx.fillStyle = desk;
        ctx.fillRect(sx - size * 0.42, sy - size * 0.08, size * 0.84, size * 0.4); // desk
        ctx.strokeRect(sx - size * 0.42, sy - size * 0.08, size * 0.84, size * 0.4);
        ctx.fillStyle = bank;
        ctx.fillRect(sx - size * 0.4, sy - size * 0.48, size * 0.84, size * 0.4); // monitor bank
        ctx.strokeRect(sx - size * 0.4, sy - size * 0.48, size * 0.84, size * 0.4);
        ctx.fillStyle = screen;
        ctx.fillRect(sx - size * 0.34, sy - size * 0.42, size * 0.3, size * 0.28);
        ctx.fillRect(sx + size * 0.04, sy - size * 0.42, size * 0.3, size * 0.28);
      }
      return;
    }
    if (s.kind === 'wire') {
      // Left as an improved Canvas primitive, not an SVG sprite: a wire tile renders as a
      // repeating conduit run across the tile (a cross so a chain reads as continuous cable in
      // any direction), not a centered icon -- that doesn't fit drawSprite's centered-silhouette
      // model (see 'fence' above for the same reasoning). Lit amber only when the segment is
      // actually carrying power back to a generator; dead segments stay dull grey.
      const live = !s.destroyed && !s.underConstruction && isTileEnergized(this._structuresForPower || [], s.x, s.y);
      ctx.strokeStyle = live ? '#e0a336' : 'rgba(110,105,95,0.75)';
      ctx.lineWidth = Math.max(1.5, size * 0.1);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx - size / 2, sy); ctx.lineTo(sx + size / 2, sy);
      ctx.moveTo(sx, sy - size / 2); ctx.lineTo(sx, sy + size / 2);
      ctx.stroke();
      ctx.fillStyle = live ? '#f5cf80' : '#57534b';
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      return;
    }
    if (s.kind === 'pipe') {
      // Water's answer to 'wire' above -- same "repeating conduit, not a centered icon" reasoning
      // for staying an improved primitive, same thin cross-conduit shape so a chain reads as one
      // continuous run, but blue-tinted instead of wire's amber so the two grids never get
      // visually confused when they're laid side by side. Lit only when actually carrying water
      // back to a pump; dead segments stay a dull blue-grey.
      const flowing = !s.destroyed && !s.underConstruction && isTileWatered(this._structuresForPower || [], s.x, s.y);
      ctx.strokeStyle = flowing ? '#3ea0d9' : 'rgba(90,105,115,0.75)';
      ctx.lineWidth = Math.max(1.5, size * 0.1);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx - size / 2, sy); ctx.lineTo(sx + size / 2, sy);
      ctx.moveTo(sx, sy - size / 2); ctx.lineTo(sx, sy + size / 2);
      ctx.stroke();
      ctx.fillStyle = flowing ? '#9adcf5' : '#5f6d72';
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      return;
    }
    if (s.kind === 'battery') {
      // A squat rounded-rect cell with a raised terminal nub (real battery-icon silhouette) and a
      // fill bar showing storedEnergy/BATTERY_STORED_MAX -- reads at a glance whether it's empty,
      // mid-charge, or full, the same way a fuel gauge would. Style-brief pass: flat casing + a
      // single upper-left highlight patch (matching the generator family's shading convention)
      // instead of a flat block with no shading cue at all; the charge-fill itself keeps a real
      // vertical gradient since it's the one deliberate "energy" glow accent on this structure,
      // same reasoning as the nuclear core / generator core glows.
      const live = !s.destroyed && !s.underConstruction;
      const frac = Math.max(0, Math.min(1, (s.storedEnergy || 0) / BATTERY_STORED_MAX));
      const casing = live ? '#3a3f47' : 'rgba(58,63,71,0.6)';
      ctx.fillStyle = casing;
      const w = size * 0.6, h = size * 0.8;
      ctx.fillRect(sx - w / 2, sy - h / 2, w, h);
      ctx.strokeRect(sx - w / 2, sy - h / 2, w, h);
      // upper-left highlight patch -- flat solid shape, not a gradient, per the style brief
      if (live) {
        ctx.fillStyle = shade(casing, 0.22);
        ctx.fillRect(sx - w / 2 + size * 0.04, sy - h / 2 + size * 0.04, w * 0.4, size * 0.1);
      }
      // terminal nub on top
      ctx.fillStyle = casing;
      ctx.fillRect(sx - size * 0.1, sy - h / 2 - size * 0.08, size * 0.2, size * 0.08);
      // charge fill bar, bottom-up -- muted (desaturated ~20%) but still traffic-light coded;
      // a real vertical gradient here since this is the deliberate glow/energy accent, kept from
      // the earlier flat-fill pass rather than removed by the "flatten shading" brief.
      if (live && frac > 0) {
        const fillH = (h - size * 0.08) * frac;
        const fillColor = frac > 0.6 ? '#6ba852' : frac > 0.25 ? '#c2a83f' : '#b8543a';
        const grad = ctx.createLinearGradient(0, sy + h / 2 - fillH, 0, sy + h / 2);
        grad.addColorStop(0, shade(fillColor, 0.25));
        grad.addColorStop(1, fillColor);
        ctx.fillStyle = grad;
        ctx.fillRect(sx - w / 2 + size * 0.05, sy + h / 2 - size * 0.04 - fillH, w - size * 0.1, fillH);
      }
      return;
    }
    if (s.kind === 'power_switch') {
      // Small pedestal with a lever -- up and lit green when switchedOn (the default), down and
      // dull red when the player has manually cut this exact tile out of the segment (power.js's
      // isConductor). Reads immediately even at a glance, no need to open the inspector. Style-brief
      // pass: pedestal gets a flat base + a small upper-left highlight edge instead of reading as a
      // single flat block; indicator-light colors desaturated ~20% to match the battery gauge.
      const live = !s.destroyed && !s.underConstruction;
      const on = s.switchedOn !== false;
      ctx.fillStyle = live ? '#4a4a52' : 'rgba(74,74,82,0.6)';
      ctx.fillRect(sx - size * 0.22, sy - size * 0.1, size * 0.44, size * 0.32); // pedestal base
      ctx.strokeRect(sx - size * 0.22, sy - size * 0.1, size * 0.44, size * 0.32);
      if (live) {
        ctx.fillStyle = shade('#4a4a52', 0.22);
        ctx.fillRect(sx - size * 0.2, sy - size * 0.08, size * 0.18, size * 0.07);
      }
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(2, size * 0.12);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx, sy - size * 0.06);
      if (on) ctx.lineTo(sx + size * 0.12, sy - size * 0.42);
      else ctx.lineTo(sx - size * 0.12, sy - size * 0.02);
      ctx.stroke();
      ctx.fillStyle = live ? (on ? '#6ba852' : '#b8543a') : '#6a6a6a';
      ctx.beginPath();
      ctx.arc(sx + (on ? size * 0.12 : -size * 0.12), sy + (on ? -size * 0.42 : -size * 0.02), size * 0.09, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (s.kind === 'power_exporter') {
      // Power Exporter (power.js's tickPowerExporters, real PA DLC Transformer/PowerExportMeter/
      // QuickConnect mechanic): a squat transformer-pylon silhouette -- two stacked coil rings on
      // a base -- with a small upward scrap-arrow glyph that ONLY lights up while `s._exportRate`
      // (stamped fresh every tick by tickPowerExporters, never a cached/lagging value) is actually
      // > 0. Dull steel when built but not currently trickling (unpowered, or a downstream
      // consumer is eating the segment's whole surplus this tick) so a glance at the icon tells
      // the player whether it's doing anything RIGHT NOW, not just whether it's built -- same
      // "state, not existence" reasoning as power_switch's on/off lever above.
      const live = !s.destroyed && !s.underConstruction;
      const exporting = live && (s._exportRate || 0) > 0;
      const casing = live ? '#4a5560' : 'rgba(74,85,96,0.6)';
      const w = size * 0.5, h = size * 0.62;
      ctx.fillStyle = casing;
      ctx.fillRect(sx - w / 2, sy - size * 0.06, w, h * 0.55); // base
      ctx.strokeRect(sx - w / 2, sy - size * 0.06, w, h * 0.55);
      if (live) {
        ctx.fillStyle = shade(casing, 0.22);
        ctx.fillRect(sx - w / 2 + size * 0.04, sy - size * 0.02, w * 0.4, size * 0.08);
      }
      // Two stacked coil rings -- the transformer-silhouette cue, tinted green while exporting.
      ctx.strokeStyle = exporting ? '#6ba852' : (live ? OUTLINE : 'rgba(122,122,122,0.6)');
      ctx.lineWidth = Math.max(1.5, size * 0.07);
      for (const ry of [sy - size * 0.16, sy + size * 0.06]) {
        ctx.beginPath();
        ctx.arc(sx, ry, size * 0.15, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Upward scrap-export arrow -- only drawn while genuinely exporting this tick, pulsing off
      // the wall clock (same pattern as the overload-warning ring above) so it stays visible even
      // while the sim is paused.
      if (exporting) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 220);
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.45 * pulse;
        ctx.fillStyle = '#e0a336';
        ctx.beginPath();
        ctx.moveTo(sx, sy - size * 0.52);
        ctx.lineTo(sx - size * 0.09, sy - size * 0.32);
        ctx.lineTo(sx + size * 0.09, sy - size * 0.32);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      return;
    }
    if (s.kind === 'shrine') {
      // Shrine (RimWorld Ideology DLC's real altar buildable, see assets.js's 'shrine' template /
      // rooms.js's BEAUTY_BY_KIND.shrine) -- a beauty-only passive building, no functional state
      // to reflect in color (unlike pump's running/dead or power_switch's on/off), so this is the
      // simplest case in this function: one fixed warm-stone palette, matching the wood-furniture
      // family's tone (bed/table/door above) since it reads as a deliberate furnishing, not
      // industrial equipment.
      const stone = '#8f8570';
      const drew = drawSprite(ctx, 'shrine', {
        STONE: stone, STONE_HI: shade(stone, 0.32),
        GLOW: '#c9a24a', GLOW_HI: '#f2dfa0', OUTLINE,
      }, sx, sy, size);
      if (!drew) {
        ctx.fillStyle = stone;
        ctx.fillRect(sx - size * 0.4, sy - size * 0.1, size * 0.8, size * 0.5);
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.25, sy - size * 0.1);
        ctx.lineTo(sx + size * 0.25, sy - size * 0.1);
        ctx.lineTo(sx, sy - size * 0.45);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.strokeRect(sx - size * 0.4, sy - size * 0.1, size * 0.8, size * 0.5);
        ctx.fillStyle = '#e2c168';
        ctx.beginPath(); ctx.arc(sx, sy - size * 0.15, size * 0.1, 0, Math.PI * 2); ctx.fill();
      }
      return;
    }
    if (s.kind === 'cinema') {
      // Cinema (real PA DLC prefab catalog's WatchCinema provider, see jobs.js's tickCinemas):
      // left as a Canvas primitive, no new SVG template, same "no new mechanic beyond the
      // buildable itself" v1 scope as fitness_station/shrine/farm_plot above. Drawn as a small
      // projector screen on a stand -- a flat panel (the "screen") with a marquee strip on top,
      // reading distinctly from bed/table's flat furniture silhouettes. The screen glows/pulses
      // gently on the tick a showing is actively airing (currentTick % CINEMA_SHOWTIME_INTERVAL_
      // TICKS near 0, read off this._lastTick set at the top of the render loop) so the player
      // can see at a glance when the broadcast is live, same "read the active state at a glance"
      // idea as workshop's staffed work-light pulse.
      const frame = '#5a4a38';
      const screenBase = s.destroyed ? 'rgba(60,60,64,0.4)' : '#2b2f36';
      ctx.fillStyle = frame;
      ctx.fillRect(sx - size * 0.42, sy - size * 0.44, size * 0.84, size * 0.14); // marquee strip
      ctx.strokeRect(sx - size * 0.42, sy - size * 0.44, size * 0.84, size * 0.14);
      ctx.fillStyle = screenBase;
      ctx.fillRect(sx - size * 0.38, sy - size * 0.28, size * 0.76, size * 0.5); // screen panel
      ctx.strokeRect(sx - size * 0.38, sy - size * 0.28, size * 0.76, size * 0.5);
      if (!s.destroyed && !s.underConstruction) {
        const ticksSinceShow = (this._lastTick ?? 0) % CINEMA_SHOWTIME_INTERVAL_TICKS;
        const airing = ticksSinceShow < CINEMA_SHOWING_GLOW_TICKS;
        const glow = airing ? (0.5 + 0.4 * Math.sin(Date.now() / 150)) : 0.18;
        ctx.fillStyle = `rgba(120,190,235,${glow})`;
        ctx.fillRect(sx - size * 0.32, sy - size * 0.22, size * 0.64, size * 0.38);
      }
      ctx.fillStyle = shade(frame, -0.25);
      ctx.fillRect(sx - size * 0.08, sy + size * 0.22, size * 0.16, size * 0.12); // stand base
      ctx.strokeStyle = OUTLINE;
      return;
    }
    if (s.kind === 'pump') {
      // Small well/tower silhouette (SVG art, see assets.js's 'pump' template) -- a squat
      // cylindrical drum with a raised spout, distinct from the generator family's boxy housing
      // so the two source buildings don't read as siblings. Falls back to the old primitive
      // drum+band+spout while a new color combo's sprite is still decoding.
      const running = !s.destroyed && !s.underConstruction;
      const drum = running ? '#33566a' : '#3a4750'; // desaturated ~15% from the earlier saturated teal
      const drew = drawSprite(ctx, 'pump', {
        DRUM: drum, DRUM_HI: shade(drum, 0.3),
        WATER: running ? '#4f92b3' : '#5a6a70', // muted water-blue, still distinct from the drum body
        SPOUT: running ? '#8c949e' : '#787878', OUTLINE,
      }, sx, sy, size * 1.05, 0, running ? 1 : 0.75);
      if (!drew) {
        ctx.fillStyle = running ? '#33566a' : 'rgba(46,60,68,0.6)';
        ctx.beginPath();
        ctx.ellipse(sx, sy, size * 0.36, size * 0.4, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = running ? '#4f92b3' : '#5a6a70'; // water-level band
        ctx.beginPath();
        ctx.ellipse(sx, sy + size * 0.08, size * 0.28, size * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = running ? '#8c949e' : 'rgba(120,120,120,0.6)';
        ctx.fillRect(sx - size * 0.06, sy - size * 0.5, size * 0.12, size * 0.24); // spout
      }
      return;
    }
    if (s.kind === 'generator') {
      // Boxy industrial housing + core light (SVG art, see assets.js's 'generator' template) --
      // the "default" power source silhouette the other generator_* variants below deliberately
      // read as heavier/lighter/differently-shaped than.
      const running = !s.destroyed && !s.underConstruction;
      const housing = running ? '#4a4a52' : '#3c3c40';
      const core = running ? '#c79552' : '#6a6250'; // muted amber (~20% desaturated) -- core light goes dark when it isn't running
      const drew = drawSprite(ctx, 'generator', {
        HOUSING: housing, HOUSING_HI: shade(housing, 0.25), HOUSING_SHADOW: shade(housing, -0.3),
        CORE: core, CORE_HI: shade(core, running ? 0.4 : 0.1), OUTLINE,
      }, sx, sy, size, 0, running ? 1 : 0.75);
      if (!drew) {
        ctx.fillStyle = running ? '#4a4a52' : 'rgba(60,60,64,0.6)';
        ctx.fillRect(sx - size * 0.42, sy - size * 0.42, size * 0.84, size * 0.84);
        ctx.strokeRect(sx - size * 0.42, sy - size * 0.42, size * 0.84, size * 0.84);
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(sx, sy, size * 0.18, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    if (s.kind === 'generator_nuclear') {
      // Deliberately reads as heavier/more industrial than the plain generator (dark housing,
      // SVG art in assets.js's 'generator_nuclear' template) with a radiation-trefoil glyph
      // glowing sickly green instead of the plain generator's warm amber -- the same green family
      // as the hazard radius so the two visually associate.
      const running = !s.destroyed && !s.underConstruction;
      const housing = running ? '#2e3230' : '#282c2a';
      const core = running ? '#a9b94a' : '#5a6650'; // desaturated ~20% hazard-green (was a candy-bright yellow-green)
      const drew = drawSprite(ctx, 'generator_nuclear', {
        HOUSING: housing, HOUSING_HI: shade(housing, 0.2),
        WELL: running ? '#161816' : '#3a3e3c',
        CORE: core, CORE_HI: running ? '#d9edaa' : '#7a8570', OUTLINE,
      }, sx, sy, size, 0, running ? 1 : 0.75);
      if (!drew) {
        ctx.fillStyle = running ? '#2e3230' : 'rgba(40,44,42,0.6)';
        ctx.fillRect(sx - size * 0.46, sy - size * 0.46, size * 0.92, size * 0.92);
        ctx.strokeRect(sx - size * 0.46, sy - size * 0.46, size * 0.92, size * 0.92);
        // trefoil-ish radiation glyph: three wedges around a hot core
        ctx.fillStyle = running ? '#161816' : '#3a3e3c';
        ctx.beginPath(); ctx.arc(sx, sy, size * 0.3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = core;
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2 - Math.PI / 2;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.arc(sx, sy, size * 0.26, a - 0.35, a + 0.35);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = running ? '#d9edaa' : '#7a8570';
        ctx.beginPath(); ctx.arc(sx, sy, size * 0.08, 0, Math.PI * 2); ctx.fill();
      }
      return;
    }
    if (s.kind === 'generator_coal') {
      // "Worse plain generator": a squatter, dirtier housing than 'generator' (SVG art, see
      // assets.js's 'generator_coal' template) with a coal-pile silhouette out front and a dull
      // red (not amber) core light so it visually reads as the cheaper, more polluting choice at
      // a glance.
      const running = !s.destroyed && !s.underConstruction;
      const housing = running ? '#3a332c' : '#332e28';
      const coal = running ? '#1a1a1a' : '#3a3a3a';
      const core = running ? '#a85138' : '#5a4a44'; // desaturated ~15% dull brick-red, not the plain generator's amber
      const drew = drawSprite(ctx, 'generator_coal', {
        HOUSING: housing, HOUSING_HI: shade(housing, 0.2),
        COAL: coal, COAL_HI: shade(coal, 0.25), CORE: core, OUTLINE,
      }, sx, sy, size, 0, running ? 1 : 0.75);
      if (!drew) {
        ctx.fillStyle = running ? '#3a332c' : 'rgba(50,46,40,0.6)';
        ctx.fillRect(sx - size * 0.4, sy - size * 0.36, size * 0.8, size * 0.72);
        ctx.strokeRect(sx - size * 0.4, sy - size * 0.36, size * 0.8, size * 0.72);
        ctx.fillStyle = coal;
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.3, sy + size * 0.36);
        ctx.lineTo(sx - size * 0.05, sy + size * 0.12);
        ctx.lineTo(sx + size * 0.2, sy + size * 0.36);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(sx + size * 0.18, sy - size * 0.12, size * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    if (s.kind === 'generator_wind') {
      // Turbine silhouette: a slim mast + three static blades (SVG art, see assets.js's
      // 'generator_wind' template -- a real spin was tried and read worse than a static
      // silhouette at this sprite size). _windSited (power.js's isWindSited, recomputed live off
      // the current structures list) tints the blades pale blue when actually acting as a power
      // source and rust-red when crowded/badly sited, so the siting tradeoff is visible on the
      // map, not just in a tooltip.
      const running = !s.destroyed && !s.underConstruction;
      const sited = s._windSited !== false;
      // Muted ~15-20%: sited reads white/gray (not saturated sky-blue), crowded reads dusty rust
      // rather than a bright warning-orange.
      const blade = running ? (sited ? '#c7d3d6' : '#b8735a') : '#6a6a6a';
      const mast = running ? '#5a5a5a' : '#464646';
      const drew = drawSprite(ctx, 'generator_wind', {
        MAST: mast, MAST_HI: shade(mast, 0.3), BLADE: blade,
        HUB: running ? '#3a3a3a' : '#5a5a5a', OUTLINE,
      }, sx, sy, size, 0, running ? 1 : 0.75);
      if (!drew) {
        ctx.fillStyle = running ? '#5a5a5a' : 'rgba(70,70,70,0.6)';
        ctx.fillRect(sx - size * 0.05, sy - size * 0.05, size * 0.1, size * 0.55); // mast
        ctx.fillStyle = blade;
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2;
          ctx.save();
          ctx.translate(sx, sy - size * 0.28);
          ctx.rotate(a);
          ctx.beginPath();
          ctx.ellipse(0, -size * 0.24, size * 0.07, size * 0.24, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        ctx.fillStyle = running ? '#3a3a3a' : '#5a5a5a';
        ctx.beginPath(); ctx.arc(sx, sy - size * 0.28, size * 0.06, 0, Math.PI * 2); ctx.fill();
      }
      return;
    }
    if (s.kind === 'generator_solar') {
      // Flat panel array in a grid pattern, tilted slightly (SVG art, see assets.js's
      // 'generator_solar' template -- a parallelogram, not a square, so it reads as a solar panel
      // rather than another generic box). Panel/grid tint follows s._openSky (world.js's tick(),
      // read back by power.js's isSource) the same sited/unsited color logic as the wind turbine
      // above: bright blue when actually acting as a power source, dull grey when stuck inside an
      // enclosed room.
      const running = !s.destroyed && !s.underConstruction;
      const openSky = s._openSky !== false;
      const panel = running ? '#2a3038' : '#2d3238';
      const grid = running ? (openSky ? '#5487ad' : '#6a6e72') : '#5a5f64'; // muted panel-blue (~15% desaturated)
      const drew = drawSprite(ctx, 'generator_solar', {
        PANEL: panel, PANEL_HI: shade(panel, 0.2), GRID: grid, OUTLINE,
      }, sx, sy, size, 0, running ? 1 : 0.7);
      if (!drew) {
        ctx.fillStyle = running ? '#2a3038' : 'rgba(45,50,56,0.6)';
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.45, sy + size * 0.3);
        ctx.lineTo(sx - size * 0.2, sy - size * 0.35);
        ctx.lineTo(sx + size * 0.45, sy - size * 0.35);
        ctx.lineTo(sx + size * 0.2, sy + size * 0.3);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        // Panel grid lines: interpolate between the bottom edge (bottomLeft -> bottomRight) and the
        // top edge (topLeft -> topRight) so the divider lines stay parallel to the panel's tilt.
        const blX = sx - size * 0.45, blY = sy + size * 0.3;
        const brX = sx + size * 0.2, brY = sy + size * 0.3;
        const tlX = sx - size * 0.2, tlY = sy - size * 0.35;
        const trX = sx + size * 0.45, trY = sy - size * 0.35;
        ctx.strokeStyle = grid;
        ctx.lineWidth = Math.max(1, size * 0.03);
        for (let k = 1; k < 3; k++) {
          const t = k / 3;
          ctx.beginPath();
          ctx.moveTo(blX + (brX - blX) * t, blY + (brY - blY) * t);
          ctx.lineTo(tlX + (trX - tlX) * t, tlY + (trY - tlY) * t);
          ctx.stroke();
        }
      }
      return;
    }
    if (s.kind === 'waste_storage') {
      // Hazard-striped drum cluster so it reads as "the thing that fixes the green zone" at a
      // glance, distinct from the recycling center's green arrow icon (that's a different
      // resource loop -- pollution, not nuclear waste).
      // RESTYLE: the housing shell is metal/industrial so it's desaturated ~20% and cooled toward
      // gray-blue (was a warm olive). The hazard stripe (cap/stripeDark, both still full
      // saturation) is the deliberate exception the style brief calls out -- left untouched.
      const fill = s.destroyed ? 'rgba(70,72,66,0.5)' : '#454940';
      const cap = s.destroyed ? 'rgba(160,150,40,0.4)' : '#d9c93a';
      const stripeDark = s.destroyed ? 'rgba(40,36,18,0.5)' : '#2b2812';
      const drew = drawSprite(ctx, 'waste_storage', {
        FILL: fill, FILL_HI: s.destroyed ? 'rgba(90,84,40,0.5)' : shade(fill, 0.3),
        STRIPE_DARK: stripeDark, STRIPE_LIGHT: cap, CAP: cap, OUTLINE,
      }, sx, sy, size);
      if (!drew) {
        ctx.fillStyle = fill;
        ctx.fillRect(sx - size * 0.4, sy - size * 0.38, size * 0.8, size * 0.76);
        ctx.strokeRect(sx - size * 0.4, sy - size * 0.38, size * 0.8, size * 0.76);
        ctx.fillStyle = cap;
        for (const dx of [-0.22, 0.22]) {
          ctx.beginPath();
          ctx.arc(sx + size * dx, sy, size * 0.16, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
      return;
    }
    if (s.kind === 'recycling_center') {
      // Keeps the recognizable green chasing-arrows recycling motif, now baked into the sprite
      // (see assets.js's 'recycling_center' template) instead of drawn as a single Canvas diamond.
      // RESTYLE: housing desaturated ~20% and cooled toward gray-blue-teal (metal/industrial
      // material trend); the arrow glyph is desaturated a touch too but kept legible/vivid since
      // it's the functional "recycling happens here" icon, not a hazard-stripe exception.
      const drew = drawSprite(ctx, 'recycling_center',
        { FILL: '#37524a', FILL_HI: shade('#37524a', 0.25), ARROW: '#6cbf8f', OUTLINE }, sx, sy, size);
      if (!drew) {
        ctx.fillStyle = '#2e5a4a';
        ctx.fillRect(sx - size * 0.45, sy - size * 0.42, size * 0.9, size * 0.84);
        ctx.strokeRect(sx - size * 0.45, sy - size * 0.42, size * 0.9, size * 0.84);
        ctx.fillStyle = '#7ad9a0';
        ctx.beginPath();
        ctx.moveTo(sx, sy - size * 0.2); ctx.lineTo(sx + size * 0.16, sy); ctx.lineTo(sx, sy + size * 0.2);
        ctx.lineTo(sx - size * 0.16, sy); ctx.closePath();
        ctx.fill();
      }
      return;
    }
    if (s.kind === 'floodlight') {
      if (!s.destroyed) {
        ctx.fillStyle = 'rgba(230,230,150,0.12)';
        ctx.beginPath(); ctx.arc(sx, sy, size * 1.4, 0, Math.PI * 2); ctx.fill();
      }
      const lamp = s.destroyed ? '#5a5540' : '#f2eec0';
      // Style-brief pass: post/housing metal desaturated ~15% from the old khaki; LAMP is the
      // light source itself (not institutional metal), left untouched.
      const housing = '#847a63';
      const drew = drawSprite(ctx, 'floodlight',
        { POST: housing, HOUSING: housing, HOUSING_HI: shade(housing, 0.3), LAMP: lamp, OUTLINE }, sx, sy + size * 0.1, size * 1.1);
      if (!drew) {
        ctx.fillStyle = housing;
        ctx.fillRect(sx - size * 0.08, sy - size * 0.1, size * 0.16, size * 0.5);
        ctx.fillStyle = lamp;
        ctx.beginPath(); ctx.arc(sx, sy - size * 0.22, size * 0.22, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      return;
    }
    if (s.kind === 'tesla') {
      // Style-brief pass: base housing desaturated toward a cooler, less-saturated blue-gray;
      // ARC/spark stroke is the charge-glow hazard exception and stays at full saturation
      // (untouched) as the deliberate contrast against the calmer housing color.
      const teslaBase = '#4e5a78';
      const base = s.destroyed ? 'rgba(60,60,60,0.6)' : teslaBase;
      const arc = s.destroyed ? 'rgba(120,140,220,0.3)' : '#a0c0ff';
      const drew = drawSprite(ctx, 'tesla',
        { FILL: base, FILL_HI: s.destroyed ? 'rgba(80,80,80,0.6)' : shade(teslaBase, 0.3), ARC: arc, OUTLINE },
        sx, sy, size);
      if (!drew) {
        ctx.fillStyle = base;
        ctx.beginPath(); ctx.arc(sx, sy + size * 0.15, size * 0.35, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = arc;
        ctx.lineWidth = Math.max(1, size * 0.06);
        ctx.beginPath(); ctx.arc(sx, sy - size * 0.15, size * 0.16, 0, Math.PI * 2); ctx.stroke();
      }
      return;
    }
    if (s.kind === 'armory') {
      // Style-brief pass: armory is one of the named institutional/metal structures -- base
      // shifted from a warm brown to a cool slate gray-blue. The crossed-rifles glyph and a new
      // small ammo-crate accent are the deliberate full-saturation hazard-color exception (ammo
      // red), same idea as tesla's charge glow -- visible against the now-calmer base.
      const armoryBase = '#565c66';
      const fill = s.destroyed ? 'rgba(60,60,60,0.6)' : armoryBase;
      const glyph = s.destroyed ? 'rgba(150,150,150,0.4)' : '#d7dde2';
      const ammo = s.destroyed ? 'rgba(120,50,40,0.4)' : '#c23b2e';
      // Crossed-rifles glyph -- reads as "weapons issued here" at a glance, same idea as the
      // recycling center's arrow icon just above -- now baked into the sprite itself.
      const drew = drawSprite(ctx, 'armory',
        { FILL: fill, FILL_HI: s.destroyed ? 'rgba(80,80,80,0.6)' : shade(armoryBase, 0.3), GLYPH: glyph, AMMO: ammo, OUTLINE },
        sx, sy, size);
      if (!drew) {
        ctx.fillStyle = fill;
        ctx.fillRect(sx - size * 0.45, sy - size * 0.42, size * 0.9, size * 0.84);
        ctx.strokeRect(sx - size * 0.45, sy - size * 0.42, size * 0.9, size * 0.84);
        ctx.strokeStyle = glyph;
        ctx.lineWidth = Math.max(1, size * 0.07);
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.2, sy - size * 0.18); ctx.lineTo(sx + size * 0.2, sy + size * 0.18);
        ctx.moveTo(sx - size * 0.2, sy + size * 0.18); ctx.lineTo(sx + size * 0.2, sy - size * 0.18);
        ctx.stroke();
        ctx.fillStyle = ammo;
        ctx.fillRect(sx - size * 0.18, sy + size * 0.28, size * 0.22, size * 0.12);
      }
      return;
    }
    if (s.kind === 'stabilizer') {
      // Stabilizer Beacon (anomaly.js) -- kept as a plain Canvas primitive, same "cheap counter-
      // buildable, no new SVG asset" precedent as rat_trap just below: a squat post with a small
      // diamond "lamp" on top, filled a calm teal so it reads as distinct from every other
      // structure's warmer/neutral palette (this is the one buildable whose whole job is visually
      // signaling "hazard countermeasure, not a weapon").
      const fill = s.destroyed ? 'rgba(60,80,80,0.4)' : '#3f8f8a';
      ctx.fillStyle = fill;
      ctx.fillRect(sx - size * 0.08, sy - size * 0.05, size * 0.16, size * 0.32);
      ctx.strokeRect(sx - size * 0.08, sy - size * 0.05, size * 0.16, size * 0.32);
      const lampY = sy - size * 0.22;
      ctx.fillStyle = s.destroyed ? fill : shade(fill, 0.4);
      ctx.beginPath();
      ctx.moveTo(sx, lampY - size * 0.16);
      ctx.lineTo(sx + size * 0.16, lampY);
      ctx.lineTo(sx, lampY + size * 0.16);
      ctx.lineTo(sx - size * 0.16, lampY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      return;
    }
    if (s.kind === 'rat_trap') {
      // Kept as a plain Canvas primitive (rats.js is deliberately the "cheap" system this pass --
      // no new SVG asset needed for a small counter-buildable): a squat wooden box with a dark
      // trigger-plate slot, distinct enough from the round explosive 'trap' shape above at a glance.
      // Style-brief pass: fill desaturated slightly, plus a flat + single upper-left highlight
      // (matching the rest of the category's shading technique) instead of a flat single tone.
      const fill = s.destroyed ? 'rgba(80,60,40,0.4)' : '#856c4e';
      ctx.fillStyle = fill;
      ctx.fillRect(sx - size * 0.32, sy - size * 0.22, size * 0.64, size * 0.44);
      ctx.strokeRect(sx - size * 0.32, sy - size * 0.22, size * 0.64, size * 0.44);
      if (!s.destroyed) {
        ctx.fillStyle = shade(fill, 0.35);
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.32, sy - size * 0.22);
        ctx.lineTo(sx - size * 0.06, sy - size * 0.22);
        ctx.lineTo(sx - size * 0.32, sy + size * 0.02);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(30,25,20,0.8)';
        ctx.fillRect(sx - size * 0.2, sy - size * 0.06, size * 0.4, size * 0.12);
      }
      return;
    }
    if (s.kind === 'lightning_rod') {
      // Plain Canvas primitive, same "cheap single-purpose counter-buildable, no new SVG asset"
      // precedent as rat_trap above: a slim metal pole with a small ball tip, plus a faint
      // protection-radius ring while a Lightning Storm is actually active (weather.js's
      // isLightningStormActive/LIGHTNING_ROD_RADIUS) so the player can see the coverage they're
      // paying for exactly when it matters, same "show the radius during the hazard" idea as
      // floodlight's always-on glow just reused conditionally.
      const poleColor = s.destroyed ? 'rgba(90,90,90,0.5)' : '#8a8f96';
      const tipColor = s.destroyed ? 'rgba(90,90,90,0.5)' : '#e8e6c8';
      if (!s.destroyed
          && (this._currentWeather === 'ThunderstormDry' || this._currentWeather === 'ThunderstormRainy')) {
        ctx.strokeStyle = 'rgba(232,230,200,0.25)';
        ctx.lineWidth = Math.max(1, size * 0.05);
        ctx.beginPath(); ctx.arc(sx, sy, size * 2.4, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.strokeStyle = poleColor;
      ctx.lineWidth = Math.max(1.5, size * 0.12);
      ctx.beginPath();
      ctx.moveTo(sx, sy + size * 0.4);
      ctx.lineTo(sx, sy - size * 0.45);
      ctx.stroke();
      ctx.fillStyle = tipColor;
      ctx.beginPath(); ctx.arc(sx, sy - size * 0.48, size * 0.14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      return;
    }
    if (s.kind === 'fabrication_bay') {
      // Plain Canvas primitive (same "cheap, no new SVG asset needed" precedent as rat_trap/
      // lightning_rod above): a squat industrial box with a bay-door opening (echoes the garage
      // case's door-opening idea, since this is also "a small structure that produces a mobile
      // unit"), plus a pulsing work-light while anything is actually gestating (world.js's
      // droneFabricationQueue) -- same "lit = actively running" language as the workshop's own
      // staffed work-light above.
      const fill = s.destroyed ? 'rgba(70,68,64,0.6)' : '#565048';
      ctx.fillStyle = fill;
      ctx.fillRect(sx - size * 0.44, sy - size * 0.4, size * 0.88, size * 0.8);
      ctx.strokeRect(sx - size * 0.44, sy - size * 0.4, size * 0.88, size * 0.8);
      if (!s.destroyed) {
        ctx.fillStyle = shade(fill, 0.26);
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.44, sy - size * 0.4);
        ctx.lineTo(sx - size * 0.1, sy - size * 0.4);
        ctx.lineTo(sx - size * 0.44, sy - size * 0.08);
        ctx.closePath(); ctx.fill(); // upper-left highlight facet
        ctx.fillStyle = 'rgba(20,20,20,0.85)';
        ctx.fillRect(sx - size * 0.22, sy - size * 0.04, size * 0.44, size * 0.34); // bay-door opening
        const fabricating = (this._droneQueueLength || 0) > 0;
        if (fabricating) {
          const pulse = 0.55 + 0.35 * Math.sin(Date.now() / 200);
          ctx.fillStyle = `rgba(120,200,190,${pulse})`;
          ctx.beginPath(); ctx.arc(sx + size * 0.24, sy - size * 0.24, size * 0.08, 0, Math.PI * 2); ctx.fill();
        }
      }
      return;
    }
    if (s.kind === 'checkpoint') {
      // Plain Canvas primitive (same "cheap, no new SVG asset needed" precedent as rat_trap/
      // lightning_rod/fabrication_bay above): a small booth with a black-and-yellow striped boom
      // barrier, real PA DLC ScannerMachine/CheckPoint's screening-chokepoint read, reskinned with
      // zero carceral framing. Faint radius ring shown while active -- same "show the coverage
      // you're paying for" idea as floodlight's always-on glow and lightning_rod's storm-only ring
      // -- so the player can see security.js/factions.js's real CHECKPOINT_RADIUS at a glance.
      if (!s.destroyed) {
        ctx.strokeStyle = 'rgba(230,200,90,0.18)';
        ctx.lineWidth = Math.max(1, size * 0.04);
        ctx.beginPath(); ctx.arc(sx, sy, size * 1.75, 0, Math.PI * 2); ctx.stroke();
      }
      const boothFill = s.destroyed ? 'rgba(80,78,72,0.5)' : '#5c5850';
      ctx.fillStyle = boothFill;
      ctx.fillRect(sx - size * 0.3, sy - size * 0.1, size * 0.3, size * 0.5);
      ctx.strokeRect(sx - size * 0.3, sy - size * 0.1, size * 0.3, size * 0.5);
      if (!s.destroyed) {
        ctx.fillStyle = shade(boothFill, 0.3);
        ctx.beginPath();
        ctx.moveTo(sx - size * 0.3, sy - size * 0.1);
        ctx.lineTo(sx - size * 0.08, sy - size * 0.1);
        ctx.lineTo(sx - size * 0.3, sy + size * 0.08);
        ctx.closePath(); ctx.fill();
      }
      // Striped boom bar, angled up (raised/idle) -- distinct from fence's flat horizontal line.
      ctx.save();
      ctx.translate(sx - size * 0.12, sy + size * 0.1);
      ctx.rotate(-0.55);
      const barLen = size * 0.75;
      const stripes = 4;
      for (let i = 0; i < stripes; i++) {
        ctx.fillStyle = s.destroyed ? 'rgba(90,80,40,0.4)' : (i % 2 === 0 ? '#d8c24a' : '#2b2b28');
        ctx.fillRect((i / stripes) * barLen, -size * 0.05, barLen / stripes, size * 0.1);
      }
      ctx.strokeRect(0, -size * 0.05, barLen, size * 0.1);
      ctx.restore();
      return;
    }
    // turret (default)
    {
      // Style-brief pass: turret is one of the named institutional/metal structures -- desaturated
      // and cooled slightly from the old '#8c949e' (already fairly neutral gray-blue) toward a
      // calmer slate tone; shading is now flat + single upper-left highlight (baked into the
      // template) instead of a radial gradient.
      const turretBase = '#7e8894';
      const fill = s.destroyed ? 'rgba(60,60,60,0.6)' : turretBase;
      const barrel = '#2b2b2b';
      const drew = drawSprite(ctx, 'turret',
        { FILL: fill, FILL_HI: s.destroyed ? 'rgba(80,80,80,0.6)' : shade(turretBase, 0.3), BARREL: s.destroyed ? fill : barrel, OUTLINE },
        sx, sy, size);
      if (!drew) {
        ctx.fillStyle = fill;
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
        ctx.strokeRect(sx - size / 2, sy - size / 2, size, size);
        if (!s.destroyed) {
          ctx.fillStyle = barrel;
          ctx.fillRect(sx - size * 0.08, sy - size * 0.6, size * 0.16, size * 0.4);
        }
      }
    }
  }

  _drawResourceNodes(world) {
    const ctx = this.ctx;
    for (const n of world.resourceNodes || []) {
      if (n.depleted) continue;
      const [sx, sy] = this.worldToScreen(n.x, n.y);
      const s = CELL * this.zoom * (0.35 + 0.35 * (n.amount / n.maxAmount));
      // RESTYLE: raw ore is a natural/mineral material (not yet processed metal), so it trends
      // warm ochre/tan like the rest of the game's organic-material objects rather than the cool
      // gray-blue used for the manufactured economy buildings above -- slightly desaturated off
      // the old tone. The VEIN facet already served as this template's one highlight shape, so it
      // just gets recolored to match, not restructured.
      const fill = '#8c8068';
      const vein = '#c2b48c';
      const drew = drawSprite(ctx, 'ore_deposit',
        { FILL: fill, FILL_HI: shade(fill, 0.25), VEIN: vein, OUTLINE }, sx, sy, s);
      if (!drew) {
        ctx.lineWidth = Math.max(1, s * 0.06);
        ctx.strokeStyle = OUTLINE;
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(sx - s * 0.5, sy + s * 0.3);
        ctx.lineTo(sx - s * 0.15, sy - s * 0.35);
        ctx.lineTo(sx + s * 0.2, sy - s * 0.1);
        ctx.lineTo(sx + s * 0.5, sy + s * 0.35);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = vein;
        ctx.fillRect(sx - s * 0.1, sy - s * 0.15, s * 0.18, s * 0.18);
      }
    }
  }

  _drawVehicles(world) {
    const ctx = this.ctx;
    for (const v of world.vehicles || []) {
      const parked = v.driverId == null;
      const [sx, sy] = this.worldToScreen(v.x, v.y);
      const s = CELL * this.zoom * 0.75;
      ctx.save();
      if (parked) ctx.globalAlpha = 0.55; // dimmed -- signals "needs a driver" at a glance
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.4, s * 0.55, s * 0.14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = Math.max(1, s * 0.06);
      ctx.strokeStyle = OUTLINE;
      // RESTYLE: same material-based split as the garages -- recycling truck trends desaturated
      // cool gray-blue-green (metal/industrial haul), garbage truck trends desaturated warm
      // ochre/tan (general/organic waste haul), each ~20% less saturated than the old tones.
      const bodyFill = v.kind === 'recycling' ? '#3f5c52' : '#6b5c40';
      // SEA:R fuel-type tradeoff (vehicles.js FUEL_TYPES): a colored fuel-tank stripe makes the
      // dirty/clean tradeoff visible at a glance without needing to inspect the truck --
      // fossil=sooty brown, gas=blue (the "best all-around" default), ethanol=green (clean but
      // food-cost), electric=cyan (cleanest, power-hungry). Baked into the sprite itself (see
      // assets.js's 'truck' template STRIPE placeholder) rather than a Canvas overlay, so it
      // still paints in the exact same spot on the cargo box regardless of the new cab silhouette.
      const stripe = FUEL_COLOR[v.fuelType] || FUEL_COLOR.gas;
      const drew = drawSprite(ctx, 'truck', {
        FILL: bodyFill, FILL_HI: shade(bodyFill, 0.25), CAB: shade(bodyFill, -0.2),
        WINDOW: '#bcd6e0', STRIPE: stripe, OUTLINE,
      }, sx, sy, s);
      if (!drew) {
        ctx.fillStyle = bodyFill;
        ctx.fillRect(sx - s * 0.5, sy - s * 0.32, s, s * 0.64);
        ctx.strokeRect(sx - s * 0.5, sy - s * 0.32, s, s * 0.64);
        ctx.fillStyle = stripe;
        ctx.fillRect(sx - s * 0.5, sy - s * 0.32, s, s * 0.12);
      }
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(sx - s * 0.3, sy + s * 0.32, s * 0.14, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx + s * 0.3, sy + s * 0.32, s * 0.14, 0, Math.PI * 2); ctx.fill();
      if (v.phase === 'working') {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(sx - s * 0.1, sy - s * 0.55, s * 0.2, s * 0.15);
      }
      ctx.restore();
      if (parked) {
        ctx.fillStyle = '#e0a336';
        ctx.font = `${Math.round(s * 0.4)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('?', sx, sy - s * 0.5);
      }
    }
  }

  // Labor drones (drones.js -- RimWorld Biotech's mech-companion analog): small, distinct from
  // both a citizen (humanoid SVG sprite) and a truck (this file's own _drawVehicles above) --
  // a squat mechanical box on short stubby legs with a single "status eye" light, deliberately
  // primitive Canvas 2D (same "left as an improved primitive" precedent as fence/wire/pipe) since
  // this is a small, cheap unit that doesn't need a full SVG template. The eye color encodes the
  // drone's one fixed WorkCategory (see WORK_CATEGORY_LABELS/DRONE_EYE_COLOR below) so its job is
  // readable at a glance without opening the inspector, and pulses while actively Working (not
  // just travelling) -- same "lit = actively running" language as _drawStructureShape's workshop
  // work-light and the garage/truck "working" glow.
  _drawDrones(world) {
    const ctx = this.ctx;
    for (const drone of world.drones || []) {
      if (drone.state === 'driving') continue; // riding inside a vehicle, drawn as part of it (same convention as a Driving citizen)
      const [sx, sy] = this.worldToScreen(drone.x, drone.y);
      const s = CELL * this.zoom * 0.55;
      const eyeRgb = DRONE_EYE_COLOR[drone.category] ?? [156, 156, 156];
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.38, s * 0.42, s * 0.12, 0, 0, Math.PI * 2); ctx.fill();
      // Stubby legs -- just enough to read "small mechanical unit standing on the ground", not an
      // animated walk-cycle (drones are tireless, not humanoid; no gait to animate).
      ctx.strokeStyle = '#2c2c2c';
      ctx.lineWidth = Math.max(1, s * 0.09);
      ctx.beginPath();
      ctx.moveTo(sx - s * 0.22, sy + s * 0.14); ctx.lineTo(sx - s * 0.22, sy + s * 0.32);
      ctx.moveTo(sx + s * 0.22, sy + s * 0.14); ctx.lineTo(sx + s * 0.22, sy + s * 0.32);
      ctx.stroke();
      // Body -- a plain salvage-tech box, not a sleek sci-fi chassis, matching this project's
      // "reskin as a simple mechanical/automated helper unit" framing rather than robot/AI framing.
      const bodyFill = '#5a564e';
      ctx.fillStyle = bodyFill;
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(1, s * 0.06);
      ctx.fillRect(sx - s * 0.34, sy - s * 0.3, s * 0.68, s * 0.5);
      ctx.strokeRect(sx - s * 0.34, sy - s * 0.3, s * 0.68, s * 0.5);
      ctx.fillStyle = shade(bodyFill, 0.28);
      ctx.beginPath();
      ctx.moveTo(sx - s * 0.34, sy - s * 0.3); ctx.lineTo(sx - s * 0.04, sy - s * 0.3);
      ctx.lineTo(sx - s * 0.34, sy - s * 0.06); ctx.closePath(); ctx.fill(); // upper-left highlight facet
      // Antenna -- reads as "fabricated equipment", not organic.
      ctx.strokeStyle = '#2c2c2c';
      ctx.beginPath(); ctx.moveTo(sx, sy - s * 0.3); ctx.lineTo(sx, sy - s * 0.48); ctx.stroke();
      ctx.fillStyle = '#2c2c2c';
      ctx.beginPath(); ctx.arc(sx, sy - s * 0.5, s * 0.05, 0, Math.PI * 2); ctx.fill();
      // Status eye -- solid while idle/travelling, pulsing while actively Working, colored by the
      // drone's one fixed WorkCategory.
      const working = drone.state === 'working';
      const alpha = working ? 0.55 + 0.35 * Math.sin(Date.now() / 200) : 0.9;
      ctx.fillStyle = `rgba(${eyeRgb[0]},${eyeRgb[1]},${eyeRgb[2]},${alpha})`;
      ctx.beginPath(); ctx.arc(sx, sy - s * 0.08, s * 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  // Low-detail top-down overview into a separate small canvas (see index.html #minimap) --
  // deliberately skips _buildGroundCache/_drawGround's noise shading (way more detail than a
  // handful of on-screen pixels can show) in favor of a flat fill plus dots/rects, so it stays
  // cheap to redraw every frame at a totally different scale than the main viewport.
  drawMinimap(world, mmCanvas) {
    const ctx = mmCanvas.getContext('2d');
    const W = mmCanvas.width, H = mmCanvas.height;
    const sx = W / world.width, sy = H / world.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#3a322a'; // flat ground tone, matches the canvas background elsewhere
    ctx.fillRect(0, 0, W, H);

    // structures -- small neutral squares, not trying to distinguish kind at this scale
    ctx.fillStyle = '#c9bfa8';
    for (const s of world.structures) {
      if (s.destroyed && s.kind === 'trap') continue;
      ctx.fillRect(s.x * sx - 1, s.y * sy - 1, 2, 2);
    }

    // citizens
    ctx.fillStyle = '#e8c9a0';
    for (let i = 0; i < world.citizens.count; i++) {
      if (!world.citizens.isAliveAt(i)) continue;
      ctx.fillRect(world.citizens.x[i] * sx - 1, world.citizens.y[i] * sy - 1, 2, 2);
    }

    // attackers -- the single most useful thing a minimap tells you during a siege is "where is
    // the wave coming from," so these get the loudest, most distinct color and a bigger dot.
    ctx.fillStyle = '#ff3b30';
    for (let i = 0; i < world.attackers.count; i++) {
      if (!world.attackers.isAliveAt(i)) continue;
      // Bosses get a fatter, brighter dot -- "there is a boss and it is HERE" is exactly the
      // kind of thing the minimap exists to tell you.
      const boss = world.attackers.kind && world.attackers.kind[i] === 3;
      if (boss) ctx.fillStyle = '#e05aff';
      const r = boss ? 3 : 1.5;
      ctx.fillRect(world.attackers.x[i] * sx - r, world.attackers.y[i] * sy - r, r * 2, r * 2);
      if (boss) ctx.fillStyle = '#ff3b30';
    }

    // viewport rectangle -- what the main camera currently frames
    const { x0, y0, x1, y1 } = this.getViewBounds();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(x0 * sx) + 0.5, Math.round(y0 * sy) + 0.5,
      Math.max(1, (x1 - x0) * sx), Math.max(1, (y1 - y0) * sy),
    );
  }

  /** Budget report sparkline (Prison Architect's finance ledger, see world.js's finance comment
   *  and FEATURE_RESEARCH.md's Prison Architect section): plain Canvas 2D bar chart of
   *  world.finance.history, one bar per snapshot, green for a net-positive wave-cycle and red for
   *  net-negative -- same "manual line/bar-plot in a small inline canvas" spirit as drawMinimap
   *  above, just DOM-driven (called from main.js only while the budget overlay is open) rather
   *  than every frame. */
  drawFinanceChart(world, chartCanvas) {
    const ctx = chartCanvas.getContext('2d');
    const W = chartCanvas.width, H = chartCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#241f1a';
    ctx.fillRect(0, 0, W, H);

    const history = world.finance?.history || [];
    if (history.length === 0) {
      ctx.fillStyle = '#a89e90';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No history yet -- first snapshot at tick 300', W / 2, H / 2);
      return;
    }

    const maxAbs = Math.max(1, ...history.map(h => Math.abs(h.net)));
    const midY = H / 2;
    const slot = W / history.length;
    const barW = Math.max(2, slot * 0.6);

    // zero line
    ctx.strokeStyle = '#4a4340';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY + 0.5);
    ctx.lineTo(W, midY + 0.5);
    ctx.stroke();

    history.forEach((h, i) => {
      const barH = (Math.abs(h.net) / maxAbs) * (H / 2 - 4);
      const cx = i * slot + slot / 2;
      ctx.fillStyle = h.net >= 0 ? '#6fbf6f' : '#d9534f';
      if (h.net >= 0) ctx.fillRect(cx - barW / 2, midY - barH, barW, barH);
      else ctx.fillRect(cx - barW / 2, midY, barW, barH);
    });
  }
}
