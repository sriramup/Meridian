// Civic site planning: where schools, a university, parks, fire and police stations, restaurants and
// other services go in a new neighbourhood, and how each site is laid out.
//
// Location rules (US planning practice):
//  - Primary schools sit inside the residential area on local streets or collectors, never fronting an
//    arterial, ideally beside a park (shared fields), within ½ mi of most homes.
//  - Middle and high schools front collectors or avenues (bus access) and are spread apart; urban high
//    schools take a superblock for a full field and track (≈ 6–9 acres).
//  - A university forms a campus district at the edge of the neighbourhood along an arterial, built as
//    several campus blocks that keep the street grid (quads, varied halls, residence halls).
//  - Fire stations front an arterial near the centre of their response area (NFPA 1710: 4-minute
//    travel), with apparatus bays opening onto the street over a 50 ft apron; police stations front an
//    arterial elsewhere.
//  - A neighbourhood park takes a central block; pocket parks and a plaza fill gaps so every home is
//    within ¼ mi (400 m) of public open space.

import { polyArea, polyCentroid } from "@/geometry/polygon";
import { dist } from "@/geometry/vec";
import type { Polygon, Vec2 } from "@/world/types";
import type { Block, BlockEdge, Reservation } from "./fabric";
import { SCHOOL_NORMS, type FacilityKind, type FacilityRequest, type Programme } from "./programme";
import { type GridCell, type GridPlan, toWorldG } from "./streets";
import { type Rng, efExtent, efPt, efRect, clip } from "./util";

export interface CivicSite {
  kind: FacilityKind;
  name: string;
  /** cells (superblock) in the grid */
  cells: GridCell[];
  enrolment?: number;
  /** keep the streets between the cells (campus district) */
  keepStreets: boolean;
}

const CELL_KINDS: FacilityKind[] = ["university", "high_school", "middle_school", "primary_school"];

const SCHOOL_NAMES = {
  primary_school: ["Bluebonnet Elementary", "Cedar Ridge Elementary", "Mockingbird Elementary", "Live Oak Elementary", "Prairie View Elementary"],
  middle_school: ["Lone Star Middle School", "Barton Middle School", "Pecan Grove Middle School", "Ridgeview Middle School"],
  high_school: ["Meridian High School", "Westlake Ridge High School", "Riverside High School", "Colorado River High School"],
  university: ["Meridian University", "University of the Hill Country", "Capital Polytechnic University"],
  park: ["Commons Park", "Heritage Green", "Pecan Park", "Mockingbird Park", "Bluebonnet Park", "Cypress Green"],
};

/** land a facility needs (m²) */
export function siteNeed(f: FacilityRequest): number {
  if (f.kind === "university") return Math.max(45000, ((f.enrolment ?? SCHOOL_NORMS.university.enrolment) / 6000) * SCHOOL_NORMS.university.siteM2);
  if (f.kind === "high_school" || f.kind === "middle_school" || f.kind === "primary_school") {
    const n = SCHOOL_NORMS[f.kind];
    return n.siteM2 * Math.sqrt((f.enrolment ?? n.enrolment) / n.enrolment);
  }
  return 0;
}

const centreOf = (g: GridPlan, cs: GridCell[]): Vec2 => {
  const x = cs.reduce((s, c) => s + (c.x0 + c.x1) / 2, 0) / cs.length,
    y = cs.reduce((s, c) => s + (c.y0 + c.y1) / 2, 0) / cs.length;
  return toWorldG(g.frame, x, y);
};

