// Shared machinery for edit operations: a pending-aware changeset builder so
// cascades can compose (a building trimmed by one rule and demolished by
// another ends as one consistent op), plus the cascade report.

import { fmtArea, fmtFloorArea, fmtFt, fmtLen } from "@/lib/units";
import { polyArea } from "@/geometry/polygon";
import { massesGFA } from "@/geometry/massing";
import type { Building, Entity, Use } from "../types";
import { makeChangeset, newId, type CascadeReport, type Changeset, type Op, type World } from "../world";

export interface OpResult {
  ok: boolean;
  changeset?: Changeset;
  report: CascadeReport;
  error?: string;
  created: string[];
  removed: string[];
  modified: string[];
  data?: Record<string, unknown>;
}

export class OpBuilder {
  private pending = new Map<string, Entity | null>();
  private original = new Map<string, Entity | undefined>();
  private order: string[] = [];
  report: CascadeReport = { summary: [], warnings: [], conflicts: [], affected: [] };
  data: Record<string, unknown> = {};
  /** aggregated cascade consequences, flushed into the summary by finish() */
  cascade = { trimmed: 0, demolished: 0, gfaLost: 0, unitsLost: 0, parcels: 0, taken: 0, trees: 0, inlets: 0, stops: 0, minor: 0, areas: new Map<string, number>(), parkTaken: 0 };

  constructor(readonly world: World, readonly author: "user" | "agent" | "system" = "user", readonly tag = newId("op")) {}

  get<T extends Entity = Entity>(id: string): T | undefined {
    if (this.pending.has(id)) return (this.pending.get(id) ?? undefined) as T | undefined;
    return this.world.get<T>(id);
  }

  private touch(id: string) {
    if (!this.original.has(id)) {
      this.original.set(id, this.world.get(id));
      this.order.push(id);
    }
  }

  add<T extends Entity>(e: T): T {
    this.touch(e.id);
    this.pending.set(e.id, e);
    return e;
  }

  update<T extends Entity>(e: T): T {
    this.touch(e.id);
    this.pending.set(e.id, e);
    return e;
  }

  remove(id: string) {
    if (!this.get(id)) return;
    this.touch(id);
    this.pending.set(id, null);
  }

  isRemoved(id: string) {
    return this.pending.has(id) && this.pending.get(id) === null;
  }

  /** entities changed so far (current pending state) */
  touched(): Entity[] {
    return this.order.map((id) => this.pending.get(id)).filter((e): e is Entity => !!e);
  }

  summary(s: string) {
    this.report.summary.push(s);
  }
  warn(s: string) {
    this.report.warnings.push(s);
  }
  conflict(id: string, kind: string, message: string, resolved: boolean) {
    this.report.conflicts.push({ id, kind, message, resolved });
  }

  ops(): Op[] {
    const ops: Op[] = [];
    for (const id of this.order) {
      const before = this.original.get(id);
      const after = this.pending.get(id) ?? null;
      if (!before && after) ops.push({ type: "add", entity: after });
      else if (before && !after) ops.push({ type: "remove", entity: before });
      else if (before && after && before !== after) ops.push({ type: "update", before, after });
    }
    return ops;
  }

  private flushCascade() {
    const c = this.cascade;
    const lines: string[] = [];
    if (c.demolished) lines.push(`${c.demolished} building${c.demolished > 1 ? "s" : ""} demolished in the new right-of-way (−${fmt.m2(c.gfaLost)} GFA${c.unitsLost >= 1 ? `, −${fmt.int(c.unitsLost)} units` : ""})`);
    if (c.trimmed) lines.push(`${c.trimmed} building façade${c.trimmed > 1 ? "s" : ""} set back to the new property line`);
    if (c.parcels) lines.push(`Right-of-way acquisition: ${fmt.area(c.taken)} from ${c.parcels} parcel${c.parcels > 1 ? "s" : ""}`);
    if (c.trees) lines.push(`${c.trees} tree${c.trees > 1 ? "s" : ""} removed from the new carriageway`);
    if (c.inlets) lines.push(`${c.inlets} kerb inlet${c.inlets > 1 ? "s" : ""} relocated to the new kerb line`);
    if (c.minor) lines.push(`${c.minor} façade${c.minor > 1 ? "s" : ""} within ${fmtFt(0.6, 0)} of the new ROW edge — absorbed in sidewalk detailing, no building change`);
    if (c.stops) lines.push(`${c.stops} bus stop${c.stops > 1 ? "s" : ""} moved to the new kerb`);
    for (const [k, v] of c.areas) if (v > 1) lines.push(`${k} reduced by ${fmt.area(v)}`);
    if (c.parkTaken > 1) this.warn(`Takes ${fmt.area(c.parkTaken)} of park land`);
    this.report.summary.push(...lines);
    this.cascade = { trimmed: 0, demolished: 0, gfaLost: 0, unitsLost: 0, parcels: 0, taken: 0, trees: 0, inlets: 0, stops: 0, minor: 0, areas: new Map(), parkTaken: 0 };
  }

  finish(label: string): OpResult {
    this.flushCascade();
    const ops = this.ops();
    const created: string[] = [],
      removed: string[] = [],
      modified: string[] = [];
    for (const op of ops) {
      if (op.type === "add") created.push(op.entity.id);
      else if (op.type === "remove") removed.push(op.entity.id);
      else modified.push(op.after.id);
    }
    this.report.affected = [...created, ...modified, ...removed];
    if (!ops.length) return { ok: false, report: this.report, error: "Operation produced no changes", created, removed, modified, data: this.data };
    const cs = makeChangeset(label, this.author, ops, this.report);
    cs.group = this.tag;
    return { ok: true, changeset: cs, report: this.report, created, removed, modified, data: this.data };
  }

