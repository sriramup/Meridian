import type { Ring, Vec2 } from "@/world/types";
import { add, closestOnSeg, dist, lerp, lineIntersect, norm, perp, scale, sub } from "./vec";

export function polyLength(path: Vec2[]): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += dist(path[i - 1], path[i]);
  return s;
}

export function cumulative(path: Vec2[]): number[] {
  const c = [0];
  for (let i = 1; i < path.length; i++) c.push(c[i - 1] + dist(path[i - 1], path[i]));
  return c;
}

export function pointAt(path: Vec2[], d: number): { p: Vec2; dir: Vec2; seg: number } {
  if (path.length === 1) return { p: path[0], dir: [1, 0], seg: 0 };
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const l = dist(path[i - 1], path[i]);
    if (acc + l >= d || i === path.length - 1) {
      const t = l < 1e-9 ? 0 : Math.max(0, Math.min(1, (d - acc) / l));
      return { p: lerp(path[i - 1], path[i], t), dir: norm(sub(path[i], path[i - 1])), seg: i - 1 };
    }
    acc += l;
  }
  return { p: path[path.length - 1], dir: norm(sub(path[path.length - 1], path[path.length - 2])), seg: path.length - 2 };
}

/** sub-path between distances d0 < d1 along the path */
export function slicePath(path: Vec2[], d0: number, d1: number): Vec2[] {
  const L = polyLength(path);
  d0 = Math.max(0, Math.min(L, d0));
  d1 = Math.max(0, Math.min(L, d1));
  if (d1 <= d0 + 1e-6) {
    const a = pointAt(path, d0).p;
    return [a, a];
  }
  const out: Vec2[] = [pointAt(path, d0).p];
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    acc += dist(path[i - 1], path[i]);
    if (acc > d0 + 1e-6 && acc < d1 - 1e-6) out.push(path[i]);
  }
  out.push(pointAt(path, d1).p);
  return out;
}

export function closestOnPath(pt: Vec2, path: Vec2[]): { p: Vec2; d: number; along: number; seg: number } {
  let best = { p: path[0], d: Infinity, along: 0, seg: 0 };
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const c = closestOnSeg(pt, path[i - 1], path[i]);
    const l = dist(path[i - 1], path[i]);
    if (c.d < best.d) best = { p: c.p, d: c.d, along: acc + c.t * l, seg: i - 1 };
    acc += l;
  }
  return best;
}

/**
 * Offset a polyline to the left by d (negative = right) with mitred joins,
 * falling back to bevels at very sharp corners.
 */
export function offsetPath(path: Vec2[], d: number, miterLimit = 4): Vec2[] {
  const n = path.length;
  if (n < 2 || Math.abs(d) < 1e-9) return path.slice();
  const out: Vec2[] = [];
  const normals: Vec2[] = [];
  for (let i = 0; i < n - 1; i++) normals.push(perp(norm(sub(path[i + 1], path[i]))));
  out.push(add(path[0], scale(normals[0], d)));
  for (let i = 1; i < n - 1; i++) {
    const n0 = normals[i - 1];
    const n1 = normals[i];
    const a0 = add(path[i - 1], scale(n0, d));
    const a1 = add(path[i], scale(n0, d));
    const b1 = add(path[i], scale(n1, d));
    const b2 = add(path[i + 1], scale(n1, d));
    const hit = lineIntersect(a0, sub(a1, a0), b1, sub(b2, b1));
    if (!hit || dist(hit.p, path[i]) > Math.abs(d) * miterLimit) out.push(a1, b1);
    else out.push(hit.p);
  }
  out.push(add(path[n - 1], scale(normals[n - 2], d)));
  return out;
}

/** ring covering the band between left offsets dA < dB along the path */
export function bandRing(path: Vec2[], dA: number, dB: number): Ring {
  const a = offsetPath(path, dA);
  const b = offsetPath(path, dB);
  return [...a, ...b.reverse()];
}

export function reversePath(p: Vec2[]): Vec2[] {
  return p.slice().reverse();
}

