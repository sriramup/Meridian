"use client";

import { ImageUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dragHasFiles, displayName, imageFromItems } from "@/sketch/image";
import { attachImage } from "./draft";

/**
 * Drop an image anywhere on the agents pane: it becomes the viewed agent's attachment. Listens on
 * the pane (its parent element) so it never blocks clicks; the overlay shows only while files are
 * dragged over it.
 */
export function SketchDropZone({ target }: { target: () => string }) {
  const [over, setOver] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const tgt = useRef(target);
  tgt.current = target;
  useEffect(() => {
    const pane = anchor.current?.parentElement;
    if (!pane) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth++;
      setOver(true);
    };
    const overF = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const f = imageFromItems(e.dataTransfer?.items, e.dataTransfer?.files);
      if (f) void attachImage(tgt.current(), f, displayName(f.name, "Sketch"));
    };
    pane.addEventListener("dragenter", enter);
    pane.addEventListener("dragover", overF);
    pane.addEventListener("dragleave", leave);
    pane.addEventListener("drop", drop);
    return () => {
      pane.removeEventListener("dragenter", enter);
      pane.removeEventListener("dragover", overF);
      pane.removeEventListener("dragleave", leave);
      pane.removeEventListener("drop", drop);
    };
  }, []);
  return (
    <div ref={anchor} aria-hidden={!over} className={`pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-[12px] border-2 border-dashed border-rose/50 bg-paper/85 backdrop-blur-[1px] transition-opacity duration-100 ${over ? "opacity-100" : "opacity-0"}`}>
      <div className="flex flex-col items-center gap-1.5 text-center">
        <ImageUp className="size-6 text-rose" strokeWidth={1.7} />
        <div className="text-[13.5px] font-medium text-ink">Drop a sketch or photo</div>
        <div className="max-w-[220px] text-[11.5px] leading-snug text-ink-3">A bird’s-eye plan: the agent reads it and builds it on the map</div>
      </div>
    </div>
  );
}
