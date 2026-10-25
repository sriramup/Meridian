// What a project can start from: the blank sandbox (design a city from scratch) or a measured city
// pack. The sandbox has no data of its own; it borrows the sun path, time zone and typical weather
// of a climate city so heat, shade and runoff still run on whatever is drawn.

export interface CityPreset {
  id: string;
  name: string;
  blurb: string;
  kind: "sandbox" | "pack";
  /** for the sandbox: the pack whose latitude, time zone and weather it uses */
  climate?: string;
  /** default name of a new project from this preset */
  projectName: string;
  /** label in the new-project menu */
  menuLabel: string;
  /** short tag shown beside a project in the sidebar */
  badge: string;
}

export const CITY_PRESETS: CityPreset[] = [
  { id: "sandbox", name: "Blank canvas", blurb: "An empty 3 × 3 km site to design from scratch", kind: "sandbox", climate: "austin", projectName: "Untitled canvas", menuLabel: "Blank canvas", badge: "Blank" },
  { id: "austin", name: "Austin", blurb: "Downtown, Central & East Austin, measured", kind: "pack", projectName: "Austin plan", menuLabel: "From Austin template", badge: "Austin" },
];

export const DEFAULT_CITY = "sandbox";

export const presetOf = (id: string) => CITY_PRESETS.find((c) => c.id === id);

/** the climate pack a base uses */
export const climateOf = (base: string) => presetOf(base)?.climate ?? base;

/** the template named by an old-style address (?city=austin), if any */
export function cityFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const id = new URLSearchParams(window.location.search).get("city");
  return id && presetOf(id) ? id : null;
}

/**
 * Open a preset without a page load: the most recent project started from it, else a new one.
 * Returns false when it is already open.
 */
export async function switchCity(id: string): Promise<boolean> {
  const { openOrCreateFromBase } = await import("./projects");
  return openOrCreateFromBase(id);
}
