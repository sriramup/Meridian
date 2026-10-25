// Decides which chunks are built and which of their layers exist, in priority order, a frame's
// budget at a time, and keeps every chunk's tier (lod.ts) and on-screen state current.
//
// - Priority: chunks on screen before chunks off it; within each, nearest to the eye first. So the
//   chunk under the camera comes first, then its neighbours ring by ring, then the rest.
// - Budget: each frame builds chunk data for at most ~6 ms and adds layers totalling at most
//   VERTEX_BUDGET polygon vertices, so deck.gl's tessellation and GPU upload of new layers is
//   spread over frames instead of one long task.
// - Preparing ahead: every chunk gets its base layers (buildings, street surfaces with areas,
//   kerbs, paths). Lane markings, the costliest near-only detail, are created while a chunk is still
//   approaching (within 1.7 x the NEAR distance) and stay hidden until it is near, so crossing into
//   a chunk never waits on tessellation.
// - Preserving: once created, a layer is kept (same id and data, so its GPU buffers stay); leaving
//   the view or a tier only flips `visible`. Layers are dropped only under memory pressure (far,
//   hidden detail first).
// - Moving: the camera's ground velocity predicts where it will be in LOOKAHEAD seconds; chunks
//   that will be on screen there are loaded right after the visible ones (prefetch in the
//   direction of motion). While the camera moves only visible and upcoming chunks are worked on;
//   preparing hidden detail and the rest of the city waits until it is still.

import type { Position } from "@deck.gl/core";
import type { Chunk, ChunkPart, SceneCache } from "./scene";
import { FAR, MID, NEAR, chunkTiers, eyeDistance, inFrustum, lodThresholds, setLodGrid, tierAt, useLod, type LodCamera, type Tier } from "./lod";

/** time a frame may spend initialising new layers (ms); the vertex budget adapts to hit it */
const FRAME_TARGET = 12;
/** starting vertex budget per frame, and its bounds while it adapts to the machine */
const VERTEX_START = 20000;
const VERTEX_MIN = 3000;
const VERTEX_MAX = 120000;
/** main-thread time for building chunk data per frame (ms) */
const BUILD_BUDGET = 6;
/** detail is prepared (hidden) this far out, as a multiple of the NEAR distance */
const PREPARE = 1.7;
/** above this much GPU buffer memory (bytes), hidden far detail is released */
const MEMORY_BUDGET = 768 * 2 ** 20;

/** how far ahead (s) the camera's motion is extrapolated for prefetching, and the cap on that lead (m) */
const LOOKAHEAD = 0.8;
const LEAD_MAX = 1600;

/** every chunk's layers ("surfaces" is one flat layer with the chunk's areas) */
const BASE: ChunkPart[] = ["surfaces", "kerbs", "masses", "paths"];

export interface ChunkView {
  tier: Tier;
  visible: boolean;
  dist: number;
  /** on screen where the camera is heading (prefetch) */
  ahead?: boolean;
  /** parts whose layers exist */
  parts: Set<ChunkPart>;
}

export interface ContextCell {
  key: string;
  box: [number, number, number, number];
  top: number;
  buildings: { polygon: [number, number][]; height: number; fade: number }[];
  tier: Tier;
  visible: boolean;
  dist: number;
  admitted: boolean;
}

/** the surrounding city's cells (m): coarse, since it is mostly far away and each cell is a layer */
const CONTEXT_CELL = 2400;

function partSize(c: Chunk, p: ChunkPart): number {
  let n = 0;
  if (p === "masses") for (const d of c.masses) for (const r of d.polygon) n += r.length * 3; // roof + walls
  else if (p === "marks" || p === "paths") for (const d of c[p]) n += d.path.length * 2;
  else if (p === "trees") n += c.trees.length;
  else if (p === "surfaces") for (const d of [...c.surfaces, ...c.areas]) n += (d.polygon as unknown[]).length;
  else for (const d of c[p]) n += (d.polygon as unknown[]).length * (p === "kerbs" ? 3 : 1);
  return n;
}

export class ChunkLoader {
  readonly views = new Map<string, ChunkView>();
  readonly cells: ContextCell[] = [];
  /** global layers that exist: trees, labels, ctx-areas, ctx-roads */
  readonly globals = new Set<string>();
  cam: LodCamera | null = null;
  /** chunks the loader has not finished (data or layers) */
  pending = true;
  private order: Chunk[] = [];
  /** tier or visibility changes not yet published to useLod */
  private unpublished = false;
  /** polygon vertices whose layers may be added per frame (deck.gl tessellates and uploads them) */
  vertexBudget = VERTEX_START;
  private lastVerts = 0;
  private orderDirty = true;
  /** the camera is moving: only visible and upcoming chunks are worked on */
  moving = false;
  /** smoothed ground velocity of the view centre (m/s) */
  velocity: [number, number] = [0, 0];
  private lastCam: { x: number; y: number; t: number } | null = null;
  /** layers added and data built, for diagnostics */
  stats = { admitted: 0, frames: 0, firstFrameAt: 0, completeAt: 0 };

