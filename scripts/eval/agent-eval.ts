// Agent eval harness: runs realistic requests through the real agent loop in the browser (tools execute
// client-side), against whatever the dev server is configured with — the real API when a key is set,
// or the mock (scripts/dev/mock-anthropic.mjs). Strictly budgeted: the server's spend ledger
// (GET /api/agent → spend) is read before and after every case, the running cost is printed, and the run
// stops before a case whose worst case would cross --budget (the server's MERIDIAN_SPEND_CAP_USD is the
// hard backstop).
//
// Usage (dev server running, e.g. `npx next dev -p 3102`):
//   npx tsx scripts/eval/agent-eval.ts [--url http://localhost:3102] [--budget 0.50] [--cases nav,design]
//                                      [--self-play] [--out .scratch/eval] [--no-shots]
//   --cases      comma list of case ids or groups (nav, quick, plan, design); default all
//   --self-play  design cases issue the tool calls a good planner would (DESIGN_SELF_PLAY) through
//                window.__meridianTools.run instead of asking the model: checks the tools are sufficient
//                and produce good results without spending anything
// Output: <out>/<timestamp>/{summary.json, <case>.json (transcript + checks + critique), <case>.png}
//
// Grading is automatic and deliberately simple: tier routing, required / forbidden tools, tool-call
// budget, errors, metric units in user-facing prose, reply length, camera moved (navigation), and for
// design cases the design critique (critique_design when the tool exists, else built-in fabric metrics:
// coverage, building diversity, empty blocks).

