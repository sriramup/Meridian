// The universal configurable building: every footprint, massing, roof, facade and programme
// parameter in one schema (the agent's escape hatch for any building), and `buildingType`, which
// turns it into a named building type by overriding defaults and optionally decorating the result
// (porches, canopies, pumps, playgrounds…). A new building type is one small call.

import { massesGFA } from "@/geometry/massing";
import { insetPoly, isValidPoly, polyArea, polyBBox, polyCentroid } from "@/geometry/polygon";
import { fmtDims } from "@/lib/units";
import { PROGRAMME, fmt } from "@/world/ops/core";
import type { Building, Mass, Polygon, Solid, Use, Vec2 } from "@/world/types";
import type { Category, GenerateContext, ParamSpec, ParamValues, Placement, PlacementInput, PrimitiveDef } from "../types";
import { FOOTPRINT_SHAPES, footprintPoly, type FootprintShape, type FootprintSpec } from "../geometry/footprints";
import { type Frame, frameOf, hashSeed, polyToLocal, polyToWorld, rng, toWorld as toW } from "../geometry/frame";
import { floorHeightsFor, stackMasses } from "../geometry/massing";
import { FACADES, FACADE_OPTIONS, ROOFS, ROOF_COLOR_OPTIONS, hexToRgb, shade, type FacadeKey, type RoofKey } from "../geometry/palette";
import { footprintParts, transformParts, type Part } from "../geometry/parts";
import { ROOF_TYPES, roofSolids, type RoofType } from "../geometry/roofs";
import { S, box, cyl, solidsToWorld, type RGB } from "../geometry/solids";
import { Out } from "./make";
import { bool, choice, color, int, num, reader, text, withDefaults, type Reader } from "./params";

export const USE_OPTIONS: { value: Use; label: string }[] = [
  { value: "residential", label: "Residential" },
  { value: "office", label: "Office" },
  { value: "retail", label: "Retail" },
  { value: "mixed", label: "Mixed use" },
  { value: "hotel", label: "Hotel" },
  { value: "civic", label: "Civic" },
  { value: "education", label: "Education" },
  { value: "religious", label: "Religious" },
  { value: "health", label: "Health" },
  { value: "industrial", label: "Industrial" },
  { value: "parking", label: "Parking" },
  { value: "utility", label: "Utility" },
  { value: "other", label: "Other" },
];

const WINGS: FootprintShape[] = ["l", "t", "u", "h", "o", "plus", "z", "crescent"];
const PITCHED: RoofType[] = ["gable", "hip", "shed", "mansard", "pyramid", "sawtooth", "cone", "gambrel", "butterfly"];

const F = "Footprint",
  MS = "Massing",
  RF = "Roof",
  FC = "Facade",
  PG = "Programme";

