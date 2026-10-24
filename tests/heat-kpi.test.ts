import { describe, expect, it } from "vitest";
import { runHeat, KPI_TILE, type HeatParams } from "@/sim/heat";
import { areaKpi, bracket, tilesIn } from "@/sim/heatKpi";
import { LC, type Landcover } from "@/sim/landcover";

// a 240 m street-and-sidewalk square on the 4 m grid
const N = 60;
const grid = { x0: 0, y0: 0, cell: 4, nx: N, ny: N };
function city(trees: [number, number][] = []): Landcover {
  const n = N * N;
  const lc: Landcover = { grid, cls: new Uint8Array(n).fill(LC.PAVED), ground: new Uint8Array(n).fill(LC.PAVED), canopy: new Float32Array(n), height: new Float32Array(n) };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (j % 15 < 5) lc.cls[j * N + i] = lc.ground[j * N + i] = LC.ROAD;
  // each tree: a 3 × 3-cell crown (12 m) at 9 m over the pavement
  for (const [ci, cj] of trees)
    for (let j = cj - 1; j <= cj + 1; j++)
      for (let i = ci - 1; i <= ci + 1; i++) {
        const k = j * N + i;
        lc.cls[k] = LC.CANOPY;
        lc.canopy[k] = 1;
        lc.height[k] = 9;
      }
  return lc;
}
// a clear July day in Austin: 26 °C at dawn, 36 °C mid-afternoon, 950 W/m² at noon
const weather = {
  t: Array.from({ length: 24 }, (_, h) => 31 - 5 * Math.cos(((h - 3) / 24) * 2 * Math.PI)),
  sw: Array.from({ length: 24 }, (_, h) => Math.max(0, 950 * Math.sin(((h - 6.5) / 13) * Math.PI))),
};
const HOURS = [0, 2, 3, 4, 6, 8, 10, 12, 13, 14, 16, 18, 20, 22];
const params = (): HeatParams => ({ date: "2025-07-16", deltaT: 0, hours: HOURS, lat: 30.27, lon: -97.74, utcOffset: -5, masses: [], trees: [], ref: { imp: 1, can: 0 } });

describe("heat KPIs per hour and per area", () => {
  const bare = runHeat(city(), weather, params());
  const all = tilesIn(bare.tiles, grid, null);

  it("tiles cover the grid", () => {
    expect(bare.tiles.tx).toBe(Math.ceil(N / KPI_TILE));
    expect(all.length).toBe(bare.tiles.tx * bare.tiles.ty);
    expect(areaKpi(bare, all, 13).cells).toBe(N * N);
  });

  it("night is cooler than the day, and nothing is in sun at night", () => {
    const night = areaKpi(bare, all, 3),
      noon = areaKpi(bare, all, 13);
    expect(noon.surface! - night.surface!).toBeGreaterThan(10);
    expect(noon.feels!).toBeGreaterThan(night.feels! + 5);
    // night pavement still holds afternoon heat: warmer than the air, but by far less than at noon
    expect(night.surface!).toBeGreaterThan(weather.t[3]);
    expect(noon.shaded!).toBeLessThan(0.05);
    expect(night.shaded).toBeNull();
  });

  it("interpolates between modelled hours", () => {
    const a = areaKpi(bare, all, 12),
      b = areaKpi(bare, all, 13),
      m = areaKpi(bare, all, 12.5);
    expect(m.surface!).toBeCloseTo((a.surface! + b.surface!) / 2, 5);
    expect(bracket([0, 2, 22], 23)).toEqual({ i0: 2, i1: 0, t: 0.5 });
  });

  it("trees in view raise canopy and shaded paths and lower temperatures there", () => {
    const trees: [number, number][] = [];
    for (let i = 8; i < 30; i += 4) trees.push([i, 8], [i, 20]);
    const planted = runHeat(city(trees), weather, params());
    // the view: the quarter of the square with the trees
    const scope = { poly: [[0, 0], [130, 0], [130, 130], [0, 130]] as [number, number][] };
    const sel = tilesIn(planted.tiles, grid, scope);
    expect(sel.length).toBeGreaterThan(0);
    expect(sel.length).toBeLessThan(all.length);
    const before = areaKpi(bare, sel, 15),
      after = areaKpi(planted, sel, 15);
    expect(after.canopy).toBeGreaterThan(before.canopy + 0.05);
    expect(after.shaded!).toBeGreaterThan(before.shaded! + 0.05);
    expect(after.surface!).toBeLessThan(before.surface! - 0.5);
    expect(after.feels!).toBeLessThan(before.feels!);
    // a view elsewhere is unaffected by canopy it can't see
    const far = tilesIn(planted.tiles, grid, { center: [220, 220], radius: 20 });
    expect(areaKpi(planted, far, 15).canopy).toBe(0);
  });

  it("a radius caps the scope", () => {
    const near = tilesIn(bare.tiles, grid, { poly: [[0, 0], [1e5, 0], [1e5, 1e5], [0, 1e5]], center: [120, 120], radius: 50 });
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThan(16);
  });
});

describe("incremental heat re-run after an edit", () => {
  const M = 200;
  const big = { x0: 0, y0: 0, cell: 4, nx: M, ny: M };
  function bigCity(trees: [number, number][], tower?: [number, number]): Landcover {
    const n = M * M;
    const lc: Landcover = { grid: big, cls: new Uint8Array(n).fill(LC.PAVED), ground: new Uint8Array(n).fill(LC.PAVED), canopy: new Float32Array(n), height: new Float32Array(n) };
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) if (j % 25 < 5) lc.cls[j * M + i] = lc.ground[j * M + i] = LC.ROAD;
    // a 40 m block elsewhere, whose long shadows reach across the window
    for (let j = 150; j < 160; j++) for (let i = 20; i < 30; i++) (lc.cls[j * M + i] = lc.ground[j * M + i] = LC.ROOF), (lc.height[j * M + i] = 40);
    for (const [ci, cj] of trees)
      for (let j = cj - 1; j <= cj + 1; j++)
        for (let i = ci - 1; i <= ci + 1; i++) {
          const k = j * M + i;
          lc.cls[k] = LC.CANOPY;
          lc.canopy[k] = 1;
          lc.height[k] = 9;
        }
    if (tower) for (let j = tower[1]; j < tower[1] + 4; j++) for (let i = tower[0]; i < tower[0] + 4; i++) (lc.cls[j * M + i] = lc.ground[j * M + i] = LC.ROOF), (lc.height[j * M + i] = 12);
    return lc;
  }
  const P = (): HeatParams => ({ ...params(), hours: [0, 4, 7, 10, 13, 16, 19, 22] });
  const a = bigCity([[100, 100]]);
  const ra = runHeat(a, weather, P());

  it.each([
    ["a planted tree", bigCity([[100, 100], [110, 104]])],
    ["a small building", bigCity([[100, 100]], [120, 90])],
    ["no change", bigCity([[100, 100]])],
  ])("%s: the windowed re-run equals a full run", (_, b) => {
    const full = runHeat(b, weather, P());
    const inc = runHeat(b, weather, P(), undefined, { lc: a, result: ra });
    for (let k = 0; k < full.hours.length; k++) {
      expect(inc.surface[k]).toEqual(full.surface[k]);
      expect(inc.exposure[k]).toEqual(full.exposure[k]);
      const d = inc.tiles.hourly[k].reduce((m, v, i) => Math.max(m, Math.abs(v - full.tiles.hourly[k][i])), 0);
      expect(d).toBeLessThan(1e-2);
    }
    expect(inc.kpi.meanSurface).toBeCloseTo(full.kpi.meanSurface, 4);
  });
});
