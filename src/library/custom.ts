// Framework primitives — escape hatches built into the library core so the agent (and the palette)
// can make things the catalog doesn't have:
//   custom.building  every massing variable: plan shape, size, floors and floor heights, procedural
//                    typology, tiers with taper and twist, setbacks, podium / towers, roof form,
//                    colour, façade, programme mix and stated occupancy.
//   custom.prop      any object from raw solids (box, cylinder, cone, sphere, hemisphere, wedge,
//                    pyramid, torus), with optional shade crown and ground cover.
// Both are ordinary PrimitiveDefs, so instances re-configure, move and persist like catalog ones.

import { generateMassing, floorHeights, massesGFA, TYPOLOGIES, type MassingSpec, type Typology } from "@/geometry/massing";
import { bufferPoly, circle, isValidPoly, normalizePoly, obb, polyCentroid, rectangle, rotatePoly, scalePoly } from "@/geometry/polygon";
import { add, rot } from "@/geometry/vec";
import type { Building, Mass, Polygon, Prop, PropCover, Ring, Solid, SolidMaterial, SolidShape, Use, Vec2 } from "@/world/types";
import { getPrimitive, hexToRgb, normColor, registerPrimitive } from "./registry";
import type { ParamSpec, ParamValues, PrimitiveDef } from "./types";
import { propFootprint, solidsHeight } from "./frame";

const USES: Use[] = ["residential", "office", "retail", "mixed", "hotel", "civic", "education", "religious", "health", "industrial", "parking", "utility", "other"];
const opt = (vs: readonly string[], label = (v: string) => v.replace(/_/g, " ")) => vs.map((v) => ({ value: v, label: label(v)[0].toUpperCase() + label(v).slice(1) }));
const RAD = Math.PI / 180;

export const PLAN_SHAPES = ["rect", "square", "circle", "ellipse", "polygon", "triangle", "l_shape", "u_shape", "t_shape", "h_shape", "cross", "courtyard", "ring", "trapezoid", "site"] as const;
export type PlanShape = (typeof PLAN_SHAPES)[number];
export const ROOFS = ["flat", "gable", "hip", "shed", "pyramid", "dome", "barrel", "sawtooth", "mansard"] as const;
const MIX_KEYS: [string, Use][] = [
  ["mix_residential", "residential"],
  ["mix_office", "office"],
  ["mix_retail", "retail"],
  ["mix_hotel", "hotel"],
  ["mix_civic", "civic"],
  ["mix_education", "education"],
  ["mix_health", "health"],
  ["mix_industrial", "industrial"],
];

