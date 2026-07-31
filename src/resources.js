// Scrap deposits scattered across the map -- the "harvest materials" loop that was missing
// (scrap only came from combat kills before). Citizens with no urgent need or job walk to the
// nearest node and harvest it over time, matching RimWorld's "colonists gather raw resources"
// loop rather than Prison Architect's pure-cash-purchase model (which still exists too: scrap
// from kills/recycling is the "it gets bought for you" side of the same resource).
export class ResourceNode {
  constructor(x, y, amount) {
    this.x = x; this.y = y;
    this.amount = amount;
    this.maxAmount = amount;
    this.depleted = false;
  }
}

const NODE_MIN = 40, NODE_MAX = 90;

export function scatterNodes(grid, rng, count, avoidRadius, avoidX, avoidY) {
  const nodes = [];
  let tries = 0;
  while (nodes.length < count && tries < count * 30) {
    tries++;
    const x = Math.floor(rng() * grid.width);
    const y = Math.floor(rng() * grid.height);
    if (Math.hypot(x - avoidX, y - avoidY) < avoidRadius) continue;
    if (grid.isBlocked(x, y)) continue;
    nodes.push(new ResourceNode(x + 0.5, y + 0.5, NODE_MIN + rng() * (NODE_MAX - NODE_MIN)));
  }
  return nodes;
}

// Occasionally drops a fresh node somewhere on the map so the economy doesn't dry up over a
// long session -- soak-testing the first version of this game showed scrap flow stalling hard
// once kill-rewards were the only source and the player wasn't actively harvesting.
export function maybeSpawnNode(nodes, grid, rng, currentTick, avoidX, avoidY) {
  if (currentTick % 400 !== 0) return;
  if (nodes.filter(n => !n.depleted).length > 14) return;
  const spawned = scatterNodes(grid, rng, 1, 10, avoidX, avoidY);
  nodes.push(...spawned);
}
