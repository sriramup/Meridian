// Definition factories for the non-building families: point props (one Prop from solids), linear
// features along a drawn path (fences, hedges, rows of bollards / lamps / trees), ground covers on a
// drawn site (Area entities with optional scattered planting) — each is one small call.

import { normalizePoly, pointInPoly, polyArea, polyBBox } from "@/geometry/polygon";
import type { AreaType, Polygon, PropCover, Solid, Vec2 } from "@/world/types";
import type { Category, GenerateContext, ParamSpec, ParamValues, PlacementInput, PrimitiveDef, Siting } from "../types";
import { type Frame, frameOf, hashSeed, rng } from "../geometry/frame";
import { solidsHeight } from "../geometry/solids";
import { Out } from "./make";
import { reader, type Reader } from "./params";

interface Common {
  id: string;
  name: string;
  category: Category;
  description: string;
  tags?: string[];
  icon?: string;
  params: ParamSpec[];
  siting?: Siting;
}

export interface PropBuild {
  solids: Solid[];
  /** casts shade (trees, canopies, shelters) */
  shade?: { r: number; h: number };
  cover?: PropCover;
  name?: string;
}

/** a single prop at a point; `build` returns solids in the prop frame */
export function propDef(o: Common & { build: (r: Reader, ctx: GenerateContext, place: PlacementInput) => PropBuild; extra?: (r: Reader, out: Out, f: Frame) => void }): PrimitiveDef {
  return {
    id: o.id,
    name: o.name,
    category: o.category,
    description: o.description,
    tags: o.tags,
    icon: o.icon,
    placement: "point",
    params: o.params,
    siting: o.siting,
    generate(values: ParamValues, place: PlacementInput, ctx: GenerateContext) {
      const r = reader(values, o.params);
      const out = new Out(ctx);
      const f = frameOf(place);
      const b = o.build(r, ctx, place);
      const p = out.prop(o.id, f, b.solids, { shade: b.shade, name: b.name });
      if (b.cover) p.cover = b.cover;
      o.extra?.(r, out, f);
      out.summary.push(`${o.name} (${solidsHeight(b.solids).toFixed(1)} m tall)`);
      return out.done();
    },
  };
}

// ---------------------------------------------------------------- paths

export interface Station {
  p: Vec2;
  /** heading of the path here, degrees CCW from east */
  rot: number;
  /** distance along the path */
  s: number;
}

/** points every `spacing` m along a polyline (both ends included when `ends`) */
export function stations(path: Vec2[], spacing: number, offset = 0, ends = true): Station[] {
  const out: Station[] = [];
  const sp = Math.max(0.2, spacing);
  let acc = 0;
  let next = offset > 0 ? offset : ends ? 0 : sp / 2;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i],
      b = path[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) continue;
    const rot = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    while (next <= acc + L + 1e-9) {
      const t = (next - acc) / L;
      out.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], rot, s: next });
      next += sp;
      if (out.length > 4000) return out;
    }
    acc += L;
  }
  if (ends && path.length >= 2) {
    const last = path[path.length - 1];
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(prev.p[0] - last[0], prev.p[1] - last[1]) > sp * 0.35) {
      const a = path[path.length - 2];
      out.push({ p: [last[0], last[1]], rot: (Math.atan2(last[1] - a[1], last[0] - a[0]) * 180) / Math.PI, s: acc });
    }
  }
  return out;
}

export const pathLength = (path: Vec2[]) => path.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - path[i][0], p[1] - path[i][1]), 0);

/** offset a polyline sideways (left positive) with mitred joints */
export function offsetPath(path: Vec2[], d: number): Vec2[] {
  if (Math.abs(d) < 1e-9 || path.length < 2) return path.map((p) => [p[0], p[1]] as Vec2);
  const out: Vec2[] = [];
  const n = (a: Vec2, b: Vec2): Vec2 => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  };
  for (let i = 0; i < path.length; i++) {
    const n0 = i > 0 ? n(path[i - 1], path[i]) : n(path[0], path[1]);
    const n1 = i < path.length - 1 ? n(path[i], path[i + 1]) : n0;
    let mx = n0[0] + n1[0],
      my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const k = Math.min(3, 1 / Math.max(0.2, mx * n1[0] + my * n1[1]));
    out.push([path[i][0] + mx * d * k, path[i][1] + my * d * k]);
  }
  return out;
}

/** a band polygon of width w around a polyline (canals, streams, hedges as areas) */
export function bandPoly(path: Vec2[], w: number): Polygon | null {
  if (path.length < 2) return null;
  const L = offsetPath(path, w / 2),
    R = offsetPath(path, -w / 2);
  const ring = [...R, ...L.reverse()];
  const poly = normalizePoly([ring]);
  return polyArea(poly) > 0.1 ? poly : null;
}

/** a path-placed feature built as one prop per segment (fences, walls, hedges, rails) */
export function linearDef(o: Common & { segment: (r: Reader, len: number) => Solid[]; maxSegment?: number; cover?: PropCover }): PrimitiveDef {
  return {
    id: o.id,
    name: o.name,
    category: o.category,
    description: o.description,
    tags: o.tags,
    icon: o.icon,
    placement: "path",
    params: o.params,
    siting: { overlapProps: true, ...o.siting },
    generate(values, place, ctx) {
      const r = reader(values, o.params);
      const out = new Out(ctx);
      const path = place.path && place.path.length >= 2 ? place.path : defaultPath(place);
      const maxSeg = o.maxSegment ?? 30;
      let total = 0;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i],
          b = path[i + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 0.2) continue;
        const n = Math.max(1, Math.ceil(L / maxSeg));
        for (let k = 0; k < n; k++) {
          const t0 = k / n,
            t1 = (k + 1) / n;
          const c: Vec2 = [a[0] + (b[0] - a[0]) * ((t0 + t1) / 2), a[1] + (b[1] - a[1]) * ((t0 + t1) / 2)];
          const len = L / n;
          const p = out.prop(o.id, { c, a: Math.atan2(b[1] - a[1], b[0] - a[0]), siteW: 0, siteD: 0 }, o.segment(r, len));
          if (o.cover) p.cover = o.cover;
        }
        total += L;
      }
      out.summary.push(`${o.name}: ${total.toFixed(0)} m`);
      return out.done();
    },
  };
}

