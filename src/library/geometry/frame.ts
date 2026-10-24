// Placement frames: every generator works in a local frame (x right / east before rotation,
// y forward / north, origin at the anchor) and maps results to world metres at the end. A frame
// comes from the placement: a point + heading, or the oriented bounding box of a drawn site.

import { normalizePoly, obb, polyArea, polyCentroid } from "@/geometry/polygon";
import type { Polygon, Ring, Vec2 } from "@/world/types";
import type { PlacementInput } from "../types";

export interface Frame {
  /** world origin of the local frame */
  c: Vec2;
  /** heading in radians, counter-clockwise from east */
  a: number;
  /** extents of the drawn site along local x / y (0 when placed at a point) */
  siteW: number;
  siteD: number;
  /** the drawn site in world coordinates, when there is one */
  site?: Polygon;
}

export const DEG = Math.PI / 180;

export function frameOf(place: PlacementInput): Frame {
  const site = place.site && place.site.length && place.site[0].length >= 3 ? normalizePoly(place.site) : undefined;
  if (site && polyArea(site) > 0.5) {
    const box = obb(site[0]);
    // keep a requested heading when given, else align with the site's long side
    if (place.rotation !== undefined && Number.isFinite(place.rotation)) {
      const a = place.rotation * DEG;
      const d = Math.abs(Math.sin(a - box.angle));
      const swap = d > Math.SQRT1_2;
      return { c: box.center, a, siteW: swap ? box.width : box.length, siteD: swap ? box.length : box.width, site };
    }
    return { c: box.center, a: box.angle, siteW: box.length, siteD: box.width, site };
  }
  if (place.path && place.path.length >= 2) {
    const p = place.path;
    const c: Vec2 = [(p[0][0] + p[p.length - 1][0]) / 2, (p[0][1] + p[p.length - 1][1]) / 2];
    const a = Math.atan2(p[p.length - 1][1] - p[0][1], p[p.length - 1][0] - p[0][0]);
    return { c, a: place.rotation !== undefined ? place.rotation * DEG : a, siteW: 0, siteD: 0 };
  }
  const at = place.at ?? (site ? polyCentroid(site) : [0, 0]);
  return { c: [at[0], at[1]], a: (place.rotation ?? 0) * DEG, siteW: 0, siteD: 0 };
}

/** local → world */
export function toWorld(f: Frame, p: Vec2): Vec2 {
  const ca = Math.cos(f.a),
    sa = Math.sin(f.a);
  return [f.c[0] + p[0] * ca - p[1] * sa, f.c[1] + p[0] * sa + p[1] * ca];
}

/** world → local */
export function toLocal(f: Frame, p: Vec2): Vec2 {
  const dx = p[0] - f.c[0],
    dy = p[1] - f.c[1];
  const ca = Math.cos(f.a),
    sa = Math.sin(f.a);
  return [dx * ca + dy * sa, -dx * sa + dy * ca];
}

export const ringToWorld = (f: Frame, r: Ring): Ring => r.map((p) => toWorld(f, p));
export const polyToWorld = (f: Frame, p: Polygon): Polygon => normalizePoly(p.map((r) => ringToWorld(f, r)));
export const polyToLocal = (f: Frame, p: Polygon): Polygon => normalizePoly(p.map((r) => r.map((q) => toLocal(f, q))));

/** sub-frame at a local offset and extra heading (for composites placing children) */
export function subFrame(f: Frame, at: Vec2, rotDeg = 0): Frame {
  return { c: toWorld(f, at), a: f.a + rotDeg * DEG, siteW: 0, siteD: 0 };
}

/** heading in degrees of a frame (for Prop.rot) */
export const headingDeg = (f: Frame) => ((f.a / DEG) % 360 + 360) % 360;

/** deterministic pseudo-random numbers (mulberry32) so regeneration is stable */
export function rng(seed: number): () => number {
  let a = (Math.floor(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a stable seed from a string (instance id) */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
