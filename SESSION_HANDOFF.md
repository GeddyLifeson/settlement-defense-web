# Session Handoff -- Settlement Defense (Web)

Read this first if context was lost. Project root: `C:\Users\imarl\settlement_defense_web\`.
Git history has full detail per-commit; this file is the "what's mid-flight right now" state.

## What this project is

A RimWorld / Prison Architect / Super Energy Apocalypse: Recycled (SEA:R) mashup, ported from
an earlier Unity/C# project (`C:\Users\imarl\settlement_defense\`, untouched, left as reference/
fallback per user's own choice) into plain JavaScript + Canvas 2D. **Explicit non-goal: never
frame this as a prison.** No inmates, no incarceration mechanics -- it's a civil settlement with
a non-carceral protection force (guards/snipers/K9), even while borrowing Prison Architect's
zoning/construction UX wholesale.

**No Unity, no build step for the player, no AI-generated art.** Every sprite is Canvas 2D
primitives. Run it by double-clicking `index.html` -- it loads `game.bundle.js`, NOT the ES
modules in `src/` directly (browsers block ES modules under `file://` via CORS; this was a real
bug the user hit and I fixed it by adding a bundler).

## THE ONE THING YOU MUST NOT FORGET

**`game.bundle.js` is generated. `index.html` never loads `src/*.js` directly.** After editing
ANYTHING in `src/`, run:
```
python build.py
```
(or `/c/Users/imarl/miniconda3/python.exe build.py` from git-bash). If you forget this step,
you will test stale code and waste time debugging a "bug" that's actually just an unbuilt
change. I hit this exact trap earlier this session -- don't repeat it.

Also: **this environment's browser tool aggressively caches `index.html`/`game.bundle.js`**
even in a brand new tab. Always navigate with a cache-busting query string
(`http://localhost:8123/index.html?v=<increment-this>`) when verifying a change, or you'll be
looking at stale-script behavior and misdiagnose it as a real bug (happened twice already).//

Server: a python http.server should already be running on port 8123 in the background
(`cd settlement_defense_web && python -m http.server 8123`). If it's not, restart it.

## Architecture -- file map

