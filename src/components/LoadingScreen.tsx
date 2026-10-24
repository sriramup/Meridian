"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useApp } from "@/state/store";

export function LoadingScreen() {
  const progress = useApp((s) => s.progress);
  const status = useApp((s) => s.status);
  const error = useApp((s) => s.error);
  const label = useApp((s) => s.progressLabel);
  return (
    <div className="absolute inset-0 grid place-items-center bg-paper" style={{ backgroundImage: "var(--parchment), radial-gradient(90% 80% at 50% 40%, #f8eccf 0%, #eedcb5 62%, #d9bd8a 100%)" }}>
      <div className="flex w-[320px] flex-col items-center text-center">
        <Wordmark className="origin-center scale-[1.9]" />
        <p className="mt-7 font-display text-[17px] leading-snug text-ink-3 italic">Draw a town, then watch its shade, heat, water and traffic.</p>
        <div className="mt-6 h-1.5 w-full overflow-hidden rounded-full border border-line-2 bg-paper-2">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <p className="mt-2 h-4 text-[11px] text-ink-4">{status === "error" ? "" : label}</p>
        {status === "error" && <p className="mt-2 text-[12px] text-bad">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Vertical shift (px) that puts the ink of `el`'s text, not its font box, on the box's centre.
 * Blackletter faces (and the fallbacks shown while they load) carry tall, uneven ascent/descent,
 * so centring the box leaves the letters visibly high; measuring the glyphs works for any face.
 */
function inkOffset(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  const g = document.createElement("canvas").getContext("2d");
  if (!g) return 0;
  g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = g.measureText(el.textContent ?? "");
  const A = m.fontBoundingBoxAscent,
    D = m.fontBoundingBoxDescent;
  if (!(A + D > 0)) return 0;
  // the box (line-height: none) spans ascent + descent around the baseline; the ink spans its own
  return (A - D - m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / 2;
}

/**
 * The compass star and the blackletter name, centred on each other by their ink. Laid out as a
 * flex box so no inline strut or baseline pushes it off centre in its parent; the name is nudged
 * by its measured glyph bounds, again whenever a font finishes loading.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  const name = useRef<HTMLSpanElement>(null);
  const [dy, setDy] = useState(0);
  useLayoutEffect(() => {
    const el = name.current;
    if (!el) return;
    const fit = () => setDy(Math.round(-inkOffset(el) * 4) / 4);
    fit();
    document.fonts?.addEventListener("loadingdone", fit);
    void document.fonts?.ready.then(fit);
    return () => document.fonts?.removeEventListener("loadingdone", fit);
  }, []);
  return (
    <span className={`flex items-center gap-1.5 ${className}`}>
      {/* a compass star on its meridian */}
      <svg width="20" height="20" viewBox="-10 -10 20 20" aria-hidden className="shrink-0">
        <circle r="8.2" fill="none" stroke="var(--color-gold)" strokeWidth="1" strokeDasharray="1.2 1.6" />
        <path d="M0 -9.5V9.5" stroke="var(--color-gold)" strokeWidth="0.9" strokeLinecap="round" />
        <path d="M0 -7 1.9 -1.9 7 0 1.9 1.9 0 7 -1.9 1.9 -7 0 -1.9 -1.9Z" fill="var(--color-accent)" stroke="var(--color-ink-2)" strokeWidth="0.8" strokeLinejoin="round" />
        <circle r="1.1" fill="var(--color-ink-2)" />
      </svg>
      <span ref={name} className="font-brand text-[22px] leading-none text-ink" style={dy ? { transform: `translateY(${dy}px)` } : undefined}>
        Meridian
      </span>
    </span>
  );
}
