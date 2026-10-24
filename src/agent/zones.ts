// Agent work zones: where a session may edit. A zone is a polygon in local metres, made from a
// drawing, the selection, or words ("between 5th and 7th from Congress to Lavaca", "the block at
// Lamar & 6th", "within 300 m of Republic Square", a district name). The executor checks every
// changeset against the session's zone before committing it (zoneCheck) and refuses edits that
// reach outside, telling the model why so it can adapt.
//
// Containment rules (zoneCheck), chosen so ordinary cascades at the zone edge still work while
// edits that genuinely act elsewhere are refused:
//  - Every feature a changeset adds, removes or modifies is tested, except junction nodes (they
//    regenerate with their streets) and transit routes that are only modified (routes re-thread
//    along edited streets and can run across the whole map).
//  - Tolerance: the zone is grown by TOL (10 m) for "inside" and by MARGIN (30 m) for "touching".
//  - Added buildings, areas, trees, stops and props (the things an edit places) must lie mostly
//    inside: ≥ 50% of their footprint, or their point, within zone+TOL.
//  - Everything else touched (modified/removed buildings, trimmed parcels, streets, relocated
//    trees, split street pieces) must touch zone+MARGIN. Street segments are atomic, so a segment
//    that crosses the boundary may be edited as a whole; segments wholly outside may not. Cascades
//    therefore reach at most one segment / one frontage beyond the line.
//  - At least one touched feature must be mostly inside (≥ 50% within zone+TOL): an edit made only
//    of boundary-straddling features elsewhere along the edge is not "in" the zone.

import { circle, convexHull, isValidPoly, normalizePoly, overlapArea, pointInPoly, polyArea, polyBBox, polyCentroid, bufferPoly, unionMany } from "@/geometry/polygon";
import { polyLength, pointAt } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import { rt } from "@/state/runtime";
import type { Entity, Polygon, Street, Vec2 } from "@/world/types";
import type { Changeset } from "@/world/world";
import type { Zone } from "./types";
import { blockAt, entityName, entityPoint, junctionOf, polyOf, resolveArea, resolveLocation, streetsNamed } from "./resolve";

export const ZONE_TOL = 10;
export const ZONE_MARGIN = 30;

let zseq = 0;
const zid = () => `z_${Date.now().toString(36)}${(++zseq).toString(36)}`;

export const hectares = (poly: Polygon) => polyArea(poly) / 10000;
export const fmtHa = (poly: Polygon) => {
  const ha = hectares(poly);
  return `${ha < 10 ? ha.toFixed(1) : Math.round(ha)} ha`;
};

/** "Label · 4.2 ha" */
export function zoneLabel(name: string, poly: Polygon): string {
  return `${name} · ${fmtHa(poly)}`;
}

/** ring simplified to at most n vertices, rounded to metres (for prompts and tool inputs) */
export function zoneRing(z: Zone, n = 24): [number, number][] {
  const r = z.poly[0];
  const step = Math.max(1, Math.ceil(r.length / n));
  const out: [number, number][] = [];
  for (let i = 0; i < r.length; i += step) out.push([Math.round(r[i][0]), Math.round(r[i][1])]);
  return out;
}

/** compact description for the model: label, area, bbox, centre and (simplified) ring */
export function zoneSummary(z: Zone): string {
  const b = polyBBox(z.poly).map(Math.round);
  const c = polyCentroid(z.poly);
  return `“${z.label}” (${fmtHa(z.poly)}; bbox x ${b[0]}…${b[2]}, y ${b[1]}…${b[3]}; centre [${Math.round(c[0])}, ${Math.round(c[1])}]; ring ${JSON.stringify(zoneRing(z, 16))})`;
}

export function zoneFromPolygon(poly: Polygon | Vec2[], opts: { label?: string; source?: Zone["source"]; query?: string } = {}): Zone {
  const p = normalizePoly(Array.isArray(poly[0]?.[0]) ? (poly as Polygon) : [poly as Vec2[]]);
  if (!isValidPoly(p)) throw new Error("Zone polygon is degenerate");
  return { id: zid(), label: zoneLabel(opts.label ?? "Drawn area", p), poly: [p[0]], source: opts.source ?? "drawn", query: opts.query };
}

/** a zone covering the selected features (union; several pieces → their convex hull) */
export function zoneFromSelection(ids: string[]): Zone | null {
  const w = rt().world;
  const polys: Polygon[] = [];
  const pts: Vec2[] = [];
  for (const id of ids) {
    const e = w.get(id);
    if (!e) continue;
    const p = polyOf(e);
    if (p && isValidPoly(p)) polys.push(p);
    else pts.push(entityPoint(e));
  }
  for (const p of pts) polys.push([circle(p, 15, 16)]);
  if (!polys.length) return null;
  const u = polys.length > 1 ? unionMany(polys) : polys;
  const poly: Polygon = u.length === 1 ? [u[0][0]] : [convexHull(u.flatMap((q) => q[0]))];
  const name = ids.length === 1 && w.get(ids[0]) ? entityName(w.get(ids[0])!) : `${ids.length} selected features`;
  return { id: zid(), label: zoneLabel(name, poly), poly, source: "selection" };
}

