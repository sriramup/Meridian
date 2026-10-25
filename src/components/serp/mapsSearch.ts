// The top-bar search's "Search Google Maps for … nearby" row: one SerpApi search around the current
// view, only when the row is chosen (Enter or a click) — never while typing. Results become pins and
// a list on the map (DiscoveredPlaces).

import { viewBounds, viewCenter } from "@/agent/resolve";
import { useApp } from "@/state/store";
import { discoverPlaces } from "@/serp/discover";
import { showOnMap } from "@/serp/view";

export async function searchGoogleMaps(query: string) {
  const q = query.trim();
  if (!q) return;
  const app = useApp.getState();
  const b = viewBounds();
  // the view's half-size, within a walkable-to-district range
  const radius = Math.max(300, Math.min(3000, Math.min(b[2] - b[0], b[3] - b[1]) / 2));
  app.notify(`Searching Google Maps for “${q}”…`, "info");
  try {
    const set = await discoverPlaces({ query: q, origin: viewCenter(), label: "this view", radius_m: radius, limit: 12, by: "search" });
    if (!set.places.length) app.notify(`Google Maps found no “${q}” around this view.`, "warn");
    else showOnMap(set);
  } catch (e) {
    app.notify((e as Error).message, "error");
  }
}
