import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { critiqueArea, designNeighborhood, facilitiesFromText, type NeighborhoodSpec } from "@/design";
import { overlapArea, polyArea, polyBBox, polyCentroid } from "@/geometry/polygon";
import { World } from "@/world/world";
import { programmeOf } from "@/world/ops/core";
import type { Building, Polygon, Street, StreetNode } from "@/world/types";

let meta: World["meta"];
const actor = { author: "agent" as const };
const AREA: Polygon = [[[-350, -300], [350, -300], [350, 300], [-350, 300]]];
const OWNER = "Can you create a high density urban neighborhood that contains a university, a primary school, middle school, high school, has a police station, fire station, roads that follow proper road hierarchy design, two restaurants, and add a few parks.";

beforeAll(() => {
  meta = loadHeadless("sandbox").meta;
});

function fresh() {
  const w = new World(meta);
  w.load([]);
  return w;
}

function build(spec: NeighborhoodSpec) {
  const w = fresh();
  const res = designNeighborhood(w, spec, actor);
  expect(res.ok, res.error).toBe(true);
  w.apply(res.changeset!);
  return { w, res };
}

const signature = (w: World) =>
  w
    .all("building")
    .map((b) => `${b.lib?.def}|${b.floors}|${polyCentroid(b.footprint).map((x) => Math.round(x)).join(",")}`)
    .sort()
    .join(";");

describe("facilitiesFromText", () => {
  it("reads the owner's request", () => {
    const f = facilitiesFromText(OWNER);
    const k = (x: string) => f.find((y) => y.kind === x)?.count;
    expect(k("university")).toBe(1);
    expect(k("primary_school")).toBe(1);
    expect(k("middle_school")).toBe(1);
    expect(k("high_school")).toBe(1);
    expect(k("police")).toBe(1);
    expect(k("fire")).toBe(1);
    expect(k("restaurant")).toBe(2);
    expect(k("park")).toBe(3);
    expect(facilitiesFromText("a main street with shops").some((f) => f.kind === "shops")).toBe(true);
  });
});

