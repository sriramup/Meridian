"use client";

// Grid and snapping settings for manual editing (the grid button on the tool rail). The grid is
// on by default on the blank canvas and off in real cities; street-frontage snapping is on
// everywhere. Remembered per browser. Hold Alt while placing to place freely; hold Shift to turn
// freely (rotation otherwise snaps to 15°).

import { create } from "zustand";
import { rtMaybe } from "./runtime";
import type { Building, Vec2 } from "@/world/types";
import { cornersOf, FT, GRID_SIZES_FT, snapToGrid, snapToVertex, type GridFt } from "@/world/ops/snap";

export interface SnapState {
  /** grid shown and snapped to, per kind of city (null: the default for it) */
  gridSandbox: boolean;
  gridCity: boolean;
  sizeFt: GridFt;
  /** buildings near a street face it and settle on its frontage / setback lines */
  street: boolean;
  /** modifier keys held right now (from pointer events) */
  free: boolean;
  freeTurn: boolean;
  setGrid: (on: boolean) => void;
  setSize: (ft: GridFt) => void;
  setStreet: (on: boolean) => void;
  setMods: (m: { alt: boolean; shift: boolean }) => void;
}

const KEY = "meridian.snap.v1";

function load(): Partial<SnapState> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return {};
    const v = JSON.parse(raw);
    return {
      ...(typeof v.gridSandbox === "boolean" ? { gridSandbox: v.gridSandbox } : {}),
      ...(typeof v.gridCity === "boolean" ? { gridCity: v.gridCity } : {}),
      ...((GRID_SIZES_FT as readonly number[]).includes(v.sizeFt) ? { sizeFt: v.sizeFt } : {}),
      ...(typeof v.street === "boolean" ? { street: v.street } : {}),
    };
  } catch {
    return {};
  }
}

function save(s: SnapState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ gridSandbox: s.gridSandbox, gridCity: s.gridCity, sizeFt: s.sizeFt, street: s.street }));
  } catch {
    /* private window */
  }
}

const sandbox = () => !!rtMaybe()?.meta?.sandbox;

export const useSnap = create<SnapState>((set, get) => ({
  gridSandbox: true,
  gridCity: false,
  sizeFt: 25,
  street: true,
  free: false,
  freeTurn: false,
  ...load(),
  setGrid: (on) => {
    set(sandbox() ? { gridSandbox: on } : { gridCity: on });
    save(get());
  },
  setSize: (sizeFt) => {
    set({ sizeFt });
    save(get());
  },
  setStreet: (street) => {
    set({ street });
    save(get());
  },
  setMods: ({ alt, shift }) => {
    const s = get();
    if (s.free !== alt || s.freeTurn !== shift) set({ free: alt, freeTurn: shift });
  },
}));

/** is the grid on in the current city? */
export function gridOn(s: SnapState = useSnap.getState()): boolean {
  return sandbox() ? s.gridSandbox : s.gridCity;
}

/** the grid step to snap to right now (m), or 0 when off / Alt is held */
export function gridStep(): number {
  const s = useSnap.getState();
  return gridOn(s) && !s.free ? s.sizeFt * FT : 0;
}

/** street-frontage snapping active right now */
export function streetSnapOn(): boolean {
  const s = useSnap.getState();
  return s.street && !s.free;
}

/** rotation step right now (15°, or free with Shift) */
export function turnStep(): number {
  return useSnap.getState().freeTurn ? 0 : 15;
}

/** metres per screen pixel at the map centre */
export function metersPerPixel(): number {
  const map = rtMaybe()?.map;
  if (!map) return 0.5;
  const lat = map.getCenter().lat;
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
}

/**
 * Snap a pointer position: to the corners of nearby buildings (within ~10 px) when `corners`, else
 * to the grid when it is on. Alt held: as it is.
 */
export function snapPoint(p: Vec2, corners = false): Vec2 {
  const g = gridStep();
  if (corners && (g || streetSnapOn())) {
    const tol = 10 * metersPerPixel();
    const near = rtMaybe()!.world.query([p[0] - tol, p[1] - tol, p[0] + tol, p[1] + tol], ["building"]);
    const v = snapToVertex(p, cornersOf(near.map((e) => (e as Building).footprint)), tol);
    if (v) return [v[0], v[1]];
  }
  return g ? snapToGrid(p, g) : p;
}