/** assign facilities and the neighbourhood park(s) to grid cells (superblocks); marks omitted streets */
export function planCivicCells(g: GridPlan, prog: Programme, rng: Rng, parkCells: number): CivicSite[] {
  const nI = g.cells.length,
    nJ = g.cells[0]?.length ?? 0;
  const taken = new Set<string>();
  const key = (i: number, j: number) => `${i}:${j}`;
  const cellLand = (c: GridCell) => Math.max(0, c.x1 - c.x0 - 18) * Math.max(0, c.y1 - c.y0 - 18);
  const meanLand = g.cells.flat().reduce((s, c) => s + cellLand(c), 0) / Math.max(1, nI * nJ);
  const R = Math.hypot(g.L, g.W) / 2;
  const sites: CivicSite[] = [];
  const reqs = [...prog.facilities.filter((f) => CELL_KINDS.includes(f.kind)).sort((a, b) => CELL_KINDS.indexOf(a.kind) - CELL_KINDS.indexOf(b.kind))];
  for (let p = 0; p < parkCells; p++) reqs.push({ kind: "park" });
  const usedNames = new Set<string>();
  for (const f of reqs) {
    const need = f.kind === "park" ? meanLand * 0.9 : siteNeed(f);
    const n = Math.max(1, Math.ceil((need * 0.92) / Math.max(1, meanLand)));
    const shapes: [number, number][] = [];
    for (let w = 1; w <= Math.min(nI, n); w++) {
      const h = Math.ceil(n / w);
      if (h <= nJ) shapes.push([w, h]);
    }
    let best: { cs: GridCell[]; s: number } | null = null;
    for (const [w, h] of shapes)
      for (let i0 = 0; i0 + w <= nI; i0++)
        for (let j0 = 0; j0 + h <= nJ; j0++) {
          const cs: GridCell[] = [];
          let ok = true;
          for (let i = i0; i < i0 + w && ok; i++)
            for (let j = j0; j < j0 + h && ok; j++) {
              const c = g.cells[i][j];
              if (taken.has(key(i, j)) || c.fill < 0.88) ok = false;
              else cs.push(c);
            }
          if (!ok) continue;
          const keepStreets = f.kind === "university";
          // a superblock may only absorb local streets
          if (!keepStreets) {
            for (let i = i0 + 1; i < i0 + w && ok; i++) if (g.xs[i].role !== "local") ok = false;
            for (let j = j0 + 1; j < j0 + h && ok; j++) if (g.ys[j].role !== "local") ok = false;
            if (!ok) continue;
          }
          const c = centreOf(g, cs);
          const dC = dist(c, g.centre) / R;
          const edgeRoles = [g.xs[i0].role, g.xs[i0 + w].role, g.ys[j0].role, g.ys[j0 + h].role];
          const arterial = edgeRoles.some((r) => r === "boulevard" || r === "avenue");
          const collector = edgeRoles.some((r) => r === "collector" || r === "main" || r === "avenue");
          const nearest = sites.filter((s) => s.kind !== "park" && s.kind !== "university").reduce((m, s) => Math.min(m, dist(centreOf(g, s.cells), c)), Infinity);
          const aspect = Math.max(w, h) / Math.min(w, h);
          let s = -0.3 * (aspect - 1) + rng.range(0, 0.05);
          switch (f.kind) {
            case "university":
              s += (arterial ? 1.5 : 0) + dC * 1.2 + (i0 === 0 || i0 + w === nI || j0 === 0 || j0 + h === nJ ? 0.8 : 0);
              break;
            case "high_school":
            case "middle_school":
              s += (collector ? 1 : 0) - Math.abs(dC - 0.45) + Math.min(1.5, nearest / 450);
              break;
            case "primary_school":
              s += (arterial ? -1.2 : 0.4) - dC * 0.8 + Math.min(1.5, nearest / 400) + (sites.some((x) => x.kind === "park" && adjacent(x.cells, cs)) ? 0.5 : 0);
              break;
            case "park": {
              const others = sites.filter((x) => x.kind === "park").reduce((m, x) => Math.min(m, dist(centreOf(g, x.cells), c)), Infinity);
              s += -dC * 1.5 + Math.min(2, others / 300) + (sites.some((x) => x.kind === "primary_school" && adjacent(x.cells, cs)) ? 0.6 : 0) + (arterial ? -0.6 : 0);
              break;
            }
          }
          if (!best || s > best.s) best = { cs, s };
        }
    if (!best) continue;
    for (const c of best.cs) taken.add(key(c.i, c.j));
    const names = SCHOOL_NAMES[f.kind as keyof typeof SCHOOL_NAMES] ?? ["Civic site"];
    let name = f.name ?? names.find((x) => !usedNames.has(x)) ?? names[0];
    usedNames.add(name);
    const site: CivicSite = { kind: f.kind, name, cells: best.cs, enrolment: f.enrolment, keepStreets: f.kind === "university" };
    for (const c of best.cs) c.group = `${f.kind}:${sites.length}`;
    sites.push(site);
    if (!site.keepStreets) omitInterior(g, best.cs);
    name = "";
  }
  return sites;
}

