"use client";

// Browser-hosted agent loop: streams model turns through /api/agent, executes
// tool calls against the live world model, and keeps an append-only message
// history (thinking blocks passed back unchanged).

import type Anthropic from "@anthropic-ai/sdk";
import { create } from "zustand";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import { entityName } from "./resolve";
import { executeTool, type ToolDisplay } from "./tools";
import { viewCenter } from "./resolve";

type MsgParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

export interface ToolCallUI {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  status: "streaming" | "running" | "done" | "error" | "cancelled";
  display?: ToolDisplay;
  startedAt: number;
  ms?: number;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; refs: string[] }
  | { kind: "assistant"; id: string; segments: Segment[]; done: boolean; startedAt: number; ms?: number }
  | { kind: "approval"; id: string; title: string; lines: string[]; state: "pending" | "approved" | "declined" }
  | { kind: "notice"; id: string; tone: "error" | "info"; text: string };

export type Segment = { type: "thinking"; text: string } | { type: "text"; text: string } | { type: "tool"; call: ToolCallUI };

interface AgentState {
  items: ChatItem[];
  running: boolean;
  configured: boolean | null;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh";
  approvals: boolean;
  setEffort: (e: AgentState["effort"]) => void;
  setApprovals: (v: boolean) => void;
}

export const useAgent = create<AgentState>((set) => ({
  items: [],
  running: false,
  configured: null,
  model: "",
  effort: "high",
  approvals: true,
  setEffort: (effort) => set({ effort }),
  setApprovals: (approvals) => set({ approvals }),
}));

let messages: MsgParam[] = [];
let abort: AbortController | null = null;
let seq = 0;
const nid = (p: string) => `${p}${++seq}`;
const approvalResolvers = new Map<string, (ok: boolean) => void>();

export async function checkAgent() {
  try {
    const r = await fetch("/api/agent");
    const j = await r.json();
    useAgent.setState({ configured: !!j.configured, model: j.model ?? "" });
  } catch {
    useAgent.setState({ configured: false });
  }
}

function patchItem(id: string, f: (it: ChatItem) => ChatItem) {
  useAgent.setState((s) => ({ items: s.items.map((it) => (it.id === id ? f(it) : it)) }));
}

function contextLine(): string {
  const R = rt();
  const st = useApp.getState();
  const sel = st.selection.slice(0, 6).map((id) => {
    const e = R.world.get(id);
    return e ? `${id} (${e.kind}: ${entityName(e)})` : id;
  });
  const c = viewCenter();
  return `[session] scenario “${R.scenarios.active.name}” (${R.scenarios.active.cursor} edits) · view centre [${Math.round(c[0])}, ${Math.round(c[1])}] zoom ${(R.map?.getZoom() ?? 0).toFixed(1)} · selection: ${sel.length ? sel.join("; ") : "none"}${st.overlay ? ` · overlay ${st.overlay} at ${st.hour.toFixed(0)}:00` : ""}`;
}

export function resolveApproval(id: string, ok: boolean) {
  approvalResolvers.get(id)?.(ok);
  approvalResolvers.delete(id);
  patchItem(id, (it) => (it.kind === "approval" ? { ...it, state: ok ? "approved" : "declined" } : it));
}

function requestApproval(req: { title: string; lines: string[] }): Promise<boolean> {
  const id = nid("ap");
  useAgent.setState((s) => ({ items: [...s.items, { kind: "approval", id, title: req.title, lines: req.lines, state: "pending" }] }));
  return new Promise((resolve) => approvalResolvers.set(id, resolve));
}

export function newConversation() {
  if (useAgent.getState().running) stop();
  messages = [];
  useAgent.setState({ items: [] });
}

export function stop() {
  abort?.abort();
  for (const [id, r] of approvalResolvers) {
    r(false);
    patchItem(id, (it) => (it.kind === "approval" ? { ...it, state: "declined" } : it));
  }
  approvalResolvers.clear();
}

async function streamTurn(itemId: string, signal: AbortSignal): Promise<Anthropic.Beta.BetaMessage | null> {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, effort: useAgent.getState().effort, city: rt().cityId }),
    signal,
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(j.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let final: Anthropic.Beta.BetaMessage | null = null;
  const append = (type: "thinking" | "text", d: string) =>
    patchItem(itemId, (it) => {
      if (it.kind !== "assistant") return it;
      const segs = it.segments.slice();
      const last = segs[segs.length - 1];
      if (last && last.type === type) segs[segs.length - 1] = { ...last, text: last.text + d };
      else segs.push({ type, text: d });
      return { ...it, segments: segs };
    });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.t === "text") append("text", ev.d);
      else if (ev.t === "thinking") append("thinking", ev.d);
      else if (ev.t === "tool")
        patchItem(itemId, (it) => (it.kind === "assistant" ? { ...it, segments: [...it.segments, { type: "tool", call: { id: ev.id, name: ev.name, status: "streaming", startedAt: Date.now() } }] } : it));
      else if (ev.t === "final") final = ev.message;
      else if (ev.t === "error") throw new Error(ev.message);
    }
  }
  return final;
}

