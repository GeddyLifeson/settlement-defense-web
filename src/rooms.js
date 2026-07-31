// Room detection via flood-fill, condensed from Prison Architect/RimWorld (see
// FEATURE_RESEARCH.md): a "room" is a connected passable area that does NOT touch the map
// edge -- i.e., it's actually enclosed by walls, not just open ground. Recomputed only when
// the wall layout changes (rare), not every tick.
// clamp01 is core.js's exported helper -- reused here (rather than a second local copy) so this
// file and core.js don't both declare a same-named top-level binding once build.py flattens
// everything into one classic script (import lines are stripped there, but the identifier still
// has to resolve to something real).
import { clamp01 } from './core.js';
import { ZoneKind } from './zones.js';

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

// Room stats (RimWorld-style beauty/cleanliness/impressiveness, see FEATURE_RESEARCH.md's
// "Room detection + room roles/stats" priority item). Deliberately kept separate from
// detectRooms above: detectRooms only re-runs when the *wall layout* changes (rare), but a
// room's contents (furniture built/destroyed, a fire breaking out, pollution drifting) change
// far more often, so computeRoomStats is meant to be called every tick against whatever `rooms`
// currently holds -- it mutates each room object in place rather than rebuilding the list.
//
// Beauty contribution per Structure kind (see siege.js's Structure class for the full kind
// list). Positive = "nice"/intentional furniture, negative = utilitarian/industrial/hazardous
// equipment that reads as ugly sitting inside a room a citizen actually lives in. Values are
// judgment calls, not ported from any single source game's exact numbers.
const BEAUTY_BY_KIND = {
  table: 2.5,      // sit-down furniture -- the clearest "nice" signal
  bed: 1.5,        // functional but still a deliberate furnishing choice
  door: 0.5,       // mild positive -- a room with a proper door reads as "finished"
  wire: -0.5,      // exposed wiring, mildly utilitarian
  turret: -2,      // a gun bolted to the floor of your room is not cozy
  fence: -1,
  trap: -2,
  tesla: -2,       // arcing electrical hazard
  floodlight: -1,  // stark industrial lighting
  watchtower: -1.5,
  camera: -0.5,
  monitor_station: -0.5,
  recycling_center: -2, // waste-processing machinery
  generator: -3,        // loud, utilitarian power equipment
  generator_nuclear: -6, // as above, worse -- also the nuclearWaste hazard below
  generator_coal: -4,    // dirtier than the plain generator, reads as worse to have indoors too
  generator_wind: -1,    // a turbine outdoors is far less obtrusive than boxy generator housing
  generator_solar: -1,   // same -- a panel array reads as mild infrastructure, not an eyesore
  waste_storage: -4,     // hazardous-waste containment, definitionally ugly
};

const CLEANLINESS_POLLUTION_DIVISOR = 20; // world.pollution this high alone fully tanks cleanliness
const CLEANLINESS_NUCLEAR_DIVISOR = 10;   // world.nuclearWaste this high alone fully tanks cleanliness
const CLEANLINESS_FIRE_PENALTY = 0.6;     // any structure actively on fire inside the room

// ---------------------------------------------------------------------------------------------
// Room roles (Prison Architect-style): an enclosed room only counts as a specific *role* -- and
// only feeds the jobs.js room-refill bonus for the matching need -- if it's both zoned right
// (zones.js's ZoneKind, same zone-painting system jobs.js already sends citizens to) AND
// furnished right (siege.js's Structure kinds). A room can be enclosed with no matching zone at
// all -- that's just generic "Unroofed Area"-style filler, same as PA's own unlabeled rooms.
//
// Requirement design notes (see task doc / FEATURE_RESEARCH.md for the broader room-roles ask):
//  - Bedroom: needs a Bedroom zone AND at least 1 bed. No fixed occupancy count is enforced here
//    -- jobs.js's zones.nearestOfKind(ZoneKind.Bedroom, ...) just walks a citizen to the nearest
//    Bedroom-zoned tile regardless of which/how many beds are in the room, there's no per-bed
//    reservation system to hook a capacity cap into. So "capacity" is reported for the UI
//    (bedCount) but isn't itself a validity gate -- 1 bed is enough to validate, more beds just
//    means more citizens can plausibly rest there at once without the mood/refill bonus lying.
//  - Dining Room: needs a Food zone AND at least 1 table.
//  - Recreation Room: needs a Recreation zone. No furniture requirement -- Recreation zones
//    don't have a canonical "furniture" kind the way beds/tables do (siege.js has no rec-room
//    Structure kind), so gating it on zone presence alone matches how jobs.js already treats it.
export const RoomRole = Object.freeze({
  None: 'none',
  Bedroom: 'bedroom',
  DiningRoom: 'dining',
  RecreationRoom: 'recreation',
});

export const ROOM_ROLE_LABEL = {
  [RoomRole.None]: 'Unroofed Area',
  [RoomRole.Bedroom]: 'Bedroom',
  [RoomRole.DiningRoom]: 'Dining Room',
  [RoomRole.RecreationRoom]: 'Recreation Room',
};

const BED_MIN = 1;
const TABLE_MIN = 1;

