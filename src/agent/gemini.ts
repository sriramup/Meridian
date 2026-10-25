// Gemini adapter for the agent route. The client-side loop (src/agent/sessions.ts) keeps one
// Claude-format history whichever provider answers a turn, so a turn served by Gemini is translated on
// the way in (Messages API params → generateContent contents, tools → function declarations) and on
// the way out (streamed parts → the route's NDJSON events and a Claude-shaped final message). Pure
// translation, no network: ./providers.ts sends the request. Node only (never imported by client code).
//
// Thought signatures: Gemini 3 validates the signature on the first functionCall part of every step of
// the current turn, and wants each call sent back as it was returned. The history cannot carry them (a
// Claude request rejects unknown fields on a tool_use block), so they stay in a server-side store keyed
// by tool_use id, with Gemini's own call id. A call the store doesn't know (Claude made it after a
// fallback, or the server restarted mid-run) gets Google's documented placeholder signature.

import type { Content, GenerateContentParameters, GenerateContentResponse, Part, ThinkingLevel, Tool } from "@google/genai";
import type { GeminiTierConfig, Usage } from "./models";

/** the Messages API blocks this adapter reads (anything else is skipped) */
type Block = { type: string; [k: string]: unknown };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

/** Google's documented value for a functionCall part that has no signature of its own */
export const SKIP_SIGNATURE = "skip_thought_signature_validator";

interface CallMeta {
  /** the id Gemini gave the call (the tool_use id is ours, unique across the history) */
  gid?: string;
  sig?: string;
}

/** tool_use id → Gemini call id and thought signature, bounded (oldest entries go first) */
export class SignatureStore {
  private m = new Map<string, CallMeta>();
  constructor(private max = 5000) {}
  get(id: string): CallMeta | undefined {
    return this.m.get(id);
  }
  set(id: string, meta: CallMeta) {
    this.m.set(id, meta);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
}

export const signatures = new SignatureStore();

const blocksOf = (m: Msg): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);

/** a tool_result's content as the JSON object Gemini expects ("output", or "error" for a failed call) */
function responseOf(b: Block): Record<string, unknown> {
  const c = b.content;
  const raw = typeof c === "string" ? c : Array.isArray(c) ? (c as Block[]).map((x) => (x.type === "text" ? String(x.text) : "")).join("\n") : "";
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // truncated or plain text: pass the string
  }
  return b.is_error ? { error: value } : { output: value };
}

/** Claude-format history → Gemini contents (thinking and server-tool blocks have no Gemini form and are dropped) */
export function toGeminiContents(messages: unknown[], store: SignatureStore = signatures): Content[] {
  let msgs = messages as Msg[];
  // server-side compaction: a compaction block replaces everything before it, as the Messages API does
  let summary: string | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i].role === "assistant" ? blocksOf(msgs[i]).find((b) => b.type === "compaction") : undefined;
    if (c) {
      summary = typeof c.content === "string" ? c.content : null;
      msgs = msgs.slice(i);
      break;
    }
  }
  const names = new Map<string, string>();
  for (const m of msgs) for (const b of blocksOf(m)) if (b.type === "tool_use") names.set(String(b.id), String(b.name));
  const out: Content[] = [];
  const add = (role: "user" | "model", parts: Part[]) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.parts!.push(...parts);
    else out.push({ role, parts });
  };
  if (summary) add("user", [{ text: `[runtime] Summary of the earlier conversation in this session:\n${summary}` }]);
  for (const m of msgs) {
    const parts: Part[] = [];
    if (m.role === "user") {
      for (const b of blocksOf(m)) {
        if (b.type === "text" && b.text) parts.push({ text: String(b.text) });
        else if (b.type === "tool_result") {
          const id = String(b.tool_use_id);
          parts.push({ functionResponse: { id: store.get(id)?.gid ?? id, name: names.get(id) ?? "unknown_tool", response: responseOf(b) } });
        } else if (b.type === "image") {
          const s = b.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined;
          if (s?.type === "base64" && s.data) parts.push({ inlineData: { mimeType: s.media_type ?? "image/jpeg", data: s.data } });
          else if (s?.type === "url" && s.url) parts.push({ fileData: { fileUri: s.url } });
        }
      }
      add("user", parts);
    } else {
      let signed = false;
      for (const b of blocksOf(m)) {
        if (b.type === "text" && b.text) parts.push({ text: String(b.text) });
        else if (b.type === "tool_use") {
          const id = String(b.id);
          const meta = store.get(id);
          const part: Part = { functionCall: { id: meta?.gid ?? id, name: String(b.name), args: (b.input ?? {}) as Record<string, unknown> } };
          if (meta?.sig) {
            part.thoughtSignature = meta.sig;
            signed = true;
          }
          parts.push(part);
        }
      }
      // a step with no known signature (Claude's, or lost): sign its first call with the placeholder
      const first = parts.find((p) => p.functionCall);
      if (first && !signed) first.thoughtSignature = SKIP_SIGNATURE;
      add("model", parts);
    }
  }
  return out;
}

type ToolParam = { name: string; description?: string; input_schema: unknown };

const declCache = new WeakMap<object, Tool[]>();
/** Messages API tools → one Gemini tool of function declarations (JSON Schema passed through as is) */
export function toGeminiTools(tools: ToolParam[]): Tool[] {
  let t = declCache.get(tools);
  if (!t) {
    t = [{ functionDeclarations: tools.map((x) => ({ name: x.name, description: x.description, parametersJsonSchema: x.input_schema })) }];
    declCache.set(tools, t);
  }
  return t;
}

