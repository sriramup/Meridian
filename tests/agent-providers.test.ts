// Provider choice for agent turns (plan → Gemini, everything else → Claude), the Gemini rate-limit
// fallback to Claude, and the Claude ⇄ Gemini translation, with mocked clients (no keys, no network).
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { GenerateContentResponse } from "@google/genai";
import { geminiErrorText, GeminiTurn, SignatureStore, SKIP_SIGNATURE, toGeminiContents, toGeminiRequest } from "@/agent/gemini";
import { costOf, geminiTierConfig, tierConfig } from "@/agent/models";
import { chooseProvider, geminiLimit, serveTurn, type ClaudeClient, type GeminiClient, type ProviderChoice } from "@/agent/providers";
import { buildRequest } from "@/agent/request";
import { SpendLedger } from "@/agent/spend";
import { loadHeadless } from "../scripts/dev/headless";

const KEYS = { ANTHROPIC_API_KEY: "test", GEMINI_API_KEY: "test" };
type Cooldown = { until: number; kind: "rate limit" | "quota" | "overloaded"; overloaded: Map<string, number> };
const cool = (until = 0, kind: Cooldown["kind"] = "rate limit"): Cooldown => ({ until, kind, overloaded: new Map() });
const tmpLedger = () => new SpendLedger({ path: join(mkdtempSync(join(tmpdir(), "meridian-prov-")), "spend.json"), cap: null });

/** a Google API error as the SDK raises it (status + the JSON body as the message) */
function apiError(status: number, code: string, message: string, retry?: string) {
  const body = { error: { code: status, message, status: code, ...(retry ? { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: retry }] } : {}) } };
  return Object.assign(new Error(JSON.stringify(body)), { status });
}

const chunk = (parts: object[], extra: object = {}) => ({ candidates: [{ content: { role: "model", parts }, ...extra }], modelVersion: "gemini-3.6-flash", responseId: "r1" }) as unknown as GenerateContentResponse;

type GeminiScript = { chunks?: GenerateContentResponse[]; openError?: Error; firstChunkError?: Error };
/** fake Gemini client: scripted chunks, or an error at open / at the first chunk (optionally per model) */
function fakeGemini(scripts: GeminiScript | ((model: string) => GeminiScript)) {
  const calls: any[] = [];
  const client: GeminiClient = {
    models: {
      async generateContentStream(p) {
        calls.push(p);
        const script = typeof scripts === "function" ? scripts(p.model) : scripts;
        if (script.openError) throw script.openError;
        return (async function* () {
          if (script.firstChunkError) throw script.firstChunkError;
          for (const c of script.chunks ?? []) yield c;
        })();
      },
    },
  };
  return { client, calls };
}

/** fake Anthropic client: one text answer */
function fakeClaude(text = "Claude here.") {
  const calls: any[] = [];
  const final = { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
  const client: ClaudeClient = {
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          const events = [
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          ];
          return Object.assign(
            (async function* () {
              yield* events as any[];
            })(),
            { finalMessage: async () => final as any },
          );
        },
      },
    },
  };
  return { client, calls };
}

const body = (mode: "plan" | "edit") => ({
  tier: "standard" as const,
  city: "sandbox",
  mode,
  messages: [{ role: "user", content: [{ type: "text", text: `<context>\nmode: ${mode}\n</context>` }, { type: "text", text: "Where could a park go?" }] }],
});

async function run(mode: "plan" | "edit", clients: { claude: ClaudeClient | null; gemini: GeminiClient | null }, opts: { now?: number; cooldown?: Cooldown; store?: SignatureStore } = {}) {
  const cooldown = opts.cooldown ?? cool();
  const now = opts.now ?? 1_000_000;
  const choice: ProviderChoice = chooseProvider(mode, KEYS, now, cooldown);
  const { cfg, tier, params } = buildRequest(body(mode));
  const ledger = tmpLedger();
  const r = ledger.reserve(0.01);
  if (!r.ok) throw new Error(r.message);
  const events: any[] = [];
  await serveTurn({ choice, ...clients, params, cfg, gcfg: geminiTierConfig(tier, {}), tier, ledger, ticket: r.ticket, promptChars: 1000, send: (o) => events.push(o), now: () => now, cooldown, store: opts.store ?? new SignatureStore() });
  return { choice, events, ledger, cooldown, route: events.find((e) => e.t === "route"), final: events.find((e) => e.t === "final"), error: events.find((e) => e.t === "error") };
}

