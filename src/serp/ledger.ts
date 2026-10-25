// SerpApi credit ledger with a hard cap (Node only: imported by src/serp/server.ts). Same pattern as
// the agent's spend ledger (src/agent/spend.ts): a JSON file on disk, re-read before each decision so
// several server processes share it, and reservations for in-flight searches so concurrent requests
// cannot overshoot the cap together.
//
// - File: .telemetry/serpapi.json by default, MERIDIAN_SERP_LEDGER to override.
// - Cap: MERIDIAN_SERP_CAP searches (default 200; "off"/"0" disables it). One live search = one credit.
//   Cache hits and fixture answers are free and are not recorded.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface SerpLedgerData {
  v: 1;
  used: number;
  by_engine: Record<string, number>;
  /** the latest searches (capped): when, which engine, the words — never the key */
  recent: { at: string; engine: string; q: string }[];
  since: string;
}

const RECENT = 300;
export const DEFAULT_SERP_CAP = 200;

export function serpCapFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.MERIDIAN_SERP_CAP;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SERP_CAP;
  if (/^(off|none|0)$/i.test(raw.trim())) return null;
  const v = Math.floor(Number(raw));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SERP_CAP;
}

export class SerpLedger {
  readonly path: string;
  cap: number | null;
  private data: SerpLedgerData;
  private inflight = 0;

  constructor(opts: { path?: string; cap?: number | null } = {}) {
    this.path = resolve(/* turbopackIgnore: true */ opts.path ?? process.env.MERIDIAN_SERP_LEDGER ?? ".telemetry/serpapi.json");
    this.cap = opts.cap !== undefined ? opts.cap : serpCapFromEnv();
    this.data = this.read();
  }

  private read(): SerpLedgerData {
    try {
      const d = JSON.parse(readFileSync(this.path, "utf8")) as SerpLedgerData;
      if (typeof d.used === "number") return { v: 1, used: d.used, by_engine: d.by_engine ?? {}, recent: d.recent ?? [], since: d.since ?? new Date().toISOString() };
    } catch {
      // missing or unreadable: a fresh ledger
    }
    return { v: 1, used: 0, by_engine: {}, recent: [], since: new Date().toISOString() };
  }

  private write() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      renameSync(tmp, this.path);
    } catch (e) {
      console.error("[serpapi] could not write the credit ledger:", (e as Error).message);
    }
  }

  refresh() {
    this.data = this.read();
  }

  get used() {
    return this.data.used;
  }

  snapshot() {
    return { used: this.data.used, cap: this.cap, remaining: this.cap === null ? null : Math.max(0, this.cap - this.data.used) };
  }

  /** hold one credit for a live search, or refuse with a clear message */
  reserve(): { ok: true } | { ok: false; message: string } {
    this.refresh();
    if (this.cap !== null && this.data.used + this.inflight >= this.cap) {
      return {
        ok: false,
        message:
          this.data.used >= this.cap
            ? `SerpApi search cap reached: ${this.data.used} of ${this.cap} searches used on this server. Cached results still work; raise MERIDIAN_SERP_CAP or reset ${this.path} to search again.`
            : `SerpApi search cap nearly reached: ${this.data.used} of ${this.cap} used and ${this.inflight} in flight. Try again in a moment.`,
      };
    }
    this.inflight++;
    return { ok: true };
  }

  /** the reserved search was not billed (failed before reaching SerpApi) */
  release() {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  /** the reserved search was billed */
  commit(engine: string, q: string) {
    this.inflight = Math.max(0, this.inflight - 1);
    this.refresh();
    const d = this.data;
    d.used += 1;
    d.by_engine[engine] = (d.by_engine[engine] ?? 0) + 1;
    d.recent.push({ at: new Date().toISOString(), engine, q: q.slice(0, 120) });
    if (d.recent.length > RECENT) d.recent.splice(0, d.recent.length - RECENT);
    this.write();
  }
}
