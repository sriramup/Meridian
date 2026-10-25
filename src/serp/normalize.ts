// SerpApi JSON → the compact shapes in ./types.ts. Pure (tested in tests/serp-normalize.test.ts):
// keeps what a planner or the agent reads (answers, facts, titles, links, snippets, dates; for places
// position, rating, reviews, type, address, hours, price, website) and drops everything else —
// search metadata, SerpApi links, tracking parameters, images other than one thumbnail.

import type { PlacesResult, SerpData, SerpEngine, SerpFact, SerpPlace, SerpSource, WebResult } from "./types";

type J = Record<string, any>;

const MAX_SOURCES = 8;
const MAX_PLACES = 20;
const MAX_FACTS = 12;
const MAX_SNIPPET = 320;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim() : typeof v === "number" ? String(v) : undefined);
const cut = (s: string | undefined, n = MAX_SNIPPET) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const num = (v: unknown): number | undefined => {
  const x = typeof v === "string" ? Number(v.replace(/[,()]/g, "")) : Number(v);
  return Number.isFinite(x) ? x : undefined;
};

/** a page link the browser may open: http(s) only, SerpApi's own links and Google redirects removed */
export function cleanUrl(u: unknown): string | undefined {
  const s = str(u);
  if (!s) return undefined;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (/(^|\.)serpapi\.com$/i.test(url.hostname)) return undefined;
  // a Google redirect: the real target is in ?q= / ?url=
  if (/(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === "/url") return cleanUrl(url.searchParams.get("q") ?? url.searchParams.get("url"));
  for (const k of [...url.searchParams.keys()]) if (/^(utm_|gclid|fbclid|srsltid|ved|ei)/i.test(k)) url.searchParams.delete(k);
  return url.toString();
}

export function domainOf(u: string | undefined): string {
  if (!u) return "";
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sourcesFrom(rows: J[] | undefined, map: (r: J) => Omit<SerpSource, "n" | "domain"> | null, limit = MAX_SOURCES): SerpSource[] {
  const out: SerpSource[] = [];
  const seen = new Set<string>();
  for (const r of rows ?? []) {
    if (out.length >= limit) break;
    const s = map(r);
    if (!s?.url || !s.title || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ n: out.length + 1, ...s, domain: domainOf(s.url), snippet: cut(s.snippet) });
  }
  return out;
}

// knowledge-graph keys that are SerpApi plumbing or images, not facts
const KG_SKIP = /^(title|type|description|source|kgmid|knowledge_graph_search_link|serpapi_.*|header_images|images|image|thumbnail|.*_links?|.*_stick|people_also_search_for.*|see_results_about|.*_search_link|entity_type|web_results|list|tabs|buttons|.*_id)$/i;

function entityFrom(kg: J | undefined): WebResult["entity"] {
  const title = str(kg?.title);
  if (!kg || !title) return undefined;
  const facts: SerpFact[] = [];
  for (const [k, v] of Object.entries(kg)) {
    if (facts.length >= MAX_FACTS || KG_SKIP.test(k)) continue;
    const value = typeof v === "string" || typeof v === "number" ? str(v) : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : undefined;
    if (!value || value.length > 200) continue;
    facts.push({ label: k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), value });
  }
  const url = cleanUrl(kg.source?.link) ?? cleanUrl(kg.website);
  return { title, type: str(kg.type), description: cut(str(kg.description), 400), facts, url, domain: url ? domainOf(url) : undefined };
}

function answerFrom(ab: J | undefined): WebResult["answer"] {
  if (!ab) return undefined;
  const list = Array.isArray(ab.list) ? ab.list.filter((x: unknown) => typeof x === "string").slice(0, 6).join("; ") : undefined;
  const table = Array.isArray(ab.table) ? ab.table.slice(0, 4).map((row: unknown) => (Array.isArray(row) ? row.join(" · ") : "")).filter(Boolean).join("; ") : undefined;
  const text = str(ab.answer) ?? str(ab.result) ?? str(ab.snippet) ?? list ?? table ?? (Array.isArray(ab.contents?.table) ? undefined : str(ab.contents?.snippet));
  if (!text) return undefined;
  const url = cleanUrl(ab.link);
  return { text: cut(text, 500)!, title: str(ab.title), url, domain: url ? domainOf(url) : undefined };
}