describe("provider selection", () => {
  it("sends plan mode to Gemini and every other mode to Claude", () => {
    expect(chooseProvider("plan", KEYS, 0, cool()).provider).toBe("gemini");
    expect(chooseProvider("edit", KEYS, 0, cool()).provider).toBe("claude");
    expect(chooseProvider(undefined, KEYS, 0, cool()).provider).toBe("claude");
  });
  it("keeps plan mode on Claude without a Gemini key", () => {
    const c = chooseProvider("plan", { ANTHROPIC_API_KEY: "x" }, 0, cool());
    expect(c.provider).toBe("claude");
    expect(c.fallback).toBeUndefined();
  });
  it("keeps plan mode on Claude during a rate-limit cooldown, then returns to Gemini", () => {
    const cd = cool(60_000);
    const during = chooseProvider("plan", KEYS, 30_000, cd);
    expect(during).toMatchObject({ provider: "claude", fallback: "Gemini rate limit" });
    expect(during.reason).toMatch(/retrying it in 30s/);
    expect(chooseProvider("plan", KEYS, 60_000, cd).provider).toBe("gemini");
    // a cooldown never moves edit mode anywhere
    expect(chooseProvider("edit", KEYS, 30_000, cd)).toEqual({ provider: "claude", reason: "edit mode" });
  });
});

