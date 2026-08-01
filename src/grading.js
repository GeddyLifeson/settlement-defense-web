// Non-carceral reframe of Prison Architect's 4-axis Grading tab (Punishment/Reform/Security/
// Health), per FEATURE_RESEARCH.md's synthesis note: same aggregate-scoring pattern, axes
// renamed to fit a settlement that isn't a prison -- Safety/Wellbeing/Sustainability/Cohesion.
//
// Purely a read-only reporting layer: computed periodically (see GRADING_INTERVAL_TICKS) and
// stored on world.grading for the UI to read. Every axis is derived from state the sim already
// tracks elsewhere (citizens.js/siege.js/relationships.js/world.js) -- nothing new is simulated
// here. Never feeds back into director.js's colonyStrength()/wave difficulty; if you're tempted
// to read world.grading from director.js, don't -- that would make this a balance lever instead
// of a reporting layer.
import { isPowered } from './siege.js';

export const GRADING_INTERVAL_TICKS = 30; // ~3s at 10Hz -- feels live without recomputing every tick

const DEFENSE_KINDS = new Set(['turret', 'fence', 'trap']);
const RECENT_EVENT_WINDOW_TICKS = 3000; // ~5 min at 10Hz -- "recent" friendship-event frequency for Cohesion

function clampScore(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

// Safety: functional defenses (turret/fence/trap, powered turrets count extra) offset by
// cumulative citizen losses, currently-downed citizens, and how many attackers are on the field
// right now -- the same signals siege.js/world.js already track, just recombined for reporting.
function computeSafety(world) {
  let functionalDefense = 0;
  for (const s of world.structures) {
    if (s.destroyed || s.underConstruction) continue;
    if (!DEFENSE_KINDS.has(s.kind)) continue;
    functionalDefense += isPowered(world.structures, s.x, s.y) ? 1.2 : 1;
  }
  const defenseCoverage = Math.min(1, functionalDefense / 10);

  let aliveCitizens = 0, downedCitizens = 0;
  for (let i = 0; i < world.citizens.count; i++) {
    if (!world.citizens.isAliveAt(i)) continue;
    aliveCitizens++;
    if (world.citizens.isDownedAt(i)) downedCitizens++;
  }
  const totalEver = Math.max(1, world.citizens.count);
  const deathRatio = Math.max(0, (totalEver - aliveCitizens) / totalEver);
  const downedRatio = aliveCitizens > 0 ? downedCitizens / aliveCitizens : 0;

  let aliveAttackers = 0;
  for (let i = 0; i < world.attackers.count; i++) if (world.attackers.isAliveAt(i)) aliveAttackers++;
  const attackerPenalty = Math.min(40, aliveAttackers * 3);

  return clampScore(45 * defenseCoverage + 35 * (1 - deathRatio) + 20 * (1 - downedRatio) - attackerPenalty);
}

// Wellbeing: straight average of hunger/rest/social/mood across the living population
// (citizens.js's CitizenStore fields) -- no derived signal needed, this is the axis the data
// most directly supports.
function computeWellbeing(world) {
  const c = world.citizens;
  let aliveCount = 0, sum = 0;
  for (let i = 0; i < c.count; i++) {
    if (!c.isAliveAt(i)) continue;
    aliveCount++;
    sum += (c.hunger[i] + c.rest[i] + c.social[i] + c.mood[i]) / 4;
  }
  if (aliveCount === 0) return 0;
  return clampScore((sum / aliveCount) * 100);
}

// Sustainability: world.pollution and world.nuclearWaste each mapped through a saturating curve
// (100 at 0, asymptoting toward 0 as the hazard grows without bound -- both accrue unboundedly
// per tick per siege.js/world.js, so a hard-clamped linear score would floor out almost
// immediately), blended with a banked-scrap trend term so a settlement whose economy is
// currently shrinking scores worse than one that's merely sitting still.
function computeSustainability(world) {
  const pollutionScore = 100 / (1 + world.pollution / 50);
  const nuclearScore = 100 / (1 + (world.nuclearWaste || 0) / 20);

  const prevScrap = world._gradingPrevScrap ?? world.scrap;
  const delta = world.scrap - prevScrap;
  world._gradingPrevScrap = world.scrap;
  const trendScore = clampScore(50 + delta);

  return clampScore(0.4 * pollutionScore + 0.3 * nuclearScore + 0.3 * trendScore);
}

// Cohesion: relationships.js's RelationshipWeb tracks a friendship value per proximate pair and
// logs an event when a pair crosses the "friends" threshold -- averaged here, plus how many such
// events landed recently. Blended with average social need (citizens.js) rather than gated
// behind a nonempty friendship map, so a brand-new colony (no friendships formed yet) still
// reports a meaningful score instead of a hard 0.
function computeCohesion(world, avgSocialNeed) {
  const web = world.relationships;
  let friendshipSum = 0, friendshipCount = 0;
  for (const v of web.friendship.values()) { friendshipSum += v; friendshipCount++; }
  const avgFriendship = friendshipCount > 0 ? friendshipSum / friendshipCount : 0;

  // events is append-ordered ascending by tick, so walking from the end and stopping at the
  // first too-old entry is enough -- no need to scan the whole log every time this runs.
  // relationships.js's events array also carries `kind: 'fight'` combat-proximity entries
  // (see that file's logFight/hasFightNearby, used by citizens.js's per-citizen unrest score) --
  // those aren't a friendship milestone, so they're skipped here rather than inflating Cohesion's
  // recent-event count. The age check still applies (and can still break the loop) regardless of
  // kind, since events is ascending by tick and everything before an old entry is also old.
  let recentEvents = 0;
  for (let i = web.events.length - 1; i >= 0; i--) {
    const e = web.events[i];
    if (world.currentTick - e.tick > RECENT_EVENT_WINDOW_TICKS) break;
    if (e.kind === 'fight') continue;
    recentEvents++;
  }
  const eventScore = Math.min(1, recentEvents / 6);

  return clampScore(40 * avgFriendship + 30 * eventScore + 30 * avgSocialNeed);
}

/** Recompute world.grading = {safety, wellbeing, sustainability, cohesion}, each 0-100. Called
 *  from world.js's tick() every GRADING_INTERVAL_TICKS -- cheap (single pass over citizens/
 *  structures/attackers, same cost class as the room-detection wall-signature gate) but still
 *  not worth doing every single tick for a number nothing else reads synchronously. */
export function computeGrading(world) {
  const c = world.citizens;
  let aliveCount = 0, socialSum = 0;
  for (let i = 0; i < c.count; i++) {
    if (!c.isAliveAt(i)) continue;
    aliveCount++;
    socialSum += c.social[i];
  }
  const avgSocialNeed = aliveCount > 0 ? socialSum / aliveCount : 0;

  world.grading = {
    safety: computeSafety(world),
    wellbeing: computeWellbeing(world),
    sustainability: computeSustainability(world),
    cohesion: computeCohesion(world, avgSocialNeed),
  };
}
