// Proposal files: what a scenario changes, written so people can read it and programs can load it.
//
// JSON ("meridian-proposal", versioned) is the exchange format. Each proposal carries a readable
// account of its changes (a GeoJSON FeatureCollection in lon/lat with the key attributes of every
// added, modified and removed feature) and the exact changesets, so importing it rebuilds the
// proposal entity for entity, in this session or any later one, on the same city.
//
// CSV is one row per changed feature for spreadsheets and GIS (geometry as WKT in lon/lat). It is
// read back as well as it can be: buildings, trees, areas, paths, junctions and street centrelines
// come back from their columns, library primitives are regenerated from their definition and
// parameters. What a row cannot carry is reported on import: street cross-sections (a re-created
// street gets its class's default section), building massing detail beyond one extruded footprint
// (setbacks, roofs, facade style), the solids of props whose definition is unknown here, and transit
// routes. Use JSON for a lossless copy.

import { buildSection, sectionWidth } from "@/geometry/crossSection";
import { stretchAbovePodium } from "@/geometry/massing";
import { polyArea, polyCentroid } from "@/geometry/polygon";
import { polyLength } from "@/geometry/polyline";
import { ensureLibrary, getPrimitive, type ParamValues } from "@/library";
import { sampleGrid } from "@/sim/raster";
import { programmeOf } from "@/world/ops/core";
import { placePrimitive } from "@/world/ops/library";
import { LocalProjection } from "@/world/projection";
import type { Scenario } from "@/world/scenarios";
import type { Area, AreaType, Building, Entity, EntityKind, LibraryRef, NodeControl, Path, Polygon, Prop, RoadClass, Street, StreetNode, TransitMode, TransitStop, Tree, Use, Vec2 } from "@/world/types";
import { makeChangeset, newId, type Changeset, type Op } from "@/world/world";
import type { Runtime } from "./runtime";

export const PROPOSAL_FORMAT = "meridian-proposal";
export const PROPOSAL_VERSION = 1;
const LEGACY_DESIGN_FORMAT = "meridian-design";

// ------------------------------------------------------------------ schema

export type ChangeAction = "added" | "modified" | "removed";

/** one changed feature: the readable attributes shared by the JSON features and the CSV rows */
export interface ChangeRow {
  action: ChangeAction;
  kind: EntityKind;
  id: string;
  name: string | null;
  /** building use, street class, area / path type, tree species, junction control, prop type… */
  use_type: string | null;
  floors: number | null;
  height_m: number | null;
  /** footprint / polygon area; a tree's crown; a street's right-of-way (length × width) */
  area_m2: number | null;
  /** estimated dwelling units and jobs (buildings) */
  units: number | null;
  jobs: number | null;
  /** representative point (WGS 84): centroid of a polygon, midpoint of a line */
  lon: number;
  lat: number;
  library_def: string | null;
  library_params: Record<string, unknown> | null;
  library_instance: string | null;
  /** how the library instance was placed, coordinates in lon/lat */
  library_placement: { at?: [number, number]; rotation?: number; site?: [number, number][][]; path?: [number, number][] } | null;
  /** attributes that differ from the existing feature (modified rows) */
  changed: string[] | null;
}

type Position = [number, number];
export type Geometry = { type: "Point"; coordinates: Position } | { type: "LineString"; coordinates: Position[] } | { type: "Polygon"; coordinates: Position[][] };

export interface ChangeFeature {
  type: "Feature";
  id: string;
  geometry: Geometry;
  properties: ChangeRow;
}

export interface ProposalEntry {
  name: string;
  description?: string;
  author: "user" | "agent";
  color: string;
  /** name of the scenario this one was branched from */
  basedOn: string | null;
  /** number of edits (changesets) */
  edits: number;
  summary: {
    added: number;
    modified: number;
    removed: number;
    byKind: Partial<Record<EntityKind, { added: number; modified: number; removed: number }>>;
    /** change in estimated dwelling units, jobs and gross floor area against the existing city */
    units: number;
    jobs: number;
    gfa_m2: number;
  };
  /** the edits in order, for reading */
  history: { label: string; author: string; time: string }[];
  /** readable list of what changed (GeoJSON, lon/lat) */
  changes: { type: "FeatureCollection"; features: ChangeFeature[] };
  /** exact edits from the existing city, in order (local metres); importing replays these */
  changesets: Changeset[];
}

export interface ProposalFile {
  format: typeof PROPOSAL_FORMAT;
  version: typeof PROPOSAL_VERSION;
  app: { name: "Meridian"; url?: string };
  exportedAt: string;
  city: { id: string; name: string; region: string; sandbox: boolean; climate: string };
  crs: {
    /** geometry inside `changesets` */
    local: string;
    origin: { lon: number; lat: number };
    /** geometry and points inside `changes` */
    lonlat: string;
  };
  proposals: ProposalEntry[];
}

// ------------------------------------------------------------------ helpers

const r1 = (x: number) => Math.round(x * 10) / 10;
const r7 = (x: number) => Math.round(x * 1e7) / 1e7;
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function projectionOf(R: Runtime) {
  return new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
}

