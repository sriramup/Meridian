// Flora: a universal configurable tree, one definition per common species (same schema, species
// defaults), rows and groves, shrubs, hedges (streetscape), flower beds, grasses, meadows, lawns,
// woodland and green walls. Trees are Props with detailed solids and `shade` (crown radius and
// height) by default, or plain Tree entities (form = "simple") for the tree-specific models.

import { polyArea, polyCentroid } from "@/geometry/polygon";
import type { Solid, Vec2 } from "@/world/types";
import type { GenerateContext, ParamSpec, PrimitiveDef } from "../types";
import { frameOf, hashSeed, rng } from "../geometry/frame";
import { C, hexToRgb, rgbToHex, shade } from "../geometry/palette";
import { shrubSolids, treeSolids, type CrownShape, type ShrubShape } from "../geometry/props";
import { S, box, moveSolids, type RGB } from "../geometry/solids";
import { areaDef, defaultPath, offsetPath, pathLength as pathLen, propDef, rowDef, scatterIn, seedOf, siteOf, stations } from "./kinds";
import { Out } from "./make";
import { bool, choice, color, int, num, opts, reader, type Reader } from "./params";

const FL = "flora" as const;
const T = "Tree",
  A = "Appearance",
  D = "Dimensions",
  P = "Planting";

export interface SpeciesPreset {
  id: string;
  name: string;
  latin: string;
  shape: CrownShape;
  height: number;
  crown: number;
  trunkFrac: number;
  dbh: number;
  color: RGB;
  trunk: RGB;
  autumn?: RGB;
  blossom?: RGB;
  evergreen: boolean;
  tags: string[];
  /** nearest species in src/world/species.ts for the simple Tree form */
  simple: string;
  note: string;
}

const G = (r: number, g: number, b: number): RGB => [r, g, b];

