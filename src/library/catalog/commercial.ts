// Commercial: shops, food, offices, hotels, services and entertainment — defaults over the
// universal building, with site elements (parking, canopies, pumps, drive-throughs, patios).

import type { Solid } from "@/world/types";
import type { ParamSpec, PrimitiveDef } from "../types";
import { type Frame, subFrame } from "../geometry/frame";
import { C, hexToRgb } from "../geometry/palette";
import { benchSolids } from "../geometry/props";
import { S, box, cyl } from "../geometry/solids";
import { buildingType, type DecorateArgs } from "./building";
import { areaL, canopySolids, parkingLot, rectL } from "./decor";
import { bool, color, int, num } from "./params";
import type { Reader } from "./params";

const CM = "commercial" as const;
const SITE = "Site";

/** parking params shared by car-oriented types */
export const parkingParams = (on: boolean, depth = 40): ParamSpec[] => [
  bool("parking", "Surface parking", on, { group: SITE, description: "Striped lot in front of the building (2.6 × 5.5 m stalls, 7 m aisles)" }),
  num("parkingDepth", "Parking depth", depth, { group: SITE, unit: "m", min: 10, max: 300, step: 1, when: { key: "parking", in: [true] }, description: "Each 18 m adds a double-loaded bay" }),
  bool("parkingTrees", "Lot trees and lights", true, { group: SITE, when: { key: "parking", in: [true] } }),
];

/** with a drawn site, push the building to the rear so the front can hold parking / forecourt */
export function atRear(r: Reader, f: Frame): Frame {
  if (!(f.siteW > 0) || r.b("fitToSite")) return f;
  const d = r.n("depth");
  const shift = Math.max(0, (f.siteD - d) / 2 - 3);
  return { ...f, c: [f.c[0] + Math.sin(f.a) * shift, f.c[1] - Math.cos(f.a) * shift], siteW: 0, siteD: 0, site: f.site };
}

/** parking lot in front (+y) of the building, as wide as the building (or the site) */
export function frontParking({ r, out, info, place }: DecorateArgs, width?: number): number {
  if (!r.b("parking")) return 0;
  const [x0, , x1, y1] = info.bbox;
  let depth = r.n("parkingDepth");
  if (place.site && info.frame.site) {
    // fill to the front of the drawn site
    depth = Math.max(18, Math.min(300, depth));
  }
  const w = width ?? Math.max(30, x1 - x0);
  const stalls = parkingLot(out, info.frame, (x0 + x1) / 2, y1 + 3 + depth / 2, w, depth, { lamps: r.b("parkingTrees"), trees: r.b("parkingTrees") });
  out.summary.push(`${stalls} parking stalls`);
  return stalls;
}

function pumps(n: number, cx: number, cy: number, spacing: number): Solid[] {
  const s: Solid[] = [];
  for (let i = 0; i < n; i++) {
    const x = cx - ((n - 1) * spacing) / 2 + i * spacing;
    s.push(box(x, cy, 0, 1.2, 4.5, 0.2, C.concrete, "concrete"), box(x, cy, 0.2, 0.7, 0.5, 1.7, C.white, "metal"), box(x, cy, 1.5, 0.75, 0.55, 0.3, C.red, "plastic"));
  }
  return s;
}

const shop = { use: "retail", floors: 1, groundFloorHeight: 5, roofType: "flat", parapetHeight: 1.2, awning: true, entrance: true };

