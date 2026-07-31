// Onboarding: a short first-run guided tour, plus a permanently-available reference panel.
//
// This game has accumulated a lot of systemic depth (needs/mood/traits, blueprint construction,
// zoning, power + water graphs, day/night, weather, fire, pollution + nuclear hazard, a wave
// siege with 4 archetypes and 3 damage types, vehicles + fuel types, a research tree, a grading
// panel, a finance ledger and a conquest layer) behind exactly one line of hint text. Two pieces
// close that gap:
//
//   1. GUIDED TOUR -- 8 lightweight floating callouts, each anchored to the REAL DOM element it
//      is talking about via getBoundingClientRect(). Deliberately not a modal: the point is that
//      you can see the toolbar/topbar/button being described while you read about it. Fires once,
//      automatically, the first time a player ever begins a new settlement (localStorage flag
//      TUTORIAL_SEEN_KEY), never on Continue/Load, and is skippable at every step.
//
//   2. REFERENCE PANEL -- a full-screen .panel modal (same convention as #research/#worldmap/
//      #finance) reachable forever after from the topbar "?" button, F1 or the '?' key. Short
//      scannable entries, not prose: how citizens choose jobs, how building actually works, what
//      the storyteller does, the scrap/pollution/research loop, the archetype/damage matchups,
//      and one line per building category.
//
// Nothing in here touches sim state -- it is purely presentation, and it reads no world.

export const TUTORIAL_SEEN_KEY = 'settlement-defense-tutorial-seen';

// ---------------------------------------------------------------- guided tour steps
// `target` is a CSS selector for the real UI element the step is about (null = centre the callout,
// used only for the opening step which is about the settlement as a whole rather than a control).
// `side` is the PREFERRED placement; placeCallout() flips/clamps it if it would leave the viewport.
export const TUTORIAL_STEPS = [
  {
    target: null,
    side: 'center',
    title: 'Welcome to your settlement',
    body: 'These people are already yours, and they already have somewhere to be. You never give ' +
      'them orders directly — you decide what gets built and where, and they sort out the rest. ' +
      'Eight quick stops and you will know what every part of this screen is for.',
  },
  {
    target: '#stat-citizens',
    side: 'below',
    title: 'Your citizens run themselves',
    body: 'Each one eats, sleeps, socialises, hauls, harvests and builds on their own, choosing ' +
      'by need first and work second. They have traits, backstories, skills and passions that ' +
      'change how well and how willingly they do things. Click anyone on the map to inspect ' +
      'them, or drag a box to read a whole group at once.',
  },
  {
    target: '#toolbar',
    side: 'right',
    title: 'Build by leaving blueprints',
    body: 'Pick a tool here (or press its bracketed key) and click or drag on the map. Nothing ' +
      'appears instantly: you pay the scrap up front, a blueprint is dropped, and a citizen has ' +
      'to walk over and actually construct it. Zones are painted the same way — a Food, Bedroom ' +
      'or Recreation zone is what tells your people where to eat, sleep and unwind.',
  },
  {
    target: '#stat-scrap',
    side: 'below',
    title: 'Scrap in, pollution out',
    body: 'Scrap 🔩 is the only currency — earned by harvesting, truck hauls, recycling and kills, ' +
      'spent on everything you build. Pollution ☣ is the bill for it. Dirty generators and dirty ' +
      'trucks push it up, and high pollution does not just look bad: it makes every wave harder. ' +
      'Recycling Centers and garbage trucks are how you push it back down.',
  },
  {
    target: '#stat-wave',
    side: 'below',
    title: 'Waves are scheduled, not random',
    body: 'A storyteller watches how strong your settlement has grown and paces attacks to match ' +
      'it — Cassandra tracks you closely, Phoebe leaves long breathers, Randy barely looks. ' +
      'Attackers come in four kinds and your weapons come in three damage types, so a wall of ' +
      'identical turrets will eventually meet something it cannot hurt. Full matchup table in Help.',
  },
  {
    target: '#btn-research',
    side: 'below',
    title: 'Most of the good things are locked',
    body: 'Shelter, basic defense and scrap power are known from the start. Everything past that — ' +
      'water, better power, tesla coils, trucks, surveillance, the armory — is behind this tech ' +
      'tree. Research points accrue passively, scaled by how many citizens are alive, so keeping ' +
      'people breathing is itself the research strategy. Locked tools stay greyed out in the toolbar.',
  },
  {
    target: '#btn-worldmap',
    side: 'below',
    title: 'There is a world past this map',
    body: 'Surviving waves, keeping citizens alive and banking scrap raise your control of the ' +
      'region you are in. Hit 100% and it is yours for good and starts shipping scrap to whatever ' +
      'settlement you are running. From here you can pack up and move to an adjacent region — the ' +
      'one you leave keeps its progress.',
  },
  {
    target: '#btn-help',
    side: 'below',
    title: 'Everything else lives in here',
    body: 'That is the tour. This button (or F1, or "?") opens a permanent reference covering job ' +
      'priorities, the build pipeline, the storyteller, the resource loop, enemy matchups and ' +
      'every building category. It is always available, and you can replay this tour from it.',
  },
];