/** the Messages API params of a turn (./request.ts buildRequest) → a generateContent request */
export function toGeminiRequest(params: Record<string, unknown>, cfg: GeminiTierConfig, signal?: AbortSignal, store: SignatureStore = signatures): GenerateContentParameters {
  const system = (params.system as { text: string }[] | undefined)?.map((s) => s.text).join("\n\n");
  return {
    model: cfg.model,
    contents: toGeminiContents(params.messages as unknown[], store),
    config: {
      ...(system ? { systemInstruction: system } : {}),
      tools: toGeminiTools(params.tools as ToolParam[]),
      thinkingConfig: { thinkingLevel: cfg.thinkingLevel as ThinkingLevel, includeThoughts: true },
      maxOutputTokens: cfg.max_tokens,
      ...(signal ? { abortSignal: signal } : {}),
    },
  };
}

/** what the route streams to the client (the same events a Claude turn produces) */
export type TurnEvent = { t: "text" | "thinking"; d: string } | { t: "tool"; id: string; name: string };

/** a Claude-shaped final message, so the client appends Gemini turns to the same history */
export interface ClaudeShapedMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Block[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  stop_sequence: null;
  usage: Usage & { input_tokens: number; output_tokens: number };
}

const REFUSED = new Set(["SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"]);
const BAD_CALL = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS"]);

let seq = 0;
const newId = () => `toolu_gm${Date.now().toString(36)}${(++seq).toString(36)}`;

/** folds a Gemini stream into route events and, at the end, a Claude-shaped message */
export class GeminiTurn {
  private blocks: Block[] = [];
  private finish?: string;
  private blocked?: string;
  private usageMeta?: GenerateContentResponse["usageMetadata"];
  private version?: string;
  private responseId?: string;

  constructor(
    private model: string,
    private store: SignatureStore = signatures,
  ) {}

  /** one streamed chunk → the events to forward */
  push(chunk: GenerateContentResponse): TurnEvent[] {
    const ev: TurnEvent[] = [];
    if (chunk.usageMetadata) this.usageMeta = chunk.usageMetadata;
    this.version ??= chunk.modelVersion;
    this.responseId ??= chunk.responseId;
    if (chunk.promptFeedback?.blockReason) this.blocked = String(chunk.promptFeedback.blockReason);
    const cand = chunk.candidates?.[0];
    if (cand?.finishReason) this.finish = String(cand.finishReason);
    for (const p of cand?.content?.parts ?? []) {
      if (p.functionCall) {
        const id = newId();
        this.store.set(id, { gid: p.functionCall.id, sig: p.thoughtSignature });
        const name = p.functionCall.name ?? "unknown_tool";
        this.blocks.push({ type: "tool_use", id, name, input: p.functionCall.args ?? {} });
        ev.push({ t: "tool", id, name });
      } else if (p.text) {
        if (p.thought) {
          ev.push({ t: "thinking", d: p.text });
          continue;
        }
        const last = this.blocks[this.blocks.length - 1];
        if (last?.type === "text") last.text = String(last.text) + p.text;
        else this.blocks.push({ type: "text", text: p.text });
        ev.push({ t: "text", d: p.text });
      }
    }
    return ev;
  }

  /** the turn as a Messages API response (throws when Gemini returned a broken tool call) */
  message(): ClaudeShapedMessage {
    if (this.finish && BAD_CALL.has(this.finish)) throw new Error(`Gemini returned an unusable tool call (${this.finish}); please retry.`);
    const content = this.blocks.slice();
    const tools = content.some((b) => b.type === "tool_use");
    const stop: ClaudeShapedMessage["stop_reason"] = this.blocked || (this.finish && REFUSED.has(this.finish)) ? "refusal" : this.finish === "MAX_TOKENS" ? "max_tokens" : tools ? "tool_use" : "end_turn";
    // the history must stay valid for both APIs: an assistant turn always has a non-empty block
    if (!content.length) content.push({ type: "text", text: stop === "refusal" ? "(declined)" : "(no response)" });
    return { id: `msg_gm_${this.responseId ?? Date.now().toString(36)}`, type: "message", role: "assistant", model: this.version || this.model, content, stop_reason: stop, stop_sequence: null, usage: geminiUsage(this.usageMeta) };
  }
}

/** Gemini usage metadata → the Messages API usage fields the spend ledger prices (./models.ts costOf) */
export function geminiUsage(u: GenerateContentResponse["usageMetadata"] | undefined): ClaudeShapedMessage["usage"] {
  const n = (x: number | undefined) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const cached = n(u?.cachedContentTokenCount);
  return {
    input_tokens: Math.max(0, n(u?.promptTokenCount) - cached) + n(u?.toolUsePromptTokenCount),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    // thinking is billed as output
    output_tokens: n(u?.candidatesTokenCount) + n(u?.thoughtsTokenCount),
  };
}

/** the readable message inside a Gemini API error (the SDK nests the JSON body, sometimes twice) */
export function geminiErrorText(e: unknown): string {
  let msg = String((e as Error)?.message ?? e);
  for (let i = 0; i < 3; i++) {
    try {
      const j = JSON.parse(msg) as { error?: { message?: unknown } };
      if (typeof j?.error?.message !== "string") break;
      msg = j.error.message.trim();
    } catch {
      break;
    }
  }
  return msg;
}
