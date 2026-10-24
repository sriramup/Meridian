"use client";

// Main-thread simulation client: one dedicated worker, a job queue, and a
// zustand store of results keyed by scenario + edit cursor so overlays,
// comparisons and the agent all read the same model outputs.

import { create } from "zustand";
import { rt } from "@/state/runtime";
import { monthDate } from "@/state/store";
import type { SimKind } from "./engine";
import { adjacentMonths, evictLru, HEAT_CACHE_BYTES, heatBytes, staleRuns, stateKey } from "./heatCache";
import { reportAssumptions } from "./telemetry";

export interface SimRecord {
  id: string;
  kind: SimKind;
  scenarioId: string;
  scenarioName: string;
  cursor: number;
  params: Record<string, unknown>;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  startedAt: number;
  ms?: number;
  result?: any;
  error?: string;
  label: string;
  /** scenario state modelled (scenario id + applied changeset ids) */
  state?: string;
  /** last time this run was shown or reused (LRU) */
  lastUsed?: number;
  /** a prefetch: never replaces what is shown when it lands */
  background?: boolean;
}

interface SimState {
  ready: boolean;
  records: SimRecord[];
  /** record id currently shown by the overlay for each kind */
  shown: Partial<Record<SimKind, string>>;
  compare: Partial<Record<SimKind, string>>;
  setShown: (kind: SimKind, id: string | undefined) => void;
  setCompare: (kind: SimKind, id: string | undefined) => void;
}

export const useSims = create<SimState>((set) => ({
  ready: false,
  records: [],
  shown: {},
  compare: {},
  setShown: (kind, id) => set((s) => ({ shown: { ...s.shown, [kind]: id } })),
  setCompare: (kind, id) => set((s) => ({ compare: { ...s.compare, [kind]: id } })),
}));

let worker: Worker | null = null;
const pending = new Map<string, { resolve: (r: SimRecord) => void; reject: (e: Error) => void }>();
let readyPromise: Promise<void> | null = null;

function utcOffset(date: string, tz: string) {
  const d = new Date(date + "T12:00:00Z");
  const local = new Date(d.toLocaleString("en-US", { timeZone: tz }));
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((local.getTime() - utc.getTime()) / 3600_000);
}

export function initSimWorker(): Promise<void> {
  if (readyPromise) return readyPromise;
  const R = rt();
  worker = typeof Worker !== "undefined" ? new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" }) : (inProcessWorker() as unknown as Worker);
  readyPromise = new Promise((resolve, reject) => {
    worker!.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m.type === "ready") {
        useSims.setState({ ready: true });
        resolve();
      } else if (m.type === "progress") update(m.id, { progress: m.p });
      else if (m.type === "result" && ctxPending.has(m.id)) {
        ctxPending.get(m.id)!.resolve(m.result);
        ctxPending.delete(m.id);
        jobDone(m.id);
      } else if (m.type === "error" && ctxPending.has(m.id)) {
        ctxPending.get(m.id)!.reject(new Error(m.error));
        ctxPending.delete(m.id);
        jobDone(m.id);
      } else if (m.type === "result") {
        update(m.id, { status: "done", progress: 1, result: m.result, ms: m.ms, lastUsed: performance.now() });
        const rec = useSims.getState().records.find((r) => r.id === m.id)!;
        // background runs of other scenarios (e.g. the baseline for a comparison) and prefetches don't replace what's shown
        if (rec.scenarioId === rt().scenarios.activeId && !rec.background) useSims.getState().setShown(rec.kind, rec.id);
        reportAssumptions(rec.kind, rt().cityId, m.result?.assumptions, rec.kind === "traffic" ? m.result?.calibration : undefined);
        if (rec.kind === "heat") {
          pruneHeat();
          if (!rec.background) prefetchAround(rec);
        }
        jobDone(m.id);
        pending.get(m.id)?.resolve(rec);
        pending.delete(m.id);
      } else if (m.type === "error") {
        if (m.id) jobDone(m.id);
        if (m.id) {
          update(m.id, { status: "error", error: m.error });
          pending.get(m.id)?.reject(new Error(m.error));
          pending.delete(m.id);
        } else reject(new Error(m.error));
      }
    };
    worker!.onerror = (e) => reject(new Error(e.message));
  });
  // baseline entities (the worker replays scenario changesets on top)
  const baseline = R.scenarios.materialize("baseline");
  worker.postMessage({
    type: "init",
    init: {
      meta: R.meta,
      entities: [...baseline.values()],
      landcover: R.landcover,
      dem: R.dem,
      census: R.census,
      counts: R.counts,
      utcOffset: utcOffset(R.meta.weather.date, R.meta.timezone),
      context: R.context,
      contextCover: R.contextCover,
    },
  });
  return readyPromise;
}

