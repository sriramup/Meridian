// Converts the world model into chunked, render-ready arrays. Each chunk keeps
// a version; edits only rebuild the chunks whose entities (or derived street
// geometry) changed, so deck.gl re-tessellates a small slice of the city.
// Theme and change-highlight switches only repaint: colours are rewritten in
// place and `paint` is bumped, so layers refresh their colour attribute alone.

import { PED_REALM } from "@/geometry/crossSection";
import { polyCentroid } from "@/geometry/polygon";
import type { Marking } from "@/geometry/streetGeometry";
import { speciesOf, type CrownShape } from "@/world/species";
import type { Position } from "@deck.gl/core";
import type { Area, Building, Entity, Path as FootPath, Ring, Street, StripType, Tree } from "@/world/types";
import type { World } from "@/world/world";
import { FACADE, facadeAlpha } from "./FacadeLayer";
import type { RGB, RGBA, Theme } from "./theme";

const CH = 1100;

/** a theme colour picker, shared by every datum painted the same way */
type Tone = (T: Theme) => RGB;

export interface MassDatum {
  id: string;
  polygon: Position[][];
  height: number;
  color: RGBA;
  base: number;
  src: Building;
  /** the planted layer on a green roof */
  roof?: boolean;
}
export interface SurfaceDatum {
  id: string;
  polygon: Position[][] | Position[];
  color: RGBA;
  kind: string;
  tone: Tone;
}
export interface MarkDatum {
  path: Position[];
  width: number;
  color: RGBA;
  dash: [number, number];
  tone: Tone;
  alpha: number;
}
interface PathDatum {
  path: Position[];
  color: RGBA;
  width: number;
  tone: Tone;
}
export interface TreeDatum {
  id: string;
  position: [number, number, number];
  r: number;
  h: number;
  proposed: boolean;
  shape?: CrownShape;
  color?: [number, number, number];
  /** 0..1 per-tree variation (tint, crown proportions) so a row doesn't look stamped */
  seed: number;
}

interface Chunk {
  key: string;
  version: number;
  built: number;
  ids: Set<string>;
  masses: MassDatum[];
  surfaces: SurfaceDatum[];
  kerbs: SurfaceDatum[];
  marks: MarkDatum[];
  areas: SurfaceDatum[];
  trees: TreeDatum[];
  paths: PathDatum[];
}

const chunkKey = (x: number, y: number) => `${Math.floor(x / CH)}:${Math.floor(y / CH)}`;

function entityAnchor(e: Entity): [number, number] | null {
  switch (e.kind) {
    case "building":
      return polyCentroid(e.footprint);
    case "street":
      return e.path[Math.floor(e.path.length / 2)];
    case "node":
    case "tree":
      return e.p;
    case "area":
      return polyCentroid(e.poly);
    case "path":
      return e.path[Math.floor(e.path.length / 2)];
    default:
      return null;
  }
}

const RENDERED = new Set(["building", "street", "node", "area", "tree", "path"]);

export function facadeFor(b: Building): number {
  if (b.createdBy) return b.style?.facade === "masonry" ? FACADE.masonry : b.style?.facade === "timber" ? FACADE.timber : b.style?.facade === "concrete" ? FACADE.concrete : FACADE.proposed;
  if (b.use === "parking") return FACADE.parking;
  switch (b.style?.facade) {
    case "glass":
      return FACADE.glass;
    case "masonry":
      return FACADE.masonry;
    case "metal":
      return FACADE.metal;
    case "timber":
      return FACADE.timber;
    case "stucco":
      return FACADE.stucco;
    default:
      return FACADE.concrete;
  }
}

const ring3 = (r: Ring, z: number): Position[] => r.map((p) => [p[0], p[1], z]);
const rgba = (c: RGB, a = 255): RGBA => [c[0], c[1], c[2], a];

const tones = new Map<string, Tone>();
/** one shared picker per key, so a datum holds a reference rather than its own closure */
function tone(key: string, pick: Tone): Tone {
  let t = tones.get(key);
  if (!t) tones.set(key, (t = pick));
  return t;
}
const T_CARRIAGEWAY = tone("carriageway", (T) => T.carriageway);
const T_PLAZA = tone("plaza", (T) => T.strip.plaza);
const T_KERB = tone("kerbTop", (T) => T.kerbTop);
const T_ISLAND = tone("island", (T) => T.island);
const T_WHITE = tone("markWhite", (T) => T.markWhite);
const T_YELLOW = tone("markYellow", (T) => T.markYellow);
const T_PATH = tone("path", (T) => T.path);
const T_CYCLE = tone("cycletrack", (T) => T.strip.cycletrack);
const stripTone = (type: string, bio: boolean) =>
  tone(`strip:${type}:${bio}`, (T) => (bio ? T.area.raingarden ?? T.strip.planting : T.strip[type as StripType] ?? T.carriageway));
const areaTone = (type: string) => tone(`area:${type}`, (T) => T.area[type as keyof Theme["area"]] ?? T.land);