/** plan outline (outer ring + optional hole) centred at c, long side along +x before rotation */
export function planShape(shape: PlanShape, c: Vec2, w: number, d: number, opts: { sides?: number; wing?: number; rotation?: number } = {}): Polygon {
  const ang = (opts.rotation ?? 0) * RAD;
  const wing = Math.max(3, Math.min(opts.wing ?? Math.min(w, d) * 0.35, Math.min(w, d) * 0.49));
  const T = (pts: Vec2[]): Ring => pts.map((p) => add(c, rot(p, ang)));
  const hw = w / 2,
    hd = d / 2;
  switch (shape) {
    case "square":
      return [T(rectangle([0, 0], Math.max(w, d), Math.max(w, d)))];
    case "circle":
      return [T(circle([0, 0], Math.max(w, d) / 2, 48))];
    case "ellipse":
      return [T(circle([0, 0], 1, 48).map(([x, y]) => [x * hw, y * hd] as Vec2))];
    case "polygon": {
      const n = Math.max(3, Math.min(24, Math.round(opts.sides ?? 6)));
      return [T(Array.from({ length: n }, (_, k) => [Math.cos((k / n) * 2 * Math.PI + Math.PI / 2) * hw, Math.sin((k / n) * 2 * Math.PI + Math.PI / 2) * hd] as Vec2))];
    }
    case "triangle":
      return [T([[-hw, -hd], [hw, -hd], [0, hd]])];
    case "trapezoid":
      return [T([[-hw, -hd], [hw, -hd], [hw * 0.6, hd], [-hw * 0.6, hd]])];
    case "l_shape":
      return [T([[-hw, -hd], [hw, -hd], [hw, -hd + wing], [-hw + wing, -hd + wing], [-hw + wing, hd], [-hw, hd]])];
    case "u_shape":
      return [T([[-hw, -hd], [hw, -hd], [hw, hd], [hw - wing, hd], [hw - wing, -hd + wing], [-hw + wing, -hd + wing], [-hw + wing, hd], [-hw, hd]])];
    case "t_shape":
      return [T([[-hw, hd - wing], [-wing / 2, hd - wing], [-wing / 2, -hd], [wing / 2, -hd], [wing / 2, hd - wing], [hw, hd - wing], [hw, hd], [-hw, hd]])];
    case "h_shape":
      return [T([[-hw, -hd], [-hw + wing, -hd], [-hw + wing, -wing / 2], [hw - wing, -wing / 2], [hw - wing, -hd], [hw, -hd], [hw, hd], [hw - wing, hd], [hw - wing, wing / 2], [-hw + wing, wing / 2], [-hw + wing, hd], [-hw, hd]])];
    case "cross":
      return [T([[-wing / 2, -hd], [wing / 2, -hd], [wing / 2, -wing / 2], [hw, -wing / 2], [hw, wing / 2], [wing / 2, wing / 2], [wing / 2, hd], [-wing / 2, hd], [-wing / 2, wing / 2], [-hw, wing / 2], [-hw, -wing / 2], [-wing / 2, -wing / 2]])];
    case "courtyard":
      return normalizePoly([T(rectangle([0, 0], w, d)), T(rectangle([0, 0], Math.max(1, w - 2 * wing), Math.max(1, d - 2 * wing)))]);
    case "ring": {
      const r = Math.max(w, d) / 2;
      return normalizePoly([T(circle([0, 0], r, 48)), T(circle([0, 0], Math.max(1, r - wing), 48))]);
    }
    default:
      return [T(rectangle([0, 0], w, d))];
  }
}

function solidsForRoof(kind: string, poly: Polygon, base: number, h: number, color: [number, number, number], rotation: number): Solid[] {
  if (kind === "flat" || h <= 0.05) return [];
  const o = obb(poly[0]);
  const yaw = (o.angle * 180) / Math.PI;
  const L = o.length,
    W = o.width;
  const at: [number, number, number] = [o.center[0], o.center[1], base];
  const mat: SolidMaterial = "stone";
  switch (kind) {
    case "gable":
      return [{ shape: "wedge", at, size: [L, W, h], rot: yaw, color, material: mat }];
    case "shed": {
      // a mono-pitch slab rising across the short side
      const pitch = (Math.atan2(h, W) * 180) / Math.PI;
      return [{ shape: "box", at: [o.center[0], o.center[1], base + h / 2 - 0.15], size: [L, Math.hypot(W, h), 0.3], rot: yaw, tilt: [pitch, 0], color, material: mat }];
    }
    case "hip":
    case "pyramid":
      return [{ shape: "pyramid", at, size: [L, W, h], rot: yaw, color, material: mat }];
    case "mansard":
      return [
        { shape: "pyramid", at, size: [L, W, h * 0.6], rot: yaw, color, material: mat },
        { shape: "box", at: [at[0], at[1], base], size: [L * 0.72, W * 0.72, h], rot: yaw, color, material: mat },
      ];
    case "dome": {
      const r = Math.min(L, W) * 0.9;
      return [{ shape: "hemisphere", at, size: [r, r, Math.min(h, r / 2) || r / 2], rot: yaw, color, material: "metal" }];
    }
    case "barrel":
      // a half-ellipsoid vault over the top plate
      return [{ shape: "hemisphere", at, size: [L, W, h], rot: yaw, color, material: "metal" }];
    case "sawtooth": {
      const n = Math.max(2, Math.round(L / 8));
      const out: Solid[] = [];
      for (let k = 0; k < n; k++) {
        const off = -L / 2 + (k + 0.5) * (L / n);
        out.push({ shape: "wedge", at: [o.center[0] + Math.cos(o.angle) * off, o.center[1] + Math.sin(o.angle) * off, base], size: [W, L / n, h], rot: yaw + 90, color, material: mat });
      }
      return out;
    }
  }
  void rotation;
  return [];
}

