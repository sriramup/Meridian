// Sketch → world: a deterministic builder that turns a normalised SketchPlan (src/sketch/plan.ts)
// into world features in ONE reversible changeset, at the quality of design_neighborhood:
//
//   placement frame (centre, size, rotation, the sketch's north arrow) →
//   water (rivers buffered from their centrelines, lakes) → streets by class, arterials first, each
//   spliced into the network (createStreet) with NACTO / AASHTO sections (src/design/streets.ts) →
//   rail lines (route + stations, kept clear of buildings) → parks, greens, plazas from the library →
//   blocks = the land between rights-of-way; very large blocks get local infill streets →
//   facilities on their blocks from the library's real primitives (a "SCHOOL" box becomes an urban
//   school) → every other block filled by the design generator's fabric (lots, typologies on an
//   intensity ladder, courtyards, gardens, garages) at the block's drawn use and density →
//   street trees.
//
// Buildings are placed with the "safe" conflict mode (never overlapping anything standing); existing
// buildings inside the site are built around unless replaceExisting (then the commit's approval
// rules apply). chooseSite() finds free space on a canvas that already holds a design.

import { bufferPoly, convexHull, insetPoly, intersection, isValidPoly, normalizePoly, obb, pointInPoly, polyArea, polyBBox, polyCentroid, rectangle } from "@/geometry/polygon";
import { bandRing, closestOnPath, polyLength, simplifyPath, smoothPath } from "@/geometry/polyline";
import { dist, segIntersect } from "@/geometry/vec";
import { ensureLibrary } from "@/library";
import { fmtAcres, fmtLen, fmtNum } from "@/lib/units";
import type { Area, Building, Polygon, Street, StreetNode, TransitRoute, TransitStop, Tree, Vec2 } from "@/world/types";
import { newId, type World } from "@/world/world";
import type { Actor } from "@/world/ops/buildings";
import { OpBuilder, programmeOf, type OpResult } from "@/world/ops/core";
import { createArea, streetTreeCandidates } from "@/world/ops/landscape";
import { placePrimitive } from "@/world/ops/library";
import { createStreet } from "@/world/ops/streets";
import { streetBand } from "@/world/ops/validate";
import { inStudyArea } from "@/world/ops/placement";
import { INTENSITY_RANGE, analyseBlock, applyRetail, lotPlacement, planFabric, roleOfClass, streetRefs, type Block, type Reservation } from "@/design/fabric";
import { SPECIES_SIZE, TREE_SPECIES, addArea, courtyardTrees, minusAll, streetsNear, yardTree } from "@/design/neighborhood";
import { resolveProgramme, type DensityClass, type PaletteName } from "@/design/programme";
import { sectionFor, type StreetRole } from "@/design/streets";
import { clip, efExtent, edgeFrame, hashStr, makeRng, minWidth, minus, type Rng } from "@/design/util";
import type { BlockUse, Density, FacilityKind, Pt, SketchPlan, StreetClass } from "./plan";

const SOURCE = "Meridian sketch";

// ---------------------------------------------------------------- placement frame

export interface Placement {
  /** centre of the sketch on the canvas, local metres */
  centre: Vec2;
  /** long side of the sketch in metres (default: the plan's estimated extent) */
  size_m?: number;
  /** extra rotation, degrees counter-clockwise (applied after the sketch's north arrow) */
  rotation_deg?: number;
}

export interface SketchFrame {
  W: number;
  H: number;
  /** radians, counter-clockwise: sketch-up → world */
  angle: number;
  centre: Vec2;
  toWorld: (p: Pt) => Vec2;
  /** the sketch's outline on the canvas */
  outline: Polygon;
}

/** clamp a requested size to something buildable */
export const SIZE_RANGE: [number, number] = [150, 3000];

/** size of the sketch on the ground (metres), keeping the image's aspect */
export function sketchSize(plan: SketchPlan, size_m?: number): { W: number; H: number } {
  const w0 = Math.max(1, plan.extent.width_m),
    h0 = Math.max(1, plan.extent.height_m);
  const long = Math.max(w0, h0);
  const want = Math.max(SIZE_RANGE[0], Math.min(SIZE_RANGE[1], size_m ?? long));
  const k = want / long;
  return { W: w0 * k, H: h0 * k };
}

/** total rotation (radians, CCW): the sketch's north arrow made to point north, plus any extra rotation */
export function sketchAngle(plan: SketchPlan, rotation_deg = 0): number {
  return (((plan.north_deg ?? 0) + rotation_deg) * Math.PI) / 180;
}

export function sketchFrame(plan: SketchPlan, p: Placement): SketchFrame {
  const { W, H } = sketchSize(plan, p.size_m);
  const angle = sketchAngle(plan, p.rotation_deg);
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const toWorld = (q: Pt): Vec2 => {
    const x = (q[0] - 0.5) * W,
      y = (0.5 - q[1]) * H;
    return [p.centre[0] + x * c - y * s, p.centre[1] + x * s + y * c];
  };
  const outline = normalizePoly([[toWorld([0, 1]), toWorld([1, 1]), toWorld([1, 0]), toWorld([0, 0])]]);
  return { W, H, angle, centre: p.centre, toWorld, outline };
}

// ---------------------------------------------------------------- free space

const KINDS = ["building", "street", "area", "prop", "route"] as const;