/** mature sizes typical of urban plantings (not record specimens) */
export const SPECIES_PRESETS: SpeciesPreset[] = [
  { id: "live_oak", name: "Live oak", latin: "Quercus virginiana", shape: "spreading", height: 12, crown: 16, trunkFrac: 0.3, dbh: 0.8, color: G(74, 108, 64), trunk: G(96, 82, 70), evergreen: true, tags: ["oak", "evergreen", "shade tree", "southern"], simple: "live_oak", note: "Broad evergreen shade tree" },
  { id: "red_oak", name: "Red oak", latin: "Quercus rubra", shape: "round", height: 18, crown: 14, trunkFrac: 0.3, dbh: 0.7, color: G(82, 120, 66), trunk: G(100, 86, 72), autumn: G(168, 62, 42), evergreen: false, tags: ["oak", "deciduous", "shade tree"], simple: "bur_oak", note: "Fast-growing deciduous oak, red in autumn" },
  { id: "bur_oak", name: "Bur oak", latin: "Quercus macrocarpa", shape: "round", height: 18, crown: 16, trunkFrac: 0.3, dbh: 0.8, color: G(86, 122, 70), trunk: G(96, 84, 70), autumn: G(150, 120, 60), evergreen: false, tags: ["oak", "deciduous", "park tree"], simple: "bur_oak", note: "Massive, drought tolerant park tree" },
  { id: "sugar_maple", name: "Sugar maple", latin: "Acer saccharum", shape: "oval", height: 18, crown: 12, trunkFrac: 0.28, dbh: 0.6, color: G(88, 132, 70), trunk: G(110, 96, 84), autumn: G(222, 128, 46), evergreen: false, tags: ["maple", "deciduous", "fall colour"], simple: "bur_oak", note: "Dense oval crown, orange autumn colour" },
  { id: "red_maple", name: "Red maple", latin: "Acer rubrum", shape: "oval", height: 14, crown: 9, trunkFrac: 0.3, dbh: 0.45, color: G(96, 136, 74), trunk: G(120, 110, 100), autumn: G(196, 52, 40), evergreen: false, tags: ["maple", "deciduous", "street tree"], simple: "bur_oak", note: "Adaptable street tree, scarlet in fall" },
  { id: "american_elm", name: "American elm", latin: "Ulmus americana", shape: "vase", height: 20, crown: 15, trunkFrac: 0.35, dbh: 0.7, color: G(92, 130, 72), trunk: G(104, 92, 80), autumn: G(200, 170, 70), evergreen: false, tags: ["elm", "vase", "avenue tree", "cathedral arch"], simple: "cedar_elm", note: "Classic arching avenue tree" },
  { id: "cedar_elm", name: "Cedar elm", latin: "Ulmus crassifolia", shape: "vase", height: 13, crown: 9, trunkFrac: 0.35, dbh: 0.45, color: G(96, 134, 74), trunk: G(104, 92, 80), autumn: G(196, 170, 70), evergreen: false, tags: ["elm", "drought tolerant", "texas"], simple: "cedar_elm", note: "Tough native elm for street strips" },
  { id: "london_plane", name: "London plane", latin: "Platanus × acerifolia", shape: "round", height: 22, crown: 16, trunkFrac: 0.3, dbh: 0.8, color: G(98, 138, 78), trunk: G(170, 160, 140), autumn: G(170, 140, 70), evergreen: false, tags: ["plane tree", "sycamore", "street tree", "urban"], simple: "bur_oak", note: "Pollution-tolerant street tree with mottled bark" },
  { id: "bald_cypress", name: "Bald cypress", latin: "Taxodium distichum", shape: "conical", height: 18, crown: 7, trunkFrac: 0.15, dbh: 0.6, color: G(62, 92, 60), trunk: G(120, 96, 76), autumn: G(176, 98, 52), evergreen: false, tags: ["cypress", "wetland", "conifer", "rain garden"], simple: "bald_cypress", note: "Narrow deciduous conifer, tolerates flooding" },
  { id: "italian_cypress", name: "Italian cypress", latin: "Cupressus sempervirens", shape: "columnar", height: 14, crown: 2.2, trunkFrac: 0.05, dbh: 0.3, color: G(52, 82, 56), trunk: G(100, 80, 64), evergreen: true, tags: ["cypress", "columnar", "mediterranean", "evergreen", "screen"], simple: "bald_cypress", note: "Pencil-thin evergreen accent" },
  { id: "loblolly_pine", name: "Loblolly pine", latin: "Pinus taeda", shape: "layered", height: 22, crown: 9, trunkFrac: 0.45, dbh: 0.6, color: G(64, 98, 64), trunk: G(118, 92, 72), evergreen: true, tags: ["pine", "conifer", "evergreen", "southern pine"], simple: "bald_cypress", note: "Tall southern pine with tiered crown" },
  { id: "white_pine", name: "Eastern white pine", latin: "Pinus strobus", shape: "conical", height: 20, crown: 10, trunkFrac: 0.2, dbh: 0.6, color: G(70, 104, 76), trunk: G(110, 90, 76), evergreen: true, tags: ["pine", "conifer", "evergreen"], simple: "bald_cypress", note: "Soft-needled conifer" },
  { id: "spruce", name: "Blue spruce", latin: "Picea pungens", shape: "conical", height: 15, crown: 6, trunkFrac: 0.05, dbh: 0.45, color: G(96, 128, 128), trunk: G(100, 84, 70), evergreen: true, tags: ["spruce", "fir", "christmas tree", "conifer", "evergreen"], simple: "bald_cypress", note: "Dense blue-grey conifer" },
  { id: "palm", name: "Mexican fan palm", latin: "Washingtonia robusta", shape: "fan_palm", height: 18, crown: 4.5, trunkFrac: 0.85, dbh: 0.45, color: G(96, 136, 72), trunk: G(150, 126, 100), evergreen: true, tags: ["palm", "fan palm", "tropical", "washingtonia"], simple: "desert_willow", note: "Tall slender fan palm" },
  { id: "date_palm", name: "Date palm", latin: "Phoenix dactylifera", shape: "palm", height: 14, crown: 8, trunkFrac: 0.8, dbh: 0.6, color: G(110, 140, 84), trunk: G(150, 124, 94), evergreen: true, tags: ["palm", "feather palm", "tropical", "phoenix"], simple: "desert_willow", note: "Feathery crown on a stout trunk" },
  { id: "sabal_palm", name: "Sabal palm", latin: "Sabal palmetto", shape: "fan_palm", height: 12, crown: 5, trunkFrac: 0.8, dbh: 0.4, color: G(88, 124, 70), trunk: G(140, 120, 96), evergreen: true, tags: ["palm", "palmetto", "cabbage palm"], simple: "desert_willow", note: "Hardy native fan palm" },
  { id: "southern_magnolia", name: "Southern magnolia", latin: "Magnolia grandiflora", shape: "oval", height: 15, crown: 9, trunkFrac: 0.15, dbh: 0.5, color: G(54, 90, 56), trunk: G(120, 110, 100), blossom: G(244, 240, 226), evergreen: true, tags: ["magnolia", "evergreen", "flowering", "southern"], simple: "live_oak", note: "Glossy evergreen with large white flowers" },
  { id: "crape_myrtle", name: "Crape myrtle", latin: "Lagerstroemia indica", shape: "multistem", height: 6, crown: 5, trunkFrac: 0.4, dbh: 0.15, color: G(96, 130, 76), trunk: G(170, 140, 120), blossom: G(214, 96, 150), evergreen: false, tags: ["crepe myrtle", "flowering", "small tree", "multi-stem"], simple: "redbud", note: "Multi-stem summer-flowering small tree" },
  { id: "cherry", name: "Flowering cherry", latin: "Prunus serrulata", shape: "round", height: 8, crown: 8, trunkFrac: 0.3, dbh: 0.3, color: G(102, 138, 80), trunk: G(96, 70, 60), blossom: G(242, 184, 204), evergreen: false, tags: ["cherry blossom", "sakura", "flowering", "ornamental"], simple: "redbud", note: "Spring blossom ornamental" },
  { id: "redbud", name: "Eastern redbud", latin: "Cercis canadensis", shape: "round", height: 7, crown: 7, trunkFrac: 0.3, dbh: 0.25, color: G(110, 140, 84), trunk: G(90, 72, 62), blossom: G(196, 104, 156), evergreen: false, tags: ["redbud", "flowering", "understorey", "small tree"], simple: "redbud", note: "Small tree with magenta spring bloom" },
  { id: "birch", name: "River birch", latin: "Betula nigra", shape: "multistem", height: 14, crown: 8, trunkFrac: 0.35, dbh: 0.25, color: G(110, 148, 84), trunk: G(220, 214, 200), autumn: G(214, 186, 80), evergreen: false, tags: ["birch", "white bark", "multi-stem", "wetland"], simple: "desert_willow", note: "Light canopy, peeling pale bark" },
  { id: "weeping_willow", name: "Weeping willow", latin: "Salix babylonica", shape: "weeping", height: 12, crown: 12, trunkFrac: 0.3, dbh: 0.6, color: G(132, 160, 92), trunk: G(110, 96, 80), autumn: G(200, 190, 90), evergreen: false, tags: ["willow", "weeping", "waterside", "pond"], simple: "desert_willow", note: "Cascading crown, by water" },
  { id: "desert_willow", name: "Desert willow", latin: "Chilopsis linearis", shape: "multistem", height: 6.5, crown: 5, trunkFrac: 0.35, dbh: 0.2, color: G(130, 150, 98), trunk: G(120, 100, 84), blossom: G(220, 160, 200), evergreen: false, tags: ["willow", "xeriscape", "small tree", "under power lines"], simple: "desert_willow", note: "Airy, drought-tough small tree" },
  { id: "ginkgo", name: "Ginkgo", latin: "Ginkgo biloba", shape: "oval", height: 16, crown: 9, trunkFrac: 0.3, dbh: 0.5, color: G(112, 150, 82), trunk: G(112, 98, 86), autumn: G(234, 200, 70), evergreen: false, tags: ["maidenhair", "street tree", "urban tolerant"], simple: "bur_oak", note: "Tough street tree, gold in autumn" },
  { id: "honey_locust", name: "Honey locust", latin: "Gleditsia triacanthos", shape: "vase", height: 15, crown: 12, trunkFrac: 0.35, dbh: 0.5, color: G(130, 160, 90), trunk: G(96, 84, 74), autumn: G(214, 196, 80), evergreen: false, tags: ["locust", "filtered shade", "street tree"], simple: "cedar_elm", note: "Fine-leaved, dappled shade" },
  { id: "linden", name: "Littleleaf linden", latin: "Tilia cordata", shape: "oval", height: 15, crown: 10, trunkFrac: 0.25, dbh: 0.5, color: G(86, 128, 70), trunk: G(100, 90, 80), autumn: G(200, 180, 80), evergreen: false, tags: ["lime tree", "basswood", "street tree"], simple: "bur_oak", note: "Neat pyramidal-oval street tree" },
  { id: "olive", name: "Olive", latin: "Olea europaea", shape: "round", height: 7, crown: 7, trunkFrac: 0.3, dbh: 0.4, color: G(130, 146, 112), trunk: G(120, 108, 92), evergreen: true, tags: ["olive", "mediterranean", "silver foliage"], simple: "desert_willow", note: "Silvery evergreen, gnarled trunk" },
  { id: "jacaranda", name: "Jacaranda", latin: "Jacaranda mimosifolia", shape: "spreading", height: 12, crown: 12, trunkFrac: 0.35, dbh: 0.45, color: G(100, 140, 86), trunk: G(110, 96, 84), blossom: G(150, 120, 210), evergreen: false, tags: ["flowering", "purple", "subtropical"], simple: "live_oak", note: "Purple spring bloom" },
  { id: "mesquite", name: "Honey mesquite", latin: "Prosopis glandulosa", shape: "spreading", height: 7, crown: 9, trunkFrac: 0.25, dbh: 0.35, color: G(124, 148, 94), trunk: G(92, 74, 60), evergreen: false, tags: ["mesquite", "desert", "xeriscape", "texas"], simple: "desert_willow", note: "Low spreading desert tree" },
  { id: "eucalyptus", name: "Eucalyptus", latin: "Eucalyptus globulus", shape: "oval", height: 24, crown: 10, trunkFrac: 0.45, dbh: 0.7, color: G(120, 148, 128), trunk: G(200, 190, 170), evergreen: true, tags: ["gum tree", "eucalypt", "australian"], simple: "bur_oak", note: "Tall blue-green evergreen" },
  { id: "juniper", name: "Ashe juniper", latin: "Juniperus ashei", shape: "conical", height: 7, crown: 5, trunkFrac: 0.1, dbh: 0.3, color: G(70, 98, 72), trunk: G(120, 96, 80), evergreen: true, tags: ["cedar", "juniper", "evergreen", "hill country"], simple: "bald_cypress", note: "Shrubby native evergreen" },
];

