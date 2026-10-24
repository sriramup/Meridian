"use client";

// Mounts the library-geometry renderer (src/render/solids.ts) in the map's solid band: props and
// building solids, rebuilt only for entities that changed, with small props culled when far out.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLayerSlot } from "@/render/layerSlots";
import { SolidInstances, maxTierAt, meshLodAt, solidLayers } from "@/render/solids";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import type { Entity } from "@/world/types";

function* propsAndBuildings(): Iterable<Entity> {
  const w = rt().world;
  for (const k of ["prop", "building"] as const) for (const id of w.byKind.get(k)!) yield w.entities.get(id)!;
}

/** the current map zoom as the renderer's detail level (tier · mesh detail), so panning never re-renders */
function useDetailTier(): string {
  const [tier, setTier] = useState("2:2");
  useEffect(() => {
    let map = rt().map;
    let detach: (() => void) | null = null;
    const attach = () => {
      map = rt().map;
      if (!map) return false;
      const m = map;
      const on = () => setTier(`${maxTierAt(m.getZoom())}:${meshLodAt(m.getZoom())}`);
      on();
      m.on("zoom", on);
      detach = () => m.off("zoom", on);
      return true;
    };
    if (attach()) return () => detach?.();
    const iv = setInterval(() => attach() && clearInterval(iv), 200);
    return () => {
      clearInterval(iv);
      detach?.();
    };
  }, []);
  return tier;
}

export function LibrarySolids() {
  const worldVersion = useApp((s) => s.worldVersion);
  const theme = useApp((s) => s.theme);
  const tier = useDetailTier();
  const cache = useRef<SolidInstances | null>(null);
  const packedRef = useRef<ReturnType<SolidInstances["layers"]>>([]);
  const packed = useMemo(() => {
    const c = (cache.current ??= new SolidInstances());
    const t0 = performance.now();
    const [t, l] = tier.split(":").map(Number) as [0 | 1 | 2, 0 | 1 | 2];
    if (c.update(propsAndBuildings(), t, l) || !packedRef.current.length) packedRef.current = c.layers();
    const R = rt() as unknown as { solidsStats?: object };
    R.solidsStats = { ms: +(performance.now() - t0).toFixed(2), rebuilt: c.lastRebuilt, instances: c.count, entities: c.entityCount, layers: packedRef.current.length };
    return packedRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldVersion, tier]);
  const layers = useMemo(() => {
    const R = rt();
    // ?solids=0 leaves the library geometry out (performance comparisons)
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("solids") === "0") return null;
    return packed.length ? solidLayers(packed, { origin: [R.meta.origin.lon, R.meta.origin.lat, 0], night: theme === "night" }) : null;
  }, [packed, theme]);
  useLayerSlot("library-solids", "solid", layers);
  return null;
}
