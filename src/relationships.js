// Condensed from SD.Sim's relationship web: nearby citizens slowly build friendship, crossing
// a threshold logs a social event for the HUD feed.
const PROXIMITY = 1.6;
const GROW_RATE = 0.004;
const FRIEND_THRESHOLD = 0.6;

export class RelationshipWeb {
  constructor() {
    this.friendship = new Map(); // "idA:idB" (idA<idB) -> value
    this.events = []; // rolling log of {tick, text}
  }

  _key(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

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
          if (this.events.length > 20) this.events.shift();
        }
      }
    }
  }
}
