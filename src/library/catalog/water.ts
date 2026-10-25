// Water: fountains, ponds, reflecting pools, splash pads, canals and streams (path → water band),
// retention ponds with storage depth, rain gardens and bioswales, docks and footbridges.

import { fmtArea, fmtFt, fmtLen, fmtVol } from "@/lib/units";
import { insetPoly, isValidPoly, polyArea, polyCentroid } from "@/geometry/polygon";
import type { Solid, Vec2 } from "@/world/types";
import type { ParamSpec, PrimitiveDef } from "../types";
import { rng } from "../geometry/frame";
import { C, hexToRgb, shade } from "../geometry/palette";
import { shrubSolids } from "../geometry/props";
import { S, beam, box, cyl, moveSolids } from "../geometry/solids";
import { bandPoly, defaultPath, offsetPath, pathLength, propDef, scatterIn, seedOf, siteOf, stations } from "./kinds";
import { Out } from "./make";
import { fountainSolids } from "./parks";
import { bool, choice, color, int, num, opts, reader } from "./params";

const WA = "water" as const;
const D = "Dimensions",
  A = "Appearance";

function edging(out: Out, ring: Vec2[], color: [number, number, number], h: number, w: number, type = "water.edge") {
  const c = polyCentroid([ring]);
  const s: Solid[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    s.push(S("box", [(a[0] + b[0]) / 2 - c[0], (a[1] + b[1]) / 2 - c[1], 0], [len + w * 0.5, w, h], color, "stone", (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI));
  }
  if (s.length) out.prop(type, { c, a: 0, siteW: 0, siteD: 0 }, s, { primary: false, height: h });
}

function blob(c: Vec2, rx: number, ry: number, seed: number, n = 28): Vec2[] {
  const rand = rng(seed);
  const ph = [rand() * 6, rand() * 6, rand() * 6];
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.12 * Math.sin(2 * a + ph[0]) + 0.08 * Math.sin(3 * a + ph[1]) + 0.05 * Math.sin(5 * a + ph[2]);
    out.push([c[0] + Math.cos(a) * rx * k, c[1] + Math.sin(a) * ry * k]);
  }
  return out;
}

const pondParams: ParamSpec[] = [
  num("width", "Width (if not drawn)", 40, { group: D, unit: "m", min: 3, max: 2000 }),
  num("depth", "Depth (if not drawn)", 25, { group: D, unit: "m", min: 3, max: 2000 }),
  choice("shape", "Shape", "natural", [{ value: "natural", label: "Natural (organic edge)" }, { value: "drawn", label: "As drawn" }], { group: D }),
  bool("reeds", "Reeds and marginal planting", true, { group: A }),
  bool("rocks", "Edge rocks", true, { group: A }),
  num("waterDepth", "Water depth", 1.5, { group: D, unit: "m", min: 0.2, max: 10, step: 0.1 }),
];

const pathWaterParams = (w: number, wall: boolean): ParamSpec[] => [
  num("width", "Water width", w, { group: D, unit: "m", min: 1, max: 200, step: 0.5 }),
  bool("walls", "Hard edges / walls", wall, { group: A }),
  bool("towpath", "Towpath / bank path", wall, { group: A }),
  num("bankPlanting", "Bank planting width", wall ? 0 : 4, { group: A, unit: "m", min: 0, max: 30, step: 0.5, description: "Riparian buffer on both banks (rain-garden cover)" }),
];

