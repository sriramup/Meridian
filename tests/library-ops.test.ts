import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { ensureLibrary, validateParams, getPrimitive } from "@/library";
import { duplicateInstance, instanceOf, listInstances, moveInstance, placePrimitive, reconfigureInstance, removeInstance, rotateInstance, type LibraryOpResult } from "@/world/ops/library";
import { createStreet } from "@/world/ops/streets";
import { programmeOf } from "@/world/ops/core";
import { ScenarioManager } from "@/world/scenarios";
import { World } from "@/world/world";
import type { Building, Entity, Prop, Tree } from "@/world/types";
import { registerFixtures } from "./library-fixtures";

let R: ReturnType<typeof loadHeadless>;
const user = { author: "user" as const };

function commit(r: LibraryOpResult | { ok: boolean; changeset?: any; error?: string }) {
  if (!r.ok) throw new Error(r.error);
  R.scenarios.commit(r.changeset!);
  return r;
}
const snapshot = () => JSON.stringify([...R.world.entities.values()].sort((a, b) => a.id.localeCompare(b.id)));

beforeAll(() => {
  R = loadHeadless("sandbox");
  ensureLibrary();
  registerFixtures();
});

beforeEach(() => {
  // back to the empty canvas
  R.scenarios.undo(R.scenarios.active.cursor);
});

