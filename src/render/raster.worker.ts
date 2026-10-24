/// <reference lib="webworker" />
// Builds overlay raster images off the main thread: quantised values → RGBA through a 256-entry
// lookup table, faded with the city edge, returned as a transferable ImageBitmap.

import { gridMask, ringFade, studyFade } from "./edge";

export interface RasterJob {
  key: string;
  grid: { x0: number; y0: number; cell: number; nx: number; ny: number };
  bounds: number[];
  edge: "study" | "ring";
  values: Uint8Array;
  lut: Uint8ClampedArray;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const FADES = { study: studyFade, ring: ringFade };

ctx.onmessage = async (ev: MessageEvent<RasterJob>) => {
  const { key, grid, bounds, edge, values, lut } = ev.data;
  try {
    const { nx, ny } = grid;
    const fade = gridMask(edge, bounds, grid, FADES[edge]);
    const img = new ImageData(nx, ny);
    const d = img.data;
    for (let j = 0; j < ny; j++) {
      const row = (ny - 1 - j) * nx;
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const f = fade[c];
        const q = values[c];
        if (!f || !q) continue;
        const o = (row + i) * 4,
          l = q * 4;
        d[o] = lut[l];
        d[o + 1] = lut[l + 1];
        d[o + 2] = lut[l + 2];
        d[o + 3] = lut[l + 3] * f;
      }
    }
    const bitmap = await createImageBitmap(img);
    ctx.postMessage({ key, bitmap }, [bitmap]);
  } catch (e) {
    ctx.postMessage({ key, error: (e as Error).message });
  }
};
