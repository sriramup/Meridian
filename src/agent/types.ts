// Shared contract for the multi-agent runtime (src/agent/*) and the agents side pane
// (src/components/agents/*). Several agent sessions can run at once; each has its own
// conversation, mode (plan / edit) and optional zone it may edit in. All sessions act on the
// same live world, so every edit appears on the map as it happens.

import type { Polygon } from "@/world/types";
import type { SketchAttachment } from "@/sketch/store";

/** plan: investigate and propose, never commit an edit (dry runs allowed). edit: may change the world. */
export type AgentMode = "plan" | "edit";

/**
 * Where a session may make edits. Reads (search, inspect, models) are never restricted; edits whose
 * geometry falls outside the zone are refused by the executor and reported back to the model.
 */
export interface Zone {
  id: string;
  /** what the user sees, e.g. "Drawn area · 3.4 acres" or "24th St & West Ave block" */
  label: string;
  /** local metres, outer ring counter-clockwise */
  poly: Polygon;
  /** how it was made: drawn on the map, resolved from words (street bounds, a place), or the selection */
  source: "drawn" | "text" | "place" | "selection";
  /** the words it was resolved from (source "text" / "place") */
  query?: string;
}

/** status shown in the session list; "needs_input" = waiting on an approval from the user */
export type SessionStatus = "idle" | "running" | "needs_input" | "error";

export interface ToolCallView {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  status: "streaming" | "running" | "done" | "error" | "cancelled" | "blocked";
  /** tool display card (title, lines, metrics) from the executor */
  display?: { title: string; detail?: string; status: "ok" | "error" | "warn"; lines?: string[]; changesetId?: string; metrics?: { label: string; value: string; delta?: string; tone?: "good" | "bad" | "neutral" }[]; simId?: string; serp?: import("@/serp/types").SerpCard };
  startedAt: number;
  ms?: number;
}

/** an attached sketch / photo as the transcript keeps it: a small thumbnail, never the image itself */
export interface SketchRef {
  id: string;
  name: string;
  /** small JPEG data URL */
  thumb: string;
  width: number;
  height: number;
}

export type Segment = { type: "thinking"; text: string } | { type: "text"; text: string } | { type: "tool"; call: ToolCallView };

export type ChatItem =
  | { kind: "user"; id: string; text: string; refs: string[]; mode: AgentMode; zone: Zone | null; at: number; sketch?: SketchRef }
  | { kind: "assistant"; id: string; segments: Segment[]; done: boolean; startedAt: number; ms?: number }
  | { kind: "approval"; id: string; title: string; lines: string[]; state: "pending" | "approved" | "declined" }
  | { kind: "notice"; id: string; tone: "error" | "info"; text: string };

export interface AgentSession {
  id: string;
  /** short task title (from the first message, renameable) */
  title: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  items: ChatItem[];
  /** default mode for the next run (the composer starts from it) */
  mode: AgentMode;
  /** default zone for the next run; null = anywhere. Set once, it carries to later runs until changed. */
  zone: Zone | null;
  /** changesets this session committed (ids), for per-session undo and the session summary */
  changesets: string[];
  /** scenario the session's edits went into */
  scenarioId?: string;
  /** last error message, when status is "error" */
  error?: string;
  /** how the latest run was routed and how long it took (set when it starts, completed when it ends) */
  lastRun?: RunStats;
}

/** request routing and timing of a run (src/agent/router.ts picks the tier) */
export interface RunStats {
  /** quick: fast model, low effort; standard: main model; deep: main model, high effort */
  tier: "quick" | "standard" | "deep";
  reason?: string;
  /** model that served it (reported by the server) */
  model?: string;
  /** provider of its last model turn: Gemini serves plan mode, Claude everything else */
  provider?: "claude" | "gemini";
  /** set when Gemini was rate-limited and Claude answered, e.g. "Gemini rate limit" */
  fallback?: string;
  startedAt: number;
  /** total run time */
  ms?: number;
  /** time to the first streamed text or tool call */
  firstTokenMs?: number;
  /** tool calls made */
  tools: number;
  /** API cost of the run in USD (server spend ledger, summed over its model turns) */
  costUsd?: number;
}

/**
 * Store API implemented by src/agent/sessions.ts (zustand store `useAgents`) and consumed by the
 * side pane. Kept here so the UI and runtime agree while they are built in parallel.
 */
export interface AgentsApi {
  /** create a session (it becomes the viewed one); returns its id */
  createSession(opts?: { title?: string; mode?: AgentMode; zone?: Zone | null }): string;
  deleteSession(id: string): void;
  renameSession(id: string, title: string): void;
  /** which session the pane shows; null = the list of all sessions */
  view(id: string | null): void;
  setMode(id: string, mode: AgentMode): void;
  setZone(id: string, zone: Zone | null): void;
  /** start a run in the session with this message (mode / zone default to the session's) */
  send(id: string, text: string, opts?: { mode?: AgentMode; zone?: Zone | null; sketch?: SketchAttachment }): Promise<void>;
  stop(id: string): void;
  resolveApproval(sessionId: string, approvalId: string, ok: boolean): void;
}
