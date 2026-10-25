// Multi-agent runtime: several agent sessions, each with its own conversation, mode (plan / edit),
// optional zone, Anthropic message history, abort controller and approvals, running concurrently on
// the same live world. The store `useAgents` is what the agents pane renders; the named exports
// implement AgentsApi (src/agent/types.ts).
//
// Parallel-safety rules
//  - Edits are serialised through the executor's world lock (tools.ts); every committed changeset is
//    tagged with its session, and undo / revert_change act on the session's own changesets.
//  - Scenario: a run works in the scenario that was active when it started. If the active scenario
//    changes under it (the user or another agent switched or branched), its further edits are refused
//    with an explanation instead of switching the user's view back; reads keep working. Exception: a
//    run that started on the read-only baseline adopts a branch auto-created from it after the run
//    began (the first edit by anyone auto-branches). The next run starts in whatever is active.
//  - Staleness: before each model turn the runtime diffs the scenario's applied changesets against
//    what the session last saw; edits by others are reported to the model, with a warning that dry-run
//    previews computed before them may be stale.
//  - Approvals are per session (status "needs_input"); the world lock is released while waiting and the
//    change is re-checked against the world before it is applied.
//
// Persistence: sessions (items, mode, zone, changesets, and the message history when it fits) are saved
// per project (or per city before a project id is provided) in localStorage, capped; a session restored without its history gets a short transcript of
// the earlier conversation with its next request. Runs interrupted by a reload are marked as stopped.

import type Anthropic from "@anthropic-ai/sdk";
import { create } from "zustand";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { useSims } from "@/sim/client";
import type { Changeset } from "@/world/world";
import { entityName, viewCenter } from "./resolve";
import { routeRequest, type Tier } from "./router";
import { MAX_STEPS } from "./models";
import { effectOf } from "./toolDefs";
import { executeTool, simSummary, type ToolContext, type ToolOutput } from "./tools";
import type { AgentMode, AgentSession, AgentsApi, ChatItem, Segment, ToolCallView, Zone } from "./types";
import { zoneFromPolygon, zoneFromSelection, zoneFromText, zoneSummary, fmtHa } from "./zones";

type MsgParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

export interface AgentsState {
  sessions: Record<string, AgentSession>;
  /** session ids, most recently active first */
  order: string[];
  /** session the pane shows; null = the list */
  viewing: string | null;
  /** server has an API key (null = not checked yet) */
  configured: boolean | null;
  /** models per tier reported by the server */
  models: Partial<Record<Tier, string>>;
  /** server spend ledger (USD) when last checked */
  spend?: { total_usd: number; cap_usd: number | null; remaining_usd: number | null };
}

/** per-session runtime state that is not rendered */
interface Runtime {
  messages: MsgParam[];
  abort: AbortController | null;
  approvals: Map<string, (ok: boolean) => void>;
  /** changeset ids of the run's scenario the session has already been told about */
  seen: Set<string>;
  /** transcript to prepend to the next request when the history could not be restored */
  restored?: string;
  run?: { scenario: string; startedAt: number; zone: Zone | null; mode: AgentMode; request: string };
}

const RESULT_CHARS = 16000;
const KEY = (city: string) => `meridian.agents.v1.${city}`;

let seq = 0;
const nid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const runtimes = new Map<string, Runtime>();
const rtOf = (id: string): Runtime => {
  let r = runtimes.get(id);
  if (!r) runtimes.set(id, (r = { messages: [], abort: null, approvals: new Map(), seen: new Set() }));
  return r;
};

function blankSession(opts: { title?: string; mode?: AgentMode; zone?: Zone | null } = {}): AgentSession {
  const now = Date.now();
  return { id: nid("s"), title: opts.title ?? "New agent", createdAt: now, updatedAt: now, status: "idle", items: [], mode: opts.mode ?? "edit", zone: opts.zone ?? null, changesets: [] };
}

const first = blankSession();
export const useAgents = create<AgentsState>(() => ({ sessions: { [first.id]: first }, order: [first.id], viewing: first.id, configured: null, models: {} }));

// ---------------------------------------------------------------- store helpers

