// Every catalog primitive through the framework: place with defaults, re-configure, undo exactly.
import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { defaultParams, ensureLibrary, listPrimitives, type PrimitiveDef } from "@/library";
import { placePrimitive, reconfigureInstance, instanceOf } from "@/world/ops/library";
import { rectangle } from "@/geometry/polygon";
import type { Vec2 } from "@/world/types";

let R: ReturnType<typeof loadHeadless>;
const user = { author: "user" as const };
const snapshot = () => JSON.stringify([...R.world.entities.values()].sort((a, b) => a.id.localeCompare(b.id)));

beforeAll(() => {
  R = loadHeadless("sandbox");
  ensureLibrary();
});

function placementFor(def: PrimitiveDef, c: Vec2) {
  switch (def.placement) {
    case "point":
      return { at: c, rotation: 30 };
    case "rect":
      return { at: c, rotation: 15 };
    case "polygon":
      return { site: [rectangle(c, 60, 40, 0.2)] };
    case "path":
      return { path: [[c[0] - 30, c[1] - 10], [c[0], c[1] + 5], [c[0] + 30, c[1] - 5]] as Vec2[] };
  }
}

/** a different valid value for the first parameter that has one */
function tweak(def: PrimitiveDef): Record<string, unknown> | null {
  const d = defaultParams(def);
  for (const p of def.params) {
    if (p.type === "integer" || p.type === "number") {
      const max = p.max ?? (p.default as number) * 2 + 1;
      const v = Math.min(max, (p.default as number) + (p.type === "integer" ? 1 : Math.max(0.5, (max - (p.min ?? 0)) * 0.1)));
      if (v !== d[p.key]) return { [p.key]: v };
    }
    if (p.type === "enum" && p.options.length > 1) return { [p.key]: p.options.find((o) => o.value !== p.default)!.value };
    if (p.type === "boolean") return { [p.key]: !p.default };
  }
  return null;
}

describe("catalog primitives through the library framework", () => {
  it("places, re-configures and undoes every catalog primitive", () => {
    const defs = listPrimitives().filter((d) => !d.id.startsWith("test."));
    expect(defs.length).toBeGreaterThan(2);
    const failures: string[] = [];
    defs.forEach((def, k) => {
      const c: Vec2 = [-1300 + (k % 16) * 160, -1300 + Math.floor(k / 16) * 160];
      const before = snapshot();
      const r = placePrimitive(R.world, { def: def.id, ...placementFor(def, c) }, user);
      if (!r.ok) return void failures.push(`${def.id} place: ${r.error}`);
      R.scenarios.commit(r.changeset!);
      const info = instanceOf(R.world, r.instance!);
      if (!info || !info.entities.length) return void failures.push(`${def.id}: no entities`);
      for (const id of info.entities) if (!R.world.get(id)!.hasOwnProperty("lib")) failures.push(`${def.id}: ${id} has no lib`);
      const t = tweak(def);
      if (t) {
        const c2 = reconfigureInstance(R.world, r.instance!, t, user);
        if (!c2.ok) failures.push(`${def.id} configure ${JSON.stringify(t)}: ${c2.error}`);
        else {
          R.scenarios.commit(c2.changeset!);
          if (JSON.stringify(instanceOf(R.world, r.instance!)!.params[Object.keys(t)[0]]) !== JSON.stringify(Object.values(t)[0])) failures.push(`${def.id}: param not applied`);
          R.scenarios.undo();
        }
      }
      R.scenarios.undo();
      if (snapshot() !== before) failures.push(`${def.id}: undo not exact`);
    });
    expect(failures).toEqual([]);
  }, 120_000);
});
