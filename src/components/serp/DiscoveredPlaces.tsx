"use client";

// Discovered places on the map (Google Maps results via SerpApi): numbered pins over the scene, the
// search circle and ground dots through a layer slot, a callout for the pin in focus (hover or click),
// and a small list panel that can be collapsed or cleared. Distances are imperial.

import { COORDINATE_SYSTEM, type Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import { ChevronDown, ChevronUp, ExternalLink, MapPin, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fmtLen } from "@/lib/units";
import { useLayerSlot } from "@/render/layerSlots";
import { useViewInsets } from "@/state/panels";
import { rtMaybe } from "@/state/runtime";
import { clearShown, focusPlace, useSerp, type LocalPlace, type PlaceSet } from "@/serp/store";
import { LocalProjection } from "@/world/projection";
import { cx } from "../ui";
import { showOnMap } from "@/serp/view";
import { PlaceRow, Stars } from "./SerpCards";

const ROSE: [number, number, number] = [138, 61, 28];
const PAPER: [number, number, number] = [250, 240, 216];
const FLAT = { depthWriteEnabled: false, depthCompare: "always" } as const;

/** re-render on camera motion while something is drawn */
function useCameraTick(active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    const map = rtMaybe()?.map;
    if (!map || !active) return;
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
  }, [active]);
}

function useGroundLayers(set: PlaceSet | null, focus: string | null) {
  const layers = useMemo<Layer[] | null>(() => {
    const R = rtMaybe();
    if (!R || !set) return null;
    const common = { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: [R.meta.origin.lon, R.meta.origin.lat, 0] as [number, number, number], parameters: FLAT, pickable: false };
    return [
      new ScatterplotLayer<{ p: [number, number]; r: number }>({
        id: "serp-radius",
        ...common,
        data: [{ p: set.origin.p, r: set.radius_m }],
        getPosition: (d) => [d.p[0], d.p[1], 0.5],
        getRadius: (d) => d.r,
        radiusUnits: "meters",
        stroked: true,
        filled: true,
        getFillColor: [...ROSE, 14],
        getLineColor: [...ROSE, 150],
        lineWidthUnits: "pixels",
        getLineWidth: 1.5,
      }),
      new ScatterplotLayer<{ p: [number, number] }>({
        id: "serp-origin",
        ...common,
        data: [{ p: set.origin.p }],
        getPosition: (d) => [d.p[0], d.p[1], 1],
        radiusUnits: "pixels",
        getRadius: 5,
        stroked: true,
        getFillColor: [...PAPER, 255],
        getLineColor: [...ROSE, 255],
        lineWidthUnits: "pixels",
        getLineWidth: 2,
      }),
      new ScatterplotLayer<LocalPlace>({
        id: "serp-dots",
        ...common,
        data: set.places,
        getPosition: (d) => [d.p[0], d.p[1], 1],
        radiusUnits: "pixels",
        getRadius: (d) => (d.id === focus ? 6 : 3.5),
        stroked: true,
        getFillColor: [...ROSE, 255],
        getLineColor: [...PAPER, 255],
        lineWidthUnits: "pixels",
        getLineWidth: 1.5,
        updateTriggers: { getRadius: focus },
      }),
    ];
  }, [set, focus]);
  useLayerSlot("serp-places", "top", layers);
}