const customBuildingParams: ParamSpec[] = [
  { key: "shape", label: "Plan shape", group: "Plan", type: "enum", default: "rect", options: opt(PLAN_SHAPES), description: "Footprint outline; 'site' uses the drawn site polygon as is" },
  { key: "width", label: "Width", group: "Plan", type: "number", default: 30, min: 3, max: 400, step: 0.5, unit: "m", description: "Plan extent along the building's long axis (ignored for shape 'site')" },
  { key: "depth", label: "Depth", group: "Plan", type: "number", default: 20, min: 3, max: 400, step: 0.5, unit: "m" },
  { key: "sides", label: "Polygon sides", group: "Plan", type: "integer", default: 6, min: 3, max: 24, when: { key: "shape", in: ["polygon"] } },
  { key: "wing", label: "Wing / bar depth", group: "Plan", type: "number", default: 12, min: 3, max: 60, unit: "m", when: { key: "shape", in: ["l_shape", "u_shape", "t_shape", "h_shape", "cross", "courtyard", "ring"] } },
  { key: "typology", label: "Massing typology", group: "Massing", type: "enum", default: "extrude", options: opt(["extrude", ...TYPOLOGIES]), description: "'extrude' stacks the plan shape (with tiers / taper / twist); others run the procedural massing generator on it" },
  { key: "floors", label: "Floors", group: "Massing", type: "integer", default: 6, min: 1, max: 160, unit: "floors" },
  { key: "floor_height", label: "Typical floor height", group: "Massing", type: "number", default: 0, min: 0, max: 12, step: 0.1, unit: "m", description: "0 = typical for the use" },
  { key: "ground_floor_height", label: "Ground floor height", group: "Massing", type: "number", default: 0, min: 0, max: 15, step: 0.1, unit: "m", description: "0 = typical for the use" },
  { key: "tiers", label: "Tiers", group: "Massing", type: "integer", default: 1, min: 1, max: 40, description: "Stacked volumes for taper / twist / stepped forms", when: { key: "typology", in: ["extrude"] } },
  { key: "taper", label: "Top scale", group: "Massing", type: "number", default: 1, min: 0.1, max: 2, step: 0.05, description: "Plan scale of the top tier relative to the base (<1 tapers, >1 cantilevers)", when: { key: "typology", in: ["extrude"] } },
  { key: "twist", label: "Twist", group: "Massing", type: "number", default: 0, min: -180, max: 180, unit: "°", description: "Total rotation from bottom to top tier", when: { key: "typology", in: ["extrude"] } },
  { key: "podium_floors", label: "Podium floors", group: "Massing", type: "integer", default: 0, min: 0, max: 20, description: "Extrude: a podium on the full plan below the tiers; typologies: podium height" },
  { key: "podium_inset", label: "Tower inset above podium", group: "Massing", type: "number", default: 0.65, min: 0.1, max: 1, step: 0.05, description: "Plan scale of the tiers above a podium (extrude)", when: { key: "typology", in: ["extrude"] } },
  { key: "tower_coverage", label: "Tower plate (share of podium)", group: "Massing", type: "number", default: 0.35, min: 0.1, max: 0.8, step: 0.05, advanced: true },
  { key: "tower_count", label: "Towers", group: "Massing", type: "integer", default: 1, min: 1, max: 6, advanced: true },
  { key: "bar_depth", label: "Bar depth", group: "Massing", type: "number", default: 14, min: 6, max: 40, unit: "m", advanced: true },
  { key: "setback_every", label: "Setback every (floors)", group: "Massing", type: "integer", default: 0, min: 0, max: 60, description: "0 = no stepped setbacks", advanced: true },
  { key: "setback_depth", label: "Setback depth", group: "Massing", type: "number", default: 3, min: 0, max: 20, unit: "m", advanced: true },
  { key: "edge_setback", label: "Setback from site edge", group: "Massing", type: "number", default: 0, min: 0, max: 30, unit: "m", advanced: true },
  { key: "crown", label: "Crown", group: "Massing", type: "boolean", default: false, advanced: true },
  { key: "roof", label: "Roof form", group: "Roof", type: "enum", default: "flat", options: opt(ROOFS) },
  { key: "roof_height", label: "Roof height", group: "Roof", type: "number", default: 4, min: 0, max: 60, unit: "m", when: { key: "roof", in: ROOFS.filter((r) => r !== "flat") } },
  { key: "roof_color", label: "Roof colour", group: "Roof", type: "color", default: "#6b5e55", when: { key: "roof", in: ROOFS.filter((r) => r !== "flat") } },
  { key: "green_roof", label: "Green roof", group: "Roof", type: "boolean", default: false },
  { key: "color", label: "Wall colour", group: "Facade", type: "color", default: "#d8d2c4" },
  { key: "facade", label: "Façade material", group: "Facade", type: "enum", default: "concrete", options: opt(["glass", "masonry", "concrete", "metal", "timber", "stucco"]) },
  { key: "use", label: "Primary use", group: "Programme", type: "enum", default: "residential", options: opt(USES) },
  ...MIX_KEYS.map(([k, u]): ParamSpec => ({ key: k, label: `${u[0].toUpperCase() + u.slice(1)} share`, group: "Programme", type: "number", default: 0, min: 0, max: 100, unit: "%", advanced: true, description: "Use mix by floor area; all zero = 100% primary use" })),
  { key: "units", label: "Homes", group: "Programme", type: "integer", default: 0, min: 0, max: 20000, description: "Stated number of homes; 0 = from floor area" },
  { key: "jobs", label: "Jobs", group: "Programme", type: "integer", default: 0, min: 0, max: 100000, description: "Stated number of jobs; 0 = from floor area" },
  { key: "name", label: "Name", group: "Identity", type: "text", default: "", maxLength: 120 },
];

