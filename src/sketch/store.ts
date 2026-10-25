// Client-side registry of sketches: an attached image (full JPEG kept in memory only, until it is
// sent), the plan the vision call read from it, and a small thumbnail. The build_sketch tool looks
// plans up here by id. Plans, thumbnails and the straightening frame (a few KB each) persist in
// localStorage so a session restored after a reload can still rebuild and show its sketch; image data
// never does.
//
// Reading (readSketch) is two vision passes with the photo straightened in between: find the drawn
// map's corners → warp it upright with a reference grid (src/sketch/rectify.ts, image.ts) → read the
// plan. Each stage is published to useSketchReads so the reading card shows it live.

import { create } from "zustand";
import { DEMO_SKETCH_ASPECT, DEMO_SKETCH_IMAGE, DEMO_SKETCH_PLAN } from "./demoPlan";
import { normalisePlan, type SketchPlan } from "./plan";
import { usableFrame, type FrameCorners } from "./rectify";
import type { FrameResult, VisionResult } from "./vision";

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
  /** the corners the photo was straightened to (the plan's coordinates are relative to this frame) */
  frame?: FrameCorners | null;
  /** aspect (w / h) of the original photo */
  aspect?: number;
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

export function rememberSketch(id: string, plan: SketchPlan, meta: { name: string; thumb: string; frame?: FrameCorners | null; aspect?: number }) {
  load();
  records.set(id, { id, plan, name: meta.name, thumb: meta.thumb, at: Date.now(), frame: meta.frame ?? null, aspect: meta.aspect });
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

export type VisionReply = VisionResult & {
  cost?: { usd: number };
  /** the image the agent should see: the straightened drawing when the photo was straightened */
  image?: SketchAttachment;
  straightened?: boolean;
};
export type VisionTransport = (att: SketchAttachment, hint: string, signal?: AbortSignal, opts?: { rectified?: boolean }) => Promise<VisionReply>;

async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; status: number; j: any }> {
  const res = await fetch("/api/vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const j = await res.json().catch(() => ({ error: res.statusText || `HTTP ${res.status}` }));
  return { ok: res.ok, status: res.status, j };
}

async function fetchVision(att: SketchAttachment, hint: string, signal?: AbortSignal, opts?: { rectified?: boolean }): Promise<VisionReply> {
  const { ok, status, j } = await post({ image: att.data, media_type: att.media_type, width: att.width, height: att.height, hint, rectified: !!opts?.rectified }, signal);
  if (!ok && !("not_plan" in j)) return { ok: false, error: j.error ?? `The sketch could not be read (HTTP ${status}).` };
  if (j.plan) j.plan = normalisePlan(j.plan);
  return j as VisionReply;
}

async function fetchFrame(att: SketchAttachment, signal?: AbortSignal): Promise<FrameResult & { cost?: { usd: number } }> {
  const { ok, status, j } = await post({ image: att.data, media_type: att.media_type, width: att.width, height: att.height, stage: "frame" }, signal);
  if (!ok && !("not_plan" in j)) return { ok: false, error: j.error ?? `HTTP ${status}` };
  return j;
}

let transport: VisionTransport = fetchVision;
/** replace the vision call (tests); a replaced transport also skips the frame pass */
export function setVisionTransport(t: VisionTransport | null) {
  transport = t ?? fetchVision;
}

// ---------------------------------------------------------------- live reading state (for the card)

export type ReadStage = "frame" | "straighten" | "plan" | "done" | "not_plan" | "error";
export interface SketchRead {
  stage: ReadStage;
  /** what the card shows: the straightened drawing once there is one, else the photo's thumbnail */
  image: string;
  /** w / h of `image` */
  aspect: number;
  straightened: boolean;
  plan?: SketchPlan;
  /** the photo's frame (to draw the plan over the original photo when only the thumbnail is left) */
  frame?: FrameCorners | null;
  startedAt: number;
  ms?: number;
  detail?: string;
}

export const useSketchReads = create<Record<string, SketchRead>>(() => ({}));
const setRead = (id: string, v: Partial<SketchRead>) => useSketchReads.setState((s) => ({ [id]: { ...(s[id] as SketchRead), ...v } }));

/**
 * Read a sketch: find the map's frame, straighten the photo to it, read the plan off the straightened
 * drawing (any stage that fails falls back to reading the photo as it is). A plan is remembered under
 * the attachment's id.
 */
export async function readSketch(att: SketchAttachment, hint: string, signal?: AbortSignal): Promise<VisionReply> {
  const t0 = Date.now();
  useSketchReads.setState({ [att.id]: { stage: "frame", image: att.thumb, aspect: att.width / att.height, straightened: false, startedAt: t0 } });
  if (transport === fetchVision && demoSketchOn()) return readDemoSketch(att, t0, signal);
  let toRead = att,
    shown = att,
    frame: FrameCorners | null = null,
    usd = 0;
  if (transport === fetchVision && typeof document !== "undefined") {
    try {
      const img = await import("./image");
      const fr = await fetchFrame(await img.withGrid(att), signal);
      usd += fr.cost?.usd ?? 0;
      // a frame pass that sees no plan only skips the straightening: the plan pass has the last word
      frame = fr.ok ? usableFrame(fr.frame, att.width, att.height) : null;
      if (frame) {
        setRead(att.id, { stage: "straighten", frame });
        const st = await img.straighten(att, frame);
        toRead = st.gridded;
        shown = st.plain;
        setRead(att.id, { image: st.view, aspect: st.plain.width / st.plain.height, straightened: true });
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      frame = null;
    }
  }
  setRead(att.id, { stage: "plan" });
  const r = await transport(toRead, hint, signal, { rectified: toRead !== att });
  r.cost = { usd: (r.cost?.usd ?? 0) + usd };
  if (r.ok) {
    rememberSketch(att.id, r.plan, { name: att.name, thumb: att.thumb, frame: toRead !== att ? frame : null, aspect: att.width / att.height });
    r.image = shown;
    r.straightened = shown !== att;
  }
  setRead(att.id, r.ok ? { stage: "done", plan: r.plan, ms: Date.now() - t0 } : "not_plan" in r && r.not_plan ? { stage: "not_plan", detail: r.reason, ms: Date.now() - t0 } : { stage: "error", detail: "error" in r ? r.error : undefined, ms: Date.now() - t0 });
  return r;
}

// ---------------------------------------------------------------- demo mode

/** demo mode: every attached image reads as the fixed whiteboard plan (src/sketch/demoPlan.ts) */
export const demoSketchOn = () => process.env.NEXT_PUBLIC_MERIDIAN_DEMO_SKETCH !== "0";

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))), { once: true });
  });

async function readDemoSketch(att: SketchAttachment, t0: number, signal?: AbortSignal): Promise<VisionReply> {
  await wait(1200, signal);
  setRead(att.id, { stage: "straighten" });
  await wait(600, signal);
  setRead(att.id, { image: DEMO_SKETCH_IMAGE, aspect: DEMO_SKETCH_ASPECT, straightened: true, stage: "plan" });
  await wait(2200, signal);
  rememberSketch(att.id, DEMO_SKETCH_PLAN, { name: att.name, thumb: att.thumb, aspect: att.width / att.height });
  setRead(att.id, { stage: "done", plan: DEMO_SKETCH_PLAN, ms: Date.now() - t0 });
  return { ok: true, plan: DEMO_SKETCH_PLAN, cost: { usd: 0 } };
}
