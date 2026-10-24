// Long-lived, non-React singletons: the world model, scenario manager, render
// cache and reference datasets. React reads them through version counters in
// the app store so components re-render only when something they show changes.

import type maplibregl from "maplibre-gl";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import { SceneCache } from "@/render/scene";
import { MODEL } from "@/render/theme";
import { ScenarioManager } from "@/world/scenarios";
import type { CensusBlock, CityMeta, CountStation, Entity, Polygon } from "@/world/types";
import { World } from "@/world/world";
import { edgeShrink } from "@/render/edge";

export interface CityGrid {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
}

/** surrounding city outside the study area; `fade` (0..1) shrinks it away at its outer edge */
export interface ContextData {
  buildings: { polygon: [number, number][]; height: number; fade: number }[];
  roads: { path: [number, number][]; cls: string; fade: number }[];
  areas: { polygon: [number, number][]; type: string; fade: number }[];
}

export interface Runtime {
  cityId: string;
  /** pack whose typical weather the heat model uses (the sandbox borrows a real city's climate) */
  climateId: string;
  meta: CityMeta & { grid: CityGrid; impervious: { measuredFraction: number } };
  world: World;
  scenarios: ScenarioManager;
  scene: SceneCache;
  context: ContextData;
  census: CensusBlock[];
  counts: CountStation[];
  fema: { zone: string; poly: Polygon }[];
  landcover: Uint8Array;
  /** measured canopy / minor paving for the surrounding city (scripts/fetch_context_cover.py), if present */
  contextCover?: Uint8Array;
  dem: Uint16Array;
  map: maplibregl.Map | null;
  overlay: MapboxOverlay | null;
}

let RT: Runtime | null = null;
export const rt = (): Runtime => {
  if (!RT) throw new Error("city not loaded");
  return RT;
};
export const rtMaybe = () => RT;
/** install a runtime built outside loadCity (headless harness) */
export const setRuntime = (r: Runtime) => {
  RT = r;
};

async function fetchWithProgress(url: string, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer;
}

/** chunk side (m): CHUNK_TARGET, or ?chunk=<m> to compare sizes */
function chunkTarget(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const v = Number(new URLSearchParams(window.location.search).get("chunk"));
  return v >= 200 && v <= 5000 ? v : undefined;
}

/** half the side of the sandbox site (m) and its raster cell (m) */
export const SANDBOX_HALF = 1500;
const SANDBOX_CELL = 4;
/** flat sandbox ground, a few metres above the reference water level */
const SANDBOX_GROUND = 6;
/** typical persons per household (US, ACS 2022) for homes drawn in the sandbox */
const SANDBOX_HOUSEHOLD = 2.5;

/**
 * An empty design site: no buildings, streets, parcels, census or counts. Sun path, time zone and
 * weather come from the climate city's pack so the environmental models still run.
 */
export async function loadSandbox(climateId: string, onProgress: (p: number, label: string) => void): Promise<Runtime> {
  onProgress(0.2, "Preparing blank canvas");
  const res = await fetch(`/data/${climateId}/meta.json`);
  if (!res.ok) throw new Error(`climate ${climateId}: HTTP ${res.status}`);
  RT = sandboxRuntime(climateId, (await res.json()) as CityMeta);
  if (typeof window !== "undefined") (window as unknown as { __meridian: Runtime }).__meridian = RT;
  onProgress(1, "Ready");
  return RT;
}

/** the sandbox runtime for a climate city's meta (no I/O; also used by the headless harness) */
export function sandboxRuntime(climateId: string, climate: CityMeta): Runtime {
  const h = SANDBOX_HALF,
    n = (2 * h) / SANDBOX_CELL;
  const meta: Runtime["meta"] = {
    id: "sandbox",
    name: "Blank canvas",
    region: `Sandbox · ${climate.name} climate`,
    origin: climate.origin,
    bounds: [-h, -h, h, h],
    contextBounds: [-h, -h, h, h],
    timezone: climate.timezone,
    waterLevel: climate.waterLevel,
    sources: [{ id: "climate", name: `Sun path, time zone and typical weather of ${climate.name} (${climate.weather.source})`, url: "", license: "", retrieved: "", kind: "measured" }],
    weather: climate.weather,
    calibration: { householdSize: SANDBOX_HOUSEHOLD, censusPopulation: 0, censusHousingUnits: 0, lodesJobs: 0 },
    initialView: { center: [0, 0], zoom: 16.1, pitch: 50, bearing: -18 },
    grid: { x0: -h, y0: -h, cell: SANDBOX_CELL, nx: n, ny: n },
    impervious: { measuredFraction: 0 },
    sandbox: true,
  };
  const world = new World(meta);
  world.load([]);
  const scenarios = new ScenarioManager(world, { baselineName: "Blank site", baselineDescription: "Empty site: everything here is designed", branchPrefix: "Design" });
  const scene = new SceneCache(world, MODEL, chunkTarget());
  world.takeDirty();
  return {
    cityId: "sandbox",
    climateId,
    meta,
    world,
    scenarios,
    scene,
    context: { buildings: [], roads: [], areas: [] },
    census: [],
    counts: [],
    fema: [],
    // greenfield: grass everywhere (base raster code 0), level ground
    landcover: new Uint8Array(n * n),
    dem: new Uint16Array(n * n).fill(Math.round((climate.waterLevel + SANDBOX_GROUND) * 10)),
    map: null,
    overlay: null,
  };
}

