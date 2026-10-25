import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import type { Zone } from "@/agent/types";

let R: ReturnType<typeof loadHeadless>;
let Z: typeof import("@/agent/zones");
let exec: typeof import("@/agent/tools").executeTool;
const ctx = (zone: Zone | null, extra: Record<string, unknown> = {}) => ({ requestApproval: async () => true, approvals: false, zone, sessionId: "s_test", ...extra });

beforeAll(async () => {
  R = loadHeadless();
  Z = await import("@/agent/zones");
  exec = (await import("@/agent/tools")).executeTool;
}, 180_000);

describe("zoneFromText on the Austin pack", () => {
  it("resolves four bounding streets to the enclosed blocks", () => {
    const r = Z.zoneFromText("between 5th and 7th from Congress to Lavaca");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ha = Z.hectares(r.zone.poly);
    expect(ha).toBeGreaterThan(2);
    expect(ha).toBeLessThan(8);
    expect(r.zone.label).toMatch(/acres?$/);
    // the comma form and the reversed order name the same area
    const r2 = Z.zoneFromText("between 7th and 5th, Lavaca and Congress");
    expect(r2.ok && Math.abs(Z.hectares(r2.zone.poly) - ha)).toBeLessThan(0.01);
  });

  it("'the block at A & B' gives the blocks around the junction with each corner as a candidate", () => {
    const r = Z.zoneFromText("the block at Lamar & 6th");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates?.length).toBe(4);
    const ne = Z.zoneFromText("NE block of Lamar & 6th");
    expect(ne.ok && ne.zone.label).toMatch(/^NE block at Lamar & 6th/);
    expect(ne.ok && Z.hectares(ne.zone.poly)).toBeLessThan(4);
  });

  it("corridors, radii and places", () => {
    const c = Z.zoneFromText("Congress between 5th and 7th");
    expect(c.ok && Z.hectares(c.zone.poly)).toBeGreaterThan(1);
    const w = Z.zoneFromText("within 300 m of Republic Square");
    expect(w.ok && Z.hectares(w.zone.poly)).toBeCloseTo((Math.PI * 300 * 300) / 1e4, 0);
    const p = Z.zoneFromText("Waterloo Park");
    expect(p.ok && p.zone.source).toBe("place");
  });

  it("explains streets that don't meet instead of guessing", () => {
    const r = Z.zoneFromText("the block at Foo Street & Bar Avenue");
    expect(r.ok).toBe(false);
    const r2 = Z.zoneFromText("between 5th and 7th from Congress to Nowhere Lane");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/Nowhere/);
  });

  it("'5th' does not match 15th or 25th", () => {
    const r = Z.zoneFromText("between 5th and 6th from Congress to Brazos");
    expect(r.ok && Z.hectares(r.zone.poly)).toBeLessThan(3);
  });
});

describe("zone enforcement in the executor", () => {
  let zone: Zone;
  beforeAll(() => {
    const r = Z.zoneFromText("between 5th and 7th from Congress to Lavaca");
    if (!r.ok) throw new Error(r.error);
    zone = r.zone;
  });

  it("refuses an edit outside the zone and tells the model why", async () => {
    const c = R.scenarios.active.cursor;
    const out = await exec("create_area", { type: "park", area: { center: [800, 800], radius: 30 } }, ctx(zone));
    expect(out.blocked).toBe(true);
    expect(String((out.content as { error: string }).error)).toMatch(/outside the session zone/);
    expect(R.scenarios.active.cursor).toBe(c);
  });

  it("dry runs report the zone check", async () => {
    const out = await exec("create_area", { type: "plaza", area: { center: [800, 800], radius: 30 }, dry_run: true }, ctx(zone));
    expect((out.content as { zone_check: string }).zone_check).toMatch(/Refused/);
  });

  it("an edit to a whole corridor that runs beyond the zone is refused; limited to the zone it applies", async () => {
    const all = await exec("set_street_attributes", { street: "Congress Avenue", speed_kmh: 30, within: "Downtown" }, ctx(zone));
    expect(all.blocked).toBe(true);
    const c = R.scenarios.active.cursor;
    const inside = await exec("set_street_attributes", { street: "Congress Avenue", speed_kmh: 30 }, ctx(zone));
    expect(inside.isError).toBeFalsy();
    expect((inside.content as { note_from_runtime: string }).note_from_runtime).toMatch(/Limited to the session zone/);
    expect(R.scenarios.active.cursor).toBe(c + 1);
    const cs = R.scenarios.appliedChangesets().at(-1)!;
    expect(cs.session).toBe("s_test");
  });

  it("'zone' as an area reference resolves to the session zone", async () => {
    const out = await exec("describe_area", { area: "zone" }, ctx(zone));
    expect(out.isError).toBeFalsy();
  });

  it("containment rules: placed features must be mostly inside; boundary cascades are allowed", () => {
    const [x0, y0, x1, y1] = [0, 0, 100, 100];
    const z = Z.zoneFromPolygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    const b = (id: string, cx: number, cy: number, h = 10) => ({ id, kind: "building", footprint: [[[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]], masses: [], height: 10 }) as never;
    expect(Z.zoneCheck(z, { ops: [{ type: "add", entity: b("a", 50, 50) }] }).ok).toBe(true);
    // a new building straddling the edge, mostly outside: refused
    expect(Z.zoneCheck(z, { ops: [{ type: "add", entity: b("a", 116, 50) }] }).ok).toBe(false);
    // within the 10 m tolerance: allowed
    expect(Z.zoneCheck(z, { ops: [{ type: "add", entity: b("a", 105, 50) }] }).ok).toBe(true);
    // the edit inside trims a building just across the edge (cascade): allowed
    expect(Z.zoneCheck(z, { ops: [{ type: "add", entity: b("a", 50, 50) }, { type: "remove", entity: b("c", 120, 50) }] }).ok).toBe(true);
    // ...but not one 200 m away
    expect(Z.zoneCheck(z, { ops: [{ type: "add", entity: b("a", 50, 50) }, { type: "remove", entity: b("c", 300, 50) }] }).ok).toBe(false);
    // a street crossing the boundary may be edited as a whole
    const s = (id: string, path: number[][]) => ({ id, kind: "street", path }) as never;
    const st = s("s", [[50, 50], [250, 50]]);
    expect(Z.zoneCheck(z, { ops: [{ type: "update", before: st, after: st }] }).ok).toBe(true);
    const far = s("t", [[300, 50], [400, 50]]);
    expect(Z.zoneCheck(z, { ops: [{ type: "update", before: far, after: far }] }).ok).toBe(false);
  });
});