/** Douglas–Peucker */
export function simplifyPath(path: Vec2[], tol: number): Vec2[] {
  if (path.length <= 2) return path.slice();
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let idx = -1,
      md = 0;
    for (let i = a + 1; i < b; i++) {
      const d = closestOnSeg(path[i], path[a], path[b]).d;
      if (d > md) {
        md = d;
        idx = i;
      }
    }
    if (md > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return path.filter((_, i) => keep[i]);
}

/** Chaikin corner cutting, endpoints fixed */
export function smoothPath(path: Vec2[], iterations = 2): Vec2[] {
  let p = path;
  for (let k = 0; k < iterations; k++) {
    if (p.length < 3) return p;
    const out: Vec2[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      out.push(lerp(p[i], p[i + 1], 0.25), lerp(p[i], p[i + 1], 0.75));
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

export function resamplePath(path: Vec2[], step: number): Vec2[] {
  const L = polyLength(path);
  const n = Math.max(1, Math.round(L / step));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) out.push(pointAt(path, (i / n) * L).p);
  return out;
}

/** heading of path at its start (radians) and end (pointing outward from the end) */
export function endDirections(path: Vec2[]): { start: Vec2; end: Vec2 } {
  const n = path.length;
  // use a short lookahead (up to ~12 m) so tiny kinks near nodes don't dominate
  const look = (from: number, step: number): Vec2 => {
    const o = path[from];
    let i = from + step;
    let q = path[i];
    while (i + step >= 0 && i + step < n && dist(o, q) < 12) {
      i += step;
      q = path[i];
    }
    return norm(sub(q, o));
  };
  return { start: look(0, 1), end: look(n - 1, -1) };
}

export function pathBBox(path: Vec2[]): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of path) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

/**
 * Curvature of a centreline. Radius is measured as the circle through three
 * points `chord` metres apart along the path (a 15 m chord ≈ what a driver
 * experiences), so closely spaced survey vertices don't read as tight curves.
 */
export function curvatureStats(path: Vec2[], chord = 15): { minRadius: number; totalTurn: number; at: Vec2 | null } {
  let total = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const v1 = norm(sub(path[i], path[i - 1])),
      v2 = norm(sub(path[i + 1], path[i]));
    total += Math.acos(Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1])));
  }
  const L = polyLength(path);
  if (L < 2 * chord || path.length < 3) return { minRadius: Infinity, totalTurn: total, at: null };
  const step = chord / 3;
  const q = resamplePath(path, step);
  const k = 3;
  let minR = Infinity,
    at: Vec2 | null = null;
  for (let i = k; i + k < q.length; i++) {
    const r = circumradius(q[i - k], q[i], q[i + k]);
    if (r < minR) {
      minR = r;
      at = q[i];
    }
  }
  return { minRadius: minR, totalTurn: total, at };
}

function circumradius(a: Vec2, b: Vec2, c: Vec2): number {
  const ab = dist(a, b),
    bc = dist(b, c),
    ac = dist(a, c);
  const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return cross < 1e-9 ? Infinity : (ab * bc * ac) / (2 * cross);
}

/** AASHTO minimum curve radius (m) for a design speed, e = 4% superelevation, low-speed urban side friction */
export function minRadiusForSpeed(kmh: number): number {
  const f = kmh <= 40 ? 0.21 : kmh <= 60 ? 0.17 : 0.14;
  return (kmh * kmh) / (127 * (0.04 + f));
}

/**
 * Replace sharp bends with circular arcs of radius R (fillets). Tangent length is
 * limited to half of each adjacent leg, so the achieved radius can be lower than
 * requested where the geometry is tight; it is reported.
 */
export function filletPath(path: Vec2[], R: number, tol = 1.5): { path: Vec2[]; achieved: number } {
  const p = simplifyPath(path, tol);
  if (p.length < 3) return { path: path.slice(), achieved: Infinity };
  const out: Vec2[] = [p[0]];
  let achieved = Infinity;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1],
      b = p[i],
      c = p[i + 1];
    const u = norm(sub(a, b)),
      w = norm(sub(c, b));
    const cosA = Math.max(-1, Math.min(1, u[0] * w[0] + u[1] * w[1]));
    const inner = Math.acos(cosA); // interior angle at the vertex
    const defl = Math.PI - inner;
    if (defl < 0.05) {
      out.push(b);
      continue;
    }
    const tanH = Math.tan(defl / 2);
    let T = R * tanH;
    const Tmax = Math.min(dist(a, b), dist(b, c)) * (i === 1 || i === p.length - 2 ? 0.9 : 0.5);
    if (T > Tmax) T = Tmax;
    const r = T / tanH;
    achieved = Math.min(achieved, r);
    const t1: Vec2 = [b[0] + u[0] * T, b[1] + u[1] * T],
      t2: Vec2 = [b[0] + w[0] * T, b[1] + w[1] * T];
    // arc centre along the angle bisector
    const bis = norm([u[0] + w[0], u[1] + w[1]]);
    const dc = r / Math.sin(inner / 2);
    const o: Vec2 = [b[0] + bis[0] * dc, b[1] + bis[1] * dc];
    const a1 = Math.atan2(t1[1] - o[1], t1[0] - o[0]),
      a2 = Math.atan2(t2[1] - o[1], t2[0] - o[0]);
    let da = a2 - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const n = Math.max(2, Math.ceil(Math.abs(da) / (Math.PI / 24)));
    for (let k = 0; k <= n; k++) {
      const ang = a1 + (da * k) / n;
      out.push([o[0] + Math.cos(ang) * r, o[1] + Math.sin(ang) * r]);
    }
  }
  out.push(p[p.length - 1]);
  return { path: out, achieved };
}
