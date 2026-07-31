# Feature Research — RimWorld / Prison Architect / SEA:Recycled

Three parallel subagent research passes (web search, not just training-data memory), run per
the user's explicit request to comprehensively inventory all three source games before
continuing to build. Raw agent output preserved in full below each summary since it's
expensive to reproduce and cheap to keep as a file. **This is a reference/planning document,
not yet an implementation plan** — read it, then update SESSION_HANDOFF.md's priority list
before building more.

## Cross-game synthesis (my read, after all three came back)

**The load-bearing insight from all three agents, independently arrived at**: almost none of
Prison Architect's mechanics are actually carceral *in mechanism* — flood-fill room detection,
power/water graphs, staff patrol routes, CCTV, K9 sniffing, needs-driven population sim,
day/night schedules, and crisis-state-machines (riot/fire/contraband) are all genre-neutral
simulation tech that happens to be reskinned around a prison. Only four things are genuinely
carceral and need real rework rather than reskinning:
1. The prisoner/warden capture-recruit-or-imprison loop (RimWorld has this too, via downed
   raiders) — replace with non-lethal takedown → exile/ransom/persuade-to-join, no cells.
2. "Prison cell" as a room role — drop; add guard post/kennel/barracks/infirmary instead.
3. Kidnapping-as-raid-goal — reframe as rescue/escort objectives.
4. Per-prisoner daily government stipend (PA's income model) — has no honest non-carceral
   equivalent; replace with trade/scavenging/grant income (already have most of this).
5. Escape tunnels — no non-carceral equivalent (only exists because someone is confined
   against their will); replace with raider infiltration tunnels (identical mechanic, inverted
   actor: they're digging *in*, not *out*).

Everything else across all three games is fair game to port with just renaming.

## KNOWN BALANCE REGRESSION (found during this pass, not yet root-caused)

A fresh hands-off colony (zero player building beyond the starting 4 instant turrets) now
falls in ~7-10k ticks (~12-17 min) regardless of storyteller personality, versus the ~22-36k
ticks (~35-60 min) the original "Full playable loop" commit soak-tested at. Ruled out during
this pass: it is NOT the new double-wave mechanic (forced `doubleChance = 0` live via
`STORYTELLERS.Cassandra.doubleChance = 0` in `window.__debug`, still fell at ~8280 ticks) and
NOT the storyteller cycle-timing changes (Cassandra's `cycleMult` was tuned back to exactly the
pre-storyteller baseline formula, no change). Prime suspect, not yet confirmed: the
blueprint-construction commit (three commits before this session's storyteller work) made
every buildable -- including fences and traps, previously instant -- require a citizen to walk
over and build them over real time. A hands-off colony with nobody manually placing new
defenses starts with only the 4 instant turrets and nothing else ever gets built, so the
"colony strength" the Director scales against may be growing without the defense actually
keeping pace the way the original baseline (built before blueprints existed) assumed. Next
step: re-run the hands-off soak test against the commit just before blueprints were added to
confirm, then decide whether to (a) retune wave scaling for the blueprint-era baseline, or
(b) make the Director's strength calculation weight built vs. unbuilt defense differently.

## Priority recommendation (mine, for discussion — not yet committed to)

Given we already have: needs/mood/traits/skills(partial)/relationships/health(simplified)/
permadeath/storyteller/zoning/construction-blueprints/power-flavored-generator/turrets-fences-
traps/scrap-economy/harvesting/citizen-driven-vehicles —

**High-value, low-to-medium cost, not yet built:**
- Room detection (flood-fill) + room roles/stats (beauty/cleanliness/impressiveness) — PA's
  most-cited-as-portable system, and ties our existing zones into actual enclosed rooms
- Power/water as a real wired-graph network (currently the "generator" buildable is decorative)
- Day/night schedule ("Regime" → "Duty Roster") — assign citizens to sleep/work/guard-duty
  blocks instead of pure needs-driven autonomy
- CCTV/watchtower early-warning (reuses the wire-network code from power)
- Multiple storyteller "personalities" (Cassandra/Phoebe/Randy-equivalent) as different Director
  parameter sets — cheap once you see the pattern, meaningfully changes replay feel
- Pollution/waste as a second resource feeding wave difficulty (SEA:R's signature mechanic,
  and we already have a Director scaling hook to plug it into)
- Fire spread simulation (relevant to both PA and SEA:R, a good siege-game crisis event)
- Downed-not-dead state for both citizens and raiders (needed as the foundation for a
  non-carceral "capture" mechanic if we want one at all)

**High-value, high cost (own subsystem), defer / scope down:**
- Full body-part health model (RimWorld rates this XL even for them)
- Full social/romance system (L even scoped down)
- Ideology/precepts (RimWorld DLC-tier, XL) — if wanted at all, do a lightweight "settlement
  doctrine" version (a few toggleable value axes with mood effects), not the full builder
- World map / caravans / factions — this is the user's separately-requested "conquest +
  control meter" ask; treat as its own feature, not bundled into this list
- Vehicles beyond hauling (RimWorld itself only added them in 2025's Odyssey DLC — not a
  long-standing core pillar, low pressure to rush this)

**Skip / already decided against:**
- Prisoner bus, prison cells, warden bureaucracy-as-punishment, kidnapping raids, per-prisoner
  income — see the four RETHINK items above
- Full gravship/flyable-base (RimWorld Odyssey) — XL, low relevance

---

## Raw findings: RimWorld

(53k tokens of agent reasoning condensed to this; agent used 20 tool calls against RimWorldWiki,
Steam guides, etc.)

Full category list the agent covered: Colonist sim (needs, mood/mental-breaks, traits/
backstories, skills/XP/passion, work priorities, social/relationships), Health (body-part
model, hediffs, disease/immunity, pain/capacities, addiction, surgery/bionics, aging,
pregnancy/children), Base building (zones, rooms/room-stats/room-roles, furniture, power grid,
temperature, terrain/floors), Economy (harvesting, crafting/bills, trade, research tree),
Combat (raid-point budget system, raid arrival methods, enemy archetypes, weapons/armor/damage
types, turrets/traps, combat AI, the three storyteller personalities in detail), Events
(weather, extreme weather, disease outbreaks, wanderers, blight, infestation), Animals
(taming/training/breeding, K9-relevant "Guard"/"Attack-trained" tiers), Quests/world-map/
caravans/factions, Prosthetics/bionics, Ideology/religion (DLC-scale), Vehicles (Odyssey DLC,
new in 2025, NOT a long-standing pillar).

**Storyteller personalities, specifically** (this is a strong, cheap-to-port pattern):
- Cassandra Classic: steadily escalating tension, ~10.6-day major-threat cycle, can double up,
  least forgiving.
- Phoebe Chillax: long generous breathing room, ~16-day cycle (8-24 range), never back-to-back
  majors — for builders.
- Randy Random: no curve, fully randomized severity/timing per roll — chaos/replayability.
- All three are just different parameter sets (curve shape, cycle mean/variance, doubling
  chance) over the *same* scheduler. Cheap once the scheduler exists.

**RETHINK items flagged**: prisoner/warden capture loop, kidnapping-as-raid-goal, ideology
precepts about prisoner treatment/slavery (only if the ideology layer is built at all).

Sources: rimworldwiki.com pages for AI Storytellers, Mental Break Threshold, Hediffs, Disease,
Rooms, Beauty, Battery, Solar/Wind generators, Backstories, Traits, Skills, Work, Social,
Biotech DLC, Genes, Children, Growing zone, Temperature, Research, Bill, Raider, Events, Animal
husbandry, Caravan, Factions, Anomaly DLC, Royalty DLC, Mechanitor, Drugs, Raid points, Wealth;
plus a Steam combat guide and a NamuWiki Odyssey DLC page.

---

## Raw findings: Prison Architect

(54k tokens condensed; agent used 14 tool calls against the Fandom + Paradox PA wikis, Steam
guides, GameRant.)

Full category list covered: Construction/zoning (flood-fill room detection with doors as hard
boundaries, room requirements/min-size/object-counts, grid-snapped materials, foundations),
Utilities (power grid with overload/explosion risk, water/plumbing, staff-only/remote doors),
Staff management (roles/chain-of-command, patrol routes, staff needs/fatigue/strikes, CCTV +
manned-monitor bonus, armory/weapons issuance, K9 dogs sniffing deliveries), Economy (budget/
finance ledger, grants/loans capped-concurrent, supply trucks + truck-driver role, payroll,
room-based income — flagged as thin/mostly-carceral), Simulation depth (pathfinding, needs-
driven population behavior, the 4-axis Grading system, day/night "Regime" schedule), Events
(riot state-machine, fire spread, contraband detection, escape tunnels), Progression (campaign
vs sandbox, Bureaucracy research tree with a carceral "Policy" automation layer), Vehicles
(Supply Truck vs. Prisoner Bus).

**Most directly reusable, per the agent**: Supply Truck + Truck Driver role — this is *already*
our garage/vehicle mechanic, PA's implementation (dedicated staff role that must be freed from
other duty to drive) is a good template for job-assignment contention we'll likely need anyway.
Also: Armory/weapons issuance was called out as "the one PA system that's already 1:1 with your
setting" — zero reframing needed, a civilian defense force issuing weapons from an armory *is*
the stated premise.

**RETHINK/omit items flagged**: Prisoner Bus (no equivalent, omit — optional "Refugee Wagon"
analog if population-growth-via-arrivals is wanted), per-prisoner daily income (drop, replace
with trade/grants), escape tunnels (replace with inverted "raider infiltration tunnels" —
identical mechanic, external actor instead), the Policy tab's *automated punishment response*
specifically (replace the slot with automated *defense* responses — same if/then pattern, no
punishment content), the Grading tab's 4 axes (Punishment/Reform/Security/Health are inherently
carceral — replace with Safety/Wellbeing/Sustainability/Cohesion, same aggregate-scoring
pattern).

Sources: prison-architect.fandom.com and prisonarchitect.paradoxwikis.com pages for Room,
Regime, Clock, Utilities, Power Station, Water Pump Station, Guard, CCTV/CCTV Monitor, Weapon
Rack, Armoury, Security, Supply Truck, Deliveries, Grant/Grants, Finance, Escape Mode, Riot(s),
Contraband, Escape Tunnel, Kitchen, Canteen, Dormitory, Needs, Staff Needs, Staff Well-being
Initiative, Bureaucracy, Warden, Policy, Prisoner Bus, Truck Driver, Sector grading, Prisoner
Profile, Status Effects, Doors, Staff Door, Remote Door; plus a GameRant piece on PA2's upgrade
system and a Steam building guide.

---

## Raw findings: Super Energy Apocalypse: Recycled

(54k tokens condensed; agent used 15 tool calls. This is a small 2009 Flash game — sources are
thinner than the other two, agent explicitly flagged confidence per finding.)

**Identification**: confirmed exact match — 2009 Flash game by Lars "larsiusprime" Doucet,
Kongregate/Newgrounds/Jay Is Games, made with Houston Advanced Research Center using real
EPA energy data (a deliberate edutainment "issues game," not just reskinned tower defense).

**Core loop / what "recycled" means** [HIGH confidence]: the economy runs on Energy, not
currency. Your own buildings (farms, plants) generate **waste/smog as a byproduct** — trucks
haul it to landfills/Recycling Centers which convert it back into material/energy (natural gas,
post-upgrade). Zombies **feed on unmanaged waste to grow stronger** — recycling is defensive
risk-mitigation, not just income. This is a *second resource loop* (pollution), not a
replacement for combat-kill/harvest scrap — worth adding as an addition to what we have, not a
swap.

**Wave structure** [HIGH]: strict day/night (build by day, zombies attack by night), edge-spawn
from multiple directions, **wave difficulty scales with the player's own pollution level** — a
player-controlled storyteller input, distinct from RimWorld's wealth-based one. 8 campaign
levels, 3 difficulty modes + sandbox/endless.

**Defenses** [HIGH]: gun turrets, floodlights (area-denial that *physically blocks* zombie
advance at night — a "soft wall" that isn't a wall object), Tesla coils (present, noted as
under-used relative to alternatives), flamethrowers (strongest, resource-hungry, player tip is
to build very few). No traditional wall object — floodlight-chokepoints substitute.

**Economy** [HIGH]: resources = Energy/Power, Metal, Food, Research, Fossil fuel, Natural gas,
Waste, Pollution(meter, not spendable). Generators: coal, natural gas, wind (needs high
ground), solar, geothermal (needs guarding), nuclear (expensive, produces hazardous waste
needing separate guarded storage). No shop-with-currency layer — everything built directly with
energy/metal.

**Vehicles — the single cleanest match to our existing system** [HIGH]: garbage trucks are a
core, real mechanic, auto-hauling waste to landfills/recycling centers. **Trucks pick one of
four fuel types**, each a genuine tradeoff: fossil fuel (cheap/dirty), natural gas (best
all-around, "great mileage, negligible smog"), ethanol (clean, consumes food supply),
electricity (cleanest, energy-hungry to produce). Fuel efficiency is itself a research target.
**Explicitly confirmed: SEA:R trucks are autonomous haulers, not manually driven** — our
citizen-drives-the-truck design is a deliberate, acknowledged departure from the source
material, not a research gap.

**Progression** [MEDIUM]: research banks within a campaign (recommend banking to 999 before
ending a level, implying it carries level-to-level within one campaign, not across separate
playthroughs). New building types unlock per level. No per-unit skill trees.

**Tone** [MEDIUM, inferred from review prose]: darkly-comic PSA energy — "pollution is like
spinach to Popeye" — the inversion of waste-as-threat-multiplier (not just a positive resource)
is the core tonal hook worth preserving, e.g. a visible smog-haze overlay scaling with a
pollution stat, zombies visibly buffed/discolored by dirty play.

**Summary table from the agent** (system → confidence → port complexity → action):
- Pollution-buffs-enemies → High → Low-Med → add as a Director scaling input
- Garbage truck fuel-type tradeoffs → High → Low-Med → direct port onto our truck/garage system
- Recycling Center (waste→resource) → High → Medium → new building feeding the truck loop
- Multi-source power economy → High → Medium → new generator building category
- Floodlight-as-soft-wall → High → Low → new fence/trap variant
- Tesla coil → High → Low → new turret variant
- Nuclear waste guarded-hazard zone → High → Medium → new hazard-tile mechanic
- Day/night build-vs-defend → High → already have → confirm alignment
- In-campaign tech unlock gating → Medium → Low → optional progression polish
- Specific enemy roster/bosses → Low confidence → open design space
- Combat/armored vehicles → confirmed absent from source → any we add is a genuine departure

Sources: Jay Is Games review/walkthrough (Recycled + original), Kongregate game page, TIGSource
archive capsule, a Game Developer/Gamasutra design-philosophy analysis piece, Flash Gaming Wiki
(fandom, partially inaccessible).
