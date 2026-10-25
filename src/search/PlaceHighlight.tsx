"use client";

// Draws the mark of the chosen search result (useSearchHighlight) through a layer slot, holds it
// while the camera flies and a moment after it lands, then fades it out and removes it.

import { COORDINATE_SYSTEM, type Layer, type Position } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import { useEffect, useMemo, useState } from "react";
import { useLayerSlot } from "@/render/layerSlots";
import { rtMaybe } from "@/state/runtime";
import { highlightAlpha, useSearchHighlight } from "./highlight";

const INK: [number, number, number] = [138, 61, 28];
const PAPER: [number, number, number] = [250, 240, 216];
const FLAT = { depthWriteEnabled: false, depthCompare: "always" } as const;

export function PlaceHighlight() {
  const target = useSearchHighlight((s) => s.target);
  // strength in 20 steps: the layers re-stack only when it visibly changes
  const [step, setStep] = useState(20);

  useEffect(() => {
    if (!target) return;
    setStep(20);
    if (target.landed === null) return;
    let raf = 0;
    const tick = () => {
      const a = highlightAlpha(target, performance.now());
      setStep(Math.round(a * 20));
      if (a > 0) raf = requestAnimationFrame(tick);
      else useSearchHighlight.getState().clear();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const layers = useMemo<Layer[] | null>(() => {
    const R = rtMaybe();
    if (!R || !target || step <= 0) return null;
    const a = step / 20;
    const { shapes } = target;
    const common = { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: [R.meta.origin.lon, R.meta.origin.lat, 0] as [number, number, number], parameters: FLAT, pickable: false };
    const out: Layer[] = [];
    if (shapes.fills.length)
      out.push(
        new SolidPolygonLayer<(typeof shapes.fills)[number]>({
          id: "search-hl-fill",
          ...common,
          data: shapes.fills,
          getPolygon: (d) => d as unknown as Position[],
          getFillColor: [...INK, Math.round(30 * a)],
        }),
      );
    const paths = [...shapes.lines, ...shapes.rings.map((r) => [...r, r[0]])];
    if (paths.length) {
      // a paper casing under the ink keeps the mark legible on dark roofs and on the heat map
      out.push(
        new PathLayer<(typeof paths)[number]>({
          id: "search-hl-casing",
          ...common,
          data: paths,
          getPath: (d) => d as Position[],
          getColor: [...PAPER, Math.round(210 * a)],
          getWidth: shapes.lines.length ? 9 : 6,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
        }),
        new PathLayer<(typeof paths)[number]>({
          id: "search-hl-line",
          ...common,
          data: paths,
          getPath: (d) => d as Position[],
          getColor: [...INK, Math.round(240 * a)],
          getWidth: shapes.lines.length ? 4.5 : 2.5,
          widthUnits: "pixels",
          capRounded: true,
          jointRounded: true,
        }),
      );
    }
    if (shapes.point)
      out.push(
        new ScatterplotLayer<{ p: [number, number] }>({
          id: "search-hl-point",
          ...common,
          data: [{ p: shapes.point }],
          getPosition: (d) => [d.p[0], d.p[1], 1],
          radiusUnits: "pixels",
          getRadius: 15,
          stroked: true,
          filled: true,
          getFillColor: [...INK, Math.round(36 * a)],
          getLineColor: [...INK, Math.round(240 * a)],
          lineWidthUnits: "pixels",
          getLineWidth: 2.5,
        }),
        new ScatterplotLayer<{ p: [number, number] }>({
          id: "search-hl-dot",
          ...common,
          data: [{ p: shapes.point }],
          getPosition: (d) => [d.p[0], d.p[1], 1],
          radiusUnits: "pixels",
          getRadius: 4,
          stroked: true,
          getFillColor: [...INK, Math.round(255 * a)],
          getLineColor: [...PAPER, Math.round(230 * a)],
          lineWidthUnits: "pixels",
          getLineWidth: 1.5,
        }),
      );
    return out;
  }, [target, step]);

  useLayerSlot("search-highlight", "top", layers);
  return null;
}
