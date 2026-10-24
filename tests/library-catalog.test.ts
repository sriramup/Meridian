import { describe, expect, it } from "vitest";
import { heightForFloors } from "@/geometry/massing";
import { polyArea, ringArea } from "@/geometry/polygon";
import { CATALOG, registerCatalog } from "@/library/catalog";
import { footprintPoly, FOOTPRINT_SHAPES } from "@/library/geometry/footprints";
import { getPrimitive, listPrimitives, searchPrimitives, validateParams } from "@/library/registry";
import type { GenerateContext, Generated, ParamSpec, ParamValues, PlacementInput, PrimitiveDef } from "@/library/types";
import type { Polygon, Ring, Solid, Vec2 } from "@/world/types";

registerCatalog();

function ctxFor(def: PrimitiveDef, params: ParamValues, place: PlacementInput, inst = "inst1"): GenerateContext {
  let n = 0;
  return { id: (p) => `${p}_${++n}`, ref: { def: def.id, instance: inst, params, placement: place }, householdSize: 2.5 };
}

const SITE: Polygon = [[[-30, -20], [30, -20], [30, 20], [-30, 20]]];
const ODD_SITE: Polygon = [[[0, 0], [50, 5], [60, 40], [20, 55], [-5, 30]]];

function placementsFor(def: PrimitiveDef): PlacementInput[] {
  switch (def.placement) {
    case "point":
      return [{ at: [10, 5], rotation: 30 }];
    case "rect":
      return [{ at: [0, 0], rotation: 0 }, { site: SITE }, { site: ODD_SITE, rotation: 15 }];
    case "polygon":
      return [{ site: SITE }, { site: ODD_SITE }, { at: [0, 0] }];
    case "path":
      return [{ path: [[0, 0], [40, 0], [60, 25]] }, { at: [0, 0], rotation: 45 }];
  }
}

const finite = (x: number) => typeof x === "number" && Number.isFinite(x);

function segsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c),
    d2 = o(a, b, d),
    d3 = o(c, d, a),
    d4 = o(c, d, b);
  const eps = 1e-7;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function simpleRing(r: Ring): boolean {
  const n = r.length;
  if (n > 200) return true; // skip quadratic check on dense curves
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsCross(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n])) return false;
    }
  return true;
}

function checkPoly(p: Polygon, what: string, errs: string[]) {
  if (!p.length || p[0].length < 3) return errs.push(`${what}: empty polygon`);
  for (const r of p) for (const v of r) if (!finite(v[0]) || !finite(v[1])) return errs.push(`${what}: non-finite vertex`);
  if (ringArea(p[0]) <= 0) errs.push(`${what}: outer ring not CCW`);
  for (let i = 1; i < p.length; i++) if (ringArea(p[i]) >= 0) errs.push(`${what}: hole ${i} not CW`);
  if (polyArea(p) <= 0.01) errs.push(`${what}: zero area`);
  if (!simpleRing(p[0])) errs.push(`${what}: self-intersecting outer ring`);
}

function checkSolid(s: Solid, what: string, errs: string[]) {
  if (!s.at.every(finite) || !s.size.every(finite)) errs.push(`${what}: non-finite solid`);
  if (s.size.some((x) => x <= 0)) errs.push(`${what}: non-positive solid size ${s.size}`);
  if (s.rot !== undefined && !finite(s.rot)) errs.push(`${what}: bad rot`);
  if (s.tilt && !s.tilt.every(finite)) errs.push(`${what}: bad tilt`);
  if (s.color.some((c) => !finite(c) || c < 0 || c > 255)) errs.push(`${what}: bad colour`);
}

