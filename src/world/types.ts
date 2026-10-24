// Meridian world model. All geometry is in local metres (x = east, y = north)
// relative to the city pack origin. Rings are open (first point not repeated)
// and outer rings are counter-clockwise.

export type Vec2 = [number, number];
export type Ring = Vec2[];
/** [outer, ...holes] */
export type Polygon = Ring[];

export type Provenance =
  | "measured" // direct survey / LiDAR / census count
  | "mapped" // crowd-mapped (OSM) attribute
  | "derived" // computed from measured or mapped inputs by a documented rule
  | "estimated" // default assumption or statistical inference
  | "proposed"; // created by a user or agent edit

export type Use =
  | "residential"
  | "office"
  | "retail"
  | "mixed"
  | "hotel"
  | "civic"
  | "education"
  | "religious"
  | "health"
  | "industrial"
  | "parking"
  | "utility"
  | "other";

export type MassRole = "body" | "podium" | "tower" | "setback" | "crown" | "wing" | "bridge" | "base";

export interface Mass {
  /** footprint of this volume */
  poly: Polygon;
  /** bottom of volume, metres above ground */
  base: number;
  /** top of volume, metres above ground */
  top: number;
  role: MassRole;
  use?: Use;
}

export interface Building {
  id: string;
  kind: "building";
  footprint: Polygon;
  masses: Mass[];
  height: number;
  floors: number;
  use: Use;
  /** fraction of GFA per use (sums to 1) */
  program: Partial<Record<Use, number>>;
  name?: string;
  address?: string;
  osmType?: string;
  historic?: boolean;
  greenRoof?: boolean;
  /** ground elevation above sea level (m) */
  ground: number;
  heightSource: Provenance;
  useSource: Provenance;
  source: string;
  parcelId?: string;
  /** set on entities created by an edit */
  createdBy?: string;
  /** free-form design notes recorded by the generator / agent */
  notes?: string;
  style?: BuildingStyle;
  /**
   * Baseline occupancy allocated from measured block totals (2020 Census housing
   * units, LEHD LODES jobs) by estimated floor area. Edits scale these by the
   * change in built volume.
   */
  existing?: { units: number; jobs: number; gfa: number; volume: number; use: Use };
}

export interface BuildingStyle {
  facade: "glass" | "masonry" | "concrete" | "metal" | "timber" | "stucco";
  tint?: number; // 0..1 variation
}

export type StripType =
  | "sidewalk"
  | "planting"
  | "parking"
  | "bike" // painted bike lane
  | "cycletrack" // protected, kerb-separated
  | "buffer"
  | "travel"
  | "bus"
  | "turn"
  | "median"
  | "tram"
  | "shoulder"
  | "plaza"; // pedestrianised carriageway

export interface Strip {
  type: StripType;
  width: number;
  /** +1 = travels from->to, -1 = to->from, 0 = bidirectional / n.a. */
  dir: 1 | -1 | 0;
  /** street trees present in a planting strip */
  trees?: boolean;
  /** planting strip built as a bioretention rain garden (depressed, engineered soil) */
  bio?: boolean;
}

/** Strips ordered from the left edge to the right edge when looking from `from` to `to`. */
export interface CrossSection {
  strips: Strip[];
  /** lateral shift of the section centre to the left of the street path (m) */
  shift?: number;
}

export type RoadClass =
  | "motorway"
  | "motorway_link"
  | "trunk"
  | "primary"
  | "secondary"
  | "tertiary"
  | "residential"
  | "service"
  | "living"
  | "pedestrian"
  | "busway";

export type NodeControl = "signal" | "stop" | "none" | "roundabout" | "yield";

export interface StreetNode {
  id: string;
  kind: "node";
  p: Vec2;
  control: NodeControl;
  /** generated: ids of incident streets (maintained by the store) */
  edges: string[];
  /** roundabout parameters when control === 'roundabout' */
  roundabout?: { radius: number; lanes: number };
  /** pedestrian plaza replaces the intersection */
  plaza?: boolean;
  /** transit signal priority (green extension / early green for buses) */
  tsp?: boolean;
  /** emergency-vehicle signal preemption (optical / GPS emitters on fire and EMS vehicles) */
  evp?: boolean;
  /** curb ramps at this junction from the City inventory: ok = grade A–C, poor = D–F, absent */
  ramps?: { ok: number; poor: number; absent: number };
}

/** one side of a street in the City's sidewalk inventory */
export interface SidewalkSide {
  status: "existing" | "partial" | "absent" | "shared";
  /** share of the segment length with an existing sidewalk */
  coverage: number;
  /** length-weighted condition grade of the existing sidewalk */
  grade?: "A" | "B" | "C" | "D" | "F";
  /** share of the assessed sidewalk rated functionally deficient */
  deficient?: number;
  /** typical measured width (m) */
  width?: number;
}

export interface Street {
  id: string;
  kind: "street";
  from: string;
  to: string;
  /** centreline, first point == node(from).p, last == node(to).p */
  path: Vec2[];
  name?: string;
  cls: RoadClass;
  oneway: boolean;
  section: CrossSection;
  /** design speed km/h */
  speed: number;
  bridge?: boolean;
  tunnel?: boolean;
  layer?: number;
  /** closed to general traffic (event, pedestrianised, etc.) */
  closed?: boolean;
  /** private circulation (parking-lot / driveway service roads, not public alleys) */
  private?: boolean;
  /** service vehicles still allowed when closed (deliveries, emergency) */
  serviceAccess?: boolean;
  /** measured sidewalk inventory per side (left/right looking from `from` to `to`) */
  sidewalks?: { left?: SidewalkSide; right?: SidewalkSide };
  /** source right-of-way width (m), from measured data where available */
  rowSource: Provenance;
  sectionSource: Provenance;
  source: string;
  createdBy?: string;
}

