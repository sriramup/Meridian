// Industrial and transport buildings and facilities.

import type { Solid } from "@/world/types";
import type { PrimitiveDef } from "../types";
import { frameOf, polyToWorld, subFrame } from "../geometry/frame";
import { C, hexToRgb, shade } from "../geometry/palette";
import { S, beam, box, cyl, moveSolids } from "../geometry/solids";
import { benchSolids, signSolids } from "../geometry/props";
import { BUILDING_PARAMS, buildBuilding, buildingType } from "./building";
import { areaL, canopySolids, parkingLot, rectL } from "./decor";
import { propDef, siteOf } from "./kinds";
import { Out } from "./make";
import { bool, choice, color, int, num, opts, reader } from "./params";

const IN = "industrial" as const,
  TR = "transport" as const;
const SITE = "Site",
  D = "Dimensions",
  A = "Appearance";

export const INDUSTRIAL: PrimitiveDef[] = [
  buildingType({
    id: "industrial.warehouse",
    name: "Warehouse",
    category: IN,
    tags: ["distribution center", "logistics", "storage", "fulfillment center", "shed", "depot"],
    description: "Tilt-up warehouse with loading docks and a truck court.",
    icon: "warehouse",
    defaults: { use: "industrial", width: 120, depth: 70, floors: 1, groundFloorHeight: 12, roofType: "flat", parapetHeight: 1, facade: "concrete", fitToSite: false, solar: true },
    extra: [int("docks", "Loading docks", 10, { group: SITE, min: 0, max: 60 }), num("truckCourt", "Truck court depth", 40, { group: SITE, unit: "m", min: 0, max: 80, step: 1, description: "≈ 40 m for 53 ft trailers" })],
    decorate: ({ r, out, info }) => {
      const [x0, , x1, y1] = info.bbox;
      const n = r.n("docks");
      const s: Solid[] = [];
      for (let i = 0; i < n; i++) s.push(box(x0 + ((x1 - x0) * (i + 0.5)) / n, y1 + 0.05, 0, 3, 0.15, 3.2, [120, 126, 132], "metal"));
      if (n) s.push(box((x0 + x1) / 2, y1 + 1.5, 4.2, ((x1 - x0) * n) / Math.max(n, 1) * 0.95, 3, 0.2, C.steel, "metal"));
      info.addSolids(s);
      if (r.n("truckCourt") > 0) areaL(out, info.frame, "parking", rectL((x0 + x1) / 2, y1 + r.n("truckCourt") / 2, x1 - x0, r.n("truckCourt")));
    },
  }),
  buildingType({
    id: "industrial.factory",
    name: "Factory",
    category: IN,
    tags: ["manufacturing", "plant", "mill", "works", "industrial building", "foundry"],
    description: "Manufacturing hall with a sawtooth roof and chimney stacks.",
    icon: "factory",
    defaults: { use: "industrial", width: 90, depth: 60, floors: 1, groundFloorHeight: 10, roofType: "sawtooth", teeth: 8, roofPitch: 25, roofMaterial: "metal_standing_seam", facade: "brick_brown", fitToSite: false },
    extra: [int("stacks", "Chimney stacks", 2, { group: SITE, min: 0, max: 6 }), num("stackHeight", "Stack height", 35, { group: SITE, unit: "m", min: 10, max: 150, step: 1, when: { key: "stacks", in: [1, 2, 3, 4, 5, 6] } })],
    decorate: ({ r, info }) => {
      const [x0, y0] = info.bbox;
      const s: Solid[] = [];
      for (let i = 0; i < r.n("stacks"); i++) s.push(cyl(x0 + 6 + i * 7, y0 - 5, 0, 3.2, r.n("stackHeight"), [150, 90, 76], "stone"), cyl(x0 + 6 + i * 7, y0 - 5, r.n("stackHeight") - 2, 3.5, 1, C.steelDark, "metal"));
      info.addSolids(s);
    },
  }),
  buildingType({
    id: "industrial.workshop",
    name: "Workshop / maker space",
    category: IN,
    tags: ["light industrial", "garage", "auto repair", "maker space", "studio", "flex space", "shed"],
    description: "Small light-industrial unit with roll-up doors.",
    icon: "wrench",
    defaults: { use: "industrial", width: 30, depth: 18, floors: 1, groundFloorHeight: 6, roofType: "gable", roofPitch: 12, roofMaterial: "metal_standing_seam", facade: "corrugated", parapetHeight: 0, fitToSite: false },
    extra: [int("doors", "Roll-up doors", 3, { group: SITE, min: 0, max: 10 })],
    decorate: ({ r, info }) => {
      const [x0, , x1, y1] = info.bbox;
      const n = r.n("doors");
      const s: Solid[] = [];
      for (let i = 0; i < n; i++) s.push(box(x0 + ((x1 - x0) * (i + 0.5)) / n, y1 + 0.05, 0, Math.min(4, ((x1 - x0) / n) * 0.7), 0.12, 4, [196, 194, 188], "metal"));
      info.addSolids(s);
    },
  }),
  buildingType({
    id: "industrial.data_center",
    name: "Data centre",
    category: IN,
    tags: ["data center", "server farm", "colocation", "hyperscale", "cloud"],
    description: "Windowless data hall with rooftop chillers and backup generators.",
    icon: "server",
    defaults: { use: "industrial", width: 110, depth: 60, floors: 2, groundFloorHeight: 7, floorHeight: 7, roofType: "flat", facade: "metal_silver", fitToSite: false, jobs: 40, entrance: true },
    extra: [int("chillers", "Rooftop chillers", 12, { group: SITE, min: 0, max: 60 }), int("generators", "Backup generators", 6, { group: SITE, min: 0, max: 40 })],
    decorate: ({ r, info }) => {
      const [x0, y0, x1, y1] = info.bbox;
      const s: Solid[] = [];
      const n = r.n("chillers");
      const cols = Math.max(1, Math.ceil(Math.sqrt(n * 3)));
      for (let i = 0; i < n; i++) s.push(box(x0 + 6 + (i % cols) * ((x1 - x0 - 12) / cols), y0 + 8 + Math.floor(i / cols) * 8, info.height, 6, 2.5, 2.6, C.steel, "metal"));
      for (let i = 0; i < r.n("generators"); i++) s.push(box(x0 + 5 + i * 7, y1 + 6, 0, 5, 2.5, 3, [220, 220, 214], "metal"), cyl(x0 + 6 + i * 7, y1 + 6, 3, 0.4, 2, C.steelDark, "metal"));
      info.addSolids(s);
    },
  }),
  buildingType({
    id: "industrial.self_storage",
    name: "Self-storage",
    category: IN,
    tags: ["storage units", "mini storage", "lockers"],
    description: "Multi-storey self-storage building.",
    icon: "package",
    defaults: { use: "industrial", width: 60, depth: 30, floors: 4, groundFloorHeight: 4, floorHeight: 3.2, roofType: "flat", facade: "metal_silver", fitToSite: false, jobs: 4, awning: true, awningColor: "#e48034" },
  }),
  propDef({
    id: "industrial.storage_tanks",
    name: "Storage tanks",
    category: IN,
    tags: ["silos", "fuel tanks", "oil tanks", "grain silo", "tank farm"],
    description: "A row of cylindrical tanks or silos (fuel, water, grain).",
    icon: "cylinder",
    params: [int("count", "Tanks", 3, { group: D, min: 1, max: 12 }), num("diameter", "Diameter", 12, { group: D, unit: "m", min: 2, max: 60, step: 0.5 }), num("height", "Height", 14, { group: D, unit: "m", min: 2, max: 60, step: 0.5 }), choice("top", "Top", "cone", opts("cone", "dome", "flat"), { group: A }), color("color", "Colour", "#e8e6e0", { group: A })],
    build: (r) => {
      const n = r.n("count"),
        d = r.n("diameter"),
        h = r.n("height");
      const c = hexToRgb(r.c("color"));
      const s: Solid[] = [];
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * d * 1.3;
        s.push(cyl(x, 0, 0, d, h, c, "metal"));
        if (r.s("top") === "cone") s.push(S("cone", [x, 0, h], [d, d, d * 0.2], shade(c, 0.9), "metal"));
        if (r.s("top") === "dome") s.push(S("hemisphere", [x, 0, h], [d, d, d * 0.25], shade(c, 0.9), "metal"));
      }
      return { solids: s };
    },
  }),
];

