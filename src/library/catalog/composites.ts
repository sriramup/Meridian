// Composites: multi-primitive ensembles generated from the other definitions — a college campus,
// a residential subdivision with its streets, a shopping centre, a mixed-use block, a town square
// and a business park. Every entity belongs to the one composite instance (re-configured together).

import { fmtDims, fmtFloorArea } from "@/lib/units";
import type { Polygon, Vec2 } from "@/world/types";
import { difference, polyArea } from "@/geometry/polygon";
import type { GenerateContext, ParamValues, PlacementInput, PrimitiveDef } from "../types";
import { validateParams } from "../registry";
import { type Frame, frameOf, polyToWorld, rng, subFrame, toWorld } from "../geometry/frame";
import { benchSolids, lampSolids, treeSolids } from "../geometry/props";
import { C } from "../geometry/palette";
import { BUILDING_PARAMS, buildBuilding } from "./building";
import { COMMERCIAL } from "./commercial";
import { HOUSING } from "./housing";
import { areaL, rectL, parkingLot } from "./decor";
import { playgroundSolids } from "./recreation";
import { Out } from "./make";
import { parkInto } from "./parks";
import { bool, choice, int, num, opts, reader } from "./params";
import { PARKS, fountainSolids, statueSolids } from "./parks";
import { CIVIC, EDUCATION } from "./civic";
import { seedOf } from "./kinds";
import { RECREATION } from "./recreation";

const CO = "composites" as const;
const L = "Layout",
  B = "Buildings";

const byId = (list: PrimitiveDef[], id: string) => list.find((d) => d.id === id)!;

/** run a child definition into `out` (defaults filled in), its entities joining the composite */
function child(out: Out, def: PrimitiveDef, params: ParamValues, place: PlacementInput) {
  const { params: p } = validateParams(def, params);
  out.include(def.generate(p, place, out.ctx));
}

/** a building from the universal schema at a local position in `f` */
function bld(out: Out, f: Frame, at: Vec2, rotDeg: number, params: ParamValues, primary = false) {
  return buildBuilding(out, reader({ fitToSite: false, ...params }, BUILDING_PARAMS), subFrame(f, at, rotDeg), {}, primary);
}

function streetTree(out: Out, p: Vec2, seed: number, scale = 0.8) {
  const t = treeSolids({ shape: "vase", height: 13 * scale, crown: 9 * scale, trunkFrac: 0.35, dbh: 0.4, color: [96, 134, 74], trunkColor: C.trunk, clumps: 2, seed });
  out.prop("flora.tree", { c: p, a: seed * 6, siteW: 0, siteD: 0 }, t, { primary: false, shade: { r: 4.5 * scale, h: 13 * scale }, anchorR: 0.5 });
}

function siteFrame(place: PlacementInput, w: number, d: number): Frame {
  const f = frameOf(place);
  return f.siteW > 0 ? f : { ...f, siteW: w, siteD: d };
}

const STYLE_OPTS = [
  { value: "collegiate", label: "Collegiate (brick, pitched roofs)" },
  { value: "modern", label: "Modern (glass and metal)" },
  { value: "mission", label: "Mission revival (stucco, tile)" },
];
const STYLE: Record<string, ParamValues> = {
  collegiate: { facade: "brick_red", roofType: "hip", roofPitch: 25, roofMaterial: "slate", parapetHeight: 0 },
  modern: { facade: "glass_green", roofType: "flat", parapetHeight: 1, greenRoof: true },
  mission: { facade: "stucco_cream", roofType: "hip", roofPitch: 22, roofMaterial: "terracotta", parapetHeight: 0 },
};

