// Parks and open space: composed parks, pocket parks, plazas, dog parks, community gardens,
// amphitheatres, picnic areas, pavilions, gazebos, pergolas, cemeteries and trails.

import { fmtArea, fmtLen } from "@/lib/units";
import { distToPoly, insetPoly, isValidPoly, pointInPoly, polyArea, polyBBox, polyCentroid } from "@/geometry/polygon";
import type { Polygon, Solid, Vec2 } from "@/world/types";
import type { GenerateContext, ParamSpec, PlacementInput, PrimitiveDef } from "../types";
import { polyToWorld, rng, subFrame, toLocal } from "../geometry/frame";
import { C, hexToRgb, shade } from "../geometry/palette";
import { benchSolids, binSolids, lampSolids, shrubSolids, treeSolids } from "../geometry/props";
import { S, beam, box, cyl, moveSolids, type RGB } from "../geometry/solids";
import { SPECIES_PRESETS } from "./flora";
import { defaultPath, offsetPath, pathLength, propDef, scatterIn, seedOf, siteOf, stations } from "./kinds";
import { Out } from "./make";
import { playgroundSolids } from "./recreation";
import { rectL } from "./decor";
import { bool, choice, color, int, num, opts, reader, withDefaults, type Reader } from "./params";

const PK = "parks" as const;
const D = "Dimensions",
  A = "Appearance",
  P = "Planting",
  F = "Facilities";

function speciesTree(id: string, scale: number, seed: number) {
  const sp = SPECIES_PRESETS.find((s) => s.id === id) ?? SPECIES_PRESETS[0];
  return { solids: treeSolids({ shape: sp.shape, height: sp.height * scale, crown: sp.crown * scale, trunkFrac: sp.trunkFrac, dbh: sp.dbh * Math.sqrt(scale), color: sp.color, trunkColor: sp.trunk, clumps: 2, seed }), r: (sp.crown * scale) / 2, h: sp.height * scale };
}

const TREE_OPTS = [{ value: "mixed", label: "Mixed shade trees" }, ...SPECIES_PRESETS.map((s) => ({ value: s.id, label: s.name }))];
const MIX = ["live_oak", "red_oak", "cedar_elm", "london_plane", "red_maple", "bur_oak", "ginkgo"];

/** place shade trees (props) at points, keeping clear of `avoid` paths by `clear` m and of each other */
function plantTrees(out: Out, pts: Vec2[], species: string, scale: number, seed: number) {
  const rand = rng(seed);
  for (const p of pts) {
    const id = species === "mixed" ? MIX[Math.floor(rand() * MIX.length)] : species;
    const t = speciesTree(id, scale * (0.85 + rand() * 0.3), rand());
    out.prop("flora.tree", { c: p, a: rand() * Math.PI * 2, siteW: 0, siteD: 0 }, t.solids, { shade: { r: t.r, h: t.h }, primary: false, anchorR: 0.6 });
  }
}

function nearPath(p: Vec2, paths: Vec2[][], d: number): boolean {
  for (const path of paths)
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i],
        b = path[i + 1];
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < d) return true;
    }
  return false;
}

const parkParams: ParamSpec[] = [
  num("width", "Width (if not drawn)", 120, { group: D, unit: "m", min: 15, max: 2000, step: 1 }),
  num("depth", "Depth (if not drawn)", 80, { group: D, unit: "m", min: 15, max: 2000, step: 1 }),
  choice("paths", "Path layout", "loop", [{ value: "loop", label: "Perimeter loop" }, { value: "cross", label: "Diagonal cross" }, { value: "both", label: "Loop and cross" }, { value: "none", label: "No paths" }], { group: F }),
  num("pathInset", "Loop inset from edge", 8, { group: F, unit: "m", min: 2, max: 60, step: 0.5, when: { key: "paths", in: ["loop", "both"] } }),
  choice("species", "Trees", "mixed", TREE_OPTS, { group: P }),
  num("treeSpacing", "Tree spacing", 16, { group: P, unit: "m", min: 6, max: 80, step: 1, description: "Centre-to-centre; larger spacing leaves open lawn" }),
  num("treeCover", "Tree coverage", 55, { group: P, unit: "%", min: 0, max: 100, step: 5, description: "Share of candidate positions planted (lawn clearings stay open)" }),
  num("treeSize", "Tree size", 90, { group: P, unit: "%", min: 20, max: 150, step: 5 }),
  int("benches", "Benches", 8, { group: F, min: 0, max: 80 }),
  bool("lamps", "Path lighting", true, { group: F }),
  bool("playground", "Playground", true, { group: F }),
  bool("pond", "Pond", false, { group: F }),
  bool("pavilion", "Pavilion", false, { group: F }),
  int("flowerBeds", "Flower beds", 2, { group: P, min: 0, max: 20 }),
  int("seed", "Variation seed", 0, { group: P, min: 0, max: 9999, advanced: true }),
];

function pavilionSolids(w: number, d: number, h: number, roof: RGB, post: RGB, kind: "hip" | "gable" | "flat" = "hip"): Solid[] {
  const s: Solid[] = [box(0, 0, 0, w + 1, d + 1, 0.25, C.concrete, "concrete")];
  const nx = Math.max(2, Math.round(w / 4) + 1),
    ny = Math.max(2, Math.round(d / 4) + 1);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      if (i > 0 && i < nx - 1 && j > 0 && j < ny - 1) continue;
      s.push(box(-w / 2 + (w * i) / (nx - 1), -d / 2 + (d * j) / (ny - 1), 0.25, 0.3, 0.3, h - 0.25, post, "wood"));
    }
  s.push(box(0, 0, h, w + 0.6, d + 0.6, 0.3, post, "wood"));
  const rise = Math.min(w, d) * 0.3;
  if (kind === "gable") s.push(S("wedge", [0, 0, h + 0.3], [w + 1.4, d + 1.4, rise], roof, "concrete"));
  else if (kind === "flat") s.push(box(0, 0, h + 0.3, w + 1.4, d + 1.4, 0.2, roof, "concrete"));
  else {
    const L = Math.max(w, d),
      W = Math.min(w, d);
    const rot = w >= d ? 0 : 90;
    if (L - W > 0.05) s.push(S("wedge", [0, 0, h + 0.3], [L - W, W + 1.4, rise], roof, "concrete", rot));
    const e = (L - W) / 2;
    for (const sg of e > 0 ? [-1, 1] : [0]) s.push(S("pyramid", [w >= d ? sg * e : 0, w >= d ? 0 : sg * e, h + 0.3], [W + 1.4, W + 1.4, rise], roof, "concrete", rot));
  }
  return s;
}