function buildCustomBuilding(p: ParamValues, place: { at?: Vec2; rotation?: number; site?: Polygon }): { building: Omit<Building, "id" | "lib">; notes: string[] } {
  const use = p.use as Use;
  const shape = p.shape as PlanShape;
  const at = place.at ?? (place.site ? polyCentroid(place.site) : [0, 0]);
  const rotation = place.rotation ?? 0;
  let plan: Polygon = shape === "site" && place.site ? place.site : planShape(shape === "site" ? "rect" : shape, at, p.width as number, p.depth as number, { sides: p.sides as number, wing: p.wing as number, rotation });
  if ((p.edge_setback as number) > 0 && (p.typology as string) === "extrude") {
    // procedural typologies take the edge setback themselves
    const inner = bufferPoly(plan, -(p.edge_setback as number));
    if (isValidPoly(inner)) plan = inner;
  }
  const fh = floorHeights(use);
  const typ = (p.floor_height as number) || fh.typ;
  const gnd = (p.ground_floor_height as number) || fh.ground;
  const floors = p.floors as number;
  const heightAt = (f: number) => (f <= 0 ? 0 : gnd + (f - 1) * typ);
  const notes: string[] = [];
  let masses: Mass[] = [];
  let footprint: Polygon = plan;
  if ((p.typology as string) === "extrude") {
    const c = polyCentroid(plan);
    const pod = Math.min(p.podium_floors as number, floors - 1);
    if (pod > 0) masses.push({ poly: plan, base: 0, top: heightAt(pod), role: "podium", use });
    const tiers = Math.max(1, Math.min(p.tiers as number, floors - pod));
    const start = pod;
    const k0 = pod > 0 ? (p.podium_inset as number) : 1;
    for (let t = 0; t < tiers; t++) {
      const f0 = start + Math.round(((floors - start) * t) / tiers);
      const f1 = start + Math.round(((floors - start) * (t + 1)) / tiers);
      if (f1 <= f0) continue;
      const frac = tiers > 1 ? t / (tiers - 1) : 0;
      const s = k0 * (1 + ((p.taper as number) - 1) * frac);
      const tw = (p.twist as number) * frac;
      let poly = scalePoly(plan, c, s);
      if (tw) poly = rotatePoly(poly, c, tw * RAD);
      masses.push({ poly, base: heightAt(f0), top: heightAt(f1), role: pod > 0 ? "tower" : t === 0 ? "body" : "setback", use });
    }
    if ((p.setback_every as number) > 0 && (p.setback_depth as number) > 0) notes.push("stepped setbacks apply to procedural typologies; use tiers + taper for an extruded form");
  } else {
    const spec: MassingSpec = {
      typology: p.typology as Typology,
      floors,
      use,
      podiumFloors: (p.podium_floors as number) || undefined,
      towerCoverage: p.tower_coverage as number,
      barDepth: p.bar_depth as number,
      setbackEvery: (p.setback_every as number) || undefined,
      setbackDepth: p.setback_depth as number,
      edgeSetback: (p.edge_setback as number) || undefined,
      towerCount: p.tower_count as number,
      orientation: rotation * RAD,
      crown: p.crown as boolean,
    };
    const g = generateMassing(plan, spec);
    masses = g.masses.map((m) => ({ ...m, use: m.use ?? use }));
    footprint = g.footprint;
    notes.push(...g.notes);
    // custom floor heights rescale the generated volumes
    const k = heightAt(floors) / Math.max(1, g.height);
    if (Math.abs(k - 1) > 0.01) masses = masses.map((m) => ({ ...m, base: m.base * k, top: m.top * k }));
  }
  masses = masses.filter((m) => isValidPoly(m.poly) && m.top > m.base);
  const height = Math.max(...masses.map((m) => m.top));
  const mix: Partial<Record<Use, number>> = {};
  let tot = 0;
  for (const [k, u] of MIX_KEYS) {
    const v = p[k] as number;
    if (v > 0) {
      mix[u] = (mix[u] ?? 0) + v;
      tot += v;
    }
  }
  const program: Partial<Record<Use, number>> = tot > 0 ? Object.fromEntries(Object.entries(mix).map(([u, v]) => [u, (v as number) / tot])) : use === "mixed" ? { residential: 0.82, retail: 0.12, office: 0.06 } : { [use]: 1 };
  const top = masses.reduce((a, m) => (m.top >= a.top ? m : a), masses[0]);
  const roofColor = hexToRgb(p.roof_color as string);
  const solids = top ? solidsForRoof(p.roof as string, top.poly, top.top, p.roof_height as number, roofColor, rotation) : [];
  const b: Omit<Building, "id" | "lib"> = {
    kind: "building",
    footprint,
    masses,
    height,
    floors,
    use,
    program,
    name: (p.name as string) || undefined,
    greenRoof: (p.green_roof as boolean) || undefined,
    ground: NaN,
    heightSource: "proposed",
    useSource: "proposed",
    source: "",
    style: { facade: p.facade as NonNullable<Building["style"]>["facade"], color: hexToRgb(p.color as string) },
    storeys: { ground: gnd, typical: typ },
    ...(solids.length ? { solids } : {}),
    notes: notes.length ? notes.join("; ") : undefined,
  };
  return { building: b, notes };
}

