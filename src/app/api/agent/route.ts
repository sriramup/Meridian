import Anthropic from "@anthropic-ai/sdk";
import { systemPromptFor } from "@/agent/prompt";
import { TOOL_DEFS } from "@/agent/toolDefs";
import type { Tier } from "@/agent/router";
import { tierConfig, tierModels, type Effort } from "@/agent/models";
import { ledger, SpendLedger } from "@/agent/spend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One request = one model turn of the client-side agent loop (src/agent/sessions.ts runs the tools in
 * the browser and calls back with their results). The tier (src/agent/router.ts) picks model, effort,
 * thinking and the output ceiling (src/agent/models.ts): Claude Haiku 5.5 on every tier by default,
 * with MERIDIAN_MODEL_QUICK / _STANDARD / _DEEP overrides.
 *
 * Caching: tools and system are byte-identical for every session of a city and every tier, so they
 * are cached once per model (explicit breakpoint on the system block); the automatic top-level
 * breakpoint caches the growing message history, so each turn re-reads the previous turns from cache.
 * Volatile state (the <context> snapshot) travels in the user message, after the cached prefix.
 *
 * Spend: every response is priced from its usage and recorded in the ledger (src/agent/spend.ts);
 * a request whose worst case would cross MERIDIAN_SPEND_CAP_USD is refused before it is sent.
 */

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  // explicit base URL so a host-level ANTHROPIC_BASE_URL meant for other tools is not picked up
  return new Anthropic({ apiKey, baseURL: process.env.MERIDIAN_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" });
}

export async function GET() {
  const models = tierModels();
  const L = ledger();
  L.refresh();
  return Response.json({ configured: !!process.env.ANTHROPIC_API_KEY, model: models.standard, models, spend: L.snapshot() });
}

// one deterministic tool list for every mode and tier, so the tools + system prefix stays cached
// (plan mode is enforced by the executor and told to the model in the turn, not by hiding tools)
const tools = TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true })) as unknown as Anthropic.Beta.BetaTool[];
const TOOLS_CHARS = JSON.stringify(tools).length;

export async function POST(req: Request) {
  const c = client();
  if (!c) return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart." }, { status: 503 });
  const body = (await req.json()) as { messages: Anthropic.Beta.BetaMessageParam[]; tier?: Tier; effort?: Effort; city?: string };
  const tierName: Tier = body.tier && ["quick", "standard", "deep"].includes(body.tier) ? body.tier : "standard";
  // an explicit effort (old agent panel's selector) overrides the tier's
  const cfg = tierConfig(tierName, process.env, body.effort && body.tier === undefined ? body.effort : undefined);
  const system = systemPromptFor(body.city === "sandbox" ? "sandbox" : "austin");

  const L = ledger();
  const promptChars = JSON.stringify(body.messages).length + system.length + TOOLS_CHARS;
  const r = L.reserve(SpendLedger.estimate(cfg.model, promptChars, cfg.max_tokens));
  if (!r.ok) return Response.json({ error: r.message, spend: L.snapshot() }, { status: 402 });
  const ticket = r.ticket;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      let committed = false;
      let streamed = 0;
      try {
        send({ t: "route", model: cfg.model, effort: cfg.effort, tier: tierName });
        const betas = ["compact-2026-01-12"];
        if (cfg.fallbacks) betas.push("server-side-fallback-2026-07-01");
        const s = c.beta.messages.stream(
          {
            model: cfg.model,
            max_tokens: cfg.max_tokens,
            // server-side compaction keeps long planning sessions inside the context window;
            // the client appends full assistant content, so compaction blocks are passed back
            betas,
            context_management: { edits: [{ type: "compact_20260112" }] },
            // Haiku 5.5 has no server-side refusal fallback; Opus / Sonnet 5.5 overrides get one
            ...(cfg.fallbacks ? { fallbacks: "default" } : {}),
            thinking: cfg.thinking,
            output_config: { effort: cfg.effort },
            cache_control: { type: "ephemeral" },
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            tools,
            messages: body.messages,
          } as unknown as Anthropic.Beta.MessageCreateParamsStreaming,
          { signal: req.signal },
        );
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
        const usd = L.commit(ticket, final.model || cfg.model, final.usage as never, tierName);
        committed = true;
        send({ t: "final", message: final, cost: { usd, total_usd: L.total, cap_usd: L.cap } });
      } catch (e) {
        const err = e as Error & { status?: number };
        send({ t: "error", message: err.message, status: err.status ?? (err instanceof Anthropic.APIError ? err.status : undefined) });
      } finally {
        if (!committed) {
          // stopped or failed mid-stream: what was generated is billed but its usage never arrived,
          // so book an estimate (prompt once + the streamed characters as output) instead of nothing
          if (streamed > 0) L.commit(ticket, cfg.model, { input_tokens: Math.round(promptChars / 3.5), output_tokens: Math.round(streamed / 3) }, `${tierName}:interrupted`);
          else L.release(ticket);
        }
        try {
          controller.close();
        } catch {
          // already closed by an aborted client
        }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