function patch(id: string, f: (s: AgentSession) => Partial<AgentSession>) {
  useAgents.setState((st) => {
    const s = st.sessions[id];
    if (!s) return st;
    return { sessions: { ...st.sessions, [id]: { ...s, ...f(s), updatedAt: Date.now() } } };
  });
}
const getS = (id: string) => useAgents.getState().sessions[id];
function pushItem(id: string, item: ChatItem) {
  patch(id, (s) => ({ items: [...s.items, item] }));
}
function patchItem(id: string, itemId: string, f: (it: ChatItem) => ChatItem) {
  patch(id, (s) => ({ items: s.items.map((it) => (it.id === itemId ? f(it) : it)) }));
}
function setCall(id: string, itemId: string, callId: string, p: Partial<ToolCallView>) {
  patchItem(id, itemId, (it) => (it.kind === "assistant" ? { ...it, segments: it.segments.map((s) => (s.type === "tool" && s.call.id === callId ? { ...s, call: { ...s.call, ...p } } : s)) } : it));
}
function touch(id: string) {
  useAgents.setState((st) => ({ order: [id, ...st.order.filter((x) => x !== id)] }));
}

// ---------------------------------------------------------------- API

export function createSession(opts: { title?: string; mode?: AgentMode; zone?: Zone | null } = {}): string {
  ensureCity();
  const s = blankSession(opts);
  useAgents.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s }, order: [s.id, ...st.order], viewing: s.id }));
  return s.id;
}

export function deleteSession(id: string) {
  stop(id);
  runtimes.delete(id);
  useAgents.setState((st) => {
    const sessions = { ...st.sessions };
    delete sessions[id];
    let order = st.order.filter((x) => x !== id);
    if (!order.length) {
      const s = blankSession();
      sessions[s.id] = s;
      order = [s.id];
    }
    return { sessions, order, viewing: st.viewing === id ? (order.length === 1 ? order[0] : null) : st.viewing };
  });
}

export function renameSession(id: string, title: string) {
  const t = title.trim();
  if (t) patch(id, () => ({ title: t.slice(0, 80) }));
}

export function view(id: string | null) {
  ensureCity();
  if (id !== null && !getS(id)) return;
  useAgents.setState({ viewing: id });
}

export function setMode(id: string, mode: AgentMode) {
  patch(id, () => ({ mode }));
}

export function setZone(id: string, zone: Zone | null) {
  patch(id, () => ({ zone }));
  const r = runtimes.get(id);
  if (r?.run) r.run.zone = zone;
}

/** clear a session's conversation (keeps its mode, zone and title) */
export function clearSession(id: string) {
  stop(id);
  const r = rtOf(id);
  r.messages = [];
  r.restored = undefined;
  patch(id, () => ({ items: [], status: "idle", error: undefined }));
}

export function stop(id: string) {
  const r = runtimes.get(id);
  if (!r) return;
  r.abort?.abort();
  for (const [aid, res] of r.approvals) {
    res(false);
    patchItem(id, aid, (it) => (it.kind === "approval" ? { ...it, state: "declined" } : it));
  }
  r.approvals.clear();
}

export function stopAll() {
  for (const id of Object.keys(useAgents.getState().sessions)) stop(id);
}

export function resolveApproval(sessionId: string, approvalId: string, ok: boolean) {
  const r = runtimes.get(sessionId);
  r?.approvals.get(approvalId)?.(ok);
  r?.approvals.delete(approvalId);
  patchItem(sessionId, approvalId, (it) => (it.kind === "approval" ? { ...it, state: ok ? "approved" : "declined" } : it));
  if (getS(sessionId)?.status === "needs_input" && !r?.approvals.size) patch(sessionId, () => ({ status: "running" }));
}

export async function checkAgent() {
  try {
    const r = await fetch("/api/agent");
    const j = await r.json();
    useAgents.setState({ configured: !!j.configured, models: j.models ?? { standard: j.model }, spend: j.spend });
  } catch {
    useAgents.setState({ configured: false });
  }
}

// ---------------------------------------------------------------- transport

