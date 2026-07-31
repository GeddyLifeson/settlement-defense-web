// Ported from SD.Facility/SettlementGrid.cs.
import { gridIndex, TerrainKind } from './core.js';

export class SettlementGrid {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.terrain = new Uint8Array(n); // TerrainKind, defaults to Bare (0)
    this.wallThingId = new Uint32Array(n); // 0 = no wall
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  index(x, y) {
    return gridIndex(this.width, x, y);
  }

  isBlocked(x, y) {
    if (!this.inBounds(x, y)) return true;
    const i = this.index(x, y);
    return this.terrain[i] === TerrainKind.Water || this.wallThingId[i] !== 0;
  }

  setTerrain(x, y, kind) {
    if (!this.inBounds(x, y)) return;
    this.terrain[this.index(x, y)] = kind;
  }

  setWall(x, y, thingId) {
    if (!this.inBounds(x, y)) return;
    this.wallThingId[this.index(x, y)] = thingId;
  }
}
