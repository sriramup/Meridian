import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { loadHeadless } from "../scripts/dev/headless";
import { memoryBackend, type LegacyDesign, type ProjectMeta } from "@/state/persist";
import { makeProject, migrateLegacy, moveProject, neighbourOf, pickInitial, sortProjects, uniqueName } from "@/state/projects";
import { sandboxRuntime } from "@/state/runtime";
import { relativeTime } from "@/components/projects/time";
import { ScenarioManager, type ScenarioSnapshot } from "@/world/scenarios";
import { World } from "@/world/world";
import type { CityMeta } from "@/world/types";

const climate = JSON.parse(fs.readFileSync("public/data/austin/meta.json", "utf8")) as CityMeta;

const list = (...names: string[]): ProjectMeta[] => names.map((n, i) => ({ id: `p${i}`, name: n, base: "sandbox", climate: "austin", createdAt: i, updatedAt: i * 10, order: i }));

describe("project list model", () => {
  it("names new projects uniquely and puts them on top", () => {
    const l = list("Untitled canvas", "Untitled canvas 2");
    expect(uniqueName("Untitled canvas", l)).toBe("Untitled canvas 3");
    expect(uniqueName("Plan", l)).toBe("Plan");
    expect(uniqueName("untitled CANVAS", l)).toBe("untitled CANVAS 3");
    // renaming a project to its own name is not a clash
    expect(uniqueName("Untitled canvas", l, "Untitled canvas")).toBe("Untitled canvas");
    const p = makeProject("austin", l, { now: 5 });
    expect(p).toMatchObject({ name: "Austin plan", base: "austin", climate: "austin", createdAt: 5, updatedAt: 5 });
    expect(sortProjects([...l, p])[0].id).toBe(p.id);
    const b = makeProject("sandbox", l);
    expect(b.name).toBe("Untitled canvas 3");
    expect(b.climate).toBe("austin");
    expect(() => makeProject("atlantis", l)).toThrow();
  });

  it("reorders by index and renumbers", () => {
    const l = list("a", "b", "c", "d");
    expect(moveProject(l, "p0", 2).map((p) => p.name)).toEqual(["b", "c", "a", "d"]);
    expect(moveProject(l, "p3", 0).map((p) => p.name)).toEqual(["d", "a", "b", "c"]);
    expect(moveProject(l, "p3", 0).map((p) => p.order)).toEqual([0, 1, 2, 3]);
    expect(moveProject(l, "p1", 99).map((p) => p.name)).toEqual(["a", "c", "d", "b"]);
    expect(moveProject(l, "nope", 1).map((p) => p.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("chooses the neighbour of a deleted project", () => {
    const l = list("a", "b", "c");
    expect(neighbourOf(l, "p1")).toBe("p2");
    expect(neighbourOf(l, "p2")).toBe("p1");
    expect(neighbourOf(list("a"), "p0")).toBeNull();
  });

  it("opens the URL's project, an old ?city= address, the last one, or makes a canvas", () => {
    const l = [...list("a", "b"), { ...list("x")[0], id: "aus", base: "austin", updatedAt: 99 }];
    expect(pickInitial(l, { project: "p1" })).toEqual({ open: "p1" });
    expect(pickInitial(l, { project: "gone", last: "p1" })).toEqual({ open: "p1" });
    expect(pickInitial(l, { city: "austin" })).toEqual({ open: "aus" });
    expect(pickInitial(list("a"), { city: "austin" })).toEqual({ create: "austin" });
    expect(pickInitial(l, {})).toEqual({ open: "p0" });
    expect(pickInitial([], {})).toEqual({ create: "sandbox" });
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-10-25T12:00:00");
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3 h ago");
    expect(relativeTime(Date.parse("2026-10-24T09:00:00"), now)).toBe("yesterday");
    expect(relativeTime(Date.parse("2026-03-04T09:00:00"), now)).toBe("Mar 4");
  });
});

/** a snapshot with two branches of real edits on a fresh sandbox */
async function sandboxDesign() {
  const R = loadHeadless("sandbox");
  const { executeTool } = await import("@/agent/tools");
  const run = async (name: string, input: Record<string, unknown>) => (await executeTool(name, input, { requestApproval: async () => true, approvals: false })).content;
  await run("create_street", { path: [[-300, 0], [300, 0]], cls: "secondary", name: "Main" });
  await run("create_building", { site: [[20, -40], [120, -40], [120, -120], [20, -120]], typology: "block", floors: 4, use: "residential" });
  R.scenarios.branch("Option B");
  await run("create_area", { polygon: [[-200, 40], [-100, 40], [-100, 120], [-200, 120]], type: "park" });
  return R;
}

describe("persistence and migration", () => {
  let snap: ScenarioSnapshot;
  let count: number;
  let activeName: string;
  beforeAll(async () => {
    const R = await sandboxDesign();
    snap = R.scenarios.snapshot();
    count = R.world.entities.size;
    activeName = R.scenarios.active.name;
  }, 120_000);

  it("migrates the old single blank-canvas design into a project, once", async () => {
    const legacy: LegacyDesign = { format: "meridian-design", version: 1, climate: "austin", savedAt: "2026-09-01T10:00:00Z", scenarios: snap };
    const be = memoryBackend({ legacy });
    const made = await migrateLegacy(be);
    expect(made).toMatchObject({ name: "My design", base: "sandbox", climate: "austin", updatedAt: Date.parse(legacy.savedAt) });
    expect(await be.list()).toHaveLength(1);
    const data = await be.getData(made!.id);
    expect(data?.scenarios?.scenarios.length).toBe(snap.scenarios.length);
    // a second start does not migrate again (even after the project is deleted)
    await be.remove(made!.id);
    expect(await migrateLegacy(be)).toBeNull();
    expect(await be.list()).toHaveLength(0);
  });

  it("skips an empty legacy design", async () => {
    const R = sandboxRuntime("austin", climate);
    const be = memoryBackend({ legacy: { format: "meridian-design", version: 1, climate: "austin", savedAt: "", scenarios: R.scenarios.snapshot() } });
    expect(await migrateLegacy(be)).toBeNull();
    expect(await be.kvGet("migrated")).toBe(true);
  });

  it("round-trips a sandbox project's proposals through storage onto a fresh runtime", async () => {
    const be = memoryBackend();
    const p = makeProject("sandbox", []);
    await be.putMeta(p);
    await be.putData(p.id, { scenarios: snap, view: { center: [10, 20], zoom: 16, pitch: 40, bearing: 5 } });
    const back = await be.getData(p.id);
    const R2 = sandboxRuntime("austin", climate);
    expect(R2.scenarios.restore(back!.scenarios!)).toBe(true);
    expect(R2.world.entities.size).toBe(count);
    expect(R2.scenarios.active.name).toBe(activeName);
    expect([...R2.scenarios.scenarios.values()].map((s) => s.name)).toEqual(snap.scenarios.map((s) => s.name));
    expect(back!.view).toEqual({ center: [10, 20], zoom: 16, pitch: 40, bearing: 5 });
    // full undo history survives
    R2.scenarios.undo(R2.scenarios.active.cursor);
    expect(R2.world.entities.size).toBe(0);
  });
});

describe("Austin-based project", () => {
  it("saves edits to a measured city and restores them on a fresh load of the pack", async () => {
    const R = loadHeadless("austin");
    const { executeTool } = await import("@/agent/tools");
    const before = R.world.entities.size;
    const [b, gone] = R.world.all("building");
    await executeTool("remove_features", { ids: [gone.id] }, { requestApproval: async () => true, approvals: false });
    R.scenarios.rename(R.scenarios.activeId, "Green plan");
    expect(R.scenarios.active.cursor).toBeGreaterThan(0);
    const after = R.world.entities.size;
    const be = memoryBackend();
    const p = makeProject("austin", []);
    await be.putData(p.id, { scenarios: R.scenarios.snapshot() });

    // a fresh world from the same pack, as the next visit would build
    const w = new World(R.meta);
    w.load([...R.scenarios.materialize("baseline").values()]);
    const S = new ScenarioManager(w);
    expect(w.entities.size).toBe(before);
    expect(S.restore((await be.getData(p.id))!.scenarios!)).toBe(true);
    expect(S.active.name).toBe("Green plan");
    expect(w.entities.size).toBe(after);
    expect(w.get(b.id)).toBeTruthy();
    expect(w.get(gone.id)).toBeUndefined();
    expect(after).toBe(before - 1);
  }, 180_000);
});