export type StreamEvent = { t: "text" | "thinking"; d: string } | { t: "tool"; id: string; name: string } | { t: "final"; message: Anthropic.Beta.BetaMessage; cost?: { usd: number; total_usd: number; cap_usd: number | null } } | { t: "route"; model: string; effort: string } | { t: "error"; message: string };
export type Transport = (body: { messages: MsgParam[]; tier: Tier; city: string }, signal: AbortSignal) => AsyncIterable<StreamEvent>;

async function* fetchTransport(body: { messages: MsgParam[]; tier: Tier; city: string }, signal: AbortSignal): AsyncIterable<StreamEvent> {
  const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(j.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) yield JSON.parse(line) as StreamEvent;
    }
  }
}

let transport: Transport = fetchTransport;
/** replace the model transport (tests drive the loop with scripted turns) */
export function setTransport(t: Transport | null) {
  transport = t ?? fetchTransport;
}

// ---------------------------------------------------------------- context snapshot

const r0 = (x: number) => Math.round(x);
function kpiLine(): string {
  const R = rtMaybe();
  if (!R) return "";
  const recs = useSims.getState().records.filter((r) => r.status === "done" && r.result);
  const latest = new Map<string, (typeof recs)[number]>();
  for (const r of recs) latest.set(r.kind, r);
  const out: string[] = [];
  for (const [kind, r] of latest) {
    let sum: Record<string, unknown>;
    try {
      sum = (simSummary(r) ?? {}) as Record<string, unknown>;
    } catch {
      continue;
    }
    // headline scalars: top-level numbers / short strings, plus the kpi object when there is one
    const flat = { ...(typeof sum.kpi === "object" && sum.kpi ? (sum.kpi as Record<string, unknown>) : {}), ...sum };
    const vals = Object.entries(flat)
      .filter(([k, v]) => k !== "kpi" && k !== "assumptions" && (typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v.length <= 12))
      .slice(0, 6)
      .map(([k, v]) => `${k} ${typeof v === "number" ? (Math.abs(v) >= 100 ? r0(v) : Math.round(v * 100) / 100) : v}`);
    if (!vals.length) continue;
    const fresh = r.scenarioId === R.scenarios.activeId && r.cursor === R.scenarios.active.cursor;
    out.push(`${kind}${r.params?.period ? ` ${r.params.period}` : ""} (${r.scenarioName}${fresh ? ", current" : `, at edit ${r.cursor} — stale`}): ${vals.join(", ")}`);
  }
  return out.slice(-4).join(" | ");
}

/** compact live snapshot sent with every request so state questions need no tool calls */
export function contextBlock(sessionId: string, mode: AgentMode, zone: Zone | null): string {
  const R = rtMaybe();
  const lines: string[] = [];
  lines.push(mode === "plan" ? "mode: plan — investigate and propose; edit tools run only as dry runs (previews), nothing is applied" : "mode: edit — you may change the world");
  lines.push(zone ? `zone: ${zoneSummary(zone)} — keep every edit inside it (within: "zone")` : "zone: none — you may edit anywhere");
  if (R) {
    const S = R.scenarios;
    const applied = S.appliedChangesets();
    const mine = applied.filter((c) => c.session === sessionId).length;
    lines.push(`scenario: “${S.active.name}” (id ${S.activeId}, ${S.active.cursor} edits: ${mine} by this session, ${applied.length - mine} by others)${S.scenarios.size > 1 ? ` · branches: ${[...S.scenarios.values()].map((s) => s.name).join(", ")}` : ""}`);
    const recent = applied.slice(-3).map((c) => `“${c.label}” (${c.session === sessionId ? "this session" : c.session ? "another agent" : c.author})`);
    if (recent.length) lines.push(`recent edits: ${recent.join("; ")}`);
    const st = useApp.getState();
    const sel = st.selection.slice(0, 6).map((id) => {
      const e = R.world.get(id);
      return e ? `${id} (${e.kind}: ${entityName(e)})` : id;
    });
    lines.push(`selection: ${sel.length ? sel.join("; ") + (st.selection.length > 6 ? ` +${st.selection.length - 6} more` : "") : "none"}`);
    const c = viewCenter();
    lines.push(`view: centre [${r0(c[0])}, ${r0(c[1])}], zoom ${(R.map?.getZoom() ?? 0).toFixed(1)}`);
    const w = R.world;
    lines.push(`world: ${w.count("building")} buildings, ${w.count("street")} street segments, ${w.count("area")} areas, ${w.count("tree")} trees${w.count("parcel") ? `, ${w.count("parcel")} parcels` : ""}${w.count("route") ? `, ${w.count("route")} transit routes` : ""}`);
    if (st.overlay) lines.push(`overlay: ${st.overlay} at ${st.hour.toFixed(0)}:00`);
    const k = kpiLine();
    if (k) lines.push(`latest model KPIs: ${k}`);
  }
  const others = Object.values(useAgents.getState().sessions).filter((s) => s.id !== sessionId && (s.status === "running" || s.status === "needs_input"));
  if (others.length) lines.push(`other agents working now: ${others.map((s) => `“${s.title}”${s.zone ? ` in ${s.zone.label}` : ""}`).join("; ")}`);
  return `<context>\n${lines.join("\n")}\n</context>`;
}