/** the full universal building schema */
export const BUILDING_PARAMS: ParamSpec[] = [
  // footprint
  choice("shape", "Plan shape", "rect", [...FOOTPRINT_SHAPES, { value: "site", label: "Drawn outline", description: "Use the drawn site polygon as the footprint" }], { group: F, description: "Footprint shape; dimensions below are its overall extents" }),
  num("width", "Width", 24, { group: F, unit: "m", min: 3, max: 400, step: 0.5, description: "Overall extent along the building's x axis (diameter for round plans)" }),
  num("depth", "Depth", 16, { group: F, unit: "m", min: 3, max: 400, step: 0.5, description: "Overall extent front to back", when: { key: "shape", in: ["rect", "l", "t", "u", "h", "o", "plus", "z", "trapezoid", "triangle", "ellipse", "ngon", "rounded", "chamfered", "crescent", "stepped"] } }),
  num("wing", "Wing width", 10, { group: F, unit: "m", min: 1, max: 100, step: 0.5, description: "Thickness of the vertical wings / legs / ring (typical double-loaded bar 40–65 ft)", when: { key: "shape", in: WINGS } }),
  num("wing2", "Cross-wing width", 10, { group: F, unit: "m", min: 1, max: 100, step: 0.5, description: "Thickness of the horizontal bar / foot / crossbar", when: { key: "shape", in: ["l", "t", "u", "h", "o", "plus", "z"] } }),
  int("sides", "Sides", 6, { group: F, min: 3, max: 24, when: { key: "shape", in: ["ngon"] } }),
  num("corner", "Corner radius / chamfer", 4, { group: F, unit: "m", min: 0.2, max: 60, step: 0.5, when: { key: "shape", in: ["rounded", "chamfered"] } }),
  num("topWidth", "Top width", 60, { group: F, unit: "%", min: 5, max: 100, step: 1, description: "Width of the back edge as a share of the front", when: { key: "shape", in: ["trapezoid"] } }),
  num("skew", "Skew", 0, { group: F, unit: "%", min: -50, max: 50, step: 1, description: "Sideways shift of the back edge", when: { key: "shape", in: ["trapezoid", "triangle"] }, advanced: true }),
  num("sweep", "Arc sweep", 140, { group: F, unit: "°", min: 20, max: 300, step: 5, when: { key: "shape", in: ["crescent"] } }),
  int("steps", "Steps", 3, { group: F, min: 2, max: 12, when: { key: "shape", in: ["stepped"] } }),
  num("targetArea", "Target footprint area", 0, { group: F, unit: "m²", min: 0, max: 100000, step: 10, description: "If set, the shape is scaled uniformly to this footprint area (0 = use dimensions)" }),
  bool("fitToSite", "Fit to drawn site", true, { group: F, description: "When placed on a drawn rectangle or site, take width and depth from it", advanced: true }),
  num("siteInset", "Setback from site edge", 0, { group: F, unit: "m", min: 0, max: 30, step: 0.5, description: "Front / side / rear setback from a drawn site", advanced: true }),
  // massing
  int("floors", "Floors", 4, { group: MS, min: 1, max: 160, unit: "floors", description: "Storeys above ground" }),
  num("targetHeight", "Target height", 0, { group: MS, unit: "m", min: 0, max: 700, step: 0.5, description: "If set, floors are derived from this height and the floor heights (0 = use Floors)" }),
  num("targetGFA", "Target floor area", 0, { group: MS, unit: "m²", min: 0, max: 2000000, step: 50, description: "If set, floors are derived so the gross floor area reaches this (0 = use Floors)" }),
  num("groundFloorHeight", "Ground floor height", 0, { group: MS, unit: "m", min: 0, max: 12, step: 0.1, description: "Floor-to-floor height of the ground storey (0 = typical for the use: 14 ft residential, 16 ft other)" }),
  num("floorHeight", "Typical floor height", 0, { group: MS, unit: "m", min: 0, max: 10, step: 0.1, description: "Floor-to-floor height of upper storeys (0 = typical for the use: 10.5 ft residential / hotel, 13 ft office, 18 ft industrial)" }),
  int("podiumFloors", "Podium floors", 0, { group: MS, min: 0, max: 20, unit: "floors", description: "Floors in a full-footprint base; the floors above form a tower (0 = no podium)" }),
  num("towerCoverage", "Tower plate", 45, { group: MS, unit: "%", min: 5, max: 100, step: 1, description: "Tower floor-plate area as a share of the podium" }),
  num("towerOffsetX", "Tower offset across", 0, { group: MS, unit: "m", min: -100, max: 100, step: 0.5, advanced: true }),
  num("towerOffsetY", "Tower offset front–back", 0, { group: MS, unit: "m", min: -100, max: 100, step: 0.5, advanced: true }),
  int("setbackEvery", "Setback every", 0, { group: MS, min: 0, max: 60, unit: "floors", description: "Step the facade back every N floors (wedding-cake / terraced; 0 = none)" }),
  num("setbackDepth", "Setback depth", 3, { group: MS, unit: "m", min: 0, max: 20, step: 0.5, description: "Depth of each step / terrace" }),
  num("topScale", "Taper", 100, { group: MS, unit: "%", min: 10, max: 200, step: 1, description: "Size of the top floor plate relative to the base of the tower (100 = straight, <100 tapers, >100 flares)" }),
  num("twist", "Twist", 0, { group: MS, unit: "°", min: -360, max: 360, step: 1, description: "Total rotation of the floor plates from the base of the tower to the top" }),
  int("pilotis", "Floors on pilotis", 0, { group: MS, min: 0, max: 4, unit: "floors", description: "Lift the building on columns, leaving an open ground floor", advanced: true }),
  bool("penthouse", "Rooftop plant / penthouse", false, { group: MS, description: "Mechanical penthouse on flat roofs", advanced: true }),
  // roof
  choice("roofType", "Roof type", "flat", ROOF_TYPES, { group: RF, description: "Pitched roofs follow rectangular wings; round plans get cones; others fall back to flat" }),
  num("roofPitch", "Roof pitch", 30, { group: RF, unit: "°", min: 3, max: 70, step: 1, description: "Slope of pitched roofs (6/12 ≈ 27°, 12/12 = 45°)", when: { key: "roofType", in: PITCHED } }),
  choice("roofMaterial", "Roof covering", "gravel", ROOF_COLOR_OPTIONS, { group: RF }),
  num("parapetHeight", "Parapet height", 1.0, { group: RF, unit: "m", min: 0, max: 4, step: 0.1, when: { key: "roofType", in: ["flat", "dome"] } }),
  num("overhang", "Eave overhang", 0.4, { group: RF, unit: "m", min: 0, max: 3, step: 0.1, when: { key: "roofType", in: PITCHED.concat(["barrel"]) } }),
  choice("ridge", "Ridge direction", "long", [{ value: "long", label: "Along the long side" }, { value: "short", label: "Across" }], { group: RF, when: { key: "roofType", in: ["gable", "hip", "shed", "mansard", "sawtooth", "barrel", "gambrel", "butterfly"] }, advanced: true }),
  num("roofRise", "Dome / vault rise", 1, { group: RF, min: 0.15, max: 1.5, step: 0.05, description: "Rise as a share of the half-span (1 = semicircular)", when: { key: "roofType", in: ["dome", "barrel"] } }),
  int("teeth", "Sawtooth bays", 5, { group: RF, min: 1, max: 40, when: { key: "roofType", in: ["sawtooth"] } }),
  bool("greenRoof", "Green roof", false, { group: RF, description: "Vegetated roof (counted by the stormwater and heat models)" }),
  bool("solar", "Rooftop solar", false, { group: RF }),
  num("solarCoverage", "Solar coverage", 60, { group: RF, unit: "%", min: 5, max: 95, step: 5, when: { key: "solar", in: [true] } }),
  // facade
  choice("facade", "Facade material", "brick_buff", FACADE_OPTIONS, { group: FC }),
  bool("customColor", "Custom wall colour", false, { group: FC }),
  color("wallColor", "Wall colour", "#e8dcc4", { group: FC, when: { key: "customColor", in: [true] }, swatches: ["#f4f0e6", "#e8dcc4", "#d6b48c", "#a85c48", "#96b2c8", "#585c62", "#a4b296"] }),
  num("tint", "Tone variation", 0.3, { group: FC, min: 0, max: 1, step: 0.05, advanced: true }),
  bool("balconies", "Balconies", false, { group: FC }),
  num("balconyDepth", "Balcony depth", 1.6, { group: FC, unit: "m", min: 0.6, max: 4, step: 0.1, when: { key: "balconies", in: [true] } }),
  bool("awning", "Ground-floor awning / canopy", false, { group: FC }),
  color("awningColor", "Awning colour", "#b65a3c", { group: FC, when: { key: "awning", in: [true] } }),
  bool("entrance", "Marked entrance", true, { group: FC, advanced: true }),
  // programme
  choice("use", "Primary use", "residential", USE_OPTIONS, { group: PG }),
  choice("groundUse", "Ground-floor use", "same", [{ value: "same", label: "Same as primary" }, ...USE_OPTIONS], { group: PG, description: "e.g. retail at grade under housing or offices" }),
  choice("secondaryUse", "Secondary use", "none", [{ value: "none", label: "None" }, ...USE_OPTIONS], { group: PG, advanced: true }),
  num("secondaryShare", "Secondary share", 20, { group: PG, unit: "%", min: 0, max: 90, step: 5, advanced: true, when: { key: "secondaryUse", in: USE_OPTIONS.map((o) => o.value) } }),
  int("units", "Dwelling units", 0, { group: PG, min: 0, max: 5000, description: "Explicit unit count (0 = estimate from residential floor area at the average unit size)" }),
  num("unitSize", "Average unit size", 78, { group: PG, unit: "m²", min: 25, max: 500, step: 1, advanced: true }),
  int("jobs", "Jobs", 0, { group: PG, min: 0, max: 50000, description: "Explicit employment (0 = estimate from floor area by use)" }),
  text("name", "Name", "", { group: PG }),
];

