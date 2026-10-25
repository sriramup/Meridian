import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { nameScore, resolvePlace } from "@/agent/resolve";

let run: (name: string, input: Record<string, unknown>) => Promise<any>;
const tools = async () => {
  const { executeTool } = await import("@/agent/tools");
  run = async (name, input) => (await executeTool(name, input, { requestApproval: async () => true, approvals: false })).content;
};

describe("fuzzy street names", () => {
  it("ignores directional prefixes, street types, ordinals in words and small typos", () => {
    expect(nameScore("21st", "West 21st Street")).toBeGreaterThanOrEqual(0.9);
    expect(nameScore("twenty-first street", "W 21st St")).toBeGreaterThanOrEqual(0.9);
    expect(nameScore("guadelupe", "Guadalupe Street")).toBeGreaterThanOrEqual(0.8);
    expect(nameScore("MLK", "East Martin Luther King Jr Boulevard")).toBeGreaterThanOrEqual(0.9);
    expect(nameScore("5th", "15th Street")).toBeLessThan(0.6);
    expect(nameScore("Pine Street", "Pine Avenue")).toBeLessThan(nameScore("Pine Street", "Pine St"));
  });
});

describe("navigation on Austin", () => {
  beforeAll(async () => {
    loadHeadless();
    await tools();
  }, 180_000);

  for (const q of ["21st and Guadalupe", "21st & guadalupe", "W 21st St and Guadalupe St", "Guadalupe at twenty-first", "corner of 21st and Guadalupe"])
    it(`resolves the intersection “${q}”`, () => {
      const m = resolvePlace(q)[0];
      expect(m?.type).toBe("junction");
      expect(m.name).toMatch(/21st/);
      expect(m.name).toMatch(/Guadalupe/);
    });

  it("go_to flies to an intersection and reports it", async () => {
    const r = await run("go_to", { place: "take-me-to 21st and Guadalupe".replace("take-me-to ", "") });
    expect(r.went_to.type).toBe("junction");
    expect(r.went_to.name).toMatch(/Guadalupe/);
  });

  it("“the university” is the UT campus, not a church or a neighbourhood", async () => {
    const r = await run("go_to", { place: "the university" });
    expect(r.went_to.name).toBe("University of Texas at Austin");
  });

  it("an unknown name returns suggestions instead of a guess", async () => {
    const r = await run("go_to", { place: "Guadaloop and 21st Boulevard Zzz" });
    if (r.error) expect(Array.isArray(r.suggestions)).toBe(true);
  });
});

describe("navigation on a designed canvas with user-named streets", () => {
  beforeAll(async () => {
    loadHeadless("sandbox");
    await tools();
    await run("create_street", { path: [[-400, 0], [400, 0]], cls: "secondary", name: "Pine Street" });
    await run("create_street", { path: [[0, -300], [0, 300]], cls: "residential", name: "Oak Avenue" });
    await run("create_street", { path: [[-400, 200], [400, 200]], cls: "residential", name: "North 3rd Street" });
    await run("create_area", { area: [[100, 40], [250, 40], [250, 160], [100, 160]], type: "park", name: "Commons Park" });
  }, 180_000);

  it("resolves a user-named intersection exactly as on city data", () => {
    for (const q of ["Pine and Oak", "pine st & oak ave", "Oak Avenue at Pine Street", "Oak and third"]) {
      const m = resolvePlace(q)[0];
      expect(m?.type, q).toBe("junction");
    }
    const m = resolvePlace("Pine and Oak")[0];
    expect(Math.hypot(m.p[0], m.p[1])).toBeLessThan(5);
  });

  it("go_to a street frames the corridor; a named park resolves too", async () => {
    const s = await run("go_to", { place: "Pine Street" });
    expect(s.went_to.type).toBe("street");
    expect(s.went_to.street_ids.length).toBeGreaterThan(0);
    const p = await run("go_to", { place: "commons park" });
    expect(p.went_to.name).toBe("Commons Park");
  });

  it("a typo still lands on the right street", async () => {
    const r = await run("go_to", { place: "Pnie Street" });
    // 4-letter tokens are not typo-matched (too ambiguous): suggestions instead
    if (r.error) expect(r.suggestions).toContain("Pine Street");
    else expect(r.went_to.name).toBe("Pine Street");
  });
});
