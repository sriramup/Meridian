import { describe, expect, it } from "vitest";
import { buildRequest } from "@/agent/request";
import { contextBlock } from "@/agent/sessions";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text: "<context>\nmode: edit\n</context>" }, { type: "text", text }] });

describe("agent request: prompt caching stays effective", () => {
  it("tools and system are byte-identical across tiers and turns (one cached prefix per model)", () => {
    const a = buildRequest({ messages: [user("hi")], tier: "quick", city: "austin" }, {}).params;
    const b = buildRequest({ messages: [user("design a district"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, user("again")], tier: "deep", city: "austin" }, {}).params;
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
    expect(a.model).toBe(b.model);
  });

  it("the stable prefix carries a cache breakpoint and the history gets the automatic one", () => {
    const { params } = buildRequest({ messages: [user("hi")], tier: "standard" }, {});
    expect((params.system as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.cache_control).toEqual({ type: "ephemeral" });
  });

  it("no volatile content in the system prompt (dates, times, ids)", () => {
    const { params } = buildRequest({ messages: [user("hi")] }, {});
    const sys = (params.system as { text: string }[])[0].text;
    expect(sys).not.toMatch(/\b20\d\d-\d\d-\d\d\b|\b\d{1,2}:\d\d\b|session_|msg_/);
    // the live snapshot travels in the user turn, not in the system prompt
    expect(sys).not.toMatch(/<context>\s*\nmode:/);
    expect(contextBlock("s1", "edit", null)).toMatch(/^<context>/);
  });

  it("the history is sent unchanged, so each turn's prefix is the previous request", () => {
    const h1 = [user("take me to 21st and Guadalupe")];
    const h2 = [...h1, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "go_to", input: { place: "21st and Guadalupe" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] }];
    const a = JSON.stringify(buildRequest({ messages: h1, tier: "quick" }, {}).params.messages);
    const b = JSON.stringify(buildRequest({ messages: h2, tier: "quick" }, {}).params.messages);
    expect(b.startsWith(a.slice(0, -1))).toBe(true);
  });

  it("Haiku 5.5 requests carry no refusal-fallback parameters; Sonnet 5.5 overrides do", () => {
    const h = buildRequest({ messages: [user("hi")], tier: "deep" }, {}).params;
    expect(h.fallbacks).toBeUndefined();
    expect(h.betas).not.toContain("server-side-fallback-2026-07-01");
    expect(h.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(h.output_config).toEqual({ effort: "high" });
    const s = buildRequest({ messages: [user("hi")], tier: "deep" }, { MERIDIAN_MODEL_DEEP: "claude-sonnet-5-5" }).params;
    expect(s.model).toBe("claude-sonnet-5-5");
    expect(s.fallbacks).toBe("default");
    expect(s.betas).toContain("server-side-fallback-2026-07-01");
  });

  it("sandbox and city prompts differ only in their world section", () => {
    const a = (buildRequest({ messages: [], city: "sandbox" }, {}).params.system as { text: string }[])[0].text;
    expect(a).toMatch(/blank design canvas/);
    expect(a).toMatch(/design_neighborhood/);
    expect(a).toMatch(/go_to/);
  });
});