function gazeboSolids(dia: number, h: number, roof: RGB, post: RGB, sides = 8): Solid[] {
  const s: Solid[] = [cyl(0, 0, 0, dia + 0.6, 0.35, C.concrete, "concrete")];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    s.push(box(Math.cos(a) * dia * 0.45, Math.sin(a) * dia * 0.45, 0.35, 0.18, 0.18, h - 0.35, post, "wood"));
    const b = ((i + 1) / sides) * Math.PI * 2;
    s.push(beam([Math.cos(a) * dia * 0.45, Math.sin(a) * dia * 0.45], [Math.cos(b) * dia * 0.45, Math.sin(b) * dia * 0.45], 0.9, 0.08, 0.08, post, "wood"));
  }
  s.push(cyl(0, 0, h, dia + 0.4, 0.2, post, "wood"), S("cone", [0, 0, h + 0.2], [dia + 1.2, dia + 1.2, dia * 0.45], roof, "concrete"), S("sphere", [0, 0, h + 0.2 + dia * 0.45], [0.3, 0.3, 0.4], post, "metal"));
  return s;
}

export function parkInto(out: Out, r: Reader, site: Polygon, ctx: GenerateContext, primaryArea = true, avoid: { c: Vec2; r: number }[] = []) {
  const seed = seedOf(ctx, r);
  const rand = rng(seed);
  out.area("park", site, { primary: primaryArea, name: r.s("name") || undefined });
  const c = polyCentroid(site);
  const paths: Vec2[][] = [];
  const layout = r.s("paths");
  if (layout === "loop" || layout === "both") {
    const ins = insetPoly(site, r.n("pathInset"));
    if (ins && isValidPoly(ins)) {
      const ring = [...ins[0], ins[0][0]];
      paths.push(ring);
      out.path(ring, "footway", { primary: false });
    }
  }
  if (layout === "cross" || layout === "both") {
    const [x0, y0, x1, y1] = polyBBox(site);
    for (const [a, b] of [[[x0, y0], [x1, y1]], [[x0, y1], [x1, y0]]] as [Vec2, Vec2][]) {
      // clip the diagonal to the site by sampling
      const pts: Vec2[] = [];
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const p: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (pointInPoly(p, site) && distToPoly(p, site) === 0) pts.push(p);
      }
      if (pts.length >= 2) {
        const seg = [pts[0], pts[pts.length - 1]];
        paths.push(seg);
        out.path(seg, "footway", { primary: false });
      }
    }
  }
  const area = polyArea(site);
  const reserve: { c: Vec2; r: number }[] = [...avoid];
  const free = (p: Vec2, rad: number) => !reserve.some((q) => Math.hypot(q.c[0] - p[0], q.c[1] - p[1]) < q.r + rad) && !nearPath(p, paths, rad + 1.2);
  // facilities first (they claim space), placed at interior points away from paths
  const interior = scatterIn(site, Math.max(10, Math.sqrt(area) / 6), seed + 3, 0.2, 6).sort((a, b) => Math.hypot(a[0] - c[0], a[1] - c[1]) - Math.hypot(b[0] - c[0], b[1] - c[1]));
  const claim = (rad: number): Vec2 | null => {
    for (const p of interior) if (free(p, rad) && distToPoly(p, site) === 0 && pointInPoly([p[0] + rad, p[1]], site) && pointInPoly([p[0] - rad, p[1]], site) && pointInPoly([p[0], p[1] + rad], site) && pointInPoly([p[0], p[1] - rad], site)) {
      reserve.push({ c: p, r: rad });
      return p;
    }
    return null;
  };
  if (r.b("pond")) {
    const rad = Math.min(25, Math.sqrt(area) * 0.12);
    const p = claim(rad + 3);
    if (p) {
      const ring: Vec2[] = [];
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        const k = 0.8 + 0.3 * Math.sin(a * 3 + seed) * 0.6;
        ring.push([p[0] + Math.cos(a) * rad * k * 1.3, p[1] + Math.sin(a) * rad * k]);
      }
      out.area("water", [ring], { primary: false, name: "Pond" });
    }
  }
  if (r.b("playground")) {
    const p = claim(13);
    if (p) out.prop("recreation.playground", { c: p, a: 0, siteW: 0, siteD: 0 }, playgroundSolids("school", 18), { primary: false }).cover = "permeable";
  }
  if (r.b("pavilion")) {
    const p = claim(9);
    if (p) out.prop("parks.pavilion", { c: p, a: 0, siteW: 0, siteD: 0 }, pavilionSolids(10, 7, 3.2, [150, 60, 52], C.woodDark), { primary: false, shade: { r: 5, h: 4 } });
  }
  for (let i = 0; i < r.n("flowerBeds"); i++) {
    const p = claim(4);
    if (!p) break;
    const s: Solid[] = [cyl(0, 0, 0, 6, 0.25, C.stone, "stone")];
    for (let k = 0; k < 7; k++) s.push(...moveSolids(shrubSolids("mound", 1.3, 0.6, [96, 136, 76], [[214, 96, 150], [232, 196, 64], [150, 120, 210]][k % 3] as RGB, k), Math.cos(k) * 1.6, Math.sin(k) * 1.6, 0, 0.25));
    out.prop("flora.flower_bed", { c: p, a: 0, siteW: 0, siteD: 0 }, s, { primary: false }).cover = "planting";
  }
  // benches and lamps along the paths
  const allPaths = paths.filter((p) => p.length >= 2);
  const totalLen = allPaths.reduce((s, p) => s + pathLength(p), 0);
  const nb = r.n("benches");
  if (nb > 0 && totalLen > 0) {
    const sp = totalLen / nb;
    let k = 0;
    for (const p of allPaths)
      for (const st of stations(offsetPath(p, 2.2), sp, sp / 2, false)) {
        if (k++ >= nb) break;
        if (!pointInPoly(st.p, site) || !free(st.p, 1.2)) continue;
        out.prop("streetscape.bench", { c: st.p, a: ((st.rot + 180) * Math.PI) / 180, siteW: 0, siteD: 0 }, benchSolids("park", 1.8), { primary: false });
        reserve.push({ c: st.p, r: 1.2 });
      }
  } else if (nb > 0) for (let i = 0; i < nb; i++) {
    const p = claim(1.5);
    if (p) out.prop("streetscape.bench", { c: p, a: rand() * Math.PI * 2, siteW: 0, siteD: 0 }, benchSolids("park", 1.8), { primary: false });
  }
  if (r.b("lamps") && totalLen > 0)
    for (const p of allPaths)
      for (const st of stations(offsetPath(p, -1.8), 22, 11, false)) {
        if (!pointInPoly(st.p, site) || !free(st.p, 0.6)) continue;
        out.prop("streetscape.street_lamp", { c: st.p, a: 0, siteW: 0, siteD: 0 }, lampSolids("acorn", 4.2), { primary: false, anchorR: 0.3 });
        reserve.push({ c: st.p, r: 0.6 });
      }
  // trees
  const scale = r.n("treeSize") / 100;
  const cover = r.n("treeCover") / 100;
  const spc = r.n("treeSpacing");
  const cand = scatterIn(site, spc, seed + 11, 0.4, Math.min(4, spc * 0.3)).filter((p) => free(p, Math.min(6, spc * 0.35)));
  const pick = cand.filter(() => rand() < cover).slice(0, 800);
  plantTrees(out, pick, r.s("species"), scale, seed + 5);
  out.summary.push(`Park ${fmtArea(area)}: ${pick.length} trees, ${fmtLen(totalLen)} of paths`);
}

