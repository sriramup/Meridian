// critiqueArea: a design scorecard for any area of the world (a generated neighbourhood, an agent's
// edits, or measured Austin blocks), with the top issues located on the map.
//
// Metrics and the standards behind their targets:
//  - Unbuilt land: share of block land (outside street right-of-way) that is neither building,
//    landscaped / public open space, civic grounds nor parking — bare lots read as unfinished.
//  - Coverage and FAR (gross floor area / block land) against the area's apparent intensity.
//  - Diversity: building types, heights, footprints and facades; a "repetition" share of the single
//    most common building signature (type + floors + footprint size).
//  - Street-wall continuity on main streets (arterials, collectors, main streets): share of frontage
//    with a building within ≈ 25 ft of the property line; form-based codes ask 70–80 % build-to.
//  - Park access: homes within a ¼ mi (400 m) walk of a park or plaza (Trust for Public Land
//    walk-access metric, tightened for dense areas); distances use a 1.2 network detour factor.
//  - School access: homes within ½ mi of a primary school; within 1 mi of any school.
//  - Blocks: average perimeter ≤ 1,500 ft and block faces ≤ 600 ft (LEED-ND Neighborhood Pattern
//    & Design credit 6; superblocks for schools / campuses are allowed).
//  - Connectivity: ≥ 140 intersections per sq mi (LEED-ND), few dead ends.
//  - Street standards: sidewalks on every street, bike facilities on collectors and arterials, street
//    trees on arterials (NACTO Urban Street Design Guide).
//  - Height gradient: towers belong on arterials / centres, not on local-only frontage; abrupt jumps
//    next to houses are flagged.

import { sectionWidth } from "@/geometry/crossSection";
import { difference, isValidPoly, obb, perimeter, pointInPoly, polyArea, polyBBox, polyCentroid } from "@/geometry/polygon";
import { closestOnPath, offsetPath, pointAt, polyLength } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import { fmtAcres, fmtFt, fmtNum, toAcres, toSqMi } from "@/lib/units";
import type { Area, Building, Polygon, Prop, Street, StreetNode, Vec2 } from "@/world/types";
import type { World } from "@/world/world";
import { programmeOf } from "@/world/ops/core";
import { streetBand } from "@/world/ops/validate";

export interface Metric {
  key: string;
  label: string;
  /** display value (imperial) */
  value: string;
  raw: number;
  /** 0–100 */
  score: number;
  target: string;
}

export interface DesignIssue {
  severity: "high" | "medium" | "low";
  metric: string;
  message: string;
  /** local metres */
  at: Vec2;
}

export interface Scorecard {
  overall: number;
  grade: "A" | "B" | "C" | "D" | "F";
  metrics: Metric[];
  issues: DesignIssue[];
  stats: {
    area_acres: number;
    block_land_acres: number;
    buildings: number;
    homes: number;
    residents: number;
    jobs: number;
    gfa_sqft: number;
    far: number;
    coverage: number;
    bare_share: number;
    homes_per_acre_gross: number;
    homes_per_acre_net: number;
    building_types: number;
    distinct_heights: number;
    repetition: number;
    street_wall: number;
    park_access: number;
    school_access: number;
    avg_block_perimeter_ft: number;
    intersections_per_sqmi: number;
    dead_ends: number;
  };
}

const WALK = 1.2; // network detour factor
const PUBLIC_OPEN = new Set<Area["type"]>(["park", "plaza", "pitch", "wood", "water", "cemetery"]);
const LANDSCAPED = new Set<Area["type"]>(["grass", "raingarden", "permeable", "retention"]);
const RANK: Record<string, number> = { motorway: 6, trunk: 5, primary: 5, secondary: 4, tertiary: 3, residential: 1, living: 1, service: 0, pedestrian: 0, busway: 2, motorway_link: 4 };

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** linear score: 100 at `good`, 0 at `bad` (either direction) */
const lin = (x: number, good: number, bad: number) => Math.round(100 * clamp01((x - bad) / (good - bad)));

export interface CritiqueOptions {
  /** sample spacing (m) for the land-use raster; default adapts to the area */
  cell?: number;
  /** max issues returned */
  maxIssues?: number;
}