export const COMMERCIAL: PrimitiveDef[] = [
  buildingType({
    id: "commercial.corner_store",
    name: "Corner store",
    category: CM,
    tags: ["bodega", "convenience store", "deli", "shop", "market", "neighbourhood retail"],
    description: "Small neighbourhood shop, optionally with apartments above.",
    icon: "store",
    defaults: { ...shop, width: 12, depth: 15, floors: 2, groundUse: "retail", use: "residential", facade: "brick_red", shape: "rect", corner: 2.5 },
  }),
  buildingType({
    id: "commercial.supermarket",
    name: "Supermarket",
    category: CM,
    tags: ["grocery store", "grocer", "food store", "market", "hypermarket"],
    description: "Full-service grocery store (≈ 4,000 m²) with a surface parking lot.",
    icon: "shopping-cart",
    defaults: { ...shop, width: 70, depth: 55, groundFloorHeight: 7, facade: "brick_buff", fitToSite: false },
    extra: parkingParams(true, 45),
    layout: atRear,
    decorate: (a) => frontParking(a),
  }),
  buildingType({
    id: "commercial.restaurant",
    name: "Restaurant",
    category: CM,
    tags: ["diner", "bistro", "eatery", "dining", "trattoria", "taqueria"],
    description: "Sit-down restaurant with a patio.",
    icon: "utensils",
    defaults: { ...shop, width: 18, depth: 20, groundFloorHeight: 5, roofType: "gable", roofPitch: 22, roofMaterial: "metal_standing_seam", facade: "stucco_cream", fitToSite: false },
    extra: [bool("patio", "Patio dining", true, { group: SITE }), int("patioTables", "Patio tables", 6, { group: SITE, min: 1, max: 30, when: { key: "patio", in: [true] } }), color("umbrellaColor", "Umbrella colour", "#2a5a3c", { group: SITE, when: { key: "patio", in: [true] } })],
    decorate: ({ r, out, info }) => {
      if (!r.b("patio")) return;
      const [x0, , x1, y1] = info.bbox;
      const n = r.n("patioTables");
      const per = Math.max(1, Math.min(n, Math.floor((x1 - x0) / 2.4)));
      const rows = Math.ceil(n / per);
      areaL(out, info.frame, "plaza", rectL((x0 + x1) / 2, y1 + 0.5 + rows * 1.2, x1 - x0, rows * 2.4 + 1));
      const s: Solid[] = [];
      for (let k = 0; k < n; k++) {
        const x = x0 + 1.4 + (k % per) * 2.4,
          y = y1 + 1.8 + Math.floor(k / per) * 2.4;
        s.push(cyl(x, y, 0, 0.08, 0.72, C.black, "metal"), cyl(x, y, 0.72, 0.8, 0.04, C.white, "plastic"), cyl(x, y, 0.76, 0.04, 1.5, C.wood, "wood"), S("cone", [x, y, 1.95], [2.1, 2.1, 0.4], hexToRgb(r.c("umbrellaColor")), "fabric"));
      }
      info.addSolids(s);
    },
  }),
  buildingType({
    id: "commercial.cafe",
    name: "Café",
    category: CM,
    tags: ["coffee shop", "coffeehouse", "bakery", "tea room", "espresso bar"],
    description: "Small café with an awning and sidewalk tables.",
    icon: "coffee",
    defaults: { ...shop, width: 9, depth: 14, floors: 1, facade: "brick_red", awningColor: "#2a5a3c", fitToSite: false },
    extra: [int("tables", "Sidewalk tables", 3, { group: SITE, min: 0, max: 12 })],
    decorate: ({ r, out, info }) => {
      const n = r.n("tables");
      if (!n) return;
      const { mid, n: nn } = info.front;
      const t: [number, number] = [-nn[1], nn[0]];
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 2.2;
        const p: [number, number] = [mid[0] + nn[0] * 2.4 + t[0] * off, mid[1] + nn[1] * 2.4 + t[1] * off];
        out.prop("streetscape.outdoor_dining", subFrame(info.frame, p), [cyl(0, 0, 0, 0.06, 0.72, C.black, "metal"), cyl(0, 0, 0.72, 0.6, 0.03, C.white, "metal"), ...[[-0.5, 0], [0.5, 0]].map(([x, y]) => box(x, y, 0, 0.4, 0.4, 0.45, C.steelDark, "metal"))], { primary: false });
      }
    },
  }),
  buildingType({
    id: "commercial.fast_food",
    name: "Fast-food restaurant with drive-through",
    category: CM,
    tags: ["drive-thru", "drive through", "quick service", "burger", "qsr", "takeaway"],
    description: "Quick-service restaurant with a drive-through lane (stacking for ≈ 8–12 cars), menu board and parking.",
    icon: "utensils",
    defaults: { ...shop, width: 20, depth: 14, groundFloorHeight: 5.5, roofType: "flat", parapetHeight: 1.5, facade: "stucco_terracotta", awningColor: "#e8c440", fitToSite: false },
    extra: [bool("driveThrough", "Drive-through lane", true, { group: SITE }), int("stacking", "Stacking spaces", 10, { group: SITE, min: 2, max: 20, when: { key: "driveThrough", in: [true] } }), ...parkingParams(true, 20)],
    decorate: (a) => {
      const { r, out, info } = a;
      const [x0, y0, x1, y1] = info.bbox;
      if (r.b("driveThrough")) {
        const lane = 3.6;
        const len = Math.max(y1 - y0 + 12, r.n("stacking") * 6);
        areaL(out, info.frame, "parking", rectL(x1 + 2 + lane / 2, (y0 + y1) / 2, lane, len));
        areaL(out, info.frame, "parking", rectL((x0 + x1) / 2 + lane / 2 + 1, y0 - 2 - lane / 2, x1 - x0 + lane + 4, lane));
        info.addSolids([box(x1 + 0.4, (y0 + y1) / 2, 2.6, 1.4, 4, 0.2, C.yellow, "metal"), box(x1 + 2 + lane + 0.6, y1 - 2, 0, 0.3, 2.2, 2.0, C.black, "metal"), box(x1 + 2 + lane + 0.6, y1 - 2, 0.6, 0.1, 2.0, 1.2, C.light, "light")]);
      }
      frontParking(a);
    },
  }),
  buildingType({
    id: "commercial.strip_mall",
    name: "Strip mall",
    category: CM,
    tags: ["shopping strip", "strip center", "plaza shops", "retail row", "neighborhood center"],
    description: "Single-storey row of shops with a continuous canopy and a parking lot in front.",
    icon: "store",
    defaults: { ...shop, width: 90, depth: 20, groundFloorHeight: 5.5, parapetHeight: 1.6, facade: "stucco_cream", awningColor: "#3c6ca8", fitToSite: false },
    extra: [int("shopCount", "Storefronts", 8, { group: SITE, min: 1, max: 40 }), ...parkingParams(true, 38)],
    layout: atRear,
    decorate: (a) => {
      const { r, info } = a;
      const [x0, , x1, y1] = info.bbox;
      const n = r.n("shopCount");
      const s: Solid[] = [];
      for (let i = 1; i < n; i++) s.push(box(x0 + ((x1 - x0) * i) / n, y1 + 1, 0, 0.3, 2.2, 4.2, C.concrete, "concrete"));
      s.push(box((x0 + x1) / 2, y1 + 1.2, 3.6, x1 - x0, 2.6, 0.35, C.white, "metal"));
      for (let i = 0; i < n; i++) s.push(box(x0 + ((x1 - x0) * (i + 0.5)) / n, y1 + 0.05, 0, ((x1 - x0) / n) * 0.7, 0.1, 3.0, C.glass, "glass"));
      info.addSolids(s);
      frontParking(a);
    },
  }),
  buildingType({
    id: "commercial.shopping_mall",
    name: "Shopping mall",
    category: CM,
    tags: ["mall", "shopping centre", "galleria", "department store", "retail center"],
    description: "Two-level enclosed mall with anchor stores, skylit concourse and parking.",
    icon: "shopping-bag",
    defaults: { ...shop, shape: "h", width: 220, depth: 120, wing: 60, wing2: 40, floors: 2, groundFloorHeight: 6, floorHeight: 5.5, facade: "precast_white", awning: false, fitToSite: false, penthouse: true },
    extra: [bool("skylight", "Skylit concourse", true, { group: SITE }), ...parkingParams(true, 72)],
    layout: atRear,
    decorate: (a) => {
      const { r, info } = a;
      if (r.b("skylight")) {
        const [x0, , x1] = info.bbox;
        info.addSolids([S("cylinder", [x0 + 60, 0, info.height], [6, 14, x1 - x0 - 120], C.glass, "glass", 0, [0, 90])]);
      }
      frontParking(a);
    },
  }),
  buildingType({
    id: "commercial.big_box_store",
    name: "Big-box store",
    category: CM,
    tags: ["warehouse store", "superstore", "home improvement", "discount store", "hypermarket", "costco"],
    description: "Large single-storey store (≈ 10,000 m²) with a garden centre and a big parking field.",
    icon: "warehouse",
    defaults: { ...shop, width: 120, depth: 90, groundFloorHeight: 9, parapetHeight: 2, facade: "concrete", awningColor: "#c43a30", fitToSite: false, solar: true },
    extra: parkingParams(true, 90),
    layout: atRear,
    decorate: (a) => frontParking(a),
  }),
  buildingType({
    id: "commercial.office_building",
    name: "Office building",
    category: CM,
    tags: ["offices", "workplace", "commercial office", "low-rise office", "headquarters"],
    description: "Four- to eight-storey office building with a deep floor plate.",
    icon: "building",
    defaults: { use: "office", width: 50, depth: 30, floors: 6, roofType: "flat", facade: "glass_green", penthouse: true, groundFloorHeight: 5 },
  }),
  buildingType({
    id: "commercial.office_tower",
    name: "Office tower",
    category: CM,
    tags: ["skyscraper", "high-rise office", "corporate tower", "class a office", "cbd"],
    description: "High-rise office tower on a podium with a crown.",
    icon: "building-2",
    defaults: { use: "office", width: 60, depth: 55, floors: 45, podiumFloors: 4, towerCoverage: 45, roofType: "flat", facade: "glass_blue", penthouse: true, groundUse: "retail", setbackEvery: 0 },
  }),
  buildingType({
    id: "commercial.hotel",
    name: "Hotel",
    category: CM,
    tags: ["inn", "motel", "lodging", "resort", "accommodation"],
    description: "Mid-rise hotel with a lobby podium and a porte-cochère.",
    icon: "bed",
    defaults: { use: "hotel", shape: "t", width: 60, depth: 40, wing: 18, wing2: 18, floors: 12, podiumFloors: 2, towerCoverage: 70, roofType: "flat", facade: "precast_white", penthouse: true, awning: true },
    extra: [bool("porteCochere", "Porte-cochère", true, { group: SITE })],
    decorate: ({ r, info }) => {
      if (!r.b("porteCochere")) return;
      const { mid, n, rot } = info.front;
      const c: [number, number] = [mid[0] + n[0] * 5, mid[1] + n[1] * 5];
      info.addSolids([S("box", [c[0], c[1], 4.2], [14, 9, 0.6], C.white, "metal", rot), ...[-6, 6].map((dx) => S("box", [c[0] + Math.cos((rot * Math.PI) / 180) * dx + n[0] * 3.5, c[1] + Math.sin((rot * Math.PI) / 180) * dx + n[1] * 3.5, 0], [0.5, 0.5, 4.2], C.steel, "metal"))]);
    },
  }),
  buildingType({
    id: "commercial.motel",
    name: "Motel",
    category: CM,
    tags: ["motor inn", "roadside motel", "motor lodge"],
    description: "Two-storey motel with exterior corridors facing its parking.",
    icon: "bed",
    defaults: { use: "hotel", shape: "l", width: 60, depth: 40, wing: 12, wing2: 12, floors: 2, roofType: "hip", roofPitch: 18, parapetHeight: 0, facade: "stucco_cream", balconies: true, balconyDepth: 1.6, fitToSite: false },
    extra: parkingParams(true, 20),
    decorate: (a) => frontParking(a),
  }),
  buildingType({
    id: "commercial.gas_station",
    name: "Gas station",
    category: CM,
    tags: ["petrol station", "filling station", "fuel", "service station", "c-store"],
    description: "Convenience store with a fuel canopy over pump islands.",
    icon: "fuel",
    defaults: { ...shop, width: 20, depth: 14, groundFloorHeight: 4.8, facade: "stucco_white", awningColor: "#c43a30", fitToSite: false },
    extra: [int("pumpIslands", "Pump islands", 4, { group: SITE, min: 1, max: 12 }), num("canopyHeight", "Canopy clearance", 5.2, { group: SITE, unit: "m", min: 4.3, max: 7, step: 0.1 }), color("canopyColor", "Canopy colour", "#f0f0ec", { group: SITE })],
    decorate: ({ r, out, info }) => {
      const [x0, , x1, y1] = info.bbox;
      const n = r.n("pumpIslands");
      const w = Math.max(16, n * 7.5),
        d = 14;
      const cy = y1 + 8 + d / 2;
      const cx = (x0 + x1) / 2;
      areaL(out, info.frame, "parking", rectL(cx, cy, w + 12, d + 12));
      info.addSolids([...canopySolids(cx, cy, w, d, r.n("canopyHeight"), hexToRgb(r.c("canopyColor")), C.steel, Math.max(2, Math.ceil(n / 2))), ...pumps(n, cx, cy, 7.5)]);
    },
  }),
  buildingType({
    id: "commercial.bank",
    name: "Bank",
    category: CM,
    tags: ["bank branch", "credit union", "financial", "atm"],
    description: "Bank branch with a classical stone facade and columned portico.",
    icon: "landmark",
    defaults: { use: "office", width: 24, depth: 20, floors: 2, groundFloorHeight: 6, roofType: "flat", parapetHeight: 1.5, facade: "limestone", fitToSite: false },
    extra: [bool("portico", "Columned portico", true, { group: SITE }), int("columns", "Columns", 6, { group: SITE, min: 2, max: 12, when: { key: "portico", in: [true] } })],
    decorate: ({ r, info }) => portico(info, r.n("columns"), r.b("portico")),
  }),
  buildingType({
    id: "commercial.cinema",
    name: "Cinema",
    category: CM,
    tags: ["movie theater", "multiplex", "theatre", "picture house", "movies"],
    description: "Multiplex cinema with a tall windowless auditorium block and a marquee.",
    icon: "clapperboard",
    defaults: { use: "retail", width: 60, depth: 50, floors: 2, groundFloorHeight: 7, floorHeight: 7, roofType: "flat", parapetHeight: 1.2, facade: "metal_dark", awning: true, awningColor: "#c43a30", jobs: 40 },
    extra: [bool("marquee", "Marquee", true, { group: SITE })],
    decorate: ({ r, info }) => {
      if (!r.b("marquee")) return;
      const { mid, n, rot } = info.front;
      info.addSolids([S("box", [mid[0] + n[0] * 1.5, mid[1] + n[1] * 1.5, 4.5], [Math.min(20, info.front.len * 0.6), 3, 1.6], C.light, "light", rot)]);
    },
  }),
  buildingType({
    id: "commercial.gym",
    name: "Gym / fitness centre",
    category: CM,
    tags: ["fitness", "health club", "sports club", "recreation centre", "ymca", "leisure centre"],
    description: "Fitness centre with a double-height glazed front.",
    icon: "dumbbell",
    defaults: { use: "retail", width: 40, depth: 35, floors: 2, groundFloorHeight: 6, roofType: "flat", facade: "glass_clear", jobs: 25 },
  }),
  buildingType({
    id: "commercial.shophouse",
    name: "Main-street shopfront",
    category: CM,
    tags: ["main street", "storefront", "shophouse", "two-part commercial block", "mixed use"],
    description: "Two- to four-storey main-street building: shop below, offices or flats above, cornice and awning.",
    icon: "store",
    defaults: { use: "residential", groundUse: "retail", width: 8, depth: 25, floors: 3, groundFloorHeight: 5, roofType: "flat", parapetHeight: 1.4, facade: "brick_red", awning: true, fitToSite: false },
  }),
  buildingType({
    id: "commercial.car_dealership",
    name: "Car dealership",
    category: CM,
    tags: ["auto dealer", "showroom", "car lot", "used cars"],
    description: "Glazed showroom with a service bay and a display lot.",
    icon: "car",
    defaults: { use: "retail", width: 45, depth: 30, floors: 1, groundFloorHeight: 7, roofType: "flat", facade: "glass_clear", fitToSite: false, jobs: 30 },
    extra: parkingParams(true, 40),
    layout: atRear,
    decorate: (a) => frontParking(a),
  }),
];

