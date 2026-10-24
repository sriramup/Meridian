"use client";

import { useEffect } from "react";
import { rt } from "@/state/runtime";
import type { CameraMode } from "@/state/store";

/**
 * Pedestrian mode: eye-level camera (~1.7 m) at maximum pitch. WASD / arrow keys
 * walk relative to the view direction, Q/E turn, Shift runs. Mouse drag looks around.
 */
export function usePedestrianControls(mode: CameraMode) {
  useEffect(() => {
    const map = rt().map;
    if (!map || mode !== "pedestrian") return;
    const keys = new Set<string>();
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,[contenteditable]")) return;
      keys.add(e.key.toLowerCase());
    };
    const up = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    let raf = 0;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (keys.size) {
        const speed = (keys.has("shift") ? 9 : 2.2) * dt; // metres per frame
        let fwd = 0,
          side = 0,
          turn = 0;
        if (keys.has("w") || keys.has("arrowup")) fwd += 1;
        if (keys.has("s") || keys.has("arrowdown")) fwd -= 1;
        if (keys.has("a")) side -= 1;
        if (keys.has("d")) side += 1;
        if (keys.has("q") || keys.has("arrowleft")) turn -= 1;
        if (keys.has("e") || keys.has("arrowright")) turn += 1;
        const b = (map.getBearing() * Math.PI) / 180;
        const c = map.getCenter();
        const mLat = 111132;
        const mLon = 111320 * Math.cos((c.lat * Math.PI) / 180);
        const dx = (Math.sin(b) * fwd + Math.cos(b) * side) * speed * 1;
        const dy = (Math.cos(b) * fwd - Math.sin(b) * side) * speed * 1;
        map.jumpTo({ center: [c.lng + dx / mLon, c.lat + dy / mLat], bearing: map.getBearing() + turn * 60 * dt });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [mode]);
}
