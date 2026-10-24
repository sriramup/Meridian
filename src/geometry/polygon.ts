import polygonClipping, { type MultiPolygon as PCMulti, type Polygon as PCPoly } from "polygon-clipping";
import type { Polygon, Ring, Vec2 } from "@/world/types";
import { add, closestOnSeg, cross, dist, lineIntersect, norm, perp, rot, scale, sub } from "./vec";

export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i];
    const q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function polyArea(p: Polygon): number {
  if (!p.length) return 0;
  let a = Math.abs(ringArea(p[0]));
  for (let i = 1; i < p.length; i++) a -= Math.abs(ringArea(p[i]));
  return Math.max(0, a);
}

export function multiArea(ps: Polygon[]): number {
  return ps.reduce((s, p) => s + polyArea(p), 0);
}

export function openRing(r: Ring): Ring {
  if (r.length > 1) {
    const a = r[0];
    const b = r[r.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) return r.slice(0, -1);
  }
  return r;
}

export function closeRing(r: Ring): Ring {
  const o = openRing(r);
  return o.length ? [...o, o[0]] : o;
}

/** outer CCW, holes CW */
export function normalizePoly(p: Polygon): Polygon {
  return p.map((r, i) => {
    const o = openRing(r);
    const a = ringArea(o);
    if (i === 0 ? a < 0 : a > 0) return o.slice().reverse();
    return o;
  });
}

export function ringCentroid(r: Ring): Vec2 {
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i];
    const q = r[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const s = r.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]] as Vec2, [0, 0] as Vec2);
    return [s[0] / r.length, s[1] / r.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function polyCentroid(p: Polygon): Vec2 {
  return ringCentroid(p[0]);
}

export function pointInRing(pt: Vec2, r: Ring): boolean {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0],
      yi = r[i][1];
    const xj = r[j][0],
      yj = r[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-300) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(pt: Vec2, p: Polygon): boolean {
  if (!p.length || !pointInRing(pt, p[0])) return false;
  for (let i = 1; i < p.length; i++) if (pointInRing(pt, p[i])) return false;
  return true;
}

export function polyBBox(p: Polygon | Ring[]): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const pt of p[0] ?? []) {
    if (pt[0] < x0) x0 = pt[0];
    if (pt[1] < y0) y0 = pt[1];
    if (pt[0] > x1) x1 = pt[0];
    if (pt[1] > y1) y1 = pt[1];
  }
  return [x0, y0, x1, y1];
}

export const mapPoly = (p: Polygon, f: (v: Vec2) => Vec2): Polygon => p.map((r) => r.map(f));
export const translatePoly = (p: Polygon, d: Vec2) => mapPoly(p, (v) => add(v, d));
export const rotatePoly = (p: Polygon, c: Vec2, ang: number) => mapPoly(p, (v) => add(c, rot(sub(v, c), ang)));
export const scalePoly = (p: Polygon, c: Vec2, s: number | Vec2) => {
  const [sx, sy] = typeof s === "number" ? [s, s] : s;
  return mapPoly(p, (v) => [c[0] + (v[0] - c[0]) * sx, c[1] + (v[1] - c[1]) * sy]);
};

export function rectangle(c: Vec2, w: number, h: number, ang = 0): Ring {
  const hw = w / 2,
    hh = h / 2;
  const pts: Vec2[] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return pts.map((p) => add(c, rot(p, ang)));
}

export function circle(c: Vec2, r: number, n = 32): Ring {
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return out;
}

export function convexHull(pts: Vec2[]): Ring {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(q, lower[lower.length - 2])) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(q, upper[upper.length - 2])) <= 0)
      upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export interface OBB {
  center: Vec2;
  /** angle of the long axis */
  angle: number;
  /** length along the long axis */
  length: number;
  /** width across */
  width: number;
  ring: Ring;
}

