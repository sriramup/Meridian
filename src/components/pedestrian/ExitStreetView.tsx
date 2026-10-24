"use client";

// The one on-screen control at street level: back up to the map. (How to move is in the Help
// guide; the cursor and the arrows on the ground explain themselves.)

import { ArrowLeft } from "lucide-react";
import { useApp } from "@/state/store";
import { togglePedestrian } from "@/state/view";

export function ExitStreetView() {
  const walking = useApp((s) => s.cameraMode === "pedestrian");
  if (!walking) return null;
  return (
    <button
      onClick={togglePedestrian}
      className="chrome pointer-events-auto flex h-8 items-center gap-1.5 rounded-full py-0 pr-2 pl-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      aria-label="Exit street view"
      title="Back to the map (Esc)"
    >
      <ArrowLeft size={14} strokeWidth={1.8} />
      Exit street view
      <kbd className="ml-0.5 rounded-[4px] border border-line-2 bg-paper-2 px-1 font-sans text-[10px] text-ink-3">Esc</kbd>
    </button>
  );
}
