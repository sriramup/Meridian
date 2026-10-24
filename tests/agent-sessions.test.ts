// The multi-agent runtime driven headlessly on the blank canvas with a scripted model transport:
// concurrent sessions, plan-mode refusal, zone refusal, per-session undo, scenario guard.
import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";

type S = typeof import("@/agent/sessions");
let R: ReturnType<typeof loadHeadless>;
let A: S;

/** one scripted model turn: text and/or tool calls; `results` are the tool results since the request */
type Turn = { text?: string; tools?: { name: string; input: Record<string, unknown> }[]; delay?: number };
const scripts = new Map<string, (results: { error: boolean; data: any }[], context: string) => Turn>();
const seen: { tier: string; request: string }[] = [];
let n = 0;

function lastRequest(messages: any[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const texts = m.content.filter((c: any) => c.type === "text").map((c: any) => c.text);
    const req = texts.filter((t: string) => !t.startsWith("<context>") && !t.startsWith("[runtime]")).pop();
    if (req) {
      const results = messages.slice(i + 1).filter((x: any) => x.role === "user").flatMap((x: any) => x.content.filter((c: any) => c.type === "tool_result")).map((c: any) => ({ error: !!c.is_error, data: JSON.parse(c.content) }));
      return { req, results, context: texts.find((t: string) => t.startsWith("<context>")) ?? "" };
    }
  }
  throw new Error("no request");
}

beforeAll(async () => {
  R = loadHeadless("sandbox");
  A = await import("@/agent/sessions");
  A.setTransport(async function* (body) {
    const { req, results, context } = lastRequest(body.messages);
    seen.push({ tier: body.tier, request: req });
    const script = scripts.get(req);
    if (!script) throw new Error(`no script for “${req}”`);
    const turn = script(results, context);
    if (turn.delay) await new Promise((r) => setTimeout(r, turn.delay));
    const content: any[] = [];
    if (turn.text) {
      yield { t: "text", d: turn.text };
      content.push({ type: "text", text: turn.text });
    }
    for (const t of turn.tools ?? []) {
      const id = `toolu_${++n}`;
      yield { t: "tool", id, name: t.name };
      content.push({ type: "tool_use", id, name: t.name, input: t.input });
    }
    yield { t: "final", message: { role: "assistant", content, stop_reason: turn.tools?.length ? "tool_use" : "end_turn" } as any };
  });
}, 180_000);

const sq = (x: number, y: number, h = 15) => [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]];
const st = () => A.useAgents.getState();
const calls = (id: string) => st().sessions[id].items.flatMap((i) => (i.kind === "assistant" ? i.segments.filter((s) => s.type === "tool").map((s) => (s.type === "tool" ? `${s.call.name}:${s.call.status}` : "")) : []));

