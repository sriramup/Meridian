// Library primitive operations: place a PrimitiveDef instance into the world, re-configure it in
// place, move / rotate / duplicate / remove it. Generators are pure (src/library); this module
// stamps a LibraryRef on every generated entity, resolves conflicts with what is already there
// (buildings, street right-of-way, water, tree crowns, other props) and commits everything through
// OpBuilder, so undo, scenarios, persistence and the simulation worker see ordinary entities.
//
// Conflict policy (consistent with createBuilding / createArea / plantTreesAt):
//  - buildings never stand in street right-of-way or open water: they are carved out of both.
//  - solid things never overlap (src/world/ops/collision.ts). A building over another instance's /
//    existing building or a solid prop: safe (default; the main building is refused with the reason
//    and the nearest free spot, a composite's secondary buildings that collide are skipped), refuse
//    (fail on any collision), carve (keep the other one and cut the new footprint around it) or
//    replace (demolish the other one; historic-designated buildings are never auto-demolished, they
//    are carved around instead). Move / rotate / duplicate / re-configure use the same default.
//  - land under a new building (lawns, parking, plazas) is cut back; trees and props inside it go.
//  - areas stay out of right-of-way (plazas excepted) and stop at the shoreline; they keep existing
//    buildings (cut around them) unless `replace`, which clears buildings mostly inside the area.
//  - trees need room for their whole crown (no trunk in a building, carriageway or water; crowns may
//    press into façades / other crowns only slightly); props stay off carriageways, out of
//    buildings, off water and off other props unless their definition's `siting` allows it.
//    Positions that fail are skipped and reported; a placement that ends with nothing fails.

import { bufferPoly, difference, isValidPoly, overlapArea, pointInPoly, polyArea, polyBBox, polyCentroid, rotatePoly, translatePoly, unionMany } from "@/geometry/polygon";
import { closestOnPath } from "@/geometry/polyline";
import { buildSection, kerbOffsets } from "@/geometry/crossSection";
import { dist, rotAround } from "@/geometry/vec";
import { sampleGrid } from "@/sim/raster";
import { rtMaybe } from "@/state/runtime";
import { ensureLibrary, getPrimitive, validateParams, type Generated, type GenerateContext, type ParamIssue, type ParamValues, type PlacementInput, type PrimitiveDef } from "@/library";
import { propFootprint, solidsHeight } from "@/library/frame";
import type { Area, Building, Entity, EntityKind, LibraryRef, Path, Polygon, Prop, Street, StreetNode, Tree, Vec2 } from "../types";
import { entityBBox, newId, type World } from "../world";
import type { BBox } from "../spatialIndex";
import type { Actor } from "./buildings";
import { OpBuilder, fmt, programmeOf, type OpResult } from "./core";
import { inStudyArea } from "./placement";
import { createStreet, type ConflictPolicy } from "./streets";
import { checkBuilding, streetBand } from "./validate";
import { blockedAt, clashes, describeOffset, nearestFreeOffset, obstacles } from "./collision";

export type ConflictMode = "safe" | "carve" | "refuse" | "replace";

/** the policy every op uses when the caller doesn't choose one: never overlap, never demolish */
export const DEFAULT_CONFLICT: ConflictMode = "safe";

export interface PlaceSpec {
  /** definition id or the definition itself */
  def: string | PrimitiveDef;
  params?: ParamValues;
  at?: Vec2;
  /** degrees counter-clockwise from east */
  rotation?: number;
  site?: Polygon;
  path?: Vec2[];
  /** what to do about existing buildings / solid props in the way (default safe: refuse the overlap) */
  onConflict?: ConflictMode;
  /** name for the instance's main entity */
  name?: string;
  /** apply coerced values but don't fail on unknown / invalid parameters (they are reported as warnings) */
  lenient?: boolean;
}

export interface InstanceInfo {
  instance: string;
  def: string;
  params: Record<string, unknown>;
  placement: LibraryRef["placement"];
  /** the main entity (the one the inspector edits) */
  primary: string;
  /** every entity of the instance, primary first */
  entities: string[];
}

export type LibraryOpResult = OpResult & { instance?: string; params?: ParamValues; issues?: ParamIssue[] };

const LIB_KINDS: EntityKind[] = ["building", "street", "area", "tree", "path", "prop"];
const R1 = (x: number) => Math.round(x * 10) / 10;

// ------------------------------------------------------------------ lookup

function libOf(e: Entity | undefined): LibraryRef | undefined {
  return e && "lib" in e ? (e as { lib?: LibraryRef }).lib : undefined;
}

/** every entity of an instance (pending-aware when a builder is given), primary first */
function membersOf(world: World, instance: string, b?: OpBuilder): Entity[] {
  const out: Entity[] = [];
  for (const k of LIB_KINDS)
    for (const id of world.byKind.get(k)!) {
      const e = b ? b.get(id) : world.get(id);
      if (e && libOf(e)?.instance === instance) out.push(e);
    }
  if (b) for (const e of b.touched()) if (libOf(e)?.instance === instance && !out.includes(e) && !world.get(e.id)) out.push(e);
  return out.sort((a, c) => Number(!!libOf(c)?.primary) - Number(!!libOf(a)?.primary));
}

/** the library instance an entity belongs to (by entity id or instance id) */
export function instanceOf(world: World, id: string): InstanceInfo | null {
  const e = world.get(id);
  const inst = libOf(e)?.instance ?? (id.startsWith("lib:") ? id : undefined);
  if (!inst) return null;
  const members = membersOf(world, inst);
  if (!members.length) return null;
  const ref = libOf(members[0])!;
  return { instance: inst, def: ref.def, params: ref.params, placement: ref.placement, primary: members[0].id, entities: members.map((m) => m.id) };
}

/** every library instance in the world */
export function listInstances(world: World): InstanceInfo[] {
  const by = new Map<string, Entity[]>();
  for (const k of LIB_KINDS)
    for (const id of world.byKind.get(k)!) {
      const e = world.get(id)!;
      const ref = libOf(e);
      if (!ref) continue;
      if (!by.has(ref.instance)) by.set(ref.instance, []);
      by.get(ref.instance)!.push(e);
    }
  return [...by.entries()].map(([instance, ms]) => {
    ms.sort((a, c) => Number(!!libOf(c)?.primary) - Number(!!libOf(a)?.primary));
    const ref = libOf(ms[0])!;
    return { instance, def: ref.def, params: ref.params, placement: ref.placement, primary: ms[0].id, entities: ms.map((m) => m.id) };
  });
}

function resolveDef(d: string | PrimitiveDef): PrimitiveDef | undefined {
  if (typeof d !== "string") return d;
  ensureLibrary();
  return getPrimitive(d);
}

// ------------------------------------------------------------------ pending-aware view

