// Rectangular decomposition of the rectilinear footprint shapes. Pitched roofs, green-roof beds and
// rooftop solar are laid out per part, so an L-plan house gets two crossing gables instead of a
// clipped box. Parts overlap where wings meet (each wing runs its full length), which keeps
// insetting a part by d equal to insetting the whole shape by d.

import type { Polygon, Vec2 } from "@/world/types";
import { obb, polyArea } from "@/geometry/polygon";
import type { FootprintSpec } from "./footprints";

/** an oriented rectangle in the local frame; w along its own x (rot degrees CCW), d along its y */
export interface Part {
  c: Vec2;
  w: number;
  d: number;
  rot: number;
}

const R = (x0: number, y0: number, x1: number, y1: number): Part => ({ c: [(x0 + x1) / 2, (y0 + y1) / 2], w: Math.abs(x1 - x0), d: Math.abs(y1 - y0), rot: 0 });

/** parts of `poly` (built from `spec` by footprintPoly), or one oriented box when the shape is nearly rectangular, or null */
export function footprintParts(spec: FootprintSpec | null, poly: Polygon): Part[] | null {
  if (spec) {
    const ring = poly[0];
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const W = x1 - x0,
      D = y1 - y0;
    // recover wing sizes from the actual polygon so scaling and clamping are respected
    const xs = [...new Set(ring.map((p) => +p[0].toFixed(6)))].sort((a, b) => a - b);
    const ys = [...new Set(ring.map((p) => +p[1].toFixed(6)))].sort((a, b) => a - b);
    const need: Partial<Record<string, [number, number]>> = { l: [3, 3], t: [4, 3], u: [4, 3], h: [4, 4], plus: [4, 4], z: [4, 4] };
    const nn = need[spec.shape];
    if (nn && (xs.length !== nn[0] || ys.length !== nn[1])) return null;
    switch (spec.shape) {
      case "rect":
      case "square":
        return [R(x0, y0, x1, y1)];
      case "l": {
        // vertices: (x0,y0) (x1,y0) (x1,y0+b) (x0+a,y0+b) (x0+a,y1) (x0,y1)
        const a = xs[1] - x0,
          b = ys[1] - y0;
        return [R(x0, y0, x1, y0 + b), R(x0, y0, x0 + a, y1)];
      }
      case "t": {
        const b = y1 - ys[1];
        return [R(x0, y1 - b, x1, y1), R(xs[1], y0, xs[2], y1)];
      }
      case "u": {
        const a = xs[1] - x0,
          b = ys[1] - y0;
        return [R(x0, y0, x1, y0 + b), R(x0, y0, x0 + a, y1), R(x1 - a, y0, x1, y1)];
      }
      case "h": {
        const a = xs[1] - x0;
        return [R(x0, y0, x0 + a, y1), R(x1 - a, y0, x1, y1), R(x0 + a * 0.5, ys[1], x1 - a * 0.5, ys[2])];
      }
      case "o": {
        if (poly.length < 2) return [R(x0, y0, x1, y1)];
        const hole = poly[1];
        let hx0 = Infinity,
          hx1 = -Infinity,
          hy0 = Infinity,
          hy1 = -Infinity;
        for (const [x, y] of hole) {
          hx0 = Math.min(hx0, x);
          hx1 = Math.max(hx1, x);
          hy0 = Math.min(hy0, y);
          hy1 = Math.max(hy1, y);
        }
        return [R(x0, y0, x1, hy0), R(x0, hy1, x1, y1), R(x0, y0, hx0, y1), R(hx1, y0, x1, y1)];
      }
      case "plus":
        return [R(xs[1], y0, xs[2], y1), R(x0, ys[1], x1, ys[2])];
      case "z": {
        // (−a/2,y0) (x1,y0) (x1,y0+b) (a/2,y0+b) (a/2,y1) (x0,y1) (x0,y1−b) (−a/2,y1−b)
        const sx0 = xs[1],
          sx1 = xs[2];
        const b = ys[1] - y0;
        return [R(sx0, y0, x1, y0 + b), R(x0, y1 - b, sx1, y1), R(sx0, y0, sx1, y1)];
      }
      case "stepped": {
        const n = Math.max(2, Math.round(spec.steps ?? 3));
        const sy = D / n,
          sx = W / (n + 1);
        const out: Part[] = [];
        for (let i = 0; i < n; i++) out.push(R(x0, y0 + i * sy, x1 - i * sx, y0 + (i + 1) * sy));
        return out;
      }
      case "chamfered":
      case "rounded":
        return [R(x0, y0, x1, y1)];
      default:
        break;
    }
  }
  if (poly.length !== 1) return null;
  const box = obb(poly[0]);
  if (box.length * box.width <= 0) return null;
  const fill = polyArea(poly) / (box.length * box.width);
  if (fill < 0.9) return null;
  return [{ c: box.center, w: box.length, d: box.width, rot: (box.angle * 180) / Math.PI }];
}

/** apply the same similarity transform the massing applied to the top plate: scale about `about`, inset, twist */
export function transformParts(parts: Part[], about: Vec2, s: number, inset: number, twistDeg: number, off: Vec2 = [0, 0]): Part[] {
  const a = (twistDeg * Math.PI) / 180,
    ca = Math.cos(a),
    sa = Math.sin(a);
  const out: Part[] = [];
  for (const p of parts) {
    const dx = (p.c[0] - about[0]) * s,
      dy = (p.c[1] - about[1]) * s;
    const w = p.w * s - 2 * inset,
      d = p.d * s - 2 * inset;
    if (w < 1 || d < 1) continue;
    out.push({ c: [about[0] + off[0] + dx * ca - dy * sa, about[1] + off[1] + dx * sa + dy * ca], w, d, rot: p.rot + twistDeg });
  }
  return out;
}