describe("library ops", () => {
  it("validates parameters: clamps, coerces, rejects unknown and invalid values", () => {
    const def = getPrimitive("test.block")!;
    const v = validateParams(def, { floors: "7", width: 1000, use: "Office", bogus: 1, with_tree: "maybe" });
    expect(v.params.floors).toBe(7);
    expect(v.params.width).toBe(200);
    expect(v.params.use).toBe("office");
    expect(v.issues.map((i) => i.kind).sort()).toEqual(["clamped", "invalid", "unknown"]);
    const r = placePrimitive(R.world, { def: "test.block", at: [0, 0], params: { bogus: 1 } }, user);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown parameter "bogus"/);
    const c = placePrimitive(R.world, { def: "test.block", at: [0, 0], params: { floors: 100 } }, user);
    expect(c.ok).toBe(true);
    expect(c.report.warnings.join(" ")).toMatch(/above the maximum 60/);
    expect(placePrimitive(R.world, { def: "test.grove", at: [0, 0] }, user).error).toMatch(/site polygon/);
    expect(placePrimitive(R.world, { def: "nope.nothing", at: [0, 0] }, user).error).toMatch(/Unknown primitive/);
  });

  it("places a prop and a building with a LibraryRef on every entity; undo/redo are exact", () => {
    const empty = snapshot();
    const r = commit(placePrimitive(R.world, { def: "test.kiosk", at: [10, 10], params: { canopy: true, color: "#ff0000" } }, user));
    const prop = R.world.get<Prop>(r.created[0])!;
    expect(prop.kind).toBe("prop");
    expect(prop.lib).toMatchObject({ def: "test.kiosk", instance: r.instance, primary: true, placement: { at: [10, 10] } });
    expect(prop.lib!.params.color).toBe("#ff0000");
    expect(prop.footprint?.[0].length).toBeGreaterThan(3);
    expect(prop.createdBy).toBeTruthy();
    const after1 = snapshot();
    const b = commit(placePrimitive(R.world, { def: "test.block", at: [60, 60], params: { floors: 6, with_tree: true }, name: "Elm Court" }, user));
    expect(b.created.length).toBe(2);
    const bld = R.world.get<Building>(b.created.find((id) => R.world.get(id)?.kind === "building")!)!;
    expect(bld.name).toBe("Elm Court");
    expect(bld.height).toBeCloseTo(19.2);
    expect(Number.isFinite(bld.ground)).toBe(true);
    const tree = R.world.all("tree")[0];
    expect(tree.lib?.instance).toBe(b.instance);
    expect(tree.lib?.primary).toBeFalsy();
    expect(instanceOf(R.world, tree.id)?.primary).toBe(bld.id);
    expect(listInstances(R.world).length).toBe(2);
    const after2 = snapshot();
    R.scenarios.undo();
    expect(snapshot()).toBe(after1);
    R.scenarios.undo();
    expect(snapshot()).toBe(empty);
    R.scenarios.redo(2);
    expect(snapshot()).toBe(after2);
  });

  it("reconfigures in place: same instance, same entity ids, user rename kept, exact undo", () => {
    const r = commit(placePrimitive(R.world, { def: "test.block", at: [0, 0], params: { floors: 4 } }, user));
    const id = r.created[0];
    expect(R.world.get<Building>(id)!.name).toBe("Block of 4 floors");
    const before = snapshot();
    const c = commit(reconfigureInstance(R.world, id, { floors: 9, use: "mixed" }, user));
    expect(c.changeset!.ops.every((o: any) => o.type === "update")).toBe(true);
    const nb = R.world.get<Building>(id)!;
    expect(nb.floors).toBe(9);
    expect(nb.use).toBe("mixed");
    expect(nb.name).toBe("Block of 9 floors"); // generated name follows the parameters
    expect(nb.lib).toMatchObject({ instance: r.instance, params: { floors: 9, use: "mixed", width: 30 }, primary: true });
    expect(c.report.summary[0]).toMatch(/floors 4 → 9/);
    R.scenarios.undo();
    expect(snapshot()).toBe(before);
    R.scenarios.redo();
    // a user rename survives re-configuration
    const named = { ...R.world.get<Building>(id)!, name: "The Larches" };
    R.scenarios.commit({ id: "cs:rename", label: "rename", author: "user", time: 0, ops: [{ type: "update", before: R.world.get(id)!, after: named }] });
    commit(reconfigureInstance(R.world, r.instance!, { floors: 3 }, user));
    expect(R.world.get<Building>(id)!.name).toBe("The Larches");
    expect(R.world.get<Building>(id)!.floors).toBe(3);
    // adding a tree adds an entity, removing it removes one
    commit(reconfigureInstance(R.world, id, { with_tree: true }, user));
    expect(instanceOf(R.world, id)!.entities.length).toBe(2);
    commit(reconfigureInstance(R.world, id, { with_tree: false }, user));
    expect(instanceOf(R.world, id)!.entities.length).toBe(1);
    expect(reconfigureInstance(R.world, id, { nope: 1 }, user).error).toMatch(/unknown parameter/);
  });

  it("resolves building conflicts: carve, refuse, replace", () => {
    const a = commit(placePrimitive(R.world, { def: "test.block", at: [0, 0] }, user));
    const refused = placePrimitive(R.world, { def: "test.block", at: [20, 0], onConflict: "refuse" }, user);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/overlap/);
    const carved = commit(placePrimitive(R.world, { def: "test.block", at: [20, 0] }, user));
    const cb = R.world.get<Building>(carved.created[0])!;
    expect(cb.footprint[0].every(([x]) => x >= 16.4)).toBe(true);
    expect(R.world.get(a.created[0])).toBeTruthy();
    expect(carved.report.conflicts.some((c) => /carved around/.test(c.message))).toBe(true);
    const rep = commit(placePrimitive(R.world, { def: "test.block", at: [10, 5], onConflict: "replace" }, user));
    expect(R.world.get(a.created[0])).toBeUndefined();
    expect(R.world.get(carved.created[0])).toBeUndefined();
    expect(rep.removed.length).toBe(2);
  });

  it("keeps props out of carriageways unless designed for it, and trees need crown room", () => {
    commit(createStreet(R.world, { path: [[-200, 300], [200, 300]], cls: "secondary" }, user));
    expect(placePrimitive(R.world, { def: "test.kiosk", at: [0, 300] }, user).error).toMatch(/roadway/);
    expect(placePrimitive(R.world, { def: "test.hump", at: [0, 300] }, user).ok).toBe(true);
    commit(placePrimitive(R.world, { def: "test.kiosk", at: [0, 200] }, user));
    expect(placePrimitive(R.world, { def: "test.kiosk", at: [0.5, 200.5] }, user).error).toMatch(/another object/);
    // a grove next to a building skips trees whose crowns would hit it
    commit(placePrimitive(R.world, { def: "test.block", at: [0, 100], params: { width: 20, depth: 20 } }, user));
    const g = commit(placePrimitive(R.world, { def: "test.grove", site: [[[-60, 60], [60, 60], [60, 140], [-60, 140]]], params: { spacing: 10 } }, user));
    const trees = R.world.all("tree") as Tree[];
    expect(trees.length).toBeGreaterThan(10);
    for (const t of trees) expect(Math.max(Math.abs(t.p[0]), Math.abs(t.p[1] - 100))).toBeGreaterThan(10 + t.r * 0.85 - 1e-6);
    expect(g.report.summary.join(" ")).toMatch(/Skipped .*(building|crown)/);
    // the park is carved around the building
    const park = R.world.all("area")[0];
    expect(park.poly.length + park.poly[0].length).toBeGreaterThan(5);
  });

  it("moves, rotates, duplicates and removes instances with exact undo", () => {
    const r = commit(placePrimitive(R.world, { def: "test.block", at: [0, 0], params: { with_tree: true } }, user));
    const bid = r.created[0];
    const s0 = snapshot();
    commit(moveInstance(R.world, [bid], [100, 50], user));
    const moved = R.world.get<Building>(bid)!;
    expect(moved.lib!.placement.at).toEqual([100, 50]);
    expect(Math.abs(moved.footprint[0].reduce((s, q) => s + q[0], 0) / 4 - 100)).toBeLessThan(0.01);
    commit(rotateInstance(R.world, [r.instance!], 90, user));
    expect(R.world.get<Building>(bid)!.lib!.placement.rotation).toBe(90);
    const d = commit(duplicateInstance(R.world, [bid], [0, 60], user, { count: 2 }));
    expect((d.data!.instances as string[]).length).toBe(2);
    expect(listInstances(R.world).length).toBe(3);
    const n = instanceOf(R.world, bid)!.entities.length;
    const rm = commit(removeInstance(R.world, [bid], user));
    expect(rm.removed.length).toBe(n);
    expect(R.world.get(bid)).toBeUndefined();
    expect(listInstances(R.world).length).toBe(2);
    R.scenarios.undo(4);
    expect(snapshot()).toBe(s0);
  });

  it("streets in an instance go through the street ops and are reconfigurable", () => {
    commit(createStreet(R.world, { path: [[-300, -300], [-300, 300]], cls: "secondary" }, user));
    const r = commit(placePrimitive(R.world, { def: "test.lane", path: [[-300, 0], [100, 0]] }, user));
    const st = R.world.all("street").filter((s) => s.lib?.instance === r.instance);
    expect(st.length).toBe(1);
    expect(st[0].lib?.primary).toBe(true);
    expect(R.world.incident(st[0].from).length).toBe(3); // spliced into the existing street
    const before = snapshot();
    commit(reconfigureInstance(R.world, st[0].id, { label: "Mill Lane" }, user));
    const st2 = R.world.all("street").filter((s) => s.lib?.instance === r.instance);
    expect(st2.length).toBe(1);
    expect(st2[0].name).toBe("Mill Lane");
    commit(removeInstance(R.world, [r.instance!], user));
    expect(R.world.all("street").filter((s) => s.lib).length).toBe(0);
    R.scenarios.undo(2);
    expect(snapshot()).toBe(before);
  });

  it("round-trips a design with props and library refs through a snapshot", () => {
    commit(placePrimitive(R.world, { def: "test.kiosk", at: [5, 5], params: { canopy: true } }, user));
    commit(placePrimitive(R.world, { def: "test.block", at: [80, 0], params: { units: 40 } }, user));
    const snap = JSON.parse(JSON.stringify(R.scenarios.snapshot()));
    const w = new World(R.meta);
    w.load([]);
    const S = new ScenarioManager(w, { baselineName: "Blank site", branchPrefix: "Design" });
    expect(S.restore(snap)).toBe(true);
    const norm = (m: Map<string, Entity>) => JSON.stringify([...m.values()].sort((a, b) => a.id.localeCompare(b.id)));
    expect(norm(w.entities)).toBe(norm(R.world.entities));
    expect(w.all("prop").length).toBe(1);
    expect(w.all("prop")[0].lib?.def).toBe("test.kiosk");
    S.undo(S.active.cursor);
    expect(w.entities.size).toBe(0);
  });

  it("library buildings carry stated occupancy into the programme", () => {
    const r = commit(placePrimitive(R.world, { def: "test.block", at: [0, 0], params: { units: 48, floors: 4 } }, user));
    const b = R.world.get<Building>(r.created[0])!;
    const pr = programmeOf(b, 2.5);
    expect(pr.units).toBeGreaterThan(40);
    expect(pr.units).toBeLessThan(56);
    expect(pr.residents).toBeCloseTo(pr.units * 2.5);
    const o = commit(placePrimitive(R.world, { def: "test.block", at: [100, 0], params: { use: "office", floors: 5 } }, user));
    expect(programmeOf(R.world.get<Building>(o.created[0])!).jobs).toBeGreaterThan(50);
  });
});
