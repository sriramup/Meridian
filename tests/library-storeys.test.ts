import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { ensureLibrary } from "@/library";
import { placePrimitive } from "@/world/ops/library";
import { programmeOf } from "@/world/ops/core";
import type { Building } from "@/world/types";

let R: ReturnType<typeof loadHeadless>;
const user = { author: "user" as const };

beforeAll(() => {
  R = loadHeadless("sandbox");
  ensureLibrary();
});

/** floor area of the building a primitive places, with the given params */
function gfaOf(def: string, params: Record<string, unknown>): { gfa: number; floors: number; height: number } {
  const r = placePrimitive(R.world, { def, params, at: [0, 0] }, user);
  if (!r.ok) throw new Error(r.error);
  const b = r.changeset!.ops.map((o) => (o.type === "add" ? o.entity : null)).find((e): e is Building => e?.kind === "building")!;
  return { gfa: programmeOf(b).gfa, floors: b.floors, height: b.height };
}

describe("explicit storey heights", () => {
  it("custom building: taller storeys keep the floor area of the same number of floors", () => {
    const base = gfaOf("custom.building", { shape: "rect", width: 30, depth: 20, floors: 10, use: "office" });
    const tall = gfaOf("custom.building", { shape: "rect", width: 30, depth: 20, floors: 10, use: "office", floor_height: 6, ground_floor_height: 7 });
    expect(tall.height).toBeGreaterThan(base.height * 1.3);
    expect(tall.gfa).toBeCloseTo(base.gfa, -1);
  });
  it("catalog building: a set floor height doesn't inflate floor area", () => {
    const base = gfaOf("buildings.building", { width: 30, depth: 20, floors: 6, use: "residential" });
    const tall = gfaOf("buildings.building", { width: 30, depth: 20, floors: 6, use: "residential", floorHeight: 5, groundFloorHeight: 6 });
    expect(tall.height).toBeGreaterThan(base.height * 1.3);
    expect(Math.abs(tall.gfa - base.gfa) / base.gfa).toBeLessThan(0.05);
  });
});