// ---------------------------------------------------------------- reference panel content
// Written for a player, not a developer: short, scannable, information-dense. Kept as data so the
// panel markup stays a single empty container in index.html.
const HELP_SECTIONS = [
  {
    title: 'Why your citizens do what they do',
    intro: 'Nobody takes orders. Every idle citizen re-picks a job from this list, top down, and takes the first thing that applies:',
    items: [
      ['Starving', 'Overrides everything, including bedtime. Walks to the nearest Food zone.'],
      ['Exhausted', 'Walks to the nearest Bedroom zone. The night Sleep block makes this trigger much earlier.'],
      ['Hungry', 'Food zone again, at the normal (non-critical) threshold.'],
      ['Lonely', 'Recreation zone. The evening Recreation block makes them seek company proactively.'],
      ['Unbuilt blueprint', 'The nearest unclaimed one. This is the only thing you directly cause.'],
      ['Idle truck', 'One haul cycle beats one pair of hands, so a parked truck wins over a resource node.'],
      ['Resource node', 'The fallback that keeps scrap trickling in even in a hands-off colony.'],
      ['Wild animal', 'Lowest priority of all — taming only happens when there is nothing productive left.'],
    ],
    outro: 'The day/night Duty Roster tightens these thresholds during the Work block, so a citizen ' +
      'will not wander off mid-shift for anything short of a real need. Mood too low and they go ' +
      'On Break and work at reduced speed — that is a warning, not a bug. Traits, backstories and ' +
      'passions (🔥 burning, ✧ interested) shift both speed and preference.',
  },
  {
    title: 'How building actually works',
    intro: 'Every buildable, walls included, goes through the same pipeline:',
    items: [
      ['1. Select', 'Click a toolbar entry or press its bracketed hotkey. [0] / Escape returns to Select.'],
      ['2. Place', 'Click a tile, or hold and drag to paint a run. Occupied tiles are refused.'],
      ['3. Pay', 'Scrap is deducted immediately, at placement — not at completion.'],
      ['4. Blueprint', 'A ghost structure appears and waits. It does nothing yet.'],
      ['5. Construct', 'The nearest free citizen claims it, walks there, and builds it. Construction skill sets the speed.'],
    ],
    outro: 'Zones (Food, Bedroom, Recreation) are free and instant — they are paint, not structures. ' +
      'Research-locked tools stay visible in the toolbar but greyed with a 🔒; clicking one tells ' +
      'you which technology unlocks it and opens the tree.',
  },
  {
    title: 'Waves and the storyteller',
    intro: 'Attacks are paced by a storyteller you picked at settlement creation. All three are the ' +
      'same scheduler with different dials:',
    items: [
      ['Cassandra', 'Reads your settlement and scales pressure straight off it. Steady, deliberate, least forgiving.'],
      ['Phoebe', 'Long gaps, almost never doubles up. Still watching you, but leaves real time to build and recover.'],
      ['Randy', 'Rolls each cycle fresh and barely looks at your strength. A quiet stretch, then two waves at once.'],
      ['Aggression', 'A flat multiplier on top: Calm 0.75x, Standard 1x, Aggressive 1.35x.'],
      ['Pollution', 'Raises wave danger independently of the storyteller. Mismanaged waste literally makes the siege worse.'],
    ],
    outro: 'Settlement strength is counted from living citizens, standing structures and banked ' +
      'scrap — growing makes you a bigger target. That is the trade, not a punishment.',
  },
  {
    title: 'Who is attacking, and what hurts them',
    intro: 'Four attacker kinds, three damage types, and exactly one intended answer each. A wall of identical turrets is not a plan.',
    items: [
      ['Grunt', 'The baseline. No resistances, no weaknesses. Anything works.'],
      ['Brute', 'Slow, heavy plate. Shrugs off bullets — put traps in its path.'],
      ['Skirmisher', 'Fast and unarmored. Bullets shred it; it outruns blasts.'],
      ['Boss', 'Huge health and a wide cleaving reach. Needs energy weapons — tesla coils and snipers.'],
      ['Kinetic', 'Turrets, guard sidearms, K9 bites. Your bread and butter.'],
      ['Explosive', 'Traps. One-shot bursts, best spent on a Brute.'],
      ['Energy', 'Tesla coils and armory-issued sniper fire. Expensive and slow, but shreds armor.'],
    ],
  },
  {
    title: 'The resource loop',
    items: [
      ['🔩 Scrap', 'Earned from kills, hand-harvesting, truck hauls, Recycling Centers and conquered regions. Spent on every structure. Budget 💰 shows the full ledger and the per-wave trend.'],
      ['☣ Pollution', 'Emitted by generators, nuclear waste and fuel-burning trucks. Raises wave difficulty. Cut it with cleaner power, ethanol/electric trucks, Recycling Centers and garbage trucks.'],
      ['🔬 Research points', 'Accrue passively, scaled by living citizens. The only way to unlock advanced buildables. A settlement that keeps burying people stops advancing.'],
      ['🏛 Settlement quality', 'Safety, Wellbeing, Sustainability and Cohesion, averaged in the topbar. Read-only — it reflects how the settlement is doing, it does not gate anything.'],
    ],
  },
  {
    title: 'What to build',
    items: [
      ['Defense', 'Wall / Fence / Door shape the approach. Turret is your general-purpose kinetic gun; Trap is a one-shot explosive burst; Tesla Coil is energy damage for armored targets; Watchtower and Floodlight extend reach and night vision.'],
      ['Power', 'Generator is the reliable dirty baseline. Coal is cheaper and dirtier, Wind is clean but needs open ground, Solar is clean but needs open sky, Nuclear is powerful and wireless but leaks hazard unless paired with Waste Storage. Power only flows along connected Wire — adjacency, not proximity.'],
      ['Water', 'Water Pump is the source, Pipe is the conduit, same connected-graph rule as power. Feeds Food and Recreation zone refill rate and the Recycling Center\'s throughput.'],
      ['Economy', 'Recycling Center converts pollution and waste into scrap. Recycling and Garbage Garages spawn trucks that haul automatically; each comes in Fossil (cheap, dirty), Gas (best all-round), Ethanol (clean, briefly saps food refill) and Electric (cleanest, but crawls unless the garage is powered).'],
      ['Living', 'Bed and Table are the physical furniture; Food, Bedroom and Recreation zones are what actually tell citizens where to go. Zones without furniture, or furniture without zones, both underperform.'],
      ['Staff & security', 'Armory automatically issues every Guard and Sniper a Rifle (a second Armory unlocks Heavy). CCTV Camera plus a Monitor Station, manned by a citizen on Monitor duty, gives you earlier warning of incoming waves.'],
    ],
  },
  {
    title: 'Controls',
    items: [
      ['Camera', 'Right-drag or middle-drag to pan, scroll to zoom, ⛶ Recenter to resume auto-follow.'],
      ['Selection', 'Left-click a citizen to inspect. Left-drag on empty ground to box-select a group.'],
      ['Time', 'Space pauses. + / − change speed (0x, 1x, 2x, 4x).'],
      ['Panels', 'Shift+T Research · Shift+M Conquest Map · Shift+B Budget · F1 or ? this reference · Escape closes.'],
      ['Files', 'F5 saves, F9 loads, R starts a new settlement (all three ask first where it matters).'],
    ],
  },
];

