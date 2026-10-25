"use client";

import { Camera, CircleAlert, ImageUp, Upload } from "lucide-react";
import { useState, type DragEvent } from "react";
import { create } from "zustand";
import { ensureCity } from "@/agent/sessions";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Spinner } from "@/components/ui/kit";
import { createProject, currentProject, renameProject, useProjects } from "@/state/projects";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { ImageError, displayName, dragHasFiles, imageFromItems, preprocessImage, projectNameFor } from "@/sketch/image";
import { getSketch, type SketchAttachment } from "@/sketch/store";
import { newAgent } from "../agents/AgentsPane";
import { agents } from "../agents/store";
import { useSketchPicker } from "./SketchAttach";

/**
 * The "From a sketch or photo…" preset (projects sidebar New menu, Start card): pick, drop, paste or
 * photograph a bird's-eye sketch → a new blank canvas named from it opens, the agent pane opens on a
 * fresh agent and the build starts. Once the sketch is read, a project still carrying its provisional
 * name takes the sketch's title (it stays renameable like any project).
 */
export const useSketchStart = create<{ open: boolean; reuse: boolean }>(() => ({ open: false, reuse: false }));
/** reuse: build on the open project when it is an untouched blank canvas (the Start card) instead of making another */
export const openSketchStart = (opts: { reuse?: boolean } = {}) => useSketchStart.setState({ open: true, reuse: !!opts.reuse });

export async function startFromSketch(att: SketchAttachment, opts: { reuse?: boolean } = {}): Promise<void> {
  const provisional = projectNameFor(att);
  const cur = currentProject();
  const R = rtMaybe();
  let p: { id: string; name: string };
  if (opts.reuse && cur && cur.base === "sandbox" && R?.meta.sandbox && R.world.entities.size === 0) {
    await renameProject(cur.id, provisional);
    p = useProjects.getState().list.find((x) => x.id === cur.id) ?? cur;
  } else p = await createProject("sandbox", { name: provisional });
  ensureCity();
  useApp.getState().setAgentOpen(true);
  const id = newAgent();
  agents.renameSession(id, `Sketch: ${att.name}`);
  void agents.send(id, "", { sketch: att });
  const t0 = Date.now();
  const iv = setInterval(() => {
    const rec = getSketch(att.id);
    if (!rec && Date.now() - t0 < 120_000) return;
    clearInterval(iv);
    const title = rec?.plan.title;
    const cur = useProjects.getState().list.find((x) => x.id === p.id);
    if (title && cur && cur.name === p.name) void renameProject(p.id, title);
  }, 400);
}

type Phase = { k: "idle" } | { k: "processing"; name: string } | { k: "error"; message: string };

export function SketchStartHost() {
  const open = useSketchStart((s) => s.open);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [over, setOver] = useState(false);
  const close = (o: boolean) => {
    useSketchStart.setState({ open: o });
    if (!o) setPhase({ k: "idle" });
  };
  const take = async (blob: Blob, name: string) => {
    setPhase({ k: "processing", name });
    try {
      const att = await preprocessImage(blob, name);
      const reuse = useSketchStart.getState().reuse;
      close(false);
      await startFromSketch(att, { reuse });
    } catch (e) {
      setPhase({ k: "error", message: e instanceof ImageError ? e.message : "That image couldn't be opened." });
    }
  };
  const { pick, camera, nodes } = useSketchPicker((b, n) => void take(b, n));
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = imageFromItems(e.dataTransfer.items, e.dataTransfer.files);
    if (f) void take(f, displayName(f.name, "Sketch"));
  };
  const busy = phase.k === "processing";
  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent
          size="md"
          onPaste={(e) => {
            const f = imageFromItems(e.clipboardData.items, e.clipboardData.files);
            if (f) {
              e.preventDefault();
              void take(f, "Pasted image");
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Start from a sketch or photo</DialogTitle>
            <DialogDescription>A bird’s-eye plan — a whiteboard or paper sketch, or a map. The agent reads its streets, blocks, parks, water and labelled buildings and builds it on a new blank canvas.</DialogDescription>
          </DialogHeader>
          <button
            type="button"
            onClick={pick}
            disabled={busy}
            onDragEnter={(e) => dragHasFiles(e.dataTransfer) && (e.preventDefault(), setOver(true))}
            onDragOver={(e) => dragHasFiles(e.dataTransfer) && e.preventDefault()}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            data-testid="sketch-start-drop"
            className={`flex h-[170px] w-full flex-col items-center justify-center gap-2 rounded-[10px] border-2 border-dashed text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-rose/35 ${over ? "border-rose/60 bg-accent-2" : "border-line-2 bg-paper/60 hover:border-rose/40 hover:bg-paper-3/50"}`}
          >
            {busy ? (
              <>
                <Spinner size={18} label="Preparing image" />
                <span className="text-[12.5px] text-ink-3">Preparing {phase.name}…</span>
              </>
            ) : (
              <>
                <ImageUp className="size-7 text-rose" strokeWidth={1.6} />
                <span className="text-[13.5px] font-medium text-ink">Drop an image, or click to choose</span>
                <span className="text-[11.5px] text-ink-4">PNG, JPEG, WebP or HEIC · you can also paste one</span>
              </>
            )}
          </button>
          {phase.k === "error" && (
            <div role="alert" className="flex items-start gap-1.5 text-[12px] leading-snug text-bad">
              <CircleAlert className="mt-px size-3.5 shrink-0" /> {phase.message}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11.5px] leading-snug text-ink-4">Tip: photograph straight from above, the whole plan in frame.</span>
            <span className="flex shrink-0 gap-1.5">
              <Button
                size="sm"
                onClick={() => {
                  // one dialog at a time: the camera takes over from this one
                  close(false);
                  camera();
                }}
                disabled={busy} className="gap-1.5" data-testid="sketch-start-camera">
                <Camera className="size-3.5" /> Use camera
              </Button>
              <Button size="sm" variant="primary" onClick={pick} disabled={busy} className="gap-1.5">
                <Upload className="size-3.5" /> Choose image
              </Button>
            </span>
          </div>
        </DialogContent>
      </Dialog>
      {nodes}
    </>
  );
}
