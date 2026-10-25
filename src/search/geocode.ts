// Street addresses and places in a real city that the local data doesn't name, from Photon
// (https://photon.komoot.io, Komoot's OpenStreetMap geocoder built for search-as-you-type).
// Usage policy: light, fair use with attribution to OpenStreetMap; so queries are debounced by the
// caller, cached here, never more than one a second, restricted to the city's bounding box, and
// cancelled when superseded. When the service can't be reached the search quietly does without it.

import { LocalProjection } from "@/world/projection";
import type { Vec2 } from "@/world/types";
import type { PlaceResult } from "./placeIndex";
import { abbreviate, normKey } from "./normalize";

export const GEOCODER_ATTRIBUTION = { text: "© OpenStreetMap contributors · Photon", url: "https://www.openstreetmap.org/copyright" };

const ENDPOINT = "https://photon.komoot.io/api/";
const MIN_INTERVAL = 1000;
const OFFLINE_BACKOFF = 60_000;

interface PhotonFeature {
  geometry: { type: string; coordinates: [number, number] };
  properties: {
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    osm_value?: string;
    type?: string;
    name?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    district?: string;
    postcode?: string;
    /** [minLon, maxLat, maxLon, minLat] */
    extent?: [number, number, number, number];
  };
}

export interface CityFrame {
  origin: { lon: number; lat: number };
  /** local metres [minX, minY, maxX, maxY] */
  bounds: [number, number, number, number];
}

const cache = new Map<string, PlaceResult[]>();
let lastAt = 0;
let downUntil = 0;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

const pretty = (v?: string) => (v ? v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "");

/** Photon features → results inside the city (anything outside its bounds is dropped) */
export function toResults(features: PhotonFeature[], city: CityFrame): PlaceResult[] {
  const proj = new LocalProjection(city.origin.lon, city.origin.lat);
  const [x0, y0, x1, y1] = city.bounds;
  const out: PlaceResult[] = [];
  for (const f of features) {
    const c = f.geometry?.coordinates;
    if (!c || f.geometry.type !== "Point") continue;
    const p = proj.toLocal(c[0], c[1]) as Vec2;
    if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
    const pr = f.properties ?? {};
    const street = pr.street ? abbreviate(pr.street) : "";
    const addr = pr.housenumber && street ? `${pr.housenumber} ${street}` : "";
    const label = pr.name ? pr.name : addr || street;
    if (!label) continue;
    const isAddr = !pr.name && !!addr;
    const what = isAddr ? "Address" : pr.osm_key === "highway" ? "Street" : pretty(pr.osm_value) || "Place";
    // a named place says its address; otherwise the search adds the neighbourhood
    const where = pr.name ? addr || street : "";
    let bbox: PlaceResult["bbox"] = [p[0] - 30, p[1] - 30, p[0] + 30, p[1] + 30];
    if (pr.extent) {
      const a = proj.toLocal(pr.extent[0], pr.extent[3]),
        b = proj.toLocal(pr.extent[2], pr.extent[1]);
      bbox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    }
    out.push({
      key: `geo:${pr.osm_type ?? ""}${pr.osm_id ?? normKey(label)}`,
      kind: "geocoded",
      icon: isAddr ? "House" : "MapPin",
      label,
      detail: where ? `${what} · ${where}` : what,
      point: p,
      bbox,
      ids: [],
      score: 0,
    });
  }
  return out;
}

/**
 * Places for `q` inside the city, best first; [] when there are none and null when the geocoder
 * can't be reached (or `signal` cancelled the request).
 */
export async function geocode(q: string, city: CityFrame, signal?: AbortSignal): Promise<PlaceResult[] | null> {
  const key = `${city.origin.lon},${city.origin.lat}|${normKey(q)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (Date.now() < downUntil || (typeof navigator !== "undefined" && navigator.onLine === false)) return null;
  try {
    const wait = lastAt + MIN_INTERVAL - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastAt = Date.now();
    const proj = new LocalProjection(city.origin.lon, city.origin.lat);
    const [x0, y0, x1, y1] = city.bounds;
    const sw = proj.toLonLat([x0, y0]),
      ne = proj.toLonLat([x1, y1]);
    const url = new URL(ENDPOINT);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", "8");
    url.searchParams.set("lang", "en");
    url.searchParams.set("bbox", [sw[0], sw[1], ne[0], ne[1]].map((v) => v.toFixed(5)).join(","));
    const c = proj.toLonLat([(x0 + x1) / 2, (y0 + y1) / 2]);
    url.searchParams.set("lon", c[0].toFixed(5));
    url.searchParams.set("lat", c[1].toFixed(5));
    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) {
      // overloaded or refusing: back off for a while
      if (res.status === 429 || res.status >= 500) downUntil = Date.now() + OFFLINE_BACKOFF;
      return null;
    }
    const json = (await res.json()) as { features?: PhotonFeature[] };
    const out = toResults(json.features ?? [], city);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(key, out);
    return out;
  } catch (e) {
    if ((e as Error)?.name !== "AbortError") downUntil = Date.now() + OFFLINE_BACKOFF;
    return null;
  }
}

/** forget cached answers and the offline back-off (tests) */
export function resetGeocoder() {
  cache.clear();
  lastAt = 0;
  downUntil = 0;
}