const SEASONS = [
  { value: "summer", label: "Summer (in leaf)" },
  { value: "spring", label: "Spring (blossom where the species flowers)" },
  { value: "autumn", label: "Autumn colour" },
  { value: "winter", label: "Winter (deciduous trees bare)" },
];

function treeParams(sp: SpeciesPreset, withSpecies: boolean): ParamSpec[] {
  return [
    ...(withSpecies ? [choice("species", "Species", sp.id, SPECIES_PRESETS.map((s) => ({ value: s.id, label: `${s.name} (${s.latin})`, description: s.note })), { group: T, description: "Sets the crown shape, size and colours below unless overridden" })] : []),
    bool("customize", "Override species form", !withSpecies ? false : false, { group: T, description: "Use the shape / size / colour values below instead of the species defaults" }),
    choice("crownShape", "Crown shape", sp.shape, opts("round", "oval", "spreading", "vase", "conical", "layered", "columnar", "weeping", "multistem", "palm", "fan_palm"), { group: T, when: { key: "customize", in: [true] } }),
    num("height", "Height", sp.height, { group: D, unit: "m", min: 1, max: 60, step: 0.5, when: { key: "customize", in: [true] } }),
    num("crown", "Crown spread", sp.crown, { group: D, unit: "m", min: 0.5, max: 40, step: 0.5, description: "Crown diameter", when: { key: "customize", in: [true] } }),
    num("trunkHeight", "Clear trunk", Math.round(sp.trunkFrac * 100), { group: D, unit: "%", min: 5, max: 90, step: 1, description: "Height to the lowest branches as a share of the total", when: { key: "customize", in: [true] }, advanced: true }),
    num("dbh", "Trunk diameter", sp.dbh, { group: D, unit: "m", min: 0.05, max: 3, step: 0.05, when: { key: "customize", in: [true] }, advanced: true }),
    color("foliage", "Foliage colour", rgbToHex(sp.color), { group: A, when: { key: "customize", in: [true] } }),
    color("trunkColor", "Trunk colour", rgbToHex(sp.trunk), { group: A, when: { key: "customize", in: [true] }, advanced: true }),
    num("scale", "Size (maturity)", 100, { group: D, unit: "%", min: 15, max: 200, step: 5, description: "Young planting ≈ 30 %, mature 100 %" }),
    choice("season", "Season", "summer", SEASONS, { group: A }),
    int("clumps", "Crown detail", 3, { group: A, min: 0, max: 6, advanced: true }),
    choice("form", "Model as", "detailed", [{ value: "detailed", label: "Detailed (shaped crown, casts shade)" }, { value: "simple", label: "Simple tree (counted by tree models)" }], { group: T, advanced: true }),
  ];
}

