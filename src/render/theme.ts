import type { AreaType, StripType, Use } from "@/world/types";

export type RGBA = [number, number, number, number];
export type RGB = [number, number, number];

export interface Theme {
  id: "model" | "night";
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
  background: "#e6e3de",
  ground: [229, 226, 221],
  land: [233, 230, 225],
  context: [224, 221, 216],
  contextBuilding: [236, 234, 230],
  contextRoad: [208, 205, 200],
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
  selection: [40, 71, 166],
  hover: [96, 128, 214],
  removed: [215, 70, 60],
  tree: [132, 160, 112],
  treeDark: [104, 134, 90],
  trunk: [120, 100, 80],
  path: [206, 196, 180],
  text: [52, 50, 47, 255],
  textHalo: [240, 238, 234, 230],
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
