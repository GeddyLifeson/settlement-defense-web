// Condensed from SD.Sim's relationship web: nearby citizens slowly build friendship, crossing
// a threshold logs a social event for the HUD feed.
const PROXIMITY = 1.6;
const GROW_RATE = 0.004;
const FRIEND_THRESHOLD = 0.6;

// Combat proximity signal (citizens.js's computeCitizenUnrestScore -- Prison Architect
// dynamicRep.txt's "Fighting Nearby +10" factor): world.js wires logFight() in from siege.js's
// tickAttackerVsCitizens contact callback, one entry per citizen actually hit this tick. Shares
// this same rolling `events` array as the friendship-crossing entries below rather than a second
// array, distinguished by `kind: 'fight'` (friendship entries never carry `kind`) plus an {x, y}
// location so hasFightNearby can do a real proximity+recency check instead of a colony-wide flag.
const FIGHT_NEARBY_RADIUS = 3.5;
const FIGHT_NEARBY_WINDOW_TICKS = 200; // ~20s at 10Hz -- "recent" combat, not any combat ever
const EVENTS_MAX = 40; // combat can log far more often than friendships form, see logFight below

export class RelationshipWeb {
  constructor() {
    this.friendship = new Map(); // "idA:idB" (idA<idB) -> value
    this.events = []; // rolling log of {tick, text} (friendship) or {tick, kind:'fight', x, y} (combat)
  }

  _key(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

  logFight(x, y, currentTick) {
    this.events.push({ tick: currentTick, kind: 'fight', x, y });
    if (this.events.length > EVENTS_MAX) this.events.shift();
  }

  // Used by citizens.js's computeCitizenUnrestScore (Fighting Nearby factor) -- walks from the
  // end since events is append-ordered ascending by tick, same early-exit pattern grading.js's
  // computeCohesion already uses for its own recent-event window.
  hasFightNearby(x, y, currentTick, radius = FIGHT_NEARBY_RADIUS, windowTicks = FIGHT_NEARBY_WINDOW_TICKS) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (currentTick - e.tick > windowTicks) break;
      if (e.kind !== 'fight') continue;
      if (Math.hypot(e.x - x, e.y - y) <= radius) return true;
    }
    return false;
  }

  tick(store, idOf, currentTick) {
    for (let i = 0; i < store.count; i++) {
      if (!store.isAliveAt(i)) continue;
      for (let j = i + 1; j < store.count; j++) {
        if (!store.isAliveAt(j)) continue;
        const d = Math.hypot(store.x[i] - store.x[j], store.y[i] - store.y[j]);
        if (d > PROXIMITY) continue;

        const key = this._key(idOf(i), idOf(j));
        const before = this.friendship.get(key) || 0;
        const after = Math.min(1, before + GROW_RATE);
        this.friendship.set(key, after);

        if (before < FRIEND_THRESHOLD && after >= FRIEND_THRESHOLD) {
          this.events.push({ tick: currentTick, text: `${store.name[i]} and ${store.name[j]} became friends` });
          if (this.events.length > EVENTS_MAX) this.events.shift();
        }
      }
    }
  }
}
