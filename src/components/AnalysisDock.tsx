"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { Bike, Car, Check, ChevronUp, CloudRain, Droplets, Ellipsis, Footprints, LayoutGrid, LoaderCircle, Pause, Play, RefreshCw, Sun, Thermometer, TramFront, TrendingUp, Users } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { runSim, useSims, type SimRecord } from "@/sim/client";
import { DIVERGE, cssGradient } from "@/render/palettes";
import { growthSnapshot, legendFor, overlayState } from "@/render/overlays";
import { rt } from "@/state/runtime";
import { monthDate, useApp, type OverlayId } from "@/state/store";
import { fmtArea, fmtDepth, fmtF, fmtLen, fmtMi, fmtNum, fmtRain, fmtSpeed, fmtSqFt, fmtVol } from "@/lib/units";
import { trafficAtCached } from "@/sim/trafficHourly";
import type { SimKind } from "@/sim/engine";
import { areaKpi, tilesIn, type Scope } from "@/sim/heatKpi";
import { stateKey } from "@/sim/heatCache";
import { LocalProjection } from "@/world/projection";
import { compareWith, usePlanImpact } from "./ImpactPanel";
import { MonthSelect } from "./MonthSelect";
import { SelectField, Slider } from "./ui/kit";
import { Button, Segmented, Tip, cx } from "./ui";

export const CHIPS: { id: OverlayId; label: string; icon: typeof Car; sim?: SimKind; hint: string; more?: boolean }[] = [
  { id: "heat", label: "Heat", icon: Thermometer, sim: "heat", hint: "Surface temperature, hour by hour" },
  { id: "sun", label: "Shade", icon: Sun, sim: "sun", hint: "Hours of direct sun per spot (fewer = more shade)" },
  { id: "runoff", label: "Stormwater", icon: CloudRain, sim: "runoff", hint: "Design-storm runoff from hard surfaces" },
  { id: "traffic", label: "Traffic", icon: Car, sim: "traffic", hint: "Volumes and congestion, hour by hour", more: true },
  { id: "density", label: "Density", icon: Users, hint: "Residents / jobs per acre", more: true },
  { id: "access", label: "Access", icon: Footprints, sim: "access", hint: "Walk times", more: true },
  { id: "bike", label: "Bike", icon: Bike, sim: "bike", hint: "Bicycle level of traffic stress", more: true },
  { id: "zoning", label: "Capacity", icon: LayoutGrid, sim: "capacity", hint: "Zoned development capacity", more: true },
  { id: "growth", label: "Growth", icon: TrendingUp, sim: "growth", hint: "Where residential growth could go", more: true },
  { id: "transit", label: "Transit", icon: TramFront, hint: "Routes & ¼-mile catchments", more: true },
  { id: "flood", label: "Flood", icon: Droplets, sim: "flood", hint: "Inundation screening", more: true },
];

/** models fast enough (≈ 1 s) to re-run on every edit while their overlay is open */
const LIVE: ReadonlySet<SimKind> = new Set(["heat", "sun", "runoff"]);

const NEEDS_DATA = new Set<OverlayId>(["zoning", "growth", "flood"]);

/** the analyses this city can run: the blank canvas has no zoning, parcels or terrain for capacity, growth and flood screening */
export function availableOverlays() {
  return CHIPS.filter((c) => !rt().meta.sandbox || !NEEDS_DATA.has(c.id));
}

function currentRecord(kind: SimKind | undefined, records: SimRecord[], shown: Partial<Record<SimKind, string>>) {
  if (!kind) return undefined;
  return records.find((r) => r.id === shown[kind]);
}