export function DiscoveredPlaces() {
  const set = useSerp((s) => (s.shown ? s.sets[s.shown] : null)) ?? null;
  const focus = useSerp((s) => s.focus);
  const [hover, setHover] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => setOpen(set?.by === "search"), [set?.id, set?.by]);
  const ins = useViewInsets();
  useGroundLayers(set, focus ?? hover);
  useCameraTick(!!set);
  const R = rtMaybe();
  if (!R?.map || !set) return null;
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  const at = (p: [number, number]) => R.map!.project(proj.toLonLat(p));
  const active = set.places.find((p) => p.id === (focus ?? hover)) ?? null;
  const W = R.map.getContainer().clientWidth,
    H = R.map.getContainer().clientHeight;
  return (
    <>
      <div className="pointer-events-none absolute inset-0 overflow-hidden" data-serp-pins>
        {set.places.map((p, i) => {
          const pt = at(p.p);
          if (pt.x < -40 || pt.y < -40 || pt.x > W + 40 || pt.y > H + 40) return null;
          const on = p.id === (focus ?? hover);
          return (
            <button
              key={p.id}
              data-serp-pin={p.id}
              className={cx("pointer-events-auto absolute -translate-x-1/2 -translate-y-full outline-none", on ? "z-20" : "z-10")}
              style={{ left: pt.x, top: pt.y - 4 }}
              onMouseEnter={() => setHover(p.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => focusPlace(focus === p.id ? null : p.id)}
              aria-label={`${i + 1}. ${p.title}`}
            >
              <span className={cx("relative grid place-items-center rounded-full border-2 border-paper font-semibold shadow-[0_2px_5px_rgb(46_28_14/0.35)] transition-transform", on ? "size-7 scale-105 bg-ink text-[12px] text-paper" : "size-6 bg-rose text-[11px] text-paper")}>
                {i + 1}
                <span className={cx("absolute -bottom-[5px] left-1/2 size-2 -translate-x-1/2 rotate-45 border-r-2 border-b-2 border-paper", on ? "bg-ink" : "bg-rose")} />
              </span>
            </button>
          );
        })}
        {active && <Callout p={active} index={set.places.indexOf(active) + 1} pt={at(active.p)} clamp={[ins.left + 128, W - ins.right - 128]} onClose={() => focusPlace(null)} />}
      </div>
      <div className="pointer-events-auto absolute top-16 z-[11] w-[300px]" style={{ left: ins.left + 60, maxWidth: `calc(100% - ${ins.left + ins.right + 80}px)` }} data-serp-panel>
        <div className="chrome overflow-hidden">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5">
            <MapPin size={13} className="shrink-0 text-rose" />
            <button className="min-w-0 flex-1 truncate text-left text-[12px] text-ink-2" onClick={() => setOpen(!open)} title={`Google Maps results for “${set.query}” near ${set.origin.label}`}>
              <span className="font-medium text-ink">{set.places.length}</span> × “{set.query}” <span className="text-ink-4">near {set.origin.label}</span>
            </button>
            <button onClick={() => setOpen(!open)} className="grid size-5 place-items-center rounded text-ink-4 hover:text-ink" aria-label={open ? "Collapse list" : "Expand list"}>
              {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            <button onClick={clearShown} className="grid size-5 place-items-center rounded text-ink-4 hover:text-ink" aria-label="Clear places from the map" data-serp-clear>
              <X size={13} />
            </button>
          </div>
          {open && (
            <div className="scroll-thin max-h-[min(420px,55vh)] overflow-y-auto border-t border-line px-1 py-1">
              {set.places.length ? set.places.map((p, i) => <PlaceRow key={p.id} p={p} index={i + 1} active={p.id === focus} onClick={() => showOnMap(set, p.id)} />) : <p className="px-2 py-1.5 text-[12px] text-ink-4">No places found.</p>}
              <div className="px-1.5 pt-1 pb-0.5 text-right text-[9.5px] text-ink-4">Google Maps results via SerpApi{set.cached ? " · cached" : ""}</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Callout({ p, index, pt, clamp, onClose }: { p: LocalPlace; index: number; pt: { x: number; y: number }; clamp: [number, number]; onClose: () => void }) {
  // kept clear of the side panels that cover the map's edges
  const x = clamp[0] < clamp[1] ? Math.max(clamp[0], Math.min(clamp[1], pt.x)) : pt.x;
  return (
    <div className="pointer-events-auto absolute z-30 w-[240px] -translate-x-1/2 -translate-y-full" style={{ left: x, top: pt.y - 40 }} data-serp-callout>
      <div className="rounded-[8px] border border-line-2 bg-paper/97 px-2.5 py-2 shadow-lg">
        <div className="flex items-start gap-1.5">
          <span className="tabular mt-px grid size-4 shrink-0 place-items-center rounded-full bg-rose text-[9.5px] font-semibold text-paper">{index}</span>
          <div className="min-w-0 flex-1 text-[12.5px] leading-tight font-semibold text-ink">{p.title}</div>
          <button onClick={onClose} className="-mt-0.5 -mr-1 grid size-4 shrink-0 place-items-center text-ink-4 hover:text-ink" aria-label="Close">
            <X size={12} />
          </button>
        </div>
        {p.rating !== undefined && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-3">
            <span className="tabular font-medium text-ink-2">{p.rating.toFixed(1)}</span>
            <Stars rating={p.rating} size={11} />
            {p.reviews !== undefined && <span className="tabular text-ink-4">({p.reviews.toLocaleString("en-US")} reviews)</span>}
          </div>
        )}
        <div className="mt-0.5 text-[11px] text-ink-3">
          {[p.type, p.price].filter(Boolean).join(" · ")}
        </div>
        {(p.hours || p.open_now !== undefined) && <div className={cx("text-[11px]", p.open_now ? "text-good" : "text-ink-4")}>{p.hours ?? (p.open_now ? "Open now" : "Closed")}</div>}
        <div className="mt-1 text-[11.5px] text-ink-2">
          <span className="font-medium">{Math.max(1, Math.round(p.walk_min))} min walk</span> · {fmtLen(p.walk_m)}
          {p.walk_basis === "estimate" && <span className="text-ink-4"> (est.)</span>}
        </div>
        {p.address && <div className="mt-0.5 truncate text-[10.5px] text-ink-4">{p.address}</div>}
        {p.website && (
          <a href={p.website} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-rose hover:underline">
            Website <ExternalLink size={10} />
          </a>
        )}
      </div>
    </div>
  );
}
