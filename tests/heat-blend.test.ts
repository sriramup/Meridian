import { describe, expect, it } from "vitest";
import { blendValue } from "@/render/heatBlendLayer";
import { bracket } from "@/sim/heatKpi";

const HOURS = [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

/** what one cell shows at clock hour h, as the layer draws it */
function shown(values: number[], h: number) {
  const { i0, i1, t } = bracket(HOURS, h);
  return blendValue(values[i0], values[i1], t);
}

describe("heat hour blend", () => {
  it("never drops a cell that has data at either end", () => {
    expect(blendValue(0, 0, 0.3)).toBeNull();
    expect(blendValue(0, 120, 0.01)).toBe(120);
    expect(blendValue(80, 0, 0.99)).toBe(80);
    expect(blendValue(80, 120, 0.25)).toBe(90);
  });

  it("is continuous and monotone across every hour mark", () => {
    // a cell warming through the morning and cooling after 15:00
    const values = HOURS.map((h) => Math.round(80 + 60 * Math.max(0, Math.sin(((h - 6) / 18) * Math.PI))) || 1);
    let prev = shown(values, 0)!;
    for (let h = 0.001; h < 24; h += 0.001) {
      const v = shown(values, h)!;
      expect(v).not.toBeNull();
      // a step of 0.001 h can move the value only a little: no jump at a boundary
      expect(Math.abs(v - prev)).toBeLessThan(0.2);
      prev = v;
    }
    // just before and just after each modelled hour the cell shows (almost) that hour's value
    for (let k = 1; k < HOURS.length; k++) {
      expect(shown(values, HOURS[k] - 1e-6)!).toBeCloseTo(values[k], 3);
      expect(shown(values, HOURS[k])!).toBeCloseTo(values[k], 6);
    }
  });

  it("moves monotonically between two hours (no overshoot through other colours)", () => {
    const a = 60,
      b = 140;
    let prev = a;
    for (let t = 0; t <= 1; t += 0.01) {
      const v = blendValue(a, b, t)!;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(v).toBeLessThanOrEqual(b);
      prev = v;
    }
  });
});
