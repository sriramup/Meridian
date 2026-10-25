// Framing a discovered place set on the map: the search origin and its places inside the study area
// (a far result outside it would zoom the view out to the whole region), or one place in focus.

import { frame } from "@/agent/navTools";
import { focusPlace, showSet, type PlaceSet } from "./store";

export function showOnMap(set: PlaceSet, focus?: string) {
  showSet(set);
  if (focus) {
    const p = set.places.find((x) => x.id === focus);
    if (p) frame([p.p[0] - 120, p.p[1] - 120, p.p[0] + 120, p.p[1] + 120]);
    focusPlace(focus);
    return;
  }
  const near = set.places.filter((p) => p.inside && p.dist_m <= Math.max(1200, set.radius_m * 2));
  const pts = [set.origin.p, ...(near.length ? near : set.places.slice(0, 3)).map((p) => p.p)];
  const r = Math.min(set.radius_m, 900);
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  frame([Math.min(...xs, set.origin.p[0] - r * 0.6), Math.min(...ys, set.origin.p[1] - r * 0.6), Math.max(...xs, set.origin.p[0] + r * 0.6), Math.max(...ys, set.origin.p[1] + r * 0.6)]);
}
