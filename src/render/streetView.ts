// Street View camera: an eye 1.7 m above the ground that hops from spot to spot, looks around by
// bearing and pitch, and zooms by narrowing its field of view (so the eye never leaves the ground).
// The eye's own state (position, heading, pitch, field of view) is the truth; every frame it is
// turned into a MapLibre camera, and deck.gl's view is kept on the same field of view.

import { MapView as DeckMapView } from "@deck.gl/core";
import { rtMaybe, type Runtime } from "@/state/runtime";
import { LocalProjection } from "@/world/projection";
import type { World } from "@/world/world";
import type { Polygon, Street, Vec2 } from "@/world/types";
import { closestOnPath, polyLength } from "@/geometry/polyline";
import { EYE, nearestSidewalk, type EyeView, type WalkEnv, type WalkStreet } from "@/components/pedestrian/walk";
import { stopOrbit } from "./camera";

/** field of view at street level: default and the zoom range (degrees, vertical) */
export const FOV = { normal: 62, min: 20, max: 80 } as const;
/** pitch range at street level (MapLibre: 90 is the horizon) */
export const PITCH = { min: 48, max: 89, normal: 86 } as const;

const WATER = new Set(["water", "retention"]);

/** the world as a person on foot sees it */
export function worldEnv(w: World): WalkEnv {
  const walkable = (e: Street) => !e.tunnel && e.cls !== "motorway" && e.cls !== "motorway_link";
  const toWalk = (e: Street): WalkStreet => ({ id: e.id, path: e.path, section: e.section, from: e.from, to: e.to });
  return {
    buildings: (b) => w.query(b, ["building"]).map((e) => ({ poly: (e as { footprint: Polygon }).footprint, height: (e as { height: number }).height })),
    water: (b) =>
      w
        .query(b, ["area"])
        .filter((e) => e.kind === "area" && WATER.has(e.type))
        .map((e) => (e as { poly: Polygon }).poly),
    streets: (b) =>
      w
        .query(b, ["street"])
        .filter((e): e is Street => e.kind === "street" && walkable(e))
        .map(toWalk),
    incident: (n) => w.incident(n).filter(walkable).map(toWalk),
  };
}

interface Eye {
  eye: Vec2;
  bearing: number;
  pitch: number;
  fov: number;
}

type Phase = "off" | "entering" | "on" | "leaving";

const S: Eye & { phase: Phase; saved: { maxZoom: number; maxPitch: number; fov: number } | null } = {
  eye: [0, 0],
  bearing: 0,
  pitch: PITCH.normal,
  fov: FOV.normal,
  phase: "off",
  saved: null,
};

let moveRaf = 0;
let fovRaf = 0;
const listeners = new Set<() => void>();
/** called whenever the eye moves or turns (layers that sit around the eye follow it) */
export function onEyeChange(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}
const emit = () => listeners.forEach((f) => f());

function ctx() {
  const R = rtMaybe();
  if (!R?.map) return null;
  return { map: R.map, R, proj: new LocalProjection(R.meta.origin.lon, R.meta.origin.lat) };
}

export const streetPhase = () => S.phase;
/** the eye as it is now (position, heading, pitch, field of view) */
export const eyeState = (): Readonly<Eye> => S;

/** the eye's view for picking ground points under the pointer */
export function eyeView(): EyeView | null {
  const c = ctx();
  if (!c) return null;
  const el = c.map.getCanvas();
  return { eye: S.eye, bearing: S.bearing, pitch: S.pitch, fov: S.fov, width: el.clientWidth, height: el.clientHeight };
}

export function streetEnv(): WalkEnv | null {
  const R = rtMaybe();
  return R ? worldEnv(R.world) : null;
}

/**
 * MapLibre camera for an eye at `e.eye`, EYE metres up. Computed directly: MapLibre's own
 * camera-from-position helper gives up close to the horizon (pitch > 84°), which is where a person looks.
 */
