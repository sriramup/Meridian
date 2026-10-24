import Anthropic from "@anthropic-ai/sdk";
import { systemPromptFor } from "@/agent/prompt";
import { TOOL_DEFS } from "@/agent/toolDefs";
import type { Tier } from "@/agent/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Model per request tier (src/agent/router.ts picks the tier on the client).
 * quick: Claude Sonnet 5.5 at low effort with thinking off between tool calls — direct answers in
 * about a second. standard / deep: Claude Opus 5.5 at medium / high effort with adaptive thinking.
 * Caches are model-scoped, so tools + system (identical for every session of a city) are cached once
 * per model; a session's history cache is reused while consecutive turns stay on one model.
 */
const MAIN = process.env.MERIDIAN_MODEL ?? "claude-opus-5-5";
const QUICK = process.env.MERIDIAN_MODEL_QUICK ?? "claude-sonnet-5-5";
const TIERS: Record<Tier, { model: string; effort: "low" | "medium" | "high" | "xhigh"; thinking: Record<string, unknown> }> = {
  quick: { model: QUICK, effort: "low", thinking: { type: "between_tools" } },
  standard: { model: MAIN, effort: "medium", thinking: { type: "adaptive", display: "summarized" } },
  deep: { model: MAIN, effort: "high", thinking: { type: "adaptive", display: "summarized" } },
};

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  // explicit base URL so a host-level ANTHROPIC_BASE_URL meant for other tools is not picked up
  return new Anthropic({ apiKey, baseURL: process.env.MERIDIAN_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" });
}

export async function GET() {
  return Response.json({ configured: !!process.env.ANTHROPIC_API_KEY, model: MAIN, models: { quick: QUICK, standard: MAIN, deep: MAIN } });
}

// one deterministic tool list for every mode and tier, so the tools + system prefix stays cached
// (plan mode is enforced by the executor and told to the model in the turn, not by hiding tools)
const tools = TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true })) as unknown as Anthropic.Beta.BetaTool[];

export async function POST(req: Request) {
  const c = client();
  if (!c) return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart." }, { status: 503 });
  const body = (await req.json()) as { messages: Anthropic.Beta.BetaMessageParam[]; tier?: Tier; effort?: "low" | "medium" | "high" | "xhigh"; city?: string };
  const tier = TIERS[body.tier ?? "standard"] ?? TIERS.standard;
  // an explicit effort (old agent panel's selector) overrides the tier's on the main model
  const effort = body.effort && body.tier === undefined ? body.effort : tier.effort;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        send({ t: "route", model: tier.model, effort });
        const s = c.beta.messages.stream(
          {
            model: tier.model,
            max_tokens: 32000,
            // server-side compaction keeps long planning sessions inside the context window;
            // the client appends full assistant content, so compaction blocks are passed back
            betas: ["server-side-fallback-2026-07-01", "compact-2026-01-12"],
            context_management: { edits: [{ type: "compact_20260112" }] },
            fallbacks: "default",
            thinking: tier.thinking,
            output_config: { effort },
            cache_control: { type: "ephemeral" },
            system: [{ type: "text", text: systemPromptFor(body.city === "sandbox" ? "sandbox" : "austin"), cache_control: { type: "ephemeral" } }],
            tools,
            messages: body.messages,
          } as unknown as Anthropic.Beta.MessageCreateParamsStreaming,
          { signal: req.signal },
        );
        for await (const ev of s) {
          if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") send({ t: "tool", id: ev.content_block.id, name: ev.content_block.name });
          else if (ev.type === "content_block_delta") {
            if (ev.delta.type === "text_delta") send({ t: "text", d: ev.delta.text });
            else if (ev.delta.type === "thinking_delta") send({ t: "thinking", d: ev.delta.thinking });
          }
        }
        const final = await s.finalMessage();
        send({ t: "final", message: final });
      } catch (e) {
        const err = e as Error & { status?: number };
        send({ t: "error", message: err.message, status: err.status ?? (err instanceof Anthropic.APIError ? err.status : undefined) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
