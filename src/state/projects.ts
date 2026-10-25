// Projects: each is a named piece of work started from a template (the blank canvas or a measured
// city), with every proposal and its undo history, saved in this browser as you work. Opening one
// never reloads the page: the next runtime is built while the current one stays on screen under the
// loading card, then the two are swapped (map, deck overlay, sim worker, stores, timers torn down).
//
// Other modules key per-project state off `currentProjectId()` and `onProjectChange`.

import { flushSync } from "react-dom";
import { create } from "zustand";
import { CITY_PRESETS, climateOf, cityFromUrl, presetOf } from "./cities";
import { defaultBackend, type LegacyDesign, type ProjectBackend, type ProjectData, type ProjectMeta, type SavedView } from "./persist";
import { buildCity, buildSandbox, disposeRuntime, installRuntime, onRuntimeDispose, rtMaybe, type Runtime } from "./runtime";
import { useApp } from "./store";
import { LocalProjection } from "@/world/projection";

export type { ProjectMeta } from "./persist";

// ---------------------------------------------------------------- pure helpers (tested)

export const newProjectId = () => `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const sortProjects = (list: ProjectMeta[]) => [...list].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

/** `name`, or `name 2`, `name 3`… so no two projects share a name */
export function uniqueName(name: string, list: { name: string }[], except?: string): string {
  const taken = new Set(list.filter((p) => p.name !== except).map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const stem = name.replace(/\s+\d+$/, "");
  for (let i = 2; ; i++) if (!taken.has(`${stem} ${i}`.toLowerCase())) return `${stem} ${i}`;
}

/** a new project's entry, placed at the top of the list */
export function makeProject(base: string, list: ProjectMeta[], opts: { name?: string; now?: number; id?: string } = {}): ProjectMeta {
  const preset = presetOf(base);
  if (!preset) throw new Error(`unknown template ${base}`);
  const now = opts.now ?? Date.now();
  const top = list.length ? Math.min(...list.map((p) => p.order)) : 1;
  return { id: opts.id ?? newProjectId(), name: uniqueName(opts.name?.trim() || preset.projectName, list), base, climate: climateOf(base), createdAt: now, updatedAt: now, order: top - 1 };
}

/** the list with `id` moved to position `to` (0-based), orders renumbered 0…n-1 */
export function moveProject(list: ProjectMeta[], id: string, to: number): ProjectMeta[] {
  const sorted = sortProjects(list);
  const from = sorted.findIndex((p) => p.id === id);
  if (from < 0) return sorted;
  const [p] = sorted.splice(from, 1);
  sorted.splice(Math.max(0, Math.min(sorted.length, to)), 0, p);
  return sorted.map((q, i) => (q.order === i ? q : { ...q, order: i }));
}

/** the project to show after `id` is deleted: the next one down, else the one above */
export function neighbourOf(list: ProjectMeta[], id: string): string | null {
  const sorted = sortProjects(list);
  const i = sorted.findIndex((p) => p.id === id);
  return sorted[i + 1]?.id ?? sorted[i - 1]?.id ?? null;
}

/**
 * Bring work saved by versions before projects into the project list, once: the blank-canvas design
 * becomes a project with every branch and its history. Returns the created project, if any.
 */
export async function migrateLegacy(be: ProjectBackend, now = Date.now()): Promise<ProjectMeta | null> {
  if (await be.kvGet<boolean>("migrated")) return null;
  const legacy: LegacyDesign | null = await be.legacyDesign();
  let made: ProjectMeta | null = null;
  if (legacy && legacy.scenarios.changesets.length > 0) {
    const t = Date.parse(legacy.savedAt) || now;
    made = { ...makeProject("sandbox", await be.list(), { name: "My design", now: t }), climate: legacy.climate || "austin", updatedAt: t };
    await be.putData(made.id, { scenarios: legacy.scenarios });
    await be.putMeta(made);
  }
  await be.kvSet("migrated", true);
  return made;
}

/** the city a plain visit opens on */
export const HOME_CITY = "austin";

/**
 * Which project the page opens: ?project=…, else a project of the ?city=… (Austin when none is
 * given): the last one opened if it is one, else its most recent, else a new one.
 */
export function pickInitial(list: ProjectMeta[], ask: { project?: string | null; city?: string | null; last?: string | null }): { open: string } | { create: string } {
  if (ask.project && list.some((p) => p.id === ask.project)) return { open: ask.project };
  const city = ask.city || HOME_CITY;
  const of = list.filter((p) => p.base === city);
  if (ask.last && of.some((p) => p.id === ask.last)) return { open: ask.last };
  const recent = of.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return recent ? { open: recent.id } : { create: city };
}

// ---------------------------------------------------------------- store

export interface Switching {
  id: string;
  name: string;
  base: string;
  progress: number;
  label: string;
  error?: string;
}

interface ProjectsState {
  /** every project, sorted by order */
  list: ProjectMeta[];
  currentId: string | null;
  /** set once the list has been read from storage */
  loaded: boolean;
  /** false when this browser blocks storage (work lasts only as long as the page) */
  durable: boolean;
  sidebarOpen: boolean;
  /** a project being opened (drives the loading card) */
  switching: Switching | null;
  /** project whose name is being edited inline in the sidebar */
  renamingId: string | null;
}

const SIDEBAR_KEY = "meridian.sidebar";
const readSidebar = () => {
  try {
    const v = localStorage.getItem(SIDEBAR_KEY);
    // open by default where the map keeps room beside it
    return v === null ? window.innerWidth >= 1200 : v === "1";
  } catch {
    return true;
  }
};

export const useProjects = create<ProjectsState>(() => ({ list: [], currentId: null, loaded: false, durable: true, sidebarOpen: true, switching: null, renamingId: null }));
if (typeof window !== "undefined") (window as unknown as { __meridianProjects: typeof useProjects }).__meridianProjects = useProjects;

export const currentProjectId = () => useProjects.getState().currentId;
export const currentProject = () => {
  const s = useProjects.getState();
  return s.list.find((p) => p.id === s.currentId) ?? null;
};

const changeListeners = new Set<(id: string, prev: string | null) => void>();
const leaveListeners = new Set<(id: string) => void>();
/** called once a project is open and its runtime installed (also for the first project of the page) */
export function onProjectChange(fn: (id: string, prev: string | null) => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
/** called just before the open project's runtime is torn down (its work is already saved) */
export function onProjectLeave(fn: (id: string) => void): () => void {
  leaveListeners.add(fn);
  return () => leaveListeners.delete(fn);
}
const fire = <A extends unknown[]>(set: Set<(...a: A) => void>, ...a: A) => {
  for (const fn of [...set])
    try {
      fn(...a);
    } catch (e) {
      console.error(e);
    }
};

export function setSidebarOpen(open: boolean) {
  useProjects.setState({ sidebarOpen: open });
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? "1" : "0");
  } catch {}
  // the map follows its container
  setTimeout(() => rtMaybe()?.map?.resize(), 0);
}
export const toggleSidebar = () => setSidebarOpen(!useProjects.getState().sidebarOpen);

// ---------------------------------------------------------------- storage

let be: ProjectBackend | null = null;
const backend = () => {
  if (!be) throw new Error("projects not initialised");
  return be;
};

function setList(list: ProjectMeta[]) {
  useProjects.setState({ list: sortProjects(list) });
}
function patchMeta(id: string, patch: Partial<ProjectMeta>): ProjectMeta | null {
  const cur = useProjects.getState().list.find((p) => p.id === id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  setList(useProjects.getState().list.map((p) => (p.id === id ? next : p)));
  return next;
}
const warn = (text: string) => useApp.getState().notify(text, "warn");

/** the camera of the open map in local metres */
function readView(R: Runtime): SavedView | undefined {
  const map = R.map;
  if (!map) return undefined;
  const c = map.getCenter();
  const [x, y] = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat).toLocal(c.lng, c.lat);
  return { center: [x, y], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
}

// ---------------------------------------------------------------- autosave

let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
let lastView: SavedView | undefined;

/** write the open project's work now (no-op while nothing is open) */
export function saveCurrent(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const id = currentProjectId();
  const R = rtMaybe();
  if (!id || !R || !be) return saving;
  const data: ProjectData = { scenarios: R.scenarios.snapshot(), view: readView(R) ?? lastView };
  const wasDirty = dirty;
  dirty = false;
  const b = be;
  saving = saving
    .then(async () => {
      await b.putData(id, data);
      if (wasDirty) {
        const m = patchMeta(id, { updatedAt: Date.now() });
        if (m) await b.putMeta(m);
      }
    })
    .catch(() => warn("Could not save in this browser — export the proposal to keep it"));
  return saving;
}

function scheduleSave(edit: boolean, delay = 700) {
  if (edit) dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveCurrent(), delay);
}

/** keep saving the installed runtime: after every scenario change, and when the camera settles */
function startAutosave(R: Runtime) {
  const offScen = R.scenarios.onChange(() => scheduleSave(true));
  let map: Runtime["map"] = null;
  const moved = () => {
    lastView = readView(R) ?? lastView;
    scheduleSave(false, 1500);
  };
  const iv = setInterval(() => {
    if (!R.map) return;
    map = R.map;
    map.on("moveend", moved);
    clearInterval(iv);
  }, 200);
  const off = onRuntimeDispose((r) => {
    if (r !== R) return;
    offScen();
    clearInterval(iv);
    map?.off("moveend", moved);
    off();
  });
}

if (typeof window !== "undefined") {
  // a closing tab or one sent to the background saves what is pending
  const flush = () => (saveTimer || dirty ? void saveCurrent() : undefined);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  window.addEventListener("popstate", () => {
    const id = new URLSearchParams(window.location.search).get("project");
    if (id && id !== currentProjectId() && useProjects.getState().list.some((p) => p.id === id)) void openProject(id, { history: "none" });
  });
}

// ---------------------------------------------------------------- lifecycle

/** let the page paint (a frame, or 60 ms when frames are not coming: hidden tab, busy GPU) */
const frame = () =>
  new Promise<void>((r) => {
    const t = setTimeout(r, 60);
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => setTimeout(() => (clearTimeout(t), r()), 0));
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setUrl(id: string, mode: "push" | "replace" | "none") {
  if (typeof window === "undefined" || mode === "none") return;
  const u = new URL(window.location.href);
  u.searchParams.delete("city");
  u.searchParams.set("project", id);
  if (u.href === window.location.href) return;
  if (mode === "push") window.history.pushState(null, "", u);
  else window.history.replaceState(null, "", u);
}

function setTitle() {
  if (typeof document === "undefined") return;
  const p = currentProject();
  document.title = p ? `${p.name} · Meridian` : "Meridian";
}

/** app state that belongs to one world (selection, tool, overlay…), back to where a new one starts */
async function resetWorldState(R: Runtime) {
  const sandbox = !!R.meta.sandbox;
  useApp.setState((s) => ({
    selection: [],
    hover: null,
    tool: "select",
    overlay: sandbox ? null : "heat",
    showChanges: !sandbox,
    compareId: null,
    annotations: [],
    highlight: null,
    cameraMode: "orbit",
    panel: null,
    playing: false,
    layers: { ...s.layers, transit: sandbox },
    worldVersion: s.worldVersion + 1,
    scenarioVersion: s.scenarioVersion + 1,
    overlayVersion: s.overlayVersion + 1,
  }));
  const [{ useImpact }, { useLibrary }, { useStreetView }, { useZoneDraw }, { resetDraw }] = await Promise.all([
    import("@/sim/impact"),
    import("@/components/library/libraryStore"),
    import("@/components/pedestrian/layers"),
    import("@/components/agents/zoneDraw"),
    import("./drawing"),
  ]);
  useImpact.getState().set(null);
  useLibrary.setState({ defId: null, points: [], cursor: null, drag: null, moving: null, moveFrom: null });
  useStreetView.setState({ cursor: null, chevrons: [], hot: null });
  useZoneDraw.setState({ mode: null, sessionId: null, points: [], cursor: null });
  resetDraw();
}

let busy = false;
let queued: { id: string; history: "push" | "replace" | "none" } | null = null;

/**
 * Open a project without a page load. The current project is saved and stays on screen (under the
 * loading card) while the next one is built; then the two are swapped. A failure leaves the current
 * project open.
 */
export async function openProject(id: string, opts: { history?: "push" | "replace" | "none" } = {}): Promise<boolean> {
  const history = opts.history ?? "push";
  const st = useProjects.getState();
  const meta = st.list.find((p) => p.id === id);
  if (!meta) return false;
  if (busy) {
    queued = { id, history };
    return false;
  }
  if (st.currentId === id && rtMaybe()) return false;
  const preset = presetOf(meta.base);
  if (!preset) return false;
  busy = true;
  const shown = Date.now();
  // whole percents only: a pack streams in hundreds of chunks
  const progress = (p: number, label: string) => {
    const sw = useProjects.getState().switching;
    if (sw?.id !== id || (sw.label === label && Math.floor(sw.progress * 100) === Math.floor(p * 100))) return;
    useProjects.setState({ switching: { ...sw, progress: p, label } });
  };
  useProjects.setState({ switching: { id, name: meta.name, base: meta.base, progress: 0, label: "Opening" } });
  const prevId = st.currentId;
  try {
    // the open project is saved before anything else happens
    await saveCurrent();
    const build = () => (preset.kind === "sandbox" ? buildSandbox(meta.climate || preset.climate!, (p, l) => progress(p * 0.5, l)) : buildCity(meta.base, (p, l) => progress(p * 0.9, l)));
    let [next, data] = await Promise.all([build(), backend().getData(id)]);
    progress(0.93, "Restoring proposals");
    await frame();
    if (data?.scenarios) {
      let ok = false;
      try {
        ok = next.scenarios.restore(data.scenarios);
      } catch (e) {
        // a half-replayed world is unusable: start again from the template
        console.error("restore", e);
        next = await build();
      }
      if (!ok) {
        // keep what was saved (autosave would otherwise write over it)
        void backend().kvSet(`unrestored:${id}:${Date.now()}`, data);
        warn(`Saved proposals of “${meta.name}” could not be restored; it opened on its template`);
      }
    }
    // (the replayed edits stay dirty: the scene builds them when the map starts)
    if (data?.view) next.startView = data.view;
    // ---- swap: the Shell unmounts (MapView removes the map and overlay), then the old world goes
    progress(0.97, "Drawing");
    if (prevId) fire(leaveListeners, prevId);
    if (rtMaybe()) {
      await saveCurrent();
      const canvases = typeof document === "undefined" ? [] : [...document.querySelectorAll("canvas")];
      // unmount the workspace now (MapView removes the map and its overlay)
      flushSync(() => useApp.setState({ status: "loading" }));
      await frame();
      releaseContexts(canvases);
      const { disposeSimWorker } = await import("@/sim/client");
      disposeSimWorker();
      disposeRuntime();
    }
    lastView = data?.view;
    dirty = false;
    installRuntime(next);
    await resetWorldState(next);
    startAutosave(next);
    useProjects.setState({ currentId: id });
    setUrl(id, history);
    setTitle();
    void be?.kvSet("lastProject", id);
    useApp.setState({ status: "ready", error: undefined });
    fire(changeListeners, id, prevId);
    progress(1, "Ready");
    // let the new map draw its first frames under the card, and never flash it
    await waitForMap(next, 1500);
    await wait(Math.max(0, 380 - (Date.now() - shown)));
    useProjects.setState({ switching: null });
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    if (rtMaybe()) {
      useProjects.setState({ switching: null });
      useApp.getState().notify(`Could not open ${meta.name}: ${msg}`, "error");
    } else {
      useProjects.setState((s) => ({ switching: s.switching && { ...s.switching, error: msg } }));
      useApp.setState({ status: "error", error: msg });
    }
    return false;
  } finally {
    busy = false;
    const q = queued;
    queued = null;
    if (q && q.id !== currentProjectId()) void openProject(q.id, { history: q.history });
  }
}

/**
 * Browsers keep only ~16 WebGL contexts and free them late: give back the contexts of canvases the
 * unmounted workspace left behind (MapLibre loses its own; deck.gl's overlay canvas does not).
 */
function releaseContexts(canvases: HTMLCanvasElement[]) {
  for (const c of canvases) {
    if (c.isConnected) continue;
    // getContext hands back the canvas's existing context of that kind, or null for a 2D canvas
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (gl && !gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** resolves once the runtime's map has loaded (or after `ms`) */
function waitForMap(R: Runtime, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const map = R.map;
      if (map && map.loaded()) {
        clearInterval(iv);
        map.once("idle", () => resolve());
        setTimeout(resolve, 300);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        resolve();
      }
    }, 50);
  });
}

/** read the project list (migrating older saved work) and open the page's project */
export async function initProjects(opts: { backend?: ProjectBackend } = {}): Promise<void> {
  if (be) return;
  const { backend: b, durable } = opts.backend ? { backend: opts.backend, durable: true } : await defaultBackend();
  be = b;
  useProjects.setState({ sidebarOpen: readSidebar(), durable });
  try {
    await migrateLegacy(b);
  } catch {}
  const list = await b.list();
  setList(list);
  useProjects.setState({ loaded: true });
  if (typeof window === "undefined") return;
  // agent sessions are kept per project: stop the old project's agents before its world goes
  void import("@/agent/sessions").then((m) => {
    m.setProjectKeyProvider(currentProjectId);
    onProjectLeave(() => m.stopAll());
    onProjectChange(() => m.ensureCity());
  });
  const q = new URLSearchParams(window.location.search);
  const pick = pickInitial(list, { project: q.get("project"), city: cityFromUrl(), last: await b.kvGet<string>("lastProject") });
  if ("open" in pick) await openProject(pick.open, { history: "replace" });
  else await createProject(pick.create, { history: "replace" });
}

/** a new project from a template, opened straight away (blank canvases open on their name) */
export async function createProject(base: string, opts: { name?: string; history?: "push" | "replace"; open?: boolean } = {}): Promise<ProjectMeta> {
  const meta = makeProject(base, useProjects.getState().list, { name: opts.name });
  await backend().putMeta(meta);
  setList([...useProjects.getState().list, meta]);
  if (opts.open !== false) await openProject(meta.id, { history: opts.history ?? "push" });
  return meta;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const clean = name.trim().slice(0, 80);
  const cur = useProjects.getState().list.find((p) => p.id === id);
  if (!clean || !cur || clean === cur.name) return;
  const m = patchMeta(id, { name: uniqueName(clean, useProjects.getState().list, cur.name), updatedAt: Date.now() });
  if (m) await backend().putMeta(m);
  if (id === currentProjectId()) setTitle();
}

/** a copy with every proposal, placed just below the original */
export async function duplicateProject(id: string): Promise<ProjectMeta | null> {
  const list = useProjects.getState().list;
  const src = list.find((p) => p.id === id);
  if (!src) return null;
  if (id === currentProjectId()) await saveCurrent();
  const data = (await backend().getData(id)) ?? {};
  const now = Date.now();
  const copy: ProjectMeta = { ...src, id: newProjectId(), name: uniqueName(`${src.name} copy`, list), createdAt: now, updatedAt: now, order: src.order + 0.5 };
  await backend().putData(copy.id, data);
  const next = moveProject([...list, copy], copy.id, sortProjects(list).findIndex((p) => p.id === id) + 1);
  setList(next);
  await backend().putMetas(next);
  return copy;
}

/** delete a project and its work (the UI confirms first); the open one gives way to its neighbour */
export async function deleteProject(id: string): Promise<void> {
  const list = useProjects.getState().list;
  if (!list.some((p) => p.id === id)) return;
  if (id === currentProjectId()) {
    const nb = neighbourOf(list, id);
    // never leave the page without a project: the last one is replaced by a fresh canvas
    if (nb) await openProject(nb, { history: "replace" });
    else await createProject("sandbox", { history: "replace" });
    if (currentProjectId() === id) return;
  }
  await backend().remove(id);
  setList(useProjects.getState().list.filter((p) => p.id !== id));
}

export async function reorderProject(id: string, to: number): Promise<void> {
  const next = moveProject(useProjects.getState().list, id, to);
  setList(next);
  await backend().putMetas(next);
}

/** remember that the "Start a city" card was closed for the open project */
export async function setStartClosed(closed: boolean): Promise<void> {
  const id = currentProjectId();
  const m = id && patchMeta(id, { startClosed: closed });
  if (m) await backend().putMeta(m);
}

/** the most recent project started from `base`, else a new one (the old city-menu behaviour) */
export async function openOrCreateFromBase(base: string): Promise<boolean> {
  if (!presetOf(base)) return false;
  if (currentProject()?.base === base) return false;
  const recent = useProjects
    .getState()
    .list.filter((p) => p.base === base)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (recent) return openProject(recent.id);
  await createProject(base);
  return true;
}

/** templates offered in the new-project menu */
export const TEMPLATES = CITY_PRESETS;

/** test hook: forget the backend so initProjects can run again */
export function __resetProjectsForTests() {
  be = null;
  busy = false;
  queued = null;
  useProjects.setState({ list: [], currentId: null, loaded: false, switching: null, renamingId: null });
}