interface TreeResolved {
  spec: Parameters<typeof treeSolids>[0];
  simple: string;
  name: string;
}

function resolveTree(r: Reader, fixed: SpeciesPreset | null, seed: number): TreeResolved {
  const sp = fixed ?? SPECIES_PRESETS.find((s) => s.id === r.s("species")) ?? SPECIES_PRESETS[0];
  const cust = r.b("customize");
  const k = r.n("scale") / 100;
  const season = r.s("season");
  let color = cust ? hexToRgb(r.c("foliage"), sp.color) : sp.color;
  let accent: RGB | undefined;
  let bare = false;
  if (season === "autumn" && sp.autumn) color = sp.autumn;
  if (season === "spring" && sp.blossom) accent = sp.blossom;
  if (season === "summer" && sp.blossom && (sp.id === "crape_myrtle" || sp.id === "southern_magnolia" || sp.id === "desert_willow")) accent = sp.blossom;
  if (season === "winter" && !sp.evergreen) bare = true;
  return {
    spec: {
      shape: cust ? (r.s("crownShape") as CrownShape) : sp.shape,
      height: (cust ? r.n("height") : sp.height) * k,
      crown: (cust ? r.n("crown") : sp.crown) * k,
      trunkFrac: cust ? r.n("trunkHeight") / 100 : sp.trunkFrac,
      dbh: (cust ? r.n("dbh") : sp.dbh) * Math.sqrt(k),
      color,
      trunkColor: cust ? hexToRgb(r.c("trunkColor"), sp.trunk) : sp.trunk,
      clumps: r.n("clumps"),
      seed,
      accent,
      bare,
    },
    simple: sp.simple,
    name: sp.name,
  };
}

/** add one tree (prop or Tree entity) at world point p */
function addTree(out: Out, r: Reader, fixed: SpeciesPreset | null, p: Vec2, rotDeg: number, seed: number, primary: boolean, typeId: string) {
  const t = resolveTree(r, fixed, seed);
  const rad = t.spec.crown / 2;
  if (r.s("form") === "simple") return out.tree(p, rad, t.spec.height, t.simple, primary);
  const shadeR = t.spec.bare ? rad * 0.35 : rad;
  return out.prop(typeId, { c: p, a: (rotDeg * Math.PI) / 180, siteW: 0, siteD: 0 }, treeSolids(t.spec), { shade: { r: shadeR, h: t.spec.height }, primary, name: t.name });
}

