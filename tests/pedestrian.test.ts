import { describe, expect, it } from "vitest";
import { buildSection, hasSidewalk, type SectionInputs } from "@/geometry/crossSection";
import { pedIndex, shadeBenefit, walkable } from "@/sim/pedestrian";
import { walkableAlong } from "@/world/network";
import type { Street } from "@/world/types";

const street = (inp: Partial<SectionInputs> & { cls: SectionInputs["cls"] }, speed = 40): Street =>
  ({ id: "s", kind: "street", from: "a", to: "b", path: [[0, 0], [100, 0]], cls: inp.cls, oneway: false, speed, section: buildSection({ oneway: false, ...inp }) }) as unknown as Street;

describe("pedestrian activity proxy", () => {
  it("motorways and streets without sidewalks carry no pedestrians", () => {
    expect(walkable(street({ cls: "motorway", lanes: 4, sidewalkLeft: true, sidewalkRight: true }))).toBe(false);
    expect(walkable(street({ cls: "residential", sidewalkLeft: false, sidewalkRight: false }))).toBe(false);
    expect(walkable(street({ cls: "residential", sidewalkLeft: true, sidewalkRight: false }))).toBe(true);
    expect(walkable(street({ cls: "pedestrian" }))).toBe(true);
  });
  it("activity decays with distance and vanishes beyond the cutoff", () => {
    const f = pedIndex([{ p: [0, 0], w: 100 }]);
    expect(f([0, 0])).toBeCloseTo(100);
    expect(f([120, 0])).toBeLessThan(f([50, 0]));
    expect(f([1000, 0])).toBe(0);
  });
  it("shade helps only where exposure exceeds the air temperature, more where more people walk", () => {
    expect(shadeBenefit(36, 38, 1000)).toBe(0);
    expect(shadeBenefit(48, 38, 400)).toBeGreaterThan(shadeBenefit(48, 38, 100));
    expect(shadeBenefit(48, 38, 100)).toBeGreaterThan(shadeBenefit(42, 38, 100));
  });
});

describe("walking along streets without sidewalks", () => {
  it("detects a sidewalk behind a planting strip, per side", () => {
    const s = street({ cls: "residential", sidewalkLeft: true, sidewalkRight: false });
    expect(hasSidewalk(s.section, "left")).toBe(true);
    expect(hasSidewalk(s.section, "right")).toBe(false);
  });
  it("arterials with no sidewalk on either side are not walk routes; local streets stay walkable", () => {
    expect(walkableAlong(street({ cls: "secondary", lanes: 4, sidewalkLeft: false, sidewalkRight: false }, 56))).toBe(false);
    expect(walkableAlong(street({ cls: "secondary", lanes: 4, sidewalkLeft: true, sidewalkRight: false }, 56))).toBe(true);
    expect(walkableAlong(street({ cls: "residential", sidewalkLeft: false, sidewalkRight: false }))).toBe(true);
    expect(walkableAlong(street({ cls: "tertiary", sidewalkLeft: false, sidewalkRight: false }, 32))).toBe(true);
    expect(walkableAlong(street({ cls: "tertiary", sidewalkLeft: false, sidewalkRight: false }, 56))).toBe(false);
    expect(walkableAlong(street({ cls: "motorway", lanes: 3, sidewalkLeft: true, sidewalkRight: true }, 100))).toBe(false);
  });
});
