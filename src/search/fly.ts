// Fly the camera to a search result with a framing that suits it: a street or park fits its
// whole extent, a junction, address or shop gets a close oblique view.

import { stopOrbit } from "@/render/camera";
import { restore as restoreStreetView } from "@/render/streetView";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { LocalProjection } from "@/world/projection";
import type { Vec2 } from "@/world/types";
import type { World } from "@/world/world";
import type { PlaceResult } from "./placeIndex";

/** kinds framed by their extent (the rest are points seen close up) */
const EXTENT = new Set(["street", "trail", "district", "neighbourhood", "park", "campus", "water", "area", "bridge", "landmark", "building", "design"]);

/** room the chrome takes around the map (top bar, tool rail, analysis dock) */
const PADDING = { top: 96, bottom: 150, left: 96, right: 96 };

/**
 * Fly to `r`. Resolves when the camera arrives (or the flight is interrupted); false when there
 * is no map.
 */
export function flyToPlace(r: Pick<PlaceResult, "kind" | "point" | "bbox"> & { ids?: string[] }): Promise<boolean> {
  const R = rtMaybe();
  const map = R?.map;
  if (!R || !map) return Promise.resolve(false);
  stopOrbit();
  const st = useApp.getState();
  if (st.cameraMode === "pedestrian") {
    // straight from the street to the place: put the map's own limits back, then fly up and over
    restoreStreetView();
    st.setCameraMode("orbit");
  }
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  const [x0, y0, x1, y1] = r.bbox;
  const size = Math.max(x1 - x0, y1 - y0);
  let bearing = map.getBearing();
  let center = proj.toLonLat(r.point);
  // a point: close, but tilted only so far that the towers in front don't hide it
  let zoom = 17.4;
  let pitch = 45;
  const axis = (r.kind === "street" || r.kind === "trail") && r.ids ? lineAxis(R.world, r.ids) : null;
  if (axis && axis.len > 3 * Math.max(axis.wid, 40)) {
    // a long street: look along it, the whole length in view
    pitch = 52;
    const b = (Math.atan2(axis.u[0], axis.u[1]) * 180) / Math.PI;
    bearing = [b, b + 180].map((x) => ({ x, d: Math.abs(((x - map.getBearing() + 540) % 360) - 180) })).sort((p, q) => p.d - q.d)[0].x;
    const el = map.getContainer();
    const h = Math.max(200, el.clientHeight - PADDING.top - PADDING.bottom),
      w = Math.max(200, el.clientWidth - PADDING.left - PADDING.right);
    const mpp = Math.max((axis.len * Math.cos((pitch * Math.PI) / 180) * 1.5) / h, (axis.wid + 60) / w, 0.25);
    const lat = R.meta.origin.lat;
    zoom = Math.max(14, Math.min(18, Math.log2((40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * mpp))));
    // the near half of a tilted view takes more of the screen: aim a little beyond the middle
    const br = (bearing * Math.PI) / 180;
    center = proj.toLonLat([axis.mid[0] + Math.sin(br) * axis.len * 0.1, axis.mid[1] + Math.cos(br) * axis.len * 0.1]);
  } else if (EXTENT.has(r.kind) && size > 60) {
    const cam = map.cameraForBounds([proj.toLonLat([x0, y0]), proj.toLonLat([x1, y1])], { padding: PADDING, bearing, maxZoom: 18.4 });
    if (cam?.zoom !== undefined && cam.center) {
      // tilted views see further at the top: pull back a little
      zoom = Math.max(14, Math.min(18.4, cam.zoom - 0.25));
      const c = cam.center as { lng: number; lat: number } | [number, number];
      center = Array.isArray(c) ? c : [c.lng, c.lat];
      pitch = zoom < 15.5 ? 38 : zoom < 16.5 ? 48 : 55;
    }
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      map.off("moveend", finish);
      resolve(true);
    };
    map.on("moveend", finish);
    map.flyTo({ center, zoom, pitch, bearing, curve: 1.42, speed: 1.3, maxDuration: 3000, essential: true });
    // a flight that goes nowhere fires no moveend (a slow one still will)
    setTimeout(() => {
      if (!map.isMoving()) finish();
    }, 3400);
  });
}

/** a street's main direction (unit vector), its length along it and spread across it, and its middle */
export function lineAxis(w: World, ids: string[]): { u: Vec2; len: number; wid: number; mid: Vec2 } | null {
  const pts: Vec2[] = [];
  for (const id of ids) {
    const e = w.get(id);
    if (e && (e.kind === "street" || e.kind === "path")) pts.push(...e.path);
  }
  if (pts.length < 2) return null;
  let mx = 0,
    my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0,
    syy = 0,
    sxy = 0;
  for (const p of pts) {
    const dx = p[0] - mx,
      dy = p[1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const u: Vec2 = [Math.cos(ang), Math.sin(ang)];
  const v: Vec2 = [-u[1], u[0]];
  let t0 = Infinity,
    t1 = -Infinity,
    s0 = Infinity,
    s1 = -Infinity;
  for (const p of pts) {
    const dx = p[0] - mx,
      dy = p[1] - my;
    const t = dx * u[0] + dy * u[1],
      s = dx * v[0] + dy * v[1];
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
  }
  const tm = (t0 + t1) / 2,
    sm = (s0 + s1) / 2;
  return { u, len: t1 - t0, wid: s1 - s0, mid: [mx + u[0] * tm + v[0] * sm, my + u[1] * tm + v[1] * sm] };
}
