import { describe, expect, it } from "vitest";
import { SolidInstances, detailTier, maxTierAt, shadingOf, writeInstance } from "@/render/solids";
import { SOLID_SHAPES, unitMesh } from "@/render/solidMeshes";
import type { Building, Prop, Solid } from "@/world/types";

const bench = (id: string, x: number, rot = 0): Prop => ({
  id,
  kind: "prop",
  type: "streetscape.bench",
  p: [x, 0],
  rot,
  height: 0.9,
  source: "test",
  provenance: "proposed",
  solids: [
    { shape: "box", at: [0, 0, 0.42], size: [1.8, 0.45, 0.06], color: [150, 110, 70], material: "wood" },
    { shape: "box", at: [-0.8, 0, 0], size: [0.06, 0.45, 0.42], color: [60, 60, 60], material: "metal" },
    { shape: "box", at: [0.8, 0, 0], size: [0.06, 0.45, 0.42], color: [60, 60, 60], material: "metal" },
  ],
});
const lamp = (id: string): Prop => ({
  id,
  kind: "prop",
  type: "streetscape.lamp",
  p: [10, 10],
  rot: 0,
  height: 6,
  source: "test",
  provenance: "proposed",
  solids: [
    { shape: "cylinder", at: [0, 0, 0], size: [0.15, 0.15, 6], color: [50, 50, 50], material: "metal" },
    { shape: "sphere", at: [0, 0, 5.8], size: [0.4, 0.4, 0.4], color: [255, 240, 200], material: "light" },
  ],
});

describe("solid instances", () => {
  it("places a solid in its owner's frame", () => {
    const out = new Float32Array(12);
    const s: Solid = { shape: "box", at: [2, 0, 1], size: [2, 1, 3], color: [0, 0, 0] };
    writeInstance(out, 0, s, 100, 50, 90);
    // 90° ccw: local +x points north
    expect(out[0]).toBeCloseTo(100);
    expect(out[1]).toBeCloseTo(52);
    expect(out[2]).toBeCloseTo(1);
    // first column = image of the x axis scaled by size x → (0, 2, 0)
    expect(out[3]).toBeCloseTo(0);
    expect(out[4]).toBeCloseTo(2);
    expect(out[11]).toBeCloseTo(3);
  });

  it("applies tilt as pitch about x", () => {
    const out = new Float32Array(12);
    writeInstance(out, 0, { shape: "box", at: [0, 0, 0], size: [1, 1, 1], tilt: [90, 0], color: [0, 0, 0] }, 0, 0, 0);
    // z axis pitched 90° about x → points to -y
    expect(out[9]).toBeCloseTo(0);
    expect(out[10]).toBeCloseTo(-1);
    expect(out[11]).toBeCloseTo(0);
  });

  it("groups by shape and shading and rebuilds only changed entities", () => {
    const c = new SolidInstances();
    const a = bench("prop:a", 0);
    const b = bench("prop:b", 5);
    const l = lamp("prop:l");
    c.update([a, b, l]);
    expect(c.lastRebuilt).toBe(3);
    const keys = c.layers().map((p) => p.key);
    expect(keys).toEqual(["box:gloss:2", "box:matte:2", "cylinder:gloss:2", "sphere:light:2"]);
    expect(c.count).toBe(8);
    const boxMetal = c.layers().find((p) => p.key === "box:gloss:2")!;
    expect(boxMetal.owners.filter((o) => o === "prop:a").length).toBe(2);
    expect(boxMetal.matrices.length).toBe(boxMetal.n * 12);
    // nothing changed: no rebuild, same arrays
    const v = boxMetal.version;
    expect(c.update([a, b, l])).toBe(false);
    expect(c.lastRebuilt).toBe(0);
    expect(c.layers().find((p) => p.key === "box:gloss:2")!.version).toBe(v);
    // move one bench: only it is recomputed; the lamp's layers are untouched
    const lampLayer = c.layers().find((p) => p.key === "sphere:light:2")!;
    const a2 = { ...a, p: [1, 1] as [number, number] };
    expect(c.update([a2, b, l])).toBe(true);
    expect(c.lastRebuilt).toBe(1);
    expect(c.layers().find((p) => p.key === "sphere:light:2")).toBe(lampLayer);
    // remove
    c.update([b, l]);
    expect(c.entityCount).toBe(2);
    expect(c.count).toBe(5);
  });

  it("culls small props when far and keeps building solids", () => {
    const roof: Building = {
      id: "bld:1", kind: "building", footprint: [[[0, 0], [10, 0], [10, 10], [0, 10]]], masses: [], height: 6, floors: 2, use: "residential", program: {}, ground: 0,
      heightSource: "proposed", useSource: "proposed", source: "test",
      solids: [{ shape: "wedge", at: [5, 5, 6], size: [10, 10, 3], color: [120, 60, 50] }],
    };
    expect(detailTier(bench("x", 0))).toBe(2);
    expect(detailTier(lamp("y"))).toBe(1);
    expect(detailTier(roof)).toBe(0);
    const c = new SolidInstances();
    c.update([bench("prop:a", 0), lamp("prop:l"), roof], maxTierAt(16));
    expect(c.count).toBe(6);
    c.update([bench("prop:a", 0), lamp("prop:l"), roof], maxTierAt(13));
    expect(c.instancesOf("prop:a")).toBe(0);
    expect(c.instancesOf("bld:1")).toBe(1);
  });

  it("maps materials to shading", () => {
    expect(shadingOf("foliage")).toBe("matte");
    expect(shadingOf("glass")).toBe("gloss");
    expect(shadingOf("light")).toBe("light");
    expect(shadingOf(undefined)).toBe("matte");
  });

  it("unit meshes fill the unit box with unit normals", () => {
    for (const s of SOLID_SHAPES) {
      const m = unitMesh(s);
      const P = m.attributes.POSITION.value, N = m.attributes.NORMAL.value;
      let minZ = Infinity, maxZ = -Infinity, maxXY = 0;
      for (let i = 0; i < P.length; i += 3) {
        minZ = Math.min(minZ, P[i + 2]);
        maxZ = Math.max(maxZ, P[i + 2]);
        maxXY = Math.max(maxXY, Math.abs(P[i]), Math.abs(P[i + 1]));
        expect(Math.hypot(N[i], N[i + 1], N[i + 2])).toBeCloseTo(1, 4);
      }
      expect(minZ, s).toBeCloseTo(0, 5);
      expect(maxZ, s).toBeCloseTo(1, 5);
      expect(maxXY, s).toBeCloseTo(0.5, 5);
      for (const i of m.indices.value) expect(i).toBeLessThan(P.length / 3);
    }
  });

  it("re-packs 10k props incrementally", () => {
    // behaviour, not wall-clock: a one-entity edit recomputes one entity and keeps untouched layers
    const props = Array.from({ length: 10000 }, (_, i) => bench(`prop:${i}`, i % 100, i));
    const c = new SolidInstances();
    c.update(props);
    expect(c.lastRebuilt).toBe(10000);
    expect(c.count).toBe(30000);
    const before = c.layers();
    c.update(props);
    expect(c.lastRebuilt).toBe(0);
    expect(c.layers()).toEqual(before);
    props[5] = { ...props[5], rot: 33 };
    c.update(props);
    expect(c.lastRebuilt).toBe(1);
    expect(c.count).toBe(30000);
  });

});