export class SceneCache {
  private chunks = new Map<string, Chunk>();
  private entityChunk = new Map<string, string>();
  theme: Theme;
  showChanges = true;
  version = 0;
  /** bumped when colours are repainted in place (layers use it as their colour update trigger) */
  paint = 0;

  constructor(private world: World, theme: Theme) {
    this.theme = theme;
    for (const e of world.entities.values()) this.place(e);
  }

  private place(e: Entity) {
    if (!RENDERED.has(e.kind)) return;
    const a = entityAnchor(e);
    if (!a) return;
    const k = chunkKey(a[0], a[1]);
    let c = this.chunks.get(k);
    if (!c) {
      c = { key: k, version: 1, built: 0, ids: new Set(), masses: [], surfaces: [], kerbs: [], marks: [], areas: [], trees: [], paths: [] };
      this.chunks.set(k, c);
    }
    c.ids.add(e.id);
    c.version++;
    this.entityChunk.set(e.id, k);
  }

  /** absorb world changes; returns true if anything visible changed */
  sync(): boolean {
    const dirty = this.world.takeDirty();
    if (!dirty.size) return false;
    for (const id of dirty) {
      const old = this.entityChunk.get(id);
      if (old) {
        const c = this.chunks.get(old)!;
        c.ids.delete(id);
        c.version++;
        this.entityChunk.delete(id);
      }
      const e = this.world.get(id);
      if (e) this.place(e);
    }
    this.version++;
    return true;
  }

  setTheme(t: Theme) {
    if (t === this.theme) return;
    this.theme = t;
    this.repaint();
  }
  setShowChanges(v: boolean) {
    if (v === this.showChanges) return;
    this.showChanges = v;
    this.repaint();
  }

  /** rewrite colours of built chunks in place; geometry (and its tessellation) is kept */
  private repaint() {
    const T = this.theme;
    for (const c of this.chunks.values()) {
      if (c.built !== c.version) continue;
      const bld = new Map<Building, RGBA>();
      for (const d of c.masses) {
        if (d.roof) d.color = [...T.area.park, 255];
        else {
          let col = bld.get(d.src);
          if (!col) bld.set(d.src, (col = this.massColor(d.src)));
          d.color = col;
        }
      }
      for (const d of c.surfaces) d.color = rgba(d.tone(T));
      for (const d of c.kerbs) d.color = rgba(d.tone(T));
      for (const d of c.areas) d.color = rgba(d.tone(T));
      for (const d of c.marks) d.color = rgba(d.tone(T), d.alpha);
      for (const d of c.paths) d.color = rgba(d.tone(T));
    }
    this.paint++;
    this.version++;
  }

  list(): Chunk[] {
    for (const c of this.chunks.values()) if (c.built !== c.version) this.build(c);
    return [...this.chunks.values()];
  }

  private build(c: Chunk) {
    const T = this.theme;
    const w = this.world;
    c.masses = [];
    c.surfaces = [];
    c.kerbs = [];
    c.marks = [];
    c.areas = [];
    c.trees = [];
    c.paths = [];
    for (const id of c.ids) {
      const e = w.get(id);
      if (!e) continue;
      if (e.kind === "building") this.buildBuilding(c, e);
      else if (e.kind === "street") this.buildStreet(c, e);
      else if (e.kind === "node") {
        const g = w.nodeGeom.get(e.id);
        if (!g) continue;
        if (g.carriageway && g.carriageway.length > 2) {
          const tn = g.plaza ? T_PLAZA : T_CARRIAGEWAY;
          (g.plaza ? c.kerbs : c.surfaces).push({ id: e.id, polygon: g.carriageway, color: rgba(tn(T)), kind: g.plaza ? "plaza" : "junction", tone: tn });
        }
        for (const r of g.corners) if (r.length > 2) c.kerbs.push({ id: e.id, polygon: r, color: rgba(T.kerbTop), kind: "corner", tone: T_KERB });
        if (g.island) c.kerbs.push({ id: e.id, polygon: g.island, color: rgba(T.island), kind: "island", tone: T_ISLAND });
        for (const m of g.markings) c.marks.push(this.mark(m));
      } else if (e.kind === "area") this.buildArea(c, e);
      else if (e.kind === "tree") this.buildTree(c, e);
      else if (e.kind === "path") this.buildPath(c, e);
    }
    c.built = c.version;
  }

  private massColor(b: Building): RGBA {
    const T = this.theme;
    const proposed = !!b.createdBy && this.showChanges;
    let base: RGB = T.building[b.use] ?? T.building.other;
    if (proposed) base = T.proposed;
    if (b.style?.facade === "glass" && !proposed) base = T.glass;
    const tint = (b.style?.tint ?? 0.5) - 0.5;
    const k = 1 + tint * (T.id === "night" ? 0.25 : 0.05);
    return [Math.min(255, base[0] * k), Math.min(255, base[1] * k), Math.min(255, base[2] * k), facadeAlpha(facadeFor(b))];
  }

