import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { costOf, tierConfig, tierModels } from "@/agent/models";
import { capFromEnv, SpendLedger } from "@/agent/spend";

const tmp = () => join(mkdtempSync(join(tmpdir(), "meridian-spend-")), "spend.json");

describe("pricing", () => {
  it("prices Haiku 5.5 input, output, cache writes and reads", () => {
    // 10k uncached in, 2k out, 20k cache write (5 min), 50k cache read (prompt under 100K)
    const usd = costOf("claude-haiku-5-5", { input_tokens: 10_000, output_tokens: 2_000, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 50_000 });
    const expected = (10_000 * 0.1 + 2_000 * 0.5 + 20_000 * 0.125 + 50_000 * 0.01) / 1e6;
    expect(usd).toBeCloseTo(expected, 10);
  });
  it("applies the long-prompt rate card above 100K prompt tokens", () => {
    const usd = costOf("claude-haiku-5-5", { input_tokens: 150_000, output_tokens: 1000 });
    expect(usd).toBeCloseTo((150_000 * 0.5 + 1000 * 2.5) / 1e6, 10);
  });
  it("prices 1-hour cache writes at 2x input", () => {
    const usd = costOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000 } });
    expect(usd).toBeCloseTo((1000 * 4) / 1e6, 10);
  });
  it("sums usage.iterations (compaction / fallback passes) at each pass's model", () => {
    const usd = costOf("claude-opus-5-5", {
      input_tokens: 1,
      output_tokens: 1,
      iterations: [
        { type: "compaction", input_tokens: 50_000, output_tokens: 2_000 },
        { type: "message", model: "claude-opus-4-8", input_tokens: 1_000, output_tokens: 500 },
      ],
    });
    expect(usd).toBeCloseTo((50_000 * 4 + 2_000 * 20) / 1e6 + (1_000 * 5 + 500 * 25) / 1e6, 10);
  });
  it("prices unknown models high so the cap errs on the safe side", () => {
    expect(costOf("claude-something-new", { input_tokens: 1e6, output_tokens: 0 })).toBeGreaterThanOrEqual(5);
  });
});

describe("tier configuration", () => {
  it("defaults every tier to Haiku 5.5 without refusal fallbacks", () => {
    for (const t of ["quick", "standard", "deep"] as const) {
      const c = tierConfig(t, {});
      expect(c.model).toBe("claude-haiku-5-5");
      expect(c.fallbacks).toBe(false);
      expect(c.thinking.type).toBe("adaptive");
    }
    expect(tierConfig("quick", {}).effort).toBe("low");
    expect(tierConfig("deep", {}).effort).toBe("high");
    expect(tierConfig("quick", {}).max_tokens).toBeLessThan(tierConfig("deep", {}).max_tokens);
  });
  it("takes per-tier overrides; Sonnet 5.5 gets the server-side fallback", () => {
    const env = { MERIDIAN_MODEL_DEEP: "claude-sonnet-5-5" };
    expect(tierModels(env)).toEqual({ quick: "claude-haiku-5-5", standard: "claude-haiku-5-5", deep: "claude-sonnet-5-5" });
    expect(tierConfig("deep", env).fallbacks).toBe(true);
    expect(tierConfig("quick", { MERIDIAN_MODEL_QUICK: "claude-sonnet-5-5" }).thinking.type).toBe("between_tools");
  });
});

describe("spend ledger", () => {
  it("records real cost from usage and persists it", () => {
    const path = tmp();
    const L = new SpendLedger({ path, cap: 2 });
    const r = L.reserve(0.01);
    expect(r.ok).toBe(true);
    const usd = L.commit(r.ok ? r.ticket : null, "claude-haiku-5-5", { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10_000 }, "standard");
    expect(usd).toBeCloseTo((1000 * 0.1 + 1000 * 0.5 + 10_000 * 0.01) / 1e6, 10);
    const disk = JSON.parse(readFileSync(path, "utf8"));
    expect(disk.total_usd).toBeCloseTo(usd, 10);
    expect(disk.requests).toBe(1);
    expect(disk.recent[0]).toMatchObject({ model: "claude-haiku-5-5", tier: "standard", cache_read: 10_000 });
    // a new process sees the same total
    expect(new SpendLedger({ path, cap: 2 }).total).toBeCloseTo(usd, 10);
  });

  it("refuses once the cap is reached", () => {
    const L = new SpendLedger({ path: tmp(), cap: 0.05 });
    // $0.06 of output on Sonnet: over the cap
    L.commit(null, "claude-sonnet-5-5", { input_tokens: 0, output_tokens: 6000 });
    const r = L.reserve(0.0001);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/spend cap reached/i);
  });

  it("counts in-flight reservations so concurrent requests cannot overshoot together", () => {
    const L = new SpendLedger({ path: tmp(), cap: 0.1 });
    const a = L.reserve(0.06);
    const b = L.reserve(0.06);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (a.ok) L.release(a.ticket);
    expect(L.reserve(0.06).ok).toBe(true);
  });

  it("estimates a worst case from prompt size and max_tokens", () => {
    const e = SpendLedger.estimate("claude-haiku-5-5", 300_000, 16_000);
    expect(e).toBeCloseTo((100_000 * 0.1 + 16_000 * 0.5) / 1e6, 10);
  });

  it("reads the cap from the environment", () => {
    expect(capFromEnv({ MERIDIAN_SPEND_CAP_USD: "1.5" })).toBe(1.5);
    expect(capFromEnv({ MERIDIAN_SPEND_CAP_USD: "off" })).toBe(null);
    expect(capFromEnv({ NODE_ENV: "development" })).toBe(2);
    expect(capFromEnv({ NODE_ENV: "production" })).toBe(null);
  });
});
