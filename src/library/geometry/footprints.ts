// Parametric footprint shapes in a local frame centred on the origin (x along the width, y along
// the depth). Every shape returns a valid polygon: CCW outer ring, CW holes, no self-intersections.
// Wing widths are clamped so a shape never degenerates; an optional target area rescales the shape
// uniformly (wings included) so floor plates can be specified by area instead of dimensions.

import { normalizePoly, polyArea, polyBBox } from "@/geometry/polygon";
import type { Polygon, Ring, Vec2 } from "@/world/types";

export type FootprintShape =
  | "rect"
  | "square"
  | "l"
  | "t"
  | "u"
  | "h"
  | "o"
  | "plus"
  | "z"
  | "trapezoid"
  | "circle"
  | "ellipse"
  | "ngon"
  | "rounded"
  | "crescent"
  | "stepped"
  | "chamfered"
  | "triangle";

export const FOOTPRINT_SHAPES: { value: FootprintShape; label: string; description: string }[] = [
  { value: "rect", label: "Rectangle", description: "Width × depth box" },
  { value: "square", label: "Square", description: "Width × width" },
  { value: "l", label: "L-shape", description: "Two wings meeting at a corner" },
  { value: "t", label: "T-shape", description: "A bar on a centred stem" },
  { value: "u", label: "U-shape", description: "Three wings around an open court" },
  { value: "h", label: "H-shape", description: "Two parallel wings joined by a crossbar" },
  { value: "o", label: "Courtyard (O)", description: "Perimeter block around a closed courtyard" },
  { value: "plus", label: "Cross / plus", description: "Four arms from a centre" },
  { value: "z", label: "Z / S-shape", description: "Offset bars joined by a stem" },
  { value: "trapezoid", label: "Trapezoid", description: "Tapered plan (top width = taper × width)" },
  { value: "triangle", label: "Triangle", description: "Flatiron-style wedge" },
  { value: "circle", label: "Circle", description: "Round plan, diameter = width" },
  { value: "ellipse", label: "Ellipse", description: "Oval plan, width × depth" },
  { value: "ngon", label: "Regular polygon", description: "Hexagon, octagon… (sides)" },
  { value: "rounded", label: "Rounded rectangle", description: "Rectangle with radiused corners" },
  { value: "chamfered", label: "Chamfered rectangle", description: "Rectangle with cut corners (corner plot)" },
  { value: "crescent", label: "Crescent / arc", description: "Curved bar following an arc" },
  { value: "stepped", label: "Stepped", description: "Staircase plan with stepped facade" },
];

