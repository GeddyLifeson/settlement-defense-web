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

## NOT STARTED -- next major features, roughly in the order the user asked for them

1. **Finish items above**, commit.
2. **World map / conquest layer** (explicit ask, Helldivers-2-style control meter per region,
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
3. **Comprehensive RimWorld/Prison Architect/SEA:R feature inventory via subagents** (explicit
   ask: "make subagents... more comprehensive and thorough acquisition"). Not started. Suggest:
   spawn parallel research agents (one per source game) to produce an exhaustive mechanic list,
   then a synthesis pass mapping each mechanic to a non-carceral equivalent for this game,
   before implementing more. Don't skip the synthesis/dedup step -- three raw lists dumped
   together will have overlapping asks (e.g., all three games have some form of "priority
   queue for jobs").

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
