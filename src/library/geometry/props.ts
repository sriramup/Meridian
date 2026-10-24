// Prop solid builders: street furniture, lighting, vegetation and animals made of unit solids in
// the prop frame (x right, y forward, origin on the ground). Each builder is parameterised by the
// dimensions planners care about; defaults follow common street-furniture standards.

import type { Solid } from "@/world/types";
import { C, mix, shade } from "./palette";
import { S, beam, box, cyl, moveSolids, sphere, type RGB } from "./solids";

// ---------------------------------------------------------------- seating

export type BenchStyle = "classic" | "backless" | "modern" | "park" | "picnic" | "curved" | "stone";

/** bench: length along x, seat ≈ 0.45 m high (ADA 17–19 in), depth ≈ 0.5–0.65 m */
export function benchSolids(style: BenchStyle, length = 1.8, seatColor: RGB = C.wood, frameColor: RGB = C.steelDark, arms = true): Solid[] {
  const L = Math.max(0.6, length);
  const out: Solid[] = [];
  const seatH = 0.45;
  switch (style) {
    case "stone":
      out.push(box(0, 0, 0, L, 0.6, seatH, C.stone, "stone"));
      return out;
    case "picnic": {
      // picnic table: 0.75 m top, benches either side (ADA-friendly overhang at the ends)
      out.push(box(0, 0, 0.72, L, 0.8, 0.05, seatColor, "wood"));
      out.push(box(0, 0.62, 0.42, L, 0.28, 0.04, seatColor, "wood"));
      out.push(box(0, -0.62, 0.42, L, 0.28, 0.04, seatColor, "wood"));
      for (const x of [-L / 2 + 0.25, L / 2 - 0.25]) {
        out.push(S("box", [x, 0, 0], [0.08, 1.5, 0.06], frameColor, "wood"));
        out.push(S("box", [x, 0.2, 0], [0.08, 0.08, 0.74], frameColor, "wood", 0, [25, 0]));
        out.push(S("box", [x, -0.2, 0], [0.08, 0.08, 0.74], frameColor, "wood", 0, [-25, 0]));
      }
      return out;
    }
    case "curved": {
      const n = 5;
      const R = L * 0.9;
      const span = L / R;
      for (let i = 0; i < n; i++) {
        const a = -span / 2 + (span * (i + 0.5)) / n;
        const x = Math.sin(a) * R,
          y = R - Math.cos(a) * R;
        out.push(S("box", [x, y, seatH - 0.06], [L / n + 0.02, 0.5, 0.06], seatColor, "wood", (-a * 180) / Math.PI));
        out.push(S("box", [x, y, 0], [0.12, 0.4, seatH - 0.06], frameColor, "metal", (-a * 180) / Math.PI));
      }
      return out;
    }
    default: {
      const depth = style === "park" ? 0.6 : 0.5;
      out.push(box(0, 0, seatH - 0.06, L, depth, 0.06, seatColor, style === "modern" ? "metal" : "wood"));
      const legs = L > 2.2 ? [-L / 2 + 0.15, 0, L / 2 - 0.15] : [-L / 2 + 0.15, L / 2 - 0.15];
      for (const x of legs) out.push(box(x, 0, 0, 0.07, depth * 0.9, seatH - 0.06, frameColor, "metal"));
      if (style !== "backless") {
        out.push(S("box", [0, -depth / 2 + 0.04, seatH], [L, 0.05, 0.42], seatColor, style === "modern" ? "metal" : "wood", 0, [12, 0]));
        if (arms && style !== "modern") for (const x of [-L / 2 + 0.04, L / 2 - 0.04]) out.push(box(x, 0, seatH, 0.06, depth * 0.8, 0.22, frameColor, "metal"));
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------- lighting

export type LampStyle = "cobra" | "acorn" | "post_top" | "double" | "pedestrian" | "modern" | "historic" | "high_mast";

/** street light: 4–6 m pedestrian, 8–12 m roadway (cobra head), 20–40 m high mast */
export function lampSolids(style: LampStyle, height = 8, arm = 1.8, pole: RGB = C.steelDark, lightColor: RGB = C.light): Solid[] {
  const H = Math.max(2, height);
  const out: Solid[] = [];
  const pd = style === "high_mast" ? 0.6 : style === "historic" || style === "acorn" ? 0.18 : 0.14;
  out.push(cyl(0, 0, 0, pd * 2.2, 0.5, shade(pole, 0.9), "metal"));
  out.push(cyl(0, 0, 0, pd, H, pole, "metal"));
  switch (style) {
    case "cobra":
      out.push(beam([0, 0], [arm, 0], H - 0.15, 0.08, 0.08, pole, "metal"));
      out.push(box(arm, 0, H - 0.3, 0.7, 0.3, 0.18, pole, "metal"));
      out.push(box(arm, 0, H - 0.32, 0.55, 0.22, 0.03, lightColor, "light"));
      break;
    case "double":
      for (const s of [-1, 1]) {
        out.push(beam([0, 0], [s * arm, 0], H - 0.15, 0.08, 0.08, pole, "metal"));
        out.push(box(s * arm, 0, H - 0.3, 0.7, 0.3, 0.18, pole, "metal"));
        out.push(box(s * arm, 0, H - 0.32, 0.55, 0.22, 0.03, lightColor, "light"));
      }
      break;
    case "acorn":
    case "historic":
      out.push(cyl(0, 0, H - 0.1, 0.3, 0.12, pole, "metal"));
      out.push(S("sphere", [0, 0, H], [0.42, 0.42, 0.7], lightColor, "light"));
      out.push(S("cone", [0, 0, H + 0.62], [0.34, 0.34, 0.3], pole, "metal"));
      if (style === "historic") out.push(cyl(0, 0, 0.5, pd * 1.6, 1.4, pole, "metal"));
      break;
    case "post_top":
    case "pedestrian":
      out.push(cyl(0, 0, H, 0.5, 0.25, lightColor, "light"));
      out.push(cyl(0, 0, H + 0.25, 0.56, 0.06, pole, "metal"));
      break;
    case "modern":
      out.push(S("box", [arm / 2, 0, H - 0.08], [arm + 0.2, 0.22, 0.08], pole, "metal"));
      out.push(box(arm / 2 + 0.1, 0, H - 0.1, arm * 0.8, 0.16, 0.02, lightColor, "light"));
      break;
    case "high_mast":
      out.push(S("torus", [0, 0, H], [2.4, 2.4, 0.3], pole, "metal"));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        out.push(box(Math.cos(a) * 1.1, Math.sin(a) * 1.1, H - 0.2, 0.4, 0.4, 0.25, lightColor, "light"));
      }
      break;
  }
  return out;
}

// ---------------------------------------------------------------- small street furniture

export function bollardSolids(height = 0.9, diameter = 0.2, color: RGB = C.steelDark, lit = false): Solid[] {
  const out = [cyl(0, 0, 0, diameter, height, color, "metal"), S("hemisphere", [0, 0, height], [diameter, diameter, diameter * 0.4], color, "metal")];
  if (lit) out.push(cyl(0, 0, height - 0.18, diameter * 1.02, 0.08, C.light, "light"));
  return out;
}

export type BinKind = "trash" | "recycling" | "compost" | "dual" | "dumpster" | "big_belly";

export function binSolids(kind: BinKind, color: RGB = C.steelDark): Solid[] {
  switch (kind) {
    case "dumpster": // 3–4 yd³ front-load: 1.8 × 1.1 × 1.3 m
      return [box(0, 0, 0.12, 1.8, 1.1, 1.15, color, "metal"), S("wedge", [0, 0, 1.27], [1.82, 1.12, 0.08], shade(color, 0.8), "plastic"), ...[-0.7, 0.7].flatMap((x) => [cyl(x, 0.4, 0, 0.12, 0.12, C.black), cyl(x, -0.4, 0, 0.12, 0.12, C.black)])];
    case "big_belly":
      return [box(0, 0, 0, 0.65, 0.68, 1.27, color, "metal"), S("box", [0, 0.05, 1.27], [0.66, 0.6, 0.04], [60, 90, 120], "glass", 0, [-8, 0])];
    case "dual":
      return [cyl(-0.3, 0, 0, 0.55, 0.95, C.steelDark, "metal"), cyl(0.3, 0, 0, 0.55, 0.95, [54, 110, 160], "metal"), S("hemisphere", [-0.3, 0, 0.95], [0.56, 0.56, 0.12], C.steelDark, "metal"), S("hemisphere", [0.3, 0, 0.95], [0.56, 0.56, 0.12], [54, 110, 160], "metal")];
    default: {
      const c = kind === "recycling" ? ([54, 110, 160] as RGB) : kind === "compost" ? ([70, 120, 70] as RGB) : color;
      return [cyl(0, 0, 0, 0.6, 0.95, c, "metal"), S("hemisphere", [0, 0, 0.95], [0.62, 0.62, 0.14], shade(c, 0.85), "metal")];
    }
  }
}

export type RackStyle = "inverted_u" | "wave" | "post_ring" | "grid" | "covered";

/** bike rack: inverted-U hoops ≈ 0.9 m tall, 0.75 m wide, 0.9 m apart (APBP), 2 bikes per hoop */
export function bikeRackSolids(style: RackStyle, hoops = 5, color: RGB = C.steel): Solid[] {
  const n = Math.max(1, Math.round(hoops));
  const out: Solid[] = [];
  const pitch = 0.9;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * pitch;
    if (style === "post_ring") {
      out.push(cyl(x, 0, 0, 0.06, 0.95, color, "metal"), S("torus", [x, 0, 0.6], [0.4, 0.4, 0.04], color, "metal"));
    } else if (style === "wave" || style === "grid") {
      out.push(box(x, 0, 0, 0.05, 0.05, style === "grid" ? 0.5 : 0.85, color, "metal"));
      out.push(box(x, 0.3, 0, 0.05, 0.05, style === "grid" ? 0.5 : 0.85, color, "metal"));
    } else {
      out.push(box(x, -0.36, 0, 0.05, 0.05, 0.86, color, "metal"), box(x, 0.36, 0, 0.05, 0.05, 0.86, color, "metal"), box(x, 0, 0.86, 0.05, 0.77, 0.05, color, "metal"));
    }
  }
  if (style === "wave" || style === "grid") out.push(box(0, 0.15, style === "grid" ? 0.45 : 0.8, n * pitch, 0.35, 0.05, color, "metal"));
  if (style === "covered") {
    const L = n * pitch + 0.6;
    out.push(box(-L / 2, -1.2, 0, 0.1, 0.1, 2.3, C.steelDark, "metal"), box(L / 2, -1.2, 0, 0.1, 0.1, 2.3, C.steelDark, "metal"));
    out.push(S("box", [0, -0.1, 2.3], [L + 0.4, 2.6, 0.08], [196, 206, 214], "glass", 0, [6, 0]));
  }
  return out;
}

/** fire hydrant ≈ 0.75 m (NFPA 291 colour codes: red / yellow / green / blue / orange caps) */
export function hydrantSolids(body: RGB = C.red, cap: RGB = C.white): Solid[] {
  return [
    cyl(0, 0, 0, 0.26, 0.08, body, "metal"),
    cyl(0, 0, 0.08, 0.2, 0.52, body, "metal"),
    cyl(0, 0, 0.6, 0.26, 0.05, body, "metal"),
    S("hemisphere", [0, 0, 0.65], [0.22, 0.22, 0.12], cap, "metal"),
    S("cylinder", [0.08, 0, 0.38], [0.11, 0.11, 0.14], body, "metal", 0, [0, 90]),
    S("cylinder", [-0.08, 0, 0.38], [0.11, 0.11, 0.14], body, "metal", 0, [0, -90]),
    S("cylinder", [0, 0.06, 0.33], [0.16, 0.16, 0.14], cap, "metal", 0, [-90, 0]),
  ];
}

export type SignKind = "street_name" | "stop" | "yield" | "speed" | "wayfinding" | "parking" | "bus_stop" | "info_board";

/** sign: blade 2.1 m clearance (MUTCD), stop sign 0.75 m octagon */
export function signSolids(kind: SignKind, height = 2.6, color: RGB = C.green): Solid[] {
  const out: Solid[] = [cyl(0, 0, 0, 0.06, height, C.steel, "metal")];
  const top = height;
  switch (kind) {
    case "street_name":
      out.push(box(0, 0, top - 0.1, 0.9, 0.03, 0.2, color, "metal"), box(0, 0, top - 0.35, 0.03, 0.9, 0.2, color, "metal"));
      break;
    case "stop":
      out.push(S("cylinder", [0, 0.02, top - 0.35], [0.75, 0.75, 0.03], C.red, "metal", 22.5, [90, 0]));
      break;
    case "yield":
      out.push(S("pyramid", [0, 0.02, top - 0.6], [0.9, 0.03, 0.78], C.white, "metal", 0, [180, 0]));
      break;
    case "speed":
    case "parking":
      out.push(box(0, 0.02, top - 0.75, 0.6, 0.03, 0.75, kind === "parking" ? C.blue : C.white, "metal"));
      break;
    case "bus_stop":
      out.push(box(0, 0.02, top - 0.6, 0.45, 0.03, 0.6, C.blue, "metal"), box(0, 0.04, top - 1.2, 0.3, 0.05, 0.5, C.white, "plastic"));
      break;
    case "wayfinding":
    case "info_board":
      out.length = 0;
      out.push(box(-0.5, 0, 0, 0.1, 0.1, height, C.steelDark, "metal"), box(0.5, 0, 0, 0.1, 0.1, height, C.steelDark, "metal"));
      out.push(box(0, 0, height * 0.35, 1.1, 0.08, height * 0.6, color, "metal"));
      out.push(box(0, 0, height, 1.25, 0.2, 0.08, C.steelDark, "metal"));
      break;
  }
  return out;
}

/** USPS-style collection box ≈ 1.25 m × 0.5 m × 0.6 m, or a residential post mailbox */
export function mailboxSolids(kind: "collection" | "residential" | "cluster", color: RGB = C.blue): Solid[] {
  if (kind === "residential") return [box(0, 0, 0, 0.1, 0.1, 1.05, C.woodDark, "wood"), box(0, 0, 1.05, 0.22, 0.48, 0.18, color, "metal"), S("cylinder", [0, 0, 1.14], [0.22, 0.48, 0.12], color, "metal", 0, [90, 0])];
  if (kind === "cluster") return [box(0, 0, 0, 0.9, 0.45, 1.6, [200, 196, 186], "metal"), box(0, 0, 1.6, 0.95, 0.5, 0.05, shade([200, 196, 186], 0.8), "metal")];
  return [box(0, 0, 0, 0.5, 0.55, 1.05, color, "metal"), S("cylinder", [0, 0, 1.05], [0.5, 0.55, 0.22], color, "metal"), ...[-0.2, 0.2].flatMap((x) => [box(x, 0.2, 0, 0.06, 0.06, 0.08, C.black), box(x, -0.2, 0, 0.06, 0.06, 0.08, C.black)])];
}

export type PlanterShape = "round" | "square" | "rect" | "tiered";

export function planterSolids(shape: PlanterShape, width = 1.2, depth = 1.2, height = 0.6, color: RGB = C.concrete, plant: RGB = C.foliage, flowers?: RGB): Solid[] {
  const out: Solid[] = [];
  if (shape === "round") out.push(cyl(0, 0, 0, width, height, color, "concrete"));
  else if (shape === "tiered") {
    out.push(box(0, 0, 0, width, depth, height * 0.5, color, "concrete"), box(0, 0, height * 0.5, width * 0.65, depth * 0.65, height * 0.5, color, "concrete"));
  } else out.push(box(0, 0, 0, width, shape === "square" ? width : depth, height, color, "concrete"));
  const pw = shape === "square" || shape === "round" ? width : width;
  const pd = shape === "square" || shape === "round" ? width : depth;
  out.push(S("hemisphere", [0, 0, height], [pw * 0.85, pd * 0.85, Math.min(0.9, pw * 0.5)], plant, "foliage"));
  if (flowers) out.push(S("hemisphere", [pw * 0.15, -pd * 0.1, height + 0.05], [pw * 0.4, pd * 0.4, Math.min(0.5, pw * 0.3)], flowers, "foliage"));
  return out;
}

// ---------------------------------------------------------------- vegetation

export type CrownShape = "round" | "spreading" | "conical" | "columnar" | "vase" | "weeping" | "palm" | "multistem" | "oval" | "layered" | "fan_palm";

export interface TreeSpec {
  shape: CrownShape;
  /** total height, m */
  height: number;
  /** crown diameter, m */
  crown: number;
  /** clear trunk height as a fraction of total height */
  trunkFrac: number;
  /** trunk diameter at breast height, m */
  dbh: number;
  color: RGB;
  trunkColor: RGB;
  /** extra crown clumps for irregularity (0–6) */
  clumps: number;
  /** 0–1 variation seed */
  seed: number;
  /** blossom / accent colour mixed into some clumps */
  accent?: RGB;
  /** bare winter tree: branches only */
  bare?: boolean;
}

export function treeSolids(t: TreeSpec): Solid[] {
  const H = Math.max(0.5, t.height);
  const Wc = Math.max(0.3, t.crown);
  const out: Solid[] = [];
  const tb = Math.max(0.15, Math.min(0.85, t.trunkFrac)) * H;
  const dbh = Math.max(0.04, t.dbh);
  const col = t.color,
    dark = shade(col, 0.82),
    lite = shade(col, 1.12);
  const rnd = (i: number) => {
    const x = Math.sin((t.seed * 97.13 + i * 12.9898) * 43758.5453);
    return x - Math.floor(x);
  };
  const crownH = H - tb;
  const leaf = (s: Solid) => (t.bare ? null : s);
  const push = (s: Solid | null) => s && out.push(s);
  switch (t.shape) {
    case "palm":
    case "fan_palm": {
      // slightly leaning trunk in 3 segments, crown of fronds
      const lean = (rnd(1) - 0.5) * 8;
      const seg = H / 3;
      for (let i = 0; i < 3; i++) out.push(S("cylinder", [Math.sin((lean * Math.PI) / 180) * seg * i, 0, seg * i], [dbh * (1 - i * 0.12), dbh * (1 - i * 0.12), seg + 0.05], t.trunkColor, "wood", 0, [0, lean]));
      const topX = Math.sin((lean * Math.PI) / 180) * H;
      const n = t.shape === "fan_palm" ? 12 : 9;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 360 + rnd(i) * 20;
        const droop = t.shape === "fan_palm" ? 20 + rnd(i + 3) * 25 : 25 + rnd(i + 3) * 35;
        const L = Wc * 0.62;
        const ar = (a * Math.PI) / 180;
        const reach = Math.cos((droop * Math.PI) / 180) * L * 0.5;
        push(leaf(S("box", [topX + Math.cos(ar) * reach, Math.sin(ar) * reach, H - 0.3 - Math.sin((droop * Math.PI) / 180) * L * 0.5], [L, t.shape === "fan_palm" ? Math.max(1.0, Wc * 0.28) : Math.max(0.6, Wc * 0.12), 0.08], i % 2 ? col : dark, "foliage", a, [0, droop])));
      }
      out.push(sphere(topX, 0, H - 0.6, Math.max(0.5, dbh * 2), shade(t.trunkColor, 0.9), "wood"));
      if (t.accent) out.push(sphere(topX, 0, H - 0.9, 0.5, t.accent, "foliage"));
      return out;
    }
    case "conical":
    case "layered": {
      out.push(cyl(0, 0, 0, dbh, H * 0.95, t.trunkColor, "wood"));
      if (t.bare) break;
      const tiers = t.shape === "layered" ? 4 : 2;
      for (let i = 0; i < tiers; i++) {
        const f = i / tiers;
        const z = tb + crownH * f * 0.75;
        const w = Wc * (1 - f * 0.7);
        out.push(S("cone", [0, 0, z], [w, w, (H - z) * (t.shape === "layered" ? 0.6 : 1)], i % 2 ? dark : col, "foliage"));
      }
      break;
    }
    case "columnar":
      out.push(cyl(0, 0, 0, dbh, tb + crownH * 0.3, t.trunkColor, "wood"));
      push(leaf(S("sphere", [0, 0, tb * 0.6], [Wc, Wc, H - tb * 0.6], col, "foliage")));
      push(leaf(S("cone", [0, 0, H * 0.75], [Wc * 0.55, Wc * 0.55, H * 0.25], dark, "foliage")));
      break;
    case "weeping":
      out.push(cyl(0, 0, 0, dbh, tb + crownH * 0.4, t.trunkColor, "wood"));
      push(leaf(S("hemisphere", [0, 0, H - crownH * 0.45], [Wc, Wc, crownH * 0.45], col, "foliage")));
      push(leaf(S("cylinder", [0, 0, Math.max(0.6, tb * 0.5)], [Wc * 0.96, Wc * 0.96, H - crownH * 0.45 - Math.max(0.6, tb * 0.5) + 0.05], lite, "foliage")));
      break;
    case "multistem": {
      const n = 3 + Math.round(rnd(2) * 2);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 360 + rnd(i) * 30;
        out.push(S("cylinder", [0, 0, 0], [dbh * 0.6, dbh * 0.6, tb + crownH * 0.5], t.trunkColor, "wood", a, [0, 14]));
      }
      if (t.bare) break;
      const m = 4 + Math.max(0, Math.round(t.clumps));
      for (let i = 0; i < m; i++) {
        const a = (i / m) * Math.PI * 2 + rnd(i + 9);
        const r = Wc * 0.25;
        const d = Wc * (0.45 + rnd(i + 4) * 0.2);
        const c = t.accent && i % 2 === 0 ? t.accent : i % 3 ? col : lite;
        out.push(S("sphere", [Math.cos(a) * r, Math.sin(a) * r, tb + rnd(i + 7) * crownH * 0.2], [d, d, crownH * 0.75], c, "foliage"));
      }
      return out;
    }
    case "vase":
      out.push(cyl(0, 0, 0, dbh, tb + crownH * 0.2, t.trunkColor, "wood"));
      for (const s of [-1, 1]) out.push(S("cylinder", [0, 0, tb * 0.8], [dbh * 0.6, dbh * 0.6, crownH * 0.5], t.trunkColor, "wood", 0, [s * 22, 0]));
      push(leaf(S("sphere", [0, 0, tb + crownH * 0.15], [Wc * 0.8, Wc * 0.8, crownH * 0.85], col, "foliage")));
      push(leaf(S("hemisphere", [0, 0, H - crownH * 0.45], [Wc, Wc, crownH * 0.45], lite, "foliage")));
      break;
    case "spreading": {
      out.push(cyl(0, 0, 0, dbh, tb + crownH * 0.3, t.trunkColor, "wood"));
      for (const a of [30, 150, 270]) out.push(S("cylinder", [0, 0, tb * 0.7], [dbh * 0.55, dbh * 0.55, Wc * 0.35], t.trunkColor, "wood", a, [0, 60]));
      push(leaf(S("sphere", [0, 0, tb], [Wc * 0.8, Wc * 0.8, crownH], col, "foliage")));
      const n = 3 + Math.max(0, Math.round(t.clumps));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd(i) * 0.6;
        const r = Wc * 0.27;
        const d = Wc * (0.42 + rnd(i + 2) * 0.12);
        push(leaf(S("sphere", [Math.cos(a) * r, Math.sin(a) * r, tb + crownH * 0.1 * rnd(i + 5)], [d, d, crownH * 0.7], i % 2 ? dark : lite, "foliage")));
      }
      return out;
    }
    case "oval":
      out.push(cyl(0, 0, 0, dbh, tb + crownH * 0.3, t.trunkColor, "wood"));
      push(leaf(S("sphere", [0, 0, tb], [Wc, Wc, crownH], col, "foliage")));
      break;
    default: {
      // round
      out.push(cyl(0, 0, 0, dbh, tb + crownH * 0.3, t.trunkColor, "wood"));
      push(leaf(S("sphere", [0, 0, tb], [Wc, Wc, crownH], col, "foliage")));
    }
  }
  if (t.bare) {
    // a few bare branches
    for (let i = 0; i < 5; i++) out.push(S("cylinder", [0, 0, tb * 0.9], [dbh * 0.35, dbh * 0.35, Math.max(1, crownH * 0.6)], t.trunkColor, "wood", i * 72 + rnd(i) * 20, [0, 35]));
    return out;
  }
  const extra = Math.max(0, Math.min(6, Math.round(t.clumps)));
  if (t.shape === "round" || t.shape === "oval" || t.shape === "vase")
    for (let i = 0; i < extra; i++) {
      const a = (i / Math.max(1, extra)) * Math.PI * 2 + rnd(i) * 0.8;
      const r = Wc * 0.28;
      const d = Wc * (0.38 + rnd(i + 1) * 0.15);
      const c = t.accent && i % 2 === 0 ? t.accent : i % 2 ? dark : lite;
      out.push(S("sphere", [Math.cos(a) * r, Math.sin(a) * r, tb + crownH * (0.15 + rnd(i + 3) * 0.35)], [d, d, d * (crownH / Wc)], c, "foliage"));
    }
  return out;
}

