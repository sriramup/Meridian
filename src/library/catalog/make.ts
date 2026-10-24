// Entity factories shared by every definition: ids from ctx.id, LibraryRef stamping (primary on
// the instance's main entity), provenance, prop footprints from solids. Composites collect
// entities from child generators through `Out` and mark exactly one as primary.

import { circle, normalizePoly, polyArea } from "@/geometry/polygon";
import type { Area, AreaType, Building, BuildingStyle, Mass, Path, Polygon, Prop, Solid, Tree, Use, Vec2 } from "@/world/types";
import type { GenerateContext, Generated } from "../types";
import { type Frame, headingDeg, toWorld } from "../geometry/frame";
import { solidsBounds, solidsHeight } from "../geometry/solids";

export const SOURCE = "Meridian library";

const stamp = (ctx: GenerateContext, primary: boolean) => ({ ...ctx.ref, primary: primary || undefined });

export class Out {
  buildings: Building[] = [];
  props: Prop[] = [];
  trees: Tree[] = [];
  areas: Area[] = [];
  paths: Path[] = [];
  streets: NonNullable<Generated["streets"]> = [];
  summary: string[] = [];
  warnings: string[] = [];
  private primarySet = false;
  constructor(readonly ctx: GenerateContext) {}

  /** whether the next entity should be primary (first claimed wins) */
  private claim(want: boolean) {
    if (want && !this.primarySet) {
      this.primarySet = true;
      return true;
    }
    return false;
  }

  building(b: Omit<Building, "id" | "kind" | "lib" | "source" | "heightSource" | "useSource" | "ground"> & { ground?: number }, primary = true): Building {
    const e: Building = { id: this.ctx.id("b"), kind: "building", ground: 0, heightSource: "proposed", useSource: "proposed", source: SOURCE, ...b, lib: stamp(this.ctx, this.claim(primary)) };
    this.buildings.push(e);
    return e;
  }

  /** a prop at a frame (its origin and heading), solids in the prop frame */
  prop(type: string, f: Frame, solids: Solid[], o: { name?: string; shade?: { r: number; h: number }; primary?: boolean; height?: number } = {}): Prop {
    const [x0, y0, x1, y1] = solidsBounds(solids);
    const fp: Polygon = normalizePoly([[toWorld(f, [x0, y0]), toWorld(f, [x1, y0]), toWorld(f, [x1, y1]), toWorld(f, [x0, y1])]]);
    const e: Prop = {
      id: this.ctx.id("pr"),
      kind: "prop",
      type,
      p: [f.c[0], f.c[1]],
      rot: headingDeg(f),
      solids,
      height: o.height ?? Math.max(0.05, solidsHeight(solids)),
      footprint: polyArea(fp) > 1e-4 ? fp : undefined,
      source: SOURCE,
      provenance: "proposed",
      lib: stamp(this.ctx, this.claim(o.primary ?? true)),
    };
    if (o.name) e.name = o.name;
    if (o.shade && o.shade.r > 0 && o.shade.h > 0) e.shade = o.shade;
    this.props.push(e);
    return e;
  }

  tree(p: Vec2, r: number, h: number, species?: string, primary = true): Tree {
    const e: Tree = { id: this.ctx.id("t"), kind: "tree", p, r: Math.max(0.3, r), h: Math.max(0.5, h), source: SOURCE, provenance: "proposed", lib: stamp(this.ctx, this.claim(primary)) };
    if (species) e.species = species;
    this.trees.push(e);
    return e;
  }

  area(type: AreaType, poly: Polygon, o: { name?: string; depth?: number; primary?: boolean } = {}): Area | null {
    const q = normalizePoly(poly);
    if (!q.length || q[0].length < 3 || polyArea(q) < 0.25) return null;
    const e: Area = { id: this.ctx.id("a"), kind: "area", type, poly: q, source: SOURCE, provenance: "proposed", lib: stamp(this.ctx, this.claim(o.primary ?? true)) };
    if (o.name) e.name = o.name;
    if (o.depth !== undefined) e.depth = o.depth;
    this.areas.push(e);
    return e;
  }

  path(path: Vec2[], type: Path["type"], o: { name?: string; primary?: boolean } = {}): Path | null {
    if (path.length < 2) return null;
    const e: Path = { id: this.ctx.id("p"), kind: "path", path, type, source: SOURCE, lib: stamp(this.ctx, this.claim(o.primary ?? true)) };
    if (o.name) e.name = o.name;
    this.paths.push(e);
    return e;
  }

  done(): Generated {
    // guarantee one primary: promote the first entity when nobody claimed it
    if (!this.primarySet) {
      const first = this.buildings[0] ?? this.areas[0] ?? this.props[0] ?? this.trees[0] ?? this.paths[0];
      if (first?.lib) first.lib.primary = true;
    }
    const g: Generated = {};
    if (this.buildings.length) g.buildings = this.buildings;
    if (this.props.length) g.props = this.props;
    if (this.trees.length) g.trees = this.trees;
    if (this.areas.length) g.areas = this.areas;
    if (this.paths.length) g.paths = this.paths;
    if (this.streets.length) g.streets = this.streets;
    if (this.summary.length) g.summary = this.summary;
    if (this.warnings.length) g.warnings = this.warnings;
    return g;
  }
}

export const discPoly = (c: Vec2, r: number, n = 24): Polygon => [circle(c, Math.max(0.2, r), n)];

export type { Building, BuildingStyle, Mass, Use };