export const COMPOSITES: PrimitiveDef[] = [
  {
    id: "composites.college_campus",
    name: "College campus",
    category: CO,
    tags: ["university", "campus", "college", "quad", "academic village", "school campus"],
    description: "A campus around a central quad: academic halls, a domed library, student union, dormitories, paths, trees and parking.",
    icon: "graduation-cap",
    placement: "rect",
    params: [
      num("width", "Width (if not drawn)", 320, { group: L, unit: "m", min: 150, max: 2000, step: 5 }),
      num("depth", "Depth (if not drawn)", 240, { group: L, unit: "m", min: 120, max: 2000, step: 5 }),
      num("quadWidth", "Quad width", 90, { group: L, unit: "m", min: 30, max: 400, step: 5 }),
      num("quadDepth", "Quad depth", 70, { group: L, unit: "m", min: 30, max: 400, step: 5 }),
      choice("style", "Architecture", "collegiate", STYLE_OPTS, { group: B }),
      int("floors", "Academic floors", 4, { group: B, min: 1, max: 20 }),
      int("halls", "Academic halls per side", 2, { group: B, min: 1, max: 6 }),
      bool("dorms", "Dormitories", true, { group: B }),
      int("dormFloors", "Dorm floors", 6, { group: B, min: 2, max: 30, when: { key: "dorms", in: [true] } }),
      bool("parking", "Parking", true, { group: L }),
      int("seed", "Variation seed", 0, { group: L, min: 0, max: 9999, advanced: true }),
    ],
    generate(values, place, ctx) {
      const r = reader(values, this.params);
      const out = new Out(ctx);
      const f = siteFrame(place, r.n("width"), r.n("depth"));
      const W = f.siteW,
        D = f.siteD;
      out.area("campus", polyToWorld(f, rectL(0, 0, W, D)), { primary: true, name: r.s("name") || "Campus" });
      const qw = Math.min(r.n("quadWidth"), W * 0.6),
        qd = Math.min(r.n("quadDepth"), D * 0.5);
      // the quad: lawn with cross paths and trees around its edge
      out.area("grass", polyToWorld(f, rectL(0, 0, qw, qd)), { primary: false, name: "Quad" });
      for (const [a, b] of [[[-qw / 2, -qd / 2], [qw / 2, qd / 2]], [[-qw / 2, qd / 2], [qw / 2, -qd / 2]], [[-qw / 2, 0], [qw / 2, 0]]] as [Vec2, Vec2][]) out.path([toWorld(f, a), toWorld(f, b)], "footway", { primary: false });
      const seed = seedOf(ctx, r);
      for (let x = -qw / 2 + 6; x <= qw / 2 - 6; x += 12) for (const y of [-qd / 2 + 4, qd / 2 - 4]) streetTree(out, toWorld(f, [x, y]), x * 0.1 + y);
      const st = STYLE[r.s("style")] ?? STYLE.collegiate;
      const fl = r.n("floors");
      const n = r.n("halls");
      const depth = 18;
      // academic halls lining the long sides of the quad, facing in
      for (const sg of [-1, 1]) {
        const len = (qw - (n - 1) * 8) / n;
        for (let i = 0; i < n; i++) {
          const x = -qw / 2 + len / 2 + i * (len + 8);
          bld(out, f, [x, sg * (qd / 2 + 6 + depth / 2)], sg > 0 ? 180 : 0, { ...st, use: "education", width: len, depth, floors: fl, groundFloorHeight: 4.8, floorHeight: 4.2, name: `Hall ${sg > 0 ? "N" : "S"}${i + 1}` });
        }
      }
      // library with a dome at the head of the quad, student union at the foot
      const lib = bld(out, f, [qw / 2 + 26, 0], 90, { ...st, use: "education", shape: "rect", width: Math.min(60, qd), depth: 34, floors: 3, groundFloorHeight: 6, floorHeight: 5, roofType: "flat", parapetHeight: 1.2, name: "Library" });
      if (lib) {
        const [x0, y0, x1, y1] = lib.bbox;
        lib.addSolids([{ shape: "cylinder", at: [(x0 + x1) / 2, (y0 + y1) / 2, lib.height], size: [16, 16, 4], color: [236, 230, 216], material: "stone" }, { shape: "hemisphere", at: [(x0 + x1) / 2, (y0 + y1) / 2, lib.height + 4], size: [16, 16, 10], color: [110, 168, 150], material: "metal" }]);
      }
      bld(out, f, [-qw / 2 - 24, 0], -90, { ...st, use: "civic", shape: "l", width: Math.min(55, qd), depth: 32, wing: 14, wing2: 14, floors: 2, groundFloorHeight: 5, name: "Student union", jobs: 40 });
      // dorms on the outer band
      if (r.b("dorms")) {
        const rand = rng(seed);
        const dx = Math.min(W / 2 - 25, qw / 2 + 70);
        for (const sg of [-1, 1]) if (D / 2 - (qd / 2 + 6 + depth + 30) > 20) bld(out, f, [sg * Math.min(dx, W / 2 - 40) * 0.5, sg * (qd / 2 + depth + 45)], 0, { ...st, use: "residential", shape: rand() < 0.5 ? "l" : "u", width: 60, depth: 36, wing: 14, wing2: 14, floors: r.n("dormFloors"), unitSize: 40, name: "Residence hall" });
      }
      if (r.b("parking") && W / 2 - qw / 2 - 70 > 25) {
        const pw = Math.min(90, W / 2 - qw / 2 - 70);
        const s = parkingLot(out, f, W / 2 - pw / 2 - 5, -D / 2 + 30, pw, 54, { lamps: true });
        out.summary.push(`${s} parking stalls`);
      }
      out.summary.unshift(`Campus ${fmtDims(W, D)} around a ${fmtDims(qw, qd)} quad`);
      return out.done();
    },
  },
  {
    id: "composites.residential_subdivision",
    name: "Residential subdivision",
    category: CO,
    tags: ["housing development", "neighbourhood", "suburb", "tract housing", "estate", "cul-de-sac", "single-family neighborhood"],
    description: "Local streets with single-family lots on both sides: houses with yards and driveways, street trees and sidewalks.",
    icon: "home",
    placement: "rect",
    params: [
      num("width", "Width (if not drawn)", 240, { group: L, unit: "m", min: 60, max: 2000, step: 5 }),
      num("depth", "Depth (if not drawn)", 120, { group: L, unit: "m", min: 50, max: 2000, step: 5 }),
      num("lotWidth", "Lot frontage", 18, { group: L, unit: "m", min: 8, max: 60, step: 0.5, description: "Typical 50–80 ft" }),
      num("lotDepth", "Lot depth", 36, { group: L, unit: "m", min: 15, max: 100, step: 0.5 }),
      choice("houseType", "Houses", "mixed", [{ value: "mixed", label: "Mixed styles" }, { value: "single_family_home", label: "Two-storey homes" }, { value: "ranch_house", label: "Ranch houses" }, { value: "cottage", label: "Cottages" }, { value: "duplex", label: "Duplexes" }, { value: "townhouse", label: "Townhouses" }], { group: B }),
      bool("streets", "Build the streets", true, { group: L, description: "Local streets through the subdivision (spliced into the network)" }),
      bool("streetTrees", "Street trees", true, { group: L }),
      int("seed", "Variation seed", 0, { group: L, min: 0, max: 9999, advanced: true }),
    ],
    generate(values, place, ctx) {
      const r = reader(values, this.params);
      const out = new Out(ctx);
      const f = siteFrame(place, r.n("width"), r.n("depth"));
      const W = f.siteW,
        D = f.siteD;
      const lw = r.n("lotWidth"),
        ld = r.n("lotDepth");
      const row = 16; // local street right-of-way
      const bands = Math.max(1, Math.floor(D / (2 * ld + row)));
      const rand = rng(seedOf(ctx, r));
      const types = ["single_family_home", "ranch_house", "cottage", "l_shaped_house"];
      const facades = ["siding_white", "siding_blue", "siding_sage", "brick_red", "stucco_cream", "siding_yellow", "brick_buff"];
      let homes = 0;
      const total = bands * (2 * ld + row);
      for (let b = 0; b < bands; b++) {
        const yc = -total / 2 + row / 2 + ld + b * (2 * ld + row);
        if (r.b("streets")) out.streets.push({ path: [toWorld(f, [-W / 2, yc]), toWorld(f, [W / 2, yc])], cls: "residential", name: `${r.s("name") || "Subdivision"} Lane ${b + 1}`, trees: false });
        const nLots = Math.max(1, Math.floor(W / lw));
        for (const sg of [-1, 1]) {
          for (let i = 0; i < nLots; i++) {
            const x = -W / 2 + lw / 2 + i * lw;
            const lotC: Vec2 = [x, yc + sg * (row / 2 + ld / 2)];
            const ht = r.s("houseType");
            const lotFrame = subFrame(f, lotC, sg > 0 ? 180 : 0);
            if (ht === "townhouse") {
              if (i % 4 === 0) child(out, byId(HOUSING, "housing.townhouse_row"), { count: Math.min(4, nLots - i) * 2, unitWidth: lw / 2, depth: 12, fitToSite: false }, { at: toWorld(lotFrame, [-sg * lw * 1.5, ld / 2 - 5 - 6]), rotation: (((lotFrame.a * 180) / Math.PI) % 360 + 360) % 360 });
              homes += i % 4 === 0 ? Math.min(4, nLots - i) * 2 : 0;
              continue;
            }
            const t = ht === "mixed" ? types[Math.floor(rand() * types.length)] : ht;
            const def = byId(HOUSING, `housing.${t}`);
            const fw = Math.min(lw - 4, def.params.find((p) => p.key === "width")!.default as number);
            const hd = Math.min(ld - 10, def.params.find((p) => p.key === "depth")!.default as number);
            const garage = lw - fw > 8.5 ? "attached" : "none";
            const params: ParamValues = { width: garage === "attached" ? Math.min(fw, lw - 8.5) : fw, depth: hd, yard: true, frontSetback: 6, rearSetback: Math.max(2, ld - 6 - hd), sideSetback: Math.max(0.5, (lw - fw) / 2 - 0.5), driveway: true, garage, garageCars: 2, facade: facades[Math.floor(rand() * facades.length)] };
            // houses face the street: local +y of the lot frame points at the street
            child(out, def, params, { at: toWorld(lotFrame, [garage === "attached" ? -3.5 : 0, ld / 2 - 6 - hd / 2]), rotation: (((lotFrame.a * 180) / Math.PI) % 360 + 360) % 360 });
            homes += t === "duplex" ? 2 : 1;
            if (r.b("streetTrees")) streetTree(out, toWorld(f, [x + lw / 2 - 2, yc + sg * (row / 2 + 2.5)]), rand(), 0.7);
          }
        }
      }
      // make the first house the primary entity (inspector edits the instance through it)
      if (out.buildings[0]) out.setPrimary(out.buildings[0]);
      out.summary.unshift(`Subdivision: ${homes} homes on ${bands} street${bands > 1 ? "s" : ""}, lots ${fmtDims(lw, ld)}`);
      return out.done();
    },
  },
  {
    id: "composites.shopping_centre",
    name: "Shopping centre with parking",
    category: CO,
    tags: ["shopping center", "retail park", "power center", "plaza", "strip center", "anchor store"],
    description: "Anchor supermarket and in-line shops in an L around a shared parking field, with pad restaurants at the street edge.",
    icon: "shopping-cart",
    placement: "rect",
    params: [num("width", "Width (if not drawn)", 220, { group: L, unit: "m", min: 100, max: 1000, step: 5 }), num("depth", "Depth (if not drawn)", 160, { group: L, unit: "m", min: 80, max: 800, step: 5 }), int("pads", "Pad buildings", 2, { group: B, min: 0, max: 6 }), bool("gasStation", "Gas station", false, { group: B })],
    generate(values, place, ctx) {
      const r = reader(values, this.params);
      const out = new Out(ctx);
      const f = siteFrame(place, r.n("width"), r.n("depth"));
      const W = f.siteW,
        D = f.siteD;
      const anchor = bld(out, f, [-W / 2 + 40, D / 2 - 32], 180, { use: "retail", width: 70, depth: 55, floors: 1, groundFloorHeight: 7.5, facade: "brick_buff", parapetHeight: 1.6, awning: true, name: "Anchor store" }, true);
      bld(out, f, [(-W / 2 + 80 + W / 2 - 4) / 2, D / 2 - 15], 180, { use: "retail", width: W - 84, depth: 24, floors: 1, groundFloorHeight: 5.5, facade: "stucco_cream", parapetHeight: 1.6, awning: true, awningColor: "#3c6ca8", name: "In-line shops" });
      const lotD = D - 64 - 26;
      const s = parkingLot(out, f, 0, D / 2 - 64 - lotD / 2, W - 10, lotD, { lamps: true, trees: true });
      const n = r.n("pads");
      for (let i = 0; i < n; i++) bld(out, f, [-W / 2 + ((W - (r.b("gasStation") ? 50 : 0)) * (i + 0.5)) / n, -D / 2 + 13], 0, { use: "retail", width: 20, depth: 16, floors: 1, groundFloorHeight: 5, facade: i % 2 ? "stucco_terracotta" : "brick_red", awning: true, name: "Pad restaurant" });
      if (r.b("gasStation")) child(out, byId(COMMERCIAL, "commercial.gas_station"), {}, { at: toWorld(f, [W / 2 - 25, -D / 2 + 22]), rotation: (f.a * 180) / Math.PI });
      if (anchor) out.setPrimary(anchor.building);
      out.summary.unshift(`Shopping centre: anchor + in-line shops, ${s} parking stalls`);
      return out.done();
    },
  },
  {
    id: "composites.mixed_use_block",
    name: "Mixed-use block",
    category: CO,
    tags: ["urban block", "perimeter block", "main street block", "transit-oriented development", "tod", "infill block"],
    description: "A city block of mixed-use buildings (shops below, homes / offices above) around a shared courtyard, with street trees.",
    icon: "building",
    placement: "rect",
    params: [num("width", "Width (if not drawn)", 110, { group: L, unit: "m", min: 40, max: 400, step: 1 }), num("depth", "Depth (if not drawn)", 80, { group: L, unit: "m", min: 30, max: 400, step: 1 }), int("floors", "Floors", 6, { group: B, min: 2, max: 40 }), int("buildings", "Buildings per long side", 3, { group: B, min: 1, max: 10 }), num("barDepth", "Building depth", 16, { group: B, unit: "m", min: 8, max: 30, step: 0.5 }), choice("upperUse", "Upper floors", "residential", opts("residential", "office", "hotel"), { group: B }), bool("tower", "Corner tower", false, { group: B }), bool("streetTrees", "Street trees", true, { group: L })],
    generate(values, place, ctx) {
      const r = reader(values, this.params);
      const out = new Out(ctx);
      const f = siteFrame(place, r.n("width"), r.n("depth"));
      const W = f.siteW,
        D = f.siteD;
      const bd = Math.min(r.n("barDepth"), D / 2 - 4);
      const n = r.n("buildings");
      const facades = ["brick_red", "precast_white", "brick_buff", "stucco_cream", "metal_dark", "limestone"];
      const fl = r.n("floors");
      let k = 0;
      for (const sg of [-1, 1]) {
        const len = W / n;
        for (let i = 0; i < n; i++) bld(out, f, [-W / 2 + len * (i + 0.5), sg * (D / 2 - bd / 2)], sg > 0 ? 180 : 0, { use: r.s("upperUse"), groundUse: "retail", width: len - 0.3, depth: bd, floors: fl + ((i + (sg > 0 ? 1 : 0)) % 2), groundFloorHeight: 5, facade: facades[k++ % facades.length], awning: i % 2 === 0, balconies: r.s("upperUse") === "residential" }, k === 1);
      }
      // short sides
      for (const sg of [-1, 1]) bld(out, f, [sg * (W / 2 - bd / 2), 0], sg > 0 ? 90 : -90, { use: r.s("upperUse"), groundUse: "retail", width: D - 2 * bd - 0.6, depth: bd, floors: fl, groundFloorHeight: 5, facade: facades[k++ % facades.length] });
      if (r.b("tower")) bld(out, f, [W / 2 - 15, D / 2 - 15], 0, { use: r.s("upperUse"), width: 26, depth: 26, floors: fl * 3, groundFloorHeight: 5, facade: "glass_blue", penthouse: true });
      out.area("grass", polyToWorld(f, rectL(0, 0, W - 2 * bd - 2, D - 2 * bd - 2)), { primary: false, name: "Courtyard" });
      if (r.b("streetTrees")) for (const sg of [-1, 1]) for (let x = -W / 2 + 6; x <= W / 2 - 6; x += 9) streetTree(out, toWorld(f, [x, sg * (D / 2 + 3)]), x);
      out.summary.unshift(`Mixed-use block ${fmtDims(W, D)}, ${fl} floors`);
      return out.done();
    },
  },
  {
    id: "composites.town_square",
    name: "Town square",
    category: CO,
    tags: ["town centre", "main square", "civic square", "village green", "courthouse square", "market square"],
    description: "A central plaza with a fountain or statue, framed by a town hall and main-street shopfronts.",
    icon: "landmark",
    placement: "rect",
    params: [num("width", "Width (if not drawn)", 160, { group: L, unit: "m", min: 80, max: 600, step: 5 }), num("depth", "Depth (if not drawn)", 130, { group: L, unit: "m", min: 60, max: 600, step: 5 }), choice("centre", "Centrepiece", "fountain", opts("fountain", "statue", "gazebo", "lawn"), { group: L }), int("shopFloors", "Shopfront floors", 3, { group: B, min: 1, max: 8 }), bool("townHall", "Town hall", true, { group: B })],
    generate(values, place, ctx) {
      const r = reader(values, this.params);
      const out = new Out(ctx);
      const f = siteFrame(place, r.n("width"), r.n("depth"));
      const W = f.siteW,
        D = f.siteD;
      const pw = W - 50,
        pd = D - 50;
      const sq = polyToWorld(f, rectL(0, 0, pw, pd));
      out.area("plaza", sq, { primary: true, name: r.s("name") || "Town square" });
      const c = toWorld(f, [0, 0]);
      const cf: Frame = { c, a: f.a, siteW: 0, siteD: 0 };
      const cp = r.s("centre");
      if (cp === "fountain") out.prop("water.fountain", cf, fountainSolids("tiered", 12, C.stone), { primary: false }).cover = "water";
      else if (cp === "statue") out.prop("landmarks.statue", cf, statueSolids(3.5, 2.5, C.bronze, C.granite, "equestrian"), { primary: false });
      else if (cp === "gazebo") child(out, byId(PARKS, "parks.gazebo"), { diameter: 8 }, { at: c });
      else out.area("grass", polyToWorld(f, rectL(0, 0, pw * 0.5, pd * 0.5)), { primary: false });
      for (let x = -pw / 2 + 5; x <= pw / 2 - 5; x += 10) for (const y of [-pd / 2 + 4, pd / 2 - 4]) streetTree(out, toWorld(f, [x, y]), x + y, 0.75);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        out.prop("streetscape.bench", subFrame(f, [Math.cos(a) * 14, Math.sin(a) * 14], (a * 180) / Math.PI + 90), benchSolids("classic", 1.8), { primary: false });
      }
      for (const [x, y] of [[-pw / 2 + 2, -pd / 2 + 2], [pw / 2 - 2, -pd / 2 + 2], [pw / 2 - 2, pd / 2 - 2], [-pw / 2 + 2, pd / 2 - 2]] as Vec2[]) out.prop("streetscape.street_lamp", subFrame(f, [x, y]), lampSolids("historic", 4.5), { primary: false, anchorR: 0.3 });
      // frame: town hall at the head, shopfronts on the other three sides
      if (r.b("townHall")) child(out, byId(CIVIC, "civic.city_hall"), { width: Math.min(70, W * 0.45), depth: 22, shape: "rect", forecourt: false, floors: 3 }, { at: toWorld(f, [0, D / 2 + 2]), rotation: ((f.a * 180) / Math.PI + 180) % 360 });
      const fl = r.n("shopFloors");
      const shops: [Vec2, number, number][] = [[[0, -D / 2 - 9], 0, W], [[-W / 2 - 9, 0], -90, D], [[W / 2 + 9, 0], 90, D]];
      const facades = ["brick_red", "brick_buff", "stucco_cream", "limestone", "brick_brown", "stucco_pink"];
      let k = 0;
      for (const [p, rot, len] of shops) {
        const n = Math.max(2, Math.floor(len / 9));
        const fr = subFrame(f, p, rot);
        for (let i = 0; i < n; i++) bld(out, fr, [-len / 2 + (len * (i + 0.5)) / n, 0], 0, { use: "residential", groundUse: "retail", width: len / n - 0.2, depth: 16, floors: fl + (k % 3 === 0 ? 1 : 0), groundFloorHeight: 4.8, facade: facades[k++ % facades.length], awning: true, awningColor: ["#b65a3c", "#2a5a3c", "#3c6ca8"][k % 3], parapetHeight: 1.3 });
      }
      out.summary.unshift(`Town square ${fmtDims(pw, pd)}`);
      return out.done();
    },
  },
  {
    id: "composites.business_park",
    name: "Business park",
    category: CO,
    tags: ["office park", "corporate campus", "tech campus", "research park", "industrial estate"],
    description: "Office buildings on landscaped grounds with a pond, paths and surface parking.",
    icon: "briefcase",
    placement: "rect",
    params: [num("width", "Width (if not drawn)", 300, { group: L, unit: "m", min: 120, max: 2000, step: 5 }), num("depth", "Depth (if not drawn)", 200, { group: L, unit: "m", min: 80, max: 2000, step: 5 }), int("buildings", "Office buildings", 4, { group: B, min: 1, max: 16 }), int("floors", "Floors", 4, { group: B, min: 1, max: 30 }), bool("pond", "Pond", true, { group: L }), bool("parking", "Parking", true, { group: L })],
    generate(values, place, ctx) {
      const r = reader(values, this.params);
      const out = new Out(ctx);
      const f = siteFrame(place, r.n("width"), r.n("depth"));
      const W = f.siteW,
        D = f.siteD;
      const site: Polygon = polyToWorld(f, rectL(0, 0, W, D));
      const n = r.n("buildings");
      const cols = Math.ceil(Math.sqrt(n * (W / D)));
      const rows = Math.ceil(n / cols);
      const fac = ["glass_blue", "glass_green", "metal_silver", "precast_white"];
      const bw = Math.max(20, Math.min(60, W / cols - 30)),
        bdp = Math.max(14, Math.min(32, D / rows - 50));
      const avoid: { c: Vec2; r: number }[] = [];
      let first: ReturnType<typeof bld> = null;
      for (let i = 0; i < n; i++) {
        const cx = -W / 2 + (W * ((i % cols) + 0.5)) / cols,
          cy = -D / 2 + (D * (Math.floor(i / cols) + 0.5)) / rows;
        const b = bld(out, f, [cx, cy + 10], 0, { use: "office", shape: i % 3 === 1 ? "l" : "rect", width: bw, depth: bdp, wing: 16, wing2: 16, floors: r.n("floors"), facade: fac[i % fac.length], penthouse: true, groundFloorHeight: 5 });
        if (b && !first) first = b;
        avoid.push({ c: toWorld(f, [cx, cy + 10]), r: Math.hypot(bw, bdp) / 2 + 5 });
        if (r.b("parking")) {
          parkingLot(out, f, cx, cy + 10 - bdp / 2 - 13, bw, 18, { lamps: false });
          avoid.push({ c: toWorld(f, [cx, cy + 10 - bdp / 2 - 13]), r: Math.hypot(bw, 18) / 2 + 2 });
        }
      }
      parkInto(out, reader({ paths: "loop", pathInset: 8, treeSpacing: 20, treeCover: 55, benches: 6, playground: false, pond: r.b("pond"), flowerBeds: 2, species: "mixed", treeSize: 90, lamps: true, pavilion: false }, PARKS[0].params), site, ctx, false, avoid);
      // paths and trees from the park run through the grounds; buildings carve them in the placement op
      if (first) out.setPrimary(first.building);
      out.summary.unshift(`Business park: ${n} office buildings of ${r.n("floors")} floors`);
      return out.done();
    },
  },
];

