"use client";

import type { SketchRef } from "@/agent/types";

/** the sketch a message carried, as a thumbnail above its bubble (the saved history keeps only this) */
export function SketchThumb({ sketch }: { sketch: SketchRef }) {
  const ratio = sketch.width && sketch.height ? sketch.width / sketch.height : 4 / 3;
  const h = 112;
  return (
    <figure className="m-0 overflow-hidden rounded-[10px] border border-line-2 bg-paper-3 shadow-[0_1px_2px_rgb(88_60_28/0.12)]" style={{ width: Math.min(220, Math.round(h * ratio)), height: h }}>
      <img src={sketch.thumb} alt={`Attached sketch: ${sketch.name}`} title={sketch.name} className="size-full object-cover" />
    </figure>
  );
}
