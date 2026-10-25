import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { setSerpTransport } from "@/serp/client";
import { SerpLedger } from "@/serp/ledger";
import { SerpService } from "@/serp/server";
import { categoryOf, importPlaces, localize, SERP_POI_SOURCE, zoomFor } from "@/serp/discover";
import { getSet, useSerp } from "@/serp/store";
import { LocalProjection } from "@/world/projection";
import { prepareAccess } from "@/sim/access";
import type { Poi } from "@/world/types";
import type { Runtime } from "@/state/runtime";

const FIX = resolve(__dirname, "fixtures/serpapi");

let R: Runtime;
let svc: SerpService;
let run: (name: string, input: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<any>;

beforeAll(async () => {
  R = loadHeadless();
  const dir = mkdtempSync(join(tmpdir(), "meridian-serp-tools-"));
  // the server in fixture mode, called in-process: no network, no credits
  svc = new SerpService({ key: null, fixtures: FIX, cacheDir: join(dir, "cache"), ledger: new SerpLedger({ path: join(dir, "l.json"), cap: 5 }), record: null, fetch: (() => Promise.reject(new Error("network in a test"))) as never });
  setSerpTransport((req) => svc.search(req));
  const { executeTool } = await import("@/agent/tools");
  run = async (name, input, extra = {}) => executeTool(name, input, { requestApproval: async () => true, approvals: false, ...extra });
}, 180_000);

describe("GPS → local metres", () => {
  it("projects places into the study frame and measures the walk", () => {
    const proj = new LocalProjection(-97.741, 30.2725);
    const origin = proj.toLocal(-97.7468, 30.2677); // Republic Square
    const [a] = localize([{ id: "g1", title: "A", lat: 30.2677, lon: -97.7468 + 0.005, type: "Grocery store" }], { origin, proj, bounds: [-2000, -2000, 2000, 2000], walkTo: (p) => Math.hypot(p[0] - origin[0], p[1] - origin[1]) * 1.2 });
    // 0.005° of longitude at 30.27° N ≈ 481 m
    expect(a.dist_m).toBeGreaterThan(470);
    expect(a.dist_m).toBeLessThan(490);
    expect(a.walk_basis).toBe("network");
    expect(a.walk_m).toBeCloseTo(a.dist_m * 1.2, -1);
    expect(a.walk_min).toBeCloseTo(a.walk_m / 1.3 / 60, 1);
    expect(a.category).toBe("grocery");
    const [far] = localize([{ id: "g2", title: "B", lat: 30.4, lon: -97.74 }], { origin, proj, bounds: [-2000, -2000, 2000, 2000], walkTo: () => 1 });
    expect(far.inside).toBe(false);
    expect(far.walk_basis).toBe("estimate");
    expect(far.walk_m).toBeCloseTo(far.dist_m * 1.3, -1);
  });
  it("classifies Google types as access-model categories and sizes the viewport", () => {
    expect(categoryOf({ title: "x", type: "Supermarket" })).toBe("grocery");
    expect(categoryOf({ title: "x", type: "Pharmacy" })).toBe("health");
    expect(categoryOf({ title: "x", type: "Taco restaurant" })).toBe("food");
    expect(categoryOf({ title: "x", type: "Establishment" }, "elementary school")).toBe("school");
    expect(zoomFor(800)).toBe(15);
    expect(zoomFor(3000)).toBeLessThan(zoomFor(400));
  });
});

describe("agent tools on Austin (fixtures)", () => {
  it("web_search returns facts and numbered sources to cite", async () => {
    const out = await run("web_search", { query: "what is the population of Austin" });
    expect(out.isError).toBeFalsy();
    const c = out.content;
    expect(c.entity.name).toBe("Austin");
    expect(c.entity.facts.Population).toMatch(/979,882/);
    expect(c.entity.cite).toBe(1);
    expect(c.sources[0]).toMatchObject({ n: 1, domain: "en.wikipedia.org" });
    expect(c.via).toBe("SerpApi");
    expect(out.display.serp.kind).toBe("web");
  });

  it("find_places near Republic Square: pins, local positions, network walking times, imperial distances", async () => {
    const out = await run("find_places", { query: "grocery", near: "Republic Square", walk_minutes: 10 });
    expect(out.isError).toBeFalsy();
    const c = out.content;
    expect(c.near).toMatch(/Republic Square/);
    expect(c.count).toBe(5);
    const names = c.places.map((p: any) => p.name);
    expect(names[0]).toBe("Royal Blue Grocery"); // sorted by walk
    const p0 = c.places[0];
    expect(p0.at).toHaveLength(2);
    expect(p0.distance).toMatch(/ft|mi/);
    expect(p0.walk_basis).toBe("street network");
    expect(p0.walk_min).toBeLessThan(10);
    expect(p0.within_walk).toBe(true);
    expect(p0.counts_as).toBe("grocery");
    const heb = c.places.find((p: any) => p.name === "H-E-B");
    expect(heb.within_walk).toBe(false);
    expect(c.within_walk).toBeGreaterThanOrEqual(1);
    expect(c.within_names).toContain("Royal Blue Grocery");
    expect(c.within_walk).toBeLessThan(5);
    // the pins on the map
    const st = useSerp.getState();
    expect(st.shown).toBe(c.set_id);
    expect(st.sets[c.set_id].places).toHaveLength(5);
    expect(out.display.serp.kind).toBe("places");
  });

  it("find_places refuses on a blank canvas", async () => {
    const sb = loadHeadless("sandbox");
    expect(sb.meta.sandbox).toBe(true);
    const out = await run("find_places", { query: "grocery" });
    expect(out.isError).toBe(true);
    expect(out.content.error).toMatch(/real-city/);
    R = loadHeadless();
  });

  it("import_places adds POIs the access model sees, is reversible, and plan mode only previews", async () => {
    await run("find_places", { query: "grocery", near: "Republic Square", walk_minutes: 10 });
    const set = getSet()!;
    const before = [...R.world.entities.values()].filter((e) => e.kind === "poi" && (e as Poi).source === SERP_POI_SOURCE).length;
    expect(before).toBe(0);

    const plan = await run("import_places", {}, { mode: "plan" });
    expect(plan.content.preview).toBe(true);
    expect([...R.world.entities.values()].filter((e) => e.kind === "poi" && (e as Poi).source === SERP_POI_SOURCE)).toHaveLength(0);

    const groceriesBefore = prepareAccess(R.world.entities.values(), []).dests.grocery.length;
    const out = await run("import_places", { ids: set.places.filter((p) => p.inside).map((p) => p.id) }, { sessionId: "s-test" });
    expect(out.isError).toBeFalsy();
    expect(out.content.applied).toBe(true);
    const added = [...R.world.entities.values()].filter((e) => e.kind === "poi" && (e as Poi).source === SERP_POI_SOURCE) as Poi[];
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((p) => p.category === "grocery" && p.tags?.place_id)).toBe(true);
    const groceriesAfter = prepareAccess(R.world.entities.values(), []).dests.grocery.length;
    expect(groceriesAfter).toBe(groceriesBefore + added.length);

    // importing again skips them
    const again = importPlaces(R.world, set.places, "agent");
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already imported|outside/);

    const undo = await run("undo", { steps: 1 }, { sessionId: "s-test" });
    expect(undo.isError).toBeFalsy();
    expect([...R.world.entities.values()].filter((e) => e.kind === "poi" && (e as Poi).source === SERP_POI_SOURCE)).toHaveLength(0);
  });

  it("never touched the network or spent a credit", () => {
    expect(svc.liveCalls).toBe(0);
    expect(svc.ledger.used).toBe(0);
  });
});