function adjacent(a: GridCell[], b: GridCell[]): boolean {
  return a.some((x) => b.some((y) => Math.abs(x.i - y.i) + Math.abs(x.j - y.j) === 1));
}

/** streets inside a superblock are not built */
function omitInterior(g: GridPlan, cs: GridCell[]) {
  const is = cs.map((c) => c.i),
    js = cs.map((c) => c.j);
  const i0 = Math.min(...is),
    i1 = Math.max(...is) + 1,
    j0 = Math.min(...js),
    j1 = Math.max(...js) + 1;
  for (let i = i0 + 1; i < i1; i++) for (let j = j0; j < j1; j++) g.omit.add(`x:${i}:${j}`);
  for (let j = j0 + 1; j < j1; j++) for (let i = i0; i < i1; i++) g.omit.add(`y:${j}:${i}`);
}

/** local bounding rectangle of a set of cells */
export function cellsBounds(cs: GridCell[]) {
  return { x0: Math.min(...cs.map((c) => c.x0)), x1: Math.max(...cs.map((c) => c.x1)), y0: Math.min(...cs.map((c) => c.y0)), y1: Math.max(...cs.map((c) => c.y1)) };
}

// ---------------------------------------------------------------- lot-scale facilities

export interface LotFacility {
  kind: FacilityKind;
  def: string;
  /** frontage and depth the site takes, m */
  w: number;
  d: number;
  /** street roles it should front, best first */
  roles: BlockEdge["role"][];
  /** set back of the building's centre from the property line, m (point placement) */
  at: number;
  params: Record<string, unknown>;
  /** prefers a block corner (restaurants, cafés) */
  corner?: boolean;
}

export const LOT_FACILITIES: Partial<Record<FacilityKind, LotFacility>> = {
  fire: { kind: "fire", def: "civic.fire_station", w: 44, d: 46, roles: ["boulevard", "avenue", "collector", "main"], at: 15.5 + 12, params: { width: 38, depth: 24, floors: 2, bays: 4, hoseTower: true } },
  police: { kind: "police", def: "civic.police_station", w: 52, d: 40, roles: ["boulevard", "avenue", "collector", "main"], at: 7 + 15, params: { width: 46, depth: 30, floors: 3, parking: false } },
  restaurant: { kind: "restaurant", def: "commercial.restaurant", w: 26, d: 30, roles: ["main", "collector", "local", "avenue"], at: 8 + 10, params: { width: 18, depth: 20, patio: true, patioTables: 8 }, corner: true },
  cafe: { kind: "cafe", def: "commercial.cafe", w: 16, d: 24, roles: ["main", "collector", "local"], at: 4 + 7, params: { width: 10, depth: 14, tables: 4 }, corner: true },
  library: { kind: "library", def: "civic.library", w: 56, d: 50, roles: ["main", "collector", "avenue"], at: 6 + 20, params: { width: 46, depth: 38, floors: 2 } },
  clinic: { kind: "clinic", def: "health.clinic", w: 36, d: 32, roles: ["collector", "main", "avenue"], at: 4 + 11, params: { width: 30, depth: 22, floors: 3, parking: false } },
  community_center: { kind: "community_center", def: "civic.community_center", w: 60, d: 46, roles: ["collector", "main", "local"], at: 5 + 20, params: { width: 52, depth: 38, floors: 2 } },
  daycare: { kind: "daycare", def: "education.daycare", w: 34, d: 44, roles: ["local", "collector"], at: 4 + 10, params: { width: 30, depth: 20, yardDepth: 18 } },
  grocery: { kind: "grocery", def: "commercial.supermarket", w: 74, d: 60, roles: ["avenue", "boulevard", "main", "collector"], at: 3 + 28, params: { width: 70, depth: 55, parking: false } },
  hotel: { kind: "hotel", def: "commercial.hotel", w: 62, d: 42, roles: ["boulevard", "avenue", "main"], at: 2 + 20, params: { width: 58, depth: 38, floors: 12, porteCochere: true } },
};