describe("Gemini limit errors", () => {
  it("treats 429 RESOURCE_EXHAUSTED as a rate limit, with the server's retry delay as the cooldown", () => {
    expect(geminiLimit(apiError(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted.", "37s"))).toEqual({ kind: "rate limit", cooldownMs: 37_000 });
    expect(geminiLimit(apiError(429, "RESOURCE_EXHAUSTED", "Too many requests"))).toEqual({ kind: "rate limit", cooldownMs: 60_000 });
  });
  it("recognises quota errors and 503 overload", () => {
    expect(geminiLimit(apiError(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details."))?.kind).toBe("quota");
    expect(geminiLimit(apiError(503, "UNAVAILABLE", "This model is currently experiencing high demand."))).toEqual({ kind: "overloaded", cooldownMs: 30_000 });
  });
  it("leaves other errors alone", () => {
    expect(geminiLimit(apiError(400, "INVALID_ARGUMENT", "Invalid JSON payload"))).toBeNull();
    expect(geminiLimit(apiError(401, "UNAUTHENTICATED", "API key not valid"))).toBeNull();
    expect(geminiLimit(new Error("socket hang up"))).toBeNull();
  });
  it("unwraps the nested message the SDK raises", () => {
    const e = Object.assign(new Error(JSON.stringify({ error: { message: JSON.stringify({ error: { code: 503, message: "High demand.", status: "UNAVAILABLE" } }), code: 503 } })), { status: 503 });
    expect(geminiErrorText(e)).toBe("High demand.");
  });
});

describe("serveTurn", () => {
  it("answers a plan-mode turn with Gemini: same event stream, a Claude-shaped final message, Gemini prices", async () => {
    const g = fakeGemini({
      chunks: [
        chunk([{ text: "Weighing sites", thought: true }]),
        chunk([{ text: "Let me look " }]),
        chunk([{ text: "first." }]),
        chunk([{ functionCall: { id: "call_7", name: "find_features", args: { kind: "parcel", limit: 3 } }, thoughtSignature: "sig-A" }]),
        chunk([{ text: "" }], { finishReason: "STOP" }),
        { ...chunk([]), usageMetadata: { promptTokenCount: 12_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 300, thoughtsTokenCount: 200 } } as unknown as GenerateContentResponse,
      ],
    });
    const c = fakeClaude();
    const { route, events, final, ledger } = await run("plan", { claude: c.client, gemini: g.client });
    expect(c.calls).toHaveLength(0);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0].model).toBe("gemini-3.6-flash");
    expect(route).toMatchObject({ t: "route", provider: "gemini", model: "gemini-3.6-flash", effort: "medium" });
    expect(events.filter((e) => e.t === "thinking").map((e) => e.d)).toEqual(["Weighing sites"]);
    expect(events.filter((e) => e.t === "text").map((e) => e.d).join("")).toBe("Let me look first.");
    const tool = events.find((e) => e.t === "tool");
    expect(tool.name).toBe("find_features");
    // the message the client appends to its history: Messages API blocks, thinking left out
    expect(final.message.stop_reason).toBe("tool_use");
    expect(final.message.content).toEqual([
      { type: "text", text: "Let me look first." },
      { type: "tool_use", id: tool.id, name: "find_features", input: { kind: "parcel", limit: 3 } },
    ]);
    expect(final.message.usage).toEqual({ input_tokens: 4_000, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 0, output_tokens: 500 });
    const usd = (4_000 * 0.75 + 8_000 * 0.075 + 500 * 3.75) / 1e6;
    expect(final.cost.usd).toBeCloseTo(usd, 10);
    expect(ledger.snapshot().by_model["gemini-3.6-flash"]).toEqual({ usd: Math.round(usd * 1e6) / 1e6, requests: 1 });
  });

  it("retries a rate-limited plan turn on Claude, notes the fallback and starts a cooldown", async () => {
    const g = fakeGemini({ openError: apiError(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted (e.g. check quota).", "20s") });
    const c = fakeClaude("Here is a plan.");
    const { route, events, final, error, cooldown, ledger } = await run("plan", { claude: c.client, gemini: g.client });
    expect(error).toBeUndefined();
    expect(g.calls).toHaveLength(1);
    expect(c.calls).toHaveLength(1);
    // the same Messages API request Claude would have had
    expect(c.calls[0].model).toBe(tierConfig("standard", {}).model);
    expect(c.calls[0].messages).toEqual(body("plan").messages);
    expect(route).toMatchObject({ provider: "claude", fallback: "Gemini quota" });
    expect(events.filter((e) => e.t === "route")).toHaveLength(1);
    expect(final.message.content[0].text).toBe("Here is a plan.");
    expect(cooldown.until).toBe(1_000_000 + 20_000);
    expect(Object.keys(ledger.snapshot().by_model)).toEqual(["claude-haiku-5-5"]);
    // later plan turns skip Gemini until the cooldown ends
    const g2 = fakeGemini({ chunks: [chunk([{ text: "Gemini again." }], { finishReason: "STOP" })] });
    const during = await run("plan", { claude: fakeClaude().client, gemini: g2.client }, { now: 1_010_000, cooldown });
    expect(g2.calls).toHaveLength(0);
    expect(during.route).toMatchObject({ provider: "claude", fallback: "Gemini quota" });
    const after = await run("plan", { claude: fakeClaude().client, gemini: g2.client }, { now: 1_020_000, cooldown });
    expect(g2.calls).toHaveLength(1);
    expect(after.route.provider).toBe("gemini");
    expect(after.final.message.content).toEqual([{ type: "text", text: "Gemini again." }]);
  });

  it("falls back when the limit arrives as the first chunk", async () => {
    const g = fakeGemini({ firstChunkError: apiError(429, "RESOURCE_EXHAUSTED", "Too many requests") });
    const a = await run("plan", { claude: fakeClaude().client, gemini: g.client });
    // a rate limit goes straight to Claude: no second Gemini model is tried
    expect(g.calls).toHaveLength(1);
    expect(a.route).toMatchObject({ provider: "claude", fallback: "Gemini rate limit" });
    expect(a.final).toBeDefined();
  });

  it("answers with the overflow Gemini model when the tier's model is overloaded, and Claude when both are", async () => {
    const busy = apiError(503, "UNAVAILABLE", "This model is currently experiencing high demand.");
    const g = fakeGemini((m) => (m === "gemini-3.6-flash" ? { openError: busy } : { chunks: [chunk([{ text: "Lite here." }], { finishReason: "STOP" })] }));
    const c = fakeClaude();
    const cooldown = cool();
    const a = await run("plan", { claude: c.client, gemini: g.client }, { cooldown });
    expect(g.calls.map((p) => p.model)).toEqual(["gemini-3.6-flash", "gemini-3.5-flash-lite"]);
    expect(c.calls).toHaveLength(0);
    expect(a.route).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash-lite" });
    expect(a.route.reason).toMatch(/gemini-3.6-flash overloaded/);
    expect(a.final.message.content).toEqual([{ type: "text", text: "Lite here." }]);
    // the overloaded model is skipped for a while; Gemini as a whole is not
    expect(cooldown.until).toBe(0);
    await run("plan", { claude: c.client, gemini: g.client }, { now: 1_010_000, cooldown });
    expect(g.calls.map((p) => p.model).slice(2)).toEqual(["gemini-3.5-flash-lite"]);
    const both = fakeGemini({ openError: busy });
    const b = await run("plan", { claude: fakeClaude().client, gemini: both.client });
    expect(both.calls).toHaveLength(2);
    expect(b.route).toMatchObject({ provider: "claude", fallback: "Gemini overloaded" });
  });

  it("reports other Gemini errors instead of switching provider", async () => {
    const c = fakeClaude();
    const { error, final, cooldown, ledger } = await run("plan", { claude: c.client, gemini: fakeGemini({ openError: apiError(400, "INVALID_ARGUMENT", "Bad schema") }).client });
    expect(c.calls).toHaveLength(0);
    expect(final).toBeUndefined();
    expect(error).toMatchObject({ message: "Gemini: Bad schema", status: 400 });
    expect(cooldown.until).toBe(0);
    expect(ledger.pending).toBe(0);
  });

  it("serves edit mode with Claude even when Gemini is available", async () => {
    const g = fakeGemini({ chunks: [chunk([{ text: "x" }])] });
    const c = fakeClaude("Edited.");
    const { route, final } = await run("edit", { claude: c.client, gemini: g.client });
    expect(g.calls).toHaveLength(0);
    expect(c.calls).toHaveLength(1);
    expect(route).toMatchObject({ provider: "claude", model: "claude-haiku-5-5" });
    expect(route.fallback).toBeUndefined();
    expect(final.message.content[0].text).toBe("Edited.");
  });
});

describe("Claude ⇄ Gemini translation", () => {
  it("maps a Claude history to Gemini contents, restoring each call's id and thought signature", () => {
    const store = new SignatureStore();
    store.set("toolu_gm1", { gid: "call_1", sig: "sig-1" });
    const contents = toGeminiContents(
      [
        { role: "user", content: [{ type: "text", text: "<context>…</context>" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "Read this" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "claude-sig" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_gm1", name: "inspect", input: { id: "b1" } }, { type: "tool_use", id: "toolu_gm2", name: "find_features", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_gm1", content: '{"height":40}' }, { type: "tool_result", tool_use_id: "toolu_gm2", content: "not json…", is_error: true }, { type: "text", text: "[runtime] note" }] },
        // a step Claude answered after a fallback: no Gemini signature known
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_01abc", name: "go_to", input: { place: "Zilker" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01abc", content: '{"went_to":{}}' }] },
      ],
      store,
    );
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user", "model", "user"]);
    expect(contents[0].parts).toEqual([{ text: "<context>…</context>" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }, { text: "Read this" }]);
    expect(contents[1].parts).toEqual([
      { text: "Looking." },
      { functionCall: { id: "call_1", name: "inspect", args: { id: "b1" } }, thoughtSignature: "sig-1" },
      { functionCall: { id: "toolu_gm2", name: "find_features", args: {} } },
    ]);
    expect(contents[2].parts).toEqual([
      { functionResponse: { id: "call_1", name: "inspect", response: { output: { height: 40 } } } },
      { functionResponse: { id: "toolu_gm2", name: "find_features", response: { error: "not json…" } } },
      { text: "[runtime] note" },
    ]);
    expect(contents[3].parts).toEqual([{ functionCall: { id: "toolu_01abc", name: "go_to", args: { place: "Zilker" } }, thoughtSignature: SKIP_SIGNATURE }]);
  });

  it("starts from the latest compaction summary, as the Messages API does", () => {
    const contents = toGeminiContents([
      { role: "user", content: "old request" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: "next" },
      { role: "assistant", content: [{ type: "compaction", content: "User asked for parks; two sites found.", encrypted_content: null }, { type: "text", text: "Continuing." }] },
      { role: "user", content: "and now?" },
    ]);
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "[runtime] Summary of the earlier conversation in this session:\nUser asked for parks; two sites found." }] },
      { role: "model", parts: [{ text: "Continuing." }] },
      { role: "user", parts: [{ text: "and now?" }] },
    ]);
  });

  it("builds the request from the cache-stable Messages API params: system, every tool, thinking level", () => {
    const { params, tier } = buildRequest(body("plan"));
    const req = toGeminiRequest(params, geminiTierConfig(tier, {}));
    const decl = (req.config!.tools as any[])[0].functionDeclarations;
    expect(decl.length).toBe((params.tools as unknown[]).length);
    expect(decl[0]).toEqual({ name: (params.tools as any[])[0].name, description: (params.tools as any[])[0].description, parametersJsonSchema: (params.tools as any[])[0].input_schema });
    expect(req.config!.systemInstruction).toBe((params.system as any[])[0].text);
    expect(req.config!.thinkingConfig).toEqual({ thinkingLevel: "MEDIUM", includeThoughts: true });
    expect(req.config!.maxOutputTokens).toBe(16000);
  });

  it("keeps every Gemini turn valid as Claude history (no empty turns) and maps finish reasons", () => {
    const empty = new GeminiTurn("gemini-3.6-flash", new SignatureStore());
    empty.push(chunk([{ text: "" }], { finishReason: "STOP" }));
    expect(empty.message()).toMatchObject({ stop_reason: "end_turn", content: [{ type: "text", text: "(no response)" }] });
    const blocked = new GeminiTurn("gemini-3.6-flash", new SignatureStore());
    blocked.push(chunk([], { finishReason: "SAFETY" }));
    expect(blocked.message().stop_reason).toBe("refusal");
    const long = new GeminiTurn("gemini-3.6-flash", new SignatureStore());
    long.push(chunk([{ text: "a long" }], { finishReason: "MAX_TOKENS" }));
    expect(long.message().stop_reason).toBe("max_tokens");
    const bad = new GeminiTurn("gemini-3.6-flash", new SignatureStore());
    bad.push(chunk([], { finishReason: "MALFORMED_FUNCTION_CALL" }));
    expect(() => bad.message()).toThrow(/unusable tool call/);
  });

  it("prices Gemini usage at Gemini's rates", () => {
    expect(costOf("gemini-3.6-flash", { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 })).toBeCloseTo(0.75 + 3.75 + 0.075, 10);
    expect(costOf("gemini-3.1-pro-preview", { input_tokens: 300_000, output_tokens: 1e6 })).toBeCloseTo(0.3 * 4 + 18, 10);
  });
});

