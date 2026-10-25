// Tool definitions shared by the server route (sent to the model) and the
// client executor. Coordinates are local metres (x east, y north) from the
// city origin. Most location parameters also accept a place name or feature id.

import { LIBRARY_TOOL_DEFS } from "./libraryToolDefs";
import { NAV_TOOL_DEFS } from "./navToolDefs";
import { DESIGN_TOOL_DEFS } from "./designToolDefs";

type Schema = Record<string, unknown>;
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Schema;
  /**
   * read: inspects or runs models, never changes the world. edit: can commit a change (plan mode
   * allows it only as a dry run; zones bound where it may act). view: moves the camera or changes
   * what the map shows. Missing = edit (the safe default for gating).
   */
  effect?: "read" | "edit" | "view";
}

const point = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] local metres" };
const polygon = { type: "array", items: point, minItems: 3, description: "outer ring [[x,y],...] in local metres" };
const location = {
  description: "A location: [x,y] point, a feature id (e.g. 'b:w123', 's:45', 'n:999'), a place/landmark/street name, or an intersection like 'Congress Avenue & 6th Street'.",
  anyOf: [point, { type: "string" }],
};
const ids = { type: "array", items: { type: "string" }, description: "feature ids" };
const dryRun = { type: "boolean", description: "Preview only: compute the change and its full cascade report (demolitions, conflicts, displaced uses) without applying it. Use to compare alternatives before committing." };
const policy = { type: "string", enum: ["trim", "demolish", "report"], description: "How to resolve buildings in the new right-of-way: trim façades back to the new property line (demolishing if >45% lost or historic), demolish, or only report conflicts without changing them." };
const area = {
  description: "An area: polygon ring, place/district/park name, feature id (parcel, block, area, building), or {center:[x,y], radius:m}.",
  anyOf: [polygon, { type: "string" }, { type: "object", properties: { center: point, radius: { type: "number" } }, required: ["center", "radius"] }],
};

const sectionEdit = {
  type: "object",
  description:
    "One cross-section edit. ops: add_lanes{count,dir:'both'|'forward'|'backward'} | remove_lanes{count,dir} (count is per direction; a two-way street loses count lanes in each direction unless dir is given — use dir:'forward' for a 4→3 road diet) | set_lane_width{width} | set_sidewalk{width,side} | widen_sidewalks{by,side} | add_bike_lanes{kind:'lane'|'track'|'two_way_track',side} | remove_bike_lanes | remove_parking{side} | add_parking{side} | add_median{width} | remove_median | add_planting{width,side} | add_raingardens{width,side,only_parking} (kerbside bioretention: counted as rain-garden land cover and as storage in the runoff model; rebuilds planting strips, else converts the parking lane, else adds a strip at the kerb — only_parking:true never adds a strip, so the ROW is not widened and streets with nothing to convert are left alone) | bus_lanes{on,mode:'convert'|'add'} | tram{on,mode} | set_oneway{oneway} | pedestrianize | reopen{lanes} | replace{strips:[{type,width,dir}]}. side: 'both'|'left'|'right' relative to the street's from→to direction, or a compass side 'north'|'south'|'east'|'west'.",
  properties: {
    op: { type: "string" },
    count: { type: "number" },
    dir: { type: "string" },
    width: { type: "number" },
    by: { type: "number" },
    side: { type: "string" },
    kind: { type: "string" },
    on: { type: "boolean" },
    mode: { type: "string" },
    oneway: { type: "boolean" },
    lanes: { type: "number" },
    strips: { type: "array", items: { type: "object" } },
  },
  required: ["op"],
};

