"use client";

// Street level, modelled on Street View: a cursor on the ground follows the pointer, a click walks
// there (a click on a facade walks up to it, a far click a hop along the street), chevrons on the
// ground step along the street, dragging looks around (with a little glide), scroll or pinch zooms
// the view and a double-click jumps straight to a spot. No keys to learn: Esc goes back up.

import { useEffect, useMemo } from "react";
import { viewCenter } from "@/agent/resolve";
import { useLayerSlot } from "@/render/layerSlots";
import { eyeState, eyeView, isWalking, look, onEyeChange, pedestrianAt, restore, streetEnv, streetPhase, walkTo, zoomFov } from "@/render/streetView";
import { rt } from "@/state/runtime";
import { useApp, type CameraMode } from "@/state/store";
import { facadeLayers, groundLayers, useStreetView, type GroundCursor } from "./pedestrian/layers";
import { alongStreet, blockedAt, chevronAt, chevronDirs, chevronLayout, CLEAR, firstWall, hopTarget, jumpTarget, sightAt, STEP, type Chevron, type Sight } from "./pedestrian/walk";
import type { Vec2 } from "@/world/types";

/** pointer travel (px) that turns a press into a look-around drag */
const DRAG_PX = 4;
/** the glide after a flick: time constant (ms) */
const GLIDE_MS = 240;

