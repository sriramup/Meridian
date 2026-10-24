import { rtMaybe } from "@/state/runtime";
import { LocalProjection } from "@/world/projection";
import { closestOnPath, polyLength } from "@/geometry/polyline";
import type { Vec2 } from "@/world/types";

function ctx() {
  const R = rtMaybe();
  if (!R?.map) return null;
  return { map: R.map, proj: new LocalProjection(R.meta.origin.lon, R.meta.origin.lat), R };
}

let orbitRaf = 0;
export function stopOrbit() {
  cancelAnimationFrame(orbitRaf);
  orbitRaf = 0;
}

export function flyTo(p: Vec2, opts: { zoom?: number; pitch?: number; bearing?: number; duration?: number } = {}) {
  const c = ctx();
  if (!c) return;
  stopOrbit();
  c.map.flyTo({
    center: c.proj.toLonLat(p),
    zoom: opts.zoom ?? Math.max(16.4, Math.min(17.4, c.map.getZoom())),
    pitch: opts.pitch ?? 60,
    bearing: opts.bearing ?? c.map.getBearing(),
    duration: opts.duration ?? 2200,
    curve: 1.3,
    essential: true,
  });
}

export function overview() {
  const c = ctx();
  if (!c) return;
  stopOrbit();
  const iv = c.R.meta.initialView;
  c.map.flyTo({ center: c.proj.toLonLat(iv.center), zoom: iv.zoom - 0.3, pitch: iv.pitch, bearing: iv.bearing, duration: 2400, curve: 1.2 });
}

/** compass bearing down the nearest street, toward its longer stretch from p (the view a person would take) */
export function streetBearingAt(p: Vec2): number | null {
  const R = rtMaybe();
  if (!R) return null;
  let best: { d: number; dir: Vec2; ahead: number } | null = null;
  for (const e of R.world.query([p[0] - 40, p[1] - 40, p[0] + 40, p[1] + 40], ["street"])) {
    if (e.kind !== "street" || e.cls === "service" || e.tunnel) continue;
    const c = closestOnPath(p, e.path);
    if (best && c.d >= best.d) continue;
    const a = e.path[c.seg],
      b = e.path[c.seg + 1] ?? a;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const total = polyLength(e.path);
    // look toward whichever end of the street is farther away
    const fwd = c.along < total / 2;
    best = { d: c.d, dir: fwd ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [(a[0] - b[0]) / L, (a[1] - b[1]) / L], ahead: fwd ? total - c.along : c.along };
  }
  if (!best) return null;
  return ((Math.atan2(best.dir[0], best.dir[1]) * 180) / Math.PI + 360) % 360;
}

/** eye-level view (≈1.7 m) looking along `bearing` (defaults to down the nearest street) */
export function pedestrianAt(p: Vec2, bearing?: number) {
  const c = ctx();
  if (!c) return;
  stopOrbit();
  c.map.flyTo({ center: c.proj.toLonLat(p), zoom: 22.4, pitch: 84, bearing: bearing ?? streetBearingAt(p) ?? c.map.getBearing(), duration: 3200, curve: 1.6 });
}

export function orbit(p: Vec2, seconds = 30) {
  const c = ctx();
  if (!c) return;
  stopOrbit();
  c.map.flyTo({ center: c.proj.toLonLat(p), zoom: 17, pitch: 62, duration: 1800 });
  const start = performance.now() + 1900;
  const b0 = c.map.getBearing();
  const step = () => {
    const t = performance.now() - start;
    if (t > 0) c.map.jumpTo({ bearing: b0 + (t / 1000) * (360 / 90) });
    if (t < seconds * 1000) orbitRaf = requestAnimationFrame(step);
  };
  orbitRaf = requestAnimationFrame(step);
  const stop = () => {
    stopOrbit();
    c.map.off("mousedown", stop);
    c.map.off("wheel", stop);
  };
  c.map.on("mousedown", stop);
  c.map.on("wheel", stop);
}

export async function flyover(points: Vec2[]) {
  const c = ctx();
  if (!c || !points.length) return;
  stopOrbit();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const next = points[i + 1] ?? points[i];
    const bearing = (Math.atan2(next[0] - p[0], next[1] - p[1]) * 180) / Math.PI;
    await new Promise<void>((resolve) => {
      c.map.once("moveend", () => resolve());
      c.map.flyTo({ center: c.proj.toLonLat(p), zoom: 17.2, pitch: 65, bearing: i === points.length - 1 ? c.map.getBearing() + 40 : bearing, duration: 3000, curve: 1.1 });
    });
    await new Promise((r) => setTimeout(r, 600));
  }
}

export function currentView() {
  const c = ctx();
  if (!c) return null;
  const ce = c.map.getCenter();
  return { center: c.proj.toLocal(ce.lng, ce.lat), zoom: c.map.getZoom(), pitch: c.map.getPitch(), bearing: c.map.getBearing() };
}

// ── turning and tilting (orbit about the view centre) ──

const turnMs = 260;

/** turn the view `deg` clockwise (positive: the camera swings to face further east) */
export function turn(deg: number) {
  const c = ctx();
  if (!c) return;
  stopOrbit();
  c.map.easeTo({ bearing: c.map.getBearing() + deg, duration: turnMs });
}

/** tilt toward the horizon (+) or down to plan view (−), within the map's pitch limits */
export function tilt(deg: number) {
  const c = ctx();
  if (!c) return;
  stopOrbit();
  c.map.easeTo({ pitch: Math.max(0, Math.min(c.map.getMaxPitch(), c.map.getPitch() + deg)), duration: turnMs });
}

/** face north; when already facing north, toggle between plan view and a 3D view */
export function faceNorth() {
  const c = ctx();
  if (!c) return;
  stopOrbit();
  const b = c.map.getBearing();
  if (Math.abs(b) > 0.5) c.map.easeTo({ bearing: 0, duration: 500 });
  else c.map.easeTo({ pitch: c.map.getPitch() > 5 ? 0 : 55, duration: 500 });
}

/**
 * Orbit from a drag that started at (x0, y0): sideways turns, up/down tilts. Returns the move
 * handler; it holds the start view, so the camera follows the pointer without drift.
 */
export function orbitDrag(x0: number, y0: number): (x: number, y: number) => void {
  const c = ctx();
  if (!c) return () => {};
  stopOrbit();
  c.map.stop();
  const b0 = c.map.getBearing(),
    p0 = c.map.getPitch();
  return (x, y) => c.map.jumpTo({ bearing: b0 + (x - x0) * 0.5, pitch: Math.max(0, Math.min(c.map.getMaxPitch(), p0 - (y - y0) * 0.4)) });
}

/** drags that orbit instead of panning: middle button, or Shift / Alt (Option) with the left button */
export function isOrbitDrag(e: MouseEvent): boolean {
  return e.button === 1 || (e.button === 0 && (e.shiftKey || e.altKey));
}
