// Housing: detached homes to high-rise residential, all defaults over the universal building.

import type { PrimitiveDef } from "../types";
import { ROOFS, type RoofKey } from "../geometry/palette";
import { buildingClusterType, buildingRowType, buildingType, type DecorateArgs } from "./building";
import { chimney, garage, porch, yard } from "./decor";
import { bool, choice, int, num } from "./params";

const H = "housing" as const;
const HOME = "Home";

const homeExtras = (porchDef: boolean, garageDef: "none" | "attached" | "detached", yardDef = true) => [
  bool("porch", "Front porch", porchDef, { group: HOME }),
  num("porchDepth", "Porch depth", 2.4, { group: HOME, unit: "m", min: 1, max: 5, step: 0.1, when: { key: "porch", in: [true] } }),
  choice("garage", "Garage", garageDef, [{ value: "none", label: "None" }, { value: "attached", label: "Attached" }, { value: "detached", label: "Detached" }], { group: HOME }),
  int("garageCars", "Garage spaces", 2, { group: HOME, min: 1, max: 4, when: { key: "garage", in: ["attached", "detached"] } }),
  bool("chimney", "Chimney", false, { group: HOME }),
  bool("yard", "Yard (lot lawn)", yardDef, { group: HOME, description: "Lawn around the house; setbacks below" }),
  num("frontSetback", "Front yard depth", 6, { group: HOME, unit: "m", min: 0, max: 30, step: 0.5, when: { key: "yard", in: [true] } }),
  num("sideSetback", "Side yard width", 2, { group: HOME, unit: "m", min: 0, max: 15, step: 0.5, when: { key: "yard", in: [true] }, advanced: true }),
  num("rearSetback", "Rear yard depth", 9, { group: HOME, unit: "m", min: 0, max: 40, step: 0.5, when: { key: "yard", in: [true] } }),
  bool("driveway", "Driveway", true, { group: HOME, when: { key: "yard", in: [true] } }),
];

function decorateHome({ r, out, info }: DecorateArgs) {
  const roof = ROOFS[(r.s("roofMaterial") in ROOFS ? r.s("roofMaterial") : "asphalt_grey") as RoofKey].color;
  if (r.b("porch")) porch(info, r.n("porchDepth"), Math.min(info.front.len, 7), [240, 238, 232], roof);
  const g = r.s("garage");
  let extraX = 0;
  if (g === "attached" || g === "detached") {
    garage(info, g, r.n("garageCars"), roof);
    extraX = 3.3 * r.n("garageCars") + 0.4 + (g === "detached" ? 3 : 0);
  }
  if (r.b("chimney")) chimney(info);
  if (r.b("yard")) yard(out, info, r.n("frontSetback"), r.n("sideSetback"), r.n("rearSetback"), r.b("driveway"), extraX);
}

const house = { use: "residential", roofType: "gable", roofPitch: 30, roofMaterial: "asphalt_grey", parapetHeight: 0, overhang: 0.5, groundFloorHeight: 3.0, floorHeight: 2.9, units: 1, entrance: true };