export interface BuildingInfo {
  building: Building;
  frame: Frame;
  /** footprint in the local frame */
  local: Polygon;
  bbox: [number, number, number, number];
  height: number;
  floors: number;
  groundH: number;
  gfa: number;
  units: number;
  jobs: number;
  /** the facade facing local +y: midpoint, outward normal, length, angle (deg) */
  front: { mid: Vec2; n: Vec2; len: number; rot: number };
  /** add local-frame solids to the building */
  addSolids(s: Solid[]): void;
  /** add a local-frame mass (annex, canopy volume…) */
  addMass(poly: Polygon, base: number, top: number, role: Mass["role"]): void;
}

function frontEdge(local: Polygon): BuildingInfo["front"] {
  let best: BuildingInfo["front"] | null = null;
  let score = -Infinity;
  const r = local[0];
  for (let i = 0; i < r.length; i++) {
    const a = r[i],
      b = r[(i + 1) % r.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const n: Vec2 = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len]; // outward for CCW
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = n[1] * 2 + mid[1] * 0.02 + Math.min(len, 20) * 0.05;
    if (s > score) {
      score = s;
      best = { mid, n, len, rot: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
    }
  }
  return best ?? { mid: [0, 0], n: [0, 1], len: 1, rot: 0 };
}

function shareOfGround(masses: Mass[], groundArea: number, ground: number, typ: number): number {
  let tot = 0;
  for (const m of masses) {
    if (m.role === "crown") continue;
    const fl = m.base < 0.5 ? 1 + Math.max(0, Math.round((m.top - ground) / typ)) : Math.max(0, Math.round((m.top - m.base) / typ));
    tot += polyArea(m.poly) * fl;
  }
  return tot > 0 ? Math.min(1, groundArea / tot) : 1;
}

export interface BuildOverrides {
  /** fixed local footprint (composites), bypassing shape params */
  footprint?: Polygon;
}

/** generate the universal building into `out`; returns geometry info for decorators / composites */
export function buildBuilding(out: Out, r: Reader, frame: Frame, o: BuildOverrides = {}, primary = true): BuildingInfo | null {
  const shape = r.s("shape") as FootprintShape | "site";
  const inset = r.n("siteInset");
  let local: Polygon | null = null;
  let fspec: FootprintSpec | null = null;
  if (o.footprint) local = o.footprint;
  else if (shape === "site") {
    if (frame.site) {
      local = polyToLocal(frame, frame.site);
      if (inset > 0) local = insetPoly(local, inset) ?? local;
    } else out.warnings.push("Drawn-outline shape needs a drawn site; used a rectangle");
  }
  if (!local) {
    const fit = frame.siteW > 0 && r.b("fitToSite");
    const W = fit ? Math.max(2, frame.siteW - 2 * inset) : r.n("width");
    const D = fit ? Math.max(2, frame.siteD - 2 * inset) : r.n("depth");
    fspec = {
      shape: shape === "site" ? "rect" : shape,
      width: W,
      depth: D,
      wing: r.n("wing"),
      wing2: r.n("wing2"),
      sides: r.n("sides"),
      corner: r.n("corner"),
      taper: r.n("topWidth") / 100,
      skew: r.n("skew") / 100,
      sweep: r.n("sweep"),
      steps: r.n("steps"),
      targetArea: r.n("targetArea") > 0 ? Math.max(10, r.n("targetArea")) : 0,
    };
    local = footprintPoly(fspec);
  }
  if (!isValidPoly(local)) {
    out.warnings.push("Footprint degenerate; nothing built");
    return null;
  }
  const use = r.s("use") as Use;
  let floors = r.n("floors");
  {
    const fh = floorHeightsFor(use, r.n("groundFloorHeight"), r.n("floorHeight"));
    if (r.n("targetHeight") > 0) floors = Math.max(1, Math.min(160, 1 + Math.round((r.n("targetHeight") - fh.ground) / fh.typ)));
    else if (r.n("targetGFA") > 0) {
      // podium floors carry the full plate, tower floors the reduced one
      const plate = polyArea(local);
      const pf = Math.min(r.n("podiumFloors"), 159);
      const tower = plate * (pf > 0 ? r.n("towerCoverage") / 100 : 1);
      const rest = r.n("targetGFA") - pf * plate;
      floors = Math.max(1, Math.min(160, pf + Math.max(pf > 0 ? 1 : 1, Math.ceil(rest / Math.max(1, tower)))));
    }
  }
  const st = stackMasses(local, {
    floors,
    use,
    groundH: r.n("groundFloorHeight"),
    typH: r.n("floorHeight"),
    podiumFloors: r.n("podiumFloors"),
    towerScale: r.n("towerCoverage") / 100,
    towerOffset: [r.n("towerOffsetX"), r.n("towerOffsetY")],
    setbackEvery: r.n("setbackEvery"),
    setbackDepth: r.n("setbackDepth"),
    taper: r.n("topScale") / 100,
    twist: r.n("twist"),
    pilotisFloors: r.n("pilotis"),
  });
  out.warnings.push(...st.notes);
  const masses: Mass[] = [...st.masses];
  const solids: Solid[] = [];

  // ---- facade and colours
  const fk = (r.s("facade") in FACADES ? r.s("facade") : "concrete") as FacadeKey;
  const fp = FACADES[fk];
  const wall: RGB = r.b("customColor") ? hexToRgb(r.c("wallColor"), fp.color) : fp.color;
  const rk = (r.s("roofMaterial") in ROOFS ? r.s("roofMaterial") : "gravel") as RoofKey;
  const roofMat = ROOFS[rk];

  // ---- roof
  let roofType = r.s("roofType") as RoofType;
  const roundPlan = !!fspec && (fspec.shape === "circle" || fspec.shape === "ellipse" || (fspec.shape === "ngon" && (fspec.sides ?? 6) >= 7));
  const baseParts = footprintParts(fspec, local);
  const xf = st.topXf;
  const topParts: Part[] | null = baseParts ? transformParts(baseParts, xf.about, xf.s, xf.inset, xf.twist, xf.off) : footprintParts(null, st.top);
  const rr = roofSolids(st.top, st.height, topParts, {
    type: roofType,
    pitch: r.n("roofPitch"),
    color: roofMat.color,
    material: roofMat.material,
    parapet: r.n("parapetHeight"),
    parapetColor: fp.trim,
    overhang: r.n("overhang"),
    ridge: r.s("ridge") === "short" ? "short" : "long",
    rise: r.n("roofRise"),
    teeth: r.n("teeth"),
    wall,
  }, roundPlan);
  solids.push(...rr.solids);
  out.warnings.push(...rr.warnings);
  if (rr.warnings.length) roofType = "flat";
  const flatTop = roofType === "flat" || roofType === "dome";
  if (r.b("penthouse") && flatTop && floors >= 3) {
    const c = polyCentroid(st.top);
    const ph = st.top.slice(0, 1).map((ring) => ring.map(([x, y]) => [c[0] + (x - c[0]) * 0.4, c[1] + (y - c[1]) * 0.4] as Vec2));
    if (isValidPoly(ph) && polyArea(ph) > 10) masses.push({ poly: ph, base: st.height, top: st.height + 4, role: "crown", use });
  }
  const green = r.b("greenRoof");
  if (green && flatTop && topParts) for (const p of topParts) if (p.w > 1.5 && p.d > 1.5) solids.push(S("box", [p.c[0], p.c[1], st.height], [p.w - 0.8, p.d - 0.8, 0.2], [118, 152, 92], "foliage", p.rot));
  if (r.b("solar") && topParts) {
    const cov = r.n("solarCoverage") / 100;
    for (const p of topParts) {
      if (flatTop) {
        // rows of panels tilted ≈ 15°, 2.2 m pitch
        const rows = Math.max(1, Math.floor(((p.d - 1.5) * cov) / 2.2));
        const ca = Math.cos((p.rot * Math.PI) / 180),
          sa = Math.sin((p.rot * Math.PI) / 180);
        for (let i = 0; i < rows; i++) {
          const v = -((rows - 1) * 2.2) / 2 + i * 2.2;
          solids.push(S("box", [p.c[0] - v * sa, p.c[1] + v * ca, st.height + 0.35], [Math.max(1, (p.w - 2) * Math.sqrt(cov)), 1.6, 0.06], [46, 62, 92], "glass", p.rot, [15, 0]));
        }
      } else if (roofType === "gable" || roofType === "hip" || roofType === "shed") {
        const longX = p.w >= p.d;
        const alongX = r.s("ridge") === "short" ? !longX : longX;
        const L = alongX ? p.w : p.d,
          W = alongX ? p.d : p.w;
        const rot = p.rot + (alongX ? 0 : 90);
        const pitch = Math.min(r.n("roofPitch"), roofType === "shed" ? 35 : 70);
        const span = roofType === "shed" ? W : W / 2;
        const ca = Math.cos((rot * Math.PI) / 180),
          sa = Math.sin((rot * Math.PI) / 180);
        const v = roofType === "shed" ? 0 : -W / 4;
        const z = st.height + (span / 2) * Math.tan((pitch * Math.PI) / 180) + 0.12;
        solids.push(S("box", [p.c[0] - v * sa, p.c[1] + v * ca, z], [L * 0.7 * Math.sqrt(cov), (span / Math.cos((pitch * Math.PI) / 180)) * 0.75, 0.05], [46, 62, 92], "glass", rot, [pitch, 0]));
      }
    }
  }

  // ---- pilotis columns
  if (r.n("pilotis") > 0) {
    const zc = st.masses.find((m) => m.role !== "base")?.base ?? 0;
    const ring = (insetPoly(local, 0.6) ?? local)[0];
    const step = Math.max(1, Math.ceil(ring.length / 24));
    for (let i = 0; i < ring.length; i += step) solids.push(cyl(ring[i][0], ring[i][1], 0, 0.5, zc, shade(fp.trim, 0.9), "concrete"));
  }

  // ---- balconies
  if (r.b("balconies") && floors >= 2) {
    const bd = r.n("balconyDepth");
    let count = 0;
    for (const m of st.masses) {
      if (m.role === "podium" || m.role === "base" || m.role === "crown") continue;
      const ring = m.poly[0];
      for (let f = m.base < 0.5 ? st.groundH : m.base; f + 0.5 < m.top && count < 700; f += st.typH) {
        for (let i = 0; i < ring.length && count < 700; i++) {
          const a = ring[i],
            b = ring[(i + 1) % ring.length];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 5) continue;
          const n: Vec2 = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
          const mid: Vec2 = [(a[0] + b[0]) / 2 + (n[0] * bd) / 2, (a[1] + b[1]) / 2 + (n[1] * bd) / 2];
          const rot = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
          solids.push(S("box", [mid[0], mid[1], f], [len * 0.7, bd, 0.2], fp.trim, "concrete", rot));
          solids.push(S("box", [mid[0] + (n[0] * bd) / 2, mid[1] + (n[1] * bd) / 2, f + 0.2], [len * 0.7, 0.05, 1.0], [196, 214, 224], "glass", rot));
          count += 2;
        }
      }
    }
  }

  // ---- entrance and awning on the front facade
  const front = frontEdge(local);
  if (r.b("entrance") && r.n("pilotis") === 0) {
    const w = Math.min(front.len * 0.5, use === "residential" && floors <= 3 ? 1.1 : 2.4);
    solids.push(S("box", [front.mid[0] + front.n[0] * 0.06, front.mid[1] + front.n[1] * 0.06, 0], [w, 0.14, Math.min(st.groundH - 0.3, 2.6)], [70, 74, 80], "glass", front.rot));
  }
  if (r.b("awning")) {
    const ad = 1.6;
    const z = Math.min(st.groundH - 0.6, 3.2);
    solids.push(S("box", [front.mid[0] + (front.n[0] * ad) / 2, front.mid[1] + (front.n[1] * ad) / 2, z], [front.len * 0.85, ad, 0.12], hexToRgb(r.c("awningColor"), [182, 90, 60]), "fabric", front.rot, [-8, 0]));
  }

  // ---- programme
  const groundArea = polyArea(local);
  const gfa = massesGFA(masses, use === "mixed" ? "residential" : use, { ground: st.groundH, typical: st.typH });
  const program: Partial<Record<Use, number>> = {};
  const gu = r.s("groundUse");
  const su = r.s("secondaryUse");
  let rest = 1;
  if (gu !== "same" && gu !== use && floors > 1) {
    const g = shareOfGround(masses, groundArea, st.groundH, st.typH);
    program[gu as Use] = (program[gu as Use] ?? 0) + g;
    rest -= g;
  }
  if (su !== "none" && su !== use) {
    const s = Math.min(rest, (r.n("secondaryShare") / 100) * rest);
    program[su as Use] = (program[su as Use] ?? 0) + s;
    rest -= s;
  }
  const mainUses: Use[] = use === "mixed" ? ["residential", "retail"] : [use];
  if (use === "mixed" && gu === "same") {
    const g = shareOfGround(masses, groundArea, st.groundH, st.typH);
    program.retail = (program.retail ?? 0) + rest * Math.min(0.5, Math.max(g, 0.15));
    program.residential = (program.residential ?? 0) + rest * (1 - Math.min(0.5, Math.max(g, 0.15)));
  } else for (const u of mainUses) program[u] = (program[u] ?? 0) + rest / mainUses.length;
  const shares = Object.entries(program).filter(([, v]) => (v ?? 0) > 1e-6);
  const bUse: Use = use === "mixed" || shares.filter(([, v]) => (v ?? 0) >= 0.1).length > 1 ? "mixed" : use;
  const resShare = program.residential ?? 0;
  const unitsAuto = (gfa * resShare * PROGRAMME.resEfficiency) / Math.max(25, r.n("unitSize"));
  const units = r.n("units") > 0 ? r.n("units") : resShare > 0 ? Math.max(1, Math.round(unitsAuto)) : 0;
  const per: Partial<Record<Use, number>> = { office: PROGRAMME.officePerJob, retail: PROGRAMME.retailPerJob, civic: PROGRAMME.civicPerJob, education: PROGRAMME.educationPerJob, industrial: PROGRAMME.industrialPerJob, health: PROGRAMME.healthPerJob, hotel: 120, religious: 400, utility: 500, parking: 2000, other: 200 };
  let jobsAuto = 0;
  for (const [u, s] of shares) if (per[u as Use]) jobsAuto += (gfa * (s ?? 0)) / per[u as Use]!;
  const jobs = r.n("jobs") > 0 ? r.n("jobs") : Math.round(jobsAuto);

  const name = r.s("name").trim();
  const worldMasses = masses.map((m) => ({ ...m, poly: polyToWorld(frame, m.poly) }));
  const height = Math.max(...worldMasses.map((m) => m.top));
  const tint = r.n("tint");
  const b = out.building(
    {
      footprint: polyToWorld(frame, local),
      masses: worldMasses,
      height,
      floors,
      use: bUse,
      program: Object.fromEntries(shares.map(([k2, v]) => [k2, Math.round((v ?? 0) * 1000) / 1000])) as Partial<Record<Use, number>>,
      style: { facade: fp.facade, color: wall, tint },
      storeys: { ground: st.groundH, typical: st.typH },
      solids: solidsToWorld(frame, solids),
      greenRoof: green || undefined,
      notes: `${floors} floors, ${fmt.m(height)}, GFA ${fmt.m2(gfa)}${units ? `, ${units} units` : ""}${jobs ? `, ${jobs} jobs` : ""}`,
      ...(name ? { name } : {}),
    },
    primary,
  );
  if (!b.greenRoof) delete b.greenRoof;
  if (r.n("units") > 0 || r.n("jobs") > 0) {
    b.occupancy = { gfa: Math.round(gfa) };
    if (r.n("units") > 0) b.occupancy.units = units;
    if (r.n("jobs") > 0) b.occupancy.jobs = jobs;
  }
  return {
    building: b,
    frame,
    local,
    bbox: polyBBox(local),
    height,
    floors,
    groundH: st.groundH,
    gfa,
    units,
    jobs,
    front,
    addSolids(s: Solid[]) {
      b.solids = [...(b.solids ?? []), ...solidsToWorld(frame, s)];
    },
    addMass(poly: Polygon, base: number, top: number, role: Mass["role"]) {
      if (!isValidPoly(poly) || top <= base) return;
      b.masses.push({ poly: polyToWorld(frame, poly), base, top, role, use });
      b.height = Math.max(b.height, top);
    },
  };
}