function treeDef(sp: SpeciesPreset | null): PrimitiveDef {
  const base = sp ?? SPECIES_PRESETS[0];
  const params = treeParams(base, !sp);
  const id = sp ? `flora.tree_${sp.id}` : "flora.tree";
  return {
    id,
    name: sp ? sp.name : "Tree (any species)",
    category: FL,
    tags: sp ? ["tree", sp.latin.toLowerCase(), ...sp.tags] : ["tree", "shade tree", "street tree", "canopy", "plant", "vegetation"],
    description: sp ? `${sp.name} (${sp.latin}): ${sp.note.toLowerCase()}; ≈ ${sp.height} m tall, ${sp.crown} m spread at maturity.` : `A tree of any of ${SPECIES_PRESETS.length} species, or any crown shape, size and colour; casts shade in the heat and sun models.`,
    icon: sp && (sp.shape === "conical" || sp.shape === "layered" || sp.shape === "columnar") ? "tree-pine" : sp && (sp.shape === "palm" || sp.shape === "fan_palm") ? "tree-palm" : "tree-deciduous",
    placement: "point",
    params,
    generate(values, place, ctx) {
      const r = reader(values, params);
      const out = new Out(ctx);
      const f = frameOf(place);
      const seed = (hashSeed(ctx.ref?.instance ?? id) % 1000) / 1000;
      addTree(out, r, sp, f.c, (f.a * 180) / Math.PI, seed, true, id);
      const t = resolveTree(r, sp, seed);
      out.summary.push(`${t.name}: ${t.spec.height.toFixed(1)} m tall, ${t.spec.crown.toFixed(1)} m crown (≈ ${Math.round(Math.PI * (t.spec.crown / 2) ** 2)} m² canopy)`);
      return out.done();
    },
  };
}

/** species picker for multi-tree definitions */
const groupSpecies = (def: string, key = "species", label = "Species") =>
  choice(key, label, def, [{ value: "mixed", label: "Mixed (several species)" }, ...SPECIES_PRESETS.map((s) => ({ value: s.id, label: s.name }))], { group: P });

function pickSpecies(r: Reader, rand: () => number, mix: string[]): SpeciesPreset {
  const v = r.s("species");
  if (v !== "mixed") return SPECIES_PRESETS.find((s) => s.id === v) ?? SPECIES_PRESETS[0];
  const id = mix[Math.floor(rand() * mix.length)];
  return SPECIES_PRESETS.find((s) => s.id === id) ?? SPECIES_PRESETS[0];
}

const multiTreeParams = (def: string, spacing: number): ParamSpec[] => [
  groupSpecies(def),
  num("spacing", "Spacing", spacing, { group: P, unit: "m", min: 2, max: 60, step: 0.5, description: "Centre-to-centre; about one crown spread gives a continuous canopy" }),
  num("scale", "Size (maturity)", 100, { group: P, unit: "%", min: 15, max: 200, step: 5 }),
  num("sizeVariation", "Size variation", 15, { group: P, unit: "%", min: 0, max: 60, step: 5 }),
  choice("season", "Season", "summer", SEASONS, { group: A }),
  choice("form", "Model as", "detailed", [{ value: "detailed", label: "Detailed (shaped crowns)" }, { value: "simple", label: "Simple trees" }], { group: P, advanced: true }),
  int("seed", "Variation seed", 0, { group: P, min: 0, max: 9999, advanced: true, description: "0 = derived from the instance" }),
  bool("customize", "Override species form", false, { advanced: true, group: P }),
  int("clumps", "Crown detail", 2, { group: A, min: 0, max: 6, advanced: true }),
];

const MIX = ["live_oak", "red_oak", "cedar_elm", "red_maple", "london_plane", "ginkgo", "linden", "bur_oak"];

function plantMany(out: Out, r: Reader, pts: { p: Vec2; rot: number }[], seed: number, primaryFirst: boolean, typeId: string) {
  const rand = rng(seed);
  const vary = r.n("sizeVariation") / 100;
  pts.forEach((q, i) => {
    const sp = pickSpecies(r, rand, MIX);
    const k = 1 + (rand() * 2 - 1) * vary;
    const rr: Reader = { ...r, n: (key: string, fb?: number) => (key === "scale" ? r.n("scale") * k : r.n(key, fb)), s: (key: string, fb?: string) => (key === "species" ? sp.id : r.s(key, fb)) };
    addTree(out, rr, sp, q.p, q.rot + rand() * 360, rand(), primaryFirst && i === 0, typeId);
  });
}