  fail(error: string): OpResult {
    return { ok: false, report: this.report, error, created: [], removed: [], modified: [], data: this.data };
  }
}

// ---- programme metrics (shared by ops, sims and the inspector) --------------

/** planning assumptions for converting floor area to people */
export const PROGRAMME = {
  /** net-to-gross efficiency for residential */
  resEfficiency: 0.82,
  /** average dwelling size (m², net) — downtown Austin multifamily mix */
  unitSize: 78,
  /** office m² GFA per job */
  officePerJob: 23,
  retailPerJob: 45,
  hotelPerRoom: 55,
  civicPerJob: 60,
  educationPerJob: 80,
  industrialPerJob: 90,
  healthPerJob: 35,
};

/**
 * Gross floor area. Proposed / multi-volume buildings are measured volume by
 * volume with use-specific floor heights. Existing buildings are single LiDAR
 * extrusions (max height × footprint), which overstates towers on podiums, so
 * above four floors the floor plate is assumed to shrink to a typical tower
 * plate (≈1,600 m², 35–85 % of the footprint). Labelled "estimated".
 */
export function massVolume(b: Building): number {
  let v = 0;
  for (const m of b.masses) if (m.role !== "crown") v += polyArea(m.poly) * Math.max(0, m.top - m.base);
  return v;
}

/** heuristic GFA for an existing single-extrusion building (see buildingGFA) */
export function existingGFA(area: number, floors: number): number {
  const f = Math.max(1, area > 15000 ? Math.min(floors, 6) : floors);
  if (f > 8 && area > 1800) {
    const cov = Math.min(0.85, Math.max(0.35, 1600 / area));
    return area * 4 + area * cov * (f - 4);
  }
  return area * f;
}

/**
 * Gross floor area. Proposed buildings are measured volume by volume with
 * use-specific floor heights. Existing buildings are single LiDAR extrusions
 * (max height × footprint), which overstates towers on podiums, so above four
 * floors the plate is assumed to shrink to a typical tower plate (≈1,600 m²);
 * edits to an existing building scale that baseline by the change in volume.
 */
export function buildingGFA(b: Building): number {
  if (b.existing) {
    const v0 = b.existing.volume;
    return v0 > 0 ? b.existing.gfa * (massVolume(b) / v0) : b.existing.gfa;
  }
  if (b.createdBy || b.masses.length > 1) return massesGFA(b.masses, b.use === "mixed" ? "residential" : b.use, b.storeys);
  return existingGFA(polyArea(b.footprint), b.floors);
}

export interface Programme {
  gfa: number;
  units: number;
  jobs: number;
  rooms: number;
  residents: number;
}

export function programmeOf(b: Building, householdSize = 1.75): Programme {
  const gfa = buildingGFA(b);
  if (b.existing && b.existing.use === b.use) {
    const k = b.existing.gfa > 0 ? gfa / b.existing.gfa : 1;
    const units = b.existing.units * k;
    return { gfa, units, jobs: b.existing.jobs * k, rooms: b.use === "hotel" ? gfa / PROGRAMME.hotelPerRoom : 0, residents: units * householdSize };
  }
  const share = (u: Use) => b.program[u] ?? 0;
  let units = (gfa * share("residential") * PROGRAMME.resEfficiency) / PROGRAMME.unitSize;
  if (b.use === "residential" && b.floors <= 3 && gfa < 600 && !b.createdBy) units = Math.max(1, Math.round(gfa / 180)); // houses
  const jobs =
    (gfa * share("office")) / PROGRAMME.officePerJob +
    (gfa * share("retail")) / PROGRAMME.retailPerJob +
    (gfa * share("civic")) / PROGRAMME.civicPerJob +
    (gfa * share("education")) / PROGRAMME.educationPerJob +
    (gfa * share("industrial")) / PROGRAMME.industrialPerJob +
    (gfa * share("health")) / PROGRAMME.healthPerJob +
    (gfa * share("hotel")) / 120;
  const rooms = (gfa * share("hotel")) / PROGRAMME.hotelPerRoom;
  if (b.occupancy) {
    // stated occupancy (library primitives), scaled with later changes to the floor area
    const k = b.occupancy.gfa > 0 ? gfa / b.occupancy.gfa : 1;
    const u = b.occupancy.units != null ? b.occupancy.units * k : units;
    return { gfa, units: u, jobs: b.occupancy.jobs != null ? b.occupancy.jobs * k : jobs, rooms: b.occupancy.rooms != null ? b.occupancy.rooms * k : rooms, residents: u * householdSize };
  }
  return { gfa, units, jobs, rooms, residents: units * householdSize };
}

// user-facing figures are imperial (lib/units); the model itself stays in metres
export const fmt = {
  /** a length: "12 ft", "850 ft", "0.4 mi" */
  m: (x: number) => fmtLen(x),
  /** a floor area or small area: "12,400 sq ft", "1.24M sq ft" */
  m2: (x: number) => fmtFloorArea(x),
  /** a land area: "8,000 sq ft", "2.3 acres" */
  area: (x: number) => fmtArea(x),
  int: (x: number) => Math.round(x).toLocaleString(),
  pct: (x: number) => `${(x * 100).toFixed(0)}%`,
};
