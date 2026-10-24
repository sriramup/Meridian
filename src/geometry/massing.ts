// Procedural building massing. Generators turn a site polygon and a programme
// into stacked volumes (podiums, towers, bars, setbacks, crowns) so proposals
// read as architecture rather than uniform extrusions.

import type { Mass, Polygon, Ring, Use, Vec2 } from "@/world/types";
import {
  dominantAngle,
  insetPoly,
  intersection,
  isValidPoly,
  normalizePoly,
  obb,
  polyArea,
  polyCentroid,
  rectangle,
  ringArea,
  scalePoly,
  unionMany,
  difference,
  pointInPoly,
  polyBBox,
} from "./polygon";
import { add, rot, scale } from "./vec";

export type Typology =
  | "block"
  | "tower_podium"
  | "courtyard"
  | "slab"
  | "terraced"
  | "l_shape"
  | "u_shape"
  | "point_towers"
  | "twin_towers"
  | "stepped_tower"
  | "rowhouses"
  | "midrise"
  | "pavilion";

export const TYPOLOGIES: Typology[] = ["block", "tower_podium", "courtyard", "slab", "terraced", "l_shape", "u_shape", "point_towers", "twin_towers", "stepped_tower", "rowhouses", "midrise", "pavilion"];

export interface MassingSpec {
  typology: Typology;
  floors: number;
  use: Use;
  podiumFloors?: number;
  /** tower floor plate as a fraction of the podium (0.15–0.7) */
  towerCoverage?: number;
  /** bar depth for courtyard / slab / L / U (m) */
  barDepth?: number;
  setbackEvery?: number;
  setbackDepth?: number;
  /** inset from the site edge at ground level (m) */
  edgeSetback?: number;
  towerCount?: number;
  /** preferred location of tower(s) within the site */
  towerAnchor?: Vec2;
  orientation?: number;
  crown?: boolean;
  /** L / U plans: which side of the site stays open, in quarter turns of the site frame (0–3) */
  openSide?: number;
}

export function floorHeights(use: Use) {
  const ground = use === "residential" ? 4.2 : 4.8;
  const typ = use === "office" ? 4.0 : use === "residential" || use === "hotel" ? 3.2 : use === "parking" ? 3.1 : use === "industrial" ? 5.5 : 3.5;
  return { ground, typ };
}

export function heightForFloors(floors: number, use: Use) {
  const { ground, typ } = floorHeights(use);
  return floors <= 0 ? 0 : ground + (floors - 1) * typ;
}

export function floorsForHeight(h: number, use: Use) {
  const { ground, typ } = floorHeights(use);
  return h <= ground ? 1 : 1 + Math.round((h - ground) / typ);
}

export interface MassingResult {
  masses: Mass[];
  footprint: Polygon;
  height: number;
  floors: number;
  gfa: number;
  notes: string[];
}

/** gross floor area of masses using the use's floor heights */
export function massesGFA(masses: Mass[], use: Use): number {
  const { ground, typ } = floorHeights(use);
  let g = 0;
  for (const m of masses) {
    if (m.role === "crown" || m.role === "bridge") continue;
    const a = polyArea(m.poly);
    const fBase = m.base < ground * 0.5 ? 0 : 1 + Math.round((m.base - ground) / typ);
    const fTop = m.top <= ground ? 1 : 1 + Math.round((m.top - ground) / typ);
    g += a * Math.max(0, fTop - fBase);
  }
  return g;
}

function largest(ps: Polygon[]): Polygon | null {
  let best: Polygon | null = null,
    a = 0;
  for (const p of ps) {
    const x = polyArea(p);
    if (x > a) {
      a = x;
      best = p;
    }
  }
  return best;
}

