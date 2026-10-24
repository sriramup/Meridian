"use client";

import type { OpResult } from "@/world/ops/core";
import { rt } from "./runtime";
import { useApp } from "./store";

export interface LastReport {
  label: string;
  summary: string[];
  warnings: string[];
  conflicts: string[];
  at: number;
}

let last: LastReport | null = null;
const listeners = new Set<() => void>();
export const getLastReport = () => last;
export const onReport = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** commit a user-driven operation result to the active scenario */
export function applyOp(res: OpResult): boolean {
  const st = useApp.getState();
  if (!res.ok || !res.changeset) {
    st.notify(res.error ?? "Operation failed", "error");
    return false;
  }
  rt().scenarios.commit(res.changeset);
  st.bumpWorld();
  st.bumpScenarios();
  last = {
    label: res.changeset.label,
    summary: res.report.summary,
    warnings: res.report.warnings,
    conflicts: res.report.conflicts.filter((c) => !c.resolved).map((c) => c.message),
    at: Date.now(),
  };
  for (const l of listeners) l();
  return true;
}

/** show the change report for an edit committed outside applyOp (e.g. through the agent's tool executor) */
export function notifyReport(content: { summary?: string[]; warnings?: string[] }, label: string) {
  last = { label, summary: content.summary ?? [], warnings: content.warnings ?? [], conflicts: [], at: Date.now() };
  for (const l of listeners) l();
}