/** a plan layered over the builder: nothing touches the builder until commit(), so a failed placement leaves it untouched */
class View {
  readonly adds = new Map<string, Entity>();
  readonly removes = new Set<string>();
  constructor(readonly b: OpBuilder) {}
  get world() {
    return this.b.world;
  }
  get<T extends Entity = Entity>(id: string): T | undefined {
    if (this.removes.has(id)) return undefined;
    return (this.adds.get(id) as T | undefined) ?? this.b.get<T>(id);
  }
  near(bb: BBox, kinds: EntityKind[]): Entity[] {
    const ids = new Set<string>();
    for (const e of this.world.query(bb, kinds)) ids.add(e.id);
    const hit = (e: Entity) => {
      if (!kinds.includes(e.kind)) return false;
      const q = entityBBox(e);
      return q[0] <= bb[2] && q[2] >= bb[0] && q[1] <= bb[3] && q[3] >= bb[1];
    };
    for (const e of this.b.touched()) if (hit(e)) ids.add(e.id);
    for (const e of this.adds.values()) if (hit(e)) ids.add(e.id);
    const out: Entity[] = [];
    for (const id of ids) {
      const e = this.get(id);
      if (e && kinds.includes(e.kind)) out.push(e);
    }
    return out;
  }
  put<T extends Entity>(e: T): T {
    this.removes.delete(e.id);
    this.adds.set(e.id, e);
    return e;
  }
  del(id: string) {
    this.adds.delete(id);
    if (this.b.get(id)) this.removes.add(id);
  }
  commit() {
    for (const id of this.removes) this.b.remove(id);
    for (const e of this.adds.values()) (this.b.get(e.id) || this.b.isRemoved(e.id) || this.world.get(e.id) ? this.b.update(e) : this.b.add(e));
  }
}

const grow = (bb: BBox, d: number): BBox => [bb[0] - d, bb[1] - d, bb[2] + d, bb[3] + d];

function groundAt(p: Vec2): number {
  const R = rtMaybe();
  if (!R?.meta?.grid || !R.dem) return 150;
  const v = sampleGrid(R.meta.grid, R.dem, p);
  return Number.isFinite(v) ? v / 10 : 150;
}

function inCarriagewayV(v: View, p: Vec2): boolean {
  for (const e of v.near([p[0] - 25, p[1] - 25, p[0] + 25, p[1] + 25], ["street"])) {
    const s = e as Street;
    if (s.tunnel) continue;
    const c = closestOnPath(p, s.path);
    if (c.d > 25) continue;
    const a = s.path[c.seg],
      q = s.path[c.seg + 1] ?? a;
    const side = (q[0] - a[0]) * (p[1] - a[1]) - (q[1] - a[1]) * (p[0] - a[0]) >= 0 ? 1 : -1;
    const k = kerbOffsets(s.section, s.section.shift ?? 0);
    const off = side * c.d;
    if (off < k.left && off > k.right) return true;
  }
  return false;
}

const isWater = (a: Area) => a.type === "water" || a.type === "retention";
const biggest = (ps: Polygon[]) => ps.filter((q) => isValidPoly(q)).sort((a, c) => polyArea(c) - polyArea(a))[0];

// ------------------------------------------------------------------ collisions

const propFp = (q: Prop): Polygon => q.footprint ?? propFootprint(q.p, q.rot, q.solids);

/** a prop that takes up room (not a ground marking or something designed to overlap) */
export function isSolidProp(q: Prop): boolean {
  if (resolveDef(q.type)?.siting?.overlapProps) return false;
  return (q.height || solidsHeight(q.solids ?? [])) >= 0.4;
}

const nameOf = (b: Building) => b.name ?? (libOf(b) ? `${resolveDef(libOf(b)!.def)?.name ?? libOf(b)!.def} ${b.id}` : `building ${b.id}`);

/** " Nearest free spot: 4.2 m east, at [x, y]." for a refusal (empty when there is none close by) */
function freeHint(v: View, pieces: Polygon[], foreign: (e: Entity) => boolean, propsOnly = false): string {
  const bb = grow(pieces.map((p) => polyBBox(p)).reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])]), 40);
  const obs = obstacles(
    v
      .near(bb, ["building", "prop"])
      .filter((e) => foreign(e) && (e.kind === "building" || isSolidProp(e as Prop)))
      .map((e) => (e.kind === "building" ? (e as Building).footprint : propFp(e as Prop))),
  );
  if (!propsOnly) for (const e of v.near(bb, ["street"])) if (!(e as Street).tunnel) obs.push({ poly: streetBand(e as Street) });
  if (!blockedAt(pieces, obs)) return "";
  const d = nearestFreeOffset(pieces, obs, { maxR: 40, step: 1 });
  if (!d || (!d[0] && !d[1])) return "";
  const c = polyCentroid(pieces[0]);
  return ` Nearest free spot: ${describeOffset(d)}, at [${Math.round(c[0] + d[0])}, ${Math.round(c[1] + d[1])}].`;
}

// ------------------------------------------------------------------ generation

interface GenOpts {
  instance: string;
  onConflict: ConflictMode;
  name?: string;
  /** old entity ids to reuse, by kind (re-configuration keeps ids stable so selections survive) */
  reuse?: Map<EntityKind, string[]>;
  reusePrimary?: string;
  /** old entities (by reused id) whose user-set attributes carry over */
  previous?: Map<string, Entity>;
  /** names the old parameters generated (to tell a user's rename from a generated name) */
  oldNames?: Map<string, string | undefined>;
  /** old streets of the instance, kept as they are when the new generation asks for the same streets */
  oldStreets?: Street[];
  /** the street specs the old parameters generated */
  oldStreetKey?: string;
  /** parameter keys the caller changed */
  patchKeys?: string[];
}

function cleanPlacement(p: PlacementInput): LibraryRef["placement"] {
  const out: LibraryRef["placement"] = {};
  if (p.at) out.at = [p.at[0], p.at[1]];
  if (p.rotation != null && Number.isFinite(p.rotation)) out.rotation = p.rotation;
  if (p.site) out.site = p.site.map((r) => r.map((q) => [q[0], q[1]] as Vec2));
  if (p.path) out.path = p.path.map((q) => [q[0], q[1]] as Vec2);
  return out;
}

function placementProblem(def: PrimitiveDef, p: PlacementInput): string | null {
  const okPt = (q: unknown) => Array.isArray(q) && q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]);
  if (p.at && !okPt(p.at)) return "`at` must be an [x, y] point";
  if (p.site && !(Array.isArray(p.site[0]) && p.site[0].length >= 3 && p.site[0].every(okPt) && polyArea(p.site) > 1)) return "`site` must be a polygon of at least 3 points enclosing some area";
  if (p.path && !(p.path.length >= 2 && p.path.every(okPt))) return "`path` must have at least 2 points";
  switch (def.placement) {
    case "point":
      return p.at ? null : `${def.id} is placed at a point: give \`at\``;
    case "rect":
      return p.at || p.site ? null : `${def.id} is placed by a rectangle: give \`site\` (or \`at\` with width / depth parameters)`;
    case "polygon":
      return p.site ? null : `${def.id} needs a site polygon: give \`site\``;
    case "path":
      return p.path ? null : `${def.id} is drawn along a line: give \`path\``;
  }
}

