// Street View geometry: where a person standing in the model can go. Pure functions over a small
// read-only view of the world (WalkEnv) so they can be tested without a map or a runtime.
//
// Walkable ground is everything that is not inside (or brushing) a building footprint or open
// water: sidewalks, plazas, paths, parks and the carriageway. Moves are short hops along a
// straight line of sight; a click far away moves along the current street toward it.

import { closestOnPath, pointAt, polyLength } from "@/geometry/polyline";
import { pointInPoly } from "@/geometry/polygon";
import { stripOffsets } from "@/geometry/crossSection";
import { closestOnSeg, dist, dot, norm, segIntersect, sub } from "@/geometry/vec";
import type { CrossSection, Polygon, Vec2 } from "@/world/types";

export type BBox = [number, number, number, number];

export interface WalkStreet {
  id: string;
  path: Vec2[];
  section: CrossSection;
  from: string;
  to: string;
}

export interface WalkEnv {
  /** building footprints near the box, with their heights (m) */
  buildings(b: BBox): { poly: Polygon; height: number }[];
  /** open water near the box */
  water(b: BBox): Polygon[];
  /** streets a person can walk along near the box */
  streets(b: BBox): WalkStreet[];
  /** streets meeting at a junction */
  incident(node: string): WalkStreet[];
}

/** eye height above the ground (m) */
export const EYE = 1.7;
/** how close the eye may come to a wall (m) */
export const CLEAR = 1.1;
/** longest single click-to-move hop (m) */
export const MAX_HOP = 30;
/** a chevron click moves this far along the street (m) */
export const STEP = 14;
/** longest double-click jump (m) */
export const MAX_JUMP = 600;

const box = (p: Vec2, r: number): BBox => [p[0] - r, p[1] - r, p[0] + r, p[1] + r];
const segBox = (a: Vec2, b: Vec2, pad: number): BBox => [Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad];
const add = (a: Vec2, b: Vec2, s = 1): Vec2 => [a[0] + b[0] * s, a[1] + b[1] * s];
const left = (d: Vec2): Vec2 => [-d[1], d[0]];

/** nearest point on any ring of the polygon */
function nearestOnPoly(p: Vec2, poly: Polygon): { q: Vec2; d: number } {
  let best = { q: p, d: Infinity };
  for (const r of poly)
    for (let i = 0; i < r.length; i++) {
      const c = closestOnSeg(p, r[i], r[(i + 1) % r.length]);
      if (c.d < best.d) best = { q: c.p, d: c.d };
    }
  return best;
}

export type Block = { kind: "building" | "water"; poly: Polygon };

/** what stops a person standing at p: inside or within `clear` of a building, or in water */
export function blockedAt(env: WalkEnv, p: Vec2, clear = CLEAR): Block | null {
  for (const { poly } of env.buildings(box(p, clear + 1))) if (pointInPoly(p, poly) || nearestOnPoly(p, poly).d < clear - 1e-6) return { kind: "building", poly };
  for (const poly of env.water(box(p, 1))) if (pointInPoly(p, poly)) return { kind: "water", poly };
  return null;
}

/**
 * The nearest place to stand: pushed out of buildings (to `clear` from the wall) and out of water.
 * Returns null only when nothing walkable lies within 40 m.
 */
export function snapWalkable(env: WalkEnv, p: Vec2, clear = CLEAR): Vec2 | null {
  let q: Vec2 = [p[0], p[1]];
  for (let i = 0; i < 6; i++) {
    const b = blockedAt(env, q, clear);
    if (!b) return q;
    const n = nearestOnPoly(q, b.poly);
    const inside = pointInPoly(q, b.poly);
    const want = b.kind === "building" ? clear + 0.05 : 0.6;
    // step out across the nearest edge (or straight away from it when just outside)
    let d = inside ? sub(n.q, q) : sub(q, n.q);
    if (Math.hypot(d[0], d[1]) < 1e-6) d = [1, 0];
    q = add(n.q, norm(d), want);
  }
  if (!blockedAt(env, q, clear)) return q;
  // tight spot (a courtyard, between two walls): search outward in rings
  for (let r = 1; r <= 40; r += 1)
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const c: Vec2 = [p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r];
      if (!blockedAt(env, c, clear)) return c;
    }
  return null;
}

