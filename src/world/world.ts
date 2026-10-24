// The persistent, editable world model. Entities are immutable records keyed by
// id; every edit is a Changeset of add / remove / update ops that can be
// applied and reverted exactly. Derived street/junction geometry is rebuilt
// incrementally for whatever a changeset touched.

import { buildStreetGeom, solveNode, type NetworkAccess, type NodeGeom, type StreetGeom } from "@/geometry/streetGeometry";
import { pathBBox } from "@/geometry/polyline";
import { polyBBox } from "@/geometry/polygon";
import { sectionWidth } from "@/geometry/crossSection";
import { GridIndex, type BBox } from "./spatialIndex";
import type { CityMeta, Entity, EntityKind, Street, StreetNode } from "./types";

export type Op =
  | { type: "add"; entity: Entity }
  | { type: "remove"; entity: Entity }
  | { type: "update"; before: Entity; after: Entity };

export interface Changeset {
  id: string;
  label: string;
  author: "user" | "agent" | "system";
  time: number;
  ops: Op[];
  /** human-readable consequences handled by the cascade engine */
  report?: CascadeReport;
  /** group id when several changesets belong to one agent action */
  group?: string;
  /** agent session that committed it (src/agent/sessions.ts): per-session undo and attribution */
  session?: string;
}

export interface CascadeReport {
  summary: string[];
  warnings: string[];
  conflicts: { id: string; kind: string; message: string; resolved: boolean }[];
  affected: string[];
}

export function entityBBox(e: Entity): BBox {
  switch (e.kind) {
    case "building":
      return polyBBox(e.footprint);
    case "street": {
      const b = pathBBox(e.path);
      const w = sectionWidth(e.section) / 2 + Math.abs(e.section.shift ?? 0) + 1;
      return [b[0] - w, b[1] - w, b[2] + w, b[3] + w];
    }
    case "node":
    case "stop":
    case "poi":
      return [e.p[0] - 1, e.p[1] - 1, e.p[0] + 1, e.p[1] + 1];
    case "place":
      return e.poly ? polyBBox(e.poly) : [e.p[0] - 1, e.p[1] - 1, e.p[0] + 1, e.p[1] + 1];
    case "tree":
      return [e.p[0] - e.r, e.p[1] - e.r, e.p[0] + e.r, e.p[1] + e.r];
    case "area":
    case "parcel":
      return polyBBox(e.poly);
    case "route":
    case "utility":
    case "path":
      return pathBBox(e.path);
    case "prop": {
      if (e.footprint) return polyBBox(e.footprint);
      const r = Math.max(0.5, ...e.solids.map((s) => Math.hypot(s.at[0], s.at[1]) + Math.hypot(s.size[0], s.size[1]) / 2));
      return [e.p[0] - r, e.p[1] - r, e.p[0] + r, e.p[1] + r];
    }
  }
}

const KINDS: EntityKind[] = ["building", "street", "node", "area", "tree", "parcel", "stop", "route", "utility", "path", "poi", "place", "prop"];

export class World implements NetworkAccess {
  meta: CityMeta;
  readonly entities = new Map<string, Entity>();
  readonly byKind = new Map<EntityKind, Set<string>>(KINDS.map((k) => [k, new Set<string>()]));
  readonly index = new GridIndex(64);
  /** node id -> incident street ids */
  readonly adj = new Map<string, Set<string>>();
  readonly streetGeom = new Map<string, StreetGeom>();
  readonly nodeGeom = new Map<string, NodeGeom>();
  version = 0;
  /** ids changed since the consumer last called takeDirty() */
  private dirty = new Set<string>();
  private dirtyStreets = new Set<string>();
  private dirtyNodes = new Set<string>();
  private listeners = new Set<(cs: Changeset | null, dir: 1 | -1) => void>();

  constructor(meta: CityMeta) {
    this.meta = meta;
  }

  // ---- read access --------------------------------------------------------
  get<T extends Entity = Entity>(id: string): T | undefined {
    return this.entities.get(id) as T | undefined;
  }
  street(id: string) {
    return this.get<Street>(id);
  }
  node(id: string): StreetNode | undefined {
    const n = this.get<StreetNode>(id);
    if (!n) return undefined;
    const edges = this.adj.get(id);
    return { ...n, edges: edges ? [...edges] : [] };
  }
  all<K extends EntityKind>(kind: K): Extract<Entity, { kind: K }>[] {
    const out: Extract<Entity, { kind: K }>[] = [];
    for (const id of this.byKind.get(kind)!) out.push(this.entities.get(id) as Extract<Entity, { kind: K }>);
    return out;
  }
  count(kind: EntityKind) {
    return this.byKind.get(kind)!.size;
  }
  query(b: BBox, kinds?: EntityKind[]): Entity[] {
    const ids = this.index.query(b);
    const out: Entity[] = [];
    for (const id of ids) {
      const e = this.entities.get(id);
      if (e && (!kinds || kinds.includes(e.kind))) out.push(e);
    }
    return out;
  }
  incident(nodeId: string): Street[] {
    const s = this.adj.get(nodeId);
    return s ? [...s].map((id) => this.entities.get(id) as Street).filter(Boolean) : [];
  }