function anchorOf(p: PlacementInput): Vec2 | null {
  if (p.at) return p.at;
  if (p.site) return polyCentroid(p.site);
  if (p.path?.length) return p.path[Math.floor(p.path.length / 2)];
  return null;
}

function runGenerator(world: World, def: PrimitiveDef, params: ParamValues, place: PlacementInput, instance: string): { gen?: Generated; ref: LibraryRef; error?: string } {
  const ref: LibraryRef = { def: def.id, instance, params, placement: cleanPlacement(place) };
  const ctx: GenerateContext = { id: (prefix: string) => newId(prefix), ref, householdSize: world.meta.calibration?.householdSize ?? 2.5 };
  try {
    const gen = def.generate(params, { ...place }, ctx);
    return { gen: gen ?? {}, ref };
  } catch (e) {
    return { ref, error: `${def.name} could not be generated: ${(e as Error).message}` };
  }
}

function describeCounts(kinds: Record<string, number>): string {
  const names: Record<string, [string, string]> = { building: ["building", "buildings"], prop: ["object", "objects"], tree: ["tree", "trees"], area: ["area", "areas"], path: ["path", "paths"], street: ["street segment", "street segments"] };
  return Object.entries(kinds)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${names[k]?.[n > 1 ? 1 : 0] ?? k}`)
    .join(", ");
}

/**
 * Generate an instance into the view. Returns an error (and leaves the view's builder untouched)
 * when the placement is refused; otherwise the plan is committed to the builder.
 */
function generateInto(v: View, def: PrimitiveDef, params: ParamValues, place: PlacementInput, actor: Actor, o: GenOpts): { error?: string; created: string[]; primary?: string; counts: Record<string, number> } {
  const b = v.b;
  const world = v.world;
  const { gen, ref, error } = runGenerator(world, def, params, place, o.instance);
  if (error || !gen) return { error, created: [], counts: {} };
  const summary: string[] = [];
  const warnings: string[] = [];
  const conflicts: { id: string; kind: string; message: string; resolved: boolean }[] = [];
  // a definition may let its users relax siting per instance with allow_* parameters
  const siting = { ...(def.siting ?? {}), ...(params.allow_carriageway === true ? { carriageway: true } : {}), ...(params.allow_water === true ? { water: true } : {}), ...(params.allow_on_buildings === true ? { onBuildings: true } : {}), ...(params.allow_overlap === true ? { overlapProps: true } : {}) };
  const source = actor.author === "agent" ? `Library: ${def.name} (agent)` : `Library: ${def.name}`;
  const foreign = (e: Entity) => libOf(e)?.instance !== o.instance;
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);

  // ---- id reuse (stable ids across re-configuration)
  const pool = new Map<EntityKind, string[]>([...(o.reuse ?? new Map<EntityKind, string[]>()).entries()].map(([k, ids]) => [k, ids.filter((id: string) => id !== o.reusePrimary)]));
  const primaryKind = o.reusePrimary ? o.previous?.get(o.reusePrimary)?.kind : undefined;
  let primaryUsed = false;
  const assignId = (e: Entity, isPrimary: boolean): string => {
    if (isPrimary && o.reusePrimary && !primaryUsed && e.kind === primaryKind) {
      primaryUsed = true;
      return o.reusePrimary;
    }
    const ids = pool.get(e.kind);
    return ids?.length ? ids.shift()! : e.id || newId(e.kind[0]);
  };

  // ---- primary: the generator's flag, else the first building / area / prop / tree / path
  const all: Entity[] = [...(gen.buildings ?? []), ...(gen.areas ?? []), ...(gen.props ?? []), ...(gen.trees ?? []), ...(gen.paths ?? [])];
  let primaryEnt = all.find((e) => libOf(e)?.primary);
  if (!primaryEnt) primaryEnt = all[0];
  const stamp = <T extends Entity>(e: T, isPrimary: boolean): T => {
    const lib: LibraryRef = { ...ref, ...(isPrimary ? { primary: true } : {}) };
    return { ...e, lib } as T;
  };
  const carry = <T extends Entity>(e: T, oldGenIndexKey: string): T => {
    const prev = o.previous?.get(e.id);
    if (!prev || prev.kind !== e.kind) return e;
    const out = { ...e } as T & { name?: string; greenRoof?: boolean; historic?: boolean };
    const pn = (prev as { name?: string }).name;
    // keep a name the user gave (one the old parameters did not generate)
    if (pn !== undefined && pn !== o.oldNames?.get(oldGenIndexKey) && !o.patchKeys?.includes("name") && o.name === undefined) out.name = pn;
    if (prev.kind === "building") {
      const pb = prev as Building;
      if (pb.greenRoof && out.greenRoof === undefined) out.greenRoof = true;
      if (pb.historic) out.historic = true;
    }
    return out;
  };

  const created: string[] = [];
  const counts: Record<string, number> = { building: 0, area: 0, path: 0, prop: 0, tree: 0, street: 0 };
  let primaryId: string | undefined;
  const nameIdx: Record<string, number> = {};
  const indexKey = (k: string) => `${k}:${(nameIdx[k] = (nameIdx[k] ?? -1) + 1)}`;

  // planned street bands (streets are created last, through the street ops)
  const plannedBands: Polygon[] = [];
  for (const s of gen.streets ?? []) {
    if (!s.path || s.path.length < 2) continue;
    const section = buildSection({ cls: s.cls, oneway: false, bikeLeft: s.bike ?? null, bikeRight: s.bike ?? null, parkingLeft: s.cls === "residential", parkingRight: s.cls === "residential", downtown: true });
    plannedBands.push(streetBand({ path: s.path, section } as Street));
  }

  // ---- buildings
  const prog = { gfa: 0, units: 0, jobs: 0, lines: [] as string[] };
  let felled = 0,
    propsCleared = 0;
  const displaced = new Map<string, number>();
  for (const raw of gen.buildings ?? []) {
    const isPrimary = raw === primaryEnt;
    const key = indexKey("building");
    let bld: Building = {
      ...raw,
      kind: "building",
      masses: (raw.masses ?? []).map((m) => ({ ...m, poly: m.poly, use: m.use ?? raw.use })),
      program: raw.program && Object.keys(raw.program).length ? raw.program : { [raw.use]: 1 },
      heightSource: "proposed",
      useSource: "proposed",
      source: raw.source || source,
      createdBy: b.tag,
    };
    if (!bld.masses.length && isValidPoly(bld.footprint)) bld.masses = [{ poly: bld.footprint, base: 0, top: bld.height || 3.5, role: "body", use: bld.use }];
    if (!isValidPoly(bld.footprint)) bld.footprint = biggest(unionMany(bld.masses.filter((m) => m.base < 0.5).map((m) => m.poly))) ?? bld.masses[0]?.poly;
    if (!isValidPoly(bld.footprint)) {
      warnings.push(`A building of ${def.name} had no valid footprint and was left out`);
      continue;
    }
    bld.id = assignId(bld, isPrimary);
    const bb = grow(polyBBox(bld.footprint), 30);
    const cut = (hole: Polygon) => {
      bld = { ...bld, masses: bld.masses.map((m) => ({ ...m, poly: biggest(difference(m.poly, hole)) ?? [[]] })).filter((m) => isValidPoly(m.poly)) };
      bld.footprint = biggest(difference(bld.footprint, hole)) ?? [[]];
    };
    const rawFp = bld.footprint;
    // street right-of-way (existing and planned) and open water
    for (const e of v.near(bb, ["street"])) {
      const s = e as Street;
      if (s.cls === "motorway" || s.cls === "motorway_link" || s.tunnel || s.private) continue;
      const band = streetBand(s);
      if (overlapArea(bld.footprint, band) > 0.5) {
        cut(band);
        if (isValidPoly(bld.footprint)) conflicts.push({ id: s.id, kind: "row", message: `Footprint cut back out of the right-of-way of ${s.name ?? "a street"}`, resolved: true });
      }
    }
    for (const band of plannedBands) if (isValidPoly(bld.footprint) && overlapArea(bld.footprint, band) > 0.5) cut(band);
    for (const e of v.near(bb, ["area"])) {
      const a = e as Area;
      if (isValidPoly(bld.footprint) && isWater(a) && overlapArea(a.poly, bld.footprint) > 1) cut(bufferPoly(a.poly, 2));
    }
    // other buildings and solid props: strict modes refuse any real overlap (touching walls are fine)
    const strict = o.onConflict === "safe" || o.onConflict === "refuse";
    if (strict && isValidPoly(bld.footprint)) {
      const hit = v.near(bb, ["building", "prop"]).find((e) => foreign(e) && e.id !== bld.id && (e.kind === "building" ? clashes(bld.footprint, (e as Building).footprint) : isSolidProp(e as Prop) && clashes(bld.footprint, propFp(e as Prop))));
      if (hit) {
        const nm = hit.kind === "building" ? nameOf(hit as Building) : `${resolveDef((hit as Prop).type)?.name ?? "an object"} ${hit.id}`;
        if (!isPrimary && o.onConflict === "safe") {
          skip("would overlap a building or object");
          continue;
        }
        return { error: `${def.name} would overlap ${nm}.${freeHint(v, [rawFp], foreign)} Move it, or use on_conflict "carve" (cut around it) or "replace" (demolish it).`, created: [], counts: {} };
      }
    }
    for (const e of v.near(bb, ["building"])) {
      if (strict || !isValidPoly(bld.footprint)) break;
      const other = e as Building;
      if (!foreign(other) || other.id === bld.id) continue;
      const ov = overlapArea(bld.footprint, other.footprint);
      if (ov <= 1) continue;
      const nm = nameOf(other);
      if (o.onConflict === "replace" && !other.historic) {
        v.del(other.id);
        conflicts.push({ id: other.id, kind: "overlap", message: `Demolished ${nm} (${fmt.area(ov)} overlap)`, resolved: true });
      } else {
        cut(bufferPoly(other.footprint, 1.5));
        conflicts.push({ id: other.id, kind: "overlap", message: other.historic && o.onConflict === "replace" ? `Kept historic-designated ${nm}; ${def.name} carved around it` : `Kept ${nm}; ${def.name} carved around it`, resolved: true });
      }
    }
    if (!isValidPoly(bld.footprint) || !bld.masses.length || polyArea(bld.footprint) < 4) {
      if (isPrimary) return { error: `Nothing of ${def.name} is left to build here after keeping clear of streets, water and existing buildings`, created: [], counts: {} };
      skip("no room for a building");
      continue;
    }
    bld.height = R1(Math.max(...bld.masses.map((m) => m.top)));
    if (!Number.isFinite(bld.ground)) bld.ground = groundAt(polyCentroid(bld.footprint));
    if (!bld.floors || !Number.isFinite(bld.floors)) bld.floors = Math.max(1, Math.round(bld.height / 3.5));
    if (o.name && isPrimary) bld.name = o.name;
    bld = carry(stamp(bld, isPrimary), key);
    // land under the footprint is cut back; trees and props inside it are removed
    const cutter = bufferPoly(bld.footprint, 0.5);
    for (const e of v.near(polyBBox(bld.footprint), ["area", "tree", "prop"])) {
      if (!foreign(e)) continue;
      if (e.kind === "area") {
        const a = e as Area;
        if (a.type === "campus" || isWater(a)) continue;
        const ov = overlapArea(a.poly, bld.footprint);
        if (ov < 2) continue;
        displaced.set(a.type, (displaced.get(a.type) ?? 0) + ov);
        const rem = difference(a.poly, cutter).filter((q) => isValidPoly(q) && polyArea(q) > 25).sort((x, y) => polyArea(y) - polyArea(x));
        if (!rem.length) v.del(a.id);
        else {
          v.put<Area>({ ...a, poly: rem[0] });
          for (const q of rem.slice(1, 4)) v.put<Area>({ ...a, id: newId("a"), poly: q });
        }
      } else if (e.kind === "tree" && pointInPoly((e as Tree).p, bld.footprint)) {
        v.del(e.id);
        felled++;
      } else if (e.kind === "prop" && pointInPoly((e as Prop).p, bld.footprint)) {
        const pd = resolveDef((e as Prop).type);
        if (pd?.siting?.onBuildings) continue;
        v.del(e.id);
        propsCleared++;
      }
    }
    v.put(bld);
    created.push(bld.id);
    counts.building++;
    if (bld.lib?.primary) primaryId = bld.id;
    const pr = programmeOf(bld, world.meta.calibration?.householdSize);
    prog.gfa += pr.gfa;
    prog.units += pr.units;
    prog.jobs += pr.jobs;
    prog.lines.push(`${bld.name ?? def.name}: ${bld.floors} floor${bld.floors > 1 ? "s" : ""}, ${fmt.m(bld.height)}, ${progText(pr)}`);
    for (const iss of checkBuilding(world, bld, new Set([bld.id]))) {
      if (iss.kind === "overlap" || iss.kind === "row") continue;
      if (iss.severity === "error") conflicts.push({ id: bld.id, kind: iss.kind, message: iss.message, resolved: false });
      else warnings.push(iss.message);
    }
  }

  // one line per building when there is one (and the generator says nothing); otherwise the programme totals
  if (prog.lines.length === 1 && !gen.summary?.length) summary.push(prog.lines[0]);
  else if (prog.lines.length) summary.push(`Programme${prog.lines.length > 1 ? ` (${prog.lines.length} buildings)` : ""}: ${progText(prog)}`);

  // ---- areas
  for (const raw of gen.areas ?? []) {
    const isPrimary = raw === primaryEnt;
    const key = indexKey("area");
    let polys: Polygon[] = [raw.poly];
    const bb = grow(polyBBox(raw.poly), 30);
    if (raw.type !== "plaza" && !siting.carriageway)
      for (const e of v.near(bb, ["street"])) {
        const s = e as Street;
        if (s.tunnel || s.cls === "motorway") continue;
        const band = streetBand(s);
        if (overlapArea(raw.poly, band) > 2) polys = polys.flatMap((q) => difference(q, band));
      }
    for (const e of v.near(bb, ["area"])) {
      const a = e as Area;
      if (!foreign(a)) continue;
      const ov = overlapArea(a.poly, raw.poly);
      if (ov < 2) continue;
      if (isWater(a) && !isWater(raw) && !siting.water) {
        polys = polys.flatMap((q) => difference(q, a.poly));
        continue;
      }
      if (raw.type === "campus" || a.type === "campus") continue; // campuses contain other land uses
      const rem = difference(a.poly, raw.poly).sort((x, y) => polyArea(y) - polyArea(x))[0];
      displaced.set(a.type, (displaced.get(a.type) ?? 0) + ov);
      if (rem && polyArea(rem) > 25) v.put<Area>({ ...a, poly: rem });
      else v.del(a.id);
    }
    if (raw.type !== "campus")
      for (const e of v.near(bb, ["building"])) {
        const bd = e as Building;
        if (!foreign(bd)) continue;
        const ov = overlapArea(bd.footprint, raw.poly);
        if (ov <= 1) continue;
        if (o.onConflict === "replace" && !bd.historic && ov >= 0.25 * polyArea(bd.footprint)) {
          v.del(bd.id);
          conflicts.push({ id: bd.id, kind: "overlap", message: `Demolished ${bd.name ?? "building " + bd.id} inside the new ${raw.type}`, resolved: true });
        } else if (o.onConflict === "refuse" && ov >= 0.25 * polyArea(bd.footprint)) {
          return { error: `${def.name} would cover ${bd.name ?? "building " + bd.id}. Move it, or use on_conflict "carve" or "replace".`, created: [], counts: {} };
        } else polys = polys.flatMap((q) => difference(q, bd.footprint));
      }
    if (isWater(raw))
      for (const e of v.near(bb, ["tree", "prop"])) {
        if (!foreign(e)) continue;
        const p = (e as Tree | Prop).p;
        if (polys.some((q) => pointInPoly(p, q))) {
          if (e.kind === "prop" && resolveDef((e as Prop).type)?.siting?.water) continue;
          v.del(e.id);
          e.kind === "tree" ? felled++ : propsCleared++;
        }
      }
    const pieces = polys.filter((q) => isValidPoly(q) && polyArea(q) >= 4).sort((a, c) => polyArea(c) - polyArea(a));
    if (!pieces.length) {
      if (isPrimary) return { error: `No usable ground for ${def.name} after keeping clear of streets, water and buildings`, created: [], counts: {} };
      skip("no room for an area");
      continue;
    }
    pieces.forEach((q, k) => {
      const prim = isPrimary && k === 0;
      let a: Area = { ...raw, kind: "area", poly: q, source: raw.source || source, provenance: "proposed", createdBy: b.tag };
      a.id = k === 0 ? assignId(a, prim) : newId("a");
      if (o.name && prim) a.name = o.name;
      a = carry(stamp(a, prim), key);
      v.put(a);
      created.push(a.id);
      counts.area++;
      if (prim) primaryId = a.id;
    });
  }

  // ---- paths
  for (const raw of gen.paths ?? []) {
    const isPrimary = raw === primaryEnt;
    const key = indexKey("path");
    if (!raw.path || raw.path.length < 2) continue;
    let p: Path = { ...raw, kind: "path", source: raw.source || source, createdBy: b.tag };
    p.id = assignId(p, isPrimary);
    if (o.name && isPrimary) p.name = o.name;
    p = carry(stamp(p, isPrimary), key);
    v.put(p);
    created.push(p.id);
    counts.path++;
    if (isPrimary) primaryId = p.id;
  }

  // ---- props
  for (const raw of gen.props ?? []) {
    const isPrimary = raw === primaryEnt;
    const key = indexKey("prop");
    const solids = raw.solids ?? [];
    const rot = Number.isFinite(raw.rot) ? raw.rot : 0;
    let pr: Prop = { ...raw, kind: "prop", type: raw.type || def.id, rot, solids, height: raw.height || solidsHeight(solids), footprint: raw.footprint && isValidPoly(raw.footprint) ? raw.footprint : propFootprint(raw.p, rot, solids), source: raw.source || source, provenance: "proposed", createdBy: b.tag };
    const fp = pr.footprint!;
    const bb = polyBBox(fp);
    let why: string | null = null;
    if (!inStudyArea(world, pr.p)) why = "outside the study area";
    else if (!siting.carriageway && inCarriagewayV(v, pr.p)) why = "in the roadway";
    else if (!siting.onBuildings && v.near(grow(bb, 1), ["building"]).some((e) => pointInPoly(pr.p, (e as Building).footprint) || clashes((e as Building).footprint, fp))) why = "inside a building";
    else if (!siting.water && v.near(bb, ["area"]).some((e) => isWater(e as Area) && pointInPoly(pr.p, (e as Area).poly))) why = "on water";
    else if (!siting.overlapProps)
      for (const e of v.near(bb, ["prop"])) {
        const q = e as Prop;
        if (q.id === pr.id || resolveDef(q.type)?.siting?.overlapProps) continue;
        const qf = q.footprint ?? propFootprint(q.p, q.rot, q.solids);
        if (clashes(qf, fp)) {
          why = "on top of another object";
          break;
        }
      }
    if (!why && !siting.overlapProps && isSolidProp(pr) && v.near(bb, ["tree"]).some((e) => foreign(e) && pointInPoly((e as Tree).p, fp))) why = "on a tree";
    if (why) {
      if (isPrimary && (gen.props?.length ?? 0) === 1 && !(gen.buildings?.length || gen.areas?.length)) return { error: `${def.name} can't stand at [${Math.round(pr.p[0])}, ${Math.round(pr.p[1])}]: ${why}.${why === "inside a building" || why === "on top of another object" ? freeHint(v, [fp], foreign, true) : ""}`, created: [], counts: {} };
      skip(why);
      continue;
    }
    pr.id = assignId(pr, isPrimary);
    if (o.name && isPrimary) pr.name = o.name;
    pr = carry(stamp(pr, isPrimary), key);
    v.put(pr);
    created.push(pr.id);
    counts.prop++;
    if (isPrimary) primaryId = pr.id;
  }

  // ---- trees (room for the whole crown)
  const GIVE = 0.85;
  for (const raw of gen.trees ?? []) {
    const isPrimary = raw === primaryEnt;
    const key = indexKey("tree");
    const r = raw.r > 0 ? raw.r : 4;
    const p = raw.p;
    const reach = r + 12;
    const around = v.near([p[0] - reach, p[1] - reach, p[0] + reach, p[1] + reach], ["building", "tree", "area"]);
    const blds = around.filter((e): e is Building => e.kind === "building");
    let why: string | null = null;
    if (!inStudyArea(world, p)) why = "outside the study area";
    else if (blds.some((x) => pointInPoly(p, x.footprint))) why = "inside a building";
    else if (around.some((e) => e.kind === "area" && isWater(e as Area) && pointInPoly(p, (e as Area).poly))) why = "on water";
    else if (inCarriagewayV(v, p)) why = "in the roadway";
    else if (blds.some((x) => x.footprint.some((ring) => closestOnPath(p, [...ring, ring[0]]).d < r * GIVE))) why = "crown would hit a building";
    else if (around.some((e) => e.kind === "tree" && e.id !== raw.id && dist((e as Tree).p, p) < ((e as Tree).r + r) * GIVE)) why = "crown would overlap another tree";
    else if (v.near([p[0] - 1, p[1] - 1, p[0] + 1, p[1] + 1], ["prop"]).some((e) => foreign(e) && isSolidProp(e as Prop) && pointInPoly(p, propFp(e as Prop)))) why = "on top of an object";
    if (why) {
      if (isPrimary && (gen.trees?.length ?? 0) === 1 && !(gen.buildings?.length || gen.areas?.length || gen.props?.length)) return { error: `No room for ${def.name} at [${Math.round(p[0])}, ${Math.round(p[1])}]: ${why}`, created: [], counts: {} };
      skip(why);
      continue;
    }
    let t: Tree = { ...raw, kind: "tree", r, h: raw.h > 0 ? raw.h : r * 2.2, source: raw.source || source, provenance: "proposed", createdBy: b.tag };
    t.id = assignId(t, isPrimary);
    t = carry(stamp(t, isPrimary), key);
    v.put(t);
    created.push(t.id);
    counts.tree++;
    if (isPrimary) primaryId = t.id;
  }

  if (!created.length && !(gen.streets?.length)) {
    const why = Object.entries(skipped).map(([k, n]) => `${n} ${k}`).join(", ");
    return { error: `Nothing of ${def.name} could be placed${why ? `: ${why}` : ""}`, created: [], counts: {} };
  }

  // ---- commit the plan, then streets through the street ops (junction splicing, ROW cascades)
  v.commit();
  v.adds.clear();
  v.removes.clear();
  const policy: ConflictPolicy = o.onConflict === "replace" ? "demolish" : o.onConflict === "refuse" ? "report" : "trim";
  const newKey = streetsKey(gen.streets);
  if (o.oldStreets?.length && newKey === o.oldStreetKey) {
    // same streets as before (something else changed): keep them, with the new parameters on their ref
    for (const st of o.oldStreets) {
      const cur = b.get<Street>(st.id);
      if (!cur) continue;
      b.update<Street>({ ...cur, lib: { ...ref, ...(cur.lib?.primary ? { primary: true } : {}) } });
      counts.street++;
      if (cur.lib?.primary) primaryId = cur.id;
    }
  } else {
    for (const st of o.oldStreets ?? []) removeStreetWithNodes(b, st.id);
    let first = !created.length;
    for (const s of gen.streets ?? []) {
      if (!s.path || s.path.length < 2) continue;
      const res = createStreet(world, { path: s.path, cls: s.cls, name: s.name, bike: s.bike ?? null, trees: s.trees, policy }, actor, b);
      if (!res.ok) {
        warnings.push(`Street ${s.name ?? s.cls} not built: ${res.error}`);
        continue;
      }
      for (const id of (b.data.streetIds as string[] | undefined) ?? res.created) {
        const st = b.get<Street>(id);
        if (!st) continue;
        b.update<Street>({ ...st, lib: { ...ref, ...(first ? { primary: true } : {}) } });
        if (first) primaryId = id;
        first = false;
        created.push(id);
        counts.street++;
      }
    }
    // a junction removed with an old street but used by a new one comes back
    for (const e of b.touched()) {
      if (e.kind !== "street") continue;
      for (const nid of [e.from, e.to]) if (b.isRemoved(nid) && world.get(nid)) b.update(world.get<StreetNode>(nid)!);
    }
  }

  // ---- report
  for (const s of gen.summary ?? []) summary.push(s);
  for (const w of gen.warnings ?? []) warnings.push(w);
  if (felled) summary.push(`${felled} existing tree${felled > 1 ? "s" : ""} removed under the new footprint`);
  if (propsCleared) summary.push(`${propsCleared} existing object${propsCleared > 1 ? "s" : ""} removed under the new footprint`);
  for (const [t, m2] of displaced) if (m2 > 1) summary.push(t === "parking" ? `Displaces ${fmt.area(m2)} of surface parking (≈${fmt.int(m2 / 30)} spaces)` : `Displaces ${fmt.area(m2)} of ${t}`);
  if ((displaced.get("park") ?? 0) > 50) warnings.push(`Takes ${fmt.area(displaced.get("park")!)} of parkland`);
  const sk = Object.entries(skipped);
  if (sk.length) summary.push(`Skipped ${sk.map(([k, n]) => `${n} ${k}`).join(", ")}`);
  for (const s of summary) b.summary(s);
  for (const w of warnings) b.warn(w);
  for (const c of conflicts) b.conflict(c.id, c.kind, c.message, c.resolved);
  return { created, primary: primaryId, counts };
}

