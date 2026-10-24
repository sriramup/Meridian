// Simplified urban heat model (hourly). Surface temperature = air temperature
// + absorbed shortwave × a class-specific heating coefficient, with sun/shade
// from building and tree shadow projection, a thermal-storage lag for
// impervious materials, and neighbourhood air-temperature adjustments for
// canopy, imperviousness and water. Surface temperature is the shown figure; a
// feels-like-on-foot index (air, ground radiant load and direct sun) backs the
// pedestrian KPIs and the agent's shade ranking. Uncalibrated against Landsat LST:
// use for relative comparison between scenarios and places.

import type { Landcover } from "./landcover";
import { IMPERVIOUS, LC } from "./landcover";
import { boxBlur, rasterizeRings } from "./raster";
import { sunAltAz } from "@/lib/sun";

// albedo, heating coefficient (K per absorbed W/m²), storage weight
const MAT: Record<number, [number, number, number]> = {
  [LC.GRASS]: [0.24, 0.014, 0.35],
  [LC.ROOF]: [0.22, 0.034, 0.55],
  [LC.ROAD]: [0.08, 0.032, 0.8],
  [LC.PAVED]: [0.3, 0.027, 0.75],
  [LC.PARKING]: [0.1, 0.031, 0.8],
  [LC.WATER]: [0.06, 0.004, 0.9],
  [LC.CANOPY]: [0.18, 0.008, 0.2],
  [LC.PARK]: [0.24, 0.012, 0.3],
  [LC.BARE]: [0.2, 0.026, 0.5],
  [LC.POOL]: [0.08, 0.003, 0.9],
  [LC.GREENROOF]: [0.25, 0.012, 0.35],
  [LC.PERMEABLE]: [0.32, 0.022, 0.6],
  [LC.RAINGARDEN]: [0.22, 0.011, 0.3],
  [LC.WOOD]: [0.16, 0.007, 0.2],
};

export interface Weather {
  t: number[];
  sw: number[];
}

export interface HeatParams {
  date: string;
  /** offset added to air temperature (°C), e.g. +4 for a hotter day */
  deltaT: number;
  hours: number[];
  lat: number;
  lon: number;
  /** UTC offset hours for the local time zone on the date */
  utcOffset: number;
  masses: { rings: number[][][]; base: number; top: number }[];
  trees: { p: [number, number]; r: number; h: number }[];
  blocks?: { id: string; rings: number[][][] }[];
  /**
   * area-mean neighbourhood imperviousness / canopy the air adjustment is measured against. Pass the
   * baseline's (heatReference) so every scenario shares one reference: measured against its own means,
   * new canopy would raise the mean and warm everywhere else, cancelling its area-wide cooling.
   */
  ref?: HeatReference;
}

export interface HeatReference {
  imp: number;
  can: number;
}

export interface HeatResult {
  hours: number[];
  /** pedestrian exposure index per hour, quantised: value = (E - 15) * 4 (0..255 → 15..78.75 °C), 0 = n/a */
  exposure: Uint8Array[];
  /** surface temperature per hour, quantised the same way */
  surface: Uint8Array[];
  /** not retained (kept for the result's shape) */
  shade: Uint8Array[];
  airTemp: number[];
  /** sun altitude (rad) at the middle of each modelled hour */
  sunAlt: number[];
  /** per-tile sums for area KPIs at any hour (sim/heatKpi) */
  tiles: HeatTiles;
  /** share of the grid computed (1 = full run; less when an edit re-ran only its window) */
  computedShare: number;
  /** whole-area figures at the hour of highest mean surface temperature */
  kpi: {
    peakHour: number;
    meanSurface: number;
    meanExposure: number;
    pedHotShare: number;
    canopy: number;
    impervious: number;
    shadedPedShare: number;
    meanSurfaceByHour: number[];
    meanExposureByHour: number[];
  };
  hottestBlocks: { id: string; exposure: number; surface: number; canopy: number; impervious: number }[];
  assumptions: string[];
}

