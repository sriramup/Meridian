"use client";

// Compatibility layer over the multi-agent runtime (src/agent/sessions.ts) for the single-conversation
// AgentPanel and the `window.__meridianAgent` hook. `useAgent` mirrors the viewed session (items,
// running) and also carries the full runtime: `__meridianAgent.createSession(...)`, `.send(id, text)`,
// `.agents.getState()` (the useAgents store), etc. New UI should use `useAgents` + the sessions API.

import { create } from "zustand";
import type { ChatItem as SessionChatItem, Segment as SessionSegment, ToolCallView } from "./types";
import * as sessions from "./sessions";
import { agentsApi, useAgents } from "./sessions";

export type ToolCallUI = ToolCallView;
export type Segment = SessionSegment;
export type ChatItem = SessionChatItem;

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

/** the session the single-conversation panel talks to: the viewed one, else the most recent */
function currentId(): string {
  const st = useAgents.getState();
  return st.viewing && st.sessions[st.viewing] ? st.viewing : st.order[0];
}

function mirror(): Pick<AgentState, "items" | "running" | "configured" | "model"> {
  const st = useAgents.getState();
  const s = st.sessions[currentId()];
  return { items: s?.items ?? [], running: s?.status === "running" || s?.status === "needs_input", configured: st.configured, model: st.models.standard ?? "" };
}

const store = create<AgentState>((set) => ({
  ...mirror(),
  effort: "high",
  approvals: true,
  setEffort: (effort) => set({ effort }),
  setApprovals: (approvals) => set({ approvals }),
}));
useAgents.subscribe(() => store.setState(mirror()));

/** zustand hook for the old panel, extended with the multi-agent API for automation */
export const useAgent = Object.assign(store, agentsApi, { agents: useAgents, sessions });

if (typeof window !== "undefined") (window as unknown as { __meridianAgent: unknown }).__meridianAgent = useAgent;

export const checkAgent = sessions.checkAgent;
export const send = (text: string) => sessions.send(currentId(), text);
export const stop = () => sessions.stop(currentId());
export const resolveApproval = (approvalId: string, ok: boolean) => sessions.resolveApproval(currentId(), approvalId, ok);
export const newConversation = () => sessions.clearSession(currentId());