import { chromium, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";

type Tier = "quick" | "standard" | "deep";
interface Case {
  id: string;
  group: "nav" | "quick" | "plan" | "design";
  city: "sandbox" | "austin";
  prompt: string;
  mode?: "plan" | "edit";
  expect: { tier?: Tier; tools?: string[]; anyOf?: string[]; forbid?: string[]; maxTools?: number; camera?: boolean; maxWords?: number; noApplied?: boolean };
  /** worst-case spend of the case on the configured models (USD), checked against the remaining budget */
  estimate: number;
  /** design cases: the area to critique ([x0, y0, x1, y1] local metres) */
  area?: [number, number, number, number];
}

const SITE: [number, number, number, number] = [-600, -500, 600, 500];

export const CASES: Case[] = [
  { id: "nav-21st-guadalupe", group: "nav", city: "austin", prompt: "take me to 21st and Guadalupe", expect: { tier: "quick", tools: ["go_to"], maxTools: 2, camera: true, maxWords: 40 }, estimate: 0.02 },
  { id: "nav-university", group: "nav", city: "austin", prompt: "show me the university", expect: { tier: "quick", tools: ["go_to"], maxTools: 2, camera: true, maxWords: 40 }, estimate: 0.02 },
  { id: "nav-typo", group: "nav", city: "austin", prompt: "can you take me to w 21st st & guadelupe?", expect: { tier: "quick", tools: ["go_to"], maxTools: 2, camera: true, maxWords: 40 }, estimate: 0.02 },
  { id: "quick-scenario", group: "quick", city: "austin", prompt: "Which scenario am I on?", expect: { tier: "quick", maxTools: 1, maxWords: 40 }, estimate: 0.02 },
  { id: "plan-bike-lane", group: "plan", city: "austin", mode: "plan", prompt: "Plan a protected bike lane on Guadalupe from MLK to 24th Street and tell me what it costs in parking and lanes.", expect: { anyOf: ["edit_streets", "find_route", "get_feature"], maxTools: 12, noApplied: true, maxWords: 220 }, estimate: 0.12 },
  {
    id: "design-neighbourhood",
    group: "design",
    city: "sandbox",
    prompt:
      "Design a walkable mixed-use neighbourhood for about 6,000 residents on this empty site: a main street with shops, a range of housing types from townhouses to mid-rise apartments, an elementary school, a few parks everyone can walk to, and no empty land left over.",
    expect: { tier: "deep", anyOf: ["design_neighborhood", "generate_district", "create_street"], maxTools: 40, maxWords: 260 },
    estimate: 0.4,
    area: SITE,
  },
  { id: "nav-designed-street", group: "nav", city: "sandbox", prompt: "take me to the school", expect: { tier: "quick", tools: ["go_to"], maxTools: 2, camera: true, maxWords: 40 }, estimate: 0.02 },
];

/**
 * What a good planner does for the design case, as direct tool calls (self-play): size the site to the
 * programme (6,000 residents ≈ 2,400 homes at ~30 homes per gross acre ≈ 80 acres ≈ 570 m square),
 * carry the whole programme in one design_neighborhood call, then check it.
 */
const H = 285;
export const DESIGN_SELF_PLAY: [string, Record<string, unknown>][] = [
  [
    "design_neighborhood",
    {
      area: [[-H, -H], [H, -H], [H, H], [-H, H]],
      population: 6000,
      facilities: [{ kind: "primary_school" }, { kind: "park", count: 3 }, { kind: "cafe", count: 3 }, { kind: "restaurant", count: 2 }, { kind: "grocery" }],
      mix: { residential: 0.85, retail: 0.1, office: 0.05 },
      name: "Self-play Neighborhood",
    },
  ],
  ["critique_design", { area: [[-H, -H], [H, -H], [H, H], [-H, H]], show_issues: true }],
];

// ------------------------------------------------------------------ args

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (k: string) => args.includes(`--${k}`);
const URL = opt("url", "http://localhost:3102")!;
const BUDGET = Number(opt("budget", "0.50"));
const SELF_PLAY = flag("self-play");
const SHOTS = !flag("no-shots");
const pick = (opt("cases") ?? "").split(",").filter(Boolean);
const OUT = path.join(opt("out", ".scratch/eval")!, new Date().toISOString().replace(/[:.]/g, "-"));

async function spend(): Promise<{ total_usd: number; cap_usd: number | null; configured: boolean; models: Record<string, string> }> {
  const j = await (await fetch(`${URL}/api/agent`)).json();
  return { total_usd: j.spend?.total_usd ?? 0, cap_usd: j.spend?.cap_usd ?? null, configured: !!j.configured, models: j.models ?? {} };
}

// ------------------------------------------------------------------ browser

async function openCity(page: Page, city: "sandbox" | "austin") {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForFunction(() => (window as any).__meridianAgent && (window as any).__meridian && (window as any).__meridianTools, null, { timeout: 180_000 });
  const cur = await page.evaluate(() => (window as any).__meridian.cityId);
  if (city !== cur) {
    if (city === "austin") await page.getByText(/open Austin/i).first().click();
    await page.waitForFunction((c) => (window as any).__meridian?.cityId === c && (c === "sandbox" || (window as any).__meridian.world.count("street") > 100), city, { timeout: 300_000 });
  }
  await page.waitForFunction(() => (window as any).__meridianAgent?.createSession && (window as any).__meridianTools, null, { timeout: 120_000 });
  await page.waitForTimeout(4000);
}

const METRIC = /\b\d[\d,.]*\s?(m|km|m²|m2|sq\.? ?m|ha|hectares?|metres?|meters?|km\/h|kph|°C)\b/;

async function runCase(page: Page, c: Case) {
  // the shell re-mounts on a city switch and re-installs the hooks
  await page.waitForFunction(() => (window as any).__meridianAgent?.createSession, null, { timeout: 120_000 });
  const t0 = Date.now();
  const res = await page.evaluate(
    async ({ prompt, mode }) => {
      const A = (window as any).__meridianAgent;
      const map = (window as any).__meridian.map;
      const cam0 = map ? map.getCenter().toArray() : null;
      const id = A.createSession({ mode: mode ?? "edit" });
      await A.send(id, prompt);
      const s = A.agents.getState().sessions[id];
      // camera flights are animated (and slow under software WebGL): wait for the camera to settle
      let cam1 = map ? map.getCenter().toArray() : null;
      for (let k = 0; k < 20 && map; k++) {
        await new Promise((r) => setTimeout(r, 500));
        const c = map.getCenter().toArray();
        if (!map.isMoving() && (Math.abs(c[0] - cam0[0]) > 1e-5 || Math.abs(c[1] - cam0[1]) > 1e-5)) {
          cam1 = c;
          break;
        }
        cam1 = c;
      }
      const calls: { name: string; input: unknown; status: string; title?: string; detail?: string }[] = [];
      let text = "";
      for (const it of s.items)
        if (it.kind === "assistant")
          for (const seg of it.segments) {
            if (seg.type === "tool") calls.push({ name: seg.call.name, input: seg.call.input, status: seg.call.status, title: seg.call.display?.title, detail: seg.call.display?.detail });
            else if (seg.type === "text") text += seg.text;
          }
      const lastText = (() => {
        const a = s.items.filter((i: any) => i.kind === "assistant").pop();
        return a ? a.segments.filter((x: any) => x.type === "text").map((x: any) => x.text).join("") : "";
      })();
      return { status: s.status, lastRun: s.lastRun, calls, text, lastText, notices: s.items.filter((i: any) => i.kind === "notice").map((i: any) => i.text), camMoved: !!(cam0 && cam1 && (Math.abs(cam0[0] - cam1[0]) > 1e-5 || Math.abs(cam0[1] - cam1[1]) > 1e-5)), applied: (window as any).__meridian.scenarios.active.cursor };
    },
    { prompt: c.prompt, mode: c.mode },
  );
  return { ...res, ms: Date.now() - t0 };
}

async function selfPlay(page: Page) {
  const out: { name: string; ok: boolean; title: string; detail?: string }[] = [];
  for (const [name, input] of DESIGN_SELF_PLAY) {
    const r = await page.evaluate(async ([n, i]) => {
      const o = await (window as any).__meridianTools.run(n, i);
      return { ok: !o.isError, title: o.display?.title, detail: o.display?.detail };
    }, [name, input] as const);
    out.push({ name, ...r });
    console.log(`   ${r.ok ? "·" : "✗"} ${name}: ${r.title}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  return out;
}

/** design critique: the critique_design tool when it exists, else built-in fabric metrics */
async function critique(page: Page, area: [number, number, number, number]) {
  return page.evaluate(async (bb) => {
    const ring = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]];
    const T = (window as any).__meridianTools;
    const tool = await T.run("critique_design", { area: ring });
    if (!tool.isError) return { source: "critique_design", ...tool.content };
    const R = (window as any).__meridian;
    const inside = (p: number[]) => p[0] >= bb[0] && p[0] <= bb[2] && p[1] >= bb[1] && p[1] <= bb[3];
    const bs = R.world.all("building").filter((b: any) => inside(b.footprint[0][0]));
    const area = (ring: number[][]) => Math.abs(ring.reduce((s, p, i) => { const q = ring[(i + 1) % ring.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    const site = (bb[2] - bb[0]) * (bb[3] - bb[1]);
    const footprint = bs.reduce((s: number, b: any) => s + area(b.footprint[0]), 0);
    const kinds = new Set(bs.map((b: any) => `${b.use}|${b.floors}|${Math.round(Math.sqrt(area(b.footprint[0])) / 10)}`));
    const uses = new Set(bs.map((b: any) => b.use));
    const parks = R.world.all("area").filter((a: any) => a.type === "park" && inside(a.poly[0][0]));
    // empty land: 50 m cells inside the site with no building, park, street or plaza within 40 m
    const near = (x: number, y: number) =>
      R.world.query([x - 40, y - 40, x + 40, y + 40], ["building", "area", "street"]).length > 0;
    let cells = 0, empty = 0;
    for (let x = bb[0] + 25; x < bb[2]; x += 50) for (let y = bb[1] + 25; y < bb[3]; y += 50) { cells++; if (!near(x, y)) empty++; }
    const homes = bs.reduce((s: number, b: any) => s + (b.units ?? 0), 0);
    return { source: "fallback", buildings: bs.length, distinct_building_types: kinds.size, diversity: bs.length ? Math.round((kinds.size / bs.length) * 100) / 100 : 0, uses: [...uses], coverage: Math.round((footprint / site) * 100) / 100, parks: parks.length, empty_land_share: Math.round((empty / Math.max(1, cells)) * 100) / 100, homes };
  }, area);
}

function grade(c: Case, r: Awaited<ReturnType<typeof runCase>>) {
  const names = r.calls.map((x) => x.name);
  const checks: Record<string, boolean> = {};
  if (c.expect.tier) checks[`tier ${c.expect.tier}`] = r.lastRun?.tier === c.expect.tier;
  for (const t of c.expect.tools ?? []) checks[`uses ${t}`] = names.includes(t);
  if (c.expect.anyOf) checks[`uses one of ${c.expect.anyOf.join("/")}`] = c.expect.anyOf.some((t) => names.includes(t));
  for (const t of c.expect.forbid ?? []) checks[`avoids ${t}`] = !names.includes(t);
  if (c.expect.maxTools !== undefined) checks[`≤ ${c.expect.maxTools} tool calls`] = names.length <= c.expect.maxTools;
  if (c.expect.camera) checks["camera moved"] = r.camMoved;
  if (c.expect.noApplied) checks["nothing applied (plan mode)"] = r.applied === 0;
  if (c.expect.maxWords) checks[`reply ≤ ${c.expect.maxWords} words`] = r.lastText.split(/\s+/).filter(Boolean).length <= c.expect.maxWords;
  checks["no metric units in prose"] = !METRIC.test(r.text);
  checks["finished without error"] = r.status === "idle" && !r.notices.some((n: string) => /error|cap|failed/i.test(n));
  checks["no failed tool calls"] = !r.calls.some((x) => x.status === "error");
  const passed = Object.values(checks).filter(Boolean).length;
  return { checks, score: Math.round((passed / Object.keys(checks).length) * 100) / 100 };
}

// ------------------------------------------------------------------ main

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const s0 = await spend();
  if (!s0.configured) throw new Error(`The dev server at ${URL} has no ANTHROPIC_API_KEY (use the real key, or ANTHROPIC_API_KEY=mock with the mock server).`);
  console.log(`models ${JSON.stringify(s0.models)} · ledger $${s0.total_usd.toFixed(4)}${s0.cap_usd !== null ? ` of cap $${s0.cap_usd.toFixed(2)}` : ""} · eval budget $${BUDGET.toFixed(2)}${SELF_PLAY ? " · self-play design" : ""}`);
  const cases = CASES.filter((c) => !pick.length || pick.includes(c.id) || pick.includes(c.group));
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const results: unknown[] = [];
  let page: Page | null = null;
  let city: string | null = null;
  try {
    for (const c of cases) {
      const s = await spend();
      const used = s.total_usd - s0.total_usd;
      const selfPlayCase = SELF_PLAY && c.group === "design";
      if (!selfPlayCase && used + c.estimate > BUDGET) {
        console.log(`\n⨯ ${c.id}: skipped — eval spend $${used.toFixed(4)} + worst case $${c.estimate.toFixed(2)} would exceed the $${BUDGET.toFixed(2)} budget`);
        results.push({ id: c.id, skipped: "budget" });
        continue;
      }
      if (!page || city !== c.city) {
        await page?.close();
        page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await openCity(page, c.city);
        city = c.city;
      }
      console.log(`\n▸ ${c.id} (${c.city}${c.mode === "plan" ? ", plan mode" : ""}): ${c.prompt}`);
      let record: Record<string, unknown>;
      if (selfPlayCase) {
        const t0 = Date.now();
        const calls = await selfPlay(page);
        record = { id: c.id, selfPlay: true, calls, ms: Date.now() - t0 };
      } else {
        let r: Awaited<ReturnType<typeof runCase>>;
        try {
          r = await runCase(page, c);
        } catch (e) {
          // a crashed tab (software WebGL under memory pressure): record it and start a fresh page
          console.log(`   ✗ ${(e as Error).message.split("\n")[0]}`);
          results.push({ id: c.id, error: (e as Error).message.split("\n")[0] });
          await page.close().catch(() => {});
          page = null;
          continue;
        }
        const g = grade(c, r);
        const after = await spend();
        const cost = after.total_usd - s.total_usd;
        record = { id: c.id, prompt: c.prompt, ...r, ...g, cost_usd: Math.round(cost * 1e5) / 1e5 };
        console.log(`   ${r.lastRun?.tier}/${r.lastRun?.model} · ${r.calls.length} tools [${r.calls.map((x) => x.name).join(", ")}] · ${(r.ms / 1000).toFixed(1)} s · $${cost.toFixed(4)} (run total $${(after.total_usd - s0.total_usd).toFixed(4)})`);
        console.log(`   reply: ${r.lastText.replace(/\s+/g, " ").slice(0, 300)}`);
        for (const [k, v] of Object.entries(g.checks)) if (!v) console.log(`   ✗ ${k}`);
        console.log(`   score ${g.score}`);
      }
      if (c.area) {
        // critique the site the agent actually designed (its design_neighborhood area), else the case's
        const calls = selfPlayCase ? DESIGN_SELF_PLAY.map(([name, input]) => ({ name, input: input as any })) : ((record.calls as { name: string; input: any }[] | undefined) ?? []);
        const designed = calls.filter((x) => x.name === "design_neighborhood" && Array.isArray(x.input?.area)).pop();
        const ring = designed?.input.area as number[][] | undefined;
        const bb: [number, number, number, number] = ring ? [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))] : c.area;
        record.critique = await critique(page, bb);
        console.log(`   critique: ${JSON.stringify(record.critique)}`);
        // the design tool frames its site; give the flight time to land
        await page.waitForTimeout(3500);
      }
      if (SHOTS) await page.screenshot({ path: path.join(OUT, `${c.id}.png`), timeout: 240_000 }).catch((e) => console.log(`   (screenshot failed: ${(e as Error).message.split("\n")[0]})`));
      fs.writeFileSync(path.join(OUT, `${c.id}.json`), JSON.stringify(record, null, 1));
      results.push(record);
    }
  } finally {
    await browser.close();
  }
  const s1 = await spend();
  const summary = { models: s0.models, spent_usd: Math.round((s1.total_usd - s0.total_usd) * 1e5) / 1e5, ledger_total_usd: s1.total_usd, cases: results.map((r: any) => ({ id: r.id, score: r.score, cost_usd: r.cost_usd, skipped: r.skipped, critique: r.critique })) };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(`\nspent $${summary.spent_usd.toFixed(4)} this run · ledger $${s1.total_usd.toFixed(4)} · results in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