// ================================================================ guided tour
let stepIndex = -1;
let repositionTimer = null;

function el(id) { return document.getElementById(id); }

export function hasSeenTutorial() {
  try { return localStorage.getItem(TUTORIAL_SEEN_KEY) != null; } catch { return false; }
}

export function markTutorialSeen() {
  try { localStorage.setItem(TUTORIAL_SEEN_KEY, '1'); } catch { /* private mode -- tour just repeats */ }
}

/** Clear the first-run flag. Exposed for verification and for the panel's "Replay tour" button. */
export function resetTutorialSeen() {
  try { localStorage.removeItem(TUTORIAL_SEEN_KEY); } catch { /* nothing to clear */ }
}

export function isTutorialActive() { return stepIndex >= 0; }

/** Auto-trigger. Called from the NEW-GAME path only (never Continue/Load), so a returning player
 *  is never interrupted. No-ops if the tour has already been seen or is already running. */
export function maybeStartTutorial() {
  if (hasSeenTutorial() || isTutorialActive()) return false;
  startTutorial();
  return true;
}

/** Force the tour to run regardless of the flag (the panel's "Replay tour" button). */
export function startTutorial() {
  stepIndex = 0;
  el('tutorial').classList.remove('hidden');
  renderStep();
  // The topbar scrolls horizontally and the window can resize under us, so anchors are re-measured
  // on a slow timer rather than only once per step. Cheap: two getBoundingClientRects.
  if (repositionTimer == null) repositionTimer = setInterval(() => { if (isTutorialActive()) placeCallout(); }, 200);
}

