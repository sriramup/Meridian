// Street hierarchy for a new neighbourhood: a planned grid in the site's own frame with arterials
// bounding it, collectors at regular spacing, a main street through the centre and local streets
// forming walkable urban blocks. Standards used:
//  - Block size: urban blocks of 200–400 ft (60–120 m) a side keep walking routes direct (LEED-ND
//    NPD credit 6: average block perimeter ≤ 1,500 ft; Portland's 200 ft blocks, Austin's 276 ft
//    downtown blocks); suburban fabric stretches to ≈ 600 ft (180 m) faces for deep house lots.
//  - Spacing: arterials ≈ 1 mi apart in suburban grids, ½ mi in cities, and usually bound a
//    neighbourhood (Perry's neighbourhood unit); collectors every ¼–½ mi (400–800 m) feed them.
//  - Cross-sections after the NACTO Urban Street Design Guide / AASHTO Green Book: boulevards with a
//    median, protected bike lanes and wide tree-lined sidewalks (≈ 120 ft ROW); avenues with a centre
//    turn lane and bike lanes (≈ 90 ft); collectors / neighbourhood main streets with bike lanes and
//    parking (≈ 70–80 ft); local streets with two 10 ft lanes, parking and planted sidewalks (≈ 60 ft).
//  - Junction spacing: signalised arterial crossings are kept ≥ ¼ mi where the grid allows; local
//    streets meet arterials under stop control (createStreet assigns signal / stop by class).

import { obb, pointInPoly, polyArea, polyBBox } from "@/geometry/polygon";
import { polyLength } from "@/geometry/polyline";
import { segIntersect } from "@/geometry/vec";
import type { Polygon, RoadClass, Street, Vec2 } from "@/world/types";
import type { World } from "@/world/world";
import type { Actor } from "@/world/ops/buildings";
import type { OpBuilder } from "@/world/ops/core";
import { createStreet, type CreateStreetParams } from "@/world/ops/streets";
import type { DensityClass } from "./programme";
import { makeRng } from "./util";

export type StreetRole = "boulevard" | "avenue" | "main" | "collector" | "local";

export const ROLE_RANK: Record<StreetRole, number> = { boulevard: 4, avenue: 3, main: 2.5, collector: 2, local: 1 };

export interface GridFrame {
  c: Vec2;
  /** radians: local +x in world */
  a: number;
}
export const toWorldG = (f: GridFrame, x: number, y: number): Vec2 => [f.c[0] + x * Math.cos(f.a) - y * Math.sin(f.a), f.c[1] + x * Math.sin(f.a) + y * Math.cos(f.a)];
export const toLocalG = (f: GridFrame, p: Vec2): Vec2 => {
  const dx = p[0] - f.c[0],
    dy = p[1] - f.c[1];
  return [dx * Math.cos(f.a) + dy * Math.sin(f.a), -dx * Math.sin(f.a) + dy * Math.cos(f.a)];
};

export interface GridLine {
  /** "x": constant x (runs along local y); "y": constant y (runs along local x) */
  axis: "x" | "y";
  pos: number;
  role: StreetRole;
  name: string;
  /** an existing street already runs here (not created) */
  existing: boolean;
  boundary: boolean;
}

export interface GridCell {
  i: number;
  j: number;
  /** local rectangle */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** share of the rectangle inside the site */
  fill: number;
  /** facility / park group this cell belongs to (superblocks) */
  group?: string;
}

export interface GridPlan {
  frame: GridFrame;
  /** local extents */
  L: number;
  W: number;
  xs: GridLine[];
  ys: GridLine[];
  cells: GridCell[][];
  /** omitted street segments, keys "x:k:j" (x-line k between ys j and j+1) or "y:k:i" */
  omit: Set<string>;
  centre: Vec2;
}

export interface StreetPlanOptions {
  density: DensityClass;
  seed: number;
  blockLength?: number;
  blockDepth?: number;
  arterials?: boolean;
  /** heading of the grid (deg); default: the site's long side */
  heading?: number;
  centre?: Vec2;
}

/** line-to-line grid spacing (block + right-of-way) by density, metres */
const SPACING: Record<DensityClass, [number, number]> = { very_high: [105, 100], high: [125, 95], medium: [135, 100], low: [190, 100] };
/** collector spacing: ¼ mi in cities, ½ mi in suburbs */
const COLLECTOR_SPACING: Record<DensityClass, number> = { very_high: 400, high: 400, medium: 450, low: 800 };

