"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Bike, Car, Check, ChevronLeft, ChevronRight, ChevronUp, CloudRain, Droplets, Ellipsis, Footprints, Info, LayoutGrid, LoaderCircle, Pause, Play, RefreshCw, Sun, Thermometer, TramFront, TreeDeciduous, TrendingUp, Users, GitCompare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { runSim, useSims, type SimRecord } from "@/sim/client";
import { DIVERGE, cssGradient } from "@/render/palettes";
import { growthSnapshot, legendFor, overlayState } from "@/render/overlays";
import { rt } from "@/state/runtime";
import { monthDate, useApp, type OverlayId } from "@/state/store";
import { fmtF } from "@/lib/units";
import type { SimKind } from "@/sim/engine";
import { compareWith, usePlanImpact } from "./ImpactPanel";
import { Button, Segmented, Tip, cx } from "./ui";

export const CHIPS: { id: OverlayId; label: string; icon: typeof Car; sim?: SimKind; hint: string; more?: boolean }[] = [
  { id: "heat", label: "Heat", icon: Thermometer, sim: "heat", hint: "How hot it feels on the street, hour by hour" },
  { id: "sun", label: "Shade", icon: Sun, sim: "sun", hint: "Hours of direct sun per spot (fewer = more shade)" },
  { id: "runoff", label: "Stormwater", icon: CloudRain, sim: "runoff", hint: "Design-storm runoff from hard surfaces" },
  { id: "traffic", label: "Traffic", icon: Car, sim: "traffic", hint: "Peak-hour assignment", more: true },
  { id: "density", label: "Density", icon: Users, hint: "Residents / jobs per ha", more: true },
  { id: "access", label: "Access", icon: Footprints, sim: "access", hint: "Walk times", more: true },
  { id: "bike", label: "Bike", icon: Bike, sim: "bike", hint: "Bicycle level of traffic stress", more: true },
  { id: "zoning", label: "Capacity", icon: LayoutGrid, sim: "capacity", hint: "Zoned development capacity", more: true },
  { id: "growth", label: "Growth", icon: TrendingUp, sim: "growth", hint: "Where residential growth could go", more: true },
  { id: "transit", label: "Transit", icon: TramFront, hint: "Routes & 400 m catchments", more: true },
  { id: "flood", label: "Flood", icon: Droplets, sim: "flood", hint: "Inundation screening", more: true },
  { id: "change", label: "Changes", icon: GitCompare, hint: "What your plan adds and removes", more: true },
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
  const setOverlay = useApp((s) => s.setOverlay);
  const hour = useApp((s) => s.hour);
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
  const running = records.find((r) => r.kind === chip?.sim && r.status === "running");
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
    const have = () => useSims.getState().records.some((r) => r.kind === kind && r.scenarioId === R.scenarios.activeId && r.cursor === R.scenarios.active.cursor && (r.status === "done" || r.status === "running") && (!dated || r.params.date === date));
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
  const kpis = useMemo(() => (rec?.status === "done" ? kpiFor(rec) : []), [rec]);
  usePlanImpact();
  const avail = availableOverlays();
  const primary = avail.filter((c) => !c.more);
  const extra = avail.filter((c) => c.more);
  const extraOn = extra.find((c) => c.id === overlay);

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
                  <DatePicker />
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
                  <select
                    value={cmpRec?.scenarioId ?? ""}
                    onChange={(e) => compareWith(chip.sim!, e.target.value, rec?.params ?? defaultParams(chip.sim!)).then(bumpOverlay)}
                    className="h-7 max-w-[140px] rounded-[5px] border border-line-2 bg-paper px-1 text-[11.5px] text-ink-2"
                    title="Show the difference against another scenario"
                  >
                    <option value="">No comparison</option>
                    {scenarios
                      .filter((s) => s.id !== R.scenarios.activeId)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          Δ vs {s.name}
                        </option>
                      ))}
                  </select>
                )}
                {chip?.sim && !LIVE.has(chip.sim) && (
                  <Tip label="Re-run on the current scenario">
                    <button onClick={() => run(chip.sim!, rec?.params ?? defaultParams(chip.sim!))} className="grid h-7 w-7 place-items-center rounded-[5px] text-ink-3 hover:bg-paper-3 hover:text-ink">
                      <RefreshCw size={13} className={cx(running && "animate-spin")} />
                    </button>
                  </Tip>
                )}
                {rec?.result?.assumptions && <Assumptions lines={rec.result.assumptions} calibration={rec.kind === "traffic" ? rec.result.calibration : undefined} />}
              </div>
            </div>
            {(overlay === "traffic" || overlay === "heat") && (
              <div className="flex items-center gap-2">
                <button onClick={() => setPlaying(!playing)} className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-on-accent hover:brightness-110" title={playing ? "Pause" : "Play the day"}>
                  {playing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" className="ml-px" />}
                </button>
                <input type="range" min={0} max={24} step={1 / 12} value={hour} onChange={(e) => setHour(+e.target.value % 24)} className="h-1 min-w-0 flex-1" />
                <span className="tabular w-[66px] shrink-0 text-right text-[12px] font-medium text-ink">{clock(hour)}</span>
                {overlay === "traffic" && (
                  <Segmented
                    size="xs"
                    value={(rec?.params?.period as string) ?? "pm"}
                    onChange={(v) => {
                      setHour(v === "am" ? 8 : 17);
                      run("traffic", { period: v });
                    }}
                    options={[
                      { value: "am", label: "AM" },
                      { value: "pm", label: "PM" },
                    ]}
                  />
                )}
              </div>
            )}
          </div>
          {/* KPIs */}
          {kpis.length > 0 && (
            <div className="grid grid-cols-[repeat(2,max-content)] content-center gap-x-5 gap-y-1 border-l border-line px-3 py-2 @max-[480px]:gap-x-3">
              {kpis.slice(0, 4).map((k) => (
                <div key={k.label} className="whitespace-nowrap">
                  <div className="text-[10px] text-ink-4">{k.label}</div>
                  <div className="tabular text-[13px] font-semibold text-ink">{k.value}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="chrome scroll-ends flex items-center gap-0.5 px-1.5 py-1">
        {primary.map((c) => (
          <Chip key={c.id} c={c} on={overlay === c.id} busy={!!c.sim && records.some((r) => r.kind === c.sim && r.status === "running")} onClick={() => setOverlay(overlay === c.id ? null : c.id)} />
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
            <DM.Content side="top" align="end" sideOffset={8} className="chrome z-50 w-60 p-1">
              <div className="px-2 pt-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-ink-4 uppercase">Other analyses</div>
              {extra.map((c) => (
                <DM.Item key={c.id} onSelect={() => setOverlay(overlay === c.id ? null : c.id)} className="flex cursor-default items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12.5px] text-ink outline-none data-[highlighted]:bg-paper-3">
                  <c.icon size={13} strokeWidth={1.8} className="text-ink-3" />
                  <span className="flex-1">{c.label}</span>
                  <span className="truncate text-[10.5px] text-ink-4">{c.hint}</span>
                  {overlay === c.id && <Check size={13} className="shrink-0 text-rose" />}
                </DM.Item>
              ))}
            </DM.Content>
          </DM.Portal>
        </DM.Root>
      </div>
    </div>
  );
}

function Chip({ c, on, busy, onClick }: { c: (typeof CHIPS)[number]; on: boolean; busy: boolean; onClick: () => void }) {
  const Icon = c.icon;
  return (
    <Tip label={c.hint} side="top">
      <button onClick={onClick} className={cx("flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors", on ? "bg-accent text-on-accent" : "text-ink-2 hover:bg-paper-3 hover:text-ink")}>
        {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Icon size={13} strokeWidth={1.8} />}
        <span className="hidden @[560px]:inline">{c.label}</span>
      </button>
    </Tip>
  );
}

/** modelled hours for the heat overlay: hourly through the day, every two hours overnight */
const HEAT_HOURS = [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

export function defaultParams(kind: SimKind): Record<string, unknown> {
  if (kind === "traffic") return { period: useApp.getState().hour < 12 ? "am" : "pm" };
  if (kind === "heat") return { deltaT: 0, date: useApp.getState().date, hours: HEAT_HOURS };
  if (kind === "flood") return { rise: 4 };
  if (kind === "runoff") return { storm: "25yr" };
  if (kind === "sun") return { date: useApp.getState().date };
  if (kind === "growth") return { years: 20 };
  return {};
}

function OverlayMode({ overlay, onChange }: { overlay: OverlayId | null; onChange: () => void }) {
  if (overlay === "heat")
    return (
      <Segmented
        size="xs"
        value={overlayState.heatMode}
        onChange={(v) => {
          overlayState.heatMode = v;
          onChange();
        }}
        options={[
          { value: "exposure", label: "Pedestrian" },
          { value: "surface", label: "Surface" },
        ]}
      />
    );
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
      <select
        value={overlayState.accessCategory}
        onChange={(e) => {
          overlayState.accessCategory = e.target.value;
          onChange();
        }}
        className="h-7 rounded-[5px] border border-line-2 bg-paper px-1 text-[11.5px]"
      >
        {["frequent_transit", "transit", "grocery", "school", "park", "health", "food", "emergency"].map((c) => (
          <option key={c} value={c}>
            {c === "emergency" ? "fire / EMS (drive)" : c.replace("_", " ")}
          </option>
        ))}
      </select>
    );
  return null;
}

function Assumptions({ lines, calibration }: { lines: string[]; calibration?: { road: string; observed: number; modelled: number; geh: number }[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="grid h-7 w-7 place-items-center rounded-[5px] text-ink-3 hover:bg-paper-3 hover:text-ink" title="Model assumptions">
          <Info size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={8} className="chrome z-50 w-[380px] p-3">
          <div className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-4 uppercase">Model assumptions</div>
          <ul className="mt-1.5 space-y-1 text-[11.5px] leading-snug text-ink-2">
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          {calibration && calibration.length > 0 && (
            <>
              <div className="mt-3 text-[10.5px] font-semibold tracking-[0.08em] text-ink-4 uppercase">Check against TxDOT counts (peak hour)</div>
              <div className="mt-1 text-[11px] text-ink-3">
                GEH &lt; 5 at {calibration.filter((c) => c.geh < 5).length} of {calibration.length} stations — not validated for absolute volumes.
              </div>
              <table className="mt-1.5 w-full text-[11px] tabular">
                <thead className="text-ink-4">
                  <tr>
                    <th className="text-left font-normal">Station</th>
                    <th className="text-right font-normal">Count</th>
                    <th className="text-right font-normal">Model</th>
                    <th className="text-right font-normal">GEH</th>
                  </tr>
                </thead>
                <tbody>
                  {calibration.slice(0, 10).map((c, i) => (
                    <tr key={i} className="text-ink-2">
                      <td className="truncate">{c.road}</td>
                      <td className="text-right">{c.observed}</td>
                      <td className="text-right">{c.modelled}</td>
                      <td className={cx("text-right", c.geh < 5 ? "text-good" : c.geh < 10 ? "text-warn" : "text-bad")}>{c.geh}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function kpiFor(rec: SimRecord): { label: string; value: string }[] {
  const r = rec.result;
  const f = (x: number, d = 0) => x.toLocaleString(undefined, { maximumFractionDigits: d });
  switch (rec.kind) {
    case "traffic":
      return [
        { label: "Delay veh·h", value: f(r.kpi.delayHours) },
        { label: "Avg speed", value: `${f(r.kpi.avgSpeedKmh, 1)} km/h` },
        { label: "Congested", value: `${f(r.kpi.congestedKm, 1)} km` },
        { label: "Veh trips", value: f(r.kpi.vehTrips) },
      ];
    case "heat":
      return [
        { label: "Feels like on foot", value: fmtF(r.kpi.meanExposure) },
        { label: "Above 104 °F", value: `${f(r.kpi.pedHotShare * 100)}%` },
        { label: "Canopy", value: `${f(r.kpi.canopy * 100, 1)}%` },
        { label: "Shaded paths", value: `${f(r.kpi.shadedPedShare * 100)}%` },
      ];
    case "bike":
      return [
        { label: "Low-stress km", value: `${f(r.kmByLts[1] + r.kmByLts[2], 1)}` },
        { label: "LTS 4 km", value: `${f(r.kmByLts[4], 1)}` },
        { label: "Grocery, low-stress", value: `${f((r.coverage.grocery?.lowStress ?? 0) * 100)}%` },
        { label: "Largest island", value: `${f(r.islands[0]?.residents ?? 0)}` },
      ];
    case "access":
      return [
        { label: "Frequent transit", value: `${f(r.coverage.frequent_transit * 100)}%` },
        { label: "Any stop 400 m", value: `${f(r.coverage.transit * 100)}%` },
        { label: "Grocery 15 min", value: `${f(r.coverage.grocery * 100)}%` },
        { label: "Park 15 min", value: `${f(r.coverage.park * 100)}%` },
      ];
    case "flood":
      return [
        { label: "Water level", value: `+${f(r.rise, 1)} m` },
        { label: "Flooded area", value: `${f(r.floodedM2 / 10000, 1)} ha` },
        { label: "Buildings", value: f(r.buildings.length) },
        { label: "Residents", value: f(r.residents) },
      ];
    case "runoff":
      return [
        { label: "Runoff", value: `${f(r.volumeM3 / 1000)}k m³` },
        { label: "Mean depth", value: `${f(r.depthMm)} mm` },
        { label: "Impervious", value: `${f(r.imperviousFraction * 100)}%` },
        { label: "Storage", value: `${f(r.storageM3)} m³` },
      ];
    case "capacity": {
      const ps = r.parcels as { addedUnits: number; addedGfa: number }[];
      return [
        { label: "Added units", value: f(ps.reduce((s, p) => s + p.addedUnits, 0)) },
        { label: "Added GFA", value: `${f(ps.reduce((s, p) => s + p.addedGfa, 0) / 1e6, 2)}M m²` },
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
      return r.stats ? [{ label: "Mean sun", value: `${f(r.stats.meanHours, 1)} h` }] : [{ label: "Date", value: String(r.date) }];
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** the modelled month (sun path and typical weather of its mean day), with month-by-month arrows */
function DatePicker() {
  const date = useApp((s) => s.date);
  const setDate = useApp((s) => s.setDate);
  const m = +date.slice(0, 2) - 1;
  const step = "grid h-7 w-6 place-items-center rounded-[5px] text-ink-3 hover:bg-paper-3 hover:text-ink";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button onClick={() => setDate(monthDate(m - 1))} className={step} title="Previous month">
        <ChevronLeft size={14} />
      </button>
      <select value={m} onChange={(e) => setDate(monthDate(+e.target.value))} className="h-7 w-[62px] rounded-[5px] border border-line-2 bg-paper px-1 text-[12.5px] font-medium text-ink outline-none hover:border-accent/60" aria-label="Month" title="Modelled month: sun path and typical weather">
        {MONTHS.map((x, i) => (
          <option key={x} value={i}>
            {x}
          </option>
        ))}
      </select>
      <button onClick={() => setDate(monthDate(m + 1))} className={step} title="Next month">
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
