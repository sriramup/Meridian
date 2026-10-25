// The sketch flow through the agent runtime on the blank canvas, with a scripted model and a canned
// vision reply: image attached → read (one vision call) → first turn sees the image + extracted plan →
// build_sketch → summary; a non-plan is reported, not built; saved history keeps no image data.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadHeadless } from "../scripts/dev/headless";
import { normalisePlan } from "@/sketch/plan";
import type { SketchAttachment } from "@/sketch/store";
import { stripImages } from "@/sketch/attach";
import { routeRequest } from "@/agent/router";

const PLAN = normalisePlan(JSON.parse(readFileSync(new URL("./fixtures/sketch-plan.json", import.meta.url), "utf8")));
let R: ReturnType<typeof loadHeadless>;
let A: typeof import("@/agent/sessions");
const firstTurns: any[][] = [];
let visionCalls = 0;

const att = (id: string, w = 1200, h = 900): SketchAttachment => ({ id, name: "whiteboard.jpg", media_type: "image/jpeg", data: "Zm9v".repeat(500), width: w, height: h, thumb: "data:image/jpeg;base64,Zm9v", bytes: 1500 });

beforeAll(async () => {
  R = loadHeadless("sandbox");
  A = await import("@/agent/sessions");
  const store = await import("@/sketch/store");
  // canned vision: a portrait image is "a selfie", anything else the fixture plan
  store.setVisionTransport(async (a) => {
    visionCalls++;
    if (a.height > a.width) return { ok: false, not_plan: true, reason: "a photo of a person", plan: normalisePlan({ is_plan: false }) };
    return { ok: true, plan: PLAN, cost: { usd: 0.0004 } };
  });
  let n = 0;
  A.setTransport(async function* (body) {
    const msgs = body.messages as any[];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user" && m.content.some((c: any) => c.type === "text" && !c.text.startsWith("<context>") && !c.text.startsWith("[runtime]")));
    const results = msgs.slice(msgs.indexOf(lastUser) + 1).filter((m) => m.role === "user").flatMap((m) => m.content.filter((c: any) => c.type === "tool_result"));
    if (!results.length) firstTurns.push(lastUser.content);
    const note = lastUser.content.find((c: any) => c.type === "text" && c.text.startsWith("[runtime] The user attached"))?.text ?? "";
    const id = note.match(/sketch_id (\w+)/)?.[1];
    let content: any[];
    if (/doesn't look like a plan/.test(note)) content = [{ type: "text", text: "That doesn't look like a bird's-eye plan." }];
    else if (!results.length && id) content = [{ type: "tool_use", id: `toolu_${++n}`, name: "build_sketch", input: { sketch_id: id } }];
    else {
      const d = JSON.parse(results[0].content);
      content = [{ type: "text", text: `Built ${d.data?.name}: ${d.data?.buildings} buildings. Placed at ${d.placed_at}.` }];
    }
    for (const c of content) if (c.type === "tool_use") yield { t: "tool", id: c.id, name: c.name };
    else yield { t: "text", d: c.text };
    yield { t: "final", message: { role: "assistant", content, stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn" } as any };
  });
}, 180_000);

const st = () => A.useAgents.getState();

describe("sketch through the agent", () => {
  it("routes image runs off the quick tier", () => {
    expect(routeRequest("hi", { hasImage: true }).tier).toBe("standard");
    expect(routeRequest("Build this sketch.", { hasImage: true }).tier).not.toBe("quick");
  });

  it("reads the sketch, shows the plan and the image to the model, and builds it", async () => {
    const id = st().order[0];
    await A.send(id, "", { sketch: att("skA") });
    const s = st().sessions[id];
    expect(s.status).toBe("idle");
    expect(visionCalls).toBe(1);
    const user = s.items.find((i) => i.kind === "user")!;
    expect(user.kind === "user" && user.sketch?.thumb).toMatch(/^data:image\/jpeg/);
    expect(user.kind === "user" && user.text).toBe("Build this sketch.");
    // the first model turn saw the image block and the compact plan
    const first = firstTurns[0];
    expect(first.some((c: any) => c.type === "image" && c.source.type === "base64" && c.source.media_type === "image/jpeg")).toBe(true);
    expect(first.find((c: any) => c.type === "text" && c.text.includes('"sketch_id":"skA"'))).toBeTruthy();
    const steps = s.items.flatMap((i) => (i.kind === "assistant" ? i.segments.filter((g) => g.type === "tool").map((g) => (g.type === "tool" ? `${g.call.name}:${g.call.status}` : "")) : []));
    expect(steps).toEqual(["read_sketch:done", "build_sketch:done"]);
    expect(R.world.all("building").length).toBeGreaterThan(80);
    expect(R.world.all("street").some((x) => x.name === "Grand Avenue")).toBe(true);
    const answer = s.items.filter((i) => i.kind === "assistant").pop()!;
    expect(JSON.stringify(answer)).toMatch(/Built Riverbend/);
    expect(s.lastRun?.costUsd).toBeGreaterThan(0);
  });

  it("puts a second sketch in free space and undoes it in one step", async () => {
    const id = A.createSession();
    const before = R.world.entities.size;
    const buildingsBefore = new Set(R.world.all("building").map((b) => b.id));
    await A.send(id, "here's another one", { sketch: att("skB") });
    const s = st().sessions[id];
    const answer = JSON.stringify(s.items.filter((i) => i.kind === "assistant").pop());
    expect(answer).toMatch(/nearest free space/);
    expect(R.world.entities.size).toBeGreaterThan(before);
    for (const b of buildingsBefore) expect(R.world.get(b)).toBeTruthy();
    expect(s.changesets.length).toBe(1);
    R.scenarios.undo();
    expect(R.world.entities.size).toBe(before);
  });

  it("says when the image is not a plan, and builds nothing", async () => {
    const id = A.createSession();
    const before = R.world.entities.size;
    await A.send(id, "", { sketch: att("skC", 600, 800) });
    const s = st().sessions[id];
    expect(R.world.entities.size).toBe(before);
    expect(JSON.stringify(s.items)).toMatch(/doesn't look like a bird's-eye plan/);
  });

  it("never keeps image data in the saved history", () => {
    const id = st().order[st().order.length - 1];
    const h = stripImages(A.historyOf(id) as any);
    expect(JSON.stringify(h)).not.toMatch(/"type":"image"/);
  });
});
