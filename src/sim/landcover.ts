// Land-cover + height rasters from the world model (4 m grid), shared by the
// heat, runoff, sunlight and green-cover analyses. The measured 2023 impervious
// layer supplies minor paved surfaces (driveways, patios); everything the world
// model knows about (buildings, street strips, parks, water, trees) is painted
// on top so edits flow straight into the analyses.

import type { Area, Building, Entity, Polygon, Tree } from "@/world/types";
import { bufferPoly } from "@/geometry/polygon";
import type { NodeGeom, StreetGeom } from "@/geometry/streetGeometry";
import { rasterizeDisc, rasterizeRings, type GridSpec } from "./raster";

export const LC = {
  GRASS: 0, // pervious / vegetated (default)
  ROOF: 1,
  ROAD: 2,
  PAVED: 3,
  PARKING: 4,
  WATER: 5,
  CANOPY: 6,
  PARK: 7,
  BARE: 8,
  POOL: 9,
  GREENROOF: 10,
  PERMEABLE: 11,
  RAINGARDEN: 12,
  WOOD: 13,
} as const;

export const LC_NAMES = ["Grass / pervious", "Roof", "Road asphalt", "Concrete / paving", "Surface parking", "Water", "Tree canopy", "Park / lawn", "Bare soil", "Pool", "Green roof", "Permeable paving", "Rain garden", "Woodland"];
export const IMPERVIOUS = new Set<number>([LC.ROOF, LC.ROAD, LC.PAVED, LC.PARKING, LC.POOL]);

/** green roofs are planted inside a perimeter setback (parapet, maintenance and egress paths, plant) */
export const GREEN_ROOF_SETBACK = 1.5;
export function plantedRoof(footprint: Polygon): Polygon {
  const p = bufferPoly(footprint, -GREEN_ROOF_SETBACK);
  return p[0]?.length >= 3 ? p : [[]];
}

/**
 * Hydrologic surface per cell: the ground cover, except that tree canopy over pervious ground counts as
 * canopy. Canopy over pavement or roofs does not make them pervious (TR-55; the City's impervious-cover
 * data counts pavement under trees as impervious).
 */
export function surfaceClasses(lc: Pick<Landcover, "cls" | "ground">): Uint8Array {
  const out = lc.ground.slice();
  for (let i = 0; i < out.length; i++) {
    const g = out[i];
    if (g === LC.WATER || IMPERVIOUS.has(g) || g === LC.GREENROOF) continue;
    if (lc.cls[i] === LC.CANOPY) out[i] = LC.CANOPY;
  }
  return out;
}

export interface LandcoverInput {
  grid: GridSpec;
  base: Uint8Array;
  buildings: { rings: number[][][]; height: number; green: boolean; planted?: number[][][]; masses: { rings: number[][][]; base: number; top: number }[] }[];
  surfaces: { rings: number[][][]; cls: number }[];
  trees: { p: [number, number]; r: number; h: number }[];
  /** proposed footprints / hard surfaces that clear the measured canopy beneath them */
  clearings: number[][][][];
}

/** base raster: low 7 bits = measured ground class, high bit = measured tree canopy (City of Austin 2022) */
export const CANOPY_BIT = 0x80;

export interface Landcover {
  grid: GridSpec;
  /** surface class seen from above */
  cls: Uint8Array;
  /** ground class beneath canopy */
  ground: Uint8Array;
  /** canopy cover fraction 0..1 */
  canopy: Float32Array;
  /** building height (m) per cell (0 = none) */
  height: Float32Array;
}

const toRings = (poly: number[][][]): [number, number][][] => poly as [number, number][][];

