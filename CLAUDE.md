# Settlement Defense (web)

Browser colony-defense sim, a JavaScript port of the Unity project at `C:\Users\imarl\settlement_defense` (now frozen as reference). This is the active line.

## The rule

Edit `src/`, then run `python build.py` (`C:/Users/imarl/miniconda3/python.exe build.py` from git-bash). `index.html` loads `game.bundle.js`, not `src/`. Reload with a cache-busting `?v=N`.

## Route

| Need | Go to |
|---|---|
| what each `src/` file does | `SESSION_HANDOFF.md`, section "Architecture -- file map" |
| current state, what's next | `SESSION_HANDOFF.md` (about 200 lines) |
| full pass history | `docs/history/SESSION_HANDOFF_full.md`: 2,016 lines, grep `^## `, never read whole |
| feature research | `FEATURE_RESEARCH.md` |
| design spec | `C:\Users\imarl\settlement_defense\design\GDD.md`, `ARCHITECTURE.md` |
| run, controls | `README.md` |
| tests | `tests/run.html` |

## Rules

- `build.py` concatenates `src/*.js` in a fixed `ORDER` list: a new module goes into that list.
- `src/world.js` owns every store and the tick order; `src/jobs.js` is the central job-priority machine.
- Live state from the browser console: `window.__debug.getWorld()`.
