// The detailed study area sits inside a ring of surrounding "context" city that ends on a square.
// Everything (context buildings, roads, ground and every analysis raster) fades out over one wide
// circle around the study area, so the city thins out gradually instead of stopping on an edge.

import type { Position } from "@deck.gl/core";

type Bounds = readonly number[];

/**
 * Fully visible within R0 of the study centre, gone by R1 (m). Both scale with the study area:
 * for Austin's 4.0 × 4.3 km pack they are 2,960 and 3,760 m, just inside the context data's square.
 */
export function fadeRadii(b: Bounds): { r0: number; r1: number } {
  const half = Math.max(b[2] - b[0], b[3] - b[1]) / 2;
  const r0 = half + 800;
  return { r0, r1: r0 + 800 * (half / 2162) };
}

/** 1 near the centre, easing to 0 over a wide circular band */
export function cityFade(b: Bounds, x: number, y: number): number {
  const { r0: R0, r1: R1 } = fadeRadii(b);
  const d = Math.hypot(x - (b[0] + b[2]) / 2, y - (b[1] + b[3]) / 2);
  if (d <= R0) return 1;
  if (d >= R1) return 0;
  const t = 1 - (d - R0) / (R1 - R0);
  return t * t * (3 - 2 * t);
}

/** the surrounding city itself (buildings, roads, parks) stays intact until the last ~320 m, then shrinks away */
export function edgeShrink(b: Bounds, x: number, y: number): number {
  const { r1: R1 } = fadeRadii(b);
  const d = Math.hypot(x - (b[0] + b[2]) / 2, y - (b[1] + b[3]) / 2);
  const a = R1 - 320 * ((R1 - fadeRadii(b).r0) / 800);
  if (d <= a) return 1;
  if (d >= R1) return 0;
  const t = 1 - (d - a) / (R1 - a);
  return t * t * (3 - 2 * t);
}

/** how far the camera may go (m from the study centre): to where the city starts to fade, so the faded rim stays at the edge of view */
export const cityRadius = (b: Bounds) => fadeRadii(b).r0;

const inside = (b: Bounds, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
/** study-area rasters: their own cells, faded with the city */
export const studyFade = (b: Bounds, x: number, y: number) => (inside(b, x, y) ? cityFade(b, x, y) : 0);
/** surrounding-city rasters: only outside the study area (inside it the detailed model shows) */
export const ringFade = (b: Bounds, x: number, y: number) => (inside(b, x, y) ? 0 : cityFade(b, x, y));

/** ground under the city: a disc, then annuli stepping its alpha down to transparent */
export function fadedGround(b: Bounds, steps = 24, seg = 160): { polygon: Position[][]; alpha: number }[] {
  const { r0: R0, r1: R1 } = fadeRadii(b);
  const cx = (b[0] + b[2]) / 2,
    cy = (b[1] + b[3]) / 2;
  const ring = (r: number): Position[] => Array.from({ length: seg + 1 }, (_, k) => [cx + r * Math.cos((k / seg) * 2 * Math.PI), cy + r * Math.sin((k / seg) * 2 * Math.PI)]);
  const out: { polygon: Position[][]; alpha: number }[] = [{ polygon: [ring(R0)], alpha: 1 }];
  for (let s = 0; s < steps; s++) {
    const a = R0 + ((R1 - R0) * s) / steps,
      c = R0 + ((R1 - R0) * (s + 1)) / steps;
    out.push({ polygon: [ring(c), ring(a).reverse()], alpha: cityFade(b, cx + (a + c) / 2, cy) });
  }
  return out;
}

const masks = new Map<string, Float32Array>();
/** per-cell value of a fade function over a raster grid (row-major from y0 upward), cached */
export function gridMask(name: string, b: Bounds, g: { x0: number; y0: number; cell: number; nx: number; ny: number }, f: (b: Bounds, x: number, y: number) => number): Float32Array {
  const key = `${name}:${b.join(",")}:${g.x0},${g.y0},${g.cell},${g.nx},${g.ny}`;
  const hit = masks.get(key);
  if (hit) return hit;
  const m = new Float32Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) m[j * g.nx + i] = f(b, g.x0 + (i + 0.5) * g.cell, g.y0 + (j + 0.5) * g.cell);
  masks.set(key, m);
  return m;
}
