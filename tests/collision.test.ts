import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { rectangle } from "@/geometry/polygon";
import { ensureLibrary } from "@/library";
import { blockedAt, clashes, nearestFreeOffset, obstacles } from "@/world/ops/collision";
import { duplicateInstance, moveInstance, placePrimitive, reconfigureInstance, rotateInstance, DEFAULT_CONFLICT, type LibraryOpResult } from "@/world/ops/library";
import { facingRotation, frontageSnap, frontDepthOf, nearestFrontage, snapAngle, snapToGrid, snapToVertex, FT } from "@/world/ops/snap";
import { createStreet } from "@/world/ops/streets";
import type { Building, Polygon, Street, Vec2 } from "@/world/types";
import { registerFixtures } from "./library-fixtures";

const sq = (c: Vec2, w: number, d = w, deg = 0): Polygon => [rectangle(c, w, d, (deg * Math.PI) / 180)];

describe("collision rules (pure)", () => {
  it("touching walls are fine; any real overlap clashes, even a small box inside a big one", () => {
    expect(clashes(sq([0, 0], 10), sq([10, 0], 10))).toBe(false);
    expect(clashes(sq([0, 0], 10), sq([9.5, 0], 10))).toBe(true);
    expect(clashes(sq([0, 0], 20), sq([0, 0], 1))).toBe(true);
    expect(clashes(sq([0, 0], 10), sq([30, 0], 10))).toBe(false);
  });

  it("finds the nearest free offset, flush against the obstacle", () => {
    const obs = obstacles([sq([0, 0], 10)]);
    const d = nearestFreeOffset([sq([8, 0], 10)], obs)!;
    expect(d).not.toBeNull();
    // pushed east until the walls touch (x = 10), not further than a few cm
    expect(d[0]).toBeGreaterThan(1.9);
    expect(d[0]).toBeLessThan(2.2);
    expect(Math.abs(d[1])).toBeLessThan(0.05);
    expect(blockedAt([sq([8, 0], 10)], obs, d)).toBe(false);
    // already clear: no offset
    expect(nearestFreeOffset([sq([30, 0], 10)], obs)).toEqual([0, 0]);
    // boxed in: nothing within reach
    const ring = obstacles([sq([0, 0], 200)]);
    expect(nearestFreeOffset([sq([0, 0], 10)], ring, { maxR: 10 })).toBeNull();
  });
});

describe("snapping (pure)", () => {
  it("grid, angle and vertex snapping", () => {
    expect(snapToGrid([12.1, -3.9], 7.62)).toEqual([15.24, -7.62]);
    expect(snapToGrid([1, 2], 0)).toEqual([1, 2]);
    expect(snapAngle(22)).toBe(15);
    expect(snapAngle(-6)).toBe(0);
    expect(snapAngle(-8)).toBe(345);
    expect(snapAngle(353)).toBe(0);
    expect(snapAngle(37.6)).toBe(45);
    expect(snapToVertex([1, 1], [[0, 0], [5, 5]], 2)).toEqual([0, 0]);
    expect(snapToVertex([3, 3], [[0, 0], [6, 6]], 2)).toBeNull();
  });

  it("faces the street and settles the front on the right-of-way or a setback line", () => {
    const R = loadHeadless("sandbox");
    R.scenarios.undo(R.scenarios.active.cursor);
    const made = createStreet(R.world, { path: [[-100, 0], [100, 0]], cls: "residential" }, { author: "user" });
    R.scenarios.commit(made.changeset!);
    const st = R.world.all("street")[0] as Street;
    const f = nearestFrontage([st], [10, 20])!;
    expect(f).not.toBeNull();
    expect(f.normal[1]).toBeCloseTo(1);
    // north side: the front (+y) must face south, i.e. heading 180
    expect(facingRotation(f)).toBeCloseTo(180);
    // a 10 m deep building near the setback line snaps onto it
    const row = f.rowEdge;
    const near = frontageSnap(f, [10, row + 10 * FT + 5 + 1], 5);
    expect(near.setback).toBeCloseTo(10 * FT);
    expect(near.at[0]).toBeCloseTo(10);
    expect(near.at[1]).toBeCloseTo(row + 10 * FT + 5);
    // far from any line: orientation only
    const free = frontageSnap(f, [10, row + 30], 5);
    expect(free.setback).toBeNull();
    expect(free.at).toEqual([10, row + 30]);
    // never inside the right-of-way
    const inRow = frontageSnap(f, [10, row - 2], 5);
    expect(inRow.at[1]).toBeCloseTo(row + 5);
    // south side faces north
    expect(facingRotation(nearestFrontage([st], [0, -20])!)).toBeCloseTo(0);
    // too far away: no frontage
    expect(nearestFrontage([st], [0, 200])).toBeNull();
    expect(frontDepthOf([sq([0, 0], 20, 10)], [0, 0], 0)).toBeCloseTo(5);
  });
});