  constructor(
    readonly scene: SceneCache,
    context: { buildings: { polygon: [number, number][]; height: number; fade: number }[] },
  ) {
    setLodGrid(
      (x, y) => scene.keyAt(x, y),
      (k) => scene.get(k),
    );
    // the surrounding city in coarse cells, so its 30,000+ footprints load last and cull by cell
    const byCell = new Map<string, ContextCell>();
    for (const b of context.buildings) {
      const p = b.polygon[0] as [number, number];
      const ix = Math.floor(p[0] / CONTEXT_CELL),
        iy = Math.floor(p[1] / CONTEXT_CELL);
      const key = `${ix}:${iy}`;
      let c = byCell.get(key);
      if (!c) {
        c = { key, box: [ix * CONTEXT_CELL - 100, iy * CONTEXT_CELL - 100, (ix + 1) * CONTEXT_CELL + 100, (iy + 1) * CONTEXT_CELL + 100], top: 0, buildings: [], tier: FAR, visible: true, dist: 0, admitted: false };
        byCell.set(key, c);
      }
      c.buildings.push(b);
      c.top = Math.max(c.top, b.height);
    }
    this.cells.push(...byCell.values());
  }

  /** a world edit added or removed chunks */
  invalidate() {
    this.orderDirty = true;
    this.pending = true;
  }

  view(key: string): ChunkView {
    let v = this.views.get(key);
    if (!v) this.views.set(key, (v = { tier: FAR, visible: true, dist: Infinity, parts: new Set() }));
    return v;
  }

  /**
   * New camera: recompute tiers and visibility; true if any changed. `notify` publishes the change
   * to useLod (off when called while React renders; the work loop publishes then).
   */
  setCamera(cam: LodCamera, notify = true): boolean {
    this.cam = cam;
    let changed = false;
    const { near } = lodThresholds(cam);
    const ahead = this.predict(cam);
    for (const c of this.scene.all()) {
      const v = this.view(c.key);
      const d = eyeDistance(cam, c.box, c.top);
      const tier = tierAt(d, v.tier === undefined ? undefined : v.tier, cam);
      const visible = inFrustum(cam, c.box, -2, c.top + 4);
      v.ahead = !!ahead && !visible && inFrustum(ahead, c.box, -2, c.top + 4);
      if (tier !== v.tier || visible !== v.visible) changed = true;
      // detail about to be needed: let the work loop prepare it
      if (d < near * PREPARE && !v.parts.has("marks") && c.ids.size) this.pending = true;
      v.tier = tier;
      v.visible = visible;
      v.dist = d;
      chunkTiers.set(c.key, tier);
    }
    for (const c of this.cells) {
      const d = eyeDistance(cam, c.box, c.top);
      const visible = inFrustum(cam, c.box, -2, c.top + 4);
      const tier = tierAt(d, c.tier, cam);
      if (tier !== c.tier || visible !== c.visible) changed = true;
      c.tier = tier;
      c.visible = visible;
      c.dist = d;
    }
    this.orderDirty = true;
    const ck = this.scene.keyAt(cam.center[0], cam.center[1]);
    const z = Math.round(cam.zoom * 10) / 10;
    const st = useLod.getState();
    if (changed && !notify) this.unpublished = this.pending = true;
    if (notify && (changed || st.cameraChunk !== ck || st.zoom !== z)) useLod.setState({ cameraChunk: ck, zoom: z, version: st.version + (changed ? 1 : 0) });
    return changed;
  }

  /** the camera LOOKAHEAD seconds on at its current ground velocity, or null when (nearly) still */
  private predict(cam: LodCamera): LodCamera | null {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const last = this.lastCam;
    this.lastCam = { x: cam.center[0], y: cam.center[1], t: now };
    if (!last) return null;
    const dt = (now - last.t) / 1000;
    if (dt <= 0) return null;
    if (dt > 0.25) {
      // a jump, or the first move after a pause: no velocity yet
      this.velocity = [0, 0];
      return null;
    }
    const k = Math.min(1, dt / 0.15);
    this.velocity = [this.velocity[0] + ((cam.center[0] - last.x) / dt - this.velocity[0]) * k, this.velocity[1] + ((cam.center[1] - last.y) / dt - this.velocity[1]) * k];
    let dx = this.velocity[0] * LOOKAHEAD,
      dy = this.velocity[1] * LOOKAHEAD;
    const lead = Math.hypot(dx, dy);
    if (lead < 20) return null;
    if (lead > LEAD_MAX) {
      dx *= LEAD_MAX / lead;
      dy *= LEAD_MAX / lead;
    }
    return { ...cam, center: [cam.center[0] + dx, cam.center[1] + dy], eye: [cam.eye[0] + dx, cam.eye[1] + dy, cam.eye[2]] };
  }