// ---------------------------------------------------------------- run loop

function scenarioGuard(r: Runtime): string | null {
  const R = rtMaybe();
  if (!R || !r.run) return null;
  const S = R.scenarios;
  if (S.activeId === r.run.scenario) return null;
  const was = S.scenarios.get(r.run.scenario);
  if (r.run.scenario === "baseline" && S.active.createdAt >= r.run.startedAt - 1) {
    // someone's first edit auto-branched off the read-only baseline since this run began: follow it
    r.run.scenario = S.activeId;
    return null;
  }
  return `The active scenario changed to “${S.active.name}” while you were working (your run started in “${was?.name ?? r.run.scenario}”). To avoid changing what the user is looking at, this edit was not applied. Tell the user; the next request will work in the active scenario.`;
}

function foreignNote(sessionId: string, r: Runtime): string | null {
  const R = rtMaybe();
  if (!R) return null;
  const applied = R.scenarios.appliedChangesets();
  const ids = new Set(applied.map((c) => c.id));
  const added = applied.filter((c) => !r.seen.has(c.id) && c.session !== sessionId);
  const removed = [...r.seen].filter((id) => !ids.has(id)).length;
  r.seen = ids;
  if (!added.length && !removed) return null;
  const list = added.slice(-5).map((c) => `“${c.label}” (${c.session ? "another agent" : c.author})`);
  return `[runtime] While you worked, the world changed outside this session: ${added.length ? `${added.length} new edit${added.length > 1 ? "s" : ""} ${list.join(", ")}` : ""}${added.length && removed ? "; " : ""}${removed ? `${removed} edit${removed > 1 ? "s" : ""} undone` : ""}. Dry-run previews computed before this may be stale — re-run a preview before relying on its numbers.`;
}

function requestApproval(sessionId: string, req: { title: string; lines: string[] }): Promise<boolean> {
  const id = nid("ap");
  pushItem(sessionId, { kind: "approval", id, title: req.title, lines: req.lines, state: "pending" });
  patch(sessionId, () => ({ status: "needs_input" }));
  return new Promise((resolve) => rtOf(sessionId).approvals.set(id, resolve));
}

function setZoneFromTool(sessionId: string, input: { zone?: unknown; clear?: boolean }): ToolOutput {
  const r = rtOf(sessionId);
  if (input.clear || input.zone === null || input.zone === undefined || (typeof input.zone === "string" && /^(none|anywhere|clear|no zone)$/i.test(input.zone.trim()))) {
    setZone(sessionId, null);
    return { content: { zone: null, message: "Zone cleared: this session may edit anywhere." }, display: { title: "Zone cleared", detail: "anywhere", status: "ok" } };
  }
  let res: ReturnType<typeof zoneFromText>;
  if (Array.isArray(input.zone)) {
    try {
      res = { ok: true, zone: zoneFromPolygon(input.zone as [number, number][], { source: "text", label: "Zone" }) };
    } catch (e) {
      res = { ok: false, error: (e as Error).message };
    }
  } else res = zoneFromText(String(input.zone), { selection: useApp.getState().selection });
  if (!res.ok) return { content: { error: res.error, candidates: res.candidates?.map((z) => z.label) }, display: { title: "Set zone", detail: res.error, status: "error" }, isError: true };
  setZone(sessionId, res.zone);
  if (r.run) r.run.zone = res.zone;
  return {
    content: { zone: res.zone.label, area_ha: Number(fmtHa(res.zone.poly).split(" ")[0]), summary: zoneSummary(res.zone), alternatives: res.candidates?.map((z) => z.label), note: res.note },
    display: { title: `Zone: ${res.zone.label}`, detail: res.note, status: "ok" },
  };
}