export function critiqueArea(world: World, area: Polygon, o: CritiqueOptions = {}): Scorecard {
  const A = polyArea(area);
  const bb = polyBBox(area);
  const pad = 60;
  const qbb: [number, number, number, number] = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad];
  const streets = world.query(qbb, ["street"]).map((e) => e as Street).filter((s) => !s.tunnel && s.cls !== "motorway" && s.cls !== "motorway_link");
  const buildings = world.query(bb, ["building"]).map((e) => e as Building).filter((b) => pointInPoly(polyCentroid(b.footprint), area));
  const areas = world.query(qbb, ["area"]).map((e) => e as Area);
  const bands = streets.map((s) => ({ s, band: streetBand(s), bb: polyBBox(streetBand(s)) }));
  const issues: DesignIssue[] = [];

  // ---- land-use raster
  const cell = o.cell ?? Math.max(4, Math.sqrt(A / 40000));
  const nx = Math.ceil((bb[2] - bb[0]) / cell),
    ny = Math.ceil((bb[3] - bb[1]) / cell);
  const cls = new Int8Array(nx * ny).fill(-1); // -1 outside, 0 bare, 1 building, 2 street, 3 public open, 4 landscaped, 5 civic grounds, 6 parking, 7 furnished
  let nIn = 0;
  const counts = new Array(8).fill(0);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const p: Vec2 = [bb[0] + (i + 0.5) * cell, bb[1] + (j + 0.5) * cell];
      if (!pointInPoly(p, area)) continue;
      nIn++;
      const k = classify(world, p, bands);
      cls[j * nx + i] = k;
      counts[k]++;
    }
  const cellA = cell * cell;
  const blockLand = (nIn - counts[2]) * cellA;
  const bare = counts[0] * cellA;
  const bareShare = blockLand > 0 ? bare / blockLand : 0;
  // bare clusters → issues
  const seen = new Uint8Array(nx * ny);
  for (let s = 0; s < nx * ny; s++) {
    if (cls[s] !== 0 || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let n = 0,
      sx = 0,
      sy = 0;
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      sx += c % nx;
      sy += Math.floor(c / nx);
      for (const d of [1, -1, nx, -nx]) {
        const q = c + d;
        if (q < 0 || q >= nx * ny || seen[q] || cls[q] !== 0) continue;
        if ((d === 1 && q % nx === 0) || (d === -1 && c % nx === 0)) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (n * cellA >= 1200) issues.push({ severity: n * cellA > 5000 ? "high" : "medium", metric: "bare_land", message: `${fmtAcres(n * cellA, 2)} of bare, unprogrammed land`, at: [bb[0] + (sx / n + 0.5) * cell, bb[1] + (sy / n + 0.5) * cell] });
  }

  // ---- programme
  let homes = 0,
    jobs = 0,
    gfa = 0,
    fp = 0;
  const hh = world.meta.calibration?.householdSize ?? 2.5;
  const progs = new Map<string, ReturnType<typeof programmeOf>>();
  for (const b of buildings) {
    const p = programmeOf(b, hh);
    progs.set(b.id, p);
    homes += p.units;
    jobs += p.jobs;
    gfa += p.gfa;
    fp += polyArea(b.footprint);
  }
  const far = blockLand > 0 ? gfa / blockLand : 0;
  const coverage = blockLand > 0 ? (counts[1] * cellA) / blockLand : 0;
  const urban = far >= 1;

  // ---- diversity
  const sig = new Map<string, number>();
  const types = new Map<string, number>();
  const floorsSet = new Set<number>();
  const facades = new Set<string>();
  const heights: number[] = [];
  const fps: number[] = [];
  for (const b of buildings) {
    const t = b.lib?.def ?? `${b.use}:${b.floors <= 2 ? "low" : b.floors <= 6 ? "mid" : "high"}`;
    types.set(t, (types.get(t) ?? 0) + 1);
    floorsSet.add(b.floors);
    if (b.style?.color) facades.add(b.style.color.join(","));
    heights.push(b.height);
    fps.push(polyArea(b.footprint));
    const k = `${t}|${b.floors}|${Math.round(polyArea(b.footprint) / 60)}`;
    sig.set(k, (sig.get(k) ?? 0) + 1);
  }
  const N = buildings.length;
  const repetition = N ? Math.max(...sig.values()) / N : 0;
  const evenness = types.size > 1 ? -[...types.values()].reduce((s, n) => s + (n / N) * Math.log(n / N), 0) / Math.log(types.size) : 0;
  const cv = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) / Math.max(1e-6, m);
  };
  const diversityScore = N < 4 ? (N ? 60 : 0) : Math.round(0.3 * lin(types.size, 6, 1) + 0.2 * lin(evenness, 0.75, 0.2) + 0.2 * lin(repetition, 0.08, 0.5) + 0.15 * lin(floorsSet.size, 8, 1) + 0.15 * lin(Math.min(cv(fps), 1.2), 0.8, 0.05));
  if (N >= 10 && repetition > 0.25) {
    const top = [...sig.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const ex = buildings.find((b) => `${b.lib?.def ?? `${b.use}:${b.floors <= 2 ? "low" : b.floors <= 6 ? "mid" : "high"}`}|${b.floors}|${Math.round(polyArea(b.footprint) / 60)}` === top)!;
    issues.push({ severity: repetition > 0.45 ? "high" : "medium", metric: "diversity", message: `${Math.round(repetition * 100)}% of buildings are the same type, height and size`, at: polyCentroid(ex.footprint) });
  }

  // ---- street wall on main streets
  let wallHit = 0,
    wallMiss = 0;
  const gapRuns: { at: Vec2; len: number; name: string }[] = [];
  for (const s of streets) {
    if ((RANK[s.cls] ?? 0) < 3) continue;
    const half = sectionWidth(s.section) / 2;
    const L = polyLength(s.path);
    for (const side of [1, -1]) {
      const line = offsetPath(s.path, side * (half + 3));
      const deep = offsetPath(s.path, side * (half + 8));
      let run = 0,
        runAt: Vec2 | null = null;
      for (let d = 8; d < L - 8; d += 6) {
        const p = pointAt(line, d).p,
          q = pointAt(deep, d).p;
        if (!pointInPoly(p, area)) continue;
        const k1 = classify(world, p, bands),
          k2 = classify(world, q, bands);
        if (k1 === 2) continue; // crossing street
        if (k1 === 1 || k2 === 1) {
          wallHit++;
          if (run >= 30 && runAt) gapRuns.push({ at: runAt, len: run, name: s.name ?? "main street" });
          run = 0;
          runAt = null;
        } else if (k1 === 3 || k1 === 5 || k2 === 3 || k2 === 5) {
          // intentional open frontage: parks, plazas, school and campus grounds
          if (run >= 30 && runAt) gapRuns.push({ at: runAt, len: run, name: s.name ?? "main street" });
          run = 0;
          runAt = null;
        } else {
          wallMiss++;
          run += 6;
          if (!runAt) runAt = p;
        }
      }
      if (run >= 30 && runAt) gapRuns.push({ at: runAt, len: run, name: s.name ?? "main street" });
    }
  }
  const wall = wallHit + wallMiss > 0 ? wallHit / (wallHit + wallMiss) : 1;
  if (urban) for (const g of gapRuns.sort((a, b) => b.len - a.len).slice(0, 4)) issues.push({ severity: g.len > 80 ? "medium" : "low", metric: "street_wall", message: `${fmtFt(g.len)} gap in the street wall on ${g.name}`, at: g.at });

  // ---- park and school access (home-weighted)
  const parks = areas.filter((a) => (a.type === "park" || a.type === "plaza") && polyArea(a.poly) >= 300);
  const schools = buildings.concat(world.query(qbb, ["building"]).map((e) => e as Building).filter((b) => !buildings.includes(b))).filter((b) => b.use === "education" || (b.program.education ?? 0) > 0.5);
  const isPrimary = (b: Building) => /elementary|primary/i.test(b.name ?? "") || b.lib?.def === "education.elementary_school" || (b.lib?.def === "composites.urban_school" && b.lib.params.level === "primary");
  const primaries = schools.filter(isPrimary);
  let homesPark = 0,
    homesSchool = 0;
  const farFromPark: { at: Vec2; homes: number }[] = [];
  for (const b of buildings) {
    const u = progs.get(b.id)!.units;
    if (u <= 0) continue;
    const c = polyCentroid(b.footprint);
    const dp = parks.reduce((m, a) => Math.min(m, distToPolyFast(c, a.poly)), Infinity) * WALK;
    if (dp <= 402) homesPark += u;
    else farFromPark.push({ at: c, homes: u });
    const ds = primaries.reduce((m, s) => Math.min(m, dist(c, polyCentroid(s.footprint))), Infinity) * WALK;
    if (ds <= 805) homesSchool += u;
  }
  const parkAccess = homes > 0 ? homesPark / homes : 1;
  const schoolAccess = homes > 0 ? homesSchool / homes : 1;
  if (farFromPark.length && parkAccess < 0.97) {
    const sx = farFromPark.reduce((s, f) => s + f.at[0] * f.homes, 0),
      sy = farFromPark.reduce((s, f) => s + f.at[1] * f.homes, 0),
      sh = farFromPark.reduce((s, f) => s + f.homes, 0);
    issues.push({ severity: parkAccess < 0.75 ? "high" : "medium", metric: "park_access", message: `${fmtNum(sh)} homes are more than a ¼-mile walk from a park or plaza`, at: [sx / sh, sy / sh] });
  }
  if (homes > 400 && schoolAccess < 0.8) issues.push({ severity: primaries.length ? "medium" : "high", metric: "school_access", message: primaries.length ? `${Math.round((1 - schoolAccess) * 100)}% of homes are over ½ mile from a primary school` : "No primary school serves this area", at: polyCentroid(area) });

  // ---- blocks
  let blocks: Polygon[] = [area];
  for (const x of bands) blocks = blocks.flatMap((q) => (overlapsBB(polyBBox(q), x.bb) ? difference(q, x.band) : [q]));
  blocks = blocks.filter((q) => isValidPoly(q) && polyArea(q) > 400);
  const civicLand = (q: Polygon) => areas.some((a) => (a.type === "campus" || a.type === "park" || a.type === "pitch") && polyArea(a.poly) > 0.4 * polyArea(q) && pointInPoly(polyCentroid(a.poly), q));
  const perims = blocks.map((q) => perimeter(q[0]));
  const avgPerim = perims.length ? perims.reduce((s, x) => s + x, 0) / perims.length : 0;
  for (const q of blocks) {
    const box = obb(q[0]);
    if (box.length > 183 && !civicLand(q) && urban) issues.push({ severity: box.length > 260 ? "medium" : "low", metric: "blocks", message: `Block face of ${fmtFt(box.length)} (urban blocks ≤ 600 ft)`, at: polyCentroid(q) });
  }

  // ---- connectivity
  const nodes = world.query(bb, ["node"]).map((e) => e as StreetNode).filter((n) => pointInPoly(n.p, area) || distToRing(n.p, area[0]) < 25);
  const deg = (n: StreetNode) => world.incident(n.id).filter((s) => s.cls !== "service" && !s.private).length;
  const inter = nodes.filter((n) => deg(n) >= 3).length;
  const deadEnds = nodes.filter((n) => deg(n) === 1 && distToRing(n.p, area[0]) > 30);
  const sqmi = toSqMi(A);
  const iDensity = sqmi > 0 ? inter / sqmi : 0;
  for (const n of deadEnds.slice(0, 3)) issues.push({ severity: "low", metric: "connectivity", message: "Dead-end street", at: n.p });

  // ---- street standards
  let segOk = 0,
    segN = 0;
  const flagged = new Set<string>();
  for (const s of streets) {
    if (!pointInPoly(pointAt(s.path, polyLength(s.path) / 2).p, area) && distToRing(pointAt(s.path, polyLength(s.path) / 2).p, area[0]) > 20) continue;
    if (s.cls === "service" || s.private || s.cls === "pedestrian") continue;
    segN++;
    const types = new Set(s.section.strips.map((x) => x.type));
    const rank = RANK[s.cls] ?? 1;
    const problems: string[] = [];
    if (!types.has("sidewalk") && !types.has("plaza")) problems.push("has no sidewalk");
    if (rank >= 3 && !types.has("bike") && !types.has("cycletrack")) problems.push("has no bike facility");
    if (rank >= 4 && !s.section.strips.some((x) => x.type === "planting" && x.trees) && !types.has("median")) problems.push("has no street trees");
    if (!problems.length) segOk++;
    else if (!flagged.has(s.name ?? s.id)) {
      flagged.add(s.name ?? s.id);
      issues.push({ severity: "low", metric: "streets", message: `${s.name ?? "A street"} ${problems.join(" and ")}`, at: pointAt(s.path, polyLength(s.path) / 2).p });
    }
  }
  const streetStd = segN ? segOk / segN : 1;

  // ---- height gradient
  let badTowers = 0,
    jumps = 0,
    gradOk = 0,
    gradN = 0;
  for (const b of buildings) {
    if (b.floors < 4) continue;
    const c = polyCentroid(b.footprint);
    let best = 0;
    for (const x of bands) {
      if (!overlapsBB(x.bb, [c[0] - 60, c[1] - 60, c[0] + 60, c[1] + 60])) continue;
      const d = closestOnPath(c, x.s.path).d - sectionWidth(x.s.section) / 2;
      if (d < 45) best = Math.max(best, RANK[x.s.cls] ?? 0);
    }
    gradN++;
    if (b.floors >= 12 && best < 3) {
      badTowers++;
      if (badTowers <= 2) issues.push({ severity: "medium", metric: "height_gradient", message: `${b.floors}-floor tower on local streets only`, at: c });
    } else gradOk++;
  }
  for (let i = 0; i < buildings.length; i++) {
    const a = buildings[i];
    if (a.floors > 2) continue;
    const ca = polyCentroid(a.footprint);
    for (const e of world.query([ca[0] - 25, ca[1] - 25, ca[0] + 25, ca[1] + 25], ["building"])) {
      const o2 = e as Building;
      if (o2.id === a.id || o2.floors < 12) continue;
      jumps++;
      if (jumps <= 2) issues.push({ severity: "low", metric: "height_gradient", message: `${o2.floors}-floor building beside a ${a.floors}-floor house`, at: ca });
      break;
    }
  }
  const gradient = gradN ? (gradOk / gradN) * (1 - Math.min(0.5, jumps / Math.max(1, N))) : 1;

  // ---- metrics
  const covGood = urban ? [0.35, 0.7] : [0.12, 0.45];
  const covScore = coverage >= covGood[0] && coverage <= covGood[1] ? 100 : coverage < covGood[0] ? lin(coverage, covGood[0], 0) : lin(coverage, covGood[1], 0.95);
  const metrics: Metric[] = [
    { key: "bare_land", label: "Unbuilt land", value: `${(bareShare * 100).toFixed(1)}%`, raw: bareShare, score: lin(bareShare, 0.02, 0.25), target: "≤ 2% of block land" },
    { key: "coverage", label: "Building coverage", value: `${Math.round(coverage * 100)}%`, raw: coverage, score: covScore, target: urban ? "35–70% (urban)" : "12–45% (suburban)" },
    { key: "far", label: "Floor-area ratio", value: far.toFixed(2), raw: far, score: N ? 100 : 0, target: "matches the brief" },
    { key: "diversity", label: "Building diversity", value: `${types.size} types, ${floorsSet.size} heights, ${Math.round(repetition * 100)}% repeat`, raw: diversityScore / 100, score: diversityScore, target: "≥ 6 types, ≤ 10% repeat" },
    { key: "street_wall", label: "Street wall (main streets)", value: `${Math.round(wall * 100)}%`, raw: wall, score: urban ? lin(wall, 0.75, 0.3) : 100, target: urban ? "≥ 75% build-to frontage" : "n/a (suburban)" },
    { key: "park_access", label: "Park within ¼ mi", value: `${Math.round(parkAccess * 100)}% of homes`, raw: parkAccess, score: lin(parkAccess, 0.98, 0.5), target: "≥ 98% of homes" },
    { key: "school_access", label: "Primary school within ½ mi", value: `${Math.round(schoolAccess * 100)}% of homes`, raw: schoolAccess, score: homes > 400 ? lin(schoolAccess, 0.9, 0.3) : 100, target: "≥ 90% of homes" },
    { key: "blocks", label: "Average block perimeter", value: fmtFt(avgPerim), raw: avgPerim, score: lin(avgPerim, 457, 900), target: "≤ 1,500 ft" },
    { key: "connectivity", label: "Intersections per sq mi", value: fmtNum(iDensity), raw: iDensity, score: lin(iDensity, 160, 40), target: "≥ 140" },
    { key: "streets", label: "Street standards", value: `${Math.round(streetStd * 100)}% of segments`, raw: streetStd, score: Math.round(streetStd * 100), target: "sidewalks, bikes on collectors, trees on arterials" },
    { key: "height_gradient", label: "Height gradient", value: `${badTowers} misplaced towers, ${jumps} abrupt jumps`, raw: gradient, score: Math.round(gradient * 100), target: "towers on arterials / centre" },
  ];
  const W: Record<string, number> = { bare_land: 15, coverage: 7, far: 3, diversity: 15, street_wall: 10, park_access: 12, school_access: 6, blocks: 10, connectivity: 8, streets: 7, height_gradient: 7 };
  const overall = Math.round(metrics.reduce((s, m) => s + m.score * W[m.key], 0) / metrics.reduce((s, m) => s + W[m.key], 0));
  const sev = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => sev[a.severity] - sev[b.severity]);
  const acres = toAcres(A);
  return {
    overall,
    grade: overall >= 85 ? "A" : overall >= 72 ? "B" : overall >= 58 ? "C" : overall >= 45 ? "D" : "F",
    metrics,
    issues: issues.slice(0, o.maxIssues ?? 10).map((i) => ({ ...i, at: [Math.round(i.at[0]), Math.round(i.at[1])] as Vec2 })),
    stats: {
      area_acres: round1(acres),
      block_land_acres: round1(toAcres(blockLand)),
      buildings: N,
      homes: Math.round(homes),
      residents: Math.round(homes * hh),
      jobs: Math.round(jobs),
      gfa_sqft: Math.round(gfa * 10.7639),
      far: Math.round(far * 100) / 100,
      coverage: Math.round(coverage * 1000) / 1000,
      bare_share: Math.round(bareShare * 1000) / 1000,
      homes_per_acre_gross: round1(homes / Math.max(1e-6, acres)),
      homes_per_acre_net: round1(homes / Math.max(1e-6, toAcres(blockLand))),
      building_types: types.size,
      distinct_heights: floorsSet.size,
      repetition: Math.round(repetition * 1000) / 1000,
      street_wall: Math.round(wall * 1000) / 1000,
      park_access: Math.round(parkAccess * 1000) / 1000,
      school_access: Math.round(schoolAccess * 1000) / 1000,
      avg_block_perimeter_ft: Math.round(avgPerim / 0.3048),
      intersections_per_sqmi: Math.round(iDensity),
      dead_ends: deadEnds.length,
    },
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function overlapsBB(a: [number, number, number, number], b: [number, number, number, number]) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function distToRing(p: Vec2, r: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < r.length; i++) {
    const a = r[i],
      b = r[(i + 1) % r.length];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

function distToPolyFast(p: Vec2, q: Polygon): number {
  return pointInPoly(p, q) ? 0 : distToRing(p, q[0]);
}

/** what covers a point: 0 bare, 1 building, 2 street ROW, 3 public open, 4 landscaped, 5 civic grounds, 6 parking, 7 furnished (props) */
function classify(world: World, p: Vec2, bands: { band: Polygon; bb: [number, number, number, number] }[]): number {
  const q: [number, number, number, number] = [p[0] - 0.5, p[1] - 0.5, p[0] + 0.5, p[1] + 0.5];
  const near = world.query(q, ["building", "area", "prop"]);
  for (const e of near) if (e.kind === "building" && pointInPoly(p, (e as Building).footprint)) return 1;
  for (const x of bands) if (p[0] >= x.bb[0] && p[0] <= x.bb[2] && p[1] >= x.bb[1] && p[1] <= x.bb[3] && pointInPoly(p, x.band)) return 2;
  let best = 0;
  for (const e of near) {
    if (e.kind === "area") {
      const a = e as Area;
      if (!pointInPoly(p, a.poly)) continue;
      const k = PUBLIC_OPEN.has(a.type) ? 3 : a.type === "campus" ? 5 : LANDSCAPED.has(a.type) ? 4 : a.type === "parking" ? 6 : a.type === "construction" ? 0 : 4;
      if (k === 3) return 3;
      if (best === 0 || k === 5) best = k;
    } else if (e.kind === "prop" && !best) {
      const pr = e as Prop;
      if (pr.footprint && pointInPoly(p, pr.footprint)) best = 7;
    }
  }
  return best;
}