// ---------------------------------------------------------------- building types

export interface DecorateArgs {
  r: Reader;
  out: Out;
  frame: Frame;
  info: BuildingInfo;
  place: PlacementInput;
  ctx: GenerateContext;
}

export interface BuildingTypeOpts {
  id: string;
  name: string;
  category: Category;
  description: string;
  tags?: string[];
  icon?: string;
  /** default overrides for universal params */
  defaults?: ParamValues;
  /** other field overrides (labels, ranges) for universal params */
  patch?: Record<string, Partial<ParamSpec>>;
  /** additional type-specific params (shown first in their groups) */
  extra?: ParamSpec[];
  placement?: Placement;
  /** add site elements around the building (local frame, see info) */
  decorate?: (a: DecorateArgs) => void;
  /** override the frame the building is built in (e.g. shift it within its site to leave room for grounds) */
  layout?: (r: Reader, frame: Frame) => Frame;
}

function summaryOf(name: string, i: BuildingInfo): string {
  return `${name}: ${i.floors} floor${i.floors > 1 ? "s" : ""}, ${fmt.m(i.height)}, ${fmt.m2(polyArea(i.local))} footprint, GFA ${fmt.m2(i.gfa)}${i.units ? `, ${fmt.int(i.units)} units` : ""}${i.jobs ? `, ≈${fmt.int(i.jobs)} jobs` : ""}`;
}

