import { describe, expect, it } from "vitest";
import { basemapColors, daylightFor, lightingTimestamp, lightsAt, nightAt, setDaylight, useNight, daylight } from "@/render/daylight";
import { localTimestamp } from "@/lib/sun";
import { LIGHTING_DATE } from "@/render/sky";
import { stackLayers } from "@/render/layers";
import type { Layer } from "@deck.gl/core";

const AUSTIN = { lat: 30.27, lon: -97.74, timezone: "America/Chicago" };

describe("day and night follow the clock", () => {
  it("night rises smoothly and monotonically as the sun sets", () => {
    let prev = -1;
    for (let alt = 30; alt >= -20; alt -= 0.5) {
      const n = nightAt(alt);
      expect(n).toBeGreaterThanOrEqual(prev);
      expect(n - Math.max(prev, 0)).toBeLessThan(0.06); // no jumps
      prev = n;
    }
    expect(nightAt(20)).toBe(0);
    expect(nightAt(-12)).toBe(1);
  });

  it("the sun is gone below the horizon and the moon takes over", () => {
    const noon = lightsAt(55),
      night = lightsAt(-25);
    expect(noon.sun.intensity).toBeGreaterThan(1.5);
    expect(noon.moon.intensity).toBe(0);
    expect(night.sun.intensity).toBe(0);
    expect(night.moon.intensity).toBeGreaterThan(0.2);
    expect(night.ambient.intensity).toBeLessThan(noon.ambient.intensity);
    // golden hour: warmer than noon
    expect(lightsAt(4).sun.color[2]).toBeLessThan(noon.sun.color[2]);
  });

  it("lighting timestamps match the wall clock on the lighting date without an Intl call per frame", () => {
    for (const h of [0, 6.25, 12, 18.5, 23.75]) expect(lightingTimestamp(h, AUSTIN.timezone)).toBe(localTimestamp(LIGHTING_DATE, h, AUSTIN.timezone));
  });

  it("an hour scrub covers dawn, noon, dusk and night on the fixed date", () => {
    const at = (h: number) => daylightFor(h, AUSTIN);
    expect(at(2).night).toBe(1);
    expect(at(13).night).toBe(0);
    expect(at(23).night).toBe(1);
    const dawn = at(7.2).night;
    expect(dawn).toBeGreaterThan(0);
    expect(dawn).toBeLessThan(1);
    // the moon sits opposite the sun: 12 h later
    expect(at(22).moonTs - at(22).sunTs).toBe(12 * 3_600_000);
  });

  it("night-only looks switch once, with the shared state", () => {
    setDaylight(daylightFor(13, AUSTIN));
    expect(useNight.getState().night).toBe(false);
    setDaylight(daylightFor(22, AUSTIN));
    expect(useNight.getState().night).toBe(true);
    expect(daylight.night).toBe(1);
  });

  it("basemap colours blend from day to night", () => {
    expect(basemapColors(0).bg).toBe("#e8d6b1");
    expect(basemapColors(1).bg).toBe("#14161a");
    expect(basemapColors(0.5).bg).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("draw order", () => {
  const L = (id: string) => ({ id }) as unknown as Layer;
  it("ground overlays (rasters, street-edge lines) always stack below buildings, labels last", () => {
    const out = stackLayers({ ground: [L("flat-0:0")], solid: [L("bld-0:0")], labels: [L("street-labels")] }, { ground: [L("heat"), L("kerb-lines-0:0")], top: [L("zones")] });
    expect(out.map((l) => l.id)).toEqual(["flat-0:0", "heat", "kerb-lines-0:0", "bld-0:0", "zones", "street-labels"]);
  });
});
