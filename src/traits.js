// Condensed personality traits, matching the RimWorld side of the GDD ("needs/mood/traits").
// Each citizen gets exactly one at spawn; traits are flavor + a small numeric nudge, not a
// deep system, since the core loop doesn't depend on them.
// workSpeedMult: RimWorld's Industriousness spectrum (WorkSpeedGlobal) -- multiplies build/harvest
// rate in jobs.js. Real offsets: -0.35 slothful / -0.20 lazy / +0.20 hard worker / +0.35 industrious,
// applied here as multipliers around 1.0 (e.g. +0.35 -> 1.35). Undefined/omitted == 1 (no change),
// same null-safe convention as the other per-trait multipliers below.
//
// breakThresholdOffset: RimWorld's Neurotic spectrum (MentalBreakThreshold) -- added to the base
// BREAK_MOOD_THRESHOLD in citizens.js before the on-break check, so a positive offset means this
// citizen starts breaking down at a *higher* mood (breaks more easily) and a negative offset means
// they tolerate lower mood before breaking. Real range +0.08 to +0.14 (Neurotic); we also allow a
// small negative for the calm counterpart. Undefined/omitted == 0 (no change).
//
// forcedPassion / conflictingPassion: RimWorld's real TorturedArtist.forcedPassions (guarantees a
// skill starts at Burning-tier Passion, no roll at all) and Brawler.conflictingPassions (that one
// skill can never roll Burning -- capped at Minor). Read by backstories.js's randomPassions(rng,
// backstory, trait) -- see that file's own doc comment on rollPassion for exactly how the override
// interacts with a backstory's normal favoredSkill-biased roll. forcedPassion is `{ skill }` with
// no explicit tier field -- it's always Burning (RimWorld's forcedPassions mechanic always forces
// the top tier), which conveniently means traits.js never needs to import backstories.js's Passion
// enum (backstories.js loads AFTER traits.js in build.py's ORDER, so importing back would be the
// same forward-reference hazard citizens.js's _sickOffset doc comment already documents for
// sickness.js -- sidestepped entirely here instead of worked around). conflictingPassion is just a
// skill-name string ('combat' | 'construction'). Both undefined/omitted == no override, the normal
// independent per-skill roll in backstories.js applies unchanged.
//
// disabledWork: RimWorld's real disabledWorkTags pattern (e.g. Pyromaniac -> Firefighting) -- a
// trait can flatly refuse an entire category of work rather than just being slower at it
// (workSpeedMult above). This project has no Firefighting job (fire.js is autonomous/self-limiting,
// see that file's header comment -- no citizen-firefighter mechanic exists to disable), so this is
// applied to a WorkCategory that actually exists here instead. Values are plain strings matching
// jobs.js's WorkCategory key names ('Construction' | 'Processing' | 'Hauling' | 'Harvesting' |
// 'Animal' | 'Cleaning'), NOT WORK_CATEGORY_LABELS' own display text (which has independent
// wording, e.g. 'Animal Handling' with a space) -- deliberately decoupled from label copy so a
// future label wording change can't silently break trait data. jobs.js's tickJobs Idle branch
// checks this before ever attempting a category, both for the Work-Priorities custom order and the
// legacy fixed ladder. Undefined/omitted == no restriction (every category still available), same
// null-safe convention as every other optional field here.
//
// meleeAccuracyOffset / rangedAccuracyOffset / dodgeChanceOffset / painThresholdOffset: RimWorld's
// real Brawler (+4% melee hit / -10% shooting), Nimble (+15% melee dodge), and Wimp (pain-shock
// threshold 0.8 -> 0.3, i.e. a -0.50 offset on that same 0-1 scale) combat stats. DATA ONLY here --
// no citizens.js/jobs.js logic reads these, a separate combat-system pass wires them into siege.js
// (that file already owns every other combat-stat lookup, e.g. resolveCitizenArmorRoll/healthMult),
// reading them defensively (`trait.dodgeChanceOffset ?? 0`) the same null-safe way every other
// per-trait field in this codebase is already read. Undefined/omitted == 0 (no change) for every
// trait that doesn't specify a given one of these four fields.
//
// skillRustMult: RimWorld's real GreatMemory trait (halves the real game's skill-decay-from-disuse
// rate). Read by citizens.js's tickNeedsAndMood (see that function's SKILL_RUST_RATE doc comment)
// as a multiplier on the disuse-decay rate -- 0.5 halves it, matching GreatMemory's real number.
// Undefined/omitted == 1 (no change), same null-safe convention as workSpeedMult etc. above.
// conflictsWith: RimWorld's real conflicting-trait pairs (e.g. Wimp vs Brawler/Masochist, Ascetic
// vs Greedy/Jealous/Gourmand, Bloodlust vs Kind/Nervous) prevent a citizen from rolling two
// thematically opposed traits together (RandomTraitsFor's DisallowedTraits check). This project
// only assigns ONE trait per citizen right now (see randomTrait below), so this field has no live
// effect -- it's seeded now as cheap pure data for a plausible future second-trait-slot, matching
// this file's existing forward-looking fields (forcedPassion/conflictingPassion/disabledWork
// above all predate any code that reads them the same way). Mapped onto this project's reskinned
// trait names by CONCEPT, not literal name, since none of the real trait names exist verbatim here:
//   - tough-vs-fragile: Tough/Brawler (physically hardy, melee-forward) vs Wimp (real RimWorld
//     Wimp-vs-Brawler pair, used verbatim; Tough added by the same toughness concept).
//   - generous-vs-greedy: Hardy (reduced hunger/rest needs -- an ascetic, wants-little citizen)
//     vs Glutton (elevated hunger need -- RimWorld's Gourmand-analog, always wanting more), the
//     closest available stand-in for the real Ascetic-vs-Gourmand pair since no literal Ascetic
//     or Greedy trait exists in this table.
//   - calm-vs-volatile: Steady (negative breakThresholdOffset, harder to push into a break) vs
//     Neurotic (positive breakThresholdOffset, easier to push into a break) -- both traits already
//     exist in this file specifically as opposite ends of the same breakThresholdOffset axis (see
//     each entry's own doc comment above), so this is a direct mechanical opposite, not just a
//     thematic one.
// Values are TRAITS[].name strings (not indices/ids -- this table has no separate id field), read
// bidirectionally via traitsConflict(idA, idB) below. Undefined/omitted == no conflicts, same
// null-safe convention as every other optional field in this file.
export const TRAITS = [
  { name: 'Tough', healthMult: 1.3, hungerMult: 1, restMult: 1, socialGainMult: 1, conflictsWith: ['Wimp'] },
  { name: 'Fast', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, speedMult: 1.3 },
  { name: 'Sociable', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1.5 },
  { name: 'Insomniac', healthMult: 1, hungerMult: 1, restMult: 1.4, socialGainMult: 1 },
  { name: 'Glutton', healthMult: 1, hungerMult: 1.4, restMult: 1, socialGainMult: 1, conflictsWith: ['Hardy'] },
  { name: 'Hardy', healthMult: 1.15, hungerMult: 0.85, restMult: 0.85, socialGainMult: 1, conflictsWith: ['Glutton'] },
  { name: 'Loner', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 0.5 },
  // Steady: already a calmer, more even-keeled flavor (reduced hunger/rest/social decay) -- paired
  // here with a negative breakThresholdOffset (RimWorld-style: harder to push into a mental break).
  { name: 'Steady', healthMult: 1, hungerMult: 0.9, restMult: 0.9, socialGainMult: 0.9, breakThresholdOffset: -0.08, conflictsWith: ['Neurotic'] },
  // Industriousness spectrum (work speed only, no needs/mood nudge -- matches RimWorld's own
  // Industriousness trait, which is purely a WorkSpeedGlobal modifier).
  { name: 'Industrious', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, workSpeedMult: 1.35 },
  { name: 'Hard Worker', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, workSpeedMult: 1.2 },
  { name: 'Lazy', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, workSpeedMult: 0.65 },
  // Neurotic: the real RimWorld tradeoff pairing -- breaks down more easily (raised break
  // threshold) but works faster while stable, so it's a genuine risk/reward pick rather than a
  // strict downgrade.
  { name: 'Neurotic', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, workSpeedMult: 1.15, breakThresholdOffset: 0.12, conflictsWith: ['Steady'] },
  // Brawler (RimWorld): melee-focused fighter -- flat combat-stat split rather than a needs/mood
  // nudge like most traits above (item 4's meleeAccuracyOffset/rangedAccuracyOffset, see this
  // file's top-of-file doc comment; a separate combat-system pass reads these from siege.js, not
  // this file). Real numbers used verbatim: +4% melee hit, -10% shooting.
  { name: 'Brawler', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, meleeAccuracyOffset: 0.04, rangedAccuracyOffset: -0.10, conflictsWith: ['Wimp'] },
  // Nimble (RimWorld): +15% real melee dodge chance, used verbatim. Pure upside, same precedent as
  // Tough above (not every trait needs a paired downside -- RimWorld's own trait list isn't
  // perfectly symmetric either).
  { name: 'Nimble', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, dodgeChanceOffset: 0.15 },
  // Wimp (RimWorld): real pain-shock threshold default 0.8 -> 0.3 for this trait, i.e. -0.50 on
  // that same 0-1 scale -- goes down/incapacitated far more easily under injury. Pure downside,
  // same asymmetric-trait precedent as Insomniac/Glutton above (no compensating upside grafted on).
  { name: 'Wimp', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, painThresholdOffset: -0.50, conflictsWith: ['Tough', 'Brawler'] },
  // Driven: this project's closest available analog to RimWorld's TorturedArtist (forcedPassions)
  // -- no Artistic skill exists here to force, so the guarantee lands on construction (building
  // things is the nearest "making something" skill this codebase tracks) instead. Paired with a
  // genuine tradeoff (conflictingPassion on combat, capped at Minor -- never Burning) rather than
  // shipping as a strict upgrade, matching the file's existing "genuine risk/reward" ethos (see
  // Neurotic's own doc comment above) -- a citizen who's obsessively fixated on their craft reads
  // as plausibly indifferent to ever mastering a fight.
  { name: 'Driven', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, forcedPassion: { skill: 'construction' }, conflictingPassion: 'combat' },
  // Great Memory (RimWorld): halves the new skill-rust disuse-decay rate (citizens.js's
  // SKILL_RUST_RATE) -- see this file's top-of-file doc comment on skillRustMult. Pure upside,
  // same asymmetric-trait precedent as Nimble/Tough above.
  { name: 'Great Memory', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, skillRustMult: 0.5 },
  // Squeamish: this project's closest available analog to RimWorld's disabledWorkTags pattern (see
  // this file's top-of-file doc comment on disabledWork for why it's not literally Pyromaniac ->
  // Firefighting) -- can't stand handling real mess/gore, flatly refuses Cleaning work rather than
  // just being slower at it. A pure downside (no compensating field), same precedent as
  // Insomniac/Glutton/Wimp above.
  { name: 'Squeamish', healthMult: 1, hungerMult: 1, restMult: 1, socialGainMult: 1, disabledWork: ['Cleaning'] },
];

