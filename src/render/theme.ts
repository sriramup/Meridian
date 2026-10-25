import type { AreaType, StripType, Use } from "@/world/types";

export type RGBA = [number, number, number, number];
export type RGB = [number, number, number];

export interface Theme {
  id: "model" | "night" | "graphite";
  background: string;
  ground: RGB;
  land: RGB;
  context: RGB;
  contextBuilding: RGB;
  contextRoad: RGB;
  area: Record<AreaType, RGB>;
  strip: Record<StripType, RGB>;
  carriageway: RGB;
  kerbTop: RGB;
  island: RGB;
  markWhite: RGB;
  markYellow: RGB;
  building: Record<Use, RGB>;
  glass: RGB;
  proposed: RGB;
  proposedEdge: RGB;
  selection: RGB;
  hover: RGB;
  removed: RGB;
  tree: RGB;
  treeDark: RGB;
  trunk: RGB;
  path: RGB;
  text: RGBA;
  textHalo: RGBA;
  ambient: number;
  sun: number;
  night: number;
  shadow: RGBA;
}

export const MODEL: Theme = {
  id: "model",
  background: "#ead9b6",
  ground: [233, 218, 186],
  land: [238, 225, 196],
  context: [228, 212, 180],
  contextBuilding: [240, 230, 208],
  contextRoad: [212, 194, 162],
  area: {
    park: [197, 211, 182],
    grass: [204, 215, 190],
    wood: [178, 197, 163],
    pitch: [191, 207, 174],
    water: [160, 185, 199],
    parking: [214, 211, 206],
    plaza: [226, 220, 210],
    construction: [222, 214, 200],
    campus: [230, 227, 221],
    cemetery: [200, 210, 188],
    retention: [150, 182, 192],
    raingarden: [168, 196, 160],
    permeable: [210, 206, 196],
  },
  strip: {
    sidewalk: [219, 215, 208],
    planting: [196, 207, 182],
    parking: [180, 179, 177],
    bike: [140, 178, 150],
    cycletrack: [120, 170, 136],
    buffer: [214, 212, 208],
    travel: [171, 170, 169],
    bus: [196, 134, 124],
    turn: [176, 175, 174],
    median: [186, 200, 172],
    tram: [160, 158, 156],
    shoulder: [182, 181, 179],
    plaza: [226, 219, 207],
  },
  carriageway: [171, 170, 169],
  kerbTop: [222, 218, 211],
  island: [186, 202, 170],
  markWhite: [248, 247, 244],
  markYellow: [226, 186, 84],
  building: {
    residential: [246, 243, 238],
    office: [240, 241, 243],
    retail: [247, 241, 233],
    mixed: [244, 241, 236],
    hotel: [243, 240, 236],
    civic: [241, 236, 228],
    education: [241, 236, 228],
    religious: [238, 231, 220],
    health: [242, 242, 240],
    industrial: [232, 229, 224],
    parking: [226, 224, 220],
    utility: [228, 226, 222],
    other: [238, 236, 232],
  },
  glass: [220, 228, 236],
  proposed: [240, 214, 120],
  proposedEdge: [178, 136, 52],
  selection: [150, 52, 30],
  hover: [196, 128, 74],
  removed: [215, 70, 60],
  tree: [132, 160, 112],
  treeDark: [104, 134, 90],
  trunk: [120, 100, 80],
  path: [206, 196, 180],
  text: [58, 36, 18, 255],
  textHalo: [242, 230, 204, 230],
  ambient: 0.62,
  sun: 1.9,
  night: 0,
  shadow: [62, 70, 92, 0.32],
};

