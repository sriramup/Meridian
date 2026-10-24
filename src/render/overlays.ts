// Analysis overlays. Every visual here is a direct encoding of a simulation
// output array: link v/c and flows, raster grids, accessibility minutes,
// parcel capacity. Nothing is decorative or interpolated beyond what the
// legend states.

import { COORDINATE_SYSTEM, type Layer, type Position } from "@deck.gl/core";
import { BitmapLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { offsetPath, polyLength } from "@/geometry/polyline";
import { contextModel, useSims, type SimRecord } from "@/sim/client";
import { dqT } from "@/sim/heat";
import { useImpact, type ImpactPin } from "@/sim/impact";
import { gridMask, ringFade, studyFade } from "./edge";
import { rtMaybe } from "@/state/runtime";
import { useApp, type OverlayId } from "@/state/store";
import type { Street, Vec2 } from "@/world/types";
import { BLUES, DENSITY, DIVERGE, HEAT, LOS, SUN, VIRIDIS, VIRIDIS_R, sample, type Palette } from "./palettes";
import { programmeOf } from "@/world/ops/core";
import { polyCentroid } from "@/geometry/polygon";
import { dF, fmtDF, toF } from "@/lib/units";

export interface OverlayState {
  heatMode: "exposure" | "surface";

  accessCategory: string;
  densityMode: "residents" | "jobs";
  capacityMode: "added" | "limit";
  /** growth scenario snapshot year shown (latest available when null) */
  growthYear: number | null;
  particles: boolean;
}
export const overlayState: OverlayState = { heatMode: "exposure", accessCategory: "frequent_transit", densityMode: "residents", capacityMode: "added", growthYear: null, particles: true };

/** the growth snapshot to draw: the chosen year, else the latest */
export function growthSnapshot(r: { snapshots: { year: number; added: number[] }[] }) {
  return r.snapshots.find((s) => s.year === overlayState.growthYear) ?? r.snapshots[r.snapshots.length - 1];
}

const imgCache = new Map<string, ImageData | HTMLCanvasElement>();

function common() {
  const R = rtMaybe()!;
  return { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: [R.meta.origin.lon, R.meta.origin.lat, 0] as [number, number, number] };
}

type Grid = { x0: number; y0: number; cell: number; nx: number; ny: number };
type Fade = "study" | "ring";
const FADES = { study: studyFade, ring: ringFade };

/**
 * Raster overlay image faded out with the city: "study" for the study-area model grid, "ring" for
 * the surrounding-city grid (drawn only outside the study area).
 */
/** a cached raster image, without building it */
function peekImage(key: string): HTMLCanvasElement | null {
  return (imgCache.get(key) as HTMLCanvasElement | undefined) ?? null;
}

function rasterImage(key: string, grid: Grid, value: (i: number) => [number, number, number, number] | null, edge: Fade = "study"): HTMLCanvasElement {
  const hit = imgCache.get(key);
  if (hit) {
    // most recently used last, so images on screen are never the ones evicted
    imgCache.delete(key);
    imgCache.set(key, hit);
    return hit as HTMLCanvasElement;
  }
  const { nx, ny } = grid;
  const fade = gridMask(edge, rtMaybe()!.meta.bounds, grid, FADES[edge]);
  const img = new ImageData(nx, ny);
  for (let j = 0; j < ny; j++) {
    const row = (ny - 1 - j) * nx;
    for (let i = 0; i < nx; i++) {
      const f = fade[j * nx + i];
      if (!f) continue;
      const c = value(j * nx + i);
      if (!c) continue;
      const o = (row + i) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = c[3] * f;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = nx;
  canvas.height = ny;
  canvas.getContext("2d")!.putImageData(img, 0, 0);
  if (imgCache.size > 120) imgCache.delete(imgCache.keys().next().value!);
  imgCache.set(key, canvas);
  return canvas;
}

function bitmap(id: string, canvas: HTMLCanvasElement, opacity = 0.82, g: Grid = rtMaybe()!.meta.grid, visible = true): Layer {
  return new BitmapLayer({
    id,
    ...common(),
    image: canvas,
    bounds: [g.x0, g.y0, g.x0 + g.nx * g.cell, g.y0 + g.ny * g.cell],
    opacity,
    visible,
    textureParameters: { minFilter: "nearest", magFilter: "nearest" },
    parameters: { depthWriteEnabled: false, depthCompare: "always" },
  });
}

const rgba = (c: [number, number, number], a = 255): [number, number, number, number] => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), a];
const norm = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

export interface Legend {
  title: string;
  unit: string;
  palette: Palette;
  min: number;
  max: number;
  ticks?: string[];
  model: string;
  note?: string;
}

export function legendFor(overlay: OverlayId | null): Legend | null {
  switch (overlay) {
    case "traffic":
      return { title: "Volume / capacity", unit: "v/c", palette: LOS, min: 0, max: 1.2, ticks: ["0", "0.6", "0.9", "1.2+"], model: "Static user-equilibrium assignment · BPR", note: "Link width ∝ modelled flow; moving vehicles travel at modelled congested speed" };
    case "heat":
      return overlayState.heatMode === "exposure"
        ? { title: "Street heat (feels like)", unit: "°F", palette: HEAT, min: Math.round(toF(heatRange()[0])), max: Math.round(toF(heatRange()[1])), model: "Simplified surface-energy model · shadow-cast" }
        : { title: "Surface temperature", unit: "°F", palette: HEAT, min: Math.round(toF(heatRange()[0])), max: Math.round(toF(heatRange()[1])), model: "Simplified surface-energy model · shadow-cast" };
    case "sun":
      return { title: "Direct sun", unit: "hours", palette: SUN, min: 0, max: 12, model: "Shadow projection, 30-min steps" };
    case "runoff":
      return { title: "Runoff depth", unit: "mm", palette: BLUES, min: 0, max: 260, model: "NRCS curve number, HSG D" };
    case "flood":
      return { title: "Inundation depth", unit: "m", palette: BLUES, min: 0, max: 5, model: "Connected bathtub on z15 DEM", note: "Screening only — not a hydraulic model" };
    case "bike":
      return { title: "Bicycle level of traffic stress", unit: "LTS", palette: LOS, min: 1, max: 4, ticks: ["1", "2", "3", "4"], model: "Mekuria/Furth LTS: facility, lanes, speed, unsignalised crossings", note: "1–2 = comfortable for most adults" };
    case "access":
      if (overlayState.accessCategory === "emergency") return { title: "Fire / EMS response travel time", unit: "min", palette: VIRIDIS_R, min: 0, max: 8, model: "Vehicle network from fire & EMS stations, free-flow; NFPA 1710 standard 4 min" };
      return { title: "Walk time to " + overlayState.accessCategory.replace("_", " "), unit: "min", palette: VIRIDIS_R, min: 0, max: 20, model: "Network shortest path, 1.3 m/s" };
    case "density":
      return { title: overlayState.densityMode === "residents" ? "Residents per hectare" : "Jobs per hectare", unit: "/ha", palette: DENSITY, min: 0, max: overlayState.densityMode === "residents" ? 400 : 2500, model: "Census 2020 HU / LODES 2023 jobs allocated to buildings; proposals estimated", note: "square-root colour scale" };
    case "growth":
      return { title: `Added residents by ${overlayState.growthYear ?? "horizon"}`, unit: "/ha of lot", palette: VIRIDIS, min: 0, max: 600, model: "Logistic growth allocated by zoned capacity × redevelopment likelihood (TCAD) × transit access", note: "square-root colour scale · a scenario, not a forecast" };
    case "zoning":
      return { title: overlayState.capacityMode === "added" ? "Additional capacity under zoning" : "Binding constraint", unit: "m² GFA", palette: VIRIDIS, min: 0, max: 60000, model: "Base zoning FAR & height + density bonus + Capitol View Corridors (simplified)", note: "square-root colour scale" };
    default:
      return null;
  }
}

/**
 * Colour range of the heat map (°C). Shade sits near air temperature and sun-baked pavement 10–15 °C
 * above it, so the range is anchored to the shown hour's air temperature: every day and hour spans
 * blue (shade) to orange (sun on hard ground).
 */
function heatRange(): [number, number] {
  const { rec } = shown("heat");
  if (!rec) return overlayState.heatMode === "exposure" ? [30, 60] : [25, 70];
  // one scale for the whole day (anchored to its hottest hour), so playback has no colour jumps
  const air = Math.round(Math.max(...(rec.result.airTemp as number[])));
  return overlayState.heatMode === "exposure" ? [air - 4, air + 14] : [air - 4, air + 30];
}

const warmed = new Set<string>();
/** run image builders one per idle slice (once per key) */
function prewarm(key: string, jobs: (() => unknown)[]) {
  if (warmed.has(key)) return;
  warmed.add(key);
  const idle = (cb: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(() => cb(), { timeout: 400 }) : setTimeout(cb, 16));
  const next = (k: number) => {
    // once all are built, redraw so every hour joins the layer list (at opacity 0) ahead of time
    if (k >= jobs.length) return useApp.getState().bumpOverlay();
    idle(() => {
      jobs[k]();
      next(k + 1);
    });
  };
  next(0);
}

/** the two modelled hours around `h` (wrapping past midnight) and how far between them it is */
function bracket(hours: number[], h: number): { i0: number; i1: number; t: number } {
  const n = hours.length;
  for (let k = 0; k < n; k++) {
    const next = k + 1 < n ? hours[k + 1] : hours[0] + 24;
    if (h >= hours[k] && h < next) return { i0: k, i1: (k + 1) % n, t: (h - hours[k]) / (next - hours[k]) };
  }
  const span = hours[0] + 24 - hours[n - 1];
  return { i0: n - 1, i1: 0, t: Math.max(0, Math.min(1, (h + 24 - hours[n - 1]) / span)) };
}

/**
 * The modelled hours i0 → i1 blended as (1 − t)·a + t·b at overall opacity alpha. Every hour of the
 * day is a permanent layer in fixed order, always visible, so moving through the day (and crossing
 * the hour mark) only changes opacity values: no layer is added, removed, hidden or reordered
 * (those structural changes showed as a white flash on the hour). Of the pair, the one drawn on top
 * (later in the list) gets its weight directly; the one beneath is scaled up to show through it.
 * Hours whose image isn't built yet are left out until the idle prewarm has made them.
 */
function crossfade(id: string, n: number, img: (k: number, build: boolean) => HTMLCanvasElement | null, i0: number, i1: number, t: number, alpha: number, g?: Grid): Layer[] {
  const w = new Map<number, number>([[i0, i0 === i1 ? 1 : 1 - t]]);
  if (i1 !== i0) w.set(i1, t);
  const [lo, hi] = i0 < i1 ? [i0, i1] : [i1, i0];
  const upper = (w.get(hi) ?? 0) * alpha;
  const lower = i0 === i1 ? alpha : ((w.get(lo) ?? 0) * alpha) / Math.max(1e-6, 1 - upper);
  const out: Layer[] = [];
  for (let k = 0; k < n; k++) {
    const active = w.has(k);
    const c = img(k, active);
    if (!c) continue;
    const op = !active ? 0 : k === hi && i0 !== i1 ? upper : lower;
    out.push(bitmap(`${id}-${k}`, c, op, g));
  }
  return out;
}

/** the surrounding-city result for the same parameters (started on first request, redrawn when it lands) */
function surrounding(model: "heat" | "sun" | "runoff", params: Record<string, unknown>) {
  return contextModel(model, params, () => useApp.getState().bumpOverlay());
}

function shown(kind: SimRecord["kind"]): { rec?: SimRecord; cmp?: SimRecord } {
  const s = useSims.getState();
  const rec = s.records.find((r) => r.id === s.shown[kind] && r.status === "done");
  const cmp = s.records.find((r) => r.id === s.compare[kind] && r.status === "done");
  return { rec, cmp };
}

// --------------------------------------------------------------------------------- traffic

interface LinkVis {
  path: Position[];
  vc: number;
  flow: number;
  speed: number;
  diff?: number;
  key: string;
  name?: string;
}

const trafficCache = new Map<string, LinkVis[]>();
function trafficLinks(rec: SimRecord, hour: number, cmp?: SimRecord): LinkVis[] {
  const key = `${rec.id}:${hour}:${cmp?.id ?? ""}`;
  const hit = trafficCache.get(key);
  if (hit) return hit;
  const r = rec.result;
  const prof: number[] = r.hourly;
  const peak = r.period === "am" ? 8 : 17;
  const f = prof[Math.floor(hour)] / prof[peak];
  const linkKey = (res: any, k: number) => {
    const p = res.paths[k] as number[];
    return `${p[0].toFixed(0)},${p[1].toFixed(0)}>${p[p.length - 2].toFixed(0)},${p[p.length - 1].toFixed(0)}`;
  };
  let base: Map<string, number> | null = null;
  if (cmp) {
    base = new Map();
    for (let k = 0; k < cmp.result.paths.length; k++) base.set(linkKey(cmp.result, k), cmp.result.flows[k]);
  }
  const out: LinkVis[] = [];
  for (let k = 0; k < r.paths.length; k++) {
    const flat = r.paths[k] as number[];
    const pts: Vec2[] = [];
    for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
    if (polyLength(pts) < 2) continue;
    const meta = r.links[k];
    const off = Math.min(6, 1.5 + meta.lanes * 1.4);
    const path = offsetPath(pts, -off).map((p) => [p[0], p[1], 0.6] as Position);
    const vc0 = r.vc[k];
    const vc = vc0 * f;
    const t0 = r.time[k] / (1 + 0.15 * Math.pow(vc0, 4));
    const t = t0 * (1 + 0.15 * Math.pow(vc, 4));
    const lk = linkKey(r, k);
    out.push({ path, vc, flow: r.flows[k] * f, speed: (meta.length / Math.max(0.1, t)) * 3.6, diff: base ? (r.flows[k] - (base.get(lk) ?? 0)) * f : undefined, key: lk, name: meta.name });
  }
  if (trafficCache.size > 12) trafficCache.delete(trafficCache.keys().next().value!);
  trafficCache.set(key, out);
  return out;
}

export interface TripDatum {
  path: Position[];
  timestamps: number[];
  color: [number, number, number];
}
const tripsCache = new Map<string, TripDatum[]>();
export const TRIP_LOOP = 240;

/** vehicles: count per link = flow × traversal time (density), moving at modelled speed */
export function trafficTrips(hour: number): TripDatum[] {
  const { rec, cmp } = shown("traffic");
  if (!rec) return [];
  const key = `${rec.id}:${Math.floor(hour)}`;
  const hit = tripsCache.get(key);
  if (hit) return hit;
  const links = trafficLinks(rec, Math.floor(hour), cmp);
  const out: TripDatum[] = [];
  // budget the number of animated vehicles; density stays proportional to modelled flow
  let total = 0;
  for (const l of links) if (l.flow >= 20) total += (l.flow * (polyLength((l.path as [number, number][]).map((p) => [p[0], p[1]] as Vec2)) / Math.max(1.5, l.speed / 3.6))) / 3600;
  const SCALE = Math.min(0.5, 9000 / Math.max(1, total * (TRIP_LOOP / 60)));
  for (const l of links) {
    if (l.flow < 20) continue;
    const pts = l.path as [number, number, number][];
    const L = polyLength(pts.map((p) => [p[0], p[1]] as Vec2));
    const v = Math.max(1.5, l.speed / 3.6);
    const traverse = L / v;
    const headway = 3600 / (l.flow * SCALE);
    if (headway > TRIP_LOOP) continue;
    const cum: number[] = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const color = sample(LOS, l.vc / 1.2);
    for (let t = -traverse; t < TRIP_LOOP; t += headway) {
      out.push({ path: pts, timestamps: cum.map((d) => t + d / v), color: color as [number, number, number] });
      if (out.length > 12000) break;
    }
  }
  tripsCache.clear();
  tripsCache.set(key, out);
  return out;
}

export function tripsLayer(time: number, data: TripDatum[]): Layer {
  return new TripsLayer<TripDatum>({
    id: "traffic-trips",
    ...common(),
    data,
    getPath: (d) => d.path,
    getTimestamps: (d) => d.timestamps,
    getColor: (d) => d.color,
    currentTime: time % TRIP_LOOP,
    trailLength: 2.2,
    widthUnits: "meters",
    getWidth: 2.2,
    widthMinPixels: 2,
    capRounded: true,
    parameters: { depthWriteEnabled: false, depthCompare: "always" },
  });
}

// --------------------------------------------------------------------------------- main

export function overlayLayers(overlay: OverlayId | null, hour: number, _theme: string): { ground: Layer[]; top: Layer[] } {
  const R = rtMaybe();
  if (!R || !overlay) return { ground: [], top: [] };
  const ground: Layer[] = [];
  const top: Layer[] = [];
  const g = R.meta.grid;

  if (overlay === "traffic") {
    const { rec, cmp } = shown("traffic");
    if (rec) {
      const links = trafficLinks(rec, Math.floor(hour), cmp);
      const diff = !!cmp;
      ground.push(
        new PathLayer<LinkVis>({
          id: `traffic-links-${rec.id}-${cmp?.id ?? ""}-${Math.floor(hour)}`,
          ...common(),
          data: links,
          getPath: (d) => d.path,
          getColor: (d) => (diff ? rgba(sample(DIVERGE, norm(d.diff ?? 0, -600, 600)), Math.abs(d.diff ?? 0) < 25 ? 40 : 235) : rgba(sample(LOS, d.vc / 1.2), d.flow < 15 ? 60 : 235)),
          getWidth: (d) => (diff ? Math.min(9, 1 + Math.abs(d.diff ?? 0) / 120) : Math.min(10, 1.2 + d.flow / 280)),
          widthUnits: "meters",
          widthMinPixels: 1,
          capRounded: true,
          jointRounded: true,
          pickable: true,
          parameters: { depthWriteEnabled: false, depthCompare: "always" },
        }),
      );
      const nodes = (rec.result.nodes as { p: Vec2; vc: number; los: string; name: string }[]).filter((n) => n.vc > 0.85).slice(0, 12);
      top.push(
        new ScatterplotLayer({
          id: `traffic-nodes-${rec.id}`,
          ...common(),
          data: nodes,
          getPosition: (d: { p: Vec2 }) => [d.p[0], d.p[1], 2],
          getRadius: (d: { vc: number }) => 10 + d.vc * 6,
          radiusUnits: "meters",
          stroked: true,
          filled: false,
          getLineColor: (d: { vc: number }) => rgba(sample(LOS, d.vc / 1.2)),
          lineWidthMinPixels: 2,
          parameters: { depthCompare: "always", depthWriteEnabled: false },
        }),
      );
    }
  } else if (overlay === "heat") {
    const { rec, cmp } = shown("heat");
    if (rec) {
      const hours: number[] = rec.result.hours;
      const { i0, i1, t } = bracket(hours, hour);
      const exp = overlayState.heatMode === "exposure";
      const [lo, hi2] = heatRange();
      const image = (hi: number, build = true) => {
        const key = `heat:${rec.id}:${hi}:${overlayState.heatMode}:${cmp?.id ?? ""}:${lo}`;
        if (!build) return peekImage(key);
        const arr: Uint8Array = exp ? rec.result.exposure[hi] : rec.result.surface[hi];
        const ci = cmp ? cmp.result.hours.indexOf(hours[hi]) : -1;
        const carr: Uint8Array | undefined = cmp && ci >= 0 ? (exp ? cmp.result.exposure[ci] : cmp.result.surface[ci]) : undefined;
        return rasterImage(key, g, (i) => {
          const q = arr[i];
          if (!q) return null;
          if (carr) {
            const d = dqT(q) - dqT(carr[i] || q);
            if (Math.abs(d) < 0.25) return null;
            return rgba(sample(DIVERGE, norm(d, -3, 3)), 240);
          }
          return rgba(sample(HEAT, norm(dqT(q), lo, hi2)), 205);
        });
      };
      // the surrounding city (unaffected by edits) continues the map outward
      const ctx = cmp ? null : surrounding("heat", rec.params);
      if (ctx?.model === "heat") {
        const cimage = (hi: number, build = true) => {
          const ckey = `heatctx:${JSON.stringify(rec.params)}:${hi}:${overlayState.heatMode}:${lo}`;
          if (!build) return peekImage(ckey);
          const ci = ctx.hours.indexOf(hours[hi]);
          const arr = ci < 0 ? null : exp ? ctx.exposure[ci] : ctx.surface[ci];
          return rasterImage(ckey, ctx.gridSpec, (i) => (arr?.[i] ? rgba(sample(HEAT, norm(dqT(arr[i]), lo, hi2)), 205) : null), "ring");
        };
        ground.push(...crossfade("heatctx", hours.length, cimage, i0, i1, t, 0.6, ctx.gridSpec));
        prewarm(`ctx:${rec.id}:${overlayState.heatMode}:${lo}`, hours.map((_, k) => () => cimage(k)));
      }
      ground.push(...crossfade("heat", hours.length, image, i0, i1, t, cmp ? 0.8 : 0.6));
      // build the rest of the day's images in idle time so playback never stalls on one
      prewarm(`heat:${rec.id}:${overlayState.heatMode}:${cmp?.id ?? ""}:${lo}`, hours.map((_, k) => () => image(k)));
    }
  } else if (overlay === "sun") {
    const { rec } = shown("sun");
    if (rec) {
      const arr: Float32Array = rec.result.grid;
      const canvas = rasterImage(`sun:${rec.id}`, g, (i) => rgba(sample(SUN, norm(arr[i], 0, 12)), 190));
      const ctx = surrounding("sun", rec.params);
      if (ctx?.model === "sun") {
        const ca = ctx.grid;
        const ckey = `sunctx:${JSON.stringify(rec.params)}`;
        ground.push(bitmap(ckey, rasterImage(ckey, ctx.gridSpec, (i) => rgba(sample(SUN, norm(ca[i], 0, 12)), 190), "ring"), 0.85, ctx.gridSpec));
      }
      ground.push(bitmap(`sun-${rec.id}`, canvas, 0.85));
    }
  } else if (overlay === "runoff") {
    const { rec, cmp } = shown("runoff");
    if (rec) {
      const arr: Uint8Array = rec.result.grid;
      const carr: Uint8Array | undefined = cmp?.result.grid;
      const canvas = rasterImage(`runoff:${rec.id}:${cmp?.id ?? ""}`, g, (i) => {
        if (carr) {
          const d = arr[i] - carr[i];
          return Math.abs(d) < 2 ? null : rgba(sample(DIVERGE, norm(d, -150, 150)), 220);
        }
        return rgba(sample(BLUES, norm(arr[i], 0, 260)), 170);
      });
      const ctx = carr ? null : surrounding("runoff", rec.params);
      if (ctx?.model === "runoff") {
        const ca = ctx.grid;
        const ckey = `runoffctx:${JSON.stringify(rec.params)}`;
        ground.push(bitmap(ckey, rasterImage(ckey, ctx.gridSpec, (i) => rgba(sample(BLUES, norm(ca[i], 0, 260)), 170), "ring"), 0.82, ctx.gridSpec));
      }
      ground.push(bitmap(`runoff-${rec.id}-${cmp?.id ?? ""}`, canvas));
    }
  } else if (overlay === "flood") {
    const { rec } = shown("flood");
    if (rec) {
      const arr: Uint8Array = rec.result.depth;
      const canvas = rasterImage(`flood:${rec.id}`, g, (i) => (arr[i] ? rgba(sample(BLUES, norm(arr[i] / 20, 0, 5)), 215) : null));
      ground.push(bitmap(`flood-${rec.id}`, canvas, 0.9));
      const hit = (rec.result.buildings as { id: string; maxDepth: number }[]).slice(0, 300);
      top.push(
        new ScatterplotLayer({
          id: `flood-bld-${rec.id}`,
          ...common(),
          data: hit.map((h) => ({ ...h, p: (() => { const b = R.world.get(h.id); return b && b.kind === "building" ? polyCentroid(b.footprint) : [0, 0]; })() })),
          getPosition: (d: { p: Vec2 }) => [d.p[0], d.p[1], 3],
          getRadius: 7,
          radiusUnits: "meters",
          getFillColor: [200, 40, 40, 230],
          parameters: { depthCompare: "always", depthWriteEnabled: false },
        }),
      );
    }
    // FEMA regulatory floodplain outline (measured / regulatory)
    ground.push(
      new SolidPolygonLayer({
        id: "fema",
        ...common(),
        data: R.fema.filter((f) => f.zone === "AE"),
        getPolygon: (d: { poly: Vec2[][] }) => d.poly as Position[][],
        getFillColor: [60, 110, 200, 45],
        parameters: { depthWriteEnabled: false, depthCompare: "always" },
      }),
    );
  } else if (overlay === "access") {
    const { rec } = shown("access");
    if (rec) {
      const cat = overlayState.accessCategory;
      const nm: Float32Array = rec.result.nodeMinutes[cat];
      const nodes: Vec2[] = rec.result.nodes;
      ground.push(
        new ScatterplotLayer({
          id: `access-${rec.id}-${cat}`,
          ...common(),
          data: nodes.map((p, i) => ({ p, m: nm[i] })).filter((d) => Number.isFinite(d.m)),
          getPosition: (d: { p: Vec2 }) => [d.p[0], d.p[1], 0.5],
          getRadius: 16,
          radiusUnits: "meters",
          getFillColor: (d: { m: number }) => rgba(sample(VIRIDIS_R, norm(d.m, 0, cat === "emergency" ? 8 : 20)), 210),
          parameters: { depthWriteEnabled: false, depthCompare: "always" },
        }),
      );
    }
  } else if (overlay === "density") {
    ground.push(densityLayer());
  } else if (overlay === "zoning") {
    const { rec } = shown("capacity");
    if (rec) {
      const caps = new Map((rec.result.parcels as { id: string; addedGfa: number; limitedBy: string; utilisation: number }[]).map((c) => [c.id, c]));
      const parcels = R.world.all("parcel").filter((p) => caps.has(p.id));
      const LIMIT: Record<string, [number, number, number]> = { far: [94, 129, 172], height: [217, 145, 54], cvc: [190, 60, 80], historic: [128, 90, 160], public: [150, 150, 150], entitlement: [170, 150, 120], none: [90, 170, 120] };
      ground.push(
        new SolidPolygonLayer({
          id: `capacity-${rec.id}-${overlayState.capacityMode}`,
          ...common(),
          data: parcels,
          getPolygon: (d: { poly: Vec2[][] }) => d.poly as Position[][],
          getFillColor: (d: { id: string }) => {
            const c = caps.get(d.id)!;
            if (overlayState.capacityMode === "limit") return rgba(LIMIT[c.limitedBy] ?? [120, 120, 120], 170);
            return c.addedGfa < 50 ? [0, 0, 0, 0] : rgba(sample(VIRIDIS, norm(Math.sqrt(c.addedGfa), 0, Math.sqrt(60000))), 190);
          },
          pickable: true,
          parameters: { depthWriteEnabled: false, depthCompare: "always" },
        }),
      );
    }
  } else if (overlay === "growth") {
    const { rec } = shown("growth");
    if (rec) {
      const snap = growthSnapshot(rec.result);
      const added = new Map<string, number>();
      (rec.result.ids as string[]).forEach((id, k) => snap.added[k] > 0.5 && added.set(id, snap.added[k]));
      const parcels = R.world.all("parcel").filter((p) => added.has(p.id));
      ground.push(
        new SolidPolygonLayer({
          id: `growth-${rec.id}-${snap.year}`,
          ...common(),
          data: parcels,
          getPolygon: (d: { poly: Vec2[][] }) => d.poly as Position[][],
          getFillColor: (d: { id: string; area: number }) => rgba(sample(VIRIDIS, norm(Math.sqrt(added.get(d.id)! / (d.area / 10000)), 0, Math.sqrt(600))), 200),
          pickable: true,
          parameters: { depthWriteEnabled: false, depthCompare: "always" },
        }),
      );
    }
  } else if (overlay === "bike") {
    const { rec } = shown("bike");
    if (rec) {
      const lts = rec.result.streetLts as Record<string, number>;
      const data = R.world.all("street").filter((s) => lts[s.id]);
      ground.push(
        new PathLayer({
          id: `bike-${rec.id}`,
          ...common(),
          data,
          getPath: (s: Street) => s.path.map((p) => [p[0], p[1], 0.6] as [number, number, number]),
          getWidth: (s: Street) => (lts[s.id] <= 2 ? 5 : 3.5),
          widthUnits: "meters",
          widthMinPixels: 1.5,
          getColor: (s: Street) => rgba(sample(LOS, (lts[s.id] - 1) / 3), 235),
          parameters: { depthWriteEnabled: false, depthCompare: "always" },
        }),
      );
    }
  } else if (overlay === "transit") {
    const stops = R.world.all("stop");
    ground.push(
      new ScatterplotLayer({
        id: "transit-catch",
        ...common(),
        data: stops,
        getPosition: (d: { p: Vec2 }) => [d.p[0], d.p[1], 0.2],
        getRadius: 400,
        radiusUnits: "meters",
        getFillColor: [47, 111, 237, 14],
        parameters: { depthWriteEnabled: false, depthCompare: "always" },
      }),
    );
  } else if (overlay === "change") {
    const diff = R.scenarios.diff("baseline", R.scenarios.activeId);
    const removed = diff.removed.map((id) => diff.a.get(id)).filter((e) => e && e.kind === "building") as Extract<ReturnType<typeof R.world.get>, { kind: "building" }>[];
    top.push(
      new SolidPolygonLayer({
        id: `removed-${R.scenarios.active.cursor}`,
        ...common(),
        data: removed.flatMap((b) => b.masses.map((m) => ({ polygon: m.poly.map((r) => r.map((p) => [p[0], p[1], m.base])), h: m.top - m.base }))),
        getPolygon: (d: { polygon: Position[][] }) => d.polygon,
        getElevation: (d: { h: number }) => d.h,
        extruded: true,
        wireframe: true,
        getFillColor: [215, 70, 60, 50],
        getLineColor: [215, 70, 60, 200],
        parameters: { depthWriteEnabled: false },
      }),
    );
    const removedStreets = diff.removed.map((id) => diff.a.get(id)).filter((e) => e && e.kind === "street") as Extract<ReturnType<typeof R.world.get>, { kind: "street" }>[];
    ground.push(
      new PathLayer({
        id: `removed-streets-${R.scenarios.active.cursor}`,
        ...common(),
        data: removedStreets,
        getPath: (d: { path: Vec2[] }) => d.path as Position[],
        getColor: [215, 70, 60, 160],
        getWidth: 3,
        widthUnits: "meters",
        getDashArray: [3, 2],
        parameters: { depthWriteEnabled: false, depthCompare: "always" },
      }),
    );
  }
  return { ground, top };
}

/** overlays drawn as rasters, over which street edges are outlined */
export const RASTER_OVERLAYS: ReadonlySet<string> = new Set(["heat", "sun", "runoff", "flood"]);

/** outlines of the pedestrian realm (kerb lines, sidewalk edges) drawn over a raster overlay; `opacity` fades them out when zoomed out */
/** per chunk kerb outlines, kept while the chunk is unchanged so zooming only moves the opacity uniform */
const kerbCache = new WeakMap<object, { path: Position[]; f: number }[]>();

export function kerbLines(opacity = 1): Layer[] {
  const R = rtMaybe()!;
  const out: Layer[] = [];
  for (const c of R.scene.list()) {
    const b = R.meta.bounds;
    let data = kerbCache.get(c.kerbs);
    if (!data) {
      data = (c.kerbs as unknown as { polygon: Position[] }[])
        .map((d) => ({ path: [...d.polygon, d.polygon[0]].map((p) => [p[0], p[1], 0.3] as Position), f: studyFade(b, d.polygon[0][0], d.polygon[0][1]) }))
        .filter((d) => d.f > 0.02);
      kerbCache.set(c.kerbs, data);
    }
    if (!data.length) continue;
    out.push(
      new PathLayer<{ path: Position[]; f: number }>({
        id: `kerb-lines-${c.key}`,
        ...common(),
        data,
        getPath: (d) => d.path,
        getColor: (d) => [30, 40, 70, 150 * d.f],
        opacity,
        getWidth: 1,
        widthUnits: "pixels",
        parameters: { depthWriteEnabled: false, depthCompare: "always" },
      }),
    );
  }
  return out;
}

/** a pin per group of edits with the degrees it changed on their own ground (sim/impact) */
export function impactPins(): Layer[] {
  const imp = useImpact.getState().impact;
  if (!imp) return [];
  const data = imp.pins;
  if (!data.length) return [];
  // the pin reads in °F; under 0.1 °F of change it says no change
  const neutral = (d: ImpactPin) => Math.abs(dF(d.deltaC)) < 0.1;
  return [
    new TextLayer<ImpactPin>({
      id: "impact-pins",
      ...common(),
      data,
      getPosition: (d) => [d.at[0], d.at[1], 12],
      getText: (d) => (neutral(d) ? "0.0 °F" : fmtDF(d.deltaC)),
      getSize: 14,
      getColor: [255, 255, 255, 255],
      background: true,
      getBackgroundColor: (d) => (neutral(d) ? [90, 98, 120, 230] : d.deltaC < 0 ? [28, 112, 70, 240] : [196, 92, 20, 240]),
      backgroundPadding: [8, 4],
      getBorderColor: [255, 255, 255, 200],
      getBorderWidth: 1,
      fontFamily: "Geist, system-ui, sans-serif",
      fontWeight: 700,
      characterSet: "auto",
      parameters: { depthWriteEnabled: false, depthCompare: "always" },
    }),
  ];
}

let densityCache: { v: number; mode: string; layer: Layer } | null = null;
function densityLayer(): Layer {
  const R = rtMaybe()!;
  if (densityCache && densityCache.v === R.world.version && densityCache.mode === overlayState.densityMode) return densityCache.layer;
  const CELL = 100;
  const sums = new Map<string, number>();
  const hh = R.meta.calibration.householdSize;
  for (const b of R.world.all("building")) {
    const c = polyCentroid(b.footprint);
    const p = programmeOf(b, hh);
    const k = `${Math.floor(c[0] / CELL)},${Math.floor(c[1] / CELL)}`;
    sums.set(k, (sums.get(k) ?? 0) + (overlayState.densityMode === "residents" ? p.residents : p.jobs));
  }
  const data = [...sums].map(([k, v]) => {
    const [i, j] = k.split(",").map(Number);
    return { polygon: [[i * CELL, j * CELL], [(i + 1) * CELL, j * CELL], [(i + 1) * CELL, (j + 1) * CELL], [i * CELL, (j + 1) * CELL]] as Position[], perHa: v };
  });
  const max = overlayState.densityMode === "residents" ? 400 : 2500;
  const layer = new SolidPolygonLayer({
    id: `density-${R.world.version}-${overlayState.densityMode}`,
    ...common(),
    data,
    getPolygon: (d: { polygon: Position[] }) => d.polygon,
    getFillColor: (d: { perHa: number }) => rgba(sample(DENSITY, norm(Math.sqrt(d.perHa), 0, Math.sqrt(max))), d.perHa < 1 ? 0 : 175),
    pickable: true,
    parameters: { depthWriteEnabled: false, depthCompare: "always" },
  });
  densityCache = { v: R.world.version, mode: overlayState.densityMode, layer };
  return layer;
}

export { TextLayer };
