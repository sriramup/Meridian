"use client";

import { Activity, Check, ChevronRight, CircleAlert, MapPin, TriangleAlert } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { ChatItem, ToolCallView } from "@/agent/types";
import { entityName } from "@/agent/resolve";
import { rtMaybe } from "@/state/runtime";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Spinner } from "@/components/ui/kit";
import { cx } from "../ui";
import { Markdown } from "../Markdown";
import { buildTranscript, formatDuration, liveLabel, runSummary, type Run, type Step } from "./model";
import { useNow } from "./SessionList";
import { agents } from "./store";
import { TOOL_ICON, TOOL_VERB } from "./toolMeta";
import { SerpCards } from "../serp/SerpCards";

/**
 * One session's conversation. Each reply of the agent reads as its answer under a single quiet
 * line: while it works, what it is doing and for how long; once done, "Worked for 18s · 7 steps",
 * which opens onto the steps. Approvals always stay in view.
 */
export function Transcript({ sessionId, items, running }: { sessionId: string; items: ChatItem[]; running: boolean }) {
  const entries = useMemo(() => buildTranscript(items, running), [items, running]);
  let prevUser: Extract<ChatItem, { kind: "user" }> | null = null;
  return (
    <div className="flex flex-col gap-5 px-4 pt-4 pb-6">
      {entries.map((e) => {
        if (e.kind === "user") {
          const p = prevUser;
          prevUser = e.item;
          return <UserMsg key={e.item.id} item={e.item} prev={p} />;
        }
        return <RunView key={e.run.id} sessionId={sessionId} run={e.run} />;
      })}
    </div>
  );
}

const UserMsg = memo(function UserMsg({ item, prev }: { item: Extract<ChatItem, { kind: "user" }>; prev: Extract<ChatItem, { kind: "user" }> | null }) {
  const R = rtMaybe();
  // the run's mode / zone, only when it is not the default and differs from the previous turn's
  const changed = !prev || prev.mode !== item.mode || prev.zone?.id !== item.zone?.id;
  const meta = changed && (item.mode === "plan" || item.zone) ? [item.mode === "plan" ? "Plan" : null, item.zone?.label ?? null].filter(Boolean).join(" · ") : null;
  return (
    <div className="flex flex-col items-end gap-1 pl-8">
      {item.refs.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1">
          {item.refs.map((id) => {
            const e = R?.world.get(id);
            return (
              <span key={id} className="inline-flex h-5 max-w-[180px] items-center truncate rounded-[4px] bg-accent-2 px-1.5 text-[10.5px] font-medium text-rose">
                {e ? entityName(e) : id}
              </span>
            );
          })}
        </div>
      )}
      <div className="max-w-full rounded-[10px] bg-paper-3 px-3 py-2 text-[13px] leading-[1.5] break-words whitespace-pre-wrap text-ink">{item.text}</div>
      {meta && (
        <div className="flex max-w-full items-center gap-1 text-[11px] text-ink-4">
          {item.zone && <MapPin size={11} className="shrink-0" />}
          <span className="truncate">{meta}</span>
        </div>
      )}
    </div>
  );
});

function RunView({ sessionId, run }: { sessionId: string; run: Run }) {
  const hasWork = run.live || run.steps.length > 0;
  return (
    <div className="flex flex-col gap-2.5">
      {hasWork && <Work run={run} />}
      <SerpCards steps={run.steps} />
      {run.approvals.map((a) => (
        <Approval key={a.id} sessionId={sessionId} item={a} />
      ))}
      {run.answer && (
        <div className="text-[13px]">
          <Markdown text={run.answer} />
        </div>
      )}
      {run.notices.map((n) => (
        <div key={n.id} className={cx("flex items-start gap-1.5 text-[12px] leading-snug", n.tone === "error" ? "text-bad" : "text-ink-4")}>
          {n.tone === "error" && <CircleAlert size={13} className="mt-px shrink-0" />}
          <span className="min-w-0">{n.text}</span>
        </div>
      ))}
    </div>
  );
}

