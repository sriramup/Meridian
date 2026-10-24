// Blank-canvas designs persist in this browser (IndexedDB, saved shortly after every edit). Files
// are proposal files (src/state/proposalIO.ts), exported and imported from the scenario menu for the
// canvas and measured cities alike; older design files are still read there. Measured cities are
// not saved in the browser: their baseline is the pack itself.

import type { ScenarioSnapshot } from "@/world/scenarios";
import { exportProposal } from "./proposalIO";
import { rtMaybe } from "./runtime";
import { useApp } from "./store";

const DB = "meridian";
const STORE = "designs";
const KEY = "sandbox";
const FORMAT = "meridian-design";

export interface DesignFile {
  format: typeof FORMAT;
  version: 1;
  /** climate city the design was drawn under */
  climate: string;
  savedAt: string;
  scenarios: ScenarioSnapshot;
}

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function current(): DesignFile | null {
  const R = rtMaybe();
  if (!R?.meta.sandbox) return null;
  return { format: FORMAT, version: 1, climate: R.climateId, savedAt: new Date().toISOString(), scenarios: R.scenarios.snapshot() };
}

function isDesign(d: DesignFile | null | undefined): d is DesignFile {
  return !!d && d.format === FORMAT && d.version === 1;
}

/** whether the canvas holds any design (edits in any branch) */
export function hasDesign(): boolean {
  const R = rtMaybe();
  return !!R && [...R.scenarios.scenarios.values()].some((s) => s.changesets.length > 0);
}

export async function saveDesign(): Promise<void> {
  const d = current();
  if (!d) return;
  try {
    await tx("readwrite", (s) => s.put(d, KEY));
  } catch {
    useApp.getState().notify("Could not save the design in this browser — export it to keep it", "warn");
  }
}

let stop: (() => void) | null = null;
/** save shortly after every change to the scenarios */
function startAutosave() {
  const R = rtMaybe();
  if (!R?.meta.sandbox || stop) return;
  let t: ReturnType<typeof setTimeout> | null = null;
  const off = R.scenarios.onChange(() => {
    if (t) clearTimeout(t);
    t = setTimeout(() => void saveDesign(), 700);
  });
  stop = () => {
    off();
    if (t) clearTimeout(t);
  };
}

/** reopen the design saved in this browser (blank canvas only); then keep saving */
export async function restoreDesign(): Promise<boolean> {
  const R = rtMaybe();
  if (!R?.meta.sandbox) return false;
  const saved = (await tx<DesignFile | undefined>("readonly", (s) => s.get(KEY))) ?? null;
  const ok = !!saved && isDesign(saved) && saved.climate === R.climateId && R.scenarios.restore(saved.scenarios);
  startAutosave();
  return ok;
}

/** start over on an empty canvas (the saved design is discarded) */
export async function clearDesign(): Promise<void> {
  stop?.();
  stop = null;
  await tx("readwrite", (s) => s.delete(KEY));
}

/** save every design on the canvas as one proposal file */
export function exportDesign() {
  const R = rtMaybe();
  if (R && hasDesign()) exportProposal(R, "json", "all");
}
