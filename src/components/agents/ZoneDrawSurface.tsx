"use client";

import { useEffect, useRef } from "react";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import type { Vec2 } from "@/world/types";
import { Kbd } from "@/components/ui/kit";
import { addCorner, cancelZoneDraw, finishPolygon, finishRect, localToScreen, removeCorner, screenToLocal, setDrawCursor, useZoneDraw } from "./zoneDraw";

/**
 * Covers the map while a zone is drawn: takes the pointer so the map's own click handlers (selection,
 * drawing tools) never fire, forwards the wheel so zoom still works, and pans on a drag in polygon mode.
 * Mount inside the map's container.
 */
export function ZoneDrawSurface() {
  const mode = useZoneDraw((s) => s.mode);
  const corners = useZoneDraw((s) => s.points.length);
  const el = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number; lx: number; ly: number; panned: boolean; anchor: Vec2 | null; id: number } | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "Escape") cancelZoneDraw();
      else if (k === "Enter" && mode === "poly") finishPolygon();
      else if ((k === "Backspace" || k === "Delete") && mode === "poly") removeCorner();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    el.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  // picking up a map tool (toolbar or shortcut) puts the zone down
  useEffect(() => useApp.subscribe((s, p) => s.tool !== p.tool && s.tool !== "select" && cancelZoneDraw()), []);

  if (!mode) return null;

  const local = (e: React.PointerEvent | React.MouseEvent): Vec2 | null => {
    const r = el.current!.getBoundingClientRect();
    return screenToLocal(e.clientX - r.left, e.clientY - r.top);
  };
  const moveCursor = (p: Vec2 | null) => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setDrawCursor(p));
  };

  return (
    <>
      <div
        ref={el}
        tabIndex={-1}
        aria-label={mode === "rect" ? "Drag on the map to draw the zone" : "Click on the map to place the zone's corners"}
        className="absolute inset-0 z-[6] cursor-crosshair outline-none"
        onContextMenu={(e) => {
          e.preventDefault();
          if (mode === "poly") removeCorner();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          gesture.current = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, panned: false, anchor: mode === "rect" ? local(e) : null, id: e.pointerId };
          if (mode === "rect" && gesture.current.anchor) useZoneDraw.setState({ points: [gesture.current.anchor] });
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (g && mode === "poly" && (g.panned || Math.hypot(e.clientX - g.x, e.clientY - g.y) > 4)) {
            // a drag in polygon mode pans the map
            g.panned = true;
            rtMaybe()?.map?.panBy([g.lx - e.clientX, g.ly - e.clientY], { animate: false });
            g.lx = e.clientX;
            g.ly = e.clientY;
            return;
          }
          moveCursor(local(e));
        }}
        onPointerUp={(e) => {
          const g = gesture.current;
          gesture.current = null;
          if (!g || e.pointerId !== g.id) return;
          const p = local(e);
          if (!p) return;
          if (mode === "rect") {
            if (g.anchor) finishRect(g.anchor, p);
            return;
          }
          if (g.panned) return;
          const pts = useZoneDraw.getState().points;
          const r = el.current!.getBoundingClientRect();
          const near = (q: Vec2, px: number) => {
            const s = localToScreen(q);
            return !!s && Math.hypot(s[0] - (e.clientX - r.left), s[1] - (e.clientY - r.top)) < px;
          };
          if (pts.length >= 3 && near(pts[0], 10)) return finishPolygon();
          // the second click of a double-click lands on the corner just placed
          if (pts.length && near(pts[pts.length - 1], 4)) return;
          addCorner(p);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          finishPolygon();
        }}
        onPointerLeave={() => moveCursor(null)}
        onWheel={(e) => {
          // keep zoom: hand the wheel to the map's canvas
          const canvas = rtMaybe()?.map?.getCanvas();
          canvas?.dispatchEvent(new WheelEvent("wheel", { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, bubbles: true, cancelable: true }));
        }}
      />
      <div className="pointer-events-none absolute top-16 left-1/2 z-[11] -translate-x-1/2">
        <div className="chrome flex h-8 items-center gap-2.5 px-3 text-[12px] whitespace-nowrap text-ink-2">
          {mode === "rect" ? (
            <span>Drag to draw the agent’s zone</span>
          ) : (
            <span>{corners < 3 ? "Click to place corners · drag to pan" : "Click the first corner or press Enter to finish"}</span>
          )}
          <span className="flex items-center gap-1 text-ink-4">
            {mode === "poly" && corners > 0 && (
              <>
                <Kbd size="xs">⌫</Kbd> undo
              </>
            )}
            <Kbd size="xs">Esc</Kbd> cancel
          </span>
        </div>
      </div>
    </>
  );
}
