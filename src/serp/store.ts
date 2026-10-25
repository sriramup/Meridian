// Discovered places (Google Maps results via SerpApi) in the planner's frame: the sets found this
// session, the one drawn on the map, the pin in focus, and the agent composer's Search toggle per
// session. Read by the map layer (src/components/serp/DiscoveredPlaces.tsx), the tool cards and the
// agent tools (src/agent/serpTools.ts).

import { create } from "zustand";
import type { Poi, Vec2 } from "@/world/types";
import type { SerpCredits, SerpPlace } from "./types";

export interface LocalPlace extends SerpPlace {
  /** local metres (x east, y north) */
  p: Vec2;
  /** straight-line distance from the search origin (m) */
  dist_m: number;
  /** walking distance (m): over the street network when inside the study area, else straight-line × 1.3 */
  walk_m: number;
  walk_min: number;
  walk_basis: "network" | "estimate";
  /** inside the study area (the walk-access model only sees destinations there) */
  inside: boolean;
  /** what the walk-access model would count it as, once imported */
  category: Poi["category"];
}

export interface PlaceSet {
  id: string;
  query: string;
  origin: { p: Vec2; label: string };
  radius_m: number;
  places: LocalPlace[];
  at: number;
  by: "agent" | "search";
  cached?: boolean;
}

interface SerpState {
  sets: Record<string, PlaceSet>;
  order: string[];
  /** the set drawn on the map */
  shown: string | null;
  /** the place whose callout is open */
  focus: string | null;
  credits: SerpCredits | null;
  /** agent composer "Search" toggle, per session id */
  searchOn: Record<string, boolean>;
}

const KEEP = 12;

export const useSerp = create<SerpState>(() => ({ sets: {}, order: [], shown: null, focus: null, credits: null, searchOn: loadSearchOn() }));

let seq = 0;
export function addSet(s: Omit<PlaceSet, "id" | "at">, show = true): PlaceSet {
  const set: PlaceSet = { ...s, id: `ps${++seq}`, at: Date.now() };
  useSerp.setState((st) => {
    const order = [...st.order, set.id].slice(-KEEP);
    const sets: Record<string, PlaceSet> = {};
    for (const id of order) sets[id] = id === set.id ? set : st.sets[id];
    return { sets, order, shown: show ? set.id : st.shown && sets[st.shown] ? st.shown : null, focus: null };
  });
  return set;
}

/** a set by id, or the latest one */
export function getSet(id?: string | null): PlaceSet | null {
  const st = useSerp.getState();
  if (id) return st.sets[id] ?? null;
  const last = st.order[st.order.length - 1];
  return last ? st.sets[last] : null;
}

/** draw a set on the map (also re-adds one restored from a saved tool card) */
export function showSet(set: PlaceSet | null) {
  if (!set) return useSerp.setState({ shown: null, focus: null });
  useSerp.setState((st) => (st.sets[set.id] ? { shown: set.id, focus: null } : { sets: { ...st.sets, [set.id]: set }, order: [...st.order, set.id].slice(-KEEP), shown: set.id, focus: null }));
}

export function clearShown() {
  useSerp.setState({ shown: null, focus: null });
}

export function focusPlace(id: string | null) {
  useSerp.setState({ focus: id });
}

const SEARCH_KEY = "meridian:serp-search-on";
function loadSearchOn(): Record<string, boolean> {
  try {
    return typeof localStorage === "undefined" ? {} : (JSON.parse(localStorage.getItem(SEARCH_KEY) ?? "{}") as Record<string, boolean>);
  } catch {
    return {};
  }
}
export function setSearchOn(sessionId: string, on: boolean) {
  const searchOn = { ...useSerp.getState().searchOn };
  if (on) searchOn[sessionId] = true;
  else delete searchOn[sessionId];
  useSerp.setState({ searchOn });
  try {
    localStorage.setItem(SEARCH_KEY, JSON.stringify(searchOn));
  } catch {
    // private mode: the toggle just isn't remembered
  }
}
export const isSearchOn = (sessionId: string) => !!useSerp.getState().searchOn[sessionId];
