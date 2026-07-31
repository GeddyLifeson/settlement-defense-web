// detectRooms flood-fill correctness on hand-built small grids: an enclosed room must be
// detected, an open area touching the map edge must NOT be.
import { assert, section } from './harness.js';
import { SettlementGrid } from '../src/grid.js';
import { detectRooms, roomContaining } from '../src/rooms.js';

function buildWalledBox(grid, x0, y0, x1, y1, wallId = 1) {
  for (let x = x0; x <= x1; x++) { grid.setWall(x, y0, wallId); grid.setWall(x, y1, wallId); }
  for (let y = y0; y <= y1; y++) { grid.setWall(x0, y, wallId); grid.setWall(x1, y, wallId); }
}

section('detectRooms: a fully enclosed interior is detected as a room', () => {
  // 10x10 grid, walls forming a box from (2,2) to (7,7) -- interior 3..6,3..6 (4x4=16 cells)
  // is enclosed and does not touch the map edge.
  const grid = new SettlementGrid(10, 10);
  buildWalledBox(grid, 2, 2, 7, 7);

  const rooms = detectRooms(grid);
  assert(rooms.length >= 1, 'at least one room is detected for a fully walled-in box');

  const interior = rooms.find(r => r.cells.has(grid.index(4, 4)));
  assert(interior != null, 'the enclosed interior cell (4,4) belongs to a detected room');
  assert(interior && interior.size === 16, `enclosed 4x4 interior room has size 16 (got ${interior ? interior.size : 'n/a'})`);

  const found = roomContaining(rooms, grid, 4.2, 4.7);
  assert(found === interior, 'roomContaining resolves a fractional (x,y) inside the enclosed room to that room');

  const wallCellRoom = roomContaining(rooms, grid, 2, 2);
  assert(wallCellRoom === null, 'roomContaining returns null for a point sitting on a wall cell');
});

section('detectRooms: an open area touching the map edge is NOT a room', () => {
  // Same 10x10 grid, but leave a gap in the box's wall so the "interior" actually connects
  // straight out to the map boundary -- must NOT be counted as an enclosed room.
  const grid = new SettlementGrid(10, 10);
  buildWalledBox(grid, 2, 2, 7, 7);
  grid.setWall(7, 4, 0); // punch a hole in the east wall, connecting interior to open ground outside

  const rooms = detectRooms(grid);
  const interior = rooms.find(r => r.cells.has(grid.index(4, 4)));
  assert(interior == null, 'a "room" with a gap leaking to the map edge is not detected as an enclosed room');
});

section('detectRooms: a completely open grid (no walls at all) has zero rooms', () => {
  const grid = new SettlementGrid(8, 8);
  const rooms = detectRooms(grid);
  assert(rooms.length === 0, 'an entirely open grid with no walls produces zero detected rooms (everything touches the edge)');
});

section('detectRooms: a tiny 1-cell pocket below MIN_ROOM_SIZE is excluded', () => {
  // A 3x3 walled box has only a single enclosed interior cell (1x1=1), below MIN_ROOM_SIZE (2).
  const grid = new SettlementGrid(10, 10);
  buildWalledBox(grid, 2, 2, 4, 4);
  const rooms = detectRooms(grid);
  const interior = rooms.find(r => r.cells.has(grid.index(3, 3)));
  assert(interior == null, 'an enclosed pocket smaller than MIN_ROOM_SIZE is not counted as a room');
});