function geometryOf(e: Entity): Geometry {
  switch (e.kind) {
    case "building":
      return { type: "Polygon", coordinates: e.footprint as unknown as Position[][] };
    case "area":
    case "parcel":
      return { type: "Polygon", coordinates: e.poly as unknown as Position[][] };
    case "place":
      return e.poly ? { type: "Polygon", coordinates: e.poly as unknown as Position[][] } : { type: "Point", coordinates: e.p };
    case "street":
    case "route":
    case "utility":
    case "path":
      return { type: "LineString", coordinates: e.path };
    case "node":
    case "tree":
    case "stop":
    case "poi":
    case "prop":
      return { type: "Point", coordinates: e.p };
  }
}

/** close each ring (GeoJSON / WKT rings repeat their first point) and project to lon/lat */
function toLonLat(g: Geometry, P: LocalProjection): Geometry {
  const pt = (p: Position): Position => {
    const [lon, lat] = P.toLonLat(p as Vec2);
    return [r7(lon), r7(lat)];
  };
  if (g.type === "Point") return { type: "Point", coordinates: pt(g.coordinates) };
  if (g.type === "LineString") return { type: "LineString", coordinates: g.coordinates.map(pt) };
  return { type: "Polygon", coordinates: g.coordinates.map((ring) => [...ring, ring[0]].map(pt)) };
}

function toLocal(g: Geometry, P: LocalProjection): Geometry {
  const pt = (p: Position): Position => P.toLocal(p[0], p[1]);
  if (g.type === "Point") return { type: "Point", coordinates: pt(g.coordinates) };
  if (g.type === "LineString") return { type: "LineString", coordinates: g.coordinates.map(pt) };
  // open the rings again (the world model stores rings without the repeated point)
  return {
    type: "Polygon",
    coordinates: g.coordinates.map((ring) => {
      const r = ring.map(pt);
      const a = r[0],
        b = r[r.length - 1];
      return r.length > 1 && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 ? r.slice(0, -1) : r;
    }),
  };
}

function anchorOf(e: Entity): Vec2 {
  const g = geometryOf(e);
  if (g.type === "Point") return g.coordinates;
  if (g.type === "Polygon") return polyCentroid(g.coordinates as Polygon);
  const path = g.coordinates as Vec2[];
  return path[Math.floor((path.length - 1) / 2)] ?? path[0];
}

function useTypeOf(e: Entity): string | null {
  switch (e.kind) {
    case "building":
      return e.use;
    case "street":
      return e.cls;
    case "area":
    case "path":
    case "place":
    case "utility":
      return e.type;
    case "tree":
      return e.species ?? null;
    case "node":
      return e.plaza ? "plaza" : e.control;
    case "stop":
    case "route":
      return e.mode;
    case "prop":
      return e.type;
    case "poi":
      return e.category;
    case "parcel":
      return e.zoning;
  }
}

function areaOf(e: Entity): number | null {
  switch (e.kind) {
    case "building":
      return polyArea(e.footprint);
    case "area":
    case "parcel":
      return polyArea(e.poly);
    case "place":
      return e.poly ? polyArea(e.poly) : null;
    case "tree":
      return Math.PI * e.r * e.r;
    case "street":
      return polyLength(e.path) * sectionWidth(e.section);
    case "prop":
      return e.footprint ? polyArea(e.footprint) : null;
    default:
      return null;
  }
}

function placementLonLat(lib: LibraryRef, P: LocalProjection): ChangeRow["library_placement"] {
  const pt = (p: Vec2): [number, number] => {
    const [lon, lat] = P.toLonLat(p);
    return [r7(lon), r7(lat)];
  };
  const pl = lib.placement ?? {};
  return {
    ...(pl.at ? { at: pt(pl.at) } : {}),
    ...(pl.rotation != null ? { rotation: pl.rotation } : {}),
    ...(pl.site ? { site: pl.site.map((ring) => ring.map(pt)) } : {}),
    ...(pl.path ? { path: pl.path.map(pt) } : {}),
  };
}

function changedKeys(before: Entity, after: Entity): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const k of keys) if (JSON.stringify((before as never)[k]) !== JSON.stringify((after as never)[k])) out.push(k);
  return out.sort();
}

function rowOf(R: Runtime, P: LocalProjection, action: ChangeAction, e: Entity, before?: Entity): ChangeFeature {
  const [lon, lat] = P.toLonLat(anchorOf(e));
  const prog = e.kind === "building" ? programmeOf(e, R.meta.calibration.householdSize) : null;
  const lib = "lib" in e ? e.lib : undefined;
  const area = areaOf(e);
  const height = e.kind === "building" || e.kind === "prop" ? e.height : e.kind === "tree" ? e.h : null;
  return {
    type: "Feature",
    id: e.id,
    geometry: toLonLat(geometryOf(e), P),
    properties: {
      action,
      kind: e.kind,
      id: e.id,
      name: ("name" in e && e.name) || null,
      use_type: useTypeOf(e),
      floors: e.kind === "building" ? e.floors : null,
      height_m: finite(height) ? r1(height) : null,
      area_m2: finite(area) ? r1(area) : null,
      units: prog ? Math.round(prog.units) : null,
      jobs: prog ? Math.round(prog.jobs) : null,
      lon: r7(lon),
      lat: r7(lat),
      library_def: lib?.def ?? null,
      library_params: lib?.params ?? null,
      library_instance: lib?.instance ?? null,
      library_placement: lib ? placementLonLat(lib, P) : null,
      changed: before ? changedKeys(before, e) : null,
    },
  };
}

