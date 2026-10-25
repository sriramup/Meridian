// Streetscape: seating, lighting, bollards, bins, bike parking, hydrants, signs, mailboxes,
// planters, kiosks, parklets, dining, fountains, toilets, and linear fences / walls / railings.

import type { Solid } from "@/world/types";
import type { PrimitiveDef } from "../types";
import { C, hexToRgb, shade } from "../geometry/palette";
import { S, beam, box, cyl, moveSolids, type RGB } from "../geometry/solids";
import { benchSolids, binSolids, bikeRackSolids, bollardSolids, hydrantSolids, lampSolids, mailboxSolids, planterSolids, shrubSolids, signSolids, type BenchStyle, type BinKind, type LampStyle, type PlanterShape, type RackStyle, type SignKind } from "../geometry/props";
import { linearDef, propDef, rowDef } from "./kinds";
import { bool, choice, color, int, num, opts } from "./params";

const SS = "streetscape" as const;
const D = "Dimensions",
  A = "Appearance";

const BENCH_STYLES = opts("classic", "backless", "modern", "park", "picnic", "curved", "stone");
const LAMP_STYLES: { value: LampStyle; label: string; description: string }[] = [
  { value: "cobra", label: "Cobra head (roadway)", description: "25–40 ft roadway luminaire on an arm" },
  { value: "double", label: "Double arm (median)", description: "Two luminaires for medians and lots" },
  { value: "acorn", label: "Acorn (pedestrian)", description: "Globe on a decorative post, 12–15 ft" },
  { value: "historic", label: "Historic post", description: "Fluted base and lantern" },
  { value: "post_top", label: "Post-top", description: "Disc luminaire on a straight post" },
  { value: "pedestrian", label: "Pedestrian column", description: "Low column light for paths" },
  { value: "modern", label: "Modern blade", description: "Linear LED head" },
  { value: "high_mast", label: "High mast", description: "65–130 ft ring of floodlights (interchanges, yards)" },
];

const lampParams = [
  choice("style", "Style", "cobra", LAMP_STYLES, { group: A }),
  num("height", "Mounting height", 9, { group: D, unit: "m", min: 2.5, max: 40, step: 0.5, description: "Pedestrian 12–20 ft, roadway 25–40 ft, high mast 65–130 ft" }),
  num("arm", "Arm length", 1.8, { group: D, unit: "m", min: 0.3, max: 6, step: 0.1, when: { key: "style", in: ["cobra", "double", "modern"] } }),
  color("poleColor", "Pole colour", "#3e4248", { group: A, swatches: ["#3e4248", "#787e84", "#2a5a3c", "#1e1e1e", "#f0f0ec"] }),
  color("lightColor", "Light colour", "#ffecb4", { group: A, swatches: ["#ffecb4", "#fff6e0", "#e8f0ff"], advanced: true }),
];
const lamp = (r: { s: (k: string) => string; n: (k: string) => number; c: (k: string) => string }) =>
  lampSolids(r.s("style") as LampStyle, r.n("height"), r.n("arm"), hexToRgb(r.c("poleColor")), hexToRgb(r.c("lightColor")));

