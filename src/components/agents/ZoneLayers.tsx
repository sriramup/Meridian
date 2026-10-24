"use client";

import { useMemo } from "react";
import { useLayerSlot } from "@/render/layerSlots";
import { zoneLayers, type ZoneDatum, type ZonePreview } from "@/render/zoneLayers";
import { rtMaybe } from "@/state/runtime";
import { polyArea } from "@/geometry/polygon";
import { formatArea, sessionColor } from "./model";
import { useSessions, useViewing } from "./store";
import { rectRing, useZoneDraw } from "./zoneDraw";

/**
 * Every agent's zone on the map (the viewed agent's drawn stronger) and the zone being drawn.
 * While the pane is closed only the zones of agents that are working stay visible.
 */
export function ZoneLayers({ paneOpen }: { paneOpen: boolean }) {
  const sessions = useSessions();
  const viewing = useViewing();
  const draw = useZoneDraw();

  const zones = useMemo<ZoneDatum[]>(
    () =>
      sessions
        .filter((s) => s.zone && (paneOpen || s.status === "running" || s.status === "needs_input"))
        .map((s) => ({ key: s.id, poly: s.zone!.poly, color: sessionColor(s.id), title: s.title, emphasis: paneOpen && s.id === viewing })),
    [sessions, viewing, paneOpen],
  );

  const preview = useMemo<ZonePreview | null>(() => {
    if (!draw.mode) return null;
    const color = sessionColor(draw.sessionId ?? "new");
    if (draw.mode === "rect") {
      if (!draw.points.length || !draw.cursor) return null;
      const ring = rectRing(draw.points[0], draw.cursor);
      return { ring, corners: [], closed: true, color, label: formatArea(Math.abs(polyArea([ring]))) };
    }
    const ring = draw.cursor ? [...draw.points, draw.cursor] : draw.points;
    return { ring, corners: draw.points, closed: ring.length >= 3, color, label: ring.length >= 3 ? formatArea(Math.abs(polyArea([ring]))) : null };
  }, [draw]);

  const layers = useMemo(() => {
    const R = rtMaybe();
    if (!R || (!zones.length && !preview)) return null;
    return zoneLayers(R, zones, preview);
  }, [zones, preview]);

  useLayerSlot("agent-zones", "ground", layers?.ground ?? null);
  useLayerSlot("agent-zones-top", "top", layers?.top ?? null);
  return null;
}