/** first wall the straight line a→b runs into (its point, how far along, and the wall's outward normal) */
export function firstWall(env: WalkEnv, a: Vec2, b: Vec2): { p: Vec2; t: number; normal: Vec2 } | null {
  const L = dist(a, b);
  if (L < 1e-6) return null;
  let best: { p: Vec2; t: number; normal: Vec2 } | null = null;
  for (const { poly } of env.buildings(segBox(a, b, 1)))
    for (const r of poly)
      for (let i = 0; i < r.length; i++) {
        const u = r[i],
          v = r[(i + 1) % r.length];
        const x = segIntersect(a, b, u, v);
        if (!x) continue;
        const t = dist(a, x) / L;
        if (best && t >= best.t) continue;
        // outward normal: the side of the wall facing the start of the line
        let nrm = norm(left(sub(v, u)));
        if (dot(nrm, sub(a, x)) < 0) nrm = [-nrm[0], -nrm[1]];
        best = { p: x, t, normal: nrm };
      }
  return best;
}

/** true when nothing (a wall or water) stands between a and b */
export function lineClear(env: WalkEnv, a: Vec2, b: Vec2): boolean {
  if (firstWall(env, a, b)) return false;
  const L = dist(a, b);
  for (const poly of env.water(segBox(a, b, 1)))
    for (let s = 0; s <= L; s += 2) {
      const t = L ? s / L : 0;
      if (pointInPoly([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], poly)) return false;
    }
  return true;
}

/** the street a person at p stands on or beside: where along it, how far to its left, its direction */
export interface StreetFrame {
  street: WalkStreet;
  along: number;
  /** signed lateral offset, positive to the left of from→to */
  offset: number;
  /** unit direction from→to at that point */
  tangent: Vec2;
  length: number;
  /** distance from the centreline */
  d: number;
}

export function streetFrame(env: WalkEnv, p: Vec2, radius = 30, dir?: Vec2): StreetFrame | null {
  let best: StreetFrame | null = null;
  let bestScore = Infinity;
  for (const s of env.streets(box(p, radius))) {
    if (s.path.length < 2) continue;
    const c = closestOnPath(p, s.path);
    if (c.d > radius) continue;
    const a = s.path[c.seg],
      b = s.path[c.seg + 1] ?? a;
    const tangent = norm(sub(b, a));
    // with a direction in mind (a chevron, a far click), prefer the street that runs that way
    const score = c.d + (dir ? (1 - Math.abs(dot(dir, tangent))) * 40 : 0);
    if (score >= bestScore) continue;
    bestScore = score;
    best = { street: s, along: c.along, offset: dot(sub(p, c.p), left(tangent)), tangent, length: polyLength(s.path), d: c.d };
  }
  return best;
}

/** the next street beyond `node` that continues most nearly in direction `dir` */
function continuation(env: WalkEnv, node: string, from: WalkStreet, dir: Vec2): { street: WalkStreet; forward: boolean } | null {
  let best: { street: WalkStreet; forward: boolean; score: number } | null = null;
  for (const s of env.incident(node)) {
    if (s.id === from.id || s.path.length < 2) continue;
    const forward = s.from === node;
    const out = forward ? norm(sub(s.path[1], s.path[0])) : norm(sub(s.path[s.path.length - 2], s.path[s.path.length - 1]));
    const score = dot(out, dir);
    if (score > 0.5 && (!best || score > best.score)) best = { street: s, forward, score };
  }
  return best;
}

/**
 * Walk `step` metres along the street from p, in whichever of its two directions lies closer to
 * `dir`, keeping the same side of the street (sidewalk stays sidewalk). At the street's end the walk
 * carries on into the street that continues straightest. Null when p is not on a street.
 */