/** Tear the tour down. `seen` marks the first-run flag so it never auto-fires again -- true for
 *  both Skip and Finish (either way the player has made a decision about it). */
export function stopTutorial(seen = true) {
  stepIndex = -1;
  if (seen) markTutorialSeen();
  el('tutorial').classList.add('hidden');
  el('tutorial-ring').classList.add('hidden');
  if (repositionTimer != null) { clearInterval(repositionTimer); repositionTimer = null; }
}

function gotoStep(i) {
  if (i < 0) return;
  if (i >= TUTORIAL_STEPS.length) { stopTutorial(true); return; }
  stepIndex = i;
  renderStep();
}

function renderStep() {
  const step = TUTORIAL_STEPS[stepIndex];
  el('tutorial-step').textContent = `Step ${stepIndex + 1} of ${TUTORIAL_STEPS.length}`;
  el('tutorial-title').textContent = step.title;
  el('tutorial-body').textContent = step.body;
  el('btn-tutorial-back').disabled = stepIndex === 0;
  el('btn-tutorial-next').textContent = stepIndex === TUTORIAL_STEPS.length - 1 ? 'Finish' : 'Next →';
  // Progress pips give the "this is short" signal a step counter alone doesn't.
  el('tutorial-pips').innerHTML = TUTORIAL_STEPS
    .map((_, i) => `<span class="pip${i === stepIndex ? ' on' : ''}${i < stepIndex ? ' done' : ''}"></span>`).join('');
  placeCallout();
}

/** Anchor the callout (and the highlight ring) to the step's real DOM element. Everything here is
 *  measured live via getBoundingClientRect() -- no hardcoded coordinates -- so it stays correct as
 *  the toolbar grows with research unlocks or the topbar scrolls. */