// ---------------------------------------------------------------- urban schools and campus blocks

const SCHOOL_LEVELS: Record<string, { pupils: number; m2: number; floors: number; field: "soccer" | "track"; fieldL: number; fieldW: number; gym: [number, number]; courts: number; play: boolean; label: string }> = {
  // m² GFA per pupil and youth field sizes: US state school-facility guides / US Youth Soccer small-sided fields
  primary: { pupils: 600, m2: 10, floors: 3, field: "soccer", fieldL: 60, fieldW: 40, gym: [32, 24], courts: 1, play: true, label: "Elementary school" },
  middle: { pupils: 800, m2: 13, floors: 3, field: "soccer", fieldL: 91, fieldW: 55, gym: [40, 30], courts: 2, play: false, label: "Middle school" },
  high: { pupils: 1600, m2: 15, floors: 4, field: "track", fieldL: 176, fieldW: 92, gym: [50, 36], courts: 3, play: false, label: "High school" },
};

const SCHOOL_FACADES = ["brick_red", "brick_buff", "limestone", "brick_brown", "precast_white"];

function urbanSchool(values: ParamValues, place: PlacementInput, ctx: GenerateContext, params: PrimitiveDef["params"]) {
  const r = reader(values, params);
  const out = new Out(ctx);
  const f = siteFrame(place, r.n("width"), r.n("depth"));
  const W = f.siteW,
    D = f.siteD;
  const lv = SCHOOL_LEVELS[r.s("level")] ?? SCHOOL_LEVELS.primary;
  const rand = rng(seedOf(ctx, r));
  const pupils = r.n("enrolment") > 0 ? r.n("enrolment") : lv.pupils;
  const floors = r.n("floors") > 0 ? r.n("floors") : lv.floors;
  const gfa = pupils * lv.m2;
  const facade = r.s("facade") !== "auto" ? r.s("facade") : SCHOOL_FACADES[Math.floor(rand() * SCHOOL_FACADES.length)];
  const name = r.s("name") || lv.label;
  out.area("campus", polyToWorld(f, rectL(0, 0, W, D)), { primary: false, name });
  // ---- academic building: a double-loaded classroom bar along the street, with a wing when needed
  const forecourt = 8,
    bd = 20;
  const gym = lv.gym;
  const academic = gfa - gym[0] * gym[1] * 1.6;
  const barW = Math.max(40, Math.min(W - 12, academic / floors / bd));
  const yBar = D / 2 - forecourt - bd / 2;
  const main = bld(out, f, [0, yBar], 0, { use: "education", width: barW, depth: bd, floors, groundFloorHeight: 4.5, floorHeight: 4.0, facade, roofType: "flat", parapetHeight: 1.1, penthouse: true, name, entrance: true, awning: false, solar: rand() < 0.5 }, true);
  let wingLen = Math.max(0, (academic / floors - barW * bd) / 18);
  const wingSide = rand() < 0.5 ? -1 : 1;
  if (wingLen > 8) {
    wingLen = Math.min(wingLen, D * 0.45);
    bld(out, f, [wingSide * (barW / 2 - 9), yBar - bd / 2 - wingLen / 2 - 0.05], 0, { use: "education", width: 18, depth: wingLen, floors: Math.max(2, floors - 1), groundFloorHeight: 4.5, floorHeight: 4.0, facade, roofType: "flat", parapetHeight: 1.1 });
  }
  // gymnasium / auditorium: a tall hall on the other side, behind the bar
  const gx = -wingSide * (barW / 2 - gym[0] / 2);
  const gy = yBar - bd / 2 - gym[1] / 2 - 0.2;
  bld(out, f, [gx, gy], 0, { use: "education", width: gym[0], depth: gym[1], floors: 1, groundFloorHeight: lv.field === "track" ? 11 : 8, facade: r.s("facade") !== "auto" ? facade : SCHOOL_FACADES[(SCHOOL_FACADES.indexOf(facade) + 2) % SCHOOL_FACADES.length], roofType: "barrel", roofRise: 0.25, roofMaterial: "metal_standing_seam", name: `${name} gymnasium`, entrance: false });
  // forecourt with trees, and a drop-off lay-by along the street
  areaL(out, f, "plaza", rectL(0, D / 2 - forecourt / 2, Math.min(W - 4, barW + 10), forecourt - 1));
  for (let x = -barW / 2 + 5; x <= barW / 2 - 5; x += 11) streetTree(out, toWorld(f, [x, D / 2 - 3]), x, 0.65);
  const dropX = W / 2 - 7;
  if (W - barW > 18) areaL(out, f, "parking", rectL(dropX, D / 2 - 30, 9, 44), { name: "Drop-off" });
  // ---- grounds behind: field at real dimensions where it fits, courts, playground
  const backTop = Math.min(gy - gym[1] / 2, yBar - bd / 2 - (wingLen > 8 ? wingLen : 0)) - 4;
  const backD = backTop + D / 2 - 3;
  let fieldPlaced = false;
  const tryField = (sport: "track" | "soccer" | "football", L0: number, W0: number) => {
    for (const rot of [0, 90]) {
      const Lx = rot ? W0 : L0,
        Ly = rot ? L0 : W0;
      if (Lx + 8 <= W - 6 && Ly + 8 <= backD) {
        const cy = -D / 2 + 3 + (Ly + 8) / 2;
        const cx = W / 2 - 3 - (Lx + 8) / 2;
        const def = byId(RECREATION, sport === "track" ? "recreation.running_track" : sport === "football" ? "recreation.football_field" : "recreation.soccer_field");
        child(out, def, { length: L0, width: W0, runoff: 4, lights: sport === "track", benches: 4 }, { site: polyToWorld(f, rectL(cx, cy, Lx + 8, Ly + 8)), rotation: ((f.a * 180) / Math.PI + rot + 360) % 360 });
        return { cx, cy, Lx: Lx + 8, Ly: Ly + 8 };
      }
    }
    return null;
  };
  let field = lv.field === "track" ? tryField("track", 176, 92) ?? tryField("football", 110, 49) ?? tryField("soccer", 100, 64) : tryField("soccer", lv.fieldL, lv.fieldW) ?? tryField("soccer", lv.fieldL * 0.75, lv.fieldW * 0.75);
  if (field) fieldPlaced = true;
  else field = { cx: W / 2, cy: -D / 2, Lx: 0, Ly: 0 };
  // the rest of the grounds behind the building: play yard, courts and a second diamond / tennis
  // where they fit, packed left to right; whatever remains is lawn (see below)
  const rx0 = -W / 2 + 3,
    rx1 = W / 2 - 3 - (field.Lx ? field.Lx + 4 : 0),
    ry0 = -D / 2 + 3,
    ry1 = -D / 2 + 3 + Math.max(0, backD - 2);
  const rot = ((f.a * 180) / Math.PI + 360) % 360;
  let cx0 = rx0;
  const slot = (w: number, d: number, fn: (cx: number, cy: number) => void) => {
    if (cx0 + w > rx1 || d > ry1 - ry0) return false;
    fn(cx0 + w / 2, ry0 + d / 2);
    cx0 += w + 4;
    return true;
  };
  if (lv.play) slot(34, Math.min(30, ry1 - ry0), (cx, cy) => {
    areaL(out, f, "plaza", rectL(cx, cy, 34, Math.min(30, ry1 - ry0)), { name: "Play yard" });
    out.prop("recreation.playground", subFrame(f, [cx, cy]), playgroundSolids("school", 18), { primary: false });
  });
  if (r.s("level") === "high" && ry1 - ry0 >= 75) {
    const s0 = Math.min(100, ry1 - ry0, rx1 - cx0);
    if (s0 >= 75) slot(s0, s0, (cx, cy) => child(out, byId(RECREATION, "recreation.baseball_field"), { length: s0 - 8, width: s0 - 8, runoff: 4 }, { site: polyToWorld(f, rectL(cx, cy, s0, s0)), rotation: rot }));
  }
  // courts in stacked rows
  const rows = Math.max(1, Math.floor((ry1 - ry0 + 2) / 21));
  let courts = lv.courts + (r.s("level") === "high" ? 2 : 0);
  while (courts > 0 && cx0 + 32 <= rx1 && ry1 - ry0 >= 19) {
    for (let k = 0; k < rows && courts > 0; k++, courts--) {
      const tennis = r.s("level") !== "primary" && courts % 2 === 0;
      child(out, byId(RECREATION, tennis ? "recreation.tennis_court" : "recreation.basketball_court"), { benches: 0 }, { site: polyToWorld(f, rectL(cx0 + 16, ry0 + 9.5 + k * 21, 32, 19)), rotation: rot });
    }
    cx0 += 36;
  }
  // shade trees along the back and sides
  for (let x = -W / 2 + 4; x <= W / 2 - 4; x += 10) streetTree(out, toWorld(f, [x, -D / 2 + 1.5]), x * 0.3, 0.75);
  for (let y = -D / 2 + 12; y <= D / 2 - 20; y += 11) for (const sg of [-1, 1]) if (!(sg > 0 && W - barW > 18 && y > D / 2 - 55)) streetTree(out, toWorld(f, [sg * (W / 2 - 1.5), y]), y * 0.7 + sg, 0.7);
  lawnFill(out, f, W, D);
  if (main) out.setPrimary(main.building);
  out.summary.unshift(`${name}: ${fmtInt(pupils)} pupils, ${fmtFloorArea(gfa)} over ${floors} floors${fieldPlaced ? "" : " (no room for a full field)"}`);
  return out.done();
}