export function alongStreet(env: WalkEnv, p: Vec2, dir: Vec2, step: number): Vec2 | null {
  const f = streetFrame(env, p, 30, dir);
  if (!f) return null;
  let street = f.street;
  let forward = dot(dir, f.tangent) >= 0;
  // offset to the left of the direction of travel
  let side = forward ? f.offset : -f.offset;
  let at = f.along;
  let left_ = step;
  for (let hops = 0; hops < 4; hops++) {
    const L = polyLength(street.path);
    const room = forward ? L - at : at;
    if (left_ <= room) {
      const s = pointAt(street.path, forward ? at + left_ : at - left_);
      const travel: Vec2 = forward ? s.dir : [-s.dir[0], -s.dir[1]];
      return add(s.p, left(travel), side);
    }
    left_ -= room;
    const end = forward ? street.to : street.from;
    const endDir = pointAt(street.path, forward ? L : 0).dir;
    const travel: Vec2 = forward ? endDir : [-endDir[0], -endDir[1]];
    const next = continuation(env, end, street, travel);
    if (!next) {
      // a dead end: stop at the end of the street
      const s = pointAt(street.path, forward ? L : 0);
      return add(s.p, left(travel), side);
    }
    street = next.street;
    forward = next.forward;
    at = forward ? 0 : polyLength(street.path);
    side = Math.sign(side) * Math.min(Math.abs(side), sectionHalf(street.section));
  }
  return null;
}

const sectionHalf = (s: CrossSection) => s.strips.reduce((a, t) => a + t.width, 0) / 2;

/** unit vectors pointing along the streets a person at p can follow (both ways, plus side streets at a junction) */
export function chevronDirs(env: WalkEnv, p: Vec2): Vec2[] {
  const f = streetFrame(env, p, 25);
  if (!f) return [];
  const dirs: Vec2[] = [f.tangent, [-f.tangent[0], -f.tangent[1]]];
  // near a junction: the other streets leaving it
  const JUNCTION = 18;
  for (const [node, atEnd] of [
    [f.street.from, f.along],
    [f.street.to, f.length - f.along],
  ] as const) {
    if (atEnd > JUNCTION) continue;
    for (const s of env.incident(node)) {
      if (s.id === f.street.id || s.path.length < 2) continue;
      const out = s.from === node ? norm(sub(s.path[1], s.path[0])) : norm(sub(s.path[s.path.length - 2], s.path[s.path.length - 1]));
      dirs.push(out);
    }
  }
  // merge near-duplicates (a straight continuation across the junction)
  const out: Vec2[] = [];
  for (const d of dirs) if (!out.some((o) => dot(o, d) > Math.cos((25 * Math.PI) / 180))) out.push(d);
  return out;
}

export type Hop = { target: Vec2; via: "direct" | "street" | "partial" };

/**
 * Where one click moves to. `ground` is the point on the ground under the pointer, as seen from
 * `eye`. A wall in the way stops the line of sight there (a click on a facade walks up to the
 * facade). Near points are reached directly; far ones a bounded hop along the street toward them.
 */
export function hopTarget(env: WalkEnv, eye: Vec2, ground: Vec2, maxHop = MAX_HOP): Hop | null {
  const wall = firstWall(env, eye, ground);
  const aim = wall ? wall.p : ground;
  const D = dist(eye, aim);
  if (D < 0.5) return null;
  const dir = norm(sub(aim, eye));
  if (D <= maxHop) {
    const t = snapWalkable(env, aim);
    if (t && dist(t, eye) > 0.5 && lineClear(env, eye, t)) return { target: t, via: "direct" };
  }
  // far away: follow the street when the click lies roughly along it
  const f = streetFrame(env, eye, 30, dir);
  if (f && Math.abs(dot(dir, f.tangent)) > 0.6) {
    const run = Math.min(maxHop, Math.abs(dot(sub(aim, eye), f.tangent)));
    const s = run > 1 ? alongStreet(env, eye, dir, run) : null;
    const t = s && snapWalkable(env, s);
    if (t && dist(t, eye) > 0.5 && lineClear(env, eye, t)) return { target: t, via: "street" };
  }
  // otherwise as far as the line of sight allows, up to one hop
  const reach = Math.min(maxHop, D);
  let last: Vec2 | null = null;
  for (let s = 1; s <= reach; s += 1) {
    const c = add(eye, dir, s);
    if (blockedAt(env, c) || !lineClear(env, eye, c)) break;
    last = c;
  }
  return last && dist(last, eye) > 0.5 ? { target: last, via: "partial" } : null;
}

