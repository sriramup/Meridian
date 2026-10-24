// Converts the world model into chunked, render-ready arrays. The study area is cut into a grid of
// chunks (about 800 m; see CHUNK_TARGET). Chunks are built lazily, in the order the chunk loader
// (chunkLoader.ts) asks for them: the camera's chunk first, then outward. Each chunk tracks which
// of its parts (buildings, street surfaces, kerbs, markings, areas, trees, paths) an edit touched,
// and a rebuild replaces only those arrays, so deck.gl re-tessellates only the layers whose data
// changed. Theme and change-highlight switches only repaint: colours are rewritten in place and
// `paint` is bumped, so layers refresh their colour attribute alone.

import { PED_REALM } from "@/geometry/crossSection";
import { polyCentroid } from "@/geometry/polygon";
import type { Marking } from "@/geometry/streetGeometry";
import { speciesOf, type CrownShape } from "@/world/species";
import type { Position } from "@deck.gl/core";
import type { Area, Building, Entity, Path as FootPath, Prop, Ring, Street, StripType, Tree } from "@/world/types";
import type { World } from "@/world/world";
import { FACADE, facadeAlpha } from "./FacadeLayer";
import type { RGB, RGBA, Theme } from "./theme";

/**
 * Target chunk side (m). Measured on Austin (10,900 buildings over 4.0 x 4.3 km) and dense sandbox
 * designs: ~800 m chunks hold ~350-700 buildings, build in a few ms and initialise on the GPU in
 * well under a frame's worth of long task each, while keeping the layer count (and so per-frame
 * draw overhead) near 150 for the whole city. Smaller chunks multiplied layers and per-layer
 * overhead; larger ones made each edit and each border crossing re-tessellate more.
 */
export const CHUNK_TARGET = 800;

/** a part of a chunk with its own deck.gl layer */
export type ChunkPart = "masses" | "surfaces" | "kerbs" | "marks" | "areas" | "trees" | "paths";
const PARTS_OF: Record<string, ChunkPart[]> = {
  building: ["masses"],
  street: ["surfaces", "kerbs", "marks"],
  node: ["surfaces", "kerbs", "marks"],
  area: ["areas"],
  tree: ["trees"],
  path: ["paths"],
};
const ALL_PARTS: ChunkPart[] = ["masses", "surfaces", "kerbs", "marks", "areas", "trees", "paths"];

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

export interface Chunk {
  key: string;
  /** grid cell */
  ix: number;
  iy: number;
  /** cell bounds padded by a margin for entities that overhang it [x0, y0, x1, y1] (m) */
  box: [number, number, number, number];
  /** tallest roof in the chunk (m), for frustum tests */
  top: number;
  version: number;
  built: number;
  /** parts whose entities changed since they were last built */
  dirty: Set<ChunkPart>;
  ids: Set<string>;
  masses: MassDatum[];
  surfaces: SurfaceDatum[];
  kerbs: SurfaceDatum[];
  marks: MarkDatum[];
  areas: SurfaceDatum[];
  trees: TreeDatum[];
  paths: PathDatum[];
}

