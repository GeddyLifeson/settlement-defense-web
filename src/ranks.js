// Citizen Rank / Prestige ladder -- RimWorld Royalty DLC, condensed and reskinned non-carceral
// (no "title"/nobility framing, just a settlement seniority track). See task brief / research:
// Royalty's real permit-favor economy has 7 seniority steps (0/100/200/300/400/500/600 favor) and
// a real per-tier favorCost curve (1/6/6/8/10/14/20) that starts cheap, flattens, then escalates.
// Both are scaled proportionally onto this project's own numeric ranges rather than copied
// literally (this codebase's "favor" analog is accumulated skillConstruction+skillCombat, both
// 0..~3+ floats, see citizens.js; its "money" is the scrap economy, see economy.js -- neither is
// on Royalty's 0-600/0-20 scale).
//
// Rank source stat: skillConstruction[i] + skillCombat[i] (RimWorld Royalty's real favor accrues
// from any work performed, not one specific skill -- combining both of this project's skill floats
// is the direct analog rather than picking just one). SKILL_LEVELS in main.js already buckets a
// single skill's Expert cutoff at 2.5 -- so a *combined* max of ~3.0 (this ladder's top tier) is a
// realistic, not aspirational, ceiling for a citizen who's actually worked both tracks.
//
// Scale factor for the 0/100/200/300/400/500/600 seniority steps: divided by 200 (Royalty's real
// range top / this project's realistic combined-skill ceiling) -> 0/0.5/1.0/1.5/2.0/2.5/3.0.
import { roomContaining } from './rooms.js';

export const RANKS = [
  // tier 0: the baseline every citizen starts at, free, no bonus -- matches Royalty's own
  // "no title yet" starting state.
  { tier: 0, name: 'Settler', skillThreshold: 0, scrapCost: 0, workSpeedMult: 1.0, healthMult: 1.0, minImpressiveness: 0 },
  { tier: 1, name: 'Journeyman', skillThreshold: 0.5, scrapCost: 6, workSpeedMult: 1.03, healthMult: 1.0, minImpressiveness: 0 },
  { tier: 2, name: 'Veteran', skillThreshold: 1.0, scrapCost: 6, workSpeedMult: 1.06, healthMult: 1.02, minImpressiveness: 0 },
  // Real Royalty room-impressiveness gates for its own title ranks: 60 / 90 / 120 / 160, on a
  // scale that tops out far above 240 in principle but whose named-tier ceiling is 240 (see
  // rooms.js's IMPRESSIVENESS_SCALE = 1/240, already used for that file's own label thresholds --
  // reused here instead of inventing a second scale factor). Scaled: 60/240=0.25, 90/240=0.375,
  // 120/240=0.5, 160/240=0.667. Applied starting at tier 3 -- the first two promotions stay
  // unconstrained the same way Royalty's own lowest title (Yeoman) needs no throne room at all.
  { tier: 3, name: 'Elder', skillThreshold: 1.5, scrapCost: 8, workSpeedMult: 1.09, healthMult: 1.04, minImpressiveness: 60 / 240 },
  { tier: 4, name: 'Chief', skillThreshold: 2.0, scrapCost: 10, workSpeedMult: 1.12, healthMult: 1.06, minImpressiveness: 90 / 240 },
  { tier: 5, name: 'Marshal', skillThreshold: 2.5, scrapCost: 14, workSpeedMult: 1.15, healthMult: 1.08, minImpressiveness: 120 / 240 },
  { tier: 6, name: 'Founder', skillThreshold: 3.0, scrapCost: 20, workSpeedMult: 1.18, healthMult: 1.10, minImpressiveness: 160 / 240 },
];

export const MAX_RANK_TIER = RANKS.length - 1;

export function rankOf(store, i) {
  return RANKS[store.citizenRank[i]] ?? RANKS[0];
}

export function rankLabel(store, i) {
  return rankOf(store, i).name;
}

export function combinedSkillFor(store, i) {
  return store.skillConstruction[i] + store.skillCombat[i];
}

// Per-citizen work-speed multiplier from rank alone -- multiplied alongside trait.workSpeedMult
// at every jobs.js rate-calc call site (Building/Harvesting/Cleaning/Processing), same
// null-safe-default-1 convention as every other multiplier in this codebase.
export function rankWorkSpeedMultFor(store, i) {
  return rankOf(store, i).workSpeedMult ?? 1;
}

// Per-citizen health multiplier from rank alone -- multiplied alongside trait.healthMult at every
// siege.js damage-reduction call site (`damage / healthMult`), same convention as
// rankWorkSpeedMultFor above.
export function rankHealthMultFor(store, i) {
  return rankOf(store, i).healthMult ?? 1;
}

// Checks whether citizen i can rank up right now, without spending anything -- used both by the
// actual rank-up action below and by the inspector UI to show why a rank-up button is disabled.
// Returns { ok: true, rank } or { ok: false, reason }.
export function canRankUp(store, i, world) {
  if (!store.isAliveAt(i)) return { ok: false, reason: 'not alive' };
  const currentTier = store.citizenRank[i];
  if (currentTier >= MAX_RANK_TIER) return { ok: false, reason: 'already at maximum rank' };
  const next = RANKS[currentTier + 1];
  const combined = combinedSkillFor(store, i);
  if (combined < next.skillThreshold) {
    return { ok: false, reason: `needs ${next.skillThreshold.toFixed(1)} combined skill (has ${combined.toFixed(2)})` };
  }
  if ((world?.scrap ?? 0) < next.scrapCost) {
    return { ok: false, reason: `needs ${next.scrapCost} scrap (have ${Math.floor(world?.scrap ?? 0)})` };
  }
  if (next.minImpressiveness > 0) {
    const room = (world?.rooms && world?.grid) ? roomContaining(world.rooms, world.grid, store.x[i], store.y[i]) : null;
    const impressiveness = room ? (room.impressiveness ?? 0) : 0;
    if (impressiveness < next.minImpressiveness) {
      return {
        ok: false,
        reason: `needs a room at least ${Math.round(next.minImpressiveness * 100)}% impressive `
          + `(currently ${room ? Math.round(impressiveness * 100) : 0}%) -- veteran's quarters requirement`,
      };
    }
  }
  return { ok: true, rank: next };
}

// Actually spends the scrap and advances citizen i's rank, if canRankUp allows it. Mirrors
// economy.js's spend() bookkeeping (world.finance.buildSpend) rather than routing through
// world.addScrap's income-kind buckets, since a rank-up is an expense like a build purchase, not
// an income event.
export function tryRankUp(store, i, world) {
  const check = canRankUp(store, i, world);
  if (!check.ok) return check;
  world.scrap -= check.rank.scrapCost;
  if (world.finance) world.finance.buildSpend += check.rank.scrapCost;
  store.citizenRank[i] = check.rank.tier;
  return { ok: true, rank: check.rank };
}