/** does anything already stand inside the (rotated) rectangle, grown by `margin`? */
export function siteOccupied(world: World, centre: Vec2, W: number, H: number, angle: number, margin = 40): boolean {
  const ring = rectangle(centre, W + 2 * margin, H + 2 * margin, angle);
  const poly: Polygon = [ring];
  const bb = polyBBox(poly);
  for (const e of world.query(bb, [...KINDS])) {
    const g: Polygon | null = e.kind === "building" ? (e as Building).footprint : e.kind === "area" ? (e as Area).poly : e.kind === "street" ? streetBand(e as Street) : null;
    if (g) {
      if (intersection(poly, g).some((q) => polyArea(q) > 1)) return true;
      continue;
    }
    // props, routes: any vertex inside
    const pts = ((e as { path?: Vec2[] }).path ?? ((e as { footprint?: Polygon }).footprint?.[0] as Vec2[] | undefined) ?? ((e as { p?: Vec2 }).p ? [(e as { p: Vec2 }).p] : [])) as Vec2[];
    if (pts.some((q) => pointInPoly(q, poly))) return true;
  }
  for (const e of world.query(bb, ["tree"])) if (pointInPoly((e as Tree).p, poly)) return true;
  return false;
}

/** the rectangle stays inside the study area */
function insideBounds(world: World, centre: Vec2, W: number, H: number, angle: number, pad = 20): boolean {
  return rectangle(centre, W + 2 * pad, H + 2 * pad, angle).every((q) => inStudyArea(world, q));
}

export interface SiteChoice {
  centre: Vec2;
  /** long side actually used (shrunk when nothing free was big enough at full size) */
  size_m: number;
  /** how it was chosen, for the report */
  how: string;
  moved: boolean;
}

/**
 * Free space for a W × H sketch: `prefer` itself when nothing is there, else the nearest free spot
 * (rings of candidates around it, nearest first), else the same search at a smaller size (down to half).
 */
