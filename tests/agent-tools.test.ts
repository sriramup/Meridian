import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";

let run: (name: string, input: Record<string, unknown>) => Promise<any>;
let R: ReturnType<typeof loadHeadless>;

beforeAll(async () => {
  R = loadHeadless();
  const { executeTool } = await import("@/agent/tools");
  run = async (name, input) => (await executeTool(name, input, { requestApproval: async () => true, approvals: false })).content;
});

describe("agent tool layer on the Austin pack", () => {
  it("dry-run previews report the cascade without changing anything", async () => {
    const before = R.world.entities.size;
    const r = await run("create_street", { path: [[700, 240], [1500, 260]], cls: "secondary", dry_run: true });
    expect(r.preview).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.buildings_demolished).toBeGreaterThan(0);
    expect(R.world.entities.size).toBe(before);
    expect(R.scenarios.active.cursor).toBe(0);
  });

  it("find_route returns an ordered corridor of real street ids", async () => {
    const r = await run("find_route", { from: "Republic Square", to: "Waterloo Park", mode: "bike", prefer: "low_stress" });
    expect(r.street_ids.length).toBeGreaterThan(3);
    for (const id of r.street_ids) expect(R.world.get(id)?.kind).toBe("street");
    expect(r.length_m).toBeGreaterThan(1500);
    expect(r.length_m).toBeLessThan(4000);
  });

  it("resolves intersections across East/West name variants", async () => {
    const r = await run("resolve_place", { query: "Lamar Boulevard & 6th Street" });
    expect(r[0].type).toBe("junction");
  });

  it("rejects malformed input before running anything", async () => {
    const before = R.scenarios.active.cursor;
    const r = await run("create_building", { site: "p:1", typology: "block", floors: "ten", use: "mixed" });
    expect(r.error).toMatch(/INVALID_INPUT/);
    expect(R.scenarios.active.cursor).toBe(before);
  });

  it("shade benefit ranks walkable street blocks, never motorways", async () => {
    const r = await run("rank_sites", { candidates: "streets", within: "Downtown", criterion: "shade_benefit", limit: 8 });
    expect(r.top.length).toBe(8);
    for (const x of r.top) {
      const s = R.world.get(x.id) as { kind: string; cls: string };
      expect(s.kind).toBe("street");
      expect(s.cls).not.toMatch(/motorway|trunk/);
      expect(x.score).toBeGreaterThan(0);
    }
  }, 120_000);

  it("emergency-access search proposes changes that raise 4-minute coverage, without committing on a dry run", async () => {
    const size = R.world.entities.size;
    const r = await run("optimize_emergency", { max_changes: 2, dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(r.proposed.length).toBeGreaterThan(0);
    for (const p of r.proposed) expect(p.residents_newly_within_4_min).toBeGreaterThanOrEqual(25);
    expect(R.world.entities.size).toBe(size);
    expect(R.scenarios.activeId).toBe("baseline");
  }, 120_000);

  it("parcels carry appraisal values and name only public owners", async () => {
    const bodies = /^(City of Austin|Austin Housing Finance Corporation|Housing Authority of the City of Austin|Travis County|State of Texas|University of Texas System|Austin ISD|Austin Community College|Capital Metro|United States|Integral Care)$/;
    const parcels = R.world.all("parcel");
    expect(parcels.filter((p) => p.value).length).toBeGreaterThan(parcels.length * 0.7);
    for (const p of parcels) if (p.owner) expect(p.owner).toMatch(bodies);
    const r = await run("find_features", { kind: "parcel", where: { owner: "private", underused: true }, limit: 5 });
    for (const row of r.rows ?? r) {
      expect(row.owner).toBe("private");
      expect(row.improvement_value_usd).toBeLessThan(row.land_value_usd * 0.5);
    }
  });
});