const KIND_ORDER: EntityKind[] = ["building", "prop", "area", "tree", "street", "node", "path", "stop", "route", "parcel", "place", "poi", "utility"];
const ACTION_ORDER: ChangeAction[] = ["added", "modified", "removed"];

/** the features a scenario adds, modifies and removes against the existing city */
export function changesOf(R: Runtime, scenarioId = R.scenarios.activeId): ChangeFeature[] {
  const P = projectionOf(R);
  const { added, modified, removed, a, b } = R.scenarios.diff("baseline", scenarioId);
  const out = [...added.map((id) => rowOf(R, P, "added", b.get(id)!)), ...modified.map((id) => rowOf(R, P, "modified", b.get(id)!, a.get(id)!)), ...removed.map((id) => rowOf(R, P, "removed", a.get(id)!))];
  const ord = (f: ChangeFeature) => ACTION_ORDER.indexOf(f.properties.action) * 100 + KIND_ORDER.indexOf(f.properties.kind);
  return out.sort((x, y) => ord(x) - ord(y) || (x.properties.name ?? "￿").localeCompare(y.properties.name ?? "￿") || x.id.localeCompare(y.id));
}

function entryOf(R: Runtime, s: Scenario): ProposalEntry {
  const features = changesOf(R, s.id);
  const byKind: ProposalEntry["summary"]["byKind"] = {};
  const count = { added: 0, modified: 0, removed: 0 };
  for (const f of features) {
    const k = (byKind[f.properties.kind] ??= { added: 0, modified: 0, removed: 0 });
    k[f.properties.action]++;
    count[f.properties.action]++;
  }
  // programme change: everything the proposal builds minus everything it replaces
  const { a, b, added, modified, removed } = R.scenarios.diff("baseline", s.id);
  const hh = R.meta.calibration.householdSize;
  const prog = (e: Entity | undefined) => (e?.kind === "building" ? programmeOf(e, hh) : { units: 0, jobs: 0, gfa: 0 });
  let units = 0,
    jobs = 0,
    gfa = 0;
  for (const id of [...added, ...modified]) {
    const p = prog(b.get(id));
    units += p.units;
    jobs += p.jobs;
    gfa += p.gfa;
  }
  for (const id of [...modified, ...removed]) {
    const p = prog(a.get(id));
    units -= p.units;
    jobs -= p.jobs;
    gfa -= p.gfa;
  }
  const applied = s.changesets.slice(0, s.cursor);
  return {
    name: s.name,
    ...(s.description ? { description: s.description } : {}),
    author: s.author,
    color: s.color,
    basedOn: s.parentId ? (R.scenarios.scenarios.get(s.parentId)?.name ?? null) : null,
    edits: applied.length,
    summary: { ...count, byKind, units: Math.round(units), jobs: Math.round(jobs), gfa_m2: Math.round(gfa) },
    history: applied.map((c) => ({ label: c.label, author: c.author, time: new Date(c.time).toISOString() })),
    changes: { type: "FeatureCollection", features },
    changesets: applied,
  };
}

/** scenarios that change something (the existing city itself is never exported) */
export function exportableScenarios(R: Runtime): Scenario[] {
  return [...R.scenarios.scenarios.values()].filter((s) => s.id !== "baseline" && s.cursor > 0);
}

/** the proposal file for the active scenario, or every scenario that has edits ("all") */
export function proposalJSON(R: Runtime, which: "active" | "all" = "active", now = new Date()): ProposalFile {
  const list = which === "all" ? exportableScenarios(R) : [R.scenarios.active].filter((s) => s.id !== "baseline" && s.cursor > 0);
  return {
    format: PROPOSAL_FORMAT,
    version: PROPOSAL_VERSION,
    app: { name: "Meridian", ...(typeof window !== "undefined" ? { url: window.location.origin } : {}) },
    exportedAt: now.toISOString(),
    city: { id: R.cityId, name: R.meta.name, region: R.meta.region, sandbox: !!R.meta.sandbox, climate: R.climateId },
    crs: {
      local: "changesets: metres on a local tangent plane, x east and y north of the origin; rings are open (first point not repeated)",
      origin: { lon: R.meta.origin.lon, lat: R.meta.origin.lat },
      lonlat: "changes: WGS 84 longitude, latitude (EPSG:4326), projected from the local plane; polygon rings are closed",
    },
    proposals: list.map((s) => entryOf(R, s)),
  };
}

