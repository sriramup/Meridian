import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { overlapArea, polyArea, polyBBox, polyCentroid, pointInPoly } from "@/geometry/polygon";
import { World } from "@/world/world";
import type { Area, Building, Street } from "@/world/types";
import { normalisePlan, planCounts, planForModel, type SketchPlan } from "@/sketch/plan";
import { buildSketch, chooseSite, sketchFrame, snapEnds } from "@/sketch/build";

const PLAN: SketchPlan = normalisePlan(JSON.parse(readFileSync(new URL("./fixtures/sketch-plan.json", import.meta.url), "utf8")));
const actor = { author: "agent" as const };
let meta: World["meta"];

beforeAll(() => {
  meta = loadHeadless("sandbox").meta;
});

function fresh() {
  const w = new World(meta);
  w.load([]);
  return w;
}

/** building footprint pairs that overlap by more than a sliver */
function overlaps(w: World): string[] {
  const bs = w.all("building");
  const out: string[] = [];
  for (const a of bs) {
    for (const e of w.query(polyBBox(a.footprint), ["building"])) {
      const c = e as Building;
      if (c.id <= a.id) continue;
      // parts of one library instance (a school's wings) may touch each other
      if (a.lib?.instance && a.lib.instance === c.lib?.instance) continue;
      if (overlapArea(a.footprint, c.footprint) > 2) out.push(`${a.id}×${c.id}`);
    }
  }
  return out;
}

describe("SketchPlan normalisation", () => {
  it("clamps, rescales percent coordinates and reads labels", () => {
    const p = normalisePlan({ is_plan: true, extent: { width_m: 20000, height_m: 10000, basis: "guess", confidence: 3 }, streets: [{ points: [[10, 50], [90, 50]], class: "bogus", weight: 5 }], facilities: [{ kind: "other", at: [50, 20], label: "Elem. School" }], blocks: [], areas: [], transit: [], notes: [] });
    expect(p.is_plan).toBe(true);
    expect(p.streets[0].points).toEqual([[0.1, 0.5], [0.9, 0.5]]);
    expect(p.streets[0].class).toBe("arterial");
    expect(p.facilities[0].kind).toBe("school");
    expect(p.extent.width_m).toBe(4000);
    expect(p.extent.height_m).toBe(2000);
    expect(p.extent.confidence).toBe(1);
  });

  it("marks a non-plan and keeps the reason", () => {
    const p = normalisePlan({ is_plan: false, not_plan_reason: "a selfie", extent: { width_m: 0, height_m: 0 }, streets: [], blocks: [], areas: [], facilities: [], transit: [], notes: [] });
    expect(p.is_plan).toBe(false);
    expect(p.not_plan_reason).toBe("a selfie");
  });

  it("summarises compactly for the model", () => {
    expect(planCounts(PLAN)).toMatch(/6 streets \(1 arterial\), a river, a park/);
    const s = planForModel(PLAN, "sk1");
    expect(s.length).toBeLessThan(3000);
    expect(JSON.parse(s).sketch_id).toBe("sk1");
  });

  it("snaps near-miss street ends onto the street they meet", () => {
    const ends = snapEnds([{ points: [[0, 0.5], [1, 0.5]] }, { points: [[0.5, 0.1], [0.5, 0.48]] }]);
    expect(ends[1][1][1]).toBeGreaterThanOrEqual(0.5);
  });
});

