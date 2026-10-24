// Vertical composition for library buildings: floors × ground / typical floor heights, an optional
// podium with a tower plate, per-floor setbacks (terraces), tapering and twisting. Works in the
// local frame; heights follow ground + (floors − 1) × typical, so with the default floor heights
// the result matches heightForFloors in src/geometry/massing.ts.

import { floorHeights } from "@/geometry/massing";
import { insetPoly, isValidPoly, polyArea, polyCentroid } from "@/geometry/polygon";
import type { Mass, MassRole, Polygon, Use, Vec2 } from "@/world/types";

export interface StackSpec {
  floors: number;
  use: Use;
  /** ground-floor height, m (0 / undefined = by use) */
  groundH?: number;
  /** typical floor height, m (0 / undefined = by use) */
  typH?: number;
  /** podium floors (0 = no podium) */
  podiumFloors?: number;
  /** tower plate area as a fraction of the podium plate (0.1–1) */
  towerScale?: number;
  /** tower plate offset from the podium centre (local m) */
  towerOffset?: Vec2;
  /** step the plate in every N floors (0 = never), counted from the ground */
  setbackEvery?: number;
  /** inset per step, m */
  setbackDepth?: number;
  /** linear scale of the top plate relative to the base of the tower (1 = straight) */
  taper?: number;
  /** total twist from the base of the tower to the top, degrees */
  twist?: number;
  /** floors lifted on pilotis (ground floor open; the mass starts above them) */
  pilotisFloors?: number;
}

export interface StackResult {
  masses: Mass[];
  height: number;
  floors: number;
  /** the top plate (where the roof goes) */
  top: Polygon;
  /** transform from the base footprint to the top plate: scale about `about`, inset and twist */
  topXf: { about: Vec2; off: Vec2; s: number; inset: number; twist: number };
  groundH: number;
  typH: number;
  notes: string[];
}

export function floorHeightsFor(use: Use, groundH?: number, typH?: number) {
  const d = floorHeights(use === "mixed" ? "residential" : use);
  return { ground: groundH && groundH > 0 ? groundH : d.ground, typ: typH && typH > 0 ? typH : d.typ };
}

/** elevation of the top of floor f (f floors above ground) */
export const levelZ = (f: number, ground: number, typ: number) => (f <= 0 ? 0 : ground + (f - 1) * typ);

function xform(poly: Polygon, about: Vec2, s: number, twistDeg: number, off: Vec2): Polygon {
  const a = (twistDeg * Math.PI) / 180,
    ca = Math.cos(a),
    sa = Math.sin(a);
  return poly.map((r) =>
    r.map(([x, y]) => {
      const dx = (x - about[0]) * s,
        dy = (y - about[1]) * s;
      return [about[0] + off[0] + dx * ca - dy * sa, about[1] + off[1] + dx * sa + dy * ca] as Vec2;
    }),
  );
}

export function stackMasses(base: Polygon, spec: StackSpec): StackResult {
  const notes: string[] = [];
  const F = Math.max(1, Math.round(spec.floors));
  const { ground, typ } = floorHeightsFor(spec.use, spec.groundH, spec.typH);
  const Z = (f: number) => levelZ(f, ground, typ);
  const masses: Mass[] = [];
  const about = polyCentroid(base);
  const lift = Math.max(0, Math.min(F - 1, Math.round(spec.pilotisFloors ?? 0)));
  const pf = Math.max(0, Math.min(F - 1, Math.round(spec.podiumFloors ?? 0)));
  const use = spec.use;
  const M = (poly: Polygon, b: number, t: number, role: MassRole): Mass => ({ poly, base: b, top: t, role, use });

  let towerBase = base;
  let s0 = 1;
  const off: Vec2 = spec.towerOffset ?? [0, 0];
  let start = lift;
  if (pf > lift) {
    masses.push(M(base, Z(lift), Z(pf), "podium"));
    const ts = Math.max(0.05, Math.min(1, spec.towerScale ?? 0.5));
    s0 = Math.sqrt(ts);
    towerBase = xform(base, about, s0, 0, off);
    start = pf;
  }
  if (lift > 0) {
    // pilotis: slim columns are drawn as solids by the building; the core keeps it standing
    const core = xform(base, about, 0.2, 0, [0, 0]);
    if (isValidPoly(core)) masses.push(M(core, 0, Z(lift), "base"));
  }

  const every = Math.max(0, Math.round(spec.setbackEvery ?? 0));
  const depth = Math.max(0, spec.setbackDepth ?? 0);
  const taper = Math.max(0.1, Math.min(2, spec.taper ?? 1));
  const twist = spec.twist ?? 0;
  const shaped = Math.abs(taper - 1) > 1e-3 || Math.abs(twist) > 1e-3;
  // break the tower into segments at setbacks and, when shaped, at most ~24 slices
  const breaks = new Set<number>([start, F]);
  if (every > 0 && depth > 0) for (let f = every; f < F; f += every) if (f > start) breaks.add(f);
  if (shaped) {
    const n = Math.min(F - start, 24);
    for (let i = 1; i < n; i++) breaks.add(start + Math.round(((F - start) * i) / n));
  }
  const levels = [...breaks].sort((a, b) => a - b);
  let lastPoly = towerBase;
  let lastXf = { about, off, s: s0, inset: 0, twist: 0 };
  let insetCap = Infinity;
  for (let i = 0; i < levels.length - 1; i++) {
    const f0 = levels[i],
      f1 = levels[i + 1];
    if (f1 <= f0) continue;
    const steps = every > 0 && depth > 0 ? Math.floor(f0 / every) : 0;
    let d = Math.min(steps * depth, insetCap);
    const t = shaped ? (f0 + f1) / 2 - start : 0;
    const k = shaped ? 1 + (taper - 1) * (t / Math.max(1, F - start)) : 1;
    const tw = shaped ? twist * (t / Math.max(1, F - start)) : 0;
    let poly = xform(towerBase, polyCentroid(towerBase), k, tw, [0, 0]);
    if (d > 0) {
      const ins = insetPoly(poly, d);
      if (ins && isValidPoly(ins) && polyArea(ins) > 12) poly = ins;
      else {
        // too small to step again: hold the last plate
        insetCap = Math.max(0, d - depth);
        d = insetCap;
        const ins2 = d > 0 ? insetPoly(poly, d) : poly;
        poly = ins2 && isValidPoly(ins2) ? ins2 : poly;
        if (!notes.length) notes.push("plate too small for further setbacks; upper floors keep the last step");
      }
    }
    const role: MassRole = pf > lift ? (d > 0 || i > 0 ? (d > 0 ? "setback" : "tower") : "tower") : d > 0 ? "setback" : "body";
    masses.push(M(poly, Z(f0), Z(f1), role));
    lastPoly = poly;
    lastXf = { about, off, s: s0 * k, inset: d, twist: tw };
  }
  return { masses, height: Z(F), floors: F, top: lastPoly, topXf: lastXf, groundH: ground, typH: typ, notes };
}
