// Sky above the horizon, driven by the real sun altitude for the hour (on LIGHTING_DATE): flat, saturated
// bands like a blocky-game sunset — deep navy at night, purple and orange through twilight, a warm
// band at golden hour and clear blue by day. Evening and morning share the same palette by altitude.

import type { SkySpecification } from "maplibre-gl";

/**
 * The scene is lit for the hour on one fixed reference day, the September equinox, whatever month
 * the analyses model: the sun rises due east and sets due west about twelve hours apart, a middle
 * ground between June's high sun and December's long shadows. Changing the month therefore never
 * re-lights or re-shades buildings, trees or the sky; only the modelled surface temperatures change.
 */
export const LIGHTING_DATE = "2025-09-22";

type RGB = [number, number, number];
interface Key {
  /** sun altitude, degrees */
  alt: number;
  sky: RGB;
  horizon: RGB;
  fog: RGB;
}

const KEYS: Key[] = [
  { alt: -18, sky: [8, 12, 34], horizon: [20, 28, 70], fog: [26, 32, 66] },
  { alt: -9, sky: [22, 26, 78], horizon: [74, 52, 120], fog: [70, 62, 104] },
  { alt: -3, sky: [52, 56, 140], horizon: [236, 104, 82], fog: [196, 132, 120] },
  { alt: 1, sky: [74, 98, 186], horizon: [255, 140, 56], fog: [242, 170, 120] },
  { alt: 6, sky: [96, 146, 222], horizon: [255, 200, 120], fog: [240, 214, 182] },
  { alt: 15, sky: [100, 168, 238], horizon: [204, 228, 248], fog: [222, 230, 236] },
  { alt: 90, sky: [88, 160, 240], horizon: [214, 234, 252], fog: [226, 234, 240] },
];

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: RGB) => `rgb(${c.map(Math.round).join(",")})`;

export function skyFor(altDeg: number): SkySpecification {
  let i = 0;
  while (i < KEYS.length - 2 && altDeg > KEYS[i + 1].alt) i++;
  const a = KEYS[i],
    b = KEYS[i + 1];
  const t = Math.max(0, Math.min(1, (altDeg - a.alt) / (b.alt - a.alt)));
  return {
    "sky-color": css(mix(a.sky, b.sky, t)),
    "horizon-color": css(mix(a.horizon, b.horizon, t)),
    "fog-color": css(mix(a.fog, b.fog, t)),
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.7,
    // haze only right at the horizon, so the city itself stays crisp
    "fog-ground-blend": 0.92,
    "atmosphere-blend": 0,
  };
}