const BOULEVARDS = ["Republic", "Union", "Pioneer", "Liberty", "Heritage", "Capital", "Riverside", "Summit"];
const AVENUES = ["Grand", "Lincoln", "Madison", "Franklin", "Lexington", "Jefferson", "Highland", "Sterling"];
const COLLECTORS = ["Market", "College", "Church", "Mill", "Academy", "Bridge", "Garden", "Commerce"];
const TREES = ["Oak", "Elm", "Pecan", "Cedar", "Willow", "Magnolia", "Laurel", "Hickory", "Walnut", "Maple", "Juniper", "Sycamore", "Chestnut", "Cypress", "Mesquite", "Birch", "Aspen", "Linden"];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** plan a street grid over a site (pure: nothing is created) */
export function planStreetGrid(world: World, area: Polygon, o: StreetPlanOptions): GridPlan {
  const ring = area[0];
  const box = obb(ring);
  const rng = makeRng(o.seed ^ 0x5eed);
  const a = o.heading !== undefined ? (o.heading * Math.PI) / 180 : box.angle;
  const frame: GridFrame = { c: box.center, a };
  // extents in the chosen frame
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const p of ring) {
    const q = toLocalG(frame, p);
    x0 = Math.min(x0, q[0]);
    x1 = Math.max(x1, q[0]);
    y0 = Math.min(y0, q[1]);
    y1 = Math.max(y1, q[1]);
  }
  // recentre the frame on the extents
  frame.c = toWorldG(frame, (x0 + x1) / 2, (y0 + y1) / 2);
  const L = x1 - x0,
    W = y1 - y0;
  const [sx0, sy0] = SPACING[o.density];
  const sx = o.blockLength ? o.blockLength + 20 : sx0,
    sy = o.blockDepth ? o.blockDepth + 20 : sy0;
  const nx = Math.max(1, Math.round(L / sx)),
    ny = Math.max(1, Math.round(W / sy));
  const xsPos = Array.from({ length: nx + 1 }, (_, k) => -L / 2 + (L * k) / nx);
  const ysPos = Array.from({ length: ny + 1 }, (_, k) => -W / 2 + (W * k) / ny);

  // existing streets parallel to a planned line take its place
  const existing = existingAligned(world, area, frame, L, W);
  const snapTo = (axis: "x" | "y", pos: number, tol: number) => existing.filter((e) => e.axis === axis && Math.abs(e.pos - pos) < tol && e.cover > 0.5).sort((p, q) => Math.abs(p.pos - pos) - Math.abs(q.pos - pos))[0];

  const big = Math.min(L, W) >= 350 && o.arterials !== false;
  const mk = (axis: "x" | "y", pos: number, k: number, n: number): GridLine => {
    const boundary = k === 0 || k === n;
    const ex = snapTo(axis, pos, boundary ? 20 : (axis === "x" ? sx : sy) * 0.35);
    return { axis, pos: ex ? ex.pos : pos, role: "local", name: "", existing: !!ex, boundary };
  };
  const xs = xsPos.map((p, k) => mk("x", p, k, nx));
  const ys = ysPos.map((p, k) => mk("y", p, k, ny));
  // keep line order after snapping
  xs.sort((p, q) => p.pos - q.pos);
  ys.sort((p, q) => p.pos - q.pos);

  // ---- hierarchy
  if (big) {
    // long sides: boulevards; short sides: avenues
    ys[0].role = ys[ys.length - 1].role = "boulevard";
    xs[0].role = xs[xs.length - 1].role = "avenue";
    // a crossing arterial every ≈ 1 mi (½ mi when dense) on very large sites
    const artSpacing = o.density === "low" ? 1600 : 800;
    if (L > artSpacing * 1.3) for (let k = 1; k < Math.round(L / artSpacing); k++) nearest(xs, -L / 2 + (L * k) / Math.round(L / artSpacing)).role = "avenue";
  } else for (const g of [xs[0], xs[xs.length - 1], ys[0], ys[ys.length - 1]]) g.role = "collector";
  const cs = COLLECTOR_SPACING[o.density];
  const pickCollectors = (lines: GridLine[], ext: number) => {
    const n = Math.max(0, Math.round(ext / cs) - 1);
    for (let k = 1; k <= n; k++) {
      const g = nearest(lines.filter((l) => !l.boundary && l.role === "local"), -ext / 2 + (ext * k) / (n + 1));
      if (g) g.role = "collector";
    }
  };
  pickCollectors(xs, L);
  pickCollectors(ys, W);
  // the main street: the interior line along the long axis nearest the centre
  const cLocal = o.centre ? toLocalG(frame, o.centre) : ([0, 0] as Vec2);
  if (o.density !== "low" || W > 500) {
    const m = nearest(ys.filter((l) => !l.boundary), cLocal[1]);
    if (m && W >= 180) m.role = "main";
  }

  // ---- names
  let bi = rng.int(0, BOULEVARDS.length - 1),
    ai = rng.int(0, AVENUES.length - 1),
    ci = rng.int(0, COLLECTORS.length - 1),
    ti = rng.int(0, TREES.length - 1),
    num = 1;
  for (const g of ys) g.name = g.role === "boulevard" ? `${BOULEVARDS[bi++ % BOULEVARDS.length]} Boulevard` : g.role === "avenue" ? `${AVENUES[ai++ % AVENUES.length]} Avenue` : g.role === "main" ? "Main Street" : g.role === "collector" ? `${COLLECTORS[ci++ % COLLECTORS.length]} Street` : `${TREES[ti++ % TREES.length]} Street`;
  for (const g of xs) g.name = g.role === "boulevard" ? `${BOULEVARDS[bi++ % BOULEVARDS.length]} Boulevard` : g.role === "avenue" ? `${AVENUES[ai++ % AVENUES.length]} Avenue` : g.role === "collector" ? `${COLLECTORS[ci++ % COLLECTORS.length]} Street` : `${ordinal(num++)} Street`;

  // ---- cells
  const cells: GridCell[][] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const col: GridCell[] = [];
    for (let j = 0; j < ys.length - 1; j++) {
      const c: GridCell = { i, j, x0: xs[i].pos, x1: xs[i + 1].pos, y0: ys[j].pos, y1: ys[j + 1].pos, fill: 0 };
      c.fill = fillOf(area, frame, c);
      col.push(c);
    }
    cells.push(col);
  }
  return { frame, L, W, xs, ys, cells, omit: new Set(), centre: o.centre ?? frame.c };
}

