// Land cover for the surrounding ("context") city, so the heat / shade / runoff maps continue past
// the study area and fade out with the buildings. Measured tree canopy (City of Austin 2022) and
// minor paving (Impervious Cover 2023: parking, driveways, sidewalks…) come from context_cover.bin
// when the pack has it; buildings and heights, roads (asphalt at typical widths by class), parks,
// woods and water come from the mapped context city. Coarser (8 m) than the study area's 4 m.

import type { Landcover } from "./landcover";
import { LC } from "./landcover";
import { rasterizeRings, type GridSpec } from "./raster";

export interface ContextInput {
  buildings: { polygon: [number, number][]; height: number }[];
  roads: { path: [number, number][]; cls: string }[];
  areas: { polygon: [number, number][]; type: string }[];
}

const ROAD_WIDTH: Record<string, number> = { motorway: 22, motorway_link: 9, trunk: 16, primary: 16, secondary: 13, tertiary: 11, residential: 9, living: 6, pedestrian: 6, busway: 7 };
const AREA_CLS: Record<string, number> = { park: LC.PARK, grass: LC.GRASS, pitch: LC.PARK, cemetery: LC.PARK, wood: LC.WOOD, water: LC.WATER, parking: LC.PARKING, plaza: LC.PAVED };

/** grid covering the study bounds plus `pad` metres on every side */
export function contextGrid(bounds: readonly number[], pad = 1900, cell = 8): GridSpec {
  const x0 = Math.floor((bounds[0] - pad) / cell) * cell,
    y0 = Math.floor((bounds[1] - pad) / cell) * cell;
  return { x0, y0, cell, nx: Math.ceil((bounds[2] + pad - x0) / cell), ny: Math.ceil((bounds[3] + pad - y0) / cell) };
}

/** cover: base-raster encoding (low 7 bits 3 = paved, 4 = parking; 0x80 = tree canopy) on grid g */
export function buildContextLandcover(ctx: ContextInput, g: GridSpec, cover?: Uint8Array): Landcover {
  const n = g.nx * g.ny;
  const cls = new Uint8Array(n); // GRASS = 0
  const hasCover = cover?.length === n;
  if (hasCover) for (let i = 0; i < n; i++) cls[i] = (cover[i] & 0x7f) === 3 ? LC.PAVED : (cover[i] & 0x7f) === 4 ? LC.PARKING : LC.GRASS;
  const height = new Float32Array(n);
  const canopy = new Float32Array(n);
  for (const a of ctx.areas) {
    const c = AREA_CLS[a.type];
    if (c !== undefined) rasterizeRings(g, [a.polygon], (i) => (cls[i] = c));
  }
  for (const r of ctx.roads) {
    const w = (ROAD_WIDTH[r.cls] ?? 8) / 2;
    for (let k = 1; k < r.path.length; k++) {
      const [ax, ay] = r.path[k - 1],
        [bx, by] = r.path[k];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 0.1) continue;
      const nx = (-(by - ay) / L) * w,
        ny = ((bx - ax) / L) * w;
      rasterizeRings(g, [[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]], (i) => {
        if (cls[i] !== LC.WATER) cls[i] = LC.ROAD;
      });
    }
  }
  for (const b of ctx.buildings)
    rasterizeRings(g, [b.polygon], (i) => {
      cls[i] = LC.ROOF;
      height[i] = Math.max(height[i], b.height);
    });
  const ground = cls.slice();
  for (let i = 0; i < n; i++) {
    if (hasCover && cover[i] & 0x80 && cls[i] !== LC.ROOF && cls[i] !== LC.WATER) {
      // measured crown over the ground class (crowns over roads stay: the street below is shaded)
      canopy[i] = 1;
      cls[i] = LC.CANOPY;
      height[i] = Math.max(height[i], 9);
    } else if (cls[i] === LC.WOOD) {
      canopy[i] = 0.8;
      height[i] = Math.max(height[i], 9);
    }
  }
  return { grid: g, cls, ground, canopy, height };
}
