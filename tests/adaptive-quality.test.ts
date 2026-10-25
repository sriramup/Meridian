import { describe, expect, it } from "vitest";
import { qualityGovernor } from "@/render/adaptiveQuality";

/** feed `n` moving frames of `dt` ms, starting at `t0` */
function feed(g: ReturnType<typeof qualityGovernor>, n: number, dt: number, t0 = 0) {
  let t = t0;
  for (let i = 0; i < n; i++) g.sample(dt, (t += dt));
  return t;
}

describe("adaptive 3D pixel density", () => {
  it("never touches a machine that keeps up", () => {
    const applied: number[] = [];
    const g = qualityGovernor(2, (r) => applied.push(r));
    feed(g, 2000, 16.7);
    expect(applied).toEqual([]);
    expect(g.level).toBe(2);
  });

  it("ignores one-off hitches (judged by the median)", () => {
    const applied: number[] = [];
    const g = qualityGovernor(2, (r) => applied.push(r));
    let t = 0;
    for (let i = 0; i < 600; i++) g.sample(i % 10 === 0 ? 120 : 16, (t += 16));
    expect(applied).toEqual([]);
  });

  it("ignores long gaps from a paused or hidden tab", () => {
    const applied: number[] = [];
    const g = qualityGovernor(2, (r) => applied.push(r));
    feed(g, 600, 1000);
    expect(applied).toEqual([]);
  });

  it("steps down one notch at a time on sustained slow motion, to a floor of 1.25", () => {
    const applied: number[] = [];
    const g = qualityGovernor(2, (r) => applied.push(r));
    let t = feed(g, 120, 40);
    expect(applied).toEqual([1.5]);
    // still slow, but within the cooldown: no second step yet
    t = feed(g, 60, 40, t);
    expect(applied).toEqual([1.5]);
    t = feed(g, 400, 40, t);
    expect(applied).toEqual([1.5, 1.25]);
    feed(g, 2000, 40, t);
    expect(applied).toEqual([1.5, 1.25]);
    expect(g.level).toBe(1.25);
  });

  it("does nothing on a 1x screen or when turned off", () => {
    const a: number[] = [];
    feed(qualityGovernor(1, (r) => a.push(r)), 2000, 50);
    feed(qualityGovernor(2, (r) => a.push(r), false), 2000, 50);
    expect(a).toEqual([]);
  });
});