function cameraFor(c: NonNullable<ReturnType<typeof ctx>>, e: Eye) {
  const b = (e.bearing * Math.PI) / 180,
    p = (e.pitch * Math.PI) / 180;
  const ahead = EYE * Math.tan(p);
  const center = c.proj.toLonLat([e.eye[0] + Math.sin(b) * ahead, e.eye[1] + Math.cos(b) * ahead]);
  return { center, zoom: eyeZoom(EYE / Math.cos(p), e.fov, c.map.getCanvas().clientHeight, center[1]), bearing: e.bearing, pitch: e.pitch };
}

/** the MapLibre zoom that puts the camera `dist` metres from the centre for a canvas `height` px tall */
export function eyeZoom(dist: number, fov: number, height: number, lat: number) {
  const camPx = (0.5 / Math.tan((fov * Math.PI) / 360)) * height;
  const circumference = 2 * Math.PI * 6371008.8 * Math.cos((lat * Math.PI) / 180);
  return Math.log2((camPx * circumference) / (dist * 512));
}

/** keep deck.gl on the map's field of view, with a near plane close enough for things at arm's length */
function syncDeckView(R: Runtime, fov: number | null) {
  R.overlay?.setProps({ views: fov == null ? undefined : new DeckMapView({ id: "mapbox", fovy: fov, nearZMultiplier: 0.02 }) } as never);
}

function setFov(c: NonNullable<ReturnType<typeof ctx>>, fov: number) {
  syncDeckView(c.R, fov);
  c.map.setVerticalFieldOfView(fov);
}

function apply() {
  const c = ctx();
  if (!c) return;
  if (Math.abs(c.map.getVerticalFieldOfView() - S.fov) > 1e-3) setFov(c, S.fov);
  c.map.jumpTo(cameraFor(c, S));
  emit();
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrap = (a: number) => ((a % 360) + 540) % 360 - 180;

/** compass bearing down the nearest street, toward its longer stretch from p (the view a person would take) */
export function streetBearingAt(p: Vec2): number | null {
  const R = rtMaybe();
  if (!R) return null;
  let best: { d: number; dir: Vec2 } | null = null;
  for (const e of R.world.query([p[0] - 40, p[1] - 40, p[0] + 40, p[1] + 40], ["street"])) {
    if (e.kind !== "street" || e.cls === "service" || e.tunnel) continue;
    const c = closestOnPath(p, e.path);
    if (best && c.d >= best.d) continue;
    const a = e.path[c.seg],
      b = e.path[c.seg + 1] ?? a;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // look toward whichever end of the street is farther away
    const fwd = c.along < polyLength(e.path) / 2;
    best = { d: c.d, dir: fwd ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [(a[0] - b[0]) / L, (a[1] - b[1]) / L] };
  }
  if (!best) return null;
  return ((Math.atan2(best.dir[0], best.dir[1]) * 180) / Math.PI + 360) % 360;
}

/**
 * Step down into the street: the nearest sidewalk to p, looking along `bearing` (defaults to down
 * the street). The camera flies down to eye level, then the view widens to Street View's.
 */
export function pedestrianAt(p: Vec2, bearing?: number) {
  const c = ctx();
  if (!c) return;
  stopOrbit();
  cancelAnimationFrame(moveRaf);
  cancelAnimationFrame(fovRaf);
  const env = worldEnv(c.R.world);
  const spot = nearestSidewalk(env, p) ?? p;
  if (!S.saved) S.saved = { maxZoom: c.map.getMaxZoom(), maxPitch: c.map.getMaxPitch(), fov: c.map.getVerticalFieldOfView() };
  c.map.setMaxZoom(27);
  c.map.setMaxPitch(PITCH.max);
  S.eye = spot;
  S.bearing = bearing ?? streetBearingAt(spot) ?? c.map.getBearing();
  S.pitch = PITCH.normal;
  // fly down with the current field of view, then widen it on the spot
  const fov0 = c.map.getVerticalFieldOfView();
  S.fov = fov0;
  const target = cameraFor(c, S);
  S.phase = "entering";
  emit();
  const arrive = () => {
    if (S.phase !== "entering") return;
    S.phase = "on";
    animateFov(FOV.normal, 450);
  };
  c.map.once("moveend", arrive);
  c.map.flyTo({ ...target, duration: 2600, curve: 1.5, essential: true });
}

/** ease the field of view to `fov` with the eye held in place */
function animateFov(fov: number, ms: number, done?: () => void) {
  cancelAnimationFrame(fovRaf);
  const f0 = S.fov,
    t0 = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / ms);
    S.fov = f0 + (fov - f0) * ease(t);
    apply();
    if (t < 1) fovRaf = requestAnimationFrame(step);
    else done?.();
  };
  fovRaf = requestAnimationFrame(step);
}

