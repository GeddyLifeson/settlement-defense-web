// Ported/condensed from SD.Security (StaffRoster, guard/sniper/K9 AI + alert-level FSM).
import { StaffRoleKind } from './core.js';

export const AlertLevel = Object.freeze({
  Calm: 0,
  Alert: 1,
  Combat: 2,
});

export class StaffRoster {
  constructor() {
    this._roleById = new Map(); // citizenId -> StaffRoleKind
    this._postById = new Map(); // citizenId -> {x, y}
  }

  assign(citizenId, kind, post) {
    this._roleById.set(citizenId, kind);
    if (post) this._postById.set(citizenId, post);
  }

  isStaff(citizenId) {
    return this._roleById.has(citizenId);
  }

  kindOf(citizenId) {
    return this._roleById.get(citizenId) || StaffRoleKind.None;
  }

  postOf(citizenId) {
    return this._postById.get(citizenId);
  }
}

// Guards/snipers walk to their assigned post and stay there (matches the Unity build's
// "hold position" staff behavior); everyone else uses the general wander tick.
export function tickStaffDuty(store, roster, idOf, speed = 0.05) {
  for (let i = 0; i < store.count; i++) {
    if (!store.isAliveAt(i)) continue;
    const id = idOf(i);
    if (!roster.isStaff(id)) continue;
    const post = roster.postOf(id);
    if (!post) continue;

    const dx = post.x - store.x[i];
    const dy = post.y - store.y[i];
    const dist = Math.hypot(dx, dy);
    if (dist > 0.1) {
      store.x[i] += (dx / dist) * speed;
      store.y[i] += (dy / dist) * speed;
    }
    store.targetX[i] = store.x[i];
    store.targetY[i] = store.y[i];
  }
}

// Guard/sniper engagement range in grid cells, and simple alert-level derivation from
// visible attacker count (Calm -> Alert -> Combat), matching the FSM's broad shape.
export function deriveAlertLevel(attackerAliveCount) {
  if (attackerAliveCount === 0) return AlertLevel.Calm;
  return AlertLevel.Combat;
}
