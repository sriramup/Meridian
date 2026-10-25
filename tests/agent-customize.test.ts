import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import type { ToolContext } from "@/agent/tools";
import type { Area, Building, Street, TransitRoute, Tree } from "@/world/types";

let exec: (name: string, input: Record<string, unknown>, extra?: Partial<ToolContext>) => Promise<any>;
let R: ReturnType<typeof loadHeadless>;

beforeAll(async () => {
  R = loadHeadless();
  const { executeTool } = await import("@/agent/tools");
  exec = async (name, input, extra = {}) => executeTool(name, input, { requestApproval: async () => true, approvals: false, ...extra });
}, 180_000);

describe("customize: appearance and attributes in place, on any feature", () => {
  it("recolours a mapped building without touching its geometry, floor area or neighbours", async () => {
    const stadium = R.world.all("building").find((b) => /royal|stadium/i.test(b.name ?? "")) ?? R.world.all("building").sort((a, b) => b.height - a.height)[0];
    const before = { count: R.world.count("building"), footprint: JSON.stringify(stadium.footprint), height: stadium.height, floors: stadium.floors };
    const r = await exec("customize", { ids: [stadium.id], color: "blue" });
    expect(r.isError).toBeFalsy();
    const after = R.world.get<Building>(stadium.id)!;
    expect(after.style?.color).toEqual([0x2e, 0x6d, 0xb4]);
    expect(JSON.stringify(after.footprint)).toBe(before.footprint);
    expect(after.height).toBe(before.height);
    expect(after.floors).toBe(before.floors);
    expect(R.world.count("building")).toBe(before.count);
    // null restores the default
    await exec("customize", { ids: [stadium.id], color: null });
    expect(R.world.get<Building>(stadium.id)!.style?.color).toBeUndefined();
  });

  it("paints areas, streets, trees and transit lines, by name, hex or rgb", async () => {
    const area = R.world.all("area")[0];
    const street = R.world.all("street")[0];
    const tree = R.world.all("tree")[0];
    const route = R.world.all("route")[0];
    const r = await exec("customize", { ids: [area.id, street.id, tree.id, ...(route ? [route.id] : [])], color: "#ff0000" });
    expect(r.isError).toBeFalsy();
    expect(R.world.get<Area>(area.id)!.paint).toEqual([255, 0, 0]);
    expect(R.world.get<Street>(street.id)!.paint).toEqual([255, 0, 0]);
    expect(R.world.get<Tree>(tree.id)!.paint).toEqual([255, 0, 0]);
    if (route) expect(R.world.get<TransitRoute>(route.id)!.color).toBe("#ff0000");
    await exec("customize", { ids: [tree.id], color: [10, 20, 30] });
    expect(R.world.get<Tree>(tree.id)!.paint).toEqual([10, 20, 30]);
  });

  it("edits plain attributes and sends structural ones to the tool that owns them", async () => {
    const b = R.world.all("building")[5];
    const ok = await exec("customize", { ids: [b.id], set: { name: "Test Hall", facade: "masonry" } });
    expect(ok.isError).toBeFalsy();
    expect(R.world.get<Building>(b.id)!.name).toBe("Test Hall");
    expect(R.world.get<Building>(b.id)!.style?.facade).toBe("masonry");
    const floors = await exec("customize", { ids: [b.id], set: { floors: 40 } });
    expect(floors.isError).toBe(true);
    expect(floors.content.error).toMatch(/modify_buildings/);
    const bad = await exec("customize", { ids: [b.id], set: { facade: "cheese" } });
    expect(bad.content.error).toMatch(/one of/);
    const colour = await exec("customize", { ids: [b.id], color: "not-a-colour" });
    expect(colour.isError).toBe(true);
  });

  it("changes undo as one edit and preview in plan mode", async () => {
    const a = R.world.all("area")[1];
    const plan = await exec("customize", { ids: [a.id], color: "teal" }, { mode: "plan" });
    expect(plan.content.preview).toBe(true);
    expect(R.world.get<Area>(a.id)!.paint).toBeUndefined();
    await exec("customize", { ids: [a.id], color: "teal" });
    expect(R.world.get<Area>(a.id)!.paint).toBeDefined();
    R.scenarios.undo();
    expect(R.world.get<Area>(a.id)!.paint).toBeUndefined();
  });
});
