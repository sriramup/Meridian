// Reusable site decorations for building types: porches, garages, chimneys, yards, parking lots,
// canopies, playgrounds, sports fields. All take local-frame coordinates around the building.

import type { Polygon, Solid, Vec2 } from "@/world/types";
import type { AreaType } from "@/world/types";
import { type Frame, polyToWorld, subFrame } from "../geometry/frame";
import { C, shade } from "../geometry/palette";
import { S, beam, box, cyl, type RGB } from "../geometry/solids";
import { benchSolids, lampSolids, treeSolids } from "../geometry/props";
import type { BuildingInfo } from "./building";
import type { Out } from "./make";

export const rectL = (cx: number, cy: number, w: number, d: number): Polygon => [[[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]]];

/** an area given in the local frame */
export function areaL(out: Out, f: Frame, type: AreaType, poly: Polygon, o: { name?: string; depth?: number } = {}) {
  return out.area(type, polyToWorld(f, poly), { ...o, primary: false });
}

/** front porch: deck, posts and a shed roof across the front facade */
export function porch(info: BuildingInfo, depth: number, width: number, color: RGB = C.white, roof: RGB = [104, 106, 110]): void {
  const { mid, n, len, rot } = info.front;
  const w = Math.min(width, len);
  const c: Vec2 = [mid[0] + (n[0] * depth) / 2, mid[1] + (n[1] * depth) / 2];
  const h = Math.min(2.8, info.groundH - 0.3);
  const s: Solid[] = [S("box", [c[0], c[1], 0], [w, depth, 0.35], shade(color, 0.92), "wood", rot)];
  const t: Vec2 = [-n[1], n[0]];
  for (const k of [-0.5, 0.5]) {
    const p: Vec2 = [c[0] + t[0] * (w / 2 - 0.15) * Math.sign(k) + (n[0] * (depth / 2 - 0.15)), c[1] + t[1] * (w / 2 - 0.15) * Math.sign(k) + (n[1] * (depth / 2 - 0.15))];
    s.push(box(p[0], p[1], 0.35, 0.16, 0.16, h - 0.35, color, "wood"));
  }
  s.push(S("box", [c[0], c[1], h], [w + 0.3, depth + 0.3, 0.15], roof, "concrete", rot, [-6, 0]));
  info.addSolids(s);
}

export function chimney(info: BuildingInfo, color: RGB = [150, 86, 70]): void {
  const [x0, , x1, y1] = info.bbox;
  const x = x0 + (x1 - x0) * 0.78,
    y = y1 - Math.min(3, (y1 - info.bbox[1]) * 0.3);
  info.addSolids([box(x, y, info.height - 0.5, 0.7, 0.7, 4.2, color, "stone")]);
}

/** attached or detached garage as an extra mass beside the building (+x side) */
export function garage(info: BuildingInfo, kind: "attached" | "detached", cars: number, roof: RGB): void {
  const [, y0, x1] = info.bbox;
  const w = 3.3 * Math.max(1, cars) + 0.4,
    d = 6.6;
  const gap = kind === "detached" ? 3 : 0;
  const cx = x1 + gap + w / 2,
    cy = y0 + d / 2 + (kind === "detached" ? -4 : 0);
  info.addMass(rectL(cx, cy, w, d), 0, 3.0, kind === "attached" ? "wing" : "body");
  info.addSolids([S("wedge", [cx, cy, 3.0], [w + 0.4, d + 0.4, 1.4], roof, "concrete", 90), S("box", [cx, cy + d / 2 + 0.05, 0], [w - 0.8, 0.1, 2.3], [226, 224, 218], "metal")]);
}

/** lot lawn around the building plus an optional driveway (local bbox margins) */
export function yard(out: Out, info: BuildingInfo, front: number, side: number, rear: number, driveway: boolean, extraX = 0): void {
  const [x0, y0, x1, y1] = info.bbox;
  const lot = rectL((x0 + x1 + extraX) / 2, (y0 - rear + y1 + front) / 2, x1 - x0 + extraX + 2 * side, y1 - y0 + front + rear);
  areaL(out, info.frame, "grass", lot);
  if (driveway) {
    const dx = extraX > 0 ? x1 + extraX / 2 : x1 - 2;
    areaL(out, info.frame, "parking", rectL(dx, y1 + front / 2, 3.2, front));
  }
}