const shelterParams = [
  choice("style", "Style", "glass", opts("glass", "canopy", "historic", "minimal"), { group: A }),
  num("length", "Length", 4.5, { group: D, unit: "m", min: 1.5, max: 30, step: 0.1, description: "Standard 3–6 m" }),
  num("depth", "Depth", 1.6, { group: D, unit: "m", min: 1, max: 4, step: 0.1 }),
  num("height", "Height", 2.6, { group: D, unit: "m", min: 2.2, max: 4.5, step: 0.1 }),
  bool("bench", "Bench", true, { group: A }),
  bool("adPanel", "Map / ad panel", true, { group: A }),
  bool("realtime", "Real-time display", true, { group: A }),
  color("frameColor", "Frame colour", "#3e4248", { group: A }),
];

function shelterSolids(r: ReturnType<typeof reader>) {
  const L = r.n("length"),
    Dp = r.n("depth"),
    h = r.n("height");
  const fc = hexToRgb(r.c("frameColor"));
  const st = r.s("style");
  const s: Solid[] = [];
  for (const x of [-L / 2 + 0.1, L / 2 - 0.1]) for (const y of st === "canopy" ? [-Dp / 2 + 0.1] : [-Dp / 2 + 0.1, Dp / 2 - 0.1]) s.push(box(x, y, 0, 0.1, 0.1, h, fc, "metal"));
  s.push(S("box", [0, 0, h], [L + 0.4, Dp + 0.4, 0.15], st === "historic" ? [42, 90, 60] : fc, "metal", 0, [st === "canopy" ? -5 : 0, 0]));
  if (st === "glass" || st === "historic") s.push(box(0, -Dp / 2 + 0.05, 0.15, L - 0.2, 0.03, h - 0.3, C.glass, "glass"), box(-L / 2 + 0.08, 0, 0.15, 0.03, Dp - 0.2, h - 0.3, C.glass, "glass"));
  if (st === "historic") s.push(S("wedge", [0, 0, h + 0.15], [L + 0.4, Dp + 0.4, 0.6], [42, 90, 60], "metal"));
  if (r.b("bench")) s.push(...moveSolids(benchSolids("backless", Math.min(L - 1, 2.4)), 0, -Dp / 2 + 0.45));
  if (r.b("adPanel")) s.push(box(L / 2 - 0.08, 0, 0.3, 0.12, Dp * 0.8, 1.8, C.light, "light"));
  if (r.b("realtime")) s.push(box(0, 0, h - 0.5, 0.8, 0.1, 0.3, C.black, "light"));
  return s;
}

