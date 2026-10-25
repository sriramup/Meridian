# Meridian

**An AI-native 3D planning and simulation workspace for real cities.** Meridian opens on a blank canvas where you can design a city from scratch. It can also load a measured, editable model of central Austin (about 17 km²: downtown, East Austin, UT, Rainey, Bouldin), with 10,800 buildings, the street network with full cross-sections, parcels and zoning, and drainage and transit. You can edit it directly or through a planning agent. Every edit cascades through the physical model, and traffic, heat, stormwater, flood, access and capacity models re-run on the edited world.

```
npm install
npm run dev            # http://localhost:3000 opens the blank canvas; http://localhost:3000/?city=austin opens Austin
```

Switch between the blank canvas and Austin from the city menu next to the Meridian wordmark. The Austin data pack ships prebuilt in `public/data/austin/` (≈ 30 MB), so no API keys or downloads are needed to explore, edit, or simulate.

### Enabling the planning agent

Agents live in the side pane on the right (⌘J). Each agent is its own task with its own conversation; several can run at once, and every edit they make shows on the map as it happens. The pane lists every agent (search, running / needs input / recent); open one to follow it, and go back to the list at any time.

- **Plan or Edit.** In Plan mode an agent investigates and proposes: edits run only as previews. In Edit mode it changes the plan.
- **Zones.** By default an agent works anywhere. Give it a zone in the composer — draw a rectangle or polygon on the map, use the selection, or describe it in words ("between 5th and 7th from Congress to Lavaca", "the block at Lamar & 6th", "within 300 m of Republic Square") — and its edits stay inside; the zone carries over to its later requests until you change it. Agents only undo their own edits.
- **Fast answers.** Questions about what's on screen ("what is the current scenario?") go to a fast model and are answered from a live snapshot without tool calls; edits and analyses go to the main model, masterplans and optimisation at higher effort (`src/agent/router.ts`).

Agents call Claude through the server route `src/app/api/agent/route.ts`. It needs an Anthropic API key in the server environment:

```
# .env.local (git-ignored)
ANTHROPIC_API_KEY=sk-ant-…
```

---

## What you can do

| | |
|---|---|
| **Inspect** | Click any building, street, junction, parcel, park or tree for measured attributes and provenance. Each value is labelled *measured* (LiDAR, survey), *mapped* (OSM), *estimated* (Census/LODES allocation) or *proposed*. |
| **Edit streets** | Change a cross-section strip by strip: lanes, bike lanes and two-way cycle tracks, bus and tram lanes, parking, medians, planting, rain gardens (bioretention, counted as storage in the runoff model), sidewalks. Kerbs, crossings, corner radii, stop bars and junctions regenerate. Buildings in a widened right-of-way are trimmed or flagged. Parcels lose ROW strips. Trees, kerb inlets and bus stops follow the kerb. Measured sidewalk gaps, poor-condition or narrow sidewalks and missing curb ramps can be found and fixed directly. |
| **Route** | Find walk, bike or drive routes (shortest, quiet, arterial, low-stress) and get their street segments, so a corridor can be edited as a unit. |
| **Edit networks** | Draw streets that splice into the network (crossings become junctions), shift streets with their connections re-attached, add roundabouts sized by HCM capacity, add transit signal priority at a junction or along a whole bus route, search automatically for small junction fixes that cut network delay, search for the fewest changes that bring more residents within the 4-minute fire/EMS standard (signal preemption on first-due routes, emergency access through car-free streets, two-way conversions, fire lanes at dead ends), realign curves to an AASHTO design radius, pedestrianise, close bridges. |
| **Edit buildings** | Use 13 procedural typologies (tower + podium, courtyard, U/L, stepped tower, rowhouses…). Massing is checked against zoning height, FAR and Capitol View Corridors. You can merge buildings with podiums and sky-bridges, regenerate a slimmer tower while holding floor area (capped by the height limit), add setbacks, and add green roofs. |
| **Masterplan** | Generate districts (European, grid, mid-rise, towers, TOD, civic, infill). Infill can redevelop only underused private lots (buildings worth less than half their land), most underused first, to hit a net housing target. New streets subdivide blocks, open space is allocated, historic buildings are preserved, and floors are solved to hit a unit or population target under a storey cap. |
| **Simulate** | Run traffic (AM/PM assignment), bicycle level of traffic stress with low-stress connectivity, heat exposure, sun hours, stormwater runoff, flood inundation, walk access, fire/EMS response, development capacity, a lot-by-lot residential growth scenario with 5-year snapshots, and scenario metrics. Results show as map overlays with legends. The heat map shows surface temperature; next to its clock, feels-like on foot, the share of ground above 104 °F, canopy and shaded paths are given for the area in view at the hour shown. |
| **Compare** | Scenario branches with exact undo/redo. Compare any two branches with KPI deltas and difference maps. Borrow changes from one branch into another. |
| **Navigate** | Orbit, cinematic fly-to, flyovers, a street-level view modelled on Street View (P: click the ground or a facade to walk there, click the arrows to step along the street, double-click to jump, drag to look around, scroll or pinch to zoom, Esc to come back up), a night theme (N), and time-of-day sun (lit for the hour on a fixed reference day, the September equinox: the month changes modelled temperatures, never how buildings or trees look). The city streams in around the camera, nearest first, with less detail in the distance. |