export const WATER: PrimitiveDef[] = [
  propDef({
    id: "water.fountain",
    name: "Fountain",
    category: WA,
    tags: ["water feature", "tiered fountain", "jet fountain", "wall fountain", "basin"],
    description: "Fountain: classic tiered, jet array, wall cascade, bowl or modern sphere.",
    icon: "droplets",
    siting: { water: true },
    params: [choice("kind", "Type", "tiered", opts("tiered", "jet", "wall", "bowl", "modern"), { group: A }), num("diameter", "Basin size", 8, { group: D, unit: "m", min: 1.5, max: 60, step: 0.5 }), color("stone", "Stone colour", "#b8b0a4", { group: A })],
    build: (r) => ({ solids: fountainSolids(r.s("kind") as "tiered", r.n("diameter"), hexToRgb(r.c("stone"))), cover: "water" }),
  }),
  {
    id: "water.pond",
    name: "Pond",
    category: WA,
    tags: ["lake", "pool", "water body", "lagoon", "duck pond"],
    description: "Pond with an organic or drawn edge, reeds and rocks.",
    icon: "waves",
    placement: "polygon",
    params: pondParams,
    generate(values, place, ctx) {
      const r = reader(values, pondParams);
      const out = new Out(ctx);
      const { poly, frame } = siteOf(place, r.n("width"), r.n("depth"));
      const ring = r.s("shape") === "natural" && !place.site ? blob(frame.c, frame.siteW / 2, frame.siteD / 2, seedOf(ctx)) : poly[0];
      const a = out.area("water", [ring], { primary: true, depth: r.n("waterDepth") });
      if (!a) return out.done();
      const seed = seedOf(ctx);
      const rand = rng(seed);
      if (r.b("rocks")) {
        const c = polyCentroid([ring]);
        const s: Solid[] = [];
        for (const st of stations([...ring, ring[0]], 2.5, 0, false)) if (rand() < 0.5) s.push(S("sphere", [st.p[0] - c[0], st.p[1] - c[1], -0.2], [0.6 + rand(), 0.5 + rand() * 0.6, 0.5 + rand() * 0.4], rand() < 0.5 ? C.stone : C.granite, "stone"));
        if (s.length) out.prop("water.pond", { c, a: 0, siteW: 0, siteD: 0 }, s, { primary: false, height: 0.8 });
      }
      if (r.b("reeds")) {
        const c = polyCentroid([ring]);
        const s: Solid[] = [];
        const st = stations([...offsetPath([...ring, ring[0]], 1.2)], 3, 0, false);
        for (const q of st) if (rand() < 0.45) s.push(...moveSolids(shrubSolids("grass_clump", 1.4, 1.3 + rand() * 0.6, [120, 150, 80], undefined, rand() * 10), q.p[0] - c[0], q.p[1] - c[1]));
        if (s.length) out.prop("water.pond", { c, a: 0, siteW: 0, siteD: 0 }, s, { primary: false, height: 2 }).cover = "planting";
      }
      out.summary.push(`Pond ${fmtArea(polyArea([ring]))}, ${fmtVol(polyArea([ring]) * r.n("waterDepth"))}`);
      return out.done();
    },
  },
  {
    id: "water.reflecting_pool",
    name: "Reflecting pool",
    category: WA,
    tags: ["mirror pool", "water basin", "formal pool", "memorial pool"],
    description: "Shallow rectangular formal pool with a stone coping.",
    icon: "rectangle-horizontal",
    placement: "rect",
    params: [num("width", "Length", 60, { group: D, unit: "m", min: 3, max: 600, step: 0.5 }), num("depth", "Width", 12, { group: D, unit: "m", min: 1, max: 100, step: 0.5 }), num("coping", "Coping width", 0.6, { group: A, unit: "m", min: 0.2, max: 3, step: 0.1 }), num("waterDepth", "Water depth", 0.45, { group: D, unit: "m", min: 0.1, max: 2, step: 0.05 })],
    generate(values, place, ctx) {
      const params = this.params;
      const r = reader(values, params);
      const out = new Out(ctx);
      const { poly } = siteOf(place, r.n("width"), r.n("depth"));
      out.area("water", poly, { primary: true, depth: r.n("waterDepth") });
      edging(out, poly[0], C.stone, 0.45, r.n("coping"));
      return out.done();
    },
  },
  propDef({
    id: "water.splash_pad",
    name: "Splash pad",
    category: WA,
    tags: ["spray park", "spray ground", "water play", "splash park", "misters"],
    description: "Zero-depth water play: ground jets, spray arches and a dumping bucket on safety surfacing.",
    icon: "droplets",
    params: [num("diameter", "Size", 14, { group: D, unit: "m", min: 4, max: 50, step: 0.5 }), int("jets", "Ground jets", 12, { group: D, min: 0, max: 60 }), bool("arches", "Spray arches", true, { group: A }), bool("bucket", "Tipping bucket", true, { group: A })],
    build: (r) => {
      const d = r.n("diameter");
      const rand = rng(7);
      const s: Solid[] = [cyl(0, 0, 0, d, 0.04, [96, 160, 196], "plastic"), cyl(0, 0, 0.04, d * 0.6, 0.01, [230, 200, 80], "plastic")];
      for (let i = 0; i < r.n("jets"); i++) {
        const a = rand() * Math.PI * 2,
          rr = Math.sqrt(rand()) * d * 0.42;
        s.push(S("cone", [Math.cos(a) * rr, Math.sin(a) * rr, 0.04], [0.25, 0.25, 0.8 + rand() * 1.4], [210, 232, 244], "water"));
      }
      if (r.b("arches")) for (const sg of [-1, 1]) s.push(S("torus", [sg * d * 0.25, 0.1, 0], [3, 3, 0.2], C.blue, "plastic", 0, [90, 0]));
      if (r.b("bucket")) s.push(box(0, d * 0.3, 0, 0.2, 0.2, 3.2, C.yellow, "metal"), S("cone", [0, d * 0.3, 3.2], [1.2, 1.2, 0.8], C.red, "plastic"));
      return { solids: s, cover: "water" };
    },
  }),
  {
    id: "water.canal",
    name: "Canal",
    category: WA,
    tags: ["waterway", "channel", "navigation canal", "urban canal", "watercourse"],
    description: "Hard-edged canal along a drawn line with quay walls and an optional towpath.",
    icon: "waves",
    placement: "path",
    params: pathWaterParams(12, true),
    generate(values, place, ctx) {
      return waterBand(values, place, ctx, this.params, "Canal");
    },
  },
  {
    id: "water.stream",
    name: "Stream / creek",
    category: WA,
    tags: ["creek", "brook", "river", "daylighted stream", "riparian", "naturalised channel"],
    description: "Natural stream along a drawn line with planted banks (daylighting / restoration).",
    icon: "waves",
    placement: "path",
    params: pathWaterParams(4, false),
    generate(values, place, ctx) {
      return waterBand(values, place, ctx, this.params, "Stream");
    },
  },
  {
    id: "water.retention_pond",
    name: "Retention / detention pond",
    category: WA,
    tags: ["stormwater pond", "detention basin", "wet pond", "dry pond", "flood storage", "swale"],
    description: "Stormwater storage pond with a storage depth (counted by the runoff model) and a planted safety bench.",
    icon: "cloud-rain",
    placement: "polygon",
    params: [num("width", "Width (if not drawn)", 50, { group: D, unit: "m", min: 5, max: 2000 }), num("depth", "Depth (if not drawn)", 30, { group: D, unit: "m", min: 5, max: 2000 }), num("storageDepth", "Storage depth", 1.5, { group: D, unit: "m", min: 0.2, max: 8, step: 0.1, description: "Volume = area × depth" }), num("bench", "Planted bench width", 3, { group: A, unit: "m", min: 0, max: 20, step: 0.5 })],
    generate(values, place, ctx) {
      const params = this.params;
      const r = reader(values, params);
      const out = new Out(ctx);
      const { poly } = siteOf(place, r.n("width"), r.n("depth"));
      out.area("retention", poly, { primary: true, depth: r.n("storageDepth") });
      if (r.n("bench") > 0) {
        const inner = insetPoly(poly, r.n("bench"));
        if (inner && isValidPoly(inner)) {
          const c = polyCentroid(poly);
          const s: Solid[] = [];
          for (const st of stations([...offsetPath([...poly[0], poly[0][0]], -r.n("bench") / 2)], 2.5, 0, false)) s.push(...moveSolids(shrubSolids("grass_clump", 1.6, 1.2, [120, 150, 80], undefined, st.s), st.p[0] - c[0], st.p[1] - c[1]));
          if (s.length) out.prop("water.retention_pond", { c, a: 0, siteW: 0, siteD: 0 }, s, { primary: false, height: 1.3 }).cover = "raingarden";
        }
      }
      out.summary.push(`Retention pond: ${fmtVol(polyArea(poly) * r.n("storageDepth"))} storage`);
      return out.done();
    },
  },
  {
    id: "water.rain_garden",
    name: "Rain garden",
    category: WA,
    tags: ["bioretention", "green infrastructure", "stormwater planter", "lid", "infiltration"],
    description: "Depressed bioretention planting that captures and infiltrates runoff.",
    icon: "flower",
    placement: "polygon",
    params: [num("width", "Width (if not drawn)", 10, { group: D, unit: "m", min: 1, max: 500 }), num("depth", "Depth (if not drawn)", 4, { group: D, unit: "m", min: 1, max: 500 }), num("planting", "Plant spacing", 1.0, { group: A, unit: "m", min: 0.3, max: 4, step: 0.1 })],
    generate(values, place, ctx) {
      const params = this.params;
      const r = reader(values, params);
      const out = new Out(ctx);
      const { poly } = siteOf(place, r.n("width"), r.n("depth"));
      out.area("raingarden", poly, { primary: true });
      const c = polyCentroid(poly);
      const s: Solid[] = [];
      scatterIn(poly, r.n("planting"), seedOf(ctx), 0.4)
        .slice(0, 800)
        .forEach((p, i) => s.push(...moveSolids(shrubSolids(i % 3 ? "grass_clump" : "mound", r.n("planting") * 1.1, 0.7 + (i % 4) * 0.15, i % 2 ? [110, 150, 84] : [140, 160, 96], i % 5 === 0 ? [150, 120, 210] : undefined, i), p[0] - c[0], p[1] - c[1])));
      if (s.length) out.prop("water.rain_garden", { c, a: 0, siteW: 0, siteD: 0 }, s, { primary: false, height: 1.2 }).cover = "raingarden";
      return out.done();
    },
  },
  {
    id: "water.bioswale",
    name: "Bioswale",
    category: WA,
    tags: ["swale", "vegetated swale", "drainage channel", "green gutter", "stormwater"],
    description: "Linear vegetated swale along a drawn line that conveys and infiltrates runoff.",
    icon: "waves",
    placement: "path",
    params: [num("width", "Width", 3, { group: D, unit: "m", min: 1, max: 20, step: 0.5 }), num("planting", "Plant spacing", 1.2, { group: A, unit: "m", min: 0.4, max: 4, step: 0.1 })],
    generate(values, place, ctx) {
      const params = this.params;
      const r = reader(values, params);
      const out = new Out(ctx);
      const path = place.path && place.path.length >= 2 ? place.path : defaultPath(place, 30);
      const band = bandPoly(path, r.n("width"));
      if (band) out.area("raingarden", band, { primary: true });
      const s: Solid[] = [];
      const c = path[0];
      for (const off of [-r.n("width") / 4, r.n("width") / 4]) for (const st of stations(offsetPath(path, off), r.n("planting"), 0, false).slice(0, 600)) s.push(...moveSolids(shrubSolids("grass_clump", r.n("planting") * 1.2, 0.8, [120, 150, 84], undefined, st.s), st.p[0] - c[0], st.p[1] - c[1]));
      if (s.length) out.prop("water.bioswale", { c, a: 0, siteW: 0, siteD: 0 }, s, { primary: false, height: 1 }).cover = "raingarden";
      out.summary.push(`Bioswale ${fmtLen(pathLength(path))} long, ${fmtFt(r.n("width"))} wide`);
      return out.done();
    },
  },
  propDef({
    id: "water.dock",
    name: "Dock / pier",
    category: WA,
    tags: ["jetty", "pier", "boardwalk", "boat launch", "kayak launch", "marina", "floating dock"],
    description: "Timber dock or pier on piles, extending over water.",
    icon: "anchor",
    siting: { water: true },
    params: [num("length", "Length", 15, { group: D, unit: "m", min: 2, max: 200, step: 0.5 }), num("width", "Width", 2.5, { group: D, unit: "m", min: 1, max: 20, step: 0.1 }), num("deckHeight", "Deck height", 0.6, { group: D, unit: "m", min: 0.2, max: 4, step: 0.1 }), bool("railing", "Railing", true, { group: A }), bool("tFinger", "T-head", true, { group: A })],
    build: (r) => {
      const L = r.n("length"),
        W = r.n("width"),
        h = r.n("deckHeight");
      const s: Solid[] = [box(0, L / 2, h, W, L, 0.2, C.woodLight, "wood")];
      for (let y = 0; y <= L; y += 3) for (const x of [-W / 2 + 0.15, W / 2 - 0.15]) s.push(cyl(x, y, -0.5, 0.25, h + 0.5, C.woodDark, "wood"));
      if (r.b("tFinger")) s.push(box(0, L, h, W * 3, W, 0.2, C.woodLight, "wood"));
      if (r.b("railing")) for (const x of [-W / 2, W / 2]) s.push(beam([x, 0], [x, L], h + 1.0, 0.06, 0.06, C.wood, "wood"));
      return { solids: s };
    },
  }),
  propDef({
    id: "water.footbridge",
    name: "Footbridge",
    category: WA,
    tags: ["pedestrian bridge", "bridge", "boardwalk bridge", "arched bridge", "crossing"],
    description: "Pedestrian bridge (arched or flat) spanning a stream, canal or pond.",
    icon: "bridge",
    siting: { water: true, overlapProps: true },
    params: [num("span", "Span", 16, { group: D, unit: "m", min: 3, max: 120, step: 0.5 }), num("width", "Width", 3, { group: D, unit: "m", min: 1.2, max: 10, step: 0.1 }), choice("style", "Style", "arched", opts("arched", "flat", "truss"), { group: A }), color("color", "Colour", "#96704c", { group: A })],
    build: (r) => {
      const L = r.n("span"),
        W = r.n("width");
      const c = hexToRgb(r.c("color"));
      const st = r.s("style");
      const s: Solid[] = [];
      const n = 12;
      const rise = st === "arched" ? Math.min(2.5, L * 0.1) : 0;
      for (let i = 0; i < n; i++) {
        const t0 = i / n,
          t1 = (i + 1) / n;
        const z0 = 0.4 + rise * Math.sin(Math.PI * t0),
          z1 = 0.4 + rise * Math.sin(Math.PI * t1);
        const x = -L / 2 + L * ((t0 + t1) / 2);
        // roll tips the deck segment along the span (positive roll lowers +x)
        const ang = -(Math.atan2(z1 - z0, L / n) * 180) / Math.PI;
        const seg = Math.hypot(L / n, z1 - z0) + 0.05;
        s.push(S("box", [x, 0, (z0 + z1) / 2 - 0.12], [seg, W, 0.25], c, "wood", 0, [0, ang]));
        for (const y of [-W / 2, W / 2]) s.push(S("box", [x, y, (z0 + z1) / 2 + 0.95], [seg, 0.08, 0.08], shade(c, 0.8), "wood", 0, [0, ang]), box(x - L / n / 2, y, Math.min(z0, z1) - 0.1, 0.08, 0.08, 1.15, shade(c, 0.8), "wood"));
      }
      s.push(box(-L / 2 - 0.5, 0, 0, 1.2, W + 0.6, 0.4, C.stone, "stone"), box(L / 2 + 0.5, 0, 0, 1.2, W + 0.6, 0.4, C.stone, "stone"));
      if (st === "truss") for (const y of [-W / 2, W / 2]) for (let i = 0; i < 6; i++) s.push(S("box", [-L / 2 + (L * (i + 0.5)) / 6, y, 0.4], [0.1, 0.1, 2.2], C.steel, "metal", 0, [0, i % 2 ? 35 : -35]));
      return { solids: s };
    },
  }),
];