export const PARKS: PrimitiveDef[] = [
  {
    id: "parks.park",
    name: "Park",
    category: PK,
    tags: ["public park", "green space", "neighbourhood park", "city park", "common", "lawn", "open space"],
    description: "A composed park over a drawn site: lawn, path loop and / or cross paths, shade trees, benches, lights, playground, pond, pavilion and flower beds.",
    icon: "trees",
    placement: "polygon",
    params: parkParams,
    generate(values, place, ctx) {
      const r = reader(values, parkParams);
      const out = new Out(ctx);
      const { poly } = siteOf(place, r.n("width"), r.n("depth"));
      parkInto(out, r, poly, ctx);
      return out.done();
    },
  },
  {
    id: "parks.pocket_park",
    name: "Pocket park",
    category: PK,
    tags: ["parklet", "mini park", "vest-pocket park", "small park", "infill park"],
    description: "A small park on a single lot: trees, benches, planting and optionally a tot lot.",
    icon: "trees",
    placement: "polygon",
    params: withDefaults(parkParams, { width: 25, depth: 30, paths: "cross", treeSpacing: 9, benches: 4, playground: false, flowerBeds: 2, pathInset: 3 }),
    generate(values, place, ctx) {
      const params = this.params;
      const r = reader(values, params);
      const out = new Out(ctx);
      const { poly } = siteOf(place, r.n("width"), r.n("depth"));
      parkInto(out, r, poly, ctx);
      return out.done();
    },
  },
  {
    id: "parks.plaza",
    name: "Plaza / square",
    category: PK,
    tags: ["town square", "piazza", "public square", "civic plaza", "hardscape", "forecourt"],
    description: "Paved public square with trees in grates around the edge, benches, lights and an optional central fountain or monument.",
    icon: "square",
    placement: "polygon",
    params: [
      num("width", "Width (if not drawn)", 60, { group: D, unit: "m", min: 10, max: 1000 }),
      num("depth", "Depth (if not drawn)", 45, { group: D, unit: "m", min: 10, max: 1000 }),
      choice("centre", "Centrepiece", "fountain", opts("fountain", "statue", "obelisk", "lawn", "none"), { group: F }),
      choice("species", "Trees", "london_plane", TREE_OPTS, { group: P }),
      num("treeSpacing", "Tree spacing", 10, { group: P, unit: "m", min: 4, max: 40, step: 0.5 }),
      num("edgeInset", "Tree inset from edge", 4, { group: P, unit: "m", min: 1, max: 30, step: 0.5 }),
      num("treeSize", "Tree size", 45, { group: P, unit: "%", min: 15, max: 120, step: 5, description: "Share of the species' mature size (plaza trees in grates are usually kept smaller)" }),
      int("benches", "Benches", 8, { group: F, min: 0, max: 60 }),
      bool("lamps", "Lights", true, { group: F }),
      choice("paving", "Paving", "plaza", [{ value: "plaza", label: "Stone paving" }, { value: "permeable", label: "Permeable pavers" }], { group: A }),
    ],
    generate(values, place, ctx) {
      const params = this.params;
      const r = reader(values, params);
      const out = new Out(ctx);
      const { poly } = siteOf(place, r.n("width"), r.n("depth"));
      out.area(r.s("paving") === "permeable" ? "permeable" : "plaza", poly, { primary: true });
      const c = polyCentroid(poly);
      const ins = insetPoly(poly, r.n("edgeInset"));
      const ring = ins && isValidPoly(ins) ? [...ins[0], ins[0][0]] : null;
      const seed = seedOf(ctx);
      if (ring) {
        const sts = stations(ring, r.n("treeSpacing"), 0, false);
        plantTrees(out, sts.map((s) => s.p), r.s("species"), r.n("treeSize") / 100, seed);
        for (const s of sts) out.prop("streetscape.tree_grate", { c: s.p, a: 0, siteW: 0, siteD: 0 }, [box(0, 0, 0, 1.8, 1.8, 0.03, C.steelDark, "metal")], { primary: false, height: 0.03 });
        const nb = r.n("benches");
        if (nb) {
          const inner = insetPoly(poly, r.n("edgeInset") + 3);
          if (inner && isValidPoly(inner)) for (const s of stations([...inner[0], inner[0][0]], pathLength([...inner[0], inner[0][0]]) / nb, 1, false).slice(0, nb)) out.prop("streetscape.bench", { c: s.p, a: ((s.rot + 180) * Math.PI) / 180, siteW: 0, siteD: 0 }, benchSolids("modern", 2.4), { primary: false });
        }
        if (r.b("lamps")) for (const s of stations(ring, r.n("treeSpacing") * 2, r.n("treeSpacing"), false)) {
          const q: Vec2 = [s.p[0] + (c[0] - s.p[0]) * 0.12, s.p[1] + (c[1] - s.p[1]) * 0.12];
          out.prop("streetscape.street_lamp", { c: q, a: 0, siteW: 0, siteD: 0 }, lampSolids("post_top", 5), { primary: false, anchorR: 0.3 });
        }
      }
      const cp = r.s("centre");
      const f = { c, a: 0, siteW: 0, siteD: 0 };
      if (cp === "fountain") out.prop("water.fountain", f, fountainSolids("tiered", 10, C.stone), { primary: false }).cover = "water";
      else if (cp === "statue") out.prop("landmarks.statue", f, statueSolids(3, 2.5, C.bronze, C.granite), { primary: false });
      else if (cp === "obelisk") out.prop("landmarks.obelisk", f, [box(0, 0, 0, 3, 3, 1.2, C.granite, "stone"), box(0, 0, 1.2, 1.6, 1.6, 12, C.stone, "stone"), S("pyramid", [0, 0, 13.2], [1.6, 1.6, 1.4], C.stone, "stone")], { primary: false });
      else if (cp === "lawn") out.area("grass", polyToWorld({ c, a: 0, siteW: 0, siteD: 0 }, rectL(0, 0, Math.sqrt(polyArea(poly)) * 0.35, Math.sqrt(polyArea(poly)) * 0.25)), { primary: false });
      out.summary.push(`Plaza ${fmtArea(polyArea(poly))}`);
      return out.done();
    },
  },
  {
    id: "parks.dog_park",
    name: "Dog park",
    category: PK,
    tags: ["off-leash area", "dog run", "bark park", "pet park"],
    description: "Fenced off-leash area with a double-gate entry, separate small-dog run, benches, shade and a water station.",
    icon: "dog",
    placement: "polygon",
    params: [num("width", "Width (if not drawn)", 50, { group: D, unit: "m", min: 10, max: 400 }), num("depth", "Depth (if not drawn)", 35, { group: D, unit: "m", min: 10, max: 400 }), bool("smallDogArea", "Small-dog area", true, { group: F }), num("fenceHeight", "Fence height", 1.5, { group: F, unit: "m", min: 1, max: 2.5, step: 0.1 }), int("benches", "Benches", 4, { group: F, min: 0, max: 20 }), bool("agility", "Agility equipment", true, { group: F })],
    generate(values, place, ctx) {
      const params = this.params;
      const r = reader(values, params);
      const out = new Out(ctx);
      const { poly } = siteOf(place, r.n("width"), r.n("depth"));
      out.area("grass", poly, { primary: true, name: "Dog park" });
      const ring = [...poly[0], poly[0][0]];
      const h = r.n("fenceHeight");
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i],
          b = ring[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.5) continue;
        const n = Math.max(1, Math.round(len / 2.5));
        const s: Solid[] = [];
        for (let k = 0; k <= n; k++) s.push(box(-len / 2 + (len * k) / n, 0, 0, 0.07, 0.07, h, C.steelDark, "metal"));
        s.push(box(0, 0, h - 0.05, len, 0.05, 0.05, C.steelDark, "metal"), box(0, 0, 0.1, len, 0.05, 0.05, C.steelDark, "metal"), box(0, 0, h / 2, len, 0.03, 0.03, C.steelDark, "metal"));
        out.prop("streetscape.fence", { c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], a: Math.atan2(b[1] - a[1], b[0] - a[0]), siteW: 0, siteD: 0 }, s, { primary: false });
      }
      const c = polyCentroid(poly);
      const f = { c, a: 0, siteW: 0, siteD: 0 };
      if (r.b("agility")) out.prop("parks.dog_park", subFrame(f, [4, 0]), [S("wedge", [0, 0, 0], [3.6, 1.0, 0.9], C.orange, "plastic", 90), ...[0, 1, 2, 3, 4].map((i) => cyl(-3 + i * 0.6, -3, 0, 0.05, 1.0, C.yellow, "plastic")), S("torus", [3, -2.95, 0.75], [0.9, 0.9, 0.1], C.blue, "plastic", 0, [90, 0]), cyl(3, -3, 0, 0.08, 0.3, C.steel, "metal")], { primary: false });
      out.prop("streetscape.drinking_fountain", subFrame(f, [-4, 3]), [box(0, 0, 0, 0.35, 0.35, 0.95, C.blue, "metal"), cyl(0, 0.45, 0, 0.4, 0.12, C.steel, "metal")], { primary: false });
      const ins = insetPoly(poly, 2.5);
      if (ins && isValidPoly(ins)) for (const s of stations([...ins[0], ins[0][0]], pathLength([...ins[0], ins[0][0]]) / Math.max(1, r.n("benches")), 3, false).slice(0, r.n("benches"))) out.prop("streetscape.bench", { c: s.p, a: ((s.rot + 180) * Math.PI) / 180, siteW: 0, siteD: 0 }, benchSolids("backless", 1.8), { primary: false });
      out.summary.push(`Dog park ${fmtArea(polyArea(poly))}`);
      return out.done();
    },
  },
  {
    id: "parks.community_garden",
    name: "Community garden",
    category: PK,
    tags: ["allotments", "urban farm", "raised beds", "p-patch", "victory garden", "garden plots"],
    description: "Rows of raised garden beds with paths, a tool shed, compost bins, water tank and fence.",
    icon: "carrot",
    placement: "polygon",
    params: [num("width", "Width (if not drawn)", 30, { group: D, unit: "m", min: 6, max: 400 }), num("depth", "Depth (if not drawn)", 20, { group: D, unit: "m", min: 6, max: 400 }), num("bedLength", "Bed length", 3.6, { group: D, unit: "m", min: 1, max: 10, step: 0.1 }), num("bedWidth", "Bed width", 1.2, { group: D, unit: "m", min: 0.6, max: 3, step: 0.1 }), num("aisle", "Aisle width", 1.2, { group: D, unit: "m", min: 0.6, max: 3, step: 0.1, description: "≥ 5 ft for wheelchair access" }), bool("shed", "Tool shed", true, { group: F }), bool("fence", "Fence", true, { group: F })],
    generate(values, place, ctx) {
      const params = this.params;
      const r = reader(values, params);
      const out = new Out(ctx);
      const { poly, frame } = siteOf(place, r.n("width"), r.n("depth"));
      out.area("grass", poly, { primary: true, name: r.s("name") || "Community garden" });
      const bl = r.n("bedLength"),
        bw = r.n("bedWidth"),
        ai = r.n("aisle");
      const local = poly[0].map((p) => toLocal(frame, p));
      const lp: Polygon = [local];
      const [x0, y0, x1, y1] = polyBBox(lp);
      const s: Solid[] = [];
      const greens: RGB[] = [[96, 140, 70], [120, 156, 80], [140, 120, 70], [86, 128, 76]];
      let n = 0;
      for (let x = x0 + 1.5 + bl / 2; x <= x1 - 1.5 - bl / 2 && n < 400; x += bl + ai)
        for (let y = y0 + 1.5 + bw / 2; y <= y1 - 1.5 - bw / 2 && n < 400; y += bw + ai) {
          if (!pointInPoly([x - bl / 2, y - bw / 2], lp) || !pointInPoly([x + bl / 2, y + bw / 2], lp) || !pointInPoly([x - bl / 2, y + bw / 2], lp) || !pointInPoly([x + bl / 2, y - bw / 2], lp)) continue;
          if (r.b("shed") && x > x1 - 6 && y > y1 - 6) continue;
          s.push(box(x, y, 0, bl, bw, 0.4, C.woodLight, "wood"), S("box", [x, y, 0.4], [bl - 0.15, bw - 0.15, 0.25 + (n % 3) * 0.12], greens[n % 4], "foliage"));
          n++;
        }
      if (s.length) out.prop("parks.community_garden", { ...frame, siteW: 0, siteD: 0 }, s, { primary: false }).cover = "planting";
      if (r.b("shed")) out.prop("parks.community_garden", subFrame(frame, [x1 - 3.5, y1 - 3.5]), [box(0, 0, 0, 3, 2.4, 2.3, [150, 112, 76], "wood"), S("wedge", [0, 0, 2.3], [3.4, 2.8, 0.9], [150, 60, 52], "metal"), ...binSolids("compost").map((q) => ({ ...q, at: [q.at[0] - 2.5, q.at[1], q.at[2]] as [number, number, number] })), cyl(2.3, 0, 0, 1.1, 1.6, [60, 70, 80], "plastic")], { primary: false });
      if (r.b("fence")) {
        const ring = [...poly[0], poly[0][0]];
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i],
            b = ring[i + 1];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 0.5) continue;
          const k = Math.max(1, Math.round(len / 2.4));
          const fs: Solid[] = [];
          for (let j = 0; j <= k; j++) fs.push(box(-len / 2 + (len * j) / k, 0, 0, 0.09, 0.09, 1.2, C.wood, "wood"));
          fs.push(box(0, 0, 1.0, len, 0.04, 0.08, C.wood, "wood"), box(0, 0, 0.4, len, 0.04, 0.08, C.wood, "wood"));
          out.prop("streetscape.fence", { c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], a: Math.atan2(b[1] - a[1], b[0] - a[0]), siteW: 0, siteD: 0 }, fs, { primary: false });
        }
      }
      out.summary.push(`Community garden: ${n} raised beds (${fmtArea(n * bl * bw)} growing area)`);
      return out.done();
    },
  },
  propDef({
    id: "parks.amphitheatre",
    name: "Amphitheatre",
    category: PK,
    tags: ["outdoor theater", "bandshell", "open-air stage", "amphitheater", "performance lawn", "seating steps"],
    description: "Semicircular stepped seating facing a stage with an optional band shell.",
    icon: "drama",
    params: [num("radius", "Outer radius", 18, { group: D, unit: "m", min: 6, max: 80, step: 0.5 }), int("tiers", "Seating tiers", 6, { group: D, min: 2, max: 30 }), num("sweep", "Seating sweep", 180, { group: D, unit: "°", min: 60, max: 270, step: 5 }), bool("shell", "Band shell", true, { group: A }), color("color", "Seating material", "#c4c0ba", { group: A })],
    build: (r) => {
      const R = r.n("radius"),
        n = r.n("tiers");
      const sw = (r.n("sweep") * Math.PI) / 180;
      const col = hexToRgb(r.c("color"));
      const s: Solid[] = [];
      const r0 = R * 0.35;
      const td = (R - r0) / n;
      for (let t = 0; t < n; t++) {
        const rr = r0 + td * (t + 0.5);
        const segs = Math.max(6, Math.round((rr * sw) / 3));
        for (let k = 0; k < segs; k++) {
          const a = Math.PI / 2 - sw / 2 + (sw * (k + 0.5)) / segs;
          s.push(S("box", [Math.cos(a) * rr, Math.sin(a) * rr, 0], [td + 0.05, 2 * rr * Math.sin(sw / segs / 2) + 0.1, 0.45 * (t + 1)], t % 2 ? col : shade(col, 0.95), "concrete", (a * 180) / Math.PI));
        }
      }
      s.push(box(0, -r0 * 0.4, 0, r0 * 1.6, r0 * 0.9, 1.0, C.woodLight, "wood"));
      if (r.b("shell")) s.push(S("hemisphere", [0, -r0 * 0.75, 0], [r0 * 1.8, r0 * 1.2, r0 * 1.3], C.white, "concrete"));
      return { solids: s, cover: "paving" };
    },
  }),
  propDef({
    id: "parks.picnic_area",
    name: "Picnic area",
    category: PK,
    tags: ["picnic tables", "bbq area", "grills", "picnic grove", "cookout"],
    description: "Picnic tables with grills and trash bins, optionally under a shade canopy.",
    icon: "utensils",
    params: [int("tables", "Tables", 6, { group: D, min: 1, max: 30 }), num("spacing", "Table spacing", 5, { group: D, unit: "m", min: 3, max: 15, step: 0.5 }), bool("grills", "Grills", true, { group: F }), bool("shade", "Shade structure", false, { group: F })],
    build: (r) => {
      const n = r.n("tables"),
        sp = r.n("spacing");
      const cols = Math.ceil(Math.sqrt(n));
      const s: Solid[] = [];
      for (let i = 0; i < n; i++) {
        const x = ((i % cols) - (cols - 1) / 2) * sp,
          y = (Math.floor(i / cols) - (Math.ceil(n / cols) - 1) / 2) * sp;
        s.push(...moveSolids(benchSolids("picnic", 2.4), x, y));
        if (r.b("grills") && i % 2 === 0) s.push(cyl(x + 1.8, y + 1.2, 0, 0.1, 0.8, C.steelDark, "metal"), box(x + 1.8, y + 1.2, 0.8, 0.7, 0.5, 0.25, C.black, "metal"));
      }
      s.push(...binSolids("dual").map((q) => ({ ...q, at: [q.at[0] - (cols / 2) * sp - 1, q.at[1], q.at[2]] as [number, number, number] })));
      const W = cols * sp,
        Dd = Math.ceil(n / cols) * sp;
      if (r.b("shade")) s.push(...pavilionSolids(W, Dd, 3.0, [70, 110, 88], C.steelDark, "flat").slice(1));
      return { solids: s, shade: r.b("shade") ? { r: Math.max(W, Dd) / 2, h: 3.2 } : undefined };
    },
  }),
  propDef({
    id: "parks.gazebo",
    name: "Gazebo",
    category: PK,
    tags: ["bandstand", "belvedere", "summerhouse", "kiosk", "rotunda"],
    description: "Octagonal (or n-sided) open gazebo with a conical roof and railings.",
    icon: "tent",
    params: [num("diameter", "Diameter", 5, { group: D, unit: "m", min: 2.5, max: 16, step: 0.1 }), num("height", "Eave height", 2.7, { group: D, unit: "m", min: 2.2, max: 5, step: 0.1 }), int("sides", "Sides", 8, { group: D, min: 4, max: 12 }), color("roof", "Roof colour", "#3c5e48", { group: A }), color("post", "Post colour", "#f0f0ec", { group: A })],
    build: (r) => ({ solids: gazeboSolids(r.n("diameter"), r.n("height"), hexToRgb(r.c("roof")), hexToRgb(r.c("post")), r.n("sides")), shade: { r: r.n("diameter") / 2, h: r.n("height") + 1 } }),
  }),
  propDef({
    id: "parks.pavilion",
    name: "Pavilion / picnic shelter",
    category: PK,
    tags: ["shelter", "open shelter", "ramada", "pavilion", "covered seating", "shade structure"],
    description: "Rectangular open-sided shelter on posts with a hip, gable or flat roof.",
    icon: "tent",
    params: [num("width", "Length", 10, { group: D, unit: "m", min: 3, max: 40, step: 0.5 }), num("depth", "Depth", 7, { group: D, unit: "m", min: 3, max: 25, step: 0.5 }), num("height", "Eave height", 3.0, { group: D, unit: "m", min: 2.3, max: 6, step: 0.1 }), choice("roof", "Roof", "hip", opts("hip", "gable", "flat"), { group: A }), color("roofColor", "Roof colour", "#96403a", { group: A }), color("post", "Structure colour", "#684e38", { group: A }), int("tables", "Picnic tables", 3, { group: A, min: 0, max: 12 })],
    build: (r) => {
      const w = r.n("width"),
        d = r.n("depth");
      const s = pavilionSolids(w, d, r.n("height"), hexToRgb(r.c("roofColor")), hexToRgb(r.c("post")), r.s("roof") as "hip");
      const n = r.n("tables");
      for (let i = 0; i < n; i++) s.push(...moveSolids(benchSolids("picnic", 2.4), -w / 2 + (w * (i + 0.5)) / n, 0, 90, 0.25));
      return { solids: s, shade: { r: Math.max(w, d) / 2, h: r.n("height") + 1 } };
    },
  }),
  propDef({
    id: "parks.pergola",
    name: "Pergola",
    category: PK,
    tags: ["arbor", "trellis", "shade pergola", "vine pergola", "colonnade"],
    description: "Open beam pergola on columns, optionally covered in vines.",
    icon: "columns-3",
    params: [num("length", "Length", 8, { group: D, unit: "m", min: 2, max: 60, step: 0.5 }), num("width", "Width", 3.5, { group: D, unit: "m", min: 1.5, max: 10, step: 0.1 }), num("height", "Height", 2.8, { group: D, unit: "m", min: 2.2, max: 5, step: 0.1 }), bool("vines", "Vines", true, { group: A }), color("color", "Timber colour", "#c4a070", { group: A })],
    build: (r) => {
      const L = r.n("length"),
        W = r.n("width"),
        h = r.n("height");
      const c = hexToRgb(r.c("color"));
      const s: Solid[] = [];
      const n = Math.max(2, Math.round(L / 3) + 1);
      for (let i = 0; i < n; i++) for (const y of [-W / 2, W / 2]) s.push(box(-L / 2 + (L * i) / (n - 1), y, 0, 0.25, 0.25, h, c, "wood"));
      for (const y of [-W / 2, W / 2]) s.push(box(0, y, h, L + 0.6, 0.15, 0.3, c, "wood"));
      const m = Math.round(L / 0.6);
      for (let i = 0; i <= m; i++) s.push(box(-L / 2 + (L * i) / m, 0, h + 0.3, 0.08, W + 0.8, 0.18, c, "wood"));
      if (r.b("vines")) s.push(box(0, 0, h + 0.45, L * 0.9, W * 0.9, 0.3, C.foliage, "foliage"), box(-L / 2, -W / 2, 0, 0.5, 0.5, h, C.foliageDark, "foliage"));
      return { solids: s, shade: { r: Math.max(L, W) / 2, h } };
    },
  }),
  {
    id: "parks.cemetery",
    name: "Cemetery",
    category: PK,
    tags: ["graveyard", "burial ground", "memorial park", "churchyard"],
    description: "Cemetery ground with rows of headstones, paths and trees.",
    icon: "cross",
    placement: "polygon",
    params: [num("width", "Width (if not drawn)", 80, { group: D, unit: "m", min: 10, max: 2000 }), num("depth", "Depth (if not drawn)", 60, { group: D, unit: "m", min: 10, max: 2000 }), num("rowSpacing", "Row spacing", 3, { group: D, unit: "m", min: 1.5, max: 8, step: 0.1 }), num("density", "Plots filled", 70, { group: D, unit: "%", min: 0, max: 100, step: 5 })],
    generate(values, place, ctx) {
      const params = this.params;
      const r = reader(values, params);
      const out = new Out(ctx);
      const { poly, frame } = siteOf(place, r.n("width"), r.n("depth"));
      out.area("cemetery", poly, { primary: true });
      const rand = rng(seedOf(ctx));
      const s: Solid[] = [];
      const sp = r.n("rowSpacing");
      for (const p of scatterIn(poly, sp, seedOf(ctx), 0, 3).slice(0, 1500)) {
        if (rand() * 100 > r.n("density")) continue;
        const q = toLocal(frame, p);
        const big = rand() < 0.1;
        s.push(S(big ? "box" : rand() < 0.3 ? "wedge" : "box", [q[0], q[1], 0], big ? [1.2, 0.8, 1.6] : [0.7, 0.2, 0.8 + rand() * 0.4], rand() < 0.5 ? C.granite : C.stone, "stone"));
      }
      if (s.length) out.prop("parks.cemetery", { ...frame, siteW: 0, siteD: 0 }, s, { primary: false, height: 1.6 });
      return out.done();
    },
  },
  {
    id: "parks.trail",
    name: "Trail / greenway path",
    category: PK,
    tags: ["walking path", "multi-use path", "greenway", "jogging trail", "footpath", "hike and bike trail", "rail trail"],
    description: "Off-street path along a drawn line (footway, shared-use cycleway or nature trail) with optional benches, lights and trees.",
    icon: "route",
    placement: "path",
    params: [choice("type", "Path type", "cycleway", [{ value: "footway", label: "Footpath" }, { value: "cycleway", label: "Shared-use path (bike + walk)" }, { value: "trail", label: "Nature trail" }, { value: "path", label: "Generic path" }, { value: "steps", label: "Steps" }], { group: A }), int("benchEvery", "Bench every", 150, { group: F, unit: "m", min: 0, max: 1000, description: "0 = no benches" }), int("lampEvery", "Light every", 0, { group: F, unit: "m", min: 0, max: 200 }), int("treeEvery", "Tree every", 15, { group: P, unit: "m", min: 0, max: 200 }), choice("species", "Trees", "cedar_elm", TREE_OPTS, { group: P })],
    generate(values, place, ctx) {
      const params = this.params;
      const r = reader(values, params);
      const out = new Out(ctx);
      const path = place.path && place.path.length >= 2 ? place.path : defaultPath(place, 60);
      out.path(path, r.s("type") as "footway", { primary: true, name: r.s("name") || undefined });
      if (r.n("benchEvery") > 0) for (const s of stations(offsetPath(path, 2.5), r.n("benchEvery"), r.n("benchEvery") / 2, false)) out.prop("streetscape.bench", { c: s.p, a: ((s.rot + 180) * Math.PI) / 180, siteW: 0, siteD: 0 }, benchSolids("park", 1.8), { primary: false });
      if (r.n("lampEvery") > 0) for (const s of stations(offsetPath(path, -2), r.n("lampEvery"), 0, false)) out.prop("streetscape.street_lamp", { c: s.p, a: 0, siteW: 0, siteD: 0 }, lampSolids("pedestrian", 4), { primary: false, anchorR: 0.3 });
      if (r.n("treeEvery") > 0) {
        const sts = stations(offsetPath(path, 6), r.n("treeEvery"), r.n("treeEvery") / 3, false);
        plantTrees(out, sts.map((s) => s.p), r.s("species"), 0.8, seedOf(ctx));
      }
      out.summary.push(`Trail: ${fmtLen(pathLength(path))}`);
      return out.done();
    },
  },
];

