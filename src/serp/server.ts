// The SerpApi service behind /api/serp (Node only — never imported by client code).
//
//   request ─► whitelist (./params.ts) ─► fixtures? ─► disk cache? ─► in-flight dedupe ─► credit cap
//           ─► SerpApi (key added here) ─► normalise (./normalize.ts) ─► cache ─► compact JSON out
//
// - Key: SERPAPI_API_KEY, read only here. It is never logged, never returned, and scrubbed from any
//   upstream error message before it leaves this module.
// - Fixtures: MERIDIAN_SERP_FIXTURES=<dir> answers every search from recorded raw responses in that
//   directory (no network, no credits) — tests and the mock-LLM end-to-end runs use it.
//   Files are <engine>__<words>.json; a search uses the file whose words best match its own, else
//   <engine>__default.json.
// - Cache: .cache/serpapi/<sha1 of the normalised request>.json holding the normalised answer, kept
//   MERIDIAN_SERP_TTL_DAYS days (default 7). MERIDIAN_SERP_CACHE overrides the directory.
// - Cap: one credit per live search, recorded in the ledger (./ledger.ts), hard cap MERIDIAN_SERP_CAP.
// - Recording: MERIDIAN_SERP_RECORD=<dir> also writes each live raw response, compacted and scrubbed,
//   as a fixture (how tests/fixtures/serpapi/ was made).

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cacheKey, serpParams } from "./params";
import { compactRaw, normalize, upstreamError } from "./normalize";
import { SerpLedger } from "./ledger";
import type { SerpData, SerpRequest, SerpResponse, SerpStatus } from "./types";

const ENDPOINT = "https://serpapi.com/search.json";
const ACCOUNT = "https://serpapi.com/account.json";
const TIMEOUT_MS = 20_000;

export interface SerpServiceOpts {
  key?: string | null;
  fixtures?: string | null;
  cacheDir?: string;
  ttlDays?: number;
  ledger?: SerpLedger;
  record?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

export class SerpService {
  private key: string | null;
  readonly fixtures: string | null;
  readonly cacheDir: string;
  readonly ttlDays: number;
  readonly ledger: SerpLedger;
  private record: string | null;
  private fetcher: typeof fetch;
  private now: () => number;
  private inflight = new Map<string, Promise<SerpResponse>>();
  private acct: { at: number; v: SerpStatus["account"] } | null = null;
  /** live calls made to SerpApi by this instance (tests assert on it) */
  liveCalls = 0;