function progText(p: { gfa: number; units: number; jobs: number }): string {
  return `${fmt.m2(p.gfa)} GFA${p.units >= 0.5 ? `, ~${fmt.int(p.units)} home${Math.round(p.units) === 1 ? "" : "s"}` : ""}${p.jobs >= 0.5 ? `, ~${fmt.int(p.jobs)} job${Math.round(p.jobs) === 1 ? "" : "s"}` : ""}`;
}

function streetsKey(streets: Generated["streets"]): string {
  return JSON.stringify((streets ?? []).filter((s) => s.path?.length >= 2).map((s) => [s.path.map((q) => [Math.round(q[0] * 10), Math.round(q[1] * 10)]), s.cls, s.name ?? null, s.bike ?? null, !!s.trees]));
}

function removeStreetWithNodes(b: OpBuilder, id: string) {
  const s = b.get<Street>(id);
  if (!s) return;
  b.remove(id);
  for (const nid of [s.from, s.to]) if (b.world.incident(nid).every((x) => b.isRemoved(x.id))) b.remove(nid);
}

// ------------------------------------------------------------------ public ops

/**
 * Place one instance of a primitive. With `ob`, the change is added to that builder (batching) and
 * not finished; otherwise the result carries a changeset to commit.
 */
export function placePrimitive(world: World, spec: PlaceSpec, actor: Actor, ob?: OpBuilder): LibraryOpResult {
  const b = ob ?? new OpBuilder(world, actor.author);
  const def = resolveDef(spec.def);
  if (!def) return b.fail(`Unknown primitive "${String(spec.def)}". Use library_search to find definition ids.`);
  const { params, issues } = validateParams(def, spec.params ?? {});
  const hard = issues.filter((i) => i.kind === "unknown" || i.kind === "invalid");
  if (hard.length && !spec.lenient) return { ...b.fail(`Invalid parameters for ${def.id}: ${hard.map((i) => i.message).join("; ")}`), issues };
  const place: PlacementInput = { at: spec.at, rotation: spec.rotation, site: spec.site, path: spec.path };
  if (def.placement === "rect" && !place.at && place.site) place.at = polyCentroid(place.site);
  const pp = placementProblem(def, place);
  if (pp) return { ...b.fail(pp), issues };
  const anchor = anchorOf(place);
  if (anchor && !inStudyArea(world, anchor)) return { ...b.fail(`[${Math.round(anchor[0])}, ${Math.round(anchor[1])}] is outside the study area`), issues };
  const instance = newId("lib");
  const v = new View(b);
  const reportStart = { s: b.report.summary.length };
  const r = generateInto(v, def, params, place, actor, { instance, onConflict: spec.onConflict ?? DEFAULT_CONFLICT, name: spec.name });
  if (r.error) return { ...b.fail(r.error), issues };
  for (const i of issues) if (i.kind === "clamped" || i.kind === "filtered" || spec.lenient) b.warn(i.message);
  b.report.summary.splice(reportStart.s, 0, `Placed ${def.name}${spec.name ? ` “${spec.name}”` : ""}: ${describeCounts(r.counts)}`);
  const data = { instance, def: def.id, primary: r.primary, params, created: r.created };
  if (ob) return { ok: true, report: b.report, created: r.created, removed: [], modified: [], data, instance, params, issues };
  Object.assign(b.data, data);
  const res = b.finish(`Place ${spec.name ?? def.name}`);
  return { ...res, instance, params, issues };
}

