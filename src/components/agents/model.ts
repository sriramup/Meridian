// Pure helpers for the agents pane: searching and grouping sessions, relative times, zone labels
// and the fixed colour each session's zone is drawn in. No React, no runtime imports (tested in
// tests/agents-pane.test.ts).

import type { AgentSession, ChatItem, SessionStatus } from "@/agent/types";
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

/** a hectare figure for a zone label: 0.42 ha, 3.2 ha, 48 ha, then km² */
export function formatArea(m2: number): string {
  const ha = m2 / 10_000;
  if (ha >= 100) return `${(ha / 100).toFixed(ha >= 1000 ? 1 : 2)} km²`;
  if (ha >= 10) return `${Math.round(ha)} ha`;
  if (ha >= 1) return `${ha.toFixed(1)} ha`;
  return `${ha.toFixed(2)} ha`;
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
  [92, 84, 60], // umber grey
];

export function sessionColor(id: string): [number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ZONE_COLORS[(h >>> 0) % ZONE_COLORS.length];
}

export const rgb = (c: [number, number, number], a = 1) => `rgb(${c[0]} ${c[1]} ${c[2]} / ${a})`;