export const qT = (v: number) => Math.max(1, Math.min(255, Math.round((v - 15) * 4)));
export const dqT = (q: number) => q / 4 + 15;

export function sunAt(date: string, hour: number, lat: number, lon: number, utcOffset: number) {
  const [y, m, d] = date.split("-").map(Number);
  const ts = Date.UTC(y, m - 1, d, 0, 0) + (hour - utcOffset) * 3600_000;
  return sunAltAz(new Date(ts), lat, lon);
}

/**
 * Shade mask for a sun position by shadow propagation over the height raster
 * (building masses + tree crowns + measured canopy): sweeping away from the sun,
 * each cell's shadow height is max(own height, upwind shadow height − step·tan(alt)).
 * O(cells) per sun position; handles courtyards, concave plans and canopy exactly
 * at raster resolution. A cell is shaded when the shadow height clears its own
 * surface by 0.3 m.
 */
export function shadeMask(lc: Landcover, _masses: HeatParams["masses"], _trees: HeatParams["trees"], alt: number, az: number): Uint8Array {
  const g = lc.grid;
  const { nx, ny } = g;
  const n = nx * ny;
  const out = new Uint8Array(n);
  // below ~3.5° the direct beam is negligible: treat as diffuse-only
  if (alt <= SUN_MIN_ALT) {
    out.fill(1);
    return out;
  }
  const H = lc.height;
  const S = new Float32Array(n);
  const tanA = Math.tan(alt);
  const dx = Math.sin(az),
    dy = Math.cos(az); // shadow direction (away from the sun; SunCalc azimuth from south, +west)
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx > 0 ? 1 : -1;
    const u = dy / Math.abs(dx); // rows advanced per column step, |u| ≤ 1
    const drop = g.cell * Math.hypot(1, u) * tanA;
    for (let k = 0; k < nx; k++) {
      const x = sx > 0 ? k : nx - 1 - k;
      const px = x - sx;
      const hasPrev = px >= 0 && px < nx;
      for (let j = 0; j < ny; j++) {
        const i = j * nx + x;
        let v = H[i];
        if (hasPrev) {
          const py = j - u;
          const j0 = Math.floor(py),
            f = py - j0;
          const a = j0 >= 0 && j0 < ny ? S[j0 * nx + px] : 0;
          const b = j0 + 1 >= 0 && j0 + 1 < ny ? S[(j0 + 1) * nx + px] : 0;
          const pv = a + (b - a) * f - drop;
          if (pv > v) v = pv;
        }
        S[i] = v;
      }
    }
  } else {
    const sy = dy > 0 ? 1 : -1;
    const u = dx / Math.abs(dy); // columns advanced per row step
    const drop = g.cell * Math.hypot(1, u) * tanA;
    for (let k = 0; k < ny; k++) {
      const y = sy > 0 ? k : ny - 1 - k;
      const py = y - sy;
      const hasPrev = py >= 0 && py < ny;
      const row = y * nx,
        prow = py * nx;
      for (let x = 0; x < nx; x++) {
        const i = row + x;
        let v = H[i];
        if (hasPrev) {
          const qx = x - u;
          const x0 = Math.floor(qx),
            f = qx - x0;
          const a = x0 >= 0 && x0 < nx ? S[prow + x0] : 0;
          const b = x0 + 1 >= 0 && x0 + 1 < nx ? S[prow + x0 + 1] : 0;
          const pv = a + (b - a) * f - drop;
          if (pv > v) v = pv;
        }
        S[i] = v;
      }
    }
  }
  for (let i = 0; i < n; i++) if (S[i] > H[i] + 0.3) out[i] = 1;
  return out;
}

function meanOf(impL: Float32Array, canL: Float32Array): HeatReference {
  let imp = 0,
    can = 0;
  for (let i = 0; i < impL.length; i++) {
    imp += impL[i];
    can += canL[i];
  }
  return { imp: imp / impL.length, can: can / impL.length };
}

