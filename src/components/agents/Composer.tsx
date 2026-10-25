"use client";

import { Button, Textarea, ToggleGroup, ToggleGroupItem, Tooltip } from "@/components/ui/kit";
import { ArrowUp, Square, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { AgentMode, Zone } from "@/agent/types";
import { entityName } from "@/agent/resolve";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { ZonePicker } from "./ZonePicker";
import { SearchToggle } from "../serp/SearchToggle";
import { SketchAttachButton, SketchChip, useSketchDraft } from "../sketch/SketchAttach";
import { attachImage, clearSketchDraft, takeReadySketch } from "../sketch/draft";
import { displayName, imageFromItems } from "@/sketch/image";
import type { SketchAttachment } from "@/sketch/store";

const MODES: { value: AgentMode; label: string; title: string }[] = [
  { value: "plan", label: "Plan", title: "Investigate and propose; never edits the map" },
  { value: "edit", label: "Edit", title: "May change the map" },
];

/** set before switching to a session whose composer should take the focus when it mounts */
let focusPending: string | null = null;
export function focusComposerNext(text?: string) {
  focusPending = text ?? "";
}

/** unsent text per session (kept while you move between agents) */
const drafts = new Map<string, string>();
export const hasDraft = (key: string) => !!drafts.get(key)?.trim();

const RING = "inset 0 1px 1px rgb(88 60 28 / 0.08), 0 0 0 4px rgb(154 62 40 / ";
function flashBox(el: HTMLElement | null) {
  el?.animate([{ boxShadow: RING + "0.3)" }, { boxShadow: RING + "0)" }], { duration: 650, easing: "ease-out" });
}

export interface ComposerHandle {
  focus: () => void;
  setText: (t: string) => void;
  /** take the focus with a brief ring, so it is plain a fresh agent is ready */
  flash: () => void;
}

interface Props {
  /** draft key: the session id, or "new" */
  draftKey: string;
  colorKey: string;
  mode: AgentMode;
  zone: Zone | null;
  running: boolean;
  disabled?: boolean;
  placeholder?: string;
  onMode: (m: AgentMode) => void;
  onZone: (z: Zone | null) => void;
  onSend: (text: string, sketch?: SketchAttachment) => void;
  onStop: () => void;
  /** whether the composer holds any text */
  onTyped?: (typed: boolean) => void;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ draftKey, colorKey, mode, zone, running, disabled, placeholder, onMode, onZone, onSend, onStop, onTyped }, ref) {
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? "");
  const ta = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const selection = useApp((s) => s.selection);
  const R = rtMaybe();

  const setText = (t: string) => {
    setTextState(t);
    if (t) drafts.set(draftKey, t);
    else drafts.delete(draftKey);
  };
  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    flash: () => {
      ta.current?.focus();
      flashBox(box.current);
    },
    setText: (t: string) => {
      setText(t);
      requestAnimationFrame(() => {
        const el = ta.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(t.length, t.length);
      });
    },
  }));
  // switching sessions swaps in that session's draft (and takes the focus when asked to)
  useLayoutEffect(() => {
    let t = drafts.get(draftKey) ?? "";
    const want = focusPending;
    focusPending = null;
    if (want) {
      t = want;
      drafts.set(draftKey, t);
    }
    setTextState(t);
    if (want !== null) {
      const el = ta.current;
      el?.focus();
      el?.setSelectionRange(t.length, t.length);
      flashBox(box.current);
    }
  }, [draftKey]);

  const typed = !!text.trim();
  useEffect(() => onTyped?.(typed), [typed, onTyped]);
  // an attached sketch can be sent on its own (the request defaults to "build this sketch")
  const sketch = useSketchDraft(draftKey);
  const canSend = (!!text.trim() || sketch?.state === "ready") && sketch?.state !== "processing" && !running && !disabled;
  const submit = () => {
    if (!canSend) return;
    const att = takeReadySketch(draftKey);
    if (att) clearSketchDraft(draftKey);
    onSend(text.trim(), att);
    setText("");
  };

  return (
    <div className="shrink-0 px-3 pt-2 pb-3">
      <div ref={box} className="rounded-[10px] border border-line-2 bg-field/75 shadow-[inset_0_1px_1px_rgb(88_60_28/0.08)] transition-[border-color,box-shadow] focus-within:border-rose/50 focus-within:ring-2 focus-within:ring-rose/15">
        {selection.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 px-2.5 pt-2">
            <span className="text-[10.5px] text-ink-4">Referring to</span>
            {selection.slice(0, 4).map((id) => {
              const e = R?.world.get(id);
              return (
                <span key={id} className="inline-flex h-5 max-w-[160px] items-center truncate rounded-[4px] bg-accent-2 px-1.5 text-[10.5px] font-medium text-rose">
                  {e ? entityName(e) : id}
                </span>
              );
            })}
            {selection.length > 4 && <span className="text-[10.5px] text-ink-4">+{selection.length - 4}</span>}
            <Tooltip content="Clear selection">
              <Button variant="ghost" size="icon-xs" className="size-5" onClick={() => useApp.getState().setSelection([])} aria-label="Clear selection">
                <X className="size-3" />
              </Button>
            </Tooltip>
          </div>
        )}
        <SketchChip draftKey={draftKey} />
        <Textarea
          ref={ta}
          onPaste={(e) => {
            const f = imageFromItems(e.clipboardData?.items, e.clipboardData?.files);
            if (!f || disabled) return;
            e.preventDefault();
            void attachImage(draftKey, f, f.name && !/^image\.(png|jpe?g)$/i.test(f.name) ? displayName(f.name, "Pasted image") : "Pasted image");
          }}
          value={text}
          minRows={2}
          maxRows={9}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              if (running) onStop();
              else ta.current?.blur();
            }
          }}
          placeholder={placeholder ?? (sketch?.state === "ready" ? "Add a note, or press Enter to build the sketch" : mode === "plan" ? "What should we investigate?" : "What should we change?")}
          aria-label="Message the agent"
          className="border-0 bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-[19px] shadow-none hover:border-0 focus-visible:ring-0"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <ToggleGroup type="single" variant="segmented" size="xs" value={mode} onValueChange={(v: string) => v && onMode(v as AgentMode)} aria-label="Mode">
            {MODES.map((m) => (
              <Tooltip key={m.value} content={m.title} side="top">
                <ToggleGroupItem value={m.value}>{m.label}</ToggleGroupItem>
              </Tooltip>
            ))}
          </ToggleGroup>
          <ZonePicker value={zone} onChange={onZone} colorKey={colorKey} onClosed={() => ta.current?.focus()} />
          <SearchToggle sessionKey={draftKey} disabled={disabled} />
          <SketchAttachButton draftKey={draftKey} disabled={disabled || running} onAttached={() => ta.current?.focus()} />
          <div className="ml-auto flex items-center">
            {running ? (
              <Tooltip content="Stop" kbd="Esc" side="top">
                <Button size="xs" onClick={onStop} className="gap-1">
                  <Square className="size-2.5" fill="currentColor" /> Stop
                </Button>
              </Tooltip>
            ) : (
              <Tooltip content="Send" kbd="↵" side="top">
                <Button variant={canSend ? "primary" : "default"} size="icon-xs" className="size-7 rounded-full" disabled={!canSend} onClick={submit} aria-label="Send">
                  <ArrowUp className="size-4" strokeWidth={2.2} />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