/** the run's work as one line: live status while it runs, a summary after; opens onto the steps */
function Work({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const canOpen = run.steps.length > 0;
  return (
    <Collapsible open={open && canOpen} onOpenChange={setOpen}>
      <CollapsibleTrigger
        data-run-work
        disabled={!canOpen}
        className="group flex max-w-full items-center gap-1.5 rounded-[5px] py-0.5 pr-1 text-left text-[12.5px] text-ink-3 outline-none hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-rose/40 disabled:cursor-default"
      >
        {run.live ? <LiveLine run={run} /> : <span className="truncate">{runSummary(run)}</span>}
        {!run.live && run.issues > 0 && <TriangleAlert size={12} className="shrink-0 text-warn" aria-label={`${run.issues} step${run.issues > 1 ? "s" : ""} failed`} />}
        {canOpen && <ChevronRight size={13} className="shrink-0 text-ink-4 transition-transform duration-150 group-data-[state=open]:rotate-90" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-1.5 ml-[6px] flex flex-col gap-0.5 border-l border-line pl-3">
          {run.steps.map((s, i) => (
            <li key={s.kind === "tool" ? s.call.id : `${s.kind}${i}`}>
              <StepRow step={s} />
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

function LiveLine({ run }: { run: Run }) {
  const now = useNow(1000);
  const label = liveLabel(run, TOOL_VERB);
  const waiting = label === "Waiting for approval";
  return (
    <span className="flex min-w-0 items-center gap-2">
      {waiting ? <CircleAlert size={13} className="shrink-0 text-warn" /> : <Spinner size={12} label={label} className="text-rose" />}
      <span className="truncate text-ink-2">{waiting ? label : `${label}…`}</span>
      <span className="tabular shrink-0 text-ink-4">{formatDuration(Math.max(0, now - run.start))}</span>
    </span>
  );
}

function StepRow({ step }: { step: Step }) {
  if (step.kind === "tool") return <ToolRow call={step.call} />;
  return <Thought text={step.text} italic={step.kind === "thinking"} />;
}

/** reasoning or a remark between steps: a few muted lines, the rest on click */
function Thought({ text, italic }: { text: string; italic: boolean }) {
  const [full, setFull] = useState(false);
  const clean = text.replace(/\*\*/g, "");
  const long = clean.length > 220 || clean.split("\n").length > 3;
  return (
    <div
      onClick={() => long && setFull(!full)}
      className={cx("py-1 pl-1 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-3", italic && "italic", long && "cursor-pointer hover:text-ink-2", long && !full && "line-clamp-3")}
    >
      {clean}
    </div>
  );
}

function ToolRow({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[call.name] ?? Activity;
  const d = call.display;
  const busy = call.status === "running" || call.status === "streaming";
  const isEdit = !!d?.changesetId;
  const hasDetail = !!(d?.lines?.length || d?.metrics?.length || call.input);
  const title = busy ? (TOOL_VERB[call.name] ?? call.name) : (d?.title ?? TOOL_VERB[call.name] ?? call.name);
  const failed = call.status === "error" || call.status === "blocked";
  return (
    <div>
      <button
        onClick={() => hasDetail && setOpen(!open)}
        aria-expanded={hasDetail ? open : undefined}
        className={cx("flex w-full items-center gap-2 rounded-[5px] py-1 pr-1 pl-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-rose/40", hasDetail ? "hover:bg-paper-3/50" : "cursor-default")}
      >
        <span className={cx("grid size-4 shrink-0 place-items-center", failed ? "text-bad" : isEdit ? "text-proposed" : "text-ink-4")}>
          {busy ? <Spinner size={12} label={title} /> : <Icon size={13} strokeWidth={1.8} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          <span className={busy ? "text-ink-3" : "text-ink-2"}>{title}</span>
          {d?.detail && !busy && <span className="text-ink-4"> · {d.detail}</span>}
        </span>
        {call.status === "blocked" && <span className="shrink-0 text-[11px] text-bad">Outside zone</span>}
        {call.status === "cancelled" && <span className="shrink-0 text-[11px] text-ink-4">Cancelled</span>}
        {call.status === "error" && <TriangleAlert size={12} className="shrink-0 text-bad" />}
        {d?.status === "warn" && call.status === "done" && <TriangleAlert size={12} className="shrink-0 text-warn" />}
        {call.status === "done" && d?.status === "ok" && isEdit && <Check size={12} className="shrink-0 text-good" />}
        {call.ms !== undefined && call.ms > 400 && <span className="tabular shrink-0 text-[10.5px] text-ink-4">{(call.ms / 1000).toFixed(1)}s</span>}
      </button>
      {open && (
        <div className="space-y-2 pt-0.5 pb-2 pl-7">
          {d?.metrics && d.metrics.length > 0 && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {d.metrics.map((m) => (
                <div key={m.label} className="min-w-0">
                  <div className="truncate text-[10.5px] text-ink-4">{m.label}</div>
                  <div className="tabular text-[12.5px] font-medium text-ink">
                    {m.value} {m.delta && <span className={cx("text-[11px]", m.tone === "good" ? "text-good" : m.tone === "bad" ? "text-bad" : "text-ink-3")}>({m.delta})</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {d?.lines && d.lines.length > 0 && (
            <ul className="space-y-0.5 text-[11.5px] leading-snug text-ink-2">
              {d.lines.slice(0, 14).map((l, k) => (
                <li key={k} className={cx(l.startsWith("⚠") ? "text-warn" : l.startsWith("✕") ? "text-bad" : "")}>
                  {l}
                </li>
              ))}
              {d.lines.length > 14 && <li className="text-ink-4">+{d.lines.length - 14} more</li>}
            </ul>
          )}
          {call.input && (
            <details className="text-[11px] text-ink-4">
              <summary className="cursor-pointer select-none hover:text-ink-3">Parameters</summary>
              <pre className="scroll-thin mt-1 max-h-48 overflow-auto rounded-[5px] bg-paper-2/70 p-2 font-mono text-[10.5px] leading-snug text-ink-3 ring-1 ring-line">{JSON.stringify(call.input, null, 1)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function Approval({ sessionId, item }: { sessionId: string; item: Extract<ChatItem, { kind: "approval" }> }) {
  if (item.state !== "pending")
    return (
      <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
        {item.state === "approved" ? <Check size={13} className="shrink-0 text-good" /> : <TriangleAlert size={12} className="shrink-0 text-ink-4" />}
        <span className="truncate">
          {item.state === "approved" ? "Approved" : "Declined"} · {item.title.replace(/^Approve\s+/i, "").replace(/^[“"](.*)[”"]\?$/, "$1").replace(/\?$/, "")}
        </span>
      </div>
    );
  return (
    <div className="rounded-[8px] border border-warn/40 bg-warn-2/50 px-3 py-2.5">
      <div className="text-[12.5px] font-semibold text-ink">{item.title}</div>
      {item.lines.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[12px] leading-snug text-ink-2">
          {item.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" variant="primary" onClick={() => agents.resolveApproval(sessionId, item.id, true)}>
          Apply
        </Button>
        <Button size="sm" onClick={() => agents.resolveApproval(sessionId, item.id, false)}>
          Decline
        </Button>
      </div>
    </div>
  );
}
