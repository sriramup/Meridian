import { describe, expect, it } from "vitest";
import { allocateGrowth, propensity, type GrowthSite } from "@/sim/growth";

const site = (id: string, o: Partial<GrowthSite> = {}): GrowthSite => ({ id, addedUnits: 100, landUse: "building", historic: false, transitMin: 20, ...o });
const params = { p0: 1000, capacity: 1600, rate: 0.05, years: 10, householdSize: 2, baseYear: 2020, snapshots: [5, 10] };

describe("growth scenario allocation", () => {
  it("prefers vacant land and lots whose buildings are worth little next to the land", () => {
    expect(propensity(site("v", { landUse: "vacant" }))).toBe(1);
    expect(propensity(site("cheap", { value: { land: 1e6, improvements: 1e5 } }))).toBeGreaterThan(propensity(site("dear", { value: { land: 1e6, improvements: 2e6 } })));
    expect(propensity(site("h", { landUse: "vacant", historic: true }))).toBe(0);
  });
  it("places each year's growth within capacity and accumulates it over time", () => {
    const sites = [site("vacant", { landUse: "vacant" }), site("old", { value: { land: 1e6, improvements: 2e6 } }), site("near", { landUse: "parking", transitMin: 3 }), site("hist", { landUse: "vacant", historic: true })];
    const r = allocateGrowth(sites, params);
    const [s5, s10] = r.snapshots;
    expect(s5.year).toBe(2025);
    const total = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(total(s10.added)).toBeGreaterThan(total(s5.added));
    expect(Math.abs(total(s10.added) - (r.series[10].population - r.series[0].population))).toBeLessThan(2);
    for (const [k, v] of s10.added.entries()) expect(v).toBeLessThanOrEqual(sites[k].addedUnits * params.householdSize + 0.1);
    expect(s10.added[3]).toBe(0);
    expect(s10.added[2]).toBeGreaterThan(s10.added[1]);
  });
  it("reports growth it cannot place when zoned capacity runs out", () => {
    const r = allocateGrowth([site("small", { addedUnits: 10, landUse: "vacant" })], params);
    expect(r.unplaced).toBeGreaterThan(0);
  });
});