// ------------------------------------------------------------------ CSV

export const CSV_COLUMNS = ["proposal", "city", "action", "kind", "id", "name", "use_type", "floors", "height_m", "area_m2", "units", "jobs", "lon", "lat", "geometry_wkt", "library_def", "library_params", "library_instance", "library_placement", "changed"] as const;
type CsvColumn = (typeof CSV_COLUMNS)[number];

/** RFC 4180 field: quoted when it holds a comma, quote, CR or LF (quotes doubled) */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** RFC 4180 parser (also accepts LF line ends and a leading byte-order mark) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let any = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
      continue;
    }
    if (c === '"') {
      q = true;
      any = true;
    } else if (c === ",") {
      row.push(f);
      f = "";
      any = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
      any = false;
    } else {
      f += c;
      any = true;
    }
  }
  if (q) throw new Error("CSV: a quoted field is never closed");
  if (any || f) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const num = (x: number) => String(x);
function wktOf(g: Geometry): string {
  const pt = (p: Position) => `${num(p[0])} ${num(p[1])}`;
  if (g.type === "Point") return `POINT (${pt(g.coordinates)})`;
  if (g.type === "LineString") return `LINESTRING (${g.coordinates.map(pt).join(", ")})`;
  return `POLYGON (${g.coordinates.map((r) => `(${r.map(pt).join(", ")})`).join(", ")})`;
}

export function parseWkt(s: string): Geometry {
  const m = /^\s*(POINT|LINESTRING|POLYGON)\s*(?:Z\s*)?\((.*)\)\s*$/is.exec(s);
  if (!m) throw new Error(`not WKT: ${s.slice(0, 40)}`);
  const pts = (t: string): Position[] =>
    t
      .split(",")
      .map((p) => p.trim().split(/\s+/).map(Number))
      .map((p) => {
        if (p.length < 2 || !p.every(Number.isFinite)) throw new Error(`bad WKT coordinate in ${s.slice(0, 40)}`);
        return [p[0], p[1]] as Position;
      });
  const type = m[1].toUpperCase();
  if (type === "POINT") return { type: "Point", coordinates: pts(m[2])[0] };
  if (type === "LINESTRING") return { type: "LineString", coordinates: pts(m[2]) };
  const rings = [...m[2].matchAll(/\(([^()]*)\)/g)].map((r) => pts(r[1]));
  if (!rings.length) throw new Error(`bad WKT polygon ${s.slice(0, 40)}`);
  return { type: "Polygon", coordinates: rings };
}

/** one row per changed feature of the active scenario */
export function proposalCSV(R: Runtime, scenarioId = R.scenarios.activeId): string {
  const s = R.scenarios.scenarios.get(scenarioId)!;
  const rows: unknown[][] = [[...CSV_COLUMNS]];
  for (const f of changesOf(R, scenarioId)) {
    const p = f.properties;
    const rec: Record<CsvColumn, unknown> = {
      proposal: s.name,
      city: R.cityId,
      action: p.action,
      kind: p.kind,
      id: p.id,
      name: p.name,
      use_type: p.use_type,
      floors: p.floors,
      height_m: p.height_m,
      area_m2: p.area_m2,
      units: p.units,
      jobs: p.jobs,
      lon: p.lon,
      lat: p.lat,
      geometry_wkt: wktOf(f.geometry),
      library_def: p.library_def,
      library_params: p.library_params,
      library_instance: p.library_instance,
      library_placement: p.library_placement,
      changed: p.changed?.join(" ") ?? null,
    };
    rows.push(CSV_COLUMNS.map((c) => rec[c]));
  }
  return toCsv(rows);
}

// ------------------------------------------------------------------ import

export interface ImportResult {
  /** ids of the scenarios created */
  scenarios: string[];
  names: string[];
  /** what could not be carried exactly (CSV) or other notices */
  notes: string[];
}

export class ProposalImportError extends Error {}

function uniqueName(R: Runtime, name: string): string {
  const taken = new Set([...R.scenarios.scenarios.values()].map((s) => s.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`)) return `${name} (${i})`;
}

/** check every changeset applies, in order, to the existing city (ids added are new, ids changed exist) */
function checkApplies(R: Runtime, changesets: Changeset[]): string | null {
  const m = R.scenarios.materialize("baseline");
  let stale = 0;
  for (const cs of changesets) {
    if (!cs || !Array.isArray(cs.ops)) return "an edit in the file is malformed";
    for (const op of cs.ops as Op[]) {
      if (op.type === "add") {
        if (!op.entity?.id || !op.entity.kind) return "an edit in the file is malformed";
        if (m.has(op.entity.id)) return `it adds ${op.entity.id}, which already exists here`;
        m.set(op.entity.id, op.entity);
      } else if (op.type === "remove") {
        const cur = m.get(op.entity?.id);
        if (!cur) return `it removes ${op.entity?.id}, which is not in this city's data`;
        if (cur !== op.entity && JSON.stringify(cur) !== JSON.stringify(op.entity)) stale++;
        m.delete(op.entity.id);
      } else if (op.type === "update") {
        const cur = m.get(op.before?.id);
        if (!cur || !op.after?.id) return `it changes ${op.before?.id}, which is not in this city's data`;
        if (cur !== op.before && JSON.stringify(cur) !== JSON.stringify(op.before)) stale++;
        m.delete(op.before.id);
        m.set(op.after.id, op.after);
      } else return "an edit in the file is malformed";
    }
  }
  return stale ? `stale:${stale}` : null;
}

