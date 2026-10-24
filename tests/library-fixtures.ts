// Fixture primitives for the library framework tests (the real catalog lives in src/library/catalog).
import { rectangle } from "@/geometry/polygon";
import { getPrimitive, hexToRgb, registerPrimitive, type PrimitiveDef } from "@/library";
import type { Building, Prop, Tree, Vec2 } from "@/world/types";
import { polyBBox, pointInPoly } from "@/geometry/polygon";

const kiosk: PrimitiveDef = {
  id: "test.kiosk",
  name: "Test kiosk",
  category: "streetscape",
  tags: ["kiosk", "stall"],
  description: "A box kiosk with an optional shade canopy.",
  placement: "point",
  params: [
    { key: "width", label: "Width", type: "number", default: 2, min: 0.5, max: 10, unit: "m" },
    { key: "depth", label: "Depth", type: "number", default: 2, min: 0.5, max: 10, unit: "m" },
    { key: "height", label: "Height", type: "number", default: 2.6, min: 1, max: 6, unit: "m" },
    { key: "color", label: "Colour", type: "color", default: "#2e6db4" },
    { key: "canopy", label: "Shade canopy", type: "boolean", default: false },
    { key: "canopy_radius", label: "Canopy radius", type: "number", default: 3, min: 1, max: 8, when: { key: "canopy", in: [true] } },
  ],
  generate(p, place, ctx) {
    const w = p.width as number,
      d = p.depth as number,
      h = p.height as number;
    const solids: Prop["solids"] = [{ shape: "box", at: [0, 0, 0], size: [w, d, h], color: hexToRgb(p.color as string), material: "metal" }];
    const r = p.canopy_radius as number;
    if (p.canopy) solids.push({ shape: "cylinder", at: [0, 0, h], size: [2 * r, 2 * r, 0.2], color: [240, 240, 240], material: "fabric" });
    const prop: Prop = { id: ctx.id("p"), kind: "prop", type: "test.kiosk", p: place.at!, rot: place.rotation ?? 0, solids, height: h + (p.canopy ? 0.2 : 0), source: "test", provenance: "proposed", lib: { ...ctx.ref, primary: true }, ...(p.canopy ? { shade: { r, h: h + 0.2 } } : {}) };
    return { props: [prop], summary: [`Kiosk ${w}×${d} m`] };
  },
};

const block: PrimitiveDef = {
  id: "test.block",
  name: "Test block",
  category: "housing",
  tags: ["apartment", "block"],
  description: "A rectangular block of flats.",
  placement: "rect",
  params: [
    { key: "width", label: "Width", type: "number", default: 30, min: 6, max: 200, unit: "m" },
    { key: "depth", label: "Depth", type: "number", default: 20, min: 6, max: 200, unit: "m" },
    { key: "floors", label: "Floors", type: "integer", default: 4, min: 1, max: 60 },
    { key: "use", label: "Use", type: "enum", default: "residential", options: [{ value: "residential", label: "Residential" }, { value: "office", label: "Office" }, { value: "mixed", label: "Mixed" }] },
    { key: "units", label: "Homes", type: "integer", default: 0, min: 0, max: 2000, description: "0 = from floor area" },
    { key: "with_tree", label: "Tree in front", type: "boolean", default: false },
  ],
  generate(p, place, ctx) {
    const at = place.at!;
    const ring = rectangle(at, p.width as number, p.depth as number, ((place.rotation ?? 0) * Math.PI) / 180);
    const top = (p.floors as number) * 3.2;
    const use = p.use as Building["use"];
    const program: Building["program"] = use === "mixed" ? { residential: 0.8, retail: 0.2 } : { [use]: 1 };
    const b: Building = {
      id: ctx.id("b"),
      kind: "building",
      footprint: [ring],
      masses: [{ poly: [ring], base: 0, top, role: "body" }],
      height: top,
      floors: p.floors as number,
      use,
      program,
      name: `Block of ${p.floors} floors`,
      ground: NaN,
      heightSource: "proposed",
      useSource: "proposed",
      source: "",
      lib: { ...ctx.ref, primary: true },
    };
    const gfa = (p.width as number) * (p.depth as number) * (p.floors as number);
    if ((p.units as number) > 0) b.occupancy = { units: p.units as number, gfa };
    const trees: Tree[] = [];
    if (p.with_tree) trees.push({ id: ctx.id("t"), kind: "tree", p: [at[0], at[1] - (p.depth as number) / 2 - 8], r: 4, h: 9, source: "", provenance: "proposed", lib: ctx.ref });
    return { buildings: [b], trees };
  },
};

const grove: PrimitiveDef = {
  id: "test.grove",
  name: "Test grove",
  category: "parks",
  description: "A park with trees on a grid.",
  placement: "polygon",
  params: [
    { key: "spacing", label: "Tree spacing", type: "number", default: 12, min: 4, max: 40 },
    { key: "crown", label: "Crown radius", type: "number", default: 4, min: 1, max: 10 },
  ],
  generate(p, place, ctx) {
    const site = place.site!;
    const [x0, y0, x1, y1] = polyBBox(site);
    const sp = p.spacing as number;
    const trees: Tree[] = [];
    for (let x = x0 + sp / 2; x < x1; x += sp) for (let y = y0 + sp / 2; y < y1; y += sp) if (pointInPoly([x, y] as Vec2, site)) trees.push({ id: ctx.id("t"), kind: "tree", p: [x, y], r: p.crown as number, h: 10, source: "", provenance: "proposed", lib: ctx.ref });
    return { areas: [{ id: ctx.id("a"), kind: "area", type: "park", poly: site, source: "", provenance: "proposed", name: "Grove", lib: { ...ctx.ref, primary: true } }], trees };
  },
};

const lane: PrimitiveDef = {
  id: "test.lane",
  name: "Test lane",
  category: "transport",
  description: "A local street with bollards along it.",
  placement: "path",
  params: [{ key: "cls", label: "Class", type: "enum", default: "residential", options: [{ value: "residential", label: "Local" }, { value: "living", label: "Living street" }] }, { key: "label", label: "Label", type: "text", default: "" }],
  generate(p, place) {
    return { streets: [{ path: place.path!, cls: p.cls as "residential", name: (p.label as string) || undefined }] };
  },
};

const hump: PrimitiveDef = {
  id: "test.hump",
  name: "Test speed hump",
  category: "streetscape",
  description: "A speed hump (stands in the carriageway).",
  placement: "point",
  siting: { carriageway: true },
  params: [],
  generate(_p, place, ctx) {
    return { props: [{ id: ctx.id("p"), kind: "prop", type: "test.hump", p: place.at!, rot: place.rotation ?? 0, solids: [{ shape: "box", at: [0, 0, 0], size: [4, 1, 0.1], color: [200, 200, 0] }], height: 0.1, source: "", provenance: "proposed", lib: { ...ctx.ref, primary: true } }] };
  },
};

export function registerFixtures() {
  for (const d of [kiosk, block, grove, lane, hump]) if (!getPrimitive(d.id)) registerPrimitive(d);
}