/** surface parking: stall-striped lot (2.6 × 5.5 m stalls, 7 m aisles, ULI / ITE standard) */
export function parkingLot(out: Out, f: Frame, cx: number, cy: number, w: number, d: number, o: { lamps?: boolean; trees?: boolean } = {}): number {
  const lot = rectL(cx, cy, w, d);
  areaL(out, f, "parking", lot);
  // bays: rows of 5.5 m stalls back to back with 7 m aisles → 18 m module
  const modules = Math.max(1, Math.floor(d / 18));
  const per = Math.max(1, Math.floor((w - 2) / 2.6));
  const stalls = modules * 2 * per;
  const s: Solid[] = [];
  for (let m = 0; m < modules; m++) {
    const yc = cy - d / 2 + 18 * m + 9;
    // stall lines (white paint) as very thin boxes
    for (let i = 0; i <= per && s.length < 400; i++) {
      const x = cx - (per * 2.6) / 2 + i * 2.6;
      s.push(box(x - cx, yc - 6.25 - cy, 0, 0.1, 5.5, 0.02, C.white, "plastic"), box(x - cx, yc + 6.25 - cy, 0, 0.1, 5.5, 0.02, C.white, "plastic"));
    }
  }
  if (s.length) {
    const p = out.prop("decor.parking_markings", subFrame(f, [cx, cy]), s, { primary: false, height: 0.05 });
    p.cover = "paving";
  }
  if (o.lamps) {
    const n = Math.max(1, Math.round(w / 30));
    for (let i = 0; i < n; i++) out.prop("streetscape.street_lamp", subFrame(f, [cx - w / 2 + (w * (i + 0.5)) / n, cy]), lampSolids("double", 9, 1.6), { primary: false });
  }
  if (o.trees) {
    for (const yy of [cy - d / 2 - 2.5, cy + d / 2 + 2.5]) for (let x = cx - w / 2 + 4; x <= cx + w / 2 - 4; x += 10) out.prop("flora.tree", subFrame(f, [x, yy]), treeSolids({ shape: "round", height: 8, crown: 6, trunkFrac: 0.35, dbh: 0.3, color: C.foliage, trunkColor: C.trunk, clumps: 2, seed: x * 0.13 }), { primary: false, shade: { r: 3, h: 8 } });
  }
  return stalls;
}

/** a flat canopy on columns (gas station, drive-through, transit) as building solids */
export function canopySolids(cx: number, cy: number, w: number, d: number, h: number, color: RGB = C.white, col: RGB = C.steel, cols = 2): Solid[] {
  const s: Solid[] = [box(cx, cy, h, w, d, 0.9, color, "metal"), box(cx, cy, h - 0.05, w - 0.4, d - 0.4, 0.06, C.light, "light")];
  for (let i = 0; i < cols; i++) {
    const x = cx - w / 2 + (w * (i + 0.5)) / cols;
    s.push(box(x, cy, 0, 0.45, 0.45, h, col, "metal"));
  }
  return s;
}

/** benches facing a point (plazas, parks) */
export function benchRing(out: Out, f: Frame, c: Vec2, r: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.prop("streetscape.bench", subFrame(f, [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r], (a * 180) / Math.PI + 90), benchSolids("classic", 1.8), { primary: false });
  }
}

/** a perimeter fence of posts and rails as building-free props along a local rectangle */
export function fenceRect(out: Out, f: Frame, cx: number, cy: number, w: number, d: number, h = 1.2, color: RGB = C.steelDark, gap = 0): void {
  const corners: Vec2[] = [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]];
  for (let i = 0; i < 4; i++) {
    const a = corners[i],
      b = corners[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const rot = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const L = i === 2 && gap > 0 ? (len - gap) / 2 : len;
    const parts = i === 2 && gap > 0 ? [-(gap / 2 + L / 2), gap / 2 + L / 2] : [0];
    for (const off of parts) out.prop("streetscape.fence", subFrame(f, mid, rot), fenceSolids(L, h, color, off), { primary: false });
  }
}

export function fenceSolids(len: number, h: number, color: RGB, off = 0): Solid[] {
  const s: Solid[] = [];
  const n = Math.max(1, Math.round(len / 2.5));
  for (let i = 0; i <= n; i++) s.push(box(off - len / 2 + (len * i) / n, 0, 0, 0.08, 0.08, h, color, "metal"));
  s.push(box(off, 0, h - 0.05, len, 0.05, 0.05, color, "metal"), box(off, 0, 0.15, len, 0.05, 0.05, color, "metal"));
  s.push(box(off, 0, h * 0.55, len, 0.04, 0.04, color, "metal"));
  return s;
}

export { beam, cyl };
