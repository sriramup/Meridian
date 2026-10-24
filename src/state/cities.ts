// What can be loaded: the blank sandbox (design a city from scratch) or a measured city pack.
// The sandbox has no data of its own; it borrows the sun path, time zone and typical weather of
// a climate city so heat, shade and runoff still run on whatever is drawn.

import { saveDesign } from "./persist";
import { rtMaybe } from "./runtime";

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

/** the page address that opens a preset (keeps any other query parameters) */
export function cityUrl(id: string, href = window.location.href): string {
  const u = new URL(href);
  if (id === DEFAULT_CITY) u.searchParams.delete("city");
  else u.searchParams.set("city", id);
  u.hash = "";
  return u.toString();
}

/**
 * Open another preset with one navigation (the runtime, worker and caches are per city). The blank
 * canvas saves itself first; scenario edits to a measured city live only in this page, so leaving
 * one with edits asks first. Returns false when the person stays.
 *
 * (Setting `location.search` and then calling `location.reload()` reloads the *old* address: the
 * reload replaces the pending navigation, which is how leaving Austin for the canvas got stuck.)
 */
export async function switchCity(id: string): Promise<boolean> {
  const R = rtMaybe();
  if (R?.cityId === id) return false;
  if (R && !R.meta.sandbox && [...R.scenarios.scenarios.values()].some((s) => s.changesets.length > 0)) {
    const { confirmAction } = await import("@/components/ConfirmDialog");
    const ok = await confirmAction({ title: `Leave ${R.meta.name}?`, body: "Proposals for a measured city are not saved in the browser. Export the proposal first (design menu → Export) to keep it.", confirm: "Leave", danger: true });
    if (!ok) return false;
  }
  if (R?.meta.sandbox) await saveDesign();
  window.location.assign(cityUrl(id));
  return true;
}