const ROW_PARAMS: ParamSpec[] = [...multiTreeParams("cedar_elm", 9), num("offset", "Side offset", 0, { group: P, unit: "m", min: -40, max: 40, step: 0.5 }), bool("bothSides", "Both sides (allée)", false, { group: P }), num("rowGap", "Distance between rows", 14, { group: P, unit: "m", min: 3, max: 60, step: 0.5, when: { key: "bothSides", in: [true] } })];
const GROVE_PARAMS: ParamSpec[] = [...multiTreeParams("mixed", 10), choice("layout", "Layout", "natural", opts("natural", "grid", "orchard"), { group: P }), choice("ground", "Ground cover", "wood", [{ value: "wood", label: "Woodland floor" }, { value: "grass", label: "Grass" }, { value: "park", label: "Park" }, { value: "none", label: "None" }], { group: P }), num("width", "Width (if not drawn)", 40, { group: D, unit: "m", min: 5, max: 1000 }), num("depth", "Depth (if not drawn)", 30, { group: D, unit: "m", min: 5, max: 1000 })];

export const FLORA: PrimitiveDef[] = [
  treeDef(null),
  ...SPECIES_PRESETS.map((s) => treeDef(s)),
  {
    id: "flora.tree_row",
    name: "Row of trees",
    category: FL,
    tags: ["street trees", "allée", "avenue", "tree line", "boulevard trees", "windbreak"],
    description: "Trees at a regular spacing along a drawn line (street trees typically 7–12 m apart).",
    icon: "trees",
    placement: "path",
    params: ROW_PARAMS,
    generate(values, place, ctx) {
      const r = reader(values, ROW_PARAMS);
      const out = new Out(ctx);
      const base = place.path && place.path.length >= 2 ? place.path : defaultPath(place, 40);
      const lines = r.b("bothSides") ? [r.n("offset") + r.n("rowGap") / 2, r.n("offset") - r.n("rowGap") / 2] : [r.n("offset")];
      const pts: { p: Vec2; rot: number }[] = [];
      for (const off of lines) for (const st of stations(offsetPathLocal(base, off), r.n("spacing"))) pts.push({ p: st.p, rot: st.rot });
      plantMany(out, r, pts, seedOf(ctx, r), true, "flora.tree");
      out.summary.push(`${pts.length} trees along ${Math.round(pathLen(base))} m`);
      return out.done();
    },
  },
  {
    id: "flora.grove",
    name: "Grove / urban forest",
    category: FL,
    tags: ["woodland", "forest", "copse", "orchard", "tree cluster", "stand of trees", "miyawaki"],
    description: "Trees scattered or in an orchard grid over a drawn area, with woodland ground cover.",
    icon: "trees",
    placement: "polygon",
    params: GROVE_PARAMS,
    generate(values, place, ctx) {
      const r = reader(values, GROVE_PARAMS);
      const out = new Out(ctx);
      const { poly } = siteOf(place, r.n("width"), r.n("depth"));
      const g = r.s("ground");
      if (g !== "none") out.area(g as "wood", poly, { primary: true });
      const seed = seedOf(ctx, r);
      const sp = r.n("spacing");
      const pts = scatterIn(poly, sp, seed, r.s("layout") === "natural" ? 0.4 : 0, sp * 0.3).map((p) => ({ p, rot: 0 }));
      if (!pts.length) pts.push({ p: polyCentroid(poly), rot: 0 });
      plantMany(out, r, pts.slice(0, 1500), seed, false, "flora.tree");
      out.summary.push(`${Math.min(1500, pts.length)} trees over ${Math.round(polyArea(poly)).toLocaleString()} m²`);
      return out.done();
    },
  },
  propDef({
    id: "flora.shrub",
    name: "Shrub",
    category: FL,
    tags: ["bush", "shrubbery", "topiary", "boxwood", "succulent", "agave", "ornamental grass", "fern", "yucca"],
    description: "A shrub: mound, upright, spreading, clipped ball or cone topiary, succulent, grass clump or fern.",
    icon: "sprout",
    params: [choice("shape", "Form", "mound", opts("mound", "upright", "spreading", "topiary_ball", "topiary_cone", "succulent", "grass_clump", "fern"), { group: A }), num("width", "Spread", 1.4, { group: D, unit: "m", min: 0.2, max: 8, step: 0.1 }), num("height", "Height", 1.1, { group: D, unit: "m", min: 0.1, max: 6, step: 0.1 }), color("color", "Foliage", "#5e8a4c", { group: A, swatches: ["#5e8a4c", "#4e7a44", "#7a9a5c", "#8aa0a0", "#9a7a4c", "#7a5070"] }), bool("flowers", "Flowering", false, { group: A }), color("flowerColor", "Flower colour", "#e6c04a", { group: A, when: { key: "flowers", in: [true] } })],
    build: (r) => ({ solids: shrubSolids(r.s("shape") as ShrubShape, r.n("width"), r.n("height"), hexToRgb(r.c("color")), r.b("flowers") ? hexToRgb(r.c("flowerColor")) : undefined), cover: "planting" }),
  }),
  rowDef({
    id: "flora.shrub_row",
    name: "Row of shrubs",
    category: FL,
    tags: ["shrub border", "foundation planting", "hedge row", "screen planting"],
    description: "Shrubs at a regular spacing along a drawn line.",
    icon: "sprout",
    siting: { overlapProps: true },
    params: [choice("shape", "Form", "mound", opts("mound", "upright", "spreading", "topiary_ball", "topiary_cone", "succulent", "grass_clump"), { group: A }), num("spacing", "Spacing", 1.5, { group: D, unit: "m", min: 0.3, max: 10, step: 0.1 }), num("width", "Spread", 1.4, { group: D, unit: "m", min: 0.2, max: 6, step: 0.1 }), num("height", "Height", 1.1, { group: D, unit: "m", min: 0.1, max: 5, step: 0.1 }), color("color", "Foliage", "#5e8a4c", { group: A })],
    item: (r, i) => ({ solids: shrubSolids(r.s("shape") as ShrubShape, r.n("width"), r.n("height"), i % 3 ? hexToRgb(r.c("color")) : shade(hexToRgb(r.c("color")), 1.1), undefined, i), cover: "planting" }),
  }),
  areaDef({
    id: "flora.flower_bed",
    name: "Flower bed",
    category: FL,
    tags: ["flowers", "garden bed", "border", "annuals", "perennials", "parterre", "pollinator garden"],
    description: "Planted bed of flowers in drifts of colour over a drawn shape.",
    icon: "flower-2",
    type: "grass",
    defaultSize: [8, 3],
    params: [num("width", "Width (if not drawn)", 8, { group: D, unit: "m", min: 1, max: 200 }), num("depth", "Depth (if not drawn)", 3, { group: D, unit: "m", min: 0.5, max: 200 }), choice("palette", "Colour palette", "mixed", opts("mixed", "warm", "cool", "white", "pollinator"), { group: A }), num("density", "Plants per m²", 2, { group: P, min: 0.2, max: 6, step: 0.1, unit: "per m²" }), bool("edging", "Stone edging", true, { group: A })],
    extra: (r, out, site, f, ctx) => flowerPlants(r, out, site, ctx),
  }),
  areaDef({
    id: "flora.wildflower_meadow",
    name: "Wildflower meadow",
    category: FL,
    tags: ["meadow", "prairie", "native grassland", "no-mow", "pollinator", "rewilding"],
    description: "Unmown native meadow with scattered flowers and grasses; permeable, low-maintenance habitat.",
    icon: "flower",
    type: "grass",
    defaultSize: [40, 25],
    params: [num("width", "Width (if not drawn)", 40, { group: D, unit: "m", min: 3, max: 1000 }), num("depth", "Depth (if not drawn)", 25, { group: D, unit: "m", min: 3, max: 1000 }), choice("palette", "Colour palette", "pollinator", opts("mixed", "warm", "cool", "white", "pollinator"), { group: A }), num("density", "Flower clumps per m²", 0.4, { group: P, min: 0.05, max: 3, step: 0.05, unit: "per m²" })],
    extra: (r, out, site, f, ctx) => flowerPlants(r, out, site, ctx, true),
  }),
  areaDef({
    id: "flora.ornamental_grasses",
    name: "Ornamental grass bed",
    category: FL,
    tags: ["grasses", "miscanthus", "muhly", "xeriscape", "drought planting"],
    description: "Massed ornamental grasses (muhly, switchgrass, feather grass) over a drawn bed.",
    icon: "wheat",
    type: "grass",
    defaultSize: [10, 4],
    params: [num("width", "Width (if not drawn)", 10, { group: D, unit: "m", min: 1, max: 300 }), num("depth", "Depth (if not drawn)", 4, { group: D, unit: "m", min: 1, max: 300 }), num("height", "Grass height", 1.0, { group: D, unit: "m", min: 0.2, max: 3, step: 0.1 }), color("color", "Colour", "#b4a46a", { group: A, swatches: ["#b4a46a", "#c890a8", "#8aa070", "#d0c090"] }), num("spacing", "Spacing", 0.9, { group: P, unit: "m", min: 0.3, max: 3, step: 0.1 })],
    extra: (r, out, site, f, ctx) => {
      const pts = scatterIn(site, r.n("spacing"), seedOf(ctx), 0.4).slice(0, 600);
      const s: Solid[] = [];
      const c = polyCentroid(site);
      pts.forEach((p, i) => s.push(...moveSolids(shrubSolids("grass_clump", r.n("spacing") * 1.1, r.n("height"), i % 2 ? hexToRgb(r.c("color")) : shade(hexToRgb(r.c("color")), 1.1), undefined, i), p[0] - c[0], p[1] - c[1])));
      if (s.length) out.prop("flora.ornamental_grasses", { c, a: 0, siteW: 0, siteD: 0 }, s, { primary: false }).cover = "planting";
    },
  }),
  areaDef({
    id: "flora.lawn",
    name: "Lawn",
    category: FL,
    tags: ["grass", "turf", "green", "sod", "field"],
    description: "Mown grass over a drawn area.",
    icon: "square",
    type: "grass",
    params: [num("width", "Width (if not drawn)", 30, { group: D, unit: "m", min: 1, max: 2000 }), num("depth", "Depth (if not drawn)", 20, { group: D, unit: "m", min: 1, max: 2000 })],
  }),
  areaDef({
    id: "flora.woodland",
    name: "Woodland ground",
    category: FL,
    tags: ["forest floor", "natural area", "wood", "nature reserve", "greenbelt"],
    description: "Woodland land cover over a drawn area (add trees with Grove).",
    icon: "trees",
    type: "wood",
    params: [num("width", "Width (if not drawn)", 60, { group: D, unit: "m", min: 1, max: 5000 }), num("depth", "Depth (if not drawn)", 40, { group: D, unit: "m", min: 1, max: 5000 })],
  }),
  propDef({
    id: "flora.green_wall",
    name: "Green wall",
    category: FL,
    tags: ["living wall", "vertical garden", "trellis", "vine screen", "climbing plants"],
    description: "Freestanding planted wall or trellis screen with climbing plants.",
    icon: "layout-grid",
    params: [num("length", "Length", 6, { group: D, unit: "m", min: 0.5, max: 60, step: 0.1 }), num("height", "Height", 3, { group: D, unit: "m", min: 0.5, max: 20, step: 0.1 }), num("thickness", "Thickness", 0.4, { group: D, unit: "m", min: 0.1, max: 2, step: 0.05 }), color("color", "Foliage", "#4e7a44", { group: A }), bool("flowers", "Flowering", true, { group: A })],
    build: (r) => {
      const L = r.n("length"),
        h = r.n("height"),
        t = r.n("thickness");
      const c = hexToRgb(r.c("color"));
      const s: Solid[] = [box(0, 0, 0, L, t * 0.4, h, C.steelDark, "metal"), box(0, t * 0.15, 0.1, L * 0.98, t * 0.6, h - 0.1, c, "foliage"), box(0, -t * 0.15, 0.1, L * 0.98, t * 0.6, h - 0.1, shade(c, 1.1), "foliage")];
      if (r.b("flowers")) for (let i = 0; i < Math.min(40, Math.round(L * h * 0.6)); i++) s.push(S("sphere", [(((i * 37) % 100) / 100 - 0.5) * L * 0.9, t * 0.48, (((i * 61) % 100) / 100) * h * 0.85 + 0.1], [0.25, 0.1, 0.25], i % 2 ? C.yellow : [214, 96, 150], "foliage"));
      return { solids: s, cover: "planting" };
    },
  }),
];

