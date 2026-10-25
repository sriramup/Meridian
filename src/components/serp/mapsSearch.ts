// The top-bar search's "Search Google Maps for … nearby" row: one SerpApi search around the current
// view, only when the row is chosen (Enter or a click) — never while typing. Results become pins and
// a list on the map (DiscoveredPlaces).

import { viewInsets } from "@/state/panels";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { LocalProjection } from "@/world/projection";
import type { Vec2 } from "@/world/types";
import { discoverPlaces } from "@/serp/discover";
import { showOnMap } from "@/serp/view";

export async function searchGoogleMaps(query: string) {
  const q = query.trim();
  if (!q) return;
  const app = useApp.getState();
  const R = rtMaybe();
  if (!R?.map) return;
  // the middle of what the side panels leave visible, and its half-size as the search radius
  const ins = viewInsets();
  const el = R.map.getContainer();
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  const local = (x: number, y: number): Vec2 => {
    const ll = R.map!.unproject([x, y]);
    return proj.toLocal(ll.lng, ll.lat);
  };
  const cx = (ins.left + el.clientWidth - ins.right) / 2,
    cy = el.clientHeight / 2;
  const centre = local(cx, cy);
  const edge = local(ins.left + 40, cy);
  const radius = Math.max(300, Math.min(3000, Math.hypot(centre[0] - edge[0], centre[1] - edge[1])));
  app.notify(`Searching Google Maps for “${q}”…`, "info");
  try {
    const set = await discoverPlaces({ query: q, origin: centre, label: "this view", radius_m: radius, limit: 12, by: "search" });
    if (!set.places.length) app.notify(`Google Maps found no “${q}” around this view.`, "warn");
    else showOnMap(set);
  } catch (e) {
    app.notify((e as Error).message, "error");
  }
}