/** the neighbourhood means runHeat adjusts air temperature against, for a reference (baseline) land cover */
export function heatReference(lc: Landcover): HeatReference {
  const g = lc.grid;
  const n = g.nx * g.ny;
  const imp = new Float32Array(n);
  for (let i = 0; i < n; i++) imp[i] = IMPERVIOUS.has(lc.ground[i]) ? 1 : 0;
  return meanOf(boxBlur(imp, g.nx, g.ny, 12), boxBlur(lc.canopy, g.nx, g.ny, 7));
}

/** KPI tile edge in cells (32 m on the 4 m grid): area KPIs sum whole tiles, so any view aggregates in microseconds */
export const KPI_TILE = 8;

/**
 * Per-tile sums the area KPIs are built from (sim/heatKpi). Static sums per tile, and per modelled
 * hour three interleaved sums per tile. A "path" cell is walkable hard ground (sidewalk, plaza,
 * carriageway) that is not under a roof.
 */
export interface HeatTiles {
  size: number;
  tx: number;
  ty: number;
  /** grid cells per tile */
  cells: Float32Array;
  /** path cells per tile */
  paths: Float32Array;
  /** canopy cover summed over the tile's cells */
  canopy: Float32Array;
  /** per modelled hour, per tile: [Σ surface °C, Σ feels-like °C over path cells, shaded path cells, cells with surface above HOT_SURFACE_C] (TILE_STRIDE values) */
  hourly: Float32Array[];
}

/** values per tile in HeatTiles.hourly */
export const TILE_STRIDE = 4;
/** surface temperature counted as hot ground: 40 °C = 104 °F */
export const HOT_SURFACE_C = 40;

/** sun below this altitude (rad, ≈ 3.5°) is treated as diffuse-only: no direct beam, nothing is "in sun" */
export const SUN_MIN_ALT = 0.06;

/**
 * A previous run of the same day and parameters on an earlier version of the land cover. runHeat
 * then recomputes only the window the edit can reach (sim/heat dirtyWindow) and copies the rest:
 * every cell's temperature depends only on its own cover, its neighbourhood (≤ 12 cells, the air
 * adjustment blur) and the shadows cast on it, so cells beyond the edit's blur radius and shadow
 * reach are unchanged. The previous result's rasters must be the caller's own copies (they are
 * reused, not modified).
 */
export interface HeatPrev {
  lc: Landcover;
  result: Pick<HeatResult, "hours" | "surface" | "exposure" | "tiles">;
}

/** cell rectangle [i0, i1) × [j0, j1) */
export interface CellWindow {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

/**
 * The cells an edit (land cover a → b) can change, aligned to KPI tiles; null when nothing changed.
 * Margin = the air-adjustment blur radius, or the longest shadow the changed heights can cast at
 * the lowest sun that still casts one (`minAlt`), whichever is larger.
 */
export function dirtyWindow(a: Landcover, b: Landcover, minAlt: number): CellWindow | null {
  const { nx, ny, cell } = b.grid;
  let i0 = nx,
    j0 = ny,
    i1 = -1,
    j1 = -1,
    hMax = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (a.cls[c] === b.cls[c] && a.ground[c] === b.ground[c] && a.canopy[c] === b.canopy[c] && a.height[c] === b.height[c]) continue;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
      // only a change of height casts a different shadow; other changes act on the cell and its blur radius
      if (a.height[c] !== b.height[c]) hMax = Math.max(hMax, a.height[c], b.height[c]);
    }
  if (i1 < 0) return null;
  const m = Math.ceil(Math.max(12, hMax / Math.tan(Math.max(minAlt, SUN_MIN_ALT)) / cell)) + 1;
  const T = KPI_TILE;
  return {
    i0: Math.max(0, Math.floor((i0 - m) / T) * T),
    j0: Math.max(0, Math.floor((j0 - m) / T) * T),
    i1: Math.min(nx, Math.ceil((i1 + 1 + m) / T) * T),
    j1: Math.min(ny, Math.ceil((j1 + 1 + m) / T) * T),
  };
}