export interface ReconfigureOptions {
  /** new placement (move / rotate); omitted keys keep the current placement */
  placement?: Partial<LibraryRef["placement"]>;
  onConflict?: ConflictMode;
  lenient?: boolean;
}

/**
 * Regenerate an instance with patched parameters (and optionally a new placement), keeping its
 * instance id, its other parameters and — where the new generation has an entity of the same kind
 * — its entity ids (so selections survive), user-given names and green roofs.
 */
export function reconfigureInstance(world: World, instanceOrEntityId: string, patch: ParamValues, actor: Actor, opts: ReconfigureOptions = {}, ob?: OpBuilder): LibraryOpResult {
  const b = ob ?? new OpBuilder(world, actor.author);
  const inst = libOf(b.get(instanceOrEntityId))?.instance ?? instanceOrEntityId;
  const members = membersOf(world, inst, b);
  if (!members.length) return b.fail(`${instanceOrEntityId} is not a library instance or one of its features`);
  const ref = libOf(members[0])!;
  const def = resolveDef(ref.def);
  if (!def) return b.fail(`The definition ${ref.def} of ${inst} is no longer in the library`);
  const { params, issues } = validateParams(def, patch ?? {}, ref.params);
  const hard = issues.filter((i) => i.kind === "unknown" || i.kind === "invalid");
  if (hard.length && !opts.lenient) return { ...b.fail(`Invalid parameters for ${def.id}: ${hard.map((i) => i.message).join("; ")}`), issues };
  const placement: PlacementInput = { ...ref.placement, ...(opts.placement ?? {}) };
  const pp = placementProblem(def, placement);
  if (pp) return { ...b.fail(pp), issues };
  // names the old parameters generated, by kind and order (so a user rename is recognised)
  const oldNames = new Map<string, string | undefined>();
  const old = runGenerator(world, def, ref.params, ref.placement, inst).gen;
  if (old) {
    const idx: Record<string, number> = {};
    for (const [k, list] of [["building", old.buildings], ["area", old.areas], ["path", old.paths], ["prop", old.props], ["tree", old.trees]] as const)
      for (const e of list ?? []) oldNames.set(`${k}:${(idx[k] = (idx[k] ?? -1) + 1)}`, (e as { name?: string }).name);
  }
  const v = new View(b);
  const reuse = new Map<EntityKind, string[]>();
  const previous = new Map<string, Entity>();
  const oldStreets: Street[] = [];
  for (const m of members) {
    if (m.kind === "street") {
      oldStreets.push(m as Street);
      continue;
    }
    previous.set(m.id, m);
    if (!reuse.has(m.kind)) reuse.set(m.kind, []);
    reuse.get(m.kind)!.push(m.id);
    v.del(m.id);
  }
  const reportStart = b.report.summary.length;
  const r = generateInto(v, def, params, placement, actor, { instance: inst, onConflict: opts.onConflict ?? DEFAULT_CONFLICT, reuse, reusePrimary: members[0].kind !== "street" ? members[0].id : undefined, previous, oldNames, oldStreets, oldStreetKey: streetsKey(old?.streets), patchKeys: Object.keys(patch ?? {}) });
  if (r.error) return { ...b.fail(r.error), issues };
  for (const i of issues) if (i.kind === "clamped" || i.kind === "filtered" || opts.lenient) b.warn(i.message);
  const changed = Object.keys(patch ?? {}).filter((k) => JSON.stringify(ref.params[k]) !== JSON.stringify(params[k]));
  const moved = opts.placement && JSON.stringify(cleanPlacement(placement)) !== JSON.stringify(ref.placement);
  b.report.summary.splice(reportStart, 0, `${def.name} ${inst.slice(-6)}: ${changed.length ? changed.map((k) => `${k} ${fmtVal(ref.params[k])} → ${fmtVal(params[k])}`).join(", ") : moved ? "moved" : "regenerated"}`);
  const data = { instance: inst, def: def.id, primary: r.primary, params, changed };
  if (ob) return { ok: true, report: b.report, created: r.created, removed: [], modified: [], data, instance: inst, params, issues };
  Object.assign(b.data, data);
  const res = b.finish(`Configure ${def.name}`);
  return { ...res, instance: inst, params, issues };
}

