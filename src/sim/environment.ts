// Stormwater runoff (NRCS/SCS Curve Number) and connected "bathtub" flood
// inundation on the DEM.

import type { Landcover } from "./landcover";
import { IMPERVIOUS, LC, surfaceClasses } from "./landcover";
import type { GridSpec } from "./raster";
import { rasterizeRings } from "./raster";

/** NRCS TR-55 curve numbers, hydrologic soil group D (Austin Blackland clays / urban land) */
export const CURVE_NUMBER: Record<number, number> = {
  [LC.GRASS]: 80,
  [LC.ROOF]: 98,
  [LC.ROAD]: 98,
  [LC.PAVED]: 98,
  [LC.PARKING]: 98,
  [LC.WATER]: 100,
  [LC.CANOPY]: 77,
  [LC.PARK]: 80,
  [LC.BARE]: 91,
  [LC.POOL]: 100,
  [LC.GREENROOF]: 86,
  [LC.PERMEABLE]: 76,
  [LC.RAINGARDEN]: 70,
  [LC.WOOD]: 77,
};

/** NOAA Atlas 14 Vol. 11, 24-hour point depths near downtown Austin (approx., inches → mm) */
export const DESIGN_STORMS: Record<string, { mm: number; label: string }> = {
  "2yr": { mm: 104, label: "2-year 24-hour (≈4.1 in)" },
  "10yr": { mm: 168, label: "10-year 24-hour (≈6.6 in)" },
  "25yr": { mm: 208, label: "25-year 24-hour (≈8.2 in)" },
  "100yr": { mm: 279, label: "100-year 24-hour (≈11.0 in)" },
};

export function scsRunoff(Pmm: number, CN: number) {
  const P = Pmm / 25.4;
  const S = 1000 / CN - 10;
  const Ia = 0.2 * S;
  return P <= Ia ? 0 : ((P - Ia) ** 2 / (P + 0.8 * S)) * 25.4;
}

export interface RunoffResult {
  storm: string;
  rainfallMm: number;
  volumeM3: number;
  depthMm: number;
  storageM3: number;
  netVolumeM3: number;
  imperviousFraction: number;
  weightedCN: number;
  /** runoff depth (mm) per cell, quantised ×1 (0..255) */
  grid: Uint8Array;
  /** hydrologic surface class per cell (after any hypothetical growth), for area breakdowns */
  surface?: Uint8Array;
  blocks: { id: string; depthMm: number }[];
  assumptions: string[];
}

/**
 * Hypothetical land-cover change: grow impervious cover by `frac` of its current
 * extent, converting private pervious cells (grass / bare, never parks, woodland,
 * canopy or water) that border existing pavement first — the pattern of
 * incremental lot coverage, driveways and additions.
 */
export function growImpervious(surface: Uint8Array, g: Landcover["grid"], frac: number): { cls: Uint8Array; converted: number } {
  const n = g.nx * g.ny;
  const cls = surface.slice();
  let imp = 0;
  for (let i = 0; i < n; i++) if (IMPERVIOUS.has(cls[i])) imp++;
  let need = Math.round(imp * frac);
  const target = need;
  const eligible = (j: number) => cls[j] === LC.GRASS || cls[j] === LC.BARE;
  // distance (in cells) from existing pavement, by breadth-first search; then convert the
  // nearest rings first, spreading within a ring by a hash so growth is citywide, not one block
  const distTo = new Int32Array(n).fill(-1);
  let ring: number[] = [];
  for (let i = 0; i < n; i++) if (IMPERVIOUS.has(cls[i])) (distTo[i] = 0), ring.push(i);
  const N4 = [1, -1, g.nx, -g.nx];
  let d = 0;
  while (need > 0 && ring.length) {
    d++;
    const next: number[] = [];
    for (const i of ring) {
      const x = i % g.nx;
      for (const o of N4) {
        const j = i + o;
        if (j < 0 || j >= n || (o === 1 && x === g.nx - 1) || (o === -1 && x === 0) || distTo[j] >= 0 || !eligible(j)) continue;
        distTo[j] = d;
        next.push(j);
      }
    }
    if (next.length <= need) {
      for (const j of next) cls[j] = LC.PAVED;
      need -= next.length;
    } else {
      next.sort((a, b) => ((a * 2654435761) >>> 0) - ((b * 2654435761) >>> 0));
      for (let k = 0; k < need; k++) cls[next[k]] = LC.PAVED;
      need = 0;
    }
    ring = next;
  }
  return { cls, converted: target - need };
}