export function prepareLandcover(entities: Iterable<Entity>, streetGeom: Map<string, StreetGeom>, nodeGeom: Map<string, NodeGeom>, grid: GridSpec, base: Uint8Array): LandcoverInput {
  const buildings: LandcoverInput["buildings"] = [];
  const surfaces: LandcoverInput["surfaces"] = [];
  const trees: LandcoverInput["trees"] = [];
  const clearings: number[][][][] = [];
  const areaCls: Partial<Record<Area["type"], number>> = {
    park: LC.PARK, grass: LC.GRASS, wood: LC.WOOD, pitch: LC.PARK, water: LC.WATER, parking: LC.PARKING, plaza: LC.PAVED,
    construction: LC.BARE, campus: -1, cemetery: LC.PARK, retention: LC.WATER, raingarden: LC.RAINGARDEN, permeable: LC.PERMEABLE,
  };
  const order: Area["type"][] = ["campus", "grass", "park", "cemetery", "pitch", "wood", "construction", "parking", "plaza", "permeable", "raingarden", "retention", "water"];
  const areas: Area[] = [];
  for (const e of entities) {
    if (e.kind === "building") {
      const b = e as Building;
      buildings.push({ rings: b.footprint, height: b.height, green: !!b.greenRoof, planted: b.greenRoof ? plantedRoof(b.footprint) : undefined, masses: b.masses.map((m) => ({ rings: m.poly, base: m.base, top: m.top })) });
      if (b.createdBy) clearings.push(b.footprint);
    } else if (e.kind === "tree") {
      const t = e as Tree;
      trees.push({ p: t.p, r: t.r, h: t.h });
    } else if (e.kind === "area") {
      const a = e as Area;
      areas.push(a);
      if (a.createdBy && ["parking", "plaza", "water", "retention", "construction", "permeable"].includes(a.type)) clearings.push(a.poly);
    }
    else if (e.kind === "street") {
      const g = streetGeom.get(e.id);
      if (!g) continue;
      const proposed = !!(e as { createdBy?: string }).createdBy;
      for (const s of g.strips) {
        const cls = s.type === "sidewalk" || s.type === "plaza" || s.type === "buffer" ? LC.PAVED : s.type === "planting" && s.bio ? LC.RAINGARDEN : s.type === "planting" || s.type === "median" ? LC.GRASS : LC.ROAD;
        surfaces.push({ rings: [s.ring], cls });
        // a rebuilt carriageway loses the canopy over it (kerbside trees are modelled as tree entities)
        if (proposed && cls === LC.ROAD) clearings.push([s.ring]);
      }
    } else if (e.kind === "node") {
      const g = nodeGeom.get(e.id);
      if (!g) continue;
      if (g.carriageway) surfaces.push({ rings: [g.carriageway], cls: g.plaza ? LC.PAVED : LC.ROAD });
      for (const c of g.corners) surfaces.push({ rings: [c], cls: LC.PAVED });
      if (g.island) surfaces.push({ rings: [g.island], cls: LC.GRASS });
    }
  }
  areas.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const areaSurfaces = areas.filter((a) => (areaCls[a.type] ?? -1) >= 0).map((a) => ({ rings: a.poly, cls: areaCls[a.type]! }));
  return { grid, base, buildings, surfaces: [...areaSurfaces, ...surfaces], trees, clearings };
}

export function buildLandcover(inp: LandcoverInput): Landcover {
  const g = inp.grid;
  const n = g.nx * g.ny;
  const cls = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = inp.base[i] & ~CANOPY_BIT;
    cls[i] = b === 3 ? LC.PAVED : b === 8 ? LC.BARE : b === 9 ? LC.POOL : LC.GRASS;
  }
  for (const s of inp.surfaces) rasterizeRings(g, toRings(s.rings), (i) => (cls[i] = s.cls));
  const height = new Float32Array(n);
  for (const b of inp.buildings) {
    rasterizeRings(g, toRings(b.rings), (i) => {
      cls[i] = LC.ROOF;
    });
    // planted only inside the edge setback; parapets, access paths and plant stay hard roof
    if (b.green && b.planted?.[0]?.length) rasterizeRings(g, toRings(b.planted), (i) => (cls[i] = LC.GREENROOF));
    for (const m of b.masses) rasterizeRings(g, toRings(m.rings), (i) => (height[i] = Math.max(height[i], m.top)));
  }
  const ground = cls.slice();
  const canopy = new Float32Array(n);
  // measured canopy, except where a proposal has cleared it
  const cleared = new Uint8Array(n);
  for (const c of inp.clearings ?? []) rasterizeRings(g, toRings(c), (i) => (cleared[i] = 1));
  for (let i = 0; i < n; i++) {
    if (!(inp.base[i] & CANOPY_BIT) || cleared[i] || cls[i] === LC.WATER) continue;
    canopy[i] = 1;
    if (cls[i] !== LC.ROOF && cls[i] !== LC.GREENROOF) {
      cls[i] = LC.CANOPY;
      height[i] = Math.max(height[i], 9);
    }
  }
  for (const t of inp.trees) {
    rasterizeDisc(g, t.p, t.r, (i) => {
      canopy[i] = 1;
      if (cls[i] !== LC.ROOF && cls[i] !== LC.GREENROOF) {
        cls[i] = LC.CANOPY;
        height[i] = Math.max(height[i], t.h * 0.6);
      }
    });
  }
  for (let i = 0; i < n; i++) if (ground[i] === LC.WOOD) canopy[i] = Math.max(canopy[i], 0.8);
  return { grid: g, cls, ground, canopy, height };
}

export function coverStats(lc: Landcover, mask?: Uint8Array) {
  const counts = new Float64Array(16);
  let canopy = 0,
    n = 0;
  for (let i = 0; i < lc.cls.length; i++) {
    if (mask && !mask[i]) continue;
    counts[lc.cls[i]]++;
    canopy += lc.canopy[i];
    n++;
  }
  const a = lc.grid.cell * lc.grid.cell;
  let imp = 0;
  for (let i = 0; i < lc.ground.length; i++) {
    if (mask && !mask[i]) continue;
    if (IMPERVIOUS.has(lc.ground[i])) imp++;
  }
  return {
    cells: n,
    areaM2: n * a,
    canopyFraction: n ? canopy / n : 0,
    imperviousFraction: n ? imp / n : 0,
    byClass: Object.fromEntries(LC_NAMES.map((name, k) => [name, (counts[k] / Math.max(1, n)) as number])),
  };
}
