// Spatial constraint checks shared by every operation and by the agent's
// validate tool: right-of-way encroachment, building overlap, height limits
// (zoning + Capitol View Corridors), buried utilities, floodplain, heritage.

import { rowBand } from "@/geometry/streetGeometry";
import { intersection, overlapArea, pointInPoly, polyArea, polyBBox, polyCentroid, polyDistance } from "@/geometry/polygon";
import { closestOnPath } from "@/geometry/polyline";
import { rtMaybe } from "@/state/runtime";
import type { Building, Parcel, Polygon, Street, Utility, Vec2 } from "../types";
import type { World } from "../world";

export interface Issue {
  severity: "error" | "warning" | "info";
  kind: "row" | "overlap" | "height" | "cvc" | "utility" | "flood" | "historic" | "parcel" | "network" | "access" | "setback";
  message: string;
  ids: string[];
}

export function streetBand(s: Street): Polygon {
  return [rowBand(s.path, s.section)];
}

/** streets whose right-of-way overlaps the polygon */
export function rowConflicts(world: World, poly: Polygon, opts: { minArea?: number; get?: (id: string) => unknown } = {}): { street: Street; area: number }[] {
  const bb = polyBBox(poly);
  const out: { street: Street; area: number }[] = [];
  for (const e of world.query([bb[0] - 30, bb[1] - 30, bb[2] + 30, bb[3] + 30], ["street"])) {
    const s = (opts.get ? (opts.get(e.id) as Street | undefined) : (e as Street)) ?? (e as Street);
    if (!s || s.cls === "motorway" || s.cls === "motorway_link" || s.tunnel || s.private) continue;
    const a = overlapArea(poly, streetBand(s));
    if (a > (opts.minArea ?? 1.5)) out.push({ street: s, area: a });
  }
  return out;
}

export function buildingOverlaps(world: World, poly: Polygon, exclude: Set<string> = new Set()): { building: Building; area: number }[] {
  const out: { building: Building; area: number }[] = [];
  const bb = polyBBox(poly);
  for (const e of world.query(bb, ["building"])) {
    if (exclude.has(e.id)) continue;
    const a = overlapArea(poly, (e as Building).footprint);
    if (a > 1) out.push({ building: e as Building, area: a });
  }
  return out;
}

export function parcelsUnder(world: World, poly: Polygon): { parcel: Parcel; area: number }[] {
  const out: { parcel: Parcel; area: number }[] = [];
  for (const e of world.query(polyBBox(poly), ["parcel"])) {
    const a = overlapArea(poly, (e as Parcel).poly);
    if (a > 1) out.push({ parcel: e as Parcel, area: a });
  }
  return out.sort((a, b) => b.area - a.area);
}

export function parcelAt(world: World, p: Vec2): Parcel | undefined {
  for (const e of world.query([p[0], p[1], p[0], p[1]], ["parcel"])) if (pointInPoly(p, (e as Parcel).poly)) return e as Parcel;
  return undefined;
}

/** governing height limit at a footprint: min of zoning max height and CVC ceiling above grade */
export function heightLimit(world: World, poly: Polygon, ground: number): { limit: number | null; source: string[] } {
  const ps = parcelsUnder(world, poly);
  let limit: number | null = null;
  const source: string[] = [];
  for (const { parcel } of ps.slice(0, 6)) {
    if (parcel.maxHeight != null && (limit == null || parcel.maxHeight < limit)) {
      limit = parcel.maxHeight;
      source.push(`zoning ${parcel.zoning} (${Math.round(parcel.maxHeight / 0.3048)} ft)`);
    }
    if (parcel.cvcCeiling != null) {
      const above = parcel.cvcCeiling - ground;
      // a sight line cannot run below grade: the corridor data does not apply here
      if (above < 3) {
        if (!source.some((s) => s.startsWith("CVC n/a"))) source.push("CVC n/a: corridor ceiling at or below grade in the source data");
        continue;
      }
      if (limit == null || above < limit) {
        limit = Math.max(0, above);
        source.push(`Capitol View Corridor ceiling ${Math.round(parcel.cvcCeiling / 0.3048)} ft ASL`);
      }
    }
  }
  return { limit, source };
}

