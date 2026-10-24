import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { loadHeadless } from "../scripts/dev/headless";
import { sandboxRuntime, setRuntime, type Runtime } from "@/state/runtime";
import { csvField, importProposalCSV, importProposalJSON, importProposalText, parseCsv, parseWkt, proposalCSV, proposalJSON, CSV_COLUMNS, PROPOSAL_FORMAT, ProposalImportError } from "@/state/proposalIO";
import { ensureLibrary, getPrimitive, registerPrimitive } from "@/library";
import { placePrimitive } from "@/world/ops/library";
import { createBuilding, modifyBuildings } from "@/world/ops/buildings";
import { createArea, plantTreesAt } from "@/world/ops/landscape";
import { createStreet, editStreetSections, setNodeControl } from "@/world/ops/streets";
import type { Entity, Parcel, Prop } from "@/world/types";

const A = { author: "user" as const };

// a small test primitive: a kiosk building with a bench prop beside it
function registerTestPrimitive() {
  ensureLibrary();
  if (getPrimitive("test.kiosk")) return;
  registerPrimitive({
    id: "test.kiosk",
    name: "Test kiosk",
    category: "streetscape",
    description: "A kiosk and a bench (test fixture)",
    placement: "point",
    params: [
      { key: "width", label: "Width", type: "number", default: 6, min: 2, max: 20 },
      { key: "color", label: "Colour", type: "color", default: "#aa5533" },
    ],
    generate(params, place, ctx) {
      const w = Number(params.width);
      const [x, y] = place.at!;
      const fp = [[[x - w / 2, y - w / 2], [x + w / 2, y - w / 2], [x + w / 2, y + w / 2], [x - w / 2, y + w / 2]]] as [number, number][][];
      return {
        buildings: [
          {
            id: ctx.id("b"),
            kind: "building",
            footprint: fp,
            masses: [{ poly: fp, base: 0, top: 4, role: "body", use: "retail" }],
            height: 4,
            floors: 1,
            use: "retail",
            program: { retail: 1 },
            ground: 150,
            heightSource: "proposed",
            useSource: "proposed",
            source: "test",
            lib: { ...ctx.ref, primary: true },
          },
        ],
        props: [{ id: ctx.id("pr"), kind: "prop", type: "test.bench", p: [x + w, y], rot: place.rotation ?? 0, solids: [{ shape: "box", at: [0, 0, 0], size: [2, 0.6, 0.5], color: [120, 80, 40], material: "wood" }], height: 0.5, source: "test", provenance: "proposed", lib: ctx.ref } as Prop],
      };
    },
  });
}

/** every entity of two worlds, compared one by one */
function expectSameWorld(a: Map<string, Entity>, b: Map<string, Entity>) {
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  for (const [id, e] of a) expect(b.get(id), id).toEqual(e);
}

