// Projects persist in this browser (IndexedDB). A project's list entry (name, base, order, times)
// lives in `projects`; its work (every proposal with full undo history, and the last camera view)
// in `snapshots`, so the sidebar loads without reading anyone's history. The single blank-canvas
// design saved by earlier versions (`designs` → "sandbox") is migrated into a project once.
// Files are proposal files (src/state/proposalIO.ts), exported and imported from the proposal menu.

import type { ScenarioSnapshot } from "@/world/scenarios";
import { exportProposal } from "./proposalIO";
import { rtMaybe } from "./runtime";

/** a project's list entry (small: the sidebar holds every one) */
export interface ProjectMeta {
  id: string;
  name: string;
  /** "sandbox" or a measured city pack id (see CITY_PRESETS) */
  base: string;
  /** pack whose sun path, time zone and weather the models use */
  climate: string;
  createdAt: number;
  updatedAt: number;
  /** position in the sidebar (ascending) */
  order: number;
  /** the "Start a city" card was dismissed for this project */
  startClosed?: boolean;
  /** small JPEG data URL of the last view, if one was taken */
  thumbnail?: string;
}

/** camera in the city's local metres (as CityMeta.initialView) */
export interface SavedView {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

/** a project's work */
export interface ProjectData {
  scenarios?: ScenarioSnapshot;
  view?: SavedView;
}

export type Project = ProjectMeta & ProjectData;

/** where projects are kept: IndexedDB in the browser, memory in tests or when storage is blocked */
export interface ProjectBackend {
  list(): Promise<ProjectMeta[]>;
  putMeta(m: ProjectMeta): Promise<void>;
  putMetas(ms: ProjectMeta[]): Promise<void>;
  getData(id: string): Promise<ProjectData | null>;
  putData(id: string, d: ProjectData): Promise<void>;
  remove(id: string): Promise<void>;
  kvGet<T>(key: string): Promise<T | null>;
  kvSet(key: string, v: unknown): Promise<void>;
  /** the blank-canvas design saved by versions before projects, if any */
  legacyDesign(): Promise<LegacyDesign | null>;
}

const LEGACY_FORMAT = "meridian-design";
export interface LegacyDesign {
  format: typeof LEGACY_FORMAT;
  version: 1;
  climate: string;
  savedAt: string;
  scenarios: ScenarioSnapshot;
}
export const isLegacyDesign = (d: unknown): d is LegacyDesign => !!d && (d as LegacyDesign).format === LEGACY_FORMAT && (d as LegacyDesign).version === 1 && !!(d as LegacyDesign).scenarios;

// ---- IndexedDB

const DB = "meridian";
const VERSION = 2;
const S = { legacy: "designs", meta: "projects", data: "snapshots", kv: "kv" } as const;

let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return (dbp ??= new Promise((resolve) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of Object.values(S)) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
    };
    req.onsuccess = () => {
      // another tab upgrading the schema closes this connection; reopen lazily
      req.result.onversionchange = () => {
        req.result.close();
        dbp = null;
      };
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  }));
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return db().then(
    (d) =>
      new Promise<T | null>((resolve, reject) => {
        if (!d) return resolve(null);
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        let out: T | null = null;
        if (req) req.onsuccess = () => (out = req.result);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error ?? new Error("storage error"));
        t.onabort = () => reject(t.error ?? new Error("storage aborted"));
      }),
  );
}

export const idbBackend: ProjectBackend = {
  list: async () => ((await run<ProjectMeta[]>(S.meta, "readonly", (s) => s.getAll())) ?? []).filter((m) => m && m.id),
  putMeta: async (m) => void (await run(S.meta, "readwrite", (s) => s.put(m, m.id))),
  putMetas: async (ms) => void (await run(S.meta, "readwrite", (s) => void ms.forEach((m) => s.put(m, m.id)))),
  getData: async (id) => (await run<ProjectData>(S.data, "readonly", (s) => s.get(id))) ?? null,
  putData: async (id, d) => void (await run(S.data, "readwrite", (s) => s.put(d, id))),
  remove: async (id) => {
    await run(S.meta, "readwrite", (s) => s.delete(id));
    await run(S.data, "readwrite", (s) => s.delete(id));
  },
  kvGet: async <T>(key: string) => ((await run<T>(S.kv, "readonly", (s) => s.get(key))) ?? null) as T | null,
  kvSet: async (key, v) => void (await run(S.kv, "readwrite", (s) => s.put(v, key))),
  legacyDesign: async () => {
    const d = await run<unknown>(S.legacy, "readonly", (s) => s.get("sandbox"));
    return isLegacyDesign(d) ? d : null;
  },
};

/** in-memory backend (tests; browsers with storage blocked) — structured clones like IndexedDB */
export function memoryBackend(seed: { legacy?: LegacyDesign } = {}): ProjectBackend & { dump(): { metas: ProjectMeta[]; data: Map<string, ProjectData>; kv: Map<string, unknown> } } {
  const metas = new Map<string, ProjectMeta>();
  const data = new Map<string, ProjectData>();
  const kv = new Map<string, unknown>();
  const clone = <T,>(v: T): T => structuredClone(v);
  return {
    list: async () => [...metas.values()].map(clone),
    putMeta: async (m) => void metas.set(m.id, clone(m)),
    putMetas: async (ms) => ms.forEach((m) => metas.set(m.id, clone(m))),
    getData: async (id) => (data.has(id) ? clone(data.get(id)!) : null),
    putData: async (id, d) => void data.set(id, clone(d)),
    remove: async (id) => {
      metas.delete(id);
      data.delete(id);
    },
    kvGet: async <T,>(key: string) => (kv.has(key) ? (clone(kv.get(key)) as T) : null),
    kvSet: async (key, v) => void kv.set(key, clone(v)),
    legacyDesign: async () => seed.legacy ?? null,
    dump: () => ({ metas: [...metas.values()], data, kv }),
  };
}

/** IndexedDB when it opens, else memory (work then lasts only as long as the page) */
export async function defaultBackend(): Promise<{ backend: ProjectBackend; durable: boolean }> {
  return (await db()) ? { backend: idbBackend, durable: true } : { backend: memoryBackend(), durable: false };
}

// ---- helpers used by the menus

/** whether the open project holds any work (edits in any proposal) */
export function hasDesign(): boolean {
  const R = rtMaybe();
  return !!R && [...R.scenarios.scenarios.values()].some((s) => s.changesets.length > 0);
}

/** save every proposal of the open project as one proposal file */
export function exportDesign() {
  const R = rtMaybe();
  if (R && hasDesign()) exportProposal(R, "json", "all");
}
