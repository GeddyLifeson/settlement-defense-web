// Zoning layer: player-painted per-cell zone kinds. Citizens use Food/Bedroom zones as job
// destinations (see jobs.js). Condensed from SD.Facility's zoning system.
import { gridIndex } from './core.js';

export const ZoneKind = Object.freeze({
  None: 0,
  Bedroom: 1,
  Food: 2,
  Recreation: 3,
});

export const ZONE_COLOR = {
  [ZoneKind.Bedroom]: 'rgba(90,110,220,0.35)',
  [ZoneKind.Food]: 'rgba(220,160,60,0.35)',
  [ZoneKind.Recreation]: 'rgba(90,200,120,0.35)',
};

export class ZoneGrid {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.kind = new Uint8Array(width * height);
  }

  index(x, y) { return gridIndex(this.width, x, y); }

  set(x, y, kind) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.kind[this.index(x, y)] = kind;
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return ZoneKind.None;
    return this.kind[this.index(x, y)];
  }

  // Nearest cell of the given kind to (fromX, fromY), or null if none painted.
  nearestOfKind(kind, fromX, fromY) {
    let bestDist = Infinity, bestX = -1, bestY = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.kind[this.index(x, y)] !== kind) continue;
        const d = (x - fromX) ** 2 + (y - fromY) ** 2;
        if (d < bestDist) { bestDist = d; bestX = x; bestY = y; }
      }
    }
    return bestX >= 0 ? { x: bestX + 0.5, y: bestY + 0.5 } : null;
  }
}