function placeCallout() {
  const step = TUTORIAL_STEPS[stepIndex];
  const box = el('tutorial-box');
  const ring = el('tutorial-ring');
  const M = 14; // gap between the target and the callout
  const vw = window.innerWidth, vh = window.innerHeight;

  const target = step.target ? document.querySelector(step.target) : null;
  if (!target) {
    ring.classList.add('hidden');
    box.style.left = Math.round((vw - box.offsetWidth) / 2) + 'px';
    box.style.top = Math.round((vh - box.offsetHeight) / 2) + 'px';
    box.dataset.side = 'center';
    return;
  }

  const r = target.getBoundingClientRect();
  ring.classList.remove('hidden');
  ring.style.left = (r.left - 4) + 'px';
  ring.style.top = (r.top - 4) + 'px';
  ring.style.width = (r.width + 8) + 'px';
  ring.style.height = (r.height + 8) + 'px';

  const bw = box.offsetWidth, bh = box.offsetHeight;
  let side = step.side;
  // Flip to the opposite side if the preferred one has no room. Only the two axes the steps
  // actually use need handling.
  if (side === 'below' && r.bottom + M + bh > vh) side = 'above';
  if (side === 'above' && r.top - M - bh < 0) side = 'below';
  if (side === 'right' && r.right + M + bw > vw) side = 'left';
  if (side === 'left' && r.left - M - bw < 0) side = 'right';

  let left, top;
  if (side === 'below' || side === 'above') {
    left = r.left + r.width / 2 - bw / 2;
    top = side === 'below' ? r.bottom + M : r.top - M - bh;
  } else {
    left = side === 'right' ? r.right + M : r.left - M - bw;
    top = r.top + r.height / 2 - bh / 2;
  }
  // Clamp into the viewport last, so a callout for an edge-hugging target (the toolbar runs the
  // full height of the screen) never ends up half off-screen.
  box.style.left = Math.round(Math.max(8, Math.min(left, vw - bw - 8))) + 'px';
  box.style.top = Math.round(Math.max(8, Math.min(top, vh - bh - 8))) + 'px';
  box.dataset.side = side;
}

// ================================================================ reference panel
let helpBuilt = false;

function buildHelp() {
  if (helpBuilt) return;
  helpBuilt = true;
  el('help-body').innerHTML = HELP_SECTIONS.map(sec =>
    `<section class="help-sec">` +
      `<h3>${sec.title}</h3>` +
      (sec.intro ? `<p class="help-intro">${sec.intro}</p>` : '') +
      `<dl>` + sec.items.map(([term, def]) =>
        `<div class="help-row"><dt>${term}</dt><dd>${def}</dd></div>`).join('') + `</dl>` +
      (sec.outro ? `<p class="help-outro">${sec.outro}</p>` : '') +
    `</section>`
  ).join('');
}

export function isHelpOpen() { return !el('help-panel').classList.contains('hidden'); }

export function toggleHelp(force) {
  const show = force != null ? force : !isHelpOpen();
  if (show) buildHelp();
  el('help-panel').classList.toggle('hidden', !show);
  el('btn-help')?.classList.toggle('active', show);
}

// ================================================================ wiring
// Self-contained: the tour and the panel own their own controls, so main.js only has to trigger
// them. Guarded so the module is inert if the markup ever isn't present.
export function initOnboarding() {
  el('btn-tutorial-next')?.addEventListener('click', () => gotoStep(stepIndex + 1));
  el('btn-tutorial-back')?.addEventListener('click', () => gotoStep(stepIndex - 1));
  el('btn-tutorial-skip')?.addEventListener('click', () => stopTutorial(true));
  el('btn-help-close')?.addEventListener('click', () => toggleHelp(false));
  el('btn-help-replay')?.addEventListener('click', () => { toggleHelp(false); startTutorial(); });
  // Escape closes the panel / dismisses the tour. Bound here rather than in input.js because it
  // must work even when no world exists and regardless of the tool-clearing Escape path.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isHelpOpen()) { toggleHelp(false); return; }
    if (isTutorialActive()) stopTutorial(true);
  });
}