export function utilitiesUnder(world: World, poly: Polygon): Utility[] {
  const out: Utility[] = [];
  for (const e of world.query(polyBBox(poly), ["utility"])) {
    const u = e as Utility;
    if (u.type === "inlet" ? pointInPoly(u.path[0], poly) : u.path.some((p) => pointInPoly(p, poly)) || intersection(poly, [[...u.path, ...u.path.slice().reverse()]]).length > 0) out.push(u);
  }
  return out;
}

export function inFloodplain(poly: Polygon): string | null {
  const R = rtMaybe();
  if (!R) return null;
  const c = polyCentroid(poly);
  for (const f of R.fema) if (f.zone !== ".2 PCT ANNUAL CHANCE FLOOD HAZARD" && pointInPoly(c, f.poly)) return f.zone;
  for (const f of R.fema) if (pointInPoly(c, f.poly)) return "0.2% annual chance (500-yr)";
  return null;
}

/** full constraint check for a (proposed) building */
export function checkBuilding(world: World, b: Building, exclude: Set<string> = new Set([b.id])): Issue[] {
  const issues: Issue[] = [];
  for (const { street, area } of rowConflicts(world, b.footprint))
    issues.push({ severity: "error", kind: "row", message: `Footprint encroaches ${area.toFixed(0)} m² into the right-of-way of ${street.name ?? street.id}`, ids: [street.id] });
  for (const { building, area } of buildingOverlaps(world, b.footprint, exclude))
    issues.push({ severity: "error", kind: "overlap", message: `Overlaps ${building.name ?? "building " + building.id} by ${area.toFixed(0)} m²`, ids: [building.id] });
  const hl = heightLimit(world, b.footprint, b.ground);
  if (hl.limit != null && b.height > hl.limit + 0.5) {
    const cvc = hl.source.some((s) => s.startsWith("Capitol"));
    issues.push({ severity: cvc ? "error" : "warning", kind: cvc ? "cvc" : "height", message: `Height ${b.height.toFixed(0)} m exceeds the ${hl.limit.toFixed(0)} m limit (${hl.source[hl.source.length - 1]})${cvc ? "" : " — would require a variance or density bonus"}`, ids: [] });
  }
  const utils = utilitiesUnder(world, b.footprint);
  const pipes = utils.filter((u) => u.type === "storm_pipe");
  if (pipes.length) issues.push({ severity: "warning", kind: "utility", message: `${pipes.length} storm drain pipe${pipes.length > 1 ? "s" : ""} run under the footprint — relocation or easement required`, ids: pipes.map((p) => p.id) });
  const fz = inFloodplain(b.footprint);
  if (fz) issues.push({ severity: fz === "AE" ? "warning" : "info", kind: "flood", message: `Footprint lies in FEMA flood zone ${fz}`, ids: [] });
  return issues;
}

/** distance from a street centreline to the nearest building face on each side, sampled along the street */
export function frontage(world: World, s: Street, exclude: Set<string> = new Set()): { left: number; right: number; samples: number } {
  const L = s.path;
  const bb = polyBBox([L]);
  const near = world.query([bb[0] - 45, bb[1] - 45, bb[2] + 45, bb[3] + 45], ["building"]).filter((b) => !exclude.has(b.id)) as Building[];
  let left = Infinity,
    right = Infinity;
  let n = 0;
  for (const b of near) {
    for (const r of b.footprint)
      for (const p of r) {
        const c = closestOnPath(p, L);
        if (c.d > 45) continue;
        // skip points beyond the street ends
        if (c.along < 2) continue;
        const a = L[c.seg],
          q = L[c.seg + 1] ?? L[c.seg];
        const side = (q[0] - a[0]) * (p[1] - a[1]) - (q[1] - a[1]) * (p[0] - a[0]);
        if (side > 0) left = Math.min(left, c.d);
        else right = Math.min(right, c.d);
        n++;
      }
  }
  return { left, right, samples: n };
}

export { polyDistance, polyArea };
