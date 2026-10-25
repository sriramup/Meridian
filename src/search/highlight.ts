// What a chosen search result marks on the map, briefly: a street's centreline, a park's or a
// building's outline, or a ring at a point. Shapes come from the world entities the result stands
// for; the PlaceHighlight component draws them and fades them out.

import { create } from "zustand";
import type { Vec2 } from "@/world/types";
import type { World } from "@/world/world";
import type { PlaceResult } from "./placeIndex";

export interface HighlightShapes {
  /** polylines [x, y, z] in local metres */
  lines: [number, number, number][][];
  /** closed outlines [x, y, z] */
  rings: [number, number, number][][];
  /** ground fills (outer rings, flat) */
  fills: Vec2[][];
  /** a point marker */
  point: Vec2 | null;
}

const LINE_KINDS = new Set(["street", "trail"]);
const POINT_KINDS = new Set(["intersection", "address", "geocoded", "poi", "stop"]);

/** the shapes that mark `r` in `w` */
export function highlightShapes(w: World, r: Pick<PlaceResult, "kind" | "ids" | "point">): HighlightShapes {
  const out: HighlightShapes = { lines: [], rings: [], fills: [], point: null };
  if (POINT_KINDS.has(r.kind)) {
    out.point = r.point;
    return out;
  }
  for (const id of r.ids) {
    const e = w.get(id);
    if (!e) continue;
    if (LINE_KINDS.has(r.kind) && (e.kind === "street" || e.kind === "path")) out.lines.push(e.path.map((p) => [p[0], p[1], 0.8]));
    else if (e.kind === "building") {
      // the roof edge, where it can be seen
      const z = e.height + 0.4;
      out.rings.push(e.footprint[0].map((p) => [p[0], p[1], z]));
    } else if (e.kind === "area" || e.kind === "parcel" || (e.kind === "place" && e.poly)) {
      const poly = e.kind === "place" ? e.poly! : e.poly;
      out.rings.push(poly[0].map((p) => [p[0], p[1], 0.8]));
      out.fills.push(poly[0]);
    } else if (e.kind === "prop" && e.footprint) out.rings.push(e.footprint[0].map((p) => [p[0], p[1], 0.8]));
    // a place stands for its outline when it has one (refs), its point only otherwise
    if (out.lines.length + out.rings.length) continue;
  }
  if (!out.lines.length && !out.rings.length) out.point = r.point;
  // a place and the area it refers to share one outline
  const seen = new Set<string>();
  const once = <T extends number[]>(ring: T[]) => {
    const k = `${ring.length}:${ring[0]?.[0].toFixed(1)},${ring[0]?.[1].toFixed(1)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  out.rings = out.rings.filter(once);
  seen.clear();
  out.fills = out.fills.filter(once);
  return out;
}

export interface HighlightTarget {
  key: string;
  shapes: HighlightShapes;
  /** when the camera arrived (ms, performance.now); null while flying */
  landed: number | null;
}

interface HighlightState {
  target: HighlightTarget | null;
  show: (key: string, shapes: HighlightShapes) => void;
  land: (key: string) => void;
  clear: () => void;
}

export const useSearchHighlight = create<HighlightState>((set, get) => ({
  target: null,
  show: (key, shapes) => set({ target: { key, shapes, landed: null } }),
  land: (key) => {
    const t = get().target;
    if (t && t.key === key && t.landed === null) set({ target: { ...t, landed: performance.now() } });
  },
  clear: () => set({ target: null }),
}));

/** how long the mark stays at full strength after landing, and how long it takes to fade (ms) */
export const HOLD_MS = 2200;
export const FADE_MS = 1400;

/** strength of the mark at time `now` (1 → 0) */
export function highlightAlpha(t: HighlightTarget, now: number): number {
  if (t.landed === null) return 1;
  const s = now - t.landed - HOLD_MS;
  if (s <= 0) return 1;
  return Math.max(0, 1 - s / FADE_MS);
}
