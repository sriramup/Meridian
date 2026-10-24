"use client";

import { useEffect } from "react";
import { rt } from "@/state/runtime";
import { useApp, type CameraMode } from "@/state/store";

/** how far to tilt while walking: from looking down at the pavement to the horizon */
const PITCH = [50, 85] as const;

/**
 * Street level: an eye-level camera. Drag to look around (the view follows the hand, as the map
 * does above), W A S D or the arrow keys walk, Shift runs, Q / E turn, scroll steps forward or back.
 * The map's own pan, zoom and arrow keys are off while walking so nothing pulls the eye away.
 */
export function usePedestrianControls(mode: CameraMode) {
  useEffect(() => {
    const map = rt().map;
    if (!map || mode !== "pedestrian") return;
    map.dragPan.disable();
    map.scrollZoom.disable();
    map.doubleClickZoom.disable();
    map.keyboard.disable();
    const canvas = map.getCanvasContainer();
    canvas.style.cursor = "grab";

    // walk relative to where the eye looks
    const walk = (fwd: number, side: number, metres: number) => {
      const b = (map.getBearing() * Math.PI) / 180;
      const c = map.getCenter();
      const mLat = 111132;
      const mLon = 111320 * Math.cos((c.lat * Math.PI) / 180);
      const dx = (Math.sin(b) * fwd + Math.cos(b) * side) * metres;
      const dy = (Math.cos(b) * fwd - Math.sin(b) * side) * metres;
      map.jumpTo({ center: [c.lng + dx / mLon, c.lat + dy / mLat] });
    };

    // drag to look around
    const look = (e: { originalEvent: MouseEvent; preventDefault: () => void }) => {
      const o = e.originalEvent;
      if (o.button !== 0 || o.shiftKey || o.altKey || o.ctrlKey || o.metaKey) return;
      e.preventDefault();
      const x0 = o.clientX,
        y0 = o.clientY;
      const b0 = map.getBearing(),
        p0 = map.getPitch();
      canvas.style.cursor = "grabbing";
      const mm = (ev: MouseEvent) => map.jumpTo({ bearing: b0 - (ev.clientX - x0) * 0.25, pitch: Math.max(PITCH[0], Math.min(PITCH[1], p0 + (ev.clientY - y0) * 0.2)) });
      const mu = () => {
        canvas.style.cursor = "grab";
        window.removeEventListener("mousemove", mm);
        window.removeEventListener("mouseup", mu);
      };
      window.addEventListener("mousemove", mm);
      window.addEventListener("mouseup", mu);
    };
    map.on("mousedown", look);

    // scroll to step forward or back
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      walk(-Math.sign(e.deltaY), 0, Math.min(3, Math.abs(e.deltaY) * 0.02));
    };
    canvas.addEventListener("wheel", wheel, { passive: false });

    const keys = new Set<string>();
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable]")) return;
      const k = e.key.toLowerCase();
      if (k.startsWith("arrow")) e.preventDefault();
      keys.add(k);
    };
    const up = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    const blur = () => keys.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    let raf = 0;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (keys.size) {
        let fwd = 0,
          side = 0,
          turn = 0;
        if (keys.has("w") || keys.has("arrowup")) fwd += 1;
        if (keys.has("s") || keys.has("arrowdown")) fwd -= 1;
        if (keys.has("a")) side -= 1;
        if (keys.has("d")) side += 1;
        if (keys.has("q") || keys.has("arrowleft")) turn -= 1;
        if (keys.has("e") || keys.has("arrowright")) turn += 1;
        if (fwd || side) walk(fwd, side, (keys.has("shift") ? 9 : 2.2) * dt);
        if (turn) map.jumpTo({ bearing: map.getBearing() + turn * 70 * dt });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      map.off("mousedown", look);
      canvas.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      map.dragPan.enable();
      map.scrollZoom.enable();
      map.keyboard.enable();
      // double-click zoom stays off while a drawing tool is in hand (it finishes shapes)
      if (useApp.getState().tool === "select") map.doubleClickZoom.enable();
      canvas.style.cursor = "";
    };
  }, [mode]);
}
