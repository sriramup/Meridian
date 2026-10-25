// Building typologies the fabric generator draws from, each mapped to a primitive in the library
// catalog (src/library/catalog) with the lot dimensions, setbacks, heights and uses it is built at.
// Typologies sit on an intensity ladder; a lot's score (street class, corner, distance to the
// centre, the programme's solved intensity, seeded jitter) picks its rung, so heights and densities
// grade from the main streets into the blocks instead of repeating one building everywhere.
//
// Dimensions (US practice): house lots 50–65 ft wide; townhouses 18–24 ft per unit; walk-ups and
// 5-over-1 mid-rise 60–75 ft deep double-loaded bars (here 14–20 m); residential tower floor plates
// ≈ 8,000–10,000 sq ft (750–950 m²) on 3–5 floor podiums; office plates 12–14 m core-to-glass.

import type { FacadeKey, RoofKey } from "@/library/geometry/palette";
import type { PaletteName } from "./programme";
import type { Rng } from "./util";

export type Family = "yard" | "perimeter";

export interface Typology {
  key: string;
  label: string;
  family: Family;
  /** library definition */
  def: string;
  /** lot frontage range, m */
  frontage: [number, number];
  floors: [number, number];
  /** building depth (yard family: the building sits at the front of a deeper lot) */
  depth: [number, number];
  /** front setback from the property line, m */
  front: [number, number];
  /** clear side gap on each side, m (0 = attached street wall) */
  side: number;
  use: "residential" | "office" | "hotel";
  /** homes per building for house-scale types (others from floor area) */
  homes?: number;
  /** how the primitive is placed: site outline, point + size, or a fitted row */
  place: "site" | "point" | "row";
  /** facade group in the palette */
  facades: "low" | "mid" | "tower" | "office" | "shop";
}

/** the ladder; `rung` order is the intensity order within each family */
export const YARD: Typology[] = [
  { key: "house", label: "Detached house", family: "yard", def: "housing.single_family_home", frontage: [15, 20], floors: [1, 2], depth: [9, 11], front: [6, 7.5], side: 2, use: "residential", homes: 1, place: "point", facades: "low" },
  { key: "plex", label: "Duplex / triplex", family: "yard", def: "housing.duplex", frontage: [14, 18], floors: [2, 3], depth: [11, 14], front: [4.5, 6], side: 1.5, use: "residential", homes: 2, place: "point", facades: "low" },
  { key: "townhouse", label: "Townhouses", family: "yard", def: "housing.townhouse_row", frontage: [26, 44], floors: [2, 3], depth: [11, 13], front: [3, 4.5], side: 1, use: "residential", place: "row", facades: "low" },
  { key: "walkup", label: "Walk-up apartments", family: "yard", def: "housing.apartment_block", frontage: [24, 40], floors: [3, 4], depth: [14, 16], front: [3, 4.5], side: 2, use: "residential", place: "site", facades: "mid" },
];

export const PERIMETER: Typology[] = [
  { key: "urban_townhouse", label: "Urban townhouses", family: "perimeter", def: "housing.rowhouses", frontage: [24, 38], floors: [3, 4], depth: [11, 12.5], front: [1.5, 2.5], side: 0, use: "residential", place: "row", facades: "low" },
  { key: "shophouse", label: "Shophouse", family: "perimeter", def: "commercial.shophouse", frontage: [7, 10], floors: [3, 4], depth: [14, 18], front: [0.3, 0.6], side: 0, use: "residential", place: "site", facades: "shop" },
  { key: "apartments", label: "Apartment building", family: "perimeter", def: "housing.apartment_block", frontage: [20, 34], floors: [4, 5], depth: [14, 20], front: [0.8, 2], side: 0, use: "residential", place: "site", facades: "mid" },
  { key: "five_over_one", label: "Mid-rise (5-over-1)", family: "perimeter", def: "housing.midrise_apartments", frontage: [30, 56], floors: [6, 7], depth: [16, 22], front: [0.5, 1.5], side: 0, use: "residential", place: "site", facades: "mid" },
  { key: "midrise", label: "Mid-rise mixed use", family: "perimeter", def: "buildings.building", frontage: [30, 48], floors: [8, 12], depth: [18, 24], front: [0.5, 1.5], side: 0, use: "residential", place: "site", facades: "mid" },
  { key: "tower", label: "Residential tower", family: "perimeter", def: "housing.highrise_residential", frontage: [36, 52], floors: [16, 32], depth: [26, 34], front: [0.5, 1], side: 0, use: "residential", place: "site", facades: "tower" },
];

