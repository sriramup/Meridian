// Model catalogue for the agent: which model serves each request tier, how it is configured, and
// what it costs. Pure data + functions, shared by the server route (src/app/api/agent/route.ts), the
// spend ledger (./spend.ts) and the tests.
//
// Default: Claude Haiku 5.5 on every tier (fast and cheap; adaptive thinking, effort low / medium /
// high). Per-tier overrides: MERIDIAN_MODEL_QUICK / MERIDIAN_MODEL_STANDARD / MERIDIAN_MODEL_DEEP
// (MERIDIAN_MODEL sets standard + deep at once), e.g. MERIDIAN_MODEL_DEEP=claude-sonnet-5-5 for
// heavier design work.

import type { Tier } from "./router";

export type Effort = "low" | "medium" | "high" | "xhigh";

/** USD per million tokens */
export interface Price {
  input: number;
  output: number;
  /** cache read, 5-minute cache write, 1-hour cache write (multipliers of input when omitted) */
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** a higher rate card for long prompts (Haiku 5.5: prompts over 100K tokens) */
  long?: { above: number; input: number; output: number };
}

/** first-party Claude API prices (2026-10); unknown models are priced as Opus so the cap errs high */
export const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, long: { above: 100_000, input: 0.5, output: 2.5 } },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};
const UNKNOWN: Price = { input: 10, output: 50 };

export function priceOf(model: string): Price {
  if (PRICES[model]) return PRICES[model];
  // tolerate provider prefixes / suffixes ("anthropic.claude-haiku-5-5", "claude-haiku-5-5[1m]")
  const k = Object.keys(PRICES).find((id) => model.includes(id));
  return k ? PRICES[k] : UNKNOWN;
}

/** the usage fields the Messages API reports (top level, or per entry of usage.iterations) */
export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  iterations?: (Usage & { model?: string; type?: string })[] | null;
}

const n = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** cost of one sampling pass in USD */
function passCost(model: string, u: Usage): number {
  const p = priceOf(model);
  const input = n(u.input_tokens);
  const read = n(u.cache_read_input_tokens);
  const write = n(u.cache_creation_input_tokens);
  const w1h = Math.min(write, n(u.cache_creation?.ephemeral_1h_input_tokens));
  const w5m = write - w1h;
  const prompt = input + read + write;
  const card = p.long && prompt > p.long.above ? { ...p, input: p.long.input, output: p.long.output, cacheRead: undefined, cacheWrite5m: undefined, cacheWrite1h: undefined } : p;
  const inRate = card.input;
  return (
    (input * inRate + read * (card.cacheRead ?? inRate * 0.1) + w5m * (card.cacheWrite5m ?? inRate * 1.25) + w1h * (card.cacheWrite1h ?? inRate * 2) + n(u.output_tokens) * card.output) / 1e6
  );
}

/**
 * Real cost of a response from its usage. When the response itemises server-side passes
 * (usage.iterations: compaction, refusal fallbacks) those are summed instead of the top level, which
 * covers only the pass that produced the returned message; each pass is priced at its own model.
 */
export function costOf(model: string, u: Usage | null | undefined): number {
  if (!u) return 0;
  if (Array.isArray(u.iterations) && u.iterations.length) return u.iterations.reduce((s, it) => s + passCost(it.model ?? model, it), 0);
  return passCost(model, u);
}

export interface TierConfig {
  model: string;
  effort: Effort;
  thinking: Record<string, unknown>;
  max_tokens: number;
  /** server-side refusal fallback (Opus 5.5 / Sonnet 5.5 only; Haiku 5.5 has none) */
  fallbacks: boolean;
}

const DEFAULT_MODEL = "claude-haiku-5-5";
const EFFORT: Record<Tier, Effort> = { quick: "low", standard: "medium", deep: "high" };
// output ceilings per request (thinking counts toward them): enough for a long design turn's tool
// inputs, small enough that one runaway response stays cheap
const MAX_TOKENS: Record<Tier, number> = { quick: 4096, standard: 16000, deep: 32000 };

export function supportsFallbacks(model: string): boolean {
  return /claude-(opus-5-5|sonnet-5-5|fable-5-1|opus-5)(\b|$)/.test(model);
}

/** env → model per tier */
export function tierModels(env: Record<string, string | undefined> = process.env): Record<Tier, string> {
  const main = env.MERIDIAN_MODEL;
  return {
    quick: env.MERIDIAN_MODEL_QUICK || DEFAULT_MODEL,
    standard: env.MERIDIAN_MODEL_STANDARD || main || DEFAULT_MODEL,
    deep: env.MERIDIAN_MODEL_DEEP || main || DEFAULT_MODEL,
  };
}

/** full request settings for a tier (an explicit effort overrides the tier's) */
export function tierConfig(tier: Tier, env: Record<string, string | undefined> = process.env, effort?: Effort): TierConfig {
  const model = tierModels(env)[tier] ?? DEFAULT_MODEL;
  const e = effort ?? EFFORT[tier];
  // Sonnet 5.5 is the one model with thinking that switches off between tool calls; elsewhere
  // adaptive thinking (low effort lets the model skip it on simple turns). Summaries feed the pane.
  const thinking = /sonnet-5-5/.test(model) && tier === "quick" ? { type: "between_tools" } : { type: "adaptive", display: "summarized" };
  return { model, effort: e, thinking, max_tokens: MAX_TOKENS[tier], fallbacks: supportsFallbacks(model) };
}

/** agent loop bound: model turns per request, per tier */
export const MAX_STEPS: Record<Tier, number> = { quick: 6, standard: 30, deep: 45 };