export const HOUSING: PrimitiveDef[] = [
  buildingType({
    id: "housing.single_family_home",
    name: "Single-family home",
    category: H,
    tags: ["house", "detached", "home", "residence", "suburban", "villa", "sfh"],
    description: "Detached house on its own lot with porch, garage, yard and driveway options.",
    icon: "home",
    defaults: { ...house, shape: "rect", width: 12, depth: 10, floors: 2, facade: "siding_white", fitToSite: false },
    extra: homeExtras(true, "attached"),
    decorate: decorateHome,
  }),
  buildingType({
    id: "housing.cottage",
    name: "Cottage",
    category: H,
    tags: ["bungalow", "small house", "cabin", "starter home"],
    description: "Small one-storey cottage or bungalow with a steep roof.",
    icon: "home",
    defaults: { ...house, width: 9, depth: 8, floors: 1, roofPitch: 40, facade: "siding_sage", roofMaterial: "wood_shake", fitToSite: false },
    extra: homeExtras(true, "none"),
    decorate: decorateHome,
  }),
  buildingType({
    id: "housing.ranch_house",
    name: "Ranch house",
    category: H,
    tags: ["rambler", "single storey", "mid-century", "suburban"],
    description: "Long, low single-storey house with a shallow hip roof and attached garage.",
    icon: "home",
    defaults: { ...house, width: 20, depth: 11, floors: 1, roofType: "hip", roofPitch: 20, overhang: 0.8, facade: "brick_brown", roofMaterial: "asphalt_brown", fitToSite: false },
    extra: homeExtras(false, "attached"),
    decorate: decorateHome,
  }),
  buildingType({
    id: "housing.l_shaped_house",
    name: "L-shaped house",
    category: H,
    tags: ["house", "craftsman", "farmhouse", "cross gable"],
    description: "Two-wing house with crossing gables.",
    icon: "home",
    defaults: { ...house, shape: "l", width: 16, depth: 14, wing: 7, wing2: 8, floors: 2, facade: "siding_blue", fitToSite: false },
    extra: homeExtras(true, "none"),
    decorate: decorateHome,
  }),
  buildingType({
    id: "housing.accessory_dwelling",
    name: "Accessory dwelling unit (ADU)",
    category: H,
    tags: ["adu", "granny flat", "backyard cottage", "tiny house", "laneway house", "casita"],
    description: "Small secondary home in a back yard or over a garage.",
    icon: "home",
    defaults: { ...house, width: 7, depth: 6, floors: 1, roofType: "shed", roofPitch: 12, facade: "timber_light", roofMaterial: "metal_standing_seam", fitToSite: false },
    extra: homeExtras(false, "none", false),
    decorate: decorateHome,
  }),
  buildingType({
    id: "housing.duplex",
    name: "Duplex",
    category: H,
    tags: ["two-family", "semi-detached", "double house", "side by side"],
    description: "Two homes in one building (side by side or stacked).",
    icon: "home",
    defaults: { ...house, width: 16, depth: 11, floors: 2, units: 2, facade: "brick_buff", fitToSite: false },
    extra: homeExtras(true, "none"),
    decorate: decorateHome,
  }),
  buildingType({
    id: "housing.triplex",
    name: "Triplex / fourplex",
    category: H,
    tags: ["three-family", "fourplex", "quadplex", "missing middle", "plex", "multiplex"],
    description: "Three or four homes in a house-scale building — 'missing middle' housing.",
    icon: "home",
    defaults: { ...house, width: 14, depth: 16, floors: 3, units: 3, roofType: "hip", roofPitch: 22, facade: "brick_red", fitToSite: false },
    extra: homeExtras(true, "none"),
    decorate: decorateHome,
  }),
  buildingRowType({
    id: "housing.townhouse_row",
    name: "Townhouse row",
    category: H,
    tags: ["townhomes", "terrace", "attached housing", "brownstone"],
    description: "A row of attached three-storey townhouses with individual entries.",
    icon: "home",
    defaults: { ...house, count: 6, unitWidth: 6.5, depth: 13, floors: 3, roofType: "flat", parapetHeight: 0.8, units: 1, stagger: 0.8, facade: "brick_red" },
  }),
  buildingRowType({
    id: "housing.rowhouses",
    name: "Rowhouses",
    category: H,
    tags: ["terraced houses", "row homes", "victorian terrace", "attached"],
    description: "Narrow two-storey gabled rowhouses with varied colours and heights.",
    icon: "home",
    defaults: { ...house, count: 8, unitWidth: 5.5, depth: 11, floors: 2, roofType: "gable", ridge: "short", roofPitch: 38, units: 1, heightVariation: 1, facade: "brick_buff" },
  }),
  buildingClusterType({
    id: "housing.garden_apartments",
    name: "Garden apartments",
    category: H,
    tags: ["walk-up", "apartment complex", "garden flats", "low-rise apartments"],
    description: "Two- to three-storey walk-up blocks around shared lawns and trees.",
    icon: "building",
    defaults: { use: "residential", rows: 2, cols: 3, width: 30, depth: 13, floors: 3, roofType: "hip", roofPitch: 22, roofMaterial: "asphalt_brown", parapetHeight: 0, facade: "brick_buff", balconies: true, balconyDepth: 1.4, unitSize: 80 },
  }),
  buildingType({
    id: "housing.apartment_block",
    name: "Apartment block",
    category: H,
    tags: ["apartments", "flats", "condo", "multifamily", "walk-up", "low-rise"],
    description: "Four- to six-storey apartment building with balconies.",
    icon: "building",
    defaults: { use: "residential", width: 40, depth: 16, floors: 5, roofType: "flat", parapetHeight: 1, facade: "brick_buff", balconies: true },
  }),
  buildingType({
    id: "housing.courtyard_apartments",
    name: "Courtyard apartments",
    category: H,
    tags: ["perimeter block", "european block", "condo", "multifamily"],
    description: "Perimeter block of apartments around a private courtyard.",
    icon: "building",
    defaults: { use: "residential", shape: "o", width: 60, depth: 50, wing: 14, wing2: 14, floors: 6, roofType: "flat", facade: "stucco_cream", groundUse: "retail" },
  }),
  buildingType({
    id: "housing.midrise_apartments",
    name: "Mid-rise apartments (5-over-1)",
    category: H,
    tags: ["podium apartments", "five over one", "mixed use", "wrap", "condo", "multifamily"],
    description: "Five floors of wood-frame apartments over a concrete retail podium.",
    icon: "building",
    defaults: { use: "residential", shape: "u", width: 70, depth: 45, wing: 18, wing2: 18, floors: 6, podiumFloors: 1, towerCoverage: 100, groundFloorHeight: 5, groundUse: "retail", roofType: "flat", facade: "precast_white", balconies: true, awning: true },
  }),
  buildingType({
    id: "housing.highrise_residential",
    name: "High-rise residential tower",
    category: H,
    tags: ["condo tower", "apartment tower", "skyscraper", "point tower", "residential tower"],
    description: "Residential tower on a podium with balconies and rooftop plant.",
    icon: "building-2",
    defaults: { use: "residential", width: 45, depth: 40, floors: 32, podiumFloors: 4, towerCoverage: 40, roofType: "flat", facade: "glass_blue", balconies: true, penthouse: true, groundUse: "retail" },
  }),
  buildingType({
    id: "housing.senior_housing",
    name: "Senior housing",
    category: H,
    tags: ["assisted living", "retirement home", "elderly", "care home", "independent living"],
    description: "Accessible three- to four-storey senior living with a courtyard garden.",
    icon: "building",
    defaults: { use: "residential", shape: "u", width: 60, depth: 40, wing: 16, wing2: 16, floors: 4, roofType: "hip", roofPitch: 22, roofMaterial: "asphalt_brown", parapetHeight: 0, facade: "brick_buff", unitSize: 60, awning: true },
  }),
  buildingType({
    id: "housing.dormitory",
    name: "Dormitory",
    category: H,
    tags: ["residence hall", "student housing", "dorm", "halls"],
    description: "Student residence hall with double-loaded corridors.",
    icon: "building",
    defaults: { use: "residential", shape: "l", width: 55, depth: 45, wing: 17, wing2: 17, floors: 6, roofType: "flat", facade: "brick_red", unitSize: 40 },
  }),
  buildingType({
    id: "housing.mobile_home",
    name: "Manufactured home",
    category: H,
    tags: ["mobile home", "trailer", "prefab", "modular home"],
    description: "Single-wide manufactured home on a pad.",
    icon: "home",
    defaults: { ...house, width: 20, depth: 4.5, floors: 1, groundFloorHeight: 3.2, roofType: "gable", roofPitch: 10, facade: "siding_white", roofMaterial: "metal_standing_seam", fitToSite: false },
    extra: homeExtras(false, "none"),
    decorate: decorateHome,
  }),
];
