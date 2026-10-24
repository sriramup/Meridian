// Level of detail for the scene, shared with every layer contributor.
//
// Tiers follow screen-space size, the way 3D-tile streamers (Cesium's screen-space error, Google
// Earth) pick detail: what matters is how many pixels a metre covers at a chunk's nearest point.
// With the map's ~37° vertical field of view the focal length is ~1.5 x the viewport height in
// pixels, so at distance d (m) one metre spans 1.5·H/d px.
//
//   NEAR  1 m ≥ ~1.5 px (d ≤ H metres): full detail: facades, lane markings, kerbs, clustered
//         tree crowns. Markings (0.1-0.6 m wide) are under a pixel beyond this and only shimmer.
//   MID   d ≤ 2.5·H: facades still resolve (floor bands fade at ~4 px); simple tree crowns,
//         no markings.
//   FAR   beyond: plain extrusions (the facade pattern would have faded to its average anyway),
//         low-poly trees without trunks.
//
// Chunks outside the view frustum (with a margin, so a chunk is drawn a little before it enters
// the screen) are hidden but keep their GPU buffers.
//
// Other modules (library solids, agent zones…) can follow the same tiers:
//   const v = useLod((s) => s.version);      // re-render when any tier changes
//   lodTierAt(x, y)                          // tier of a local point (m)
//   lodTierOfChunk(key) / useLod.getState().cameraChunk

import { create } from "zustand";

export const NEAR = 0;
export const MID = 1;
export const FAR = 2;
export type Tier = 0 | 1 | 2;

export interface LodCamera {
  /** view centre on the ground (local m) */
  center: [number, number];
  /** eye position (local m, z up) */
  eye: [number, number, number];
  fwd: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  /** tan of half the horizontal / vertical field of view */
  tanX: number;
  tanY: number;
  /** viewport height (CSS px) */
  height: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface LodState {
  /** bumps whenever a chunk changes tier or visibility, or the loader adds layers */
  version: number;
  /** key of the chunk under the view centre */
  cameraChunk: string | null;
  /** the camera's zoom (0.1 steps) */
  zoom: number;
  /** bumps when the loader has built more chunk data (for layers derived from built chunks) */
  loaded: number;
}

export const useLod = create<LodState>(() => ({ version: 0, cameraChunk: null, zoom: 15, loaded: 0 }));

let cam: LodCamera | null = null;
let keyAt: ((x: number, y: number) => string) | null = null;
let boxOf: ((key: string) => { box: readonly number[]; top: number } | undefined) | null = null;

/** the current camera (null before the map is up) */
export const lodCamera = () => cam;

/** wire the chunk grid in (scene.ts owns it; set by the chunk loader) */
export function setLodGrid(k: typeof keyAt, b: typeof boxOf) {
  keyAt = k;
  boxOf = b;
}

/** chunk key at a local point, or null before a city is loaded */
export const chunkKeyAt = (x: number, y: number) => (keyAt ? keyAt(x, y) : null);

const EARTH = 2 * Math.PI * 6378137;

/** the camera of a MapLibre-style view (centre in local m, zoom on 512 px tiles, degrees) */
export function cameraOf(v: { center: [number, number]; lat: number; zoom: number; pitch: number; bearing: number; fov: number; width: number; height: number }): LodCamera {
  const mpp = (EARTH * Math.cos((v.lat * Math.PI) / 180)) / (512 * 2 ** v.zoom);
  const ty = Math.tan((v.fov * Math.PI) / 360);
  const dist = ((0.5 * v.height) / ty) * mpp;
  const p = (v.pitch * Math.PI) / 180,
    b = (v.bearing * Math.PI) / 180;
  const hx = Math.sin(b),
    hy = Math.cos(b);
  const fwd: [number, number, number] = [hx * Math.sin(p), hy * Math.sin(p), -Math.cos(p)];
  const eye: [number, number, number] = [v.center[0] - fwd[0] * dist, v.center[1] - fwd[1] * dist, -fwd[2] * dist];
  const right: [number, number, number] = [Math.cos(b), -Math.sin(b), 0];
  const up: [number, number, number] = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  return { center: v.center, eye, fwd, right, up, tanX: (ty * v.width) / Math.max(1, v.height), tanY: ty, height: v.height, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing };
}

export function setLodCamera(c: LodCamera) {
  cam = c;
}

/** NEAR / MID distance limits (m) for the current viewport */
export function lodThresholds(c: LodCamera | null = cam): { near: number; mid: number } {
  const h = Math.max(500, Math.min(1600, c?.height ?? 900));
  return { near: h, mid: 2.5 * h };
}

/** distance (m) from the eye to the nearest point of a box on the ground rising to `top` */
export function eyeDistance(c: LodCamera, box: readonly number[], top = 0): number {
  const [ex, ey, ez] = c.eye;
  const dx = Math.max(box[0] - ex, 0, ex - box[2]),
    dy = Math.max(box[1] - ey, 0, ey - box[3]),
    dz = Math.max(0 - ez, 0, ez - top);
  return Math.hypot(dx, dy, dz);
}

/** tier at a distance; `prev` adds 10% hysteresis so a chunk on a boundary doesn't flicker */
export function tierAt(d: number, prev?: Tier, c: LodCamera | null = cam): Tier {
  const { near, mid } = lodThresholds(c);
  const k = (t: Tier) => (prev !== undefined && prev <= t ? 1.1 : 1);
  return d <= near * k(NEAR) ? NEAR : d <= mid * k(MID) ? MID : FAR;
}

/** tier of a local point (m) for the current camera; NEAR before the camera is known */
export function lodTierAt(x: number, y: number, z = 0): Tier {
  if (!cam) return NEAR;
  return tierAt(Math.hypot(x - cam.eye[0], y - cam.eye[1], z - cam.eye[2]));
}

/** tier of a chunk by key (the loader's current tier when it has one) */
export function lodTierOfChunk(key: string): Tier {
  const t = chunkTiers.get(key);
  if (t !== undefined) return t;
  const b = boxOf?.(key);
  if (!cam || !b) return NEAR;
  return tierAt(eyeDistance(cam, b.box, b.top));
}

/** tiers the chunk loader settled on, by chunk key (read-only for others) */
export const chunkTiers = new Map<string, Tier>();

/**
 * Whether a box (ground footprint, from z0 to z1) may be on screen. `margin` widens the frustum
 * (1.25 = 25% beyond each screen edge) so chunks appear before they reach the edge of the view.
 */
export function inFrustum(c: LodCamera, box: readonly number[], z0: number, z1: number, margin = 1.25): boolean {
  const tx = c.tanX * margin,
    ty = c.tanY * margin;
  // a plane rejects the box when all 8 corners are outside it
  let behind = 0,
    left = 0,
    rightOut = 0,
    below = 0,
    above = 0;
  for (let i = 0; i < 8; i++) {
    const px = (i & 1 ? box[2] : box[0]) - c.eye[0],
      py = (i & 2 ? box[3] : box[1]) - c.eye[1],
      pz = (i & 4 ? z1 : z0) - c.eye[2];
    const z = px * c.fwd[0] + py * c.fwd[1] + pz * c.fwd[2];
    const x = px * c.right[0] + py * c.right[1] + pz * c.right[2];
    const y = px * c.up[0] + py * c.up[1] + pz * c.up[2];
    if (z < 1) behind++;
    if (x < -z * tx) left++;
    if (x > z * tx) rightOut++;
    if (y < -z * ty) below++;
    if (y > z * ty) above++;
  }
  return behind < 8 && left < 8 && rightOut < 8 && below < 8 && above < 8;
}