const LOT_PARAMS = [num("width", "Width", 60, { group: D, unit: "m", min: 10, max: 500, step: 1 }), num("depth", "Depth", 40, { group: D, unit: "m", min: 10, max: 500, step: 1 }), bool("lights", "Lights", true, { group: A }), bool("trees", "Edge trees", true, { group: A }), bool("permeable", "Permeable paving", false, { group: A, description: "Counted as permeable in the runoff model" })];
const HUB_PARAMS = [int("bays", "Bus bays", 6, { group: D, min: 2, max: 24 }), num("canopyLength", "Canopy length", 70, { group: D, unit: "m", min: 15, max: 300, step: 1 }), bool("station", "Station building", true, { group: A }), bool("bikeShare", "Bike share", true, { group: A })];

export const TRANSPORT: PrimitiveDef[] = [
  propDef({
    id: "transport.bus_shelter",
    name: "Bus shelter",
    category: TR,
    tags: ["bus stop", "transit shelter", "tram stop", "waiting shelter"],
    description: "Transit shelter with bench, map panel and real-time display (glass, canopy, historic or minimal).",
    icon: "bus",
    params: shelterParams,
    build: (r) => ({ solids: shelterSolids(r), shade: { r: Math.max(1, r.n("length") / 2), h: r.n("height") } }),
  }),
  propDef({
    id: "transport.transit_stop_sign",
    name: "Transit stop sign",
    category: TR,
    tags: ["bus stop pole", "bus stop sign", "flag stop", "stop marker"],
    description: "Bus / tram stop flag on a pole with a timetable case.",
    icon: "signpost",
    params: [num("height", "Height", 2.8, { group: D, unit: "m", min: 2, max: 4, step: 0.1 })],
    build: (r) => ({ solids: signSolids("bus_stop", r.n("height")) }),
  }),
  buildingType({
    id: "transport.train_station",
    name: "Train station",
    category: TR,
    tags: ["railway station", "rail station", "depot", "commuter rail", "metro station", "light rail station"],
    description: "Station building with a barrel-vaulted hall and covered platforms.",
    icon: "train-front",
    defaults: { use: "civic", width: 80, depth: 30, floors: 2, groundFloorHeight: 8, floorHeight: 6, roofType: "barrel", roofRise: 0.6, roofMaterial: "glass", facade: "brick_red", fitToSite: false, jobs: 60 },
    extra: [int("platforms", "Platforms", 2, { group: SITE, min: 1, max: 12 }), num("platformLength", "Platform length", 150, { group: SITE, unit: "m", min: 20, max: 400, step: 5 })],
    decorate: ({ r, out, info }) => {
      const [, y0] = info.bbox;
      const n = r.n("platforms"),
        L = r.n("platformLength");
      const s: Solid[] = [];
      for (let i = 0; i < n; i++) {
        const y = y0 - 8 - i * 14;
        s.push(box(0, y, 0, L, 6, 1.0, C.concrete, "concrete"), ...canopySolids(0, y, L * 0.7, 5, 4.5, [200, 204, 208], C.steel, Math.max(2, Math.round(L / 20))).slice(0, 1 + Math.max(2, Math.round(L / 20)) + 1));
        s.push(box(0, y - 5, 0, L * 1.1, 0.15, 0.2, C.steelDark, "metal"), box(0, y - 3.6, 0, L * 1.1, 0.15, 0.2, C.steelDark, "metal"));
      }
      info.addSolids(s);
      areaL(out, info.frame, "plaza", rectL(0, info.bbox[3] + 12, info.bbox[2] - info.bbox[0], 24));
    },
  }),
  buildingType({
    id: "transport.parking_garage",
    name: "Parking garage",
    category: TR,
    tags: ["parking structure", "multi-storey car park", "deck", "parkade", "ramp"],
    description: "Open-deck parking structure (≈ 30 m² per space) with a stair / elevator core.",
    icon: "square-parking",
    defaults: { use: "parking", width: 60, depth: 36, floors: 5, groundFloorHeight: 3.4, floorHeight: 3.1, roofType: "flat", parapetHeight: 1.1, facade: "concrete", fitToSite: false, entrance: true },
    extra: [bool("openDecks", "Open decks (spandrels)", true, { group: SITE })],
    decorate: ({ r, info }) => {
      if (!r.b("openDecks")) return;
      const [x0, y0, x1, y1] = info.bbox;
      const s: Solid[] = [];
      for (let f = 1; f < info.floors; f++) {
        const z = info.groundH + (f - 1) * 3.1;
        s.push(box((x0 + x1) / 2, y1 + 0.15, z, x1 - x0, 0.3, 1.1, [214, 212, 206], "concrete"), box((x0 + x1) / 2, y0 - 0.15, z, x1 - x0, 0.3, 1.1, [214, 212, 206], "concrete"));
      }
      s.push(box(x1 - 4, y1 - 4, 0, 6, 6, info.height + 3, [150, 178, 200], "glass"));
      info.addSolids(s);
    },
  }),
  {
    id: "transport.parking_lot",
    name: "Surface parking lot",
    category: TR,
    tags: ["car park", "parking", "lot", "stalls", "parking area"],
    description: "Striped surface lot: 2.6 × 5.5 m stalls on 18 m double-loaded bays, with lights and edge trees.",
    icon: "square-parking",
    placement: "rect",
    params: LOT_PARAMS,
    generate(values, place, ctx) {
      const r = reader(values, LOT_PARAMS);
      const out = new Out(ctx);
      const { frame } = siteOf(place, r.n("width"), r.n("depth"));
      const W = frame.siteW || r.n("width"),
        Dd = frame.siteD || r.n("depth");
      const stalls = parkingLot(out, { ...frame, siteW: 0, siteD: 0 }, 0, 0, W, Dd, { lamps: r.b("lights"), trees: r.b("trees") });
      if (r.b("permeable")) for (const a of out.areas) a.type = "permeable";
      out.summary.push(`${stalls} stalls on ${Math.round(W * Dd).toLocaleString()} m² (${Math.round((W * Dd) / Math.max(1, stalls))} m² per stall)`);
      return out.done();
    },
  },
  propDef({
    id: "transport.bike_share_dock",
    name: "Bike-share dock",
    category: TR,
    tags: ["bikeshare", "bike share station", "docking station", "citi bike", "e-bike station"],
    description: "Bike-share station: docks in a row with a payment kiosk and bikes.",
    icon: "bike",
    params: [int("docks", "Docks", 12, { group: D, min: 3, max: 40 }), num("fill", "Bikes present", 60, { group: D, unit: "%", min: 0, max: 100, step: 5 }), color("color", "Brand colour", "#2a6cb0", { group: A })],
    build: (r) => {
      const n = r.n("docks");
      const c = hexToRgb(r.c("color"));
      const s: Solid[] = [box(0, 0, 0, n * 0.8 + 1.2, 0.5, 0.08, C.steelDark, "metal"), box(-(n * 0.8) / 2 - 0.4, 0, 0, 0.5, 0.4, 1.8, c, "metal"), box(-(n * 0.8) / 2 - 0.4, 0.21, 1.1, 0.35, 0.02, 0.4, C.light, "light")];
      const bikes = Math.round((n * r.n("fill")) / 100);
      for (let i = 0; i < n; i++) {
        const x = -(n * 0.8) / 2 + 0.6 + i * 0.8;
        s.push(box(x, 0, 0.08, 0.15, 0.25, 0.7, C.steel, "metal"));
        if (i < bikes) s.push(S("torus", [x, 0.6, 0], [0.04, 0.66, 0.66], C.black, "plastic", 0, [0, 90]), S("torus", [x, 1.6, 0], [0.04, 0.66, 0.66], C.black, "plastic", 0, [0, 90]), beam([x, 0.6], [x, 1.6], 0.6, 0.06, 0.06, c, "metal"), box(x, 1.5, 0.6, 0.06, 0.06, 0.45, c, "metal"), box(x, 0.7, 0.9, 0.5, 0.06, 0.06, C.black, "plastic"));
      }
      return { solids: s };
    },
  }),
  propDef({
    id: "transport.ev_charger",
    name: "EV chargers",
    category: TR,
    tags: ["electric vehicle charging", "charging station", "supercharger", "dcfc", "level 2"],
    description: "Electric-vehicle charging pedestals (Level 2 or DC fast) for a row of stalls, optional solar canopy.",
    icon: "plug-zap",
    params: [int("ports", "Chargers", 4, { group: D, min: 1, max: 20 }), choice("kind", "Type", "dcfc", [{ value: "level2", label: "Level 2 (pedestal)" }, { value: "dcfc", label: "DC fast (cabinet)" }], { group: A }), bool("canopy", "Solar canopy", false, { group: A }), color("color", "Colour", "#2a8c5c", { group: A })],
    build: (r) => {
      const n = r.n("ports");
      const c = hexToRgb(r.c("color"));
      const s: Solid[] = [];
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * 2.7;
        s.push(box(x, 0, 0, 0.9, 0.9, 0.15, C.concrete, "concrete"));
        if (r.s("kind") === "dcfc") s.push(box(x, 0, 0.15, 0.7, 0.45, 2.0, C.white, "metal"), box(x, 0.23, 1.2, 0.5, 0.02, 0.4, C.light, "light"), box(x, 0, 2.15, 0.75, 0.5, 0.15, c, "metal"));
        else s.push(box(x, 0, 0.15, 0.3, 0.25, 1.4, c, "metal"), box(x, 0.13, 1.0, 0.2, 0.02, 0.2, C.light, "light"));
      }
      if (r.b("canopy")) s.push(...canopySolids(0, -2.5, n * 2.7 + 0.6, 6, 3.4, [46, 62, 92], C.steel, Math.max(2, Math.ceil(n / 2))).slice(0, 1).concat(Array.from({ length: Math.max(2, Math.ceil(n / 2)) }, (_, k) => box(-(n * 2.7) / 2 + ((n * 2.7) * (k + 0.5)) / Math.max(2, Math.ceil(n / 2)), -2.5, 0, 0.3, 0.3, 3.4, C.steel, "metal"))));
      return { solids: s };
    },
  }),
  {
    id: "transport.transit_hub",
    name: "Transit hub",
    category: TR,
    tags: ["bus terminal", "transit center", "interchange", "mobility hub", "bus station"],
    description: "Bus interchange: island platform with a long canopy, bus bays, shelters, bike share and a small station building.",
    icon: "bus",
    placement: "rect",
    params: HUB_PARAMS,
    generate(values, place, ctx) {
      const r = reader(values, HUB_PARAMS);
      const out = new Out(ctx);
      const f = frameOf(place);
      const L = r.n("canopyLength");
      const n = r.n("bays");
      out.area("plaza", polyToWorld(f, rectL(0, 0, L + 10, 12)), { primary: true });
      out.area("parking", polyToWorld(f, rectL(0, 13, L + 20, 14)), { primary: false });
      const s: Solid[] = [...canopySolids(0, 0, L, 9, 5, [236, 236, 232], C.steel, Math.max(2, Math.round(L / 15)))];
      for (let i = 0; i < n; i++) s.push(box(-L / 2 + (L * (i + 0.5)) / n, 6.2, 0, 0.15, 3, 0.02, C.yellow, "plastic"));
      for (let i = 0; i < n; i++) s.push(...moveSolids(benchSolids("backless", 2.4), -L / 2 + (L * (i + 0.5)) / n, 0));
      out.prop("transport.transit_hub", f, s, { primary: false, shade: { r: L / 2, h: 5 } });
      if (r.b("station")) buildBuilding(out, reader({ use: "civic", width: 24, depth: 12, floors: 1, groundFloorHeight: 5, roofType: "shed", roofPitch: 8, facade: "glass_clear", fitToSite: false, jobs: 10, name: "Transit centre" }, BUILDING_PARAMS), subFrame(f, [-L / 2 - 16, -2]), {}, false);
      if (r.b("bikeShare")) out.prop("transport.bike_share_dock", subFrame(f, [L / 2 + 6, -3], 90), [box(0, 0, 0, 8, 0.5, 0.08, C.steelDark, "metal"), box(-4.4, 0, 0, 0.5, 0.4, 1.8, [42, 108, 176], "metal")], { primary: false });
      out.summary.push(`Transit hub: ${n} bus bays under a ${L} m canopy`);
      return out.done();
    },
  },
];
