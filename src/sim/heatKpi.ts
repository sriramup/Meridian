// Area KPIs of a heat run for any hour and any part of the map, from the per-tile sums the model
// writes (sim/heat HeatTiles). A view is a set of 32 m tiles; its KPIs are ratios of tile sums, so
// re-scoping (panning) or re-timing (scrubbing the clock) costs microseconds and never touches the
// rasters. Between modelled hours the figures are interpolated linearly, like the map's crossfade.

import type { HeatTiles } from "./heat";
import { SUN_MIN_ALT, TILE_STRIDE } from "./heat";
import type { GridSpec } from "./raster";

/** the two modelled hours around `h` (wrapping past midnight) and how far between them it is */
export function bracket(hours: number[], h: number): { i0: number; i1: number; t: number } {
  const n = hours.length;
  for (let k = 0; k < n; k++) {
    const next = k + 1 < n ? hours[k + 1] : hours[0] + 24;
    if (h >= hours[k] && h < next) return { i0: k, i1: (k + 1) % n, t: (h - hours[k]) / (next - hours[k]) };
  }
  const span = hours[0] + 24 - hours[n - 1];
  return { i0: n - 1, i1: 0, t: Math.max(0, Math.min(1, (h + 24 - hours[n - 1]) / span)) };
}

export interface AreaKpi {
  /** mean surface temperature of every cell in scope, °C */
  surface: number | null;
  /** air temperature at the hour (area-wide, °C); null when the run has none */
  air: number | null;
  /** mean feels-like temperature on walkable hard ground, °C */
  feels: number | null;
  /** canopy cover share of the scope, 0..1 */
  canopy: number;
  /** share of walkable hard ground out of direct sun, 0..1; null while the sun is down */
  shaded: number | null;
  /** share of the ground in scope whose surface is above 104 °F (40 °C), 0..1 */
  hot: number | null;
  /** grid cells in scope */
  cells: number;
}

/** a ground polygon (local metres) the KPIs are taken over, optionally capped to a radius around a centre */
export interface Scope {
  poly?: [number, number][];
  center?: [number, number];
  radius?: number;
}

function inside(x: number, y: number, r: [number, number][]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  }
  return c;
}

/** tiles whose centre lies in the scope (all tiles for an empty scope) */
export function tilesIn(tiles: Pick<HeatTiles, "size" | "tx" | "ty">, g: GridSpec, scope: Scope | null): Uint32Array {
  const out: number[] = [];
  const span = tiles.size * g.cell;
  const r2 = scope?.radius ? scope.radius * scope.radius : Infinity;
  for (let j = 0; j < tiles.ty; j++) {
    const y = g.y0 + (j + 0.5) * span;
    for (let i = 0; i < tiles.tx; i++) {
      const x = g.x0 + (i + 0.5) * span;
      if (scope?.center && (x - scope.center[0]) ** 2 + (y - scope.center[1]) ** 2 > r2) continue;
      if (scope?.poly && scope.poly.length >= 3 && !inside(x, y, scope.poly)) continue;
      out.push(j * tiles.tx + i);
    }
  }
  return Uint32Array.from(out);
}

/** KPIs over the selected tiles at hour `hour` (fractional, 0–24) */
export function areaKpi(r: { hours: number[]; sunAlt?: number[]; airTemp?: number[]; tiles: HeatTiles }, sel: Uint32Array, hour: number): AreaKpi {
  const T = r.tiles;
  let cells = 0,
    paths = 0,
    canopy = 0;
  for (const t of sel) {
    cells += T.cells[t];
    paths += T.paths[t];
    canopy += T.canopy[t];
  }
  const { i0, i1, t } = bracket(r.hours, hour);
  const at = (k: number) => {
    const h = T.hourly[k];
    let s = 0,
      e = 0,
      sd = 0,
      hot = 0;
    for (const x of sel) {
      const o = x * TILE_STRIDE;
      s += h[o];
      e += h[o + 1];
      sd += h[o + 2];
      hot += h[o + 3];
    }
    return { s, e, sd, hot };
  };
  const a = at(i0),
    b = i1 === i0 ? a : at(i1);
  const mix = (u: number, v: number) => u * (1 - t) + v * t;
  const sunUp = (k: number) => (r.sunAlt ? r.sunAlt[k] > SUN_MIN_ALT : true);
  // with the sun down at either end the shade share would blend toward a meaningless 100%
  const shadedAt = (k: number, v: { sd: number }) => (sunUp(k) ? v.sd / paths : null);
  const s0 = paths ? shadedAt(i0, a) : null,
    s1 = paths ? shadedAt(i1, b) : null;
  const shaded = s0 === null && s1 === null ? null : s0 === null ? (t > 0.5 ? s1 : null) : s1 === null ? (t < 0.5 ? s0 : null) : mix(s0, s1);
  return {
    surface: cells ? mix(a.s, b.s) / cells : null,
    air: r.airTemp && r.airTemp.length === r.hours.length ? mix(r.airTemp[i0], r.airTemp[i1]) : null,
    feels: paths ? mix(a.e, b.e) / paths : null,
    canopy: cells ? canopy / cells : 0,
    shaded,
    hot: cells ? mix(a.hot, b.hot) / cells : null,
    cells,
  };
}