// Which zone kind implies which candidate role, checked in this priority order when a room
// happens to have more than one zone kind painted inside it (rare, but painting tools don't
// stop a player from mixing zones in one enclosed space) -- Bedroom first since an unmade bed
// is the highest-stakes miss (a citizen sleeping in the open loses the mood/refill bonus every
// night), then Food, then Recreation.
const ZONE_TO_ROLE = [
  [ZoneKind.Bedroom, RoomRole.Bedroom],
  [ZoneKind.Food, RoomRole.DiningRoom],
  [ZoneKind.Recreation, RoomRole.RecreationRoom],
];

// Which need (jobs.js's JobState-adjacent "what is this citizen here to refill") a validated
// role serves. Exported so jobs.js can gate ROOM_REFILL_BONUS by matching the citizen's current
// activity to the room they're standing in, rather than "any enclosed room" as before.
export const ROLE_FOR_NEED = Object.freeze({
  hunger: RoomRole.DiningRoom,
  rest: RoomRole.Bedroom,
  social: RoomRole.RecreationRoom,
});

// Counts which ZoneKind cells appear inside a room. Small map, but a room can be large -- this
// is O(room.size), fine at the "only recompute when structures/zones change" cadence below.
function zoneCellCounts(room, grid, zones) {
  const counts = { [ZoneKind.Bedroom]: 0, [ZoneKind.Food]: 0, [ZoneKind.Recreation]: 0 };
  for (const idx of room.cells) {
    const kind = zones.kind[idx];
    if (kind === ZoneKind.Bedroom || kind === ZoneKind.Food || kind === ZoneKind.Recreation) counts[kind]++;
  }
  return counts;
}

// Classifies a single room's role given its zone coverage + furniture counts (bedCount/
// tableCount, tallied by computeRoomStats below while it's already walking structures for
// beauty). Returns { role, roleValid, missingRequirements }.
function classifyRoomRole(room, grid, zones, bedCount, tableCount) {
  const zoneCounts = zoneCellCounts(room, grid, zones);
  for (const [zoneKind, role] of ZONE_TO_ROLE) {
    if (zoneCounts[zoneKind] === 0) continue;
    if (role === RoomRole.Bedroom) {
      const valid = bedCount >= BED_MIN;
      return { role, roleValid: valid, missingRequirements: valid ? [] : ['a bed'], bedCount };
    }
    if (role === RoomRole.DiningRoom) {
      const valid = tableCount >= TABLE_MIN;
      return { role, roleValid: valid, missingRequirements: valid ? [] : ['a table'], tableCount };
    }
    if (role === RoomRole.RecreationRoom) {
      return { role, roleValid: true, missingRequirements: [] };
    }
  }
  return { role: RoomRole.None, roleValid: false, missingRequirements: [] };
}

// Call once per tick (world.js) with the *current* rooms/grid/structures/world state. Mutates
// each room with .beauty (raw sum, informational), .cleanliness, .impressiveness, and the
// combined .quality score (0..1) that citizens.js's tickNeedsAndMood reads to nudge mood. Also
// mutates .role/.roleValid/.missingRequirements (see classifyRoomRole above) -- zones is
// world.zones (zones.js's ZoneGrid), same grid dimensions/indexing as `grid` itself.
export function computeRoomStats(rooms, grid, structures, world, zones) {
  for (const room of rooms) {
    let beauty = 0;
    let niceCount = 0;
    let onFireInside = false;
    let bedCount = 0;
    let tableCount = 0;

    for (const s of structures) {
      if (s.destroyed || s.underConstruction) continue;
      const sx = Math.floor(s.x), sy = Math.floor(s.y);
      if (!grid.inBounds(sx, sy)) continue;
      if (!room.cells.has(grid.index(sx, sy))) continue;

      const contribution = BEAUTY_BY_KIND[s.kind] ?? 0;
      beauty += contribution;
      if (contribution > 0) niceCount++;
      if (s.onFire) onFireInside = true;
      if (s.kind === 'bed') bedCount++;
      if (s.kind === 'table') tableCount++;
    }

    const pollution = world?.pollution ?? 0;
    const nuclearWaste = world?.nuclearWaste ?? 0;
    let cleanliness = 1 - pollution / CLEANLINESS_POLLUTION_DIVISOR - nuclearWaste / CLEANLINESS_NUCLEAR_DIVISOR;
    if (onFireInside) cleanliness -= CLEANLINESS_FIRE_PENALTY;
    cleanliness = clamp01(cleanliness);

    // Impressiveness: RimWorld's third room stat, driven by sheer scale + amount of positive
    // ("nice") furniture rather than the beauty/ugly balance -- a big hall full of tables reads
    // as impressive even before accounting for any ugly equipment dragging beauty down.
    const impressiveness = clamp01(room.size / MAX_ROOM_SIZE * 0.4 + niceCount * 0.1);

    room.beauty = beauty;
    room.cleanliness = cleanliness;
    room.impressiveness = impressiveness;
    room.quality = clamp01(0.5 + beauty * 0.05 + (impressiveness - 0.5) * 0.2) * cleanliness;

    if (zones) {
      const classified = classifyRoomRole(room, grid, zones, bedCount, tableCount);
      room.role = classified.role;
      room.roleValid = classified.roleValid;
      room.missingRequirements = classified.missingRequirements;
      room.bedCount = bedCount;
      room.tableCount = tableCount;
    } else {
      room.role = RoomRole.None;
      room.roleValid = false;
      room.missingRequirements = [];
    }
  }
}