export const OFFICE: Typology = { key: "office", label: "Office building", family: "perimeter", def: "commercial.office_building", frontage: [36, 60], floors: [6, 12], depth: [22, 30], front: [0.5, 2], side: 0, use: "office", place: "site", facades: "office" };
export const OFFICE_TOWER: Typology = { key: "office_tower", label: "Office tower", family: "perimeter", def: "commercial.office_tower", frontage: [44, 60], floors: [20, 40], depth: [28, 34], front: [0.5, 2], side: 0, use: "office", place: "site", facades: "office" };

/** score thresholds: lots below enter the rung (yard family uses 0..3.6, perimeter 3.6..) */
const YARD_CUTS = [1.0, 1.9, 2.8];
const PERIM_CUTS = [4.3, 5.1, 6.2, 7.0];
export const PERIMETER_FROM = 3.6;

/** pick a rung by score within a family (shophouses are chosen separately, on retail frontage) */
export function typologyFor(score: number, family: Family, maxFloors: number): Typology {
  if (family === "yard") {
    let k = 0;
    while (k < YARD_CUTS.length && score >= YARD_CUTS[k]) k++;
    return YARD[k];
  }
  const rungs = PERIMETER.filter((t) => t.key !== "shophouse");
  let k = 0;
  while (k < PERIM_CUTS.length && score >= PERIM_CUTS[k]) k++;
  let t = rungs[k];
  // height cap: step down until the rung fits
  while (k > 0 && t.floors[0] > maxFloors) t = rungs[--k];
  return t;
}

/** lot depth an edge should carry for its family and score */
export function edgeDepth(family: Family, score: number, avail: number): number {
  if (family === "yard") return Math.max(22, Math.min(avail, score >= 2.8 ? 34 : score >= 1.9 ? 28 : 36));
  const d = score >= PERIM_CUTS[3] ? 30 : score >= PERIM_CUTS[2] ? 22 : score >= PERIM_CUTS[1] ? 19 : 17;
  return Math.min(avail, d);
}

// ---------------------------------------------------------------- palettes

type Pal = Record<Typology["facades"], FacadeKey[]> & { pitched: RoofKey[] };
export const PALETTES: Record<PaletteName, Pal> = {
  masonry: {
    low: ["brick_red", "brick_buff", "brick_brown", "siding_white", "siding_blue", "siding_sage"],
    mid: ["brick_red", "brick_buff", "brick_brown", "limestone", "precast_white", "metal_dark"],
    shop: ["brick_red", "brick_buff", "brick_brown", "limestone", "stucco_cream"],
    tower: ["glass_blue", "glass_bronze", "precast_white", "limestone", "glass_green"],
    office: ["glass_blue", "glass_green", "metal_silver", "limestone", "glass_bronze"],
    pitched: ["asphalt_grey", "asphalt_brown", "slate", "metal_standing_seam"],
  },
  texas: {
    low: ["stucco_cream", "limestone", "siding_white", "siding_sage", "timber_light", "brick_buff"],
    mid: ["limestone", "stucco_cream", "brick_buff", "sandstone", "metal_dark", "timber_light", "precast_white"],
    shop: ["limestone", "brick_red", "stucco_cream", "sandstone", "brick_buff"],
    tower: ["glass_blue", "glass_clear", "precast_white", "glass_bronze", "limestone"],
    office: ["glass_green", "glass_blue", "limestone", "metal_silver", "glass_clear"],
    pitched: ["metal_standing_seam", "asphalt_brown", "terracotta", "asphalt_grey"],
  },
  modern: {
    low: ["siding_white", "timber_light", "metal_dark", "stucco_white", "timber_dark"],
    mid: ["precast_white", "metal_dark", "timber_light", "stucco_white", "brick_brown", "concrete"],
    shop: ["metal_dark", "brick_brown", "precast_white", "timber_dark"],
    tower: ["glass_blue", "glass_clear", "metal_silver", "precast_white"],
    office: ["glass_clear", "glass_blue", "metal_dark", "metal_silver"],
    pitched: ["metal_standing_seam", "asphalt_grey", "metal_green"],
  },
  coastal: {
    low: ["siding_white", "siding_blue", "siding_yellow", "stucco_pink", "siding_sage"],
    mid: ["stucco_white", "stucco_cream", "stucco_pink", "precast_white", "siding_blue"],
    shop: ["stucco_terracotta", "stucco_cream", "stucco_pink", "brick_buff"],
    tower: ["glass_blue", "precast_white", "glass_clear"],
    office: ["glass_blue", "glass_clear", "precast_white"],
    pitched: ["terracotta", "asphalt_grey", "metal_standing_seam"],
  },
};

/** a facade from the palette group, avoiding the previous lot's facade */
export function pickFacade(pal: Pal, group: Typology["facades"], rng: Rng, avoid?: string): FacadeKey {
  const xs = pal[group];
  for (let k = 0; k < 4; k++) {
    const f = rng.pick(xs);
    if (f !== avoid) return f;
  }
  return xs[0];
}