export function buildingType(o: BuildingTypeOpts): PrimitiveDef {
  const params = [...(o.extra ?? []), ...withDefaults(BUILDING_PARAMS, o.defaults, o.patch)];
  return {
    id: o.id,
    name: o.name,
    category: o.category,
    description: o.description,
    tags: o.tags,
    icon: o.icon ?? "building",
    placement: o.placement ?? "rect",
    params,
    generate(values, place, ctx) {
      const r = reader(values, params);
      const out = new Out(ctx);
      let frame = frameOf(place);
      if (o.layout) frame = o.layout(r, frame);
      const info = buildBuilding(out, r, frame);
      if (info) {
        o.decorate?.({ r, out, frame, info, place, ctx });
        // the placement op reports each building's floors, height, GFA, homes and jobs itself
        void summaryOf;
      }
      return out.done();
    },
  };
}

/** the main entity's local helpers for decorators: a rectangle ring in local coordinates */
export const rectLocal = (cx: number, cy: number, w: number, d: number): Polygon => [[[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]]];

export { box, floorHeightsFor };

// ---------------------------------------------------------------- rows and clusters of buildings

const ROW_PARAMS: ParamSpec[] = [
  int("count", "Buildings in row", 6, { group: "Layout", min: 1, max: 40, description: "Number of attached units / buildings" }),
  num("unitWidth", "Unit frontage", 6.5, { group: "Layout", unit: "m", min: 3, max: 60, step: 0.1, description: "Width of each unit along the row (rowhouse lots are typically 16–25 ft)" }),
  num("gap", "Gap between units", 0, { group: "Layout", unit: "m", min: 0, max: 30, step: 0.5, description: "0 = attached (party walls)" }),
  num("stagger", "Front stagger", 0, { group: "Layout", unit: "m", min: 0, max: 10, step: 0.1, description: "Alternate units step forward / back" }),
  int("heightVariation", "Height variation", 0, { group: "Layout", min: 0, max: 5, unit: "floors", description: "Random extra floors per unit" }),
  bool("varyColour", "Vary colours", true, { group: "Layout" }),
];

