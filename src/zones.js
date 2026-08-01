// Zoning layer: player-painted per-cell zone kinds. Citizens use Food/Bedroom zones as job
// destinations (see jobs.js). Condensed from SD.Facility's zoning system.
import { gridIndex } from './core.js';

export const ZoneKind = Object.freeze({
  None: 0,
  Bedroom: 1,
  Food: 2,
  Recreation: 3,
  // Training (programs.js's Skills Workshop -- see rooms.js's RoomRole.Training): a dedicated
  // zone kind rather than reusing Recreation, since the Skills Workshop program is a distinct
  // room-role requirement (see the task doc / rooms.js's classifyRoomRole) and jobs.js needs a
  // zone to path a Foreman-staffed program's attendees toward. Named "Training" rather than
  // "Workshop" to avoid colliding with the unrelated 'workshop' materials-processing Structure
  // kind (economy.js/siege.js/jobs.js's Processing job) -- different system, same English word,
  // kept deliberately distinct here so a player never confuses the two "workshop" features.
  Training: 4,
  // Storage/Medical/Command (rooms.js RoomRole.Storage/Medical/Command): same "zone + minimum
  // furniture" room-role pattern as Bedroom/Food/Recreation/Training above, no new mechanic.
  Storage: 5,
  Medical: 6,
  Command: 7,
  // Gymnasium (PA needs.txt Exercise -- see citizens.js's EXERCISE_DECAY / rooms.js's
  // RoomRole.Gymnasium): same "zone + minimum furniture" room-role pattern as the roles above,
  // furniture requirement is the new Fitness Station buildable (siege.js Structure kind
  // 'fitness_station', the single consolidated stand-in for PA's whole gym-equipment catalog).
  Gymnasium: 8,
});

export const ZONE_COLOR = {
  [ZoneKind.Bedroom]: 'rgba(90,110,220,0.35)',
  [ZoneKind.Food]: 'rgba(220,160,60,0.35)',
  [ZoneKind.Recreation]: 'rgba(90,200,120,0.35)',
  [ZoneKind.Training]: 'rgba(200,120,200,0.35)',
  [ZoneKind.Storage]: 'rgba(150,130,90,0.35)',
  [ZoneKind.Medical]: 'rgba(220,70,70,0.35)',
  [ZoneKind.Command]: 'rgba(90,90,110,0.35)',
  [ZoneKind.Gymnasium]: 'rgba(230,140,40,0.35)',
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

  // Nearest cell of the given kind to (fromX, fromY), or null if none painted. isAllowed is an
  // optional (x, y) -> bool predicate -- jobs.js passes a citizen's Allowed Area check through
  // here so a restricted citizen's autonomous job-seeking only ever considers zone cells inside
  // their own painted area, matching the exact same "nearest that qualifies" behavior every
  // other candidate here already gets. Omitted (every pre-existing call site) means no filtering
  // at all, byte-for-byte the old behavior.
  nearestOfKind(kind, fromX, fromY, isAllowed = null) {
    let bestDist = Infinity, bestX = -1, bestY = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.kind[this.index(x, y)] !== kind) continue;
        if (isAllowed && !isAllowed(x + 0.5, y + 0.5)) continue;
        const d = (x - fromX) ** 2 + (y - fromY) ** 2;
        if (d < bestDist) { bestDist = d; bestX = x; bestY = y; }
      }
    }
    return bestX >= 0 ? { x: bestX + 0.5, y: bestY + 0.5 } : null;
  }
}
