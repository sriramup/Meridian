import { describe, expect, it } from "vitest";
import { validateToolInput } from "@/agent/tools";

describe("tool input validation (streamed inputs are checked before running)", () => {
  it("accepts well-formed input", () => {
    expect(validateToolInput("edit_streets", { street: "Lavaca Street", edits: [{ op: "add_lanes", count: 1 }] })).toBeNull();
    expect(validateToolInput("create_area", { type: "park", area: [[0, 0], [10, 0], [10, 10]] })).toBeNull();
    expect(validateToolInput("create_area", { type: "park", area: "Republic Square" })).toBeNull();
  });
  it("rejects missing required fields, wrong types and bad enums", () => {
    expect(validateToolInput("edit_streets", { street: "Lavaca Street" })).toMatch(/missing required field “edits”/);
    expect(validateToolInput("create_building", { site: "p:1", typology: "block", floors: "ten", use: "mixed" })).toMatch(/“floors” should be number/);
    expect(validateToolInput("optimize_bottlenecks", { period: "noon" })).toMatch(/must be one of am, pm/);
    expect(validateToolInput("nope", {})).toMatch(/Unknown tool/);
  });
});
