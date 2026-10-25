"use client";

import { useEffect, useRef } from "react";
import { useApp } from "@/state/store";
import { focusComposerNext, hasDraft, type ComposerHandle } from "./Composer";
import { DeleteAgentDialog, SessionList } from "./SessionList";
import { SessionView } from "./SessionView";
import { agents, checkAgent, getSessions, useAgents, useSession, useSessions, useViewing } from "./store";

/** the mounted pane's composer, so a new agent asked for from anywhere can take the focus */
let liveComposer: ComposerHandle | null = null;

/** a fresh agent: reuse an untouched one (no messages, nothing typed) rather than piling up empty agents */
export function newAgent(): string {
  const blank = getSessions().find((s) => s.status === "idle" && s.items.length === 0 && !hasDraft(s.id));
  if (blank) {
    agents.view(blank.id);
    return blank.id;
  }
  return agents.createSession();
}

/**
 * Open the pane on a fresh agent with its composer focused (holding `text`), from anywhere: the
 * pane's New buttons, the C key, the search's "Ask the agent". When the fresh agent is already on
 * screen the composer rings briefly, so it is plain that it happened.
 */
export function openNewAgent(text = "") {
  const app = useApp.getState();
  const before = useAgents.getState().viewing;
  const id = newAgent();
  if (app.agentOpen && id === before && liveComposer) {
    if (text) liveComposer.setText(text);
    liveComposer.flash();
  } else focusComposerNext(text);
  if (!app.agentOpen) app.setAgentOpen(true);
}

/** C (outside text fields, as in "compose"): a new agent */
export function useAgentShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest("input,textarea,select,[contenteditable],[role=menu],[role=dialog]")) return;
      e.preventDefault();
      openNewAgent();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * The agents side pane: the list of every agent and, one level in, a single agent's conversation.
 * Agents keep running while you move between them or close the pane.
 */
export function AgentsPane({ onClose }: { onClose: () => void }) {
  const sessions = useSessions();
  const viewing = useViewing();
  const session = useSession(viewing);
  const composer = useRef<ComposerHandle>(null);

  useEffect(() => {
    checkAgent();
    // opening the pane on an agent puts the cursor in its composer
    const raf = requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) composer.current?.focus();
    });
    liveComposer = {
      focus: () => composer.current?.focus(),
      setText: (t) => composer.current?.setText(t),
      flash: () => composer.current?.flash(),
    };
    return () => {
      cancelAnimationFrame(raf);
      liveComposer = null;
    };
  }, []);

  // text handed over from the search ("Ask the agent …") goes into a fresh agent's composer
  const draft = useApp((s) => s.agentDraft);
  useEffect(() => {
    const d = useApp.getState().takeAgentDraft();
    if (d === null) return;
    if (d) openNewAgent(d);
    else requestAnimationFrame(() => composer.current?.focus());
  }, [draft]);

  return (
    <aside aria-label="Agents" className="agent-sheet flex h-full w-full flex-col border-l border-line-2">
      {session ? (
        <SessionView key={session.id} ref={composer} session={session} onBack={() => agents.view(null)} onNew={() => openNewAgent()} onClose={onClose} />
      ) : (
        <SessionList sessions={sessions} onNew={() => openNewAgent()} onClose={onClose} />
      )}
      <DeleteAgentDialog sessions={sessions} />
    </aside>
  );
}
