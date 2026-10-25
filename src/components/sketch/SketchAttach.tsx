"use client";

import { Camera, CircleAlert, ImagePlus, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuShortcut, DropdownMenuTrigger, Spinner, Tooltip } from "@/components/ui/kit";
import { ACCEPT, displayName } from "@/sketch/image";
import { CameraDialog } from "./CameraDialog";
import { attachImage, clearSketchDraft, useSketchDrafts } from "./draft";

const PASTE_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘V" : "Ctrl+V";

export const useSketchDraft = (key: string) => useSketchDrafts((s) => s.drafts[key]);

/** a hidden file input + the camera dialog, opened by `pick()` / `camera()` (shared by the composer and the preset) */
export function useSketchPicker(onFile: (blob: Blob, name: string) => void) {
  const input = useRef<HTMLInputElement>(null);
  const [cam, setCam] = useState(false);
  const nodes = (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        aria-hidden
        tabIndex={-1}
        data-testid="sketch-file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile(f, displayName(f.name, "Sketch"));
        }}
      />
      <CameraDialog open={cam} onOpenChange={setCam} onUse={(b) => onFile(b, "Camera photo")} />
    </>
  );
  return { pick: () => input.current?.click(), camera: () => setCam(true), nodes };
}

/** the composer's "Attach a sketch or photo" control: upload, camera; paste and drop work anywhere in the pane */
export function SketchAttachButton({ draftKey, disabled, onAttached }: { draftKey: string; disabled?: boolean; onAttached?: () => void }) {
  const { pick, camera, nodes } = useSketchPicker((b, name) => {
    void attachImage(draftKey, b, name);
    onAttached?.();
  });
  return (
    <>
      <DropdownMenu>
        <Tooltip content="Attach a sketch or photo" side="top">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="size-7" disabled={disabled} aria-label="Attach a sketch or photo" data-testid="sketch-attach">
              <ImagePlus className="size-4" strokeWidth={1.8} />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="start" side="top" className="w-60">
          <DropdownMenuLabel>A bird’s-eye sketch, photo or map</DropdownMenuLabel>
          <DropdownMenuItem onSelect={pick} data-testid="sketch-upload">
            <Upload /> Upload an image…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={camera} data-testid="sketch-camera">
            <Camera /> Use camera…
          </DropdownMenuItem>
          <div className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-ink-4">
            Or paste <DropdownMenuShortcut className="ml-0 inline">{PASTE_KEY}</DropdownMenuShortcut> or drop an image onto the agent panel.
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {nodes}
    </>
  );
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** the attachment waiting in the composer: thumbnail, name, size; × removes it */
export function SketchChip({ draftKey }: { draftKey: string }) {
  const d = useSketchDraft(draftKey);
  if (!d) return null;
  return (
    <div className="flex items-center gap-2 px-2.5 pt-2" data-testid="sketch-chip">
      <div className={`flex min-w-0 max-w-full items-center gap-2 rounded-[7px] border py-1 pr-1 pl-1 ${d.state === "error" ? "border-bad/35 bg-bad-2/60" : "border-line-2 bg-paper/70"}`}>
        <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[5px] bg-paper-3">
          {d.state === "ready" ? <img src={d.att.thumb} alt={`Attached: ${d.att.name}`} className="size-full object-cover" /> : d.state === "processing" ? <Spinner size={14} label="Preparing image" /> : <CircleAlert className="size-4 text-bad" />}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12px] font-medium text-ink">{d.state === "ready" ? d.att.name : d.name}</div>
          <div className={`text-[11px] ${d.state === "error" ? "text-bad" : "text-ink-4"}`} role={d.state === "error" ? "alert" : undefined}>
            {d.state === "ready" ? `${d.att.width} × ${d.att.height} px · ${kb(d.att.bytes)} · read when sent` : d.state === "processing" ? "Preparing…" : d.error}
          </div>
        </div>
        <Tooltip content="Remove image">
          <Button variant="ghost" size="icon-xs" className="size-6 shrink-0" onClick={() => clearSketchDraft(draftKey)} aria-label="Remove image">
            <X className="size-3.5" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
