import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import type { ToolContext } from "@/agent/tools";

let exec: (name: string, input: Record<string, unknown>, extra?: Partial<ToolContext>) => Promise<any>;
let R: ReturnType<typeof loadHeadless>;
const SITE = [[-500, -400], [500, -400], [500, 400], [-500, 400]];

beforeAll(async () => {
  R = loadHeadless("sandbox");
  const { executeTool } = await import("@/agent/tools");
  exec = async (name, input, extra = {}) => executeTool(name, input, { requestApproval: async () => true, approvals: false, ...extra });
}, 180_000);

describe("design tools", () => {
  it("validates input before running", async () => {
    const r = await exec("design_neighborhood", { homes: 2000 });
    expect(r.isError).toBe(true);
    expect(r.content.error).toMatch(/INVALID_INPUT.*area/);
    const small = await exec("design_neighborhood", { area: [[0, 0], [50, 0], [50, 50], [0, 50]] });
    expect(small.content.error).toMatch(/too small/);
    const bad = await exec("design_neighborhood", { area: SITE, homes: "lots" });
    expect(bad.content.error).toMatch(/INVALID_INPUT/);
  });

  it("plan mode previews a design without applying it", async () => {
    const r = await exec("design_neighborhood", { area: SITE, homes: 2500 }, { mode: "plan" });
    expect(r.content.preview).toBe(true);
    expect(r.content.applied).toBe(false);
    expect(R.world.count("building")).toBe(0);
  });

  it("designs a neighborhood with streets, civic uses and varied buildings, and returns its critique", async () => {
    const r = await exec("design_neighborhood", { area: SITE, homes: 2500, facilities: "a primary school, two parks and a few cafés", name: "Test Town" });
    expect(r.isError).toBeFalsy();
    expect(r.content.applied).toBe(true);
    expect(r.content.data.homes).toBeGreaterThan(1000);
    expect(r.content.data.area).toBeUndefined();
    expect(R.world.count("street")).toBeGreaterThan(10);
    expect(R.world.count("building")).toBeGreaterThan(50);
    expect(typeof r.content.critique.overall).toBe("number");
    expect(["A", "B", "C", "D", "F"]).toContain(r.content.critique.grade);
    // one changeset: undo is one step
    expect(R.scenarios.active.cursor).toBe(1);
  });

  it("generic names find the designed civic uses: “the school”, “the park”", async () => {
    const s = await exec("go_to", { place: "the school" });
    expect(s.isError).toBeFalsy();
    expect(`${s.content.went_to.type} ${s.content.went_to.name}`).toMatch(/school|elementary/i);
    const p = await exec("go_to", { place: "a park" });
    expect(p.content.went_to.type).toBe("park");
  });

  it("design results stay compact for the model (headline summary, no placement list)", async () => {
    const r = await exec("design_neighborhood", { area: [[600, 600], [1200, 600], [1200, 1100], [600, 1100]], homes: 2000, seed: 2 });
    expect(r.content.summary.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(r.content).length).toBeLessThan(8000);
  });

  it("critique_design scores any area and reports issues in imperial units", async () => {
    const r = await exec("critique_design", { area: SITE });
    expect(r.content.overall).toBeGreaterThanOrEqual(0);
    expect(r.content.overall).toBeLessThanOrEqual(100);
    for (const i of r.content.issues) expect(i.message).not.toMatch(/\d\s?(m|km|m²|ha)\b/);
  });

  it("a design outside the session zone is refused", async () => {
    const { zoneFromPolygon } = await import("@/agent/zones");
    const zone = zoneFromPolygon([[900, 900], [1300, 900], [1300, 1300], [900, 1300]], { source: "drawn", label: "Zone" });
    const r = await exec("design_neighborhood", { area: [[-1400, -1400], [-800, -1400], [-800, -900], [-1400, -900]], homes: 800 }, { zone });
    expect(r.isError).toBe(true);
    expect(r.blocked).toBe(true);
  });
});
