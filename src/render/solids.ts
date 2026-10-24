// The generic renderer for library geometry: every Prop's solids and every Building.solids drawn
// as instanced unit meshes (src/render/solidMeshes.ts). There is one SimpleMeshLayer per unit
// shape and shading class, never one per entity; each instance carries its own position,
// orientation, scale and colour in binary attributes.
//
// SolidInstances keeps each entity's instances cached against the entity record (entities are
// immutable, so a changed entity is a new object): a world edit recomputes only the entities that
// changed and re-packs only the layers they touch. Small props drop out when the camera is far
// away (a detail tier per entity), which also only re-packs.

import { COORDINATE_SYSTEM, type Layer, type PickingInfo } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import type { Building, Entity, Prop, Solid, SolidMaterial, SolidShape, Vec2 } from "@/world/types";
import { SOLID_SHAPES, unitMesh, type MeshLod } from "./solidMeshes";

/** how a material is lit: matte (most things), glossy (metal, glass, water, plastic), light (emissive at night) */
export type Shading = "matte" | "gloss" | "light";
const SHADINGS: Shading[] = ["matte", "gloss", "light"];

export function shadingOf(m: SolidMaterial | undefined): Shading {
  switch (m) {
    case "metal":
    case "glass":
    case "water":
    case "plastic":
      return "gloss";
    case "light":
      return "light";
    default:
      return "matte";
  }
}

export type LayerKey = `${SolidShape}:${Shading}`;
const keyOf = (s: Solid): LayerKey => `${SOLID_SHAPES.includes(s.shape) ? s.shape : "box"}:${shadingOf(s.material)}`;

/** floats per instance in the packed cache: position (3) + column-major 3×3 model matrix (9) */
const STRIDE = 12;
const D2R = Math.PI / 180;
/** sizes are floored so the inverse-transpose used for normals never sees a singular matrix */
const MIN_SIZE = 0.005;

/**
 * Write one solid's instance transform. The owner frame is a ground point (ox, oy) turned by
 * `frameRot` degrees counter-clockwise (props); buildings pass their absolute frame (0, 0, 0°).
 * The solid is scaled to its size, tilted (pitch about its x, then roll about its y), yawed by
 * frame + own rotation, and placed with its base centre at `at`.
 */
export function writeInstance(out: Float32Array, o: number, s: Solid, ox: number, oy: number, frameRot: number) {
  const fr = frameRot * D2R;
  const cf = Math.cos(fr), sf = Math.sin(fr);
  out[o] = ox + cf * s.at[0] - sf * s.at[1];
  out[o + 1] = oy + sf * s.at[0] + cf * s.at[1];
  out[o + 2] = s.at[2];
  const yaw = fr + (s.rot ?? 0) * D2R;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const p = (s.tilt?.[0] ?? 0) * D2R, r = (s.tilt?.[1] ?? 0) * D2R;
  const cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
  const sx = Math.max(MIN_SIZE, Math.abs(s.size[0])), sy = Math.max(MIN_SIZE, Math.abs(s.size[1])), sz = Math.max(MIN_SIZE, Math.abs(s.size[2]));
  // M = Rz(yaw) · Rx(pitch) · Ry(roll) · S, stored column by column
  out[o + 3] = (c * cr - sn * sp * sr) * sx;
  out[o + 4] = (sn * cr + c * sp * sr) * sx;
  out[o + 5] = -cp * sr * sx;
  out[o + 6] = -sn * cp * sy;
  out[o + 7] = c * cp * sy;
  out[o + 8] = sp * sy;
  out[o + 9] = (c * sr + sn * sp * cr) * sz;
  out[o + 10] = (sn * sr - c * sp * cr) * sz;
  out[o + 11] = cp * cr * sz;
}

/**
 * Detail tier: 0 always drawn; 1 dropped when far (lamps, shelters, shrubs); 2 only drawn close
 * (benches, bollards, bins, animals). Buildings' solids are always drawn.
 */
export function detailTier(e: Prop | Building): 0 | 1 | 2 {
  if (e.kind === "building") return 0;
  let ext = 0;
  for (const s of e.solids) ext = Math.max(ext, Math.hypot(s.at[0], s.at[1]) * 2 + Math.max(s.size[0], s.size[1]));
  if (e.height <= 2.2 && ext <= 4) return 2;
  if (e.height <= 7 && ext <= 10) return 1;
  return 0;
}