export const TOOL_DEFS: ToolDef[] = [
  // ------------------------------------------------------------------ inspect
  {
    name: "get_context",
    description: "Current session context: user selection (with details), camera view (centre, visible bounds, nearby named places), active scenario and branches, the last few edits, active overlay and latest simulation KPIs. Call this first whenever the user says 'this', 'here', 'that', 'these' or refers to the view.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "resolve_place",
    description: "Resolve a place reference to coordinates/geometry: landmarks, districts, neighbourhoods, parks, stations, bridges, street names (returns the corridor) and intersections ('Lamar & 5th'). Returns ranked matches with ids.",
    input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "find_features",
    description:
      "Search the world model. kind: building|street|node|parcel|area|tree|stop|route|poi|place|utility|prop (library objects). Filters: name (fuzzy), near+radius, within (area), where{def (library definition id or prefix), category (library category), instance (lib:…), type (prop definition), use, minHeight, maxHeight, minFloors, cls, landUse ('vacant','parking','building','park'), zoning (prefix), type (area type), historic, proposed (created in this session), minArea, maxArea, control (junction), degree (junction approaches; 1 = dead end), bridge, oneway, closed, minLanes, maxRadius (streets with a curve tighter than this radius, m, measured on a 15 m chord), sidewalk ('missing' any side | 'missing_both' | 'missing_measured' = confirmed absent in the City inventory | 'poor' = grade D/F or ≥ 50 % functionally deficient | 'narrow' = under 4 ft), ramps ('missing' | 'poor', junction curb ramps), owner ('public' | 'private' | a public body name), underused (improvements worth < half the land), etod (in the ETOD overlay), maxLandValuePerM2}. Parcel rows carry TCAD land / improvement values, owner (public bodies by name; private owners are not named) and ETOD eligibility. Street rows carry sidewalk_left/right status (City inventory where measured). sort: distance|height|area|gfa|residents|jobs|curvature (most substandard curve for its speed first). Returns compact rows.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        name: { type: "string" },
        near: location,
        radius: { type: "number" },
        within: area,
        where: { type: "object" },
        sort: { type: "string" },
        limit: { type: "number" },
      },
      required: ["kind"],
    },
  },
  {
    name: "get_feature",
    description: "Full detail for one or more features: buildings (masses, floors, programme, units/jobs, provenance, parcel zoning & height limits, constraints), streets (cross-section strips and widths, lanes per direction, ROW, frontage distance to buildings on each side, junction ids), junctions (approaches, control), parcels (zoning, FAR, height/CVC limits, capacity), areas, routes, library objects; anything placed from the library also shows its definition, instance and full parameter set.",
    input_schema: { type: "object", properties: { ids }, required: ["ids"] },
  },
  {
    name: "describe_area",
    description: "Aggregate profile of an area: buildings, GFA, housing units and residents (Census-anchored), jobs (LODES-anchored), land cover, parks, surface parking, streets by class and lane-km, bike facilities, transit stops, zoning mix, historic buildings, soft sites. Use to diagnose a district before designing.",
    input_schema: { type: "object", properties: { area }, required: ["area"] },
  },
  {
    name: "make_polygon",
    description: "Construct geometry for other tools. shape: rect{center,width,height,angle_deg} | circle{center,radius} | buffer{ids or path, distance} | union{ids} (parcels/buildings/areas) | block{at: location} (the city block containing a point, inside street ROW) | corridor{street_ids or street name, width} | hull{ids}. Returns the polygon, its area and the features it touches.",
    input_schema: {
      type: "object",
      properties: { shape: { type: "string" }, center: location, width: { type: "number" }, height: { type: "number" }, angle_deg: { type: "number" }, radius: { type: "number" }, ids, path: { type: "array", items: point }, distance: { type: "number" }, at: location, street: { type: "string" } },
      required: ["shape"],
    },
  },
  {
    name: "measure",
    description: "Distance between two locations (straight-line and walking network), or area/perimeter of an area.",
    input_schema: { type: "object", properties: { from: location, to: location, area } },
  },
  {
    name: "find_route",
    description: "Route along the street network from → (via) → to and return the ordered street_ids (ready to pass to edit_streets / plant_trees / set_street_attributes), named legs, length and time. mode: walk|bike|drive. prefer: shortest | quiet (avoid arterials) | arterial | low_stress (bike: minimise level of traffic stress). Use it to pick corridors: green links between parks, bike connections, bus routes, detours.",
    input_schema: { type: "object", properties: { from: location, to: location, via: { type: "array", items: location }, mode: { type: "string" }, prefer: { type: "string" } }, required: ["from", "to"] },
  },
  // ------------------------------------------------------------------ buildings
  {
    name: "create_building",
    description:
      "Generate a new building with procedural massing on a site. site: area (parcel ids / polygon / place). typology: block|tower_podium|courtyard|slab|terraced|l_shape|u_shape|point_towers|twin_towers|stepped_tower|rowhouses|midrise|pavilion. use: residential|office|retail|mixed|hotel|civic|education. The site is clipped to street ROW automatically. replace_ids are demolished; other overlaps are carved around unless demolish_conflicts. Validates zoning height, Capitol View Corridors, utilities, floodplain.",
    input_schema: {
      type: "object",
      properties: {
        site: area,
        typology: { type: "string" },
        floors: { type: "number" },
        use: { type: "string" },
        podium_floors: { type: "number" },
        tower_coverage: { type: "number", description: "tower plate as fraction of podium, 0.15–0.7" },
        tower_count: { type: "number" },
        bar_depth: { type: "number" },
        edge_setback: { type: "number" },
        orientation_deg: { type: "number" },
        name: { type: "string" },
        replace_ids: ids,
        demolish_conflicts: { type: "boolean" },
        green_roof: { type: "boolean" },
        program: { type: "object", description: "GFA shares by use, e.g. {residential:0.85, retail:0.15}" },
      },
      required: ["site", "typology", "floors", "use"],
    },
  },
  {
    name: "modify_buildings",
    description: "Change existing buildings: height (m) | floors | height_scale (1.2 = 20% taller, adds floors above the podium, footprint unchanged) | translate [dx,dy] | rotate_deg | footprint_scale | use | massing {typology, keep_gfa, floors, podium_floors, tower_coverage} (regenerate the form on the same footprint, e.g. slimmer tower on a podium holding GFA) | setbacks {above_floor, depth} | green_roof | name.",
    input_schema: {
      type: "object",
      properties: { ids, height: { type: "number" }, floors: { type: "number" }, height_scale: { type: "number" }, translate: point, rotate_deg: { type: "number" }, footprint_scale: { type: "number" }, use: { type: "string" }, program: { type: "object" }, massing: { type: "object" }, setbacks: { type: "object" }, green_roof: { type: "boolean" }, name: { type: "string" } },
      required: ["ids"],
    },
  },
  {
    name: "optimize_massing",
    description: "Massing study for one building: generates courtyard, U and L plans facing each side, slab and terraced forms on its footprint (holding floor area, within the height limit), scores each by direct-sun hours on the open ground of its site for a date (default winter solstice), and applies the best form that keeps ≥ 90% of the floor area. Returns every variant scored.",
    input_schema: { type: "object", properties: { id: { type: "string" }, site: area, date: { type: "string" }, keep_gfa: { type: "boolean" }, max_height_m: { type: "number" }, branch_name: { type: "string" } }, required: ["id"] },
  },
  {
    name: "merge_buildings",
    description: "Turn several buildings into one connected development: shared podium bridging gaps (never across street ROW), existing towers kept, sky-bridges where a street separates them.",
    input_schema: { type: "object", properties: { ids, podium_floors: { type: "number" }, name: { type: "string" } }, required: ["ids"] },
  },
  {
    name: "remove_features",
    description: "Delete buildings, trees, areas, stops or other features (not streets — use remove_streets).",
    input_schema: { type: "object", properties: { ids, reason: { type: "string" } }, required: ["ids"] },
  },
  {
    name: "green_roofs",
    description: "Convert suitable flat roofs to green roofs (excludes glass towers > 100 m, roofs < min_area, historic), planted inside a 1.5 m edge setback. Target buildings by ids or area; with target_m2, the largest roofs are planted until that planted area is reached. Green roofs count as vegetated (non-impervious) cover in the runoff model with their own curve number — say so when they are used toward a permeable-surface target, since they are not ground-level permeable paving.",
    input_schema: { type: "object", properties: { ids, area, min_area: { type: "number" }, max_count: { type: "number" }, target_m2: { type: "number" } } },
  },
  // ------------------------------------------------------------------ streets
  {
    name: "edit_streets",
    description:
      "Edit street cross-sections with full cascade: kerbs, sidewalks, crossings and junction geometry regenerate; buildings in a widened ROW are trimmed/demolished per conflict_policy; parcels lose ROW strips; trees, kerb inlets and bus stops follow the kerb; corridor-end transitions are flagged. Target with street_ids or street (name) optionally limited by within (area) or between two cross streets [from, to]. keep_row_width holds the overall ROW (narrow the road → give width to sidewalks). anchor keeps one ROW edge fixed ('left'|'right' or a compass side).",
    input_schema: {
      type: "object",
      properties: {
        street_ids: ids,
        street: { type: "string" },
        within: area,
        between: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2, description: "two cross-street names bounding the corridor" },
        edits: { type: "array", items: sectionEdit },
        keep_row_width: { type: "boolean" },
        anchor: { type: "string" },
        conflict_policy: policy,
      },
      required: ["edits"],
    },
  },
  {
    name: "set_junction",
    description: "Change a junction: control 'signal'|'stop'|'yield'|'none'|'roundabout'|'plaza'. Roundabouts size themselves to the approaches (or radius) and cascade to corner buildings, parcels and trees; plazas close the junction to vehicles. transit_priority:true (with control 'signal') adds transit signal priority — the traffic model cuts bus signal delay there and charges the conflicting approaches some capacity. Pass route (route id, ref or name) instead of junction to apply transit_priority at every existing signal along that bus route. Junction may be an id or 'Street A & Street B'. curb_ramps:'upgrade' (with junction, or junctions: ids — e.g. from find_features kind node where{ramps:'missing'}) rebuilds absent and grade D–F curb ramps to the accessible standard; no control needed.",
    input_schema: { type: "object", properties: { junction: { type: "string" }, junctions: ids, route: { type: "string" }, control: { type: "string" }, radius: { type: "number" }, lanes: { type: "number" }, transit_priority: { type: "boolean" }, curb_ramps: { type: "string", enum: ["upgrade"] }, conflict_policy: policy } },
  },
  {
    name: "create_street",
    description: "Draw a new street and splice it into the network: it snaps to nearby junctions/streets at its ends and creates junctions at every crossing (splitting existing streets). path: list of points (or locations). cls: primary|secondary|tertiary|residential|living|pedestrian. Buildings in the new ROW are demolished by default (conflict_policy). Use extend semantics by starting the path at an existing street end.",
    input_schema: {
      type: "object",
      properties: { path: { type: "array", items: location }, cls: { type: "string" }, name: { type: "string" }, lanes: { type: "number" }, oneway: { type: "boolean" }, bike: { type: "string", enum: ["lane", "track"] }, median: { type: "boolean" }, parking: { type: "boolean" }, sidewalk: { type: "number" }, trees: { type: "boolean" }, conflict_policy: policy },
      required: ["path"],
    },
  },
  {
    name: "plan_street",
    description: "Alignment study for a new street or boulevard between two locations while minimising demolition: previews a straight alignment, four bowed alternatives and upgrading the existing street route (median, planting, optional bike tracks), each with its full cascade, then builds the least destructive (fewest historic demolitions, then homes, then floor area). Returns every candidate's demolition count, homes, floor area and park impact. Same street options as create_street; dry_run:true only reports.",
    input_schema: { type: "object", properties: { from: location, to: location, cls: { type: "string" }, name: { type: "string" }, lanes: { type: "number" }, bike: { type: "string", enum: ["lane", "track"] }, median: { type: "boolean" }, parking: { type: "boolean" }, sidewalk: { type: "number" }, trees: { type: "boolean" }, dry_run: { type: "boolean" } }, required: ["from", "to"] },
  },
  {
    name: "move_streets",
    description: "Shift street segments by [dx,dy] metres; their junctions move and every connected street is re-attached (bent near the joint). Conflicts with buildings in the new ROW follow conflict_policy; released ROW is reported.",
    input_schema: { type: "object", properties: { street_ids: ids, street: { type: "string" }, within: area, offset: point, conflict_policy: policy }, required: ["offset"] },
  },
  {
    name: "realign_streets",
    description: "Realign a street's sharp bends as circular curves of a design radius (default: AASHTO minimum for the street's speed, or radius / design_speed_kmh), limited by the distance to adjacent bends/junctions; cascades to buildings, parcels and trees along the new alignment. Reports achieved vs required radius. find_features where.maxRadius / sort:'curvature' locate substandard curves.",
    input_schema: { type: "object", properties: { street_ids: ids, radius: { type: "number" }, design_speed_kmh: { type: "number" }, conflict_policy: policy }, required: ["street_ids"] },
  },
  {
    name: "remove_streets",
    description: "Remove street segments (orphan junctions removed, adjacent junctions regenerated). reclaim the freed ROW as 'plaza' | 'park' | 'none'. Transit routes using them are flagged.",
    input_schema: { type: "object", properties: { street_ids: ids, reclaim: { type: "string" } }, required: ["street_ids"] },
  },
  {
    name: "set_street_attributes",
    description: "Set attributes: closed (to general traffic; e.g. bridge closure or pedestrian street), service_access (deliveries/emergency still allowed when closed), speed_kmh, name, cls.",
    input_schema: { type: "object", properties: { street_ids: ids, street: { type: "string" }, within: area, closed: { type: "boolean" }, service_access: { type: "boolean" }, speed_kmh: { type: "number" }, name: { type: "string" }, cls: { type: "string" } } },
  },
  // ------------------------------------------------------------------ land / landscape / transit
  {
    name: "create_area",
    description: "Create a land-use area: park|plaza|water|retention|raingarden|permeable|grass|wood|parking. Buildings mostly inside are demolished (or kept with buildings:'keep'; historic always kept), overlapped parking lots are cut back and counted, street ROW is excluded (except plazas). Retention ponds take depth (m) for storage. shade_trees plants a canopy grid.",
    input_schema: { type: "object", properties: { type: { type: "string" }, area, name: { type: "string" }, depth: { type: "number" }, buildings: { type: "string", enum: ["keep", "demolish"] }, shade_trees: { type: "boolean" } }, required: ["type", "area"] },
  },
  {
    name: "convert_areas",
    description: "Change the type of existing areas (e.g. surface parking → permeable or park). Either pass ids, or select by from_type (+ within) — with target_m2 the largest matching areas are converted until the target area is reached (reports whether it was met).",
    input_schema: { type: "object", properties: { ids, type: { type: "string" }, from_type: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "area type(s) to draw from, e.g. 'parking' or ['parking','plaza']" }, within: area, target_m2: { type: "number" } }, required: ["type"] },
  },
  {
    name: "plant_trees",
    description: "Plant street trees along streets (both sides; respects sidewalk width ≥3 m or planting strips, 11 m sight-line clearance at junctions, kerb inlets, bus stops and existing canopy) or in an area. With count + target:'heat', positions are ranked by shade benefit — modelled 15:00 sidewalk exposure above air temperature × √pedestrian activity (residents, jobs and transit riders nearby) — so trees go where people walk in the heat (runs the heat model if needed). species sets crown and habit (live_oak 9 m crown, spreading · cedar_elm 8 m, upright · bur_oak 9 m · bald_cypress 5 m, conical · desert_willow 6 m · redbud 5 m); default is a generic 9 m crown like the mapped trees.",
    input_schema: { type: "object", properties: { street_ids: ids, street: { type: "string" }, within: area, count: { type: "number" }, spacing: { type: "number" }, target: { type: "string", enum: ["heat", "even"] }, species: { type: "string", enum: ["live_oak", "cedar_elm", "bur_oak", "bald_cypress", "desert_willow", "redbud"] } } },
  },
  {
    name: "create_transit_route",
    description: "Create a bus | rapid | brt | tram route through waypoints (locations), routed on the street network preferring arterials, with stops every stop_spacing m (snapped to junctions). dedicated:true converts a general lane each way to bus/tram lanes along the alignment with full cascade.",
    input_schema: { type: "object", properties: { mode: { type: "string" }, waypoints: { type: "array", items: location }, name: { type: "string" }, headway: { type: "number" }, stop_spacing: { type: "number" }, dedicated: { type: "boolean" } }, required: ["mode", "waypoints", "name"] },
  },
  {
    name: "optimize_stops",
    description: "Re-space the stops of transit routes to minimise demand-weighted walking distance (greedy p-median over residents + jobs within 600 m, minimum spacing).",
    input_schema: { type: "object", properties: { route_ids: ids, min_spacing: { type: "number" }, max_stops: { type: "number" } }, required: ["route_ids"] },
  },
  {
    name: "generate_district",
    description:
      "Masterplan an area in one operation: optional new local streets through oversized blocks (block_size), open space allocation (open_space_ratio), preservation (preserve_ids, historic by default, keep_all_existing for infill), and building massing solved to hit target_units or target_population under max_floors. style: european (courtyard perimeter blocks, living streets) | grid | midrise | towers | tod (heights taper from anchor) | civic | infill.",
    input_schema: {
      type: "object",
      properties: { area, style: { type: "string" }, target_units: { type: "number", description: "0 = streets and open space only, no new buildings" }, target_net_units: { type: "number", description: "net new homes: units demolished on redeveloped lots are replaced on top" }, redevelop: { type: "string", enum: ["underused"], description: "with keep_all_existing: still rebuild private, non-historic lots whose buildings are worth less than half their land (TCAD appraisal) — the planners' soft-site test; lots are taken most underused first, only as many as the target needs, at the lowest height that can reach it (raise min_floors to redevelop fewer lots)" }, target_population: { type: "number" }, max_floors: { type: "number" }, min_floors: { type: "number" }, new_streets: { type: "boolean" }, block_size: { type: "number" }, open_space_ratio: { type: "number" }, preserve_ids: ids, keep_all_existing: { type: "boolean" }, anchor: location, use: { type: "string" }, name: { type: "string" } },
      required: ["area", "style"],
    },
  },
  // ------------------------------------------------------------------ scenarios & history
  {
    name: "scenario",
    description: "Manage scenario branches. action: list | branch{name, from?} (new branch from the active or a named scenario; switches to it) | switch{id or name} | rename{id,name} | delete{id}. Edits always go to the active scenario; the baseline (existing city) is read-only so the first edit auto-branches.",
    input_schema: { type: "object", properties: { action: { type: "string" }, name: { type: "string" }, id: { type: "string" }, from: { type: "string" } }, required: ["action"] },
  },
  {
    name: "history",
    description: "Edit history of the active scenario (changeset ids, labels, authors, summaries). Use with undo or revert_change.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "undo",
    description: "Undo this session's last N edits in the active scenario (other agents' and the user's edits are kept; simulation settings are untouched). redo:true re-applies instead. any_author:true undoes the last N edits whoever made them — only when the user explicitly asks for that.",
    input_schema: { type: "object", properties: { steps: { type: "number" }, redo: { type: "boolean" }, any_author: { type: "boolean" } } },
  },
  {
    name: "revert_change",
    description: "Revert one specific earlier changeset while keeping the later ones that still apply (e.g. 'keep the original intersection'). Changesets made by another agent session or the user need any_author:true, which you set only when the user explicitly asks.",
    input_schema: { type: "object", properties: { changeset_id: { type: "string" }, any_author: { type: "boolean" } }, required: ["changeset_id"] },
  },
  {
    name: "borrow_changes",
    description: "Copy changesets from another scenario into the active one (e.g. take the green corridor from Option A into Option B). Select by changeset_ids or by a label substring.",
    input_schema: { type: "object", properties: { from: { type: "string" }, changeset_ids: ids, label_contains: { type: "string" } }, required: ["from"] },
  },
  // ------------------------------------------------------------------ analysis
  {
    name: "run_simulation",
    description:
      "Run a model on a scenario (default active) and show its overlay. kind: traffic{period:'am'|'pm', demand_scale, extra_residents:[{at,residents}]} | heat{delta_t (°C added to air temperature; 1 °F = 0.56 °C), hours:[..], date} | runoff{storm:'2yr'|'10yr'|'25yr'|'100yr', impervious_increase (hypothetical: 0.15 = impervious cover grows 15% of its current extent on private pervious land), area (also report pervious / impervious m² and runoff inside it)} | flood{rise_m} | access{area} (walk times to amenities + fire/EMS response drive times vs the 4-min standard; area adds coverage for the residents inside it) | bike (bicycle level of traffic stress per street, low-stress coverage to destinations, low-stress islands and the critical high-stress links that would join them) | capacity{parcel_ids|area, floors, height_limit} | sun{date, area} | metrics. Returns KPIs, top lists and model assumptions. Results are planning-grade estimates — report them with their assumptions.",
    input_schema: { type: "object", properties: { kind: { type: "string" }, scenario: { type: "string" }, params: { type: "object" } }, required: ["kind"] },
  },
  {
    name: "optimize_emergency",
    description: "Improve fire/EMS response coverage (NFPA 1710: first engine within 4 min travel) with the fewest network changes. Searches signal preemption (EVP) around each station, opening car-free streets ≥ 6.1 m wide to emergency vehicles (removable bollards), two-way conversion of one-way corridors, and bollard-controlled fire lanes linking dead ends to the next street (clear of buildings, water and other streets); a greedy search keeps, step by step, the change that brings the most residents within 4 minutes. Chosen changes are committed as real edits in the active branch (auto-branches from the existing city) and the access model is re-run for before/after figures. allow limits the change types; min_gain (residents, default 25) sets the bar.",
    input_schema: { type: "object", properties: { max_changes: { type: "number" }, min_gain: { type: "number" }, allow: { type: "array", items: { type: "string", enum: ["preempt", "open", "two_way", "connector"] } }, branch_name: { type: "string" } } },
  },
  {
    name: "optimize_bottlenecks",
    description: "Fix the worst junction bottlenecks with the smallest changes that help: for each of the worst non-motorway junctions (v/c above target_vc), tries +1 lane on the busiest approaches (no demolition, ROW held where possible), signalisation and a two-lane roundabout, re-runs the traffic assignment for each, and keeps the candidate that most reduces network delay. Commits into the active branch (auto-branches from the existing city). Reports everything tried and what could not be fixed.",
    input_schema: { type: "object", properties: { period: { type: "string", enum: ["am", "pm"] }, max_changes: { type: "number" }, target_vc: { type: "number" }, allow: { type: "array", items: { type: "string", enum: ["lanes", "signal", "roundabout"] } }, exclude_junctions: ids, branch_name: { type: "string" } } },
  },
  {
    name: "compare_scenarios",
    description: "Run the same models on two scenarios and return KPI deltas (b − a). kinds default ['metrics','traffic','heat']. The map switches to a difference view when show_diff.",
    input_schema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" }, kinds: { type: "array", items: { type: "string" } }, params: { type: "object" }, show_diff: { type: "boolean" } }, required: ["a", "b"] },
  },
  {
    name: "validate",
    description: "Check proposals for conflicts: ROW encroachment, building overlaps, zoning height and Capitol View Corridor limits, storm drains under footprints, floodplain, historic designations, street connectivity (dangling ends), buildings without street frontage. Defaults to everything created in the active scenario.",
    input_schema: { type: "object", properties: { ids, area } },
  },
  {
    name: "rank_sites",
    description: "Rank candidate locations. candidates: 'vacant_parcels' | 'parking_lots' | 'soft_sites' | 'public_land' (lots owned by a public body) | 'underused' (private lots whose buildings are worth < half the land, TCAD) | 'junctions' | 'streets' (segments with sidewalks) | 'points' (with points) within an area. criterion: residents_walk (residents within `minutes` walk) | transit_gap (residents far from frequent transit) | park_gap (residents far from parks) | heat (modelled exposure, sampled on sidewalks / junction corners) | shade_benefit (where shade helps most people: exposure above air temperature × √pedestrian activity; skips motorways and streets without sidewalks) | near_transit (site area near frequent transit) | affordable_housing (size × frequent-transit walk × land cost from TCAD appraisal, with local public land counted as nearly free × ETOD bonus eligibility; reports land $/m², owner and ETOD per site). extra_residents [{at, residents}] adds planned residents (e.g. a new district) to the population being served. Returns top sites with scores.",
    input_schema: { type: "object", properties: { candidates: { type: "string" }, points: { type: "array", items: point }, within: area, criterion: { type: "string" }, minutes: { type: "number" }, limit: { type: "number" }, extra_residents: { type: "array", items: { type: "object" } } }, required: ["candidates", "criterion"] },
  },
  {
    name: "estimate",
    description: "Economic / social estimates with explicit assumptions. what: costs (capital cost of the active scenario's changes from unit costs; unit_costs override) | schools (students and schools needed for units) | growth (logistic population path over years with rate and capacity, allocated year by year to lots by remaining zoned capacity × redevelopment likelihood from the appraisal roll × frequent-transit access; turns on the Growth map overlay with 5-year snapshots and returns totals by area) | budget_fit (which soft sites deliver the most homes for a public-infrastructure budget: utility capacity, school seats, frontage and new streets, greedy by cost per unit; budget, within).",
    input_schema: { type: "object", properties: { what: { type: "string" }, within: area, units: { type: "number" }, years: { type: "number" }, rate: { type: "number" }, capacity: { type: "number" }, budget: { type: "number" }, unit_costs: { type: "object" } }, required: ["what"] },
  },
  // ------------------------------------------------------------------ session
  {
    name: "set_zone",
    description:
      "Set or clear this session's work zone: the area your edits must stay inside, for this and later requests (reads are never limited). Use it when the user says e.g. 'only work between 5th and 7th', 'stick to the block at Lamar & 6th', 'within 300 m of Republic Square' or 'work anywhere again'. zone: street bounds ('between 5th and 7th from Congress to Lavaca', '24th St & West Ave block'), a place or district name, 'within N m of X', 'selection', or a polygon ring. clear:true removes the zone. Returns the resolved zone (label, area, bbox) or candidates when the words are ambiguous.",
    input_schema: { type: "object", properties: { zone: { anyOf: [{ type: "string" }, polygon] }, clear: { type: "boolean" } } },
  },
  // ------------------------------------------------------------------ communicate
  {
    name: "camera",
    description: "Move the camera. action: fly_to{target, zoom?, pitch?, bearing?} | overview | pedestrian{target} (eye level) | orbit{target} (slow orbit) | flyover{targets:[...]} (sequence through locations).",
    input_schema: { type: "object", properties: { action: { type: "string" }, target: location, targets: { type: "array", items: location }, zoom: { type: "number" }, pitch: { type: "number" }, bearing: { type: "number" } }, required: ["action"] },
  },
  {
    name: "show",
    description: "Set the visualisation: overlay (traffic|heat|density|access|bike|flood|zoning|growth|transit|sun|runoff|change|none), hour (0–24 time of day), compare_with (scenario to diff against, or null), mode (density: residents|jobs; access: frequent_transit|transit|grocery|school|park|health|food|emergency (fire/EMS drive time); zoning: added|limit; growth: a snapshot year such as 2030), timelapse {from,to,seconds}.",
    input_schema: { type: "object", properties: { overlay: { type: "string" }, hour: { type: "number" }, compare_with: { type: "string" }, mode: { type: "string" }, timelapse: { type: "object" } } },
  },
  {
    name: "annotate",
    description: "Place callouts on the map to explain decisions or results (each {at: location, title, body?, tone: info|warn|good}), and/or highlight feature ids. clear:true removes previous annotations.",
    input_schema: { type: "object", properties: { notes: { type: "array", items: { type: "object" } }, highlight: ids, clear: { type: "boolean" } } },
  },
  ...NAV_TOOL_DEFS,
  ...DESIGN_TOOL_DEFS,
  ...LIBRARY_TOOL_DEFS,
];

