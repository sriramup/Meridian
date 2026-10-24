import { describe, expect, it } from "vitest";
import type { AgentSession } from "@/agent/types";
import { drawnZoneLabel, editCount, formatArea, groupSessions, matchExcerpt, matchesQuery, relTime, sessionColor, statusText, titleFromText, ZONE_COLORS } from "@/components/agents/model";

const sess = (p: Partial<AgentSession> & { id: string }): AgentSession => ({ title: "Untitled", createdAt: 0, updatedAt: 0, status: "idle", items: [], mode: "edit", zone: null, changesets: [], ...p });

describe("agents pane model", () => {
  const a = sess({ id: "a", title: "Roundabout at Congress & 6th", updatedAt: 10, items: [{ kind: "user", id: "u1", text: "Turn the junction into a roundabout", refs: [], mode: "edit", zone: null, at: 1 }] });
  const b = sess({
    id: "b",
    title: "Tree corridor",
    status: "running",
    updatedAt: 5,
    items: [{ kind: "assistant", id: "x", done: false, startedAt: 0, segments: [{ type: "text", text: "Planting street trees along Lavaca Street for shade" }] }],
  });
  const c = sess({ id: "c", title: "Tower site", status: "needs_input", updatedAt: 1, zone: { id: "z", label: "Republic Square block", poly: [], source: "text" } });
  const d = sess({ id: "d", title: "Older", updatedAt: 20, status: "error" });

  it("searches title, zone and message content, accent and case insensitive, all terms", () => {
    expect(matchesQuery(a, "ROUNDABOUT")).toBe(true);
    expect(matchesQuery(b, "lavaca shade")).toBe(true);
    expect(matchesQuery(b, "lavaca congress")).toBe(false);
    expect(matchesQuery(c, "republic")).toBe(true);
    expect(matchesQuery(sess({ id: "e", title: "Café plaza" }), "cafe")).toBe(true);
    expect(matchesQuery(a, "  ")).toBe(true);
  });

  it("excerpts a message match but not a title match", () => {
    expect(matchExcerpt(b, "lavaca")).toContain("Lavaca Street");
    expect(matchExcerpt(a, "roundabout")).toBeNull();
  });

  it("groups needs-input, running, recent with newest first", () => {
    const g = groupSessions([a, b, c, d]);
    expect(g.map((x) => x.id)).toEqual(["attention", "running", "recent"]);
    expect(g[2].sessions.map((s) => s.id)).toEqual(["d", "a"]);
    expect(groupSessions([a, b, c, d], "tree").map((x) => x.id)).toEqual(["running"]);
  });

  it("status text distinguishes a fresh session from a finished one", () => {
    expect(statusText(sess({ id: "n" }))).toBe("New");
    expect(statusText(a)).toBe("Done");
    expect(statusText(d)).toBe("Failed");
  });

  it("relative times", () => {
    const now = 1_000_000_000;
    expect(relTime(now - 10_000, now)).toBe("now");
    expect(relTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relTime(now - 3 * 3600_000, now)).toBe("3h");
    expect(relTime(now - 2 * 86400_000, now)).toBe("2d");
  });

  it("zone labels in hectares", () => {
    expect(formatArea(32_000)).toBe("3.2 ha");
    expect(formatArea(4_200)).toBe("0.42 ha");
    expect(formatArea(480_000)).toBe("48 ha");
    expect(formatArea(2_500_000)).toBe("2.50 km²");
    expect(drawnZoneLabel([[[0, 0], [200, 0], [200, 160], [0, 160]]])).toBe("Drawn area · 3.2 ha");
  });

  it("edit count from changesets or committed edit calls", () => {
    expect(editCount(sess({ id: "e", changesets: ["1", "2"] }))).toBe(2);
    const call = (cs?: string) => ({ type: "tool" as const, call: { id: "t", name: "create_building", status: "done" as const, startedAt: 0, display: { title: "x", status: "ok" as const, changesetId: cs } } });
    expect(editCount(sess({ id: "f", items: [{ kind: "assistant", id: "x", done: true, startedAt: 0, segments: [call("c1"), call(), call("c2")] }] }))).toBe(2);
  });

  it("titles from the first message", () => {
    expect(titleFromText("Plant trees on Lavaca. Then test heat.")).toBe("Plant trees on Lavaca");
    const t = titleFromText("Redesign the Rainey Street district for 3,000 more residents and improve transit");
    expect(t.length).toBeLessThanOrEqual(49);
    expect(t.endsWith("…")).toBe(true);
  });

  it("a stable colour per session", () => {
    expect(sessionColor("abc")).toEqual(sessionColor("abc"));
    expect(ZONE_COLORS).toContainEqual(sessionColor("xyz"));
  });
});