export function randomTrait(rng) {
  return TRAITS[Math.floor(rng() * TRAITS.length)];
}

// traitsConflict: bidirectional lookup over the conflictsWith data above -- RimWorld's real
// DisallowedTraits check is symmetric (Wimp disallows Brawler exactly when Brawler disallows Wimp),
// so this checks both directions even though every conflictsWith pair above is already listed on
// both entries, in case a future addition only lists one side. Pure data lookup, no RNG, no
// mutation, no effect on randomTrait's roll -- not called anywhere yet (no second-trait-slot
// exists), seeded now for when that lands. idA/idB are TRAITS[].name strings.
export function traitsConflict(idA, idB) {
  const a = TRAITS.find((t) => t.name === idA);
  const b = TRAITS.find((t) => t.name === idB);
  if (!a || !b) return false;
  return Boolean(a.conflictsWith?.includes(idB) || b.conflictsWith?.includes(idA));
}

// ---------------------------------------------------------------- age bands (RimWorld Biotech
// LifeStageDef, condensed). Real RimWorld LifeStageDefs are just a bundle of flat multipliers
// keyed by age band (bodySize/health/speed/melee/hunger) -- the exact same shape as the trait
// multipliers above, so this is a second lookup table of the same kind rather than a parallel
// system. `age` (citizens.js) is ticks-since-spawn; maxAge is the upper (exclusive) tick bound
// for a band, Infinity for the last one. Looked up once per citizen per tick and multiplied
// straight into the SAME rate expressions jobs.js already builds from trait.workSpeedMult
// (`* ageBandFor(store.age[i]).workSpeedMult`) and siege.js's trait.healthMult (toughness --
// higher healthMult means LESS damage taken per hit, see siege.js's `DAMAGE / healthMult`).
//
// Real RimWorld pre-teen anchor (MoveSpeed x0.85) adapted directionally for an elder band: reduced
// work-speed (0.85-0.9 range, matching the ask) and a reduced health ceiling/toughness (elders take
// real hits harder, same shape as a Neurotic/Glutton downside trait). Compensating "wisdom"
// tradeoff, a genuine deliberate design call rather than pure decline: a real skill-gain-RATE
// bonus (not a starting-skill bonus -- an elder isn't smarter on day one, they just learn faster
// from the practice they're already getting, mirroring backstories.js's own Passion mechanic
// exactly, see PASSION_GAIN_MULT). Applied as `ageBandFor(store.age[i]).skillGainMult` alongside
// the existing PASSION_GAIN_MULT term at every skill-gain site in jobs.js/siege.js -- multiplicative
// with passion, not a replacement for it, same "stacks, doesn't override" convention as every other
// multiplier table in this file.
export const AGE_BANDS = [
  // Young: default band, every multiplier at baseline -- a citizen who never crosses either
  // threshold behaves byte-for-byte as if this feature didn't exist.
  { name: 'Young', maxAge: 20000, workSpeedMult: 1, healthMult: 1, skillGainMult: 1 },
  // Veteran: real RimWorld pre-teen MoveSpeed anchor (x0.85) landed at the gentler end of the
  // requested 0.85-0.9 workSpeedMult range; skillGainMult mirrors backstories.js's own Minor
  // Passion tier (1.5x) so "experience" reads on the same scale as the existing wisdom-adjacent
  // mechanic rather than inventing a new one.
  { name: 'Veteran', maxAge: 45000, workSpeedMult: 0.9, healthMult: 0.95, skillGainMult: 1.5 },
  // Elder: the top of the requested workSpeedMult range, a further-reduced health ceiling (more
  // toughness lost than Veteran, same direction as real RimWorld's old-age HP/immunity decline),
  // and a skillGainMult matching backstories.js's Burning Passion tier (2.5x) -- the "wisdom"
  // payoff is at its largest exactly where the physical decline is also at its largest, a genuine
  // tradeoff rather than a strict downgrade.
  { name: 'Elder', maxAge: Infinity, workSpeedMult: 0.85, healthMult: 0.88, skillGainMult: 2.5 },
];

export function ageBandFor(age) {
  for (const band of AGE_BANDS) if (age < band.maxAge) return band;
  return AGE_BANDS[AGE_BANDS.length - 1];
}