export const STREETSCAPE: PrimitiveDef[] = [
  propDef({
    id: "streetscape.bench",
    name: "Bench",
    category: SS,
    tags: ["seat", "seating", "park bench", "street furniture", "picnic table"],
    description: "Bench in several styles; standard 6 ft long, 18 in seat height.",
    icon: "armchair",
    params: [
      choice("style", "Style", "classic", BENCH_STYLES, { group: A }),
      num("length", "Length", 1.8, { group: D, unit: "m", min: 0.6, max: 8, step: 0.1, description: "Typical 5–8 ft" }),
      bool("arms", "Armrests", true, { group: A, description: "Centre / end arms aid standing up" }),
      color("seatColor", "Seat colour", "#96704c", { group: A, swatches: ["#96704c", "#c4a070", "#3e4248", "#2a5a3c", "#b8b0a4"] }),
      color("frameColor", "Frame colour", "#3e4248", { group: A }),
    ],
    build: (r) => ({ solids: benchSolids(r.s("style") as BenchStyle, r.n("length"), hexToRgb(r.c("seatColor")), hexToRgb(r.c("frameColor")), r.b("arms")) }),
  }),
  propDef({
    id: "streetscape.street_lamp",
    name: "Street lamp",
    category: SS,
    tags: ["street light", "lamppost", "light pole", "luminaire", "lighting", "lantern"],
    description: "Street or path light: cobra head, double arm, acorn, historic, post-top, pedestrian, modern or high mast.",
    icon: "lamp",
    params: lampParams,
    build: (r) => ({ solids: lamp(r), anchorR: 0.35 }),
  }),
  rowDef({
    id: "streetscape.lamp_row",
    name: "Row of street lamps",
    category: SS,
    tags: ["lighting run", "lamps along street", "light poles"],
    description: "Street lights at a regular spacing along a line (typically 80–130 ft for roadway, 40–65 ft pedestrian).",
    icon: "lamp",
    params: [...lampParams, num("spacing", "Spacing", 30, { group: D, unit: "m", min: 3, max: 100, step: 0.5 }), num("offset", "Side offset", 0, { group: D, unit: "m", min: -30, max: 30, step: 0.5, description: "Shift left (+) / right (−) of the drawn line" }), bool("alternate", "Alternate sides", false, { group: D })],
    sideKey: "offset",
    item: (r, i) => ({ solids: r.b("alternate") && i % 2 ? moveSolids(lamp(r), 0, 0, 180) : moveSolids(lamp(r), 0, 0, 90), anchorR: 0.35 }),
  }),
  propDef({
    id: "streetscape.bollard",
    name: "Bollard",
    category: SS,
    tags: ["post", "barrier", "traffic post", "security bollard", "light bollard"],
    description: "Steel or concrete bollard ≈ 3 ft tall (crash-rated 8–12 in diameter).",
    icon: "circle-dot",
    siting: { carriageway: true },
    params: [
      num("height", "Height", 0.9, { group: D, unit: "m", min: 0.3, max: 1.5, step: 0.05 }),
      num("diameter", "Diameter", 0.2, { group: D, unit: "m", min: 0.08, max: 0.8, step: 0.01 }),
      bool("lit", "Lighted", false, { group: A }),
      color("color", "Colour", "#3e4248", { group: A, swatches: ["#3e4248", "#e8c440", "#c4c0ba", "#c43a30"] }),
    ],
    build: (r) => ({ solids: bollardSolids(r.n("height"), r.n("diameter"), hexToRgb(r.c("color")), r.b("lit")) }),
  }),
  rowDef({
    id: "streetscape.bollard_row",
    name: "Row of bollards",
    category: SS,
    tags: ["bollards", "barrier line", "vehicle barrier", "pedestrian protection"],
    description: "Bollards along a line; 4–5 ft clear spacing stops cars but passes wheelchairs and bikes.",
    icon: "circle-dot",
    siting: { carriageway: true },
    params: [num("spacing", "Spacing", 1.5, { group: D, unit: "m", min: 0.8, max: 20, step: 0.1 }), num("height", "Height", 0.9, { group: D, unit: "m", min: 0.3, max: 1.5, step: 0.05 }), num("diameter", "Diameter", 0.2, { group: D, unit: "m", min: 0.08, max: 0.8, step: 0.01 }), bool("lit", "Lighted", false, { group: A }), color("color", "Colour", "#3e4248", { group: A })],
    item: (r) => ({ solids: bollardSolids(r.n("height"), r.n("diameter"), hexToRgb(r.c("color")), r.b("lit")) }),
  }),
  propDef({
    id: "streetscape.trash_bin",
    name: "Trash / recycling bin",
    category: SS,
    tags: ["litter bin", "garbage can", "waste receptacle", "recycling", "compost", "dumpster", "bin"],
    description: "Litter, recycling or compost receptacle, dual bins, a solar compactor or a dumpster.",
    icon: "trash-2",
    params: [choice("kind", "Type", "trash", opts("trash", "recycling", "compost", "dual", "big_belly", "dumpster"), { group: A }), color("color", "Colour", "#3e4248", { group: A })],
    build: (r) => ({ solids: binSolids(r.s("kind") as BinKind, hexToRgb(r.c("color"))) }),
  }),
  propDef({
    id: "streetscape.bike_rack",
    name: "Bike rack",
    category: SS,
    tags: ["bicycle parking", "bike hoops", "inverted u", "cycle stands", "covered bike parking"],
    description: "Bicycle parking: inverted-U hoops 3 ft apart (2 bikes each), wave, post-and-ring, grid or covered.",
    icon: "bike",
    params: [choice("style", "Style", "inverted_u", opts("inverted_u", "wave", "post_ring", "grid", "covered"), { group: A }), int("hoops", "Hoops / stands", 5, { group: D, min: 1, max: 30, description: "Each holds two bikes" }), color("color", "Colour", "#787e84", { group: A })],
    build: (r) => ({ solids: bikeRackSolids(r.s("style") as RackStyle, r.n("hoops"), hexToRgb(r.c("color"))) }),
  }),
  propDef({
    id: "streetscape.fire_hydrant",
    name: "Fire hydrant",
    category: SS,
    tags: ["hydrant", "fire plug", "standpipe", "water"],
    description: "Dry-barrel fire hydrant; cap colour by NFPA 291 flow class (blue ≥ 1500 gpm, green, orange, red).",
    icon: "flame",
    params: [color("body", "Body colour", "#c43a30", { group: A, swatches: ["#c43a30", "#e8c440", "#f0f0ec", "#2a5a3c"] }), choice("flowClass", "Flow class (cap)", "aa", [{ value: "aa", label: "AA ≥ 1500 gpm (light blue)" }, { value: "a", label: "A 1000–1499 gpm (green)" }, { value: "b", label: "B 500–999 gpm (orange)" }, { value: "c", label: "C < 500 gpm (red)" }], { group: A })],
    build: (r) => ({ solids: hydrantSolids(hexToRgb(r.c("body")), ({ aa: [120, 180, 220], a: [70, 150, 80], b: [228, 128, 52], c: [196, 58, 48] } as Record<string, RGB>)[r.s("flowClass")] ?? C.white) }),
  }),
  propDef({
    id: "streetscape.street_sign",
    name: "Street sign",
    category: SS,
    tags: ["signpost", "stop sign", "yield", "speed limit", "parking sign", "wayfinding", "street name", "information board"],
    description: "Street-name blades, stop / yield / speed / parking signs, a wayfinding board or info panel (MUTCD 7 ft clearance).",
    icon: "signpost",
    params: [choice("kind", "Sign", "street_name", opts("street_name", "stop", "yield", "speed", "parking", "bus_stop", "wayfinding", "info_board"), { group: A }), num("height", "Post height", 2.7, { group: D, unit: "m", min: 1, max: 6, step: 0.1 }), color("color", "Panel colour", "#407e54", { group: A })],
    build: (r) => ({ solids: signSolids(r.s("kind") as SignKind, r.n("height"), hexToRgb(r.c("color"))) }),
  }),
  propDef({
    id: "streetscape.mailbox",
    name: "Mailbox",
    category: SS,
    tags: ["postbox", "letter box", "collection box", "usps", "cluster mailbox"],
    description: "Street collection box, residential post mailbox or cluster box unit.",
    icon: "mail",
    params: [choice("kind", "Type", "collection", opts("collection", "residential", "cluster"), { group: A }), color("color", "Colour", "#3c6ca8", { group: A, swatches: ["#3c6ca8", "#c43a30", "#2a5a3c", "#1e1e1e"] })],
    build: (r) => ({ solids: mailboxSolids(r.s("kind") as "collection", hexToRgb(r.c("color"))) }),
  }),
  propDef({
    id: "streetscape.planter",
    name: "Planter",
    category: SS,
    tags: ["planter box", "flower pot", "tree planter", "raised bed", "container planting"],
    description: "Concrete, timber or steel planter with shrubs and flowers.",
    icon: "flower",
    params: [
      choice("shape", "Shape", "round", opts("round", "square", "rect", "tiered"), { group: A }),
      num("width", "Width", 1.2, { group: D, unit: "m", min: 0.4, max: 8, step: 0.1 }),
      num("depth", "Depth", 1.2, { group: D, unit: "m", min: 0.4, max: 8, step: 0.1, when: { key: "shape", in: ["rect", "tiered"] } }),
      num("height", "Height", 0.6, { group: D, unit: "m", min: 0.2, max: 1.5, step: 0.05 }),
      color("color", "Planter colour", "#c4c0ba", { group: A, swatches: ["#c4c0ba", "#96704c", "#3e4248", "#b86246"] }),
      color("plant", "Foliage colour", "#62884e", { group: A }),
      bool("flowers", "Flowers", true, { group: A }),
      color("flowerColor", "Flower colour", "#d06890", { group: A, when: { key: "flowers", in: [true] } }),
    ],
    build: (r) => ({ solids: planterSolids(r.s("shape") as PlanterShape, r.n("width"), r.n("depth"), r.n("height"), hexToRgb(r.c("color")), hexToRgb(r.c("plant")), r.b("flowers") ? hexToRgb(r.c("flowerColor")) : undefined), cover: "planting" }),
  }),
  propDef({
    id: "streetscape.kiosk",
    name: "Kiosk",
    category: SS,
    tags: ["newsstand", "vendor", "booth", "coffee kiosk", "ticket booth", "information kiosk", "food stand"],
    description: "Small vending / information kiosk with a service window and canopy.",
    icon: "store",
    params: [num("width", "Width", 3, { group: D, unit: "m", min: 1.2, max: 8, step: 0.1 }), num("depth", "Depth", 2.2, { group: D, unit: "m", min: 1, max: 6, step: 0.1 }), num("height", "Height", 2.8, { group: D, unit: "m", min: 2.2, max: 5, step: 0.1 }), choice("roof", "Roof", "flat", opts("flat", "pyramid", "dome"), { group: A }), color("color", "Body colour", "#2a5a3c", { group: A }), color("canopyColor", "Canopy colour", "#d06048", { group: A })],
    build: (r) => {
      const w = r.n("width"),
        d = r.n("depth"),
        h = r.n("height");
      const body = hexToRgb(r.c("color"));
      const s: Solid[] = [box(0, 0, 0, w, d, h, body, "metal"), box(0, d / 2 + 0.02, 1.0, w * 0.7, 0.04, 1.1, C.glass, "glass"), box(0, d / 2 + 0.3, 0.95, w * 0.75, 0.6, 0.06, shade(body, 0.8), "metal")];
      s.push(S("box", [0, d / 2 + 0.45, h - 0.5], [w + 0.2, 1.0, 0.08], hexToRgb(r.c("canopyColor")), "fabric", 0, [-12, 0]));
      const rf = r.s("roof");
      if (rf === "pyramid") s.push(S("pyramid", [0, 0, h], [w + 0.4, d + 0.4, 1], shade(body, 0.8), "metal"));
      else if (rf === "dome") s.push(S("hemisphere", [0, 0, h], [Math.min(w, d), Math.min(w, d), Math.min(w, d) * 0.4], shade(body, 0.8), "metal"));
      else s.push(box(0, 0, h, w + 0.3, d + 0.3, 0.15, shade(body, 0.8), "metal"));
      return { solids: s };
    },
  }),
  propDef({
    id: "streetscape.parklet",
    name: "Parklet",
    category: SS,
    tags: ["curbside seating", "street seat", "pavement to parks", "pocket park", "platform"],
    description: "Kerbside platform in one or two parking spaces with planters, seating and a buffer rail (≈ 7 ft wide, 20–40 ft long).",
    icon: "trees",
    siting: { carriageway: true },
    params: [num("length", "Length", 11, { group: D, unit: "m", min: 4, max: 30, step: 0.5, description: "One parking space ≈ 20 ft" }), num("width", "Width", 2.1, { group: D, unit: "m", min: 1.5, max: 3.5, step: 0.1 }), int("seats", "Benches / tables", 3, { group: D, min: 0, max: 10 }), color("deck", "Deck colour", "#b48c64", { group: A })],
    build: (r) => {
      const L = r.n("length"),
        W = r.n("width");
      const s: Solid[] = [box(0, 0, 0, L, W, 0.15, hexToRgb(r.c("deck")), "wood")];
      // planters on the traffic side and ends, rail
      s.push(box(0, -W / 2 + 0.25, 0.15, L, 0.4, 0.55, C.woodDark, "wood"), S("box", [0, -W / 2 + 0.25, 0.7], [L * 0.95, 0.35, 0.4], C.foliage, "foliage"));
      for (const x of [-L / 2 + 0.25, L / 2 - 0.25]) s.push(box(x, 0, 0.15, 0.4, W, 0.9, C.woodDark, "wood"));
      const n = r.n("seats");
      for (let i = 0; i < n; i++) s.push(...moveSolids(benchSolids(i % 2 ? "backless" : "classic", 1.6), -L / 2 + 1.5 + ((L - 3) * (i + 0.5)) / n, W / 2 - 0.6, 180, 0.15));
      s.push(box(-L / 2 - 0.4, -W / 2 + 0.2, 0, 0.12, 0.12, 0.9, C.yellow, "plastic"), box(L / 2 + 0.4, -W / 2 + 0.2, 0, 0.12, 0.12, 0.9, C.yellow, "plastic"));
      return { solids: s };
    },
  }),
  propDef({
    id: "streetscape.outdoor_dining",
    name: "Outdoor dining",
    category: SS,
    tags: ["cafe seating", "patio", "sidewalk cafe", "terrace", "tables and chairs", "umbrellas", "streetery"],
    description: "Café tables with chairs and umbrellas inside a low barrier.",
    icon: "utensils",
    params: [int("tables", "Tables", 4, { group: D, min: 1, max: 24 }), int("rows", "Rows", 1, { group: D, min: 1, max: 4 }), bool("umbrellas", "Umbrellas", true, { group: A }), color("umbrellaColor", "Umbrella colour", "#f0f0ec", { group: A, when: { key: "umbrellas", in: [true] } }), bool("barrier", "Barrier", true, { group: A })],
    build: (r) => {
      const n = r.n("tables"),
        rows = r.n("rows");
      const sp = 2.2;
      const s: Solid[] = [];
      const per = Math.ceil(n / rows);
      for (let k = 0; k < n; k++) {
        const i = k % per,
          j = Math.floor(k / per);
        const x = (i - (per - 1) / 2) * sp,
          y = (j - (rows - 1) / 2) * sp;
        s.push(cyl(x, y, 0, 0.08, 0.72, C.black, "metal"), cyl(x, y, 0.72, 0.75, 0.04, C.white, "plastic"));
        for (const [dx, dy] of [[0.6, 0], [-0.6, 0]]) s.push(box(x + dx, y + dy, 0, 0.42, 0.42, 0.45, C.steelDark, "metal"), box(x + dx * 1.3, y + dy, 0.45, 0.06, 0.42, 0.4, C.steelDark, "metal"));
        if (r.b("umbrellas")) s.push(cyl(x, y, 0.76, 0.04, 1.6, C.wood, "wood"), S("cone", [x, y, 2.0], [2.0, 2.0, 0.45], hexToRgb(r.c("umbrellaColor")), "fabric"));
      }
      if (r.b("barrier")) {
        const W = per * sp + 0.6,
          Dd = rows * sp + 0.4;
        s.push(beam([-W / 2, -Dd / 2], [W / 2, -Dd / 2], 0, 0.05, 0.9, C.steelDark, "metal"), beam([-W / 2, -Dd / 2], [-W / 2, Dd / 2], 0, 0.05, 0.9, C.steelDark, "metal"), beam([W / 2, -Dd / 2], [W / 2, Dd / 2], 0, 0.05, 0.9, C.steelDark, "metal"));
      }
      return { solids: s };
    },
  }),
  propDef({
    id: "streetscape.drinking_fountain",
    name: "Drinking fountain",
    category: SS,
    tags: ["water fountain", "bubbler", "bottle filler", "water station"],
    description: "Pedestal drinking fountain with optional bottle filler and pet bowl (ADA hi-lo).",
    icon: "droplet",
    params: [bool("hiLo", "Hi-lo (accessible)", true, { group: A }), bool("bottleFiller", "Bottle filler", true, { group: A }), bool("petBowl", "Pet bowl", false, { group: A }), color("color", "Colour", "#3c6ca8", { group: A })],
    build: (r) => {
      const c = hexToRgb(r.c("color"));
      const s: Solid[] = [box(0, 0, 0, 0.35, 0.35, 0.95, c, "metal"), box(0, 0.15, 0.95, 0.45, 0.4, 0.08, C.steel, "metal")];
      if (r.b("hiLo")) s.push(box(0.55, 0, 0, 0.3, 0.3, 0.8, c, "metal"), box(0.55, 0.15, 0.8, 0.4, 0.4, 0.08, C.steel, "metal"));
      if (r.b("bottleFiller")) s.push(box(-0.45, 0, 0, 0.3, 0.3, 1.6, c, "metal"));
      if (r.b("petBowl")) s.push(cyl(0, 0.4, 0, 0.35, 0.12, C.steel, "metal"));
      return { solids: s };
    },
  }),
  propDef({
    id: "streetscape.public_toilet",
    name: "Public toilet",
    category: SS,
    tags: ["restroom", "loo", "wc", "portland loo", "comfort station", "bathroom", "public convenience"],
    description: "Freestanding single-stall public toilet (Portland Loo style, ≈ 10.5 × 6 ft) or a restroom block.",
    icon: "bath",
    params: [int("stalls", "Stalls", 1, { group: D, min: 1, max: 8 }), color("color", "Colour", "#4c6c78", { group: A }), bool("handwash", "Exterior hand-wash", true, { group: A })],
    build: (r) => {
      const n = r.n("stalls");
      const c = hexToRgb(r.c("color"));
      const W = 2.0 * n + 0.2;
      const s: Solid[] = [box(0, 0, 0, W, 1.9, 2.7, c, "metal"), box(0, 0, 2.7, W + 0.4, 2.3, 0.15, shade(c, 0.75), "metal")];
      for (let i = 0; i < n; i++) s.push(box(-W / 2 + 1.1 + i * 2.0, 0.97, 0, 0.9, 0.04, 2.1, shade(c, 0.7), "metal"));
      if (r.b("handwash")) s.push(box(W / 2 + 0.15, 0, 0.8, 0.3, 0.5, 0.3, C.steel, "metal"));
      return { solids: s };
    },
  }),
  propDef({
    id: "streetscape.parking_meter",
    name: "Parking pay station",
    category: SS,
    tags: ["parking meter", "pay and display", "pay station", "ticket machine"],
    description: "Single-space meter or multi-space pay-and-display station.",
    icon: "parking-meter",
    params: [choice("kind", "Type", "pay_station", opts("single", "double", "pay_station"), { group: A }), color("color", "Colour", "#3e4248", { group: A })],
    build: (r) => {
      const c = hexToRgb(r.c("color"));
      const k = r.s("kind");
      if (k === "pay_station") return { solids: [box(0, 0, 0, 0.45, 0.35, 1.7, c, "metal"), box(0, 0.18, 1.1, 0.3, 0.02, 0.3, C.glass, "glass")] };
      const s: Solid[] = [cyl(0, 0, 0, 0.08, 1.1, C.steel, "metal"), box(0, 0, 1.1, 0.25, 0.2, 0.4, c, "metal")];
      if (k === "double") s.push(box(0.27, 0, 1.1, 0.25, 0.2, 0.4, c, "metal"));
      return { solids: s };
    },
  }),
  propDef({
    id: "streetscape.bike_repair_stand",
    name: "Bike repair station",
    category: SS,
    tags: ["fix-it station", "bike pump", "repair stand", "cycling"],
    description: "Public bike repair stand with tools and a pump.",
    icon: "wrench",
    params: [color("color", "Colour", "#2a6cb0", { group: A })],
    build: (r) => ({ solids: [box(0, 0, 0, 0.2, 0.2, 1.4, hexToRgb(r.c("color")), "metal"), S("box", [0.2, 0, 1.3], [0.5, 0.06, 0.06], C.steel, "metal"), box(0.5, 0.2, 0, 0.15, 0.15, 0.9, hexToRgb(r.c("color")), "metal")] }),
  }),
  propDef({
    id: "streetscape.newspaper_boxes",
    name: "Newspaper / vending boxes",
    category: SS,
    tags: ["news rack", "vending box", "newsbox", "free paper"],
    description: "A row of newspaper vending boxes.",
    icon: "newspaper",
    params: [int("count", "Boxes", 3, { group: D, min: 1, max: 10 })],
    build: (r) => {
      const cols: RGB[] = [C.blue, C.red, C.yellow, C.green, C.white];
      return { solids: Array.from({ length: r.n("count") }, (_, i) => box((i - (r.n("count") - 1) / 2) * 0.55, 0, 0, 0.5, 0.45, 1.05, cols[i % cols.length], "metal")) };
    },
  }),
  propDef({
    id: "streetscape.tree_grate",
    name: "Tree pit with grate",
    category: SS,
    tags: ["tree well", "tree grate", "street tree pit", "silva cell"],
    description: "Sidewalk tree pit (5 × 5 ft minimum, larger for soil volume) with a cast-iron grate and guard.",
    icon: "grid-3x3",
    params: [num("size", "Pit size", 1.8, { group: D, unit: "m", min: 1, max: 4, step: 0.1 }), bool("guard", "Tree guard", true, { group: A })],
    build: (r) => {
      const z = r.n("size");
      const s: Solid[] = [box(0, 0, 0, z, z, 0.03, C.steelDark, "metal")];
      if (r.b("guard")) for (const [x, y] of [[-0.35, -0.35], [0.35, -0.35], [0.35, 0.35], [-0.35, 0.35]]) s.push(box(x, y, 0, 0.04, 0.04, 1.2, C.steelDark, "metal"));
      if (r.b("guard")) s.push(S("torus", [0, 0, 1.0], [0.8, 0.8, 0.04], C.steelDark, "metal"));
      return { solids: s, cover: "permeable" };
    },
  }),
  propDef({
    id: "streetscape.speed_hump",
    name: "Speed hump / table",
    category: SS,
    tags: ["traffic calming", "speed bump", "speed table", "raised crosswalk", "speed cushion"],
    description: "Traffic-calming hump (12 ft long, 3–4 in high) or a 22 ft speed table; place across the carriageway.",
    icon: "waves",
    siting: { carriageway: true, overlapProps: true },
    params: [choice("kind", "Type", "hump", opts("hump", "table", "cushion"), { group: A }), num("width", "Width across road", 7, { group: D, unit: "m", min: 2, max: 20, step: 0.1 }), num("length", "Length along road", 3.7, { group: D, unit: "m", min: 1, max: 10, step: 0.1 }), num("height", "Height", 0.08, { group: D, unit: "m", min: 0.03, max: 0.15, step: 0.005 })],
    build: (r) => {
      const k = r.s("kind");
      const W = r.n("width"),
        L = r.n("length"),
        h = r.n("height");
      if (k === "cushion") return { solids: [-1, 0, 1].map((i) => S("wedge", [0, i * (W / 3), 0], [L, 1.9, h], [176, 172, 166], "concrete", 90)) };
      if (k === "table") return { solids: [box(0, 0, 0, L * 0.6, W, h, [200, 196, 188], "concrete"), S("wedge", [0, 0, 0], [W, L, h], [176, 172, 166], "concrete", 90)] };
      return { solids: [S("wedge", [0, 0, 0], [W, L, h], [176, 172, 166], "concrete", 90), ...[-W / 4, W / 4].map((y) => box(0, y, h * 0.9, 0.3, 0.3, 0.02, C.white, "plastic"))] };
    },
  }),
  propDef({
    id: "streetscape.traffic_signal",
    name: "Traffic signal pole",
    category: SS,
    tags: ["traffic light", "stop light", "signal mast arm", "pedestrian signal"],
    description: "Mast-arm traffic signal pole with signal heads and pedestrian signal.",
    icon: "traffic-cone",
    params: [num("arm", "Mast-arm length", 8, { group: D, unit: "m", min: 2, max: 18, step: 0.5 }), int("heads", "Signal heads", 2, { group: D, min: 1, max: 5 }), num("height", "Arm height", 6.2, { group: D, unit: "m", min: 4.6, max: 8, step: 0.1, description: "MUTCD: signal heads 15–25.6 ft above the road" })],
    build: (r) => {
      const L = r.n("arm"),
        h = r.n("height");
      const s: Solid[] = [cyl(0, 0, 0, 0.3, h + 0.8, C.steelDark, "metal"), beam([0, 0], [L, 0], h, 0.18, 0.18, C.steelDark, "metal"), box(0, 0.25, 2.4, 0.3, 0.25, 0.45, C.black, "metal")];
      const n = r.n("heads");
      for (let i = 0; i < n; i++) {
        const x = L * (0.4 + (0.6 * (i + 0.5)) / n);
        s.push(box(x, 0, h - 1.1, 0.35, 0.3, 1.05, C.yellow, "metal"));
        s.push(S("sphere", [x, 0.16, h - 0.35], [0.2, 0.05, 0.2], [220, 60, 50], "light"), S("sphere", [x, 0.16, h - 0.95], [0.2, 0.05, 0.2], [80, 200, 120], "light"));
      }
      return { solids: s, anchorR: 0.4 };
    },
  }),
  // ---------------------------------------------------------------- linear
  linearDef({
    id: "streetscape.fence",
    name: "Fence",
    category: SS,
    tags: ["picket fence", "chain link", "railing fence", "wood fence", "privacy fence", "boundary"],
    description: "Fence along a drawn line: picket, privacy board, chain-link, wrought iron or ranch rail.",
    icon: "fence",
    params: [choice("style", "Style", "picket", opts("picket", "privacy", "chain_link", "wrought_iron", "ranch", "split_rail"), { group: A }), num("height", "Height", 1.2, { group: D, unit: "m", min: 0.5, max: 3, step: 0.05 }), num("postSpacing", "Post spacing", 2.4, { group: D, unit: "m", min: 1, max: 4, step: 0.1, advanced: true }), color("color", "Colour", "#f0f0ec", { group: A, swatches: ["#f0f0ec", "#96704c", "#3e4248", "#787e84"] })],
    segment: (r, len) => {
      const st = r.s("style");
      const h = r.n("height");
      const c = hexToRgb(r.c("color"));
      const n = Math.max(1, Math.round(len / r.n("postSpacing")));
      const s: Solid[] = [];
      const mat = st === "chain_link" || st === "wrought_iron" ? "metal" : "wood";
      for (let i = 0; i <= n; i++) s.push(box(-len / 2 + (len * i) / n, 0, 0, st === "ranch" || st === "split_rail" ? 0.14 : 0.09, st === "ranch" || st === "split_rail" ? 0.14 : 0.09, h + 0.05, c, mat));
      if (st === "privacy") s.push(box(0, 0, 0.05, len, 0.03, h - 0.05, c, "wood"));
      else if (st === "picket") {
        const k = Math.min(200, Math.floor(len / 0.15));
        for (let i = 0; i < k; i++) s.push(S("box", [-len / 2 + (i + 0.5) * (len / k), 0, 0.05], [0.07, 0.025, h - 0.1], c, "wood"));
        s.push(box(0, -0.03, h * 0.25, len, 0.03, 0.08, c, "wood"), box(0, -0.03, h * 0.75, len, 0.03, 0.08, c, "wood"));
      } else {
        const rails = st === "ranch" || st === "split_rail" ? 3 : 2;
        for (let i = 0; i < rails; i++) s.push(box(0, 0, h * ((i + 0.6) / (rails + 0.2)), len, st === "split_rail" ? 0.1 : 0.05, st === "split_rail" ? 0.1 : 0.05, c, mat));
        if (st === "wrought_iron") {
          const k = Math.min(250, Math.floor(len / 0.12));
          for (let i = 0; i < k; i++) s.push(box(-len / 2 + (i + 0.5) * (len / k), 0, 0, 0.02, 0.02, h, c, "metal"));
        }
      }
      return s;
    },
  }),
  linearDef({
    id: "streetscape.wall",
    name: "Wall",
    category: SS,
    tags: ["garden wall", "retaining wall", "stone wall", "brick wall", "sound wall", "screen wall", "seat wall"],
    description: "Freestanding, seat, retaining or sound wall along a drawn line, with optional coping.",
    icon: "brick-wall",
    params: [choice("material", "Material", "brick", opts("brick", "stone", "concrete", "stucco", "gabion"), { group: A }), num("height", "Height", 1.5, { group: D, unit: "m", min: 0.3, max: 8, step: 0.05, description: "Seat wall 18 in, garden 3–6 ft, sound wall 10–20 ft" }), num("thickness", "Thickness", 0.3, { group: D, unit: "m", min: 0.1, max: 1.5, step: 0.05 }), bool("coping", "Coping", true, { group: A }), bool("piers", "Piers", false, { group: A })],
    segment: (r, len) => {
      const colors: Record<string, RGB> = { brick: [168, 92, 72], stone: [184, 176, 164], concrete: [196, 192, 186], stucco: [238, 226, 200], gabion: [150, 146, 136] };
      const c = colors[r.s("material")] ?? C.concrete;
      const h = r.n("height"),
        t = r.n("thickness");
      const s: Solid[] = [box(0, 0, 0, len, t, h, c, "stone")];
      if (r.b("coping")) s.push(box(0, 0, h, len + 0.05, t + 0.08, 0.06, shade(c, 1.15), "stone"));
      if (r.b("piers")) {
        const n = Math.max(1, Math.round(len / 3));
        for (let i = 0; i <= n; i++) s.push(box(-len / 2 + (len * i) / n, 0, 0, t * 1.6, t * 1.6, h + 0.15, shade(c, 0.92), "stone"));
      }
      return s;
    },
  }),
  linearDef({
    id: "streetscape.railing",
    name: "Railing / guardrail",
    category: SS,
    tags: ["handrail", "guard rail", "barrier", "pedestrian rail", "w-beam", "jersey barrier"],
    description: "Pedestrian railing (42 in), highway W-beam guardrail or concrete Jersey barrier along a line.",
    icon: "fence",
    siting: { carriageway: true },
    params: [choice("kind", "Type", "pedestrian", opts("pedestrian", "guardrail", "jersey_barrier", "cable"), { group: A }), num("height", "Height", 1.07, { group: D, unit: "m", min: 0.5, max: 2, step: 0.01 }), color("color", "Colour", "#787e84", { group: A })],
    segment: (r, len) => {
      const k = r.s("kind");
      const c = hexToRgb(r.c("color"));
      const h = r.n("height");
      if (k === "jersey_barrier") return [box(0, 0, 0, len, 0.6, 0.25, C.concrete, "concrete"), box(0, 0, 0.25, len, 0.25, Math.max(0.3, h - 0.25), C.concrete, "concrete")];
      const n = Math.max(1, Math.round(len / (k === "guardrail" ? 1.9 : 1.5)));
      const s: Solid[] = [];
      for (let i = 0; i <= n; i++) s.push(box(-len / 2 + (len * i) / n, 0, 0, 0.08, 0.08, k === "guardrail" ? 0.75 : h, c, "metal"));
      if (k === "guardrail") s.push(box(0, 0.08, 0.45, len, 0.06, 0.32, C.steel, "metal"));
      else if (k === "cable") for (const z of [0.5, 0.7, 0.9]) s.push(box(0, 0, z * (h / 1.07), len, 0.02, 0.02, c, "metal"));
      else s.push(box(0, 0, h - 0.05, len, 0.06, 0.06, c, "metal"), box(0, 0, h * 0.45, len, 0.03, 0.03, c, "metal"));
      return s;
    },
  }),
  linearDef({
    id: "streetscape.hedge",
    name: "Hedge",
    category: SS,
    tags: ["hedgerow", "privet", "boxwood", "living fence", "green screen", "shrub border"],
    description: "Clipped or informal hedge along a drawn line.",
    icon: "trees",
    cover: "planting",
    params: [num("height", "Height", 1.4, { group: D, unit: "m", min: 0.3, max: 6, step: 0.1 }), num("width", "Width", 0.9, { group: D, unit: "m", min: 0.3, max: 4, step: 0.1 }), choice("form", "Form", "clipped", opts("clipped", "rounded", "informal"), { group: A }), color("color", "Colour", "#4e7a44", { group: A, swatches: ["#4e7a44", "#6a8c50", "#3c5e3a", "#8a6a3c"] })],
    segment: (r, len) => {
      const h = r.n("height"),
        w = r.n("width");
      const c = hexToRgb(r.c("color"));
      const f = r.s("form");
      if (f === "clipped") return [box(0, 0, 0, len, w, h, c, "foliage")];
      const n = Math.max(1, Math.round(len / (w * 0.9)));
      const s: Solid[] = [];
      for (let i = 0; i < n; i++) {
        const x = -len / 2 + (len * (i + 0.5)) / n;
        if (f === "rounded") s.push(S("sphere", [x, 0, 0], [len / n + w * 0.3, w, h], i % 2 ? c : shade(c, 1.08), "foliage"));
        else s.push(...moveSolids(shrubSolids("mound", w * 1.2, h, i % 3 ? c : shade(c, 1.1), undefined, i), x, 0));
      }
      return s;
    },
  }),
];
