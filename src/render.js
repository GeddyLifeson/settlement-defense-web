// Procedural renderer -- draws every sprite with Canvas 2D shape primitives instead of AI-
// generated images, per the "generate assets in-house" decision (no external art pipeline).
import { StaffRoleKind, TerrainKind } from './core.js';
import { ZONE_COLOR, ZoneKind } from './zones.js';

const CELL = 24; // px per grid cell at zoom 1

const ROLE_COLOR = {
  [StaffRoleKind.Guard]: '#f2c026',
  [StaffRoleKind.Sniper]: '#bf59d9',
  [StaffRoleKind.K9Handler]: '#f2c026',
  [StaffRoleKind.None]: '#d9d9de',
};

// Deterministic per-cell noise so the ground doesn't need an image asset to avoid looking flat.
function cellNoise(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
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
    this._drawStructures(world);
    this._drawCitizens(world);
    this._drawDogs(world);
    this._drawAttackers(world);
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

  _drawGround(world) {
    const ctx = this.ctx;
    const [x0, y0] = this.worldToScreen(0, 0);
    const size = CELL * this.zoom;
    const startCol = Math.max(0, Math.floor(-x0 / size));
    const startRow = Math.max(0, Math.floor(-y0 / size));
    const endCol = Math.min(world.width, Math.ceil((this.canvas.width - x0) / size));
    const endRow = Math.min(world.height, Math.ceil((this.canvas.height - y0) / size));

    for (let gy = startRow; gy < endRow; gy++) {
      for (let gx = startCol; gx < endCol; gx++) {
        const idx = world.grid.index(gx, gy);
        const kind = world.grid.terrain[idx];
        const hasWall = world.grid.wallThingId[idx] !== 0;
        const n = cellNoise(gx, gy);
        let base = [0.55, 0.42, 0.28]; // dirt brown, matches the GDD's scavenged-settlement palette
        if (kind === TerrainKind.Soil) base = [0.42, 0.32, 0.20];
        else if (kind === TerrainKind.Rock) base = [0.5, 0.5, 0.52];
        else if (kind === TerrainKind.Water) base = [0.18, 0.35, 0.55];
        if (hasWall) base = [0.17, 0.16, 0.19];

        const shade = 0.85 + n * 0.3;
        const r = Math.round(base[0] * 255 * shade);
        const g = Math.round(base[1] * 255 * shade);
        const b = Math.round(base[2] * 255 * shade);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        const px = x0 + gx * size, py = y0 + gy * size;
        ctx.fillRect(px, py, size + 1, size + 1);
      }
    }
  }

  _drawHumanoid(x, y, scale, bodyColor, headColor, healthFrac) {
    const ctx = this.ctx;
    const [sx, sy] = this.worldToScreen(x, y);
    const s = CELL * this.zoom * scale;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(sx, sy + s * 0.42, s * 0.28, s * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = bodyColor;
    ctx.fillRect(sx - s * 0.18, sy - s * 0.1, s * 0.36, s * 0.42);

    ctx.fillStyle = headColor;
    ctx.beginPath();
    ctx.arc(sx, sy - s * 0.28, s * 0.2, 0, Math.PI * 2);
    ctx.fill();

    if (healthFrac !== undefined && healthFrac < 0.98) {
      const barW = s * 0.5, barY = sy - s * 0.55;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(sx - barW / 2, barY, barW, s * 0.08);
      ctx.fillStyle = healthFrac > 0.5 ? '#5fd15f' : healthFrac > 0.25 ? '#e0c040' : '#e05050';
      ctx.fillRect(sx - barW / 2, barY, barW * Math.max(0, healthFrac), s * 0.08);
    }
  }

  _drawCitizens(world) {
    for (let i = 0; i < world.citizens.count; i++) {
      if (!world.citizens.isAliveAt(i)) continue;
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
      ctx.fillStyle = '#7a5230';
      ctx.beginPath();
      ctx.ellipse(sx, sy, s * 0.32, s * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx + s * 0.28, sy - s * 0.05, s * 0.14, 0, Math.PI * 2);
      ctx.fill();
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

      if (s.kind === 'fence') {
        ctx.strokeStyle = s.destroyed ? 'rgba(80,60,40,0.4)' : '#a8825a';
        ctx.lineWidth = Math.max(2, size * 0.12);
        ctx.beginPath();
        ctx.moveTo(sx - size / 2, sy);
        ctx.lineTo(sx + size / 2, sy);
        ctx.stroke();
        continue;
      }

      if (s.kind === 'trap') {
        ctx.fillStyle = 'rgba(140,20,20,0.55)';
        ctx.beginPath();
        ctx.arc(sx, sy, size * 0.3, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      ctx.fillStyle = s.destroyed ? 'rgba(60,60,60,0.6)' : '#8c949e';
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      if (s.kind === 'turret' && !s.destroyed) {
        ctx.fillStyle = '#2b2b2b';
        ctx.fillRect(sx - size * 0.08, sy - size * 0.6, size * 0.16, size * 0.4);
      }
    }
  }
}
