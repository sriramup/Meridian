import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildVisionRequest, parseVisionResponse, rejectsForcedTools, visionModel } from "@/sketch/vision";
import { SKETCH_TOOL_NAME } from "@/sketch/plan";

const PLAN = JSON.parse(readFileSync(new URL("./fixtures/sketch-plan.json", import.meta.url), "utf8"));
const IMG = "A".repeat(4000);

describe("vision request", () => {
  it("sends the image as a base64 block and forces the plan tool", () => {
    const { model, forced, params } = buildVisionRequest({ image: IMG, media_type: "image/jpeg", width: 1200, height: 900, hint: "a riverside neighbourhood" }, {});
    expect(model).toBe("claude-haiku-5-5");
    expect(forced).toBe(true);
    const msg = (params.messages as any[])[0];
    expect(msg.role).toBe("user");
    expect(msg.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: IMG } });
    expect(msg.content[1].text).toMatch(/1200 × 900/);
    expect(msg.content[1].text).toMatch(/riverside/);
    expect(params.tool_choice).toEqual({ type: "tool", name: SKETCH_TOOL_NAME, disable_parallel_tool_use: true });
    // forced tool use can't be combined with thinking
    expect(params.thinking).toEqual({ type: "disabled" });
    expect((params.tools as any[]).map((t) => t.name)).toEqual([SKETCH_TOOL_NAME]);
    // the stable prefix (system + tool) is cached; nothing volatile in it
    expect((params.system as any[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(params.system)).not.toMatch(/1200|riverside/);
  });

  it("uses MERIDIAN_MODEL_VISION, else the standard tier's model", () => {
    expect(visionModel({ MERIDIAN_MODEL_VISION: "claude-sonnet-5" })).toBe("claude-sonnet-5");
    expect(visionModel({ MERIDIAN_MODEL_STANDARD: "claude-opus-5" })).toBe("claude-opus-5");
    expect(visionModel({})).toBe("claude-haiku-5-5");
  });

  it("falls back to an unforced call on models that reject forced tool use", () => {
    expect(rejectsForcedTools("claude-opus-5-5")).toBe(true);
    expect(rejectsForcedTools("claude-haiku-5-5")).toBe(false);
    const { forced, params } = buildVisionRequest({ image: IMG }, { MERIDIAN_MODEL_VISION: "claude-sonnet-5-5" });
    expect(forced).toBe(false);
    expect((params.tool_choice as any).type).toBe("auto");
    expect((params.thinking as any).type).toBe("adaptive");
  });

  it("reads only the tool input, and recognises a non-plan", () => {
    const ok = parseVisionResponse({ stop_reason: "tool_use", content: [{ type: "text" }, { type: "tool_use", name: SKETCH_TOOL_NAME, input: PLAN }] });
    expect(ok.ok).toBe(true);
    const no = parseVisionResponse({ stop_reason: "tool_use", content: [{ type: "tool_use", name: SKETCH_TOOL_NAME, input: { is_plan: false, not_plan_reason: "a selfie", extent: { width_m: 0, height_m: 0 }, streets: [], blocks: [], areas: [], facilities: [], transit: [], notes: [] } }] });
    expect(no.ok).toBe(false);
    expect((no as { reason: string }).reason).toBe("a selfie");
    expect(parseVisionResponse({ stop_reason: "end_turn", content: [{ type: "text" }] }).ok).toBe(false);
  });
});

describe("POST /api/vision", () => {
  let server: http.Server;
  const seen: any[] = [];
  const env = { ...process.env };
  let ledgerPath = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw);
        seen.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: body.model, stop_reason: "tool_use", stop_sequence: null, content: [{ type: "tool_use", id: "toolu_1", name: SKETCH_TOOL_NAME, input: PLAN }], usage: { input_tokens: 1800, output_tokens: 900, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    ledgerPath = join(mkdtempSync(join(tmpdir(), "vision-")), "spend.json");
    Object.assign(process.env, { ANTHROPIC_API_KEY: "test", MERIDIAN_ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, MERIDIAN_SPEND_LEDGER: ledgerPath, MERIDIAN_SPEND_CAP_USD: "1" });
  });
  afterAll(() => {
    server.close();
    process.env = env;
  });

  it("reserves against the ledger, calls the model once and records the cost", async () => {
    const { POST } = await import("@/app/api/vision/route");
    const res = await POST(new Request("http://x/api/vision", { method: "POST", body: JSON.stringify({ image: IMG, media_type: "image/jpeg", width: 1200, height: 900 }) }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.plan.title).toBe("Riverbend");
    expect(seen.length).toBe(1);
    expect(seen[0].stream).toBeFalsy();
    expect(seen[0].messages[0].content[0].type).toBe("image");
    expect(seen[0].tool_choice.name).toBe(SKETCH_TOOL_NAME);
    expect(j.cost.usd).toBeGreaterThan(0);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(ledger.requests).toBe(1);
    expect(ledger.recent[0].tier).toBe("vision");
  });

  it("refuses a request that would cross the spend cap, before sending it", async () => {
    process.env.MERIDIAN_SPEND_CAP_USD = "0.0000001";
    // the route uses the process-wide ledger (configured on first use): point its cap down
    (await import("@/agent/spend")).ledger().cap = 0.0000001;
    const { POST } = await import("@/app/api/vision/route");
    const before = seen.length;
    const res = await POST(new Request("http://x/api/vision", { method: "POST", body: JSON.stringify({ image: IMG }) }));
    expect(res.status).toBe(402);
    expect(seen.length).toBe(before);
  });

  it("rejects an empty or oversized image kindly", async () => {
    const { POST } = await import("@/app/api/vision/route");
    expect((await POST(new Request("http://x/api/vision", { method: "POST", body: JSON.stringify({ image: "" }) }))).status).toBe(400);
    expect((await POST(new Request("http://x/api/vision", { method: "POST", body: JSON.stringify({ image: "A".repeat(5_000_001) }) }))).status).toBe(413);
  });
});
