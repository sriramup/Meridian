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
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import type { Building, Entity, Prop, Solid, SolidMaterial, SolidShape } from "@/world/types";
import { SOLID_SHAPES, unitMesh } from "./solidMeshes";

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

/** the most detailed tier drawn at a zoom level */
export function maxTierAt(zoom: number): 0 | 1 | 2 {
  return zoom >= 15.6 ? 2 : zoom >= 14.4 ? 1 : 0;
}

interface Entry {
  src: Prop | Building;
  tier: 0 | 1 | 2;
  parts: Map<LayerKey, { data: Float32Array; colors: Uint8Array; n: number }>;
}

export interface PackedLayer {
  key: LayerKey;
  shape: SolidShape;
  shading: Shading;
  n: number;
  positions: Float32Array;
  /** 12 floats per instance (3×3 matrix + zero translation), the SimpleMeshLayer model-matrix layout */
  matrices: Float32Array;
  colors: Uint8Array;
  /** owning entity id per instance (picking) */
  owners: string[];
  /** bumped whenever the arrays are replaced */
  version: number;
}

function entityWithSolids(e: Entity): e is Prop | Building {
  return e.kind === "prop" ? e.solids.length > 0 : e.kind === "building" ? !!e.solids?.length : false;
}

function buildEntry(e: Prop | Building): Entry {
  const groups = new Map<LayerKey, Solid[]>();
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
    list.forEach((s, i) => {
      if (isProp) writeInstance(data, i * STRIDE, s, e.p[0], e.p[1], e.rot);
      else writeInstance(data, i * STRIDE, s, 0, 0, 0);
      colors[i * 4] = s.color[0];
      colors[i * 4 + 1] = s.color[1];
      colors[i * 4 + 2] = s.color[2];
      colors[i * 4 + 3] = 255;
    });
    parts.set(k, { data, colors, n: list.length });
  }
  return { src: e, tier: detailTier(e), parts };
}

export class SolidInstances {
  private entries = new Map<string, Entry>();
  /** entity ids with instances in each layer */
  private members = new Map<LayerKey, Set<string>>();
  private packed = new Map<LayerKey, PackedLayer>();
  private dirtyKeys = new Set<LayerKey>();
  private maxTier: 0 | 1 | 2 = 2;
  private version = 0;
  /** entities (re)computed by the last update, for diagnostics and tests */
  lastRebuilt = 0;

  /**
   * Bring the cache in line with the current entities. `source` yields every prop and building
   * (only ones with solids are kept); unchanged records are skipped by reference.
   */
  update(source: Iterable<Entity>, maxTier: 0 | 1 | 2 = 2): boolean {
    const seen = new Set<string>();
    let rebuilt = 0;
    for (const e of source) {
      if (!entityWithSolids(e)) continue;
      seen.add(e.id);
      const cur = this.entries.get(e.id);
      if (cur && cur.src === e) continue;
      if (cur) this.drop(e.id, cur);
      const entry = buildEntry(e);
      this.entries.set(e.id, entry);
      for (const k of entry.parts.keys()) {
        let m = this.members.get(k);
        if (!m) this.members.set(k, (m = new Set()));
        m.add(e.id);
        this.dirtyKeys.add(k);
      }
      rebuilt++;
    }
    for (const [id, cur] of this.entries) if (!seen.has(id)) this.drop(id, cur);
    if (maxTier !== this.maxTier) {
      this.maxTier = maxTier;
      for (const k of this.members.keys()) this.dirtyKeys.add(k);
    }
    this.lastRebuilt = rebuilt;
    const changed = this.dirtyKeys.size > 0;
    for (const k of this.dirtyKeys) this.pack(k);
    this.dirtyKeys.clear();
    return changed;
  }

  private drop(id: string, cur: Entry) {
    this.entries.delete(id);
    for (const k of cur.parts.keys()) {
      this.members.get(k)?.delete(id);
      this.dirtyKeys.add(k);
    }
  }

  private pack(k: LayerKey) {
    const ids = this.members.get(k);
    let n = 0;
    if (ids) for (const id of ids) {
      const e = this.entries.get(id)!;
      if (e.tier <= this.maxTier) n += e.parts.get(k)!.n;
    }
    if (!n) {
      this.packed.delete(k);
      return;
    }
    const positions = new Float32Array(n * 3);
    const matrices = new Float32Array(n * 12);
    const colors = new Uint8Array(n * 4);
    const owners: string[] = new Array(n);
    let i = 0;
    for (const id of ids!) {
      const e = this.entries.get(id)!;
      if (e.tier > this.maxTier) continue;
      const p = e.parts.get(k)!;
      colors.set(p.colors, i * 4);
      for (let j = 0; j < p.n; j++, i++) {
        const o = j * STRIDE;
        positions[i * 3] = p.data[o];
        positions[i * 3 + 1] = p.data[o + 1];
        positions[i * 3 + 2] = p.data[o + 2];
        matrices.set(p.data.subarray(o + 3, o + 12), i * 12);
        owners[i] = id;
      }
    }
    const [shape, shading] = k.split(":") as [SolidShape, Shading];
    this.packed.set(k, { key: k, shape, shading, n, positions, matrices, colors, owners, version: ++this.version });
  }

  layers(): PackedLayer[] {
    return [...this.packed.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  /** total drawn instances */
  get count(): number {
    let n = 0;
    for (const p of this.packed.values()) n += p.n;
    return n;
  }
  get entityCount(): number {
    return this.entries.size;
  }
  /** the drawn instance count of one entity (0 when culled) */
  instancesOf(id: string): number {
    const e = this.entries.get(id);
    if (!e || e.tier > this.maxTier) return 0;
    let n = 0;
    for (const p of e.parts.values()) n += p.n;
    return n;
  }
}

// ---------------------------------------------------------------- deck.gl

/** SimpleMeshLayer with normals transformed by the inverse-transpose (correct light on stretched shapes) and picking by owner id */
class SolidMeshLayer extends SimpleMeshLayer<unknown, { owners: string[] }> {
  static layerName = "SolidMeshLayer";
  getShaders() {
    const s = super.getShaders();
    const fix = (src: string) => src.split("project_normal(instanceModelMatrix * normals)").join("project_normal(transpose(inverse(instanceModelMatrix)) * normals)");
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

const dataCache = new WeakMap<PackedLayer, object>();
/** the binary data object for a packed layer, kept stable so unchanged layers don't re-upload */
function binaryData(p: PackedLayer): object {
  let d = dataCache.get(p);
  if (!d)
    dataCache.set(
      p,
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

/** one SimpleMeshLayer per non-empty (shape, shading) group */
export function solidLayers(packed: PackedLayer[], opt: SolidLayerOptions): Layer[] {
  const prefix = opt.idPrefix ?? "lib-solids";
  return packed.map(
    (p) =>
      new SolidMeshLayer({
        id: `${prefix}-${p.key}`,
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: opt.origin,
        mesh: unitMesh(p.shape) as never,
        data: binaryData(p) as never,
        owners: p.owners,
        pickable: opt.pickable ?? true,
        material: p.shading === "light" && opt.night ? (false as never) : (MATERIAL[p.shading] as never),
      }),
  );
}
