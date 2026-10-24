// Roofs as solids over a top plate (local frame). Pitched forms are laid out over rectangular
// parts (see parts.ts); round plans get cones / domes; anything else falls back to a flat roof
// with a parapet and says so.

import { polyBBox } from "@/geometry/polygon";
import type { Polygon, Solid, SolidMaterial } from "@/world/types";
import type { Part } from "./parts";
import { S, beam, type RGB } from "./solids";
import { shade } from "./palette";

export type RoofType = "flat" | "gable" | "hip" | "shed" | "mansard" | "dome" | "pyramid" | "sawtooth" | "barrel" | "cone" | "gambrel" | "butterfly";

export const ROOF_TYPES: { value: RoofType; label: string; description: string }[] = [
  { value: "flat", label: "Flat", description: "Flat roof with optional parapet" },
  { value: "gable", label: "Gable", description: "Two slopes meeting at a ridge" },
  { value: "hip", label: "Hip", description: "Slopes on all four sides" },
  { value: "pyramid", label: "Pyramid", description: "Four slopes to a point" },
  { value: "shed", label: "Shed / mono-pitch", description: "Single slope" },
  { value: "butterfly", label: "Butterfly", description: "Two slopes falling to a central valley" },
  { value: "mansard", label: "Mansard", description: "Steep lower storey with a low hip above" },
  { value: "gambrel", label: "Gambrel (barn)", description: "Steep lower and shallow upper gable slopes" },
  { value: "dome", label: "Dome", description: "Hemispherical dome" },
  { value: "cone", label: "Cone", description: "Conical roof (towers, round plans)" },
  { value: "barrel", label: "Barrel vault", description: "Half-cylinder along the ridge" },
  { value: "sawtooth", label: "Sawtooth", description: "Industrial north-light roof" },
];

export interface RoofSpec {
  type: RoofType;
  /** slope in degrees (pitched types) */
  pitch: number;
  color: RGB;
  material?: SolidMaterial;
  /** parapet height on flat roofs, m (0 = none) */
  parapet: number;
  parapetColor: RGB;
  /** eave overhang, m */
  overhang: number;
  /** ridge along the long side (default) or across */
  ridge: "long" | "short";
  /** dome / barrel rise as a fraction of the half-span */
  rise: number;
  /** sawtooth teeth count */
  teeth: number;
  /** wall colour (gable-end infill) */
  wall: RGB;
}

export interface RoofResult {
  solids: Solid[];
  /** height of the roof above the plate, m */
  height: number;
  warnings: string[];
}

const D2R = Math.PI / 180;

function ringEdges(poly: Polygon) {
  const out: [number, number][][] = [];
  for (const r of poly) for (let i = 0; i < r.length; i++) out.push([r[i], r[(i + 1) % r.length]]);
  return out;
}

export function parapetSolids(poly: Polygon, z: number, h: number, t: number, color: RGB): Solid[] {
  if (h <= 0) return [];
  const out: Solid[] = [];
  for (const [a, b] of ringEdges(poly)) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    // shift inward by half the thickness (outer ring CCW, holes CW → left normal is inward for both)
    const nx = -(b[1] - a[1]) / len,
      ny = (b[0] - a[0]) / len;
    const o = t / 2;
    out.push(beam([a[0] + nx * o, a[1] + ny * o], [b[0] + nx * o, b[1] + ny * o], z, t, h, color, "concrete"));
  }
  return out;
}