function toolCtx(sessionId: string, signal: AbortSignal): ToolContext {
  const r = rtOf(sessionId);
  return {
    requestApproval: (req) => requestApproval(sessionId, req),
    approvals: true,
    signal,
    mode: r.run?.mode ?? getS(sessionId)?.mode ?? "edit",
    zone: r.run ? r.run.zone : (getS(sessionId)?.zone ?? null),
    sessionId,
    beforeCommit: () => scenarioGuard(r),
    onCommit: (cs: Changeset) => {
      const R = rtMaybe();
      if (r.run && R) r.run.scenario = R.scenarios.activeId;
      r.seen.add(cs.id);
      patch(sessionId, (s) => ({ changesets: [...s.changesets, cs.id], scenarioId: R?.scenarios.activeId }));
    },
    setZone: (input) => setZoneFromTool(sessionId, input),
    request: r.run?.request,
  };
}

async function streamTurn(sessionId: string, itemId: string, tier: Tier, signal: AbortSignal, onFirst: () => void): Promise<{ msg: Anthropic.Beta.BetaMessage | null; model?: string; usd?: number }> {
  const r = rtOf(sessionId);
  let final: Anthropic.Beta.BetaMessage | null = null;
  let model: string | undefined;
  let firstSeen = false;
  let usd: number | undefined;
  const append = (type: "thinking" | "text", d: string) =>
    patchItem(sessionId, itemId, (it) => {
      if (it.kind !== "assistant") return it;
      const segs = it.segments.slice();
      const last = segs[segs.length - 1];
      if (last && last.type === type) segs[segs.length - 1] = { ...last, text: last.text + d };
      else segs.push({ type, text: d });
      return { ...it, segments: segs };
    });
  for await (const ev of transport({ messages: r.messages, tier, city: rtMaybe()?.cityId ?? "sandbox" }, signal)) {
    if (signal.aborted) throw Object.assign(new Error("Stopped"), { name: "AbortError" });
    if (!firstSeen && (ev.t === "text" || ev.t === "tool" || ev.t === "final")) {
      firstSeen = true;
      onFirst();
    }
    if (ev.t === "text") append("text", ev.d);
    else if (ev.t === "thinking") append("thinking", ev.d);
    else if (ev.t === "tool") patchItem(sessionId, itemId, (it) => (it.kind === "assistant" ? { ...it, segments: [...it.segments, { type: "tool", call: { id: ev.id, name: ev.name, status: "streaming", startedAt: Date.now() } }] } : it));
    else if (ev.t === "route") model = ev.model;
    else if (ev.t === "final") {
      final = ev.message;
      usd = ev.cost?.usd;
    }
    else if (ev.t === "error") throw new Error(ev.message);
  }
  return { msg: final, model, usd };
}

const asView = (d: ToolOutput["display"]): ToolCallView["display"] => d;

async function runTool(sessionId: string, itemId: string, u: Anthropic.Beta.BetaToolUseBlock, signal: AbortSignal): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  if (signal.aborted) {
    setCall(sessionId, itemId, u.id, { status: "cancelled" });
    return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify({ cancelled: "Stopped by the user before this tool ran." }), is_error: true };
  }
  const ts = Date.now();
  setCall(sessionId, itemId, u.id, { status: "running", startedAt: ts });
  const input = (u.input ?? {}) as Record<string, unknown>;
  const out = await executeTool(u.name, input, toolCtx(sessionId, signal));
  if (u.name === "scenario" && !out.isError) {
    const r = rtOf(sessionId);
    const R = rtMaybe();
    if (r.run && R) r.run.scenario = R.scenarios.activeId; // the session switched / branched itself
  }
  setCall(sessionId, itemId, u.id, { status: out.blocked ? "blocked" : out.isError ? "error" : "done", display: asView(out.display), ms: Date.now() - ts });
  let content = JSON.stringify(out.content);
  if (content.length > RESULT_CHARS) content = content.slice(0, RESULT_CHARS) + '…"(truncated)"';
  return { type: "tool_result", tool_use_id: u.id, content, is_error: out.isError || undefined };
}