export const NIGHT: Theme = {
  ...MODEL,
  id: "night",
  background: "#0f1115",
  ground: [24, 26, 30],
  land: [26, 28, 32],
  context: [21, 23, 27],
  contextBuilding: [40, 43, 49],
  contextRoad: [44, 47, 53],
  area: {
    park: [30, 42, 34],
    grass: [32, 42, 35],
    wood: [26, 38, 30],
    pitch: [31, 43, 35],
    water: [17, 28, 38],
    parking: [34, 36, 40],
    plaza: [42, 42, 44],
    construction: [40, 38, 34],
    campus: [30, 31, 35],
    cemetery: [30, 40, 33],
    retention: [20, 34, 44],
    raingarden: [30, 46, 36],
    permeable: [40, 40, 42],
  },
  strip: {
    sidewalk: [52, 54, 58],
    planting: [34, 46, 38],
    parking: [40, 42, 46],
    bike: [36, 60, 46],
    cycletrack: [34, 66, 48],
    buffer: [54, 56, 60],
    travel: [44, 46, 50],
    bus: [72, 40, 38],
    turn: [46, 48, 52],
    median: [36, 48, 40],
    tram: [50, 50, 54],
    shoulder: [42, 44, 48],
    plaza: [58, 56, 54],
  },
  carriageway: [44, 46, 50],
  kerbTop: [60, 62, 66],
  island: [36, 50, 40],
  markWhite: [150, 150, 146],
  markYellow: [150, 120, 60],
  building: Object.fromEntries(Object.entries(MODEL.building).map(([k]) => [k, [86, 90, 98]])) as Record<Use, RGB>,
  glass: [70, 80, 96],
  path: [60, 58, 54],
  tree: [44, 62, 46],
  treeDark: [36, 52, 40],
  text: [214, 212, 206, 255],
  textHalo: [16, 18, 22, 230],
  ambient: 0.35,
  sun: 0.4,
  night: 1,
  shadow: [0, 0, 0, 0.25],
};

/**
 * The map by day under the Dark interface: the same model in neutral graphite, so the scene sits
 * with the panels over it. Buildings stay light enough for sun and shadow to read; the analysis
 * overlays' colours carry over unchanged.
 */
export const GRAPHITE: Theme = {
  ...MODEL,
  id: "graphite",
  background: "#1d1f23",
  ground: [38, 40, 45],
  land: [42, 44, 49],
  context: [35, 37, 42],
  contextBuilding: [72, 75, 82],
  contextRoad: [55, 58, 64],
  area: {
    park: [48, 62, 51],
    grass: [50, 63, 52],
    wood: [42, 57, 46],
    pitch: [48, 63, 51],
    water: [34, 52, 66],
    parking: [56, 58, 63],
    plaza: [62, 63, 67],
    construction: [60, 58, 54],
    campus: [52, 54, 59],
    cemetery: [47, 59, 49],
    retention: [36, 58, 70],
    raingarden: [46, 66, 52],
    permeable: [58, 59, 63],
  },
  strip: {
    sidewalk: [78, 80, 86],
    planting: [50, 64, 53],
    parking: [58, 60, 65],
    bike: [48, 88, 66],
    cycletrack: [44, 96, 68],
    buffer: [80, 82, 87],
    travel: [62, 64, 70],
    bus: [104, 58, 54],
    turn: [64, 66, 72],
    median: [52, 68, 55],
    tram: [70, 70, 75],
    shoulder: [60, 62, 68],
    plaza: [82, 82, 86],
  },
  carriageway: [62, 64, 70],
  kerbTop: [88, 90, 96],
  island: [52, 68, 55],
  markWhite: [196, 198, 204],
  markYellow: [196, 158, 70],
  building: {
    residential: [204, 207, 213],
    office: [196, 201, 210],
    retail: [206, 204, 200],
    mixed: [202, 204, 208],
    hotel: [200, 202, 207],
    civic: [198, 196, 192],
    education: [198, 196, 192],
    religious: [194, 190, 184],
    health: [204, 206, 210],
    industrial: [180, 182, 186],
    parking: [170, 172, 176],
    utility: [174, 176, 180],
    other: [192, 194, 198],
  },
  glass: [150, 166, 188],
  proposed: [182, 152, 255],
  proposedEdge: [138, 108, 232],
  selection: [88, 140, 255],
  hover: [132, 168, 248],
  tree: [84, 118, 88],
  treeDark: [66, 98, 72],
  trunk: [92, 82, 72],
  path: [92, 92, 94],
  text: [228, 229, 233, 255],
  textHalo: [22, 24, 28, 230],
  shadow: [0, 0, 0, 0.38],
};

/** which day palette the map uses: paper under Cartography, graphite under the Dark interface */
export function mapIsGraphite(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
}

/** the map's day theme for the current interface theme */
export function dayTheme(): Theme {
  return mapIsGraphite() ? GRAPHITE : MODEL;
}
