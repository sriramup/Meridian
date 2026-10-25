"use client";

import { ChevronLeft, Ellipsis } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AgentMode, AgentSession, Zone } from "@/agent/types";
import type { SketchAttachment } from "@/sketch/store";
import { rtMaybe } from "@/state/runtime";
import { Button, Tooltip } from "@/components/ui/kit";
import { Composer, type ComposerHandle } from "./Composer";
import { titleFromText } from "./model";
import { CloseButton, NewAgentButton } from "./parts";
import { SessionMenu, TitleInput } from "./SessionList";
import { agents, useConfigured } from "./store";
import { SANDBOX_STARTERS, STARTERS } from "./toolMeta";
import { Transcript } from "./Transcript";

/** one agent: header with the way back to all agents, the conversation, and its composer */
export const SessionView = forwardRef<ComposerHandle, { session: AgentSession; onBack: () => void; onNew: () => void; onClose: () => void }>(function SessionView({ session: s, onBack, onNew, onClose }, ref) {
  const [renaming, setRenaming] = useState(false);
  const running = s.status === "running" || s.status === "needs_input";
  const configured = useConfigured();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const composer = useRef<ComposerHandle>(null);
  useImperativeHandle(ref, () => ({
    focus: () => composer.current?.focus(),
    setText: (t) => composer.current?.setText(t),
    flash: () => composer.current?.flash(),
  }));
  const fresh = s.items.length === 0;
  const [typed, setTyped] = useState(false);

  // follow the conversation while it grows, unless the user has scrolled up to read
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.items, s.status]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line pr-2 pl-1.5">
        <Tooltip content="All agents">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to all agents">
            <ChevronLeft className="size-4" strokeWidth={1.8} />
          </Button>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-center pl-0.5">
          {renaming ? (
            <TitleInput session={s} done={() => setRenaming(false)} className="text-[13px] font-medium" />
          ) : (
            <h2 onDoubleClick={() => setRenaming(true)} title={s.title} className="min-w-0 truncate px-1 text-[13.5px] font-medium text-ink">
              {s.title}
            </h2>
          )}
        </div>
        <NewAgentButton onNew={onNew} />
        <SessionMenu session={s} onRename={() => setRenaming(true)}>
          <Button variant="ghost" size="icon-sm" aria-label="Agent actions">
            <Ellipsis />
          </Button>
        </SessionMenu>
        <CloseButton onClose={onClose} />
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="scroll-thin min-h-0 flex-1 animate-[kit-fade-in_140ms_ease-out] overflow-y-auto"
      >
        {fresh ? (
          <Welcome starters={!typed && configured !== false} onPick={(t) => composer.current?.setText(t)} />
        ) : (
          <Transcript sessionId={s.id} items={s.items} running={running} />
        )}
        {s.status === "error" && s.error && !s.items.some((i) => i.kind === "notice" && i.text === s.error) && <div className="px-4 pb-4 text-[12px] text-bad">{s.error}</div>}
      </div>

      <Composer
        ref={composer}
        draftKey={s.id}
        colorKey={s.id}
        mode={s.mode}
        zone={s.zone}
        running={running}
        disabled={configured === false}
        placeholder={configured === false ? "Agent not connected" : undefined}
        onMode={(m: AgentMode) => agents.setMode(s.id, m)}
        onZone={(z: Zone | null) => agents.setZone(s.id, z)}
        onSend={(t, sketch) => sendFirst(s, t, sketch)}
        onTyped={setTyped}
        onStop={() => agents.stop(s.id)}
      />
    </div>
  );
});

/** the first message names the agent (unless the user already did) */
function sendFirst(s: AgentSession, text: string, sketch?: SketchAttachment) {
  if (!s.items.some((i) => i.kind === "user") && s.title === "New agent") agents.renameSession(s.id, titleFromText(text || (sketch ? `Sketch: ${sketch.name}` : "")));
  void agents.send(s.id, text, sketch ? { sketch } : undefined);
}

/** a fresh agent: one question in the middle and a few starting points under it; they fill the composer, they don't send */
function Welcome({ starters, onPick }: { starters: boolean; onPick: (t: string) => void }) {
  const list = rtMaybe()?.meta.sandbox ? SANDBOX_STARTERS : STARTERS;
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-5 py-8">
      <h3 className="text-center font-display text-[22px] leading-tight text-ink">What are we building today?</h3>
      {starters && (
        <div className="mt-5 flex w-full max-w-[380px] flex-col gap-2">
          {list.map((x) => (
            <button
              key={x.label}
              onClick={() => onPick(x.prompt)}
              title={x.prompt}
              className="w-full rounded-[8px] border border-line px-3 py-2.5 text-left text-[13px] font-medium text-ink outline-none transition-colors hover:border-rose/40 hover:bg-paper-3/60 focus-visible:ring-2 focus-visible:ring-rose/35"
            >
              {x.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
