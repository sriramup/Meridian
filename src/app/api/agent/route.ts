import Anthropic from "@anthropic-ai/sdk";
import { tierModels } from "@/agent/models";
import { API_TOOLS, buildRequest, type TurnBody } from "@/agent/request";
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

const TOOLS_CHARS = JSON.stringify(API_TOOLS).length;

export async function POST(req: Request) {
  const c = client();
  if (!c) return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart." }, { status: 503 });
  const body = (await req.json()) as TurnBody;
  const { cfg, tier: tierName, params } = buildRequest(body);
  const system = (params.system as { text: string }[])[0].text;

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
        const s = c.beta.messages.stream(
          params as unknown as Anthropic.Beta.MessageCreateParamsStreaming,
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
