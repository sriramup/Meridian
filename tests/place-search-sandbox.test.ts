import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { placeIndexFor, searchPlaces } from "@/search";

let run: (name: string, input: Record<string, unknown>) => Promise<any>;

beforeAll(async () => {
  loadHeadless("sandbox");
  const { executeTool } = await import("@/agent/tools");
  run = async (name, input) => (await executeTool(name, input, { requestApproval: async () => true, approvals: false })).content;
});

describe("place search on a blank canvas", () => {
  it("finds the streets, junctions and buildings a design names, as they are drawn", async () => {
    expect(placeIndexFor()?.size).toBe(0);
    await run("create_street", { path: [[-400, 0], [400, 0]], cls: "secondary", name: "Maple Avenue" });
    await run("create_street", { path: [[-400, 200], [400, 200]], cls: "residential", name: "Birch Street" });
    for (const [x, name] of [[-200, "Oak Street"], [200, "Cedar Lane"]] as const) await run("create_street", { path: [[x, -300], [x, 300]], cls: "residential", name });
    await run("create_building", { site: [[20, 20], [120, 20], [120, 120], [20, 120]], typology: "block", floors: 3, use: "civic", name: "Town Hall" });

    expect(searchPlaces("maple ave")[0]).toMatchObject({ kind: "street", label: "Maple Avenue" });
    expect(searchPlaces("mapel")[0]?.label).toBe("Maple Avenue");
    const x = searchPlaces("oak & maple")[0];
    expect(x).toMatchObject({ kind: "intersection", label: "Oak St & Maple Ave" });
    expect(Math.hypot(x.point[0] + 200, x.point[1])).toBeLessThan(5);
    expect(searchPlaces("cedar and birch")[0]?.label).toBe("Cedar Ln & Birch St");
    expect(searchPlaces("town hall")[0]).toMatchObject({ kind: "building", label: "Town Hall" });
    // the whole street, though crossings split it into segments
    expect(searchPlaces("maple avenue")[0].ids.length).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
