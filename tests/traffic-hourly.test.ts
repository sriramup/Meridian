import { describe, expect, it } from "vitest";
import { HOURLY_PROFILE } from "@/sim/traffic";
import { PEAK_HOUR, amWeight, profileAt, trafficAt, type TrafficDay } from "@/sim/trafficHourly";

// three links: a busy arterial, a moderate street and an empty one
function day(withAlt = true): TrafficDay {
  const links = [
    { length: 800, capacity: 1800 },
    { length: 400, capacity: 900 },
    { length: 300, capacity: 600 },
  ];
  const mk = (flows: number[]) => {
    const cap = links.map((l) => l.capacity);
    const vc = flows.map((f, k) => f / cap[k]);
    const t0 = [800 / 15, 400 / 11, 300 / 9];
    return { flows: Float32Array.from(flows), vc: Float32Array.from(vc), time: Float32Array.from(t0.map((t, k) => t * (1 + 0.15 * vc[k] ** 4))) };
  };
  const pm = mk([1750, 600, 0]);
  const am = mk([1500, 700, 0]);
  return { period: "pm", ...pm, links, kpi: { vehTrips: 10000 }, hourly: HOURLY_PROFILE, alt: withAlt ? { period: "am", ...am, vehTrips: 9000 } : undefined };
}

describe("traffic through the day", () => {
  it("profile and peak weights", () => {
    expect(profileAt(PEAK_HOUR.pm + 0.5)).toBeCloseTo(HOURLY_PROFILE[17]);
    expect(profileAt(3.5)).toBeLessThan(profileAt(8.5));
    expect(amWeight(7)).toBe(1);
    expect(amWeight(18)).toBe(0);
    expect(amWeight(12)).toBeCloseTo(0.5);
  });
  it("reproduces each peak at its own hour", () => {
    const r = day();
    const pm = trafficAt(r, 17.5);
    expect(pm.flows[0]).toBeCloseTo(1750, 0);
    expect(pm.kpi.vehTrips).toBeCloseTo(10000, -1);
    const am = trafficAt(r, 8.5);
    expect(am.flows[1]).toBeCloseTo(700, 0);
    expect(am.kpi.vehTrips).toBeCloseTo(9000, -1);
  });
  it("every KPI changes with the hour, and night is quiet and free-flowing", () => {
    const r = day();
    const rows = [3, 7, 8.5, 12, 15, 17.5, 21].map((h) => trafficAt(r, h).kpi);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].vehTrips).not.toBeCloseTo(rows[i - 1].vehTrips, 0);
      expect(rows[i].delayHours).not.toBe(rows[i - 1].delayHours);
    }
    const night = trafficAt(r, 3).kpi,
      peak = trafficAt(r, 17.5).kpi;
    expect(night.vehTrips).toBeLessThan(peak.vehTrips / 5);
    expect(night.avgSpeed).toBeGreaterThan(peak.avgSpeed);
    expect(night.delayHours).toBeLessThan(peak.delayHours);
    expect(peak.congestedM).toBe(800);
    expect(night.congestedM).toBe(0);
  });
  it("is continuous across the hour marks and the AM/PM handover", () => {
    const r = day();
    for (let h = 0; h < 24; h += 0.01) {
      const a = trafficAt(r, h).kpi.vehTrips,
        b = trafficAt(r, h + 0.01).kpi.vehTrips;
      expect(Math.abs(b - a)).toBeLessThan(0.02 * Math.max(a, b) + 5);
    }
  });
  it("works with a single peak run", () => {
    const r = day(false);
    expect(trafficAt(r, 8.5).kpi.vehTrips).toBeCloseTo((10000 * HOURLY_PROFILE[8]) / HOURLY_PROFILE[17], -1);
  });
});