/** shade over window w only: the shadow sweep runs on w grown by the longest shadow anything can cast at this sun */
function shadeIn(lc: Landcover, w: CellWindow, alt: number, az: number, hGlobal: number): Uint8Array | null {
  const { nx, ny, cell } = lc.grid;
  if (alt <= SUN_MIN_ALT) return null; // all diffuse: shaded everywhere
  const r = Math.ceil(hGlobal / Math.tan(alt) / cell) + 1;
  const c = { i0: Math.max(0, w.i0 - r), j0: Math.max(0, w.j0 - r), i1: Math.min(nx, w.i1 + r), j1: Math.min(ny, w.j1 + r) };
  if ((c.i1 - c.i0) * (c.j1 - c.j0) > 0.6 * nx * ny) return shadeMask(lc, [], [], alt, az);
  const sx = c.i1 - c.i0,
    sy = c.j1 - c.j0;
  const height = new Float32Array(sx * sy);
  for (let j = 0; j < sy; j++) height.set(lc.height.subarray((c.j0 + j) * nx + c.i0, (c.j0 + j) * nx + c.i1), j * sx);
  const sub = shadeMask({ grid: { x0: 0, y0: 0, cell, nx: sx, ny: sy }, height } as Landcover, [], [], alt, az);
  // back onto the full grid (only w is read)
  const out = new Uint8Array(nx * ny);
  for (let j = w.j0; j < w.j1; j++) out.set(sub.subarray((j - c.j0) * sx + (w.i0 - c.i0), (j - c.j0) * sx + (w.i1 - c.i0)), j * nx + w.i0);
  return out;
}

