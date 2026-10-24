"use client";

// UI state of the library: the primitive armed for placement, the parameters the user set for
// each definition (kept for the session so repeated placement reuses them), the placement heading,
// and the in-progress points of a polygon / path placement.

import { create } from "zustand";
import { defaultParams, ensureLibrary, getPrimitive, type ParamValues } from "@/library";
import { useApp } from "@/state/store";
import type { Vec2 } from "@/world/types";

export interface LibraryState {
  /** definition being configured / placed (null: browsing) */
  defId: string | null;
  /** last-used parameters per definition */
  params: Record<string, ParamValues>;
  /** heading for point / rect placement, degrees ccw from east */
  rotation: number;
  /** browse filter */
  query: string;
  category: string | null;
  /** clicked points of a polygon / path being drawn */
  points: Vec2[];
  cursor: Vec2 | null;
  /** a press-and-drag in progress (heading for points, a rectangle for rect placement) */
  drag: { from: Vec2; to: Vec2 } | null;
  /** bumped when the preview should be recomputed */
  tick: number;
  setQuery: (q: string) => void;
  setCategory: (c: string | null) => void;
  /** open a definition's form and arm it for placement */
  arm: (defId: string) => void;
  /** back to browsing (keeps the library tool) */
  disarm: () => void;
  setParams: (defId: string, values: ParamValues) => void;
  resetParams: (defId: string) => void;
  setRotation: (deg: number) => void;
  bump: () => void;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  defId: null,
  params: {},
  rotation: 0,
  query: "",
  category: null,
  points: [],
  cursor: null,
  drag: null,
  tick: 0,
  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  arm: (defId) => {
    ensureLibrary();
    const def = getPrimitive(defId);
    if (!def) return;
    const params = get().params[defId] ? get().params : { ...get().params, [defId]: defaultParams(def) };
    set({ defId, params, points: [], drag: null, tick: get().tick + 1 });
    const app = useApp.getState();
    if (app.tool !== "library") app.setTool("library");
  },
  disarm: () => set({ defId: null, points: [], drag: null, cursor: null, tick: get().tick + 1 }),
  setParams: (defId, values) => set({ params: { ...get().params, [defId]: values }, tick: get().tick + 1 }),
  resetParams: (defId) => {
    const def = getPrimitive(defId);
    if (def) set({ params: { ...get().params, [defId]: defaultParams(def) }, tick: get().tick + 1 });
  },
  setRotation: (deg) => set({ rotation: ((Math.round(deg * 10) / 10) % 360 + 360) % 360, tick: get().tick + 1 }),
  bump: () => set({ tick: get().tick + 1 }),
}));

/** the armed definition's current parameters */
export function armedParams(): ParamValues {
  const s = useLibrary.getState();
  return s.defId ? (s.params[s.defId] ?? {}) : {};
}