export type ZoneResult = { ok: true; zone: Zone; candidates?: Zone[]; note?: string } | { ok: false; error: string; candidates?: Zone[] };

const cleanStreet = (s: string) =>
  s
    .replace(/^(the\s+)?(block|blocks|area|corner)\s+(at|of|around|by)\s+/i, "")
    .replace(/\b(block|blocks)\b/gi, "")
    .replace(/^\s*(the|of|at)\s+/i, "")
    .replace(/[.,;]+$/g, "")
    .trim();

function junctionP(a: string, b: string): Vec2 | null {
  const n = junctionOf(a, b);
  return n ? n.p : null;
}

const QUAD: Record<string, Vec2> = { ne: [1, 1], nw: [-1, 1], se: [1, -1], sw: [-1, -1] };
function quadrantOf(text: string): keyof typeof QUAD | null {
  const t = text.toLowerCase();
  if (/\b(north[- ]?east|ne)\b/.test(t)) return "ne";
  if (/\b(north[- ]?west|nw)\b/.test(t)) return "nw";
  if (/\b(south[- ]?east|se)\b/.test(t)) return "se";
  if (/\b(south[- ]?west|sw)\b/.test(t)) return "sw";
  return null;
}

/** the four corner blocks around a junction (NE/NW/SE/SW) */
function cornerBlocks(p: Vec2): { q: keyof typeof QUAD; poly: Polygon }[] {
  const out: { q: keyof typeof QUAD; poly: Polygon }[] = [];
  const seen = new Set<string>();
  for (const q of Object.keys(QUAD) as (keyof typeof QUAD)[]) {
    const d = QUAD[q];
    for (const off of [25, 40, 60]) {
      const b = blockAt([p[0] + d[0] * off, p[1] + d[1] * off], 220);
      if (!b || !isValidPoly(b) || !pointInPoly([p[0] + d[0] * off, p[1] + d[1] * off], b)) continue;
      const c = polyCentroid(b);
      const k = `${Math.round(c[0] / 5)}:${Math.round(c[1] / 5)}`;
      if (seen.has(k)) break;
      seen.add(k);
      out.push({ q, poly: [b[0]] });
      break;
    }
  }
  return out;
}

/**
 * Resolve words to a zone. Understands:
 *  - "within 300 m of X", "300 m around X"
 *  - "between 5th and 7th from Congress to Lavaca" / "between 5th and 7th, Congress and Lavaca"
 *  - "Congress between 5th and 7th" (a frontage corridor ±60 m)
 *  - "24th St & West Ave block", "the block at Lamar & 6th", "NE block of Lamar & 6th"
 *  - "selection" (current selection), place / district / park / street names, feature ids
 */
