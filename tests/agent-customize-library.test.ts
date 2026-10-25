import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import type { ToolContext } from "@/agent/tools";

let exec: (name: string, input: Record<string, unknown>, extra?: Partial<ToolContext>) => Promise<any>;
let R: ReturnType<typeof loadHeadless>;

beforeAll(async () => {
  R = loadHeadless("sandbox");
  const { executeTool } = await import("@/agent/tools");
  exec = async (name, input, extra = {}) => executeTool(name, input, { requestApproval: async () => true, approvals: false, ...extra });
}, 180_000);

describe("customize on library items", () => {
  it("recolours through the item's own colour parameter, so a later reconfigure keeps it", async () => {
    const { ensureLibrary, listPrimitives } = await import("@/library");
    ensureLibrary();
    const def = listPrimitives().find((d) => d.placement === "point" && d.params.some((p) => p.type === "color" && p.key === "color"))!;
    expect(def).toBeDefined();
    const placed = await exec("place", { def: def.id, at: [0, 0] });
    expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();
    const primary = () => [...R.world.entities.values()].find((e) => "lib" in e && e.lib?.def === def.id && e.lib.primary) as { id: string; lib: { params: Record<string, unknown> } };
    const r = await exec("customize", { ids: [primary().id], color: "red" });
    expect(r.isError).toBeFalsy();
    expect(primary().lib.params.color).toBe("#c0392b");
    // other parameters of the item go through `set`
    const other = def.params.find((p) => p.type === "boolean");
    if (other) {
      const s = await exec("customize", { ids: [primary().id], set: { [other.key]: !(primary().lib.params[other.key] as boolean) } });
      expect(s.isError).toBeFalsy();
      expect(primary().lib.params.color).toBe("#c0392b");
    }
  });
});
