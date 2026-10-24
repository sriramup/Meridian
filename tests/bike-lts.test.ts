import { describe, expect, it } from "vitest";
import { buildSection, type SectionInputs } from "@/geometry/crossSection";
import { crossingLTS, segmentLTS } from "@/sim/bike";
import type { Street } from "@/world/types";

const street = (inp: Partial<SectionInputs> & { cls: SectionInputs["cls"] }, speed: number, extra: Partial<Street> = {}): Street =>
  ({ id: "s", kind: "street", from: "a", to: "b", path: [[0, 0], [100, 0]], cls: inp.cls, oneway: !!inp.oneway, speed, section: buildSection({ oneway: false, ...inp }), ...extra }) as unknown as Street;

describe("bicycle level of traffic stress (Furth 2017)", () => {
  it("a protected track is LTS 1 regardless of the road", () => {
    expect(segmentLTS(street({ cls: "primary", lanes: 4, bikeLeft: "track", bikeRight: "track" }, 56))).toBe(1);
  });
  it("a calm residential street is LTS 1, a 4-lane arterial is LTS 4", () => {
    expect(segmentLTS(street({ cls: "residential", lanes: 2 }, 40))).toBe(1);
    expect(segmentLTS(street({ cls: "secondary", lanes: 4 }, 56))).toBe(4);
  });
  it("painted lanes help only on narrow, slow streets", () => {
    expect(segmentLTS(street({ cls: "tertiary", lanes: 2, bikeLeft: "lane", bikeRight: "lane" }, 40))).toBe(2);
    expect(segmentLTS(street({ cls: "secondary", lanes: 4, bikeLeft: "lane", bikeRight: "lane" }, 56))).toBe(3);
  });
  it("motorways are not rideable; pedestrian streets are calm", () => {
    expect(segmentLTS(street({ cls: "motorway", lanes: 4 }, 100))).toBeNull();
    expect(segmentLTS(street({ cls: "pedestrian" }, 10))).toBe(1);
  });
  it("crossing a wide fast street without a signal is high stress", () => {
    expect(crossingLTS(street({ cls: "secondary", lanes: 4, centreTurn: true }, 56))).toBe(4); // 5 lanes to cross
    expect(crossingLTS(street({ cls: "residential", lanes: 2 }, 40))).toBe(1);
  });
});
