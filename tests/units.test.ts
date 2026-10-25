import { describe, expect, it } from "vitest";
import {
  displayUnit, fmtArea, fmtDF, fmtDLen, fmtDepth, fmtF, fmtFt, fmtLen, fmtNum, fmtPerAcre, fmtRain, fmtSpeed, fmtVol,
  ftToM, toFt, toMph,
} from "@/lib/units";

describe("units", () => {
  it("formats numbers", () => {
    expect(fmtNum(12400)).toBe("12,400");
    expect(fmtNum(-2.04, 1)).toBe("−2.0");
    expect(fmtNum(-0.01, 1)).toBe("0.0");
  });
  it("switches feet to miles", () => {
    expect(fmtLen(3)).toBe("9.8 ft");
    expect(fmtLen(100)).toBe("328 ft");
    expect(fmtLen(300)).toBe("984 ft");
    expect(fmtLen(400)).toBe("0.2 mi");
    expect(fmtLen(3700)).toBe("2.3 mi");
    expect(fmtLen(20000)).toBe("12 mi");
    expect(fmtFt(43.3)).toBe("142 ft");
    expect(fmtDLen(-3)).toBe("−9.8 ft");
    expect(fmtDLen(3)).toBe("+9.8 ft");
  });
  it("switches sq ft to acres to sq mi", () => {
    expect(fmtArea(100)).toBe("1,076 sq ft");
    expect(fmtArea(4046.86 * 3.4)).toBe("3.4 acres");
    expect(fmtArea(17e6)).toBe("6.6 sq mi");
  });
  it("speed, temperature, volume, depth, density", () => {
    expect(fmtSpeed(13.4112)).toBe("30 mph");
    expect(fmtF(40)).toBe("104.0 °F");
    expect(fmtDF(-1)).toBe("−1.8 °F");
    expect(fmtDF(0.01)).toBe("0.0 °F");
    expect(fmtVol(1)).toBe("264 gal");
    expect(fmtVol(100)).toBe("3,531 cu ft");
    expect(fmtVol(12335)).toBe("10 acre-ft");
    expect(fmtRain(25.4)).toBe("1.0 in");
    expect(fmtDepth(0.15)).toBe("6 in");
    expect(fmtDepth(1)).toBe("3.3 ft");
    expect(fmtPerAcre(24 / 4046.8564224, "homes")).toBe("24 homes / acre");
  });
  it("round-trips form units", () => {
    const u = displayUnit("m");
    expect(u.label).toBe("ft");
    expect(u.fromDisplay(u.toDisplay(12.5))).toBeCloseTo(12.5, 9);
    expect(displayUnit("%").label).toBe("%");
    expect(displayUnit("°C").toDisplay(100)).toBeCloseTo(212);
    expect(toFt(ftToM(7))).toBeCloseTo(7);
    expect(toMph(1)).toBeCloseTo(2.23694, 4);
  });
});
