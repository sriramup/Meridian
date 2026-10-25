// Server-side spend ledger and hard cap for the agent route (Node only — imported by
// src/app/api/agent/route.ts, never by client code).
//
// - Every response's real cost is computed from its usage (input, output, cache writes, cache reads ×
//   the model's prices, see ./models.ts costOf) and added to a JSON ledger on disk:
//   .telemetry/spend.json by default, MERIDIAN_SPEND_LEDGER to override.
// - Cap: MERIDIAN_SPEND_CAP_USD (defaults to 2.00 outside production; unset in production = no cap,
//   "0" or "off" disables it). Before a request starts, the ledger total plus what in-flight requests
//   may still spend plus this request's worst case (prompt estimate + max_tokens of output) must stay
//   under the cap, so concurrent sessions cannot overshoot it together. Once reached, new requests are
//   refused with a clear message until the ledger is reset (delete the file) or the cap is raised.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { costOf, priceOf, type Usage } from "./models";

export interface LedgerEntry {
  at: string;
  model: string;
  tier?: string;
  usd: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface LedgerData {
  v: 1;
  total_usd: number;
  requests: number;
  by_model: Record<string, { usd: number; requests: number }>;
  /** the latest entries (capped) */
  recent: LedgerEntry[];
  since: string;
}

const RECENT = 200;

export function capFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.MERIDIAN_SPEND_CAP_USD;
  if (raw !== undefined && raw !== "") {
    if (/^(off|none|0)$/i.test(raw.trim())) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  return env.NODE_ENV === "production" ? null : 2;
}

export class SpendLedger {
  readonly path: string;
  cap: number | null;
  private data: LedgerData;
  private reserved = new Map<number, number>();
  private seq = 0;

  constructor(opts: { path?: string; cap?: number | null } = {}) {
    this.path = resolve(opts.path ?? process.env.MERIDIAN_SPEND_LEDGER ?? ".telemetry/spend.json");
    this.cap = opts.cap !== undefined ? opts.cap : capFromEnv();
    this.data = this.read();
  }

  private read(): LedgerData {
    try {
      const d = JSON.parse(readFileSync(this.path, "utf8")) as LedgerData;
      if (typeof d.total_usd === "number") return { v: 1, total_usd: d.total_usd, requests: d.requests ?? 0, by_model: d.by_model ?? {}, recent: d.recent ?? [], since: d.since ?? new Date().toISOString() };
    } catch {
      // missing or unreadable: start a fresh ledger
    }
    return { v: 1, total_usd: 0, requests: 0, by_model: {}, recent: [], since: new Date().toISOString() };
  }

  private write() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      renameSync(tmp, this.path);
    } catch (e) {
      console.error("[spend] could not write the ledger:", (e as Error).message);
    }
  }

  /** re-read from disk (another server process, or the file was reset by hand) */
  refresh() {
    this.data = this.read();
  }

  get total(): number {
    return this.data.total_usd;
  }

  get pending(): number {
    let s = 0;
    for (const v of this.reserved.values()) s += v;
    return s;
  }

  snapshot() {
    return { total_usd: round(this.data.total_usd), cap_usd: this.cap, remaining_usd: this.cap === null ? null : round(Math.max(0, this.cap - this.data.total_usd)), requests: this.data.requests, by_model: this.data.by_model, since: this.data.since };
  }

  /** worst-case cost of a request before it runs */
  static estimate(model: string, promptChars: number, maxTokens: number): number {
    const p = priceOf(model);
    const promptTokens = promptChars / 3; // conservative (code and JSON tokenise densely)
    const card = p.long && promptTokens > p.long.above ? p.long : p;
    return (promptTokens * card.input + maxTokens * card.output) / 1e6;
  }

  /**
   * Reserve a request's worst case. Returns a ticket, or a refusal message when the cap would be
   * exceeded. Release the ticket with commit() (actual usage) or release() (nothing was billed).
   */
  reserve(worstCase: number): { ok: true; ticket: number } | { ok: false; message: string } {
    this.refresh();
    if (this.cap !== null) {
      const spent = this.data.total_usd;
      if (spent >= this.cap) return { ok: false, message: `Agent spend cap reached: $${spent.toFixed(2)} of $${this.cap.toFixed(2)} used. Raise MERIDIAN_SPEND_CAP_USD or reset ${this.path} to continue.` };
      if (spent + this.pending + worstCase > this.cap)
        return { ok: false, message: `Agent spend cap nearly reached: $${spent.toFixed(2)} of $${this.cap.toFixed(2)} used${this.pending ? ` and $${this.pending.toFixed(2)} in flight` : ""}; this request could cost up to $${worstCase.toFixed(3)}. Try again when other agents finish, or raise MERIDIAN_SPEND_CAP_USD.` };
    }
    const ticket = ++this.seq;
    this.reserved.set(ticket, worstCase);
    return { ok: true, ticket };
  }

  release(ticket: number) {
    this.reserved.delete(ticket);
  }

  /** record a finished response; returns its cost */
  commit(ticket: number | null, model: string, usage: Usage | null | undefined, tier?: string): number {
    if (ticket !== null) this.reserved.delete(ticket);
    const usd = costOf(model, usage);
    this.refresh();
    const d = this.data;
    d.total_usd += usd;
    d.requests += 1;
    const m = (d.by_model[model] ??= { usd: 0, requests: 0 });
    m.usd = round(m.usd + usd, 6);
    m.requests += 1;
    const sum = (k: keyof Usage) => {
      const it = usage?.iterations;
      if (Array.isArray(it) && it.length) return it.reduce((s, x) => s + (Number(x[k]) || 0), 0);
      return Number(usage?.[k]) || 0;
    };
    d.recent.push({ at: new Date().toISOString(), model, tier, usd: round(usd, 6), input: sum("input_tokens"), output: sum("output_tokens"), cache_read: sum("cache_read_input_tokens"), cache_write: sum("cache_creation_input_tokens") });
    if (d.recent.length > RECENT) d.recent.splice(0, d.recent.length - RECENT);
    this.write();
    return usd;
  }
}

const round = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;

let shared: SpendLedger | null = null;
/** the process-wide ledger (configured from the environment on first use) */
export function ledger(): SpendLedger {
  return (shared ??= new SpendLedger());
}