/** lawn over every part of a site not already a building or another surface */
function lawnFill(out: Out, f: Frame, W: number, D: number) {
  const site = polyToWorld(f, rectL(0, 0, W, D));
  const cut: Polygon[] = [...out.buildings.map((b) => b.footprint), ...out.areas.filter((a) => a.type !== "campus").map((a) => a.poly)].filter((q) => q[0]?.length >= 3);
  let rest: Polygon[];
  try {
    rest = cut.length ? difference(site, ...cut) : [site];
  } catch {
    return;
  }
  for (const q of rest) if (polyArea(q) > 30) out.area("grass", q, { primary: false });
}

const fmtInt = (x: number) => Math.round(x).toLocaleString();

const CAMPUS_ROLES = ["academic", "library", "science", "residential", "union", "athletics"] as const;
const HALL_NAMES: Record<string, string[]> = {
  academic: ["Hall of Letters", "Founders Hall", "Commons Hall", "Hall of Business", "Law School", "Arts Building", "Humanities Hall", "Education Hall"],
  library: ["Main Library", "Library Annex", "Graduate Hall", "Admissions"],
  science: ["Engineering Building", "Life Sciences", "Physics Laboratory", "Computer Science", "Chemistry Building", "Medical Research"],
  residential: ["Residence Hall", "Graduate Housing", "Student Apartments", "Residence Hall East", "Residence Hall West"],
  union: ["Student Union", "Performing Arts Center", "Dining Commons", "Student Services"],
  athletics: ["Recreation Center", "Athletics Hall", "Natatorium"],
};
const CAMPUS_STYLE: Record<string, { facades: string[]; roof: ParamValues }> = {
  collegiate: { facades: ["brick_red", "brick_red", "brick_brown", "limestone"], roof: { roofType: "hip", roofPitch: 24, roofMaterial: "slate", parapetHeight: 0 } },
  mission: { facades: ["stucco_cream", "limestone", "sandstone", "stucco_white"], roof: { roofType: "hip", roofPitch: 22, roofMaterial: "terracotta", parapetHeight: 0 } },
  modern: { facades: ["glass_green", "precast_white", "metal_silver", "glass_clear", "brick_brown"], roof: { roofType: "flat", parapetHeight: 1 } },
};