export type ShrubShape = "mound" | "upright" | "spreading" | "topiary_ball" | "topiary_cone" | "succulent" | "grass_clump" | "fern";

export function shrubSolids(shape: ShrubShape, width = 1.2, height = 1.0, color: RGB = C.foliage, flowers?: RGB, seed = 0): Solid[] {
  const w = Math.max(0.1, width),
    h = Math.max(0.1, height);
  const r = (i: number) => {
    const x = Math.sin((seed * 31.7 + i * 7.31) * 9137.53);
    return x - Math.floor(x);
  };
  const out: Solid[] = [];
  switch (shape) {
    case "topiary_ball":
      out.push(cyl(0, 0, 0, 0.08, h * 0.4, C.trunk, "wood"), sphere(0, 0, h * 0.3, Math.min(w, h * 0.75), color, "foliage"));
      break;
    case "topiary_cone":
      out.push(S("cone", [0, 0, 0], [w, w, h], color, "foliage"));
      break;
    case "upright":
      out.push(S("sphere", [0, 0, 0], [w * 0.7, w * 0.7, h], color, "foliage"));
      break;
    case "succulent":
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * 360;
        out.push(S("cone", [0, 0, 0], [w * 0.18, w * 0.08, h], color, "foliage", a, [0, 28 + r(i) * 20]));
      }
      break;
    case "grass_clump":
      for (let i = 0; i < 6; i++) out.push(S("cone", [(r(i) - 0.5) * w * 0.4, (r(i + 9) - 0.5) * w * 0.4, 0], [w * 0.45, w * 0.45, h * (0.7 + r(i + 4) * 0.3)], i % 2 ? color : shade(color, 1.15), "foliage", 0, [(r(i + 2) - 0.5) * 24, (r(i + 3) - 0.5) * 24]));
      break;
    case "fern":
      for (let i = 0; i < 8; i++) out.push(S("box", [0, 0, h * 0.1], [w * 0.55, w * 0.12, 0.03], color, "foliage", i * 45, [0, -35]));
      break;
    case "spreading":
      out.push(S("hemisphere", [0, 0, 0], [w, w * 0.8, h], color, "foliage"), S("hemisphere", [w * 0.25, w * 0.1, 0], [w * 0.6, w * 0.6, h * 0.8], shade(color, 1.1), "foliage"));
      break;
    default:
      out.push(S("hemisphere", [0, 0, 0], [w, w, h], color, "foliage"));
      for (let i = 0; i < 2; i++) out.push(S("hemisphere", [(r(i) - 0.5) * w * 0.4, (r(i + 5) - 0.5) * w * 0.4, 0], [w * 0.6, w * 0.6, h * 0.85], shade(color, i ? 0.88 : 1.12), "foliage"));
  }
  if (flowers) for (let i = 0; i < 4; i++) out.push(sphere((r(i + 11) - 0.5) * w * 0.6, (r(i + 13) - 0.5) * w * 0.6, h * 0.65, Math.max(0.12, w * 0.18), flowers, "foliage", Math.max(0.1, w * 0.12)));
  return out;
}

