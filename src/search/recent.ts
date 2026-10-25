// The last few places chosen in the search, per city, kept in this browser only.

import type { PlaceResult } from "./placeIndex";

const MAX = 4;
const keyFor = (city: string) => `meridian.search.recent.${city}`;

export type RecentPlace = Omit<PlaceResult, "score">;

export function loadRecents(city: string): RecentPlace[] {
  try {
    const raw = localStorage.getItem(keyFor(city));
    const v = raw ? (JSON.parse(raw) as RecentPlace[]) : [];
    return Array.isArray(v) ? v.filter((r) => r && typeof r.label === "string" && Array.isArray(r.point) && Array.isArray(r.bbox)).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function rememberPlace(city: string, r: PlaceResult | RecentPlace): RecentPlace[] {
  const entry: RecentPlace = { key: r.key, kind: r.kind, icon: r.icon, label: r.label, detail: r.detail, point: r.point, bbox: r.bbox, ids: r.ids.slice(0, 400) };
  const list = [entry, ...loadRecents(city).filter((x) => x.key !== r.key && x.label !== r.label)].slice(0, MAX);
  try {
    localStorage.setItem(keyFor(city), JSON.stringify(list));
  } catch {
    /* storage unavailable: recents just aren't kept */
  }
  return list;
}

export function clearRecents(city: string) {
  try {
    localStorage.removeItem(keyFor(city));
  } catch {
    /* nothing to clear */
  }
}