export function AnalysisDock() {
  const overlay = useApp((s) => s.overlay);
  // the clock is read by the small components that show it (TimeControl, the KPI blocks), so playback
  // re-renders those, not the whole dock
  const setHour = useApp((s) => s.setHour);
  const playing = useApp((s) => s.playing);
  const setPlaying = useApp((s) => s.setPlaying);
  const worldVersion = useApp((s) => s.worldVersion);
  const date = useApp((s) => s.date);
  const bumpOverlay = useApp((s) => s.bumpOverlay);
  // re-render when overlay modes change from elsewhere (e.g. the agent's show tool)
  useApp((s) => s.overlayVersion);
  useApp((s) => s.scenarioVersion);
  const records = useSims((s) => s.records);
  const shown = useSims((s) => s.shown);
  const compare = useSims((s) => s.compare);
  const [, force] = useState(0);
  const chip = CHIPS.find((c) => c.id === overlay);
  const rec = currentRecord(chip?.sim, records, shown);
  // prefetches (e.g. the neighbouring months) run silently
  const running = records.find((r) => r.kind === chip?.sim && r.status === "running" && !r.background);
  const R = rt();
  const stale = rec && rec.scenarioId === R.scenarios.activeId && rec.cursor !== R.scenarios.active.cursor;
  const otherScenario = rec && rec.scenarioId !== R.scenarios.activeId;

  const run = (kind: SimKind, params: Record<string, unknown> = {}) =>
    runSim(kind, params)
      .then(() => bumpOverlay())
      .catch((e) => useApp.getState().notify(`${kind} model failed: ${(e as Error).message}`, "error"));
  // run when an overlay without current results is opened, and keep fast models live as the plan changes
  const lastOverlay = useRef<OverlayId | null>(null);
  const lastDate = useRef(date);
  useEffect(() => {
    const opened = lastOverlay.current !== overlay || lastDate.current !== date;
    lastDate.current = date;
    lastOverlay.current = overlay;
    if (!chip?.sim) return;
    const kind = chip.sim;
    if (!opened && !LIVE.has(kind)) return;
    const dated = kind === "heat" || kind === "sun";
    const params = () => {
      const p = currentRecord(kind, useSims.getState().records, useSims.getState().shown)?.params ?? defaultParams(kind);
      return dated ? { ...p, date } : p;
    };
    // current = the shown run modelled this scenario state (and month); a cached or prefetched run is
    // not current until runSim shows it, which it does instantly
    const have = () => {
      const S = useSims.getState();
      const state = stateKey(R.scenarios.activeId, R.scenarios.appliedChangesets().map((c) => c.id));
      const ok = (r: SimRecord) => r.kind === kind && r.state === state && (!dated || r.params.date === date);
      const cur = currentRecord(kind, S.records, S.shown);
      return (cur?.status === "done" && ok(cur)) || S.records.some((r) => r.status === "running" && !r.background && ok(r));
    };
    if (have()) return;
    const t = setTimeout(() => !have() && run(kind, params()), opened ? 0 : 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, worldVersion, R.scenarios.activeId, date]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const h = useApp.getState().hour + dt * 1.2;
      useApp.getState().setHour(h >= 24 ? h - 24 : h);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, setHour]);

  const legend = legendFor(overlay);
  const scenarios = [...R.scenarios.scenarios.values()];
  const cmpRec = chip?.sim ? records.find((r) => r.id === compare[chip.sim!]) : undefined;
  const kpisStatic = useMemo(() => (rec?.status === "done" && rec.kind !== "heat" && rec.kind !== "traffic" ? kpiFor(rec) : []), [rec]);

  return (
    <div className="pointer-events-none flex w-full flex-col items-center gap-2 px-3">
      {overlay && (
        // one row on a wide map; on a narrow one the legend and KPIs share the top row, controls below
        <div className="chrome grid w-full max-w-[min(1000px,calc(100cqw-24px))] grid-cols-[220px_minmax(0,1fr)_auto] @max-[860px]:grid-cols-[minmax(0,1fr)_auto]">
          {/* legend */}
          <div className="min-w-0 px-3 py-2.5">
            {legend ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[12px] font-semibold text-ink">{cmpRec ? `Δ ${legend.title}` : legend.title}</span>
                  <span className="shrink-0 text-[10.5px] text-ink-4">{legend.unit}</span>
                </div>
                <div className="mt-1.5 h-2 rounded-full" style={{ background: cssGradient(cmpRec ? DIVERGE : legend.palette) }} />
                <div className="mt-1 flex justify-between text-[10.5px] text-ink-4 tabular">
                  <span>{cmpRec ? (overlay === "heat" ? "−5 °F cooler" : "less") : legend.min}</span>
                  <span>{cmpRec ? (overlay === "heat" ? "+5 °F hotter" : "more") : legend.max}</span>
                </div>
              </>
            ) : overlay === "transit" ? (
              <div className="text-[12px] text-ink-2">Capital Metro routes and stops</div>
            ) : (
              <div className="flex items-center gap-3 text-[12px] text-ink-2">
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-proposed" /> Proposed</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] border-2 border-bad" /> Removed</span>
              </div>
            )}
          </div>
          {/* controls */}
          <div className="flex min-w-0 flex-col justify-center gap-2 border-l border-line px-3 py-2 @max-[860px]:order-last @max-[860px]:col-span-2 @max-[860px]:border-t @max-[860px]:border-l-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {chip?.sim === "heat" || chip?.sim === "sun" ? (
                <>
                  <MonthSelect />
                  {running && <LoaderCircle size={13} className="shrink-0 animate-spin text-ink-3" />}
                </>
              ) : running ? (
                <span className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-ink-2">
                  <LoaderCircle size={13} className="shrink-0 animate-spin" /> {running.label}
                </span>
              ) : rec ? (
                <span className="min-w-0 truncate text-[12px] text-ink-2">
                  <span className="font-medium text-ink">{rec.scenarioName}</span>
                  {cmpRec && <span className="text-ink-3"> vs {cmpRec.scenarioName}</span>}
                  {stale && <span className="text-warn"> · updating</span>}
                  {otherScenario && <span className="text-warn"> · other scenario</span>}
                </span>
              ) : (
                <span className="min-w-0 truncate text-[12px] text-ink-3">{chip?.hint}</span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <OverlayMode
                  overlay={overlay}
                  onChange={() => {
                    bumpOverlay();
                    force((x) => x + 1);
                  }}
                />
                {chip?.sim && (chip.sim === "traffic" || chip.sim === "runoff") && scenarios.length > 1 && (
                  <SelectField
                    size="xs"
                    aria-label="Compare with scenario"
                    className="max-w-[150px]"
                    value={cmpRec?.scenarioId ?? "none"}
                    onValueChange={(v) => compareWith(chip.sim!, v === "none" ? "" : v, rec?.params ?? defaultParams(chip.sim!)).then(bumpOverlay)}
                    options={[{ value: "none", label: "No comparison" }, ...scenarios.filter((s) => s.id !== R.scenarios.activeId).map((s) => ({ value: s.id, label: `Δ vs ${s.name}` }))]}
                  />
                )}
                {chip?.sim && !LIVE.has(chip.sim) && (
                  <Tip label="Re-run on the current scenario">
                    <button onClick={() => run(chip.sim!, rec?.params ?? defaultParams(chip.sim!))} className="grid h-7 w-7 place-items-center rounded-[5px] text-ink-3 hover:bg-paper-3 hover:text-ink">
                      <RefreshCw size={13} className={cx(running && "animate-spin")} />
                    </button>
                  </Tip>
                )}
              </div>
            </div>
          </div>
          {/* KPIs */}
          {rec?.kind === "heat" ? <HeatKpiBlock rec={rec.status === "done" ? rec : undefined} /> : rec?.kind === "traffic" ? <TrafficKpiBlock rec={rec.status === "done" ? rec : undefined} /> : <KpiGrid kpis={kpisStatic} />}
        </div>
      )}
      <PlanImpactSync />
      <div className="flex max-w-full items-center gap-2">
        <TimeControl timed={overlay === "heat" || overlay === "traffic"} />
        <ChipBar overlay={overlay} busy={records.filter((r) => r.status === "running" && !r.background).map((r) => r.kind).sort().join(",")} />
      </div>
    </div>
  );
}

