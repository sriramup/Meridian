"use client";

// Mounts the library-geometry renderer (src/render/solids.ts) in the map's solid band: props and
// building solids, rebuilt only for entities that changed. Detail follows the scene's level-of-detail
// tiers (src/render/lod.ts) cell by cell: near cells in full, mid-distance cells with coarser meshes
// and without the smallest props, far cells with only the largest parts of larger things, and cells
// off screen not drawn at all.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayerSlot } from "@/render/layerSlots";
import { FAR, MID, eyeDistance, inFrustum, lodCamera, tierAt, type Tier } from "@/render/lod";
import { SolidInstances, solidLayers, type CellBounds, type CellState, type PackedLayer } from "@/render/solids";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import type { Entity } from "@/world/types";

function* propsAndBuildings(): Iterable<Entity> {
  const w = rt().world;
  for (const k of ["prop", "building"] as const) for (const id of w.byKind.get(k)!) yield w.entities.get(id)!;
}

const STATE: Record<Tier, Omit<CellState, "visible">> = {
  0: { lod: 2, maxTier: 2 },
  1: { lod: 1, maxTier: 1 },
  2: { lod: 0, maxTier: 0 },
};

/** tiers by cell, kept between camera moves for hysteresis */
const tiers = new Map<string, Tier>();

/** cells last drawn as on screen */
const shown = new Set<string>();
/** while the camera moves, cells that come into view are added but none are dropped (no re-pack per frame) */
let sticky = false;

/** how a cell is drawn from the current camera (everything in full before the camera is known) */
function cellView(key: string, b: CellBounds): CellState {
  const cam = lodCamera();
  if (!cam) return { visible: true, lod: 2, maxTier: 2 };
  const t = tierAt(eyeDistance(cam, b.box, b.top), tiers.get(key), cam);
  tiers.set(key, t);
  const visible = inFrustum(cam, b.box, -1, b.top + 2) || (sticky && shown.has(key));
  if (visible) shown.add(key);
  else shown.delete(key);
  return { visible, ...STATE[t] };
}

/** debug: ?solids=0 leaves the library geometry out (performance comparisons) */
const disabled = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("solids") === "0";

export function LibrarySolids() {
  const worldVersion = useApp((s) => s.worldVersion);
  const theme = useApp((s) => s.theme);
  const cache = useRef<SolidInstances | null>(null);
  const [packed, setPacked] = useState<PackedLayer[]>([]);
  const stats = (t0: number) => {
    const c = cache.current!;
    (rt() as unknown as { solidsStats?: object }).solidsStats = { ms: +(performance.now() - t0).toFixed(2), rebuilt: c.lastRebuilt, instances: c.count, entities: c.entityCount, layers: c.layers().length, tiers: { near: [...tiers.values()].filter((t) => t < MID).length, mid: [...tiers.values()].filter((t) => t === MID).length, far: [...tiers.values()].filter((t) => t === FAR).length } };
  };
  // world edits: recompute the entities that changed
  useEffect(() => {
    const c = (cache.current ??= new SolidInstances());
    const t0 = performance.now();
    if (c.update(propsAndBuildings(), cellView) || !packed.length) setPacked(c.layers());
    stats(t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldVersion]);
  // camera moves: re-evaluate cells (at most once a frame); re-packs only when a cell changes state
  useEffect(() => {
    let detach: (() => void) | null = null;
    const attach = () => {
      const map = rt().map;
      if (!map) return false;
      // during a move: at most every 250 ms, only adding cells; when it ends: exactly
      let timer: ReturnType<typeof setTimeout> | null = null;
      const evaluate = (moving: boolean) => {
        const c = cache.current;
        if (!c || !c.entityCount) return;
        sticky = moving;
        const t0 = performance.now();
        if (c.setView(cellView)) {
          setPacked(c.layers());
          stats(t0);
        }
      };
      const onMove = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          evaluate(true);
        }, 250);
      };
      const onEnd = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        evaluate(false);
      };
      map.on("move", onMove);
      map.on("moveend", onEnd);
      map.on("resize", onEnd);
      onEnd();
      detach = () => {
        map.off("move", onMove);
        map.off("moveend", onEnd);
        map.off("resize", onEnd);
        if (timer) clearTimeout(timer);
      };
      return true;
    };
    if (!attach()) {
      const iv = setInterval(() => attach() && clearInterval(iv), 200);
      return () => (clearInterval(iv), detach?.());
    }
    return () => detach?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const layers = useMemo(() => {
    if (disabled() || !packed.length) return null;
    const R = rt();
    return solidLayers(packed, { origin: [R.meta.origin.lon, R.meta.origin.lat, 0], night: theme === "night" });
  }, [packed, theme]);
  useLayerSlot("library-solids", "solid", layers);
  return null;
}