/** same message protocol as sim.worker.ts, run on the calling thread (Node harness / no-Worker environments) */
function inProcessWorker() {
  const w = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onerror: null as unknown,
    engine: null as import("./engine").Engine | null,
    mod: import("./engine"),
    postMessage(msg: { type: string; init?: unknown; job?: { id: string } }) {
      const emit = (data: unknown) => setTimeout(() => w.onmessage?.({ data }), 0);
      w.mod.then(({ Engine }) => {
        try {
          if (msg.type === "init") {
            w.engine = new Engine(structuredClone(msg.init) as ConstructorParameters<typeof Engine>[0]);
            emit({ type: "ready" });
            return;
          }
          const t = performance.now();
          const { result } = w.engine!.run(structuredClone(msg.job) as Parameters<import("./engine").Engine["run"]>[0], () => {});
          emit({ type: "result", id: msg.job!.id, result, ms: performance.now() - t });
        } catch (e) {
          emit({ type: "error", id: msg.job?.id, error: (e as Error).message });
        }
      });
    },
  };
  return w;
}

/** runs on screen: the shown and compared heat, and the baseline the plan-impact pins compare against */
function pinnedHeat(): Set<string> {
  const st = useSims.getState();
  const pinned = new Set<string>();
  for (const id of [st.shown.heat, st.compare.heat]) if (id) pinned.add(id);
  const shown = st.records.find((r) => r.id === st.shown.heat);
  if (shown) {
    const p = JSON.stringify(shown.params);
    for (const r of st.records) if (r.kind === "heat" && r.scenarioId === "baseline" && JSON.stringify(r.params) === p) pinned.add(r.id);
  }
  return pinned;
}

/**
 * A full-day heat run is ~48 MB of rasters. Runs of the active scenario's earlier states are dropped
 * (an edit made them obsolete); the rest are kept under an LRU byte budget so revisited and
 * prefetched months are instant.
 */
function pruneHeat(cap = HEAT_CACHE_BYTES) {
  const st = useSims.getState();
  const R = rt();
  const pinned = pinnedHeat();
  const heat = st.records.filter((r) => r.kind === "heat" && r.status === "done");
  const current = stateKey(R.scenarios.activeId, R.scenarios.appliedChangesets().map((c) => c.id));
  const drop = new Set(staleRuns(heat.map((r) => ({ id: r.id, scenarioId: r.scenarioId, state: r.state ?? "" })), R.scenarios.activeId, current, pinned));
  const live = heat.filter((r) => !drop.has(r.id));
  for (const id of evictLru(live.map((r) => ({ id: r.id, bytes: heatBytes(r.result ?? {}), lastUsed: r.lastUsed ?? 0 })), cap, pinned)) drop.add(id);
  if (drop.size) useSims.setState({ records: st.records.filter((r) => !drop.has(r.id)) });
}

// ---- background prefetch: adjacent months, posted to the worker only while it has nothing else to do

const inFlight = new Set<string>();
let bgQueue: { kind: SimKind; params: Record<string, unknown>; sid: string; state: string; context?: boolean }[] = [];
let bgTimer: ReturnType<typeof setTimeout> | null = null;

function jobDone(id: string) {
  inFlight.delete(id);
  schedulePump();
}

function schedulePump(delay = 700) {
  if (bgTimer || !bgQueue.length) return;
  bgTimer = setTimeout(() => {
    bgTimer = null;
    const idle = (cb: () => void) => (typeof requestIdleCallback !== "undefined" ? requestIdleCallback(cb, { timeout: 1500 }) : cb());
    idle(pump);
  }, delay);
}

function pump() {
  if (inFlight.size || !bgQueue.length) return schedulePump();
  const R = rt();
  const job = bgQueue.shift()!;
  // the surrounding city is scenario-independent: cached by parameters alone
  if (job.context) {
    contextModel("heat", job.params, () => {});
    return schedulePump();
  }
  // a prefetch for a state the user has since edited away from is pointless
  if (job.state !== stateKey(job.sid, R.scenarios.appliedChangesets(job.sid).map((c) => c.id))) return pump();
  runSim(job.kind, job.params, job.sid, { background: true }).catch(() => {});
}

