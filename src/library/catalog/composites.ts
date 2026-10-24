// Composites: multi-primitive ensembles generated from the other definitions — a college campus,
// a residential subdivision with its streets, a shopping centre, a mixed-use block, a town square
// and a business park. Every entity belongs to the one composite instance (re-configured together).

import type { Polygon, Vec2 } from "@/world/types";
import type { GenerateContext, ParamValues, PlacementInput, PrimitiveDef } from "../types";
import { validateParams } from "../registry";
import { type Frame, frameOf, polyToWorld, rng, subFrame, toWorld } from "../geometry/frame";
import { benchSolids, lampSolids, treeSolids } from "../geometry/props";
import { C } from "../geometry/palette";
import { BUILDING_PARAMS, buildBuilding } from "./building";
import { COMMERCIAL } from "./commercial";
import { HOUSING } from "./housing";
import { rectL, parkingLot } from "./decor";
import { Out } from "./make";
import { parkInto } from "./parks";
import { bool, choice, int, num, opts, reader } from "./params";
import { PARKS, fountainSolids, statueSolids } from "./parks";
import { CIVIC, EDUCATION } from "./civic";
import { seedOf } from "./kinds";

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
  out.prop("flora.tree", { c: p, a: seed * 6, siteW: 0, siteD: 0 }, t, { primary: false, shade: { r: 4.5 * scale, h: 13 * scale } });
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
      out.summary.unshift(`Campus ${Math.round(W)} × ${Math.round(D)} m around a ${Math.round(qw)} × ${Math.round(qd)} m quad`);
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
      num("lotWidth", "Lot frontage", 18, { group: L, unit: "m", min: 8, max: 60, step: 0.5, description: "Typical 15–25 m (50–80 ft)" }),
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
      out.summary.unshift(`Subdivision: ${homes} homes on ${bands} street${bands > 1 ? "s" : ""}, lots ${lw} × ${ld} m`);
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
      out.summary.unshift(`Mixed-use block ${Math.round(W)} × ${Math.round(D)} m, ${fl} floors`);
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
      for (const [x, y] of [[-pw / 2 + 2, -pd / 2 + 2], [pw / 2 - 2, -pd / 2 + 2], [pw / 2 - 2, pd / 2 - 2], [-pw / 2 + 2, pd / 2 - 2]] as Vec2[]) out.prop("streetscape.street_lamp", subFrame(f, [x, y]), lampSolids("historic", 4.5), { primary: false });
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
      out.summary.unshift(`Town square ${Math.round(pw)} × ${Math.round(pd)} m`);
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

void EDUCATION;
void ({} as GenerateContext);
