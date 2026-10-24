"use client";

// Feature modules (agent zones, library props, the street-level cursor…) contribute deck.gl
// layers through named slots instead of editing MapView: a component calls useLayerSlot with its
// layers and MapView stacks every slot in its band. Keep each slot's layer array referentially
// stable (useMemo) so the map only re-stacks when a contribution actually changes.

import type { Layer } from "@deck.gl/core";
import { useEffect } from "react";
import { create } from "zustand";

/**
 * ground: flat on the ground, above street surfaces and analysis rasters, below buildings.
 * solid: 3D things drawn with the buildings and trees. top: overlays drawn above the scene.
 */
export type SlotBand = "ground" | "solid" | "top";

interface SlotState {
  slots: Record<string, { band: SlotBand; layers: Layer[] }>;
  set: (key: string, band: SlotBand, layers: Layer[] | null) => void;
}

export const useLayerSlots = create<SlotState>((set) => ({
  slots: {},
  set: (key, band, layers) =>
    set((s) => {
      const slots = { ...s.slots };
      if (layers && layers.length) slots[key] = { band, layers };
      else delete slots[key];
      return { slots };
    }),
}));

/** contribute `layers` under `key` while the calling component is mounted */
export function useLayerSlot(key: string, band: SlotBand, layers: Layer[] | null) {
  useEffect(() => {
    useLayerSlots.getState().set(key, band, layers);
  }, [key, band, layers]);
  useEffect(() => () => useLayerSlots.getState().set(key, band, null), [key]);
}

/** every slot's layers in one band, in key order (stable stacking) */
export function slotLayers(slots: SlotState["slots"], band: SlotBand): Layer[] {
  return Object.keys(slots)
    .sort()
    .filter((k) => slots[k].band === band)
    .flatMap((k) => slots[k].layers);
}
