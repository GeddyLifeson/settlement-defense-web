// Procedural renderer -- draws every sprite with Canvas 2D shape primitives instead of AI-
// generated images. Visual language borrows from RimWorld/Prison Architect: flat top-down
// grid, a visible floor grid, outlined silhouettes so units read clearly against the ground,
// and zone/room tints rather than photographic texture.
import { StaffRoleKind, TerrainKind } from './core.js';
import { ZONE_COLOR, ZoneKind } from './zones.js';
import { JobState } from './jobs.js';
import { isTileEnergized } from './power.js';
import { isTileWatered } from './water.js';
import { isNuclearContained, NUCLEAR_HAZARD_RADIUS } from './siege.js';

const CELL = 24; // px per grid cell at zoom 1
const OUTLINE = 'rgba(20,16,12,0.75)';

const ROLE_COLOR = {
  [StaffRoleKind.Guard]: '#f2c026',
  [StaffRoleKind.Sniper]: '#bf59d9',
  [StaffRoleKind.K9Handler]: '#f2c026',
  [StaffRoleKind.Monitor]: '#59a6d9',
  [StaffRoleKind.None]: '#d3cdbf',
};

const ZONE_BORDER = {
  [ZoneKind.Bedroom]: '#5a6fb0',
  [ZoneKind.Food]: '#c98a2e',
  [ZoneKind.Recreation]: '#4a9e5f',
};

// SEA:R truck fuel-type tradeoff (see vehicles.js FUEL_TYPES) -- a stripe color per fuel so the
// dirty/clean tradeoff reads at a glance in _drawVehicles below.
const FUEL_COLOR = {
  fossil: '#6b5334',
  gas: '#3d6fa8',
  ethanol: '#5fa83d',
  electric: '#3dd0d0',
};

