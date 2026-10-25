// The Messages API request for one agent turn, built as a pure function so its caching properties can
// be tested without a key (tests/agent-request.test.ts):
//  - tools and system are byte-identical for every tier, mode and session of a city (no dates, ids or
//    state in them), so the prefix tools → system is cached once per model (breakpoint on system);
//  - volatile state (the <context> snapshot, runtime notes) rides in user messages, and the history is
//    append-only, so the automatic top-level breakpoint re-reads every earlier turn from cache.

import { systemPromptFor } from "./prompt";
import { TOOL_DEFS } from "./toolDefs";
import { tierConfig, type Effort, type TierConfig } from "./models";
import type { Tier } from "./router";

export const API_TOOLS = TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true }));

export interface TurnBody {
  messages: unknown[];
  tier?: Tier;
  effort?: Effort;
  city?: string;
}

export function buildRequest(body: TurnBody, env: Record<string, string | undefined> = process.env): { cfg: TierConfig; tier: Tier; params: Record<string, unknown> } {
  const tier: Tier = body.tier && ["quick", "standard", "deep"].includes(body.tier) ? body.tier : "standard";
  // an explicit effort (old agent panel's selector) overrides the tier's
  const cfg = tierConfig(tier, env, body.effort && body.tier === undefined ? body.effort : undefined);
  const betas = ["compact-2026-01-12"];
  if (cfg.fallbacks) betas.push("server-side-fallback-2026-07-01");
  const params: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.max_tokens,
    // server-side compaction keeps long planning sessions inside the context window; the client
    // appends full assistant content, so compaction blocks are passed back
    betas,
    context_management: { edits: [{ type: "compact_20260112" }] },
    // Haiku 5.5 has no server-side refusal fallback; Opus / Sonnet 5.5 overrides get one
    ...(cfg.fallbacks ? { fallbacks: "default" } : {}),
    thinking: cfg.thinking,
    output_config: { effort: cfg.effort },
    cache_control: { type: "ephemeral" },
    system: [{ type: "text", text: systemPromptFor(body.city === "sandbox" ? "sandbox" : "austin"), cache_control: { type: "ephemeral" } }],
    tools: API_TOOLS,
    messages: body.messages,
  };
  return { cfg, tier, params };
}
