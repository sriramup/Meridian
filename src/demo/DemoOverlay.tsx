"use client";

// Demo-video director (demo branch only): full-frame title beats between product shots, a visible
// cursor and a cinematic mode, drawn over the real app and driven from scripts/demo/record.mjs
// through window.__demo. Mounted only with ?demo in the URL.
//
// Type: one face (Geist, the app's own), semibold, tight tracking, sentence case, a few words a
// beat; a line can pair a white statement with a quieter grey one. No eyebrows, boxes or shadows:
// the text sits on a frosted, dimmed view of the live map and the product shots run clean.

import { useEffect, useState } from "react";
import { create } from "zustand";
import { startZoneDraw } from "@/components/agents/zoneDraw";
import { rt } from "@/state/runtime";
import { LocalProjection } from "@/world/projection";

interface Beat {
  /** the statement (white) */
  lead: string;
  /** a quieter follow-on, same size (grey) */
  tail?: string;
  /** a smaller supporting line under it */
  note?: string;
  /** the wordmark close */
  brand?: boolean;
}
interface State {
  beat: (Beat & { id: number; leaving?: boolean }) | null;
  cursor: { x: number; y: number; ms: number; visible: boolean; down: boolean; clicks: number };
}
const useDemo = create<State>(() => ({ beat: null, cursor: { x: 960, y: 540, ms: 0, visible: false, down: false, clicks: 0 } }));
let seq = 0;
const LEAVE_MS = 520;

const api = {
  beat(b: Beat | null) {
    const cur = useDemo.getState().beat;
    if (!b) {
      if (!cur) return Promise.resolve();
      useDemo.setState({ beat: { ...cur, leaving: true } });
      return new Promise<void>((r) =>
        setTimeout(() => {
          if (useDemo.getState().beat?.id === cur.id) useDemo.setState({ beat: null });
          r();
        }, LEAVE_MS),
      );
    }
    useDemo.setState({ beat: { ...b, id: ++seq } });
    return Promise.resolve();
  },
  cursor(x: number, y: number, ms = 700) {
    useDemo.setState((s) => ({ cursor: { ...s.cursor, x, y, ms, visible: true } }));
    return new Promise((r) => setTimeout(r, ms));
  },
  press(down: boolean) {
    useDemo.setState((s) => ({ cursor: { ...s.cursor, down, clicks: down ? s.cursor.clicks + 1 : s.cursor.clicks } }));
  },
  hideCursor() {
    useDemo.setState((s) => ({ cursor: { ...s.cursor, visible: false } }));
  },
  /** hide every panel over the map (an unobstructed shot of the city) */
  cine(on: boolean) {
    document.documentElement.classList.toggle("demo-cine", on);
  },
  zoneDraw(sessionId: string) {
    return startZoneDraw("rect", sessionId);
  },
  /** a local point (m) on screen, in page pixels */
  screenOf(p: [number, number]): [number, number] | null {
    const R = rt();
    const map = R.map;
    if (!map) return null;
    const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
    const [lon, lat] = proj.toLonLat(p);
    const s = map.project([lon, lat]);
    const r = map.getCanvas().getBoundingClientRect();
    return [r.left + s.x, r.top + s.y];
  },
  /** a slow cinematic flight to a local point */
  fly(p: [number, number], o: { zoom: number; pitch?: number; bearing?: number; duration?: number; curve?: number }) {
    const R = rt();
    const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
    const [lon, lat] = proj.toLonLat(p);
    R.map?.flyTo({ center: [lon, lat], zoom: o.zoom, pitch: o.pitch ?? R.map.getPitch(), bearing: o.bearing ?? R.map.getBearing(), duration: o.duration ?? 3000, curve: o.curve ?? 1.25, essential: true });
    return new Promise((r) => setTimeout(r, o.duration ?? 3000));
  },
  /** jump without animation */
  jump(p: [number, number], o: { zoom: number; pitch?: number; bearing?: number }) {
    const R = rt();
    const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
    const [lon, lat] = proj.toLonLat(p);
    R.map?.jumpTo({ center: [lon, lat], zoom: o.zoom, pitch: o.pitch ?? 0, bearing: o.bearing ?? 0 });
  },
  /** turn slowly about the view centre */
  orbit(deg: number, ms: number) {
    const map = rt().map;
    map?.rotateTo((map.getBearing() + deg) % 360, { duration: ms, easing: (t) => t });
    return new Promise((r) => setTimeout(r, ms));
  },
};

/** words that rise into place one after another */
function Words({ text, from, className }: { text: string; from: number; className: string }) {
  return (
    <span className={className}>
      {text.split(" ").map((w, i) => (
        <span key={i} className="demo-word" style={{ animationDelay: `${from + i * 55}ms` }}>
          {w}
          {" "}
        </span>
      ))}
    </span>
  );
}

function Mark() {
  return (
    <svg width="92" height="92" viewBox="-10 -10 20 20" aria-hidden className="demo-mark">
      <circle r="8.2" fill="none" stroke="#7f9dff" strokeWidth="0.55" strokeDasharray="1.1 1.4" />
      <path d="M0 -9.5V9.5" stroke="#7f9dff" strokeWidth="0.5" strokeLinecap="round" />
      <path d="M0 -7 1.9 -1.9 7 0 1.9 1.9 0 7 -1.9 1.9 -7 0 -1.9 -1.9Z" fill="#4a7dff" />
      <circle r="1" fill="#fff" />
    </svg>
  );
}