function nearest(lines: GridLine[], pos: number): GridLine {
  return lines.slice().sort((p, q) => Math.abs(p.pos - pos) - Math.abs(q.pos - pos))[0];
}

/** share of a cell rectangle inside the site (sampled) */
function fillOf(area: Polygon, f: GridFrame, c: GridCell): number {
  let n = 0,
    k = 0;
  for (let u = 0.1; u < 1; u += 0.2)
    for (let v = 0.1; v < 1; v += 0.2) {
      k++;
      if (pointInPoly(toWorldG(f, c.x0 + (c.x1 - c.x0) * u, c.y0 + (c.y1 - c.y0) * v), area)) n++;
    }
  return n / k;
}

export const cellRect = (g: GridPlan, c: { x0: number; x1: number; y0: number; y1: number }): Polygon => [[toWorldG(g.frame, c.x0, c.y0), toWorldG(g.frame, c.x1, c.y0), toWorldG(g.frame, c.x1, c.y1), toWorldG(g.frame, c.x0, c.y1)]];

/** existing streets that run parallel to the grid axes inside the site */
function existingAligned(world: World, area: Polygon, f: GridFrame, L: number, W: number): { axis: "x" | "y"; pos: number; cover: number }[] {
  const bb = polyBBox(area);
  const out: { axis: "x" | "y"; pos: number; cover: number }[] = [];
  for (const e of world.query([bb[0] - 30, bb[1] - 30, bb[2] + 30, bb[3] + 30], ["street"])) {
    const s = e as Street;
    if (s.cls === "service" || s.cls === "motorway" || s.cls === "motorway_link" || s.private) continue;
    const p = s.path.map((q) => toLocalG(f, q));
    const dx = p[p.length - 1][0] - p[0][0],
      dy = p[p.length - 1][1] - p[0][1];
    const len = Math.hypot(dx, dy);
    if (len < 20) continue;
    if (Math.abs(dy) / len < 0.17) {
      const lo = Math.max(-L / 2, Math.min(p[0][0], p[p.length - 1][0])),
        hi = Math.min(L / 2, Math.max(p[0][0], p[p.length - 1][0]));
      out.push({ axis: "y", pos: (p[0][1] + p[p.length - 1][1]) / 2, cover: Math.max(0, hi - lo) / L });
    } else if (Math.abs(dx) / len < 0.17) {
      const lo = Math.max(-W / 2, Math.min(p[0][1], p[p.length - 1][1])),
        hi = Math.min(W / 2, Math.max(p[0][1], p[p.length - 1][1]));
      out.push({ axis: "x", pos: (p[0][0] + p[p.length - 1][0]) / 2, cover: Math.max(0, hi - lo) / W });
    }
  }
  // merge collinear pieces of the same street line
  const merged: typeof out = [];
  for (const e of out) {
    const m = merged.find((x) => x.axis === e.axis && Math.abs(x.pos - e.pos) < 4);
    if (m) m.cover = Math.min(1, m.cover + e.cover);
    else merged.push({ ...e });
  }
  return merged;
}