export function usePedestrianControls(mode: CameraMode) {
  useStreetViewLayers(mode === "pedestrian");
  useEffect(() => {
    const map = rt().map;
    if (!map || mode !== "pedestrian") return;
    useApp.getState().setHover(null);
    // arriving without a destination (e.g. a mode switch from elsewhere): step down at the view centre
    if (streetPhase() === "off") pedestrianAt(viewCenter());

    const handlers = [map.dragPan, map.scrollZoom, map.doubleClickZoom, map.keyboard, map.dragRotate, map.touchZoomRotate, map.touchPitch, map.boxZoom];
    const wasOn = handlers.map((h) => h.isEnabled());
    handlers.forEach((h) => h.disable());
    const el = map.getCanvasContainer();
    const setCss = (c: string) => (el.style.cursor = c);
    setCss("grab");

    const env = streetEnv();
    const ready = () => streetPhase() === "on" && useApp.getState().tool === "select";
    let pointer: { x: number; y: number } | null = null;

    // ── the cursor and chevrons (recomputed at most once a frame) ──
    let chevKey = "";
    let dirs: Vec2[] = [];
    let lastLayout: { key: string; chevs: Chevron[] } = { key: "", chevs: [] };
    const chevrons = (): Chevron[] => {
      if (!env || streetPhase() !== "on" || isWalking()) return [];
      const e = eyeState();
      const key = `${Math.round(e.eye[0] * 2)},${Math.round(e.eye[1] * 2)}`;
      if (key !== chevKey) {
        chevKey = key;
        dirs = chevronDirs(env, e.eye);
      }
      // the same layout while the eye stays put (a zoom, a still frame) keeps the layers as they are
      const layoutKey = `${key},${Math.round(e.bearing * 4)},${dirs.length}`;
      if (layoutKey !== lastLayout.key) {
        // facing a wall close by, the ring comes nearer so it stays on the sidewalk
        const b = (e.bearing * Math.PI) / 180;
        const wall = firstWall(env, e.eye, [e.eye[0] + Math.sin(b) * 8, e.eye[1] + Math.cos(b) * 8]);
        const ahead = wall ? Math.max(2.4, Math.hypot(wall.p[0] - e.eye[0], wall.p[1] - e.eye[1]) - 1.5) : 5.6;
        const ring = chevronLayout(e.eye, e.bearing, dirs, ahead);
        // an arrow that would lie under a wall (a narrow sidewalk) tucks in toward the ring's centre, or is left out
        const clear = ring.map((c) => (blockedAt(env, c.at, 0) ? (chevronLayout(e.eye, e.bearing, [c.dir], ahead, 0.55)[0] ?? c) : c)).filter((c) => !blockedAt(env, c.at, 0));
        lastLayout = { key: layoutKey, chevs: clear };
      }
      return lastLayout.chevs;
    };
    const sight = (x: number, y: number) => {
      const v = eyeView();
      return v && env ? sightAt(env, v, x, y) : null;
    };
    // a facade: walk up to it (the ground just in front of the wall)
    const aimOf = (s: Sight): Vec2 => (s.kind === "wall" ? [s.p[0] + s.normal[0] * CLEAR * 1.5, s.p[1] + s.normal[1] * CLEAR * 1.5] : s.p);
    const cursorAt = (x: number, y: number, chevs: Chevron[]): { cursor: GroundCursor | null; hot: number | null } => {
      if (!env || !ready()) return { cursor: null, hot: null };
      const s = sight(x, y);
      if (!s) return { cursor: null, hot: null };
      if (s.kind === "ground") {
        const c = chevronAt(chevs, s.p);
        if (c) return { cursor: null, hot: chevs.indexOf(c) };
      }
      // the disc and the panel grow with distance so they stay readable, as Street View's do
      const r = Math.max(0.35, Math.min(4, 0.22 + s.dist * 0.035));
      if (s.kind === "wall") return { cursor: { kind: "facade", p: s.p, normal: s.normal, z: s.z, w: Math.max(1.4, Math.min(10, s.dist * 0.13)) }, hot: null };
      if (blockedAt(env, s.p, 0)) return { cursor: { kind: "blocked", p: s.p, r }, hot: null };
      return { cursor: { kind: "ground", p: s.p, r }, hot: null };
    };
    let raf = 0;
    const refresh = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const chevs = chevrons();
        const { cursor, hot } = pointer && !drag?.moved ? cursorAt(pointer.x, pointer.y, chevs) : { cursor: null, hot: null };
        const cur = useStreetView.getState();
        // only what changed (each change re-stacks the map's layers)
        if (cur.chevrons !== chevs || cur.hot !== hot || !sameCursor(cur.cursor, cursor)) cur.set({ chevrons: chevs, cursor, hot });
        if (!drag) setCss(hot != null ? "pointer" : "grab");
      });
    };
    const offEye = onEyeChange(refresh);

    // ── moving ──
    const hop = (x: number, y: number) => {
      if (!env || !ready()) return;
      const s = sight(x, y);
      if (!s) return;
      const eye = eyeState().eye;
      const c = s.kind === "ground" ? chevronAt(chevrons(), s.p) : null;
      if (c) return step(c.dir);
      const h = hopTarget(env, eye, aimOf(s));
      if (h) walkTo(h.target);
    };
    const step = (dir: Vec2) => {
      if (!env) return;
      const e = eyeState();
      const t = alongStreet(env, e.eye, dir, STEP);
      if (!t) return;
      // face the way the chevron leads when it pointed off to the side or behind
      const b = (Math.atan2(dir[0], dir[1]) * 180) / Math.PI;
      const off = Math.abs((((b - e.bearing) % 360) + 540) % 360 - 180);
      walkTo(t, off > 50 ? { bearing: b } : {});
    };
    /** the ground spot a click aims at: under the pointer, or in front of the facade it rests on */
    const aimAt = (x: number, y: number): Vec2 | null => {
      const s = sight(x, y);
      return s ? aimOf(s) : null;
    };
    const jump = (ground: Vec2) => {
      if (!env || !ready()) return;
      const t = jumpTarget(env, eyeState().eye, ground);
      if (t) walkTo(t);
    };

    // ── pointer: click to move, drag to look (with a glide), pinch to zoom ──
    let drag: { id: number; x: number; y: number; lx: number; ly: number; moved: boolean; v: [number, number]; t: number } | null = null;
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: number | null = null;
    let glide = 0;
    let lastClick: { t: number; x: number; y: number; ground: Vec2 | null } | null = null;
    const local = (e: PointerEvent | MouseEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const degPerPx = () => {
      const v = eyeView();
      return v ? v.fov / Math.max(1, v.height) : 0.06;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !ready()) return;
      cancelAnimationFrame(glide);
      touches.set(e.pointerId, local(e));
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        drag = null;
        return;
      }
      const p = local(e);
      drag = { id: e.pointerId, x: p.x, y: p.y, lx: p.x, ly: p.y, moved: false, v: [0, 0], t: performance.now() };
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const p = local(e);
      if (touches.has(e.pointerId)) touches.set(e.pointerId, p);
      if (pinch != null && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 0) zoomFov(pinch / d);
        pinch = d;
        return;
      }
      pointer = e.pointerType === "mouse" ? p : null;
      if (drag && drag.id === e.pointerId) {
        if (!drag.moved && Math.hypot(p.x - drag.x, p.y - drag.y) > DRAG_PX) {
          drag.moved = true;
          setCss("grabbing");
        }
        if (drag.moved) {
          // grab the scene: it follows the hand
          const k = degPerPx();
          const dx = p.x - drag.lx,
            dy = p.y - drag.ly;
          const now = performance.now();
          const dt = Math.max(1, now - drag.t);
          drag.v = [0.6 * drag.v[0] + 0.4 * ((-dx * k) / dt), 0.6 * drag.v[1] + 0.4 * ((dy * k) / dt)];
          drag.t = now;
          look(-dx * k, dy * k);
        }
        drag.lx = p.x;
        drag.ly = p.y;
      }
      refresh();
    };
    const up = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag;
      drag = null;
      setCss("grab");
      if (d.moved) {
        // glide on after a flick, unless the hand stopped before letting go
        if (performance.now() - d.t < 60 && Math.hypot(d.v[0], d.v[1]) > 0.02) {
          let v = d.v;
          let t0 = performance.now();
          const tick = () => {
            const now = performance.now();
            const dt = now - t0;
            t0 = now;
            v = [v[0] * Math.exp(-dt / GLIDE_MS), v[1] * Math.exp(-dt / GLIDE_MS)];
            look(v[0] * dt, v[1] * dt);
            if (Math.hypot(v[0], v[1]) > 0.002) glide = requestAnimationFrame(tick);
          };
          glide = requestAnimationFrame(tick);
        }
        refresh();
        return;
      }
      // a click: the second click of a double-click waits for the jump instead of hopping again
      const p = local(e);
      const now = performance.now();
      if (lastClick && now - lastClick.t < 380 && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < 8) return;
      lastClick = { t: now, x: p.x, y: p.y, ground: aimAt(p.x, p.y) };
      hop(p.x, p.y);
    };
    const dbl = (e: MouseEvent) => {
      e.preventDefault();
      const p = local(e);
      const g = lastClick && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < 8 ? lastClick.ground : aimAt(p.x, p.y);
      lastClick = null;
      if (g) jump(g);
    };
    const leave = () => {
      pointer = null;
      refresh();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!ready()) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      // pinch on a trackpad arrives as ctrl + wheel and is finer
      zoomFov(Math.exp(Math.max(-0.5, Math.min(0.5, dy * (e.ctrlKey ? 0.01 : 0.0015)))));
      refresh();
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("dblclick", dbl);
    el.addEventListener("wheel", wheel, { passive: false });
    // the eye's height depends on the canvas size: re-place the camera when it changes
    const resize = () => look(0, 0);
    map.on("resize", resize);
    refresh();

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(glide);
      offEye();
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("dblclick", dbl);
      el.removeEventListener("wheel", wheel);
      map.off("resize", resize);
      handlers.forEach((h, i) => wasOn[i] && h.enable());
      // double-click zoom stays off while a drawing tool is in hand (it finishes shapes)
      if (useApp.getState().tool !== "select") map.doubleClickZoom.disable();
      setCss("");
      useStreetView.getState().set({ cursor: null, chevrons: [], hot: null });
      // left by some other route than the exit control (an agent's camera move): put the map back
      if (streetPhase() === "on" || streetPhase() === "entering") restore();
    };
  }, [mode]);
}

const sameCursor = (a: GroundCursor | null, b: GroundCursor | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && Math.abs(a.p[0] - b.p[0]) < 0.02 && Math.abs(a.p[1] - b.p[1]) < 0.02 && (a.kind !== "facade" || (b.kind === "facade" && Math.abs(a.z - b.z) < 0.02)));

/** the ground cursor and chevrons, contributed to the map's layer slots */
function useStreetViewLayers(on: boolean) {
  const cursor = useStreetView((s) => s.cursor);
  const chevrons = useStreetView((s) => s.chevrons);
  const hot = useStreetView((s) => s.hot);
  const origin = useMemo<[number, number, number] | null>(() => {
    if (!on) return null;
    const R = rt();
    return [R.meta.origin.lon, R.meta.origin.lat, 0];
  }, [on]);
  const ground = useMemo(() => (origin ? groundLayers(origin, cursor, chevrons, hot) : null), [origin, cursor, chevrons, hot]);
  const facade = useMemo(() => (origin ? facadeLayers(origin, cursor) : null), [origin, cursor]);
  useLayerSlot("street-view", "ground", ground);
  useLayerSlot("street-view-facade", "solid", facade);
}