const fmtVal = (x: unknown) => (typeof x === "number" ? String(Math.round(x * 100) / 100) : typeof x === "string" ? x : JSON.stringify(x));

function shiftedPlacement(pl: LibraryRef["placement"], d: Vec2): LibraryRef["placement"] {
  return {
    ...pl,
    ...(pl.at ? { at: [pl.at[0] + d[0], pl.at[1] + d[1]] as Vec2 } : {}),
    ...(pl.site ? { site: translatePoly(pl.site, d) } : {}),
    ...(pl.path ? { path: pl.path.map((q) => [q[0] + d[0], q[1] + d[1]] as Vec2) } : {}),
  };
}

function rotatedPlacement(pl: LibraryRef["placement"], deg: number, about?: Vec2): LibraryRef["placement"] {
  const c = about ?? pl.at ?? (pl.site ? polyCentroid(pl.site) : pl.path ? pl.path[Math.floor(pl.path.length / 2)] : ([0, 0] as Vec2));
  const rad = (deg * Math.PI) / 180;
  return {
    ...pl,
    rotation: (((pl.rotation ?? 0) + deg) % 360 + 360) % 360,
    ...(pl.at ? { at: rotAround(pl.at, c, rad) } : {}),
    ...(pl.site ? { site: rotatePoly(pl.site, c, rad) } : {}),
    ...(pl.path ? { path: pl.path.map((q) => rotAround(q, c, rad)) } : {}),
  };
}