/** google / google_news / google_scholar */
export function normalizeWeb(engine: Exclude<SerpEngine, "google_maps">, query: string, raw: J): WebResult {
  if (engine === "google_news") {
    // a news result is either a story or a cluster of stories (take the cluster's first)
    const rows: J[] = (raw.news_results ?? []).flatMap((r: J) => (r.link ? [r] : Array.isArray(r.stories) ? r.stories.slice(0, 1) : []));
    return {
      engine,
      query,
      sources: sourcesFrom(rows, (r) => ({ title: str(r.title) ?? "", url: cleanUrl(r.link) ?? "", snippet: str(r.snippet), date: str(r.date)?.replace(/, \+0000 UTC$/, ""), source: str(r.source?.name) ?? str(r.source) })),
    };
  }
  if (engine === "google_scholar") {
    return {
      engine,
      query,
      sources: sourcesFrom(raw.organic_results, (r) => {
        const cited = num(r.inline_links?.cited_by?.total);
        const pub = str(r.publication_info?.summary);
        return { title: str(r.title) ?? "", url: cleanUrl(r.link) ?? cleanUrl(r.resources?.[0]?.link) ?? "", snippet: [str(r.snippet), pub, cited ? `cited by ${cited}` : undefined].filter(Boolean).join(" — "), date: pub?.match(/\b(19|20)\d{2}\b/)?.[0], source: pub?.split(" - ").pop() };
      }),
    };
  }
  const questions = (raw.related_questions ?? [])
    .map((r: J) => {
      const url = cleanUrl(r.link);
      const a = str(r.snippet) ?? str(r.list?.join?.("; "));
      return a && str(r.question) ? { q: str(r.question)!, a: cut(a, 260)!, url, domain: url ? domainOf(url) : undefined } : null;
    })
    .filter(Boolean)
    .slice(0, 3) as NonNullable<WebResult["questions"]>;
  const out: WebResult = {
    engine,
    query,
    answer: answerFrom(raw.answer_box),
    entity: entityFrom(raw.knowledge_graph),
    sources: sourcesFrom(raw.organic_results, (r) => ({ title: str(r.title) ?? "", url: cleanUrl(r.link) ?? "", snippet: str(r.snippet), date: str(r.date), source: str(r.source) })),
  };
  if (questions.length) out.questions = questions;
  if (!out.answer) delete out.answer;
  if (!out.entity) delete out.entity;
  // the answer and the entity cite a numbered source like everything else (added when not listed)
  for (const x of [out.answer, out.entity]) {
    if (!x?.url) continue;
    const s = out.sources.find((r) => r.url === x.url);
    if (s) x.n = s.n;
    else {
      x.n = out.sources.length + 1;
      out.sources.push({ n: x.n, title: x.title ?? x.domain ?? x.url, url: x.url, domain: x.domain ?? domainOf(x.url) });
    }
  }
  return out;
}

/** google_maps (type=search): local_results, or a single place_results when the query names one place */
export function normalizePlaces(query: string, raw: J): PlacesResult {
  const rows: J[] = Array.isArray(raw.local_results) ? raw.local_results : raw.place_results ? [raw.place_results] : [];
  const places: SerpPlace[] = [];
  for (const r of rows) {
    if (places.length >= MAX_PLACES) break;
    const lat = num(r.gps_coordinates?.latitude),
      lon = num(r.gps_coordinates?.longitude);
    const title = str(r.title);
    if (!title || lat === undefined || lon === undefined) continue;
    const open = str(r.open_state) ?? str(r.hours);
    const p: SerpPlace = {
      id: `g${places.length + 1}`,
      title,
      lat,
      lon,
      rating: num(r.rating),
      reviews: num(r.reviews),
      type: str(r.type) ?? str(r.types?.[0]),
      types: Array.isArray(r.types) ? r.types.filter((x: unknown) => typeof x === "string").slice(0, 4) : undefined,
      address: str(r.address),
      hours: cut(open, 80),
      open_now: open ? (/^open\b/i.test(open) || /open 24 hours/i.test(open) ? true : /^(closed|temporarily closed|permanently closed)/i.test(open) ? false : undefined) : undefined,
      price: str(r.price),
      website: cleanUrl(r.website),
      phone: str(r.phone),
      thumbnail: cleanUrl(r.thumbnail),
      place_id: str(r.place_id),
      description: cut(str(r.description), 160),
    };
    for (const k of Object.keys(p) as (keyof SerpPlace)[]) if (p[k] === undefined) delete p[k];
    places.push(p);
  }
  return { engine: "google_maps", query, places };
}

export function normalize(engine: SerpEngine, query: string, raw: J): SerpData {
  return engine === "google_maps" ? normalizePlaces(query, raw) : normalizeWeb(engine, query, raw);
}

/** SerpApi reports failures in-band ({error: "..."}); "no results" is not a failure */
export function upstreamError(raw: J): string | null {
  const e = str(raw?.error);
  if (!e) return null;
  if (/hasn't returned any results|no results/i.test(e)) return null;
  return e;
}

/**
 * A raw response trimmed for a test fixture: SerpApi metadata, its own links and anything that could
 * identify the account removed (the key never appears in a response, but fixtures are scrubbed anyway).
 */
export function compactRaw(raw: J, secret?: string): J {
  const drop = /^(search_metadata|search_parameters|search_information|serpapi_.*|pagination|.*_link|inline_images|images_results|immersive_products|ads|shopping_results|related_searches|top_stories_link|filters|knowledge_graph_search_link|data_id|data_cid|reviews_link|photos_link|provider_id|.*_token)$/;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return secret && v.includes(secret) ? v.split(secret).join("REDACTED") : v;
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const o: J = {};
      for (const [k, x] of Object.entries(v)) if (!drop.test(k) && depth < 6) o[k] = walk(x, depth + 1);
      return o;
    }
    return v;
  };
  return walk(raw, 0) as J;
}
