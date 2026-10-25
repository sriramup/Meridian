import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { geminiModels, geminiTierConfig, tierModels } from "@/agent/models";
import { chooseProvider, serveTurn, type ClaudeClient, type GeminiClient } from "@/agent/providers";
import { API_TOOLS, buildRequest, type TurnBody } from "@/agent/request";
import { ledger, SpendLedger } from "@/agent/spend";
import type { AgentMode } from "@/agent/types";

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
 *
 * Provider (src/agent/providers.ts): plan-mode turns go to Gemini when GEMINI_API_KEY is set, with the
 * Claude-format request translated (src/agent/gemini.ts) so the stream keeps its shape; a Gemini rate
 * limit retries the turn on Claude. Every other mode is Claude. MERIDIAN_GEMINI_BASE_URL points the
 * Gemini client at the dev mock (scripts/dev/mock-anthropic.mjs).
 */

function claude(): ClaudeClient | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  // explicit base URL so a host-level ANTHROPIC_BASE_URL meant for other tools is not picked up
  return new Anthropic({ apiKey, baseURL: process.env.MERIDIAN_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" }) as unknown as ClaudeClient;
}

let geminiClient: { key: string; client: GeminiClient } | null = null;
function gemini(): GeminiClient | null {
  // read here, server-side only: the key never reaches a client bundle (no NEXT_PUBLIC_ prefix)
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (geminiClient?.key !== apiKey) {
    const baseUrl = process.env.MERIDIAN_GEMINI_BASE_URL;
    geminiClient = { key: apiKey, client: new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) }) };
  }
  return geminiClient.client;
}

export async function GET() {
  const models = tierModels();
  const L = ledger();
  L.refresh();
  const plan = chooseProvider("plan");
  return Response.json({
    configured: !!process.env.ANTHROPIC_API_KEY,
    model: models.standard,
    models,
    plan: { provider: plan.provider, reason: plan.reason, models: plan.provider === "gemini" ? geminiModels() : models },
    spend: L.snapshot(),
  });
}

const TOOLS_CHARS = JSON.stringify(API_TOOLS).length;

export async function POST(req: Request) {
  const body = (await req.json()) as TurnBody & { mode?: AgentMode };
  const choice = chooseProvider(body.mode);
  const c = claude();
  if (!c && choice.provider === "claude") return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart." }, { status: 503 });
  const { cfg, tier: tierName, params } = buildRequest(body);
  const gcfg = geminiTierConfig(tierName, process.env, body.effort && body.tier === undefined ? body.effort : undefined);
  const system = (params.system as { text: string }[])[0].text;

  const L = ledger();
  const promptChars = JSON.stringify(body.messages).length + system.length + TOOLS_CHARS;
  // a Gemini turn may fall back to Claude: reserve the dearer of the two
  const worst = Math.max(SpendLedger.estimate(cfg.model, promptChars, cfg.max_tokens), choice.provider === "gemini" ? SpendLedger.estimate(gcfg.model, promptChars, gcfg.max_tokens) : 0);
  const r = L.reserve(worst);
  if (!r.ok) return Response.json({ error: r.message, spend: L.snapshot() }, { status: 402 });
  const ticket = r.ticket;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        await serveTurn({ choice, claude: c, gemini: choice.provider === "gemini" ? gemini() : null, params, cfg, gcfg, tier: tierName, ledger: L, ticket, promptChars, signal: req.signal, send });
      } finally {
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