function campusBlock(values: ParamValues, place: PlacementInput, ctx: GenerateContext, params: PrimitiveDef["params"]) {
  const r = reader(values, params);
  const out = new Out(ctx);
  const f = siteFrame(place, r.n("width"), r.n("depth"));
  const W = f.siteW,
    D = f.siteD;
  const rand = rng(seedOf(ctx, r));
  const role = r.s("role");
  const style = CAMPUS_STYLE[r.s("style")] ?? CAMPUS_STYLE.collegiate;
  const floors = r.n("floors");
  const names = [...(HALL_NAMES[role] ?? HALL_NAMES.academic)];
  const takeName = () => names.splice(Math.floor(rand() * names.length), 1)[0] ?? "Hall";
  out.area("campus", polyToWorld(f, rectL(0, 0, W, D)), { primary: false, name: r.s("name") || "Campus" });
  const setback = 5;
  let first: ReturnType<typeof bld> = null;
  const hall = (x: number, y: number, rot: number, w: number, d: number, extra: ParamValues = {}) => {
    const sci = role === "science";
    const res = role === "residential";
    const fl = Math.max(2, floors + Math.round((rand() - 0.5) * 3) + (res ? 2 : 0));
    const pitched = !sci && fl <= 6 && style.roof.roofType !== "flat";
    const b = bld(out, f, [x, y], rot, {
      use: res ? "residential" : "education",
      unitSize: res ? 40 : 78,
      width: w,
      depth: d,
      floors: fl,
      groundFloorHeight: 4.8,
      floorHeight: sci ? 4.6 : res ? 3.2 : 4.2,
      facade: sci && rand() < 0.6 ? (rand() < 0.5 ? "metal_silver" : "glass_green") : style.facades[Math.floor(rand() * style.facades.length)],
      ...(pitched ? style.roof : { roofType: "flat", parapetHeight: 1.1, penthouse: sci }),
      balconies: res && rand() < 0.4,
      name: takeName(),
      ...extra,
    }, !first);
    if (b && !first) first = b;
    return b;
  };
  if (role === "athletics") {
    const L0 = Math.min(105, W - 30),
      W0 = Math.min(68, D - 50);
    if (L0 > 50 && W0 > 30) child(out, byId(RECREATION, "recreation.soccer_field"), { length: L0, width: W0, runoff: 4, lights: true }, { site: polyToWorld(f, rectL(0, -D / 2 + setback + (W0 + 8) / 2, L0 + 8, W0 + 8)), rotation: ((f.a * 180) / Math.PI + 360) % 360 });
    hall(0, D / 2 - setback - 15, 0, Math.min(70, W - 20), 30, { floors: 2, groundFloorHeight: 9, roofType: "barrel", roofRise: 0.3, roofMaterial: "metal_standing_seam" });
  } else {
    // halls framing a central quad, with passages into it on every side
    const bd = role === "residential" ? 17 : 19;
    const qx = W - 2 * (setback + bd),
      qy = D - 2 * (setback + bd);
    for (const sg of [-1, 1]) {
      const n = W > 150 ? 3 : W > 90 ? 2 : 1;
      const gap = 10;
      const len = (W - 2 * setback - (n - 1) * gap) / n;
      for (let i = 0; i < n; i++) {
        const x = -W / 2 + setback + len / 2 + i * (len + gap);
        const big = role === "library" && sg > 0 && i === Math.floor(n / 2);
        const b = hall(x, sg * (D / 2 - setback - bd / 2 - (big ? 4 : 0)), sg > 0 ? 180 : 0, len, big ? bd + 8 : bd, big ? { floors: Math.max(3, floors - 1), groundFloorHeight: 6, floorHeight: 5, roofType: "flat", parapetHeight: 1.2, name: "Main Library" } : {});
        if (big && b) {
          const [x0, y0, x1, y1] = b.bbox;
          b.addSolids([{ shape: "cylinder", at: [(x0 + x1) / 2, (y0 + y1) / 2, b.height], size: [16, 16, 4], color: [236, 230, 216], material: "stone" }, { shape: "hemisphere", at: [(x0 + x1) / 2, (y0 + y1) / 2, b.height + 4], size: [16, 16, 10], color: [110, 168, 150], material: "metal" }]);
        }
      }
    }
    if (qy > 30)
      for (const sg of [-1, 1]) {
        const len = Math.max(12, qy - 2 * 10);
        if (rand() < 0.85) hall(sg * (W / 2 - setback - bd / 2), 0, sg > 0 ? 90 : -90, len, bd);
      }
    if (qx > 20 && qy > 16) {
      out.area("grass", polyToWorld(f, rectL(0, 0, qx - 4, qy - 4)), { primary: false, name: role === "residential" ? "Courtyard" : "Quad" });
      for (const [a, b] of [[[-qx / 2 - setback - bd, 0], [qx / 2 + setback + bd, 0]], [[0, -qy / 2 - setback - bd], [0, qy / 2 + setback + bd]]] as [Vec2, Vec2][]) out.path([toWorld(f, a), toWorld(f, b)], "footway", { primary: false });
      if (qx > 50 && qy > 40) for (const [a, b] of [[[-qx / 2 + 2, -qy / 2 + 2], [qx / 2 - 2, qy / 2 - 2]], [[-qx / 2 + 2, qy / 2 - 2], [qx / 2 - 2, -qy / 2 + 2]]] as [Vec2, Vec2][]) out.path([toWorld(f, a), toWorld(f, b)], "footway", { primary: false });
      for (let x = -qx / 2 + 6; x <= qx / 2 - 6; x += 11) for (const y of [-qy / 2 + 4, qy / 2 - 4]) streetTree(out, toWorld(f, [x, y]), x * 0.2 + y, 0.85);
    }
  }
  lawnFill(out, f, W, D);
  if (first) out.setPrimary((first as NonNullable<typeof first>).building);
  out.summary.unshift(`Campus block (${role}) ${fmtDims(W, D)}`);
  return out.done();
}

