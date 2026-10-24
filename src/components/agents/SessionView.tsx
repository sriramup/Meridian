"use client";

import { ChevronLeft, ChevronRight, Ellipsis } from "lucide-react";
import { forwardRef, useEffect, useRef, useState } from "react";
import type { AgentMode, AgentSession, Zone } from "@/agent/types";
import { rtMaybe } from "@/state/runtime";
import { Button, Tooltip } from "@/components/ui/kit";
import { cx } from "../ui";
import { Composer, type ComposerHandle } from "./Composer";
import { editCount, statusText, titleFromText } from "./model";
import { CloseButton, StatusIcon } from "./parts";
import { SessionMenu, TitleInput } from "./SessionList";
import { agents, useConfigured } from "./store";
import { EXAMPLES, SANDBOX_EXAMPLES } from "./toolMeta";
import { Transcript } from "./Transcript";

/** one agent: header with the way back to all agents, the conversation, and its composer */
export const SessionView = forwardRef<ComposerHandle, { session: AgentSession; onBack: () => void; onClose: () => void }>(function SessionView({ session: s, onBack, onClose }, ref) {
  const [renaming, setRenaming] = useState(false);
  const running = s.status === "running" || s.status === "needs_input";
  const configured = useConfigured();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const edits = editCount(s);

  // follow the conversation while it grows, unless the user has scrolled up to read
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.items]);
  useEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-2 pl-1.5">
        <Tooltip content="All agents">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to all agents">
            <ChevronLeft className="size-4" strokeWidth={1.8} />
          </Button>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-center gap-2 pl-0.5">
          {renaming ? (
            <TitleInput session={s} done={() => setRenaming(false)} className="text-[13px] font-medium" />
          ) : (
            <Tooltip content="Rename">
              <button onClick={() => setRenaming(true)} className="min-w-0 truncate rounded-[4px] px-1 py-0.5 text-left text-[13.5px] font-medium text-ink outline-none hover:bg-paper-3/60 focus-visible:ring-2 focus-visible:ring-rose/40">
                {s.title}
              </button>
            </Tooltip>
          )}
        </div>
        {!renaming && (
          <span className={cx("flex shrink-0 items-center gap-1.5 pr-1 text-[11.5px]", s.status === "needs_input" ? "text-warn" : s.status === "error" ? "text-bad" : "text-ink-3")}>
            <StatusIcon session={s} size={13} />
            {statusText(s)}
            {edits > 0 && <span className="text-ink-4">· {edits} edit{edits > 1 ? "s" : ""}</span>}
          </span>
        )}
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
        className="scroll-thin min-h-0 flex-1 overflow-y-auto"
      >
        {s.items.length === 0 ? (
          <Starters disabled={configured === false} onPick={(t) => sendFirst(s, t)} />
        ) : (
          <Transcript sessionId={s.id} items={s.items} running={s.status === "running"} />
        )}
        {s.status === "error" && s.error && !s.items.some((i) => i.kind === "notice" && i.text === s.error) && <div className="px-4 pb-4 text-[12px] text-bad">{s.error}</div>}
      </div>

      <Composer
        ref={ref}
        draftKey={s.id}
        colorKey={s.id}
        mode={s.mode}
        zone={s.zone}
        running={running}
        disabled={configured === false}
        placeholder={configured === false ? "Agent not connected" : undefined}
        onMode={(m: AgentMode) => agents.setMode(s.id, m)}
        onZone={(z: Zone | null) => agents.setZone(s.id, z)}
        onSend={(t) => sendFirst(s, t)}
        onStop={() => agents.stop(s.id)}
      />
    </div>
  );
});

/** the first message names the agent (unless the user already did) */
function sendFirst(s: AgentSession, text: string) {
  if (!s.items.some((i) => i.kind === "user") && s.title === "New agent") agents.renameSession(s.id, titleFromText(text));
  void agents.send(s.id, text);
}

/** a fresh agent: what it can do, a few starting points, and a note when no model is connected */
export function Starters({ disabled, onPick }: { disabled: boolean; onPick: (t: string) => void }) {
  const groups = rtMaybe()?.meta.sandbox ? SANDBOX_EXAMPLES : EXAMPLES;
  return (
    <div className="px-4 pt-5 pb-4">
      <p className="text-[13px] leading-relaxed text-ink-2">Describe what to change, test or understand. In Edit mode the agent changes the live map; in Plan mode it investigates and proposes without editing.</p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-3">Limit where it may edit with the zone below. Select features on the map to refer to them as “this”.</p>
      {disabled && (
        <div className="mt-4 rounded-[6px] border border-warn/30 bg-warn-2 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
          <div className="font-medium text-ink">Agent not connected</div>
          Set <code className="font-mono text-[11.5px]">ANTHROPIC_API_KEY</code> in <code className="font-mono text-[11.5px]">.env.local</code> and restart the server. Editing, simulations and scenarios work without it.
        </div>
      )}
      {groups.map((g) => (
        <div key={g.group} className="mt-5">
          <div className="mb-1 px-2 font-legend text-[12px] leading-none text-ink-3">{g.group}</div>
          <div className="space-y-px">
            {g.items.map((t) => (
              <button
                key={t}
                onClick={() => onPick(t)}
                disabled={disabled}
                className="group flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] leading-snug text-ink-2 outline-none hover:bg-paper-3/60 hover:text-ink focus-visible:ring-2 focus-visible:ring-rose/35 disabled:opacity-50"
              >
                <ChevronRight size={13} className="mt-[3px] shrink-0 text-ink-4 group-hover:text-ink-2" />
                {t}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
