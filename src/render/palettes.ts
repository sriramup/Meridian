export type RGB = [number, number, number];

function lerpStops(stops: [number, RGB][], t: number): RGB {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    const [t0, c0] = stops[i - 1];
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
    }
  }
  return stops[stops.length - 1][1];
}

export interface Palette {
  id: string;
  stops: [number, RGB][];
}

/** heat ramp: cool blues through a pale midpoint to yellow and deep orange (no red) */
export const HEAT: Palette = {
  id: "heat",
  stops: [
    [0, [40, 78, 150]],
    [0.14, [70, 130, 196]],
    [0.27, [146, 194, 222]],
    [0.37, [238, 234, 204]],
    [0.47, [252, 220, 112]],
    [0.66, [249, 176, 58]],
    [0.84, [234, 128, 26]],
    [1, [196, 86, 12]],
  ],
};
/** level-of-service ramp for v/c */
export const LOS: Palette = {
  id: "los",
  stops: [
    [0, [26, 152, 80]],
    [0.6, [145, 207, 96]],
    [0.75, [254, 224, 139]],
    [0.9, [252, 141, 89]],
    [1.0, [215, 48, 39]],
    [1.2, [140, 20, 40]],
  ],
};
/** viridis */
export const VIRIDIS: Palette = {
  id: "viridis",
  stops: [
    [0, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.5, [33, 145, 140]],
    [0.75, [94, 201, 98]],
    [1, [253, 231, 37]],
  ],
};
/** viridis reversed: bright = short / good (walk and response times) */
export const VIRIDIS_R: Palette = { id: "viridis_r", stops: VIRIDIS.stops.map(([t, c]) => [1 - t, c] as [number, RGB]).reverse() };
export const BLUES: Palette = {
  id: "blues",
  stops: [
    [0, [222, 235, 247]],
    [0.4, [107, 174, 214]],
    [0.7, [33, 113, 181]],
    [1, [8, 48, 107]],
  ],
};
/** differences: saturated blue (lower / cooler) and orange (higher / hotter), no washed-out middle */
export const DIVERGE: Palette = {
  id: "diverge",
  stops: [
    [0, [22, 74, 160]],
    [0.25, [52, 128, 206]],
    [0.47, [140, 196, 236]],
    [0.53, [252, 214, 120]],
    [0.75, [244, 152, 40]],
    [1, [206, 92, 10]],
  ],
};
export const SUN: Palette = {
  id: "sun",
  stops: [
    [0, [38, 52, 92]],
    [0.3, [96, 104, 150]],
    [0.6, [214, 172, 92]],
    [1, [255, 226, 120]],
  ],
};
export const DENSITY: Palette = {
  id: "density",
  stops: [
    [0, [246, 239, 247]],
    [0.3, [189, 201, 225]],
    [0.6, [103, 169, 207]],
    [0.85, [28, 144, 153]],
    [1, [1, 70, 54]],
  ],
};

export function sample(p: Palette, t: number): RGB {
  return lerpStops(p.stops, t);
}

export function cssGradient(p: Palette) {
  return `linear-gradient(90deg, ${p.stops.map(([t, c]) => `rgb(${c.map(Math.round).join(",")}) ${Math.round(t * 100)}%`).join(", ")})`;
}

/** 256-entry LUT */
export function lut(p: Palette): Uint8Array {
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const c = sample(p, i / 255);
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}