export function zoneFromText(text: string, opts: { selection?: string[] } = {}): ZoneResult {
  const q = text.trim().replace(/\s+/g, " ");
  if (!q) return { ok: false, error: "Describe the zone, e.g. “between 5th and 7th from Congress to Lavaca”." };
  const src = (label: string, poly: Polygon, source: Zone["source"] = "text"): Zone => ({ id: zid(), label: zoneLabel(label, poly), poly: [poly[0]], source, query: q });
  try {
    if (/^(the\s+)?(current\s+)?(selection|selected( features)?)$/i.test(q)) {
      const z = opts.selection?.length ? zoneFromSelection(opts.selection) : null;
      return z ? { ok: true, zone: { ...z, query: q } } : { ok: false, error: "Nothing is selected." };
    }
    // within N m of X
    let m = q.match(/^(?:within\s+)?(\d+(?:\.\d+)?)\s*(m|metres?|meters?|km|ft|feet)\s+(?:of|around|from)\s+(.+)$/i);
    if (m) {
      const unit = m[2].toLowerCase();
      const r = Number(m[1]) * (unit === "km" ? 1000 : unit === "ft" || unit === "feet" ? 0.3048 : 1);
      const xy = m[3].trim().match(/^\[?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]?$/);
      const at = xy ? { p: [Number(xy[1]), Number(xy[2])] as Vec2, label: `[${xy[1]}, ${xy[2]}]` } : resolveLocation(m[3]);
      const poly: Polygon = [circle(at.p, r, 48)];
      return { ok: true, zone: src(`${Math.round(r)} m around ${at.label}`, poly, "place") };
    }
    // between A and B from C to D
    m = q.match(/^between\s+(.+?)\s+(?:and|&)\s+(.+?)(?:,\s*|\s+)(?:from\s+(.+?)\s+to\s+(.+)|(.+?)\s+(?:and|&)\s+(.+))$/i);
    if (m) {
      const [a, b] = [cleanStreet(m[1]), cleanStreet(m[2])];
      const [c, d] = [cleanStreet(m[3] ?? m[5]), cleanStreet(m[4] ?? m[6])];
      const pts = [junctionP(a, c), junctionP(a, d), junctionP(b, c), junctionP(b, d)];
      const missing = ["", "", "", ""].map((_, i) => (pts[i] ? null : [`${a} & ${c}`, `${a} & ${d}`, `${b} & ${c}`, `${b} & ${d}`][i])).filter(Boolean);
      if (missing.length) return { ok: false, error: `Could not find the junction${missing.length > 1 ? "s" : ""} ${missing.join(", ")}. Check the street names.` };
      const hull = convexHull(pts as Vec2[]);
      if (hull.length < 3 || polyArea([hull]) < 200) return { ok: false, error: `${a}/${b} and ${c}/${d} don't enclose an area (are they parallel?).` };
      return { ok: true, zone: src(`${a}–${b}, ${c}–${d}`, [hull]) };
    }
    // C between A and B (corridor)
    m = q.match(/^(?:along\s+|on\s+)?(.+?)\s+between\s+(.+?)\s+(?:and|&)\s+(.+)$/i);
    if (m) {
      const [c, a, b] = [cleanStreet(m[1]), cleanStreet(m[2]), cleanStreet(m[3])];
      const pa = junctionP(c, a),
        pb = junctionP(c, b);
      if (!pa || !pb) return { ok: false, error: `Could not find ${!pa ? `${c} & ${a}` : `${c} & ${b}`}.` };
      const L = dist(pa, pb);
      if (L < 10) return { ok: false, error: `${a} and ${b} meet ${c} at the same point.` };
      const ux = (pb[0] - pa[0]) / L,
        uy = (pb[1] - pa[1]) / L;
      const hw = 60;
      const ring: Vec2[] = [
        [pa[0] - uy * hw, pa[1] + ux * hw],
        [pa[0] + uy * hw, pa[1] - ux * hw],
        [pb[0] + uy * hw, pb[1] - ux * hw],
        [pb[0] - uy * hw, pb[1] + ux * hw],
      ];
      return { ok: true, zone: src(`${c}, ${a} to ${b}`, normalizePoly([ring])) };
    }
    // block at A & B
    const blockish = /\bblock|corner\b/i.test(q);
    const core = cleanStreet(q.replace(/\b(north[- ]?east|north[- ]?west|south[- ]?east|south[- ]?west|ne|nw|se|sw)\b/gi, "").replace(/\bof\b/gi, " "));
    const parts = core.split(/\s*(?:&|\band\b|\bat\b|\/|\+)\s*/i).map(cleanStreet).filter(Boolean);
    if (parts.length === 2) {
      const n = junctionOf(parts[0], parts[1]);
      if (n) {
        const blocks = cornerBlocks(n.p);
        const name = `${parts[0]} & ${parts[1]}`;
        if (!blocks.length) return { ok: true, zone: src(`around ${name}`, [circle(n.p, 80, 32)]) };
        const cands = blocks.map((b) => src(`${b.q.toUpperCase()} block at ${name}`, b.poly));
        const want = quadrantOf(q);
        const pick = want ? cands[blocks.findIndex((b) => b.q === want)] : undefined;
        if (pick) return { ok: true, zone: pick, candidates: cands };
        if (blocks.length === 1) return { ok: true, zone: cands[0], candidates: cands };
        // no corner named: the blocks around the junction (with the junction itself), corners as candidates
        const hull = convexHull(blocks.flatMap((b) => b.poly[0]));
        return { ok: true, zone: src(`${blocks.length} blocks at ${name}`, [hull]), candidates: cands, note: blockish ? "No corner named: the zone covers the blocks around the junction. Pick a corner (NE/NW/SE/SW) to narrow it." : undefined };
      }
      if (blockish) return { ok: false, error: `${parts[0]} and ${parts[1]} don't meet in the data. Check the names.` };
    }
    const streets = streetsNamed(q);
    const r = resolveArea(q);
    if (!isValidPoly(r.poly)) return { ok: false, error: `Could not resolve “${q}” to an area.` };
    const poly: Polygon = [r.poly[0]];
    return { ok: true, zone: src(r.label.replace(/ \(approximate.*$/, " (approx.)"), poly, streets.length ? "text" : "place"), note: /approximate/.test(r.label) ? r.label : undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------- containment

type Geom = { t: "poly"; poly: Polygon } | { t: "line"; path: Vec2[] } | { t: "pt"; p: Vec2 };

function geomOf(e: Entity): Geom {
  switch (e.kind) {
    case "building":
      return { t: "poly", poly: e.footprint };
    case "area":
    case "parcel":
      return { t: "poly", poly: e.poly };
    case "street":
    case "route":
    case "utility":
    case "path":
      return { t: "line", path: (e as Street).path };
    case "prop":
      return e.footprint && isValidPoly(e.footprint) ? { t: "poly", poly: e.footprint } : { t: "pt", p: e.p };
    default:
      return { t: "pt", p: entityPoint(e) };
  }
}

function samples(path: Vec2[]): Vec2[] {
  const L = polyLength(path);
  if (L < 1) return [path[0]];
  const n = Math.min(200, Math.max(2, Math.ceil(L / 5)));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) out.push(pointAt(path, (L * i) / n).p);
  return out;
}

function share(g: Geom, z: Polygon): number {
  if (g.t === "pt") return pointInPoly(g.p, z) ? 1 : 0;
  if (g.t === "line") {
    const s = samples(g.path);
    return s.filter((p) => pointInPoly(p, z)).length / s.length;
  }
  const a = polyArea(g.poly);
  if (a < 1) return pointInPoly(polyCentroid(g.poly), z) ? 1 : 0;
  return Math.min(1, overlapArea(g.poly, z) / a);
}

function touches(g: Geom, z: Polygon): boolean {
  if (g.t === "pt") return pointInPoly(g.p, z);
  if (g.t === "line") return samples(g.path).some((p) => pointInPoly(p, z));
  return g.poly[0].some((p) => pointInPoly(p, z)) || overlapArea(g.poly, z) > 0.5 || z[0].some((p) => pointInPoly(p, g.poly));
}

const PLACED = new Set(["building", "area", "tree", "stop", "prop"]);

export interface ZoneVerdict {
  ok: boolean;
  checked: number;
  outside: { id: string; kind: string; name: string; inside_share: number }[];
  message?: string;
}

const grownCache = new WeakMap<Polygon, { tol: Polygon; margin: Polygon }>();
function grown(z: Zone) {
  let g = grownCache.get(z.poly);
  if (!g) {
    g = { tol: bufferPoly(z.poly, ZONE_TOL), margin: bufferPoly(z.poly, ZONE_MARGIN) };
    grownCache.set(z.poly, g);
  }
  return g;
}

/** does this changeset stay inside the zone? (rules at the top of this file) */
export function zoneCheck(zone: Zone, cs: Pick<Changeset, "ops">): ZoneVerdict {
  const { tol, margin } = grown(zone);
  const outside: ZoneVerdict["outside"] = [];
  let checked = 0,
    anchored = false;
  const name = (e: Entity) => {
    try {
      return entityName(e);
    } catch {
      return e.id;
    }
  };
  for (const op of cs.ops) {
    const ents: { e: Entity; placed: boolean }[] =
      op.type === "add" ? [{ e: op.entity, placed: PLACED.has(op.entity.kind) }] : op.type === "remove" ? [{ e: op.entity, placed: false }] : [{ e: op.before, placed: false }, { e: op.after, placed: false }];
    for (const { e, placed } of ents) {
      if (e.kind === "node" || e.kind === "place" || e.kind === "poi") continue;
      if (e.kind === "route" && op.type === "update") continue;
      checked++;
      const g = geomOf(e);
      const sh = share(g, tol);
      if (sh >= 0.5) anchored = true;
      const bad = placed ? sh < 0.5 : !touches(g, margin);
      if (bad && !outside.some((o) => o.id === e.id)) outside.push({ id: e.id, kind: e.kind, name: name(e), inside_share: Math.round(sh * 100) / 100 });
    }
  }
  if (!checked) return { ok: true, checked, outside };
  if (!outside.length && anchored) return { ok: true, checked, outside };
  const list = outside.slice(0, 6).map((o) => `${o.name} (${o.kind} ${o.id})`).join("; ");
  const message = outside.length
    ? `Refused: this edit reaches outside the session zone ${zoneSummary(zone)}. ${outside.length} of ${checked} affected features lie outside it: ${list}${outside.length > 6 ? "; …" : ""}. Nothing was applied. Restrict the edit to the zone (pass within: "zone" or ids inside it), or ask the user to change the zone.`
    : `Refused: this edit is not inside the session zone ${zoneSummary(zone)} — none of the ${checked} affected features lies mostly inside it. Nothing was applied. Work inside the zone (pass within: "zone"), or ask the user to change the zone.`;
  return { ok: false, checked, outside, message };
}

/** quick test: is a point inside the zone (with tolerance)? */
export function inZone(zone: Zone, p: Vec2): boolean {
  return pointInPoly(p, grown(zone).tol);
}