// Blend a hex color toward gray -- used to give OnBreak citizens a visibly washed-out look
// distinct from the flat gray used for Downed citizens (see _drawCitizens).
function desaturate(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
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
    this._drawResourceNodes(world);
    this._drawNuclearHazards(world);
    this._drawStructures(world);
    this._drawFire(world);
    this._drawCitizens(world);
    this._drawDogs(world);
    this._drawWildAnimals(world);
    this._drawAttackers(world);
    this._drawVehicles(world);
    this._drawSmogHaze(world);
    if (input) {
      this._drawCursor(world, input);
      this._drawSelection(world, input);
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
  // live cursor position so the player can see what they're about to sweep up.
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
    ctx.fillStyle = 'rgba(127,215,255,0.12)';
    ctx.strokeStyle = '#7fd7ff';
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
        ctx.beginPath();
        if (world.zones.get(x, y - 1) !== kind) { ctx.moveTo(px, py); ctx.lineTo(px + size, py); }
        if (world.zones.get(x, y + 1) !== kind) { ctx.moveTo(px, py + size); ctx.lineTo(px + size, py + size); }
        if (world.zones.get(x - 1, y) !== kind) { ctx.moveTo(px, py); ctx.lineTo(px, py + size); }
        if (world.zones.get(x + 1, y) !== kind) { ctx.moveTo(px + size, py); ctx.lineTo(px + size, py + size); }
        ctx.stroke();
      }
    }
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

  _drawHumanoid(x, y, scale, bodyColor, headColor, healthFrac) {
    const ctx = this.ctx;
    const [sx, sy] = this.worldToScreen(x, y);
    const s = CELL * this.zoom * scale;

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(sx, sy + s * 0.44, s * 0.3, s * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = Math.max(1, s * 0.06);
    ctx.strokeStyle = OUTLINE;

    // legs, drawn as two short stubs beneath the body so the silhouette doesn't read as one
    // flat blob (Prison Architect/RimWorld units both have a visible torso/leg break)
    ctx.fillStyle = bodyColor;
    ctx.beginPath(); ctx.rect(sx - s * 0.16, sy + s * 0.1, s * 0.12, s * 0.22); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.rect(sx + s * 0.04, sy + s * 0.1, s * 0.12, s * 0.22); ctx.fill(); ctx.stroke();

    ctx.beginPath();
    ctx.rect(sx - s * 0.19, sy - s * 0.12, s * 0.38, s * 0.28);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = headColor;
    ctx.beginPath();
    ctx.arc(sx, sy - s * 0.3, s * 0.21, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

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
      const role = world.roster.isStaff(id) ? world.roster.kindOf(id) : StaffRoleKind.None;
      const baseColor = ROLE_COLOR[role] || ROLE_COLOR[StaffRoleKind.None];
      const color = downed ? '#6b6b6b' : onBreak ? desaturate(baseColor, 0.6) : baseColor;
      const headColor = downed ? '#8a8a8a' : onBreak ? desaturate('#e8c9a0', 0.6) : '#e8c9a0';
      const [sx, sy] = this.worldToScreen(world.citizens.x[i], world.citizens.y[i]);
      this._drawHumanoid(world.citizens.x[i], world.citizens.y[i], downed ? 0.5 : 0.7, color, headColor, world.citizens.health[i]);
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
    }
  }

  // Tamed dogs (world.dogs, roster-assignable/combat-capable) get a warm coat + a gold collar
  // ring; wild untamed animals (world.wildAnimals, see security.js/jobs.js's Taming job) reuse
  // the same silhouette in a duller, uncollared coat so "this one isn't yours yet" reads clearly
  // at a glance without needing a whole separate sprite.
  _drawDogs(world) {
    this._drawAnimal(world.dogs, '#7a5230', '#f2c026');
  }

  _drawWildAnimals(world) {
    this._drawAnimal(world.wildAnimals, '#8f8a76', null);
  }

  _drawAnimal(list, coatColor, collarColor) {
    const ctx = this.ctx;
    for (const dog of list || []) {
      const [sx, sy] = this.worldToScreen(dog.x, dog.y);
      const s = CELL * this.zoom * 0.4;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.22, s * 0.34, s * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.strokeStyle = OUTLINE;
      ctx.fillStyle = coatColor;
      ctx.beginPath();
      ctx.ellipse(sx, sy, s * 0.32, s * 0.2, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx + s * 0.28, sy - s * 0.05, s * 0.14, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      if (collarColor) {
        ctx.strokeStyle = collarColor;
        ctx.lineWidth = Math.max(1, s * 0.1);
        ctx.beginPath();
        ctx.arc(sx + s * 0.28, sy - s * 0.05, s * 0.19, 0, Math.PI * 2);
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
  static ATTACKER_STYLES = [
    { scale: 0.6,  body: '#8a1f1f', head: '#c76b4a' }, // Grunt
    { scale: 0.85, body: '#4a4438', head: '#8f7a5c' }, // Brute
    { scale: 0.48, body: '#b0521f', head: '#e0a06a' }, // Skirmisher
    { scale: 1.25, body: '#4a1f5e', head: '#c469e0' }, // Boss
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
        style.body, style.head, world.attackers.health[i]);

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
    for (const s of world.structures) {
      if (s.destroyed && s.kind === 'trap') continue; // traps vanish once triggered
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

    if (s.kind === 'wall') {
      ctx.fillStyle = '#413c34';
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      ctx.strokeRect(sx - size / 2, sy - size / 2, size, size);
      return;
    }
    if (s.kind === 'fence') {
      ctx.strokeStyle = s.destroyed ? 'rgba(80,60,40,0.4)' : '#a8825a';
      ctx.lineWidth = Math.max(2, size * 0.12);
      ctx.beginPath();
      ctx.moveTo(sx - size / 2, sy);
      ctx.lineTo(sx + size / 2, sy);
      ctx.stroke();
      return;
    }
    if (s.kind === 'trap') {
      ctx.fillStyle = 'rgba(140,20,20,0.55)';
      ctx.beginPath();
      ctx.arc(sx, sy, size * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      return;
    }
    if (s.kind === 'bed') {
      ctx.fillStyle = '#5a6fb0';
      ctx.fillRect(sx - size * 0.4, sy - size * 0.3, size * 0.8, size * 0.6);
      ctx.strokeRect(sx - size * 0.4, sy - size * 0.3, size * 0.8, size * 0.6);
      ctx.fillStyle = '#8898cc';
      ctx.fillRect(sx - size * 0.4, sy - size * 0.3, size * 0.8, size * 0.18);
      return;
    }
    if (s.kind === 'table') {
      ctx.fillStyle = '#a87d4a';
      ctx.fillRect(sx - size * 0.4, sy - size * 0.28, size * 0.8, size * 0.56);
      ctx.strokeRect(sx - size * 0.4, sy - size * 0.28, size * 0.8, size * 0.56);
      return;
    }
    if (s.kind === 'door') {
      ctx.fillStyle = '#7a5a30';
      ctx.fillRect(sx - size * 0.35, sy - size * 0.42, size * 0.7, size * 0.84);
      ctx.strokeRect(sx - size * 0.35, sy - size * 0.42, size * 0.7, size * 0.84);
      return;
    }
    if (s.kind === 'garage_recycling' || s.kind === 'garage_garbage') {
      ctx.fillStyle = s.kind === 'garage_recycling' ? '#3a5a3f' : '#5a5030';
      ctx.fillRect(sx - size * 0.45, sy - size * 0.4, size * 0.9, size * 0.8);
      ctx.strokeRect(sx - size * 0.45, sy - size * 0.4, size * 0.9, size * 0.8);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(sx - size * 0.3, sy - size * 0.1, size * 0.6, size * 0.42); // garage door opening
      return;
    }
    if (s.kind === 'watchtower') {
      ctx.fillStyle = '#5a4a3a';
      ctx.fillRect(sx - size * 0.15, sy - size * 0.1, size * 0.3, size * 0.55); // support post
      ctx.fillStyle = '#8c949e';
      ctx.fillRect(sx - size * 0.4, sy - size * 0.5, size * 0.8, size * 0.35); // watch platform
      ctx.strokeRect(sx - size * 0.4, sy - size * 0.5, size * 0.8, size * 0.35);
      return;
    }
    if (s.kind === 'camera') {
      // Cheap CCTV camera: a mounting post + a small angled lens housing with a "lit lens" dot,
      // deliberately smaller/plainer than the watchtower platform (cheaper, shorter-range).
      ctx.fillStyle = '#4a4a4a';
      ctx.fillRect(sx - size * 0.06, sy - size * 0.05, size * 0.12, size * 0.4); // mounting post
      ctx.save();
      ctx.translate(sx, sy - size * 0.32);
      ctx.rotate(-0.4);
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(-size * 0.28, -size * 0.14, size * 0.5, size * 0.24);
      ctx.strokeRect(-size * 0.28, -size * 0.14, size * 0.5, size * 0.24);
      ctx.fillStyle = s.destroyed ? '#5a1a1a' : '#59a6d9';
      ctx.beginPath();
      ctx.arc(size * 0.22, -size * 0.02, size * 0.07, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (s.kind === 'monitor_station') {
      // A desk with a bank of CCTV screens -- staffed/unstaffed reads via screen brightness so
      // the "manned monitor bonus" is visible on the map, not just in the milestone log.
      ctx.fillStyle = '#5a4630';
      ctx.fillRect(sx - size * 0.42, sy - size * 0.08, size * 0.84, size * 0.4); // desk
      ctx.strokeRect(sx - size * 0.42, sy - size * 0.08, size * 0.84, size * 0.4);
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(sx - size * 0.4, sy - size * 0.48, size * 0.84, size * 0.4); // monitor bank
      ctx.strokeRect(sx - size * 0.4, sy - size * 0.48, size * 0.84, size * 0.4);
      ctx.fillStyle = s.destroyed ? '#3a3a3a' : (s._staffed ? '#7ad9a0' : '#3a5a6a');
      ctx.fillRect(sx - size * 0.34, sy - size * 0.42, size * 0.3, size * 0.28);
      ctx.fillRect(sx + size * 0.04, sy - size * 0.42, size * 0.3, size * 0.28);
      return;
    }
    if (s.kind === 'wire') {
      // Thin conduit run rather than a box (same visual logic as 'fence'), drawn as a cross so
      // a chain of them reads as continuous cable in any direction. Lit amber only when the
      // segment is actually carrying power back to a generator; dead segments stay dull grey.
      const live = !s.destroyed && !s.underConstruction && isTileEnergized(this._structuresForPower || [], s.x, s.y);
      ctx.strokeStyle = live ? '#e0a336' : 'rgba(110,105,95,0.75)';
      ctx.lineWidth = Math.max(1.5, size * 0.1);
      ctx.beginPath();
      ctx.moveTo(sx - size / 2, sy); ctx.lineTo(sx + size / 2, sy);
      ctx.moveTo(sx, sy - size / 2); ctx.lineTo(sx, sy + size / 2);
      ctx.stroke();
      ctx.fillStyle = live ? '#f5cf80' : '#57534b';
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.12, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (s.kind === 'pipe') {
      // Water's answer to 'wire' above -- same thin cross-conduit shape so a chain reads as one
      // continuous run, but blue-tinted instead of wire's amber so the two grids never get
      // visually confused when they're laid side by side. Lit only when actually carrying water
      // back to a pump; dead segments stay a dull blue-grey.
      const flowing = !s.destroyed && !s.underConstruction && isTileWatered(this._structuresForPower || [], s.x, s.y);
      ctx.strokeStyle = flowing ? '#3ea0d9' : 'rgba(90,105,115,0.75)';
      ctx.lineWidth = Math.max(1.5, size * 0.1);
      ctx.beginPath();
      ctx.moveTo(sx - size / 2, sy); ctx.lineTo(sx + size / 2, sy);
      ctx.moveTo(sx, sy - size / 2); ctx.lineTo(sx, sy + size / 2);
      ctx.stroke();
      ctx.fillStyle = flowing ? '#9adcf5' : '#5f6d72';
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.12, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (s.kind === 'pump') {
      // Small well/tower silhouette -- a squat cylindrical drum with a raised spout, distinct
      // from the generator's boxy housing so the two source buildings don't read as siblings.
      const running = !s.destroyed && !s.underConstruction;
      ctx.fillStyle = running ? '#2e5266' : 'rgba(46,60,68,0.6)';
      ctx.beginPath();
      ctx.ellipse(sx, sy, size * 0.36, size * 0.4, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = running ? '#3ea0d9' : '#5a6a70'; // water-level band
      ctx.beginPath();
      ctx.ellipse(sx, sy + size * 0.08, size * 0.28, size * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = running ? '#8c949e' : 'rgba(120,120,120,0.6)';
      ctx.fillRect(sx - size * 0.06, sy - size * 0.5, size * 0.12, size * 0.24); // spout
      return;
    }
    if (s.kind === 'generator') {
      const running = !s.destroyed && !s.underConstruction;
      ctx.fillStyle = running ? '#4a4a52' : 'rgba(60,60,64,0.6)';
      ctx.fillRect(sx - size * 0.42, sy - size * 0.42, size * 0.84, size * 0.84);
      ctx.strokeRect(sx - size * 0.42, sy - size * 0.42, size * 0.84, size * 0.84);
      ctx.fillStyle = running ? '#e0a336' : '#6a6250'; // core light goes dark when it isn't running
      ctx.beginPath();
      ctx.arc(sx, sy, size * 0.18, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (s.kind === 'generator_nuclear') {
      // Deliberately reads as heavier/more industrial than the plain generator (dark cooling-
      // tower silhouette) with a glowing sickly-green core instead of the plain generator's warm
      // amber -- the same green family as the hazard radius so the two visually associate.
      const running = !s.destroyed && !s.underConstruction;
      ctx.fillStyle = running ? '#2e3230' : 'rgba(40,44,42,0.6)';
      ctx.fillRect(sx - size * 0.46, sy - size * 0.46, size * 0.92, size * 0.92);
      ctx.strokeRect(sx - size * 0.46, sy - size * 0.46, size * 0.92, size * 0.92);
      // trefoil-ish radiation glyph: three wedges around a hot core
      ctx.fillStyle = running ? '#161816' : '#3a3e3c';
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = running ? '#c8e63c' : '#5a6650';
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 - Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.arc(sx, sy, size * 0.26, a - 0.35, a + 0.35);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = running ? '#e8ffb0' : '#7a8570';
      ctx.beginPath(); ctx.arc(sx, sy, size * 0.08, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (s.kind === 'generator_coal') {
      // "Worse plain generator": a squatter, dirtier housing than 'generator' -- a small coal pile
      // out front and a dull red (not amber) core light so it visually reads as the cheaper, more
      // polluting choice at a glance.
      const running = !s.destroyed && !s.underConstruction;
      ctx.fillStyle = running ? '#3a332c' : 'rgba(50,46,40,0.6)';
      ctx.fillRect(sx - size * 0.4, sy - size * 0.36, size * 0.8, size * 0.72);
      ctx.strokeRect(sx - size * 0.4, sy - size * 0.36, size * 0.8, size * 0.72);
      ctx.fillStyle = running ? '#1a1a1a' : '#3a3a3a'; // coal pile
      ctx.beginPath();
      ctx.moveTo(sx - size * 0.3, sy + size * 0.36);
      ctx.lineTo(sx - size * 0.05, sy + size * 0.12);
      ctx.lineTo(sx + size * 0.2, sy + size * 0.36);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = running ? '#c0492e' : '#5a4a44'; // dull red core, not the plain generator's amber
      ctx.beginPath();
      ctx.arc(sx + size * 0.18, sy - size * 0.12, size * 0.13, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (s.kind === 'generator_wind') {
      // Turbine silhouette: a slim mast + three blades. _windSited (power.js's isWindSited,
      // recomputed live off the current structures list) tints the blades pale blue when actually
      // acting as a power source and rust-red when crowded/badly sited, so the siting tradeoff is
      // visible on the map, not just in a tooltip.
      const running = !s.destroyed && !s.underConstruction;
      const sited = s._windSited !== false;
      ctx.fillStyle = running ? '#5a5a5a' : 'rgba(70,70,70,0.6)';
      ctx.fillRect(sx - size * 0.05, sy - size * 0.05, size * 0.1, size * 0.55); // mast
      ctx.fillStyle = running ? (sited ? '#bfe6f5' : '#c76b4a') : '#6a6a6a';
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
      return;
    }
    if (s.kind === 'generator_solar') {
      // Flat panel array in a grid pattern, tilted slightly (a parallelogram, not a square) so it
      // reads as a solar panel rather than another generic box. Panel tint follows s._openSky
      // (world.js's tick(), read back by power.js's isSource) the same sited/unsited color logic
      // as the wind turbine above: bright blue when actually acting as a power source, dull grey
      // when stuck inside an enclosed room.
      const running = !s.destroyed && !s.underConstruction;
      const openSky = s._openSky !== false;
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
      ctx.strokeStyle = running ? (openSky ? '#5aa0d9' : '#6a6e72') : 'rgba(90,95,100,0.5)';
      ctx.lineWidth = Math.max(1, size * 0.03);
      for (let k = 1; k < 3; k++) {
        const t = k / 3;
        ctx.beginPath();
        ctx.moveTo(blX + (brX - blX) * t, blY + (brY - blY) * t);
        ctx.lineTo(tlX + (trX - tlX) * t, tlY + (trY - tlY) * t);
        ctx.stroke();
      }
      return;
    }
    if (s.kind === 'waste_storage') {
      // Squat drum cluster, hazard-striped so it reads as "the thing that fixes the green zone"
      // at a glance, distinct from the recycling center's green triangle icon (that's a different
      // resource loop -- pollution, not nuclear waste).
      ctx.fillStyle = s.destroyed ? 'rgba(70,64,30,0.5)' : '#4a4626';
      ctx.fillRect(sx - size * 0.4, sy - size * 0.38, size * 0.8, size * 0.76);
      ctx.strokeRect(sx - size * 0.4, sy - size * 0.38, size * 0.8, size * 0.76);
      ctx.fillStyle = s.destroyed ? 'rgba(160,150,40,0.4)' : '#d9c93a';
      for (const dx of [-0.22, 0.22]) {
        ctx.beginPath();
        ctx.arc(sx + size * dx, sy, size * 0.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      return;
    }
    if (s.kind === 'recycling_center') {
      ctx.fillStyle = '#2e5a4a';
      ctx.fillRect(sx - size * 0.45, sy - size * 0.42, size * 0.9, size * 0.84);
      ctx.strokeRect(sx - size * 0.45, sy - size * 0.42, size * 0.9, size * 0.84);
      ctx.fillStyle = '#7ad9a0';
      ctx.beginPath();
      ctx.moveTo(sx, sy - size * 0.2); ctx.lineTo(sx + size * 0.16, sy); ctx.lineTo(sx, sy + size * 0.2);
      ctx.lineTo(sx - size * 0.16, sy); ctx.closePath();
      ctx.fill();
      return;
    }
    if (s.kind === 'floodlight') {
      if (!s.destroyed) {
        ctx.fillStyle = 'rgba(230,230,150,0.12)';
        ctx.beginPath(); ctx.arc(sx, sy, size * 1.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#8c8060';
      ctx.fillRect(sx - size * 0.08, sy - size * 0.1, size * 0.16, size * 0.5);
      ctx.fillStyle = s.destroyed ? '#5a5540' : '#f2eec0';
      ctx.beginPath(); ctx.arc(sx, sy - size * 0.22, size * 0.22, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      return;
    }
    if (s.kind === 'tesla') {
      ctx.fillStyle = s.destroyed ? 'rgba(60,60,60,0.6)' : '#4a5a8c';
      ctx.beginPath(); ctx.arc(sx, sy + size * 0.15, size * 0.35, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = s.destroyed ? 'rgba(120,140,220,0.3)' : '#a0c0ff';
      ctx.lineWidth = Math.max(1, size * 0.06);
      ctx.beginPath(); ctx.arc(sx, sy - size * 0.15, size * 0.16, 0, Math.PI * 2); ctx.stroke();
      return;
    }
    if (s.kind === 'armory') {
      ctx.fillStyle = s.destroyed ? 'rgba(60,60,60,0.6)' : '#5a4a38';
      ctx.fillRect(sx - size * 0.45, sy - size * 0.42, size * 0.9, size * 0.84);
      ctx.strokeRect(sx - size * 0.45, sy - size * 0.42, size * 0.9, size * 0.84);
      // Crossed-rifles glyph -- reads as "weapons issued here" at a glance, same idea as the
      // recycling center's arrow icon just above.
      ctx.strokeStyle = s.destroyed ? 'rgba(150,150,150,0.4)' : '#d8cba0';
      ctx.lineWidth = Math.max(1, size * 0.07);
      ctx.beginPath();
      ctx.moveTo(sx - size * 0.2, sy - size * 0.18); ctx.lineTo(sx + size * 0.2, sy + size * 0.18);
      ctx.moveTo(sx - size * 0.2, sy + size * 0.18); ctx.lineTo(sx + size * 0.2, sy - size * 0.18);
      ctx.stroke();
      return;
    }
    // turret (default)
    ctx.fillStyle = s.destroyed ? 'rgba(60,60,60,0.6)' : '#8c949e';
    ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    ctx.strokeRect(sx - size / 2, sy - size / 2, size, size);
    if (!s.destroyed) {
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(sx - size * 0.08, sy - size * 0.6, size * 0.16, size * 0.4);
    }
  }

  _drawResourceNodes(world) {
    const ctx = this.ctx;
    for (const n of world.resourceNodes || []) {
      if (n.depleted) continue;
      const [sx, sy] = this.worldToScreen(n.x, n.y);
      const s = CELL * this.zoom * (0.35 + 0.35 * (n.amount / n.maxAmount));
      ctx.lineWidth = Math.max(1, s * 0.06);
      ctx.strokeStyle = OUTLINE;
      ctx.fillStyle = '#8a8060';
      ctx.beginPath();
      ctx.moveTo(sx - s * 0.5, sy + s * 0.3);
      ctx.lineTo(sx - s * 0.15, sy - s * 0.35);
      ctx.lineTo(sx + s * 0.2, sy - s * 0.1);
      ctx.lineTo(sx + s * 0.5, sy + s * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#b5aa80';
      ctx.fillRect(sx - s * 0.1, sy - s * 0.15, s * 0.18, s * 0.18);
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
      ctx.fillStyle = v.kind === 'recycling' ? '#3d7a4a' : '#7a6a3d';
      ctx.fillRect(sx - s * 0.5, sy - s * 0.32, s, s * 0.64);
      ctx.strokeRect(sx - s * 0.5, sy - s * 0.32, s, s * 0.64);
      // SEA:R fuel-type tradeoff (vehicles.js FUEL_TYPES): a colored fuel-tank stripe makes the
      // dirty/clean tradeoff visible at a glance without needing to inspect the truck --
      // fossil=sooty brown, gas=blue (the "best all-around" default), ethanol=green (clean but
      // food-cost), electric=cyan (cleanest, power-hungry).
      ctx.fillStyle = FUEL_COLOR[v.fuelType] || FUEL_COLOR.gas;
      ctx.fillRect(sx - s * 0.5, sy - s * 0.32, s, s * 0.12);
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