describe("proposal files on the blank canvas", () => {
  let R: Runtime;
  beforeAll(() => {
    registerTestPrimitive();
    R = loadHeadless("sandbox");
    const commit = (r: { ok: boolean; changeset?: unknown; error?: string }) => {
      expect(r.ok, r.error).toBe(true);
      R.scenarios.commit(r.changeset as never);
    };
    commit(createStreet(R.world, { path: [[-300, 0], [300, 0]], cls: "secondary", name: "Main, \"the\" Boulevard" }, A));
    commit(createStreet(R.world, { path: [[0, -200], [0, 200]], cls: "residential" }, A));
    commit(createBuilding(R.world, { site: [[[40, 40], [140, 40], [140, 110], [40, 110]]], spec: { typology: "tower_podium", floors: 12, use: "mixed" }, name: "Tower, north\nside" }, A));
    commit(createArea(R.world, { type: "park", poly: [[[-150, 30], [-40, 30], [-40, 120], [-150, 120]]], name: "Green" }, A));
    commit(plantTreesAt(R.world, { points: [[-100, -40], [-80, -40]] } as never, A));
    commit(setNodeControl(R.world, R.world.all("node").find((n) => R.world.incident(n.id).length === 4)!.id, "signal", {}, A));
    commit(placePrimitive(R.world, { def: "test.kiosk", params: { width: 8 }, at: [-100, -120], rotation: 30 }, A));
    const b = R.world.all("building").find((x) => x.name?.startsWith("Tower"))!;
    commit(modifyBuildings(R.world, { ids: [b.id], floors: 15 }, A));
  });

  it("exports a readable, versioned JSON proposal", () => {
    const f = proposalJSON(R);
    expect(f.format).toBe(PROPOSAL_FORMAT);
    expect(f.version).toBe(1);
    expect(f.city).toMatchObject({ id: "sandbox", sandbox: true, climate: "austin" });
    expect(f.crs.origin.lon).toBeCloseTo(R.meta.origin.lon, 9);
    const p = f.proposals[0];
    expect(p.name).toBe(R.scenarios.active.name);
    expect(p.edits).toBe(R.scenarios.active.cursor);
    expect(p.changesets.length).toBe(p.edits);
    const feats = p.changes.features;
    // the sandbox has no existing features: everything is added
    expect(feats.every((x) => x.properties.action === "added")).toBe(true);
    expect(feats.length).toBe(R.world.entities.size);
    const tower = feats.find((x) => x.properties.name?.startsWith("Tower"))!;
    expect(tower.properties).toMatchObject({ kind: "building", use_type: "mixed", floors: 15 });
    expect(tower.properties.units).toBeGreaterThan(10);
    expect(tower.geometry.type).toBe("Polygon");
    const ring = (tower.geometry as { coordinates: number[][][] }).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(Math.abs(ring[0][0] - R.meta.origin.lon)).toBeLessThan(0.01);
    const kiosk = feats.find((x) => x.properties.library_def === "test.kiosk" && x.properties.kind === "prop")!;
    expect(kiosk.properties.library_params).toMatchObject({ width: 8 });
    expect(kiosk.properties.library_placement?.rotation).toBe(30);
    expect(p.summary.units).toBe(feats.reduce((s, x) => s + (x.properties.units ?? 0), 0));
  });

  it("re-imports the JSON as a new branch with exactly the same world, in a fresh session", () => {
    const text = JSON.stringify(proposalJSON(R), null, 2);
    const before = R.world.cloneEntities();
    const climate = JSON.parse(fs.readFileSync("public/data/austin/meta.json", "utf8"));
    const R2 = sandboxRuntime("austin", climate);
    setRuntime(R2);
    try {
      const res = importProposalJSON(R2, text);
      expect(res.names).toEqual([R.scenarios.active.name]);
      expect(R2.scenarios.active.cursor).toBe(R.scenarios.active.cursor);
      expectSameWorld(before, R2.world.cloneEntities());
      // and it undoes back to the empty site
      R2.scenarios.undo(R2.scenarios.active.cursor);
      expect(R2.world.entities.size).toBe(0);
    } finally {
      setRuntime(R);
    }
  });

  it("exports every proposal at once and imports them all", () => {
    const first = R.scenarios.activeId;
    const alt = R.scenarios.branch("Option B");
    R.scenarios.commit(createArea(R.world, { type: "plaza", poly: [[[150, -100], [220, -100], [220, -40], [150, -40]]] }, A).changeset!);
    const want = new Map([first, alt.id].map((id) => [R.scenarios.scenarios.get(id)!.name, R.scenarios.materialize(id)]));
    const f = proposalJSON(R, "all");
    expect(f.proposals.map((p) => p.name)).toEqual([...want.keys()]);
    const R2 = sandboxRuntime("austin", R.meta as never);
    const res = importProposalJSON(R2, JSON.stringify(f));
    expect(res.names).toEqual([...want.keys()]);
    for (const [i, id] of res.scenarios.entries()) expectSameWorld(want.get(res.names[i])!, R2.scenarios.materialize(id));
    R.scenarios.switchTo(first);
    R.scenarios.remove(alt.id);
  });

  it("writes one CSV row per changed feature and re-creates them from it", () => {
    const csv = proposalCSV(R);
    const table = parseCsv(csv);
    expect(table[0]).toEqual([...CSV_COLUMNS]);
    expect(table.length - 1).toBe(R.world.entities.size);
    const col = (n: string) => table[0].indexOf(n);
    const tower = table.find((r) => r[col("name")] === "Tower, north\nside")!;
    expect(tower[col("floors")]).toBe("15");
    expect(parseWkt(tower[col("geometry_wkt")]).type).toBe("Polygon");
    expect(table.find((r) => r[col("name")] === 'Main, "the" Boulevard')).toBeTruthy();

    const R2 = sandboxRuntime("austin", R.meta as never);
    const res = importProposalCSV(R2, csv);
    expect(res.names[0]).toBe(R.scenarios.active.name);
    expect(res.notes.some((n) => /cross-section/.test(n))).toBe(true);
    const count = (m: Map<string, Entity>, k: string) => [...m.values()].filter((e) => e.kind === k).length;
    const a = R.world.cloneEntities(),
      b = R2.world.cloneEntities();
    for (const k of ["building", "street", "node", "area", "tree", "prop"]) expect(count(b, k), k).toBe(count(a, k));
    // buildings come back at the same place and height (lon/lat rounding is a centimetre)
    for (const x of R.world.all("building")) {
      const y = [...b.values()].find((e) => e.kind === "building" && Math.abs(e.height - x.height) < 0.06 && Math.abs(e.footprint[0][0][0] - x.footprint[0][0][0]) < 0.05);
      expect(y, x.name ?? x.id).toBeTruthy();
    }
    // the library instance is placed again from its definition and parameters
    const kiosk = R2.world.all("prop").find((p) => p.lib?.def === "test.kiosk")!;
    expect(kiosk.lib!.params).toMatchObject({ width: 8 });
    expect(kiosk.p[0]).toBeCloseTo(-92, 1);
  });

  it("refuses files for another city, version or format", () => {
    const f = proposalJSON(R);
    const R2 = sandboxRuntime("austin", R.meta as never);
    expect(() => importProposalJSON(R2, JSON.stringify({ ...f, version: 2 }))).toThrow(/version 2/);
    expect(() => importProposalJSON(R2, JSON.stringify({ ...f, city: { ...f.city, id: "austin", name: "Austin" } }))).toThrow(/made for Austin/);
    expect(() => importProposalJSON(R2, JSON.stringify({ format: "geojson" }))).toThrow(ProposalImportError);
    expect(() => importProposalJSON(R2, "{not json")).toThrow(/not JSON/);
    expect(() => importProposalText(R2, "a,b\n1,2\n")).toThrow(/not a Meridian proposal/);
    expect(() => importProposalCSV(R2, proposalCSV(R).replace(/\r\n([^,\r\n]*),sandbox,/g, "\r\n$1,austin,"))).toThrow(/made for austin/);
    expect(R2.scenarios.scenarios.size).toBe(1);
  });

  it("still opens blank-canvas design files (all their branches)", () => {
    const legacy = { format: "meridian-design", version: 1, climate: "austin", savedAt: "", scenarios: R.scenarios.snapshot() };
    const R2 = sandboxRuntime("austin", R.meta as never);
    const res = importProposalJSON(R2, JSON.stringify(legacy));
    expect(res.names).toEqual([R.scenarios.active.name]);
    expectSameWorld(R.world.cloneEntities(), R2.world.cloneEntities());
  });
});

