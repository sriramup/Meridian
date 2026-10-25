"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { presetOf } from "@/state/cities";
import { openProject, useProjects } from "@/state/projects";
import { useApp } from "@/state/store";
import { Badge, Button } from "./ui/kit";

/**
 * The loading card: a rounded card with the project's name and a progress bar, over the app while a
 * project opens. On a switch the current project stays visible (softened) under it until the next
 * one has drawn, so nothing flashes; it fades out when the new map is up.
 */
export function LoadingScreen() {
  const switching = useProjects((s) => s.switching);
  // the name as it is now (a new project is often being named while it opens)
  const liveName = useProjects((s) => s.list.find((p) => p.id === s.switching?.id)?.name);
  const status = useApp((s) => s.status);
  const appError = useApp((s) => s.error);
  const busy = !!switching || status !== "ready";
  // keep the card for a short fade after the work is done
  const [shown, setShown] = useState(busy);
  const last = useRef(switching);
  if (switching) last.current = switching;
  useEffect(() => {
    if (busy) return setShown(true);
    const t = setTimeout(() => setShown(false), 200);
    return () => clearTimeout(t);
  }, [busy]);
  if (!shown && !busy) return null;
  const s = switching ?? last.current;
  // the first project of the page opens over a plain sheet; later ones over the app
  const over = status === "ready" || (!!s && status === "loading");
  const error = s?.error ?? (status === "error" ? appError : undefined);
  const progress = busy ? (s?.progress ?? 0) : 1;
  const preset = s ? presetOf(s.base) : undefined;
  return (
    <div
      data-testid="loading-card"
      aria-busy={busy}
      className="absolute inset-0 z-40 grid place-items-center"
      style={{
        // over the app: a sheet of parchment laid on the map (a blur would cost every frame under it)
        background: over ? "rgb(241 226 194 / 0.72)" : "var(--parchment), radial-gradient(90% 80% at 50% 40%, #f8eccf 0%, #eedcb5 62%, #d9bd8a 100%)",
        opacity: busy ? 1 : 0,
        transition: "opacity 200ms ease-out",
        animation: "kit-fade-in 160ms ease-out",
      }}
    >
      {/* the card is centred on the window, not on the workspace beside the projects pane */}
      <div className="pointer-events-none fixed inset-0 grid place-items-center">
        <div role="status" aria-live="polite" className="chrome pointer-events-auto w-[340px] max-w-[calc(100%-32px)] rounded-[14px] px-5 pt-4 pb-4" style={{ animation: "kit-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
          <div className="flex items-center justify-between">
            <span className="font-legend text-[12px] leading-none text-ink-3">{error ? "Could not open" : "Opening"}</span>
            <Wordmark className="origin-right scale-[0.72] opacity-80" />
          </div>
          <div className="mt-2.5 flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-display text-[21px] leading-tight text-ink">{liveName ?? s?.name ?? "Meridian"}</span>
            {preset && (
              <Badge variant={s?.base === "sandbox" ? "outline" : "accent"} className="shrink-0">
                {preset.badge}
              </Badge>
            )}
          </div>
          {error ? (
            <>
              <p className="mt-2 text-[12px] leading-snug text-bad">{error}</p>
              {s && (
                <div className="mt-3 flex justify-end">
                  <Button size="sm" variant="primary" onClick={() => void openProject(s.id, { history: "replace" })}>
                    Try again
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="mt-3.5 h-[7px] w-full overflow-hidden rounded-full border border-line-2 bg-paper-2 shadow-[inset_0_1px_1px_rgb(88_60_28/0.15)]">
                {/* scaled, not resized: the compositor keeps it moving while the main thread parses */}
                <div
                  className="h-full w-full origin-left rounded-full bg-accent transition-transform duration-300 ease-out"
                  style={{ transform: `scaleX(${Math.max(0.03, progress)})`, backgroundImage: "linear-gradient(180deg, rgb(255 244 220 / 0.45), transparent)" }}
                />
              </div>
              <div className="mt-2 flex h-4 items-center justify-between text-[11px] text-ink-4">
                <span className="truncate">{s?.label ?? "Opening"}</span>
                <span className="tabular">{Math.round(progress * 100)}%</span>
              </div>
            </>
          )}
        </div>
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
