// Sketches waiting in a composer, per draft key (the session id, or "new"): set by the attach
// button, paste, a drop onto the agents pane or the camera; taken by the composer when it sends.

import { create } from "zustand";
import { ImageError, preprocessImage } from "@/sketch/image";
import type { SketchAttachment } from "@/sketch/store";

export type SketchDraft = { state: "processing"; name: string } | { state: "ready"; att: SketchAttachment } | { state: "error"; name: string; error: string };

export const useSketchDrafts = create<{ drafts: Record<string, SketchDraft> }>(() => ({ drafts: {} }));

const setDraft = (key: string, d: SketchDraft | null) =>
  useSketchDrafts.setState((s) => {
    const drafts = { ...s.drafts };
    if (d) drafts[key] = d;
    else delete drafts[key];
    return { drafts };
  });

let token = 0;
const latest = new Map<string, number>();

/** preprocess an image into the draft (the newest attachment wins) */
export async function attachImage(key: string, blob: Blob, name: string): Promise<SketchAttachment | null> {
  const t = ++token;
  latest.set(key, t);
  setDraft(key, { state: "processing", name });
  try {
    const att = await preprocessImage(blob, name);
    if (latest.get(key) !== t) return null;
    setDraft(key, { state: "ready", att });
    return att;
  } catch (e) {
    if (latest.get(key) !== t) return null;
    setDraft(key, { state: "error", name, error: e instanceof ImageError ? e.message : "That image couldn't be opened." });
    return null;
  }
}

export function clearSketchDraft(key: string) {
  latest.delete(key);
  setDraft(key, null);
}

export const takeReadySketch = (key: string): SketchAttachment | undefined => {
  const d = useSketchDrafts.getState().drafts[key];
  return d?.state === "ready" ? d.att : undefined;
};