/** move instances by an offset (regenerated at the new place, ids kept) */
export function moveInstance(world: World, ids: string[], by: Vec2, actor: Actor, opts: { onConflict?: ConflictMode } = {}, ob?: OpBuilder): LibraryOpResult {
  return multi(world, ids, actor, ob, "Move", (inst, info, b) => reconfigureInstance(world, inst, {}, actor, { placement: shiftedPlacement(info.placement, by), onConflict: opts.onConflict }, b));
}

/** rotate instances by `degrees` counter-clockwise about their anchor (or a shared point) */
export function rotateInstance(world: World, ids: string[], degrees: number, actor: Actor, opts: { about?: Vec2; onConflict?: ConflictMode } = {}, ob?: OpBuilder): LibraryOpResult {
  return multi(world, ids, actor, ob, "Rotate", (inst, info, b) => reconfigureInstance(world, inst, {}, actor, { placement: rotatedPlacement(info.placement, degrees, opts.about), onConflict: opts.onConflict }, b));
}

/** copy instances (same definition and parameters) offset by `by`, `count` times */
export function duplicateInstance(world: World, ids: string[], by: Vec2, actor: Actor, opts: { count?: number; onConflict?: ConflictMode; params?: ParamValues } = {}, ob?: OpBuilder): LibraryOpResult {
  const b = ob ?? new OpBuilder(world, actor.author);
  const made: string[] = [];
  const errors: string[] = [];
  const created: string[] = [];
  for (const info of uniqueInstances(world, ids, b)) {
    for (let k = 1; k <= Math.max(1, Math.min(100, opts.count ?? 1)); k++) {
      const pl = shiftedPlacement(info.placement, [by[0] * k, by[1] * k]);
      const r = placePrimitive(world, { def: info.def, params: { ...info.params, ...(opts.params ?? {}) }, ...pl, onConflict: opts.onConflict }, actor, b);
      if (r.ok && r.instance) {
        made.push(r.instance);
        created.push(...r.created);
      } else errors.push(r.error ?? "failed");
    }
  }
  if (!made.length) return b.fail(errors[0] ?? "Nothing to duplicate: give instance or feature ids of library instances");
  for (const e of errors) b.warn(e);
  b.data.instances = made;
  if (ob) return { ok: true, report: b.report, created, removed: [], modified: [], data: b.data };
  return b.finish(`Duplicate ${made.length} instance${made.length > 1 ? "s" : ""}`);
}