/** back up above the street, over the spot where the walk ended */
export function leaveStreetView() {
  const c = ctx();
  if (!c || S.phase === "off") return;
  cancelAnimationFrame(moveRaf);
  c.map.stop();
  S.phase = "leaving";
  const fov0 = S.saved?.fov ?? 36.87;
  const up = () => {
    c.map.once("moveend", () => restore());
    c.map.flyTo({ center: c.proj.toLonLat(S.eye), zoom: 17.6, pitch: 58, bearing: S.bearing, duration: 2200, curve: 1.4, essential: true });
  };
  if (Math.abs(S.fov - fov0) > 0.5) animateFov(fov0, 280, up);
  else up();
}

/** put the map back as it was (limits, field of view); safe to call more than once */
export function restore() {
  const c = ctx();
  cancelAnimationFrame(moveRaf);
  cancelAnimationFrame(fovRaf);
  S.phase = "off";
  emit();
  if (!c || !S.saved) return;
  const saved = S.saved;
  S.saved = null;
  if (Math.abs(c.map.getVerticalFieldOfView() - saved.fov) > 1e-3) c.map.setVerticalFieldOfView(saved.fov);
  syncDeckView(c.R, null);
  // limits wait until any flight away from the street has finished (clamping mid-flight would jolt)
  const limits = () => {
    c.map.setMaxPitch(saved.maxPitch);
    c.map.setMaxZoom(saved.maxZoom);
  };
  if (c.map.isMoving()) c.map.once("moveend", limits);
  else limits();
}

/**
 * Walk to `to` along a straight line, eased, at a brisk walking pace. A new move during a move
 * starts from wherever the eye is. `bearing` turns the head on the way.
 */
export function walkTo(to: Vec2, opts: { bearing?: number; ms?: number } = {}) {
  if (S.phase !== "on") return;
  cancelAnimationFrame(moveRaf);
  const from: Vec2 = [S.eye[0], S.eye[1]];
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const ms = opts.ms ?? Math.max(450, Math.min(1800, 320 + d * 38));
  const b0 = S.bearing;
  const db = opts.bearing == null ? 0 : wrap(opts.bearing - b0);
  const t0 = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / ms);
    const k = ease(t);
    S.eye = [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
    if (db) S.bearing = b0 + db * k;
    apply();
    moveRaf = t < 1 ? requestAnimationFrame(step) : 0;
  };
  moveRaf = requestAnimationFrame(step);
}

export const isWalking = () => moveRaf !== 0 && S.phase === "on";

/** turn and tilt the head (degrees); pitch stays within the street-level range */
export function look(dBearing: number, dPitch: number) {
  if (S.phase !== "on") return;
  S.bearing = (S.bearing + dBearing + 360) % 360;
  S.pitch = Math.max(PITCH.min, Math.min(PITCH.max, S.pitch + dPitch));
  apply();
}

/** zoom by narrowing (factor < 1) or widening the field of view; the eye stays put */
export function zoomFov(factor: number) {
  if (S.phase !== "on") return;
  cancelAnimationFrame(fovRaf);
  S.fov = Math.max(FOV.min, Math.min(FOV.max, S.fov * factor));
  apply();
}

// test / automation hook: where the eye is
if (typeof window !== "undefined") (window as unknown as { __meridianStreetView: unknown }).__meridianStreetView = { eye: () => ({ ...S, eye: [...S.eye] }) };
