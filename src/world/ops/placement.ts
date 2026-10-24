// Live placement checks for the drawing tools: the same rules the operations
// apply, evaluated on hover so the map can show in red where something can't
// go (and why) before the user commits.

import { kerbOffsets } from "@/geometry/crossSection";
import { pointInPoly, polyBBox } from "@/geometry/polygon";
import { closestOnPath } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import type { Area, Building, Polygon, Street, Tree, Vec2 } from "../types";
import type { World } from "../world";
import { buildingOverlaps, rowConflicts } from "./validate";

export type TreeProblem = "outside" | "building" | "leaves" | "road" | "water" | "crowded";

export const TREE_PROBLEM_LABEL: Record<TreeProblem, string> = {
  outside: "Outside the study area",
  building: "Inside a building",
  road: "In the roadway",
  water: "On water",
  leaves: "Its leaves would hit a building",
  crowded: "Its leaves would overlap another tree",
};

/** inside the modelled study area (edits outside it would have no data under them) */
export function inStudyArea(world: World, p: Vec2): boolean {
  const b = world.meta.bounds;
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

/** why a drawing tool can't put a corner / vertex at p (null = fine) */
export function pointProblem(world: World, tool: string, p: Vec2): string | null {
  if (!inStudyArea(world, p)) return TREE_PROBLEM_LABEL.outside;
  if (tool === "building") {
    if (world.query([p[0] - 1, p[1] - 1, p[0] + 1, p[1] + 1], ["building"]).some((e) => pointInPoly(p, (e as Building).footprint))) return "Inside a building";
    if (inCarriageway(world, p)) return "In the roadway";
  }
  return null;
}

/** is p between the kerbs of a street (in the carriageway)? */
export function inCarriageway(world: World, p: Vec2): boolean {
  for (const e of world.query([p[0] - 25, p[1] - 25, p[0] + 25, p[1] + 25], ["street"])) {
    const s = e as Street;
    if (s.tunnel) continue;
    const c = closestOnPath(p, s.path);
    if (c.d > 25) continue;
    const a = s.path[c.seg],
      b = s.path[c.seg + 1] ?? a;
    const side = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0 ? 1 : -1;
    const k = kerbOffsets(s.section, s.section.shift ?? 0);
    const off = side * c.d;
    if (off < k.left && off > k.right) return true;
  }
  return false;
}

/** how far crowns may press into each other or into a façade (share of the crown radius) before it counts as a collision */
const CROWN_GIVE = 0.15;

/**
 * Why a tree with crown radius r can't stand at p (null = fine); `also` are positions planted in
 * the same action (same crown). A tree takes up its whole crown: a cylinder as wide as its leaves and
 * as tall as the tree, so crowns don't overlap one another or grow into buildings. The trunk alone
 * decides road and water.
 */
export function treeProblem(world: World, p: Vec2, r: number, also: Vec2[] = []): TreeProblem | null {
  if (!inStudyArea(world, p)) return "outside";
  const reach = r + 12;
  const around = world.query([p[0] - reach, p[1] - reach, p[0] + reach, p[1] + reach], ["building", "tree", "area"]);
  const blds = around.filter((e): e is Building => e.kind === "building");
  if (blds.some((b) => pointInPoly(p, b.footprint))) return "building";
  if (around.some((e) => e.kind === "area" && ((e as Area).type === "water" || (e as Area).type === "retention") && pointInPoly(p, (e as Area).poly))) return "water";
  if (inCarriageway(world, p)) return "road";
  const give = 1 - CROWN_GIVE;
  if (blds.some((b) => b.footprint.some((ring) => closestOnPath(p, [...ring, ring[0]]).d < r * give))) return "leaves";
  if (around.some((e) => e.kind === "tree" && dist((e as Tree).p, p) < ((e as Tree).r + r) * give) || also.some((o) => dist(o, p) < 2 * r * give)) return "crowded";
  return null;
}

export interface ShapeConflicts {
  /** existing buildings the shape overlaps */
  buildings: Building[];
  /** streets whose right-of-way the shape overlaps */
  streets: Street[];
  /** one-line consequence for the UI, or null when the shape is clean */
  message: string | null;
  /** true when the conflict blocks or trims the result (shown red); false = informational */
  blocking: boolean;
}

/** what a drawn building / area polygon runs into */
export function shapeConflicts(world: World, tool: "building" | "area", ring: Vec2[]): ShapeConflicts {
  if (ring.length < 3) return { buildings: [], streets: [], message: null, blocking: false };
  const poly: Polygon = [ring];
  const streets = rowConflicts(world, poly, { minArea: 2 }).map((c) => c.street);
  const buildings = buildingOverlaps(world, poly, new Set())
    .filter((o) => o.area > 1)
    .map((o) => o.building);
  const n = buildings.length;
  const msg = n ? `Overlaps ${n} building${n > 1 ? "s" : ""}` : streets.length ? (tool === "building" ? "Crosses the road" : "Road excluded") : null;
  return { buildings, streets, message: msg, blocking: !!msg };
}

/** buildings a new street of the given total width would cut through */
export function streetConflicts(world: World, path: Vec2[], width = 15): Building[] {
  if (path.length < 2) return [];
  const bb = polyBBox([path]);
  const half = width / 2;
  const out: Building[] = [];
  for (const e of world.query([bb[0] - half, bb[1] - half, bb[2] + half, bb[3] + half], ["building"])) {
    const b = e as Building;
    const hit = b.footprint[0].some((q) => closestOnPath(q, path).d < half) || path.some((q) => pointInPoly(q, b.footprint));
    if (hit) out.push(b);
  }
  return out;
}
