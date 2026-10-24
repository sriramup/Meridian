// What can be loaded: the blank sandbox (design a city from scratch) or a measured city pack.
// The sandbox has no data of its own; it borrows the sun path, time zone and typical weather of
// a climate city so heat, shade and runoff still run on whatever is drawn.

export interface CityPreset {
  id: string;
  name: string;
  blurb: string;
  kind: "sandbox" | "pack";
  /** for the sandbox: the pack whose latitude, time zone and weather it uses */
  climate?: string;
}

export const CITY_PRESETS: CityPreset[] = [
  { id: "sandbox", name: "Blank canvas", blurb: "Design a city from scratch on an empty 3 × 3 km site", kind: "sandbox", climate: "austin" },
  { id: "austin", name: "Austin", blurb: "Downtown, Central & East Austin: measured buildings, streets, zoning and census", kind: "pack" },
];

export const DEFAULT_CITY = "sandbox";

export const presetOf = (id: string) => CITY_PRESETS.find((c) => c.id === id);

/** the city named in the URL (?city=…), else the blank canvas */
export function cityFromUrl(): string {
  if (typeof window === "undefined") return DEFAULT_CITY;
  const id = new URLSearchParams(window.location.search).get("city");
  return id && presetOf(id) ? id : DEFAULT_CITY;
}

/** reload into another preset (the runtime, worker and caches are per city) */
export function switchCity(id: string) {
  const q = new URLSearchParams(window.location.search);
  if (id === DEFAULT_CITY) q.delete("city");
  else q.set("city", id);
  const s = q.toString();
  window.location.search = s ? `?${s}` : "";
  if (!s) window.location.reload();
}