describe("the agent loop tells the server the mode and records who answered", () => {
  type S = typeof import("@/agent/sessions");
  let A: S;
  const bodies: { mode: string }[] = [];
  beforeAll(async () => {
    loadHeadless("sandbox");
    A = await import("@/agent/sessions");
    A.setTransport(async function* (b) {
      bodies.push({ mode: b.mode });
      const plan = b.mode === "plan";
      yield plan ? { t: "route", model: "claude-haiku-5-5", effort: "medium", provider: "claude", fallback: "Gemini rate limit" } : { t: "route", model: "claude-haiku-5-5", effort: "medium", provider: "claude" };
      yield { t: "text", d: "ok" };
      yield { t: "final", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } as any };
    });
  }, 180_000);

  it("sends plan and edit runs with their mode; a fallback is noted on the run", async () => {
    const id = A.createSession({ mode: "plan" });
    await A.send(id, "Where could a park go?");
    let s = A.useAgents.getState().sessions[id];
    expect(bodies.at(-1)).toEqual({ mode: "plan" });
    expect(s.lastRun).toMatchObject({ provider: "claude", fallback: "Gemini rate limit" });
    expect(s.items.filter((i) => i.kind === "notice").map((i) => (i.kind === "notice" ? i.text : ""))).toEqual(["Gemini rate limit: Claude answered this plan-mode run."]);
    await A.send(id, "Thanks, what is there now?", { mode: "edit" });
    s = A.useAgents.getState().sessions[id];
    expect(bodies.at(-1)).toEqual({ mode: "edit" });
    expect(s.lastRun?.provider).toBe("claude");
    expect(s.lastRun?.fallback).toBeUndefined();
  });
});

describe("the Gemini key stays on the server", () => {
  const ROOT = resolve(__dirname, "..");
  const files: string[] = [];
  (function walk(d: string) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(f)) files.push(p);
    }
  })(join(ROOT, "src"));
  const rel = (p: string) => relative(ROOT, p);
  const src = (f: string) => readFileSync(f, "utf8");

  it("only the agent route reads GEMINI_API_KEY from process.env, and no NEXT_PUBLIC_ variant exists", () => {
    expect(files.filter((f) => /process\.env\.GEMINI_API_KEY|process\.env\[["']GEMINI_API_KEY/.test(src(f))).map(rel)).toEqual(["src/app/api/agent/route.ts"]);
    expect(files.filter((f) => src(f).includes("NEXT_PUBLIC_GEMINI")).map(rel)).toEqual([]);
  });
  it("the Gemini modules and SDK are imported only on the server side of the agent", () => {
    const importers = files.filter((f) => /from ["'](@\/agent\/|\.\/)(providers|gemini)["']|from ["']@google\/genai["']/.test(src(f))).map(rel).sort();
    expect(importers).toEqual(["src/agent/gemini.ts", "src/agent/providers.ts", "src/app/api/agent/route.ts"]);
  });
});
