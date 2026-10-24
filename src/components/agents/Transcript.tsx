"use client";

import { Activity, Check, ChevronRight, CircleAlert, MapPin, TriangleAlert } from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { ChatItem, Segment, ToolCallView } from "@/agent/types";
import { entityName } from "@/agent/resolve";
import { rtMaybe } from "@/state/runtime";
import { Button, Spinner } from "@/components/ui/kit";
import { cx } from "../ui";
import { Markdown } from "../Markdown";
import { TOOL_ICON, TOOL_VERB } from "./toolMeta";
import { agents } from "./store";

/** one session's conversation: user turns, the agent's reasoning, tool timeline and text, approvals */
export function Transcript({ sessionId, items, running }: { sessionId: string; items: ChatItem[]; running: boolean }) {
  return (
    <div className="px-4 py-4">
      {items.map((it, i) => (
        // one run's consecutive turns read as one continuous reply
        <div key={it.id} className={cx(i > 0 && (it.kind === "assistant" && items[i - 1].kind === "assistant" ? "mt-1" : "mt-4"))}>
          <Item sessionId={sessionId} item={it} prev={items[i - 1]} />
        </div>
      ))}
      {running && !items.some((it) => it.kind === "approval" && it.state === "pending") && (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
          <Spinner size={13} label="Working" />
          Working
        </div>
      )}
    </div>
  );
}

const Item = memo(function Item({ sessionId, item, prev }: { sessionId: string; item: ChatItem; prev?: ChatItem }) {
  if (item.kind === "user") {
    // show the run's mode / zone when it differs from the previous run's
    const prevUser = prev?.kind === "user" ? prev : null;
    return <UserMsg item={item} showMeta={!prevUser || prevUser.mode !== item.mode || prevUser.zone?.id !== item.zone?.id} />;
  }
  if (item.kind === "notice")
    return (
      <div className={cx("flex items-start gap-2 text-[12px] leading-snug", item.tone === "error" ? "text-bad" : "text-ink-3")}>
        {item.tone === "error" && <CircleAlert size={13} className="mt-px shrink-0" />}
        <span className="min-w-0">{item.text}</span>
      </div>
    );
  if (item.kind === "approval") return <Approval sessionId={sessionId} item={item} />;
  return <AssistantMsg segments={item.segments} done={item.done} />;
});

function UserMsg({ item, showMeta }: { item: Extract<ChatItem, { kind: "user" }>; showMeta: boolean }) {
  const R = rtMaybe();
  return (
    <div className="flex flex-col items-end gap-1">
      {item.refs.length > 0 && (
        <div className="flex max-w-[90%] flex-wrap justify-end gap-1">
          {item.refs.map((id) => {
            const e = R?.world.get(id);
            return (
              <span key={id} className="inline-flex h-5 items-center rounded-[4px] bg-accent-2 px-1.5 text-[10.5px] font-medium text-rose">
                {e ? entityName(e) : id}
              </span>
            );
          })}
        </div>
      )}
      <div className="max-w-[90%] rounded-[8px] bg-paper-3 px-3 py-2 text-[13px] leading-[1.5] whitespace-pre-wrap text-ink">{item.text}</div>
      {showMeta && (
        <div className="flex max-w-[90%] items-center gap-1.5 text-[11px] text-ink-4">
          <span>{item.mode === "plan" ? "Plan" : "Edit"}</span>
          <span aria-hidden>·</span>
          <MapPin size={11} className="shrink-0" />
          <span className="truncate">{item.zone ? item.zone.label : "Anywhere"}</span>
        </div>
      )}
    </div>
  );
}