function setCall(itemId: string, callId: string, patch: Partial<ToolCallUI>) {
  patchItem(itemId, (it) => (it.kind === "assistant" ? { ...it, segments: it.segments.map((s) => (s.type === "tool" && s.call.id === callId ? { ...s, call: { ...s.call, ...patch } } : s)) } : it));
}

export async function send(text: string) {
  const st = useAgent.getState();
  if (st.running || !text.trim()) return;
  const refs = useApp.getState().selection.slice(0, 6);
  useAgent.setState((s) => ({ items: [...s.items, { kind: "user", id: nid("u"), text, refs }], running: true }));
  messages.push({ role: "user", content: [{ type: "text", text: `${contextLine()}\n\n${text}` }] });
  abort = new AbortController();
  const signal = abort.signal;
  try {
    for (let step = 0; step < 60; step++) {
      const itemId = nid("a");
      const t0 = Date.now();
      useAgent.setState((s) => ({ items: [...s.items, { kind: "assistant", id: itemId, segments: [], done: false, startedAt: t0 }] }));
      const msg = await streamTurn(itemId, signal);
      if (!msg) throw new Error("The model stream ended without a message");
      messages.push({ role: "assistant", content: msg.content } as unknown as MsgParam);
      // reconcile tool inputs from the final message
      const uses = (msg.content as ContentBlock[]).filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      for (const u of uses) setCall(itemId, u.id, { input: u.input as Record<string, unknown> });
      if (msg.stop_reason === "refusal") {
        useAgent.setState((s) => ({ items: [...s.items, { kind: "notice", id: nid("n"), tone: "error", text: "The model declined this request." }] }));
        patchItem(itemId, (it) => (it.kind === "assistant" ? { ...it, done: true, ms: Date.now() - t0 } : it));
        break;
      }
      if (msg.stop_reason === "max_tokens" && uses.length) throw new Error("A tool call was cut off by the output limit; please retry with a narrower request.");
      if (msg.stop_reason === "pause_turn") {
        // long server-side turn paused: send the conversation back as-is to resume
        patchItem(itemId, (it) => (it.kind === "assistant" ? { ...it, done: true, ms: Date.now() - t0 } : it));
        continue;
      }
      if (msg.stop_reason !== "tool_use" || !uses.length) {
        patchItem(itemId, (it) => (it.kind === "assistant" ? { ...it, done: true, ms: Date.now() - t0 } : it));
        break;
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        if (signal.aborted) {
          setCall(itemId, u.id, { status: "cancelled" });
          results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify({ cancelled: "Stopped by the user before this tool ran." }), is_error: true });
          continue;
        }
        const ts = Date.now();
        setCall(itemId, u.id, { status: "running", startedAt: ts });
        const input = (u.input ?? {}) as Record<string, unknown>;
        const out = await executeTool(u.name, input, { requestApproval, approvals: useAgent.getState().approvals, signal });
        setCall(itemId, u.id, { status: out.isError ? "error" : "done", display: out.display, ms: Date.now() - ts });
        let content = JSON.stringify(out.content);
        if (content.length > 16000) content = content.slice(0, 16000) + '…"(truncated)"';
        results.push({ type: "tool_result", tool_use_id: u.id, content, is_error: out.isError || undefined });
      }
      messages.push({ role: "user", content: results });
      patchItem(itemId, (it) => (it.kind === "assistant" ? { ...it, done: true, ms: Date.now() - t0 } : it));
      if (signal.aborted) break;
    }
  } catch (e) {
    const err = e as Error;
    const aborted = signal.aborted || err.name === "AbortError";
    // keep history valid: a dangling assistant tool_use without results must be answered
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && Array.isArray(last.content)) {
      const pend = (last.content as { type: string; id?: string }[]).filter((b) => b.type === "tool_use");
      if (pend.length) messages.push({ role: "user", content: pend.map((b) => ({ type: "tool_result" as const, tool_use_id: b.id!, content: "Cancelled", is_error: true })) });
    }
    useAgent.setState((s) => ({ items: [...s.items.map((it) => (it.kind === "assistant" && !it.done ? { ...it, done: true } : it)), { kind: "notice", id: nid("n"), tone: aborted ? "info" : "error", text: aborted ? "Stopped." : err.message }] }));
  } finally {
    useAgent.setState({ running: false });
    abort = null;
  }
}