/** minimum-area oriented bounding rectangle */
export function obb(pts: Vec2[]): OBB {
  const hull = convexHull(pts);
  let best: OBB | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const p of hull) {
      const q = rot(p, -ang);
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.length * best.width - 1e-9) {
      const w = x1 - x0,
        h = y1 - y0;
      const c = rot([(x0 + x1) / 2, (y0 + y1) / 2], ang);
      const long = w >= h;
      best = {
        center: c,
        angle: long ? ang : ang + Math.PI / 2,
        length: long ? w : h,
        width: long ? h : w,
        ring: rectangle(c, w, h, ang),
      };
    }
  }
  return best ?? { center: pts[0] ?? [0, 0], angle: 0, length: 0, width: 0, ring: [] };
}

// ---- boolean ops (polygon-clipping) ----------------------------------------

const toPC = (p: Polygon): PCPoly => p.map((r) => closeRing(r).map((v) => [v[0], v[1]] as [number, number]));
const fromPC = (m: PCMulti): Polygon[] =>
  m.map((poly) => normalizePoly(poly.map((r) => openRing(r.map((v) => [v[0], v[1]] as Vec2)))));

function safe(op: () => PCMulti): Polygon[] {
  try {
    return fromPC(op());
  } catch {
    return [];
  }
}

export const union = (...ps: Polygon[]): Polygon[] =>
  ps.length === 0 ? [] : safe(() => polygonClipping.union(toPC(ps[0]), ...ps.slice(1).map(toPC)));
export const intersection = (a: Polygon, ...b: Polygon[]): Polygon[] =>
  safe(() => polygonClipping.intersection(toPC(a), ...b.map(toPC)));
export const difference = (a: Polygon, ...b: Polygon[]): Polygon[] =>
  b.length ? safe(() => polygonClipping.difference(toPC(a), ...b.map(toPC))) : [a];
export const unionMany = (ps: Polygon[]): Polygon[] => {
  if (!ps.length) return [];
  return safe(() => polygonClipping.union(toPC(ps[0]), ...ps.slice(1).map(toPC)));
};

export function overlapArea(a: Polygon, b: Polygon): number {
  const ba = polyBBox(a),
    bb = polyBBox(b);
  if (ba[2] < bb[0] || bb[2] < ba[0] || ba[3] < bb[1] || bb[3] < ba[1]) return 0;
  return multiArea(intersection(a, b));
}

// ---- offsets ----------------------------------------------------------------

/**
 * Miter-offset a closed ring. Positive d grows a CCW ring outward; negative insets.
 * Self-intersections from deep insets are cleaned by intersecting with the
 * original (for insets) and keeping the largest resulting piece.
 */
export function offsetRing(r: Ring, d: number, miterLimit = 3): Ring {
  const n = r.length;
  if (n < 3) return r;
  const ccw = ringArea(r) > 0;
  const s = ccw ? -d : d; // outward normal for CCW is right-hand (-perp)
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const p0 = r[(i - 1 + n) % n];
    const p1 = r[i];
    const p2 = r[(i + 1) % n];
    const n0 = perp(norm(sub(p1, p0)));
    const n1 = perp(norm(sub(p2, p1)));
    const a0 = add(p0, scale(n0, s));
    const a1 = add(p1, scale(n0, s));
    const b1 = add(p1, scale(n1, s));
    const b2 = add(p2, scale(n1, s));
    const hit = lineIntersect(a0, sub(a1, a0), b1, sub(b2, b1));
    if (!hit) {
      out.push(a1);
      continue;
    }
    if (dist(hit.p, p1) > Math.abs(d) * miterLimit) {
      out.push(a1, b1); // bevel
    } else out.push(hit.p);
  }
  return out;
}

