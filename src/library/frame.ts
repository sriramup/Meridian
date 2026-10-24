// Frames for library geometry. A Prop's solids live in the prop's own frame: before rotation x
// points east and y north, origin at `prop.p` on the ground; the prop's `rot` (degrees,
// counter-clockwise) turns that frame. Building.solids are already in world (local-metre) coordinates.
// A solid's own `rot` yaws it about its vertical axis after it is placed in its owner's frame.

import type { Polygon, Prop, Ring, Solid, Vec2 } from "@/world/types";
import { convexHull } from "@/geometry/polygon";

const RAD = Math.PI / 180;

/** a point in the prop's frame → world */
export function toWorld(p: Vec2, rotDeg: number, local: Vec2): Vec2 {
  const c = Math.cos(rotDeg * RAD),
    s = Math.sin(rotDeg * RAD);
  return [p[0] + local[0] * c - local[1] * s, p[1] + local[0] * s + local[1] * c];
}

/** a world point → the prop's frame */
export function toLocal(p: Vec2, rotDeg: number, world: Vec2): Vec2 {
  const c = Math.cos(rotDeg * RAD),
    s = Math.sin(rotDeg * RAD);
  const dx = world[0] - p[0],
    dy = world[1] - p[1];
  return [dx * c + dy * s, -dx * s + dy * c];
}

/** plan outline of one solid (a rotated rectangle; round shapes use a 12-gon) in its owner's frame */
export function solidOutline(s: Solid): Ring {
  const [cx, cy] = s.at;
  const hx = s.size[0] / 2,
    hy = s.size[1] / 2;
  const yaw = (s.rot ?? 0) * RAD;
  const c = Math.cos(yaw),
    sn = Math.sin(yaw);
  const round = s.shape === "cylinder" || s.shape === "cone" || s.shape === "sphere" || s.shape === "hemisphere" || s.shape === "torus";
  const pts: Vec2[] = round
    ? Array.from({ length: 12 }, (_, k) => [Math.cos((k / 12) * 2 * Math.PI) * hx, Math.sin((k / 12) * 2 * Math.PI) * hy] as Vec2)
    : [
        [-hx, -hy],
        [hx, -hy],
        [hx, hy],
        [-hx, hy],
      ];
  return pts.map(([x, y]) => [cx + x * c - y * sn, cy + x * sn + y * c]);
}

/** world-space plan footprint of a prop: the convex hull of its solids' outlines */
export function propFootprint(p: Vec2, rotDeg: number, solids: Solid[]): Polygon {
  const pts: Vec2[] = [];
  for (const s of solids) for (const q of solidOutline(s)) pts.push(toWorld(p, rotDeg, q));
  if (pts.length < 3) return [[[p[0] - 0.25, p[1] - 0.25], [p[0] + 0.25, p[1] - 0.25], [p[0] + 0.25, p[1] + 0.25], [p[0] - 0.25, p[1] + 0.25]]];
  const hull = convexHull(pts);
  return hull.length >= 3 ? [hull] : [[[p[0] - 0.25, p[1] - 0.25], [p[0] + 0.25, p[1] - 0.25], [p[0] + 0.25, p[1] + 0.25], [p[0] - 0.25, p[1] + 0.25]]];
}

/** overall height of a set of solids (m) */
export function solidsHeight(solids: Solid[]): number {
  return solids.reduce((h, s) => Math.max(h, s.at[2] + s.size[2]), 0);
}

/** world-space outline of each solid of a prop, with its vertical extent (for shadows and land cover) */
export function propSolidsWorld(prop: Pick<Prop, "p" | "rot" | "solids">): { ring: Ring; base: number; top: number; solid: Solid }[] {
  return prop.solids.map((s) => ({ ring: solidOutline(s).map((q) => toWorld(prop.p, prop.rot, q)), base: s.at[2], top: s.at[2] + s.size[2], solid: s }));
}