export type AreaType =
  | "park"
  | "plaza"
  | "water"
  | "grass"
  | "wood"
  | "parking" // surface parking lot
  | "retention" // retention / detention pond
  | "raingarden"
  | "permeable" // permeable paving
  | "construction"
  | "campus"
  | "cemetery"
  | "pitch";

export interface Area {
  id: string;
  kind: "area";
  type: AreaType;
  poly: Polygon;
  name?: string;
  source: string;
  provenance: Provenance;
  /** retention ponds: storage depth (m) */
  depth?: number;
  createdBy?: string;
}

export interface Tree {
  id: string;
  kind: "tree";
  p: Vec2;
  /** canopy radius m */
  r: number;
  h: number;
  /** species id (src/world/species.ts); mapped trees without one render as a generic crown */
  species?: string;
  source: string;
  provenance: Provenance;
  streetId?: string;
  createdBy?: string;
}

export interface Parcel {
  id: string;
  kind: "parcel";
  poly: Polygon;
  area: number;
  zoning: string;
  zoningBase: string;
  /** maximum floor-area ratio under base zoning + density bonus overlays */
  maxFar: number | null;
  /** maximum height (m) above grade from zoning + Capitol View Corridors */
  maxHeight: number | null;
  /** Capitol View Corridor absolute elevation ceiling (m ASL) when applicable */
  cvcCeiling?: number | null;
  historic: boolean;
  /** current land use classification */
  landUse: "building" | "parking" | "vacant" | "park" | "civic" | "water" | "row";
  /** appraised values (USD), Travis Central Appraisal District, prorated to this lot */
  value?: { land: number; improvements: number };
  /** public body that owns the lot (private owners are not recorded) */
  owner?: string;
  /** Equitable Transit-Oriented Development overlay: eligible for the affordability-linked height bonus */
  etod?: { subdistrict: string; maxHeight: number };
  source: string;
}

export type TransitMode = "bus" | "rapid" | "rail" | "tram" | "brt";

export interface TransitStop {
  id: string;
  kind: "stop";
  p: Vec2;
  name: string;
  mode: TransitMode;
  routes: string[];
  source: string;
  provenance: Provenance;
  createdBy?: string;
}

export interface TransitRoute {
  id: string;
  kind: "route";
  mode: TransitMode;
  name: string;
  ref: string;
  color: string;
  /** polyline in local metres */
  path: Vec2[];
  /** street ids the route uses (map-matched), in order */
  streets: string[];
  stops: string[];
  /** scheduled headway (min) */
  headway: number;
  source: string;
  provenance: Provenance;
  createdBy?: string;
}

/** A storm drain pipe or other buried utility, used for conflict detection */
export interface Utility {
  id: string;
  kind: "utility";
  type: "storm_pipe" | "inlet";
  path: Vec2[];
  size?: number; // inches
  source: string;
}

/** Off-street footpath / trail (sidewalks are part of street cross-sections) */
export interface Path {
  id: string;
  kind: "path";
  path: Vec2[];
  type: "footway" | "cycleway" | "path" | "steps" | "trail";
  name?: string;
  source: string;
  createdBy?: string;
}

export interface Poi {
  id: string;
  kind: "poi";
  p: Vec2;
  name?: string;
  category:
    | "grocery"
    | "school"
    | "university"
    | "health"
    | "food"
    | "shop"
    | "civic"
    | "culture"
    | "park"
    | "worship"
    | "transit"
    | "landmark"
    | "hotel"
    | "other";
  tags?: Record<string, string>;
  source: string;
}

/** Named place (neighbourhood, district, landmark) for reference resolution */
export interface Place {
  id: string;
  kind: "place";
  name: string;
  type: "district" | "neighbourhood" | "landmark" | "campus" | "park" | "water" | "station" | "bridge";
  p: Vec2;
  poly?: Polygon;
  refs?: string[];
  source: string;
}

export type Entity =
  | Building
  | Street
  | StreetNode
  | Area
  | Tree
  | Parcel
  | TransitStop
  | TransitRoute
  | Utility
  | Path
  | Poi
  | Place;

export type EntityKind = Entity["kind"];

export interface CensusBlock {
  geoid: string;
  pop: number;
  hu: number;
  poly: Polygon;
}

export interface CountStation {
  id: string;
  road: string;
  aadt: number;
  year: number;
  p: Vec2;
}

export interface Raster {
  /** south-west corner of cell (0,0) in local metres */
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  /** row-major, row 0 is the southern-most row */
  data: Float32Array | Uint8Array;
}

export interface CityMeta {
  id: string;
  name: string;
  region: string;
  /** origin of the local metre frame */
  origin: { lon: number; lat: number };
  /** study area bbox in local metres [minX, minY, maxX, maxY] */
  bounds: [number, number, number, number];
  contextBounds: [number, number, number, number];
  timezone: string;
  /** normal pool / reference water surface elevation (m ASL) */
  waterLevel: number;
  sources: { id: string; name: string; url: string; license: string; retrieved: string; kind: Provenance }[];
  weather: {
    date: string;
    source: string;
    hourly: { t: number[]; rh: number[]; sw: number[]; wind: number[]; cloud: number[] };
  };
  calibration: {
    /** household size used for population estimates of new units */
    householdSize: number;
    censusPopulation: number;
    censusHousingUnits: number;
    lodesJobs: number;
  };
  initialView: { center: Vec2; zoom: number; pitch: number; bearing: number };
  /** a blank design canvas: no measured data, everything in it is proposed */
  sandbox?: boolean;
}