/** a double-click goes straight to the spot (up to the first wall in the way), however far */
export function jumpTarget(env: WalkEnv, eye: Vec2, ground: Vec2): Vec2 | null {
  const wall = firstWall(env, eye, ground);
  let aim = wall ? wall.p : ground;
  const D = dist(eye, aim);
  if (D > MAX_JUMP) aim = add(eye, norm(sub(aim, eye)), MAX_JUMP);
  const t = snapWalkable(env, aim);
  return t && dist(t, eye) > 0.5 ? t : null;
}

/** the closest sidewalk (or plaza) spot to p, for stepping down into the street; falls back to any walkable spot */
export function nearestSidewalk(env: WalkEnv, p: Vec2, radius = 60): Vec2 | null {
  let best: { q: Vec2; d: number } | null = null;
  for (const s of env.streets(box(p, radius))) {
    if (s.path.length < 2) continue;
    const c = closestOnPath(p, s.path);
    if (c.d > radius) continue;
    // keep out of the junctions at either end (a cross street's sidewalk doesn't run through them)
    const L = polyLength(s.path);
    const half = sectionHalf(s.section) + 1;
    let along = c.along;
    if (env.incident(s.from).length > 1) along = Math.max(along, Math.min(L / 2, half));
    if (env.incident(s.to).length > 1) along = Math.min(along, Math.max(L / 2, L - half));
    const at = pointAt(s.path, along);
    for (const o of stripOffsets(s.section, s.section.shift ?? 0)) {
      if (o.strip.type !== "sidewalk" && o.strip.type !== "plaza") continue;
      const q = add(at.p, left(at.dir), (o.left + o.right) / 2);
      const d = dist(q, p);
      if (!best || d < best.d) best = { q, d };
    }
  }
  return snapWalkable(env, best ? best.q : p);
}

// ── looking: the eye's view and the ground under a pixel ──

export interface EyeView {
  eye: Vec2;
  /** compass bearing of the view, degrees clockwise from north */
  bearing: number;
  /** MapLibre pitch: 0 looks straight down, 90 at the horizon */
  pitch: number;
  /** vertical field of view, degrees */
  fov: number;
  width: number;
  height: number;
  h?: number;
}

/**
 * The ray through pixel (x, y) and where it meets the ground (null above the horizon). Matches
 * MapLibre's perspective camera (centre of projection at the middle of the canvas).
 */
export function groundAt(v: EyeView, x: number, y: number): { p: Vec2; dist: number; ray: [number, number, number] } | null {
  const h = v.h ?? EYE;
  const ray = rayAt(v, x, y);
  if (ray[2] >= -1e-9) return null;
  const t = h / -ray[2];
  const p: Vec2 = [v.eye[0] + ray[0] * t, v.eye[1] + ray[1] * t];
  return { p, dist: dist(p, v.eye), ray };
}

/** the (unnormalised) direction of the line of sight through pixel (x, y): [east, north, up] */
export function rayAt(v: EyeView, x: number, y: number): [number, number, number] {
  const b = (v.bearing * Math.PI) / 180,
    pt = (v.pitch * Math.PI) / 180;
  const f = v.height / 2 / Math.tan((v.fov * Math.PI) / 360);
  const fwdH: Vec2 = [Math.sin(b), Math.cos(b)];
  const right: Vec2 = [Math.cos(b), -Math.sin(b)];
  const dx = x - v.width / 2,
    dy = v.height / 2 - y;
  // camera basis: forward (looking down by 90° − pitch), up, right
  const F: [number, number, number] = [fwdH[0] * Math.sin(pt), fwdH[1] * Math.sin(pt), -Math.cos(pt)];
  const U: [number, number, number] = [fwdH[0] * Math.cos(pt), fwdH[1] * Math.cos(pt), Math.sin(pt)];
  return [F[0] * f + right[0] * dx + U[0] * dy, F[1] * f + right[1] * dx + U[1] * dy, F[2] * f + U[2] * dy];
}