export function runRunoff(lc: Landcover, storm: keyof typeof DESIGN_STORMS, storage: { volumeM3: number; label: string }[], blocks?: { id: string; rings: number[][][] }[], opts: { imperviousIncrease?: number } = {}): RunoffResult {
  const g = lc.grid;
  const n = g.nx * g.ny;
  let surface = surfaceClasses(lc);
  let grown: ReturnType<typeof growImpervious> | null = null;
  if (opts.imperviousIncrease) {
    grown = growImpervious(surface, g, opts.imperviousIncrease);
    surface = grown.cls;
  }
  const P = DESIGN_STORMS[storm].mm;
  const cellA = g.cell * g.cell;
  const lut = new Float32Array(16);
  for (let c = 0; c < 16; c++) lut[c] = scsRunoff(P, CURVE_NUMBER[c] ?? 85);
  const grid = new Uint8Array(n);
  let vol = 0,
    cnSum = 0,
    imp = 0;
  for (let i = 0; i < n; i++) {
    const c = surface[i];
    const q = lut[c];
    grid[i] = Math.min(255, Math.round(q));
    vol += (q / 1000) * cellA;
    cnSum += CURVE_NUMBER[c] ?? 85;
    if (IMPERVIOUS.has(c)) imp++;
  }
  const st = storage.reduce((s, x) => s + x.volumeM3, 0);
  const out: RunoffResult["blocks"] = [];
  if (blocks)
    for (const b of blocks) {
      let s = 0,
        m = 0;
      rasterizeRings(g, b.rings as [number, number][][], (i) => {
        s += grid[i];
        m++;
      });
      if (m > 10) out.push({ id: b.id, depthMm: s / m });
    }
  return {
    storm: DESIGN_STORMS[storm].label,
    rainfallMm: P,
    volumeM3: vol,
    depthMm: (vol / (n * cellA)) * 1000,
    storageM3: st,
    netVolumeM3: Math.max(0, vol - st),
    imperviousFraction: imp / n,
    weightedCN: cnSum / n,
    grid,
    surface,
    blocks: out.sort((a, b) => b.depthMm - a.depthMm).slice(0, 25),
    assumptions: [
      "NRCS TR-55 curve-number method, Ia = 0.2S, hydrologic soil group D (urban clay soils); curve numbers follow the ground surface — tree canopy over pavement does not make it pervious",
      `Design rainfall ${DESIGN_STORMS[storm].label} from NOAA Atlas 14 (approximate point value)`,
      "Retention ponds and rain gardens subtract their storage volume (assumes they capture runoff routed to them)",
      "Volumes only — no hydrograph routing, pipe capacity or timing",
      ...(grown
        ? [`Hypothetical: impervious cover +${Math.round(opts.imperviousIncrease! * 100)}% of its current extent (${Math.round((grown.converted * g.cell * g.cell) / 1000) / 1000} km² of private grass/bare ground paved, growing outward from existing pavement; parks, woodland, canopy and water untouched) — a land-cover sensitivity test, not a geometry change`]
        : []),
    ],
  };
}

export interface FloodResult {
  wse: number;
  rise: number;
  floodedM2: number;
  depth: Uint8Array;
  buildings: { id: string; maxDepth: number }[];
  residents: number;
  assumptions: string[];
}

/** connected inundation: cells below the water surface elevation reachable from existing water */
export function runFlood(lc: Landcover, demDm: Uint16Array, grid: GridSpec, wse: number, normalPool: number, buildings: { id: string; rings: number[][][]; residents: number }[]): FloodResult {
  const n = grid.nx * grid.ny;
  const depth = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const q: number[] = [];
  for (let i = 0; i < n; i++) if (lc.ground[i] === LC.WATER) {
    seen[i] = 1;
    q.push(i);
  }
  const W = grid.nx;
  let head = 0;
  while (head < q.length) {
    const i = q[head++];
    const x = i % W,
      y = (i / W) | 0;
    const elev = demDm[i] / 10;
    if (elev < wse && lc.ground[i] !== LC.WATER) depth[i] = Math.min(255, Math.max(1, Math.round((wse - elev) * 20)));
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= grid.ny) continue;
      const j = ny * W + nx;
      if (seen[j]) continue;
      if (demDm[j] / 10 < wse) {
        seen[j] = 1;
        q.push(j);
      }
    }
  }
  let flooded = 0;
  for (let i = 0; i < n; i++) if (depth[i]) flooded++;
  const hit: FloodResult["buildings"] = [];
  let residents = 0;
  for (const b of buildings) {
    let md = 0;
    rasterizeRings(grid, b.rings as [number, number][][], (i) => {
      if (depth[i] > md) md = depth[i];
    });
    if (md > 0) {
      hit.push({ id: b.id, maxDepth: md / 20 });
      residents += b.residents;
    }
  }
  return {
    wse,
    rise: wse - normalPool,
    floodedM2: flooded * grid.cell * grid.cell,
    depth,
    buildings: hit.sort((a, b) => b.maxDepth - a.maxDepth),
    residents,
    assumptions: [
      "Static 'bathtub' inundation with hydraulic connectivity from Lady Bird Lake and mapped creeks",
      "Terrain: AWS Terrain Tiles z15 (USGS 3DEP-derived, ~5 m resampled) — vertical error of ±1 m or more; buildings not burned into the DEM",
      "No rainfall-runoff, flow dynamics, levees or drainage capacity — screening only; see FEMA floodplain for regulatory extents",
    ],
  };
}