const URBAN_SCHOOL_PARAMS: PrimitiveDef["params"] = [
  choice("level", "Level", "primary", [{ value: "primary", label: "Primary / elementary (K–5)" }, { value: "middle", label: "Middle (6–8)" }, { value: "high", label: "High (9–12)" }], { group: B }),
  int("enrolment", "Enrolment", 0, { group: B, min: 0, max: 5000, unit: "pupils", description: "0 = typical for the level (600 / 800 / 1,600)" }),
  int("floors", "Floors", 0, { group: B, min: 0, max: 8, description: "0 = typical for the level" }),
  choice("facade", "Facade", "auto", [{ value: "auto", label: "Automatic" }, ...SCHOOL_FACADES.map((v) => ({ value: v, label: v.replace(/_/g, " ") }))], { group: B }),
  num("width", "Width (if not drawn)", 110, { group: L, unit: "m", min: 50, max: 600, step: 1 }),
  num("depth", "Depth (if not drawn)", 90, { group: L, unit: "m", min: 40, max: 600, step: 1 }),
  int("seed", "Variation seed", 0, { group: L, min: 0, max: 9999, advanced: true }),
];

const CAMPUS_BLOCK_PARAMS: PrimitiveDef["params"] = [
  choice("role", "Block role", "academic", opts(...CAMPUS_ROLES), { group: B }),
  choice("style", "Architecture", "collegiate", STYLE_OPTS, { group: B }),
  int("floors", "Typical floors", 4, { group: B, min: 2, max: 20 }),
  num("width", "Width (if not drawn)", 110, { group: L, unit: "m", min: 50, max: 600, step: 1 }),
  num("depth", "Depth (if not drawn)", 80, { group: L, unit: "m", min: 40, max: 600, step: 1 }),
  int("seed", "Variation seed", 0, { group: L, min: 0, max: 9999, advanced: true }),
];

COMPOSITES.push(
  {
    id: "composites.urban_school",
    name: "Urban school",
    category: CO,
    tags: ["school", "elementary school", "primary school", "middle school", "high school", "school campus", "schoolyard"],
    description: "A compact multi-storey school on a city block: classroom bar on the street with a forecourt and drop-off, gymnasium, play yard and courts, and a field at real youth / regulation dimensions where it fits.",
    icon: "school",
    placement: "rect",
    params: URBAN_SCHOOL_PARAMS,
    generate(values, place, ctx) {
      return urbanSchool(values, place, ctx, URBAN_SCHOOL_PARAMS);
    },
  },
  {
    id: "composites.campus_block",
    name: "Campus block",
    category: CO,
    tags: ["university", "college", "campus", "quad", "academic block", "residence halls"],
    description: "One block of a university campus: varied halls framing a quad with paths and trees (academic, library, science, residential, student union or athletics).",
    icon: "graduation-cap",
    placement: "rect",
    params: CAMPUS_BLOCK_PARAMS,
    generate(values, place, ctx) {
      return campusBlock(values, place, ctx, CAMPUS_BLOCK_PARAMS);
    },
  },
);

void EDUCATION;
void ({} as GenerateContext);
