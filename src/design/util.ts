// Small shared helpers for the design generator: seeded randomness, edge frames, rectangles in an
// edge's frame, interval arithmetic along a frontage and polygon clean-up.

import { difference, intersection, isValidPoly, normalizePoly, polyArea, simplifyRing } from "@/geometry/polygon";
import type { Polygon, Ring, Vec2 } from "@/world/types";

/** mulberry32: deterministic, fast, good enough for layout jitter */
export function makeRng(seed: number) {
  let a = (Math.floor(seed) >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: <T>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(next() * xs.length))],
    chance: (p: number) => next() < p,
    /** weighted pick: weights need not sum to 1 */
    weighted: <T>(xs: readonly T[], w: readonly number[]): T => {
      const tot = w.reduce((s, x) => s + Math.max(0, x), 0);
      let r = next() * tot;
      for (let i = 0; i < xs.length; i++) {
        r -= Math.max(0, w[i]);
        if (r <= 0) return xs[i];
      }
      return xs[xs.length - 1];
    },
    fork: (salt: number) => makeRng((seed * 2654435761 + salt * 40503) >>> 0),
  };
}
export type Rng = ReturnType<typeof makeRng>;

/** stable integer hash of a string (seeds per block / street) */
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** an edge frame: origin a, unit direction u along the edge, unit normal n pointing into the block */
export interface EdgeFrame {
  a: Vec2;
  b: Vec2;
  u: Vec2;
  n: Vec2;
  len: number;
}

export function edgeFrame(a: Vec2, b: Vec2): EdgeFrame {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const u: Vec2 = [dx / len, dy / len];
  // CCW outer ring: the interior is on the left
  return { a, b, u, n: [-u[1], u[0]], len };
}

/** point at (s along, t inward) in an edge frame */
export const efPt = (f: EdgeFrame, s: number, t: number): Vec2 => [f.a[0] + f.u[0] * s + f.n[0] * t, f.a[1] + f.u[1] * s + f.n[1] * t];

/** rectangle [s0,s1] × [t0,t1] in an edge frame (CCW) */
export function efRect(f: EdgeFrame, s0: number, s1: number, t0: number, t1: number): Polygon {
  return [[efPt(f, s0, t0), efPt(f, s1, t0), efPt(f, s1, t1), efPt(f, s0, t1)]];
}

/** project a polygon onto an edge frame: [sMin, sMax, tMin, tMax] */
export function efExtent(f: EdgeFrame, p: Polygon): [number, number, number, number] {
  let s0 = Infinity,
    s1 = -Infinity,
    t0 = Infinity,
    t1 = -Infinity;
  for (const q of p[0]) {
    const dx = q[0] - f.a[0],
      dy = q[1] - f.a[1];
    const s = dx * f.u[0] + dy * f.u[1],
      t = dx * f.n[0] + dy * f.n[1];
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
  }
  return [s0, s1, t0, t1];
}

/** heading (degrees CCW from east) that makes a library frame's local +y point along `out` */
export function headingFacing(out: Vec2): number {
  return ((Math.atan2(out[1], out[0]) * 180) / Math.PI - 90 + 360) % 360;
}

/** subtract intervals from [lo, hi] */
export function freeIntervals(lo: number, hi: number, taken: [number, number][], minLen = 0): [number, number][] {
  let out: [number, number][] = [[lo, hi]];
  for (const [a, b] of taken) {
    const next: [number, number][] = [];
    for (const [x, y] of out) {
      if (b <= x || a >= y) next.push([x, y]);
      else {
        if (a > x) next.push([x, a]);
        if (b < y) next.push([b, y]);
      }
    }
    out = next;
  }
  return out.filter(([x, y]) => y - x >= minLen);
}

/** split a length into n parts whose widths vary by ±jitter, summing exactly to L */
export function splitLength(L: number, n: number, rng: Rng, jitter = 0.25): number[] {
  if (n <= 1) return [L];
  const w = Array.from({ length: n }, () => 1 + rng.range(-jitter, jitter));
  const tot = w.reduce((s, x) => s + x, 0);
  return w.map((x) => (x / tot) * L);
}

/** valid pieces with at least `minArea` m² */
export function cleanPieces(ps: Polygon[], minArea = 1): Polygon[] {
  return ps.map((p) => normalizePoly(p)).filter((p) => isValidPoly(p) && polyArea(p) >= minArea);
}

type BB = [number, number, number, number];
const bbOf = (p: Polygon): BB => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const q of p[0]) {
    if (q[0] < x0) x0 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[0] > x1) x1 = q[0];
    if (q[1] > y1) y1 = q[1];
  }
  return [x0, y0, x1, y1];
};
const bbHit = (a: BB, b: BB) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function isConvex(r: Ring): boolean {
  let sign = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i],
      b = r[(i + 1) % r.length],
      c = r[(i + 2) % r.length];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

