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
7. Only commit once console is clean and the specific behavior you changed is verified working
