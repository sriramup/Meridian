"use client";

import type { Layer } from "@deck.gl/core";
import { useMemo } from "react";
import { useApp } from "@/state/store";
import { useSims } from "@/sim/client";
import { RASTER_OVERLAYS, impactPins, kerbLines, overlayLayers } from "@/render/overlays";
import { useImpact } from "@/sim/impact";
import { toolLayers } from "@/render/toolLayers";
import { useLod } from "@/render/lod";

/** analysis overlays, recomputed only when their inputs change */
export function useExtraLayers(): { ground: Layer[]; top: Layer[] } {
  const overlay = useApp((s) => s.overlay);
  const overlayVersion = useApp((s) => s.overlayVersion);
  // hour only matters for time-varying overlays; quantised inside the selector so the map doesn't
  // re-render while the clock moves under an overlay that ignores it (day and night are uniforms)
  // heat cross-fades between modelled hours: follow the clock in 3-minute steps
  const h = useApp((s) => (overlay === "traffic" ? Math.floor(s.hour) : overlay === "heat" ? Math.round(s.hour * 20) / 20 : 0));
  const worldVersion = useApp((s) => s.worldVersion);
  const shown = useSims((s) => s.shown);
  const compare = useSims((s) => s.compare);
  return useMemo(() => {
    return overlayLayers(overlay, h, "model");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, overlayVersion, h, worldVersion, shown, compare]);
}

/** drawing / placement previews; kept out of the scene layers so cursor moves don't rebuild the city */
export function useToolLayers(): Layer[] {
  const toolVersion = useApp((s) => s.toolVersion);
  const tool = useApp((s) => s.tool);
  const planting = useApp((s) => s.planting);
  const worldVersion = useApp((s) => s.worldVersion);
  return useMemo(
    () => toolLayers().top,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toolVersion, tool, planting, worldVersion],
  );
}

/** degrees-saved pins per edit; only when zoomed in far enough for them to sit on their street */
export function useImpactLayers(zoom: number): Layer[] {
  const impact = useImpact((s) => s.impact);
  const overlay = useApp((s) => s.overlay);
  const near = zoom >= 15;
  return useMemo(() => (overlay === "heat" && near ? impactPins() : []), [impact, overlay, near]);
}

/** street-edge lines over raster overlays: full when close in, faded out as the camera pulls back */
export function useKerbLayers(zoom: number): Layer[] {
  const overlay = useApp((s) => s.overlay);
  const worldVersion = useApp((s) => s.worldVersion);
  // chunks stream in: pick up each newly built one (unchanged chunks keep their cached lines)
  const lod = useLod((s) => s.loaded);
  const t = Math.max(0, Math.min(1, (zoom - 14.4) / 1.6));
  const opacity = Math.round(t * t * (3 - 2 * t) * 10) / 10;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (overlay && RASTER_OVERLAYS.has(overlay) && opacity > 0 ? kerbLines(opacity) : []), [overlay, opacity, worldVersion, lod]);
}
