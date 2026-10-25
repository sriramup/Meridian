// Which LLM serves an agent turn, and the turn itself (Node only — imported by
// src/app/api/agent/route.ts, never by client code):
//   plan mode            → Gemini (./gemini.ts translates the Claude-format history and tools), when
//                          GEMINI_API_KEY is set;
//   every other mode     → Claude, as before;
//   Gemini rate-limited  → the same request is retried on Claude before anything has streamed, and
//   (429 / RESOURCE_EXHAUSTED, later plan-mode turns stay on Claude for a cooldown (the error's
//   or a quota error)      retryDelay when it gives one);
//   Gemini overloaded    → the tier's overflow model (Flash-Lite) takes the turn and the overloaded
//   (503 "high demand")    model is skipped for a while; when that is overloaded too, Claude answers.
// Overload is Google's capacity limit rather than ours, and it is frequent on the newest Flash models:
// failing the run would be worse than answering it with another model. The route event names the
// provider and model that answered and, after a fallback to Claude, why, so the run records it.

import type Anthropic from "@anthropic-ai/sdk";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { geminiErrorText, GeminiTurn, signatures, toGeminiRequest, type SignatureStore } from "./gemini";
import type { GeminiTierConfig, TierConfig } from "./models";
import type { SpendLedger } from "./spend";
import type { AgentMode } from "./types";

export type Provider = "claude" | "gemini";

export interface ProviderChoice {
  provider: Provider;
  /** why (route event, logs) */
  reason: string;
  /** Claude stands in for Gemini (cooldown after a rate limit), e.g. "Gemini rate limit" */
  fallback?: string;
}

/** Gemini is skipped until `until` (ms) after a rate limit; an overloaded model until its own time */
export const geminiCooldown: { until: number; kind: GeminiLimit["kind"]; overloaded: Map<string, number> } = { until: 0, kind: "rate limit", overloaded: new Map() };

/** plan mode → Gemini (key set, not cooling down); everything else → Claude */
export function chooseProvider(mode: AgentMode | undefined, env: Record<string, string | undefined> = process.env, now = Date.now(), cooldown = geminiCooldown): ProviderChoice {
  if (mode !== "plan") return { provider: "claude", reason: `${mode ?? "edit"} mode` };
  if (!env.GEMINI_API_KEY) return { provider: "claude", reason: "plan mode; GEMINI_API_KEY not set" };
  if (now < cooldown.until) return { provider: "claude", reason: `plan mode; Gemini ${cooldown.kind}, retrying it in ${Math.ceil((cooldown.until - now) / 1000)}s`, fallback: `Gemini ${cooldown.kind}` };
  return { provider: "gemini", reason: "plan mode" };
}

export interface GeminiLimit {
  kind: "rate limit" | "quota" | "overloaded";
  /** how long Gemini stays skipped */
  cooldownMs: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** a Gemini error that should send the turn to Claude, or null (any other error fails the turn) */
export function geminiLimit(e: unknown): GeminiLimit | null {
  const status = (e as { status?: unknown })?.status;
  const raw = String((e as Error)?.message ?? "");
  // RetryInfo detail: "retryDelay": "37s"
  const retry = /retryDelay\\?"\s*:\s*\\?"(\d+(?:\.\d+)?)s/.exec(raw);
  const retryMs = retry ? Number(retry[1]) * 1000 : null;
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(raw)) {
    const quota = /quota/i.test(raw);
    return { kind: quota ? "quota" : "rate limit", cooldownMs: clamp(retryMs ?? (quota ? 300_000 : 60_000), 5_000, 15 * 60_000) };
  }
  if ((status === 403 || status === 400) && /quota/i.test(raw)) return { kind: "quota", cooldownMs: clamp(retryMs ?? 300_000, 5_000, 15 * 60_000) };
  if (status === 503 || /"UNAVAILABLE"|overloaded|high demand/i.test(raw)) return { kind: "overloaded", cooldownMs: clamp(retryMs ?? 30_000, 5_000, 5 * 60_000) };
  return null;
}

/** the slice of the Anthropic client a turn uses (tests pass a fake) */
export interface ClaudeClient {
  beta: { messages: { stream(params: Anthropic.Beta.MessageCreateParamsStreaming, opts?: { signal?: AbortSignal }): AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> & { finalMessage(): Promise<Anthropic.Beta.BetaMessage> } } };
}
/** the slice of the Google GenAI client a turn uses (tests pass a fake) */
export interface GeminiClient {
  models: { generateContentStream(params: GenerateContentParameters): Promise<AsyncIterable<GenerateContentResponse>> };
}

export interface TurnInput {
  choice: ProviderChoice;
  claude: ClaudeClient | null;
  gemini: GeminiClient | null;
  /** Messages API params from ./request.ts buildRequest */
  params: Record<string, unknown>;
  cfg: TierConfig;
  gcfg: GeminiTierConfig;
  tier: string;
  ledger: SpendLedger;
  ticket: number;
  /** prompt size for the interrupted-turn estimate */
  promptChars: number;
  signal?: AbortSignal;
  send: (o: unknown) => void;
  now?: () => number;
  cooldown?: typeof geminiCooldown;
  store?: SignatureStore;
}