/** height (m) at which the line of sight to `ground` meets a wall `t` of the way there */
export const wallHeight = (t: number, h = EYE) => h * (1 - t);

export type Sight = { kind: "ground"; p: Vec2; dist: number } | { kind: "wall"; p: Vec2; dist: number; normal: Vec2; z: number };

/**
 * What the pointer at pixel (x, y) rests on: the ground, or a wall (also above the horizon, as long
 * as the line of sight meets the wall below the building's top). Null for open sky.
 */
export function sightAt(env: WalkEnv, v: EyeView, x: number, y: number, far = 900): Sight | null {
  const h = v.h ?? EYE;
  const g = groundAt(v, x, y);
  // the ray's direction, also for pixels above the horizon
  const ray = g?.ray ?? rayAt(v, x, y);
  const rh = Math.hypot(ray[0], ray[1]);
  if (rh < 1e-9) return null;
  const hd: Vec2 = [ray[0] / rh, ray[1] / rh];
  const slope = ray[2] / rh; // rise per metre along the ground
  const reach = g ? Math.min(g.dist, far) : far;
  const end = add(v.eye, hd, reach);
  const hits: { p: Vec2; s: number; normal: Vec2; top: number }[] = [];
  for (const { poly, height } of env.buildings(segBox(v.eye, end, 1)))
    for (const r of poly)
      for (let i = 0; i < r.length; i++) {
        const a = r[i],
          b = r[(i + 1) % r.length];
        const xp = segIntersect(v.eye, end, a, b);
        if (!xp) continue;
        let nrm = norm(left(sub(b, a)));
        if (dot(nrm, hd) > 0) nrm = [-nrm[0], -nrm[1]];
        hits.push({ p: xp, s: dist(v.eye, xp), normal: nrm, top: height });
      }
  hits.sort((a, b) => a.s - b.s);
  for (const w of hits) {
    const z = h + slope * w.s;
    if (z >= 0 && z <= w.top) return { kind: "wall", p: w.p, dist: w.s, normal: w.normal, z };
  }
  return g && g.dist <= far ? { kind: "ground", p: g.p, dist: g.dist } : null;
}

// ── chevrons: arrows on the ground pointing along the street ──

export interface Chevron {
  dir: Vec2;
  /** where it sits on the ground */
  at: Vec2;
  /** arrow outline on the ground */
  ring: Vec2[];
}

/**
 * Arrows on a small ring just ahead of the eye (as in Street View): every direction stays in view,
 * and each sits on the side it leads to.
 */
export function chevronLayout(eye: Vec2, bearing: number, dirs: Vec2[], ahead = 5.6, radius = 1.25, size = 0.55): Chevron[] {
  const b = (bearing * Math.PI) / 180;
  const c: Vec2 = [eye[0] + Math.sin(b) * ahead, eye[1] + Math.cos(b) * ahead];
  return dirs.map((dir) => {
    const at = add(c, dir, radius);
    const l = left(dir);
    // a chevron: two arms meeting at the tip
    const tip = add(at, dir, size * 0.55);
    const back = add(at, dir, -size * 0.45);
    const notch = add(at, dir, -size * 0.05);
    const ring: Vec2[] = [tip, add(back, l, -size * 0.6), notch, add(back, l, size * 0.6)];
    return { dir, at, ring };
  });
}

/** the chevron under a ground point, if any */
export function chevronAt(chevrons: Chevron[], p: Vec2, reach = 0.85): Chevron | null {
  let best: Chevron | null = null;
  let bd = reach;
  for (const c of chevrons) {
    const d = dist(c.at, p);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}