export const customBuilding: PrimitiveDef = {
  id: "custom.building",
  name: "Custom building",
  category: "buildings",
  tags: ["custom", "bespoke", "massing", "any shape", "tower", "block", "pavilion", "escape hatch"],
  description: "Any building from explicit massing variables: plan shape and size, floors and floor heights, procedural typology or tiers with taper / twist, podium, setbacks, roof form, colour, façade, use mix and stated homes / jobs.",
  placement: "rect",
  icon: "building",
  params: customBuildingParams,
  generate(params, place, ctx) {
    const { building, notes } = buildCustomBuilding(params, place);
    const b: Building = { ...building, id: ctx.id("b"), lib: { ...ctx.ref, primary: true } };
    if ((params.units as number) > 0 || (params.jobs as number) > 0) b.occupancy = { ...((params.units as number) > 0 ? { units: params.units as number } : {}), ...((params.jobs as number) > 0 ? { jobs: params.jobs as number } : {}), gfa: massesGFA(b.masses, b.use === "mixed" ? "residential" : b.use) };
    return { buildings: [b], warnings: notes.filter((n) => /could not|too small/i.test(n)) };
  },
};

const SHAPES: SolidShape[] = ["box", "cylinder", "cone", "sphere", "hemisphere", "wedge", "pyramid", "torus"];
const MATERIALS: SolidMaterial[] = ["foliage", "wood", "metal", "stone", "concrete", "glass", "water", "fabric", "plastic", "fur", "light"];