export function DemoOverlay() {
  const beat = useDemo((s) => s.beat);
  const cursor = useDemo((s) => s.cursor);
  const [, ready] = useState(false);
  useEffect(() => {
    (window as unknown as { __demo: typeof api }).__demo = api;
    ready(true);
  }, []);
  const leadWords = beat ? beat.lead.split(" ").length : 0;
  return (
    <div className="demo-layer pointer-events-none fixed inset-0 z-[200]">
      <style>{CSS}</style>
      {beat && (
        <div key={beat.id} className={`demo-beat ${beat.leaving ? "demo-leaving" : ""} ${beat.brand ? "demo-brand" : ""}`}>
          <div className="demo-beat-inner">
            {beat.brand ? (
              <>
                <div className="demo-brand-row demo-word" style={{ animationDelay: "80ms" }}>
                  <Mark />
                  <span className="demo-wordmark">{beat.lead}</span>
                </div>
                {beat.note && <Words text={beat.note} from={520} className="demo-note" />}
              </>
            ) : (
              <>
                <h1 className="demo-headline">
                  <Words text={beat.lead} from={60} className="demo-lead" />
                  {beat.tail && <Words text={beat.tail} from={60 + leadWords * 55 + 160} className="demo-tail" />}
                </h1>
                {beat.note && <Words text={beat.note} from={60 + leadWords * 55 + 420} className="demo-note" />}
              </>
            )}
          </div>
        </div>
      )}
      <div
        className="demo-cursor"
        style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)`, transition: `transform ${cursor.ms}ms cubic-bezier(0.22, 0.8, 0.2, 1), opacity 300ms`, opacity: cursor.visible ? 1 : 0 }}
      >
        <span key={cursor.clicks} className={cursor.clicks ? "demo-ripple" : ""} />
        <svg width="26" height="26" viewBox="0 0 26 26" style={{ transform: cursor.down ? "scale(0.88)" : "none", transition: "transform 90ms" }}>
          <path d="M5 3 L5 20.5 L9.6 16.4 L12.7 23.2 L15.6 22 L12.6 15.3 L19 15.1 Z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}

const CSS = `
html.demo-cine .chrome, html.demo-cine aside, html.demo-cine [aria-label="Projects"] { opacity: 0 !important; transition: opacity 700ms ease; pointer-events: none !important; }
html .chrome { transition: opacity 700ms ease; }

.demo-beat {
  position: absolute; inset: 0; display: grid; place-items: center;
  background: rgba(7, 8, 10, 0.34);
  backdrop-filter: blur(26px) saturate(1.15) brightness(0.5);
  -webkit-backdrop-filter: blur(26px) saturate(1.15) brightness(0.5);
  animation: demo-veil 700ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.demo-leaving { animation: demo-veil-out ${LEAVE_MS}ms cubic-bezier(0.4, 0, 1, 1) forwards; }
.demo-beat-inner { max-width: 1320px; padding: 0 80px; text-align: center; }
.demo-headline {
  margin: 0;
  font-family: var(--font-geist-sans), "Inter", system-ui, sans-serif;
  font-weight: 600; font-size: 76px; line-height: 1.04; letter-spacing: -0.038em;
  font-feature-settings: "ss01", "ss03", "cv11";
  text-wrap: balance;
}
.demo-lead { color: #f5f5f7; }
.demo-tail { color: rgba(245, 245, 247, 0.4); }
.demo-note {
  display: block; margin: 30px auto 0; max-width: 880px;
  font-family: var(--font-geist-sans), "Inter", system-ui, sans-serif;
  font-weight: 450; font-size: 26px; line-height: 1.4; letter-spacing: -0.012em;
  color: rgba(235, 235, 240, 0.56); text-wrap: balance;
}
.demo-word { display: inline-block; animation: demo-word 900ms cubic-bezier(0.16, 1, 0.3, 1) both; }

.demo-brand { background: rgba(7, 8, 10, 0.4); }
.demo-brand-row { display: inline-flex; align-items: center; gap: 26px; }
.demo-wordmark {
  font-family: var(--font-geist-sans), "Inter", system-ui, sans-serif;
  font-weight: 600; font-size: 136px; line-height: 1; letter-spacing: -0.055em; color: #f5f5f7;
}
.demo-brand .demo-note { margin-top: 34px; font-size: 30px; color: rgba(235, 235, 240, 0.6); }

.demo-cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; margin: -3px 0 0 -5px; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.45)); }
.demo-ripple { position: absolute; left: 5px; top: 3px; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 2px solid rgba(142,176,255,0.9); animation: demo-ripple 520ms ease-out forwards; }

@keyframes demo-veil { from { opacity: 0; } }
@keyframes demo-veil-out { to { opacity: 0; filter: blur(6px); } }
@keyframes demo-word { from { opacity: 0; transform: translateY(0.32em); filter: blur(12px); } }
@keyframes demo-ripple { from { opacity: 1; transform: scale(0.3); } to { opacity: 0; transform: scale(1.4); } }
`;
