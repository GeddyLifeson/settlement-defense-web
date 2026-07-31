// Room detection via flood-fill, condensed from Prison Architect/RimWorld (see
// FEATURE_RESEARCH.md): a "room" is a connected passable area that does NOT touch the map
// edge -- i.e., it's actually enclosed by walls, not just open ground. Recomputed only when
// the wall layout changes (rare), not every tick.
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const MIN_ROOM_SIZE = 2;
const MAX_ROOM_SIZE = 400; // discourage "the whole map" from ever counting as one room

export function detectRooms(grid) {
  const visited = new Uint8Array(grid.width * grid.height);
  const rooms = [];

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const idx = grid.index(x, y);
      if (visited[idx] || grid.wallThingId[idx] !== 0) continue;

      const cells = [];
      const queue = [[x, y]];
      visited[idx] = 1;
      let touchesEdge = (x === 0 || y === 0 || x === grid.width - 1 || y === grid.height - 1);

      while (queue.length) {
        const [cx, cy] = queue.pop();
        cells.push(grid.index(cx, cy));
        for (const [dx, dy] of NEIGHBORS) {
          const nx = cx + dx, ny = cy + dy;
          if (!grid.inBounds(nx, ny)) continue;
          const nidx = grid.index(nx, ny);
          if (visited[nidx] || grid.wallThingId[nidx] !== 0) continue;
          visited[nidx] = 1;
          if (nx === 0 || ny === 0 || nx === grid.width - 1 || ny === grid.height - 1) touchesEdge = true;
          queue.push([nx, ny]);
        }
      }

      if (!touchesEdge && cells.length >= MIN_ROOM_SIZE && cells.length <= MAX_ROOM_SIZE) {
        rooms.push({ cells: new Set(cells), size: cells.length });
      }
    }
  }
  return rooms;
}

export function roomContaining(rooms, grid, x, y) {
  const idx = grid.index(Math.floor(x), Math.floor(y));
  for (const room of rooms) if (room.cells.has(idx)) return room;
  return null;
}
