import { describe, expect, it } from "vitest";
import type { ChatItem, ToolCallView } from "@/agent/types";
import { buildTranscript, formatDuration, liveLabel, runSummary, type Run } from "@/components/agents/model";

const user = (id: string, at: number): ChatItem => ({ kind: "user", id, text: "Lay out a grid", refs: [], mode: "edit", zone: null, at });
const call = (id: string, p: Partial<ToolCallView> = {}): ToolCallView => ({ id, name: "create_street", status: "done", startedAt: 1000, ms: 500, ...p });
const asst = (id: string, startedAt: number, ms: number | undefined, segments: Extract<ChatItem, { kind: "assistant" }>["segments"], done = true): ChatItem => ({ kind: "assistant", id, startedAt, ms, done, segments });
const VERBS = { create_street: "Laying out street" };
const run = (e: ReturnType<typeof buildTranscript>[number]): Run => {
  if (e.kind !== "run") throw new Error("not a run");
  return e.run;
};

describe("agent transcript runs", () => {
  const items: ChatItem[] = [
    user("u1", 1000),
    asst("a1", 1000, 1400, [{ type: "thinking", text: "Four streets\naround the centre" }, { type: "text", text: "Laying out a grid." }, { type: "tool", call: call("c1") }]),
    asst("a2", 2400, 1300, [{ type: "tool", call: call("c2", { status: "blocked" }) }]),
    asst("a3", 3700, 600, [{ type: "text", text: "Done: 2 streets." }]),
  ];

  it("folds reasoning, remarks and tool calls into steps and keeps the trailing text as the answer", () => {
    const t = buildTranscript(items, false);
    expect(t.map((e) => e.kind)).toEqual(["user", "run"]);
    const r = run(t[1]);
    expect(r.steps.map((s) => s.kind)).toEqual(["thinking", "note", "tool", "tool"]);
    expect(r.answer).toBe("Done: 2 streets.");
    expect(r.tools).toBe(2);
    expect(r.issues).toBe(1);
    expect(r.end! - r.start).toBe(3300);
    expect(runSummary(r)).toBe("Worked for 3s · 2 steps");
  });

  it("a plain reply has no steps and no summary", () => {
    const r = run(buildTranscript([user("u", 0), asst("a", 0, 200, [{ type: "text", text: "Twelve buildings." }])], false)[1]);
    expect(r.steps).toEqual([]);
    expect(r.answer).toBe("Twelve buildings.");
    expect(runSummary(r)).toBeNull();
  });

  it("reasoning alone reads as thought", () => {
    const r = run(buildTranscript([user("u", 0), asst("a", 0, 4200, [{ type: "thinking", text: "hm" }, { type: "text", text: "Yes." }])], false)[1]);
    expect(runSummary(r)).toBe("Thought for 4s");
  });

  it("a live run names what it is doing", () => {
    const live = [user("u1", 1000), asst("a1", 1000, undefined, [{ type: "text", text: "Laying out a grid." }, { type: "tool", call: call("c1", { status: "running", ms: undefined }) }], false)];
    const r = run(buildTranscript(live, true)[1]);
    expect(r.live).toBe(true);
    expect(r.end).toBeUndefined();
    expect(liveLabel(r, VERBS)).toBe("Laying out street");
    expect(r.answer).toBe("");
    // before the first token, a running session still shows a live run
    const empty = buildTranscript([user("u1", 5)], true);
    expect(empty.map((e) => e.kind)).toEqual(["user", "run"]);
    expect(liveLabel(run(empty[1]), VERBS)).toBe("Thinking");
    expect(buildTranscript([user("u1", 5)], false)).toHaveLength(1);
  });

  it("an approval waits; earlier runs are never live", () => {
    const its: ChatItem[] = [...items, user("u2", 9000), asst("b1", 9000, 300, [{ type: "tool", call: call("d1", { name: "remove_features" }) }]), { kind: "approval", id: "ap", title: "Remove 40 buildings?", lines: [], state: "pending" }];
    const t = buildTranscript(its, true);
    expect(run(t[1]).live).toBe(false);
    const r = run(t[3]);
    expect(r.approvals).toHaveLength(1);
    expect(liveLabel(r, VERBS)).toBe("Waiting for approval");
  });

  it("formats durations compactly", () => {
    expect(formatDuration(200)).toBe("1s");
    expect(formatDuration(18_400)).toBe("18s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
  });
});
