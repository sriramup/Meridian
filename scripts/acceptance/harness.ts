// Acceptance harness: drives the agent's tool executor (the exact code path the
// in-app agent uses) headlessly against the city pack. Each case composes tools
// the way a planning agent would for one of the spec's example prompts and
// checks that the physical and analytical consequences actually happened.

import { loadHeadless } from "../dev/headless";

export type Status = "pass" | "partial" | "unsupported" | "fail";
export interface CaseResult {
  id: number;
  cat: string;
  prompt: string;
  status: Status;
  evidence: string[];
  gap?: string;
  error?: string;
  ms: number;
  tools: string[];
}
export interface Verdict {
  status?: Exclude<Status, "fail">;
  gap?: string;
}
export interface H {
  run: (tool: string, input?: Record<string, unknown>, opts?: { allowError?: boolean }) => Promise<any>;
  fresh: (name: string) => Promise<void>;
  ev: (...lines: unknown[]) => void;
  expect: (cond: unknown, msg: string) => void;
  R: ReturnType<typeof loadHeadless>;
  ids: (rows: any) => string[];
}
export interface Case {
  id: number;
  cat: string;
  prompt: string;
  run: (h: H) => Promise<Verdict | void>;
  /** cases whose scenario branches this one builds on (pulled into partial runs) */
  deps?: number[];
}

export class Fail extends Error {}

export async function runCases(cases: Case[], only?: Set<number>): Promise<CaseResult[]> {
  const R = loadHeadless();
  const { executeTool } = await import("@/agent/tools");
  const ctx = { requestApproval: async () => true, approvals: false };
  const out: CaseResult[] = [];
  for (const c of cases) {
    if (only && !only.has(c.id)) continue;
    const evidence: string[] = [];
    const tools: string[] = [];
    const h: H = {
      R,
      async run(tool, input = {}, opts = {}) {
        tools.push(tool);
        const r: any = await executeTool(tool, input, ctx);
        if (r.isError && !opts.allowError) throw new Fail(`${tool} failed: ${JSON.stringify(r.content).slice(0, 400)}`);
        if (r.content?.rejected) throw new Fail(`${tool} rejected`);
        return r.content;
      },
      async fresh(name) {
        await h.run("scenario", { action: "switch", id: "baseline" });
        await h.run("scenario", { action: "branch", name });
      },
      ev: (...lines) => evidence.push(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join(" ")),
      expect(cond, msg) {
        if (!cond) throw new Fail(`expectation failed: ${msg}`);
      },
      ids: (rows) => (Array.isArray(rows) ? rows : rows?.rows ?? []).map((r: any) => r.id),
    };
    const t = performance.now();
    let res: CaseResult;
    try {
      const v = (await c.run(h)) ?? {};
      res = { id: c.id, cat: c.cat, prompt: c.prompt, status: v.status ?? "pass", gap: v.gap, evidence, ms: performance.now() - t, tools };
    } catch (e) {
      res = { id: c.id, cat: c.cat, prompt: c.prompt, status: "fail", error: (e as Error).message, evidence, ms: performance.now() - t, tools };
    }
    out.push(res);
    const mark = { pass: "✓", partial: "◐", unsupported: "○", fail: "✕" }[res.status];
    console.log(`${mark} ${String(c.id).padStart(3)} ${c.cat} ${(res.ms / 1000).toFixed(1).padStart(5)}s  ${c.prompt.slice(0, 70)}${res.error ? `\n        ${res.error}` : ""}${res.gap ? `\n        gap: ${res.gap}` : ""}`);
    for (const l of evidence.slice(0, 6)) console.log(`        · ${l.slice(0, 600)}`);
  }
  return out;
}

/** first summary line(s) of a committed change */
export const sum = (r: any, n = 2) => (r?.summary ?? []).slice(0, n).join(" | ");