/**
 * Stream one model turn to `send` as NDJSON-ready objects: route, text / thinking / tool deltas, then
 * final (the message and its cost) or error. Books the cost in the ledger in every case.
 */
export async function serveTurn(x: TurnInput): Promise<void> {
  const { send, ledger: L } = x;
  const now = x.now ?? Date.now;
  const cooldown = x.cooldown ?? geminiCooldown;
  let provider: Provider = "claude";
  let model = x.cfg.model;
  let streamed = 0;
  let committed = false;
  try {
    let fallback = x.choice.fallback;
    if (x.choice.provider === "gemini" && x.gemini) {
      const models = [x.gcfg.model, x.gcfg.overflow].filter((m, i, a): m is string => !!m && a.indexOf(m) === i);
      const ready = models.filter((m) => !((cooldown.overloaded.get(m) ?? 0) > now()));
      if (!ready.length) fallback = "Gemini overloaded";
      let lastErr: unknown = null;
      for (const m of ready) {
        provider = "gemini";
        model = m;
        const gcfg = { ...x.gcfg, model: m };
        // the limit errors arrive with the response headers or as the first chunk: until a chunk is
        // in, nothing has reached the client and the turn can still move to another model
        let it: AsyncIterator<GenerateContentResponse> | null = null;
        let first: IteratorResult<GenerateContentResponse> | null = null;
        try {
          it = (await x.gemini.models.generateContentStream(toGeminiRequest(x.params, gcfg, x.signal, x.store ?? signatures)))[Symbol.asyncIterator]();
          first = await it.next();
        } catch (e) {
          const lim = x.signal?.aborted ? null : geminiLimit(e);
          if (!lim) throw e;
          lastErr = e;
          console.warn(`[agent] Gemini ${lim.kind} on ${m} (${geminiErrorText(e).slice(0, 160)}); skipping it for ${Math.round(lim.cooldownMs / 1000)}s`);
          if (lim.kind === "overloaded") {
            cooldown.overloaded.set(m, now() + lim.cooldownMs);
            fallback = "Gemini overloaded";
            continue;
          }
          cooldown.until = now() + lim.cooldownMs;
          cooldown.kind = lim.kind;
          fallback = `Gemini ${lim.kind}`;
          break;
        }
        const reason = m === x.gcfg.model ? x.choice.reason : `${x.choice.reason}; ${x.gcfg.model} overloaded`;
        send({ t: "route", provider: "gemini", model, effort: gcfg.thinkingLevel.toLowerCase(), tier: x.tier, reason });
        const turn = new GeminiTurn(model, x.store ?? signatures);
        for (let r = first; !r.done; r = await it.next()) {
          for (const ev of turn.push(r.value)) {
            streamed += ev.t === "tool" ? ev.name.length : ev.d.length;
            send(ev);
          }
        }
        const final = turn.message();
        const usd = L.commit(x.ticket, final.model, final.usage, x.tier);
        committed = true;
        send({ t: "final", message: final, cost: { usd, total_usd: L.total, cap_usd: L.cap } });
        return;
      }
      if (!x.claude && lastErr) throw lastErr;
    }
    provider = "claude";
    model = x.cfg.model;
    if (!x.claude) throw new Error("ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart.");
    send({ t: "route", provider: "claude", model, effort: x.cfg.effort, tier: x.tier, reason: x.choice.provider === "gemini" && fallback ? `${fallback}; Claude answered` : x.choice.reason, ...(fallback ? { fallback } : {}) });
    const s = x.claude.beta.messages.stream(x.params as unknown as Anthropic.Beta.MessageCreateParamsStreaming, { signal: x.signal });
    for await (const ev of s) {
      if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") send({ t: "tool", id: ev.content_block.id, name: ev.content_block.name });
      else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") {
          streamed += ev.delta.text.length;
          send({ t: "text", d: ev.delta.text });
        } else if (ev.delta.type === "thinking_delta") {
          streamed += ev.delta.thinking.length;
          send({ t: "thinking", d: ev.delta.thinking });
        } else if (ev.delta.type === "input_json_delta") streamed += ev.delta.partial_json.length;
      }
    }
    const final = await s.finalMessage();
    const usd = L.commit(x.ticket, final.model || model, final.usage as never, x.tier);
    committed = true;
    send({ t: "final", message: final, cost: { usd, total_usd: L.total, cap_usd: L.cap } });
  } catch (e) {
    const err = e as Error & { status?: number };
    send({ t: "error", message: provider === "gemini" ? `Gemini: ${geminiErrorText(e)}` : err.message, status: err.status });
  } finally {
    if (!committed) {
      // stopped or failed mid-stream: what was generated is billed but its usage never arrived,
      // so book an estimate (prompt once + the streamed characters as output) instead of nothing
      if (streamed > 0) L.commit(x.ticket, model, { input_tokens: Math.round(x.promptChars / 3.5), output_tokens: Math.round(streamed / 3) }, `${x.tier}:interrupted`);
      else L.release(x.ticket);
    }
  }
}
