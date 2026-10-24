"use client";

// The pane's door into the agent runtime (src/agent/sessions.ts): selectors over its store and its
// AgentsApi functions.

import { useMemo } from "react";
import type { AgentSession, AgentsApi } from "@/agent/types";
import * as runtime from "@/agent/sessions";

export const { useAgents } = runtime;

export function useSessions(): AgentSession[] {
  const sessions = useAgents((s) => s.sessions);
  return useMemo(() => Object.values(sessions), [sessions]);
}

export function useSession(id: string | null): AgentSession | null {
  return useAgents((s) => (id ? (s.sessions[id] ?? null) : null));
}

export const useViewing = () => useAgents((s) => s.viewing);
export const useConfigured = () => useAgents((s) => s.configured);
export const getSessions = (): AgentSession[] => Object.values(useAgents.getState().sessions);
export const checkAgent = () => runtime.checkAgent();

export const agents: AgentsApi = {
  createSession: (o) => runtime.createSession(o),
  deleteSession: (id) => runtime.deleteSession(id),
  renameSession: (id, t) => runtime.renameSession(id, t),
  view: (id) => runtime.view(id),
  setMode: (id, m) => runtime.setMode(id, m),
  setZone: (id, z) => runtime.setZone(id, z),
  send: (id, t, o) => runtime.send(id, t, o),
  stop: (id) => runtime.stop(id),
  resolveApproval: (s, a, ok) => runtime.resolveApproval(s, a, ok),
};
