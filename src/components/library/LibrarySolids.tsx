"use client";

// Mounts the library-geometry renderer (src/render/solids.ts) in the map's solid band: props and
// building solids, rebuilt only for entities that changed. Detail follows the scene's level-of-detail
// tiers (src/render/lod.ts) chunk by chunk: near chunks in full, mid-distance chunks with coarser
// meshes and without street furniture, far chunks with only the largest parts of larger things,
// chunks off screen hidden. A camera move only flips which instance buffers are visible; a chunk's
// buffers for a detail level are built the first time it needs them and then kept.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayerSlot } from "@/render/layerSlots";
import { chunkKeyAt, chunkTiers, eyeDistance, inFrustum, lodCamera, tierAt, type Tier } from "@/render/lod";
import { SolidInstances, defaultCellKey, solidLayers, type CellBounds, type CellState, type PackedLayer } from "@/render/solids";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import type { Entity } from "@/world/types";

function* propsAndBuildings(): Iterable<Entity> {
  const w = rt().world;
  for (const k of ["prop", "building"] as const) for (const id of w.byKind.get(k)!) yield w.entities.get(id)!;
}

/** the scene's tier → mesh detail (near full, mid coarser, far coarsest) */
const LOD_OF: Record<Tier, 0 | 1 | 2> = { 0: 2, 1: 1, 2: 0 };

/** our own tiers for chunks the scene has no tier for (chunks holding only library props) */
const ownTiers = new Map<string, Tier>();

/** how a chunk is drawn from the current camera (everything in full before the camera is known) */
function cellView(key: string, b: CellBounds): CellState {
  const cam = lodCamera();
  if (!cam) return { visible: true, lod: 2 };
  let t = chunkTiers.get(key);
  if (t === undefined) {
    t = tierAt(eyeDistance(cam, b.box, b.top), ownTiers.get(key), cam);
    ownTiers.set(key, t);
  }
  return { visible: inFrustum(cam, b.box, -1, b.top + 2), lod: LOD_OF[t] };
}

/** debug: ?solids=0 leaves the library geometry out (performance comparisons) */
const disabled = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("solids") === "0";

export function LibrarySolids() {
  const worldVersion = useApp((s) => s.worldVersion);
  const theme = useApp((s) => s.theme);
  const cache = useRef<SolidInstances | null>(null);
  const [packed, setPacked] = useState<PackedLayer[]>([]);
  // a new array (same buffer objects) whenever visibility or buffers change
  const publish = (t0: number) => {
    const c = cache.current!;
    setPacked(c.layers().map((p) => ({ ...p })));
    const vis = c.visibleLayers();
    const tiers = [...new Set(vis.map((p) => `${p.cell}:${p.lod}`))].map((s) => +s.slice(-1));
    (rt() as unknown as { solidsStats?: object }).solidsStats = { ms: +(performance.now() - t0).toFixed(2), rebuilt: c.lastRebuilt, packed: c.lastPacked, instances: c.count, entities: c.entityCount, buffers: c.layers().length, visible: vis.length, chunks: { near: tiers.filter((l) => l === 2).length, mid: tiers.filter((l) => l === 1).length, far: tiers.filter((l) => l === 0).length } };
  };
  // world edits: recompute the entities that changed
  useEffect(() => {
    const c = (cache.current ??= new SolidInstances((x, y) => chunkKeyAt(x, y) ?? defaultCellKey(x, y)));
    const t0 = performance.now();
    if (c.update(propsAndBuildings(), cellView) || !packed.length) publish(t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldVersion]);
  // camera moves: re-evaluate chunks once a frame; usually only visibility flips
  useEffect(() => {
    let detach: (() => void) | null = null;
    const attach = () => {
      const map = rt().map;
      if (!map) return false;
      let raf = 0;
      const on = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const c = cache.current;
          if (!c || !c.entityCount) return;
          const t0 = performance.now();
          if (c.setView(cellView)) publish(t0);
        });
      };
      map.on("move", on);
      map.on("resize", on);
      on();
      detach = () => {
        map.off("move", on);
        map.off("resize", on);
        cancelAnimationFrame(raf);
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
