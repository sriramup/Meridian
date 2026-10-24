// Solid builders shared by every primitive. Conventions (see Solid in src/world/types.ts):
// a solid fills a box of full extents size=[x,y,z] whose base centre is `at` (z up).
//   box       cuboid
//   cylinder  elliptic cylinder (x, y diameters)
//   cone      elliptic base at z=0, apex at the top
//   sphere    ellipsoid filling the box (centre at z/2)
//   hemisphere upper half-ellipsoid, flat face down
//   wedge     gable prism: ridge along local x at height z, eaves at y = ±y/2
//   pyramid   rectangular base, apex at the top
//   torus     horizontal ring, outer diameters x / y, tube thickness z, resting on the base
// rot = yaw (degrees CCW) about the vertical axis, applied after tilt = [pitch, roll]: right-handed
// rotations about the base centre, pitch about local x (+ lifts the +y edge), roll about local y.

import type { Solid, SolidMaterial, SolidShape, Vec2 } from "@/world/types";
import { DEG, type Frame, toWorld } from "./frame";

export type RGB = [number, number, number];

export function S(shape: SolidShape, at: [number, number, number], size: [number, number, number], color: RGB, material?: SolidMaterial, rot?: number, tilt?: [number, number]): Solid {
  const s: Solid = { shape, at, size: [Math.max(0.01, size[0]), Math.max(0.01, size[1]), Math.max(0.01, size[2])], color };
  if (material) s.material = material;
  if (rot) s.rot = rot;
  if (tilt && (tilt[0] || tilt[1])) s.tilt = tilt;
  return s;
}

export const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: RGB, material?: SolidMaterial, rot?: number) => S("box", [x, y, z], [sx, sy, sz], color, material, rot);
export const cyl = (x: number, y: number, z: number, d: number, h: number, color: RGB, material?: SolidMaterial) => S("cylinder", [x, y, z], [d, d, h], color, material);
export const sphere = (x: number, y: number, z: number, d: number, color: RGB, material?: SolidMaterial, dz = d) => S("sphere", [x, y, z], [d, d, dz], color, material);

/** move solids by a local offset and yaw (degrees) about the local origin */
export function moveSolids(solids: Solid[], dx: number, dy: number, yawDeg = 0, dz = 0): Solid[] {
  const a = yawDeg * DEG,
    ca = Math.cos(a),
    sa = Math.sin(a);
  return solids.map((s) => {
    const [x, y, z] = s.at;
    const out: Solid = { ...s, at: [dx + x * ca - y * sa, dy + x * sa + y * ca, z + dz] };
    const r = (s.rot ?? 0) + yawDeg;
    if (r) out.rot = r;
    else delete out.rot;
    return out;
  });
}

/** uniformly scale solids about the local origin */
export function scaleSolids(solids: Solid[], k: number): Solid[] {
  return solids.map((s) => ({ ...s, at: [s.at[0] * k, s.at[1] * k, s.at[2] * k], size: [s.size[0] * k, s.size[1] * k, s.size[2] * k] }));
}

/** local-frame solids → absolute world solids (Building.solids) */
export function solidsToWorld(f: Frame, solids: Solid[]): Solid[] {
  const yaw = f.a / DEG;
  return solids.map((s) => {
    const p = toWorld(f, [s.at[0], s.at[1]]);
    const out: Solid = { ...s, at: [p[0], p[1], s.at[2]] };
    const r = (s.rot ?? 0) + yaw;
    if (Math.abs(r) > 1e-9) out.rot = r;
    else delete out.rot;
    return out;
  });
}

/** a thin box running from a to b (local xy) at height z: rails, beams, walls, kerbs */
export function beam(a: Vec2, b: Vec2, z: number, w: number, h: number, color: RGB, material?: SolidMaterial): Solid {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const rot = (Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG) || 0;
  return S("box", [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z], [Math.max(0.01, len), w, h], color, material, rot);
}

/** overall height of a solid list */
export const solidsHeight = (solids: Solid[]) => solids.reduce((m, s) => Math.max(m, s.at[2] + s.size[2]), 0);

/** radius of the solids' plan extent about the origin */
export function solidsRadius(solids: Solid[]): number {
  let r = 0;
  for (const s of solids) r = Math.max(r, Math.hypot(s.at[0], s.at[1]) + Math.hypot(s.size[0], s.size[1]) / 2);
  return r;
}

/** plan bounds [x0, y0, x1, y1] of solids in their frame (rotation-conservative) */
export function solidsBounds(solids: Solid[]): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of solids) {
    const h = s.rot ? Math.hypot(s.size[0], s.size[1]) / 2 : 0;
    const hx = s.rot ? h : s.size[0] / 2,
      hy = s.rot ? h : s.size[1] / 2;
    x0 = Math.min(x0, s.at[0] - hx);
    x1 = Math.max(x1, s.at[0] + hx);
    y0 = Math.min(y0, s.at[1] - hy);
    y1 = Math.max(y1, s.at[1] + hy);
  }
  if (!Number.isFinite(x0)) return [-0.5, -0.5, 0.5, 0.5];
  return [x0, y0, x1, y1];
}