/** a point-prop builder repeated along a path at a spacing (rows of bollards, lamps, planters, trees as props) */
export function rowDef(o: Common & { item: (r: Reader, i: number, st: Station) => PropBuild; spacingKey?: string; sideKey?: string }): PrimitiveDef {
  return {
    id: o.id,
    name: o.name,
    category: o.category,
    description: o.description,
    tags: o.tags,
    icon: o.icon,
    placement: "path",
    params: o.params,
    siting: o.siting,
    generate(values, place, ctx) {
      const r = reader(values, o.params);
      const out = new Out(ctx);
      const base = place.path && place.path.length >= 2 ? place.path : defaultPath(place);
      const path = o.sideKey ? offsetPath(base, r.n(o.sideKey)) : base;
      const st = stations(path, r.n(o.spacingKey ?? "spacing", 10));
      st.forEach((s, i) => {
        const b = o.item(r, i, s);
        const p = out.prop(o.id, { c: s.p, a: (s.rot * Math.PI) / 180, siteW: 0, siteD: 0 }, b.solids, { shade: b.shade });
        if (b.cover) p.cover = b.cover;
      });
      out.summary.push(`${o.name}: ${st.length} along ${pathLength(base).toFixed(0)} m`);
      return out.done();
    },
  };
}

/** when a path primitive is placed at a point, a default 20 m line through it */
export function defaultPath(place: PlacementInput, len = 20): Vec2[] {
  const f = frameOf(place);
  const ca = Math.cos(f.a),
    sa = Math.sin(f.a);
  return [
    [f.c[0] - (ca * len) / 2, f.c[1] - (sa * len) / 2],
    [f.c[0] + (ca * len) / 2, f.c[1] + (sa * len) / 2],
  ];
}

/** the site polygon of a placement, or a default rectangle w × d around the anchor */
export function siteOf(place: PlacementInput, w: number, d: number): { poly: Polygon; frame: Frame } {
  const f = frameOf(place);
  if (f.site) return { poly: f.site, frame: f };
  const ca = Math.cos(f.a),
    sa = Math.sin(f.a);
  const P = (x: number, y: number): Vec2 => [f.c[0] + x * ca - y * sa, f.c[1] + x * sa + y * ca];
  const poly = normalizePoly([[P(-w / 2, -d / 2), P(w / 2, -d / 2), P(w / 2, d / 2), P(-w / 2, d / 2)]]);
  return { poly, frame: { ...f, siteW: w, siteD: d, site: poly } };
}

/** scatter points inside a polygon with a minimum spacing (jittered grid), deterministic per seed */
export function scatterIn(poly: Polygon, spacing: number, seed: number, jitter = 0.35, margin = 0): Vec2[] {
  const [x0, y0, x1, y1] = polyBBox(poly);
  const sp = Math.max(0.3, spacing);
  const rand = rng(seed);
  const out: Vec2[] = [];
  const nx = Math.ceil((x1 - x0) / sp),
    ny = Math.ceil((y1 - y0) / sp);
  if (nx * ny > 20000) return out;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const p: Vec2 = [x0 + (i + 0.5 + (rand() - 0.5) * jitter * 2) * sp, y0 + (j + 0.5 + (rand() - 0.5) * jitter * 2) * sp];
      if (!pointInPoly(p, poly)) continue;
      if (margin > 0 && !pointInPoly([p[0] + margin, p[1]], poly)) continue;
      if (margin > 0 && !pointInPoly([p[0] - margin, p[1]], poly)) continue;
      if (margin > 0 && !pointInPoly([p[0], p[1] + margin], poly)) continue;
      if (margin > 0 && !pointInPoly([p[0], p[1] - margin], poly)) continue;
      out.push(p);
    }
  return out;
}

/** a ground cover on a drawn site: one Area, plus optional extras */
export function areaDef(o: Common & { type: AreaType | ((r: Reader) => AreaType); defaultSize?: [number, number]; depthKey?: string; extra?: (r: Reader, out: Out, site: Polygon, f: Frame, ctx: GenerateContext) => void }): PrimitiveDef {
  return {
    id: o.id,
    name: o.name,
    category: o.category,
    description: o.description,
    tags: o.tags,
    icon: o.icon,
    placement: "polygon",
    params: o.params,
    siting: o.siting,
    generate(values, place, ctx) {
      const r = reader(values, o.params);
      const out = new Out(ctx);
      const [w, d] = o.defaultSize ?? [30, 20];
      const { poly, frame } = siteOf(place, r.n("width", w) || w, r.n("depth", d) || d);
      const type = typeof o.type === "function" ? o.type(r) : o.type;
      const a = out.area(type, poly, { depth: o.depthKey ? r.n(o.depthKey) : undefined, name: r.s("name") || undefined });
      if (a) out.summary.push(`${o.name}: ${Math.round(polyArea(poly)).toLocaleString()} m²`);
      o.extra?.(r, out, poly, frame, ctx);
      return out.done();
    },
  };
}

export const seedOf = (ctx: GenerateContext, r?: Reader) => (r && r.n("seed", 0) > 0 ? r.n("seed") : hashSeed(ctx.ref?.instance ?? "x"));