// ---------------------------------------------------------------- fauna

export interface QuadrupedSpec {
  /** body length (chest to rump), m */
  length: number;
  /** shoulder height, m */
  height: number;
  color: RGB;
  /** secondary colour (belly, muzzle, mane) */
  accent?: RGB;
  /** neck length as a fraction of body length */
  neck?: number;
  /** neck raised angle, degrees */
  neckAngle?: number;
  head?: number;
  tail?: number;
  /** tail raised angle, degrees (0 = horizontal, negative = hanging) */
  tailAngle?: number;
  ears?: "pointed" | "floppy" | "long" | "none";
  antlers?: boolean;
  /** body depth as a fraction of shoulder height */
  girth?: number;
  bushyTail?: boolean;
  /** sitting pose */
  sitting?: boolean;
}

/** a decorative four-legged animal facing +x */
export function quadrupedSolids(q: QuadrupedSpec): Solid[] {
  const L = Math.max(0.1, q.length),
    H = Math.max(0.08, q.height);
  const g = (q.girth ?? 0.45) * H;
  const legH = H - g * 0.6;
  const out: Solid[] = [];
  const bodyZ = q.sitting ? legH * 0.4 : legH;
  out.push(S("sphere", [0, 0, bodyZ - g * 0.1], [L, g * 0.85, g * 1.1], q.color, "fur", 0, q.sitting ? [0, -25] : undefined));
  const legD = Math.max(0.02, g * 0.22);
  const legs: [number, number][] = q.sitting
    ? [[L * 0.32, g * 0.22], [L * 0.32, -g * 0.22]]
    : [[L * 0.36, g * 0.22], [L * 0.36, -g * 0.22], [-L * 0.36, g * 0.22], [-L * 0.36, -g * 0.22]];
  for (const [x, y] of legs) out.push(cyl(x, y, 0, legD, q.sitting ? legH * 1.1 : legH + g * 0.1, shade(q.color, 0.9), "fur"));
  if (q.sitting) out.push(S("sphere", [-L * 0.25, 0, 0], [L * 0.5, g, g * 0.8], q.color, "fur"));
  // neck and head
  const nl = (q.neck ?? 0.35) * L;
  const na = ((q.neckAngle ?? 40) * Math.PI) / 180;
  const nx = L * 0.42,
    nz = bodyZ + g * 0.25 + (q.sitting ? L * 0.2 : 0);
  out.push(S("cylinder", [nx, 0, nz - g * 0.2], [g * 0.4, g * 0.4, nl + g * 0.2], q.color, "fur", 0, [0, ((Math.PI / 2 - na) * 180) / Math.PI]));
  const hx = nx + Math.cos(na) * nl,
    hz = nz + Math.sin(na) * nl;
  const hs = (q.head ?? 0.3) * L;
  out.push(S("sphere", [hx, 0, hz - hs * 0.35], [hs * 1.2, hs * 0.75, hs * 0.75], q.accent ?? q.color, "fur"));
  out.push(S("sphere", [hx + hs * 0.55, 0, hz - hs * 0.45], [hs * 0.6, hs * 0.45, hs * 0.45], q.accent ?? shade(q.color, 1.1), "fur"));
  out.push(sphere(hx + hs * 0.86, 0, hz - hs * 0.32, Math.max(0.01, hs * 0.14), C.black));
  const ear = q.ears ?? "pointed";
  for (const s of [-1, 1]) {
    if (ear === "pointed") out.push(S("cone", [hx - hs * 0.15, s * hs * 0.22, hz], [hs * 0.25, hs * 0.18, hs * 0.4], q.color, "fur"));
    else if (ear === "long") out.push(S("cone", [hx - hs * 0.2, s * hs * 0.15, hz], [hs * 0.2, hs * 0.12, hs * 0.9], q.color, "fur"));
    else if (ear === "floppy") out.push(S("box", [hx - hs * 0.15, s * hs * 0.4, hz - hs * 0.6], [hs * 0.25, hs * 0.08, hs * 0.5], shade(q.color, 0.8), "fur"));
    if (q.antlers) {
      out.push(S("cylinder", [hx - hs * 0.1, s * hs * 0.2, hz], [0.04, 0.04, hs * 1.6], [140, 116, 90], "wood", 0, [s * -25, 10]));
      out.push(S("cylinder", [hx - hs * 0.1, s * hs * 0.45, hz + hs * 0.7], [0.03, 0.03, hs * 0.7], [140, 116, 90], "wood", 0, [s * -10, 40]));
    }
  }
  const tl = (q.tail ?? 0.4) * L;
  if (tl > 0.01) {
    const ta = q.tailAngle ?? 20;
    const td = q.bushyTail ? g * 0.6 : Math.max(0.02, g * 0.12);
    out.push(S(q.bushyTail ? "sphere" : "cylinder", [-L * 0.48, 0, bodyZ + g * 0.1], [td, td, tl], q.accent && q.bushyTail ? q.accent : q.color, "fur", 0, [0, -(90 - ta)]));
  }
  return out;
}