export function runHeat(lc: Landcover, weather: Weather, p: HeatParams, onProgress?: (f: number) => void, prev?: HeatPrev | null): HeatResult {
  const g = lc.grid;
  const { nx, ny } = g;
  const n = nx * ny;
  // neighbourhood fractions
  const imp = new Float32Array(n),
    wat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    imp[i] = IMPERVIOUS.has(lc.ground[i]) ? 1 : 0;
    wat[i] = lc.ground[i] === LC.WATER ? 1 : 0;
  }
  const impL = boxBlur(imp, nx, ny, 12);
  const canL = boxBlur(lc.canopy, nx, ny, 7);
  const watL = boxBlur(wat, nx, ny, 12);
  const { imp: impMean, can: canMean } = p.ref ?? meanOf(impL, canL);
  const airAdj = new Float32Array(n);
  for (let i = 0; i < n; i++) airAdj[i] = 1.2 * (impL[i] - impMean) - 1.6 * (canL[i] - canMean) - 0.8 * watL[i];

  // per-cell material constants, looked up once instead of every hour
  const topK = new Float32Array(n), // (1 − albedo) × heating coefficient of the top surface
    topSt = new Float32Array(n), // its storage weight
    gK = new Float32Array(n),
    gSt = new Float32Array(n);
  // 1 = pedestrian ground (has a feels-like value), 2 = path cell, 4 = under tree canopy
  const flag = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const top = lc.cls[i],
      ground = lc.ground[i];
    const [a, k, st] = MAT[top] ?? MAT[LC.GRASS];
    const [ga, gk, gst] = MAT[ground] ?? MAT[LC.GRASS];
    topK[i] = (1 - a) * k;
    topSt[i] = st;
    gK[i] = (1 - ga) * gk;
    gSt[i] = gst;
    const ped = top !== LC.ROOF && top !== LC.GREENROOF && ground !== LC.WATER && ground !== LC.POOL;
    flag[i] = (ped ? 1 : 0) | (ped && (ground === LC.PAVED || ground === LC.ROAD) ? 2 : 0) | (top === LC.CANOPY ? 4 : 0);
  }

  // KPI tiles
  const T = KPI_TILE;
  const tx = Math.ceil(nx / T),
    ty = Math.ceil(ny / T);
  const nt = tx * ty;
  const tCells = new Float32Array(nt),
    tPaths = new Float32Array(nt),
    tCanopy = new Float32Array(nt);
  for (let j = 0; j < ny; j++) {
    const trow = ((j / T) | 0) * tx;
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i,
        t = trow + ((i / T) | 0);
      tCells[t]++;
      tCanopy[t] += lc.canopy[c];
      if (flag[c] & 2) tPaths[t]++;
    }
  }

  const storage = new Float32Array(n);
  // the ground under a canopy stores the heat of its own (shaded) surface, not the crown's
  const gStorage = new Float32Array(n);
  const hours = p.hours.slice().sort((a, b) => a - b);
  const slot = new Map(hours.map((h, k) => [h, k]));
  const exposure: Uint8Array[] = new Array(hours.length);
  const surface: Uint8Array[] = new Array(hours.length);
  const hourly: Float32Array[] = new Array(hours.length);
  const airTemp: number[] = new Array(hours.length);
  const sunAlt: number[] = new Array(hours.length);
  // a day runs from 6:00 (storage spun up from sunrise) through the evening and the following night,
  // so night-time pavement still carries the afternoon's stored heat; hours before 6:00 are that night
  const start = 6;
  const wrap = hours.some((h) => h < start);
  const last = wrap ? Math.max(...hours.filter((h) => h < start)) + 24 : hours[hours.length - 1];
  const suns: { alt: number; az: number }[] = [];
  for (let hh = start; hh <= last; hh++) suns.push(sunAt(p.date, (hh % 24) + 0.5, p.lat, p.lon, p.utcOffset));

  // incremental: only the window the edit can reach, the rest copied from the previous run
  let win: CellWindow = { i0: 0, j0: 0, i1: nx, j1: ny };
  let partial = false;
  if (prev && p.ref && prev.lc.grid.nx === nx && prev.lc.grid.ny === ny && prev.result.hours.join() === hours.join() && prev.result.tiles?.size === T) {
    const lowest = Math.min(...suns.map((s) => (s.alt > SUN_MIN_ALT ? s.alt : Infinity)));
    const w = dirtyWindow(prev.lc, lc, lowest);
    if (!w) win = { i0: 0, j0: 0, i1: 0, j1: 0 };
    if (!w || (w.i1 - w.i0) * (w.j1 - w.j0) < 0.4 * n) {
      partial = true;
      if (w) win = w;
    }
  }
  let hGlobal = 0;
  if (partial) for (let i = 0; i < n; i++) if (lc.height[i] > hGlobal) hGlobal = lc.height[i];
  const inWin = (t: number) => {
    const ti = (t % tx) * T,
      tj = Math.floor(t / tx) * T;
    return ti >= win.i0 && ti < win.i1 && tj >= win.j0 && tj < win.j1;
  };
  const shadeAll = new Uint8Array(0);
  for (let hh = start; hh <= last; hh++) {
    const h = hh % 24;
    const Tair = (weather.t[h] ?? weather.t[weather.t.length - 1]) + p.deltaT;
    const S = Math.max(0, weather.sw[h] ?? 0);
    const sun = suns[hh - start];
    // null = the whole window is shaded (sun down)
    const sh = win.i1 <= win.i0 ? shadeAll : partial ? shadeIn(lc, win, sun.alt, sun.az, hGlobal) : sun.alt <= SUN_MIN_ALT ? null : shadeMask(lc, p.masses, p.trees, sun.alt, sun.az);
    const k = slot.get(h);
    const want = k !== undefined;
    let ex: Uint8Array | null = null,
      sf: Uint8Array | null = null,
      th: Float32Array | null = null;
    if (want) {
      if (partial) {
        const pk = k!;
        ex = prev!.result.exposure[pk].slice();
        sf = prev!.result.surface[pk].slice();
        th = prev!.result.tiles.hourly[pk].slice();
        for (let t = 0; t < nt; t++) if (inWin(t)) th.fill(0, t * TILE_STRIDE, t * TILE_STRIDE + TILE_STRIDE);
      } else {
        ex = new Uint8Array(n);
        sf = new Uint8Array(n);
        th = new Float32Array(nt * TILE_STRIDE);
      }
    }
    const Sd = 0.18 * S; // diffuse share reaching shaded ground
    for (let j = win.j0; j < win.j1; j++) {
      const trow = ((j / T) | 0) * tx;
      for (let x = win.i0; x < win.i1; x++) {
        const i = j * nx + x;
        const lit = S > 0 && sh !== null && !sh[i];
        const dS = topK[i] * (lit ? S : Sd);
        const st = topSt[i];
        const sto = storage[i] * st + dS * (1 - st);
        storage[i] = sto;
        const Tl = Tair + airAdj[i];
        const fl = flag[i];
        let E = 0;
        if (fl & 1) {
          // pedestrian ground: under canopy the ground is shaded
          const groundLit = lit && !(fl & 4);
          const gS = gK[i] * (groundLit ? S : Sd);
          const gst = gSt[i];
          const gsto = gStorage[i] * gst + gS * (1 - gst);
          gStorage[i] = gsto;
          if (want) {
            const Tg = Tl + Math.max(gS, gsto * 0.6);
            E = Tl + 0.35 * (Tg - Tl) + (groundLit ? 0.0055 * S : 0);
            const q = Math.round((E - 15) * 4);
            ex![i] = q < 1 ? 1 : q > 255 ? 255 : q;
            if (fl & 2) {
              const t3 = (trow + ((x / T) | 0)) * TILE_STRIDE;
              th![t3 + 1] += E;
              if (!groundLit) th![t3 + 2]++;
            }
          }
        } else if (want) ex![i] = 0; // (a reused raster may hold an old value here)
        if (want) {
          const Ts = Tl + (dS > sto ? dS : sto);
          const q = Math.round((Ts - 15) * 4);
          sf![i] = q < 1 ? 1 : q > 255 ? 255 : q;
          const t4 = (trow + ((x / T) | 0)) * TILE_STRIDE;
          th![t4] += Ts;
          if (Ts > HOT_SURFACE_C) th![t4 + 3]++;
        }
      }
    }
    if (want) {
      exposure[k] = ex!;
      surface[k] = sf!;
      hourly[k] = th!;
      airTemp[k] = Tair;
      sunAlt[k] = sun.alt;
    }
    onProgress?.((hh - start + 1) / (last - start + 1));
  }
  const tiles: HeatTiles = { size: T, tx, ty, cells: tCells, paths: tPaths, canopy: tCanopy, hourly };

  // whole-area figures per hour (sums of all tiles); the summary KPIs are those of the hottest hour
  let canopy = 0,
    impv = 0,
    paths = 0;
  for (let t = 0; t < nt; t++) {
    canopy += tCanopy[t];
    paths += tPaths[t];
  }
  for (let i = 0; i < n; i++) impv += imp[i];
  let pi = 0,
    peakS = -Infinity;
  const meanSurfaceH: number[] = [],
    meanExposureH: number[] = [],
    shadedH: number[] = [];
  hours.forEach((_, k) => {
    let s = 0,
      e = 0,
      sd = 0;
    const th = hourly[k];
    for (let t = 0; t < nt; t++) {
      s += th[t * TILE_STRIDE];
      e += th[t * TILE_STRIDE + 1];
      sd += th[t * TILE_STRIDE + 2];
    }
    meanSurfaceH.push(s / n);
    meanExposureH.push(paths ? e / paths : 0);
    shadedH.push(paths ? sd / paths : 0);
    if (s > peakS) {
      peakS = s;
      pi = k;
    }
  });
  let hot = 0;
  {
    const ex = exposure[pi];
    for (let i = 0; i < n; i++) if (flag[i] & 2 && dqT(ex[i]) > 40) hot++;
  }
  // hottest blocks at the peak hour
  const hottest: HeatResult["hottestBlocks"] = [];
  if (p.blocks && hours.length) {
    const ex = exposure[pi],
      sf = surface[pi];
    for (const b of p.blocks) {
      let se = 0,
        ss = 0,
        c = 0,
        cc = 0,
        ii = 0,
        m = 0;
      rasterizeRings(g, b.rings as [number, number][][], (i) => {
        m++;
        ss += dqT(sf[i]);
        cc += lc.canopy[i];
        ii += imp[i];
        if (ex[i]) {
          se += dqT(ex[i]);
          c++;
        }
      });
      if (c > 20) hottest.push({ id: b.id, exposure: se / c, surface: ss / m, canopy: cc / m, impervious: ii / m });
    }
    hottest.sort((a, b) => b.surface - a.surface);
  }
  return {
    hours,
    exposure,
    surface,
    shade: [],
    computedShare: ((win.i1 - win.i0) * Math.max(0, win.j1 - win.j0)) / n,
    airTemp,
    sunAlt,
    tiles,
    kpi: {
      peakHour: hours[pi],
      meanSurface: meanSurfaceH[pi],
      meanExposure: meanExposureH[pi],
      pedHotShare: paths ? hot / paths : 0,
      canopy: canopy / n,
      impervious: impv / n,
      shadedPedShare: shadedH[pi],
      meanSurfaceByHour: meanSurfaceH,
      meanExposureByHour: meanExposureH,
    },
    hottestBlocks: hottest.slice(0, 400),
    assumptions: HEAT_ASSUMPTIONS,
  };
}

