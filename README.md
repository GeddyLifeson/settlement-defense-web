# Settlement Defense (Web)

A RimWorld / Prison Architect / Super Energy Apocalypse fusion, ported from an earlier Unity/C#
build into plain JavaScript + HTML5 Canvas. No build step, no external dependencies, no AI-
generated art — every sprite is drawn procedurally with Canvas 2D primitives.

## Running it

**Just double-click `index.html`.** It loads `game.bundle.js`, a plain classic script (not an
ES module), specifically so it works straight from `file://` with no server. If you'd rather
serve it (e.g. for the browser devtools' network tab), any static file server works too:

```
python -m http.server 8123
```

### If you edit anything in `src/`

`game.bundle.js` is generated, not hand-written. After changing any file in `src/`, rerun:

```
python build.py
```

`index.html` always loads `game.bundle.js`, never the `src/` files directly -- if you edit
`src/` and forget to rebuild, you'll be testing stale code.

## Controls

- **1-4**: select a build tool -- Wall ($2), Turret ($25), Fence ($3), Trap ($15)
- **5-7**: paint a zone -- Food, Bedroom, Recreation
- **0 / Escape**: back to select mode (click a citizen to inspect them)
- **Left click / drag**: place the selected structure or paint the selected zone
- **Space**: pause/unpause
- **+ / -**: speed up / slow down (1x-4x)
- **F5 / F9**: save / load (browser localStorage)
- **R**: abandon this settlement and start a new one

## What's simulated

- Citizens: hunger/rest/social needs, mood, mental breaks, combat/skill XP, friendships
- Real Eat/Sleep/Recreation job AI -- citizens walk to the nearest matching zone when a need
  gets low, and idle-wander otherwise
- Staff roster: guards and snipers hold an assigned post and fight back with their own
  weapon range/damage, separate from turret coverage
- Wave spawner + Director AI: wave size/timing scale with colony strength (citizen count,
  structure health, scrap on hand), so the siege chases player capability rather than following
  a fixed schedule
- Turrets (auto-target in range), fences (block attackers, take contact damage, destructible),
  traps (single-use burst damage)
- Scrap economy: kills pay out scrap, building costs it
- Permadeath: citizens caught by an attacker take damage over time and die at 0 HP
- Win/loss: the settlement falls when every citizen is dead; `R` starts a fresh run

## Source layout

Each file carries forward one piece of the original Unity project's C# assembly split:

| File | Ported from |
|---|---|
| `src/core.js` | SD.Core (RNG, shared types) |
| `src/grid.js` | SD.Facility/SettlementGrid |
| `src/zones.js` | SD.Facility zoning |
| `src/citizens.js` | SD.Sim (CitizenStore, needs/mood) |
| `src/jobs.js` | SD.Sim real Eat/Sleep job execution |
| `src/relationships.js` | SD.Sim relationship web |
| `src/security.js` | SD.Security (StaffRoster, guard/sniper AI) |
| `src/siege.js` | SD.Siege (attackers, turrets/fences/traps, wave spawner) |
| `src/director.js` | SD.Director (storyteller pacing) |
| `src/economy.js` | SD.Siege scrap balancing |
| `src/world.js` | SD.Headless/SimWorld (composition root, tick loop, save/load) |
| `src/render.js` | SD.Presentation (Canvas 2D renderer, procedural sprites) |
| `src/input.js` | player build/zone/inspect input -- did not exist in the Unity build |
| `src/main.js` | SD.Presentation/SimWorldHost (bootstrap, game loop) |

`window.__debug = { getWorld, input, renderer }` is exposed in `main.js` for poking at live
state from the browser console.

## Balance notes

Soak-tested via `window.__debug.getWorld().tick()` loops (see git history): a fresh colony
with zero player intervention beyond the starting 4 turrets holds for roughly 35-40 minutes
(~40 waves) before the Director's difficulty ramp overwhelms it -- by design, the player is
expected to spend accumulated scrap on more turrets/fences as waves escalate. Needs-decay and
job-travel constants were tuned so average mood stabilizes around 0.4-0.5 rather than trending
toward the mental-break threshold, which happened with the first-pass numbers.
