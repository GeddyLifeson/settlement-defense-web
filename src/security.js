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
    if (store.isDownedAt(i)) continue; // downed staff can't hold their post
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

const DOG_RANGE = 2.5; const DOG_DAMAGE = 0.08; const DOG_COOLDOWN = 3; const DOG_SPEED = 0.07;

// K9 units: each dog follows its handler loosely and bites the nearest attacker in range,
// fast and cheap per-hit compared to a guard's sidearm -- matches the GDD's non-carceral
// civil-protection-force framing ("guards/snipers/K9/CCTV", never inmates).
export function tickDogs(dogs, citizens, roster, attackers, onScrap) {
  for (const dog of dogs) {
    const ownerIdx = findCitizenIndexById(citizens, dog.ownerId);
    if (ownerIdx < 0 || !citizens.isAliveAt(ownerIdx)) continue;

    const dx = citizens.x[ownerIdx] - dog.x;
    const dy = citizens.y[ownerIdx] - dog.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1.2) {
      dog.x += (dx / dist) * DOG_SPEED;
      dog.y += (dy / dist) * DOG_SPEED;
    }

    if (dog.cooldown > 0) { dog.cooldown--; continue; }
    let bestI = -1, bestDist = DOG_RANGE;
    for (let i = 0; i < attackers.count; i++) {
      if (!attackers.isAliveAt(i)) continue;
      const d = Math.hypot(attackers.x[i] - dog.x, attackers.y[i] - dog.y);
      if (d < bestDist) { bestDist = d; bestI = i; }
    }
    if (bestI >= 0) {
      attackers.health[bestI] -= DOG_DAMAGE;
      dog.cooldown = DOG_COOLDOWN;
      if (attackers.health[bestI] <= 0) { attackers.alive[bestI] = 0; onScrap?.(4); }
    }
  }
}

function findCitizenIndexById(citizens, id) {
  for (let i = 0; i < citizens.count; i++) if (citizens.id[i] === id) return i;
  return -1;
}
