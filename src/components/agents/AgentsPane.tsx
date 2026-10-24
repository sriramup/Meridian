"use client";

import { useEffect, useRef } from "react";
import { useApp } from "@/state/store";
import { focusComposerNext, type ComposerHandle } from "./Composer";
import { DeleteAgentDialog, SessionList } from "./SessionList";
import { SessionView } from "./SessionView";
import { agents, checkAgent, getSessions, useAgents, useSession, useSessions, useViewing } from "./store";

/** open a fresh agent: reuse an untouched one rather than piling up empty agents */
export function newAgent(): string {
  const blank = getSessions().find((s) => s.status === "idle" && s.items.length === 0);
  if (blank) {
    agents.view(blank.id);
    return blank.id;
  }
  return agents.createSession();
}

/**
 * The agents side pane: the list of every agent (search, grouped by state) and, one level in, a
 * single agent's conversation. Agents keep running while you move between them or close the pane.
 */
export function AgentsPane({ onClose }: { onClose: () => void }) {
  const sessions = useSessions();
  const viewing = useViewing();
  const session = useSession(viewing);
  const composer = useRef<ComposerHandle>(null);

  useEffect(() => {
    checkAgent();
  }, []);

  /** show a fresh agent with its composer focused (and holding `text`) */
  const open = (text = "") => {
    const current = useAgents.getState().viewing;
    const id = newAgent();
    if (id === current && composer.current) {
      if (text) composer.current.setText(text);
      else composer.current.focus();
    }
    else focusComposerNext(text);
  };

  // text handed over from the search ("Ask the agent …") goes into a fresh agent's composer
  const draft = useApp((s) => s.agentDraft);
  useEffect(() => {
    const d = useApp.getState().takeAgentDraft();
    if (d === null) return;
    if (d) open(d);
    else requestAnimationFrame(() => composer.current?.focus());
  }, [draft]);

  return (
    <aside aria-label="Agents" className="agent-sheet flex h-full w-full flex-col border-l border-line-2">
      {session ? <SessionView ref={composer} session={session} onBack={() => agents.view(null)} onClose={onClose} /> : <SessionList sessions={sessions} onNew={() => open()} onClose={onClose} />}
      <DeleteAgentDialog sessions={sessions} />
    </aside>
  );
}