export interface BirdSpec {
  length: number;
  color: RGB;
  head?: RGB;
  beak?: RGB;
  /** neck length relative to body (geese, swans) */
  neck?: number;
  wingsOpen?: boolean;
  legs?: number;
  /** floating on water (no legs, low) */
  floating?: boolean;
}

/** a decorative bird facing +x */
export function birdSolids(b: BirdSpec): Solid[] {
  const L = Math.max(0.05, b.length);
  const out: Solid[] = [];
  const z0 = b.floating ? 0 : b.legs ?? L * 0.35;
  if (!b.floating) for (const s of [-1, 1]) out.push(cyl(0, s * L * 0.08, 0, Math.max(0.01, L * 0.04), z0 + L * 0.05, C.orange));
  out.push(S("sphere", [0, 0, z0], [L, L * 0.5, L * 0.45], b.color, "fur"));
  const nk = (b.neck ?? 0.15) * L;
  if (nk > L * 0.2) out.push(S("cylinder", [L * 0.35, 0, z0 + L * 0.25], [L * 0.12, L * 0.12, nk], b.head ?? b.color, "fur", 0, [0, 15]));
  const hz = z0 + L * 0.25 + nk;
  const hs = L * 0.32;
  out.push(sphere(L * 0.4 + nk * 0.25, 0, hz, hs, b.head ?? b.color, "fur"));
  out.push(S("cone", [L * 0.4 + nk * 0.25 + hs * 0.5, 0, hz + hs * 0.35], [hs * 0.35, hs * 0.25, hs * 0.55], b.beak ?? C.orange, "plastic", 0, [0, 90]));
  out.push(S("wedge", [-L * 0.5, 0, z0 + L * 0.15], [L * 0.35, L * 0.3, L * 0.08], shade(b.color, 0.8), "fur"));
  if (b.wingsOpen) for (const s of [-1, 1]) out.push(S("box", [0, s * L * 0.55, z0 + L * 0.3], [L * 0.45, L * 0.9, 0.02], shade(b.color, 0.9), "fur", 0, [s * 15, 0]));
  return out;
}

// ---------------------------------------------------------------- composite helpers

/** a small crowd of copies scattered in a disc (flocks, herds, gardens) */
export function scatter(base: (i: number) => Solid[], count: number, radius: number, seed = 1): Solid[] {
  const out: Solid[] = [];
  let s = seed * 9301 + 49297;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2,
      d = Math.sqrt(r()) * radius;
    out.push(...moveSolids(base(i), Math.cos(a) * d, Math.sin(a) * d, r() * 360));
  }
  return out;
}

export const tint = (c: RGB, seed: number, amt = 0.12): RGB => mix(c, shade(c, seed > 0.5 ? 1.2 : 0.8), Math.abs(seed - 0.5) * 2 * amt * 4);