// ---------------------------------------------------------------- shared with water / landmarks

export function fountainSolids(kind: "tiered" | "jet" | "wall" | "bowl" | "modern", dia: number, stone: RGB): Solid[] {
  const s: Solid[] = [cyl(0, 0, 0, dia, 0.55, stone, "stone"), cyl(0, 0, 0.05, dia - 0.5, 0.45, C.water, "water")];
  switch (kind) {
    case "tiered":
      s.push(cyl(0, 0, 0.5, dia * 0.12, 1.4, stone, "stone"), cyl(0, 0, 1.9, dia * 0.45, 0.3, stone, "stone"), cyl(0, 0, 2.0, dia * 0.4, 0.22, C.water, "water"), cyl(0, 0, 2.2, dia * 0.07, 1.0, stone, "stone"), cyl(0, 0, 3.2, dia * 0.22, 0.25, stone, "stone"), S("cone", [0, 0, 3.4], [0.5, 0.5, 1.2], [220, 236, 244], "water"));
      break;
    case "jet":
      s.push(S("cone", [0, 0, 0.4], [dia * 0.15, dia * 0.15, dia * 0.8], [220, 236, 244], "water"));
      for (let i = 0; i < 8; i++) s.push(S("cone", [Math.cos(i * 0.785) * dia * 0.3, Math.sin(i * 0.785) * dia * 0.3, 0.4], [0.3, 0.3, dia * 0.3], [220, 236, 244], "water"));
      break;
    case "wall":
      s.length = 0;
      s.push(box(0, 0.5, 0, dia, 0.6, 3, stone, "stone"), box(0, -0.4, 0, dia, 1.4, 0.5, stone, "stone"), box(0, -0.4, 0.05, dia - 0.3, 1.1, 0.42, C.water, "water"), box(0, 0.18, 0.4, dia * 0.8, 0.05, 2.4, [200, 226, 240], "water"));
      break;
    case "bowl":
      s.push(cyl(0, 0, 0.5, dia * 0.1, 0.8, stone, "stone"), S("hemisphere", [0, 0, 1.3], [dia * 0.5, dia * 0.5, 0.5], stone, "stone"), cyl(0, 0, 1.75, dia * 0.45, 0.05, C.water, "water"));
      break;
    case "modern":
      s.push(S("sphere", [0, 0, 0.5], [dia * 0.3, dia * 0.3, dia * 0.3], C.granite, "stone"), S("cone", [0, 0, 0.5 + dia * 0.28], [0.2, 0.2, 1.4], [220, 236, 244], "water"));
      break;
  }
  return s;
}