describe("designNeighborhood", () => {
  let dense: ReturnType<typeof build>;
  beforeAll(() => {
    dense = build({ area: [[[-500, -400], [500, -400], [500, 400], [-500, 400]]], density: "high", facilities: facilitiesFromText(OWNER), seed: 3 });
  }, 120_000);

  it("is deterministic for a seed", () => {
    const a = build({ area: AREA, density: "medium", seed: 11 });
    const b = build({ area: AREA, density: "medium", seed: 11 });
    const c = build({ area: AREA, density: "medium", seed: 12 });
    expect(signature(a.w)).toBe(signature(b.w));
    expect(signature(a.w)).not.toBe(signature(c.w));
  }, 120_000);

  it("never overlaps buildings", () => {
    const { w } = dense;
    let bad = 0;
    for (const b of w.all("building")) {
      for (const e of w.query(polyBBox(b.footprint), ["building"])) {
        if (e.id <= b.id) continue;
        if (overlapArea(b.footprint, (e as Building).footprint) > 1) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("builds every lot or leaves it deliberately open, with diverse buildings", () => {
    const sc = critiqueArea(dense.w, dense.res.data!.area as Polygon);
    expect(sc.stats.bare_share).toBeLessThan(0.02);
    expect(sc.stats.building_types).toBeGreaterThanOrEqual(8);
    expect(sc.stats.distinct_heights).toBeGreaterThanOrEqual(6);
    expect(sc.stats.repetition).toBeLessThan(0.3);
    expect(sc.stats.park_access).toBeGreaterThan(0.95);
    expect(sc.stats.street_wall).toBeGreaterThan(0.75);
    expect(sc.overall).toBeGreaterThanOrEqual(85);
  });

  it("delivers the requested facilities, exactly", () => {
    const bs = dense.w.all("building");
    const defs = (d: string) => new Set(bs.filter((b) => b.lib?.def === d).map((b) => b.lib!.instance)).size;
    expect(defs("commercial.restaurant")).toBe(2);
    expect(defs("civic.fire_station")).toBe(1);
    expect(defs("civic.police_station")).toBe(1);
    expect(defs("composites.urban_school")).toBe(3);
    expect(defs("composites.campus_block")).toBeGreaterThanOrEqual(3);
    // fire station fronts an arterial: its bays face a boulevard or avenue within 40 m
    const fire = bs.find((b) => b.lib?.def === "civic.fire_station")!;
    const near = dense.w.query(polyBBox(fire.footprint).map((x, i) => x + (i < 2 ? -45 : 45)) as [number, number, number, number], ["street"]).map((e) => (e as Street).cls);
    expect(near.some((c) => c === "primary" || c === "secondary")).toBe(true);
  });

  it("meets the homes target within tolerance", () => {
    const { res } = build({ area: AREA, homes: 2500, seed: 5 });
    const homes = res.data!.homes as number;
    expect(homes).toBeGreaterThan(2500 * 0.95);
    expect(homes).toBeLessThan(2500 * 1.25);
  }, 120_000);

  it("lays out a street hierarchy with connected corners", () => {
    const { w } = dense;
    const cls = new Set(w.all("street").map((s) => s.cls));
    for (const c of ["primary", "secondary", "tertiary", "residential"]) expect(cls.has(c as Street["cls"])).toBe(true);
    // every site corner is a junction shared by a boulevard and an avenue
    for (const p of [[-500, -400], [500, -400], [500, 400], [-500, 400]]) {
      const n = w.all("node").find((x: StreetNode) => Math.hypot(x.p[0] - p[0], x.p[1] - p[1]) < 3)!;
      expect(n).toBeTruthy();
      const inc = new Set(w.incident(n.id).map((s) => s.cls));
      expect(inc.has("primary") && inc.has("secondary")).toBe(true);
    }
    // no dead ends inside the site
    const dead = w.all("node").filter((n) => w.incident(n.id).length === 1);
    expect(dead.length).toBe(0);
  });

  it("produces low-density fabric for a suburb (logic is general, not one look)", () => {
    const { w } = build({ area: AREA, density: "low", seed: 2, facilities: [{ kind: "primary_school" }] });
    const bs = w.all("building");
    const houses = bs.filter((b) => /housing\.(single_family_home|cottage|l_shaped_house|ranch_house|duplex|triplex|townhouse_row)/.test(b.lib?.def ?? ""));
    expect(houses.length / bs.length).toBeGreaterThan(0.7);
    expect(Math.max(...bs.filter((b) => b.use === "residential").map((b) => b.floors))).toBeLessThanOrEqual(3);
  }, 120_000);
});

describe("briefs are honoured", () => {
  const SITE: Polygon = [[[-450, -450], [450, -450], [450, 450], [-450, 450]]];
  const BRIEF = "a walkable high-density mixed-use neighborhood with a main street with shops, two cafés and three parks";

  it("keeps an urban character on a large site and reports the extra capacity", () => {
    const { w, res } = build({ area: SITE, population: 4000, brief: BRIEF, facilities: facilitiesFromText(BRIEF), seed: 2 });
    const d = res.data!;
    expect(d.density).toBe("high");
    expect((d.advisories as string[]).some((a) => /Built at high density/.test(a))).toBe(true);
    // no surface lots, shops on the main street, cafés with distinct names, the three parks asked for
    expect(w.all("area").filter((a) => a.type === "parking" && polyArea(a.poly) >= 120).length).toBeLessThan(5);
    expect(w.all("building").filter((b) => (b.program.retail ?? 0) > 0.02).length).toBeGreaterThan(20);
    const cafes = (d.facilities as { kind: string; name: string }[]).filter((f) => f.kind === "cafe").map((f) => f.name);
    expect(cafes.length).toBe(2);
    expect(new Set(cafes).size).toBe(2);
    expect((d.civic as { kind: string }[]).filter((c) => c.kind === "park").length).toBeGreaterThanOrEqual(3);
    const sc = critiqueArea(w, SITE, { brief: d.brief as never });
    expect(sc.overall).toBeGreaterThanOrEqual(85);
  }, 120_000);

  it("grades a suburban result poorly against a high-density brief", () => {
    const { w, res } = build({ area: SITE, population: 4000, brief: BRIEF, fill: "programme", seed: 2 });
    expect((res.data!.advisories as string[]).some((a) => /Kept the/.test(a))).toBe(true);
    const sc = critiqueArea(w, SITE, { brief: res.data!.brief as never });
    expect(sc.overall).toBeLessThan(65);
    expect(sc.issues.some((i) => i.metric === "brief")).toBe(true);
  }, 120_000);

  it("honours a retail mix or says why not", () => {
    const { res } = build({ area: AREA, density: "medium", mix: { retail: 0.1 }, seed: 4 });
    const share = res.data!.retail_share as number;
    expect(share >= 0.08 || (res.data!.advisories as string[]).some((a) => /Retail at grade/.test(a))).toBe(true);
    expect(share).toBeGreaterThan(0.03);
  }, 120_000);
});

describe("critiqueArea", () => {
  it("measures coverage, bare land and FAR on a known layout", () => {
    const w = fresh();
    const sq = (x: number, y: number, s: number): Polygon => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s]]];
    const b: Building = { id: "b:1", kind: "building", footprint: sq(0, 0, 20), masses: [{ poly: sq(0, 0, 20), base: 0, top: 12, role: "body" }], height: 12, floors: 4, use: "office", program: { office: 1 }, ground: 0, heightSource: "proposed", useSource: "proposed", source: "test", createdBy: "t" };
    w.load([b]);
    const sc = critiqueArea(w, sq(-40, -40, 100), { cell: 2 });
    expect(sc.stats.coverage).toBeCloseTo(0.04, 2);
    expect(sc.stats.bare_share).toBeCloseTo(0.96, 2);
    expect(sc.stats.far).toBeCloseTo(programmeOf(b).gfa / 10000, 2);
    expect(polyArea(sq(0, 0, 20))).toBe(400);
    expect(sc.issues.some((i) => i.metric === "bare_land")).toBe(true);
  });
});