function validate(def: PrimitiveDef, g: Generated, inst = "inst1"): string[] {
  const errs: string[] = [];
  const all = [...(g.buildings ?? []), ...(g.props ?? []), ...(g.trees ?? []), ...(g.areas ?? []), ...(g.paths ?? [])];
  if (!all.length && !g.streets?.length) errs.push("generated nothing");
  const ids = new Set<string>();
  let primaries = 0;
  for (const e of all) {
    if (ids.has(e.id)) errs.push(`duplicate id ${e.id}`);
    ids.add(e.id);
    if (!e.lib || e.lib.def !== def.id || e.lib.instance !== inst) errs.push(`${e.id}: missing / wrong LibraryRef`);
    if (e.lib?.primary) primaries++;
  }
  if (all.length && primaries !== 1) errs.push(`${primaries} primary entities`);
  for (const b of g.buildings ?? []) {
    checkPoly(b.footprint, `building ${b.id} footprint`, errs);
    if (!b.masses.length) errs.push(`building ${b.id}: no masses`);
    for (const m of b.masses) {
      checkPoly(m.poly, `building ${b.id} mass`, errs);
      if (!(m.top > m.base) || !finite(m.top) || !finite(m.base) || m.base < 0) errs.push(`building ${b.id}: mass ${m.base}..${m.top}`);
    }
    if (!(b.height > 0) || !finite(b.height)) errs.push(`building ${b.id}: height ${b.height}`);
    const sum = Object.values(b.program).reduce((s, v) => s + (v ?? 0), 0);
    if (Math.abs(sum - 1) > 0.02) errs.push(`building ${b.id}: programme sums to ${sum}`);
    for (const s of b.solids ?? []) checkSolid(s, `building ${b.id}`, errs);
  }
  for (const p of g.props ?? []) {
    if (!p.solids.length) errs.push(`prop ${p.id}: no solids`);
    for (const s of p.solids) checkSolid(s, `prop ${p.id} (${p.type})`, errs);
    if (!(p.height > 0) || !finite(p.p[0]) || !finite(p.p[1]) || !finite(p.rot)) errs.push(`prop ${p.id}: bad placement`);
    if (p.shade && !(p.shade.r > 0 && p.shade.h > 0)) errs.push(`prop ${p.id}: bad shade`);
  }
  for (const t of g.trees ?? []) if (!(t.r > 0 && t.h > 0 && finite(t.p[0]) && finite(t.p[1]))) errs.push(`tree ${t.id}: bad`);
  for (const a of g.areas ?? []) checkPoly(a.poly, `area ${a.id} (${a.type})`, errs);
  for (const p of g.paths ?? []) if (p.path.length < 2 || !p.path.every((v) => finite(v[0]) && finite(v[1]))) errs.push(`path ${p.id}: bad`);
  for (const s of g.streets ?? []) if (s.path.length < 2 || !s.path.every((v) => finite(v[0]) && finite(v[1]))) errs.push(`street: bad path`);
  return errs;
}

