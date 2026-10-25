// Whitelisting for the SerpApi proxy: the browser's request is reduced to a few known fields per
// engine, and those become SerpApi's query parameters. Nothing else the client sends reaches SerpApi.
// The normalised request doubles as the cache key, so "Tacos " and "tacos" share one cached search.

import type { SerpEngine, SerpRequest } from "./types";

export const ENGINES: readonly SerpEngine[] = ["google", "google_maps", "google_news", "google_scholar"];

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

/** validate and canonicalise; returns an error message for a request the proxy refuses */
export function normalizeRequest(raw: unknown): { ok: true; req: SerpRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Expected a JSON body {engine, q}." };
  const r = raw as Record<string, unknown>;
  const engine = r.engine as SerpEngine;
  if (!ENGINES.includes(engine)) return { ok: false, error: `engine must be one of ${ENGINES.join(", ")}.` };
  const q = typeof r.q === "string" ? r.q.replace(/\s+/g, " ").trim() : "";
  if (!q) return { ok: false, error: "q (the search words) is required." };
  if (q.length > 200) return { ok: false, error: "q is too long (200 characters at most)." };
  const req: SerpRequest = { engine, q };
  if (engine === "google_maps") {
    const n = r.near as { lat?: unknown; lon?: unknown } | undefined;
    if (n && typeof n === "object") {
      const lat = Number(n.lat),
        lon = Number(n.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, error: "near must be {lat, lon} in degrees." };
      // ~11 m precision: enough for a local search, and nearby repeats share a cache entry
      req.near = { lat: round(lat, 4), lon: round(lon, 4) };
    }
    const z = Number(r.zoom);
    if (req.near) req.zoom = Number.isFinite(z) ? clamp(Math.round(z), 3, 21) : 15;
  } else {
    if (typeof r.location === "string" && r.location.trim()) req.location = r.location.trim().slice(0, 120);
    const num = Number(r.num);
    if (Number.isFinite(num) && num > 0) req.num = clamp(Math.round(num), 1, 10);
    if (engine === "google_scholar") {
      const y = Number(r.since);
      if (Number.isFinite(y) && y > 1900 && y < 2100) req.since = Math.round(y);
    }
  }
  return { ok: true, req };
}

/** the cache key: the canonical request, case-folded words */
export function cacheKey(req: SerpRequest): string {
  const o: Record<string, unknown> = { e: req.engine, q: req.q.toLowerCase() };
  if (req.near) o.ll = `${req.near.lat},${req.near.lon},${req.zoom ?? 15}`;
  if (req.location) o.loc = req.location.toLowerCase();
  if (req.num) o.num = req.num;
  if (req.since) o.since = req.since;
  return JSON.stringify(o);
}

/** SerpApi query parameters for a canonical request (without the key, which the server adds) */
export function serpParams(req: SerpRequest): Record<string, string> {
  const p: Record<string, string> = { engine: req.engine, q: req.q, hl: "en" };
  switch (req.engine) {
    case "google":
      p.gl = "us";
      if (req.location) p.location = req.location;
      if (req.num) p.num = String(req.num);
      break;
    case "google_maps":
      p.type = "search";
      p.gl = "us";
      if (req.near) p.ll = `@${req.near.lat},${req.near.lon},${req.zoom ?? 15}z`;
      break;
    case "google_news":
      p.gl = "us";
      break;
    case "google_scholar":
      if (req.num) p.num = String(req.num);
      if (req.since) p.as_ylo = String(req.since);
      break;
  }
  return p;
}
