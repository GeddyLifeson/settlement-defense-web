// Procedural renderer -- draws every sprite with Canvas 2D shape primitives instead of AI-
// generated images. Visual language borrows from RimWorld/Prison Architect: flat top-down
// grid, a visible floor grid, outlined silhouettes so units read clearly against the ground,
// and zone/room tints rather than photographic texture.
import { StaffRoleKind, TerrainKind } from './core.js';
import { ZONE_COLOR, ZoneKind } from './zones.js';
import { JobState } from './jobs.js';

const CELL = 24; // px per grid cell at zoom 1
const OUTLINE = 'rgba(20,16,12,0.75)';

const ROLE_COLOR = {
  [StaffRoleKind.Guard]: '#f2c026',
  [StaffRoleKind.Sniper]: '#bf59d9',
  [StaffRoleKind.K9Handler]: '#f2c026',
  [StaffRoleKind.None]: '#d3cdbf',
};

const ZONE_BORDER = {
  [ZoneKind.Bedroom]: '#5a6fb0',
  [ZoneKind.Food]: '#c98a2e',
  [ZoneKind.Recreation]: '#4a9e5f',
};

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

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camX = 0; this.camY = 0; this.zoom = 1;
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

  draw(world, input) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._drawGround(world);
    this._drawZones(world);
    this._drawResourceNodes(world);
    this._drawStructures(world);
    this._drawCitizens(world);
    this._drawDogs(world);
    this._drawAttackers(world);
    this._drawVehicles(world);
    if (input) {
      this._drawCursor(world, input);
      this._drawSelection(world, input);
    }
  }

  _drawSelection(world, input) {
    const sel = input.selectedCitizen;
    if (sel == null || sel < 0 || sel >= world.citizens.count || !world.citizens.isAliveAt(sel)) return;
    const ctx = this.ctx;
    const [sx, sy] = this.worldToScreen(world.citizens.x[sel], world.citizens.y[sel]);
    const r = CELL * this.zoom * 0.5;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
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
      const role = world.roster.isStaff(id) ? world.roster.kindOf(id) : StaffRoleKind.None;
      const color = ROLE_COLOR[role] || ROLE_COLOR[StaffRoleKind.None];
      this._drawHumanoid(world.citizens.x[i], world.citizens.y[i], 0.7, color, '#e8c9a0', world.citizens.health[i]);
    }
  }

  _drawDogs(world) {
    const ctx = this.ctx;
    for (const dog of world.dogs || []) {
      const [sx, sy] = this.worldToScreen(dog.x, dog.y);
      const s = CELL * this.zoom * 0.4;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.22, s * 0.34, s * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.strokeStyle = OUTLINE;
      ctx.fillStyle = '#7a5230';
      ctx.beginPath();
      ctx.ellipse(sx, sy, s * 0.32, s * 0.2, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx + s * 0.28, sy - s * 0.05, s * 0.14, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  }

  _drawAttackers(world) {
    for (let i = 0; i < world.attackers.count; i++) {
      if (!world.attackers.isAliveAt(i)) continue;
      this._drawHumanoid(world.attackers.x[i], world.attackers.y[i], 0.6, '#8a1f1f', '#c76b4a', world.attackers.health[i]);
    }
  }

  _drawStructures(world) {
    const ctx = this.ctx;
    for (const s of world.structures) {
      if (s.destroyed && s.kind === 'trap') continue; // traps vanish once triggered
      const [sx, sy] = this.worldToScreen(s.x, s.y);
      const size = CELL * this.zoom * 0.85;

      if (s.kind !== 'fence') {
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
    if (s.kind === 'generator') {
      ctx.fillStyle = '#4a4a52';
      ctx.fillRect(sx - size * 0.42, sy - size * 0.42, size * 0.84, size * 0.84);
      ctx.strokeRect(sx - size * 0.42, sy - size * 0.42, size * 0.84, size * 0.84);
      ctx.fillStyle = '#e0a336';
      ctx.beginPath();
      ctx.arc(sx, sy, size * 0.18, 0, Math.PI * 2);
      ctx.fill();
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
}
