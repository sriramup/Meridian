"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PANEL_EASE } from "@/state/panels";
import { cn } from "./ui/kit";

/**
 * A side panel that slides in over the map from its edge and slides out before it unmounts. It is
 * positioned absolutely, so opening it never changes the size of what is underneath.
 */
export function SlidePanel({ side, open, width, className, children }: { side: "left" | "right"; open: boolean; width: number; className?: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // two frames: the off-screen position is painted before the transition starts
      let r2 = 0;
      const r1 = requestAnimationFrame(() => (r2 = requestAnimationFrame(() => setShown(true))));
      return () => (cancelAnimationFrame(r1), cancelAnimationFrame(r2));
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return (
    <div
      className={cn("absolute top-0 bottom-0", side === "left" ? "left-0" : "right-0", className)}
      style={{ width, transform: shown ? "none" : `translateX(${side === "left" ? "-100%" : "100%"})`, transition: `transform ${PANEL_EASE}`, willChange: "transform" }}
      // closing: no focus or clicks while it leaves (opening must accept focus at once: the composer takes it)
      inert={!open || undefined}
    >
      {children}
    </div>
  );
}