/** run a turn's tool calls: consecutive read-only calls concurrently, edits and view changes in order */
async function runTools(sessionId: string, itemId: string, uses: Anthropic.Beta.BetaToolUseBlock[], signal: AbortSignal) {
  const results: Anthropic.Beta.BetaToolResultBlockParam[] = new Array(uses.length);
  let i = 0;
  while (i < uses.length) {
    if (effectOf(uses[i].name, uses[i].input as Record<string, unknown>) === "read") {
      let j = i;
      while (j < uses.length && effectOf(uses[j].name, uses[j].input as Record<string, unknown>) === "read") j++;
      const batch = await Promise.all(uses.slice(i, j).map((u) => runTool(sessionId, itemId, u, signal)));
      batch.forEach((b, k) => (results[i + k] = b));
      i = j;
    } else {
      results[i] = await runTool(sessionId, itemId, uses[i], signal);
      i++;
    }
  }
  return results;
}

function transcriptOf(items: ChatItem[]): string {
  const out: string[] = [];
  for (const it of items.slice(-12)) {
    if (it.kind === "user") out.push(`user: ${it.text.slice(0, 300)}`);
    else if (it.kind === "assistant") {
      const t = it.segments.filter((s): s is Extract<Segment, { type: "text" }> => s.type === "text").map((s) => s.text).join(" ").trim();
      const tools = it.segments.filter((s) => s.type === "tool").map((s) => (s as Extract<Segment, { type: "tool" }>).call.name);
      if (t || tools.length) out.push(`assistant: ${tools.length ? `[tools: ${tools.join(", ")}] ` : ""}${t.slice(0, 400)}`);
    }
  }
  return out.join("\n");
}