export function insetPoly(p: Polygon, d: number): Polygon | null {
  if (d <= 0) return p;
  const outer = offsetRing(p[0], -d);
  const cleaned = intersection([outer], [p[0]]);
  // keep the largest piece; holes grow by d
  let best: Polygon | null = null;
  let bestA = 0;
  for (const c of cleaned) {
    const a = polyArea(c);
    if (a > bestA) {
      best = c;
      bestA = a;
    }
  }
  if (!best || bestA < 1) return null;
  // verify inset is genuinely d away (miter artifacts can survive)
  const holes = p.slice(1).map((h) => offsetRing(h, d));
  if (holes.length) {
    const diff = difference(best, ...holes.map((h) => [h] as Polygon));
    return diff.sort((a, b) => polyArea(b) - polyArea(a))[0] ?? null;
  }
  return best;
}

export function bufferPoly(p: Polygon, d: number): Polygon {
  if (d === 0) return p;
  if (d < 0) return insetPoly(p, -d) ?? [[]];
  const outer = offsetRing(p[0], d, 2);
  const res = union([outer], p);
  return res.sort((a, b) => polyArea(b) - polyArea(a))[0] ?? p;
}

/** distance from point to polygon boundary (0 if inside) */
export function distToPoly(pt: Vec2, p: Polygon): number {
  if (pointInPoly(pt, p)) return 0;
  let best = Infinity;
  for (const r of p)
    for (let i = 0; i < r.length; i++) {
      const c = closestOnSeg(pt, r[i], r[(i + 1) % r.length]);
      if (c.d < best) best = c.d;
    }
  return best;
}

/** minimum distance between two polygons (0 if they overlap) */
export function polyDistance(a: Polygon, b: Polygon): number {
  let best = Infinity;
  for (const p of a[0]) best = Math.min(best, distToPoly(p, b));
  for (const p of b[0]) best = Math.min(best, distToPoly(p, a));
  return best;
}

/** remove nearly-collinear & duplicate vertices */
export function simplifyRing(r0: Ring, tol = 0.15): Ring {
  const r = openRing(r0);
  if (r.length <= 3) return r;
  const out: Ring = [];
  const n = r.length;
  for (let i = 0; i < n; i++) {
    const a = out.length ? out[out.length - 1] : r[(i - 1 + n) % n];
    const b = r[i];
    const c = r[(i + 1) % n];
    if (dist(a, b) < 0.05) continue;
    const ab = sub(b, a);
    const ac = sub(c, a);
    const l = Math.hypot(ac[0], ac[1]);
    const h = l < 1e-9 ? 0 : Math.abs(cross(ab, ac)) / l;
    if (h < tol && dist(a, c) > 1e-6 && out.length) continue;
    out.push(b);
  }
  return out.length >= 3 ? out : r;
}

export function perimeter(r: Ring): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += dist(r[i], r[(i + 1) % r.length]);
  return s;
}

/** angle of the longest edge (useful for aligning generated geometry) */
export function dominantAngle(r: Ring): number {
  let best = 0,
    ang = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i],
      b = r[(i + 1) % r.length];
    const l = dist(a, b);
    if (l > best) {
      best = l;
      ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  return ang;
}

/** split polygon with an infinite line through p with direction dir; returns [left, right] pieces */
export function splitByLine(poly: Polygon, p: Vec2, dir: Vec2): [Polygon[], Polygon[]] {
  const d = norm(dir);
  const n = perp(d);
  const big = 1e5;
  const halfL: Ring = [add(p, scale(d, -big)), add(p, scale(d, big)), add(add(p, scale(d, big)), scale(n, big)), add(add(p, scale(d, -big)), scale(n, big))];
  const halfR: Ring = [add(p, scale(d, big)), add(p, scale(d, -big)), add(add(p, scale(d, -big)), scale(n, -big)), add(add(p, scale(d, big)), scale(n, -big))];
  return [intersection(poly, [halfL]), intersection(poly, [halfR])];
}

export function isValidPoly(p: Polygon | null | undefined): p is Polygon {
  return !!p && p.length > 0 && p[0].length >= 3 && polyArea(p) > 0.5;
}