  constructor(o: SerpServiceOpts = {}) {
    this.key = o.key !== undefined ? o.key : process.env.SERPAPI_API_KEY?.trim() || null;
    const fx = o.fixtures !== undefined ? o.fixtures : process.env.MERIDIAN_SERP_FIXTURES || null;
    this.fixtures = fx ? resolve(/* turbopackIgnore: true */ fx) : null;
    this.cacheDir = resolve(/* turbopackIgnore: true */ o.cacheDir ?? process.env.MERIDIAN_SERP_CACHE ?? ".cache/serpapi");
    const ttl = o.ttlDays ?? Number(process.env.MERIDIAN_SERP_TTL_DAYS ?? 7);
    this.ttlDays = Number.isFinite(ttl) && ttl >= 0 ? ttl : 7;
    this.ledger = o.ledger ?? new SerpLedger();
    const rec = o.record !== undefined ? o.record : process.env.MERIDIAN_SERP_RECORD || null;
    this.record = rec ? resolve(/* turbopackIgnore: true */ rec) : null;
    this.fetcher = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  get configured() {
    return !!this.key || !!this.fixtures;
  }

  /** remove the key from any text that might leave the server */
  scrub(s: string): string {
    return this.key ? s.split(this.key).join("[key]") : s;
  }

  async status(withAccount = false): Promise<SerpStatus> {
    this.ledger.refresh();
    const st: SerpStatus = { configured: this.configured, fixtures: !!this.fixtures, credits: this.ledger.snapshot(), cache: { ttl_days: this.ttlDays } };
    if (withAccount && !this.fixtures && this.key) {
      const a = await this.account();
      if (a) st.account = a;
    }
    return st;
  }

  /** remaining searches on the SerpApi account (the account endpoint costs no search); cached 10 min */
  private async account(): Promise<SerpStatus["account"] | undefined> {
    if (this.acct && this.now() - this.acct.at < 600_000) return this.acct.v;
    try {
      const res = await this.fetcher(`${ACCOUNT}?${new URLSearchParams({ api_key: this.key! })}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return undefined;
      const j = (await res.json()) as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === "number" ? v : null);
      // only the counts: the account endpoint also returns the owner's email and the key itself
      const v = { searches_left: n(j.total_searches_left) ?? n(j.plan_searches_left), this_month_usage: n(j.this_month_usage), plan: typeof j.plan_name === "string" ? j.plan_name : undefined };
      this.acct = { at: this.now(), v };
      return v;
    } catch {
      return undefined;
    }
  }

  private cacheFile(key: string) {
    return join(this.cacheDir, `${createHash("sha1").update(key).digest("hex")}.json`);
  }

  private readCache(key: string): SerpData | null {
    try {
      const c = JSON.parse(readFileSync(this.cacheFile(key), "utf8")) as { at: number; key: string; data: SerpData };
      if (c.key !== key) return null;
      if (this.now() - c.at > this.ttlDays * 86_400_000) return null;
      return c.data;
    } catch {
      return null;
    }
  }

  private writeCache(key: string, data: SerpData) {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const f = this.cacheFile(key);
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: this.now(), key, data }));
      renameSync(tmp, f);
    } catch (e) {
      console.error("[serpapi] cache write failed:", (e as Error).message);
    }
  }

  /** the fixture for a request: the file whose words best cover the query's, else the engine's default */
  private fixture(req: SerpRequest): Record<string, unknown> | null {
    const dir = this.fixtures!;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith(`${req.engine}__`) && f.endsWith(".json"));
    } catch {
      return null;
    }
    const qWords = new Set(slug(req.q).split("-").filter(Boolean));
    let best: string | null = null,
      bestScore = 0;
    for (const f of files) {
      const words = f.slice(req.engine.length + 2, -5).split("-").filter(Boolean);
      if (!words.length || words[0] === "default") continue;
      // "grocery" covers "groceries", "restaurant" covers "restaurants"
      const stem = (w: string) => (w.length > 4 ? w.replace(/(ies|y|es|s)$/, "") : w);
      const hit = words.filter((w) => [...qWords].some((q) => q === w || q.startsWith(stem(w)))).length;
      // every word of the fixture's name must be in the query; more words = more specific
      if (hit === words.length && hit > bestScore) {
        best = f;
        bestScore = hit;
      }
    }
    best ??= files.find((f) => f === `${req.engine}__default.json`) ?? null;
    if (!best) return null;
    try {
      return JSON.parse(readFileSync(join(dir, best), "utf8"));
    } catch {
      return null;
    }
  }

  async search(req: SerpRequest): Promise<SerpResponse> {
    const key = cacheKey(req);
    if (this.fixtures) {
      const raw = this.fixture(req);
      if (!raw) return { ok: false, code: "no_fixture", error: `No SerpApi fixture for ${req.engine} “${req.q}” in ${this.fixtures}.`, credits: this.ledger.snapshot() };
      return { ok: true, data: normalize(req.engine, req.q, raw), cached: false, fixture: true, credits: this.ledger.snapshot() };
    }
    const hit = this.readCache(key);
    if (hit) return { ok: true, data: hit, cached: true, credits: this.ledger.snapshot() };
    if (!this.key) return { ok: false, code: "not_configured", error: "SerpApi is not configured: set SERPAPI_API_KEY in .env.local and restart the server." };
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.live(req, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async live(req: SerpRequest, key: string): Promise<SerpResponse> {
    const r = this.ledger.reserve();
    if (!r.ok) return { ok: false, code: "cap", error: r.message, credits: this.ledger.snapshot() };
    let billed = false;
    try {
      this.liveCalls++;
      const res = await this.fetcher(`${ENDPOINT}?${new URLSearchParams({ ...serpParams(req), api_key: this.key! })}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
      let raw: Record<string, unknown> = {};
      try {
        raw = (await res.json()) as Record<string, unknown>;
      } catch {
        // not JSON: reported below
      }
      if (!res.ok) {
        const msg = typeof raw.error === "string" ? raw.error : `HTTP ${res.status}`;
        return { ok: false, code: "upstream", error: this.scrub(`SerpApi refused the search: ${msg}`), credits: this.ledger.snapshot() };
      }
      // a 200 is a billed search, results or not
      billed = true;
      this.ledger.commit(req.engine, req.q);
      const e = upstreamError(raw);
      if (e) return { ok: false, code: "upstream", error: this.scrub(`SerpApi: ${e}`), credits: this.ledger.snapshot() };
      if (this.record) this.recordRaw(req, raw);
      const data = normalize(req.engine, req.q, raw);
      this.writeCache(key, data);
      return { ok: true, data, cached: false, credits: this.ledger.snapshot() };
    } catch (err) {
      return { ok: false, code: "upstream", error: this.scrub(`SerpApi could not be reached: ${(err as Error).message}`), credits: this.ledger.snapshot() };
    } finally {
      if (!billed) this.ledger.release();
    }
  }

  private recordRaw(req: SerpRequest, raw: Record<string, unknown>) {
    try {
      mkdirSync(this.record!, { recursive: true });
      writeFileSync(join(this.record!, `${req.engine}__${slug(req.q)}.json`), JSON.stringify(compactRaw(raw, this.key ?? undefined), null, 1));
    } catch (e) {
      console.error("[serpapi] fixture record failed:", (e as Error).message);
    }
  }
}

let shared: SerpService | null = null;
/** the process-wide service (configured from the environment on first use) */
export function serpService(): SerpService {
  return (shared ??= new SerpService());
}
