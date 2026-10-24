// Buffering policy for heat runs. A run is identified by the scenario state it modelled (scenario id
// + the ids of its applied changesets) and its parameters (month-day, hours, offset), so a month the
// user returns to, or one prefetched while idle, is reused without re-running; an edit changes the
// state key and so can never be served a stale result. Memory is bounded by an LRU byte cap; the
// runs on screen (shown, compared, the plan-impact baseline) are pinned.

export interface CacheEntry {
  id: string;
  bytes: number;
  lastUsed: number;
}

/** the scenario state a run modelled */
export const stateKey = (scenarioId: string, changesetIds: string[]) => `${scenarioId}@${changesetIds.join(",")}`;

/** default memory budget for finished heat runs (a full Austin day ≈ 48 MB) */
export const HEAT_CACHE_BYTES = 320 * 1024 * 1024;

/** ids to drop, least recently used first, until the unpinned total fits the cap */
export function evictLru(entries: CacheEntry[], cap: number, pinned: ReadonlySet<string>): string[] {
  let total = entries.reduce((s, e) => s + e.bytes, 0);
  const drop: string[] = [];
  for (const e of [...entries].sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (total <= cap) break;
    if (pinned.has(e.id)) continue;
    drop.push(e.id);
    total -= e.bytes;
  }
  return drop;
}

/**
 * Runs made obsolete by an edit: same scenario, a different state than the one now current, not
 * pinned. (Other scenarios' runs stay: switching back to them is a cache hit.)
 */
export function staleRuns(entries: { id: string; scenarioId: string; state: string }[], scenarioId: string, current: string, pinned: ReadonlySet<string>): string[] {
  return entries.filter((e) => e.scenarioId === scenarioId && e.state !== current && !pinned.has(e.id)).map((e) => e.id);
}

/** approximate retained size of a heat result */
export function heatBytes(r: { exposure?: ArrayLike<unknown>[]; surface?: ArrayLike<unknown>[]; tiles?: { hourly: { byteLength: number }[] } }): number {
  let b = 0;
  for (const a of r.exposure ?? []) b += a.length;
  for (const a of r.surface ?? []) b += a.length;
  for (const h of r.tiles?.hourly ?? []) b += h.byteLength;
  return b;
}

/** the months either side of a month-day ("MM-DD" → the neighbours' dates, via monthDate) */
export function adjacentMonths(md: string, monthDate: (m: number) => string): string[] {
  const m = +md.slice(0, 2) - 1;
  return [monthDate(m + 1), monthDate(m - 1)];
}