function AssistantMsg({ segments, done }: { segments: Segment[]; done: boolean }) {
  // consecutive tool calls read as one activity timeline
  const groups = useMemo(() => {
    const out: ({ type: "tools"; calls: ToolCallView[] } | Segment)[] = [];
    for (const s of segments) {
      if (s.type === "tool") {
        const last = out[out.length - 1];
        if (last && last.type === "tools") last.calls.push(s.call);
        else out.push({ type: "tools", calls: [s.call] });
      } else out.push(s);
    }
    return out;
  }, [segments]);
  if (!segments.length) return null;
  return (
    <div className="space-y-2.5">
      {groups.map((g, i) =>
        g.type === "thinking" ? (
          <Thinking key={i} text={g.text} live={!done && i === groups.length - 1} />
        ) : g.type === "text" ? (
          g.text.trim() ? <Markdown key={i} text={g.text} /> : null
        ) : g.type === "tools" ? (
          <ToolTimeline key={i} calls={g.calls} />
        ) : null,
      )}
    </div>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const first = text.trim().split("\n").find((l) => l.trim()) ?? "";
  return (
    <div className="text-[12px] text-ink-3">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-start gap-1.5 rounded-[4px] text-left outline-none hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-rose/40">
        <ChevronRight size={13} className={cx("mt-[2px] shrink-0 transition-transform", open && "rotate-90")} />
        <span className={cx("min-w-0", !open && "truncate")}>
          <span className="font-medium text-ink-2">{live ? "Reasoning" : "Reasoned"}</span>
          {!open && first && <span className="text-ink-4"> — {first.replace(/\*\*/g, "")}</span>}
        </span>
      </button>
      {open && <div className="mt-1 ml-[6px] border-l border-line pl-[13px] leading-relaxed whitespace-pre-wrap text-ink-3">{text.trim()}</div>}
    </div>
  );
}

/** the steps as a quiet list hung from a rule, not a box */
function ToolTimeline({ calls }: { calls: ToolCallView[] }) {
  return (
    <div className="relative">
      <div className="absolute top-3 bottom-3 left-[11px] w-px bg-line" aria-hidden />
      {calls.map((c) => (
        <ToolRow key={c.id} call={c} />
      ))}
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
    <div className="relative">
      <button
        onClick={() => hasDetail && setOpen(!open)}
        aria-expanded={hasDetail ? open : undefined}
        className={cx("flex w-full items-center gap-2.5 rounded-[5px] py-[5px] pr-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-rose/40", hasDetail && "hover:bg-paper-3/50")}
      >
        <span
          className={cx(
            "relative grid size-[23px] shrink-0 place-items-center rounded-full ring-1",
            failed ? "bg-bad-2 text-bad ring-bad/30" : isEdit ? "bg-proposed-2 text-proposed ring-proposed/30" : "bg-paper text-ink-3 ring-line",
          )}
        >
          {busy ? <Spinner size={12} label={title} /> : <Icon size={12} strokeWidth={1.9} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate text-[12.5px]", busy ? "text-ink-3" : "text-ink")}>{title}</span>
          {d?.detail && !busy && <span className="block truncate text-[11.5px] text-ink-3">{d.detail}</span>}
        </span>
        {call.status === "blocked" && <span className="shrink-0 text-[11px] text-bad">Outside zone</span>}
        {call.status === "cancelled" && <span className="shrink-0 text-[11px] text-ink-4">Cancelled</span>}
        {call.status === "error" && <TriangleAlert size={13} className="shrink-0 text-bad" />}
        {d?.status === "warn" && call.status === "done" && <TriangleAlert size={13} className="shrink-0 text-warn" />}
        {call.status === "done" && d?.status === "ok" && isEdit && <Check size={13} className="shrink-0 text-good" />}
        {call.ms !== undefined && call.ms > 400 && <span className="tabular shrink-0 text-[10.5px] text-ink-4">{(call.ms / 1000).toFixed(1)}s</span>}
      </button>
      {open && (
        <div className="space-y-2 pt-0.5 pb-2 pl-[33px]">
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
  const pending = item.state === "pending";
  return (
    <div className={cx("rounded-[7px] border px-3 py-2.5", pending ? "border-warn/40 bg-warn-2/50" : "border-line bg-transparent")}>
      <div className="flex items-start gap-2">
        <TriangleAlert size={14} className={cx("mt-px shrink-0", pending ? "text-warn" : "text-ink-4")} />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-ink">{item.title}</div>
          <ul className="mt-1 space-y-0.5 text-[12px] leading-snug text-ink-2">
            {item.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          {pending ? (
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" variant="primary" onClick={() => agents.resolveApproval(sessionId, item.id, true)}>
                Apply
              </Button>
              <Button size="sm" onClick={() => agents.resolveApproval(sessionId, item.id, false)}>
                Decline
              </Button>
            </div>
          ) : (
            <div className={cx("mt-1.5 text-[11.5px] font-medium", item.state === "approved" ? "text-good" : "text-ink-3")}>{item.state === "approved" ? "Applied" : "Declined"}</div>
          )}
        </div>
      </div>
    </div>
  );
}