export function statueSolids(figure: number, pedestal: number, metal: RGB, base: RGB, kind: "standing" | "equestrian" | "bust" | "abstract" = "standing"): Solid[] {
  const s: Solid[] = [box(0, 0, 0, pedestal * 1.4, pedestal * 1.4, 0.4, base, "stone"), box(0, 0, 0.4, pedestal, pedestal, pedestal * 0.9, base, "stone"), box(0, 0, 0.4 + pedestal * 0.9, pedestal * 1.15, pedestal * 1.15, 0.25, base, "stone")];
  const z = 0.65 + pedestal * 0.9;
  const H = figure;
  switch (kind) {
    case "equestrian":
      s.push(S("sphere", [0, 0, z + H * 0.35], [H * 0.75, H * 0.25, H * 0.3], metal, "metal"));
      for (const [x, y] of [[0.25, 0.08], [0.25, -0.08], [-0.25, 0.08], [-0.25, -0.08]]) s.push(cyl(x * H, y * H, z, H * 0.06, H * 0.38, metal, "metal"));
      s.push(S("cylinder", [H * 0.3, 0, z + H * 0.4], [H * 0.12, H * 0.12, H * 0.35], metal, "metal", 0, [0, 30]), S("sphere", [H * 0.5, 0, z + H * 0.68], [H * 0.25, H * 0.12, H * 0.13], metal, "metal"));
      s.push(S("cylinder", [0, 0, z + H * 0.5], [H * 0.14, H * 0.14, H * 0.35], metal, "metal"), sphereAt(0, 0, z + H * 0.85, H * 0.13, metal));
      break;
    case "bust":
      s.push(S("sphere", [0, 0, z], [H * 0.5, H * 0.3, H * 0.4], metal, "metal"), sphereAt(0, 0, z + H * 0.35, H * 0.3, metal));
      break;
    case "abstract":
      s.push(S("torus", [0, H * 0.09, z + H * 0.4], [H * 0.8, H * 0.8, H * 0.18], metal, "metal", 0, [90, 0]));
      break;
    default:
      for (const y of [-0.08, 0.08]) s.push(cyl(0, y * H, z, H * 0.09, H * 0.47, metal, "metal"));
      s.push(S("cylinder", [0, 0, z + H * 0.45], [H * 0.26, H * 0.17, H * 0.35], metal, "metal"), sphereAt(0, 0, z + H * 0.82, H * 0.14, metal));
      s.push(S("cylinder", [0, H * 0.15, z + H * 0.75], [H * 0.06, H * 0.06, H * 0.3], metal, "metal", 0, [-20, 0]), S("cylinder", [0, -H * 0.15, z + H * 0.48], [H * 0.06, H * 0.06, H * 0.3], metal, "metal"));
  }
  return s;
}

const sphereAt = (x: number, y: number, z: number, d: number, c: RGB): Solid => S("sphere", [x, y, z], [d, d, d * 1.15], c, "metal");

export type { PlacementInput };