export async function send(id: string, text: string, opts: { mode?: AgentMode; zone?: Zone | null } = {}): Promise<void> {
  ensureCity();
  const s = getS(id);
  if (!s || !text.trim() || s.status === "running" || s.status === "needs_input") return;
  const mode = opts.mode ?? s.mode;
  const zone = opts.zone !== undefined ? opts.zone : s.zone;
  const r = rtOf(id);
  const R = rtMaybe();
  const refs = useApp.getState().selection.slice(0, 6);
  const route = routeRequest(text, { mode, hasSelection: refs.length > 0 });
  const t0 = Date.now();
  patch(id, (x) => ({
    mode,
    zone,
    status: "running",
    error: undefined,
    title: x.items.some((it) => it.kind === "user") || x.title !== "New agent" ? x.title : text.trim().replace(/\s+/g, " ").slice(0, 60),
    items: [...x.items, { kind: "user", id: nid("u"), text, refs, mode, zone, at: t0 }],
    lastRun: { tier: route.tier, reason: route.reason, startedAt: t0, tools: 0 },
  }));
  touch(id);
  r.run = { scenario: R?.scenarios.activeId ?? "baseline", startedAt: t0, zone, mode, request: text };
  r.seen = new Set(R?.scenarios.appliedChangesets().map((c) => c.id) ?? []);
  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: contextBlock(id, mode, zone) }];
  if (r.restored) {
    blocks.push({ type: "text", text: `[runtime] Earlier conversation in this session (history not restored after a reload):\n${r.restored}` });
    r.restored = undefined;
  }
  blocks.push({ type: "text", text });
  r.messages.push({ role: "user", content: blocks });
  r.abort = new AbortController();
  const signal = r.abort.signal;
  let tools = 0;
  let firstMs: number | undefined;
  let model: string | undefined;
  let cost = 0;
  try {
    const maxSteps = MAX_STEPS[route.tier];
    for (let step = 0; step < maxSteps; step++) {
      if (step === maxSteps - 1) {
        // last allowed turn: ask for a wrap-up instead of more tool calls (keeps the loop bounded)
        const last = r.messages[r.messages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) (last.content as Anthropic.Beta.BetaContentBlockParam[]).push({ type: "text", text: "[runtime] Step limit reached for this request: do not call more tools; summarise what was done and what remains." });
      }
      const itemId = nid("a");
      const ts = Date.now();
      pushItem(id, { kind: "assistant", id: itemId, segments: [], done: false, startedAt: ts });
      const turn = await streamTurn(id, itemId, route.tier, signal, () => (firstMs ??= Date.now() - t0));
      model = turn.model ?? model;
      cost += turn.usd ?? 0;
      const msg = turn.msg;
      if (!msg) throw new Error("The model stream ended without a message");
      r.messages.push({ role: "assistant", content: msg.content } as unknown as MsgParam);
      const uses = (msg.content as ContentBlock[]).filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      for (const u of uses) setCall(id, itemId, u.id, { input: u.input as Record<string, unknown> });
      const finish = () => patchItem(id, itemId, (it) => (it.kind === "assistant" ? { ...it, done: true, ms: Date.now() - ts } : it));
      if (msg.stop_reason === "refusal") {
        finish();
        pushItem(id, { kind: "notice", id: nid("n"), tone: "error", text: "The model declined this request." });
        break;
      }
      if (msg.stop_reason === "max_tokens" && uses.length) throw new Error("A tool call was cut off by the output limit; please retry with a narrower request.");
      if (msg.stop_reason === "pause_turn") {
        finish();
        continue;
      }
      if (msg.stop_reason !== "tool_use" || !uses.length) {
        finish();
        break;
      }
      tools += uses.length;
      const results = await runTools(id, itemId, uses, signal);
      const content: (Anthropic.Beta.BetaToolResultBlockParam | Anthropic.Beta.BetaTextBlockParam)[] = results;
      const note = foreignNote(id, r);
      if (note) content.push({ type: "text", text: note });
      r.messages.push({ role: "user", content });
      finish();
      if (signal.aborted) break;
    }
    patch(id, (x) => ({
      status: "idle",
      items: signal.aborted ? [...x.items, { kind: "notice", id: nid("n"), tone: "info", text: "Stopped." }] : x.items,
      lastRun: { ...x.lastRun!, model, ms: Date.now() - t0, firstTokenMs: firstMs, tools, costUsd: cost },
    }));
  } catch (e) {
    const err = e as Error;
    const aborted = signal.aborted || err.name === "AbortError";
    // keep the history valid: a dangling assistant tool_use without results must be answered
    const last = r.messages[r.messages.length - 1];
    if (last?.role === "assistant" && Array.isArray(last.content)) {
      const pend = (last.content as { type: string; id?: string }[]).filter((b) => b.type === "tool_use");
      if (pend.length) r.messages.push({ role: "user", content: pend.map((b) => ({ type: "tool_result" as const, tool_use_id: b.id!, content: "Cancelled", is_error: true })) });
    }
    patch(id, (x) => ({
      status: aborted ? "idle" : "error",
      error: aborted ? undefined : err.message,
      items: [...x.items.map((it) => (it.kind === "assistant" && !it.done ? { ...it, done: true } : it)), { kind: "notice", id: nid("n"), tone: aborted ? "info" : "error", text: aborted ? "Stopped." : err.message }],
      lastRun: x.lastRun ? { ...x.lastRun, model, ms: Date.now() - t0, firstTokenMs: firstMs, tools, costUsd: cost } : undefined,
    }));
  } finally {
    r.abort = null;
    r.run = undefined;
    // pending approvals of a finished run can no longer be answered
    for (const [aid] of r.approvals) patchItem(id, aid, (it) => (it.kind === "approval" && it.state === "pending" ? { ...it, state: "declined" } : it));
    r.approvals.clear();
  }
}

// ---------------------------------------------------------------- persistence (per city)

let city: string | null = null;
const MAX_SESSIONS = 12;
const MAX_ITEMS = 150;
const MAX_BYTES = 2_500_000;

