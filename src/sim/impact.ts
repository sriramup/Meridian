// What the plan did to street heat, where. Every edited feature (a planted tree, a park or plaza,
// a building) is grouped with edits within ~50 m into one pin. The pin's value is the modelled
// change in surface temperature (plan − current city) on that group's own ground: under the tree crowns,
// inside the park, around the building. Only the hour shown on the map is compared.

import { create } from "zustand";
import { polyCentroid } from "@/geometry/polygon";
import type { Changeset, Op } from "@/world/world";
import type { Entity, Vec2 } from "@/world/types";
import { dqT } from "./heat";
import { rasterizeDisc, rasterizeRings, type GridSpec } from "./raster";

export interface ImpactPin {
  at: Vec2;
  /** mean change (°C, negative = cooler) on the group's footprint cells */
  deltaC: number;
  /** footprint area that was compared, m² */
  areaM2: number;
  features: number;
}

export interface PlanImpact {
  hour: number;
  pins: ImpactPin[];
}

export const useImpact = create<{ impact: PlanImpact | null; set: (i: PlanImpact | null) => void }>((set) => ({ impact: null, set: (impact) => set({ impact }) }));

interface HeatLike {
  hours: number[];
  surface: Uint8Array[];
}

/** the ground an edited feature acts on */
type Footprint = { at: Vec2; disc?: { c: Vec2; r: number }; rings?: number[][][]; halo?: number };

function footprint(e: Entity): Footprint | null {
  switch (e.kind) {
    case "tree":
      return { at: e.p, disc: { c: e.p, r: e.r } };
    case "area":
      return { at: polyCentroid(e.poly), rings: e.poly };
    case "building":
      // a building changes heat by its shadow and roof: compare the ground within 25 m of it
      return { at: polyCentroid(e.footprint), rings: e.footprint, halo: 25 };
    case "prop":
      // library objects act through their shade crown or ground cover
      return e.shade ? { at: e.p, disc: { c: e.p, r: e.shade.r } } : e.cover && e.footprint ? { at: e.p, rings: e.footprint } : null;
    default:
      return null;
  }
}

const added = (o: Op): Entity | null => (o.type === "add" ? o.entity : o.type === "update" ? o.after : null);

/** the modelled hour nearest `hour` (impacts are read at modelled hours, not between them) */
export function nearestModelHour(hours: number[], hour: number): number {
  let best = 0;
  for (let i = 1; i < hours.length; i++) if (Math.abs(hours[i] - hour) < Math.abs(hours[best] - hour)) best = i;
  return hours[best];
}

/** grouped ground cells the plan's features act on: geometry only, the same at every hour */
interface ImpactGroup {
  at: Vec2;
  cells: Int32Array;
  features: number;
}

let groupCache: { key: string; groups: ImpactGroup[] } | null = null;

function impactGroups(g: GridSpec, changesets: Changeset[]): ImpactGroup[] {
  // changesets are immutable once committed: their ids name the geometry
  const key = `${g.cell}|${g.x0}|${g.y0}|${g.nx}|${g.ny}|${changesets.map((c) => c.id).join(",")}`;
  if (groupCache?.key === key) return groupCache.groups;
  // features the plan adds or reshapes (net of later edits to the same id)
  const feats = new Map<string, Footprint>();
  for (const cs of changesets)
    for (const o of cs.ops) {
      const e = added(o);
      if (o.type === "remove") feats.delete(o.entity.id);
      else if (e) {
        const f = footprint(e);
        if (f) feats.set(e.id, f);
        else feats.delete(e.id);
      }
    }
  // greedy grouping: each feature joins the first group whose anchor is within 50 m
  const raw: { at: Vec2; sx: number; sy: number; fs: Footprint[] }[] = [];
  for (const f of feats.values()) {
    const grp = raw.find((q) => Math.hypot(q.at[0] - f.at[0], q.at[1] - f.at[1]) < 50);
    if (grp) {
      grp.fs.push(f);
      grp.sx += f.at[0];
      grp.sy += f.at[1];
      grp.at = [grp.sx / grp.fs.length, grp.sy / grp.fs.length];
    } else raw.push({ at: f.at, sx: f.at[0], sy: f.at[1], fs: [f] });
  }
  const groups: ImpactGroup[] = [];
  for (const grp of raw) {
    // a building's own footprint is roof, not the ground around it
    const skip = new Set<number>();
    for (const f of grp.fs) if (f.rings && f.halo) rasterizeRings(g, f.rings as [number, number][][], (i) => skip.add(i));
    const seen = new Set<number>();
    const take = (i: number) => {
      if (!skip.has(i)) seen.add(i);
    };
    for (const f of grp.fs) {
      if (f.disc) rasterizeDisc(g, f.disc.c, f.disc.r, take);
      if (f.rings) {
        if (f.halo) {
          // the ground near the building (its shadow and surroundings)
          const [x0, y0, x1, y1] = bbox(f.rings[0]);
          rasterizeRings(g, [[[x0 - f.halo, y0 - f.halo], [x1 + f.halo, y0 - f.halo], [x1 + f.halo, y1 + f.halo], [x0 - f.halo, y1 + f.halo]]], take);
        } else rasterizeRings(g, f.rings as [number, number][][], take);
      }
    }
    if (seen.size) groups.push({ at: grp.at, cells: Int32Array.from(seen), features: grp.fs.length });
  }
  groupCache = { key, groups };
  return groups;
}

export function planImpact(base: HeatLike, cur: HeatLike, hour: number, g: GridSpec, changesets: Changeset[]): PlanImpact | null {
  const mh = nearestModelHour(base.hours, hour);
  const ia = base.hours.indexOf(mh);
  const ib = cur.hours.indexOf(mh);
  if (ib < 0) return null;
  const ea = base.surface[ia],
    eb = cur.surface[ib];
  const pins: ImpactPin[] = [];
  const cellA = g.cell * g.cell;
  for (const grp of impactGroups(g, changesets)) {
    let sum = 0,
      n = 0;
    for (const i of grp.cells) {
      if (!ea[i] || !eb[i]) continue;
      sum += dqT(eb[i]) - dqT(ea[i]);
      n++;
    }
    if (n) pins.push({ at: grp.at, deltaC: sum / n, areaM2: n * cellA, features: grp.features });
  }
  return { hour: mh, pins };
}

function bbox(r: number[][]): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of r) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