function flowerPlants(r: Reader, out: Out, site: [number, number][][], ctx: GenerateContext, meadow = false) {
  const pal: Record<string, RGB[]> = {
    mixed: [[214, 96, 150], [232, 196, 64], [150, 120, 210], [240, 240, 236], [228, 128, 52]],
    warm: [[232, 196, 64], [228, 128, 52], [196, 58, 48], [240, 170, 90]],
    cool: [[150, 120, 210], [96, 130, 200], [200, 160, 220], [240, 240, 236]],
    white: [[244, 242, 236], [230, 226, 214], [214, 220, 200]],
    pollinator: [[150, 120, 210], [232, 196, 64], [214, 96, 150], [228, 128, 52], [240, 240, 236]],
  };
  const cols = pal[r.s("palette")] ?? pal.mixed;
  const dens = Math.max(0.05, r.n("density"));
  const area = polyArea(site);
  const n = Math.min(1500, Math.round(area * dens));
  const sp = Math.sqrt(area / Math.max(1, n));
  const pts = scatterIn(site, sp, seedOf(ctx), 0.45).slice(0, 1500);
  const c = polyCentroid(site);
  const s: Solid[] = [];
  const rand = rng(seedOf(ctx) + 7);
  for (const p of pts) {
    const col = cols[Math.floor(rand() * cols.length)];
    const h = meadow ? 0.5 + rand() * 0.5 : 0.3 + rand() * 0.3;
    s.push(S("hemisphere", [p[0] - c[0], p[1] - c[1], 0], [sp * 1.1, sp * 1.1, h * 0.6], meadow ? [128, 156, 92] : [96, 136, 76], "foliage"));
    s.push(S("sphere", [p[0] - c[0], p[1] - c[1], h * 0.45], [sp * 0.55, sp * 0.55, h * 0.35], col, "foliage"));
  }
  if (r.b("edging") && !meadow) {
    // a low stone kerb around the bed outline
    const ring = site[0];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.1) continue;
      s.push(S("box", [(a[0] + b[0]) / 2 - c[0], (a[1] + b[1]) / 2 - c[1], 0], [len, 0.15, 0.15], C.stone, "stone", (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI));
    }
  }
  if (s.length) out.prop(meadow ? "flora.wildflower_meadow" : "flora.flower_bed", { c, a: 0, siteW: 0, siteD: 0 }, s, { primary: false, height: 1 }).cover = "planting";
}

function offsetPathLocal(path: Vec2[], d: number): Vec2[] {
  return d === 0 ? path : offsetPath(path, d);
}