export interface FootprintSpec {
  shape: FootprintShape;
  /** overall extent along x (m) */
  width: number;
  /** overall extent along y (m) */
  depth: number;
  /** wing / bar thickness of the vertical members (L, T stem, U legs, H legs, plus, Z stem, O ring, crescent) */
  wing?: number;
  /** thickness of the horizontal members (L foot, T bar, U base, H crossbar, plus arm, Z bars, O ring along y); defaults to wing */
  wing2?: number;
  /** n-gon sides */
  sides?: number;
  /** corner radius (rounded) or chamfer (chamfered), m */
  corner?: number;
  /** trapezoid: top width as a fraction of the width */
  taper?: number;
  /** trapezoid / triangle: horizontal shift of the top edge as a fraction of the width */
  skew?: number;
  /** crescent: swept angle (degrees) */
  sweep?: number;
  /** stepped: number of steps */
  steps?: number;
  /** if > 0, scale uniformly so the area equals this (m²) */
  targetArea?: number;
  /** curve segments for full circles */
  segments?: number;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const fin = (x: number | undefined, d: number) => (x !== undefined && Number.isFinite(x) ? x : d);

function arcPts(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

/** footprint polygon, local frame, centred on its bounding box */
export function footprintPoly(spec: FootprintSpec): Polygon {
  const W = Math.max(1, fin(spec.width, 20));
  const D0 = Math.max(1, fin(spec.depth, 15));
  const D = spec.shape === "square" || spec.shape === "circle" ? W : D0;
  const segs = Math.round(clamp(fin(spec.segments, 40), 12, 96));
  // wings: at most 45 % of the extent they cut across, at least 1 m
  const a = clamp(fin(spec.wing, Math.min(W, D) * 0.35), 1, W * 0.45);
  const b = clamp(fin(spec.wing2, fin(spec.wing, Math.min(W, D) * 0.35)), 1, D * 0.45);
  const x0 = -W / 2,
    x1 = W / 2,
    y0 = -D / 2,
    y1 = D / 2;
  let poly: Polygon;
  switch (spec.shape) {
    case "rect":
    case "square":
      poly = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
      break;
    case "l": {
      const la = clamp(fin(spec.wing, W * 0.4), 1, W * 0.9);
      const lb = clamp(fin(spec.wing2, fin(spec.wing, D * 0.4)), 1, D * 0.9);
      poly = [[[x0, y0], [x1, y0], [x1, y0 + lb], [x0 + la, y0 + lb], [x0 + la, y1], [x0, y1]]];
      break;
    }
    case "t": {
      const ta = clamp(fin(spec.wing, W * 0.35), 1, W * 0.9);
      const tb = clamp(fin(spec.wing2, fin(spec.wing, D * 0.35)), 1, D * 0.9);
      poly = [[[-ta / 2, y0], [ta / 2, y0], [ta / 2, y1 - tb], [x1, y1 - tb], [x1, y1], [x0, y1], [x0, y1 - tb], [-ta / 2, y1 - tb]]];
      break;
    }
    case "u":
      poly = [[[x0, y0], [x1, y0], [x1, y1], [x1 - a, y1], [x1 - a, y0 + b], [x0 + a, y0 + b], [x0 + a, y1], [x0, y1]]];
      break;
    case "h": {
      const hb = clamp(fin(spec.wing2, fin(spec.wing, D * 0.3)), 1, D * 0.9);
      poly = [[[x0, y0], [x0 + a, y0], [x0 + a, -hb / 2], [x1 - a, -hb / 2], [x1 - a, y0], [x1, y0], [x1, y1], [x1 - a, y1], [x1 - a, hb / 2], [x0 + a, hb / 2], [x0 + a, y1], [x0, y1]]];
      break;
    }
    case "o": {
      const oa = clamp(fin(spec.wing, Math.min(W, D) * 0.3), 1, W * 0.42);
      const ob = clamp(fin(spec.wing2, fin(spec.wing, Math.min(W, D) * 0.3)), 1, D * 0.42);
      poly = [
        [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
        [[x0 + oa, y0 + ob], [x0 + oa, y1 - ob], [x1 - oa, y1 - ob], [x1 - oa, y0 + ob]],
      ];
      break;
    }
    case "plus": {
      const pa = clamp(fin(spec.wing, W / 3), 1, W * 0.9);
      const pb = clamp(fin(spec.wing2, fin(spec.wing, D / 3)), 1, D * 0.9);
      poly = [[[-pa / 2, y0], [pa / 2, y0], [pa / 2, -pb / 2], [x1, -pb / 2], [x1, pb / 2], [pa / 2, pb / 2], [pa / 2, y1], [-pa / 2, y1], [-pa / 2, pb / 2], [x0, pb / 2], [x0, -pb / 2], [-pa / 2, -pb / 2]]];
      break;
    }
    case "z": {
      const za = clamp(fin(spec.wing, W * 0.3), 1, W * 0.9);
      const zb = clamp(fin(spec.wing2, fin(spec.wing, D * 0.3)), 1, D * 0.45);
      poly = [[[-za / 2, y0], [x1, y0], [x1, y0 + zb], [za / 2, y0 + zb], [za / 2, y1], [x0, y1], [x0, y1 - zb], [-za / 2, y1 - zb]]];
      break;
    }
    case "trapezoid": {
      const tw = W * clamp(fin(spec.taper, 0.6), 0.05, 1);
      const sk = W * clamp(fin(spec.skew, 0), -0.5, 0.5);
      poly = [[[x0, y0], [x1, y0], [tw / 2 + sk, y1], [-tw / 2 + sk, y1]]];
      break;
    }
    case "triangle": {
      const sk = W * clamp(fin(spec.skew, 0), -0.5, 0.5);
      poly = [[[x0, y0], [x1, y0], [sk, y1]]];
      break;
    }
    case "circle":
    case "ellipse":
      poly = [arcPts(0, 0, W / 2, D / 2, 0, Math.PI * 2, segs).slice(0, segs)];
      break;
    case "ngon": {
      const n = Math.round(clamp(fin(spec.sides, 6), 3, 24));
      const r: Ring = [];
      // flat bottom edge
      const off = -Math.PI / 2 + Math.PI / n;
      for (let i = 0; i < n; i++) {
        const t = off + (i / n) * Math.PI * 2;
        r.push([Math.cos(t) * (W / 2), Math.sin(t) * (D / 2)]);
      }
      poly = [r];
      break;
    }
    case "rounded":
    case "chamfered": {
      const rr = clamp(fin(spec.corner, Math.min(W, D) * 0.15), 0.1, Math.min(W, D) / 2 - 0.05);
      const n = spec.shape === "rounded" ? 6 : 1;
      const r: Ring = [
        ...arcPts(x1 - rr, y0 + rr, rr, rr, -Math.PI / 2, 0, n),
        ...arcPts(x1 - rr, y1 - rr, rr, rr, 0, Math.PI / 2, n),
        ...arcPts(x0 + rr, y1 - rr, rr, rr, Math.PI / 2, Math.PI, n),
        ...arcPts(x0 + rr, y0 + rr, rr, rr, Math.PI, Math.PI * 1.5, n),
      ];
      poly = [dedupe(r)];
      break;
    }
    case "crescent": {
      const sweep = clamp(fin(spec.sweep, 140), 20, 300) * (Math.PI / 180);
      const R = W / 2;
      const th = clamp(fin(spec.wing, Math.min(W * 0.25, 14)), 1, R * 0.8);
      const n = Math.max(6, Math.round((segs * sweep) / (Math.PI * 2)));
      const a0 = Math.PI / 2 - sweep / 2,
        a1 = Math.PI / 2 + sweep / 2;
      const outer = arcPts(0, 0, R, R * (D / W), a0, a1, n);
      const inner = arcPts(0, 0, R - th, (R - th) * (D / W), a1, a0, n);
      poly = [[...outer, ...inner]];
      break;
    }
    case "stepped": {
      const n = Math.round(clamp(fin(spec.steps, 3), 2, 12));
      const sx = W / (n + 1),
        sy = D / n;
      const r: Ring = [[x0, y0], [x1, y0]];
      for (let i = 0; i < n; i++) {
        const x = x1 - i * sx;
        const y = y0 + (i + 1) * sy;
        r.push([x, y]);
        if (i < n - 1) r.push([x - sx, y]);
      }
      r.push([x0, y1]);
      poly = [r];
      break;
    }
    default:
      poly = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
  }
  poly = normalizePoly(poly);
  // centre on the bounding box (crescents and Z shapes are not symmetric about the origin)
  const [bx0, by0, bx1, by1] = polyBBox(poly);
  const cx = (bx0 + bx1) / 2,
    cy = (by0 + by1) / 2;
  if (Math.abs(cx) > 1e-9 || Math.abs(cy) > 1e-9) poly = poly.map((r) => r.map(([x, y]) => [x - cx, y - cy] as Vec2));
  const target = fin(spec.targetArea, 0);
  if (target > 0) {
    const area = polyArea(poly);
    if (area > 0) {
      const k = Math.sqrt(target / area);
      poly = poly.map((r) => r.map(([x, y]) => [x * k, y * k] as Vec2));
    }
  }
  return poly;
}

function dedupe(r: Ring): Ring {
  const out: Ring = [];
  for (const p of r) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out;
}

/** shapes whose roof can be a pitched form over the oriented box (others get flat / dome fallbacks) */
export const RECTILINEAR: FootprintShape[] = ["rect", "square", "chamfered", "rounded"];
/** shapes that carry wing parameters */
export const WINGED: FootprintShape[] = ["l", "t", "u", "h", "o", "plus", "z", "crescent"];
