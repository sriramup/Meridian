"use client";

// The editing grid (sandbox by default, optional in cities) and the edge of the blank canvas,
// contributed through a layer slot. Lines thin out with zoom so the grid never turns into a grey
// wash: minor lines only show when they are a comfortable distance apart on screen; major lines
// every 100 ft (500 ft for the 100 ft grid). Also tracks Alt / Shift for snapping overrides.

import { COORDINATE_SYSTEM, type Layer, type Position } from "@deck.gl/core";
import { PathLayer } from "@deck.gl/layers";
import { useEffect, useMemo, useState } from "react";
import { useLayerSlot } from "@/render/layerSlots";
import { MODEL, NIGHT } from "@/render/theme";
import { rtMaybe } from "@/state/runtime";
import { gridOn, useSnap } from "@/state/snap";
import { useApp } from "@/state/store";
import { useNight } from "@/render/daylight";
import { FT } from "@/world/ops/snap";

const FLAT = { depthCompare: "always", depthWriteEnabled: false } as const;
type Line = { path: Position[]; major: number };

/** metres per screen pixel at the map's centre */
function metersPerPixel(): number {
  const map = rtMaybe()?.map;
  if (!map) return 1;
  const lat = map.getCenter().lat;
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
}

function useMapScale(): number {
  // quantised to half zoom levels: rebuilding on every zoom frame isn't needed
  const [mpp, setMpp] = useState(1);
  useEffect(() => {
    let off: (() => void) | null = null;
    const iv = setInterval(() => {
      const map = rtMaybe()?.map;
      if (!map) return;
      clearInterval(iv);
      let last = 0;
      const on = () => {
        const q = Math.round(map.getZoom() * 2) / 2;
        if (q === last) return;
        last = q;
        setMpp(metersPerPixel());
      };
      on();
      map.on("zoom", on);
      off = () => map.off("zoom", on);
    }, 200);
    return () => {
      clearInterval(iv);
      off?.();
    };
  }, []);
  return mpp;
}

function useModifierKeys() {
  useEffect(() => {
    const k = (e: KeyboardEvent | MouseEvent) => useSnap.getState().setMods({ alt: e.altKey, shift: e.shiftKey });
    const blur = () => useSnap.getState().setMods({ alt: false, shift: false });
    window.addEventListener("keydown", k, true);
    window.addEventListener("keyup", k, true);
    window.addEventListener("mousemove", k, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", k, true);
      window.removeEventListener("keyup", k, true);
      window.removeEventListener("mousemove", k, true);
      window.removeEventListener("blur", blur);
    };
  }, []);
}

export function gridLines(b: readonly number[], step: number, majorEvery: number, minor: boolean): Line[] {
  const out: Line[] = [];
  const push = (fixed: number, axis: 0 | 1, major: number) => out.push({ path: axis === 0 ? [[fixed, b[1]], [fixed, b[3]]] : [[b[0], fixed], [b[2], fixed]], major });
  const s = minor ? step : step * majorEvery;
  for (let i = Math.ceil(b[0] / s); i * s <= b[2]; i++) push(i * s, 0, minor ? (i % majorEvery ? 0 : 1) : 1);
  for (let i = Math.ceil(b[1] / s); i * s <= b[3]; i++) push(i * s, 1, minor ? (i % majorEvery ? 0 : 1) : 1);
  return out;
}

/** mounted once: the grid and the site edge */
export function SnapGrid() {
  useModifierKeys();
  const snap = useSnap();
  const on = gridOn(snap);
  // the grid follows the clock: light lines on dark ground at night (render/daylight.ts)
  const theme = useNight((s) => (s.night ? "night" : "model"));
  const status = useApp((s) => s.status);
  const mpp = useMapScale();
  const layers = useMemo((): Layer[] | null => {
    const R = rtMaybe();
    if (!R?.meta || status !== "ready") return null;
    const sandbox = !!R.meta.sandbox;
    if (!on && !sandbox) return null;
    const b = R.meta.bounds;
    const origin: [number, number, number] = [R.meta.origin.lon, R.meta.origin.lat, 0];
    const common = { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: origin };
    const T = theme === "night" ? NIGHT : MODEL;
    const ink = (theme === "night" ? T.land.map((c) => Math.min(255, c + 40)) : T.land.map((c) => Math.max(0, c - 44))) as [number, number, number];
    const out: Layer[] = [];
    if (on) {
      const step = snap.sizeFt * FT;
      const majorEvery = snap.sizeFt >= 100 ? 5 : Math.round(100 / snap.sizeFt);
      const minorPx = step / mpp;
      // major lines also thin out when even they crowd together
      const majorPx = (step * majorEvery) / mpp;
      if (majorPx >= 6) {
        const minor = minorPx >= 9;
        const fade = Math.min(1, (minorPx - 9) / 12);
        out.push(
          new PathLayer<Line>({
            id: "snap-grid",
            ...common,
            data: gridLines(b, step, majorEvery, minor),
            getPath: (d) => d.path,
            getWidth: (d) => (d.major ? 1.1 : 0.8),
            widthUnits: "pixels",
            getColor: (d) => [...ink, d.major ? 120 : 55 * Math.max(0.3, fade)] as [number, number, number, number],
            updateTriggers: { getColor: [theme, fade] },
            parameters: FLAT,
          }),
        );
      }
    }
    if (sandbox)
      out.push(
        new PathLayer<{ path: Position[] }>({
          id: "snap-site-edge",
          ...common,
          data: [{ path: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]] }],
          getPath: (d) => d.path,
          getWidth: 2,
          widthUnits: "pixels",
          getColor: [...ink, 230] as [number, number, number, number],
          parameters: FLAT,
        }),
      );
    return out;
  }, [on, snap.sizeFt, theme, mpp, status]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayerSlot("snap-grid", "ground", layers);
  return null;
}