/**
 * Reserve frontage for lot-scale facilities in fabric blocks. `near` pulls a facility toward a point
 * (fire: the centre; restaurants: the plaza / park); `apart` keeps it away from others of its group.
 */
export function reserveFacility(blocks: Block[], taken: Reservation[], lf: LotFacility, near: Vec2, apartFrom: Vec2[], R: number, rng: Rng): Reservation | null {
  let best: { r: Reservation; s: number } | null = null;
  for (const blk of blocks) {
    blk.edges.forEach((e, ei) => {
      const ri = lf.roles.indexOf(e.role);
      if (ri < 0) return;
      if (e.f.len < lf.w + (lf.corner ? 4 : 24) || e.across < lf.d + 6) return;
      const opts = lf.corner ? [0, e.f.len - lf.w] : [(e.f.len - lf.w) / 2];
      for (const s0 of opts) {
        const s1 = s0 + lf.w;
        const poly = clip(blk.poly, efRect(e.f, s0, s1, 0, lf.d), 10).sort((a, b) => polyArea(b) - polyArea(a))[0];
        if (!poly || polyArea(poly) < lf.w * lf.d * 0.85) continue;
        if (taken.some((t) => t.block === blk.key && overlaps(t.poly, poly))) continue;
        const c = polyCentroid(poly);
        const apart = apartFrom.reduce((m, p) => Math.min(m, dist(p, c)), Infinity);
        const s = -ri * 0.6 - dist(c, near) / R + Math.min(1, apart / 250) + rng.range(0, 0.05);
        if (!best || s > best.s) best = { r: { block: blk.key, edge: ei, s0, s1, depth: lf.d, kind: lf.kind, poly, data: { def: lf.def } }, s };
      }
    });
  }
  return best ? (best as { r: Reservation }).r : null;
}

function overlaps(a: Polygon, b: Polygon): boolean {
  return clip(a, b, 2).length > 0;
}

/** an open-space reservation (pocket park / plaza) at the best corner of a block */
export function reserveOpenSpace(blk: Block, taken: Reservation[], kind: "pocket_park" | "plaza", w: number, d: number, prefer: BlockEdge["role"][]): Reservation | null {
  let best: { r: Reservation; s: number } | null = null;
  blk.edges.forEach((e, ei) => {
    if (e.f.len < w + 10 || e.across < d) return;
    const ri = prefer.indexOf(e.role);
    for (const s0 of [0, e.f.len - w, (e.f.len - w) / 2]) {
      const poly = clip(blk.poly, efRect(e.f, s0, s0 + w, 0, d), 10).sort((a, b) => polyArea(b) - polyArea(a))[0];
      if (!poly || polyArea(poly) < w * d * 0.8) continue;
      if (taken.some((t) => t.block === blk.key && overlaps(t.poly, poly))) continue;
      const s = (ri < 0 ? -2 : -ri) + (s0 === 0 || s0 === e.f.len - w ? 0.5 : 0);
      if (!best || s > best.s) best = { r: { block: blk.key, edge: ei, s0, s1: s0 + w, depth: d, kind, poly }, s };
    }
  });
  return best ? (best as { r: Reservation }).r : null;
}

/** point and heading for a lot facility's building inside its reservation */
export function facilityPlacement(blk: Block, r: Reservation, lf: LotFacility): { at: Vec2; rotation: number } {
  const e = blk.edges[r.edge];
  const at = efPt(e.f, (r.s0 + r.s1) / 2, lf.at);
  const out: Vec2 = [-e.f.n[0], -e.f.n[1]];
  return { at, rotation: ((Math.atan2(out[1], out[0]) * 180) / Math.PI - 90 + 360) % 360 };
}

export { efExtent };