Keyboard: `/` or `⌘K` search for a place, street, intersection or address · `?` controls guide · `V` select · `L` library (`B` buildings, `A` parks, `T` trees) · `S` street · `D` district · `R` transit line · `M` measure · `Delete` remove the selection · `1–0` overlays · `N` night · `P` street level · `⌘Z / ⇧⌘Z` undo/redo · `⌘J` agent.

Camera: drag to pan; right-drag, `Ctrl`-, `Shift`-, `Alt`/`⌥`- or middle-drag to rotate and tilt (or drag the compass, top right; click it to face north). `Q / E` turn, `⇧↑ / ⇧↓` tilt. The `?` button lists every control.

Temperatures are shown in °F (the heat model works in °C; the agent's tool results carry both).

## Blank canvas (sandbox)

The default view is an empty 3 × 3 km site with a faint 100 m grid. There is no basemap, measured data or existing city under it. You design the city from scratch with the same elements and operations used on Austin:

- **The library.** Everything a city has is a configurable building block (`L`, or the library in the left rail): 220+ primitives — buildings of any plan shape, height, storeys, roof, facade and programme; homes, apartments, shops, restaurants, offices, civic buildings, schools and campuses; parks, sports fields and playgrounds; benches, lamps and all street furniture; 30+ tree species, shrubs, hedges and meadows; animals; water features; utilities and landmarks; and composites such as a college campus or a subdivision with its own streets. Search by name or synonym, set any parameter (each one has units and limits), and place it by clicking, dragging a rectangle, outlining a site or drawing a line. Select anything you placed to change any parameter later; the agent can set every one of them too (`src/library/`).
- **Draw tools.** Choosing a tool opens a small palette for that element. Streets come in six classes (local, collector, avenue, boulevard, living street, pedestrian), with optional bike lanes and street trees. Buildings have a use, a form (13 massing typologies) and a number of floors. Areas cover parks, plazas, water, woodland, lawn, rain gardens, permeable paving, retention ponds and parking (drawn bare: trees are planted by hand). Trees go one at a time or along a line, spaced a crown apart; a tree needs room for its whole crown, so it can't be planted where its leaves would overlap another tree or a building. A district has a style, a homes target, a height cap, and optional new local streets. A transit line can be a bus, rapid bus or tram, with a headway.
- **Placing elements.** Finishing a shape creates the element straight away and selects it, so you can fine-tune it in the inspector. The inspector lets you rename, edit floors and form, edit the street cross-section, set junction control, or remove the element. Shapes that run into something (a street through buildings, a footprint over another building) ask first.
- **Hidden overlays.** The heat, shade, stormwater, traffic, density, walk-access, bike and transit models all run on what you draw. Capacity, growth and flood screening are hidden, because there are no parcels, zoning or terrain to work on.
- **How models treat a drawn city:**
  - Open ends of collectors, avenues and boulevards are the town's connections to the wider region in the traffic model.
  - School and clinic floor space become walk-access destinations.
  - A building drawn as a fire station counts as a fire/EMS station.
- **Climate.** Sun path, time zone and typical weather come from a climate city (Austin) so the environmental models have real inputs. The canvas uses 2.5 persons per household.
- **Saving.** Your design (every branch, with full undo history) is saved in the browser as you work. Start over with *New blank canvas* in the city menu.

### Exporting and importing proposals

The scenario menu (the coloured dot with the design's name) has **Export ▸ JSON / CSV** and **Import…**, on the blank canvas and on Austin alike.

- **JSON** (`"format": "meridian-proposal", "version": 1`) is lossless. It holds the city (id, name, climate), the coordinate reference (local metres from an origin lon/lat), and per proposal: a summary (features added / modified / removed by kind, change in homes, jobs and floor area), the edit history, a readable GeoJSON `FeatureCollection` of the changed features in lon/lat with their key attributes (kind, name, use/type, floors, height, area, units, jobs, library definition and parameters, which attributes changed), and the exact changesets. Importing it replays the changesets as a new branch, entity for entity; it refuses files from another city or a newer version. *Export ▸ All designs* puts every branch in one file. Older blank-canvas design files are still imported (each branch becomes a design).
- **CSV** has one row per changed feature: `proposal, city, action, kind, id, name, use_type, floors, height_m, area_m2, units, jobs, lon, lat, geometry_wkt` (WKT in lon/lat), `library_def, library_params` (JSON), `library_instance, library_placement` (JSON, lon/lat), `changed`; RFC 4180 quoting. Importing it re-creates what the columns carry as a new branch: buildings (one extruded footprint), areas, trees, paths, junction controls, street centrelines and classes, removals, and library primitives (placed again from definition + parameters). It cannot carry street cross-sections (re-created streets get their class default), building massing detail (setbacks, roofs, facade), the shapes of props without a known definition, or transit routes; the import lists what it could not carry. Use JSON for an exact copy.
- **The agent** gets a canvas-specific system prompt: build the network first, generate districts, and don't run models that need measured data.

## The 100-prompt acceptance suite

The spec's 100 example prompts are encoded as a behavioural suite in `scripts/acceptance/`. Each case drives the **same tool executor the agent uses** headlessly against the Austin pack. It composes tools the way a planning agent would and checks that the consequences happened: geometry changed, cascades resolved, and models re-ran on the edited world.

```
npx tsx scripts/acceptance/run.ts --report     # full suite (~15 min, many model runs) → docs/ACCEPTANCE.md
npx tsx scripts/acceptance/run.ts --only 1-10  # a category
```

**Latest run: 96 pass · 4 partial · 0 fail.** [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) lists every prompt with its result and the evidence from the run. When something is only partly supported, the missing piece is named rather than papered over. For example, there is no sidewalk-gap inventory in the data, PUD entitlements and land ownership are not modelled, and the optimisers are greedy searches that cannot prove a result is minimal or optimal. The suite verifies capability. The language model's own planning is exercised in the app with an API key.

## Tests

```
npm test               # vitest: blank canvas (build from scratch, run models, design round trip), sun & shadow geometry, bicycle stress, pedestrian activity & shade benefit, growth allocation, agent tool layer (dry runs, routing, input validation, shade ranking, emergency-access search), cascade policy, exact undo
npm run typecheck
```

The agent pipeline can be exercised end to end without an API key against a scripted mock of the streaming Messages API. The mock makes real tool calls (resolve a junction, find a parcel, build a tower, run traffic), reads their results back from the conversation, and writes a summary from them:

```
node scripts/dev/mock-anthropic.mjs 3999 &
ANTHROPIC_API_KEY=mock MERIDIAN_ANTHROPIC_BASE_URL=http://localhost:3999 npm run dev
node scripts/dev/act.mjs scripts/dev/agent-e2e.json /tmp/agent   # drives the real UI in headless Chromium
```

## Architecture

```
scripts/build-pack.ts     data pipeline → public/data/austin/{world,meta,reference,utilities,context}.json, landcover.bin, dem.bin
src/state/                runtime (city pack or blank canvas), city presets, design autosave / files, draw-then-create, app store
src/world/                immutable entity model, changesets (exact apply/revert), scenario branches, spatial index
src/world/ops/            cascade-aware operations (OpBuilder) — streets, buildings, landscape, transit, districts, validation
src/geometry/             polygon kernel, cross-sections, street/junction geometry, procedural massing
src/sim/                  models (pure TS) run in a Web Worker on a replayed copy of the active scenario
src/render/               MapLibre basemap + deck.gl scene (custom facade shader, chunked scene cache, overlays)
src/agent/                tool definitions, client-side executor, place resolver, agent loop
src/app/api/agent/        server route streaming Claude (adaptive thinking, tool use) as NDJSON
src/components/           UI shell: inspector, cross-section editor, analysis dock, agent panel
```

- **One world model.** Manual tools and the agent call the same operations and commit the same changesets. Undo, redo, branching, comparison and borrowing all work on changesets, never on rendered geometry.
- **Cascades are explicit.** Each operation returns a report (summary, warnings, resolved and unresolved conflicts) that is shown in the UI and returned to the agent. When an edit can't be resolved, it is reported as unresolved and never silently dropped. Historic-designated buildings are never auto-demolished, and demolishing more than 25 buildings or any historic one needs user approval.
- **Simulations replay scenarios.** The worker holds the baseline and replays a scenario's changesets, so any branch can be simulated or compared without disturbing the editor.

## Data provenance

| Layer | Source | Kind |
|---|---|---|
| Building footprints & heights | City of Austin Building Footprints 2023 (LiDAR) matched to OSM building parts | measured (93% of buildings) |
| Buildings, streets, POIs, parks | OpenStreetMap (BBBike extract 2026-10-17), ODbL | mapped |
| Street ROW & lanes | Austin Strategic Mobility Plan street network | measured |
| Land & improvement values, public ownership | Travis Central Appraisal District parcels (Travis County TNR monthly snapshot), prorated to lots (8,681 valued, 1,255 publicly owned). Only public bodies are named; private owners are not recorded. | measured |
| ETOD overlay | City of Austin Equitable Transit-Oriented Development overlay (affordability-linked height bonus) | measured |
| Sidewalks & curb ramps | City of Austin Sidewalk Network & Curb Ramp inventory (presence, A–F condition, width), matched to street sides (2,876 segments) and junctions | measured |
| Lots, zoning, density bonus, Capitol View Corridors, Neighborhood Planning Areas, Downtown Austin Plan districts | City of Austin GIS | measured |
| Impervious cover | City of Austin Impervious Cover 2023 | measured |
| Tree canopy | City of Austin Tree Canopy 2022 (27% of the study area) | measured |
| Storm drains & inlets, FEMA floodplain | City of Austin GIS | measured |
| Transit routes & stops | Capital Metro (via City GIS) | measured |
| Population & housing | US Census 2020 blocks (68,428 residents, 36,095 units) | measured, allocated to buildings by floor area |
| Jobs | LEHD LODES 8 WAC 2023 (213,931 jobs) | measured, allocated to buildings by floor area |
| Traffic counts | TxDOT AADT (30 stations) | measured, used for gateway calibration |
| Terrain | AWS Terrain Tiles (USGS 3DEP-derived) | measured |
| Weather | ERA5 reanalysis via Open-Meteo, 2023-08-15 | measured |

Where sources disagree in time, the newer source wins and the decision is recorded. For example, 26 LiDAR-2023 footprints inside sites OSM maps as construction in 2026 (including the Austin Convention Center rebuild) are treated as demolished.

Rebuild the pack (requires the raw extracts in `data/raw/`; see `scripts/fetch-osm.sh`, `scripts/fetch_austin_gis.py`, `scripts/fetch_extra.py`):

```
npm run data:austin
```

## Model assumptions (summary)

Every simulation result carries its assumptions in the agent's tool output. They are not shown in the app; each model run's assumptions are sent once per session to `POST /api/telemetry`, which appends them to `.telemetry/model-assumptions.jsonl` on the server (override with `MERIDIAN_TELEMETRY_LOG`). These are planning-grade models for **comparing scenarios**. They are not forecasts.

- **Traffic:** ITE 11th-ed. peak-hour trip rates on Census/LODES-allocated land use, gravity distribution, and gateways calibrated to TxDOT AADT (K = 0.09, D = 0.55). Assignment is static user equilibrium (Frank–Wolfe, BPR α = 0.15, β = 4). Junctions are screened with the critical-lane-volume method, and roundabouts use HCM 6 entry capacity. Calibration is reported as GEH per count station. There are no turn penalties, queue spill-back, or signal timing.
- **Heat:** ERA5 air temperature and shortwave for the reference day, a 4 m land-cover raster with the City's measured tree canopy, and exact building and tree shadows from the sun position. Comparisons report both the area-wide mean and the local change where the model moved by 0.25 °C or more, because area-wide means hide local interventions. Pedestrian exposure is an MRT-style proxy, not UTCI, and is not calibrated to Landsat LST. Shade and tree placement are prioritised by *shade benefit*: sidewalk exposure above air temperature × √pedestrian activity. Activity is a proxy (residents, jobs and transit riders nearby, decayed with distance) because the pack has no footfall counts. Motorways and streets without sidewalks are excluded, and comparisons also report people-weighted sidewalk exposure.
- **Stormwater:** NRCS TR-55 curve number method, hydrologic soil group D, NOAA Atlas 14 design storms. Curve numbers follow the ground surface, so pavement under tree canopy stays impervious (as in the City's impervious-cover data). Green roofs are planted inside a 1.5 m edge setback and get their own curve number. Reports list them separately from ground-level permeable surfaces. Ponds and rain gardens subtract their storage. Volumes only, with no routing.
- **Flood:** Connected "bathtub" inundation on the DEM above Lady Bird Lake. No hydraulics.
- **Cycling:** Bicycle Level of Traffic Stress (Mekuria, Furth & Nixon 2012; Furth 2017) from facility type, lanes per direction, posted speed, parking and unsignalised crossings. Low-stress (LTS ≤ 2) coverage counts residents within 15 minutes of destinations, and low-stress islands identify the high-stress links whose upgrade would join them. There are no traffic volumes and no measured operating speeds.
- **Access:** Network walk times at 1.3 m/s to OSM amenities, parks, and transit (frequent = ≤ 15-min headway). The walk network leaves out motorways and any arterial segment with no sidewalk on either side (pedestrian level of traffic stress 4). Local streets without sidewalks stay walkable. Fire/EMS response is free-flow drive time from OSM-named stations, compared with the NFPA 1710 4-minute travel standard. Each signal costs 6 s, or 1 s with preemption. Emergency vehicles may run against one-way traffic at half speed (Texas Transportation Code §546.001), never on motorways.
- **Capacity:** min(FAR × lot, height-limited floors × 70% coverage), with Capitol View Corridor ceilings. Historic and public parcels are held at their existing state.
- **Growth:** a logistic population path toward a stated capacity, placed year by year on lots with remaining zoned capacity. Placement is weighted by redevelopment likelihood and transit access. Likelihood is 1 for vacant and parking lots; for built lots it falls with the ratio of improvement to land value from the appraisal roll, and it is 0 for historic lots. Lots within a 5–10 minute walk of frequent transit get up to ×1.5. It is a scenario, not a market forecast.

## Known limitations

- The study area is one Austin pack. The pipeline is city-agnostic, but other cities need their own source adapters.
- Neighbourhood names without an official boundary (OSM label points such as Eastwoods) resolve to a labelled 400 m approximation.
- Traffic is a static peak-hour model. The trip animation is driven by assigned link flows, but it is a visualisation of the flows, not a microsimulation.
- Pedestrian-level rendering uses procedural façades, not photogrammetry.
- Headless browsers with software WebGL render at about 1 fps. Real GPUs are needed for the 60 fps target.