  private buildBuilding(c: Chunk, b: Building) {
    const T = this.theme;
    const col = this.massColor(b);
    for (const m of b.masses) {
      c.masses.push({ id: b.id, polygon: m.poly.map((r) => ring3(r, m.base)), height: Math.max(0.5, m.top - m.base), color: col, base: m.base, src: b });
    }
    if (b.greenRoof) {
      const top = Math.max(...b.masses.map((m) => m.top));
      for (const m of b.masses)
        if (m.top >= top - 0.1) c.masses.push({ id: b.id, polygon: m.poly.map((r) => ring3(r, m.top)), height: 0.35, color: [...T.area.park, 255] as RGBA, base: m.top, src: b, roof: true });
    }
  }

  private buildStreet(c: Chunk, s: Street) {
    const T = this.theme;
    const g = this.world.streetGeom.get(s.id);
    if (!g) return;
    const closed = s.closed;
    for (const st of g.strips) {
      if (st.ring.length < 3) continue;
      const ped = PED_REALM.has(st.type);
      const tn = closed && !ped ? T_PLAZA : stripTone(st.type, !!st.bio);
      (ped ? c.kerbs : c.surfaces).push({ id: s.id, polygon: st.ring, color: rgba(tn(T)), kind: st.type, tone: tn });
    }
    if (!closed) for (const m of g.markings) c.marks.push(this.mark(m));
  }

  private mark(m: Marking): MarkDatum {
    const tn = m.color === "white" ? T_WHITE : T_YELLOW;
    const alpha = m.kind === "crosswalk" ? 235 : 225;
    return { path: m.path, width: m.width, color: rgba(tn(this.theme), alpha), dash: m.dash ? [m.dash[0] / m.width, m.dash[1] / m.width] : [0, 0], tone: tn, alpha };
  }

  private buildArea(c: Chunk, a: Area) {
    const tn = areaTone(a.type);
    c.areas.push({ id: a.id, polygon: a.poly, color: rgba(tn(this.theme)), kind: a.type, tone: tn });
  }

  private buildTree(c: Chunk, t: Tree) {
    const sp = speciesOf(t.species);
    let hsh = 0;
    for (let i = 0; i < t.id.length; i++) hsh = (hsh * 31 + t.id.charCodeAt(i)) | 0;
    c.trees.push({ id: t.id, position: [t.p[0], t.p[1], 0], r: t.r, h: t.h, proposed: !!t.createdBy, shape: sp?.shape, color: sp?.color, seed: ((hsh >>> 0) % 1000) / 1000 });
  }

  private buildPath(c: Chunk, p: FootPath) {
    const tn = p.type === "cycleway" ? T_CYCLE : T_PATH;
    c.paths.push({ path: p.path, color: rgba(tn(this.theme)), width: p.type === "steps" ? 2 : p.type === "cycleway" ? 2.6 : 2, tone: tn });
  }
}

export interface OutlinePath {
  path: Position[];
  /** drawn depth-tested against the scene, so parts hidden behind a building stay hidden */
  solid: boolean;
}

/**
 * World-space edges for selection, hover and highlight outlines. A building gives its visible
 * edges in 3D: the roof and base rings and the vertical edges at its outward corners. Flat
 * things (streets, areas, junctions) give one ring just above the ground.
 */
export function outlineFor(e: Entity, world: World): OutlinePath[] {
  const out: OutlinePath[] = [];
  const ring = (r: Ring, z: number): Position[] => [...r, r[0]].map((p) => [p[0], p[1], z]);
  const flat = (r: Ring) => out.push({ path: ring(r, 0.35), solid: false });
  if (e.kind === "building") {
    for (const m of e.masses)
      m.poly.forEach((r, k) => {
        out.push({ path: ring(r, m.base + 0.05), solid: true });
        out.push({ path: ring(r, m.top + 0.05), solid: true });
        if (k === 0) for (const p of outwardCorners(r)) out.push({ path: [[p[0], p[1], m.base], [p[0], p[1], m.top + 0.05]], solid: true });
      });
  } else if (e.kind === "street") {
    const g = world.streetGeom.get(e.id);
    if (g) flat(g.row);
  } else if (e.kind === "area" || e.kind === "parcel") {
    for (const r of e.poly) flat(r);
  } else if (e.kind === "node") {
    const g = world.nodeGeom.get(e.id);
    if (g?.carriageway) flat(g.carriageway);
  }
  return out;
}

/** corners where an outer ring turns outward by more than 20° (real corners, not the facets of a curve) */
function outwardCorners(r: Ring): Ring {
  const pts = r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r;
  const n = pts.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i],
      b = pts[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const ccw = area > 0 ? 1 : -1;
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n],
      b = pts[i],
      c = pts[(i + 1) % n];
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      vx = c[0] - b[0],
      vy = c[1] - b[1];
    const turn = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * ccw;
    if (turn > (20 * Math.PI) / 180) out.push(b);
  }
  return out;
}