/** add a scenario branched from the existing city holding `changesets`, and make it active */
function addBranch(R: Runtime, name: string, changesets: Changeset[], opts: { author?: "user" | "agent"; description?: string } = {}): Scenario {
  const S = R.scenarios;
  const s = S.branch(uniqueName(R, name), opts.author ?? "user", "baseline", opts.description);
  if (S.activeId !== s.id) S.switchTo(s.id);
  for (const cs of changesets) S.commit(cs);
  return s;
}

function validateHeader(R: Runtime, d: { city?: { id?: string; name?: string; climate?: string } }) {
  const id = d.city?.id;
  if (id !== R.cityId) {
    const where = d.city?.name ?? id ?? "another city";
    throw new ProposalImportError(`This proposal was made for ${where}, not ${R.meta.name}. Open ${where} first, then import it there.`);
  }
}

/** read a proposal JSON file (or a blank-canvas design file) into new scenarios */
export function importProposalJSON(R: Runtime, text: string): ImportResult {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(text);
  } catch {
    throw new ProposalImportError("This file is not JSON.");
  }
  if (d?.format === LEGACY_DESIGN_FORMAT) return importLegacyDesign(R, d);
  if (d?.format !== PROPOSAL_FORMAT) throw new ProposalImportError("This is not a Meridian proposal file.");
  if (typeof d.version !== "number" || d.version > PROPOSAL_VERSION || d.version < 1)
    throw new ProposalImportError(`This proposal file is version ${String(d.version)}; this copy of Meridian reads version ${PROPOSAL_VERSION}. Update Meridian to open it.`);
  const f = d as unknown as ProposalFile;
  validateHeader(R, f);
  if (!Array.isArray(f.proposals) || !f.proposals.length) throw new ProposalImportError("The file holds no proposals.");
  const notes: string[] = [];
  for (const p of f.proposals) {
    if (!Array.isArray(p.changesets)) throw new ProposalImportError(`“${p.name}” has no edits to import.`);
    const bad = checkApplies(R, p.changesets);
    if (bad?.startsWith("stale:")) notes.push(`${bad.slice(6)} feature(s) in “${p.name}” differ from this copy of ${R.meta.name}'s data; the proposal's version is used.`);
    else if (bad) throw new ProposalImportError(`“${p.name}” does not fit this copy of ${R.meta.name}: ${bad}.`);
  }
  const made = f.proposals.map((p) => addBranch(R, p.name || "Imported proposal", p.changesets, { author: p.author === "agent" ? "agent" : "user", description: p.description }));
  if (made.length > 1) R.scenarios.switchTo(made[0].id);
  return { scenarios: made.map((s) => s.id), names: made.map((s) => s.name), notes };
}

/** blank-canvas design files (all branches of a design, the format before proposal files) */
function importLegacyDesign(R: Runtime, d: Record<string, unknown>): ImportResult {
  if (!R.meta.sandbox) throw new ProposalImportError(`This is a blank-canvas design file. Open the blank canvas first, then import it there.`);
  const snap = d.scenarios as { changesets?: Changeset[]; scenarios?: { id: string; name: string; changesets: string[]; cursor: number; author: "user" | "agent"; description?: string }[] } | undefined;
  if (!snap?.changesets || !snap.scenarios) throw new ProposalImportError("This design file is damaged.");
  const byId = new Map(snap.changesets.map((c) => [c.id, c]));
  const made: Scenario[] = [];
  for (const s of snap.scenarios) {
    if (s.id === "baseline") continue;
    const cs = s.changesets
      .map((id) => byId.get(id))
      .filter((c): c is Changeset => !!c)
      .slice(0, s.cursor);
    if (!cs.length || checkApplies(R, cs)) continue;
    made.push(addBranch(R, s.name, cs, { author: s.author, description: s.description }));
  }
  if (!made.length) throw new ProposalImportError("The design file holds no edits.");
  R.scenarios.switchTo(made[0].id);
  return { scenarios: made.map((s) => s.id), names: made.map((s) => s.name), notes: [] };
}

const USES = new Set<Use>(["residential", "office", "retail", "mixed", "hotel", "civic", "education", "religious", "health", "industrial", "parking", "utility", "other"]);
const AREA_TYPES = new Set<AreaType>(["park", "plaza", "water", "grass", "wood", "parking", "retention", "raingarden", "permeable", "construction", "campus", "cemetery", "pitch"]);
const ROAD_CLASSES = new Set<RoadClass>(["motorway", "motorway_link", "trunk", "primary", "secondary", "tertiary", "residential", "service", "living", "pedestrian", "busway"]);
const CONTROLS = new Set<NodeControl>(["signal", "stop", "none", "roundabout", "yield"]);
const PATH_TYPES = new Set<Path["type"]>(["footway", "cycleway", "path", "steps", "trail"]);
const MODES = new Set<TransitMode>(["bus", "rapid", "rail", "tram", "brt"]);