/** one part's pitched roof */
function partRoof(p: Part, z: number, spec: RoofSpec, out: Solid[]): number {
  const longX = p.w >= p.d;
  const alongX = spec.ridge === "long" ? longX : !longX;
  const L = alongX ? p.w : p.d; // ridge length
  const W = alongX ? p.d : p.w; // span
  const rot = p.rot + (alongX ? 0 : 90);
  const ov = Math.max(0, spec.overhang);
  const pitch = Math.max(2, Math.min(75, spec.pitch)) * D2R;
  const rise = (W / 2) * Math.tan(pitch);
  const col = spec.color;
  const mat = spec.material;
  const ca = Math.cos(rot * D2R),
    sa = Math.sin(rot * D2R);
  const at = (u: number, v: number, zz: number): [number, number, number] => [p.c[0] + u * ca - v * sa, p.c[1] + u * sa + v * ca, zz];
  switch (spec.type) {
    case "gable":
      out.push(S("wedge", at(0, 0, z), [L + 2 * ov, W + 2 * ov, rise], col, mat, rot));
      return rise;
    case "gambrel": {
      // steep lower slopes (≈60°) to 30 % in from each eave, shallow upper gable
      const r1 = W * 0.3 * Math.tan(60 * D2R) * 0.55;
      const lower = S("box", at(0, 0, z), [L, W * 0.98, r1], spec.wall, "wood", rot);
      out.push(lower);
      out.push(S("wedge", at(0, 0, z), [L + 2 * ov, W + 2 * ov, r1 * 1.05], col, mat, rot));
      const up = (W * 0.42) * Math.tan(Math.min(pitch, 35 * D2R));
      out.push(S("wedge", at(0, 0, z + r1), [L + 2 * ov, W * 0.84, up], col, mat, rot));
      return r1 + up;
    }
    case "hip": {
      const Wd = W + 2 * ov;
      if (L - W > 0.05) out.push(S("wedge", at(0, 0, z), [L - W, Wd, rise], col, mat, rot));
      const e = Math.max(0, (L - W) / 2);
      out.push(S("pyramid", at(-e, 0, z), [Wd, Wd, rise], col, mat, rot));
      if (e > 0) out.push(S("pyramid", at(e, 0, z), [Wd, Wd, rise], col, mat, rot));
      return rise;
    }
    case "pyramid": {
      const r = (Math.min(p.w, p.d) / 2) * Math.tan(pitch);
      out.push(S("pyramid", at(0, 0, z), [(alongX ? p.w : p.d) + 2 * ov, (alongX ? p.d : p.w) + 2 * ov, r], col, mat, rot));
      return r;
    }
    case "mansard": {
      // steep lower slope reads as a dark band set in slightly; low hip on top
      const h1 = Math.min(4.2, Math.max(2.4, W * 0.18));
      out.push(S("box", at(0, 0, z), [L - 0.6, W - 0.6, h1], col, mat, rot));
      const Wi = W - 2.2;
      const r2 = (Wi / 2) * Math.tan(Math.min(pitch, 25 * D2R));
      if (Wi > 1) {
        if (L - W > 0.05) out.push(S("wedge", at(0, 0, z + h1), [L - W, Wi, r2], shade(col, 0.9), mat, rot));
        const e = Math.max(0, (L - W) / 2);
        out.push(S("pyramid", at(-e, 0, z + h1), [Wi, Wi, r2], shade(col, 0.9), mat, rot));
        if (e > 0) out.push(S("pyramid", at(e, 0, z + h1), [Wi, Wi, r2], shade(col, 0.9), mat, rot));
      }
      return h1 + r2;
    }
    case "shed":
    case "butterfly": {
      // a pitched slab across the span with the triangular void under it filled by a stepped wall
      const sp = spec.type === "shed" ? W : W / 2;
      const r = sp * Math.tan(Math.min(pitch, 35 * D2R));
      const slab = 0.25;
      const panels = spec.type === "shed" ? [{ v: 0, sgn: 1 }] : [{ v: -W / 4, sgn: -1 }, { v: W / 4, sgn: 1 }];
      for (const pn of panels) {
        const ang = Math.atan2(r, sp) / D2R;
        out.push(S("box", at(0, pn.v, z + r / 2 - slab / 2), [L + 2 * ov, Math.hypot(sp, r) + ov, slab], col, mat, rot, [pn.sgn * ang, 0]));
        // infill: 3 steps under the slope
        for (let k = 0; k < 3; k++) {
          const frac = (k + 0.5) / 3;
          const v0 = pn.v + pn.sgn * (sp * (frac - 0.5));
          const h = (r * k) / 3;
          if (h > 0.05) out.push(S("box", at(0, v0, z), [L, sp / 3, h], spec.wall, "concrete", rot));
        }
      }
      return r;
    }
    case "sawtooth": {
      const n = Math.max(1, Math.round(spec.teeth));
      const tw = L / n; // teeth run across the span, repeating along the ridge length
      const r = Math.min(tw * Math.tan(Math.min(pitch, 40 * D2R)), 4);
      const ang = Math.atan2(r, tw) / D2R;
      for (let i = 0; i < n; i++) {
        const u = -L / 2 + tw * (i + 0.5);
        // slope rises toward +u; rotate the slab 90° so its pitch acts along u
        out.push(S("box", at(u, 0, z + r / 2), [W, Math.hypot(tw, r), 0.25], col, mat, rot + 90, [-ang, 0]));
        out.push(S("box", at(u + tw / 2 - 0.15, 0, z), [0.3, W, r], [176, 200, 214], "glass", rot));
        out.push(S("box", at(u - tw / 6, 0, z), [tw / 3, W, r * 0.33], spec.wall, "concrete", rot));
      }
      return r;
    }
    case "barrel": {
      const h = (W / 2) * Math.max(0.15, Math.min(1, spec.rise));
      // a horizontal half-buried cylinder: roll 90° turns its axis along local u
      out.push(S("cylinder", at(-L / 2 - ov, 0, z), [2 * h, W + 2 * ov, L + 2 * ov], col, mat, rot, [0, 90]));
      return h;
    }
    default:
      return 0;
  }
}