const MUTATING = new Set(["create_building", "modify_buildings", "merge_buildings", "remove_features", "green_roofs", "edit_streets", "set_junction", "create_street", "move_streets", "realign_streets", "remove_streets", "set_street_attributes", "create_area", "convert_areas", "plant_trees", "create_transit_route", "optimize_stops", "generate_district", "optimize_emergency", "design_neighborhood"]);
for (const t of TOOL_DEFS) if (MUTATING.has(t.name)) (t.input_schema.properties as Record<string, unknown>).dry_run = dryRun;

// what each tool does to the world: gates plan mode and zones (tools not listed default to "edit")
const EFFECT: Record<string, NonNullable<ToolDef["effect"]>> = {
  get_context: "read", resolve_place: "read", find_features: "read", get_feature: "read", describe_area: "read", make_polygon: "read", measure: "read", find_route: "read",
  history: "read", run_simulation: "read", compare_scenarios: "read", validate: "read", rank_sites: "read", estimate: "read",
  camera: "view", show: "view", annotate: "view", set_zone: "view",
};
for (const t of TOOL_DEFS) t.effect ??= EFFECT[t.name] ?? "edit";

/** effect of one call: a few tools are read-only for some inputs (scenario list) */
export function effectOf(name: string, input?: Record<string, unknown>): NonNullable<ToolDef["effect"]> {
  if (name === "scenario" && (input?.action === "list" || input?.action === undefined)) return "read";
  return TOOL_DEFS.find((t) => t.name === name)?.effect ?? "edit";
}

/** edit tools that accept dry_run (plan mode turns their calls into previews) */
export function supportsDryRun(name: string): boolean {
  const def = TOOL_DEFS.find((t) => t.name === name);
  return !!(def?.input_schema.properties as Record<string, unknown> | undefined)?.dry_run;
}

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);
