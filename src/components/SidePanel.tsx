"use client";

// A pane docked to the left or right edge of the window (the projects list, the agents) that slides
// open and closed and can be resized by dragging its inner edge. Its width animates, so the chrome
// over the map reflows with it; the map canvas itself is pinned and resized once per move
// (render/paneTransition.ts). The content keeps its full width while it slides, mounts a frame
// before the slide starts (so mounting never costs a frame of the animation) and stays mounted only
// while open or closing.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PANE_EASE_CSS, paneDragEnd, paneDragStart, paneTransition } from "@/render/paneTransition";

const DURATION = 300;
/** the map beside a pane keeps at least this much width */
const MIN_ROOM = 600;

/** a remembered pane width (px), kept per browser */
export function usePaneWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (v >= min && v <= max) return v;
    } catch {
      // storage blocked: the default
    }
    return initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(Math.round(width)));
    } catch {
      // storage blocked: the width lasts for this page
    }
  }, [key, width]);
  // NaN (a double-click on the edge) puts the default back
  return [width, (w: number) => setWidth(Number.isNaN(w) ? initial : Math.max(min, Math.min(max, w)))] as const;
}

interface Props {
  open: boolean;
  side: "left" | "right";
  width: number;
  onResize: (w: number) => void;
  label: string;
  className?: string;
  children: ReactNode;
}

export function SidePanel({ open, side, width, onResize, label, className = "", children }: Props) {
  const [present, setPresent] = useState(open);
  // `shown` drives the slide; it follows `open` a frame after the content has mounted
  const [shown, setShown] = useState(open);
  const [moving, setMoving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useEffect(() => {
    if (open) {
      setPresent(true);
      // two frames: one to mount and lay out the content, one to start the slide from it
      let r2 = 0;
      const r1 = requestAnimationFrame(() => (r2 = requestAnimationFrame(() => setShown(true))));
      return () => {
        cancelAnimationFrame(r1);
        cancelAnimationFrame(r2);
      };
    }
    setShown(false);
    const t = setTimeout(() => setPresent(false), DURATION + 60);
    return () => clearTimeout(t);
  }, [open]);

  // the slide starts: hand the map its one-resize move, from wherever the pane is now
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const now = box.current?.getBoundingClientRect().width ?? 0;
    paneTransition(side, now - (shown ? width : 0), DURATION);
    setMoving(true);
    const t = setTimeout(() => setMoving(false), DURATION + 40);
    return () => clearTimeout(t);
    // width changes while open come from dragging, which moves the map itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    // the most the pane may take while leaving the map MIN_ROOM
    const room = (box.current?.parentElement?.clientWidth ?? Infinity) - MIN_ROOM;
    setDragging(true);
    paneDragStart(side, w0);
    let raf = 0;
    let next = w0;
    const move = (ev: PointerEvent) => {
      next = Math.min(room, w0 + (side === "left" ? ev.clientX - x0 : x0 - ev.clientX));
      // one layout per frame however fast the pointer reports
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), onResize(next)));
    };
    const up = () => {
      cancelAnimationFrame(raf);
      onResize(next);
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      requestAnimationFrame(() => paneDragEnd(side));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const animate = !dragging;
  return (
    <div
      ref={box}
      className={`relative h-full shrink-0 overflow-hidden ${className}`}
      style={{ width: shown ? width : 0, transition: animate ? `width ${DURATION}ms ${PANE_EASE_CSS}` : "none" }}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
    >
      <div
        className="absolute top-0 bottom-0"
        style={{
          width,
          [side]: 0,
          opacity: shown ? 1 : 0,
          transform: shown ? "translate3d(0,0,0)" : `translate3d(${side === "left" ? -32 : 32}px,0,0)`,
          transition: animate ? `opacity ${DURATION * 0.7}ms ${PANE_EASE_CSS}, transform ${DURATION}ms ${PANE_EASE_CSS}` : "none",
          // its own compositor layer while it moves, so sliding never repaints the content
          willChange: moving ? "transform, opacity" : undefined,
          contain: "layout paint",
        }}
      >
        {present && children}
      </div>
      {open && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label}`}
          onPointerDown={startDrag}
          onDoubleClick={() => onResize(Number.NaN)}
          className={`group absolute top-0 bottom-0 z-20 w-2.5 cursor-col-resize ${side === "left" ? "right-0" : "left-0"}`}
        >
          <span className={`absolute top-0 bottom-0 left-1/2 w-[2px] -translate-x-1/2 transition-colors duration-150 ${dragging ? "bg-accent" : "bg-transparent group-hover:bg-accent/60"}`} />
        </div>
      )}
    </div>
  );
}