export function chooseSite(world: World, plan: SketchPlan, opts: { prefer: Vec2; size_m?: number; rotation_deg?: number; margin?: number; label?: string }): SiteChoice | null {
  const angle = sketchAngle(plan, opts.rotation_deg);
  const full = sketchSize(plan, opts.size_m);
  const label = opts.label ?? `[${Math.round(opts.prefer[0])}, ${Math.round(opts.prefer[1])}]`;
  const empty = world.count("building") + world.count("street") + world.count("area") === 0;
  for (const k of [1, 0.85, 0.7, 0.55]) {
    const W = full.W * k,
      H = full.H * k;
    const long = Math.max(W, H);
    const step = Math.max(40, Math.min(120, long / 8));
    const maxR = Math.hypot(world.meta.bounds[2] - world.meta.bounds[0], world.meta.bounds[3] - world.meta.bounds[1]) / 2;
    for (let r = 0; r <= maxR; r += step) {
      const n = r === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * r) / step));
      // nearest first; at equal distance start east and go round
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        const c: Vec2 = [opts.prefer[0] + r * Math.cos(a), opts.prefer[1] + r * Math.sin(a)];
        if (!insideBounds(world, c, W, H, angle)) continue;
        if (siteOccupied(world, c, W, H, angle, opts.margin ?? 40)) continue;
        const moved = r > 0;
        const sizeNote = k < 1 ? ` at ${Math.round(k * 100)}% of the sketch's estimated size (nothing free was big enough at full size)` : "";
        return {
          centre: [Math.round(c[0]), Math.round(c[1])],
          size_m: Math.round(long),
          moved,
          how: !moved ? (empty ? `the centre of the empty canvas${sizeNote}` : `${label}, which is free${sizeNote}`) : `the nearest free space to ${label}, ${fmtLen(r)} away (the design already there is left untouched)${sizeNote}`,
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- builder

export interface BuildSketchOptions {
  name?: string;
  seed?: number;
  /** demolish (non-historic) buildings standing inside the site; default: build around them */
  replaceExisting?: boolean;
  /** override every block's density */
  density?: Density;
}

const ROLE_OF: Record<StreetClass, StreetRole> = { arterial: "avenue", collector: "collector", local: "local", pedestrian: "local" };
const RANK: Record<StreetClass, number> = { arterial: 4, collector: 3, local: 2, pedestrian: 1 };
const AVENUES = ["Grand", "Lincoln", "Madison", "Franklin", "Lexington", "Jefferson", "Highland", "Sterling"];
const COLLECTORS = ["Market", "College", "Church", "Mill", "Academy", "Bridge", "Garden", "Commerce"];
const LOCALS = ["Oak", "Elm", "Pecan", "Cedar", "Willow", "Magnolia", "Laurel", "Hickory", "Walnut", "Maple", "Juniper", "Sycamore", "Chestnut", "Cypress", "Mesquite", "Birch", "Aspen", "Linden"];

/** a facility's library primitive, its default footprint (m) and how it is placed */
const FACILITY: Record<FacilityKind, { def: string; w: number; d: number; site?: boolean; label: string; params?: Record<string, unknown> }> = {
  school: { def: "composites.urban_school", w: 120, d: 100, site: true, label: "School" },
  university: { def: "composites.campus_block", w: 200, d: 160, site: true, label: "University", params: { role: "academic", style: "collegiate", floors: 5 } },
  hospital: { def: "health.hospital", w: 110, d: 80, label: "Hospital" },
  clinic: { def: "health.clinic", w: 30, d: 22, label: "Clinic", params: { floors: 3, parking: false } },
  station: { def: "transport.train_station", w: 80, d: 30, label: "Station" },
  fire: { def: "civic.fire_station", w: 38, d: 24, label: "Fire Station", params: { floors: 2, bays: 4, hoseTower: true } },
  police: { def: "civic.police_station", w: 46, d: 30, label: "Police Station", params: { floors: 3, parking: false } },
  library: { def: "civic.library", w: 46, d: 38, label: "Library", params: { floors: 2 } },
  community: { def: "civic.community_center", w: 52, d: 38, label: "Community Center", params: { floors: 2 } },
  worship: { def: "civic.place_of_worship", w: 30, d: 45, label: "Place of Worship" },
  museum: { def: "civic.museum", w: 60, d: 45, label: "Museum" },
  market: { def: "commercial.market_stalls", w: 40, d: 30, label: "Market" },
  supermarket: { def: "commercial.supermarket", w: 70, d: 55, label: "Grocery", params: { parking: false } },
  stadium: { def: "parks.park", w: 180, d: 130, site: true, label: "Sports Park", params: { paths: "perimeter", playground: false } },
  hotel: { def: "commercial.hotel", w: 58, d: 38, label: "Hotel", params: { floors: 12 } },
  city_hall: { def: "civic.city_hall", w: 60, d: 45, label: "City Hall" },
  other: { def: "buildings.building", w: 40, d: 30, label: "Civic building", params: { use: "civic", floors: 3 } },
};

const USE_FABRIC: Record<BlockUse, { retail: number; office: number; density?: DensityClass; shops: boolean }> = {
  residential: { retail: 0.02, office: 0, shops: false },
  mixed: { retail: 0.14, office: 0.1, shops: true },
  commercial: { retail: 0.3, office: 0.35, shops: true },
  office: { retail: 0.08, office: 0.7, shops: true },
  civic: { retail: 0.05, office: 0.1, shops: false },
  industrial: { retail: 0, office: 0, shops: false },
};

interface Piece {
  key: string;
  poly: Polygon;
  use: BlockUse;
  density: DensityClass;
  floors?: number;
  label?: string;
}

/** snap street endpoints (normalised) onto the nearest other street within tol, so the network connects */
export function snapEnds(streets: { points: Pt[] }[], tol = 0.035): Pt[][] {
  const out = streets.map((s) => s.points.map((p) => [p[0], p[1]] as Pt));
  for (let i = 0; i < out.length; i++) {
    for (const end of [0, out[i].length - 1]) {
      const p = out[i][end];
      let best: { q: Pt; d: number } | null = null;
      for (let j = 0; j < out.length; j++) {
        if (j === i) continue;
        const c = closestOnPath(p as Vec2, out[j] as Vec2[]);
        if (c.d < tol && (!best || c.d < best.d)) best = { q: c.p as Pt, d: c.d };
      }
      if (!best) continue;
      // overshoot slightly onto the other line so the crossing is found (createStreet splices at hits)
      const nb = end === 0 ? out[i][1] : out[i][out[i].length - 2];
      const dx = best.q[0] - nb[0],
        dy = best.q[1] - nb[1];
      const L = Math.hypot(dx, dy) || 1;
      out[i][end] = [best.q[0] + (dx / L) * 0.002, best.q[1] + (dy / L) * 0.002];
    }
  }
  return out;
}

/** the parts of a straight line (through p along u) inside a polygon */
function lineInside(poly: Polygon, p: Vec2, u: Vec2, reach: number): [Vec2, Vec2][] {
  const a: Vec2 = [p[0] - u[0] * reach, p[1] - u[1] * reach],
    b: Vec2 = [p[0] + u[0] * reach, p[1] + u[1] * reach];
  const ts: number[] = [];
  for (const ring of poly)
    for (let i = 0; i < ring.length; i++) {
      const x = segIntersect(a, b, ring[i], ring[(i + 1) % ring.length]);
      if (x) ts.push(dist(a, x) / (2 * reach));
    }
  ts.sort((x, y) => x - y);
  const out: [Vec2, Vec2][] = [];
  const at = (t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let i = 0; i + 1 < ts.length; i += 2) {
    const s = at(ts[i]),
      e = at(ts[i + 1]);
    if (pointInPoly(at((ts[i] + ts[i + 1]) / 2), poly)) out.push([s, e]);
  }
  return out;
}

/** extend a segment end along its direction until it meets a street centreline (≤ reach m) */
function extendToStreet(end: Vec2, dir: Vec2, streets: Street[], reach = 40): Vec2 {
  const far: Vec2 = [end[0] + dir[0] * reach, end[1] + dir[1] * reach];
  let best: { p: Vec2; d: number } | null = null;
  for (const s of streets)
    for (let i = 1; i < s.path.length; i++) {
      const x = segIntersect(end, far, s.path[i - 1], s.path[i]);
      if (x && (!best || dist(end, x) < best.d)) best = { p: x, d: dist(end, x) };
    }
  return best?.p ?? end;
}

function pick<T>(xs: T[], i: number): T {
  return xs[i % xs.length];
}

export function buildSketch(world: World, plan: SketchPlan, placement: Placement, actor: Actor, opts: BuildSketchOptions = {}): OpResult {
  ensureLibrary();
  const b = new OpBuilder(world, actor.author);
  if (!plan.is_plan) return b.fail(`This doesn't look like a plan: ${plan.not_plan_reason ?? "nothing to build"}`);
  const F = sketchFrame(plan, placement);
  const seed = Math.floor(opts.seed ?? (hashStr(JSON.stringify(plan.streets).slice(0, 2000)) % 9973) + 1);
  const rng = makeRng(seed);
  const name = opts.name ?? plan.title ?? "Sketch";
  const hh = world.meta.calibration?.householdSize ?? 2.5;
  const palette: PaletteName = rng.pick(["masonry", "texas", "modern", "masonry", "texas"] as PaletteName[]);
  const W = (pts: Pt[]) => pts.map(F.toWorld);
  const Wpoly = (pts: Pt[]): Polygon | null => {
    const p = normalizePoly([W(pts)]);
    if (!isValidPoly(p)) return null;
    return clip(p, F.outline, 20)[0] ?? null;
  };
  const defaultDensity: DensityClass = opts.density ?? plan.default_density ?? "medium";
  const outBB = polyBBox(F.outline);

  // ---- 0. what stands on the site
  const standing: Building[] = [];
  let demolished = 0;
  for (const e of world.query(outBB, ["building"])) {
    const bld = b.get<Building>(e.id);
    if (!bld || !pointInPoly(polyCentroid(bld.footprint), F.outline)) continue;
    if (opts.replaceExisting && !bld.historic) {
      b.remove(bld.id);
      demolished++;
    } else standing.push(bld);
  }
  const policy = opts.replaceExisting || !standing.length ? "demolish" : "report";

  // ---- 1. water
  const waterPolys: Polygon[] = [];
  for (const a of plan.areas.filter((x) => x.kind === "water")) {
    let poly: Polygon | null = null;
    if (a.poly) poly = Wpoly(a.poly);
    else if (a.line) {
      const path = smoothPath(simplifyPath(W(a.line), 2), 2);
      const w = a.width_m ?? 40;
      const band = normalizePoly([bandRing(path, -w / 2, w / 2)]);
      poly = isValidPoly(band) ? (clip(band, F.outline, 20).sort((x, y) => polyArea(y) - polyArea(x))[0] ?? null) : null;
    }
    if (!poly) continue;
    const r = createArea(world, { type: "water", poly, name: a.name }, actor, b);
    if (r.ok) waterPolys.push(poly);
  }

  // ---- 2. streets, arterials first so lower classes splice into them
  const snapped = snapEnds(plan.streets);
  const order = plan.streets.map((s, i) => ({ s, pts: snapped[i] })).sort((x, y) => RANK[y.s.class] - RANK[x.s.class] || (y.s.weight ?? 0) - (x.s.weight ?? 0));
  const built: { id: string; role: StreetRole; name: string; cls: StreetClass }[] = [];
  const roleByName = new Map<string, StreetRole>();
  const counters = { a: rng.int(0, 7), c: rng.int(0, 7), l: rng.int(0, 17) };
  let streetLen = 0;
  for (const { s, pts } of order) {
    let path = simplifyPath(W(pts), 1.5);
    if (path.length > 2) path = smoothPath(path, 1);
    if (polyLength(path) < 25) continue;
    const role: StreetRole = s.class === "arterial" && ((s.weight ?? 0) >= 4.5 || /boulevard|blvd|parkway/i.test(s.name ?? "")) ? "boulevard" : ROLE_OF[s.class];
    const nm = s.name ?? (s.class === "arterial" ? `${pick(AVENUES, counters.a++)} Avenue` : s.class === "collector" ? `${pick(COLLECTORS, counters.c++)} Street` : s.class === "pedestrian" ? `${pick(LOCALS, counters.l++)} Walk` : `${pick(LOCALS, counters.l++)} Street`);
    const section = s.class === "pedestrian" ? { cls: "pedestrian" as const, trees: true } : sectionFor(role, defaultDensity);
    const r = createStreet(world, { path, name: nm, policy, ...section }, actor, b);
    if (!r.ok) continue;
    streetLen += polyLength(path);
    roleByName.set(nm, role);
    for (const id of (r.data?.streetIds as string[]) ?? []) built.push({ id, role, name: nm, cls: s.class });
  }

  // ---- 3. rail / transit lines: a route with stations, its corridor kept clear
  const railBands: Polygon[] = [];
  let lines = 0;
  for (const t of plan.transit) {
    const path = smoothPath(simplifyPath(W(t.points), 2), 1);
    if (polyLength(path) < 60) continue;
    const rail = t.kind === "rail" || t.kind === "metro" || t.kind === "tram";
    if (t.kind === "rail" || t.kind === "metro") railBands.push(normalizePoly([bandRing(path, -9, 9)]));
    const routeId = newId("r");
    const stops: string[] = [];
    const st = t.stations?.length ? W(t.stations) : [];
    for (const p of st) {
      const c = closestOnPath(p, path);
      const id = newId("st");
      b.add<TransitStop>({ id, kind: "stop", p: c.p, name: `${t.name ?? name} station ${stops.length + 1}`, mode: rail ? (t.kind === "tram" ? "tram" : "rail") : t.kind === "brt" ? "brt" : "bus", routes: [routeId], source: SOURCE, provenance: "proposed", createdBy: b.tag });
      stops.push(id);
    }
    b.add<TransitRoute>({ id: routeId, kind: "route", mode: t.kind === "metro" ? "rail" : t.kind, name: t.name ?? `${name} ${t.kind === "bus" ? "bus" : t.kind} line`, ref: t.kind === "bus" ? "S1" : "L1", color: rail ? "#7a3b8f" : "#2a6fb0", path, streets: [], stops, headway: rail ? 10 : 12, source: SOURCE, provenance: "proposed", createdBy: b.tag });
    lines++;
  }

  // ---- 4. land between the rights-of-way
  const bandsNow = () => streetsNear(world, b, [outBB[0] - 40, outBB[1] - 40, outBB[2] + 40, outBB[3] + 40]);
  let streets = bandsNow();
  const hullPts: Vec2[] = [];
  for (const s of built) hullPts.push(...(b.get<Street>(s.id)?.path ?? []));
  for (const a of plan.areas) hullPts.push(...W(a.poly ?? []));
  for (const bl of plan.blocks) hullPts.push(...W(bl.poly));
  for (const f of plan.facilities) hullPts.push(F.toWorld(f.at), ...W(f.poly ?? []));
  let region: Polygon = F.outline;
  if (hullPts.length >= 3) {
    const hull = normalizePoly([convexHull(hullPts)]);
    // a little room beyond the outermost street so its far side gets a row of lots too
    const grown = isValidPoly(hull) ? bufferPoly(hull, 45) : null;
    const r = grown && isValidPoly(grown) ? clip(grown, F.outline, 100).sort((x, y) => polyArea(y) - polyArea(x))[0] : null;
    if (r) region = r;
  }
  const openPolys: { kind: string; poly: Polygon; name?: string }[] = [];
  for (const a of plan.areas.filter((x) => x.kind !== "water")) {
    let poly: Polygon | null = null;
    if (a.poly) poly = Wpoly(a.poly);
    else if (a.line) {
      const path = smoothPath(simplifyPath(W(a.line), 2), 2);
      const band = normalizePoly([bandRing(path, -(a.width_m ?? 30) / 2, (a.width_m ?? 30) / 2)]);
      poly = isValidPoly(band) ? (clip(band, F.outline, 20)[0] ?? null) : null;
    }
    if (poly) openPolys.push({ kind: a.kind, poly, name: a.name });
  }
  const keepOut = () => [...streets.map(streetBand), ...waterPolys.map((w) => bufferPoly(w, 4)), ...railBands, ...standing.map((s) => s.footprint)];
  let ko = keepOut();
  const piecesOf = () => minus(region, [...ko, ...openPolys.map((o) => o.poly)], 400).filter((q) => minWidth(q) >= 14);

  // very large blocks (a sketch with only a few streets drawn) get local streets at block spacing
  const spacing = defaultDensity === "low" ? 170 : defaultDensity === "medium" ? 130 : 115;
  let infill = 0;
  for (const q of piecesOf()) {
    if (polyArea(q) < spacing * spacing * 2.2 || minWidth(q) < spacing * 1.6) continue;
    const box = obb(q[0]);
    const u: Vec2 = [Math.cos(box.angle), Math.sin(box.angle)],
      v: Vec2 = [-u[1], u[0]];
    const reach = Math.hypot(box.length, box.width);
    const segs: [Vec2, Vec2][] = [];
    // lines across the long side (constant along-u offsets), then along it when the block is deep
    for (const [dirAlong, dirAcross, ext] of [[v, u, box.length], [u, v, box.width]] as [Vec2, Vec2, number][]) {
      const n = Math.round(ext / spacing);
      if (n < 2) continue;
      for (let k = 1; k < n; k++) {
        const off = -ext / 2 + (ext * k) / n;
        const p: Vec2 = [box.center[0] + dirAcross[0] * off, box.center[1] + dirAcross[1] * off];
        for (const [s0, e0] of lineInside(q, p, dirAlong, reach)) if (dist(s0, e0) > 60) segs.push([s0, e0]);
      }
    }
    for (const [s0, e0] of segs) {
      const d: Vec2 = [(e0[0] - s0[0]) / dist(s0, e0), (e0[1] - s0[1]) / dist(s0, e0)];
      const s1 = extendToStreet(s0, [-d[0], -d[1]], streets),
        e1 = extendToStreet(e0, d, [...streets, ...built.map((x) => b.get<Street>(x.id)!).filter(Boolean)]);
      const nm = `${pick(LOCALS, counters.l++)} Street`;
      const r = createStreet(world, { path: [s1, e1], name: nm, policy, ...sectionFor("local", defaultDensity) }, actor, b);
      if (!r.ok) continue;
      infill++;
      streetLen += dist(s1, e1);
      roleByName.set(nm, "local");
      for (const id of (r.data?.streetIds as string[]) ?? []) built.push({ id, role: "local", name: nm, cls: "local" });
    }
  }
  if (infill) {
    streets = bandsNow();
    ko = keepOut();
  }
  const roleOf = (s: Street): StreetRole => roleByName.get(s.name ?? "") ?? roleOfClass(s.cls);
  const refs = streetRefs(streets, roleOf);

  // per-block use: the drawn block containing it, else the plan's default
  const drawn = plan.blocks.map((bl) => ({ bl, poly: Wpoly(bl.poly) })).filter((x): x is { bl: (typeof plan.blocks)[number]; poly: Polygon } => !!x.poly);
  const pieces: Piece[] = piecesOf().map((q, i) => {
    const c = polyCentroid(q);
    const hit = drawn.find((d) => pointInPoly(c, d.poly)) ?? drawn.find((d) => intersection(d.poly, q).some((x) => polyArea(x) > polyArea(q) * 0.4));
    return { key: `k${i}`, poly: q, use: hit?.bl.use ?? plan.default_use ?? "mixed", density: opts.density ?? hit?.bl.density ?? (hit?.bl.floors ? (hit.bl.floors >= 12 ? "very_high" : hit.bl.floors >= 5 ? "high" : hit.bl.floors >= 3 ? "medium" : "low") : defaultDensity), floors: hit?.bl.floors, label: hit?.bl.label };
  });

  // ---- 5. sub-builders: blocks are disjoint and outside every right-of-way, so each is placed in its
  // own builder and merged (collision checks scan one block's entities, as in designNeighborhood)
  const sub = (fn: (sb: OpBuilder) => void) => {
    const sb = new OpBuilder(world, b.author, b.tag);
    fn(sb);
    for (const op of sb.ops()) {
      if (op.type === "add") b.add(op.entity);
      else if (op.type === "remove") b.remove(op.entity.id);
      else b.update(op.after);
    }
  };
  const brng = rng.fork(99);

  // ---- 6. parks, greens, plazas, parking
  let parks = 0,
    plazas = 0;
  const openNames: string[] = [];
  for (const o of openPolys) {
    const qs = minus(o.poly, ko, 60);
    for (const q of qs) {
      sub((sb) => {
        let r;
        if (o.kind === "plaza") r = placePrimitive(world, { def: "parks.plaza", params: { centre: "fountain", treeSpacing: 9 }, site: q, name: o.name ?? "Town Square", onConflict: "safe", lenient: true }, actor, sb);
        else if (o.kind === "parking") r = createArea(world, { type: "parking", poly: q, name: o.name }, actor, sb);
        else if (o.kind === "forest") r = placePrimitive(world, { def: "flora.woodland", site: q, name: o.name, onConflict: "safe", lenient: true }, actor, sb);
        else r = placePrimitive(world, { def: "parks.park", params: { paths: "both", playground: polyArea(q) > 6000, benches: Math.min(16, Math.round(polyArea(q) / 1500) + 2), pavilion: polyArea(q) > 15000, flowerBeds: 3, treeSpacing: 14, treeCover: o.kind === "green" ? 35 : 60, seed: brng.int(1, 9999) }, site: q, name: o.name, onConflict: "safe", lenient: true }, actor, sb);
        if (!r.ok) addArea(sb, o.kind === "plaza" ? "plaza" : o.kind === "parking" ? "parking" : "park", q, o.name);
      });
      if (o.kind === "plaza") plazas++;
      else if (o.kind !== "parking") parks++;
    }
    if (o.name) openNames.push(o.name);
  }

  // ---- 7. facilities on their blocks
  const reservations: Reservation[] = [];
  const placedFacilities: { kind: FacilityKind; name: string; def: string }[] = [];
  const facilitySites: { piece: Piece; site: Polygon; f: (typeof plan.facilities)[number] }[] = [];
  for (const f of plan.facilities) {
    const at = F.toWorld(f.at);
    const piece = pieces.find((p) => pointInPoly(at, p.poly)) ?? pieces.slice().sort((x, y) => dist(polyCentroid(x.poly), at) - dist(polyCentroid(y.poly), at))[0];
    if (!piece || dist(polyCentroid(piece.poly), at) > 400) continue;
    const spec = FACILITY[f.kind];
    let site: Polygon | null = null;
    if (f.poly) site = (Wpoly(f.poly) && clip(Wpoly(f.poly)!, piece.poly, 100).sort((x, y) => polyArea(y) - polyArea(x))[0]) || null;
    if (!site) {
      const box = obb(piece.poly[0]);
      const sw = spec.w + 16,
        sd = spec.d + 16;
      if (polyArea(piece.poly) < sw * sd * 1.7) site = piece.poly;
      else {
        // centred on the drawn point, pulled inside the block
        const c: Vec2 = pointInPoly(at, piece.poly) ? at : polyCentroid(piece.poly);
        site = clip([rectangle(c, Math.min(sw, box.length), Math.min(sd, box.width), box.angle)], piece.poly, 100).sort((x, y) => polyArea(y) - polyArea(x))[0] ?? null;
      }
    }
    if (!site || polyArea(site) < 300) continue;
    if (reservations.some((r) => r.block === piece.key && intersection(r.poly, site!).some((x) => polyArea(x) > 20))) continue;
    reservations.push({ block: piece.key, edge: 0, s0: 0, s1: 0, depth: 0, kind: f.kind, poly: site });
    facilitySites.push({ piece, site, f });
  }

  // ---- 8. the fabric, grouped by use and density (one programme per group)
  const industrial = pieces.filter((p) => p.use === "industrial");
  const fabricPieces = pieces.filter((p) => p.use !== "industrial" && !reservations.some((r) => r.block === p.key && polyArea(r.poly) > polyArea(p.poly) * 0.85));
  const groups = new Map<string, Piece[]>();
  for (const p of fabricPieces) {
    const k = `${p.use}|${p.density}|${p.floors ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const R = Math.max(F.W, F.H) / 2;
  const typCount = new Map<string, number>();
  let garages = 0;
  const allBlocks: Block[] = [];
  for (const [, ps] of groups) {
    const { use, density, floors } = ps[0];
    const blocks = ps.map((p) => analyseBlock(p.key, p.poly, refs));
    allBlocks.push(...blocks);
    const land = blocks.reduce((s, x) => s + x.area, 0);
    const prog = resolveProgramme({ area: ps[0].poly, density, maxFloors: floors ? floors + 1 : undefined, minFloors: floors ? Math.max(1, floors - 2) : undefined, openSpace: 0 }, land, hh);
    const uf = USE_FABRIC[use];
    const [lo, hi] = INTENSITY_RANGE[density];
    const intensity = lo + (hi - lo) * (use === "commercial" || use === "office" ? 0.75 : 0.62);
    const parksAll = [...openPolys.map((o) => o.poly)];
    const base = { prog, centre: F.centre, radius: R * 0.9, seed: seed + hashStr(use + density) % 1000, palette, parks: parksAll, reservations, officeJobs: uf.office > 0 ? (land * (density === "low" ? 0.4 : density === "medium" ? 1.1 : 2.4) * uf.office) / 23 : 0, shops: uf.shops, retailShare: uf.retail };
    const plan0 = planFabric(blocks, { ...base, intensity });
    applyRetail(plan0, { ...base, intensity });
    const lotsBy = new Map<string, typeof plan0.lots>();
    for (const l of plan0.lots) lotsBy.set(l.block, [...(lotsBy.get(l.block) ?? []), l]);
    const coresBy = new Map<string, typeof plan0.cores>();
    for (const c of plan0.cores) coresBy.set(c.block, [...(coresBy.get(c.block) ?? []), c]);
    const suburban = density === "low" && use === "residential";
    for (const blk of blocks) {
      sub((sb) => {
        for (const lot of lotsBy.get(blk.key) ?? []) {
          const pl = lotPlacement(lot, brng, palette, suburban);
          if (!pl) continue;
          const r = placePrimitive(world, { def: pl.def, params: pl.params, site: pl.site, at: pl.at, rotation: pl.rotation, onConflict: "safe", lenient: true }, actor, sb);
          if (!r.ok) continue;
          typCount.set(lot.t.label, (typCount.get(lot.t.label) ?? 0) + 1);
          for (const y of lot.yard) yardTree(sb, y, brng);
        }
        for (const c of coresBy.get(blk.key) ?? []) {
          if (c.garage) {
            const site = insetPoly(c.poly, 1.2);
            if (site && isValidPoly(site)) {
              const r = placePrimitive(world, { def: "transport.parking_garage", params: { shape: "site", floors: brng.int(4, 6), facade: brng.pick(["concrete", "precast_white", "brick_buff"]), greenRoof: brng.chance(0.3) }, site, rotation: 0, onConflict: "safe", lenient: true }, actor, sb);
              if (r.ok) {
                garages++;
                continue;
              }
            }
          }
          courtyardTrees(sb, c.poly, c.family, brng);
        }
        const cut: Polygon[] = reservations.filter((r) => r.block === blk.key).map((r) => r.poly);
        for (const e of sb.touched()) {
          if (e.kind === "building") cut.push((e as Building).footprint);
          else if (e.kind === "area") cut.push((e as Area).poly);
        }
        for (const g of minusAll(blk.poly, cut)) addArea(sb, "grass", g, polyArea(g) > 1500 ? "Courtyard garden" : undefined);
      });
    }
  }

  // ---- 9. industrial blocks: sheds along the frontage, yards behind
  for (const p of industrial) {
    const blk = analyseBlock(p.key, p.poly, refs);
    const front = blk.edges.slice().sort((x, y) => y.f.len - x.f.len)[0];
    if (!front) continue;
    sub((sb) => {
      const [s0, s1, , t1] = efExtent(front.f, p.poly);
      const depth = Math.min(90, Math.max(30, t1 - 14));
      const n = Math.max(1, Math.round((s1 - s0) / 95));
      const w = (s1 - s0) / n;
      for (let k = 0; k < n; k++) {
        const def = brng.weighted(["industrial.warehouse", "industrial.factory", "industrial.workshop"], [0.5, 0.3, 0.2]);
        const sw = Math.max(20, w - 14),
          sd = Math.max(20, depth - 16);
        const at = front.f.a.map((v, i) => v + front.f.u[i] * (s0 + w * (k + 0.5)) + front.f.n[i] * (10 + sd / 2)) as Vec2;
        if (!pointInPoly(at, p.poly)) continue;
        placePrimitive(world, { def, params: { width: Math.min(sw, 120), depth: Math.min(sd, 80) }, at, rotation: ((Math.atan2(-front.f.n[1], -front.f.n[0]) * 180) / Math.PI - 90 + 360) % 360, onConflict: "safe", lenient: true }, actor, sb);
      }
      const cut: Polygon[] = [];
      for (const e of sb.touched()) if (e.kind === "building") cut.push(bufferPoly((e as Building).footprint, 1));
      for (const g of minusAll(p.poly, cut)) addArea(sb, polyArea(g) > 2500 ? "parking" : "grass", g);
    });
  }

  // ---- 10. facilities (after the fabric: their sites were reserved from it)
  for (const { piece, site, f } of facilitySites) {
    const spec = FACILITY[f.kind];
    const label = f.label && !/^(school|hospital|station|fire|police|library|park)$/i.test(f.label.trim()) ? titleCase(f.label) : `${name} ${spec.label}`.replace(/^Sketch /, "");
    const blk = analyseBlock(`${piece.key}f`, site, refs);
    const front = blk.edges.slice().sort((x, y) => roleW(y.role) - roleW(x.role) || y.f.len - x.f.len)[0];
    const heading = front ? ((Math.atan2(-front.f.n[1], -front.f.n[0]) * 180) / Math.PI - 90 + 360) % 360 : 0;
    sub((sb) => {
      let r;
      if (spec.site) {
        const params = f.kind === "school" ? { level: /high/i.test(f.label ?? "") ? "high" : /middle|junior/i.test(f.label ?? "") ? "middle" : "primary", seed: brng.int(1, 9999), name: label } : f.kind === "university" ? { ...spec.params, seed: brng.int(1, 9999), name: label } : { ...spec.params, seed: brng.int(1, 9999) };
        r = placePrimitive(world, { def: spec.def, params, site, rotation: heading, name: label, onConflict: "safe", lenient: true }, actor, sb);
      } else {
        // a point-placed building: fit its footprint to the site, facing the best street
        const fr = front ? efExtent(front.f, site) : [0, spec.w, 0, spec.d];
        const along = fr[1] - fr[0],
          across = fr[3] - fr[2];
        const width = Math.max(12, Math.min(spec.w, along - 8)),
          depth = Math.max(10, Math.min(spec.d, across - 8));
        const c = polyCentroid(site);
        r = placePrimitive(world, { def: spec.def, params: { ...spec.params, width, depth, name: label }, at: c, rotation: heading, name: label, onConflict: "safe", lenient: true }, actor, sb);
      }
      if (r.ok) placedFacilities.push({ kind: f.kind, name: label, def: spec.def });
      const cut: Polygon[] = [];
      for (const e of sb.touched()) if (e.kind === "building") cut.push((e as Building).footprint);
      else if (e.kind === "area") cut.push((e as Area).poly);
      for (const g of minusAll(site, cut)) addArea(sb, "grass", g);
    });
  }

  // ---- 11. street trees on the new streets
  const created = built.map((x) => ({ s: b.get<Street>(x.id), role: x.role })).filter((x): x is { s: Street; role: StreetRole } => !!x.s && x.s.cls !== "pedestrian");
  const junctions = b.touched().filter((e): e is StreetNode => e.kind === "node").map((n) => n.p);
  let trees = 0;
  const speciesBy = new Map<string, string>();
  for (const { s, role } of created) {
    const species = speciesBy.get(s.name ?? s.id) ?? makeRng(seed ^ hashStr(s.name ?? s.id)).pick(TREE_SPECIES[role]);
    speciesBy.set(s.name ?? s.id, species);
    const { cands } = streetTreeCandidates(world, [s], role === "local" ? 10 : 9);
    for (const c of cands) {
      if (junctions.some((j) => dist(j, c.p) < 12)) continue;
      if (waterPolys.some((w) => pointInPoly(c.p, w))) continue;
      const sp = SPECIES_SIZE[species] ?? { r: 4, h: 9 };
      b.add<Tree>({ id: newId("t"), kind: "tree", p: c.p, r: sp.r, h: sp.h, species, streetId: s.id, source: `${SOURCE}: street tree`, provenance: "proposed", createdBy: b.tag });
      trees++;
    }
  }

  // ---- 12. report
  let homes = 0,
    jobs = 0,
    nb = 0;
  for (const e of b.touched()) {
    if (e.kind !== "building") continue;
    const p = programmeOf(e as Building, hh);
    homes += p.units;
    jobs += p.jobs;
    nb++;
  }
  if (!nb && !built.length && !waterPolys.length && !parks) return b.fail("Nothing from the sketch could be built here");
  const byClass = (c: StreetClass) => new Set(built.filter((x) => x.cls === c).map((x) => x.name)).size;
  const streetWords = (["arterial", "collector", "local", "pedestrian"] as StreetClass[]).filter((c) => byClass(c)).map((c) => `${byClass(c)} ${c === "arterial" ? "avenue" : c === "local" ? "local street" : c === "pedestrian" ? "pedestrian street" : "collector"}${byClass(c) > 1 ? "s" : ""}`).join(", ");
  const areaM2 = polyArea(region);
  b.report.summary.unshift(
    `${name}: ${fmtNum(nb)} buildings, ≈${fmtNum(homes)} homes (≈${fmtNum(homes * hh)} residents), ≈${fmtNum(jobs)} jobs on ${fmtAcres(areaM2)}`,
    `Streets: ${streetWords || "none drawn"} (${fmtLen(streetLen)} in all${infill ? `, incl. ${infill} local infill street${infill > 1 ? "s" : ""} in very large blocks` : ""})`,
    `Open space: ${parks} park${parks === 1 ? "" : "s"}${plazas ? `, ${plazas} plaza${plazas > 1 ? "s" : ""}` : ""}${waterPolys.length ? `, ${waterPolys.length} water bod${waterPolys.length > 1 ? "ies" : "y"}` : ""}; ${fmtNum(trees)} street trees${placedFacilities.length ? `; ${placedFacilities.map((f) => f.name).join(", ")}` : ""}${lines ? `; ${lines} transit line${lines > 1 ? "s" : ""}` : ""}`,
  );
  const missing = plan.facilities.length - placedFacilities.length;
  if (missing > 0) b.warn(`${missing} of ${plan.facilities.length} facilities from the sketch had no buildable site and were left out`);
  if (standing.length && !opts.replaceExisting) b.warn(`Built around ${standing.length} existing building${standing.length > 1 ? "s" : ""} on the site (nothing demolished)`);
  if (demolished) b.summary(`Replaced ${demolished} existing buildings`);
  b.data = {
    name,
    homes: Math.round(homes),
    residents: Math.round(homes * hh),
    jobs: Math.round(jobs),
    buildings: nb,
    streets: { arterial: byClass("arterial"), collector: byClass("collector"), local: byClass("local"), pedestrian: byClass("pedestrian"), infill },
    parks,
    plazas,
    water: waterPolys.length,
    transit_lines: lines,
    facilities: placedFacilities.map((f) => ({ kind: f.kind, name: f.name })),
    typologies: Object.fromEntries(typCount),
    parking_structures: garages,
    street_trees: trees,
    blocks: allBlocks.length + industrial.length,
    palette,
    seed,
    placement: { centre: [Math.round(F.centre[0]), Math.round(F.centre[1])], width_m: Math.round(F.W), height_m: Math.round(F.H), rotation_deg: Math.round((F.angle * 180) / Math.PI) },
    bbox: polyBBox(F.outline).map(Math.round),
  };
  return b.finish(`Build sketch: ${name}`);
}

const roleW = (r: StreetRole | "none") => ({ boulevard: 5, avenue: 4, main: 3.5, collector: 3, local: 2, none: 0 })[r];
const titleCase = (s: string) => s.trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export type { Rng };
