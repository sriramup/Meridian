// Server-side sink for model telemetry (the assumptions behind each model run). Records are appended
// as JSON lines to a log that only the team reads; nothing here is ever served back to users.
// Identical records (same kind, city and content) are written once, across requests and restarts.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface TelemetryRecord {
  type: "assumptions";
  kind: string;
  city?: string;
  assumptions: string[];
  /** model-specific extras, e.g. traffic count calibration */
  detail?: unknown;
}

const MAX_BYTES = 64 * 1024;

/** validate an untrusted body; null when it isn't a telemetry record */
export function parseRecord(body: unknown): TelemetryRecord | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.type !== "assumptions" || typeof b.kind !== "string" || b.kind.length > 40) return null;
  if (!Array.isArray(b.assumptions) || b.assumptions.length > 60 || !b.assumptions.every((x) => typeof x === "string" && x.length < 2000)) return null;
  if (b.city !== undefined && (typeof b.city !== "string" || b.city.length > 40)) return null;
  const rec: TelemetryRecord = { type: "assumptions", kind: b.kind, assumptions: b.assumptions as string[] };
  if (b.city) rec.city = b.city as string;
  if (b.detail !== undefined) rec.detail = b.detail;
  return JSON.stringify(rec).length > MAX_BYTES ? null : rec;
}

/** dedup key: what was assumed, not when or by whom */
export function recordHash(r: TelemetryRecord): string {
  return createHash("sha256").update(JSON.stringify([r.type, r.kind, r.city ?? "", r.assumptions, r.detail ?? null])).digest("hex").slice(0, 24);
}

/** an append-only JSONL log with content dedup (hashes of what it holds are loaded on first use) */
export class TelemetryLog {
  private seen: Set<string> | null = null;
  constructor(readonly file: string) {}

  private load() {
    if (this.seen) return this.seen;
    this.seen = new Set();
    try {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          this.seen.add((JSON.parse(line) as { hash: string }).hash);
        } catch {
          // a torn last line from a crash: ignore
        }
      }
    } catch {
      // no log yet
    }
    return this.seen;
  }

  /** append unless an identical record is already logged; true when written */
  append(r: TelemetryRecord, now = new Date()): boolean {
    const seen = this.load();
    const hash = recordHash(r);
    if (seen.has(hash)) return false;
    seen.add(hash);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ hash, at: now.toISOString(), ...r }) + "\n");
    return true;
  }
}

export const telemetryFile = () => process.env.MERIDIAN_TELEMETRY_LOG ?? path.join(process.cwd(), ".telemetry", "model-assumptions.jsonl");