describe("buildSketch", () => {
  let w: World;
  let res: ReturnType<typeof buildSketch>;
  beforeAll(() => {
    w = fresh();
    res = buildSketch(w, PLAN, { centre: [0, 0] }, actor, { seed: 3 });
  });

  it("builds the sketch as one changeset", () => {
    expect(res.ok, res.error).toBe(true);
    w.apply(res.changeset!);
    expect(res.changeset!.ops.length).toBeGreaterThan(200);
  });

  it("lays the streets with their classes and names, spliced into one network", () => {
    const streets = w.all("street") as Street[];
    const grand = streets.filter((s) => s.name === "Grand Avenue");
    expect(grand.length).toBeGreaterThan(1); // split where Market Street and the locals cross it
    // the thickest line (weight 5) is a boulevard
    expect(new Set(grand.map((s) => s.cls))).toEqual(new Set(["primary"]));
    expect(streets.find((s) => s.name === "Market Street")?.cls).toBe("tertiary");
    expect(streets.filter((s) => s.cls === "residential").length).toBeGreaterThan(4);
    // the avenue's junctions are shared with the crossing streets
    const nodes = new Map<string, number>();
    for (const s of streets) for (const n of [s.from, s.to]) nodes.set(n, (nodes.get(n) ?? 0) + 1);
    expect([...nodes.values()].filter((k) => k >= 3).length).toBeGreaterThan(5);
  });

  it("makes the river and the park", () => {
    const areas = w.all("area") as Area[];
    const water = areas.filter((a) => a.type === "water");
    expect(water.length).toBeGreaterThan(0);
    expect(water.reduce((s, a) => s + polyArea(a.poly), 0)).toBeGreaterThan(15000);
    expect(areas.some((a) => a.type === "park")).toBe(true);
  });

  it("puts a real school primitive on the SCHOOL box", () => {
    const school = w.all("building").filter((b) => b.lib?.def === "composites.urban_school");
    expect(school.length).toBeGreaterThan(0);
    const F = sketchFrame(PLAN, { centre: [0, 0] });
    const at = F.toWorld([0.63, 0.12]);
    expect(school.some((b) => Math.hypot(polyCentroid(b.footprint)[0] - at[0], polyCentroid(b.footprint)[1] - at[1]) < 120)).toBe(true);
  });

  it("fills the blocks with varied fabric, not boxes", () => {
    const bs = w.all("building");
    expect(bs.length).toBeGreaterThan(80);
    const defs = new Set(bs.map((b) => b.lib?.def).filter(Boolean));
    expect(defs.size).toBeGreaterThan(5);
    const floors = new Set(bs.map((b) => b.floors));
    expect(floors.size).toBeGreaterThan(3);
    expect((res.data as { homes: number }).homes).toBeGreaterThan(500);
    // nothing on the water or in the park
    const water = (w.all("area") as Area[]).filter((a) => a.type === "water");
    for (const b of bs) expect(water.some((a) => pointInPoly(polyCentroid(b.footprint), a.poly))).toBe(false);
  });

  it("never overlaps buildings", () => {
    expect(overlaps(w)).toEqual([]);
  });

  it("undoes in one step", () => {
    w.revert(res.changeset!);
    expect(w.entities.size).toBe(0);
  });
});

describe("placement", () => {
  it("uses the centre of an empty canvas", () => {
    const w = fresh();
    const s = chooseSite(w, PLAN, { prefer: [0, 0] })!;
    expect(s.centre).toEqual([0, 0]);
    expect(s.moved).toBe(false);
  });

  it("lands a second sketch in free space next to an existing design, overlapping nothing", () => {
    const w = fresh();
    const first = buildSketch(w, PLAN, { centre: [0, 0] }, actor, { seed: 1 });
    w.apply(first.changeset!);
    const before = new Set(w.entities.keys());
    const s = chooseSite(w, PLAN, { prefer: [0, 0] })!;
    expect(s.moved).toBe(true);
    const F = sketchFrame(PLAN, { centre: s.centre, size_m: s.size_m });
    // the new outline does not touch the first design's outline
    const F0 = sketchFrame(PLAN, { centre: [0, 0] });
    expect(overlapArea(F.outline, F0.outline)).toBe(0);
    const second = buildSketch(w, PLAN, { centre: s.centre, size_m: s.size_m }, actor, { seed: 2 });
    expect(second.ok, second.error).toBe(true);
    // nothing of the first design is changed or removed
    expect(second.removed.length).toBe(0);
    expect(second.modified.filter((id) => before.has(id))).toEqual([]);
    w.apply(second.changeset!);
    expect(overlaps(w)).toEqual([]);
  });
});
