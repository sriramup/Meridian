import { describe, expect, it } from "vitest";
import { sunAltAz } from "@/lib/sun";
import { shadeMask, sunAt } from "@/sim/heat";
import type { Landcover } from "@/sim/landcover";

const deg = (r: number) => (r * 180) / Math.PI;

describe("sun position (suncalc 2.x normalised to radians, azimuth from south +west)", () => {
  it("winter-solstice noon in Austin is ~36° high, due south", () => {
    const s = sunAt("2026-12-21", 12.5, 30.27, -97.74, -6);
    expect(deg(s.alt)).toBeGreaterThan(34);
    expect(deg(s.alt)).toBeLessThan(38);
    expect(Math.abs(deg(s.az))).toBeLessThan(5);
  });
  it("morning sun is in the east (negative azimuth), afternoon in the west", () => {
    expect(sunAt("2026-06-21", 9, 30.27, -97.74, -5).az).toBeLessThan(0);
    expect(sunAt("2026-06-21", 17, 30.27, -97.74, -5).az).toBeGreaterThan(0);
  });
  it("returns radians, never degrees", () => {
    const s = sunAltAz(new Date(Date.UTC(2026, 5, 21, 18)), 30.27, -97.74);
    expect(Math.abs(s.alt)).toBeLessThanOrEqual(Math.PI / 2);
  });
});

describe("raster shadow propagation", () => {
  const nx = 200,
    ny = 200,
    cell = 4;
  const grid = { x0: -400, y0: -400, cell, nx, ny };
  const height = new Float32Array(nx * ny);
  // 40 m tower, 20 × 20 m, at the origin; plus a courtyard block (outer 60 m, inner 30 m, 15 m tall) at x = 200
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = grid.x0 + (i + 0.5) * cell,
        y = grid.y0 + (j + 0.5) * cell;
      if (Math.abs(x) < 10 && Math.abs(y) < 10) height[j * nx + i] = 40;
      const cx = Math.abs(x - 200),
        cy = Math.abs(y);
      if (Math.max(cx, cy) < 30 && Math.max(cx, cy) >= 15) height[j * nx + i] = 15;
    }
  const lc = { grid, height, cls: new Uint8Array(nx * ny), ground: new Uint8Array(nx * ny), canopy: new Float32Array(nx * ny) } as unknown as Landcover;
  const at = (x: number, y: number) => Math.floor((y - grid.y0) / cell) * nx + Math.floor((x - grid.x0) / cell);

  it("casts a shadow of length h / tan(alt) away from the sun", () => {
    const m = shadeMask(lc, [], [], Math.PI / 4, 0); // sun due south at 45°
    expect(m[at(0, 15)]).toBe(1); // just north of the tower
    expect(m[at(0, 38)]).toBe(1); // ~30 m north of the tower, inside its 40 m shadow
    expect(m[at(0, 58)]).toBe(0); // beyond the 40 m shadow
    expect(m[at(0, -20)]).toBe(0); // sunny south side
  });
  it("lights the open part of a courtyard and shades its southern strip", () => {
    const m = shadeMask(lc, [], [], Math.PI / 3, 0); // 60° sun: 15 m wall casts ~8.7 m
    expect(m[at(200, -12)]).toBe(1); // just inside the south wing
    expect(m[at(200, 8)]).toBe(0); // northern half of the courtyard is in sun
  });
});