| File | Role |
|---|---|
| `src/core.js` | RNG, shared enums (AggressionPreset, StaffRoleKind, TerrainKind) |
| `src/grid.js` | SettlementGrid: terrain + wall passability |
| `src/zones.js` | Player-painted zone kinds (Food/Bedroom/Recreation), nearest-of-kind lookup |
| `src/economy.js` | BUILD_COST table, spend/canAfford |
| `src/resources.js` | ResourceNode scrap deposits scattered on the map, respawn over time |
| `src/vehicles.js` | Recycling/garbage trucks -- **just reworked, see "IN PROGRESS" below** |
| `src/citizens.js` | CitizenStore (SoA), needs/mood decay, traits |
| `src/traits.js` | 8 personality traits, one assigned per citizen at spawn |
| `src/security.js` | StaffRoster (guard/sniper/K9), staff-hold-post AI, K9 dog tick |
| `src/siege.js` | AttackerStore, Structure (blueprint/construction pipeline), wave spawner, turret/fence/trap combat, staff personal combat |
| `src/relationships.js` | Friendship web between nearby citizens, event log |
| `src/director.js` | Storyteller AI -- scales wave size/timing to colony strength |
| `src/jobs.js` | THE central job-priority state machine -- needs > blueprint construction > harvesting > driving a vehicle > idle wander |
| `src/world.js` | SimWorld composition root -- owns every store, tick() orchestrates all systems, serialize()/deserialize() for save/load |
| `src/render.js` | Canvas 2D renderer -- **just reworked, see "IN PROGRESS" below** |
| `src/input.js` | Player input: build palette (TOOLS array), zone painting, click-to-inspect, pause/speed |
| `src/main.js` | Bootstrap: DOM wiring for the whole UI (topbar/toolbar/inspector/eventlog/gameover modal), game loop |
| `build.py` | Concatenates src/*.js into game.bundle.js, stripping import/export (regex-based, NOT a real bundler -- see its own header comment for a bug already caught: multi-line `import {...} from` needed a `[\s\S]*?` regex, not `.*?`) |

`window.__debug = { getWorld, input, renderer }` is exposed in main.js -- use this from the
browser console (or `javascript_tool` in this environment) to inspect/fast-forward live state.
`window.__debug.getWorld().tick()` called in a loop is how every soak-test/balance-check this
session was actually done (screenshots of the canvas via `canvas.toDataURL()` for visual proof,
since this environment's real screenshot tool can't composite the Browser pane reliably).

## Session history (chronological, high level)

1. Ported the whole Unity/C# sim to this JS+Canvas structure (citizens, siege, security,
   director, save/load) -- committed as "Initial JS port"
2. Added full player interactivity (build/zone/economy/pause/speed), fixed a real bug where
   attackers stopped 1 unit short of citizens and could never actually deal contact damage,
   rebalanced needs-decay/job-speed/break-threshold after soak testing showed mood collapsing
   toward permanent breaks -- committed as "Full playable loop"
3. Added 8 traits + K9 dog companions (previously just a role label with no behavior)
4. **Fixed the file:// launch bug** (see above) + did a full UI/UX rebuild replacing a single
   monospace HUD div with topbar/toolbar/inspector/eventlog/gameover-modal DOM panels. Also
   fixed a real canvas-sizing bug (0x0 canvas if window dimensions weren't ready at first paint
   -- now self-heals by resizing every frame).
5. Added resource harvesting (RimWorld raw-material gathering), blueprint construction (every
   buildable including walls now requires a citizen to walk over and build it, Prison-Architect/
   RimWorld style -- was instant placement before), 4 new buildables (bed/table/door/generator),
   and vehicles (recycling/garbage trucks) that autonomously spawned and hauled
6. First visual pass toward RimWorld/PA look: grid lines, bordered zones, outlined silhouettes
7. **User feedback, addressed in this exact order, IN PROGRESS when context ran low:**
   - "trucks should have to be built by citizens and driven by them" -- vehicles were
     autonomous/spawning on their own, not player-built. **Reworked (see below).**
   - "don't want the ground to look like a grid... want it to look like one big piece (like
     minecraft grass)" -- the grid-line visual pass from step 6 was WRONG per this feedback.
     **Fixed (see below).**
   - "I want a RimWorld style planet map... conquest... control meter (Helldivers 2 style)" --
     **NOT STARTED. This is the next major feature after the in-progress items below land.**
   - "inspect every aspect of each game and port them over... use subagents" -- explicit
     request to use the Agent tool for a comprehensive RimWorld/Prison
     Architect/SEA:R feature-inventory research pass. **NOT STARTED.**

## IN PROGRESS RIGHT NOW -- finish these first, in this order

### 1. Vehicle rework (garage + driver) -- code written, NOT YET rebuilt/tested/committed

Changed files: `src/vehicles.js` (rewritten), `src/jobs.js` (added SeekingVehicle/Driving job
states + import of findUndrivenVehicle/boardVehicle), `src/world.js` (tickJobs call now passes
`this` as final arg; removed `maybeSpawnVehicle` import/call since vehicles no longer spawn on
their own; added garage-completion handling in the structures-filter pass that spawns a parked
Vehicle via `spawnParkedVehicle` when a `garage_recycling`/`garage_garbage` blueprint finishes),
`src/economy.js` (added `garage_recycling: 45, garage_garbage: 35` costs), `src/input.js` (added
`v`/`n` keys for the two garage tools to the TOOLS array).

**What's NOT done yet:**
- `src/render.js` needs updating to:
  - Draw `garage_recycling`/`garage_garbage` structure kinds (currently falls through to the
    default turret-shaped box in `_drawStructureShape` -- functional but visually wrong, should
    look like a small garage/depot icon)
  - Draw vehicles differently when parked (no driver) vs actively working -- right now
    `_drawVehicles` draws every vehicle in `world.vehicles` identically regardless of
    `driverId`; a parked one should look visually "idle" (e.g., dimmer, or a small "needs
    driver" indicator) so the player knows to send someone
  - Skip drawing citizens whose `jobState === JobState.Driving` in `_drawCitizens` (they're
    "inside" the vehicle now -- currently they'd still render as a separate humanoid standing
    at the vehicle's position, doubling up visually). Need to import `JobState` from jobs.js
    into render.js (not currently imported there) and check `world.citizens.jobState[i] !==
    JobState.Driving` in the `_drawCitizens` loop.
- `python build.py` has NOT been run since these edits -- game.bundle.js is stale relative to
  src/. Run it before testing.
- Needs functional verification via `window.__debug`: build a `garage_recycling`, fast-forward
  ticks, confirm a citizen claims driver duty (`jobState` becomes `SeekingVehicle` then
  `Driving`), confirm the vehicle's `driverId` gets set, confirm it actually drives out/works/
  returns and releases the driver (`driverId` back to `null`, citizen `jobState` back to
  `Idle`). The construction-claim pattern (`claimedBy`) used for blueprints was NOT reused for
  vehicles -- double check there's no race where two citizens could path to the same parked
  vehicle simultaneously and only one successfully boards (current code: the loser just goes
  Idle again on arrival if `vehicle.driverId != null`, which is correct, but hasn't been tested
  under load).
- Needs a save/load round-trip check -- `world.js` `serialize()`/`deserialize()` were NOT
  updated for the new vehicle shape (`garageX`/`garageY`/`driverId`/`phase`/`workTimer`/
  `targetNode`). The old serialize already writes `this.vehicles` -- **wait, check**: grep
  world.js's serialize() -- if it doesn't already serialize `world.vehicles` at all, add it. If
  it does, verify the new fields round-trip (especially `driverId` referencing a citizen id
  that must still resolve after reload).

### 2. Ground rendering fix -- code written, NOT YET rebuilt/tested/committed

`src/render.js`: replaced the flat per-cell fillRect + grid-line-stroke approach with an
offscreen-canvas cache (`_buildGroundCache`) using smoothstep-interpolated value noise
(`smoothNoise()`, added near the top of the file) so the ground blends continuously with no
visible per-cell seams, no grid lines. Cache rebuilds only when the wall layout changes
(tracked via `_wallSignature()`, a cheap sum-of-indices hash over `grid.wallThingId`).

**What's NOT done yet:** same as above -- needs `python build.py` + visual verification via
`canvas.toDataURL()` that (a) no grid lines are visible, (b) the ground looks like continuous
blended terrain not a checkerboard, (c) walls still darken correctly, (d) performance is fine
(the cache is built at `world.width*4 x world.height*4` = 256x256px for a 64x64 map, trivial,
but confirm no visible stutter when it rebuilds after a wall completes).

## STATUS UPDATE (this pass): items above are DONE

Vehicle rework (garage + citizen driver) and the ground-rendering fix are both finished,
verified via `window.__debug` soak tests, and committed (`b0aafe0`). Also fixed two real bugs
caught during that verification: (1) vehicle-driving was checked *after* resource-node
harvesting in job priority, so with nodes almost always available no citizen ever reached the
driving job in 6000+ ticks -- moved it above harvesting; (2) garages had no `_vehicleSpawned`
persistence, so reloading a save would spawn a duplicate vehicle per garage every time -- fixed
serialize/deserialize for both structures and vehicles.

**Also DONE**: the three-subagent RimWorld/Prison-Architect/SEA:R research pass the user
explicitly asked for. Full raw findings + a synthesis/priority read are in
`FEATURE_RESEARCH.md` -- **read that file before deciding what to build next**, don't
re-research from scratch. Short version: almost none of Prison Architect's mechanics are
actually carceral in mechanism (flood-fill rooms, power/water graphs, patrol routes, CCTV, K9
sniffing, needs-sim, schedules, crisis state-machines are all genre-neutral); only four things
need real rework rather than reskinning (prisoner/warden capture loop, "prison cell" room role,
kidnapping-as-raid-goal, per-prisoner income model) -- see FEATURE_RESEARCH.md's synthesis
section for the full list and a cost-sorted recommendation of what to build next.

## LATEST PASS (this session, after the research commit): DONE

Storyteller personalities, downed-not-dead, pollution economy, room detection (flood-fill,
with a refill-rate bonus for using an actually-enclosed room), and a watchtower early-warning
buildable are all implemented, individually verified via `window.__debug`, and committed
(`f6c0c09`). Read that commit message for exactly what was tested.

**CRITICAL -- unresolved balance regression, top priority to investigate next**: a hands-off
colony (zero player building beyond the starting 4 instant turrets) now falls in ~7-10k ticks
(~12-17 min), down from ~22-36k ticks (~35-60 min) at the "Full playable loop" commit. This
was caught DURING this pass's soak-testing, not introduced by it -- I ruled out the new
doubleChance and cycleMult storyteller mechanics as the cause (both tested live via
`STORYTELLERS.Cassandra.doubleChance = 0` etc. in `window.__debug` — the bundle is a flat
script so these are plain globals, not module-scoped, so you can mutate them straight from the
console). Prime suspect, not confirmed: the blueprint-construction commit (`25ef1c1`, three
commits before the storyteller work) made every buildable including fences/traps require
citizen construction time instead of instant placement -- a hands-off colony never gets
anything beyond the 4 starting turrets built, so colony strength/defense capability diverged
from what the original wave-scaling numbers assumed. **Next step**: `git stash` any WIP, check
out `3f9b1dc` (the last commit before blueprints existed) in a throwaway way (or just diff the
Structure/build logic), re-run the identical hands-off soak test, confirm whether that commit
still gets the long survival time. If confirmed, the fix is almost certainly in
`colonyStrength()` (director.js) or the wave-count/health scaling formula (siege.js
`WaveSpawner`), not in anything from this latest pass.

## NOT STARTED -- next major features

1. **Fix the balance regression above.**
2. **Remaining FEATURE_RESEARCH.md items**: a real power/water wire-graph (currently the
   generator buildable produces pollution but doesn't actually power anything -- no consumer
   side exists yet), a day/night duty-roster schedule system, fire spread, fuel-type tradeoffs
   for trucks (SEA:R's other big vehicle mechanic, distinct from the driver requirement already
   built).
3. **World map / conquest layer** (explicit ask, Helldivers-2-style control meter per region,
   RimWorld-style multi-settlement). No code exists for this yet. My rough plan (not committed
   to, reconsider if a better approach occurs to you): a `worldmap.js` with ~16 regions in a
   simple layout (id, name, neighbors, control 0-100, owned bool), one currently-active
   SimWorld/region at a time (running multiple live sims simultaneously is a lot more
   complexity than the ask likely needs), control% tied to the active settlement's performance
   (waves survived + scrap banked), an "expand to adjacent region" action that banks the
   current region's state and starts a fresh SimWorld for the new one, and passive scrap
   trickle from fully-controlled owned regions into whichever region is currently active
   (the "settlements giving each other resources" part of the ask). UI: a topbar button or `M`
   key opens a full-screen map overlay in the same DOM-panel style as the rest of the UI.

## REAL SVG ART PASS (this session, solo foundation + 4 parallel subagents): DONE

User asked to make the game look better -- clarified this means real hand-authored SVG art
(not AI-generated images, that constraint is unchanged; not procedural-shape polish either,
an actual art pipeline), while keeping the double-click-index.html-no-server design point
intact. New file `src/assets.js`: SVG templates as inline JS template-literal strings (NOT
separate `.svg` files -- a `fetch()` for an external file hits the exact `file://` CORS wall
that already broke ES modules earlier in this project), loaded via `data:` URI, recolored per
palette via `{{PLACEHOLDER}}` substitution, cached forever per distinct color combination.
`getSprite`/`drawSprite` is the public API; every call site has a primitive-shape fallback for
the few frames before a brand-new color combo's sprite finishes decoding.

**Solo foundation pass** (done directly, not via subagent -- unified art direction across the
most-repeated sprite benefits from one hand, unlike the systemic/mechanical work): humanoids
(citizens + all 4 attacker archetypes share one `_drawHumanoid` function, so converting it once
upgraded both) and dogs/wild animals. Hybrid split, deliberate: the torso+head silhouette (real
curves, gradient shading, per-unit hair color) is SVG; legs stay Canvas-drawn since they're the
part that animates every frame via a new phase-driven walk-bob (deterministic off
`world.currentTick` + a per-unit seed, pausable/replayable like everything else in this sim).

**4 parallel subagents, then**, converting every remaining structure/vehicle category (~24
kinds) -- this was the highest same-file-collision-risk wave of the whole session (all 4 agents
editing `render.js`'s `_drawStructureShape` and `assets.js`'s `TEMPLATES` object simultaneously):
- Defense: wall, trap, turret, tesla, floodlight, armory, watchtower (fence correctly left as an
  improved primitive -- it renders as a repeating line segment across a tile, not a centered
  icon, so it doesn't fit `drawSprite`'s model, same reasoning as wire/pipe below)
- Power/utility: all 5 generator variants, pump (wire/pipe also correctly left as improved
  primitives, same repeating-line-segment reasoning as fence)
- Economy + vehicles: garages, recycling center, waste storage, trucks (fuel-type stripe baked
  directly into the SVG via a `{{STRIPE}}` placeholder), resource nodes (ore deposit, scales
  with remaining `amount` exactly as before)
- Furniture + security: bed, table, door, camera, monitor_station

Every existing state-dependent visual (destroyed/underConstruction dimming, the overload-warning
pulse ring, wind's sited-vs-crowded tint, solar's open-sky-vs-enclosed tint, the monitor
station's staffed/unstaffed/destroyed 3-way color, camera's destroyed lens tint) was preserved
by computing the same color the old primitive code branched on and passing it into `drawSprite`'s
`vars` instead of losing the logic -- verified for every one of these, not assumed.

**Verification note**: the furniture/security agent got locked out of the shared browser pane by
contention from the other 3 concurrent agents and couldn't self-verify the monitor_station's
3-state color logic or camera's destroyed tint. Verified in this integration pass instead via a
differential-pixel-sum technique (render each state, sum all pixel values in a sample region
around the sprite, confirm the sums differ) rather than guessing a single pixel's exact
coordinates against the new SVG geometry -- monitor_station's three states produced measurably
different sums (312904/312052/310985), camera's normal-vs-destroyed differed (218105/217313),
confirming the state logic genuinely reaches the rendered pixels.

**Also verified in this integration pass**: zero duplicate top-level declarations across the
rebuilt bundle (the same `grep -oE "^(async function|function) [A-Za-z0-9_]+" game.bundle.js |
sort | uniq -d` sweep from the previous collision-bug discovery, re-run given 4 agents editing
`assets.js`'s single `TEMPLATES` object concurrently was real risk) -- clean, and no duplicate
template keys either. Full rebuild, zero console errors, 85/85 automated tests still passing
(render-layer-only change, no simulation logic touched), and a real in-game screenshot of all
22 convertible structure kinds placed together confirmed every one renders as a distinct,
legible silhouette with no broken/missing sprites.

## REMAINING-GAPS WAVE (this session, via 7 more parallel subagents): DONE

User asked "what else are we missing" a third time; the honest answer by this point was mostly
small polish plus two genuinely practical gaps (save reliability under `file://`, and zero touch
input despite being a browser game). All 7 landed cleanly.

- **Save export/import to file** — Download/Upload Save buttons (title screen + pause menu),
  reusing the exact `world.serialize()` payload the existing save systems already produce.
  Addresses a real risk: every save mechanism (manual/slots/autosave) writes to `localStorage`,
  which is genuinely unreliable under a `file://` origin (this project's whole "double-click
  index.html" design point) — a file-backed save is a durable path that doesn't depend on it.
- **Touch/mobile input** — implemented as a thin shim feeding synthesized mouse-shaped events
  into the *existing* mouse handlers (one-finger drag/tap literally reuses `_onDown`/`_onMove`/
  `_onUp`, not a parallel code path), plus new two-finger pan/pinch state. Caught and fixed a
  real bug in the process: touch-start has no "hover" preamble the way mouse always does (a
  `mousedown` is necessarily preceded by a `mousemove`), so the first tile of a touch-drag
  build was landing wrong until `_updateHover()` was added to the touch-start path.
- **Per-citizen work-priority table** — a RimWorld Work-tab-style override (Construction/
  Hauling/Harvesting/Animal, 4 categories mapped 1:1 to the existing non-needs `JobState`s) that
  biases, not replaces, the needs-first autonomy. Citizens with no override keep the exact
  original fixed-priority behavior (verified byte-for-byte identical).
- **Formal room roles** — Bedroom/Dining/Recreation Room classification requiring the matching
  zone AND furniture (a bed, a table) to validate; the existing room-refill mood/need bonus now
  gates on role validity, not just "any enclosed room" (verified an exact 1.63x refill-rate
  change the moment the missing furniture is built).
- **Riot/unrest crisis** — a colony-wide `unrestLevel` (reusing `grading.js`'s Wellbeing axis
  rather than recomputing it) with hysteresis trigger/resolve thresholds, applying a real 0.7x
  colony-wide rate penalty (stacking with individual `OnBreak`) while active. Verified a healthy
  colony never comes close to spuriously triggering it.
- **Power grid overload/explosion risk** — per-segment load vs. generator capacity; exceeding it
  soft-fails the powered damage/range bonus (verified exact damage-output match) and adds a real,
  low, tuned fire-ignition risk reusing `fire.js`'s existing spread/damage system rather than a
  parallel one.
- **Persistent meta-progression / achievements** — 11 achievements checked against real in-game
  numbers (research node count, region count, generator variety), lifetime stats in a dedicated
  `localStorage` key separate from any save/slot/autosave key, verified accumulating correctly
  across multiple runs and surviving a page reload.

**A systemic bug class caught during this round, worth remembering going forward**: the
meta-progression agent found that `build.py`'s flat-concatenation bundling means EVERY top-level
`function`/`const`/`let`/`class` name across all of `src/*.js` shares one global scope — a
same-named helper in two different files silently collides, and the later one in `build.py`'s
`ORDER` wins with no error (their own `load()`/`unlock()` helpers had been silently overwritten
by unrelated same-named functions in `main.js`/`audio.js`). Fixed by renaming to underscore-
prefixed internal names. **Verified in this integration pass**: a full sweep of the rebuilt
bundle (`grep -oE "^(async function|function) [A-Za-z0-9_]+" game.bundle.js | sort | uniq -d`)
found zero duplicate top-level declarations across all 251 functions — this specific check is
worth re-running after any future large multi-agent pass, since it's a silent-failure class that
produces no build error and no console error until the exact wrong function happens to get
called.

**Verification**: full rebuild, zero duplicate top-level names (251 functions checked), zero
console errors, `tests/run.html` still 85/85 passing, and a 3-seed soak test came back byte-for-
byte identical to the established baseline (22568/21241/21344 ticks) confirming zero balance
drift from this entire round despite the new crisis/overload systems being active throughout.

## MENUS/UX WAVE (this session, via 8 more parallel subagents): DONE

User asked what was missing for "menus, setup, things like that" — the meta-game wrapper around
the sim, distinct from gameplay systems. The game previously booted directly into a running
colony with zero menu of any kind. All 8 landed; the first (title screen) ran alone first since
it's the architectural foundation everything else needed, the remaining 7 ran in parallel against
the shared tree once its interface existed.

**Title screen + lazy boot** (`src/main.js` restructured — `SimWorld` is no longer constructed
at module load) is the load-bearing piece. It exposes a clean interface on `window.__debug` that
every other agent this round hooked into: `startGame(world)` (the one gameplay-handoff point),
`showTitleScreen()` (quit-to-title), `isInGame()`, `newGame(opts)`, `hasSave()`,
`save()`/`load()`/`restart()`. New Game setup exposes map size, seed, starting citizen count,
`AggressionPreset`, and storyteller personality — all real backend parameters that existed since
early in the project but were hardcoded and never player-facing until now.

**Everything else, built against that interface:**
- Confirm-before-destructive dialogs (New/Restart/Load-while-in-game) — `confirmAction()` helper
  reused by the pause menu's Quit-to-Title.
- Pause menu (Resume/Save/Settings/Quit to Title), correctly wired to poll `world.paused` so it
  also opens via the Space hotkey, not just the topbar button.
- Multi-slot save management (5 slots + legacy-save auto-migration), fully independent of and
  verified non-conflicting with the separately-built autosave key.
- Autosave (dedicated key, ~1200-tick interval, quiet fade indicator) + a resume-on-load prompt
  that compares manual-save vs. autosave timestamps and offers whichever's relevant.
- Options/Settings — a REAL volume slider (verified against the actual WebAudio `GainNode`
  value, not just a UI number), a keybinding reference, and **live** mid-campaign
  aggression/storyteller changes (verified: switching storyteller mid-run actually changes
  `waveSpawner.cycleMult`/`doubleChance` on the very next wave-timing decision, confirming
  `directWaveSpawner` reads those fields fresh every tick rather than caching them at
  construction), plus a scoped-down accessibility pass (shape-coded rings/dash-patterns for
  colorblind-friendliness, a UI-scale slider).
- Tutorial/onboarding — an 8-step non-modal guided tour anchored to real UI elements via live
  `getBoundingClientRect()` (verified 14px anchor precision on every step, edge-clamping, live
  repositioning if the anchored element moves), triggered once on a player's first-ever New Game
  only, plus a persistent 40-row Help reference panel (`F1`/`?`) covering the job-priority
  system, the blueprint pipeline, storytellers, enemy archetypes/damage types, the resource loop,
  and a one-liner per building category.
- Credits/about screen + a fullscreen toggle (graceful failure if the browser's autoplay/gesture
  policy blocks it).

**Verification note on balance**: a post-integration soak test at first showed survival times
~40% below the established baseline (13-14k vs. 21-23k ticks) — investigated before assuming a
regression, and it wasn't one: the new `newGame()` helper defaults to `Standard` aggression
(a reasonable default for a new player) where the old direct-`SimWorld`-construction soak tests
this whole session had all implicitly used `Calm`. Holding aggression constant at `Calm`
reproduced the exact prior baseline numbers (22568/21241/21344 — identical to the pre-menu-wave
soak). No balance code was touched or needed fixing this round.

**Verification**: full rebuild, zero console errors through the whole title→setup→tutorial→
pause→settings→quit-to-title chain (driven live via the Claude in Chrome extension, not just
`window.__debug` state checks), `tests/run.html` still 85/85 passing, real screenshots of the
title screen, New Game setup, tutorial step anchoring, pause menu, and Settings panel all
confirming clean visual integration with no overlap despite 8 concurrently-landed panels.

## SECOND BACKLOG WAVE (this session, via 13 more parallel subagents): DONE

User asked "what else are we missing from each of the games", got a fresh gap analysis against
`FEATURE_RESEARCH.md`, then said to run a subagent for every remaining bullet. All 13 landed,
same no-worktree-isolation constraint as the first wave (agents edited the shared tree directly,
concurrently) -- collisions happened and were mostly self-resolved by the agents themselves; the
rest fixed in this final integration pass.

**New systems, one per subagent:**
- **Backstories + skill passions** (`backstories.js`) -- 8 childhood/adult pairs, None/Minor/
  Burning passion tiers with a verified 2.5x skill-gain multiplier on Burning.
- **Room stats** (`computeRoomStats` in `rooms.js`) -- beauty/cleanliness/impressiveness/quality
  per detected room, feeds a real, measured mood delta.
- **Weather + random events** (`weather.js`) -- Clear/Rain/Cold/Heatwave with real decay/speed
  effects, wanderer-joins + blight events (infestation explicitly scoped out, documented why).
- **Enemy variety** -- 4 archetypes (Grunt/Brute/Skirmisher/Boss) with a legible damage-type
  resistance matrix (Kinetic/Explosive/Energy) and tunnel-arrival raids that breach the interior
  instead of walking in from the edge.
- **Animal taming/breeding** -- wild animals spawn periodically, tameable via a new job state,
  breed with a population cap (verified holding at exactly 8 over a 30k-tick soak).
- **Water/plumbing** (`water.js`) -- a direct architectural mirror of `power.js`'s flood-fill
  graph; boosts Food/Recreation zone refill and Recycling Center throughput when connected.
- **Staff patrol routes + fatigue** -- guards/snipers can patrol 2-4 waypoints instead of a
  static post, and now actually go off-duty to eat/sleep when needs crash (previously they just
  silently decayed forever with zero recovery -- a real bug, not just a missing feature).
- **Armory + weapon tiers** -- Sidearm/Rifle/Heavy issued off armory count, Heavy's cooldown
  penalty is a genuine tradeoff (measured, not a strict upgrade).
- **Grading/scoring** (`grading.js`) -- Safety/Wellbeing/Sustainability/Cohesion, the non-carceral
  reframe of Prison Architect's 4-axis system, read-only reporting layer.
- **Population growth via arrivals** -- a "Refugee Wagon" analog, reactive (only replenishes
  combat losses back toward ~90% of starting population, capped).
- **Finance ledger** -- per-category income/expense tracking + a rolling 20-snapshot trend chart,
  Budget Report modal (Shift+B).
- **Generator variety** -- coal/wind/solar added (geothermal skipped, documented reasoning: its
  "needs guarding" fits a staffing UI this pass didn't have room to build safely, not the
  nuclear-style containment pattern). Siting constraints are honest substitutes for elevation/
  roof data this engine doesn't have (open-ground clearance for wind, non-enclosed-room for
  solar), and are real binary gates on the power graph, not cosmetic.
- **Research tree** (`research.js`) -- 3 free innate techs (wall/turret/fence/door/bed/table/
  generator/wire) + 12 gated nodes, fail-open by design (any buildable not in the gate map stays
  placeable, so future work can't go silently unplaceable), Research panel (Shift+T).

**Real regression caught and fixed during this pass's final integration**: multiple agents
independently observed hands-off soak tests landing well below the established baseline (16-18k
ticks vs. the historical 22-36k). The root cause: `weather.js`'s wanderer-joins event had **no
population ceiling of its own**, and stacked uncoordinated with the separate Refugee Wagon
mechanic (which does cap around 90% of starting population) -- a hands-off colony grew from 24 to
40+ citizens in ~10k ticks with zero combat losses. Since `colonyStrength()` scales directly off
alive-citizen count, this silently inflated wave difficulty with nothing scaling up to match --
the same *shape* of bug as the scrap-uncapped regression from the first backlog wave, just a
different resource ballooning unchecked. Fixed with a `WANDERER_POPULATION_CAP_MULT = 1.15` gate
in `weather.js`. Re-soak-tested: 21241-23245 ticks across 4 seeds post-fix (up from ~16-18k) --
still somewhat below the original 22-36k, which is expected and reasonable given how much
genuinely new difficulty this wave added (Bosses, tunnel raids, damage resistances, staff
periodically going off-duty) -- did not chase the exact historical number further.

**Also fixed in this integration pass**: `#topbar` was overflowing horizontally (many agents
each added their own topbar stat/button -- weather, day/night, grading, research, budget, map,
sound -- and total content width exceeded the bar at common viewport widths, clipping the
rightmost buttons). Fixed with `overflow-x: auto` + `flex-shrink: 0` on stats/buttons, same
scrollable-bounded-bar pattern already used for `#toolbar`'s vertical overflow from the first
backlog wave.

**Verification**: full rebuild, zero console errors, `tests/run.html` still 85/85 passing against
the fully-merged tree, real screenshot verification (Claude in Chrome extension) of the Research
panel, Budget Report, and the now-scrollable topbar/toolbar.

## FULL BACKLOG CLEAR (this session, via 11 parallel subagents): DONE

User: "DO EVERYTHING" + "RUN AGENTS FOR EACH THING THAT'S ON BACKLOG" -- every remaining backlog
item from the previous pass, plus a fresh NPC-need-rate bug report, was farmed out to a real
Agent-tool subagent (model/effort picked per task: opus for the two largest -- power graph,
world map -- sonnet for everything else), running concurrently against this shared working
directory. **Worktree isolation was NOT available** (the session's cwd, `C:\`, isn't itself a
git repo, and the Agent tool's worktree feature requires that) -- agents edited the live tree
directly, in parallel, with instructions to re-read files before editing and expect occasional
retries. This worked better than expected; only a couple of real collisions occurred (see below),
both self-resolved by the agents themselves before I even had to intervene.

**NPC rate-diminishment bug (user-reported, both halves confirmed and fixed):**
- `HUNGER_DECAY`/`REST_DECAY`/`SOCIAL_DECAY` (`citizens.js`) were ~12x too fast relative to
  `REFILL_RATE`/travel time -- a citizen could deplete a need to zero before finishing the walk
  to a zone. Retuned so full-to-zero takes ~2000 ticks instead of ~170-400.
- `CitizenFlags.OnBreak` was set/cleared based on mood but **read nowhere else in the entire
  codebase** -- mood crashing had zero gameplay effect. Fixed: on-break citizens now work/build/
  harvest at 0.5x speed (`jobs.js`), render visibly desaturated with a status glyph
  (`render.js`), and show in the inspector (`main.js`).

**New systems (all verified via `window.__debug` soak-tests by their own agent, then
re-verified together in the final integration pass below):**
- **Real power/water wire-graph** (`power.js`, new) -- replaced the earlier radius-based
  `isPowered` stub with an actual flood-fill conductor network over `generator`/`wire` tiles.
  Cut/repair a wire and downstream consumers correctly lose/regain power.
- **Day/night Duty Roster** (`schedule.js`, new) -- `world.timeOfDay` cycles every 2400 ticks;
  `jobs.js` biases citizens toward sleep/rec/work by time-of-day without overriding a genuine
  starvation/exhaustion emergency. Topbar sun/moon indicator.
- **Fire spread** (`fire.js`, new) -- generators can rarely spark nearby flammable furniture
  (bed/table/door), which burns and can cascade to neighbors, self-extinguishes once out of
  fuel. Walls are deliberately NOT flammable -- they fold into permanent grid terrain the tick
  after construction finishes and can't hold fire state.
- **Truck fuel-type tradeoffs** -- 4 fuel variants per garage kind (fossil/gas/ethanol/electric),
  each with a real, measured tradeoff: pollution-per-haul, a temporary Food-zone refill penalty
  for ethanol, a power-graph dependency for electric (2.5x slower if its garage isn't wired).
- **CCTV camera + manned Monitor Station** -- cheaper/shorter-range early-warning complement to
  Watchtower; a staffed Monitor Station (new `StaffRoleKind.Monitor`) roughly doubles the warning
  window versus an unmanned camera.
- **Nuclear generator + waste storage** -- high-power/high-risk generator tier with a wireless
  power radius, but accrues `world.nuclearWaste` and deals real hazard damage to anything nearby
  until a Waste Storage building is placed within containment radius.
- **World map / Conquest layer** (`worldmap.js`, new) -- the user's long-standing RimWorld-style
  ask. 16 regions, one live `SimWorld` at a time, control% driven by how the active settlement is
  doing, owned regions passively trickle scrap to the active one, "Expand here" banks the current
  region and starts a fresh settlement in an adjacent one. Full-screen overlay, `Shift+M` to
  toggle (`M`/`m` was already claimed by Monitor Station's hotkey).
- **Minimap** -- always-on corner overview, attacker dots, click-to-jump camera.
- **Drag-select multiple citizens** -- marquee-select (Select tool only, doesn't interfere with
  build-painting or camera pan); since there's no per-citizen command system to hook into yet,
  multi-select shows aggregate need/mood info rather than pretending to enable orders that don't
  exist.
- **Procedural WebAudio sound** -- 5 synthesized cues (build-complete, turret-fire, kill,
  wave-incoming, citizen-downed), throttled where needed, mute button in the topbar, gated behind
  the browser's user-gesture autoplay unlock.
- **Automated test suite** (`tests/`, new) -- 85 real assertions against `CitizenStore`,
  `tickNeedsAndMood`, `detectRooms`, `WaveSpawner`/`colonyStrength`, the blueprint-construction
  lifecycle, and the full vehicle garage->driver->haul-cycle. Runs over `http://` (imports
  `src/*.js` directly as real ES modules, bypassing `game.bundle.js` entirely) -- open
  `tests/run.html` via the existing `python -m http.server 8123`. Never added to `build.py`'s
  `ORDER`, so it can never leak into the shipped bundle.

**Real cross-agent collisions that happened, and how they resolved:**
- Three different agents (world-map, CCTV, audio) independently hit the exact same latent
  bundler gap: `main.js`'s `import * as audio from './audio.js'` doesn't survive `build.py`'s
  strip-imports-to-globals concatenation (only named imports do). The audio and CCTV agents both
  fixed it by switching `main.js` to named imports; the truck-fuel-type agent additionally made
  `build.py` itself understand namespace imports generically (synthesizes a `const audio = {...}`
  alias object). Both fixes are compatible -- `main.js` uses named imports, `build.py`'s new
  generic support is just unused-but-harmless extra capability. Verified no conflict.
- The nuclear-hazard agent caught and fixed a real bug in `power.js`: `computeEnergized` special-
  cased the literal string `'generator'` as a power source even after `isSource()` had already
  been genericized to accept any `generator_*` prefix -- meaning the nuclear generator (or any
  future generator variant) would never have counted as a power source. Fixed to use `isSource()`
  consistently.
- `build.py`'s `ORDER` array needed `schedule.js`/`fire.js`/`power.js`/`worldmap.js`/`audio.js`
  added by whichever agent's work depended on them; by the time all 11 landed, every new module
  was present and in a working dependency order (verified via a clean full rebuild + zero console
  errors).

**Fixed during final integration (not any single agent's fault, a consequence of merging 11
agents' UI additions into one toolbar):** `#toolbar` grew to 26 items across all the new
buildables and had no `max-height`/`overflow-y`, so it silently overflowed off the bottom of the
viewport with no way to reach the later entries. Fixed by bounding it between the topbar and the
bottom edge (`top: 60px`) with `overflow-y: auto`.

**Final integration verification** (fresh browser tab, full rebuild via `build.py`):
- Zero console errors on load.
- Full soak test to game-over: 32,842 ticks -- still squarely in the healthy 22-36k baseline,
  with every new system's state (`timeOfDay`, `nuclearWaste`, `worldMap`, etc.) present and sane
  throughout.
- `tests/run.html` re-run against the fully-merged tree: still 85/85 passing.
- Real screenshot verification (Claude in Chrome extension, not the still-broken Claude_Browser
  screenshot tool) of the base game, the fixed toolbar, and the Conquest Map overlay -- all render
  correctly with no overlap.

## LAUNDRY-LIST PASS (this session): comprehensive audit + implementation, DONE

User asked for a full audit "at every level from code to UI" and to implement improvements, not
just list them. Full list below, split by what got built this pass vs what's still backlog.

**Done this pass, all rebuilt/verified via `window.__debug` soak tests + real screenshots
(Claude in Chrome extension, not the Browser-pane tool -- see note at the very bottom):**

1. **Root-caused and fixed the balance regression** flagged in the previous pass. It was NOT the
   blueprint-construction commit (the prime suspect at the time) -- it was `colonyStrength()` in
   `director.js` including a raw linear `world.scrap * 0.1` term. Idle citizens auto-harvest
   resource nodes even in a totally hands-off colony (jobs.js's idle-fallback), so scrap grows
   unboundedly with zero player action, saturating `strengthFactor` to its cap within a few
   thousand ticks regardless of actual defense built. Fixed by switching to
   `Math.sqrt(world.scrap) * 1.5` (diminishing returns, not a hard cap). Re-verified with two
   fresh soak tests: 31974 and 26735 ticks to game-over, both back in the original 22-36k
   baseline range (was 7-10k regressed).
2. **Manual camera control** -- there was previously *no* way for the player to pan or zoom by
   hand; the camera was 100% auto-framed on a timer (`frameOnContent` every 50 frames). Added
   scroll-wheel zoom (`Renderer.zoomAt`, keeps the world point under the cursor stationary) and
   right-click-drag pan (`Renderer.panByScreenDelta`), both clamped to map bounds via the same
   `_clampCamToWorld` added for the void-bug fix. Auto-reframe now backs off once
   `renderer.manualCamera` is true; a new topbar "⛶ Recenter" button (`input.recenter()`) hands
   control back to auto-follow.
3. **Simple power system** -- generators previously had no consumer side (pollution cost, no
   benefit). Added `isPowered(structures, x, y)` in `siege.js` (radius check against active
   generators); turrets/tesla coils get +50% damage and +25% range when powered, watchtowers get
   a longer early-warning lead time (90 vs 50 ticks). Deliberately NOT a full wire-graph (that's
   still "medium cost" backlog below) -- this is the "low cost" scoped-down version
   FEATURE_RESEARCH.md flagged as the alternative.
4. **Three new SEA:R-flavored buildables**: Floodlight (`$12`, soft-wall -- slows attackers
   35% inside its radius instead of blocking them like a fence), Tesla Coil (`$40`, chains to
   every attacker in range per activation instead of picking one target -- a crowd-control pick,
   not a strict turret upgrade), Recycling Center (`$55`, passive pollution->scrap trickle,
   complements rather than obsoletes the garbage-truck haul cycle). All three have real Canvas 2D
   shapes in `render.js`, real economy costs, real toolbar entries with hotkeys (f/x/r).
5. **Skill levels surfaced in the inspector** -- was a raw unbounded float (`Combat skill: 0.34`),
   now bucketed into RimWorld-style named tiers (Novice/Competent/Skilled/Expert/Master) for both
   combat and construction skill.

**Still backlog, not done this pass (roughly cost-sorted, see FEATURE_RESEARCH.md for full
detail on each):**
- Full power/water wire-graph (current fix is radius-based, not a real connected network)
- Day/night duty-roster schedule system
- Fire spread simulation
- Truck fuel-type tradeoffs (SEA:R mechanic, distinct from the driver requirement already built)
- CCTV monitor room bonus (watchtower covers the early-warning half of this; the "manned
  monitor" staffing bonus from Prison Architect's CCTV system doesn't exist yet)
- Nuclear-waste-style guarded-hazard-zone mechanic
- World map / conquest layer (Helldivers-2-style per-region control meter, RimWorld-style
  multi-settlement) -- explicit user ask from earlier in the project, still not started, still
  the single largest remaining feature. Rough plan unchanged from the previous handoff pass, see
  below.
- Minimap / world overview once a settlement's footprint grows past what one screen can show at
  a readable zoom (more pressing now that manual zoom exists and players may zoom in tight)
- Drag-select multiple citizens (currently one at a time via click)
- Any kind of audio (fully unaddressed all session -- would need to be procedural/WebAudio-
  generated, consistent with the no-AI-assets rule)
- No automated test suite for the SoA/job-priority logic -- every verification this whole session
  has been manual `window.__debug` soak tests, which work but don't guard against regressions the
  way even a handful of assertion-based smoke tests would

**Note on visual verification tooling**: the Claude_Browser MCP's screenshot/zoom tools cannot
reliably composite this environment's Browser pane (a "pane is not displayed" error that
recurred all session). The `mcp__claude-in-chrome__*` tools (the Claude in Chrome extension,
driving a real Chrome tab) do NOT have this limitation and were used for all real-screenshot
verification in this pass -- prefer that toolset over Claude_Browser's computer/zoom actions for
this project going forward.

## Known gaps / deliberately-simplified systems (carried forward from earlier handoff, still true)

- No power/water utility networks, no room detection/enclosure -- decided early these aren't
  load-bearing for the survive-the-siege loop, but they're squarely in-scope now given the
  "every aspect" ask above. Revisit.
- Health is a single 0-1 float per citizen, no body-part model.
- `skillConstruction` and `skillCombat` are tracked and feed build/harvest/combat rates but
  there's no UI surfacing skill *levels* distinctly (just a raw number in the inspector panel).
- CCTV (named in the original GDD) not implemented at all.

## REAL-GAME-FILES DEEP DIVE (this session): DONE, research + full implementation wave both landed

`FEATURE_RESEARCH.md` (referenced throughout this file) was built from web/wiki research, not
the actual shipped game data. User pushed back explicitly: "you're missing a lot of stuff" and
asked for a real deep dive into RimWorld's and Prison Architect's actual installed game files via
Steam (owns both). This supersedes/extends FEATURE_RESEARCH.md -- treat *this* section, not that
file, as the current source of truth for what's been mined from real data.

**RimWorld**: read directly from `C:\Program Files (x86)\Steam\steamapps\common\RimWorld\Data\`
-- Core + all 4 DLC, real human-readable Defs XML (StatDefs, NeedDefs, HediffDefs, WorkTypeDefs,
SkillDefs, TraitDefs, BackstoryDefs, ThingDefs_Buildings, ResearchProjectDefs, PawnKindDefs,
DamageDefs, WeatherDefs, Storyteller/DifficultyDefs). Only Core was covered this pass -- the 4
DLCs' own content (Biotech genes/xenotypes, Ideology precepts, Anomaly horror mechanics, Royalty
titles) is still unexamined, a real next-step if there's appetite for another research wave.

**Prison Architect**: installed via Steam (computer-use, user's explicit choice) mid-session.
Its actual data ships packed inside RAR archives (`main.dat`/`prisons.dat`/etc, despite the `.dat`
extension) -- extracted read-only with a legitimately-downloaded 7-Zip (user approved) into a
scratchpad, yielding 1151 real text/Lua files: `needs.txt`, `research.txt`, `production.txt`,
`materials.txt`, `calamities.txt`, `gangs.txt`/`gangdemands.txt`, `guardrank_settings.txt`,
`crookedguards_settings.txt`, `ratsystem.txt`, `firePropagationSystem.txt`,
`heatstrokesystem.txt`, `deepfreezesystem.txt`, `reform_programs.txt`, `dynamicRep.txt`, plus 24
real campaign Lua scripts (`riot.lua`, `riot_hostages.lua`, `riot_roulette.lua`, etc) showing
actual staged-escalation state-machine logic. Full extraction still sits at
`C:\Users\imarl\AppData\Local\Temp\claude\...\scratchpad\pa_extract\data\` (a temp session
directory -- may not survive a machine restart; re-extract via 7z from `main.dat` if it's gone,
the archive itself is untouched at the Steam install path).

**8-agent research pass** (4 RimWorld clusters, 4 PA clusters) read the real files and produced
concrete numeric gap reports against this codebase -- not implemented directly from those
reports, but immediately followed by:

**15-agent implementation wave**, all landed and individually soak-tested, covering: needs/mood
overhaul (real mood-threshold fix 0.12->0.35, stacking mood-events, break-severity tiers,
cross-need throttling, hunger spiral, a new Hydration need wired to `water.js`), trait/backstory
work-speed and break-threshold axes, a new Cleaning job category + room-quality flavor text,
power retune (fixed wind/solar/generator capacity ranking, new battery + power-switch
buildables), construction time now scales by building tier, weather now affects combat accuracy
+ a new Thunderstorm/lightning-fire mechanic + PA-real difficulty-scaled fire spread, a real
armor-penetration-vs-armor stochastic combat roll (replacing the old flat multiplier table), a
RimWorld-style points-budget wave composition (replacing fixed per-slot percentage rolls), a new
Citizen Support Programs system (`programs.js`, reskinned non-carceral port of PA's reform
programs), a two-stage production chain (`workshop` buildable), a real research-tree capstone
node, tiered unrest + per-citizen unrest-proneness scoring + a reward-for-good-crisis-management
loop, a rival faction/clique system (`factions.js`, reskinned non-carceral port of PA's gangs),
corrupt/bribable staff + a held-citizen crisis event, and a rat/vermin infestation system
(`rats.js`) + cold-weather pipe freezing + a heatwave movement-speed penalty.

**Also fixed during this wave**: the wave-spawner's attacker-count formula had its bonus-term
ramp capped too early (`Math.min(10, waveNumber*1.5)`, hit by wave ~7), which let per-tick
`strengthFactor` variation invert the intended "later waves are at least as big" ordering once
two waves were far enough apart in number but close in the flattened bonus term. Raised the ramp
cap 10 -> 40 in `siege.js`'s `waveCount()`. Confirmed fixed: 89/89 tests now pass (test suite also
grew from 85 as several agents added real assertions for their own new systems).

**Final integration verification**: clean rebuild, zero duplicate top-level declarations across
the full bundle, 89/89 `tests/run.html` passing, and a fresh hands-off soak test to game-over:
22,156 ticks (wave 37, real colony wipe confirmed via `isAliveAt`, not a bug) -- solidly inside
the established 22-36k baseline despite this being the largest single mechanics wave of the whole
session. Zero console errors across the full soak.

**Style/art note**: a separate research pass studied RimWorld's/Prison Architect's real sprite
art (viewed only, nothing copied) and wrote a concrete style brief -- muted 2-4-tone material
palettes, flat-fill-plus-single-highlight-band shading (current `assets.js` leans more toward
full gradients than this), bolder/more opaque outlines, chunky low-detail pawn proportions. A
UI/UX-layout pass (bottom-docked categorized build palette, top resource bar, tabbed side panels)
is still unaddressed -- the humanoid art half of this brief is now done, see below.

## HUMANOID STYLE-BRIEF PASS (this session): DONE

Applied the style brief above specifically to `_drawHumanoid`/`_drawAnimal` and their shared
assets.js templates (citizens, the 4 attacker archetypes, tamed dogs, wild animals -- everything
that shares one silhouette pipeline). Structures/vehicles were NOT touched by this pass (a
concurrent session was seen editing those templates independently while this one ran -- both
scopes are disjoint, no conflict).

- **Palette** (`render.js`): `ROLE_COLOR`, `ATTACKER_STYLES` body/head, the citizen skin tone
  (now `CITIZEN_SKIN = '#e1c8a8'`), and the tamed-dog coat all desaturated ~15-25% off their old
  punchy hex values (computed by hand from the originals, see the comments at each constant for
  the before/after). Hazard/attention accents were deliberately left alone: downed gray, the
  onBreak `desaturate()` tint, the Boss's pulsing threat ring + crown, and the tamed-dog collar
  (a small "this one's yours" accent) all keep their existing saturation.
- **Shading** (`assets.js`'s `humanoid_torso`/`animal_body` templates): replaced the
  `bodyShade`/`headShade`/`coatShade` linear/radial gradients with a flat base fill per part plus
  ONE solid highlight ellipse clipped to that part's own silhouette (`torsoClip`/`headClip`/
  `animalBodyClip`/`animalHeadClip`), covering roughly the top 20-30% of each shape, biased
  upper-left. `render.js` now passes `BODY_HI`/`HEAD_HI` (both `shade(color, 0.3)`) instead of the
  old `BODY_SHADOW`/gradient-stop pair.
- **Outline**: `OUTLINE` bumped from `rgba(20,16,12,0.75)` to `rgba(10,10,12,0.95)` -- true near-
  black (not warm-tinted) and near-opaque, for crisper silhouette edges at small sprite size. This
  is a single shared constant so it affects every sprite, not just humanoids -- intentional, per
  the brief.
- **Proportions**: head circle radius bumped 19->21 (recentered cy 24->23) in `humanoid_torso`,
  hair paths nudged outward to match -- a small, incremental head-to-torso bump, not a redesign.
- **Latent bug fixed in passing**: `shade()`/`desaturate()` (`render.js`) only ever parsed
  `#rrggbb` hex via `hex.slice(1)`; `desaturate()`'s own `rgb(...)` output already got fed back
  into `shade()` for onBreak citizens (`BODY_HI = shade(bodyColor, 0.3)` where `bodyColor` can be
  `desaturate(baseColor, 0.6)`), which silently produced black. Added a shared `parseColor()` that
  handles both formats; both functions now compose correctly regardless of input format.
- **Preserved, verified not just assumed**: downed dimming, onBreak desaturation + the "z" glyph,
  the health bar, the Boss's threat ring/crown and the high-contrast accessibility ring overlay,
  the walk-bob leg animation (untouched, still Canvas-drawn), tamed-vs-wild dog coat/collar
  distinction. Citizens don't have an onFire or corrupt-staff visual state today (only structures
  catch fire; staff corruption has no per-citizen render hook) -- confirmed via grep, nothing to
  preserve there.

**Verification**: `python build.py` clean, zero duplicate top-level declarations, zero console
errors on load. Visual proof via `window.__debug` + `canvas.toDataURL()` (the reliable path per
this file's own verification-pattern section -- the Claude_Browser screenshot/zoom tool still
can't composite this pane): captured citizen normal/downed/onBreak side by side (flat fill + one
clear highlight patch on head and torso, viewably larger head, crisp near-black outline, correct
health bar), Grunt/Boss attacker archetypes (crown intact, threat ring still full-saturation), and
a tamed dog (flat coat + highlight, gold collar). `tests/run.html` still reports `ALL PASSED`
(render-only change, no simulation logic touched).

## NEW GAME SETUP LAYOUT PASS (this session): DONE

User played a legally-owned reference game (Super Energy Apocalypse: Recycled) and asked for its
title/mode-select layout *pattern* adopted for this project's New Game setup screen -- explicit
hard constraint: layout/interaction conventions are fair to reuse, actual UI art/graphics are not,
and none of this pass touched or added any art (pure DOM/CSS restructure + one small procedural
`<canvas>` sketch, no copied assets). Scope was `#title-setup` in `index.html` + its wiring in
`src/main.js` only -- `#title-main` (the actual title screen) was left alone, it didn't need it.

**What changed** (every existing parameter/default preserved exactly -- `readSetupForm()` and
`beginSettlement()`'s defaults are byte-for-byte unchanged, this was a layout pass only):
- Two-column layout: left column is Map size / Attacker aggression / Storyteller, each a
  selectable control with exactly one description line reflecting the *current* selection (the
  SEA:R pattern -- previously aggression/storyteller were 3-card grids with a description baked
  into every card at once). New `buildRadioList()` in `main.js` replaces the old `buildCards()`;
  width/height sliders now share one "Map size" field with a computed small/mid/large description
  (`mapSizeDescription()`, fresh text, not copied from anywhere).
- Right column is Seed / Starting citizens plus a small seeded procedural preview canvas
  (`drawSetupPreview()`) -- not real terrain (this engine's real terrain gen has no seed-driven
  variety worth previewing yet, see "Known gaps" above), just a seeded scatter of scrap-node-style
  dots plus a starting-camp cluster sized by the citizen slider, aspect-ratio-matched to the
  current width/height. Prev/next arrows next to the thumbnail step the seed by 1 (SEA:R's
  map-browse-arrows pattern, reused as a seed nudge since this game doesn't have discrete map
  choices to page through).
- A single prominent "Start ▶" button sits top-right in its own `.setup-head` row, visually and
  structurally separate from both columns (was previously bottom-of-form next to "Back").
- `#title-setup`'s panel widened (560px -> 780px) to fit two columns; new CSS added under the
  existing `#titlescreen` scope (`.setup-columns`, `.radio-list`/`.radio-option`, `.option-desc`,
  `.preview-frame`, `.dual-slider`, `.setup-head`/`.setup-start-btn`) with a single-column fallback
  under 620px. The old `.cards`/`.card` rules are now dead CSS (nothing left references them) but
  were left in place rather than risk breaking something else that might reuse the class names.

**Verified**: full rebuild (`python build.py`), zero duplicate top-level declarations, zero
console errors through the title -> New Game -> pick Aggressive -> step seed via arrows -> Start
flow (Claude in Chrome extension, own dedicated tab -- the shared browser pane had several other
stale tabs open from earlier in this session's history, switched to a fresh tab to avoid any
cross-tab interference). Confirmed via `window.__debug.getWorld()` that every setup control's
value actually reaches the running world: one pass picking Aggressive/Cassandra/64x64/24 (mostly
defaults) matched exactly, a second pass explicitly changing every field (Calm/Randy/96x48/12
citizens/seed 42 via the sliders+radio rows+prev/next-arrow-adjusted seed) also matched exactly on
`world.aggression`/`world.storyteller`/`world.grid.width`/`world.grid.height`/`world.seed`/
`world.citizens.count`. `tests/run.html` still 89/89 (unsurprising -- no simulation code touched).

## DRAFT/UNDRAFT COMMAND SYSTEM (this session): DONE, new architectural foundation for later agents

User's explicit ask: "I do not have the same amount of control over NPCs here as I do in RimWorld"
-- RimWorld's core player-agency mechanic (draft a colonist off autonomous AI, give direct move/
attack orders, undraft to resume autonomy) had zero equivalent here. Citizens were pure autonomous
AI via jobs.js's priority ladder; the existing drag-select multi-select (see the FULL BACKLOG CLEAR
section above) explicitly punted on this ("no per-citizen command system to hook into yet"). This
pass builds that system. Framed as the architectural foundation for a wave of follow-on agents, so
priority was a clean, well-documented public surface over polish.

**New module: `src/draft.js`** -- full public interface documented in its own header comment block:
`isDrafted(world, citizenId)`, `draftCitizen(world, citizenId)`, `undraftCitizen(world, citizenId)`,
`issueMoveOrder(world, citizenIds, x, y)`, `issueAttackOrder(world, citizenIds, targetAttackerIndex)`,
`cancelOrder(world, citizenId)`, `tickDrafted(world)` (called once per tick from `world.js`'s
`tick()`, right after `tickStaffCombat`). All take citizen **ids**, not store indices, matching this
codebase's existing convention (`world.idOf`/`_jobRef` etc.).

- **State**: `citizens.js`'s `CitizenFlags` gets a new `Drafted` bit (extends the existing Dead/
  OnBreak/Downed bitflag pattern, defaults to unset so every existing citizen/save/test is
  unaffected). New per-citizen SoA fields on `CitizenStore` -- `orderKind` (0 None/1 Move/2 Attack),
  `orderTargetX/Y`, `orderAttackIndex` -- same shape/precedent as `jobState`/`_jobRef`.
- **Removal from autonomy**: `jobs.js`'s `tickJobs`, `security.js`'s `tickStaffDuty`/
  `tickStaffOffDuty`, and `siege.js`'s `tickStaffCombat` all check `store.isDraftedAt(i)` first thing
  and skip a drafted citizen entirely -- no needs-seeking, no construction/harvesting/cleaning/
  program-attending/staff-post-holding/auto-target-combat. `draftCitizen()` also immediately
  releases whatever claim they held (blueprint/workshop/animal/program-site) via a new shared
  `jobs.js` export, `releaseCurrentJobClaim` (factored out of the existing Duty-Roster sleep-
  interrupt block, which now calls the same function -- verified byte-identical behavior there).
  This is what makes the stop genuinely mid-task instant, not just "skip on the next Idle check."
- **Move orders**: reuse the exact straight-line travel approach every other travel state in this
  project already uses (jobs.js has no pathfinding, only `grid.isBlocked` for placement/wall-
  blocking) -- `jobs.js`'s `JOB_SPEED`/`ARRIVE_DIST` constants exported and reused directly, not
  reinvented.
- **Attack orders**: reuse `siege.js`'s real damage pipeline (`damageAttacker`/`rollsHit`/
  `DamageType`) and the same `GUARD_*`/`SNIPER_*` baseline stats `tickStaffCombat` uses (all four
  exported from siege.js for this reuse) -- a drafted Guard/Sniper fights with their real
  armory-issued weapon tier, any other drafted citizen fights unarmed-civilian baseline (RimWorld
  itself lets you draft/fight with any colonist). Targets an **index** into `AttackerStore`, not a
  stable id (AttackerStore has none, matching every other existing combat call site) -- documented,
  accepted edge case at 1024 simultaneous attackers, see draft.js's header comment.
- **Input**: `input.js`'s right-click was previously pan-only. Added a movement-threshold check
  (`RIGHT_CLICK_ORDER_THRESHOLD_PX`) so a right-click-and-release-without-drag is now a distinct
  "issue an order" gesture, auto-detecting move-vs-attack by what's under the cursor
  (`nearestAliveAttacker`, exported from siege.js for this). Works off the existing single-select
  and marquee multi-select uniformly. Shift+D hotkey and an inspector "🎯 Draft/Undraft" button
  (works for both single and multi-select, "unify to majority action" toggle) round out the UX.
- **Visual**: `render.js`'s `_drawCitizens` gets a small cyan ring under a drafted citizen's feet
  (same state-tint convention as onBreak's "z" glyph/Downed's gray tint) plus a dashed order-line to
  the current move/attack target -- reuses `highContrast`'s dashed-vs-solid convention.

**Verified**: full rebuild (`python build.py`), zero duplicate top-level declarations (including one
real collision caught and fixed -- `draft.js`'s own `findCitizenIndexById` helper collided with
`security.js`'s identically-named one; renamed to `_draftFindCitizenIndexById`, same underscore-
prefix convention `siege.js` already uses for its own copy). Also caught and fixed a real `build.py`
bug during this pass: multiple `export const` statements on one source line only had the first
`export` stripped (the regex is `^export\s+`, line-start-anchored) -- left a real `SyntaxError:
Unexpected token 'export'` in the bundle that silently broke the entire game (blank `window.__debug`)
until caught via console errors; fixed by putting each export on its own line, not a build.py change
(every other file in this codebase already followed one-export-per-line, this was draft.js's own
mistake). `tests/run.html` 89/89 passing unchanged (draft state defaults to false for every citizen,
confirmed no regression). Live-verified via `window.__debug` + real mouse clicks through the Claude
in Chrome extension: drafting a citizen mid-Harvesting stopped them instantly (jobState 10 -> 0,
position frozen with no order active); a move order pathed a citizen ~7 tiles and arrived/stopped;
an attack order engaged a specific spawned attacker (including a tougher Boss-kind target, watched
mid-engagement) rather than the nearest/best autonomous target, and resolved back to standing-by on
kill; undrafting resumed full autonomy (jobState left Idle on its own within the same soak). Real
screenshots captured (Claude in Chrome extension) showing the drafted-citizen ring + inspector
"Drafted -- standing by/moving to order/engaging target" states, a citizen mid-move-order (dashed
line to target tile), and a citizen mid-attack-order against a Boss (dashed line to the live target,
crown/threat-ring visible on the attacker) -- all via the real right-click gesture, not just direct
`draft.js` calls.

## GROUP DRAFT COMMANDS PASS (this session): DONE

Closed the gap the earlier drag-select section explicitly punted on ("no per-citizen command
system to hook into yet") now that draft.js exists. Investigation found most of this was already
built by the draft-system pass itself and just needed verifying, not writing: `main.js` already had
a shared `toggleDraftSelection()` (used by both the Shift+D hotkey and the inspector's `#insp-
draft-btn`) that drafts/undrafts every citizen in `input.selectedCitizens` at once with "unify to
majority action" labeling, `updateInspectorMulti()` already showed a `${draftedCount}/${alive.length}
drafted` line and toggled the same button between "🎯 Draft"/"🎯 Undraft" for the whole group, and
`input.js`'s `_tryIssueOrder`/`_draftedSelectionIds` already fed the *entire* multi-selection's ids
into `issueMoveOrder`/`issueAttackOrder` on a single right-click -- so items 1/2/4 of the ask were
already live.

**What was actually missing and got built this pass**: group move orders sent every drafted citizen
to the literal same (x, y) with no spread, so they'd path onto and stack on one tile. Added
`_formationOffset(index, total)` to `draft.js` -- a simple ring formation (citizen 0 gets the exact
clicked point, then rings of `ring*6` slots at `ring*0.55` world-unit radius) -- and changed
`issueMoveOrder` to resolve the REAL post-filter list of citizens that will receive the order first
(so formation slots aren't wasted on ids that get skipped), then assign each a `(x+ox, y+oy)` target
instead of the raw point.

**Verified**: `python build.py` clean, zero duplicate top-level declarations, `tests/run.html`
89/89 passing unchanged. Live via `window.__debug` (`javascript_tool`, Claude in Chrome extension):
drafted 4 citizens at once via the same `input.onToggleDraft()` path the UI button uses, confirmed
`isDraftedAt` true for all 4; called `issueMoveOrder` with 4 ids at one target point and confirmed 4
distinct `orderTargetX/Y` values (not identical); ran 400 ticks and confirmed all 4 arrived
(orderKind back to 0) at visibly distinct, clustered-not-stacked final positions; force-spawned a
wave, issued a group `issueAttackOrder` against one attacker, confirmed all 4 citizens' orderKind
flipped to Attack against the same index, and watched the target's health drop across multiple
citizens' hits and die within 30 ticks (not just one citizen's damage). Real screenshot (Claude in
Chrome extension) of a live drag-selected 4-citizen group post-draft confirms the inspector reads
"4 citizens selected" / "4/4 drafted -- Group averages below" / an "Undraft" button, and a zoomed
crop shows 4 separate cyan draft-rings clustered near the move target, not overlapping on one tile.

## ROUND 7 (this session): art/UI restyle + Draft/Undraft NPC-control system, ALL LANDED

User asked for the art/UI to draw more on RimWorld/PA's real visual and layout conventions
(never their actual asset files -- studied only, described in prose, all new hand-authored SVG),
plus real player-agency parity with RimWorld's colonist control model ("I don't have the same
amount of control over NPCs here as I do in RimWorld"). 11 agents, all landed and individually
verified:

**Art restyle** (5 agents, `assets.js`/`render.js`): humanoids/attackers/animals, defense
structures, power/utility structures, economy structures + vehicles, furniture + security.
Consistent brief across all five: desaturate ~15-25%, flat-fill + one solid highlight shape
(replacing full-surface gradients), outline opacity bumped ~0.75->~0.94-1.0 near-black, slightly
chunkier humanoid head-to-torso ratio. Hazard/glow accents (tesla arc, nuclear core, camera lens)
deliberately kept as full-saturation/gradient exceptions. Every state-dependent visual (destroyed,
underConstruction, overload, sited/crowded tints, monitor-station 3-way color) preserved and
re-verified, not assumed.

**UI/UX restructure** (5 agents): build toolbar recategorized into category->item-list->detail
(inspired by observing SEA:R's own build panel live), topbar got real hand-drawn icon glyphs +
primary/secondary visual hierarchy, citizen inspector reorganized into labeled sections (Vitals/
Needs/Status/Skills&Work/Room) with inline bar-fills instead of raw numbers, all 9 report/modal
panels (Research/Budget/Map/Factions/Programs/Settings/Stats/Help/Credits) got unified shared
chrome (title-bar/close-button/padding/section-header), New Game setup screen restructured into a
two-column-plus-CTA layout with a lightweight seeded preview canvas.

**Draft/Undraft NPC-control system** (`src/draft.js`, new, foundational -- built first, other work
built on its exported interface): `isDrafted`/`draftCitizen`/`undraftCitizen`/`issueMoveOrder`/
`issueAttackOrder`/`cancelOrder`/`tickDrafted`/`OrderKind`. A drafted citizen is fully removed from
`jobs.js`'s autonomous AI (no needs-seeking, no jobs) until undrafted; right-click issues a move or
attack order (auto-detected by what's under the cursor), reusing existing pathing/combat logic
rather than duplicating it. Visually distinct on the map (ring indicator). Verified: drafting stops
a citizen mid-task instantly, attack orders engage the specific ordered target instead of
autonomous nearest-target selection, 89/89 tests unaffected (draft defaults false for everyone).

**Real bug caught and fixed mid-wave**: `build.py`'s import-stripping regex only stripped the
first `export` when multiple `export const` statements shared one line -- silently broke the whole
bundle. Fixed by the draft-system agent; verify this doesn't recur if editing build.py.

**Final integration for round 7**: rebuild clean, zero duplicate top-level bundle declarations,
89/89 tests passing.

## ROUND 8 (this session), Phase B: NPC-control depth, IN PROGRESS

Continuing the user's explicit "control over NPCs" push, building directly on `draft.js`'s
interface. 5 agents launched:
- **Manual weapon-tier override** (`security.js`) -- DONE, verified. Per-staffer override of
  auto-assigned Sidearm/Rifle/Heavy, queues if armory stock insufficient, auto-promotes once
  stock allows, real combat-stat effect confirmed (not just a UI label), save/load round-trips.
- **Multi-select group draft orders** -- DONE, verified. Turned out mostly already covered by the
  draft.js foundation (draft-all/undraft-all, group move/attack already worked); the one real gap
  (formation spread so citizens don't all path to the identical tile) was fixed with a ring-
  formation offset function in `draft.js`.
- **Force/Prioritize job command** -- IN PROGRESS as of last update, not yet confirmed landed.
- **True per-citizen numeric work priorities** -- IN PROGRESS, not yet confirmed landed. Brief was
  to verify the EXISTING work-priority system (`citizens.js`'s `workPriority*` fields, built in an
  earlier wave) is genuinely per-citizen and genuinely wired into job-selection order, not just
  cosmetic, and close any real gap found.
- **Per-citizen schedule override + allowed-area zone restriction** -- IN PROGRESS, not yet
  confirmed landed.

**Check for completion notifications on these 3 before assuming this wave is done.** No
integration/rebuild/commit has happened for round 8 yet.

## ROUND 9 (this session): massive RimWorld/PA research crawl, IN PROGRESS

User: "I don't care how expensive I want this. I NEED THIS" -- explicit request to maximize
research coverage, no cost constraint. 14 research-only agents launched (read real files, report
gaps, no code changes), covering ground NOT touched by the round-6 research pass (which only
covered RimWorld Core + a sampled subset of Prison Architect's extracted files):

**RimWorld, all 5 DLCs + deeper Core** (confirmed installed: Anomaly/Biotech/Core/Ideology/
Odyssey/Royalty at `C:\Program Files (x86)\Steam\steamapps\common\RimWorld\Data\`):
- Biotech (genes/xenotype/mechanitor/growth-vats) -- DONE. Recommends: mech-companion labor
  drones (cheapest/highest value), age/lifespan multiplier table, second acquired-trait slot,
  deathrest-style overclock rest state. Explicitly recommends AGAINST body-part health, genetic
  inheritance/pregnancy/children, cosmetic gene variety, full mechanitor implant meta-game (all
  need infrastructure this project has deliberately not built).
- Ideology (precepts/rituals/memes) -- DONE. Recommends: colony-value mood-event hooks (reusing
  existing `addMoodEvent` verbatim), a gathering/ritual `ProgramKind` riding on `programs.js`'s
  existing shape, a single-tier shrine/altar buildable (+15 Beauty anchor). Skips full ideoligion/
  conversion system and specialist ability-granting roles as disproportionate.
- Anomaly (entities/horror) -- DONE. Recommends: an "anomalous activity" 0->1 meter exactly
  shaped like `rats.js`'s existing pattern (periodic roll, tiered thresholds, one-off burst
  event) -- explicitly recommends AGAINST porting the actual fleshbeast entity roster as real
  attacker-adjacent pawns (too big a surface, correctly flagged as future "5th AttackerKind" work
  if ever greenlit, with real stat anchors already extracted for that if it happens).
- Royalty (titles/permits/psycasts) -- DONE. Recommends: a citizen rank/prestige track (6-tier
  ladder off accumulated skill, real favorCost curve 1/6/6/8/10/14/20 as anchor), rank-gated
  earned abilities reusing the existing break-severity-tier machinery instead of a new resource
  meter, room-quality-gated rank-up requirements (reuses `computeRoomStats` as-is).
- Odyssey (gravships/space) -- DONE. Directly actionable improvements to the EXISTING
  `worldmap.js` (currently: expansion is completely free, no cost/risk/range-limit at all): add a
  scrap cost per expansion, a small chance-of-mishap on arrival, an upgradeable multi-hop travel
  range -- all three map cleanly onto real GravshipRange/fuel/LandingOutcome numbers.
- Items/weapons/apparel full catalog -- DONE. Flags that this project has ZERO armor/apparel
  system for anyone (citizens or staff) -- arguably a bigger fidelity gap than weapon-tier count.
  Recommends adding armor-penetration-per-tier to the existing `WEAPON_TIERS`, and a basic
  citizen armor-rating stat, ahead of just adding more weapon tiers.
- Crafting/medical/recipes -- DONE. Flags a real, already-acknowledged code gap: `citizens.js`
  around line 427 literally comments "no dedicated first-aid job yet, so recovery is passive."
  Recommends a "citizen tends downed citizen" `JobState.Tending` mechanic (real numbers derived:
  `TEND_RECOVERY_RATE ~= 0.006`, ~4x the current passive `DOWNED_RECOVERY_RATE = 0.0015`) as the
  highest-value, cheapest item found in the entire research wave. Also recommends a second
  production-chain tier (mirroring RimWorld's Steel->Component->AdvancedComponent step-up).
- Diseases/addictions -- DONE. Fully implementation-ready: a "sickness" mechanic using `rats.js`'s
  staggered-per-entity-roll pattern, real per-tick constants derived from RimWorld's actual Flu
  progression rates (0.2488/0.2388 per day, rescaled against `DAY_NIGHT_CYCLE_TICKS=2400`),
  feeding the EXISTING `addMoodEvent` system with zero new mood-blending code. Explicitly capped
  well under lethal severity (this mechanic must never kill a citizen outright, no body-part path
  exists to justify it). Addiction-lite flagged as viable but lower priority/needs more scoping.
- Incidents/events/biomes -- DONE. Real number: RimWorld Core alone has 58 distinct IncidentDefs;
  this project's periodic-roll event system (`weather.js`) has exactly 2 (wanderer-join, blight).
  Highest-priority gap: **zero positive economic event exists** -- recommends a trader/visitor-
  caravan event as the cheapest, highest-value addition (reuses `economy.js` directly, no new
  entity/render work needed).

**Prison Architect, exhaustive (not sampled) sweep**:
- Full remaining-.txt-files sweep, full prefab/object catalog, full campaign Lua deep-read (only
  the riot/*.lua scripts were read in round 6 -- conviction/deathrow/epilogue/food/grants.lua were
  NOT), audio-cue catalog, and every `_dlc`-tagged file -- confirmed PA's DLC content ships merged
  into `main.dat` as `*_dlc.txt` files, not separate archives.
- Audio: DONE. Real number: PA's `sounds.txt` defines 674 distinct event types; this project's
  `audio.js` has 5 synthesized cues. `world.onRandomEvent` already exists as an unused integration
  point for new cues (currently wired only to a toast). Prioritized list of 7 new cues for
  systems that already exist (unrest-tier escalation, mood break, program completion, faction
  demand, corrupt-staff-caught, rat infestation, weather change).
- DLC-tagged files: DONE. Confirms Hydration/Recycling-Center/CCTV/Battery/wind-solar/corrupt-
  staff already match real DLC numbers (no action needed). New/uncovered: no Exercise need
  despite ~10 real provider defs existing, no crop-farming loop, no hospitality/retail economy
  (Restaurant/Bakery/Cinema), no checkpoint/screening mechanic, no power-export economy, 3 cheap
  research nodes that would gate upgrades onto systems that ALREADY EXIST here (RecyclingIncentive
  -> Recycling Center throughput, StaffVetting -> corrupt-staff chance [note: `security.js`
  already has its own vetting-research hook per round-6 work, cross-check before adding a
  duplicate], CCTVImprovement -> Monitor Station/camera range).
- Full prefab/object catalog: DONE. Real per-object price/build-time table extracted (dozens of
  objects). Recommends, cheapest-first: a Storage room role (zone + 1 shelf-analog buildable,
  ~$6 PA-scaled), a Medical/Infirmary room role plugging directly into the existing single-float
  `health` stat, promoting the ALREADY-EXISTING `armory`+`camera`/`monitor_station` buildables
  into a formal "Command Room" role (zero new buildables needed, just a `rooms.js` classifier
  entry) -- these three need no new mechanic, only a `rooms.js` role addition.
- Still pending as of this handoff update: RimWorld's remaining-files sweep is DONE (see above,
  it was actually a round-8 RimWorld item, already folded in), full campaign Lua deep-read
  (conviction/deathrow/epilogue/food/grants.lua) STILL PENDING -- check for its completion
  notification before assuming it's done.

**IMPORTANT -- nothing from round 9's research has been implemented yet.** This is 100%
research-only so far. No subagent has been launched to build any of the above. The natural next
step once all 14 land is a large prioritized implementation wave, following this session's
established research -> gap-list -> parallel-implementation -> integration-verify -> commit
pattern. Do not assume any of round 9's findings are in the codebase without checking `git log`/
`git status` first.

**Also not yet done as of this handoff update**: round 7+8's work (art/UI/draft/weapon-override/
group-orders, all confirmed landed and individually verified) has NOT been committed to git yet.
Round 6 (`18af3f9`) is still the last commit. A full integration pass (rebuild, dedup sweep, test
suite, soak test) plus commit is owed for everything since round 6 once round 8's remaining 3
agents (force-job, per-citizen priorities, schedule/area-restriction) are confirmed landed.

## AGE/LIFESPAN PASS (this session): DONE

Added a RimWorld Biotech `LifeStageDef`-style age-band multiplier table, per research recommending
it as a cheap addition since it's just a flat-multiplier-by-band lookup, the same shape
`traits.js` already uses.

- `src/citizens.js`: new `age` field (Float32Array, ticks-since-spawn) on `CitizenStore`.
  Randomized starting age (2000-24000 ticks) on `spawn()` so a fresh colony reads as mixed-age
  from the start, not everyone "born" at tick 0. Incremented by 1 every tick for every alive
  citizen (in `tickNeedsAndMood`, regardless of downed/on-break state -- aging is passive).
  Persisted through `world.js`'s `serialize()`/`deserialize()` (old saves without the field
  default to 10000, mid-Young-band, rather than 0).
- `src/traits.js`: new `AGE_BANDS` table + `ageBandFor(age)` lookup -- Young (< 20000 ticks,
  baseline), Veteran (< 45000, workSpeedMult 0.9 / healthMult 0.95 / skillGainMult 1.5), Elder
  (workSpeedMult 0.85 / healthMult 0.88 / skillGainMult 2.5). Real RimWorld pre-teen MoveSpeed
  anchor (x0.85) adapted directionally for the elder band. The "wisdom" tradeoff (skillGainMult)
  is a deliberate design call, not in the research ask verbatim: mirrors `backstories.js`'s own
  Passion mechanic (Minor/Burning = 1.5x/2.5x) so it reads on the same scale as an existing system
  instead of inventing a new one -- an elder isn't smarter on day one, they just learn faster from
  the practice they're already getting.
- `src/jobs.js`: `ageBandFor(store.age[i]).workSpeedMult` multiplied in alongside
  `trait.workSpeedMult` at all four rate sites (Building/Harvesting/Cleaning/Processing), and
  `.skillGainMult` multiplied in alongside `PASSION_GAIN_MULT` at all three skill-gain sites
  (build-complete, harvest, workshop-complete) -- stacks with trait/passion, doesn't replace them,
  same "multiplicative, not exclusive" convention as everything else in this rate-calc chain.
- `src/siege.js`: `ageBandFor(...).healthMult` multiplied into the existing
  `(trait?.healthMult ?? 1)` toughness term at all three sites that use it (nuclear hazard damage,
  attacker-contact damage, held-citizen-crisis injury) -- higher healthMult means LESS damage
  taken per hit, same convention `trait.healthMult` already established. Also added the same
  `ageBandFor(...).skillGainMult` term to the one combat skill-gain site (`tickStaffCombat`).

**Verified** (via `tests/run.html`'s real ES-module imports, since the shared `game.bundle.js` was
being concurrently rebuilt by several other sessions at the same time this pass ran -- see the
"note on concurrent editing" below): a citizen's `age` increments by exactly ~5000 over a 5000-tick
soak (float32 rounding only); `ageBandFor` returns three genuinely distinct multiplier sets for
young/veteran/elder ages; a young citizen (age 1000) and an elder citizen (age 50000) with
IDENTICAL trait (null) and IDENTICAL skill (0.2), given the same blueprint via `tickJobs`'s real
`Building` handler, finish at a 1.176x progress ratio after 50 ticks -- exactly `1/0.85`, the
Elder `workSpeedMult`, confirming the multiplier reaches the actual job-rate calculation, not just
the lookup table. Same technique confirmed the elder citizen also takes measurably more damage per
hit via `tickAttackerVsCitizens` (0.00909 vs 0.008 health lost, ratio 1.136 = `1/0.88`, the Elder
`healthMult`). Also verified live in a real running game via `window.__debug.newGame()` +
`world.tick()` x8000: every citizen's `age` (including newly-arrived ones) genuinely climbed by
~8000 over the soak, no console errors. `tests/run.html` still 89/89 passing (re-run twice, before
and after the age-band edits landed).

**Note on concurrent editing this pass**: multiple other sessions were actively editing
`citizens.js`/`jobs.js`/`siege.js`/`traits.js` at the same time (a first-aid Tending job, a `ranks`
system, weapon-override work, `rats.js`/`anomaly.js` additions) -- the same shared-tree collision
risk documented elsewhere in this file. `game.bundle.js` briefly had a duplicate `TIER_MEDIUM`
declaration (from `rats.js` momentarily double-included by a concurrent `build.py` run racing this
one) that self-resolved on the next rebuild; not this pass's bug, not chased further since
`tests/run.html`'s direct-ES-module route gave a clean, race-free way to verify the actual
age-band logic regardless of the bundle's momentary state. Worth a fresh
`grep -oE "^(async function|function) [A-Za-z0-9_]+" game.bundle.js | sort | uniq -d` sweep next
session before trusting `game.bundle.js` at face value, given how much concurrent traffic it saw.

## Verification pattern to keep using

1. Edit `src/*.js`
2. `python build.py`
3. Open/navigate to `http://localhost:8123/index.html?v=<new number>` (cache-bust!) in a fresh
   tab (`tabs_create` then `navigate`)
4. `read_console_messages` for errors
5. Use `window.__debug.getWorld()` + a tick-loop to fast-forward and assert on state directly
   (fast, deterministic, and sidesteps the fact real-time waiting for game events is slow)
6. `document.getElementById('game').toDataURL('image/png')` -> saved via a small python snippet
   reading the tool-results JSON and base64-decoding -> `Read` the PNG for actual visual proof
   (this environment's screenshot tool cannot reliably capture the Browser pane's canvas)

## OUTPOST CHARTER CONTRACTS PASS (this session): DONE

Ported Prison Architect's real `grants.lua` mechanic (a milestone-gated grant chain: a parent
objective carries the reward, free child checklist items, hidden until prerequisites via
`Objective.SetPreRequisite`; a scaling capacity-tier ladder unlocked strictly in sequence; a
time-locked investment instrument). New `src/grants.js`, reskinned as "Outpost Charter Contracts"
-- no prison/inmate language. Wired into `world.js` (`this.grants`, `tickGrants(this)` call,
`addScrap(amt, 'grant')` finance bucket, full serialize/deserialize with old-save fallback),
`main.js` (Shift+G panel reusing the shared `.report-panel`/`.report-head`/`.grid`/`.node` CSS
pattern every other overlay uses), `input.js` (hotkey), `build.py` (`ORDER`).

Six charters: Bootstrap (free, 7-condition checklist -- wall/turret/bed built, Food+Bedroom zones
painted, 6 citizens alive, survived wave 1 -- pays 375 scrap), a 4-rung population-tier ladder
(Outpost/Waystation/District/Regional, unlocked strictly in sequence, rewards 70/110/170/260), and
an Emergency Stabilization bailout (only appears once scrap is critically low + population is
decent-sized + a sustained deficit shows in `world.finance.history`, but -- the real "strings
attached" part ported faithfully from PA -- does NOT pay the moment the crisis is spotted, it
stays pending until the settlement's own finances actually recover; pays 300). Plus a standing
investment action (not milestone-gated): pay 125 scrap, wait 1080 ticks (short) or 2520 ticks
(long), get back 220 or 400.

**Real bug caught and fixed during verification, not obvious from the task doc**: the initial
capacity-tier thresholds were flat absolute numbers (16/22/30/40) modeled loosely on PA's own
50/100/200/500 ladder. Tested live via `window.__debug` and the first two rungs completed on tick
1 for a default 24-citizen colony -- not a real milestone, just arithmetic that happened to already
be true at game start. Root cause: this engine hard-caps population growth to ~1.15x whatever a
run started with (`weather.js`'s `WANDERER_POPULATION_CAP_MULT`, plus the separate Refugee Wagon
which only replenishes losses, never grows past starting size) -- a flat ladder is either trivial
or unreachable depending on the New Game setup's starting-citizen slider (12-32). Fixed by making
thresholds relative to `world.startingCitizenCount` (`tierPopulationThreshold()`, factors
1.04/1.08/1.12/1.15, i.e. topping out just under the real ceiling) so every rung is a genuine
milestone regardless of starting size.

**Second real bug caught**: the Bootstrap checklist's "at least one wall built" condition checked
`world.structures` for a completed `wall` kind -- but a finished wall Structure gets folded into
`grid.wallThingId` permanent terrain and removed from `world.structures` almost immediately (see
`fire.js`'s own doc comment on why walls can't hold fire state). The condition would essentially
never see a wall. Fixed to read `grid.wallThingId` directly (`wallTileCount()`) instead of scanning
structures for a wall kind that's already gone by the time anything checks.

**Third fix (ordering, not a functional bug but worth noting)**: `tickGrants(this)` was originally
called early in `world.js`'s `tick()`, before `peakAliveCitizens` gets updated near the end of the
same tick -- caught via live testing (spawned 2 citizens, ticked once, tier rung didn't complete
until a SECOND tick even though peak had already crossed its threshold). Moved the call to run
right after the `peakAliveCitizens` update (and before the finance-history snapshot, so a
grant/investment payout is reflected in that same snapshot) so the ladder reacts the same tick a
population milestone is actually reached.

**Verified live via `window.__debug`** (fresh tab, `?v=` cache-bust, per this file's own
verification pattern above): Bootstrap unlocks tick 1 (always-visible) and pays exactly 375 the
moment all 7 conditions are real; a tier rung stays locked until the prior rung completes AND
`peakAliveCitizens` crosses its (starting-size-relative) threshold, then pays its reward the same
tick; the investment instrument debits 125 immediately, stays pending through tick 1343 (one short
of its 1080-tick short-term maturity), and pays exactly 220 on tick 1344 with the pending entry
removed; the bailout unlocks under a forced crisis (scrap=10, 3-snapshot deficit sum -45) but does
NOT pay across several more ticks while still in crisis, then pays exactly 300 the tick a forced
recovery (scrap=80, positive recent net) is detected. Save/load round-trip verified byte-for-byte
identical (`w.serialize()` -> `SimWorld.deserialize()`), including a pending investment. UI panel
verified via DOM inspection (6 cards render, correct labels/checklist ticks, investment button
text matches the real constants) and the Shift+G hotkey verified via a direct `input._onKey()`
call. Full rebuild, zero duplicate top-level declarations, zero console errors,
`tests/run.html` still 89/89 passing (unrelated to this pass's changes -- confirms nothing else
broke).
7. Only commit once console is clean and the specific behavior you changed is verified working

## FIRST-AID TENDING (this session): DONE

User asked to close the explicit gap flagged in `citizens.js`'s downed-recovery comment (line
~427 pre-this-pass): "no dedicated first-aid job yet, so recovery is passive rather than requiring
a medic to tend them." Real RimWorld gives a ~4x recovery-rate bonus for active tending over
untended healing -- used as the numeric anchor.

**Implemented**: `JobState.SeekingTend`/`Tending` (`jobs.js`), following the exact claim/release
pattern `Processing`/`Cleaning`/`Attending` already use. A citizen with construction OR combat
skill past the existing "Novice" bar (`TEND_SKILL_THRESHOLD = 0.15`, reusing the same cutoff
`citizens.js`'s `SKILL_INVESTED_THRESHOLD` and `main.js`'s `SKILL_LEVELS` already use -- no new
Medicine skill added, per FEATURE_RESEARCH.md's precedent) walks to and tends the nearest
unclaimed Downed ally. Checked near the top of the Idle-branch priority ladder (right after the
starvation emergency and Force Job, before the citizen's own soft rest/hunger/social thresholds).
`store.tendClaimedBy` (an id, not an index) prevents two tenders converging on one patient, same
role `claimedBy` plays for blueprints.

The actual rate swap lives in `citizens.js`: `TEND_RECOVERY_RATE = 0.006` (exactly 4x
`DOWNED_RECOVERY_RATE = 0.0015`), gated by a new `store.beingTended` per-tick flag. Ordering
quirk worth remembering: `world.js` calls `tickNeedsAndMood` *before* `tickJobs` every tick, so
`beingTended` is read-then-cleared in `tickNeedsAndMood` and re-set by `tickJobs`'s `Tending`
handler for the *next* tick -- a harmless one-tick lag, confirmed in verification below. Small
symmetric bonus/malus variance roll (`TEND_VARIANCE_CHANCE = 0.02`, `TEND_VARIANCE_MAG = 0.01`)
echoes RimWorld's real medicine-quality curve without an item-tier system. Visual: a green "+"
glyph (`render.js`, `#5ec97a`) above the head, shown on both the tender (`jobState === Tending`)
and the patient (`beingTended === 1`) -- same above-head-glyph convention as onBreak's "z" and
Force Job's orange "!".

**Verified live via `window.__debug`** (real before/after numbers, not estimated): with the world
paused between measurement windows to eliminate real-time background-tick contamination --
passive-only baseline measured at exactly `0.0015`/tick (bit-exact match to
`DOWNED_RECOVERY_RATE`); once a tender walked over and entered `Tending`, measured `0.00577`/tick
average over 20 ticks (matches the flat `0.006` `TEND_RECOVERY_RATE` within the expected variance-
roll noise -- a ~3.85x speedup, matching the "~4x" spec); after force-releasing the tender back to
Idle, the very next tick still read the stale `beingTended` flag (the documented one-tick lag) and
then reverted cleanly to `0.0015`/tick from the second tick onward. The green "+" glyph was
confirmed via a `ctx.fillText` interception on a paused, isolated citizen -- present at `#5ec97a`
only while `beingTended`/`Tending` is true, absent otherwise.

**Known limitation, consistent with existing precedent, not fixed this pass**: like
`blueprint.claimedBy`/workshop `workerId`/animal `claimedBy` elsewhere in this codebase, if the
*tender* themselves goes Downed mid-tend (e.g. caught in a raid), `tendClaimedBy` is never
released (a downed citizen never runs `tickJobs`, the only place claims get released), leaving
the patient un-claimable by a second tender until the first one recovers. Same bug shape already
exists for every other claim-bearing job type in this codebase; not introduced fresh by this
feature, not fixed here (would need a codebase-wide pass, out of scope).

**Verification**: full rebuild, zero duplicate top-level declarations (confirmed via the standard
`grep -oE "^(async function|function) [A-Za-z0-9_]+" game.bundle.js | sort | uniq -d` sweep, clean
despite heavy concurrent multi-agent activity on this same tree during this pass), zero console
errors, `tests/run.html` still 89/89 passing.

**Environment note for future passes**: this session hit heavy concurrent-agent contention on the
shared Browser pane tabs (other sessions navigating/closing tabs mid-test, `window.__debug`
intermittently `undefined` right after `navigate`, one canvas screenshot crop coming back visibly
corrupted). Opening a fresh tab per verification attempt and using the `ctx.fillText`/pixel-sum
interception techniques (rather than relying on `computer{action:"screenshot"}`, which this
project's SESSION_HANDOFF has already flagged as unreliable here) worked reliably once isolated.

## ROUNDS 7-9 INTEGRATION (this session): DONE, committed

Rounds 7 (art/UI restyle + Draft/Undraft foundation), 8 (NPC-control depth: force-job,
per-citizen priorities, group draft orders, weapon override, schedule/area-restriction), and 9
(21-agent implementation wave from the massive RimWorld/PA research crawl) all landed and are
now integrated and committed together in one pass. New top-level modules added this stretch:
`draft.js`, `forcejob.js`, `grants.js`, `anomaly.js`, `ranks.js`, `drones.js`, `sickness.js`,
`coverageplans.js`.

**Full accounting of round 9's 21 items, all landed and individually verified** (see each
agent's own report earlier in this file, or the commit log, for exact numbers):
grants/investment economy (`grants.js`), trader/visitor caravan event, tending job for downed
citizens, sickness mechanic, anomaly pressure meter (`anomaly.js`), colony-values mood hooks +
Community Gathering program + shrine buildable, citizen rank/prestige track (`ranks.js`),
worldmap expansion cost/risk/range upgrade, armor-penetration tiers + citizen vest armor, mech
labor drone companion (`drones.js`), age/lifespan multiplier table, 7 new audio cues,
Storage/Medical/Command room roles, 3 research nodes gating existing-system upgrades, Exercise
need + Gymnasium room, Coverage Plans insurance system (`coverageplans.js`), Lightning Storm
calamity (the escalating-demand item was found already covered by `factions.js`, correctly not
duplicated), unrest-weight recalibration + critical-structure watchdog + catastrophic mass-fire
event, non-lethal StunBaton + upgraded K9 tier + staff training track, crop-farming production
loop, and a WorkCredential-style arrival-skill check (found already fully covered, nothing built).

**Real cross-agent collisions caught and fixed during this stretch** (same bug class as prior
rounds -- `build.py`'s flat concatenation means same-named top-level declarations across files
silently collide, later-in-ORDER wins, no error): a genuine duplicate `TIER_MEDIUM`/`TIER_HIGH`
between `anomaly.js` and `rats.js` (renamed anomaly.js's to `ANOMALY_TIER_MEDIUM`/`_HIGH`), and
`build.py`'s `ORDER` array briefly missing `grants.js` (broke the whole bundle with a
`ReferenceError` until caught). **Final sweep after the full round-9 merge: zero duplicate
top-level declarations across the entire bundle** (`grep -oE "^(async function|function|const|let|class) [A-Za-z0-9_]+" game.bundle.js | sort | uniq -d`, both function and const/let/class forms checked).

**Known gap flagged, not yet fixed**: `programs.js`'s `assignProgramStaff()` has zero call sites
outside its own definition -- there is NO in-game UI to assign a citizen to any program staff
role (Foreman/Psychologist/Facilitator/Organizer/Instructor). Every program (Skills Workshop,
Wellness Counseling, Community Circle, Community Gathering, Guard Response Training) currently
can only be staffed via `window.__debug` in the console. Flagged as a spawned background task
(not yet acted on as of this handoff update) -- check for it before re-flagging.

**Final integration verification**: `python build.py` clean, zero duplicate declarations, 89/89
`tests/run.html` passing, fresh hands-off soak test to a real colony wipe at 24,587 ticks --
inside the established 22-36k baseline despite this being the largest single merge of the whole
session (34 files touched, 8 new modules). Zero console errors across the full soak.

## POST-ROUND-9 MANUAL AUDIT (this session): DONE, 2 real bugs found and fixed

User asked to "go over the game to see what else needs to be done" after the huge round-9 merge.
Did an actual live audit (not just re-reading agent reports) -- loaded the game, checked console,
inspected the toolbar/inspector, and diffed `TOOLS` against `TOOL_CATEGORY`/`TOOL_BLURB`
programmatically rather than eyeballing. Found two real, concrete issues:

1. **11 fully-functional buildables were invisible in the categorized toolbar.** Each of them
   works correctly (real cost, real structure/job logic, individually verified by whichever
   round-9 agent built it) but was never added to `main.js`'s `TOOL_CATEGORY`/`TOOL_BLURB` maps --
   because the categorized-toolbar UI (built by a round-7 agent) and most of these buildables
   (built by round-9 agents afterward) never coordinated on this specific map. Affected:
   `restrict-area`, `zone-storage`, `zone-medical`, `zone-command`, `zone-gymnasium`, `shelf`,
   `medical_bed`, `shrine`, `fabrication_bay`, `fitness_station`, `farm_plot`. **Fixed**: added
   all 11 to both maps in `src/main.js`. If a future pass adds a new buildable to `TOOLS`, run
   the same diff check before assuming it's reachable in the UI: `TOOLS.filter(t=>t.tool &&
   !(t.tool in TOOL_CATEGORY))` in the browser console (or `window.__debug` equivalent) should
   always return empty.

2. **The real root cause of this session's long-running "aggressive browser caching" symptom**,
   documented and worked around dozens of times throughout this file without ever being fixed:
   `index.html`'s `<script src="./game.bundle.js">` tag had **no cache-busting parameter at
   all**. Every verification this whole session used a `?v=<label>` query string on `index.html`'s
   own URL, which busts the cache for the HTML page -- but never touched the separate HTTP cache
   entry for the unparameterized `game.bundle.js` script request, so the browser could keep
   serving a stale bundle indefinitely regardless of how the page itself was navigated to. Proved
   this concretely: a real edit + rebuild + fresh-tab-with-new-`?v=`-navigate still showed the old
   behavior, but a direct `fetch('/game.bundle.js', {cache:'no-store'})` immediately showed the
   new content was being served correctly -- confirming the server was fine and the browser's own
   cache was the problem. **Fixed**: `index.html` now injects the actual `<script>` tag via
   `document.write` with a real `?t=${Date.now()}` cache-buster baked into the script's own src,
   so every page load is now guaranteed fresh regardless of the outer URL. This may retroactively
   explain some of the "tab got hijacked"/"stale state"/needed-a-fresh-tab-to-get-a-clean-result
   notes scattered through many earlier agents' reports this session -- worth keeping in mind if
   something in this file's history reads as inconsistent with the code as it exists now.

**Verified**: `python build.py` clean, zero duplicate declarations, 89/89 tests passing, the
11-tool category gap confirmed closed via the same programmatic diff check (0 missing), and the
cache-buster confirmed working live (`document.querySelector('script[src*="game.bundle.js"]').src`
showed a real `?t=<timestamp>` in a fresh tab). Not yet committed as of this handoff update.

## POWER EXPORTER (real PA DLC mechanic ported): DONE

Implemented the Transformer/PowerExportMeter/QuickConnect idea from the round-9 research notes: a
new `power_exporter` buildable (`economy.js` cost 42, `input.js` hotkey SHIFT+E, `main.js`
category `power` + blurb, `render.js` transformer-pylon Canvas shape with a pulsing scrap-arrow
that only lights up while actively exporting) that converts a power segment's GENUINE spare
capacity into a slow scrap trickle.

Core logic lives in `power.js`'s new `tickPowerExporters` (called from `world.js`'s `tick()`
right after `tickBatteries`, same calling shape, reports through `world.addScrap(amt,
'powerExport')` -> new `finance.powerExportScrap` bucket). Deliberately reuses
`computeSegmentLoads` (exported for this purpose -- the exact same raw capacity-minus-load number
`tickBatteries` already uses to gate battery charging) rather than a parallel calculation, so the
exporter can never claim capacity a battery or a real consumer would have gotten instead. Two
stacked safety margins: `POWER_EXPORT_RESERVE_MARGIN` (1.5 raw capacity units held back untouched
before anything is exportable) and `POWER_EXPORT_FRACTION`/`POWER_EXPORT_MAX_PER_TICK` (only a
small slice of what's left, capped, converts per tick -- a real trickle, not a drain). Recomputed
fresh every tick (not cached), so a new downstream consumer's load shows up in the very next
tick's export calculation, no lag.

**Verified live via `window.__debug`** (generator capacity=5, one exporter, `POWER_EXPORT_
RESERVE_MARGIN=1.5`, `POWER_EXPORT_FRACTION=0.12`, `POWER_EXPORT_MAX_PER_TICK=0.15`):
- Generator + wire + exporter, no other consumers: surplus = 5 - 0 - 1.5 = 3.5, export hits the
  0.15/tick cap immediately; `finance.powerExportScrap` accumulated exactly 45.0 over 300 ticks
  (0.15 x 300), confirmed via direct scrap-bucket read, not just `world.scrap` (which also moves
  from harvesting).
- Added 3 turrets on the same segment (load=3): surplus = 5 - 3 - 1.5 = 0.5, export rate dropped
  to exactly 0.06 (0.5 x 0.12) -- a genuine proportional SHRINK, not a binary cutoff.
- Added a 4th turret (load=4): surplus = 5 - 4 - 1.5 = -0.5, export rate dropped to exactly 0,
  `finance.powerExportScrap` delta over the next 100 ticks was 0.0, and
  `isSegmentOverloadedAt(structures, wireX, wireY)` stayed `false` throughout -- confirms it never
  causes or contributes to an overload, it just goes quiet.
- `TOOLS.filter(t=>t.tool && !(t.tool in TOOL_CATEGORY))` and the same check against `TOOL_BLURB`
  both returned `[]` -- the toolbar-completeness gate from the note at the top of this file, still
  clean after this addition.

**A live collision hazard worth remembering**: this pass landed while at least 3-4 OTHER
concurrent agents were actively editing this same tree (a restaurant buildable, a checkpoint
buildable, a cinema buildable, an epidemic/sickness system, a supplies/tainted-delivery system,
and an augments system all landed mid-session). Three of those left `build.py`'s `ORDER` array
missing their new file (`epidemic.js`→fixed by another agent before this pass finished,
`supplies.js` and `augments.js`→both fixed live during this pass's own verification, since a
broken bundle blocked testing the Power Exporter itself). If a future session hits a
`ReferenceError: initXxx is not defined` or similar at `new SimWorld`, check `build.py`'s `ORDER`
for a missing entry before assuming it's a logic bug -- this is now the second session in a row
this exact failure mode has shown up from a concurrent multi-agent pass.

**Verified**: `python build.py` clean, zero duplicate top-level declarations across the full
bundle, zero console errors placing/ticking the new buildable, and `tests/run.html` at 88/89 (the
one failure, "the builder gains construction skill on completion", is unrelated to this pass --
not touched by any file this change modified -- and was already failing before this work started,
almost certainly from one of the concurrent sessions' work; worth a fresh look next session).

## MASS-DESIGNATION MARQUEE (this session): DONE

User's ask, explicitly scoped as "inspired by the general concept" of a well-known RimWorld QoL
mod category (mass-designate-via-drag), described from public reputation only, built entirely
original: a way to Force-Job-designate many targets at once via the same marquee-drag gesture
`input.js` already uses for multi-citizen select, instead of clicking each target one at a time
via `forcejob.js`'s existing single-click Force Job gesture.

**Mode switch, design call**: held **Alt** at the moment the drag starts (`_onDown`, Select tool
only) switches the SAME drag gesture from "marquee-select citizens" to "marquee-designate job
targets" -- tracked as a new `this._marqueeDesignate` instance flag on `InputController`, not a
separate toolbar tool, so it's still only ever reachable with the Select tool and never collides
with build-tool painting. Chose a modifier over a dedicated toolbar entry because every other
"alternate behavior on the same gesture" precedent in this codebase (`_tryIssueOrder`'s
drafted-vs-undrafted auto-detect, `power_switch`'s click-to-toggle) already reads context off the
existing gesture rather than adding a mode button, and the toolbar is already extremely dense
(50+ single-key entries, see `TOOLS` in `input.js`).

**Implementation** (`src/input.js`): `_onDown`'s Select-tool branch checks `e.altKey` first --
if set, skips `_pickCitizen` entirely (an Alt+click shouldn't select whoever's under the cursor)
and arms the marquee with `_marqueeDesignate = true`. `_onUp` branches on that flag once the drag
exceeds the existing 0.5-world-unit click-vs-drag threshold, calling the new `_massDesignate`
instead of the existing citizen-picking loop. `_findJobTargetsInBox` is the box variant of the
existing single-point `_findJobTargetAt` -- same four `ForceJobKind` categories the single-click
Force Job gesture already supports (unclaimed blueprint, resource node, messy room, unstaffed
workshop); farm_plot/program-station staffing are NOT `ForceJobKind` values yet (see forcejob.js's
own header), so a drag over those doesn't pick them up either -- extending `ForceJobKind` itself
would be the natural follow-up, out of scope for reusing the existing claim logic as asked.
`_massDesignate` calls `forceJob`/`pickClosestUndraftedCitizen` (both from forcejob.js, unmodified)
in a loop over every target found, assigning each to the closest currently-**idle**, undrafted
citizen not already used by an earlier target in the same drag (so N targets and M idle citizens
spread across up to min(N,M) citizens instead of dog-piling one citizen). Deliberately idle-only,
unlike a single Force Job click (which DOES interrupt whatever a citizen is doing) -- a drag over a
dozen targets yanking a dozen already-working citizens off their current task would read as a
hostile mis-click. Leftover targets beyond the idle-citizen count are simply left unforced; the
normal autonomous ladder (jobs.js) picks them up the next time someone goes Idle on their own,
nothing is lost. `render.js`'s `_drawMarquee` reads the same flag to color the box orange
(`#ffb020`, matching forcejob's own pending-order "!" glyph color) instead of the default cyan, so
the mode reads clearly at a glance while dragging.

**Real bug found and fixed during this pass's own verification, not pre-existing behavior this
pass relied on**: a Guard/Sniper/K9Handler/Monitor holding their post (`world.isStaffOnDutyAt(i)`)
never runs `jobs.js`'s `tickJobs` Idle branch at all (staff are skipped before the state read), but
their `jobState` SoA slot is simply left at its default `0` (Idle) forever since they never enter
any job state through that branch -- they LOOK idle by every check `_massDesignate`'s naive
idle-scan was using. Without excluding them, a forced job assigned to on-duty staff would sit
unconsumed forever (`tryClaimForcedJob`, the only place that ever clears `forcedJobKind`, lives
inside the very branch staff never reach) -- caught live: a first test run over a box containing 4
staff citizens left all 4 with `forcedJobKind` set and `jobState` still `0` after 87 real ticks,
zero blueprints ever got claimed. This same latent trap exists in the single-click Force Job
gesture too (`_tryIssueOrder`/`pickClosestUndraftedCitizen` don't filter staff either) but is far
more likely to bite via a mass-designate drag, which sweeps up whoever LOOKS idle in bulk rather
than one player-chosen citizen at a time. Fixed by adding `world.isStaffOnDutyAt(i)` to
`_massDesignate`'s own idle-candidate filter; the single-click gesture's version of this same bug
was left alone (out of scope for this task, worth a follow-up).

**Verified**: `python build.py` clean, zero duplicate top-level declarations across the full
bundle, zero console errors. Direct-logic test via `window.__debug` (`input._massDesignate(world,
x0,y0,x1,y1)` called directly): 7 blueprints + resource nodes spread across a 40x40 map, all
correctly force-assigned to 19 distinct idle non-staff citizens in one call (confirmed by distinct
`claimedBy` ids after ticking), 5 genuinely on-duty staff correctly excluded from the idle pool.
Real end-to-end gesture test via actual DOM `MouseEvent` dispatch on the canvas (`mousedown` with
`altKey:true` -> `mousemove` -> `mouseup`, exercising the real registered event listeners, not
calling internal methods directly) over 3 fresh blueprints: `input.selectedCitizens` stayed empty
(confirms designate mode never falls back to citizen-select) and 3 distinct citizens (ids 6/7/8)
each claimed a different blueprint over the following ticks. A real plain (non-Alt) drag over a
cluster of citizens, tested via the `computer` tool's actual pixel-space mouse drag (coordinate
mapping confirmed via a calibration click first -- this environment's screenshot/computer-tool
pixel space is scaled ~0.8167x relative to the page's CSS px, `1568x703` vs `1920x861` at
`devicePixelRatio:2`, consistent with this file's other computer-tool caveats), selected the
correct 5 citizens with `_marqueeDesignate` correctly false throughout -- confirms the existing
citizen-marquee-select gesture is completely unaffected outside Alt-drag. `tests/run.html`: 121/122
passing, the one failure (`"the builder gains construction skill on completion"`) is the same
pre-existing, already-documented failure from the Power Exporter pass immediately above --
unrelated to this pass, not touched by either file this change modified (`input.js`/`render.js`).
Not yet committed as of this handoff update.

## ROUND 10 (this session): backlog clear + "mod-concept" adaptation wave, DONE

User asked for everything remaining in round-9's backlog EXCEPT zombie mode, then separately asked
to "adapt" well-known RimWorld/Prison Architect mod CONCEPTS (not their actual content -- see the
explicit copyright line held throughout this conversation: reading a base game's own shipped Defs/
Lua is fine since it's shipped as plaintext for modding, but a third-party mod is an independent
copyrighted work licensed for use *within* that game, not for extraction into an unrelated project,
regardless of scale or popularity). Two waves, 16 agents total, all landed:

**Backlog wave (9 items, all done)**: gang territory/lieutenant/graffiti refinement (`factions.js`),
tropical-fever proximity-spread epidemic distinct from `sickness.js` (`epidemic.js`, new),
tainted-shipment/contraband-in-supply mechanic (`supplies.js`, new), Cinema group-broadcast
buildable, Restaurant retail-income loop, power-export economy (Power Exporter buildable),
Checkpoint (reduces corrupt-staff/faction-consequence severity near it), Security Response
Coverage Plan (3rd plan, reinforcement call-in), resource-gift event + a rare/long-cooldown
map-wide hazard condition distinct from weather -- both in `weather.js`.

**Mod-concept-adaptation wave (5 items, all done, each an ORIGINAL implementation inspired only by
a mod's public reputation, never its actual code/text/art)**: a pre-game "Customize Starting
Colonists" screen (re-roll/rename via the real existing backstory/trait roll functions, no direct
stat-value editing), an Ammo + Suppression combat layer (`security.js`/`siege.js` -- weapons now
consume a global ammo pool replenished by Armories, sustained fire suppresses accuracy), a Hygiene
need tied to the existing water-plumbing grid (`water.js`), a mass-designation Alt-drag marquee
mode (queues Force Job on every valid target in the drag box, not just one), and a Scavenged
Augments system (`augments.js` -- purchasable permanent stat trade-offs, distinct from the earned
`ranks.js` ladder).

**Two real cross-agent caching bugs found and fixed during final integration, same root-cause
class as `index.html`'s already-fixed bug**: `tests/run.html` also had zero cache-busting on its
dynamic test-file imports (fixed, with a hard-learned caveat: `harness.js` must stay a bare,
non-cache-busted import since every test file also imports it via a bare specifier -- cache-busting
it separately would split it into two module instances with two independent `results` arrays and
silently break `renderSummary`), AND `run.html`'s own outer HTML had no cache-buster on ITS OWN
url either -- meaning even after fixing the inner imports, a bare navigation to `/tests/run.html`
could still execute a stale cached copy of the page that never runs the fix at all (a genuine
bootstrapping problem: a fix living inside a document doesn't help if the document itself is
served stale). Added a self-redirect-once-with-a-fresh-marker script, though note this can't
retroactively un-stick an ALREADY-cached copy from before the fix landed -- if `tests/run.html`
ever seems to be running stale content again, manually append `?t=<anything>` to force a real
fetch. **This same "outer HTML page itself might be served stale, not just its sub-resources"
risk plausibly also still affects `index.html`** even after its earlier fix (that fix handles
`game.bundle.js` staying fresh, but if the browser has an old cached copy of `index.html` itself
from before that fix was added, a bare navigation could still run pre-fix HTML) -- worth actively
checking for, not assuming fixed, in a fresh browsing session.

**Real, legitimate bug found and fixed via this pass's manual test-suite audit** (not a caching
issue): `tests/vehicles.test.js`'s "the builder gains construction skill on completion" assertion
predated the backstory-skill-penalty feature (some backstories now legitimately start
`skillConstruction` negative as a real tradeoff, added earlier this session) -- the test asserted
`skillConstruction > 0` when it should have asserted the value *increased from wherever it
started*. Fixed the test, not the game logic. Confirmed fixed: **122/122 tests passing** once the
caching bugs above were also worked around.

**CRITICAL -- unresolved balance regression, top priority to investigate next.** A hands-off soak
(zero player building beyond the starting structures) now falls in ~10-12k ticks across 3 seeds
(42/12345/777), down hard from the established 22-36k baseline -- confirmed reproducible, not
noise, and confirmed NOT a crash (zero exceptions thrown in any run). Investigated one real,
confirmed contributing cause and fixed it: `security.js`'s new ammo system gave a hands-off colony
(which never builds an Armory) literally zero ammo regen once its `AMMO_BASE_CAPACITY` (40) ran
dry, permanently crippling turrets/guards to their heavy dry-fire penalty for the entire rest of
the game -- added a small always-on `AMMO_BASE_PRODUCTION = 0.02` trickle independent of Armory
count. **This fix alone was NOT sufficient** -- re-soaked after it, survival barely moved
(11.3k/10.2k/11.7k, essentially unchanged). A deeper tick-by-tick trace (seed 42) shows the real
proximate cause is different and more systemic: **`world.scrap` collapses to 0 by tick ~2000-3000
(wave 2-3!) and stays there for most of the game**, and **`world.unrestTier` hits its max (3) by
tick 5000 and never recovers**, creating a real compounding spiral (low wellbeing -> max unrest
-> rate penalties + violence events -> citizens work/harvest slower -> economy stays broke ->
needs stay unmet -> wellbeing stays low -> unrest stays maxed). This round landed an unusually
large number of independent PASSIVE scrap-drain and rate-penalty systems in one merge -- faction
unmet-demand scrap loss, corrupt-staff diversion, anomaly-pressure scrap drain, tainted-shipment
effects, epidemic/sickness work-rate penalties, gang food-fight damage -- each individually
soak-tested and verified correct IN ISOLATION by its own agent, but nothing tested their combined
effect on one colony at once. This is the same "systemic compounding" bug class this session has
hit and fixed before (the wanderer-join population-cap bug from an earlier round, the
`colonyStrength` sqrt-diminishing-returns fix) -- **next step**: instrument a hands-off soak to
log exactly which drain source(s) account for the scrap collapse and the earliest unrest-tier-3
trigger (the tick-1000/2000/3000 snapshots already show scrap hitting 0 well before wave 3, i.e.
before combat losses alone plausibly explain it -- check the passive drains first, not combat
damage), then retune whichever constant(s) are actually dominant rather than guessing further.
Do NOT assume the ammo fix above resolved this -- it's real and correct but demonstrably
insufficient alone.

**Final integration for round 10**: clean rebuild, zero duplicate top-level declarations, 122/122
tests passing (once caching quirks above are worked around), zero console errors and zero
exceptions across multiple full soak tests. **Committed as `b60a823`** (superseding the earlier
"not yet committed" note above -- the balance regression was documented and committed with it
clearly flagged, rather than held back).

**Stale duplicate bug report received and checked, already resolved**: a report describing "the
builder gains construction skill on completion" failing (89 total/88 passing) with a hypothesized
`PASSION_GAIN_MULT[undefined]` NaN root cause came in after `b60a823` was already committed. Live
`tests/run.html` check confirmed 122/122 already passing with the real fix from `b60a823` visibly
applied (`"the builder gains construction skill on completion (-0.0300 -> -0.0100)"`). The
hypothesized root cause doesn't match what was actually found: `passionConstruction` is never
`undefined` via the real `CitizenStore.spawn()` path (it unconditionally calls
`randomPassions()`), confirmed via direct reproduction. The real cause (see the "real, legitimate
bug" paragraph above) was the test's stale assumption that skill starts at 0, which a concurrent
earlier feature (some backstories legitimately starting `skillConstruction` negative) had already
invalidated. Added the suggested `?? 1` defensive guard to all 5 `PASSION_GAIN_MULT[...]` call
sites in `jobs.js` anyway as cheap, harmless insurance -- rebuilt clean, zero duplicate
declarations. Not yet committed as its own change as of this handoff update (bundled with
whatever lands next).