/** the chunk grid over a city's bounds: whole cells of about CHUNK_TARGET, anchored at the bounds' corner */
export interface ChunkGrid {
  x0: number;
  y0: number;
  cw: number;
  chh: number;
}
export function chunkGrid(b: readonly number[], target = CHUNK_TARGET): ChunkGrid {
  const nx = Math.max(1, Math.round((b[2] - b[0]) / target)),
    ny = Math.max(1, Math.round((b[3] - b[1]) / target));
  return { x0: b[0], y0: b[1], cw: (b[2] - b[0]) / nx || target, chh: (b[3] - b[1]) / ny || target };
}
const OVERHANG = 80;

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
  readonly grid: ChunkGrid;
  theme: Theme;
  showChanges = true;
  version = 0;
  /** bumped when colours are repainted in place (layers use it as their colour update trigger) */
  paint = 0;
  /** build timings (ms) for diagnostics: window.__meridian.scene.stats */
  stats = { builds: 0, buildMs: 0, maxBuildMs: 0 };

  constructor(private world: World, theme: Theme, target = CHUNK_TARGET) {
    this.theme = theme;
    this.grid = chunkGrid(world.meta?.bounds ?? [-1500, -1500, 1500, 1500], target);
    for (const e of world.entities.values()) this.place(e);
  }

  /** key of the chunk holding (x, y) */
  keyAt(x: number, y: number): string {
    const g = this.grid;
    return `${Math.floor((x - g.x0) / g.cw)}:${Math.floor((y - g.y0) / g.chh)}`;
  }

  private place(e: Entity) {
    if (!RENDERED.has(e.kind)) return;
    const a = entityAnchor(e);
    if (!a) return;
    const k = this.keyAt(a[0], a[1]);
    let c = this.chunks.get(k);
    if (!c) {
      const g = this.grid;
      const ix = Math.floor((a[0] - g.x0) / g.cw),
        iy = Math.floor((a[1] - g.y0) / g.chh);
      const x0 = g.x0 + ix * g.cw,
        y0 = g.y0 + iy * g.chh;
      c = {
        key: k,
        ix,
        iy,
        box: [x0 - OVERHANG, y0 - OVERHANG, x0 + g.cw + OVERHANG, y0 + g.chh + OVERHANG],
        top: 320,
        version: 1,
        built: 0,
        dirty: new Set(ALL_PARTS),
        ids: new Set(),
        masses: [],
        surfaces: [],
        kerbs: [],
        marks: [],
        areas: [],
        trees: [],
        paths: [],
      };
      this.chunks.set(k, c);
    }
    c.ids.add(e.id);
    c.version++;
    for (const p of PARTS_OF[e.kind] ?? ALL_PARTS) c.dirty.add(p);
    this.entityChunk.set(e.id, k);
  }

  /** absorb world changes; returns true if anything visible changed */
  sync(): boolean {
    const dirty = this.world.takeDirty();
    if (!dirty.size) return false;
    for (const id of dirty) {
      const old = this.entityChunk.get(id);
      const e = this.world.get(id);
      if (old) {
        const c = this.chunks.get(old)!;
        c.ids.delete(id);
        c.version++;
        // the entity's kind is gone with it when it was deleted: rebuild every part
        for (const p of (e && PARTS_OF[e.kind]) || ALL_PARTS) c.dirty.add(p);
        this.entityChunk.delete(id);
      }
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
      // every built chunk, current or not: a later partial rebuild keeps its untouched parts
      if (!c.built) continue;
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

  /** every chunk, built (synchronously) and current; prefer built() on the render path */
  list(): Chunk[] {
    for (const c of this.chunks.values()) if (c.built !== c.version) this.build(c);
    return [...this.chunks.values()];
  }

  /** every chunk, built or not (no work) */
  all(): IterableIterator<Chunk> {
    return this.chunks.values();
  }

  /** chunks that have been built at least once (their arrays may lag an edit until rebuilt) */
  built(): Chunk[] {
    const out: Chunk[] = [];
    for (const c of this.chunks.values()) if (c.built > 0) out.push(c);
    return out;
  }

  get(key: string): Chunk | undefined {
    return this.chunks.get(key);
  }

  isCurrent(c: Chunk): boolean {
    return c.built === c.version;
  }

  /** build (or rebuild the edited parts of) one chunk; returns the time it took (ms) */
  ensure(c: Chunk): number {
    if (c.built === c.version) return 0;
    const t0 = performance.now();
    this.build(c);
    const ms = performance.now() - t0;
    this.stats.builds++;
    this.stats.buildMs += ms;
    this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, ms);
    return ms;
  }

  private build(c: Chunk) {
    const T = this.theme;
    const w = this.world;
    const d = c.dirty;
    // only the parts an edit touched get new arrays; the others (and their GPU buffers) are kept
    if (d.has("masses")) c.masses = [];
    if (d.has("surfaces")) c.surfaces = [];
    if (d.has("kerbs")) c.kerbs = [];
    if (d.has("marks")) c.marks = [];
    if (d.has("areas")) c.areas = [];
    if (d.has("trees")) c.trees = [];
    if (d.has("paths")) c.paths = [];
    const streets = d.has("surfaces") || d.has("kerbs") || d.has("marks");
    for (const id of c.ids) {
      const e = w.get(id);
      if (!e) continue;
      if (e.kind === "building") {
        if (d.has("masses")) this.buildBuilding(c, e);
      } else if (e.kind === "street") {
        if (streets) this.buildStreet(c, e);
      } else if (e.kind === "node") {
        if (!streets) continue;
        const g = w.nodeGeom.get(e.id);
        if (!g) continue;
        if (g.carriageway && g.carriageway.length > 2) {
          const tn = g.plaza ? T_PLAZA : T_CARRIAGEWAY;
          (g.plaza ? c.kerbs : c.surfaces).push({ id: e.id, polygon: g.carriageway, color: rgba(tn(T)), kind: g.plaza ? "plaza" : "junction", tone: tn });
        }
        for (const r of g.corners) if (r.length > 2) c.kerbs.push({ id: e.id, polygon: r, color: rgba(T.kerbTop), kind: "corner", tone: T_KERB });
        if (g.island) c.kerbs.push({ id: e.id, polygon: g.island, color: rgba(T.island), kind: "island", tone: T_ISLAND });
        for (const m of g.markings) c.marks.push(this.mark(m));
      } else if (e.kind === "area") {
        if (d.has("areas")) this.buildArea(c, e);
      } else if (e.kind === "tree") {
        if (d.has("trees")) this.buildTree(c, e);
      } else if (e.kind === "path") {
        if (d.has("paths")) this.buildPath(c, e);
      }
    }
    if (d.has("masses")) {
      let top = 0;
      for (const m of c.masses) top = Math.max(top, m.base + m.height);
      c.top = top;
    }
    d.clear();
    c.built = c.version;
  }

  private massColor(b: Building): RGBA {
    const T = this.theme;
    const proposed = !!b.createdBy && this.showChanges;
    let base: RGB = T.building[b.use] ?? T.building.other;
    if (proposed) base = T.proposed;
    if (b.style?.facade === "glass" && !proposed) base = T.glass;
    // library primitives carry an explicit wall colour (kept when changes are highlighted, so a configured colour is seen)
    if (b.style?.color) base = b.style.color;
    const tint = (b.style?.tint ?? 0.5) - 0.5;
    // by day buildings range from white to a light grey so a block doesn't read as one white mass
    const k = T.id === "night" ? 1 + tint * 0.25 : 0.95 + tint * 0.16;
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
  } else if (e.kind === "prop") {
    // a library prop: its footprint (or the box around its solids) at the base and at its height
    const r = e.footprint?.[0] ?? propBox(e);
    out.push({ path: ring(r, 0.08), solid: false });
    if (e.height > 1.5) out.push({ path: ring(r, e.height), solid: true });
  }
  return out;
}

/** a prop's ground box from its solids (world coordinates) */
function propBox(e: Prop): Ring {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of e.solids) {
    const a = ((s.rot ?? 0) * Math.PI) / 180, ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a));
    const hx = (ca * s.size[0] + sa * s.size[1]) / 2, hy = (sa * s.size[0] + ca * s.size[1]) / 2;
    x0 = Math.min(x0, s.at[0] - hx); x1 = Math.max(x1, s.at[0] + hx);
    y0 = Math.min(y0, s.at[1] - hy); y1 = Math.max(y1, s.at[1] + hy);
  }
  if (!Number.isFinite(x0)) x0 = y0 = -0.5, x1 = y1 = 0.5;
  const pad = 0.15, c = Math.cos((e.rot * Math.PI) / 180), sn = Math.sin((e.rot * Math.PI) / 180);
  return ([[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x1 + pad, y1 + pad], [x0 - pad, y1 + pad]] as Ring).map(([x, y]) => [e.p[0] + c * x - sn * y, e.p[1] + sn * x + c * y]);
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
