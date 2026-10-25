// Straightening a photographed sketch: a whiteboard or paper plan is rarely square to the camera
// (tilted, shot at an angle, the drawing itself rotated on the board), and a vision model reads
// coordinates off a slanted drawing badly. The first vision pass finds the four corners of the drawn
// map (src/sketch/vision.ts, stage "frame"); this module maps that quadrilateral onto an upright
// rectangle with a perspective transform (homography), so the second pass reads a straight drawing
// whose streets run along the image axes. Pure functions over RGBA buffers: the browser
// (src/sketch/image.ts) and the tests use the same code.

import type { Pt } from "./plan";

/** the drawn map's corners in normalised image coordinates, in reading order */
export interface FrameCorners {
  tl: Pt;
  tr: Pt;
  br: Pt;
  bl: Pt;
}

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** solve A x = b (n × n, partial pivoting); null when singular */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** the homography taking each src[i] to dst[i] (four point pairs); null when degenerate */
export function homography(src: Pt[], dst: Pt[]): Mat3 | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i],
      [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return h ? ([...h, 1] as Mat3) : null;
}

export function applyH(H: Mat3, p: Pt): Pt {
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
}

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const len = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Corners worth straightening to: a convex quadrilateral covering a fair part of the image. A frame
 * that is nearly the whole image and nearly square to it is not worth a resample (null: read as is).
 */
export function usableFrame(c: FrameCorners | null | undefined, imgW: number, imgH: number): FrameCorners | null {
  if (!c) return null;
  const q = [c.tl, c.tr, c.br, c.bl];
  if (q.some((p) => !p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null;
  const px = q.map((p) => [p[0] * imgW, p[1] * imgH] as Pt);
  const signs = px.map((p, i) => Math.sign(cross(p, px[(i + 1) % 4], px[(i + 2) % 4])));
  if (!signs.every((s) => s === signs[0] && s !== 0)) return null;
  let area = 0;
  for (let i = 0; i < 4; i++) area += px[i][0] * px[(i + 1) % 4][1] - px[(i + 1) % 4][0] * px[i][1];
  if (Math.abs(area) / 2 < imgW * imgH * 0.12) return null;
  // already square to the image and filling it: nothing to straighten
  const off = Math.max(...q.map((p, i) => len(p, ([[0, 0], [1, 0], [1, 1], [0, 1]] as Pt[])[i])));
  if (off < 0.04) return null;
  return c;
}

/** grow the frame by `m` of its size on every side (the corners are read a little tight) */
export function growFrame(c: FrameCorners, m = 0.025): FrameCorners {
  const cx = (c.tl[0] + c.tr[0] + c.br[0] + c.bl[0]) / 4,
    cy = (c.tl[1] + c.tr[1] + c.br[1] + c.bl[1]) / 4;
  const g = (p: Pt): Pt => [cx + (p[0] - cx) * (1 + 2 * m), cy + (p[1] - cy) * (1 + 2 * m)];
  return { tl: g(c.tl), tr: g(c.tr), br: g(c.br), bl: g(c.bl) };
}

/** the straightened size in pixels: the mean lengths of opposite sides, long edge `maxEdge` */
export function rectifiedSize(c: FrameCorners, imgW: number, imgH: number, maxEdge = 1400): { w: number; h: number } {
  const P = (p: Pt): Pt => [p[0] * imgW, p[1] * imgH];
  const w0 = (len(P(c.tl), P(c.tr)) + len(P(c.bl), P(c.br))) / 2,
    h0 = (len(P(c.tl), P(c.bl)) + len(P(c.tr), P(c.br))) / 2;
  const k = maxEdge / Math.max(w0, h0);
  return { w: Math.max(64, Math.round(w0 * k)), h: Math.max(64, Math.round(h0 * k)) };
}

export interface RGBA {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Resample the frame onto an upright w × h image (inverse mapping, bilinear). Pixels whose source
 * falls outside the photo are white (the board).
 */
export function warpFrame(src: RGBA, c: FrameCorners, w: number, h: number): RGBA {
  const H = homography(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    [c.tl, c.tr, c.br, c.bl].map((p) => [p[0] * src.width, p[1] * src.height] as Pt),
  );
  const out = new Uint8ClampedArray(w * h * 4);
  if (!H) return { data: out.fill(255), width: w, height: h };
  const { data, width: sw, height: sh } = src;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = applyH(H, [(x + 0.5) / w, (y + 0.5) / h]);
      const o = (y * w + x) * 4;
      const fx = sx - 0.5,
        fy = sy - 0.5;
      const x0 = Math.floor(fx),
        y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255;
        continue;
      }
      const ax = fx - x0,
        ay = fy - y0;
      const i00 = (y0 * sw + x0) * 4,
        i10 = i00 + 4,
        i01 = i00 + sw * 4,
        i11 = i01 + 4;
      for (let k = 0; k < 4; k++) out[o + k] = (data[i00 + k] * (1 - ax) + data[i10 + k] * ax) * (1 - ay) + (data[i01 + k] * (1 - ax) + data[i11 + k] * ax) * ay;
    }
  }
  return { data: out, width: w, height: h };
}

/** a straightened point (unit square of the frame) back to normalised image coordinates */
export function frameToImage(c: FrameCorners): ((p: Pt) => Pt) | null {
  const H = homography(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    [c.tl, c.tr, c.br, c.bl],
  );
  return H ? (p) => applyH(H, p) : null;
}