const ROW_FACADES: FacadeKey[] = ["brick_red", "brick_buff", "siding_blue", "stucco_cream", "brick_brown", "siding_sage", "stucco_pink", "limestone", "siding_yellow"];

/** a row of attached (or spaced) buildings sharing one parameter set: rowhouses, townhouses, shopfronts */
export function buildingRowType(o: Omit<BuildingTypeOpts, "layout">): PrimitiveDef {
  const params = [...ROW_PARAMS.map((p) => (o.defaults && p.key in o.defaults ? ({ ...p, default: o.defaults[p.key] } as ParamSpec) : p)), ...(o.extra ?? []), ...withDefaults(BUILDING_PARAMS, Object.fromEntries(Object.entries(o.defaults ?? {}).filter(([k2]) => !ROW_PARAMS.some((p) => p.key === k2))), o.patch)];
  return {
    id: o.id,
    name: o.name,
    category: o.category,
    description: o.description,
    tags: o.tags,
    icon: o.icon ?? "building",
    placement: o.placement ?? "rect",
    params,
    generate(values, place, ctx) {
      const r = reader(values, params);
      const out = new Out(ctx);
      const frame = frameOf(place);
      const fit = frame.siteW > 0 && r.b("fitToSite");
      let n = r.n("count");
      let uw = r.n("unitWidth");
      const gap = r.n("gap");
      if (fit) {
        n = Math.max(1, Math.floor((frame.siteW + gap) / (uw + gap)));
        uw = (frame.siteW - gap * (n - 1)) / n;
      }
      const depth = fit ? Math.max(4, Math.min(frame.siteD, r.n("depth"))) : r.n("depth");
      const total = n * uw + (n - 1) * gap;
      const rand = rngOf(ctx);
      let units = 0,
        gfa = 0;
      const floorsBase = r.n("floors");
      for (let i = 0; i < n; i++) {
        const x = -total / 2 + uw / 2 + i * (uw + gap);
        const y = (i % 2 ? 1 : -1) * (r.n("stagger") / 2) + (fit ? frame.siteD / 2 - depth / 2 : 0);
        const fl = floorsBase + Math.floor(rand() * (r.n("heightVariation") + 1));
        const v: ParamValues = { ...values, floors: fl, shape: "rect", width: uw, depth, fitToSite: false, targetArea: 0 };
        if (r.b("varyColour") && !r.b("customColor")) v.facade = ROW_FACADES[(i + Math.floor(rand() * 3)) % ROW_FACADES.length];
        const rr = reader(v, params);
        const sub: Frame = { c: toW(frame, [x, y]), a: frame.a, siteW: 0, siteD: 0 };
        const info = buildBuilding(out, rr, sub, {}, i === 0);
        if (!info) continue;
        o.decorate?.({ r: rr, out, frame: sub, info, place, ctx });
        units += info.units;
        gfa += info.gfa;
      }
      out.summary.unshift(`${o.name}: ${n} units of ${fmtDims(uw, depth)}, ${floorsBase}+ floors, GFA ${fmt.m2(gfa)}${units ? `, ${units} homes` : ""}`);
      return out.done();
    },
  };
}