  // ---- low-level mutation (only via changesets) ---------------------------
  private insert(e: Entity) {
    this.entities.set(e.id, e);
    this.byKind.get(e.kind)!.add(e.id);
    // parcels / places / utilities / routes are queried less spatially but still indexed
    this.index.insert(e.id, entityBBox(e));
    this.dirty.add(e.id);
    if (e.kind === "street") {
      for (const n of [e.from, e.to]) {
        if (!this.adj.has(n)) this.adj.set(n, new Set());
        this.adj.get(n)!.add(e.id);
        this.dirtyNodes.add(n);
      }
      this.dirtyStreets.add(e.id);
    } else if (e.kind === "node") {
      this.dirtyNodes.add(e.id);
    }
  }
  private delete(e: Entity) {
    this.entities.delete(e.id);
    this.byKind.get(e.kind)!.delete(e.id);
    this.index.remove(e.id);
    this.dirty.add(e.id);
    if (e.kind === "street") {
      for (const n of [e.from, e.to]) {
        this.adj.get(n)?.delete(e.id);
        this.dirtyNodes.add(n);
      }
      this.streetGeom.delete(e.id);
      this.dirtyStreets.delete(e.id);
    } else if (e.kind === "node") {
      this.nodeGeom.delete(e.id);
      this.dirtyNodes.delete(e.id);
    }
  }

  /** bulk load without history */
  load(entities: Entity[]) {
    for (const e of entities) this.insert(e);
    this.rebuildGeometry();
    this.version++;
  }

  apply(cs: Changeset) {
    for (const op of cs.ops) {
      if (op.type === "add") this.insert(op.entity);
      else if (op.type === "remove") {
        const cur = this.entities.get(op.entity.id);
        if (cur) this.delete(cur);
      } else {
        const cur = this.entities.get(op.before.id);
        if (cur) this.delete(cur);
        this.insert(op.after);
      }
    }
    this.rebuildGeometry();
    this.version++;
    for (const l of this.listeners) l(cs, 1);
  }

  revert(cs: Changeset) {
    for (let i = cs.ops.length - 1; i >= 0; i--) {
      const op = cs.ops[i];
      if (op.type === "add") {
        const cur = this.entities.get(op.entity.id);
        if (cur) this.delete(cur);
      } else if (op.type === "remove") this.insert(op.entity);
      else {
        const cur = this.entities.get(op.after.id);
        if (cur) this.delete(cur);
        this.insert(op.before);
      }
    }
    this.rebuildGeometry();
    this.version++;
    for (const l of this.listeners) l(cs, -1);
  }

  subscribe(fn: (cs: Changeset | null, dir: 1 | -1) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  takeDirty(): Set<string> {
    const d = this.dirty;
    this.dirty = new Set();
    return d;
  }

  // ---- derived geometry ---------------------------------------------------
  rebuildGeometry() {
    if (!this.dirtyStreets.size && !this.dirtyNodes.size) return;
    const nodes = new Set(this.dirtyNodes);
    for (const sid of this.dirtyStreets) {
      const s = this.street(sid);
      if (s) {
        nodes.add(s.from);
        nodes.add(s.to);
      }
    }
    const streets = new Set(this.dirtyStreets);
    for (const nid of nodes) {
      const n = this.node(nid);
      if (!n) {
        this.nodeGeom.delete(nid);
        continue;
      }
      const g = solveNode(n, this);
      this.nodeGeom.set(nid, g);
      for (const e of n.edges) streets.add(e);
    }
    for (const sid of streets) {
      const s = this.street(sid);
      if (!s) continue;
      const a = this.nodeGeom.get(s.from)?.ends.find((e) => e.streetId === sid && e.atStart);
      const b = this.nodeGeom.get(s.to)?.ends.find((e) => e.streetId === sid && !e.atStart);
      this.streetGeom.set(sid, buildStreetGeom(s, a, b));
      this.dirty.add(sid);
    }
    for (const n of nodes) this.dirty.add(n);
    this.dirtyStreets.clear();
    this.dirtyNodes.clear();
  }

  /** shallow clone (shares immutable entities) – used for scenario materialisation */
  cloneEntities(): Map<string, Entity> {
    return new Map(this.entities);
  }
}

let seq = 0;
export const newId = (prefix: string) => `${prefix}:x${Date.now().toString(36)}${(seq++).toString(36)}`;

export function makeChangeset(label: string, author: Changeset["author"], ops: Op[], report?: CascadeReport): Changeset {
  return { id: newId("cs"), label, author, time: Date.now(), ops, report };
}