function Chip({ c, on, busy, onClick }: { c: (typeof CHIPS)[number]; on: boolean; busy: boolean; onClick: () => void }) {
  const Icon = c.icon;
  return (
    <Tip label={c.hint} side="top">
      <button onClick={onClick} aria-pressed={on} className={cx("flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors", on ? "bg-accent text-on-accent" : "text-ink-2 hover:bg-paper-3 hover:text-ink")}>
        {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Icon size={13} strokeWidth={1.8} />}
        <span className="hidden @[560px]:inline">{c.label}</span>
      </button>
    </Tip>
  );
}

/** modelled hours for the heat overlay: hourly through the day, every two hours overnight */
const HEAT_HOURS = [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

export function defaultParams(kind: SimKind): Record<string, unknown> {
  // both peaks, so volumes, speeds and delay can follow the clock through the day
  if (kind === "traffic") return { period: "pm", day: true };
  if (kind === "heat") return { deltaT: 0, date: useApp.getState().date, hours: HEAT_HOURS };
  if (kind === "flood") return { rise: 4 };
  if (kind === "runoff") return { storm: "25yr" };
  if (kind === "sun") return { date: useApp.getState().date };
  if (kind === "growth") return { years: 20 };
  return {};
}

function OverlayMode({ overlay, onChange }: { overlay: OverlayId | null; onChange: () => void }) {
  if (overlay === "density")
    return (
      <Segmented
        size="xs"
        value={overlayState.densityMode}
        onChange={(v) => {
          overlayState.densityMode = v;
          onChange();
        }}
        options={[
          { value: "residents", label: "Residents" },
          { value: "jobs", label: "Jobs" },
        ]}
      />
    );
  if (overlay === "growth") {
    const rec = currentRecord("growth", useSims.getState().records, useSims.getState().shown);
    const years = rec?.status === "done" ? (rec.result.snapshots as { year: number }[]).map((s) => s.year) : [];
    if (!years.length) return null;
    return (
      <Segmented
        size="xs"
        value={String(overlayState.growthYear ?? years[years.length - 1])}
        onChange={(v) => {
          overlayState.growthYear = +v;
          onChange();
        }}
        options={years.map((y) => ({ value: String(y), label: String(y) }))}
      />
    );
  }
  if (overlay === "zoning")
    return (
      <Segmented
        size="xs"
        value={overlayState.capacityMode}
        onChange={(v) => {
          overlayState.capacityMode = v;
          onChange();
        }}
        options={[
          { value: "added", label: "Added GFA" },
          { value: "limit", label: "Constraint" },
        ]}
      />
    );
  if (overlay === "access")
    return (
      <SelectField
        size="xs"
        aria-label="Destination"
        value={overlayState.accessCategory}
        onValueChange={(v) => {
          overlayState.accessCategory = v;
          onChange();
        }}
        options={["frequent_transit", "transit", "grocery", "school", "park", "health", "food", "emergency"].map((c) => ({ value: c, label: c === "emergency" ? "fire / EMS (drive)" : c.replace("_", " ") }))}
      />
    );
  return null;
}

function kpiFor(rec: SimRecord): { label: string; value: string; hint?: string }[] {
  const r = rec.result;
  const f = (x: number, d = 0) => fmtNum(x, d);
  const KM = 1000;
  switch (rec.kind) {
    case "bike":
      return [
        { label: "Low-stress streets", value: fmtMi((r.kmByLts[1] + r.kmByLts[2]) * KM), hint: "Street length at LTS 1–2, comfortable for most adults" },
        { label: "High-stress (LTS 4)", value: fmtMi(r.kmByLts[4] * KM) },
        { label: "Grocery, low-stress", value: `${f((r.coverage.grocery?.lowStress ?? 0) * 100)}%`, hint: "Residents who can reach a grocery on low-stress streets" },
        { label: "Largest island", value: `${f(r.islands[0]?.residents ?? 0)} residents`, hint: "Residents in the largest connected low-stress area" },
      ];
    case "access":
      return [
        { label: "Frequent transit", value: `${f(r.coverage.frequent_transit * 100)}%`, hint: "Residents within a 5-minute walk of a stop with service every 15 minutes or better" },
        { label: "Any stop ¼ mi", value: `${f(r.coverage.transit * 100)}%` },
        { label: "Grocery 15 min", value: `${f(r.coverage.grocery * 100)}%` },
        { label: "Park 15 min", value: `${f(r.coverage.park * 100)}%` },
      ];
    case "flood":
      return [
        { label: "Water level", value: `+${fmtDepth(r.rise)}` },
        { label: "Flooded area", value: fmtArea(r.floodedM2) },
        { label: "Buildings", value: f(r.buildings.length) },
        { label: "Residents", value: f(r.residents) },
      ];
    case "runoff":
      return [
        { label: "Runoff", value: fmtVol(r.volumeM3) },
        { label: "Mean depth", value: fmtRain(r.depthMm) },
        { label: "Impervious", value: `${f(r.imperviousFraction * 100)}%` },
        { label: "Storage", value: fmtVol(r.storageM3) },
      ];
    case "capacity": {
      const ps = r.parcels as { addedUnits: number; addedGfa: number }[];
      return [
        { label: "Added homes", value: f(ps.reduce((s, p) => s + p.addedUnits, 0)) },
        { label: "Added floor area", value: fmtSqFt(ps.reduce((s, p) => s + p.addedGfa, 0)) },
      ];
    }
    case "growth": {
      const s = growthSnapshot(r);
      const pop = (r.series as { year: number; population: number }[]).find((x) => x.year === s.year)?.population ?? 0;
      return [
        { label: `Population ${s.year}`, value: f(pop) },
        { label: "Placed", value: `+${f(s.added.reduce((a: number, b: number) => a + b, 0))}` },
        { label: "Zoned room", value: f(r.zonedCapacityResidents) },
      ];
    }
    case "sun":
      return r.stats ? [{ label: "Mean direct sun", value: `${f(r.stats.meanHours, 1)} h` }] : [];
    default:
      return [];
  }
}

/** 12-hour clock, e.g. 3:05 PM */
function clock(hour: number): string {
  const m = Math.floor((((hour % 24) + 24) % 24) * 60 + 1e-6);
  const h24 = Math.floor(m / 60),
    min = m % 60;
  return `${h24 % 12 === 0 ? 12 : h24 % 12}:${String(min).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

/** the part of the map the heat KPIs describe: the ground in view, capped to 900 m around the view centre */
const VIEW_RADIUS = 900;

function viewScope(): Scope | null {
  const R = rt();
  const map = R.map;
  if (!map) return null;
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  const cv = map.getCanvas();
  const w = cv.clientWidth,
    h = cv.clientHeight;
  const c = map.getCenter();
  const center = proj.toLocal(c.lng, c.lat) as [number, number];
  const poly: [number, number][] = [];
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const ll = map.unproject([x, y]);
    const p = proj.toLocal(ll.lng, ll.lat);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return { center, radius: VIEW_RADIUS };
    poly.push([p[0], p[1]]);
  }
  // a tilted view reaches toward the horizon: the radius keeps the figures about the place in front of you
  return { poly, center, radius: VIEW_RADIUS };
}

/**
 * Heat KPIs for the area in view at the hour shown: re-scoped when the camera settles, re-timed every
 * frame of the clock (tile sums, microseconds), and recomputed whenever a new run (an edit, a month)
 * lands.
 */
function useHeatKpis(rec: SimRecord | undefined, hour: number): { label: string; value: string; hint?: string }[] {
  const [scope, setScope] = useState<Scope | null>(null);
  useEffect(() => {
    let map = rt().map;
    let t: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const update = () => {
      last = performance.now();
      t = null;
      setScope(viewScope());
    };
    // throttled while the camera moves (a long flight still updates), and once more where it stops
    const onMove = () => {
      if (t) return;
      t = setTimeout(update, Math.max(0, 300 - (performance.now() - last)));
    };
    // the map can attach after the dock mounts
    const poll = setInterval(() => {
      if (map || !rt().map) return;
      map = rt().map;
      map!.on("move", onMove);
      map!.on("moveend", onMove);
      update();
    }, 500);
    if (map) {
      map.on("move", onMove);
      map.on("moveend", onMove);
      update();
    }
    return () => {
      clearInterval(poll);
      if (t) clearTimeout(t);
      map?.off("move", onMove);
      map?.off("moveend", onMove);
    };
  }, []);
  const tiles = rec?.result?.tiles;
  const grid = rec?.result?.grid ?? rt().meta.grid;
  const sel = useMemo(() => (tiles ? tilesIn(tiles, grid, scope) : null), [tiles, grid, scope]);
  if (!rec || !tiles || !sel) return [];
  const k = areaKpi(rec.result, sel, hour);
  const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
  const none = "—";
  // every figure is for the hour shown (interpolated between modelled hours, like the map)
  return [
    { label: "Feels like on foot", value: k.feels === null ? none : fmtF(k.feels), hint: "Mean feels-like temperature on the sidewalks, plazas and streets in view (air, sun and the heat the ground gives off)" },
    { label: "Ground surface", value: k.surface === null ? none : fmtF(k.surface), hint: "Mean surface temperature of the ground in view: what the map colours show" },
    { label: "Air", value: k.air === null ? none : fmtF(k.air), hint: "Air temperature at this hour on the modelled day" },
    { label: "Shaded paths", value: k.feels === null ? none : k.shaded === null ? "Night" : pct(k.shaded), hint: `Share of walkable ground in view out of direct sun · tree canopy covers ${k.cells ? pct(k.canopy, 1) : none} of the view` },
  ];
}

function KpiGrid({ kpis, title }: { kpis: { label: string; value: string; hint?: string }[]; title?: string }) {
  if (!kpis.length) return null;
  return (
    <div className="grid grid-cols-[repeat(2,max-content)] content-center gap-x-5 gap-y-1 border-l border-line px-3 py-2 @max-[480px]:gap-x-3" title={title}>
      {kpis.slice(0, 4).map((k) => (
        <div key={k.label} className="whitespace-nowrap" title={k.hint}>
          <div className="text-[10px] text-ink-4">{k.label}</div>
          <div className="tabular text-[13px] font-semibold text-ink">{k.value}</div>
        </div>
      ))}
    </div>
  );
}

function HeatKpiBlock({ rec }: { rec: SimRecord | undefined }) {
  const hour = useApp((s) => s.hour);
  return <KpiGrid kpis={useHeatKpis(rec, hour)} title="For the area in view, at the time shown" />;
}

/**
 * Traffic for the hour shown: both peak assignments scaled by the weekday hourly profile, with
 * link times re-evaluated at the scaled volumes (sim/trafficHourly), so every figure follows the clock.
 */
function TrafficKpiBlock({ rec }: { rec: SimRecord | undefined }) {
  // tenth-of-an-hour steps: playback re-renders this block, not the dock
  const hour = useApp((s) => Math.round(s.hour * 10) / 10);
  if (!rec) return null;
  const k = trafficAtCached(rec.result, hour).kpi;
  return (
    <KpiGrid
      title="Across the network, for the hour shown"
      kpis={[
        { label: "Trips this hour", value: fmtNum(k.vehTrips, 0), hint: "Vehicle trips starting in this hour" },
        { label: "Avg speed", value: fmtSpeed(k.avgSpeed, 1), hint: "Distance-weighted mean speed of traffic on the network" },
        { label: "Congested", value: k.congestedM < 1 ? "None" : fmtLen(k.congestedM), hint: "Street length running above 90% of capacity" },
        { label: "Delay", value: k.delayHours < 1 ? `${fmtNum(k.delayHours * 60, 0)} veh·min` : `${fmtNum(k.delayHours, k.delayHours < 10 ? 1 : 0)} veh·h`, hint: "Vehicle-hours lost to congestion in this hour, against free flow" },
      ]}
    />
  );
}

/**
 * The time of day, always available: play/pause and the clock; the clock opens the day slider (open
 * by default while an hour-by-hour analysis is shown). Drives useApp().hour, which the lighting, the
 * heat and traffic overlays and their figures all follow.
 */
const TimeControl = memo(function TimeControl({ timed }: { timed: boolean }) {
  const hour = useApp((s) => s.hour);
  const setHour = useApp((s) => s.setHour);
  const playing = useApp((s) => s.playing);
  const setPlaying = useApp((s) => s.setPlaying);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? timed;
  // an analysis being opened or closed resets the user's choice to its default
  useEffect(() => setOpen(null), [timed]);
  return (
    <div className="chrome pointer-events-auto flex h-10 shrink-0 items-center gap-1.5 px-1.5" role="group" aria-label="Time of day">
      <Tip label={playing ? "Pause" : "Play the day"} side="top">
        <button onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play the day"} className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-on-accent hover:brightness-110">
          {playing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" className="ml-px" />}
        </button>
      </Tip>
      <div className={cx("flex items-center overflow-hidden transition-[width] duration-200 ease-out", expanded ? "w-[clamp(120px,22cqw,240px)]" : "w-0")}>
        {expanded && <Slider size="sm" min={0} max={24} step={1 / 12} value={[hour]} onValueChange={([v]) => setHour(v % 24)} thumbLabels={["Time of day"]} className="mx-1.5 min-w-0 flex-1" />}
      </div>
      <Tip label={expanded ? "Hide the day slider" : "Change the time of day"} side="top">
        <button onClick={() => setOpen(!expanded)} aria-expanded={expanded} className="tabular h-7 w-[68px] shrink-0 rounded-[5px] px-1 text-right text-[12px] font-medium text-ink hover:bg-paper-3">
          {clock(hour)}
        </button>
      </Tip>
    </div>
  );
});

/** keeps the plan-impact pins current (it follows the clock, so it lives outside the dock's render) */
function PlanImpactSync() {
  usePlanImpact();
  return null;
}

/** the analysis chips; memoised so clock ticks and overlay redraws don't re-render them */
const ChipBar = memo(function ChipBar({ overlay, busy }: { overlay: OverlayId | null; busy: string }) {
  const setOverlay = useApp((s) => s.setOverlay);
  const running = new Set(busy.split(","));
  const avail = availableOverlays();
  const primary = avail.filter((c) => !c.more);
  const extra = avail.filter((c) => c.more);
  const extraOn = extra.find((c) => c.id === overlay);
  return (
    <div className="chrome scroll-ends flex items-center gap-0.5 px-1.5 py-1">
      {primary.map((c) => (
        <Chip key={c.id} c={c} on={overlay === c.id} busy={!!c.sim && running.has(c.sim)} onClick={() => setOverlay(overlay === c.id ? null : c.id)} />
      ))}
      <span className="mx-0.5 h-5 w-px bg-line" />
      <DM.Root>
        <DM.Trigger asChild>
          <button className={cx("flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors outline-none", extraOn ? "bg-accent text-on-accent" : "text-ink-3 hover:bg-paper-3 hover:text-ink")}>
            {extraOn ? <extraOn.icon size={13} strokeWidth={1.8} /> : <Ellipsis size={14} />}
            <span>{extraOn ? extraOn.label : "More"}</span>
            <ChevronUp size={12} className="opacity-70" />
          </button>
        </DM.Trigger>
        <DM.Portal>
          <DM.Content side="top" align="end" sideOffset={8} collisionPadding={8} className="kit-surface kit-pop z-50 w-72 p-1">
            <div className="px-2 pt-1.5 pb-1.5 font-legend text-[11px] leading-4 font-medium text-ink-3">Other analyses</div>
            {extra.map((c) => (
              <DM.Item key={c.id} onSelect={() => setOverlay(overlay === c.id ? null : c.id)} className="flex cursor-default items-center gap-2.5 rounded-[6px] px-2 py-1.5 outline-none data-[highlighted]:bg-paper-3">
                <span className={cx("grid size-7 shrink-0 place-items-center rounded-[6px] border", overlay === c.id ? "border-accent/50 bg-accent text-on-accent" : "border-line bg-paper-2 text-ink-3")}>
                  <c.icon size={14} strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-4 font-medium text-ink">{c.label}</span>
                  <span className="block truncate text-[11px] leading-4 text-ink-4">{c.hint}</span>
                </span>
                {overlay === c.id && <Check size={14} className="shrink-0 text-rose" />}
              </DM.Item>
            ))}
          </DM.Content>
        </DM.Portal>
      </DM.Root>
    </div>
  );
});
