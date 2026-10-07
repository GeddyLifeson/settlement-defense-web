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


## History

Every pass from the port onward (rounds 1-10, waves, audits) is in `docs/history/SESSION_HANDOFF_full.md`, 2,016 lines. Grep it by `^## `; never read it whole.

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


## Game-feel audit (this session, immediately after the roadmap wave)

User feedback, verbatim in spirit: the game has all the mechanics now but doesn't *feel* right,
and doesn't feel like any of RimWorld/Prison Architect/SEA:R despite porting real numbers from all
three. Asked to actually fix that, not port more mechanics. Correctly read as a different KIND of
work than the two waves above -- diagnosed by actually driving the live game (not just headless
`window.__debug` calls, which is most of what this session had done up to this point) before
touching any code.

**Root cause #1, confirmed with real measurements, not guessed**: `#topbar`'s `scrollWidth` was
2271px inside a 1258px container (`overflow-x: auto`, no visible scrollbar affordance) -- every
one of this session's ~15 new panel/system buttons had been added directly to the always-visible
row with nothing ever checking whether they still fit. Concretely, mid-game, a player could not
reach Save, Load, Help, Fullscreen, Sound, New Settlement, or 5 of the 9 report panels (Programs,
Charters, Contracts, Coverage, Drones) without discovering an invisible horizontal scroll. **Fixed**
(commit `fa7c3d8`): collapsed all 9 panel launchers + the rarely-needed system actions (Help/Save/
Load/New -- Save and Settings are already reachable via the pause menu) into one "☰ Menu" dropdown
trigger; Fullscreen/Sound stay inline as the two genuinely frequent single-click toggles. Every
button kept its exact original id/handler/hotkey -- only the container changed. Verified live:
dropdown opens/closes, picking a panel opens it AND auto-closes the dropdown, content width cut
2271px -> 1091px, 133/133 tests still passing. This also fixes the actual root cause, not just the
symptom -- a future panel now costs one dropdown line, not one more permanent topbar slot.

