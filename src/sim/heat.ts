// Simplified urban heat model (hourly). Surface temperature = air temperature
// + absorbed shortwave × a class-specific heating coefficient, with sun/shade
// from building and tree shadow projection, a thermal-storage lag for
// impervious materials, and neighbourhood air-temperature adjustments for
// canopy, imperviousness and water. A pedestrian heat-exposure index combines
// air, ground radiant load and direct sun. Uncalibrated against Landsat LST:
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
  /** shade mask at each hour (1 = shaded) */
  shade: Uint8Array[];
  airTemp: number[];
  kpi: {
    peakHour: number;
    meanSurface: number;
    meanExposure: number;
    pedHotShare: number;
    canopy: number;
    impervious: number;
    shadedPedShare: number;
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
  if (alt <= 0.06) {
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

export function runHeat(lc: Landcover, weather: Weather, p: HeatParams, onProgress?: (f: number) => void): HeatResult {
  const g = lc.grid;
  const n = g.nx * g.ny;
  // neighbourhood fractions
  const imp = new Float32Array(n),
    can = new Float32Array(n),
    wat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    imp[i] = IMPERVIOUS.has(lc.ground[i]) ? 1 : 0;
    can[i] = lc.canopy[i];
    wat[i] = lc.ground[i] === LC.WATER ? 1 : 0;
  }
  const impL = boxBlur(imp, g.nx, g.ny, 12);
  const canL = boxBlur(can, g.nx, g.ny, 7);
  const watL = boxBlur(wat, g.nx, g.ny, 12);
  const { imp: impMean, can: canMean } = p.ref ?? meanOf(impL, canL);
  const airAdj = new Float32Array(n);
  for (let i = 0; i < n; i++) airAdj[i] = 1.2 * (impL[i] - impMean) - 1.6 * (canL[i] - canMean) - 0.8 * watL[i];

  const storage = new Float32Array(n);
  // the ground under a canopy stores the heat of its own (shaded) surface, not the crown's
  const gStorage = new Float32Array(n);
  const exposure: Uint8Array[] = [];
  const surface: Uint8Array[] = [];
  const shades: Uint8Array[] = [];
  const airTemp: number[] = [];
  // spin up storage from 6:00 with the earliest requested hour
  const hours = p.hours.slice().sort((a, b) => a - b);
  const start = Math.min(6, hours[0]);
  const last = hours[hours.length - 1];
  let peak = { hour: hours[0], mean: -Infinity };
  const kpiAcc = { meanSurface: 0, meanExposure: 0, hot: 0, shadedPed: 0 };
  let pedCount = 0;
  for (let i = 0; i < n; i++) if (lc.ground[i] === LC.PAVED || lc.ground[i] === LC.ROAD) pedCount++;
  for (let h = start; h <= last; h++) {
    const Tair = (weather.t[h] ?? weather.t[weather.t.length - 1]) + p.deltaT;
    const S = Math.max(0, weather.sw[h] ?? 0);
    const sun = sunAt(p.date, h + 0.5, p.lat, p.lon, p.utcOffset);
    const sh = shadeMask(lc, p.masses, p.trees, sun.alt, sun.az);
    const want = hours.includes(h);
    const ex = want ? new Uint8Array(n) : null;
    const sf = want ? new Uint8Array(n) : null;
    let sumS = 0,
      sumE = 0,
      cnt = 0,
      hot = 0,
      shadedPed = 0;
    for (let i = 0; i < n; i++) {
      const top = lc.cls[i];
      const ground = lc.ground[i];
      const [a, k, st] = MAT[top] ?? MAT[LC.GRASS];
      const lit = !sh[i] && S > 0;
      const dS = (1 - a) * S * k * (lit ? 1 : 0.18);
      storage[i] = storage[i] * st + dS * (1 - st);
      const dT = Math.max(dS, storage[i]);
      const Tl = Tair + airAdj[i];
      const Ts = Tl + dT;
      // pedestrian ground: under canopy the ground is shaded
      const [ga, gk, gst] = MAT[ground] ?? MAT[LC.GRASS];
      const groundLit = lit && top !== LC.CANOPY;
      const gS = (1 - ga) * S * gk * (groundLit ? 1 : 0.18);
      gStorage[i] = gStorage[i] * gst + gS * (1 - gst);
      const Tg = Tl + Math.max(gS, gStorage[i] * 0.6);
      const pedestrian = top !== LC.ROOF && top !== LC.GREENROOF && ground !== LC.WATER && ground !== LC.POOL;
      if (want) {
        sf![i] = qT(Ts);
        if (pedestrian) {
          const E = Tl + 0.35 * (Tg - Tl) + (groundLit ? 0.0055 * S : 0);
          ex![i] = qT(E);
          if (ground === LC.PAVED || ground === LC.ROAD) {
            sumE += E;
            cnt++;
            if (E > 40) hot++;
            if (!groundLit) shadedPed++;
          }
        }
        sumS += Ts;
      }
    }
    if (want) {
      exposure.push(ex!);
      surface.push(sf!);
      shades.push(sh);
      airTemp.push(Tair);
      const meanE = cnt ? sumE / cnt : 0;
      if (meanE > peak.mean) {
        peak = { hour: h, mean: meanE };
        kpiAcc.meanSurface = sumS / n;
        kpiAcc.meanExposure = meanE;
        kpiAcc.hot = cnt ? hot / cnt : 0;
        kpiAcc.shadedPed = pedCount ? shadedPed / pedCount : 0;
      }
    }
    onProgress?.((h - start + 1) / (last - start + 1));
  }
  // cover stats
  let canopy = 0,
    impv = 0;
  for (let i = 0; i < n; i++) {
    canopy += lc.canopy[i];
    impv += imp[i];
  }
  // hottest blocks at the peak hour
  const hottest: HeatResult["hottestBlocks"] = [];
  const pi = hours.indexOf(peak.hour);
  if (p.blocks && pi >= 0) {
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
    hottest.sort((a, b) => b.exposure - a.exposure);
  }
  return {
    hours,
    exposure,
    surface,
    shade: shades,
    airTemp,
    kpi: { peakHour: peak.hour, meanSurface: kpiAcc.meanSurface, meanExposure: kpiAcc.meanExposure, pedHotShare: kpiAcc.hot, canopy: canopy / n, impervious: impv / n, shadedPedShare: kpiAcc.shadedPed },
    hottestBlocks: hottest.slice(0, 400),
    assumptions: [
      "Air temperature & shortwave: ERA5 reanalysis for the reference day (Open-Meteo), plus the scenario offset",
      "Surface heating = (1−albedo) × shortwave × class coefficient; asphalt α=0.08, concrete 0.30, roof 0.22, lawn 0.24 (literature values)",
      "Shadows cast by sun position (SunCalc) over a 4 m height raster of building masses, modelled tree crowns (60% of height) and the City of Austin 2022 measured canopy (taken as 9 m); proposals clear canopy under new buildings, hard surfaces and rebuilt carriageways; sun below 3.5° is treated as diffuse-only",
      "Neighbourhood air adjustment: +1.2 °C per unit imperviousness (50 m), −1.6 °C per unit canopy (30 m), −0.8 °C near water, measured against the existing city's area means so new canopy cools without warming elsewhere",
      "Pedestrian exposure index ≈ air + 0.35 × (ground − air) + 5.5 °C per kW/m² of direct sun — an MRT-style proxy, not UTCI",
      "Not calibrated to Landsat land-surface temperature; use for relative comparison",
    ],
  };
}

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