function waterBand(values: Record<string, unknown>, place: Parameters<PrimitiveDef["generate"]>[1], ctx: Parameters<PrimitiveDef["generate"]>[2], params: ParamSpec[], label: string) {
  const r = reader(values, params);
  const out = new Out(ctx);
  const path = place.path && place.path.length >= 2 ? place.path : defaultPath(place, 60);
  const w = r.n("width");
  const band = bandPoly(path, w);
  if (band) out.area("water", band, { primary: true, name: r.s("name") || undefined });
  const bp = r.n("bankPlanting");
  if (bp > 0) for (const sg of [-1, 1]) {
    const b = bandPoly(offsetPath(path, sg * (w / 2 + bp / 2)), bp);
    if (b) out.area("raingarden", b, { primary: false });
  }
  if (r.b("walls")) for (const sg of [-1, 1]) {
    const edge = offsetPath(path, sg * (w / 2 + 0.3));
    for (let i = 0; i < edge.length - 1; i++) {
      const a = edge[i],
        b = edge[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.2) continue;
      out.prop("water.canal", { c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], a: Math.atan2(b[1] - a[1], b[0] - a[0]), siteW: 0, siteD: 0 }, [box(0, 0, -0.6, len, 0.6, 1.1, C.stone, "stone")], { primary: false, height: 0.5 });
    }
  }
  if (r.b("towpath")) out.path(offsetPath(path, w / 2 + 2.5), "footway", { primary: false });
  out.summary.push(`${label}: ${fmtLen(pathLength(path))} long, ${fmtFt(w)} wide`);
  return out.done();
}
