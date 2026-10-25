// Pure helpers for the agents pane: searching and grouping sessions, relative times, zone labels
// and the fixed colour each session's zone is drawn in. No React, no runtime imports (tested in
// tests/agents-pane.test.ts).

import { fmtArea } from "@/lib/units";
import type { AgentSession, ChatItem, Segment, SessionStatus, ToolCallView } from "@/agent/types";
import { polyArea } from "@/geometry/polygon";
import type { Polygon } from "@/world/types";

export type GroupId = "attention" | "running" | "recent";
export const GROUP_LABEL: Record<GroupId, string> = { attention: "Needs input", running: "Running", recent: "Recent" };

export const STATUS_LABEL: Record<SessionStatus, string> = { idle: "Done", running: "Running", needs_input: "Needs input", error: "Failed" };

/** what a status reads as in a row: an idle session that never ran is a draft, not "done" */
export function statusText(s: Pick<AgentSession, "status" | "items">): string {
  if (s.status === "idle" && !s.items.some((i) => i.kind === "user")) return "New";
  return STATUS_LABEL[s.status];
}

function itemText(it: ChatItem): string {
  if (it.kind === "user") return it.text;
  if (it.kind === "assistant") return it.segments.map((s) => (s.type === "text" ? s.text : s.type === "tool" ? (s.call.display?.title ?? "") : "")).join(" ");
  if (it.kind === "approval") return `${it.title} ${it.lines.join(" ")}`;
  return it.text;
}

/** case- and accent-insensitive; every whitespace-separated term must appear in the title, zone or messages */
export function matchesQuery(s: AgentSession, query: string): boolean {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = fold([s.title, s.zone?.label ?? "", ...s.items.map(itemText)].join("\n"));
  return terms.every((t) => hay.includes(t));
}

