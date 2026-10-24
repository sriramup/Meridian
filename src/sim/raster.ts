import type { Ring, Vec2 } from "@/world/types";

export interface GridSpec {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
}

/**
 * Scanline-fill polygon rings (even-odd, so holes subtract) into a grid,
 * sampling cell centres. `set(idx)` is called once per covered cell.
 */
export function rasterizeRings(g: GridSpec, rings: Ring[], set: (idx: number) => void) {
  let ymin = Infinity,
    ymax = -Infinity;
  for (const r of rings)
    for (const p of r) {
      if (p[1] < ymin) ymin = p[1];
      if (p[1] > ymax) ymax = p[1];
    }
  const j0 = Math.max(0, Math.ceil((ymin - g.y0) / g.cell - 0.5));
  const j1 = Math.min(g.ny - 1, Math.floor((ymax - g.y0) / g.cell - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = g.y0 + (j + 0.5) * g.cell;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length;
      for (let i = 0, k = n - 1; i < n; k = i++) {
        const a = r[k],
          b = r[i];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = j * g.nx;
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xs[q] - g.x0) / g.cell - 0.5));
      const i1 = Math.min(g.nx - 1, Math.floor((xs[q + 1] - g.x0) / g.cell - 0.5));
      for (let i = i0; i <= i1; i++) set(row + i);
    }
  }
}

export function rasterizeDisc(g: GridSpec, c: Vec2, r: number, set: (idx: number, w: number) => void) {
  const i0 = Math.max(0, Math.floor((c[0] - r - g.x0) / g.cell));
  const i1 = Math.min(g.nx - 1, Math.floor((c[0] + r - g.x0) / g.cell));
  const j0 = Math.max(0, Math.floor((c[1] - r - g.y0) / g.cell));
  const j1 = Math.min(g.ny - 1, Math.floor((c[1] + r - g.y0) / g.cell));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const x = g.x0 + (i + 0.5) * g.cell - c[0];
      const y = g.y0 + (j + 0.5) * g.cell - c[1];
      const d = Math.hypot(x, y);
      if (d <= r) set(j * g.nx + i, 1 - d / (r + 1e-9));
    }
}

/** separable box blur (radius in cells) — used for neighbourhood fractions */
export function boxBlur(src: Float32Array, nx: number, ny: number, rad: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const w = 2 * rad + 1;
  for (let j = 0; j < ny; j++) {
    let s = 0;
    const row = j * nx;
    for (let i = -rad; i <= rad; i++) s += src[row + Math.min(nx - 1, Math.max(0, i))];
    for (let i = 0; i < nx; i++) {
      tmp[row + i] = s / w;
      s += src[row + Math.min(nx - 1, i + rad + 1)] - src[row + Math.max(0, i - rad)];
    }
  }
  for (let i = 0; i < nx; i++) {
    let s = 0;
    for (let j = -rad; j <= rad; j++) s += tmp[Math.min(ny - 1, Math.max(0, j)) * nx + i];
    for (let j = 0; j < ny; j++) {
      out[j * nx + i] = s / w;
      s += tmp[Math.min(ny - 1, j + rad + 1) * nx + i] - tmp[Math.max(0, j - rad) * nx + i];
    }
  }
  return out;
}

export function sampleGrid(g: GridSpec, data: ArrayLike<number>, p: Vec2): number {
  const i = Math.floor((p[0] - g.x0) / g.cell);
  const j = Math.floor((p[1] - g.y0) / g.cell);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return NaN;
  return data[j * g.nx + i];
}
