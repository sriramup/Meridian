"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getLastReport, onReport, type LastReport } from "@/state/actions";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { LocalProjection } from "@/world/projection";
import { cx } from "./ui";

/** agent / user callouts pinned to world positions */
export function Annotations() {
  const notes = useApp((s) => s.annotations);
  const [, tick] = useState(0);
  useEffect(() => {
    const map = rtMaybe()?.map;
    if (!map) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => tick((x) => x + 1));
    };
    map.on("move", on);
    return () => {
      map.off("move", on);
      cancelAnimationFrame(raf);
    };
  }, []);
  const R = rtMaybe();
  if (!R?.map || !notes.length) return null;
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {notes.map((n) => {
        const pt = R.map!.project(proj.toLonLat(n.p));
        const tone = n.tone === "warn" ? "border-warn" : n.tone === "good" ? "border-good" : "border-accent";
        return (
          <div key={n.id} className="absolute" style={{ transform: `translate(${pt.x}px, ${pt.y}px)` }}>
            <div className="absolute -translate-x-1/2 -translate-y-1/2">
              <span className={cx("block h-2.5 w-2.5 rounded-full border-2 bg-paper", tone)} />
            </div>
            <div className={cx("pointer-events-auto absolute bottom-3 left-0 w-max max-w-[230px] -translate-x-1/2 rounded-[6px] border-l-[3px] bg-paper/97 px-2.5 py-1.5 shadow-lg", tone)}>
              <div className="text-[11.5px] font-semibold text-ink">{n.title}</div>
              {n.body && <div className="mt-0.5 text-[11px] leading-snug text-ink-3">{n.body}</div>}
            </div>
          </div>
        );
      })}
      <button className="pointer-events-auto absolute top-16 left-1/2 -translate-x-1/2 rounded-full bg-paper/95 px-2.5 py-1 text-[11px] text-ink-3 shadow hover:text-ink" onClick={() => useApp.getState().setAnnotations([])}>
        Clear {notes.length} annotation{notes.length > 1 ? "s" : ""}
      </button>
    </div>
  );
}

/** consequences of the last manual edit (the cascade report) */
export function ChangeReport() {
  const [r, setR] = useState<LastReport | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const off = onReport(() => {
      // only what needs attention: a plain successful edit is visible on the map already
      const rep = getLastReport();
      if (!rep?.warnings.length && !rep?.conflicts.length) return setR(null);
      setR(rep);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setR(null), 14000);
    });
    return () => {
      off();
    };
  }, []);
  if (!r) return null;
  return (
    <div className="chrome w-[320px] p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-4 uppercase">Applied</div>
          <div className="text-[12.5px] font-semibold text-ink">{r.label}</div>
        </div>
        <button onClick={() => setR(null)} className="text-ink-4 hover:text-ink">
          <X size={14} />
        </button>
      </div>
      <ul className="mt-1.5 space-y-0.5 text-[11.5px] leading-snug text-ink-2">
        {r.summary.slice(0, 8).map((l, i) => (
          <li key={i}>{l}</li>
        ))}
        {r.warnings.map((l, i) => (
          <li key={`w${i}`} className="text-warn">
            {l}
          </li>
        ))}
        {r.conflicts.map((l, i) => (
          <li key={`c${i}`} className="text-bad">
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Toasts() {
  const toast = useApp((s) => s.toast);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !show) return null;
  return (
    <div className={cx("pointer-events-auto rounded-[6px] px-3 py-2 text-[12px] shadow-lg", toast.tone === "error" ? "bg-bad text-on-accent" : toast.tone === "warn" ? "bg-warn text-on-accent" : "chrome text-ink")}>{toast.text}</div>
  );
}