/** remove every entity of the instances (streets take junctions left without streets with them) */
export function removeInstance(world: World, ids: string[], actor: Actor, ob?: OpBuilder): LibraryOpResult {
  const b = ob ?? new OpBuilder(world, actor.author);
  const infos = uniqueInstances(world, ids, b);
  if (!infos.length) return b.fail("No library instances among the given ids");
  let n = 0;
  const kinds: Record<string, number> = {};
  for (const info of infos) {
    for (const id of info.entities) {
      const e = b.get(id);
      if (!e) continue;
      if (e.kind === "street") removeStreetWithNodes(b, id);
      else b.remove(id);
      kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
      n++;
    }
  }
  b.summary(`Removed ${infos.length} library instance${infos.length > 1 ? "s" : ""} (${describeCounts(kinds)})`);
  if (ob) return { ok: true, report: b.report, created: [], removed: infos.flatMap((i) => i.entities), modified: [], data: b.data };
  return b.finish(`Remove ${infos.length === 1 ? (resolveDef(infos[0].def)?.name ?? "instance") : `${infos.length} instances`}`);
}

function uniqueInstances(world: World, ids: string[], b: OpBuilder): InstanceInfo[] {
  const seen = new Set<string>();
  const out: InstanceInfo[] = [];
  for (const id of ids) {
    const inst = libOf(b.get(id))?.instance ?? (id.startsWith("lib:") ? id : undefined);
    if (!inst || seen.has(inst)) continue;
    seen.add(inst);
    const members = membersOf(world, inst, b);
    if (!members.length) continue;
    const ref = libOf(members[0])!;
    out.push({ instance: inst, def: ref.def, params: ref.params, placement: ref.placement, primary: members[0].id, entities: members.map((m) => m.id) });
  }
  return out;
}

function multi(world: World, ids: string[], actor: Actor, ob: OpBuilder | undefined, verb: string, fn: (inst: string, info: InstanceInfo, b: OpBuilder) => LibraryOpResult): LibraryOpResult {
  const b = ob ?? new OpBuilder(world, actor.author);
  const infos = uniqueInstances(world, ids, b);
  if (!infos.length) return b.fail("No library instances among the given ids");
  const errors: string[] = [];
  let n = 0;
  for (const info of infos) {
    const r = fn(info.instance, info, b);
    if (r.ok) n++;
    else errors.push(`${info.instance}: ${r.error}`);
  }
  if (!n) return b.fail(errors.join("; "));
  for (const e of errors) b.warn(e);
  if (ob) return { ok: true, report: b.report, created: [], removed: [], modified: [], data: b.data };
  return b.finish(`${verb} ${n === 1 ? (resolveDef(infos[0].def)?.name ?? "instance") : `${n} instances`}`);
}