/** Sutherland–Hodgman: a convex subject clipped by a convex CCW window */
function clipConvex(subject: Ring, win: Ring): Ring {
  let out = subject;
  for (let i = 0; i < win.length && out.length; i++) {
    const a = win[i],
      b = win[(i + 1) % win.length];
    const inside = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-9;
    const inp = out;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const p = inp[k],
        q = inp[(k + 1) % inp.length];
      const pi = inside(p),
        qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) {
        const dx = q[0] - p[0],
          dy = q[1] - p[1];
        const den = (b[0] - a[0]) * dy - (b[1] - a[1]) * dx;
        if (Math.abs(den) > 1e-12) {
          const t = ((b[1] - a[1]) * (p[0] - a[0]) - (b[0] - a[0]) * (p[1] - a[1])) / den;
          out.push([p[0] + dx * t, p[1] + dy * t]);
        }
      }
    }
  }
  return out;
}

export function clip(a: Polygon, b: Polygon, minArea = 1): Polygon[] {
  if (!bbHit(bbOf(a), bbOf(b))) return [];
  // fast path: two convex simple polygons (blocks, strips and lot rectangles usually are)
  if (a.length === 1 && b.length === 1 && isConvex(a[0]) && isConvex(b[0])) {
    const ca = normalizePoly(a),
      cb = normalizePoly(b);
    const r = clipConvex(ca[0], cb[0]);
    return r.length >= 3 ? cleanPieces([[r]], minArea) : [];
  }
  return cleanPieces(intersection(a, b), minArea);
}

const roundPoly = (p: Polygon, q = 100): Polygon => p.map((r) => simplifyRing(r.map(([x, y]) => [Math.round(x * q) / q, Math.round(y * q) / q] as Vec2), 0.02));
const inside = (pt: Vec2, p: Polygon) => {
  const r = p[0];
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i][1] > pt[1] !== r[j][1] > pt[1] && pt[0] < ((r[j][0] - r[i][0]) * (pt[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
};

/**
 * a − b that survives polygon-clipping's precision failures (it throws on near-degenerate input and the
 * wrapper returns nothing): retry rounded and nudged before concluding the result is empty
 */
function diffRobust(a: Polygon, b: Polygon): Polygon[] {
  const r = difference(a, b);
  if (r.length) return r;
  // genuinely covered?
  const ring = a[0];
  const c: Vec2 = [ring.reduce((t, v) => t + v[0], 0) / ring.length, ring.reduce((t, v) => t + v[1], 0) / ring.length];
  if (ring.every((v) => inside([v[0] + (c[0] - v[0]) * 0.01, v[1] + (c[1] - v[1]) * 0.01], b))) return [];
  for (const [dx, dy] of [[0, 0], [0.011, 0.007], [-0.013, 0.009]]) {
    const r2 = difference(roundPoly(a), roundPoly(b.map((rr) => rr.map(([x, y]) => [x + dx, y + dy] as Vec2))));
    if (r2.length) return r2;
  }
  return [a];
}

/** a minus every b (only the bs whose bounds touch a are clipped) */
export function minus(a: Polygon, bs: Polygon[], minArea = 1): Polygon[] {
  const ab = bbOf(a);
  const hit = bs.filter((b) => b.length && b[0].length >= 3 && bbHit(ab, bbOf(b)));
  if (!hit.length) return cleanPieces([a], minArea);
  // one subtraction at a time: polygon-clipping can drop the whole result when many operands share edges
  let cur: Polygon[] = [a];
  for (const b of hit) {
    const bb = bbOf(b);
    cur = cur.flatMap((q) => (bbHit(bbOf(q), bb) ? diffRobust(q, b) : [q]));
  }
  return cleanPieces(cur, minArea);
}

/** a simplified CCW outer ring without collinear points */
export function cleanRing(r: Ring): Ring {
  const s = simplifyRing(r, 0.4);
  return s.length >= 3 ? s : r;
}

/** narrowest extent of a polygon (OBB width) — rejects slivers */
export function minWidth(p: Polygon): number {
  const r = p[0];
  let best = Infinity;
  for (let i = 0; i < r.length; i++) {
    const f = edgeFrame(r[i], r[(i + 1) % r.length]);
    if (f.len < 0.5) continue;
    const [, , t0, t1] = efExtent(f, p);
    best = Math.min(best, t1 - t0);
  }
  return Number.isFinite(best) ? best : 0;
}

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
