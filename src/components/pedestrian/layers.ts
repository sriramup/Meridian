// What Street View draws on the scene: the ground cursor that follows the pointer (a disc lying on
// the ground, a panel on a facade, a struck-through disc where one can't stand) and the chevrons
// on the ground pointing along the street.

import { COORDINATE_SYSTEM, type Layer, type Position } from "@deck.gl/core";
import { PathLayer, PolygonLayer, SolidPolygonLayer } from "@deck.gl/layers";
import { create } from "zustand";
import type { Vec2 } from "@/world/types";
import type { Chevron } from "./walk";

export type GroundCursor =
  | { kind: "ground"; p: Vec2; r: number }
  | { kind: "facade"; p: Vec2; normal: Vec2; z: number; w: number }
  | { kind: "blocked"; p: Vec2; r: number };

interface StreetViewState {
  cursor: GroundCursor | null;
  chevrons: Chevron[];
  /** index of the chevron under the pointer */
  hot: number | null;
  set: (s: Partial<Pick<StreetViewState, "cursor" | "chevrons" | "hot">>) => void;
}

export const useStreetView = create<StreetViewState>((set) => ({
  cursor: null,
  chevrons: [],
  hot: null,
  set: (s) => set(s),
}));

type RGBA = [number, number, number, number];
const WHITE: RGBA = [255, 255, 255, 235];
const SHADOW: RGBA = [40, 28, 16, 110];
const HOT: RGBA = [255, 206, 120, 250];
const NO: RGBA = [214, 76, 60, 230];
const FLAT = { depthWriteEnabled: false, depthCompare: "always" } as const;
const Z = 0.04;

const circle = (c: Vec2, r: number, n = 40): Position[] => Array.from({ length: n }, (_, i) => [c[0] + Math.cos((i / n) * Math.PI * 2) * r, c[1] + Math.sin((i / n) * Math.PI * 2) * r, Z]);

/** flat on the ground: the cursor disc and the chevrons */
export function groundLayers(origin: [number, number, number], cursor: GroundCursor | null, chevrons: Chevron[], hot: number | null): Layer[] {
  const common = { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: origin, parameters: FLAT };
  const out: Layer[] = [];
  if (chevrons.length)
    out.push(
      new PolygonLayer<{ ring: Position[]; hot: boolean }>({
        id: "sv-chevrons",
        ...common,
        data: chevrons.map((c, i) => ({ ring: c.ring.map((p) => [p[0], p[1], Z] as Position), hot: i === hot })),
        getPolygon: (d) => d.ring,
        getFillColor: (d) => (d.hot ? HOT : WHITE),
        getLineColor: SHADOW,
        getLineWidth: 1.5,
        lineWidthUnits: "pixels",
        lineJointRounded: true,
        stroked: true,
        filled: true,
        updateTriggers: { getFillColor: [hot] },
      }),
    );
  if (cursor && cursor.kind !== "facade") {
    const no = cursor.kind === "blocked";
    const r = cursor.r;
    out.push(
      new PolygonLayer<{ ring: Position[] }>({
        id: "sv-cursor",
        ...common,
        data: [{ ring: circle(cursor.p, r) }],
        getPolygon: (d) => d.ring,
        getFillColor: no ? [214, 76, 60, 70] : [255, 255, 255, 110],
        getLineColor: no ? NO : WHITE,
        getLineWidth: 2,
        lineWidthUnits: "pixels",
        stroked: true,
        filled: true,
      }),
    );
    // a soft shadow ring so the disc reads on pale paving
    out.push(
      new PathLayer<{ path: Position[] }>({
        id: "sv-cursor-shadow",
        ...common,
        data: [{ path: [...circle(cursor.p, r * 1.06), circle(cursor.p, r * 1.06)[0]] }],
        getPath: (d) => d.path,
        getColor: [40, 28, 16, 70],
        getWidth: 3,
        widthUnits: "pixels",
      }),
    );
    if (no) {
      const k = r * 0.62;
      out.push(
        new PathLayer<{ path: Position[] }>({
          id: "sv-cursor-no",
          ...common,
          data: [{ path: [[cursor.p[0] - k, cursor.p[1] - k, Z], [cursor.p[0] + k, cursor.p[1] + k, Z]] }],
          getPath: (d) => d.path,
          getColor: NO,
          getWidth: 2.5,
          widthUnits: "pixels",
          capRounded: true,
        }),
      );
    }
  }
  return out;
}

/** upright on a wall: the panel that says "walk up to this facade" */
export function facadeLayers(origin: [number, number, number], cursor: GroundCursor | null): Layer[] {
  if (!cursor || cursor.kind !== "facade") return [];
  const { p, normal: n, z, w } = cursor;
  const h = w * 0.66;
  const t: Vec2 = [-n[1], n[0]];
  const o = 0.08; // just in front of the wall
  const at = (s: number, dz: number): Position => [p[0] + n[0] * o + t[0] * s, p[1] + n[1] * o + t[1] * s, Math.max(0.05, z + dz)];
  const quad = [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)];
  const common = { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: origin, parameters: { depthCompare: "less-equal", depthWriteEnabled: false } as const };
  return [
    new SolidPolygonLayer<{ q: Position[] }>({
      id: "sv-facade",
      ...common,
      data: [{ q: quad }],
      getPolygon: (d) => d.q,
      getFillColor: [255, 255, 255, 90],
      _full3d: true,
      material: false,
    }),
    new PathLayer<{ q: Position[] }>({
      id: "sv-facade-edge",
      ...common,
      data: [{ q: [...quad, quad[0]] }],
      getPath: (d) => d.q,
      getColor: WHITE,
      getWidth: 2,
      widthUnits: "pixels",
      billboard: true,
    }),
  ];
}