export async function loadCity(cityId: string, onProgress: (p: number, label: string) => void): Promise<Runtime> {
  const base = `/data/${cityId}`;
  const files = ["meta.json", "world.json", "utilities.json", "reference.json", "context.json", "landcover.bin", "dem.bin"];
  const approx: Record<string, number> = { "meta.json": 1e4, "world.json": 1.6e7, "utilities.json": 2.3e6, "reference.json": 1.3e6, "context.json": 4.4e6, "landcover.bin": 1.1e6, "dem.bin": 2.2e6 };
  const total = Object.values(approx).reduce((a, b) => a + b, 0);
  let loaded = 0;
  const bufs = await Promise.all(
    files.map((f) =>
      fetchWithProgress(`${base}/${f}`, (n) => {
        loaded += n;
        onProgress(Math.min(0.85, (loaded / total) * 0.85), "Streaming city data");
      }),
    ),
  );
  const dec = new TextDecoder();
  const json = (i: number) => JSON.parse(dec.decode(bufs[i]));
  const meta = json(0);
  onProgress(0.86, "Parsing world model");
  await new Promise((r) => setTimeout(r, 0));
  const w = json(1);
  const utilities = json(2);
  const ref = json(3);
  const ctx = json(4);
  onProgress(0.9, "Solving street network geometry");
  await new Promise((r) => setTimeout(r, 0));
  const world = new World(meta);
  const entities: Entity[] = [...w.nodes, ...w.streets, ...w.buildings, ...w.areas, ...w.trees, ...w.parcels, ...w.stops, ...w.routes, ...w.paths, ...w.pois, ...w.places, ...utilities];
  world.load(entities);
  onProgress(0.97, "Preparing scene");
  await new Promise((r) => setTimeout(r, 0));
  const scenarios = new ScenarioManager(world);
  const scene = new SceneCache(world, MODEL, chunkTarget());
  world.takeDirty();
  const b = meta.bounds;
  const fadeAt = (pts: [number, number][]) => {
    let x = 0,
      y = 0;
    for (const p of pts) {
      x += p[0];
      y += p[1];
    }
    return edgeShrink(b, x / pts.length, y / pts.length);
  };
  const context: ContextData = {
    buildings: (ctx.buildings as [number[], number][])
      .map(([flat, h]) => {
        const ring: [number, number][] = [];
        for (let i = 0; i < flat.length; i += 2) ring.push([flat[i], flat[i + 1]]);
        return { polygon: ring, height: h, fade: fadeAt(ring) };
      })
      .filter((x) => x.fade > 0.02),
    roads: (ctx.roads as { c: string; p: number[] }[])
      .map((r) => {
        const path: [number, number][] = [];
        for (let i = 0; i < r.p.length; i += 2) path.push([r.p[i], r.p[i + 1]]);
        return { path, cls: r.c, fade: fadeAt(path) };
      })
      .filter((x) => x.fade > 0.02),
    areas: (ctx.areas as { t: string; r: number[] }[])
      .map((a) => {
        const ring: [number, number][] = [];
        for (let i = 0; i < a.r.length; i += 2) ring.push([a.r[i], a.r[i + 1]]);
        return { polygon: ring, type: a.t, fade: fadeAt(ring) };
      })
      .filter((x) => x.fade > 0.02),
  };
  RT = {
    cityId,
    climateId: cityId,
    meta,
    world,
    scenarios,
    scene,
    context,
    census: ref.census,
    counts: ref.counts,
    fema: ref.fema,
    landcover: new Uint8Array(bufs[5]),
    contextCover: await fetch(`${base}/context_cover.bin`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? new Uint8Array(b) : undefined))
      .catch(() => undefined),
    dem: new Uint16Array(bufs[6]),
    map: null,
    overlay: null,
  };
  if (typeof window !== "undefined") (window as unknown as { __meridian: Runtime }).__meridian = RT;
  onProgress(1, "Ready");
  return RT;
}
