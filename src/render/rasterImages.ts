// Overlay raster images built in a worker (render/raster.worker) so colouring a day's hours never
// competes with interaction on the main thread. Requests are prioritised: the hours on screen first,
// the rest of the day (prewarm) only while the camera is still. Results are ImageBitmaps kept in a
// small LRU; the caller redraws when they land.

import type { RasterJob } from "./raster.worker";

type Grid = RasterJob["grid"];

const MAX_IMAGES = 110;
const cache = new Map<string, ImageBitmap>();
const queue: { job: RasterJob; urgent: boolean }[] = [];
const queued = new Set<string>();
let worker: Worker | null = null;
let busy = 0;
let onReady: (urgent: boolean) => void = () => {};
let idleGate: () => boolean = () => true;
let gateTimer: ReturnType<typeof setTimeout> | null = null;
const urgentKeys = new Set<string>();

/** main-thread cost of the image pipeline (posting jobs, receiving bitmaps), for measurement */
export const rasterStats = { posted: 0, built: 0, mainMs: 0, workerWallMs: 0 };
if (typeof window !== "undefined") (window as unknown as { __meridianRaster: typeof rasterStats }).__meridianRaster = rasterStats;

/** what to call when images land, and whether background work may run now (e.g. the camera is still) */
export function configureRasterImages(opts: { onReady: (urgent: boolean) => void; idle: () => boolean }) {
  onReady = opts.onReady;
  idleGate = opts.idle;
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  worker = new Worker(new URL("./raster.worker.ts", import.meta.url), { type: "module" });
  const started = new Map<string, number>();
  (worker as Worker & { started?: Map<string, number> }).started = started;
  worker.onmessage = (ev: MessageEvent<{ key: string; bitmap?: ImageBitmap; error?: string }>) => {
    const t = performance.now();
    busy--;
    const { key, bitmap } = ev.data;
    queued.delete(key);
    rasterStats.workerWallMs += t - (started.get(key) ?? t);
    started.delete(key);
    if (bitmap) {
      cache.set(key, bitmap);
      rasterStats.built++;
      while (cache.size > MAX_IMAGES) {
        const old = cache.keys().next().value!;
        // not closed: a layer may still hold it as its stand-in until its replacement lands
        cache.delete(old);
      }
    }
    const urgent = urgentKeys.delete(key);
    pump();
    rasterStats.mainMs += performance.now() - t;
    onReady(urgent);
  };
  return worker;
}

function pump() {
  const w = getWorker();
  if (!w) return;
  while (busy < 2 && queue.length) {
    const k = queue.findIndex((q) => q.urgent);
    if (k < 0 && !idleGate()) {
      // background work waits for a still camera
      if (!gateTimer) gateTimer = setTimeout(() => ((gateTimer = null), pump()), 250);
      return;
    }
    const { job } = queue.splice(k < 0 ? 0 : k, 1)[0];
    const t = performance.now();
    busy++;
    (w as Worker & { started?: Map<string, number> }).started!.set(job.key, t);
    // the values are copied (structured clone): the sim results keep theirs
    w.postMessage(job);
    rasterStats.posted++;
    rasterStats.mainMs += performance.now() - t;
  }
}

/** the built image, if any (most recently used last) */
export function peekRaster(key: string): ImageBitmap | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

/**
 * The image for `key` if built; otherwise null, after queueing it (urgent = needed on screen now).
 * Without Worker support (tests, old browsers) returns null and builds nothing.
 */
export function requestRaster(key: string, grid: Grid, bounds: readonly number[], edge: "study" | "ring", values: Uint8Array, lut: Uint8ClampedArray, urgent: boolean): ImageBitmap | null {
  const hit = peekRaster(key);
  if (hit) return hit;
  if (urgent) urgentKeys.add(key);
  if (queued.has(key)) {
    if (urgent) {
      const q = queue.find((x) => x.job.key === key);
      if (q) q.urgent = true;
    }
    return null;
  }
  queued.add(key);
  queue.push({ job: { key, grid: { ...grid }, bounds: [...bounds], edge, values, lut }, urgent });
  pump();
  return null;
}

/** drop queued background builds that are no longer wanted (e.g. a superseded run's hours) */
export function cancelRasters(keep: (key: string) => boolean) {
  for (let k = queue.length - 1; k >= 0; k--)
    if (!queue[k].urgent && !keep(queue[k].job.key)) {
      queued.delete(queue[k].job.key);
      queue.splice(k, 1);
    }
}
