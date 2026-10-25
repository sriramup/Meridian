// Collision rules shared by every placement path (library placement, move / rotate / duplicate,
// re-configuration, the agent's place tools through the ops, drawn footprints): solid things —
// buildings and solid props — never overlap one another unless the caller explicitly asks to
// replace what is there. Pure geometry, so the rules are tested directly (tests/collision.test.ts).

import { overlapArea, polyArea, polyBBox, translatePoly } from "@/geometry/polygon";
import { fmtLen } from "@/lib/units";
import type { Polygon, Vec2 } from "../types";

/**
 * How much two solid footprints may overlap before it counts as a collision (m²): almost nothing.
 * Walls that touch (party walls, a kiosk against a façade) are fine; a small box hidden inside a
 * big one is not (the threshold scales down with the smaller footprint).
 */
export function clashThreshold(a: Polygon, b: Polygon): number {
  const small = Math.min(polyArea(a), polyArea(b));
  return Math.max(0.05, Math.min(0.5, 0.01 * small));
}

type BB = [number, number, number, number];
const bbHit = (a: BB, b: BB, pad = 0) => a[0] <= b[2] + pad && a[2] >= b[0] - pad && a[1] <= b[3] + pad && a[3] >= b[1] - pad;

/** do two solid footprints collide? */
export function clashes(a: Polygon, b: Polygon): boolean {
  if (!bbHit(polyBBox(a), polyBBox(b))) return false;
  return overlapArea(a, b) > clashThreshold(a, b);
}

export interface Obstacle {
  poly: Polygon;
  bb?: BB;
}

/** obstacles with their bounding boxes cached */
export function obstacles(polys: Polygon[]): Obstacle[] {
  return polys.map((poly) => ({ poly, bb: polyBBox(poly) }));
}

/** does any of `pieces` (moved by `d`) collide with an obstacle? */
export function blockedAt(pieces: Polygon[], obs: Obstacle[], d: Vec2 = [0, 0]): boolean {
  for (const p0 of pieces) {
    const p = d[0] || d[1] ? translatePoly(p0, d) : p0;
    const bb = polyBBox(p);
    for (const o of obs) {
      if (!bbHit(bb, o.bb ?? (o.bb = polyBBox(o.poly)))) continue;
      if (overlapArea(p, o.poly) > clashThreshold(p, o.poly)) return true;
    }
  }
  return false;
}

/**
 * The smallest offset that moves `pieces` clear of every obstacle, searched outwards in rings
 * (`dirs` directions, `step` m apart, up to `maxR`) and refined by bisection along the winning
 * direction, so a box pushed against a wall ends flush with it. Null when nothing within maxR is
 * free; [0, 0] when it is already clear.
 */
export function nearestFreeOffset(pieces: Polygon[], obs: Obstacle[], opts: { maxR?: number; step?: number; dirs?: number; gap?: number } = {}): Vec2 | null {
  if (!blockedAt(pieces, obs)) return [0, 0];
  const maxR = opts.maxR ?? 30;
  const step = opts.step ?? 1;
  const n = opts.dirs ?? 16;
  const gap = opts.gap ?? 0.05;
  // nearby obstacles only
  const all = pieces.map((p) => polyBBox(p)).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] as BB);
  const near = obs.filter((o) => bbHit(all, o.bb ?? (o.bb = polyBBox(o.poly)), maxR + 1));
  // axis directions first, so a box beside a box slides square to it
  const dirs: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const t = (k * 2 * Math.PI) / n;
    dirs.push([Math.cos(t), Math.sin(t)]);
  }
  for (let r = step; r <= maxR + 1e-9; r += step) {
    let best: { d: Vec2; r: number } | null = null;
    for (const u of dirs) {
      if (blockedAt(pieces, near, [u[0] * r, u[1] * r])) continue;
      // bisect between the last blocked radius and this free one
      let lo = r - step,
        hi = r;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        if (blockedAt(pieces, near, [u[0] * mid, u[1] * mid])) lo = mid;
        else hi = mid;
      }
      if (!best || hi < best.r) best = { d: u, r: hi };
    }
    if (best) {
      const rr = best.r + gap;
      const d: Vec2 = [best.d[0] * rr, best.d[1] * rr];
      return blockedAt(pieces, near, d) ? [best.d[0] * best.r, best.d[1] * best.r] : d;
    }
  }
  return null;
}

/** "14 ft east" style wording for a hint (compass from local x = east, y = north) */
export function describeOffset(d: Vec2): string {
  const m = Math.hypot(d[0], d[1]);
  const names = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
  const k = Math.round(((Math.atan2(d[1], d[0]) * 180) / Math.PI + 360) / 45) % 8;
  return `${fmtLen(m)} ${names[k]}`;
}