describe("mesh detail", () => {
  it("drops small parts and uses coarser meshes when far", () => {
    const c = new SolidInstances();
    const lampProp: Prop = { id: "prop:l", kind: "prop", type: "lamp", p: [0, 0], rot: 0, height: 9, source: "t", provenance: "proposed", solids: [
      { shape: "cylinder", at: [0, 0, 0], size: [0.2, 0.2, 9], color: [1, 1, 1] },
      { shape: "sphere", at: [0, 0, 9], size: [0.1, 0.1, 0.1], color: [1, 1, 1] },
    ] };
    c.update([lampProp], 2, 2);
    expect(c.count).toBe(2);
    c.update([lampProp], 2, 1);
    expect(c.count).toBe(1);
    expect(c.layers()[0].lod).toBe(1);
    expect(unitMesh("sphere", 0).attributes.POSITION.value.length).toBeLessThan(unitMesh("sphere", 2).attributes.POSITION.value.length / 2);
  });
});

describe("far detail caps", () => {
  it("keeps a prop's largest parts when far", () => {
    const c = new SolidInstances();
    const solids = Array.from({ length: 10 }, (_, i) => ({ shape: "sphere" as const, at: [i, 0, 3] as [number, number, number], size: [1 + i, 1 + i, 1 + i] as [number, number, number], color: [1, 1, 1] as [number, number, number] }));
    const crown: Prop = { id: "prop:t", kind: "prop", type: "tree", p: [0, 0], rot: 0, height: 12, source: "t", provenance: "proposed", solids };
    c.update([crown], 2, 2);
    expect(c.count).toBe(10);
    c.update([crown], 2, 0);
    expect(c.count).toBe(3);
    // the three largest survive
    const xs = Array.from(c.layers()[0].positions.filter((_, i) => i % 3 === 0)).sort();
    expect(xs).toEqual([7, 8, 9]);
  });
});

describe("cells", () => {
  it("draws each cell by its own state: hidden, coarse or full", () => {
    const c = new SolidInstances();
    const near = bench("prop:near", 10);
    const far = { ...lamp("prop:far"), p: [1000, 1000] as [number, number] };
    const off = { ...lamp("prop:off"), p: [-2000, 0] as [number, number] };
    c.update([near, far, off], (key) => (key === "0:0" ? { visible: true, lod: 2, maxTier: 2 } : key.startsWith("-") ? { visible: false, lod: 0, maxTier: 0 } : { visible: true, lod: 0, maxTier: 1 }));
    expect(c.instancesOf("prop:near")).toBe(3);
    expect(c.instancesOf("prop:off")).toBe(0);
    // the far lamp: coarse meshes, the tiny lamp head (0.4 m) dropped
    expect(c.instancesOf("prop:far")).toBe(1);
    expect(c.layers().some((p) => p.key === "cylinder:gloss:0")).toBe(true);
    expect(c.cells().map((b) => b.key).sort()).toEqual(["-7:0", "0:0", "3:3"]);
    // a view change that alters nothing re-packs nothing
    const v = c.layers().map((p) => p.version);
    expect(c.setView((key) => (key === "0:0" ? { visible: true, lod: 2, maxTier: 2 } : key.startsWith("-") ? { visible: false, lod: 0, maxTier: 0 } : { visible: true, lod: 0, maxTier: 1 }))).toBe(false);
    expect(c.layers().map((p) => p.version)).toEqual(v);
  });
});