describe("agent sessions", () => {
  it("starts with one default session", () => {
    expect(st().order.length).toBe(1);
    expect(st().sessions[st().order[0]].mode).toBe("edit");
  });

  it("answers a quick question with no tools, routed to the quick tier, with the context snapshot", async () => {
    const id = st().order[0];
    let ctx = "";
    scripts.set("What is the current scenario?", (_r, c) => ((ctx = c), { text: "Blank site, no edits." }));
    await A.send(id, "What is the current scenario?");
    const s = st().sessions[id];
    expect(s.status).toBe("idle");
    expect(s.lastRun?.tier).toBe("quick");
    expect(s.lastRun?.tools).toBe(0);
    expect(ctx).toMatch(/mode: edit/);
    expect(ctx).toMatch(/zone: none/);
    expect(ctx).toMatch(/scenario: “/);
    expect(s.title).toBe("What is the current scenario?");
  });

  it("runs two sessions concurrently; both edit the live world and tag their changesets", async () => {
    const a = A.createSession({ title: "west" });
    const b = A.createSession({ title: "east" });
    const grid = (x: number) => (r: unknown[]) => (r.length < 3 ? { delay: 30, tools: [{ name: "create_street", input: { path: [[x - 100, -100 + r.length * 100], [x + 100, -100 + r.length * 100]], cls: "residential" } }] } : { text: "done" });
    scripts.set("grid west", grid(-600));
    scripts.set("grid east", grid(600));
    const pa = A.send(a, "grid west");
    const pb = A.send(b, "grid east");
    await new Promise((r) => setTimeout(r, 10));
    expect(st().sessions[a].status).toBe("running");
    expect(st().sessions[b].status).toBe("running");
    await Promise.all([pa, pb]);
    expect(st().sessions[a].changesets.length).toBe(3);
    expect(st().sessions[b].changesets.length).toBe(3);
    const applied = R.scenarios.appliedChangesets();
    expect(applied.filter((c) => c.session === a).length).toBe(3);
    expect(applied.filter((c) => c.session === b).length).toBe(3);
    // they interleaved rather than ran one after the other
    const order = applied.map((c) => c.session);
    expect(order.slice(0, 3).every((x) => x === order[0])).toBe(false);
    expect(st().order[0]).toBe(b);
  });

  it("tells each session about edits other sessions made while it worked (stale previews)", () => {
    const [b, a] = st().order;
    const notes = [a, b].map((id) => JSON.stringify(A.historyOf(id)).match(/While you worked, the world changed outside this session/g)?.length ?? 0);
    expect(notes[0] + notes[1]).toBeGreaterThan(0);
  });

  it("the context snapshot carries current model KPIs once a model has run", async () => {
    const { executeTool } = await import("@/agent/tools");
    const out = await executeTool("run_simulation", { kind: "runoff", params: { storm: "10yr" } }, { requestApproval: async () => true, approvals: false });
    expect(out.isError).toBeFalsy();
    const ctx = A.contextBlock(st().order[0], "edit", null);
    expect(ctx).toMatch(/latest model KPIs: runoff/);
    expect(ctx).toMatch(/current/);
  });

  it("undo reverts only the session's own edit", async () => {
    const [b, a] = st().order;
    const before = R.scenarios.appliedChangesets().map((c) => c.id);
    const lastA = st().sessions[a].changesets.at(-1)!;
    scripts.set("undo my last edit", (r) => (r.length ? { text: "undone" } : { tools: [{ name: "undo", input: { steps: 1 } }] }));
    await A.send(a, "undo my last edit");
    const after = R.scenarios.appliedChangesets().map((c) => c.id);
    expect(after.length).toBe(before.length - 1);
    expect(after).not.toContain(lastA);
    expect(after.filter((id) => st().sessions[b].changesets.includes(id)).length).toBe(3);
    // revert_change on another session's changeset is refused unless the user asked
    const theirs = st().sessions[b].changesets[0];
    scripts.set("revert theirs", (r) => (r.length ? { text: "ok" } : { tools: [{ name: "revert_change", input: { changeset_id: theirs } }] }));
    await A.send(a, "revert theirs");
    expect(calls(a).at(-1)).toBe("revert_change:blocked");
    expect(R.scenarios.appliedChangesets().map((c) => c.id)).toContain(theirs);
  });

  it("plan mode turns edits into previews and refuses edits without one", async () => {
    const p = A.createSession({ mode: "plan" });
    const cur = R.scenarios.active.cursor;
    const nb = R.world.count("building");
    let note = "";
    scripts.set("plan a block", (r) =>
      r.length === 0 ? { tools: [{ name: "create_building", input: { site: sq(0, 500), typology: "block", floors: 6, use: "residential" } }, { name: "undo", input: {} }] } : ((note = JSON.stringify(r)), { text: "proposal" }),
    );
    await A.send(p, "plan a block");
    expect(R.scenarios.active.cursor).toBe(cur);
    expect(R.world.count("building")).toBe(nb);
    expect(calls(p)).toEqual(["create_building:done", "undo:blocked"]);
    expect(note).toMatch(/preview/);
    expect(note).toMatch(/Plan mode/);
    expect(st().sessions[p].lastRun?.tier).not.toBe("quick");
  });

  it("zone: outside edits are refused, the model adapts inside; set_zone from chat persists to the next run", async () => {
    const z = A.createSession();
    A.setZone(z, A.agentsApi.zoneFromPolygon([[-100, 800], [100, 800], [100, 1000], [-100, 1000]], { label: "Test" }));
    scripts.set("build a block", (r) =>
      r.length === 0
        ? { tools: [{ name: "create_building", input: { site: sq(900, -900), typology: "block", floors: 4, use: "residential" } }] }
        : r.length === 1 && r[0].error
          ? { tools: [{ name: "create_building", input: { site: sq(0, 900), typology: "block", floors: 4, use: "residential" } }] }
          : { text: "built inside" },
    );
    await A.send(z, "build a block");
    expect(calls(z)).toEqual(["create_building:blocked", "create_building:done"]);
    expect(st().sessions[z].changesets.length).toBe(1);
    scripts.set("only work within 150 m of [0, -900]", (r) => (r.length ? { text: "ok" } : { tools: [{ name: "set_zone", input: { zone: "within 150 m of [0, -900]" } }] }));
    await A.send(z, "only work within 150 m of [0, -900]");
    expect(st().sessions[z].zone?.label).toMatch(/150 m around/);
    let ctx = "";
    scripts.set("what zone?", (_r, c) => ((ctx = c), { text: "that one" }));
    await A.send(z, "what zone?");
    expect(ctx).toMatch(/150 m around/);
    const user = st().sessions[z].items.filter((i) => i.kind === "user").at(-1);
    expect(user?.kind === "user" && user.zone?.label).toMatch(/150 m around/);
  });

  it("a run whose scenario was switched away refuses further edits instead of switching back", async () => {
    const g = A.createSession();
    const S = R.scenarios;
    const original = S.activeId;
    scripts.set("two blocks", (r) => {
      if (r.length === 0) return { tools: [{ name: "create_building", input: { site: sq(-900, 900), typology: "block", floors: 3, use: "residential" } }] };
      if (r.length === 1) {
        // the user branches and switches while the agent is mid-run
        S.branch("User option", "user");
        return { tools: [{ name: "create_building", input: { site: sq(-900, 700), typology: "block", floors: 3, use: "residential" } }] };
      }
      return { text: "stopped" };
    });
    await A.send(g, "two blocks");
    expect(calls(g)).toEqual(["create_building:done", "create_building:blocked"]);
    expect(S.active.name).toBe("User option");
    S.switchTo(original);
  });

  it("approvals are per session and don't block other sessions' edits while pending", async () => {
    const { executeTool } = await import("@/agent/tools");
    const ids: string[] = [];
    for (let k = 0; k < 26; k++) {
      const out = await executeTool("create_building", { site: sq(-1300 + (k % 13) * 45, -1300 + Math.floor(k / 13) * 45, 12), typology: "block", floors: 2, use: "residential" }, { requestApproval: async () => true, approvals: false });
      ids.push(...((out.content as { created: string[] }).created ?? []));
    }
    expect(ids.length).toBe(26);
    const x = A.createSession();
    const y = A.createSession();
    scripts.set("clear the lots", (r) => (r.length ? { text: "cleared" } : { tools: [{ name: "remove_features", input: { ids } }] }));
    scripts.set("one more block", (r) => (r.length ? { text: "ok" } : { tools: [{ name: "create_building", input: { site: sq(1300, 1300), typology: "block", floors: 3, use: "residential" } }] }));
    const px = A.send(x, "clear the lots");
    for (let k = 0; k < 100 && st().sessions[x].status !== "needs_input"; k++) await new Promise((r) => setTimeout(r, 10));
    expect(st().sessions[x].status).toBe("needs_input");
    await A.send(y, "one more block");
    expect(calls(y)).toEqual(["create_building:done"]);
    const ap = st().sessions[x].items.find((i) => i.kind === "approval")!;
    A.resolveApproval(x, ap.id, true);
    await px;
    expect(calls(x)).toEqual(["remove_features:done"]);
    for (const id of ids) expect(R.world.get(id)).toBeUndefined();
  });

  it("stop aborts a running session; delete keeps at least one session", async () => {
    const s = A.createSession();
    scripts.set("slow", () => ({ delay: 200, tools: [{ name: "get_context", input: {} }] }));
    const p = A.send(s, "slow");
    await new Promise((r) => setTimeout(r, 20));
    A.stop(s);
    await p;
    expect(st().sessions[s].status).toBe("idle");
    expect(st().sessions[s].items.at(-1)).toMatchObject({ kind: "notice", text: "Stopped." });
    for (const id of [...st().order]) A.deleteSession(id);
    expect(st().order.length).toBe(1);
  });
});