/** classical portico of columns with a pediment on the front facade (banks, civic buildings) */
export function portico(info: DecorateArgs["info"], cols: number, on = true, color: [number, number, number] = [236, 230, 216]): void {
  if (!on) return;
  const { mid, n, len, rot } = info.front;
  const w = Math.min(len * 0.8, cols * 3.2);
  const h = Math.min(info.height - 1, Math.max(5, info.groundH * 1.8));
  const depth = 3.2;
  const t: [number, number] = [-n[1], n[0]];
  const c: [number, number] = [mid[0] + n[0] * (depth / 2), mid[1] + n[1] * (depth / 2)];
  const s: Solid[] = [S("box", [c[0], c[1], 0], [w + 1, depth + 1, 0.6], color, "stone", rot)];
  for (let i = 0; i < cols; i++) {
    const off = -w / 2 + (w * (i + 0.5)) / cols;
    s.push(cyl(c[0] + t[0] * off + n[0] * 0.8, c[1] + t[1] * off + n[1] * 0.8, 0.6, 0.8, h - 0.6, color, "stone"));
  }
  s.push(S("box", [c[0], c[1], h], [w + 0.6, depth + 0.6, 0.9], color, "stone", rot));
  s.push(S("wedge", [c[0], c[1], h + 0.9], [depth + 0.6, w + 0.6, 2.2], color, "stone", rot + 90));
  info.addSolids(s);
}

export { benchSolids };