/** after a heat run lands, model the neighbouring months in idle time (one at a time) */
function prefetchAround(rec: SimRecord) {
  const md = rec.params.date as string | undefined;
  if (!md || !/^\d\d-\d\d$/.test(md) || rec.scenarioId !== rt().scenarios.activeId) return;
  const ctx = !rt().meta.sandbox && rt().context.buildings.length > 0;
  bgQueue = adjacentMonths(md, monthDate).flatMap((date) => {
    const job = { kind: rec.kind, params: { ...rec.params, date }, sid: rec.scenarioId, state: rec.state ?? "" };
    return ctx ? [job, { ...job, context: true }] : [job];
  });
  schedulePump();
}

/** test / debug: the finished heat runs held, with their months and sizes */
export function heatCacheInfo() {
  return useSims
    .getState()
    .records.filter((r) => r.kind === "heat" && r.status === "done")
    .map((r) => ({ id: r.id, scenario: r.scenarioId, date: r.params.date, state: r.state, mb: Math.round(heatBytes(r.result ?? {}) / 1e5) / 10, background: !!r.background }));
}

function update(id: string, patch: Partial<SimRecord>) {
  useSims.setState((s) => ({ records: s.records.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
}

const LABEL: Record<SimKind, string> = {
  traffic: "Traffic assignment",
  heat: "Heat exposure",
  context: "Surrounding city",
  runoff: "Stormwater runoff",
  flood: "Flood inundation",
  access: "Walk accessibility",
  capacity: "Development capacity",
  sun: "Sunlight hours",
  metrics: "Scenario metrics",
  sites: "Site reach",
  bike: "Bicycle stress (LTS)",
  emergency_opt: "Emergency access search",
  growth: "Growth scenario",
};

export interface WeatherNormals {
  source: string;
  years: [number, number];
  /** "MM-DD" → typical hourly air temperature / shortwave */
  days: Record<string, { t: number[]; sw: number[] }>;
}

/** sun positions for a month-day are computed in this (non-leap) year */
export const SUN_YEAR = 2025;

let normals: Promise<WeatherNormals | null> | null = null;
/** typical hourly weather for every month-day (scripts/fetch_weather.py); null when the pack has none */
export function loadWeather(): Promise<WeatherNormals | null> {
  // revalidate: /data is cached for an hour and an older weather.json had dated ("YYYY-MM-DD") keys
  normals ??= fetch(`/data/${rt().climateId}/weather.json`, { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return normals;
}

/** typical weather for a month-day; tolerates dated keys; null when the pack has none for it */
async function weatherFor(md: string): Promise<{ t: number[]; sw: number[] } | null> {
  const w = await loadWeather();
  if (!w?.days) return null;
  if (w.days[md]) return w.days[md];
  const dated = Object.keys(w.days).find((k) => k.endsWith(`-${md}`));
  if (dated) return w.days[dated];
  // Feb 29 and any other gap: the nearest earlier day
  const [m, d] = md.split("-").map(Number);
  return d > 1 ? weatherFor(`${String(m).padStart(2, "0")}-${String(d - 1).padStart(2, "0")}`) : null;
}

/**
 * Dated runs: params.date is a month-day ("MM-DD"). The worker gets a full date for the sun
 * position, that day's UTC offset (daylight saving) and, for heat, the multi-year typical weather.
 */
async function jobParams(kind: SimKind, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const md = params.date as string | undefined;
  if (!md || (kind !== "heat" && kind !== "sun") || !/^\d\d-\d\d$/.test(md)) return params;
  const R = rt();
  const date = `${SUN_YEAR}-${md}`;
  const out: Record<string, unknown> = { ...params, date, utcOffset: utcOffset(date, R.meta.timezone) };
  if (kind === "heat") {
    // without typical weather the worker falls back to the pack's measured reference day
    const day = await weatherFor(md);
    if (day) out.weather = day;
  }
  return out;
}

let seq = 0;
export async function runSim(kind: SimKind, params: Record<string, unknown> = {}, scenarioId?: string, opts: { background?: boolean } = {}): Promise<SimRecord> {
  await initSimWorker();
  const R = rt();
  const sid = scenarioId ?? R.scenarios.activeId;
  const sc = R.scenarios.scenarios.get(sid);
  if (!sc) throw new Error(`unknown scenario ${sid}`);
  const changesets = R.scenarios.appliedChangesets(sid);
  const state = stateKey(sid, changesets.map((c) => c.id));
  const pj = JSON.stringify(params);
  // reuse an identical run: finished (a cache hit), or still running (e.g. a prefetch the user caught up with)
  const same = useSims.getState().records.find((r) => r.kind === kind && r.state === state && (r.status === "done" ? !!r.result : r.status === "running") && JSON.stringify(r.params) === pj);
  if (same?.status === "done") {
    update(same.id, { lastUsed: performance.now(), ...(opts.background ? {} : { background: false }) });
    if (sid === R.scenarios.activeId && !opts.background) useSims.getState().setShown(kind, same.id);
    return useSims.getState().records.find((r) => r.id === same.id)!;
  }
  if (same) {
    // promote a running prefetch: it will be shown when it lands
    if (!opts.background) update(same.id, { background: false });
    return new Promise((resolve, reject) => {
      const prev = pending.get(same.id);
      pending.set(same.id, { resolve: (r) => (prev?.resolve(r), resolve(r)), reject: (e) => (prev?.reject(e), reject(e)) });
    });
  }
  // a user-requested run goes first: anything not yet sent to the worker in the background waits
  if (!opts.background) bgQueue = bgQueue.filter((j) => j.kind !== kind);
  const job = await jobParams(kind, params);
  const id = `sim${++seq}`;
  const rec: SimRecord = { id, kind, scenarioId: sid, scenarioName: sc.name, cursor: changesets.length, params, status: "running", progress: 0, startedAt: Date.now(), label: LABEL[kind], state, background: opts.background };
  // heat runs are retained by pruneHeat's byte budget; other kinds by count
  useSims.setState((s) => {
    const other = s.records.filter((r) => r.kind !== "heat");
    const drop = new Set(other.slice(0, Math.max(0, other.length - 40)).map((r) => r.id));
    return { records: [...s.records.filter((r) => !drop.has(r.id)), rec] };
  });
  inFlight.add(id);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ type: "run", job: { id, kind, changesets, params: job } });
  });
}

export function latest(kind: SimKind, scenarioId?: string): SimRecord | undefined {
  const recs = useSims.getState().records.filter((r) => r.kind === kind && r.status === "done" && (!scenarioId || r.scenarioId === scenarioId));
  return recs[recs.length - 1];
}

type Grid = { x0: number; y0: number; cell: number; nx: number; ny: number };
export type ContextResult =
  | { model: "heat"; hours: number[]; surface: Uint8Array[]; airTemp: number[]; gridSpec: Grid }
  | { model: "sun"; grid: Float32Array; gridSpec: Grid }
  | { model: "runoff"; grid: Uint8Array; gridSpec: Grid };

const ctxPending = new Map<string, { resolve: (r: ContextResult) => void; reject: (e: Error) => void }>();
const ctxRunning = new Set<string>();
const ctxDone = new Map<string, ContextResult>();

/**
 * Heat / shade / runoff for the surrounding city with the same parameters as a study-area run.
 * Scenario-independent (edits stay inside the study area), so results are cached by parameters and
 * kept out of the scenario records. Returns the result when ready; otherwise starts it, returns
 * null and calls onReady once it lands.
 */
export function contextModel(model: ContextResult["model"], params: Record<string, unknown>, onReady: () => void): ContextResult | null {
  const key = `${model}:${JSON.stringify(params)}`;
  const hit = ctxDone.get(key);
  if (hit) return hit;
  if (!ctxRunning.has(key)) {
    ctxRunning.add(key);
    (async () => {
      await initSimWorker();
      const job = model === "runoff" ? params : await jobParams(model, params);
      const id = `ctx${++seq}`;
      inFlight.add(id);
      return new Promise<ContextResult>((resolve, reject) => {
        ctxPending.set(id, { resolve, reject });
        worker!.postMessage({ type: "run", job: { id, kind: "context", changesets: [], params: { ...job, model } } });
      });
    })()
      .then((r) => {
        if (ctxDone.size >= 6) ctxDone.delete(ctxDone.keys().next().value!);
        ctxDone.set(key, r);
        onReady();
      })
      .catch(() => {})
      .finally(() => ctxRunning.delete(key));
  }
  return null;
}
