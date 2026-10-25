// Snapping for manual placement (pure, tested in tests/collision.test.ts): a square grid anchored
// at the local origin, 15° rotation steps, the corners of nearby buildings, and street frontage —
// a building near a street turns to face it and its front settles on the right-of-way line or a
// setback line, so hand-placed buildings line up like a real street.

import { kerbOffsets } from "@/geometry/crossSection";
import { closestOnPath } from "@/geometry/polyline";
import type { Polygon, Street, Vec2 } from "../types";

export const FT = 0.3048;
/** grid sizes offered (feet) */
export const GRID_SIZES_FT = [10, 25, 50, 100] as const;
export type GridFt = (typeof GRID_SIZES_FT)[number];
/** setback lines a building front snaps to, measured from the right-of-way line (m: 0, 10, 20 ft) */
export const SETBACKS = [0, 10 * FT, 20 * FT];

/** the nearest grid point (grid anchored at the local origin, axis-aligned) */
export function snapToGrid(p: Vec2, size: number): Vec2 {
  if (!(size > 0)) return p;
  return [Math.round(p[0] / size) * size, Math.round(p[1] / size) * size];
}

/** an angle (degrees) rounded to `step` and normalised to [0, 360) */
export function snapAngle(deg: number, step = 15): number {
  const r = step > 0 ? Math.round(deg / step) * step : deg;
  return ((r % 360) + 360) % 360;
}

/** the closest of `verts` within `tol` m of p, or null */
export function snapToVertex(p: Vec2, verts: Vec2[], tol: number): Vec2 | null {
  let best: Vec2 | null = null;
  let bd = tol;
  for (const v of verts) {
    const d = Math.hypot(v[0] - p[0], v[1] - p[1]);
    if (d <= bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}

/** corners of footprints (outer rings) */
export function cornersOf(polys: Polygon[]): Vec2[] {
  return polys.flatMap((p) => p[0] ?? []);
}

export interface Frontage {
  street: Street;
  /** closest point on the centreline */
  foot: Vec2;
  /** unit direction of the street at the foot */
  along: Vec2;
  /** unit normal from the street towards the point's side */
  normal: Vec2;
  /** distance of the point from the centreline */
  dist: number;
  /** distance from the centreline to the right-of-way line on the point's side */
  rowEdge: number;
}

/** the street whose frontage p is on (within `reach` m of its right-of-way line), or null */
export function nearestFrontage(streets: Street[], p: Vec2, reach = 40): Frontage | null {
  let best: Frontage | null = null;
  for (const s of streets) {
    if (s.tunnel || s.path.length < 2 || s.cls === "motorway" || s.cls === "motorway_link") continue;
    const c = closestOnPath(p, s.path);
    const a = s.path[c.seg],
      b = s.path[Math.min(c.seg + 1, s.path.length - 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const along: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    // beyond the ends of a street there is no frontage
    const t = (p[0] - a[0]) * along[0] + (p[1] - a[1]) * along[1];
    if ((c.seg === 0 && t < -2) || (c.seg === s.path.length - 2 && t > L + 2)) continue;
    const left = along[0] * (p[1] - a[1]) - along[1] * (p[0] - a[0]) >= 0;
    const k = kerbOffsets(s.section, s.section.shift ?? 0);
    const rowEdge = left ? k.rowLeft : -k.rowRight;
    if (c.d - rowEdge > reach) continue;
    const normal: Vec2 = left ? [-along[1], along[0]] : [along[1], -along[0]];
    const f: Frontage = { street: s, foot: c.p, along, normal, dist: c.d, rowEdge };
    if (!best || c.d - rowEdge < best.dist - best.rowEdge) best = f;
  }
  return best;
}

/** the heading (degrees ccw from east) that turns an item's front (local +y) to face the street */
export function facingRotation(f: Frontage): number {
  const t = (Math.atan2(-f.normal[1], -f.normal[0]) * 180) / Math.PI - 90;
  return ((t % 360) + 360) % 360;
}

export interface FrontSnap {
  at: Vec2;
  rotation: number;
  /** the setback the front was snapped to (m from the right-of-way line), or null (orientation only) */
  setback: number | null;
}

/**
 * Face the street from p, and when the front would land within `tol` of the right-of-way line or a
 * setback line, settle it there. `frontDepth` is the distance from the anchor to the front edge
 * along the item's local +y (half the depth for a centred rectangle).
 */
export function frontageSnap(f: Frontage, p: Vec2, frontDepth: number, tol = 2.5, setbacks: number[] = SETBACKS): FrontSnap {
  const rotation = facingRotation(f);
  const dist = (p[0] - f.foot[0]) * f.normal[0] + (p[1] - f.foot[1]) * f.normal[1];
  const frontAt = dist - frontDepth; // where the front edge would be (from the centreline)
  let setback: number | null = null;
  let bd = tol;
  for (const s of setbacks) {
    const d = Math.abs(frontAt - (f.rowEdge + s));
    if (d <= bd) {
      bd = d;
      setback = s;
    }
  }
  // never let the front sit inside the right-of-way
  if (setback === null && frontAt < f.rowEdge) setback = 0;
  if (setback === null) return { at: p, rotation, setback: null };
  const off = f.rowEdge + setback + frontDepth;
  // keep the position along the street; move only across it
  const t = (p[0] - f.foot[0]) * f.along[0] + (p[1] - f.foot[1]) * f.along[1];
  const at: Vec2 = [f.foot[0] + f.along[0] * t + f.normal[0] * off, f.foot[1] + f.along[1] * t + f.normal[1] * off];
  return { at, rotation, setback };
}

/** how far a footprint reaches from `at` along the local +y of `rotation` (its front depth) */
export function frontDepthOf(polys: Polygon[], at: Vec2, rotation: number): number {
  const t = ((rotation + 90) * Math.PI) / 180;
  const u: Vec2 = [Math.cos(t), Math.sin(t)];
  let m = 0;
  for (const p of polys) for (const q of p[0] ?? []) m = Math.max(m, (q[0] - at[0]) * u[0] + (q[1] - at[1]) * u[1]);
  return m;
}