const HEAT_ASSUMPTIONS = [
  "Air temperature & shortwave: typical hourly weather for the modelled day (multi-year normals, else ERA5 for the pack's reference day), plus the scenario offset",
  "Surface heating = (1−albedo) × shortwave × class coefficient; asphalt α=0.08, concrete 0.30, roof 0.22, lawn 0.24 (literature values); thermal storage carried hour to hour from 6:00 through the following night",
  "Shadows cast by sun position (SunCalc) over a 4 m height raster of building masses, modelled tree crowns (60% of height) and the City of Austin 2022 measured canopy (taken as 9 m); proposals clear canopy under new buildings, hard surfaces and rebuilt carriageways; sun below 3.5° is treated as diffuse-only",
  "Neighbourhood air adjustment: +2.2 °F per unit imperviousness (50 m), −2.9 °F per unit canopy (30 m), −1.4 °F near water, measured against the existing city's area means so new canopy cools without warming elsewhere",
  "Feels like on foot ≈ air + 0.35 × (ground − air) + 9.9 °F per kW/m² of direct sun — an MRT-style proxy, not UTCI (modelled in °C, shown in °F)",
  "Area KPIs: mean surface temperature of every cell in view; feels-like, shade share over walkable hard ground (sidewalks, plazas, carriageways) not under roofs; canopy share of all cells",
  "Not calibrated to Landsat land-surface temperature; use for relative comparison",
];

/** sunlit hours per cell for a date (step in hours) */
export function sunHours(lc: Landcover, masses: HeatParams["masses"], trees: HeatParams["trees"], date: string, lat: number, lon: number, utcOffset: number, step = 0.5): Float32Array {
  const g = lc.grid;
  const out = new Float32Array(g.nx * g.ny);
  for (let h = 5; h <= 21; h += step) {
    const s = sunAt(date, h, lat, lon, utcOffset);
    if (s.alt <= 0.03) continue;
    const sh = shadeMask(lc, masses, trees, s.alt, s.az);
    for (let i = 0; i < out.length; i++) if (!sh[i]) out[i] += step;
  }
  return out;
}