/** deterministic pseudo-random */
function rand(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomParams(specs: ParamSpec[], r: () => number): ParamValues {
  const out: ParamValues = {};
  for (const p of specs) {
    if (r() < 0.35) continue; // keep some defaults
    switch (p.type) {
      case "number":
      case "integer": {
        const lo = p.min ?? (p.default as number) * 0.25;
        const hi = p.max ?? Math.max(1, (p.default as number) * 4);
        // bias towards the lower part of huge ranges so fuzzing stays fast
        const t = r() ** 2;
        const v = lo + (Math.min(hi, lo + Math.max(10, (hi - lo) * 0.3)) - lo) * t;
        out[p.key] = p.type === "integer" ? Math.round(v) : v;
        break;
      }
      case "enum":
        out[p.key] = p.options[Math.floor(r() * p.options.length)].value;
        break;
      case "boolean":
        out[p.key] = r() < 0.5;
        break;
      case "color":
        out[p.key] = "#" + Math.floor(r() * 0xffffff).toString(16).padStart(6, "0");
        break;
      case "multi":
        out[p.key] = p.options.filter(() => r() < 0.4).map((o) => o.value);
        break;
      default:
        break;
    }
  }
  return out;
}

describe("library catalog", () => {
  it("registers every definition once with well-formed schemas", () => {
    const ids = CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of CATALOG) {
      expect(getPrimitive(d.id)).toBe(d);
      expect(d.id.startsWith(d.category === "buildings" ? "buildings." : `${d.category}.`), d.id).toBe(true);
      expect(d.description.length).toBeGreaterThan(10);
      const keys = new Set(d.params.map((p) => p.key));
      for (const p of d.params) {
        expect(p.label, `${d.id}.${p.key}`).toBeTruthy();
        if (p.when) expect(keys.has(p.when.key), `${d.id}.${p.key} when → ${p.when.key}`).toBe(true);
        if (p.type === "number" || p.type === "integer") {
          if (p.min !== undefined) expect(p.default, `${d.id}.${p.key} default ≥ min`).toBeGreaterThanOrEqual(p.min);
          if (p.max !== undefined) expect(p.default, `${d.id}.${p.key} default ≤ max`).toBeLessThanOrEqual(p.max);
        }
        if (p.type === "enum") expect(p.options.some((o) => o.value === p.default), `${d.id}.${p.key} default option`).toBe(true);
      }
      expect(validateParams(d, {}).errors).toEqual([]);
    }
    expect(listPrimitives().length).toBeGreaterThanOrEqual(CATALOG.length);
  });

  it("every definition generates valid entities with default parameters, for every placement", () => {
    const failures: string[] = [];
    for (const def of CATALOG) {
      const params = validateParams(def, {}).params;
      for (const place of placementsFor(def)) {
        const t0 = performance.now();
        let g: Generated;
        try {
          g = def.generate(params, place, ctxFor(def, params, place));
        } catch (e) {
          failures.push(`${def.id} ${JSON.stringify(place)}: threw ${(e as Error).message}`);
          continue;
        }
        const ms = performance.now() - t0;
        if (ms > 1500) failures.push(`${def.id}: slow (${ms.toFixed(0)} ms)`);
        for (const e of validate(def, g)) failures.push(`${def.id} ${JSON.stringify(place).slice(0, 60)}: ${e}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("fuzz: randomized parameter sweeps stay valid and bounded in time", () => {
    const failures: string[] = [];
    const r = rand(12345);
    const N = Number(process.env.LIB_FUZZ ?? 6);
    for (const def of CATALOG) {
      for (let k = 0; k < N; k++) {
        const raw = randomParams(def.params, r);
        const { params } = validateParams(def, raw);
        const places = placementsFor(def);
        const place = places[k % places.length];
        const t0 = performance.now();
        let g: Generated;
        try {
          g = def.generate(params, place, ctxFor(def, params, place, `fz${k}`));
        } catch (e) {
          failures.push(`${def.id} ${JSON.stringify(raw)}: threw ${(e as Error).message}`);
          continue;
        }
        const ms = performance.now() - t0;
        if (ms > 5000) failures.push(`${def.id}: slow (${ms.toFixed(0)} ms) with ${JSON.stringify(raw)}`);
        for (const e of validate(def, g, `fz${k}`)) failures.push(`${def.id} ${JSON.stringify(raw).slice(0, 300)}: ${e}`);
        if (failures.length > 30) break;
      }
    }
    expect(failures.slice(0, 30)).toEqual([]);
  }, 120_000);

  it("generation is deterministic for the same instance", () => {
    for (const id of ["housing.rowhouses", "flora.grove", "flora.tree_row", "buildings.building"]) {
      const def = getPrimitive(id)!;
      const params = validateParams(def, {}).params;
      const place = placementsFor(def)[0];
      const a = def.generate(params, place, ctxFor(def, params, place));
      const b = def.generate(params, place, ctxFor(def, params, place));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

describe("footprints and massing", () => {
  it("every footprint shape is a valid simple polygon and hits a target area", () => {
    for (const { value } of FOOTPRINT_SHAPES) {
      for (const [w, d, wing] of [[30, 20, 8], [12, 40, 5], [80, 60, 20], [5, 5, 4]]) {
        const p = footprintPoly({ shape: value, width: w, depth: d, wing, wing2: wing * 0.8, sides: 7, corner: 3, taper: 0.5, sweep: 160, steps: 4 });
        const errs: string[] = [];
        checkPoly(p, `${value} ${w}x${d}`, errs);
        expect(errs).toEqual([]);
        const t = footprintPoly({ shape: value, width: w, depth: d, wing, sides: 7, targetArea: 1234 });
        expect(Math.abs(polyArea(t) - 1234) / 1234, value).toBeLessThan(0.01);
      }
    }
  });

  it("the universal building targets a footprint area and matches heightForFloors", () => {
    const def = getPrimitive("buildings.building")!;
    for (const shape of ["rect", "l", "u", "o", "circle", "crescent", "plus"]) {
      const { params } = validateParams(def, { shape, targetArea: 1500, floors: 10, use: "residential" });
      const g = def.generate(params, { at: [100, 100], rotation: 33 }, ctxFor(def, params, {}));
      const b = g.buildings![0];
      expect(Math.abs(polyArea(b.footprint) - 1500) / 1500, shape).toBeLessThan(0.01);
      expect(b.height).toBeCloseTo(heightForFloors(10, "residential"), 6);
      expect(b.floors).toBe(10);
    }
    for (const use of ["office", "industrial", "hotel", "retail"] as const) {
      const { params } = validateParams(def, { floors: 6, use });
      const b = def.generate(params, { at: [0, 0] }, ctxFor(def, params, {})).buildings![0];
      expect(b.height).toBeCloseTo(heightForFloors(6, use), 6);
    }
  });

  it("podium, setbacks, taper and twist produce stacked masses", () => {
    const def = getPrimitive("buildings.building")!;
    const { params } = validateParams(def, { width: 50, depth: 40, floors: 30, podiumFloors: 4, towerCoverage: 40, setbackEvery: 10, setbackDepth: 2, topScale: 70, twist: 45 });
    const b = def.generate(params, { at: [0, 0] }, ctxFor(def, params, {})).buildings![0];
    expect(b.masses.find((m) => m.role === "podium")).toBeTruthy();
    expect(b.masses.length).toBeGreaterThan(10);
    const sorted = [...b.masses].sort((a, c) => a.base - c.base);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].base).toBeCloseTo(sorted[i - 1].top, 6);
    const top = sorted[sorted.length - 1],
      tower = sorted[1];
    expect(polyArea(top.poly)).toBeLessThan(polyArea(tower.poly));
  });

  it("pitched roofs follow L wings; odd plans fall back to flat with a warning", () => {
    const def = getPrimitive("buildings.building")!;
    const l = validateParams(def, { shape: "l", roofType: "gable", floors: 2 }).params;
    const gl = def.generate(l, { at: [0, 0] }, ctxFor(def, l, {}));
    expect(gl.buildings![0].solids!.filter((s) => s.shape === "wedge").length).toBe(2);
    const t = validateParams(def, { shape: "trapezoid", roofType: "hip", floors: 2 }).params;
    const gt = def.generate(t, { at: [0, 0] }, ctxFor(def, t, {}));
    expect(gt.warnings?.some((w) => /flat roof/.test(w))).toBe(true);
    const c = validateParams(def, { shape: "circle", roofType: "dome", floors: 3 }).params;
    expect(def.generate(c, { at: [0, 0] }, ctxFor(def, c, {})).buildings![0].solids!.some((s) => s.shape === "hemisphere")).toBe(true);
  });

  it("stated homes and jobs become explicit occupancy", () => {
    const def = getPrimitive("housing.single_family_home")!;
    const { params } = validateParams(def, {});
    const b = def.generate(params, { at: [0, 0] }, ctxFor(def, params, {})).buildings![0];
    expect(b.occupancy?.units).toBe(1);
    expect(b.use).toBe("residential");
  });

  it("mixed programmes split floor area between uses", () => {
    const def = getPrimitive("buildings.building")!;
    const { params } = validateParams(def, { use: "residential", groundUse: "retail", floors: 5 });
    const b = def.generate(params, { at: [0, 0] }, ctxFor(def, params, {})).buildings![0];
    expect(b.use).toBe("mixed");
    expect(b.program.retail).toBeCloseTo(0.2, 1);
    expect(b.program.residential).toBeCloseTo(0.8, 1);
  });
});

describe("search", () => {
  it("finds primitives by synonym", () => {
    const top = (q: string) => searchPrimitives(q, 8).map((d) => d.id);
    expect(top("condo")).toEqual(expect.arrayContaining(["housing.apartment_block"]));
    expect(top("lamppost")).toContain("streetscape.street_lamp");
    expect(top("sakura")).toContain("flora.tree_cherry");
    expect(top("townhomes")).toContain("housing.townhouse_row");
    expect(top("palm")).toEqual(expect.arrayContaining(["flora.tree_palm"]));
  });
});
