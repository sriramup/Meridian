import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { ScenarioManager } from "@/world/scenarios";
import { World } from "@/world/world";

let run: (name: string, input: Record<string, unknown>) => Promise<any>;
let R: ReturnType<typeof loadHeadless>;

beforeAll(async () => {
  R = loadHeadless("sandbox");
  const { executeTool } = await import("@/agent/tools");
  run = async (name, input) => (await executeTool(name, input, { requestApproval: async () => true, approvals: false })).content;
});

describe("blank canvas", () => {
  it("starts empty, with the climate city's sun and weather and no measured data", () => {
    expect(R.meta.sandbox).toBe(true);
    expect(R.world.entities.size).toBe(0);
    expect(R.census.length + R.counts.length).toBe(0);
    expect(R.meta.weather.hourly.t.length).toBe(24);
    expect(R.scenarios.active.name).toBe("Blank site");
  });

  it("builds a town from scratch and runs the models on it", async () => {
    await run("create_street", { path: [[-450, 0], [450, 0]], cls: "secondary", name: "Main Boulevard" });
    for (const x of [-300, 0, 300]) await run("create_street", { path: [[x, -300], [x, 300]], cls: "residential" });
    const d = await run("generate_district", { area: [[-290, 10], [290, 10], [290, 290], [-290, 290]], style: "midrise", target_units: 600, new_streets: true });
    expect(d.applied).toBe(true);
    await run("create_building", { site: [[20, -40], [140, -40], [140, -150], [20, -150]], typology: "courtyard", floors: 3, use: "education", name: "School" });
    await run("create_building", { site: [[-140, -40], [-60, -40], [-60, -100], [-140, -100]], typology: "block", floors: 2, use: "civic", name: "Fire Station" });
    expect(R.scenarios.active.name).toBe("Design 1");
    expect(R.world.all("building").length).toBeGreaterThan(3);

    const m = await run("run_simulation", { kind: "metrics" });
    expect(m.housing_units).toBeGreaterThan(500);
    // open ends of the boulevard connect the town to the region
    const t = await run("run_simulation", { kind: "traffic" });
    expect(t.kpi.veh_trips).toBeGreaterThan(100);
    const h = await run("run_simulation", { kind: "heat" });
    expect(h.mean_ped_exposure_c).toBeGreaterThan(20);
    // drawn school space is a school destination; a building named as a station is a station
    const a = await run("run_simulation", { kind: "access" });
    expect(a.residents_covered.school).not.toBe("0%");
    expect(a.emergency).toBeTruthy();
  }, 120_000);

  it("round-trips a design through a snapshot onto a fresh empty world", () => {
    const snap = JSON.parse(JSON.stringify(R.scenarios.snapshot()));
    const w = new World(R.meta);
    w.load([]);
    const S = new ScenarioManager(w, { baselineName: "Blank site", branchPrefix: "Design" });
    expect(S.restore(snap)).toBe(true);
    expect(w.entities.size).toBe(R.world.entities.size);
    expect(S.active.name).toBe(R.scenarios.active.name);
    expect(S.canUndo()).toBe(true);
    S.undo(S.active.cursor);
    expect(w.entities.size).toBe(0);
  });
});
