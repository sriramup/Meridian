import { describe, expect, it } from "vitest";
import { buildSection } from "@/geometry/crossSection";
import { alongStreet, blockedAt, chevronAt, chevronDirs, chevronLayout, firstWall, groundAt, hopTarget, jumpTarget, nearestSidewalk, sightAt, snapWalkable, CLEAR, EYE, type WalkEnv, type WalkStreet } from "@/components/pedestrian/walk";
import type { Polygon, Vec2 } from "@/world/types";

const section = buildSection({ cls: "residential", oneway: false, sidewalkLeft: true, sidewalkRight: true });
const st = (id: string, from: string, to: string, path: Vec2[]): WalkStreet => ({ id, from, to, path, section });
const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];

/** a + junction at the origin: streets north, south, east and west; a 20 m building in the NE block, a pond in the SW one */
function env(): WalkEnv {
  const streets = [st("n", "o", "N", [[0, 0], [0, 150]]), st("s", "S", "o", [[0, -150], [0, 0]]), st("e", "o", "E", [[0, 0], [150, 0]]), st("w", "W", "o", [[-150, 0], [0, 0]])];
  const buildings = [{ poly: rect(14, 14, 90, 90), height: 20 }];
  const water = [rect(-90, -90, -14, -14)];
  return {
    buildings: () => buildings,
    water: () => water,
    streets: () => streets,
    incident: (n) => streets.filter((s) => s.from === n || s.to === n),
  };
}

describe("street view: walkable ground", () => {
  it("buildings and water block; streets and sidewalks don't", () => {
    const E = env();
    expect(blockedAt(E, [50, 50])?.kind).toBe("building");
    expect(blockedAt(E, [13.5, 50])?.kind).toBe("building"); // brushing the wall
    expect(blockedAt(E, [-50, -50])?.kind).toBe("water");
    expect(blockedAt(E, [0, 50])).toBeNull();
    expect(blockedAt(E, [8, 50])).toBeNull();
  });
  it("snaps a spot inside a building out to just in front of its nearest wall", () => {
    const q = snapWalkable(env(), [16, 50])!;
    expect(q[0]).toBeCloseTo(14 - CLEAR - 0.05, 1);
    expect(q[1]).toBeCloseTo(50, 1);
    expect(blockedAt(env(), q)).toBeNull();
  });
  it("snaps out of water onto the shore", () => {
    const q = snapWalkable(env(), [-50, -16])!;
    expect(blockedAt(env(), q)).toBeNull();
    expect(q[1]).toBeGreaterThan(-14);
  });
  it("steps down onto the nearest sidewalk, not the carriageway", () => {
    // the test street's sidewalks run 3–6 m either side of the centreline
    const q = nearestSidewalk(env(), [1, 40])!;
    expect(q[0]).toBeCloseTo(4.5);
    expect(q[1]).toBeCloseTo(40, 0);
    // at a junction: onto a sidewalk beside the junction, not into its middle
    const j = nearestSidewalk(env(), [0.5, 2])!;
    expect(Math.max(Math.abs(j[0]), Math.abs(j[1]))).toBeGreaterThan(6);
  });
});

describe("street view: moving", () => {
  it("a near click walks straight there", () => {
    const h = hopTarget(env(), [8, 30], [6, 45])!;
    expect(h.via).toBe("direct");
    expect(h.target[0]).toBeCloseTo(6);
    expect(h.target[1]).toBeCloseTo(45);
  });
  it("a click on a facade walks up to the facade and stops short of the wall", () => {
    const wall = firstWall(env(), [-8, 50], [40, 50])!;
    expect(wall.p[0]).toBeCloseTo(14);
    expect(wall.normal[0]).toBeCloseTo(-1);
    const h = hopTarget(env(), [-8, 50], [40, 50])!;
    expect(h.target[0]).toBeLessThanOrEqual(14 - CLEAR);
    expect(h.target[0]).toBeGreaterThan(11);
    expect(blockedAt(env(), h.target)).toBeNull();
  });
  it("a far click along the street moves one bounded hop along it, on the same side", () => {
    const h = hopTarget(env(), [-8, 30], [-6, 140], 30)!;
    expect(h.via).toBe("street");
    expect(h.target[0]).toBeCloseTo(-8, 0);
    expect(h.target[1]).toBeCloseTo(60, 0);
  });
  it("never ends inside or against a building", () => {
    for (const g of [[30, 30], [60, 20], [20, 80], [15, 15]] as Vec2[]) {
      const h = hopTarget(env(), [8, 8], g);
      if (h) expect(blockedAt(env(), h.target)).toBeNull();
    }
  });
  it("a chevron step carries on across a junction into the street ahead, on the same side", () => {
    // on the north street's west sidewalk, 6 m short of the junction (the cross street is as close)
    const t = alongStreet(env(), [-4.5, 6], [0, -1], 20)!;
    expect(t[0]).toBeCloseTo(-4.5, 0);
    expect(t[1]).toBeCloseTo(-14, 0);
  });
  it("a double-click jumps however far, but not through a wall", () => {
    const t = jumpTarget(env(), [-8, 30], [-8, 140])!;
    expect(t[1]).toBeCloseTo(140);
    const w = jumpTarget(env(), [-8, 50], [80, 50])!;
    expect(w[0]).toBeLessThan(14);
  });
});

describe("street view: chevrons and the view", () => {
  it("chevrons point both ways along the street, and down the side streets near a junction", () => {
    const mid = chevronDirs(env(), [-8, 60]);
    expect(mid).toHaveLength(2);
    expect(mid.map((d) => Math.round(d[1])).sort()).toEqual([-1, 1]);
    expect(chevronDirs(env(), [-8, 8])).toHaveLength(4);
    expect(chevronDirs(env(), [300, 300])).toHaveLength(0);
  });
  it("chevrons sit just ahead of the eye and can be hit-tested", () => {
    const ch = chevronLayout([0, 0], 0, [[0, 1], [1, 0]]);
    expect(ch[0].at[1]).toBeGreaterThan(4);
    expect(chevronAt(ch, ch[1].at)).toBe(ch[1]);
    expect(chevronAt(ch, [0, -5])).toBeNull();
  });
  it("finds the ground under a pixel from eye height", () => {
    const v = { eye: [0, 0] as Vec2, bearing: 0, pitch: 80, fov: 60, width: 1000, height: 800 };
    const g = groundAt(v, 500, 400)!;
    expect(g.p[0]).toBeCloseTo(0);
    expect(g.p[1]).toBeCloseTo(EYE * Math.tan((80 * Math.PI) / 180));
    expect(groundAt(v, 500, 0)).toBeNull(); // above the horizon
  });
  it("finds a facade under the pointer above the horizon, and sky above the roof", () => {
    // standing west of the building, looking east at its wall 22 m away
    const v = { eye: [-8, 50] as Vec2, bearing: 90, pitch: 89, fov: 60, width: 1000, height: 800 };
    const s = sightAt(env(), v, 500, 300)!;
    expect(s.kind).toBe("wall");
    expect(s.p[0]).toBeCloseTo(14);
    if (s.kind === "wall") expect(s.z).toBeGreaterThan(EYE);
    if (s.kind === "wall") expect(s.z).toBeLessThan(20);
    const low = { ...env(), buildings: () => [{ poly: rect(14, 14, 90, 90), height: 6 }] };
    expect(sightAt(low, v, 500, 2)).toBeNull(); // over the 6 m roof: sky
    expect(sightAt(env(), v, 500, 700)?.kind).toBe("ground");
  });
});
