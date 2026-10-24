// Street- and park-tree palette for Central Texas. Sizes sit around the mapped
// trees in the pack (OSM: 4 m crown radius, 9 m tall) so new plantings read at
// the same scale as the existing street trees; species differ in habit (a
// spreading oak, a narrow cypress, a small redbud) rather than in giant crowns.
// The heat, sun and runoff models use these crowns to cast shade.

export type CrownShape = "spreading" | "round" | "conical" | "vase";

export interface Species {
  id: string;
  name: string;
  /** crown radius m */
  r: number;
  /** height m */
  h: number;
  shape: CrownShape;
  color: [number, number, number];
  note: string;
}

export const SPECIES: Species[] = [
  { id: "live_oak", name: "Live oak", r: 4.5, h: 9, shape: "spreading", color: [74, 108, 64], note: "Broad evergreen shade; Austin's signature street tree" },
  { id: "cedar_elm", name: "Cedar elm", r: 4, h: 10, shape: "vase", color: [96, 134, 74], note: "Drought-tough, upright vase over sidewalks" },
  { id: "bur_oak", name: "Bur oak", r: 4.5, h: 10, shape: "round", color: [86, 122, 70], note: "Large deciduous canopy for parks and wide strips" },
  { id: "bald_cypress", name: "Bald cypress", r: 2.5, h: 11, shape: "conical", color: [62, 92, 60], note: "Narrow and tall; good by water and in tight strips" },
  { id: "desert_willow", name: "Desert willow", r: 2.5, h: 6.5, shape: "round", color: [130, 150, 98], note: "Small, airy shade; fits under power lines" },
  { id: "redbud", name: "Texas redbud", r: 3, h: 6, shape: "round", color: [176, 104, 132], note: "Small ornamental; spring bloom, light shade" },
];

export const DEFAULT_SPECIES = "live_oak";

const BY_ID = new Map(SPECIES.map((s) => [s.id, s]));
export const speciesOf = (id?: string): Species | undefined => (id ? BY_ID.get(id) : undefined);
