// Client-side registry of sketches: an attached image (full JPEG kept in memory only, until it is
// sent), the plan the vision call read from it, and a small thumbnail. The build_sketch tool looks
// plans up here by id. Plans and thumbnails (a few KB each) persist in localStorage so a session
// restored after a reload can still rebuild its sketch; image data never does.

import { normalisePlan, type SketchPlan } from "./plan";
import type { VisionResult } from "./vision";

/** an image ready to send: preprocessed in the browser (src/sketch/image.ts) */
export interface SketchAttachment {
  id: string;
  /** file name, or "Camera photo" / "Pasted image" */
  name: string;
  media_type: "image/jpeg";
  /** base64 JPEG (≤ 1568 px long edge), no data: prefix */
  data: string;
  width: number;
  height: number;
  /** small JPEG data URL for chips, bubbles and the saved history */
  thumb: string;
  /** size of the JPEG in bytes */
  bytes: number;
}

export interface SketchRecord {
  id: string;
  name: string;
  thumb: string;
  plan: SketchPlan;
  at: number;
}

const KEY = "meridian.sketches.v1";
const MAX = 24;
const records = new Map<string, SketchRecord>();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    const list = raw ? (JSON.parse(raw) as SketchRecord[]) : [];
    for (const r of list) if (r?.id && r.plan) records.set(r.id, { ...r, plan: normalisePlan(r.plan) });
  } catch {
    // unreadable: start empty
  }
}

function save() {
  try {
    if (typeof localStorage === "undefined") return;
    const list = [...records.values()].sort((a, b) => b.at - a.at).slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // quota or private mode: the in-memory registry still works for this page
  }
}

export function rememberSketch(id: string, plan: SketchPlan, meta: { name: string; thumb: string }) {
  load();
  records.set(id, { id, plan, name: meta.name, thumb: meta.thumb, at: Date.now() });
  save();
}

export function getSketch(id: string): SketchRecord | null {
  load();
  return records.get(id) ?? null;
}

/** the most recent sketch (when the model refers to "the sketch" without an id) */
export function latestSketch(): SketchRecord | null {
  load();
  return [...records.values()].sort((a, b) => b.at - a.at)[0] ?? null;
}

let seq = 0;
export const newSketchId = () => `sk${Date.now().toString(36)}${(++seq).toString(36)}`;

export type VisionReply = VisionResult & { cost?: { usd: number } };
export type VisionTransport = (att: SketchAttachment, hint: string, signal?: AbortSignal) => Promise<VisionReply>;

async function fetchVision(att: SketchAttachment, hint: string, signal?: AbortSignal): Promise<VisionReply> {
  const res = await fetch("/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: att.data, media_type: att.media_type, width: att.width, height: att.height, hint }),
    signal,
  });
  const j = await res.json().catch(() => ({ error: res.statusText || `HTTP ${res.status}` }));
  if (!res.ok && !("not_plan" in j)) return { ok: false, error: j.error ?? `The sketch could not be read (HTTP ${res.status}).` };
  if (j.plan) j.plan = normalisePlan(j.plan);
  return j as VisionReply;
}

let transport: VisionTransport = fetchVision;
/** replace the vision call (tests) */
export function setVisionTransport(t: VisionTransport | null) {
  transport = t ?? fetchVision;
}

/** read a sketch: one vision call; a plan is remembered under the attachment's id */
export async function readSketch(att: SketchAttachment, hint: string, signal?: AbortSignal): Promise<VisionReply> {
  const r = await transport(att, hint, signal);
  if (r.ok) rememberSketch(att.id, r.plan, { name: att.name, thumb: att.thumb });
  return r;
}