/** coerce agent-supplied solids: unknown shapes fall back to box, sizes floored, colours accepted as hex or [r,g,b] */
export function normalizeSolids(raw: unknown): { solids: Solid[]; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(raw)) return { solids: [], problems: ["solids must be an array"] };
  const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && Number.isFinite(Number(x)) ? Number(x) : d);
  const v3 = (x: unknown, d: [number, number, number]): [number, number, number] => (Array.isArray(x) ? [num(x[0], d[0]), num(x[1], d[1]), num(x[2], d[2])] : d);
  const solids: Solid[] = [];
  raw.slice(0, 400).forEach((s: Record<string, unknown>, k) => {
    if (!s || typeof s !== "object") return void problems.push(`solid ${k}: not an object`);
    const shape = SHAPES.includes(s.shape as SolidShape) ? (s.shape as SolidShape) : "box";
    if (s.shape !== undefined && shape !== s.shape) problems.push(`solid ${k}: shape "${String(s.shape)}" is not one of ${SHAPES.join(", ")}; using box`);
    const size = v3(s.size, [1, 1, 1]).map((x) => Math.max(0.01, Math.abs(x))) as [number, number, number];
    const color: [number, number, number] = typeof s.color === "string" ? hexToRgb(normColor(s.color) ?? "#888888") : Array.isArray(s.color) ? v3(s.color, [136, 136, 136]).map((x) => Math.max(0, Math.min(255, Math.round(x)))) as [number, number, number] : [136, 136, 136];
    const out: Solid = { shape, at: v3(s.at, [0, 0, 0]), size, color };
    if (s.rot !== undefined) out.rot = num(s.rot, 0);
    if (Array.isArray(s.tilt)) out.tilt = [num(s.tilt[0], 0), num(s.tilt[1], 0)];
    if (MATERIALS.includes(s.material as SolidMaterial)) out.material = s.material as SolidMaterial;
    solids.push(out);
  });
  if (raw.length > 400) problems.push("only the first 400 solids are used");
  return { solids, problems };
}

export const customProp: PrimitiveDef = {
  id: "custom.prop",
  name: "Custom object",
  category: "streetscape",
  tags: ["custom", "object", "sculpture", "structure", "solids", "escape hatch"],
  description: "Any object built from raw solids in its own frame (x east / y north before rotation, z up, metres), with optional shade crown and ground cover.",
  placement: "point",
  icon: "shapes",
  params: [
    { key: "solids", label: "Solids", type: "json", default: [{ shape: "box", at: [0, 0, 0], size: [1, 1, 1], color: "#888888" }], advanced: true, shape: "[{shape: box|cylinder|cone|sphere|hemisphere|wedge|pyramid|torus, at:[x,y,z] base centre, size:[x,y,z], rot?:deg, tilt?:[pitch,roll], color:'#rrggbb'|[r,g,b], material?: foliage|wood|metal|stone|concrete|glass|water|fabric|plastic|fur|light}]" },
    { key: "shade_radius", label: "Shade radius", type: "number", default: 0, min: 0, max: 40, unit: "m", description: "Casts shade like a tree crown of this radius (0 = none)" },
    { key: "shade_height", label: "Shade height", type: "number", default: 3, min: 0.5, max: 60, unit: "m", description: "Height of the shading canopy" },
    { key: "cover", label: "Ground cover", type: "enum", default: "none", options: opt(["none", "water", "paving", "planting", "lawn", "permeable", "raingarden", "woodland", "bare"]), description: "What the footprint counts as in heat / runoff / green-cover models" },
    { key: "allow_carriageway", label: "May stand in the roadway", type: "boolean", default: false, advanced: true },
    { key: "name", label: "Name", type: "text", default: "", maxLength: 120 },
  ],
  generate(params, place, ctx) {
    const { solids, problems } = normalizeSolids(params.solids);
    if (!solids.length) throw new Error(problems[0] ?? "no solids");
    const p = place.at!;
    const rotDeg = place.rotation ?? 0;
    const pr: Prop = {
      id: ctx.id("p"),
      kind: "prop",
      type: "custom.prop",
      p,
      rot: rotDeg,
      solids,
      height: solidsHeight(solids),
      footprint: propFootprint(p, rotDeg, solids),
      source: "",
      provenance: "proposed",
      name: (params.name as string) || undefined,
      lib: { ...ctx.ref, primary: true },
    };
    if ((params.shade_radius as number) > 0) pr.shade = { r: params.shade_radius as number, h: params.shade_height as number };
    if (params.cover !== "none") pr.cover = params.cover as PropCover;
    return { props: [pr], warnings: problems };
  },
};

let done = false;
/** register the framework primitives (idempotent) */
export function registerBuiltins(): void {
  if (done) return;
  done = true;
  for (const d of [customBuilding, customProp]) if (!getPrimitive(d.id)) registerPrimitive(d);
}
