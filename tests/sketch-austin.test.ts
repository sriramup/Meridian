// A sketch built in the measured city: placed where asked, built around what stands (nothing
// demolished) unless replace_existing, which removes buildings and so goes through the approval gate.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { normalisePlan } from "@/sketch/plan";

const PLAN = normalisePlan(JSON.parse(readFileSync(new URL("./fixtures/sketch-plan.json", import.meta.url), "utf8")));
let R: ReturnType<typeof loadHeadless>;
let executeTool: typeof import("@/agent/tools").executeTool;

beforeAll(async () => {
  R = loadHeadless("austin");
  ({ executeTool } = await import("@/agent/tools"));
  (await import("@/sketch/store")).rememberSketch("skAus", PLAN, { name: "whiteboard", thumb: "" });
}, 180_000);

describe("build_sketch in Austin", () => {
  it("builds around existing buildings by default", async () => {
    const n0 = R.world.count("building");
    const out = await executeTool("build_sketch", { sketch_id: "skAus", center: [1400, 900], size_m: 500, dry_run: true }, { requestApproval: async () => true, approvals: true });
    const c = out.content as any;
    expect(out.isError, JSON.stringify(c).slice(0, 300)).toBeFalsy();
    expect(c.preview).toBe(true);
    expect(c.buildings_demolished).toBe(0);
    expect(R.world.count("building")).toBe(n0);
  });

  it("asks before demolishing when replace_existing clears a built-up site", async () => {
    let asked = false;
    const out = await executeTool("build_sketch", { sketch_id: "skAus", center: [0, 0], size_m: 500, replace_existing: true }, { requestApproval: async () => ((asked = true), false), approvals: true });
    expect(asked).toBe(true);
    expect((out.content as any).rejected).toBe(true);
  });
});