export function roofSolids(top: Polygon, z: number, parts: Part[] | null, spec: RoofSpec, roundPlan: boolean): RoofResult {
  const out: Solid[] = [];
  const warnings: string[] = [];
  let h = 0;
  const flat = () => {
    out.push(...parapetSolids(top, z, spec.parapet, 0.3, spec.parapetColor));
    return spec.parapet;
  };
  const [x0, y0, x1, y1] = polyBBox(top);
  const bw = x1 - x0,
    bd = y1 - y0;
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  switch (spec.type) {
    case "flat":
      h = flat();
      break;
    case "dome": {
      const d = Math.min(bw, bd) * (roundPlan ? 1 : 0.9);
      const r = (d / 2) * Math.max(0.2, Math.min(1.5, spec.rise));
      if (!roundPlan) out.push(...parapetSolids(top, z, Math.min(spec.parapet, 1.2), 0.3, spec.parapetColor));
      out.push(S("hemisphere", [cx, cy, z], [roundPlan ? bw : d, roundPlan ? bd : d, r], spec.color, spec.material ?? "metal"));
      h = r;
      break;
    }
    case "cone": {
      const r = (Math.min(bw, bd) / 2) * Math.tan(Math.max(10, Math.min(75, spec.pitch)) * D2R);
      out.push(S("cone", [cx, cy, z], [bw + 2 * spec.overhang, bd + 2 * spec.overhang, r], spec.color, spec.material));
      h = r;
      break;
    }
    default: {
      if (roundPlan && (spec.type === "pyramid" || spec.type === "hip" || spec.type === "gable" || spec.type === "mansard")) {
        const r = (Math.min(bw, bd) / 2) * Math.tan(Math.max(10, Math.min(75, spec.pitch)) * D2R);
        out.push(S("cone", [cx, cy, z], [bw + 2 * spec.overhang, bd + 2 * spec.overhang, r], spec.color, spec.material));
        h = r;
        break;
      }
      if (!parts || !parts.length) {
        warnings.push(`${spec.type} roof needs a rectangular plan; used a flat roof with a parapet`);
        h = flat();
        break;
      }
      for (const p of parts) h = Math.max(h, partRoof(p, z, spec, out));
    }
  }
  return { solids: out, height: h, warnings };
}
