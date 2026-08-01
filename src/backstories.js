// RimWorld-style backstories: a childhood + adult flavor pair picked once at spawn, same spirit
// as traits.js (flavor + a small numeric nudge, not a deep system) but focused on *skills*
// rather than needs -- a starting skill nudge plus a "favored skill" that biases which skill(s)
// this citizen is more likely to burn with Passion (see below). Complements traits.js, doesn't
// replace it: a citizen has exactly one trait AND exactly one backstory.
// skillConstructionStart/skillCombatStart double as both the starting bonus AND, when negative,
// a starting penalty on the *other* tracked skill -- RimWorld routinely pairs a backstory's skill
// gain with a loss elsewhere (e.g. real RimWorld: Construction +7 / Social -3). Since this project
// only tracks construction/combat, a construction-favoring backstory can carry a small negative
// skillCombatStart (and vice versa) instead of leaving the non-favored skill at a flat 0. Both
// skills feed straight into jobs.js's (1 + skill) rate multiplier, so a negative start reads as a
// genuine below-baseline penalty, not just "no bonus". At least half of the 8 pairs below carry
// this tradeoff; the rest stay bonus-only where the flavor reads as a generalist/steady-hands type
// rather than someone who traded one skill for another.
export const BACKSTORIES = [
  {
    childhood: 'Farm Kid', adult: 'Ration Clerk',
    description: 'Grew up rationing a failing harvest; now keeps the settlement\'s ledgers straight.',
    favoredSkill: 'construction', skillConstructionStart: 0.1, skillCombatStart: -0.05,
  },
  {
    childhood: 'Street Orphan', adult: 'Scrap Runner',
    description: 'Learned to scavenge before they learned to read; still fastest hands on a resource node.',
    favoredSkill: 'construction', skillConstructionStart: 0.15, skillCombatStart: -0.05,
  },
  {
    childhood: 'Military Brat', adult: 'Militia Veteran',
    description: 'Grew up on base housing and old war stories; picked up a rifle before they picked a trade.',
    favoredSkill: 'combat', skillConstructionStart: -0.05, skillCombatStart: 0.15,
  },
  {
    childhood: 'Gang Runner', adult: 'Reformed Enforcer',
    description: 'Ran errands for a bad crowd as a kid; the violence stuck, the crowd didn\'t.',
    favoredSkill: 'combat', skillConstructionStart: -0.03, skillCombatStart: 0.1,
  },
  {
    childhood: 'Bookish Loner', adult: 'Machinist',
    description: 'Took apart every appliance in the house growing up; now takes apart problems instead.',
    favoredSkill: 'construction', skillConstructionStart: 0.1, skillCombatStart: 0,
  },
  {
    childhood: 'Feral Child', adult: 'Perimeter Hunter',
    description: 'Raised half-wild past the fence line; still most comfortable facing outward.',
    favoredSkill: 'combat', skillConstructionStart: 0, skillCombatStart: 0.1,
  },
  {
    childhood: 'Wanderer', adult: 'Settlement Trader',
    description: 'Never stayed anywhere long enough to specialize; a generalist by necessity, not passion.',
    favoredSkill: null, skillConstructionStart: 0.05, skillCombatStart: 0.05,
  },
  {
    childhood: "Preacher's Kid", adult: 'Camp Medic',
    description: 'Grew up patching up a congregation\'s hurts; steadier hands than most under pressure.',
    favoredSkill: null, skillConstructionStart: 0.05, skillCombatStart: 0,
  },
];

export function randomBackstory(rng) {
  return BACKSTORIES[Math.floor(rng() * BACKSTORIES.length)];
}

// Passion (RimWorld): a per-skill bias on top of the backstory's one-time starting nudge above --
// it doesn't change what a citizen *can* do, only (a) how fast that skill grows while doing it
// (see PASSION_GAIN_MULT, applied in jobs.js's BUILD_SKILL_GAIN/HARVEST_SKILL_GAIN and siege.js's
// tickStaffCombat) and (b) a very slight tie-break in jobs.js's idle-priority checks when a
// citizen has a genuine choice between two available jobs.
export const Passion = Object.freeze({ None: 0, Minor: 1, Burning: 2 });

export const PASSION_GAIN_MULT = [1, 1.5, 2.5]; // indexed by Passion tier
export const PASSION_ICON = ['', ' ·', ' 🔥']; // none / minor (dot) / burning (fire), indexed by Passion tier

// Independent per-skill roll, base weights skewed toward None so Burning stays a real standout
// rather than the common case; a backstory's favoredSkill shifts its own skill's weights toward
// Burning without guaranteeing it (still meant to read as "this person's history", not a hard rule).
const BASE_WEIGHTS = [0.6, 0.25, 0.15]; // None, Minor, Burning
const FAVORED_WEIGHTS = [0.35, 0.3, 0.35];

// trait (traits.js's optional forcedPassion/conflictingPassion, RimWorld's real TorturedArtist/
// Brawler mechanics -- see traits.js's own top-of-file doc comment): a hard override on ONE
// specific skill, checked before the backstory-biased roll below since a trait guarantee is a
// stronger claim than a backstory's soft bias. forcedPassion always resolves to Burning (no tier
// field on the trait data itself -- see traits.js's doc comment for why); conflictingPassion caps
// this skill's roll at Minor, so a would-be Burning result is simply demoted rather than re-rolled
// (keeps the None/Minor split proportions from the normal roll intact instead of skewing them).
function rollPassion(rng, favored, skillName, trait) {
  if (trait?.forcedPassion?.skill === skillName) return Passion.Burning;
  const weights = favored ? FAVORED_WEIGHTS : BASE_WEIGHTS;
  const r = rng();
  if (r < weights[0]) return Passion.None;
  if (trait?.conflictingPassion === skillName) return Passion.Minor; // Burning disallowed for this skill
  if (r < weights[0] + weights[1]) return Passion.Minor;
  return Passion.Burning;
}

// trait: optional 3rd arg (citizens.js passes the citizen's own randomTrait() result, see that
// file's spawn()) -- omitted, every call site behaves byte-for-byte as before this feature existed
// (rollPassion's trait?.foo reads all come back undefined, same null-safe convention as every other
// optional field in this codebase).
export function randomPassions(rng, backstory, trait) {
  return {
    combat: rollPassion(rng, backstory?.favoredSkill === 'combat', 'combat', trait),
    construction: rollPassion(rng, backstory?.favoredSkill === 'construction', 'construction', trait),
  };
}