describe("CSV fields", () => {
  it("round-trips commas, quotes, line breaks and JSON", () => {
    const rows = [
      ["plain", "with, comma", 'with "quotes"', "multi\nline", "crlf\r\nline", "", "  spaced  ", "ünïcödé"],
      [JSON.stringify({ a: [1, 2], b: 'x,"y"' }), "1.5", "-0", "=SUM(A1)", '"', ",", "\n", "end"],
    ];
    const text = rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
    expect(parseCsv(text)).toEqual(rows);
    expect(parseCsv("﻿a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
    expect(csvField(null)).toBe("");
    expect(csvField({ k: "v" })).toBe('"{""k"":""v""}"');
    expect(() => parseCsv('a,"open')).toThrow(/never closed/);
  });

  it("reads WKT points, lines and polygons with holes", () => {
    expect(parseWkt("POINT (-97.7 30.2)")).toEqual({ type: "Point", coordinates: [-97.7, 30.2] });
    expect(parseWkt("LINESTRING (0 0, 1 1)").coordinates).toEqual([[0, 0], [1, 1]]);
    const p = parseWkt("POLYGON ((0 0, 4 0, 4 4, 0 0), (1 1, 2 1, 2 2, 1 1))");
    expect(p.coordinates.length).toBe(2);
  });
});

describe("proposal files on Austin", () => {
  let R: Runtime;
  beforeAll(() => {
    R = loadHeadless("austin");
  });

  it("round-trips modified, removed and added measured features exactly", () => {
    const W = R.world;
    const lav = W.all("street").filter((s) => s.name === "Lavaca Street");
    const r1 = editStreetSections(W, { streetIds: lav.map((s) => s.id), edits: [{ op: "add_lanes", count: 1, dir: "both" }], policy: "trim" }, A);
    R.scenarios.commit(r1.changeset!);
    const site = W.all("parcel").filter((p) => (p.landUse === "vacant" || p.landUse === "parking") && p.zoningBase === "CBD").sort((a, b) => b.area - a.area)[0] as Parcel;
    R.scenarios.commit(createBuilding(W, { site: site.poly, spec: { typology: "tower_podium", floors: 30, use: "mixed" }, name: "Test Tower", demolishConflicts: true }, A).changeset!);
    const want = W.cloneEntities();
    const f = proposalJSON(R);
    const p = f.proposals[0];
    expect(p.summary.modified).toBeGreaterThan(0);
    expect(p.summary.removed + p.summary.added).toBeGreaterThan(0);
    const mod = p.changes.features.find((x) => x.properties.action === "modified" && x.properties.kind === "street")!;
    expect(mod.properties.changed).toContain("section");
    const text = JSON.stringify(f);

    // a later session: the same measured city with no edits
    const made = R.scenarios.activeId;
    R.scenarios.switchTo("baseline");
    R.scenarios.remove(made);
    const res = importProposalJSON(R, text);
    expect(R.scenarios.activeId).toBe(res.scenarios[0]);
    expectSameWorld(want, W.cloneEntities());

    // a file for the blank canvas is refused here
    expect(() => importProposalJSON(R, JSON.stringify({ ...f, city: { ...f.city, id: "sandbox", name: "Blank canvas" } }))).toThrow(/made for Blank canvas/);
    // as is one whose edits do not fit this city's data
    const broken = JSON.parse(text);
    broken.proposals[0].changesets[0].ops.find((o: { type: string }) => o.type === "update").before.id = "s:nope";
    expect(() => importProposalJSON(R, JSON.stringify(broken))).toThrow(/does not fit/);

    // CSV keeps what it can of the measured edits (the tower, the demolitions); sections are noted
    const csv = proposalCSV(R);
    R.scenarios.switchTo("baseline");
    const c = importProposalCSV(R, csv);
    expect(c.notes.join(" ")).toMatch(/cross-section/);
    const tower = W.all("building").find((b) => b.name === "Test Tower")!;
    expect(tower.height).toBeCloseTo((want.get(tower.id) as { height: number } | undefined)?.height ?? tower.height, 1);
    for (const [id] of R.scenarios.materialize("baseline")) if (!want.has(id)) expect(W.get(id), id).toBeUndefined();
  }, 120_000);
});
