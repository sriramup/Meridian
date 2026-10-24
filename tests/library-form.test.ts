import { describe, expect, it } from "vitest";
import { changedKeys, coerce, coerceNumber, formatValue, layoutForm, segmentable, stepOf, widgetFor, withValue } from "@/components/library/formModel";
import type { NumberParam, ParamSpec } from "@/library/types";

const specs: ParamSpec[] = [
  { key: "name", label: "Name", type: "text", default: "" },
  { key: "floors", label: "Floors", type: "integer", default: 4, min: 1, max: 80, group: "Massing" },
  { key: "width", label: "Width", type: "number", default: 20, min: 4, max: 200, unit: "m", group: "Massing" },
  { key: "roof", label: "Roof", type: "enum", default: "flat", group: "Roof", options: [{ value: "flat", label: "Flat" }, { value: "gable", label: "Gable" }, { value: "hip", label: "Hip" }] },
  { key: "pitch", label: "Pitch", type: "number", default: 30, min: 10, max: 60, unit: "°", group: "Roof", when: { key: "roof", in: ["gable", "hip"] } },
  { key: "parapet", label: "Parapet", type: "boolean", default: true, group: "Roof", when: { key: "roof", in: ["flat"] }, advanced: true },
  { key: "wall", label: "Wall colour", type: "color", default: "#e8dcc8", group: "Facade", advanced: true },
  { key: "uses", label: "Uses", type: "multi", default: ["retail"], group: "Programme", options: [{ value: "retail", label: "Retail" }, { value: "office", label: "Office" }, { value: "homes", label: "Homes" }] },
];

describe("parameter form model", () => {
  it("groups active params, ungrouped first, advanced folded", () => {
    const d = Object.fromEntries(specs.map((p) => [p.key, p.default]));
    const l = layoutForm(specs, d);
    expect(l.sections.map((s) => s.title)).toEqual(["", "Massing", "Roof", "Programme"]);
    expect(l.sections.find((s) => s.title === "Roof")!.params.map((p) => p.key)).toEqual(["roof"]);
    expect(l.advanced.map((s) => s.title)).toEqual(["Roof", "Facade"]);
    expect(l.advancedCount).toBe(2);
  });

  it("applies when-conditions as values change", () => {
    let v = Object.fromEntries(specs.map((p) => [p.key, p.default]));
    v = withValue(v, specs[3], "gable");
    const l = layoutForm(specs, v);
    expect(l.sections.find((s) => s.title === "Roof")!.params.map((p) => p.key)).toEqual(["roof", "pitch"]);
    expect(l.advanced.map((s) => s.title)).toEqual(["Facade"]);
  });

  it("coerces numbers: clamp, integer rounding, junk input", () => {
    const floors = specs[1] as NumberParam;
    const width = specs[2] as NumberParam;
    expect(coerceNumber(floors, "7.6", 4)).toBe(8);
    expect(coerceNumber(floors, 500, 4)).toBe(80);
    expect(coerceNumber(floors, "abc", 4)).toBe(4);
    expect(coerceNumber(width, "12.345 m", 20)).toBe(12.35);
    expect(coerceNumber(width, -5, 20)).toBe(4);
  });

  it("coerces other types", () => {
    expect(coerce(specs[3], "mansard", "flat")).toBe("flat");
    expect(coerce(specs[3], "hip", "flat")).toBe("hip");
    expect(coerce(specs[6], "#ABCDEF", "#000000")).toBe("#abcdef");
    expect(coerce(specs[6], "red", "#000000")).toBe("#000000");
    expect(coerce(specs[7], ["homes", "nope", "retail"], [])).toEqual(["retail", "homes"]);
    expect(coerce(specs[5], "true", false)).toBe(true);
  });

  it("chooses widgets", () => {
    expect(widgetFor(specs[1])).toBe("slider");
    expect(widgetFor(specs[2])).toBe("number");
    expect(widgetFor(specs[3])).toBe("segmented");
    expect(widgetFor(specs[5])).toBe("switch");
    expect(widgetFor(specs[7])).toBe("multi");
    const many: ParamSpec = { key: "k", label: "K", type: "enum", default: "a", options: "abcdef".split("").map((x) => ({ value: x, label: x })) };
    expect(widgetFor(many)).toBe("select");
    expect(segmentable({ ...(specs[3] as never), options: [{ value: "a", label: "A very long option label" }, { value: "b", label: "Another long one" }] })).toBe(false);
  });

  it("formats values with units and finds changed keys", () => {
    expect(formatValue(specs[2], 12.5)).toBe("12.5 m");
    expect(formatValue(specs[4], 35)).toBe("35°");
    expect(formatValue(specs[7], ["retail", "homes"])).toBe("Retail, Homes");
    expect(stepOf(specs[2] as NumberParam)).toBe(2);
    const v = Object.fromEntries(specs.map((p) => [p.key, p.default]));
    expect(changedKeys(specs, { ...v, floors: 9 })).toEqual(["floors"]);
  });
});

import { groupForm, groupSummary } from "@/components/library/formModel";
describe("grouped form", () => {
  it("groups basic and advanced per group, following when", () => {
    const d = Object.fromEntries(specs.map((p) => [p.key, p.default]));
    const g = groupForm(specs, d);
    expect(g.map((x) => x.title)).toEqual(["", "Massing", "Roof", "Facade", "Programme"]);
    expect(g.find((x) => x.title === "Roof")!.advanced.map((p) => p.key)).toEqual(["parapet"]);
    expect(g.find((x) => x.title === "Facade")!.basic).toEqual([]);
    const g2 = groupForm(specs, { ...d, roof: "hip" });
    expect(g2.find((x) => x.title === "Roof")!.basic.map((p) => p.key)).toEqual(["roof", "pitch"]);
    expect(g2.find((x) => x.title === "Roof")!.advanced).toEqual([]);
    expect(groupSummary(g.find((x) => x.title === "Massing")!, d)).toBe("4 · 20 m");
  });
});