  private sorted(): Chunk[] {
    if (this.orderDirty) {
      this.order = [...this.scene.all()].filter((c) => c.ids.size);
      const rank = (c: Chunk) => {
        const v = this.view(c.key);
        return (v.visible ? 0 : v.ahead ? 5e6 : 1e7) + v.dist;
      };
      this.order.sort((a, b) => rank(a) - rank(b));
      this.orderDirty = false;
    }
    return this.order;
  }

  /** whether the part's layer should exist (now or prepared ahead) */
  private wants(c: Chunk, v: ChunkView, p: ChunkPart): boolean {
    if (p !== "marks") return true;
    return v.dist < lodThresholds(this.cam).near * PREPARE;
  }

  /**
   * The frame after an admission took `ms` (rAF to rAF): fit the vertex budget so deck.gl's
   * initialisation of new layers stays near FRAME_TARGET on this machine.
   */
  noteFrame(ms: number) {
    if (this.lastVerts < 2000) return;
    const perVert = Math.max(1e-5, (ms - 8) / this.lastVerts);
    const fit = Math.max(VERTEX_MIN, Math.min(VERTEX_MAX, FRAME_TARGET / perVert));
    this.vertexBudget = Math.round(this.vertexBudget * 0.5 + fit * 0.5);
    this.lastVerts = 0;
  }

  /**
   * One frame's work: build chunk data and admit layers in priority order within the budgets.
   * Returns true when layers were added (the caller re-stacks them).
   */
  work(): boolean {
    if (!this.pending) return false;
    const published = this.unpublished;
    this.unpublished = false;
    const t0 = performance.now();
    const VERTEX_BUDGET = this.vertexBudget;
    let verts = 0;
    let added = false;
    let builtAny = false;
    let remaining = false;
    const order = this.sorted();
    for (const c of order) {
      const v = this.view(c.key);
      const parts = [...BASE, "marks" as ChunkPart].filter((p) => !v.parts.has(p) && this.wants(c, v, p));
      if (!parts.length) continue;
      // moving: off-screen chunks the camera isn't heading for wait until it stops
      // (the final check below keeps the loader pending for them)
      if (this.moving && !v.visible && !v.ahead) continue;
      if (!this.scene.isCurrent(c)) {
        if (performance.now() - t0 > BUILD_BUDGET && added) {
          remaining = true;
          break;
        }
        this.scene.ensure(c);
        builtAny = true;
      }
      for (const p of parts) {
        const n = partSize(c, p);
        if (verts > 0 && verts + n > VERTEX_BUDGET) {
          remaining = true;
          break;
        }
        verts += n;
        v.parts.add(p);
        added = true;
        this.stats.admitted++;
      }
      if (remaining) break;
    }
    // globals once every visible chunk has its base layers; the surrounding city last
    if (!remaining) {
      const baseDone = order.every((c) => !this.view(c.key).visible || BASE.every((p) => this.view(c.key).parts.has(p)));
      if (baseDone) {
        for (const g of ["trees", "labels", "ctx-areas", "ctx-roads"])
          if (!this.globals.has(g)) {
            this.globals.add(g);
            added = true;
          }
        const cells = this.cells.filter((c) => !c.admitted && (c.visible || !this.moving)).sort((a, b) => (a.visible ? 0 : 1e7) + a.dist - ((b.visible ? 0 : 1e7) + b.dist));
        for (const c of cells) {
          const n = c.buildings.reduce((s, b) => s + b.polygon.length * 3, 0);
          if (verts > 0 && verts + n > VERTEX_BUDGET) {
            remaining = true;
            break;
          }
          verts += n;
          c.admitted = true;
          added = true;
        }
      } else remaining = true;
    }
    // anything still wanted beyond this frame?
    if (!remaining) remaining = order.some((c) => [...BASE, "marks" as ChunkPart].some((p) => !this.view(c.key).parts.has(p) && this.wants(c, this.view(c.key), p)));
    if (!remaining) remaining = this.cells.some((c) => !c.admitted);
    this.pending = remaining;
    this.lastVerts = verts;
    this.stats.frames++;
    if (builtAny) useLod.setState((s) => ({ loaded: s.loaded + 1 }));
    if (added && !this.stats.firstFrameAt) this.stats.firstFrameAt = performance.now();
    if (!remaining && !this.stats.completeAt) this.stats.completeAt = performance.now();
    return added || published;
  }

  /**
   * Under memory pressure, forget hidden or far markings (they are rebuilt if the chunk comes
   * near). Returns the keys of the chunks whose markings were dropped.
   */
  trim(bufferBytes: number, budget = MEMORY_BUDGET): string[] {
    if (bufferBytes < budget) return [];
    const far = [...this.views.entries()].filter(([, v]) => v.parts.has("marks") && (v.tier !== NEAR || !v.visible)).sort((a, b) => b[1].dist - a[1].dist);
    const out: string[] = [];
    for (const [k, v] of far.slice(0, Math.max(1, far.length >> 1))) {
      v.parts.delete("marks");
      out.push(k);
    }
    return out;
  }
}

/** context-cell buildings as positions (deck.gl reads `polygon`) */
export type ContextBuilding = { polygon: Position[]; height: number; fade: number };
export { MID, NEAR, FAR };
