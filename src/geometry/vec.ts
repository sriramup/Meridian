import type { Vec2 } from "@/world/types";

export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
export const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const dist2 = (a: Vec2, b: Vec2) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const norm = (a: Vec2): Vec2 => {
  const l = Math.hypot(a[0], a[1]);
  return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l];
};
/** left-hand perpendicular (rotate +90°) */
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
export const rot = (a: Vec2, ang: number): Vec2 => {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
};
export const rotAround = (p: Vec2, c: Vec2, ang: number): Vec2 => add(c, rot(sub(p, c), ang));
export const angle = (a: Vec2) => Math.atan2(a[1], a[0]);
export const eq = (a: Vec2, b: Vec2, eps = 1e-6) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
export const round = (a: Vec2, q = 100): Vec2 => [Math.round(a[0] * q) / q, Math.round(a[1] * q) / q];

/** Intersection of infinite lines p + t*r and q + u*s. Returns t, u or null if parallel. */
export function lineIntersect(p: Vec2, r: Vec2, q: Vec2, s: Vec2): { t: number; u: number; p: Vec2 } | null {
  const rxs = cross(r, s);
  if (Math.abs(rxs) < 1e-9) return null;
  const qp = sub(q, p);
  const t = cross(qp, s) / rxs;
  const u = cross(qp, r) / rxs;
  return { t, u, p: add(p, scale(r, t)) };
}

export function segIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const hit = lineIntersect(a, sub(b, a), c, sub(d, c));
  if (!hit) return null;
  if (hit.t < -1e-9 || hit.t > 1 + 1e-9 || hit.u < -1e-9 || hit.u > 1 + 1e-9) return null;
  return hit.p;
}

/** closest point on segment ab to p, with parameter t in [0,1] */
export function closestOnSeg(p: Vec2, a: Vec2, b: Vec2): { p: Vec2; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  let t = l2 < 1e-12 ? 0 : dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = add(a, scale(ab, t));
  return { p: q, t, d: dist(p, q) };
}

/** normalise angle to (-PI, PI] */
export function wrapAngle(a: number) {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

export function bboxOf(pts: Vec2[]): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

export function bboxOverlap(a: [number, number, number, number], b: [number, number, number, number], pad = 0) {
  return !(a[2] + pad < b[0] || b[2] + pad < a[0] || a[3] + pad < b[1] || b[3] + pad < a[1]);
}
