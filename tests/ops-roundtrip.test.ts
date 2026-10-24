import { describe, expect, it } from "vitest";
import { loadWorld } from "../scripts/dev/load";
import { createBuilding, modifyBuildings } from "@/world/ops/buildings";
import { editStreetSections, setNodeControl } from "@/world/ops/streets";
import { ScenarioManager } from "@/world/scenarios";
import type { Parcel } from "@/world/types";

describe("editing operations on the Austin pack", () => {
  const world = loadWorld();
  const sm = new ScenarioManager(world);
  const A = { author: "agent" as const };

  it("cascades a corridor widening and reports what it did", () => {
    const lav = world.all("street").filter((s) => s.name === "Lavaca Street");
    const r = editStreetSections(world, { streetIds: lav.map((s) => s.id), edits: [{ op: "add_lanes", count: 1, dir: "both" }], policy: "trim" }, A);
    expect(r.ok).toBe(true);
    expect(r.report.summary.some((s) => s.includes("segments rebuilt"))).toBe(true);
    // historic buildings are never auto-demolished under the trim policy
    expect(r.changeset!.ops.some((o) => o.type === "remove" && o.entity.kind === "building" && o.entity.historic)).toBe(false);
    sm.commit(r.changeset!);
  });

  it("builds a roundabout and a tower, then stretches the tower without changing its footprint", () => {
    const n4 = world.all("node").find((n) => world.incident(n.id).length === 4 && world.incident(n.id).every((s) => s.cls === "residential"))!;
    const rb = setNodeControl(world, n4.id, "roundabout", {}, A);
    expect(rb.ok).toBe(true);
    sm.commit(rb.changeset!);
    const site = world.all("parcel").filter((p) => (p.landUse === "vacant" || p.landUse === "parking") && p.zoningBase === "CBD").sort((a, b) => b.area - a.area)[0] as Parcel;
    const t = createBuilding(world, { site: site.poly, spec: { typology: "tower_podium", floors: 30, use: "mixed" }, name: "Test Tower" }, A);
    expect(t.ok).toBe(true);
    sm.commit(t.changeset!);
    const fp = t.building!.footprint;
    const m = modifyBuildings(world, { ids: [t.building!.id], heightScale: 1.2 }, A);
    sm.commit(m.changeset!);
    const after = world.get(t.building!.id)!;
    expect(after.kind === "building" && after.height).toBeGreaterThan(t.building!.height * 1.15);
    expect(after.kind === "building" && after.footprint).toEqual(fp);
  });

  it("undoes everything back to the exact baseline", () => {
    sm.undo(sm.active.cursor);
    const base = sm.materialize("baseline");
    let diff = 0;
    for (const [id, e] of world.entities) if (base.get(id) !== e) diff++;
    expect(diff).toBe(0);
    expect(world.entities.size).toBe(base.size);
  });
});