describe("collision-safe ops (default policy)", () => {
  let R: ReturnType<typeof loadHeadless>;
  const user = { author: "user" as const };
  const commit = (r: LibraryOpResult) => {
    if (!r.ok) throw new Error(r.error);
    R.scenarios.commit(r.changeset!);
    return r;
  };
  beforeAll(() => {
    R = loadHeadless("sandbox");
    ensureLibrary();
    registerFixtures();
  });
  beforeEach(() => R.scenarios.undo(R.scenarios.active.cursor));

  it("defaults to safe and refuses a building over a building, with the nearest free spot", () => {
    expect(DEFAULT_CONFLICT).toBe("safe");
    const a = commit(placePrimitive(R.world, { def: "test.block", at: [0, 0] }, user));
    const r = placePrimitive(R.world, { def: "test.block", at: [20, 0] }, user);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/would overlap/);
    expect(r.error).toMatch(/Nearest free spot: 10 m east, at \[30, 0\]/);
    // flush beside it is fine
    commit(placePrimitive(R.world, { def: "test.block", at: [30, 0] }, user));
    expect(R.world.get(a.created[0])).toBeTruthy();
    // explicit replace still demolishes
    const rep = commit(placePrimitive(R.world, { def: "test.block", at: [10, 0], onConflict: "replace" }, user));
    expect(rep.removed.length).toBe(2);
  });

  it("refuses a building over a solid prop, and a small box inside a building", () => {
    commit(placePrimitive(R.world, { def: "test.kiosk", at: [0, 0] }, user));
    expect(placePrimitive(R.world, { def: "test.block", at: [0, 0] }, user).error).toMatch(/would overlap Test kiosk/);
    commit(placePrimitive(R.world, { def: "test.block", at: [100, 0], params: { width: 40, depth: 40 } }, user));
    const k = placePrimitive(R.world, { def: "test.kiosk", at: [118, 0], params: { width: 1, depth: 1 } }, user);
    expect(k.ok).toBe(false);
    expect(k.error).toMatch(/inside a building/);
    // kiosks may not overlap each other either
    expect(placePrimitive(R.world, { def: "test.kiosk", at: [1, 0] }, user).error).toMatch(/another object/);
    commit(placePrimitive(R.world, { def: "test.kiosk", at: [2, 0] }, user));
  });

  it("move, rotate, duplicate and re-configure never push into a neighbour", () => {
    commit(placePrimitive(R.world, { def: "test.block", at: [0, 0] }, user));
    const b = commit(placePrimitive(R.world, { def: "test.block", at: [0, 40] }, user));
    const id = b.created[0];
    expect(moveInstance(R.world, [id], [0, -30], user).ok).toBe(false);
    expect(moveInstance(R.world, [id], [0, -25], user).ok).toBe(false);
    commit(moveInstance(R.world, [id], [0, -20], user)); // flush: walls touch at y = 10
    // rotating a 30 × 20 block by 90° at 20 m from its neighbour makes it 30 deep: refused
    expect(rotateInstance(R.world, [id], 90, user).ok).toBe(false);
    expect(duplicateInstance(R.world, [id], [0, -20], user).ok).toBe(false);
    commit(duplicateInstance(R.world, [id], [0, 20], user));
    // growing into the neighbour is refused; the instance stays as it was
    const before = R.world.get<Building>(id)!.footprint;
    const g = reconfigureInstance(R.world, id, { depth: 30 }, user);
    expect(g.ok).toBe(false);
    expect(R.world.get<Building>(id)!.footprint).toEqual(before);
    // explicit carve is still available
    expect(reconfigureInstance(R.world, id, { depth: 30 }, user, { onConflict: "carve" }).ok).toBe(true);
  });

  it("areas still fit around existing buildings by default", () => {
    commit(placePrimitive(R.world, { def: "test.block", at: [0, 0], params: { width: 20, depth: 20 } }, user));
    const g = commit(placePrimitive(R.world, { def: "test.grove", site: [[[-60, -60], [60, -60], [60, 60], [-60, 60]]], params: { spacing: 15 } }, user));
    expect(g.ok).toBe(true);
  });
});

describe("refusal wording for the map", () => {
  it("is short, without ids or the agent's advice", async () => {
    const { shortError } = await import("@/components/library/placement");
    expect(shortError('Single-family home would overlap Single-family home b:xmv12. Nearest free spot: 4 m east, at [3, 4]. Move it, or use on_conflict "carve".')).toBe("Overlaps Single-family home");
    expect(shortError("Test kiosk can't stand at [1, 2]: inside a building. Nearest free spot: 4 m east, at [3, 4].")).toBe("Inside a building");
    expect(shortError("No room for Oak at [1, 2]: crown would hit a building")).toBe("Crown would hit a building");
  });
});