/** parts smaller than this (largest extent, m) are left out at each mesh detail level */
const MIN_PART: Record<MeshLod, number> = { 0: 0.9, 1: 0.18, 2: 0 };
/** a prop keeps only its largest parts (by volume) when far: the crown masses of a tree, a shelter's roof and posts */
const MAX_PARTS: Record<MeshLod, number> = { 0: 3, 1: 6, 2: Infinity };


/** fallback cell size before the scene's chunk grid is known (m) */
export const CELL = 800;
/** the scene's chunk key for a point (render/lod.ts), or an 800 m grid cell without a scene */
export type CellKeyFn = (x: number, y: number) => string;
export const defaultCellKey: CellKeyFn = (x, y) => `c${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

/** how one cell is drawn: whether it is on screen and its detail (2 full · 1 mid · 0 far) */
export interface CellState {
  visible: boolean;
  lod: MeshLod;
}
/** a cell's extent (from what stands in it) and the top of its tallest thing, for distance and frustum tests */
export interface CellBounds {
  key: string;
  box: [number, number, number, number];
  top: number;
}
type CellView = (key: string, b: CellBounds) => CellState;

type Part = { data: Float32Array; colors: Uint8Array; n: number; ext: Float32Array; rank: Uint16Array };
interface Entry {
  src: Prop | Building;
  tier: 0 | 1 | 2;
  cell: string;
  anchor: Vec2;
  /** per instance: largest extent (m) and rank by volume within its entity (0 = largest; buildings 0) */
  parts: Map<LayerKey, Part>;
}

export interface PackedLayer {
  /** `${shape}:${shading}:${lod}` */
  key: string;
  cell: string;
  shape: SolidShape;
  shading: Shading;
  lod: MeshLod;
  n: number;
  positions: Float32Array;
  /** 12 floats per instance (3×3 matrix + zero translation), the SimpleMeshLayer model-matrix layout */
  matrices: Float32Array;
  colors: Uint8Array;
  /** owning entity id per instance (picking) */
  owners: string[];
  /** drawn now (its cell is on screen at this detail); hidden layers keep their buffers */
  visible: boolean;
  /** bumped whenever arrays are (re)built */
  version: number;
}

function entityWithSolids(e: Entity): e is Prop | Building {
  return e.kind === "prop" ? e.solids.length > 0 : e.kind === "building" ? !!e.solids?.length : false;
}

function anchorOf(e: Prop | Building): Vec2 {
  if (e.kind === "prop") return e.p;
  const r = e.footprint[0];
  let x = 0, y = 0;
  for (const p of r) (x += p[0]), (y += p[1]);
  return [x / r.length, y / r.length];
}

function buildEntry(e: Prop | Building, cellKey: CellKeyFn): Entry {
  const groups = new Map<LayerKey, Solid[]>();
  const vol = (s: Solid) => Math.abs(s.size[0] * s.size[1] * s.size[2]);
  const rankOf = new Map<Solid, number>();
  if (e.kind === "prop") [...e.solids].sort((a, b) => vol(b) - vol(a)).forEach((s, i) => rankOf.set(s, i));
  for (const s of e.solids ?? []) {
    const k = keyOf(s);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(s);
  }
  const parts: Entry["parts"] = new Map();
  const isProp = e.kind === "prop";
  for (const [k, list] of groups) {
    const data = new Float32Array(list.length * STRIDE);
    const colors = new Uint8Array(list.length * 4);
    const ext = new Float32Array(list.length);
    const rank = new Uint16Array(list.length);
    list.forEach((s, i) => {
      rank[i] = Math.min(65535, rankOf.get(s) ?? 0);
      ext[i] = Math.max(Math.abs(s.size[0]), Math.abs(s.size[1]), Math.abs(s.size[2]));
      if (isProp) writeInstance(data, i * STRIDE, s, e.p[0], e.p[1], e.rot);
      else writeInstance(data, i * STRIDE, s, 0, 0, 0);
      colors[i * 4] = s.color[0];
      colors[i * 4 + 1] = s.color[1];
      colors[i * 4 + 2] = s.color[2];
      colors[i * 4 + 3] = 255;
    });
    parts.set(k, { data, colors, n: list.length, ext, rank });
  }
  const a = anchorOf(e);
  return { src: e, tier: detailTier(e), cell: cellKey(a[0], a[1]), anchor: a, parts };
}

/** at a detail level: which props are kept (by their own detail tier) and which of their parts */
const tierKept = (e: Entry, lod: MeshLod) => e.tier <= lod;
const keepAt = (p: Part, j: number, lod: MeshLod) => p.ext[j] >= MIN_PART[lod] && p.rank[j] < MAX_PARTS[lod];

/**
 * Instance buffers by scene chunk, shape group and detail level. A camera move only changes which
 * buffers are visible: a chunk's buffers for a detail level are built the first time it is drawn at
 * that level and kept (GPU buffers stay) until something in that chunk changes.
 */
export class SolidInstances {
  private entries = new Map<string, Entry>();
  /** entity ids by cell and shape group */
  private members = new Map<string, Map<LayerKey, Set<string>>>();
  /** built buffers by `${cell}|${layerKey}|${lod}` */
  private packs = new Map<string, PackedLayer>();
  private bounds = new Map<string, CellBounds>();
  private boundsDirty = new Set<string>();
  private states = new Map<string, CellState>();
  private version = 0;
  /** entities (re)computed by the last update, for diagnostics and tests */
  lastRebuilt = 0;
  /** buffers built by the last update / setView */
  lastPacked = 0;

  constructor(private cellKey: CellKeyFn = defaultCellKey) {}

  /**
   * Bring the cache in line with the current entities and view. `source` yields every prop and
   * building (only ones with solids are kept); unchanged records are skipped by reference. `view`
   * says how each cell is drawn (one detail level everywhere, or a function of the cell).
   * Returns whether the drawn set changed.
   */
  update(source: Iterable<Entity>, view: CellView | MeshLod = 2): boolean {
    const seen = new Set<string>();
    let rebuilt = 0;
    let changed = false;
    for (const e of source) {
      if (!entityWithSolids(e)) continue;
      seen.add(e.id);
      const cur = this.entries.get(e.id);
      if (cur && cur.src === e) continue;
      if (cur) this.drop(e.id, cur);
      const entry = buildEntry(e, this.cellKey);
      this.entries.set(e.id, entry);
      let byKey = this.members.get(entry.cell);
      if (!byKey) this.members.set(entry.cell, (byKey = new Map()));
      for (const k of entry.parts.keys()) {
        let m = byKey.get(k);
        if (!m) byKey.set(k, (m = new Set()));
        m.add(e.id);
        this.invalidate(entry.cell, k);
      }
      this.boundsDirty.add(entry.cell);
      rebuilt++;
      changed = true;
    }
    for (const [id, cur] of this.entries) if (!seen.has(id)) (this.drop(id, cur), (changed = true));
    this.lastRebuilt = rebuilt;
    const v = typeof view === "function" ? view : () => ({ visible: true, lod: view });
    return this.setView(v) || changed;
  }

  private invalidate(cell: string, k: LayerKey) {
    for (const lod of [0, 1, 2]) this.packs.delete(`${cell}|${k}|${lod}`);
  }

  private drop(id: string, cur: Entry) {
    this.entries.delete(id);
    this.boundsDirty.add(cur.cell);
    const byKey = this.members.get(cur.cell);
    for (const k of cur.parts.keys()) {
      byKey?.get(k)?.delete(id);
      if (byKey?.get(k)?.size === 0) byKey.delete(k);
      this.invalidate(cur.cell, k);
    }
    if (byKey && !byKey.size) {
      this.members.delete(cur.cell);
      this.bounds.delete(cur.cell);
      this.states.delete(cur.cell);
      this.boundsDirty.delete(cur.cell);
    }
  }

  private refreshBounds() {
    for (const cell of this.boundsDirty) {
      const byKey = this.members.get(cell);
      if (!byKey) continue;
      const ids = new Set<string>();
      for (const s of byKey.values()) for (const id of s) ids.add(id);
      const b: CellBounds = { key: cell, box: [Infinity, Infinity, -Infinity, -Infinity], top: 0 };
      for (const id of ids) {
        const e = this.entries.get(id)!;
        const r = e.src.kind === "prop" ? Math.max(1, e.src.height) : 0;
        const pts = e.src.kind === "prop" ? [e.anchor] : e.src.footprint[0];
        for (const p of pts) {
          b.box[0] = Math.min(b.box[0], p[0] - r);
          b.box[1] = Math.min(b.box[1], p[1] - r);
          b.box[2] = Math.max(b.box[2], p[0] + r);
          b.box[3] = Math.max(b.box[3], p[1] + r);
        }
        b.top = Math.max(b.top, e.src.kind === "prop" ? e.src.height : e.src.height + 8);
      }
      this.bounds.set(cell, b);
    }
    this.boundsDirty.clear();
  }

  /**
   * Re-evaluate every cell (camera moved). Builds buffers only for a cell drawn at a detail level it
   * has none for yet; otherwise only visibility changes. Returns whether the drawn set changed.
   */
  setView(view: CellView): boolean {
    this.refreshBounds();
    let changed = false;
    let packed = 0;
    for (const [cell, b] of this.bounds) {
      const s = view(cell, b);
      const prev = this.states.get(cell);
      if (!prev || prev.visible !== s.visible || prev.lod !== s.lod) {
        this.states.set(cell, s);
        changed = true;
      }
      if (!s.visible) continue;
      for (const k of this.members.get(cell)?.keys() ?? []) {
        const id = `${cell}|${k}|${s.lod}`;
        if (!this.packs.has(id)) {
          this.pack(cell, k, s.lod);
          packed++;
          changed = true;
        }
      }
    }
    // visibility of every built buffer
    for (const p of this.packs.values()) {
      const s = this.states.get(p.cell);
      p.visible = !!s && s.visible && s.lod === p.lod && p.n > 0;
    }
    this.lastPacked = packed;
    return changed;
  }

  private pack(cell: string, k: LayerKey, lod: MeshLod) {
    const ids = this.members.get(cell)?.get(k);
    const [shape, shading] = k.split(":") as [SolidShape, Shading];
    let n = 0;
    if (ids)
      for (const id of ids) {
        const e = this.entries.get(id)!;
        if (!tierKept(e, lod)) continue;
        const p = e.parts.get(k)!;
        if (lod === 2) n += p.n;
        else for (let j = 0; j < p.n; j++) if (keepAt(p, j, lod)) n++;
      }
    const positions = new Float32Array(n * 3);
    const matrices = new Float32Array(n * 12);
    const colors = new Uint8Array(n * 4);
    const owners: string[] = new Array(n);
    let i = 0;
    if (ids)
      for (const id of ids) {
        const e = this.entries.get(id)!;
        if (!tierKept(e, lod)) continue;
        const p = e.parts.get(k)!;
        for (let j = 0; j < p.n; j++) {
          if (lod !== 2 && !keepAt(p, j, lod)) continue;
          const o = j * STRIDE;
          positions[i * 3] = p.data[o];
          positions[i * 3 + 1] = p.data[o + 1];
          positions[i * 3 + 2] = p.data[o + 2];
          matrices.set(p.data.subarray(o + 3, o + 12), i * 12);
          colors.set(p.colors.subarray(j * 4, j * 4 + 4), i * 4);
          owners[i] = id;
          i++;
        }
      }
    this.packs.set(`${cell}|${k}|${lod}`, { key: `${k}:${lod}`, cell, shape, shading, lod, n, positions, matrices, colors, owners, visible: false, version: ++this.version });
  }

  /** every built buffer (visible or kept hidden), in a stable order */
  layers(): PackedLayer[] {
    return [...this.packs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, p]) => p);
  }
  /** the buffers drawn now */
  visibleLayers(): PackedLayer[] {
    return this.layers().filter((p) => p.visible);
  }

  /** every cell with instances, with its bounds */
  cells(): CellBounds[] {
    this.refreshBounds();
    return [...this.bounds.values()];
  }

  /** drawn instances */
  get count(): number {
    let n = 0;
    for (const p of this.packs.values()) if (p.visible) n += p.n;
    return n;
  }
  get entityCount(): number {
    return this.entries.size;
  }
  /** the drawn instance count of one entity (0 when culled) */
  instancesOf(id: string): number {
    const e = this.entries.get(id);
    if (!e) return 0;
    const st = this.states.get(e.cell);
    if (!st || !st.visible || !tierKept(e, st.lod)) return 0;
    let n = 0;
    for (const p of e.parts.values()) for (let j = 0; j < p.n; j++) if (st.lod === 2 || keepAt(p, j, st.lod)) n++;
    return n;
  }
}

// ---------------------------------------------------------------- deck.gl

/** SimpleMeshLayer with normals transformed by the inverse-transpose (correct light on stretched shapes) and picking by owner id */
class SolidMeshLayer extends SimpleMeshLayer<unknown, { owners: string[] }> {
  static layerName = "SolidMeshLayer";
  getShaders() {
    const s = super.getShaders();
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("solidsfix") === "0") return s;
    // M = R·S (a rotation times a per-axis scale), so the inverse-transpose is R·S⁻¹ = M·S⁻²: divide
    // the normal by each column's squared length instead of inverting a matrix per vertex
    const fix = (src: string) =>
      src
        .split("project_normal(instanceModelMatrix * normals)")
        .join("project_normal(instanceModelMatrix * (normals / vec3(dot(instanceModelMatrixCol0, instanceModelMatrixCol0), dot(instanceModelMatrixCol1, instanceModelMatrixCol1), dot(instanceModelMatrixCol2, instanceModelMatrixCol2))))");
    return { ...s, vs: fix(s.vs) };
  }
  getPickingInfo({ info }: { info: PickingInfo }): PickingInfo {
    const owners = this.props.owners;
    if (info.index >= 0 && owners && info.index < owners.length) info.object = { id: owners[info.index] };
    return info;
  }
}

const MATERIAL: Record<Shading, object> = {
  matte: { ambient: 0.58, diffuse: 0.62, shininess: 6, specularColor: [18, 18, 18] },
  gloss: { ambient: 0.48, diffuse: 0.58, shininess: 72, specularColor: [150, 150, 150] },
  light: { ambient: 0.7, diffuse: 0.4, shininess: 32, specularColor: [90, 90, 90] },
};

export interface SolidLayerOptions {
  origin: [number, number, number];
  /** night theme: lights are drawn unlit (they glow) */
  night: boolean;
  pickable?: boolean;
  idPrefix?: string;
}

/** keyed by the colour buffer, so copies of a PackedLayer (visibility changes) share one upload while a re-tinted copy gets its own */
const dataCache = new WeakMap<Uint8Array, object>();
/** the binary data object for a packed layer, kept stable so unchanged layers don't re-upload */
function binaryData(p: PackedLayer): object {
  let d = dataCache.get(p.colors);
  if (!d)
    dataCache.set(
      p.colors,
      (d = {
        length: p.n,
        attributes: {
          getPosition: { value: p.positions, size: 3 },
          getColor: { value: p.colors, size: 4, normalized: true },
          instanceModelMatrix: { value: p.matrices, size: 12 },
        },
      }),
    );
  return d;
}

const poolCache = new WeakMap<Float32Array, object>();
/**
 * Warm pools of light on the ground under every light source (night): three stacked discs
 * (full, 2/3 and 1/3 of the reach) added together read as a soft falloff. Reach grows with height.
 */
function lightPools(p: PackedLayer): object {
  let d = poolCache.get(p.positions);
  if (!d) {
    const n = p.n * 3;
    const pos = new Float32Array(n * 3);
    const r = new Float32Array(n);
    for (let i = 0; i < p.n; i++) {
      const reach = Math.min(9, 1 + p.positions[i * 3 + 2] * 0.7);
      for (let k = 0; k < 3; k++) {
        const j = i * 3 + k;
        pos[j * 3] = p.positions[i * 3];
        pos[j * 3 + 1] = p.positions[i * 3 + 1];
        pos[j * 3 + 2] = 0.06 + k * 0.01;
        r[j] = (reach * (3 - k)) / 3;
      }
    }
    poolCache.set(p.positions, (d = { length: n, attributes: { getPosition: { value: pos, size: 3 }, getRadius: { value: r, size: 1 } } }));
  }
  return d;
}

/** one SimpleMeshLayer per non-empty (shape, shading) group */
export function solidLayers(packed: PackedLayer[], opt: SolidLayerOptions): Layer[] {
  const prefix = opt.idPrefix ?? "lib-solids";
  const pools: Layer[] = opt.night
    ? packed
        .filter((p) => p.shading === "light" && p.n > 0)
        .map(
          (p) =>
            new ScatterplotLayer({
              id: `${prefix}-pool-${p.cell}-${p.key}`,
              visible: p.visible,
              coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
              coordinateOrigin: opt.origin,
              data: lightPools(p) as never,
              getFillColor: [255, 190, 110, 30],
              radiusUnits: "meters",
              stroked: false,
              parameters: { depthWriteEnabled: false, blend: true, blendColorSrcFactor: "src-alpha", blendColorDstFactor: "one", blendAlphaSrcFactor: "one", blendAlphaDstFactor: "one" } as never,
            }),
        )
    : [];
  return [...pools, ...packed.filter((p) => p.n > 0).map(
    (p) =>
      new SolidMeshLayer({
        id: `${prefix}-${p.cell}-${p.key}`,
        visible: p.visible,
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: opt.origin,
        mesh: unitMesh(p.shape, p.lod) as never,
        data: binaryData(p) as never,
        owners: p.owners,
        pickable: opt.pickable ?? true,
        material: p.shading === "light" && opt.night ? (false as never) : (MATERIAL[p.shading] as never),
      }),
  )];
}