function programFor(use: Use): Partial<Record<Use, number>> {
  return use === "mixed" ? { residential: 0.82, retail: 0.12, office: 0.06 } : { [use]: 1 };
}

const near = (a: Vec2, b: Vec2, tol: number) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
const samePoly = (a: Polygon, b: Polygon) => a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((p, j) => near(p, b[i][j], 0.05)));

/**
 * Re-create a CSV export as a new scenario: one edit replaying the rows (removed, then modified,
 * then added). Returns what could not be carried exactly in `notes`.
 */
export function importProposalCSV(R: Runtime, text: string, fallbackName = "Imported proposal"): ImportResult {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (e) {
    throw new ProposalImportError((e as Error).message);
  }
  const head = table[0]?.map((h) => h.trim().toLowerCase());
  const need: CsvColumn[] = ["action", "kind", "id", "geometry_wkt"];
  if (!head || need.some((c) => !head.includes(c))) throw new ProposalImportError(`This CSV is not a Meridian proposal export (it needs the columns ${need.join(", ")}).`);
  const col = (r: string[], c: CsvColumn) => {
    const i = head.indexOf(c);
    return i >= 0 ? (r[i] ?? "").trim() : "";
  };
  const rows = table.slice(1).filter((r) => r.some((x) => x.trim()));
  if (!rows.length) throw new ProposalImportError("The CSV has no rows.");
  const city = col(rows[0], "city");
  if (city && city !== R.cityId) throw new ProposalImportError(`This proposal was made for ${city === "sandbox" ? "the blank canvas" : city}, not ${R.meta.name}. Open it first, then import it there.`);

  const P = projectionOf(R);
  const S = R.scenarios;
  const base = S.materialize("baseline");
  const ops: Op[] = [];
  const cur = new Map(base);
  const notes = new Map<string, number>();
  const note = (s: string) => notes.set(s, (notes.get(s) ?? 0) + 1);
  const tag = newId("op");
  const source = "Imported from a proposal CSV";
  const ground = (p: Vec2) => {
    const v = sampleGrid(R.meta.grid, R.dem, p);
    return Number.isFinite(v) ? v / 10 : 150;
  };
  const put = (e: Entity) => {
    const before = cur.get(e.id);
    ops.push(before ? { type: "update", before, after: e } : { type: "add", entity: e });
    cur.set(e.id, e);
  };
  const drop = (id: string) => {
    const e = cur.get(id);
    if (!e) return false;
    ops.push({ type: "remove", entity: e });
    cur.delete(id);
    return true;
  };
  const numOr = (s: string, d: number | undefined) => (s !== "" && Number.isFinite(Number(s)) ? Number(s) : d);
  const json = <T>(s: string): T | null => {
    if (!s) return null;
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  };

  type Parsed = { action: ChangeAction; kind: EntityKind; id: string; name?: string; type: string; floors?: number; height?: number; area?: number; geo: Geometry | null; lib: LibraryRef | null; raw: string[] };
  const parsed: Parsed[] = [];
  for (const r of rows) {
    const action = col(r, "action") as ChangeAction;
    const kind = col(r, "kind") as EntityKind;
    if (!ACTION_ORDER.includes(action) || !KIND_ORDER.includes(kind)) {
      note("rows with an unknown action or kind were skipped");
      continue;
    }
    let geo: Geometry | null = null;
    try {
      geo = col(r, "geometry_wkt") ? toLocal(parseWkt(col(r, "geometry_wkt")), P) : null;
    } catch {
      note("rows with unreadable geometry were skipped");
      continue;
    }
    const def = col(r, "library_def");
    const pl = json<ChangeRow["library_placement"]>(col(r, "library_placement"));
    const loc = (p: [number, number]) => P.toLocal(p[0], p[1]);
    const lib: LibraryRef | null = def
      ? {
          def,
          instance: col(r, "library_instance") || newId("lib"),
          params: json<Record<string, unknown>>(col(r, "library_params")) ?? {},
          placement: {
            ...(pl?.at ? { at: loc(pl.at) } : {}),
            ...(pl?.rotation != null ? { rotation: pl.rotation } : {}),
            ...(pl?.site ? { site: pl.site.map((ring) => ring.map(loc)) } : {}),
            ...(pl?.path ? { path: pl.path.map(loc) } : {}),
          },
        }
      : null;
    parsed.push({ action, kind, id: col(r, "id"), name: col(r, "name") || undefined, type: col(r, "use_type"), floors: numOr(col(r, "floors"), undefined), height: numOr(col(r, "height_m"), undefined), area: numOr(col(r, "area_m2"), undefined), geo, lib, raw: r });
  }

  // 1. removals
  for (const p of parsed) if (p.action === "removed" && !drop(p.id)) note("removed features not in this city's data were ignored");

  // nodes first so streets can find their ends; then everything else
  const nodeAt = (pt: Vec2): string => {
    for (const e of cur.values()) if (e.kind === "node" && near(e.p, pt, 0.3)) return e.id;
    const n: StreetNode = { id: newId("n"), kind: "node", p: pt, control: "none", edges: [] };
    put(n);
    return n.id;
  };
  const fresh = (id: string, prefix: string) => (id && !cur.has(id) ? id : newId(prefix));

  // 2. library instances are placed again from their definition and parameters after the rows
  // (step 4), when the definition is known here; their rows are not re-created one by one
  ensureLibrary();
  const instances = new Map<string, LibraryRef & { name?: string }>();
  for (const p of parsed) if (p.action === "added" && p.lib && getPrimitive(p.lib.def) && (!instances.has(p.lib.instance) || p.name)) instances.set(p.lib.instance, { ...p.lib, name: p.name ?? instances.get(p.lib.instance)?.name });

  // 3. modified and added rows, kind by kind (nodes before streets)
  const order = (p: Parsed) => (p.action === "modified" ? 0 : 1) * 100 + (p.kind === "node" ? 0 : 1);
  for (const p of parsed.filter((x) => x.action !== "removed").sort((a, b) => order(a) - order(b))) {
    if (p.action === "added" && p.lib && instances.has(p.lib.instance)) continue;
    const was = p.action === "modified" ? cur.get(p.id) : undefined;
    if (p.action === "modified" && !was) {
      note("modified features not in this city's data were ignored");
      continue;
    }
    const g = p.geo;
    const lib = p.lib ? { lib: p.lib } : {};
    switch (p.kind) {
      case "building": {
        if (g?.type !== "Polygon") {
          note("buildings without a footprint were skipped");
          break;
        }
        const fp = g.coordinates as Polygon;
        const use = (USES.has(p.type as Use) ? p.type : (was as Building | undefined)?.use ?? "other") as Use;
        const height = p.height ?? (was as Building | undefined)?.height ?? 10;
        const floors = Math.max(1, Math.round(p.floors ?? (was as Building | undefined)?.floors ?? height / 3.2));
        const prev = was as Building | undefined;
        let masses: Building["masses"];
        if (prev && samePoly(prev.footprint, fp)) masses = Math.abs(prev.height - height) > 0.05 ? stretchAbovePodium(prev.masses, height) : prev.masses;
        else {
          masses = [{ poly: fp, base: 0, top: height, role: "body", use }];
          if (prev || p.action === "added") note("building massing beyond one extruded footprint (setbacks, roofs, facade style) is not carried by CSV");
        }
        const b: Building = {
          ...(prev ?? { id: fresh(p.id, "b"), kind: "building", ground: ground(polyCentroid(fp)), heightSource: "proposed", useSource: "proposed", source, createdBy: tag }),
          footprint: fp,
          masses: masses.map((m) => ({ ...m, use: m.use === prev?.use || !m.use ? use : m.use })),
          height,
          floors,
          use,
          program: prev && prev.use === use ? prev.program : programFor(use),
          name: p.name,
          ...lib,
        } as Building;
        put(b);
        break;
      }
      case "street": {
        if (g?.type !== "LineString" || g.coordinates.length < 2) {
          note("streets without a centreline were skipped");
          break;
        }
        const path = g.coordinates as Vec2[];
        const prev = was as Street | undefined;
        const cls = (ROAD_CLASSES.has(p.type as RoadClass) ? p.type : prev?.cls ?? "residential") as RoadClass;
        if (prev && (prev.section !== undefined || prev.cls !== cls)) note("street cross-section changes are not carried by CSV (sections were kept or reset to the class default)");
        if (!prev) note("re-created streets get their class's default cross-section (CSV does not carry sections)");
        const s: Street = prev
          ? { ...prev, path, cls, name: p.name }
          : {
              id: fresh(p.id, "s"),
              kind: "street",
              from: nodeAt(path[0]),
              to: nodeAt(path[path.length - 1]),
              path,
              name: p.name,
              cls,
              oneway: false,
              section: buildSection({ cls, oneway: false, parkingLeft: cls === "residential", parkingRight: cls === "residential", downtown: true }),
              speed: cls === "primary" ? 56 : cls === "secondary" ? 48 : cls === "tertiary" ? 40 : 32,
              rowSource: "proposed",
              sectionSource: "proposed",
              source,
              createdBy: tag,
              ...lib,
            };
        put(s);
        break;
      }
      case "node": {
        if (g?.type !== "Point") break;
        const prev = was as StreetNode | undefined;
        const plaza = p.type === "plaza";
        const control = (CONTROLS.has(p.type as NodeControl) ? p.type : prev?.control ?? "none") as NodeControl;
        if (prev) put({ ...prev, control: plaza ? prev.control : control, plaza: plaza || undefined, p: g.coordinates });
        else if (![...cur.values()].some((e) => e.kind === "node" && near(e.p, g.coordinates, 0.3))) put({ id: fresh(p.id, "n"), kind: "node", p: g.coordinates, control, edges: [], ...(plaza ? { plaza } : {}) });
        if (control === "roundabout") note("roundabout geometry (radius, lanes) is not carried by CSV");
        break;
      }
      case "area": {
        if (g?.type !== "Polygon") break;
        const prev = was as Area | undefined;
        const type = (AREA_TYPES.has(p.type as AreaType) ? p.type : prev?.type ?? "grass") as AreaType;
        put({ ...(prev ?? { id: fresh(p.id, "a"), kind: "area", source, provenance: "proposed", createdBy: tag }), type, poly: g.coordinates as Polygon, name: p.name, ...lib } as Area);
        break;
      }
      case "tree": {
        if (g?.type !== "Point") break;
        const prev = was as Tree | undefined;
        const r = p.area ? Math.sqrt(p.area / Math.PI) : prev?.r ?? 4;
        put({ ...(prev ?? { id: fresh(p.id, "t"), kind: "tree", source, provenance: "proposed", createdBy: tag }), p: g.coordinates, r: Math.round(r * 100) / 100, h: p.height ?? prev?.h ?? 8, species: p.type || prev?.species, ...lib } as Tree);
        break;
      }
      case "path": {
        if (g?.type !== "LineString") break;
        const prev = was as Path | undefined;
        const type = (PATH_TYPES.has(p.type as Path["type"]) ? p.type : prev?.type ?? "path") as Path["type"];
        put({ ...(prev ?? { id: fresh(p.id, "p"), kind: "path", source, createdBy: tag }), path: g.coordinates, type, name: p.name, ...lib } as Path);
        break;
      }
      case "stop": {
        if (g?.type !== "Point") break;
        const prev = was as TransitStop | undefined;
        const mode = (MODES.has(p.type as TransitMode) ? p.type : prev?.mode ?? "bus") as TransitMode;
        put({ ...(prev ?? { id: fresh(p.id, "st"), kind: "stop", routes: [], source, provenance: "proposed", createdBy: tag }), p: g.coordinates, name: p.name ?? prev?.name ?? "Stop", mode } as TransitStop);
        break;
      }
      case "prop": {
        const prev = was as Prop | undefined;
        if (prev && g?.type === "Point") put({ ...prev, p: g.coordinates, name: p.name });
        else note("props whose library definition is not available here were skipped (CSV does not carry their shape)");
        break;
      }
      default: {
        if (was && "name" in was) put({ ...was, name: p.name } as Entity);
        else note(`${p.kind} features cannot be re-created from CSV (use the JSON export)`);
      }
    }
  }
  if (!ops.length && !instances.size) throw new ProposalImportError("Nothing in the CSV could be applied to this city.");
  const name = col(rows[0], "proposal") || fallbackName;
  const s = addBranch(R, name, ops.length ? [makeChangeset(`Import ${name} (CSV)`, "user", ops)] : [], { description: "Imported from a proposal CSV" });
  // 4. library primitives, each regenerated as one edit (what they displaced is already in the rows)
  for (const lib of instances.values()) {
    const pl = lib.placement ?? {};
    const r = placePrimitive(R.world, { def: lib.def, params: lib.params as ParamValues, at: pl.at, rotation: pl.rotation, site: pl.site, path: pl.path, onConflict: "carve", lenient: true, name: lib.name }, { author: "user" });
    if (r.ok && r.changeset) R.scenarios.commit(r.changeset);
    else note(`library primitives that could not be placed again were skipped${r.error ? ` (${r.error})` : ""}`);
  }
  return { scenarios: [s.id], names: [s.name], notes: [...notes.entries()].map(([n, k]) => (k > 1 ? `${n} (${k})` : n)) };
}

/** pick the reader by content: JSON object, else CSV */
export function importProposalText(R: Runtime, text: string, fileName = ""): ImportResult {
  const t = text.replace(/^﻿/, "").trimStart();
  if (t.startsWith("{") || /\.json$/i.test(fileName)) return importProposalJSON(R, t);
  return importProposalCSV(R, t, fileName.replace(/\.[^.]+$/, "") || undefined);
}

// ------------------------------------------------------------------ files

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "proposal";

export function proposalFileName(R: Runtime, which: "active" | "all", ext: "json" | "csv", now = new Date()): string {
  const what = which === "all" ? "proposals" : slug(R.scenarios.active.name);
  return `meridian-${slug(R.meta.sandbox ? "canvas" : R.cityId)}-${what}-${now.toISOString().slice(0, 10)}.${ext}`;
}

/** save text as a file in the browser */
export function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function exportProposal(R: Runtime, format: "json" | "csv", which: "active" | "all" = "active") {
  const now = new Date();
  if (format === "json") download(proposalFileName(R, which, "json", now), JSON.stringify(proposalJSON(R, which, now), null, 2) + "\n", "application/json");
  else download(proposalFileName(R, "active", "csv", now), proposalCSV(R), "text/csv");
}