const CLUSTER_PARAMS: ParamSpec[] = [
  int("rows", "Rows of buildings", 2, { group: "Layout", min: 1, max: 12 }),
  int("cols", "Buildings per row", 3, { group: "Layout", min: 1, max: 12 }),
  num("spacingX", "Spacing across", 12, { group: "Layout", unit: "m", min: 0, max: 100, step: 0.5, description: "Clear distance between buildings side by side" }),
  num("spacingY", "Spacing front–back", 16, { group: "Layout", unit: "m", min: 0, max: 100, step: 0.5, description: "Clear distance between rows (courtyards, lawns)" }),
  bool("lawn", "Shared lawn", true, { group: "Layout" }),
  int("treesPerGap", "Trees per courtyard", 2, { group: "Layout", min: 0, max: 10 }),
];

/** a grid of identical (or varied) buildings with shared grounds: garden apartments, business parks, dorm quads */
export function buildingClusterType(o: Omit<BuildingTypeOpts, "layout">): PrimitiveDef {
  const params = [...CLUSTER_PARAMS.map((p) => (o.defaults && p.key in o.defaults ? ({ ...p, default: o.defaults[p.key] } as ParamSpec) : p)), ...(o.extra ?? []), ...withDefaults(BUILDING_PARAMS, Object.fromEntries(Object.entries(o.defaults ?? {}).filter(([k2]) => !CLUSTER_PARAMS.some((p) => p.key === k2))), o.patch)];
  return {
    id: o.id,
    name: o.name,
    category: o.category,
    description: o.description,
    tags: o.tags,
    icon: o.icon ?? "building",
    placement: o.placement ?? "rect",
    params,
    generate(values, place, ctx) {
      const r = reader(values, params);
      const out = new Out(ctx);
      const frame = frameOf(place);
      let rows = r.n("rows"),
        cols = r.n("cols");
      const sx = r.n("spacingX"),
        sy = r.n("spacingY");
      let w = r.n("width"),
        d = r.n("depth");
      if (frame.siteW > 0 && r.b("fitToSite")) {
        // fit as many buildings of the given size as the site allows
        cols = Math.max(1, Math.floor((frame.siteW - 4 + sx) / (w + sx)));
        rows = Math.max(1, Math.floor((frame.siteD - 4 + sy) / (d + sy)));
        w = Math.min(w, frame.siteW - 4);
        d = Math.min(d, frame.siteD - 4);
      }
      const TW = cols * w + (cols - 1) * sx,
        TD = rows * d + (rows - 1) * sy;
      if (r.b("lawn")) out.area("grass", polyToWorld(frame, rectLocal(0, 0, frame.siteW > 0 ? frame.siteW : TW + 12, frame.siteD > 0 ? frame.siteD : TD + 12)), { primary: false });
      let units = 0,
        gfa = 0,
        k = 0;
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const x = -TW / 2 + w / 2 + i * (w + sx),
            y = -TD / 2 + d / 2 + j * (d + sy);
          const v: ParamValues = { ...values, width: w, depth: d, fitToSite: false };
          const rr = reader(v, params);
          const sub: Frame = { c: toW(frame, [x, y]), a: frame.a, siteW: 0, siteD: 0 };
          const info = buildBuilding(out, rr, sub, {}, k++ === 0);
          if (!info) continue;
          o.decorate?.({ r: rr, out, frame: sub, info, place, ctx });
          units += info.units;
          gfa += info.gfa;
        }
      // trees in the courtyards between rows
      const nt = r.n("treesPerGap");
      if (nt > 0 && sy >= 8)
        for (let j = 0; j < rows - 1; j++) {
          const y = -TD / 2 + (j + 1) * d + j * sy + sy / 2;
          for (let t = 0; t < nt * cols; t++) {
            const x = -TW / 2 + (TW * (t + 0.5)) / (nt * cols);
            const rad = Math.min(4, sy / 2 - 1.5);
            if (rad > 1.5) out.tree(toW(frame, [x, y]), rad, rad * 2.2, "live_oak", false);
          }
        }
      out.summary.unshift(`${o.name}: ${rows * cols} buildings, GFA ${fmt.m2(gfa)}${units ? `, ${units} homes` : ""}`);
      return out.done();
    },
  };
}

const rngOf = (ctx: GenerateContext) => rng(hashSeed(ctx.ref?.instance ?? "row"));
