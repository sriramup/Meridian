// Day and night follow the clock. The scene is lit for useApp().hour on the fixed lighting date
// (sky.ts: LIGHTING_DATE), so the month never changes how the city looks. Everything here is a
// continuous function of the sun's altitude, so dawn and dusk blend smoothly:
//
// - `night` (0 day … 1 night) darkens the ground, streets, trees and buildings on the GPU (the
//   facade shader and DuskExtension read it as a uniform) and switches on lit windows;
// - lights: the sun fades out below the horizon and warms near it, a cool moon (opposite the sun)
//   and a dimmer ambient take over at night;
// - the sky (sky.ts) and the basemap's colours follow the same altitude.
//
// Nothing re-tessellates or re-uploads geometry when the hour changes: the scene's colour
// attributes always hold the day palette and the night look is a uniform. The renderer reads the
// current state from `daylight` at draw time (no layer props change), then redraws.

import { create } from "zustand";
import { sunAltAz } from "@/lib/sun";
import { LIGHTING_DATE } from "./sky";
import { mapIsGraphite, type RGB } from "./theme";

export interface Daylight {
  /** local hour it was computed for */
  hour: number;
  /** sun altitude (degrees) */
  alt: number;
  /** 0 full day … 1 full night (civil twilight is most of the way): lit windows, lamps, labels */
  night: number;
  /**
   * 0 … 1: how far surfaces are graded towards their night tone. Starts earlier than `night`
   * (as the sun gets low), so unlit ground dims together with roofs that the low sun no longer
   * reaches, instead of staying bright while the buildings go dark.
   */
  dim: number;
  sun: { intensity: number; color: RGB };
  moon: { intensity: number; color: RGB };
  ambient: { intensity: number; color: RGB };
  /** UTC timestamps that put the sun and the moon (opposite the sun) where they are at this hour */
  sunTs: number;
  moonTs: number;
}

const DAY_AMBIENT = 0.62;
const NIGHT_AMBIENT = 0.36;
const DAY_SUN = 1.9;
const MOON = 0.42;
const TWILIGHT = 0.8;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** how far into night the city is at a sun altitude (degrees): 0 above ~6°, ~0.3 at sunset, 1 by -10° */
export function nightAt(altDeg: number): number {
  return 1 - smooth(-10, 6, altDeg);
}

/** the lighting state for a sun altitude (pure; timestamps are filled in by daylightFor) */
export function lightsAt(altDeg: number): Pick<Daylight, "night" | "dim" | "sun" | "moon" | "ambient"> {
  const night = nightAt(altDeg);
  const dim = 1 - smooth(-10, 16, altDeg);
  // the sun fades out as it touches the horizon and is golden near it
  const up = smooth(-1.5, 10, altDeg);
  const warm = 1 - smooth(2, 22, altDeg);
  // twilight: the sky still lights the city after the sun is gone (skylight makes up the sun's loss)
  const sky = TWILIGHT * (1 - up) * (1 - night);
  return {
    night,
    dim,
    sun: { intensity: DAY_SUN * up, color: mixRGB([255, 248, 236], [255, 178, 112], warm) },
    moon: { intensity: MOON * night, color: [150, 162, 205] },
    ambient: { intensity: DAY_AMBIENT + (NIGHT_AMBIENT - DAY_AMBIENT) * night + sky, color: mixRGB(mixRGB([255, 255, 255], [255, 222, 206], sky / TWILIGHT), [196, 206, 236], night) },
  };
}

/** UTC offset (ms) of a time zone on the lighting date, cached (one Intl call per zone) */
const offsets = new Map<string, number>();
function zoneOffset(timeZone: string): number {
  let o = offsets.get(timeZone);
  if (o === undefined) {
    const [y, m, d] = LIGHTING_DATE.split("-").map(Number);
    const guess = Date.UTC(y, m - 1, d, 12, 0);
    let asLocal = guess;
    try {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
      asLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    } catch {
      /* unknown zone: UTC */
    }
    offsets.set(timeZone, (o = asLocal - guess));
  }
  return o;
}

/** UTC timestamp of a local hour on the lighting date (fractional hours, no Intl call per frame) */
export function lightingTimestamp(hour: number, timeZone: string): number {
  const [y, m, d] = LIGHTING_DATE.split("-").map(Number);
  return Date.UTC(y, m - 1, d) + hour * 3_600_000 - zoneOffset(timeZone);
}

export function daylightFor(hour: number, place: { lat: number; lon: number; timezone: string }): Daylight {
  const sunTs = lightingTimestamp(hour, place.timezone);
  const alt = (sunAltAz(new Date(sunTs), place.lat, place.lon).alt * 180) / Math.PI;
  return { hour, alt, ...lightsAt(alt), sunTs, moonTs: sunTs + 12 * 3_600_000 };
}

/** the current state, read by shaders at draw time; written by the map when the hour changes */
export const daylight: Daylight = { hour: 15, alt: 40, ...lightsAt(40), sunTs: 0, moonTs: 0 };

export function setDaylight(d: Daylight) {
  Object.assign(daylight, d);
  const isNight = d.night > 0.55;
  if (useNight.getState().night !== isNight) useNight.setState({ night: isNight });
}

/**
 * Whether it is night enough for night-only looks that switch rather than fade (light text on a
 * dark halo, glowing lamps). Changes twice a day; subscribe with useNight((s) => s.night).
 */
export const useNight = create<{ night: boolean }>(() => ({ night: false }));

/** per-layer night tones: how much each kind of surface keeps of its day colour at full night */
export const NIGHT_TONE = {
  land: [0.11, 0.125, 0.165] as RGB,
  surface: [0.22, 0.24, 0.28] as RGB,
  area: [0.15, 0.19, 0.2] as RGB,
  road: [0.21, 0.24, 0.33] as RGB,
  path: [0.29, 0.3, 0.32] as RGB,
  mark: [0.6, 0.62, 0.68] as RGB,
  kerb: [0.27, 0.28, 0.32] as RGB,
  tree: [0.34, 0.39, 0.42] as RGB,
  trunk: [0.45, 0.45, 0.5] as RGB,
  grid: [0.3, 0.33, 0.42] as RGB,
  building: [0.35, 0.37, 0.41] as RGB,
  context: [0.18, 0.19, 0.23] as RGB,
};

/** basemap colours by day and by night; blended by `night` */
const BASE_DAY = { bg: "#e8d6b1", water: "#b4cac8", park: "#d3d4b0", road: "#d8c39d", major: "#cdb488", label: "#6e5234", halo: "#f1e3c3" };
/** the day basemap under the Dark interface (render/theme.ts GRAPHITE) */
const BASE_GRAPHITE = { bg: "#1d1f23", water: "#1c2a35", park: "#26332a", road: "#30333a", major: "#3a3d44", label: "#8b8f98", halo: "#1d1f23" };
const BASE_NIGHT = { bg: "#14161a", water: "#121c25", park: "#18211b", road: "#24272c", major: "#2b2f35", label: "#7c8088", halo: "#14161a" };
export type BasemapColors = typeof BASE_DAY;
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const toHex = (c: RGB) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
export function basemapColors(night: number): BasemapColors {
  const day = mapIsGraphite() ? BASE_GRAPHITE : BASE_DAY;
  if (night <= 0) return day;
  if (night >= 1) return BASE_NIGHT;
  const out = {} as BasemapColors;
  for (const k of Object.keys(day) as (keyof BasemapColors)[]) out[k] = toHex(mixRGB(hex(day[k]), hex(BASE_NIGHT[k]), night));
  return out;
}