/** cross-section per role (NACTO / AASHTO, see header) */
export function sectionFor(role: StreetRole, density: DensityClass): Omit<CreateStreetParams, "path" | "name"> {
  const dense = density === "high" || density === "very_high";
  switch (role) {
    case "boulevard":
      return { cls: "primary", lanes: 4, median: true, bike: "track", parking: false, sidewalk: dense ? 5 : 3.5, trees: true };
    case "avenue":
      return { cls: "secondary", lanes: dense ? 4 : 3, bike: "lane", parking: dense, sidewalk: dense ? 4.5 : 3, trees: true };
    case "main":
      return { cls: "tertiary", lanes: 2, bike: "lane", parking: true, sidewalk: dense ? 5 : 4, trees: true };
    case "collector":
      return { cls: "tertiary", lanes: 2, bike: "lane", parking: true, sidewalk: dense ? 3.5 : 2.5, trees: true };
    default:
      return { cls: "residential" as RoadClass, lanes: 2, parking: density !== "low", sidewalk: dense ? 3 : 2, trees: true };
  }
}

export interface BuiltStreets {
  /** created street segment ids with their role */
  ids: { id: string; role: StreetRole; name: string }[];
  /** role by street name (for frontage lookups) */
  roleOf: Map<string, StreetRole>;
}

/** create the planned network in `b` (arterials first so lower classes splice into them) */
export function buildStreetGrid(world: World, g: GridPlan, area: Polygon, density: DensityClass, actor: Actor, b: OpBuilder): BuiltStreets {
  const lines = [...g.xs, ...g.ys].sort((p, q) => ROLE_RANK[q.role] - ROLE_RANK[p.role]);
  const ids: BuiltStreets["ids"] = [];
  const roleOf = new Map<string, StreetRole>();
  for (const line of lines) {
    roleOf.set(line.name, line.role);
    if (line.existing) continue;
    const cross = line.axis === "x" ? g.ys : g.xs;
    const k = (line.axis === "x" ? g.xs : g.ys).indexOf(line);
    // maximal runs of segments that are kept
    const runs: [number, number][] = [];
    let start = -1;
    for (let j = 0; j < cross.length - 1; j++) {
      const keep = !g.omit.has(`${line.axis}:${k}:${j}`) && segmentInside(g, line, cross[j].pos, cross[j + 1].pos, area);
      if (keep && start < 0) start = j;
      if (!keep && start >= 0) {
        runs.push([start, j]);
        start = -1;
      }
    }
    if (start >= 0) runs.push([start, cross.length - 1]);
    for (const [j0, j1] of runs) {
      const t0 = cross[j0].pos,
        t1 = cross[j1].pos;
      let path: Vec2[] = line.axis === "x" ? [toWorldG(g.frame, line.pos, t0), toWorldG(g.frame, line.pos, t1)] : [toWorldG(g.frame, t0, line.pos), toWorldG(g.frame, t1, line.pos)];
      path = clipToArea(path, area, line.boundary);
      if (polyLength(path) < 20) continue;
      const r = createStreet(world, { path, name: line.name, policy: "demolish", ...sectionFor(line.role, density) }, actor, b);
      if (r.ok) for (const id of (r.data?.streetIds as string[]) ?? []) ids.push({ id, role: line.role, name: line.name });
    }
  }
  return { ids, roleOf };
}

/** whether a segment of a grid line lies (mostly) inside the site */
function segmentInside(g: GridPlan, line: GridLine, t0: number, t1: number, area: Polygon): boolean {
  if (line.boundary) return true;
  let n = 0;
  for (const t of [0.2, 0.5, 0.8]) {
    const tt = t0 + (t1 - t0) * t;
    if (pointInPoly(line.axis === "x" ? toWorldG(g.frame, line.pos, tt) : toWorldG(g.frame, tt, line.pos), area)) n++;
  }
  return n >= 2;
}

/** clip an interior line to the site (boundary lines are kept whole) */
function clipToArea(path: Vec2[], area: Polygon, boundary: boolean): Vec2[] {
  if (boundary || polyArea(area) <= 0) return path;
  const [a, b] = path;
  const ring = area[0];
  const ts: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const x = segIntersect(a, b, ring[i], ring[(i + 1) % ring.length]);
    if (x) ts.push(Math.hypot(x[0] - a[0], x[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const inA = pointInPoly(a, area),
    inB = pointInPoly(b, area);
  if (inA && inB) return path;
  ts.sort((p, q) => p - q);
  const lerpP = (t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const s = inA ? 0 : ts[0] ?? 0;
  const e = inB ? 1 : ts[ts.length - 1] ?? 1;
  return [lerpP(s), lerpP(e)];
}
