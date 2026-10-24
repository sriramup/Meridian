import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { ensureLibrary } from "@/library";
import { buildLandcover, LC, prepareLandcover } from "@/sim/landcover";
import type { Building, Prop, Street } from "@/world/types";
import { kerbOffsets } from "@/geometry/crossSection";
import { closestOnPath } from "@/geometry/polyline";
import { TOOL_DEFS } from "@/agent/toolDefs";
import { registerFixtures } from "./library-fixtures";

let run: (name: string, input: Record<string, unknown>) => Promise<any>;
let R: ReturnType<typeof loadHeadless>;

beforeAll(async () => {
  R = loadHeadless("sandbox");
  ensureLibrary();
  registerFixtures();
  const { executeTool } = await import("@/agent/tools");
  run = async (name, input) => (await executeTool(name, input, { requestApproval: async () => true, approvals: false })).content;
});

beforeEach(() => {
  R.scenarios.undo(R.scenarios.active.cursor);
});

const cellOf = (p: [number, number]) => {
  const g = R.meta.grid;
  return Math.floor((p[1] - g.y0) / g.cell) * g.nx + Math.floor((p[0] - g.x0) / g.cell);
};

describe("library agent tools", () => {
  it("registers tool definitions with effects", () => {
    const names = ["library_search", "library_describe", "place", "configure", "move_instance", "rotate_instance", "duplicate_instance", "remove_instance", "custom_building", "custom_prop"];
    for (const n of names) {
      const d = TOOL_DEFS.find((t) => t.name === n);
      expect(d, n).toBeTruthy();
      expect(d!.effect).toBe(n.startsWith("library_") ? "read" : "edit");
    }
  });

  it("searches and describes the library", async () => {
    const cats = await run("library_search", {});
    expect(cats.total).toBeGreaterThanOrEqual(5);
    const s = await run("library_search", { query: "kiosk" });
    expect(s.results[0].id).toBe("test.kiosk");
    expect(s.results[0].params.join(" ")).toMatch(/width: number 0.5–10 m = 2/);
    const custom = await run("library_search", { query: "custom building" });
    expect(custom.results.map((r: any) => r.id)).toContain("custom.building");
    const d = await run("library_describe", { ids: ["test.block", "nope"] });
    expect(d[0].params.find((p: any) => p.key === "use").options).toContain("office");
    expect(d[1].error).toBeTruthy();
  });

  it("places one primitive, reports validation errors, and previews with dry_run", async () => {
    const bad = await run("place", { def: "test.block", at: [0, 0], params: { floorz: 3 } });
    expect(bad.error).toMatch(/unknown parameter "floorz"/);
    const typo = await run("place", { def: "test.kiosks", at: [0, 0] });
    expect(typo.error).toMatch(/did you mean test.kiosk/);
    const prev = await run("place", { def: "test.block", at: [0, 0], dry_run: true });
    expect(prev.preview).toBe(true);
    expect(R.world.entities.size).toBe(0);
    const ok = await run("place", { def: "test.block", at: [0, 0], params: { floors: 8, units: 60 }, name: "Oak House" });
    expect(ok.applied).toBe(true);
    expect(ok.summary[0]).toMatch(/Placed Test block “Oak House”/);
    const b = R.world.all("building")[0];
    expect(b.name).toBe("Oak House");
    const g = await run("get_feature", { ids: [b.id] });
    expect(g[0].library).toMatchObject({ def: "test.block", params: { floors: 8, units: 60 }, primary: true });
    expect(g[0].units).toBeGreaterThan(55);
  });

  it("batches items and layouts into one undoable change", async () => {
    const before = R.scenarios.active.cursor;
    const r = await run("place", {
      params: { width: 1.5 },
      items: [
        { def: "test.kiosk", layout: { type: "grid", center: [0, 0], rows: 3, cols: 3, spacing: 10 } },
        { def: "test.kiosk", params: { canopy: true }, layout: { type: "ring", center: [100, 0], radius: 20, count: 6 } },
        { def: "test.kiosk", layout: { type: "row", from: [-100, 50], to: [-40, 50], count: 4 } },
        { def: "test.kiosk", layout: { type: "scatter", area: [[200, 200], [260, 200], [260, 260], [200, 260]], count: 5, min_spacing: 8, seed: 3 } },
        { def: "test.block", layout: { type: "fill_area", area: [[-300, -300], [-200, -300], [-200, -200], [-300, -200]], spacing: [40, 40], margin: 10 } },
        { def: "test.kiosk", params: { nope: 1 }, at: [5, 5] },
      ],
    });
    expect(r.applied).toBe(true);
    expect(R.scenarios.active.cursor).toBe(before + 1);
    expect(r.data.instances.length).toBe(9 + 6 + 4 + 5 + 4);
    expect(r.data.failures[0].error).toMatch(/unknown parameter/);
    expect(R.world.all("prop").length).toBe(24);
    expect(R.world.all("prop").every((p) => (p.lib!.params.width as number) === 1.5)).toBe(true);
    // ring members face the centre: front (+y) points inward
    const ring = R.world.all("prop").filter((p) => p.lib!.params.canopy);
    for (const p of ring) {
      const a = (p.rot * Math.PI) / 180;
      const fwd = [-Math.sin(a), Math.cos(a)];
      const toC = [100 - p.p[0], 0 - p.p[1]];
      expect(fwd[0] * toC[0] + fwd[1] * toC[1]).toBeGreaterThan(19);
    }
    R.scenarios.undo();
    expect(R.world.entities.size).toBe(0);
  });

  it("lays objects along a street behind the kerb, never in the carriageway", async () => {
    await run("create_street", { path: [[-200, 0], [200, 0]], cls: "secondary", name: "High Street" });
    const r = await run("place", { def: "test.kiosk", params: { width: 1, depth: 0.6 }, layout: { type: "along_street", street: "High Street", side: "both", spacing: 25 } });
    expect(r.applied).toBe(true);
    const props = R.world.all("prop") as Prop[];
    expect(props.length).toBeGreaterThan(20);
    const st = R.world.all("street")[0] as Street;
    const k = kerbOffsets(st.section);
    for (const p of props) {
      const d = closestOnPath(p.p, st.path).d;
      expect(d).toBeGreaterThan(Math.min(Math.abs(k.left), Math.abs(k.right)));
      // front faces the street
      const a = (p.rot * Math.PI) / 180;
      expect(Math.sign(Math.cos(a)) * Math.sign(-p.p[1]) >= 0 || Math.abs(Math.cos(a)) < 1e-6).toBe(true);
    }
  });

  it("configures, moves, rotates, duplicates and removes instances", async () => {
    const r = await run("place", { def: "test.block", at: [0, 0], params: { floors: 3 } });
    const id = r.created[0];
    const c = await run("configure", { ids: [id], params: { floors: 12, use: "office" } });
    expect(c.applied).toBe(true);
    expect(R.world.get<Building>(id)!.floors).toBe(12);
    const bad = await run("configure", { ids: [id], params: { use: "spaceport" } });
    expect(bad.error).toMatch(/not one of/);
    await run("move_instance", { ids: [id], to: [150, 150] });
    expect(R.world.get<Building>(id)!.lib!.placement.at).toEqual([150, 150]);
    await run("rotate_instance", { ids: [id], degrees: 45 });
    expect(R.world.get<Building>(id)!.lib!.placement.rotation).toBe(45);
    const d = await run("duplicate_instance", { ids: [id], offset: [0, 60], count: 2, params: { floors: 2 } });
    expect(d.data.instances.length).toBe(2);
    expect(R.world.all("building").map((b) => b.floors).sort((a, b) => a - b)).toEqual([2, 2, 12]);
    const f = await run("find_features", { kind: "building", where: { def: "test.block" } });
    expect(f.total).toBe(3);
    expect(f.rows[0].library.def).toBe("test.block");
    const rm = await run("remove_instance", { ids: [id] });
    expect(rm.applied).toBe(true);
    expect(R.world.all("building").length).toBe(2);
  });

  it("custom_building: any massing, roof solids, colour, stated occupancy; custom_prop from solids", async () => {
    const b = await run("custom_building", { at: [0, 0], shape: "polygon", sides: 5, width: 30, depth: 30, floors: 30, tiers: 6, taper: 0.6, twist: 45, roof: "pyramid", roof_height: 10, color: "teal", facade: "glass", use: "mixed", mix_residential: 70, mix_office: 30, units: 200, name: "Twist" });
    expect(b.applied).toBe(true);
    const bld = R.world.all("building")[0];
    expect(bld.masses.length).toBe(6);
    expect(bld.solids?.[0].shape).toBe("pyramid");
    expect(bld.style?.color).toEqual([42, 140, 140]);
    expect(bld.program).toEqual({ residential: 0.7, office: 0.3 });
    const g = await run("get_feature", { ids: [bld.id] });
    expect(g[0].units).toBeGreaterThan(190);
    expect(g[0].units).toBeLessThan(210);
    // it stays configurable
    await run("configure", { ids: [bld.id], params: { roof: "dome", floors: 20 } });
    expect(R.world.get<Building>(bld.id)!.solids?.[0].shape).toBe("hemisphere");
    const site = await run("custom_building", { site: [[100, 0], [160, 0], [160, 40], [100, 40]], typology: "courtyard", floors: 5, use: "residential" });
    expect(site.applied).toBe(true);
    const p = await run("custom_prop", { at: [60, 60], solids: [{ shape: "cylinder", at: [0, 0, 0], size: [0.3, 0.3, 4], color: "#444444", material: "metal" }, { shape: "cone", at: [0, 0, 4], size: [6, 6, 1.5], color: [250, 250, 250], material: "fabric" }], shade_radius: 3, shade_height: 4.5, name: "Shade umbrella" });
    expect(p.applied).toBe(true);
    const prop = R.world.all("prop")[0];
    expect(prop.shade).toEqual({ r: 3, h: 4.5 });
    expect(prop.height).toBeCloseTo(5.5);
    const bad = await run("custom_prop", { at: [70, 70], solids: [] });
    expect(bad.error).toBeTruthy();
  });

  it("sims: shade objects add canopy and shadow height; ground covers paint land cover; homes and jobs reach the metrics", async () => {
    await run("create_street", { path: [[-300, -100], [300, -100]], cls: "secondary" });
    await run("custom_prop", { at: [0, 0], solids: [{ shape: "cylinder", at: [0, 0, 0], size: [0.3, 0.3, 4], color: "#444444" }], shade_radius: 6, shade_height: 4 });
    await run("custom_prop", { at: [40, 0], solids: [{ shape: "cylinder", at: [0, 0, 0], size: [10, 10, 0.4], color: "#3a7bd5", material: "water" }] });
    await run("custom_prop", { at: [80, 0], solids: [{ shape: "box", at: [0, 0, 0], size: [8, 8, 0.6], color: "#336633", material: "foliage" }], cover: "lawn" });
    await run("custom_prop", { at: [120, 0], solids: [{ shape: "box", at: [0, 0, 0], size: [8, 8, 3], color: "#999999", material: "metal" }] });
    const li = prepareLandcover(R.world.entities.values(), R.world.streetGeom, R.world.nodeGeom, R.meta.grid, R.landcover);
    const lc = buildLandcover(li);
    expect(lc.canopy[cellOf([0, 0])]).toBe(1);
    expect(lc.cls[cellOf([0, 0])]).toBe(LC.CANOPY);
    expect(lc.height[cellOf([0, 0])]).toBeGreaterThan(3);
    expect(lc.cls[cellOf([40, 0])]).toBe(LC.WATER);
    expect(lc.cls[cellOf([80, 0])]).toBe(LC.PARK);
    expect(lc.height[cellOf([120, 0])]).toBeCloseTo(3);
    const m0 = await run("run_simulation", { kind: "metrics" });
    await run("place", { def: "test.block", at: [0, -200], params: { units: 120, floors: 6 } });
    await run("place", { def: "test.block", at: [100, -200], params: { use: "office", floors: 6 } });
    const m1 = await run("run_simulation", { kind: "metrics" });
    expect(m1.housing_units - (m0.housing_units ?? 0)).toBeGreaterThanOrEqual(115);
    expect(m1.jobs - (m0.jobs ?? 0)).toBeGreaterThan(60);
    const h = await run("run_simulation", { kind: "heat" });
    expect(h.mean_ped_exposure_c).toBeGreaterThan(15);
  }, 120_000);
});
