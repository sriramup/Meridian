import { describe, expect, it } from "vitest";
import { nearestModelHour, planImpact } from "@/sim/impact";
import type { Changeset } from "@/world/world";

// a 100 × 100 m grid of 2 m cells, two modelled hours; the plan plants one tree at the middle
const g = { x0: -50, y0: -50, cell: 2, nx: 50, ny: 50 };
const n = g.nx * g.ny;
const surf = (q: number) => new Uint8Array(n).fill(q);
const base = { hours: [10, 14], surface: [surf(100), surf(140)] };
// the plan's ground is 2 °C cooler at 10:00 and 4 °C cooler at 14:00 (dqT: q / 4 + 15)
const cur = { hours: [10, 14], surface: [surf(92), surf(124)] };
const cs = { id: "cs:test", ops: [{ type: "add", entity: { id: "t1", kind: "tree", p: [0, 0], r: 5 } }] } as unknown as Changeset;

describe("plan impact", () => {
  it("reads the modelled hour nearest the clock, so scrubbing between hours changes nothing", () => {
    expect(nearestModelHour(base.hours, 11.9)).toBe(10);
    expect(nearestModelHour(base.hours, 12.1)).toBe(14);
    const a = planImpact(base, cur, 10, g, [cs])!;
    expect(a.hour).toBe(10);
    expect(a.pins).toHaveLength(1);
    expect(a.pins[0].deltaC).toBeCloseTo(-2);
    expect(a.pins[0].areaM2).toBeGreaterThan(50);
    expect(planImpact(base, cur, 11.4, g, [cs])).toEqual(a);
    const b = planImpact(base, cur, 13.2, g, [cs])!;
    expect(b.hour).toBe(14);
    expect(b.pins[0].deltaC).toBeCloseTo(-4);
    // the same cells at every hour
    expect(b.pins[0].areaM2).toBe(a.pins[0].areaM2);
  });

  it("follows the plan: an undone edit leaves no pin", () => {
    expect(planImpact(base, cur, 10, g, [])!.pins).toHaveLength(0);
  });
});