function save() {
  if (!city || typeof localStorage === "undefined") return;
  const st = useAgents.getState();
  const order = st.order.slice(0, MAX_SESSIONS);
  const sessions = order.map((id) => st.sessions[id]).filter(Boolean).map((s) => ({ ...s, items: s.items.slice(-MAX_ITEMS) }));
  const messages: Record<string, MsgParam[]> = {};
  for (const id of order) messages[id] = runtimes.get(id)?.messages ?? [];
  try {
    let json = JSON.stringify({ v: 1, sessions, order, viewing: st.viewing, messages });
    if (json.length > MAX_BYTES) json = JSON.stringify({ v: 1, sessions, order, viewing: st.viewing });
    localStorage.setItem(KEY(city), json);
  } catch {
    // quota or private mode: persistence is best-effort
  }
}

function load(c: string) {
  let data: { sessions: AgentSession[]; order: string[]; viewing: string | null; messages?: Record<string, MsgParam[]> } | null = null;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY(c)) : null;
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!data?.sessions?.length) {
    // nothing saved for this city: keep pristine sessions (the startup default), else start fresh
    const st = useAgents.getState();
    const pristine = Object.values(st.sessions).every((s) => !s.items.length && s.status === "idle");
    if (pristine && st.order.length) return;
    runtimes.clear();
    const s = blankSession();
    useAgents.setState({ sessions: { [s.id]: s }, order: [s.id], viewing: s.id });
    return;
  }
  runtimes.clear();
  const sessions: Record<string, AgentSession> = {};
  for (const s0 of data.sessions) {
    const interrupted = s0.status === "running" || s0.status === "needs_input";
    const items = s0.items.map((it) => (it.kind === "approval" && it.state === "pending" ? { ...it, state: "declined" as const } : it.kind === "assistant" && !it.done ? { ...it, done: true } : it));
    if (interrupted) items.push({ kind: "notice", id: nid("n"), tone: "info", text: "Stopped by a page reload." });
    sessions[s0.id] = { ...s0, items, status: interrupted || s0.status === "error" ? "idle" : s0.status };
    const r = rtOf(s0.id);
    const msgs = data.messages?.[s0.id];
    // a valid history ends with an assistant turn (or is empty); otherwise fall back to a transcript
    if (msgs?.length && msgs[msgs.length - 1].role === "assistant") r.messages = msgs;
    else if (items.some((it) => it.kind === "user")) r.restored = transcriptOf(items);
  }
  const order = data.order.filter((id) => sessions[id]);
  useAgents.setState({ sessions, order, viewing: data.viewing && sessions[data.viewing] ? data.viewing : (order[0] ?? null) });
}

/**
 * Persistence key: the open project when the projects sidebar provides one (set via
 * setProjectKeyProvider), else the loaded city. Keys for cities keep their old form, so sessions saved
 * before projects existed are still found.
 */
const storeProject = () => ((useApp.getState() as { projectId?: string | null }).projectId ?? null) || null;
let projectKey: () => string | null = storeProject;
export function setProjectKeyProvider(fn: (() => string | null) | null) {
  projectKey = fn ?? storeProject;
  ensureCity();
}
function currentKey(): string | null {
  const p = projectKey();
  if (p) return `project:${p}`;
  return rtMaybe()?.cityId ?? null;
}

/** follow the open project / loaded city: save the old one's sessions, load the new one's */
export function ensureCity() {
  const c = currentKey();
  if (!c || c === city) return;
  if (city) {
    stopAll();
    save();
  }
  city = c;
  load(c);
}

if (typeof window !== "undefined") {
  let timer: ReturnType<typeof setTimeout> | null = null;
  useAgents.subscribe(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      save();
    }, 800);
  });
  setInterval(ensureCity, 1000);
  window.addEventListener("beforeunload", save);
}

/** a session's model message history (read-only view, for debugging and tests) */
export function historyOf(id: string): readonly MsgParam[] {
  return runtimes.get(id)?.messages ?? [];
}

/** the AgentsApi object (plus extras) — what the pane and the window hook use */
export const agentsApi: AgentsApi & {
  clearSession: typeof clearSession;
  stopAll: typeof stopAll;
  checkAgent: typeof checkAgent;
  zoneFromText: typeof zoneFromText;
  zoneFromSelection: typeof zoneFromSelection;
  zoneFromPolygon: typeof zoneFromPolygon;
} = { createSession, deleteSession, renameSession, view, setMode, setZone, send, stop, resolveApproval, clearSession, stopAll, checkAgent, zoneFromText, zoneFromSelection, zoneFromPolygon };
