"use client";

// Drawing a session's zone on the map: a rectangle dragged out with the map's panning suspended, or
// a polygon clicked corner by corner (Enter, a double-click or clicking the first corner finishes;
// Backspace removes the last corner; Esc cancels). While a zone is being drawn a transparent surface
// over the map takes the pointer (so the map's selection and drawing tools never see these clicks);
// the wheel still zooms and, for polygons, a drag still pans.

import { create } from "zustand";
import type { Zone } from "@/agent/types";
import { zoneFromPolygon } from "@/agent/zones";
import { draw, resetDraw } from "@/state/drawing";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { LocalProjection } from "@/world/projection";
import type { Vec2 } from "@/world/types";

export type DrawMode = "rect" | "poly";

interface ZoneDrawState {
  mode: DrawMode | null;
  /** the session the zone is for (its colour is used for the preview) */
  sessionId: string | null;
  /** rect: [anchor] while dragging; poly: the placed corners */
  points: Vec2[];
  cursor: Vec2 | null;
}

export const useZoneDraw = create<ZoneDrawState>(() => ({ mode: null, sessionId: null, points: [], cursor: null }));

let resolver: ((z: Zone | null) => void) | null = null;

/** start drawing; resolves with the zone, or null when cancelled */
export function startZoneDraw(mode: DrawMode, sessionId: string | null): Promise<Zone | null> {
  resolver?.(null);
  // one map interaction at a time: put any drawing tool down first
  const st = useApp.getState();
  if (st.tool !== "select" || draw.points.length) {
    resetDraw();
    st.setTool("select");
  }
  useZoneDraw.setState({ mode, sessionId, points: [], cursor: null });
  return new Promise((r) => (resolver = r));
}

export function cancelZoneDraw() {
  end(null);
}

function end(z: Zone | null) {
  const r = resolver;
  resolver = null;
  useZoneDraw.setState({ mode: null, sessionId: null, points: [], cursor: null });
  r?.(z);
}

export function zoneFromRing(ring: Vec2[]): Zone {
  return zoneFromPolygon([ring], { label: "Drawn area", source: "drawn" });
}

/** axis-aligned on screen would skew under rotation; the rectangle is aligned to local metres instead */
export function rectRing(a: Vec2, b: Vec2): Vec2[] {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** counter-clockwise, as the Zone contract asks */
function ccw(ring: Vec2[]): Vec2[] {
  return signedArea(ring) > 0 ? ring : ring.slice().reverse();
}
function signedArea(r: Vec2[]) {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** finish the polygon being drawn (needs three corners) */
export function finishPolygon() {
  const { mode, points } = useZoneDraw.getState();
  if (mode !== "poly" || points.length < 3) return;
  end(zoneFromRing(ccw(points)));
}

export function finishRect(a: Vec2, b: Vec2) {
  const ring = rectRing(a, b);
  // a click without a real drag isn't a zone
  if (Math.abs(ring[1][0] - ring[0][0]) < 4 || Math.abs(ring[2][1] - ring[1][1]) < 4) {
    useZoneDraw.setState({ points: [], cursor: b });
    return;
  }
  end(zoneFromRing(ccw(ring)));
}

export function addCorner(p: Vec2) {
  useZoneDraw.setState((s) => ({ points: [...s.points, p] }));
}

export function removeCorner() {
  useZoneDraw.setState((s) => ({ points: s.points.slice(0, -1) }));
}

export function setDrawCursor(p: Vec2 | null) {
  useZoneDraw.setState({ cursor: p });
}

/** screen point (relative to the map container) to local metres */
export function screenToLocal(x: number, y: number): Vec2 | null {
  const R = rtMaybe();
  if (!R?.map) return null;
  const ll = R.map.unproject([x, y]);
  return new LocalProjection(R.meta.origin.lon, R.meta.origin.lat).toLocal(ll.lng, ll.lat);
}

export function localToScreen(p: Vec2): [number, number] | null {
  const R = rtMaybe();
  if (!R?.map) return null;
  const [lon, lat] = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat).toLonLat(p);
  const s = R.map.project([lon, lat]);
  return [s.x, s.y];
}

/** bring a zone into view (keeps the current pitch and bearing) */
export function zoomToZone(poly: Vec2[][]) {
  const R = rtMaybe();
  const ring = poly[0];
  if (!R?.map || !ring?.length) return;
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of ring) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const sw = proj.toLonLat([x0, y0]);
  const ne = proj.toLonLat([x1, y1]);
  R.map.fitBounds([sw, ne], { padding: 90, maxZoom: 16.5, pitch: R.map.getPitch(), bearing: R.map.getBearing(), duration: 900 });
}