function fold(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** a short excerpt around the first match in the messages (not the title), for the row's second line */
export function matchExcerpt(s: AgentSession, query: string, width = 64): string | null {
  const term = fold(query).split(/\s+/).filter(Boolean)[0];
  if (!term || fold(s.title).includes(term)) return null;
  for (const it of s.items) {
    const t = itemText(it).replace(/[*_`#>]+/g, "").replace(/\s+/g, " ");
    const i = fold(t).indexOf(term);
    if (i < 0) continue;
    const a = Math.max(0, i - Math.floor((width - term.length) / 2));
    return (a > 0 ? "…" : "") + t.slice(a, a + width).trim() + (a + width < t.length ? "…" : "");
  }
  return null;
}

/** needs input first, then running, then everything else; newest activity first inside each group */
export function groupSessions(sessions: AgentSession[], query = ""): { id: GroupId; sessions: AgentSession[] }[] {
  const by: Record<GroupId, AgentSession[]> = { attention: [], running: [], recent: [] };
  for (const s of sessions) {
    if (!matchesQuery(s, query)) continue;
    by[s.status === "needs_input" ? "attention" : s.status === "running" ? "running" : "recent"].push(s);
  }
  return (Object.keys(by) as GroupId[]).filter((g) => by[g].length).map((id) => ({ id, sessions: by[id].sort((a, b) => b.updatedAt - a.updatedAt) }));
}

/** "now", "4m", "3h", "2d", then a date: the compact stamp of a session list */
export function relTime(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** edits a session committed: its changesets, or failing that the edit tool calls that produced one */
export function editCount(s: AgentSession): number {
  if (s.changesets.length) return s.changesets.length;
  let n = 0;
  for (const it of s.items) if (it.kind === "assistant") for (const g of it.segments) if (g.type === "tool" && g.call.display?.changesetId && g.call.status === "done") n++;
  return n;
}

/** an area for a zone label, imperial: 8,600 sq ft, 3.2 acres, 48 acres, then sq mi */
export function formatArea(m2: number): string {
  return fmtArea(m2);
}

export function drawnZoneLabel(poly: Polygon): string {
  return `Drawn area · ${formatArea(polyArea(poly))}`;
}

/** title for a new session from its first message: first sentence, at most ~48 characters on a word boundary */
export function titleFromText(text: string, max = 48): string {
  const one = text.replace(/\s+/g, " ").trim();
  const sentence = one.split(/(?<=[.!?])\s/)[0];
  if (sentence.length <= max) return sentence.replace(/[.!]$/, "");
  const cut = sentence.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "") + "…";
}

/** fixed zone colours (RGB), legible over the parchment basemap and the buildings; one per session */
export const ZONE_COLORS: [number, number, number][] = [
  [154, 62, 40], // madder
  [44, 96, 140], // prussian
  [74, 112, 58], // sap green
  [128, 72, 132], // mulberry
  [176, 116, 22], // ochre
  [36, 118, 116], // verdigris
  [168, 58, 96], // crimson lake
  [70, 74, 150], // indigo
];

export function sessionColor(id: string): [number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ZONE_COLORS[(h >>> 0) % ZONE_COLORS.length];
}

export const rgb = (c: [number, number, number], a = 1) => `rgb(${c[0]} ${c[1]} ${c[2]} / ${a})`;

// ---------------------------------------------------------------- runs

type UserItem = Extract<ChatItem, { kind: "user" }>;
type AssistantItem = Extract<ChatItem, { kind: "assistant" }>;
type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;
type NoticeItem = Extract<ChatItem, { kind: "notice" }>;

/** one step of a run's work: reasoning, a remark between tool calls, or a tool call */
export type Step = { kind: "thinking"; text: string } | { kind: "note"; text: string } | { kind: "tool"; call: ToolCallView };

/**
 * One reply of the agent: everything between a user message and the next. The work (reasoning,
 * tool calls, remarks between them) folds into `steps`; the text after the last step is the answer.
 */
export interface Run {
  id: string;
  steps: Step[];
  answer: string;
  approvals: ApprovalItem[];
  notices: NoticeItem[];
  /** first and last moment of work (ms epoch); end is undefined while live */
  start: number;
  end?: number;
  live: boolean;
  /** tool calls made */
  tools: number;
  /** tool calls that failed or were refused */
  issues: number;
}

export type TranscriptEntry = { kind: "user"; item: UserItem } | { kind: "run"; run: Run };

/** the conversation as user turns and runs (keyed by their user turn, so a run keeps its identity as it grows); the last run is live while the session runs */
export function buildTranscript(items: ChatItem[], running: boolean): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let group: ChatItem[] = [];
  let at = 0;
  let uid = "";
  const flush = (live: boolean) => {
    if (group.length) out.push({ kind: "run", run: toRun(group, at, live, uid ? `${uid}:run` : undefined) });
    group = [];
  };
  for (const it of items) {
    if (it.kind === "user") {
      flush(false);
      out.push({ kind: "user", item: it });
      at = it.at;
      uid = it.id;
    } else group.push(it);
  }
  const last = out[out.length - 1];
  if (group.length) flush(running);
  else if (running && last?.kind === "user") out.push({ kind: "run", run: toRun([], at, true, `${uid}:run`) });
  return out;
}

function toRun(items: ChatItem[], at: number, live: boolean, id?: string): Run {
  const segs: Segment[] = [];
  const approvals: ApprovalItem[] = [];
  const notices: NoticeItem[] = [];
  let start = at || Infinity;
  let end = 0;
  for (const it of items) {
    if (it.kind === "assistant") {
      segs.push(...(it as AssistantItem).segments);
      start = Math.min(start, it.startedAt);
      end = Math.max(end, it.startedAt + (it.ms ?? 0));
      for (const s of it.segments) if (s.type === "tool") end = Math.max(end, s.call.startedAt + (s.call.ms ?? 0));
    } else if (it.kind === "approval") approvals.push(it);
    else if (it.kind === "notice") notices.push(it);
  }
  // the answer is the text after the last tool call or reasoning
  let cut = segs.length;
  while (cut > 0 && segs[cut - 1].type === "text") cut--;
  const work = segs.slice(0, cut);
  const hasWork = work.some((s) => s.type !== "text");
  const answerSegs = hasWork ? segs.slice(cut) : segs;
  const steps: Step[] = [];
  if (hasWork)
    for (const s of work) {
      if (s.type === "tool") steps.push({ kind: "tool", call: s.call });
      else if (s.text.trim()) steps.push({ kind: s.type === "thinking" ? "thinking" : "note", text: s.text.trim() });
    }
  const calls = steps.flatMap((s) => (s.kind === "tool" ? [s.call] : []));
  if (!Number.isFinite(start)) start = end || at;
  return {
    id: id ?? items[0]?.id ?? "run",
    steps,
    answer: answerSegs.map((s) => (s.type === "text" ? s.text : "")).join("\n\n").trim(),
    approvals,
    notices,
    start,
    end: live ? undefined : Math.max(end, start),
    live,
    tools: calls.length,
    issues: calls.filter((c) => c.status === "error" || c.status === "blocked").length,
  };
}

/** what a live run is doing right now, in a few words */
export function liveLabel(run: Run, verbs: Record<string, string>): string {
  if (run.approvals.some((a) => a.state === "pending")) return "Waiting for approval";
  if (run.answer) return "Writing";
  const last = run.steps[run.steps.length - 1];
  if (!last || last.kind === "thinking") return "Thinking";
  if (last.kind === "tool") {
    const busy = last.call.status === "running" || last.call.status === "streaming";
    return busy ? (verbs[last.call.name] ?? "Working") : "Thinking";
  }
  return "Working";
}

/** "4s", "1m 12s", "1h 3m" */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** the collapsed line of a finished run: "Worked for 18s · 7 steps", "Thought for 4s"; null when it did no work */
export function runSummary(run: Run): string | null {
  if (!run.steps.length) return null;
  const d = formatDuration((run.end ?? run.start) - run.start);
  if (!run.tools) return `Thought for ${d}`;
  return `Worked for ${d} · ${run.tools} step${run.tools > 1 ? "s" : ""}`;
}