**Root cause #2, identified but NOT yet fixed, flagged for the user before proceeding**: the build
toolbar (`#toolbar`) DOES have category headers (Defense/Power & Water/Economy & Vehicles/
Furniture/Security/Zones) but renders every buildable across every category as one continuous
always-expanded 648px-tall column, all visible simultaneously. This is structurally different from
how all three reference games actually present their build menus (RimWorld's architect menu:
compact category icons, click one, get a flyout of just that category; Prison Architect: the same
click-a-tab pattern). Every one of today's new buildables (turret tiers, mortar, traps, valve,
demolish) just extended this same flat always-expanded list further. This is very likely a second
real contributor to "doesn't feel like any of the three games" -- diagnosed via the same live-DOM-
inspection method as root cause #1, not yet touched. Given this is a genuine design/redesign
decision (not a mechanical bug fix like the topbar), stopped here to check in with the user on
direction rather than silently redesigning it, matching the explicit feedback that drove this
whole audit (don't just keep producing large silent output).

Also had real environment friction this session unrelated to game code: the dev server this whole
session had been running on died at some point (another chat's server was occupying the port by
the time this was noticed), and the Browser pane's viewport was reporting `innerWidth: 0`
(not composited/displayed) for several verification attempts -- neither is a game bug, both are
noted here so a future session recognizes the symptoms immediately (`ERR_CONNECTION_RESET` on a
freshly-navigated page + `window.__debug` staying `undefined` = the server connection reset
mid-load, just reload again; `window.innerWidth === 0` on every element = the pane isn't currently
displayed, box-model reads off individual elements' `getBoundingClientRect()` are still valid, only
the global `window.innerWidth`/screenshot compositing is affected). Registered this project's dev
server properly in `C:\.claude\launch.json` (was previously only in a per-project, unread
`.claude/launch.json` that the harness never actually looks at) as `settlement-defense-web`, port
8199, so `preview_start({name: 'settlement-defense-web'})` works cleanly going forward instead of
an ad-hoc background `python -m http.server` call the harness doesn't track.

Not yet committed as of this handoff update (this section only -- the topbar fix itself is already
committed as `fa7c3d8`).

### Follow-up: build-toolbar "giant dead-space panel" bug (user said "DO IT ALL", proceeded)

Went back into `#toolbar` (the build panel) expecting to have to do the category-flyout redesign
flagged above as undone. Turned out that redesign already exists in `src/main.js` -- category grid
-> that category's item list -> a detail-before-commit readout, exactly the RimWorld/Prison
Architect click-a-category pattern this audit was about to go build. Verified this live before
writing any code (`toolbar-items`/`toolbar-categories`/`toolbar-detail` all present and behaving
correctly, 0 items rendered when no category is open) rather than trusting the prior session's
"648px flat list" read at face value -- that number was real but the diagnosis attached to it was
wrong.

Actual bug: `#toolbar`'s CSS pinned `top: 60px; bottom: 10px` -- a fixed-position element told to
span from just under the topbar to just above the screen edge, *regardless of how much content it
actually held*. Since `.panel` (its class) paints a solid background/border/blur, this rendered as
a large bordered card sitting on the left edge of the screen at all times, most of it empty --
confirmed live: with no category open the real content was 249px tall inside a 650px card, i.e.
~400px of dead space above just the Select/Demolish buttons and 6 category icons. This is exactly
the kind of thing that reads as "doesn't feel like any of the three games" -- none of them show a
giant mostly-empty panel by default.

**Fix** (`index.html`, CSS-only, no bundle rebuild needed): dropped the `bottom: 10px` anchor,
replaced with `max-height: calc(100vh - 70px)` -- the panel now hugs whatever it's actually
showing, with the old full-height value kept only as an upper cap for the one category that can
legitimately get tall (Economy & Vehicles, 14 items). Added `flex: 1 1 auto; min-height: 0;` to
`#toolbar-body` so the existing `overflow-y: auto` on that element actually engages once the cap is
hit, instead of the flex column just growing past it. Verified live via `getBoundingClientRect()`
across all three states: no category open 650px -> 249px, header fully collapsed -> 45px, Economy
(largest category) open -> correctly caps at 650px and scrolls its item list internally rather than
overflowing the viewport. 133/133 tests still pass (CSS-only change, but reran the full suite for
the same "trust nothing, verify everything" discipline this session has followed throughout).

Committed as `dee9a1b`.

### Follow-up: systematic sweep for the same class of bug, 3 more found and fixed

Once the toolbar's own dead-space bug was fixed, went looking for the same root cause elsewhere --
any fixed-position HUD panel whose coordinates were hand-picked against an older, differently-sized
neighbor and never re-checked as neighbors changed shape over this session's many feature waves.
Method: pull every non-modal fixed-position panel's `getBoundingClientRect()` live (modals using the
shared `inset:0` + `.box{max-height:92vh;overflow:auto}` pattern from the menus/UX wave were trusted
as already correct and not re-audited) and check pairwise overlaps / off-screen extents. Found three
more real bugs this way, all committed individually:

1. **Grading popover overlapped the toolbar by 30px** (`f576844`) -- positioned off a comment
   estimating "toolbar ends around x=170"; the toolbar's real right edge is x=230. Moved to
   left:240px.
2. **Event log overlapped the toolbar by 50px** (`d045d10`) -- same stale-coordinate root cause,
   worse in practice since both a tall toolbar category and a populated event log are *common*
   states in normal play, not edge cases. Moved to left:240px.
3. **Citizen inspector was silently losing ~half its own content off-screen** (`31e1333`) -- the
   single biggest find of this sweep. `#inspector` had no `max-height`/`overflow` at all; with a
   fully-loaded citizen (traits/skills/health/augments/buttons) it measured 1240px tall against a
   720px viewport. The page is `overflow:hidden` (fixed-layout game UI, not a scrolling document),
   so everything past ~660px -- augment slots, several stat rows, the action buttons -- was
   permanently invisible and unreachable, with no visual indication anything was missing. This had
   been getting silently worse every time a feature wave added one more stat row to the panel, all
   session, and is very likely the single biggest concrete contributor to "doesn't feel right" of
   everything found in this whole audit: the most-used panel in a RimWorld-like was losing content.
   Fixed with the same `max-height: calc(100vh - 70px); overflow-y: auto` pattern as the toolbar.
   Same commit also fixed the minimap (`right:10px`) painting directly over the inspector's column
   (`right:10px; width:240px`) whenever both were visible -- moved the minimap to `right:260px`.

All four fixes verified live via `getBoundingClientRect()`/`scrollHeight` before and after (not
screenshots -- the Browser pane's compositor has been unavailable this whole session, a known
environment artifact, not a game bug); 133/133 tests re-run and passing after each one.

Not yet committed as of this handoff update (this section only -- all four fixes above already are).