/** rectangle aligned with angle, of a given area and aspect, fitted inside poly near an anchor */
/** interior points far from the boundary (approximate poles of inaccessibility), best first */
function interiorAnchors(poly: Polygon, n = 4): Vec2[] {
  const [x0, y0, x1, y1] = polyBBox(poly);
  const pts: { p: Vec2; d: number }[] = [];
  const G = 9;
  for (let i = 0; i < G; i++)
    for (let j = 0; j < G; j++) {
      const p: Vec2 = [x0 + ((i + 0.5) / G) * (x1 - x0), y0 + ((j + 0.5) / G) * (y1 - y0)];
      if (!pointInPoly(p, poly)) continue;
      let d = Infinity;
      for (const r of poly)
        for (let k = 0, m = r.length - 1; k < r.length; m = k++) {
          const a = r[m],
            b = r[k];
          const dx = b[0] - a[0],
            dy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
          d = Math.min(d, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
        }
      pts.push({ p, d });
    }
  return pts.sort((a, b) => b.d - a.d).slice(0, n).map((x) => x.p);
}

export function fitRect(poly: Polygon, area: number, aspect: number, angle: number, anchor?: Vec2): Polygon | null {
  const w = Math.sqrt(area * aspect);
  const h = area / w;
  const center = polyCentroid(poly);
  const fits = (c: Vec2, s: number, a: number) => {
    const r = rectangle(c, w * s, h * s, a);
    const ia = intersection([r], poly).reduce((acc, p) => acc + polyArea(p), 0);
    return ia > 0.985 * Math.abs(ringArea(r)) ? normalizePoly([r]) : null;
  };
  const c0 = anchor ?? center;
  for (let shrink = 1; shrink > 0.35; shrink -= 0.08) {
    for (let t = 0; t <= 1.0001; t += 0.25) {
      // move from anchor toward centre until it fits
      const r = fits([c0[0] + (center[0] - c0[0]) * t, c0[1] + (center[1] - c0[1]) * t], shrink, angle);
      if (r) return r;
    }
    // irregular sites: the centroid may sit near a re-entrant corner — try the most interior points and the cross orientation
    if (shrink < 0.95 && !anchor) for (const c of interiorAnchors(poly)) for (const a of [angle, angle + Math.PI / 2]) {
      const r = fits(c, shrink, a);
      if (r) return r;
    }
  }
  // fall back: clipped rectangle at centre
  const r = rectangle(center, w * 0.6, h * 0.6, angle);
  return largest(intersection([r], poly));
}

const M = (poly: Polygon, base: number, top: number, role: Mass["role"], use?: Use): Mass => ({ poly, base, top, role, ...(use ? { use } : {}) });

export function generateMassing(site: Polygon, spec: MassingSpec): MassingResult {
  const notes: string[] = [];
  const use = spec.use;
  const H = (f: number) => heightForFloors(f, use);
  const floors = Math.max(1, Math.round(spec.floors));
  let base = spec.edgeSetback && spec.edgeSetback > 0 ? insetPoly(site, spec.edgeSetback) ?? site : site;
  if (!isValidPoly(base)) base = site;
  const box = obb(base[0]);
  const ang = spec.orientation ?? box.angle ?? dominantAngle(base[0]);
  const masses: Mass[] = [];
  const area = polyArea(base);
  // feasibility: towers need a real floor plate, courtyards need depth
  let typology = spec.typology;
  const minPlate = use === "office" ? 900 : 380;
  if ((typology === "tower_podium" || typology === "stepped_tower" || typology === "twin_towers" || typology === "point_towers") && (area < minPlate / 0.7 || box.width < 18)) {
    notes.push(`site (${Math.round(area)} m², ${box.width.toFixed(0)} m wide) too small for a tower floor plate; generated a ${floors > 8 ? "slender block" : "block"}`);
    typology = "block";
  }
  if ((typology === "courtyard" || typology === "midrise" || typology === "u_shape") && box.width < 2 * (spec.barDepth ?? 14) + 10) {
    if (typology !== "midrise") notes.push(`site too narrow for a courtyard (${box.width.toFixed(0)} m); generated a bar`);
    typology = typology === "midrise" ? "midrise" : "slab";
  }

  switch (typology) {
    case "block":
    case "pavilion": {
      masses.push(M(base, 0, H(floors), "body"));
      break;
    }
    case "tower_podium":
    case "stepped_tower":
    case "point_towers":
    case "twin_towers": {
      const pf = Math.min(floors - 1, Math.max(1, spec.podiumFloors ?? Math.min(5, Math.max(2, Math.round(floors * 0.15)))));
      masses.push(M(base, 0, H(pf), "podium"));
      const count = typology === "twin_towers" ? 2 : typology === "point_towers" ? Math.max(2, spec.towerCount ?? 3) : 1;
      const cov = Math.min(0.7, Math.max(0.12, spec.towerCoverage ?? (use === "office" ? 0.45 : 0.32)));
      const plate = Math.min(use === "office" ? 2400 : 1100, Math.max(420, (area * cov) / count));
      const inner = insetPoly(base, 3) ?? base;
      const towers: Polygon[] = [];
      for (let i = 0; i < count; i++) {
        let anchor = spec.towerAnchor;
        if (count > 1) {
          const t = count === 1 ? 0.5 : i / (count - 1);
          const along = (t - 0.5) * Math.max(0, box.length - Math.sqrt(plate) * 1.4);
          anchor = add(box.center, rot([along, 0], box.angle));
        }
        const others = towers.length ? difference(inner, ...towers.map((tw) => scalePoly(tw, polyCentroid(tw), 1.6))) : [inner];
        const host = largest(others) ?? inner;
        const r = fitRect(host, plate, count > 1 ? 1.0 : 1.35, ang, anchor);
        if (r && isValidPoly(r) && polyArea(r) > plate * 0.45) towers.push(r);
      }
      for (const tw of towers) {
        if (typology === "stepped_tower") {
          // art-deco setbacks: shrink the plate every few floors in the upper third
          const steps = 3;
          const t0 = pf;
          const span = floors - pf;
          let poly = tw;
          for (let s = 0; s < steps; s++) {
            const f0 = t0 + Math.round((span * s) / steps);
            const f1 = t0 + Math.round((span * (s + 1)) / steps);
            masses.push(M(poly, H(f0), H(f1), s === 0 ? "tower" : "setback"));
            poly = scalePoly(poly, polyCentroid(poly), 0.8);
          }
        } else masses.push(M(tw, H(pf), H(floors), "tower"));
        if (spec.crown !== false && floors >= 12) {
          const c = scalePoly(tw, polyCentroid(tw), 0.62);
          masses.push(M(c, H(floors), H(floors) + 6, "crown"));
        }
      }
      if (!towers.length) {
        notes.push("site too constrained for a tower; generated a mid-rise block instead");
        masses.length = 0;
        masses.push(M(base, 0, H(floors), "body"));
      }
      break;
    }
    case "courtyard":
    case "midrise": {
      const depth = spec.barDepth ?? (use === "office" ? 18 : 14);
      const hole = insetPoly(base, depth);
      if (hole && polyArea(hole) > 120) {
        const ring = difference(base, hole);
        const shape = largest(ring);
        if (shape) {
          if (typology === "midrise") {
            const pf = 1;
            masses.push(M(shape, 0, H(pf), "podium", "retail"));
            masses.push(M(shape, H(pf), H(floors), "body"));
          } else {
            // taller on the poleward side keeps the courtyard sunlit: split the ring by a line through the centre
            const c = polyCentroid(base);
            const north = intersection(shape, [rectangle(add(c, [0, 500]), 2000, 1000, 0)]);
            const south = intersection(shape, [rectangle(add(c, [0, -500]), 2000, 1000, 0)]);
            const fN = floors;
            const fS = Math.max(2, floors - 2);
            for (const p of north) masses.push(M(p, 0, H(fN), "body"));
            for (const p of south) masses.push(M(p, 0, H(fS), "wing"));
          }
          break;
        }
      }
      notes.push("parcel too narrow for an open courtyard; generated a perimeter bar");
      masses.push(M(base, 0, H(floors), "body"));
      break;
    }
    case "slab": {
      const depth = spec.barDepth ?? 16;
      const len = Math.max(20, box.length - 6);
      const r = intersection([rectangle(box.center, len, Math.min(depth, box.width - 2), ang)], base);
      const s = largest(r);
      masses.push(M(s ?? base, 0, H(floors), "body"));
      break;
    }
    case "l_shape":
    case "u_shape": {
      const depth = spec.barDepth ?? 14;
      // rotate the site frame by quarter turns so the open side can face any edge
      const k = (((spec.openSide ?? 0) % 4) + 4) % 4;
      const fa = box.angle + (k * Math.PI) / 2;
      const L = k % 2 ? box.width : box.length,
        W = k % 2 ? box.length : box.width;
      const u = rot([1, 0], fa),
        v = rot([0, 1], fa);
      const at = (a: number, b: number): Vec2 => add(box.center, add(scale(u, a), scale(v, b)));
      const bars: Ring[] = [rectangle(at(0, -W / 2 + depth / 2), L, depth, fa)];
      bars.push(rectangle(at(-L / 2 + depth / 2, 0), depth, W, fa));
      if (typology === "u_shape") bars.push(rectangle(at(L / 2 - depth / 2, 0), depth, W, fa));
      const shape = largest(intersection(unionMany(bars.map((b) => [b] as Polygon))[0] ?? [bars[0]], base));
      masses.push(M(shape ?? base, 0, H(floors), "body"));
      break;
    }
    case "terraced": {
      const every = spec.setbackEvery ?? Math.max(2, Math.round(floors / 4));
      const d = spec.setbackDepth ?? 3;
      let poly: Polygon | null = base;
      let f = 0;
      let role: Mass["role"] = "podium";
      while (f < floors && poly && isValidPoly(poly)) {
        const f1 = Math.min(floors, f + every);
        masses.push(M(poly, H(f), H(f1), role));
        role = "setback";
        f = f1;
        poly = insetPoly(poly, d);
      }
      break;
    }
    case "rowhouses": {
      const unitW = 6.5;
      const depth = Math.min(13, box.width - 2);
      const n = Math.max(2, Math.floor((box.length - 2) / unitW));
      const u = rot([1, 0], box.angle);
      const v = rot([0, 1], box.angle);
      for (let i = 0; i < n; i++) {
        const a = -box.length / 2 + 1 + unitW * (i + 0.5);
        const c = add(box.center, add(scale(u, a), scale(v, -box.width / 2 + depth / 2 + 1)));
        const r = largest(intersection([rectangle(c, unitW - 0.15, depth, box.angle)], base));
        if (!r) continue;
        const f = floors + ((i * 7) % 3 === 0 ? 1 : 0);
        masses.push(M(r, 0, heightForFloors(f, "residential"), "body"));
      }
      if (!masses.length) masses.push(M(base, 0, H(floors), "body"));
      break;
    }
  }

  const footprint = largest(unionMany(masses.filter((m) => m.base < 0.5).map((m) => m.poly))) ?? base;
  const height = Math.max(...masses.map((m) => m.top));
  return { masses, footprint, height, floors, gfa: massesGFA(masses, use), notes };
}

/** split masses at a height and inset everything above it (upper-floor setbacks) */
export function addSetbacks(masses: Mass[], atHeight: number, depth: number): { masses: Mass[]; changed: boolean } {
  const out: Mass[] = [];
  let changed = false;
  for (const m of masses) {
    if (m.top <= atHeight + 1 || m.role === "crown") {
      out.push(m);
      continue;
    }
    const upper = insetPoly(m.poly, depth);
    if (!upper || polyArea(upper) < 40) {
      out.push(m);
      continue;
    }
    changed = true;
    if (m.base < atHeight) out.push({ ...m, top: atHeight });
    out.push({ ...m, poly: upper, base: Math.max(m.base, atHeight), role: "setback" });
  }
  return { masses: out, changed };
}

/** scale all heights about the ground (keeps footprint) */
export function scaleHeights(masses: Mass[], k: number): Mass[] {
  return masses.map((m) => ({ ...m, base: m.base * k, top: m.top * k }));
}

/** stretch everything above the podium so the building reaches height h (podium and street wall unchanged) */
export function stretchAbovePodium(masses: Mass[], h: number): Mass[] {
  const cur = Math.max(...masses.map((m) => m.top));
  const pods = masses.filter((m) => m.role === "podium" || m.role === "base");
  const podTop = pods.length && pods.length < masses.length ? Math.max(...pods.map((m) => m.top)) : 0;
  if (cur <= podTop + 0.5) return setHeight(masses, h);
  const k = (h - podTop) / (cur - podTop);
  const f = (z: number) => (z <= podTop ? z : podTop + (z - podTop) * k);
  return masses.map((m) => ({ ...m, base: f(m.base), top: f(m.top) }));
}

/** set the overall height, scaling the vertical composition proportionally */
export function setHeight(masses: Mass[], h: number): Mass[] {
  const cur = Math.max(...masses.map((m) => m.top));
  return cur > 0 ? scaleHeights(masses, h / cur) : masses;
}
