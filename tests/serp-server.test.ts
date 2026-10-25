import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cacheKey, normalizeRequest, serpParams } from "@/serp/params";
import { cleanUrl, compactRaw, normalizePlaces, normalizeWeb } from "@/serp/normalize";
import { SerpLedger, serpCapFromEnv } from "@/serp/ledger";
import { SerpService } from "@/serp/server";

const FIX = resolve(__dirname, "fixtures/serpapi");
const raw = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `meridian-serp-${p}-`));
const KEY = "test-key-0123456789abcdef-not-real";

/** a fake SerpApi: counts calls, answers a fixture, never touches the network */
function fakeFetch(body: unknown, status = 200, delay = 0) {
  const f = vi.fn(async (url: string | URL) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    void url;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return f;
}

function service(o: { cap?: number | null; body?: unknown; status?: number; delay?: number; key?: string | null; fixtures?: string | null; now?: () => number } = {}) {
  const dir = tmp("svc");
  const fetch = fakeFetch(o.body ?? raw("google_maps__grocery.json"), o.status, o.delay);
  const ledger = new SerpLedger({ path: join(dir, "serpapi.json"), cap: o.cap === undefined ? 200 : o.cap });
  const s = new SerpService({ key: o.key === undefined ? KEY : o.key, fixtures: o.fixtures ?? null, cacheDir: join(dir, "cache"), ledger, record: null, fetch: fetch as unknown as typeof globalThis.fetch, now: o.now });
  return { s, fetch, ledger, dir };
}

describe("request whitelisting", () => {
  it("keeps only known fields per engine and canonicalises them", () => {
    const r = normalizeRequest({ engine: "google_maps", q: "  Tacos   near  6th ", near: { lat: 30.267712345, lon: -97.74681 }, zoom: 15.6, api_key: "evil", location: "x", num: 99 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.req).toEqual({ engine: "google_maps", q: "Tacos near 6th", near: { lat: 30.2677, lon: -97.7468 }, zoom: 16 });
    const p = serpParams(r.req);
    expect(p).toEqual({ engine: "google_maps", q: "Tacos near 6th", hl: "en", gl: "us", type: "search", ll: "@30.2677,-97.7468,16z" });
    expect(JSON.stringify(p)).not.toMatch(/api_key|evil/);
  });
  it("refuses unknown engines, empty and huge queries", () => {
    expect(normalizeRequest({ engine: "bing", q: "x" }).ok).toBe(false);
    expect(normalizeRequest({ engine: "google", q: " " }).ok).toBe(false);
    expect(normalizeRequest({ engine: "google", q: "x".repeat(201) }).ok).toBe(false);
    expect(normalizeRequest({ engine: "google_maps", q: "x", near: { lat: 200, lon: 0 } }).ok).toBe(false);
  });
  it("shares one cache key across case and spacing", () => {
    const a = normalizeRequest({ engine: "google", q: "Austin population" });
    const b = normalizeRequest({ engine: "google", q: " austin   POPULATION" });
    expect(a.ok && b.ok && cacheKey(a.req) === cacheKey(b.req)).toBe(true);
  });
});

describe("normalisation", () => {
  it("compacts local results: coordinates, rating, reviews, type, address, hours, open state, price, clean website", () => {
    const r = normalizePlaces("grocery", raw("google_maps__grocery.json"));
    expect(r.places).toHaveLength(5);
    const p = r.places[0];
    expect(p).toMatchObject({ id: "g1", title: "Royal Blue Grocery", lat: 30.2652, lon: -97.7454, rating: 4.3, reviews: 512, type: "Grocery store", address: "247 W 3rd St, Austin, TX 78701", open_now: true, price: "$$" });
    expect(p.website).toBe("https://www.royalbluegrocery.com/");
    expect(r.places[3].open_now).toBe(false);
    expect(r.places[4].open_now).toBe(true); // open 24 hours
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/serpapi|search_metadata|data_id|pagination/);
    expect(s.length).toBeLessThan(JSON.stringify(raw("google_maps__grocery.json")).length);
  });
  it("web: answer box, knowledge-graph facts, numbered de-duplicated sources with domains", () => {
    const w = normalizeWeb("google", "household size", raw("google__default.json"));
    expect(w.answer?.text).toMatch(/2\.31/);
    expect(w.answer?.url).toBe("https://www.fixture.example.gov/quickfacts");
    expect(w.sources.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(w.sources[1]).toMatchObject({ domain: "data.fixture.example.org", url: "https://data.fixture.example.org/housing" });
    expect(w.sources[2].date).toBe("2 days ago");
    expect(w.questions?.[0].q).toMatch(/household/);
    const k = normalizeWeb("google", "austin population", raw("google__population.json"));
    expect(k.entity?.title).toBe("Austin");
    expect(k.entity?.facts.map((f) => f.label)).toEqual(expect.arrayContaining(["Population", "Area", "Elevation"]));
    expect(JSON.stringify(k)).not.toMatch(/serpapi\.com|kgmid|header_images/);
  });
  it("news and scholar", () => {
    const n = normalizeWeb("google_news", "corridor", raw("google_news__default.json"));
    expect(n.sources.map((x) => x.source)).toEqual(["Fixture News", "Fixture Transit Daily"]);
    expect(n.sources[0].date).toBe("10/20/2026, 07:00 AM");
    const s = normalizeWeb("google_scholar", "walkability", raw("google_scholar__default.json"));
    expect(s.sources[0].snippet).toMatch(/cited by 87/);
    expect(s.sources[0].date).toBe("2021");
  });
  it("drops non-http and SerpApi links, unwraps Google redirects", () => {
    expect(cleanUrl("javascript:alert(1)")).toBeUndefined();
    expect(cleanUrl("https://serpapi.com/search.json?q=x")).toBeUndefined();
    expect(cleanUrl("https://www.google.com/url?q=https://example.org/a?utm_source=x")).toBe("https://example.org/a");
  });
  it("compacted fixtures carry no metadata and never the key", () => {
    const c = compactRaw({ search_metadata: { id: 1 }, local_results: [{ title: `x ${KEY}`, serpapi_link: "https://serpapi.com/x" }] }, KEY);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(JSON.stringify(c)).not.toMatch(/search_metadata|serpapi_link/);
  });
});

describe("service: cache, dedupe, cap, fixtures", () => {
  const req = { engine: "google_maps" as const, q: "grocery", near: { lat: 30.2677, lon: -97.7468 }, zoom: 15 };

  it("a miss spends one credit and caches; the repeat is a free hit", async () => {
    const { s, fetch, ledger } = service();
    const a = await s.search(req);
    expect(a.ok && !a.cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ledger.used).toBe(1);
    const b = await s.search({ ...req, q: "GROCERY" });
    expect(b.ok && b.cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ledger.used).toBe(1);
    // the key travels to SerpApi only, in the request URL
    expect(String(fetch.mock.calls[0][0])).toContain(`api_key=${KEY}`);
  });

  it("expires cache entries after the TTL", async () => {
    let t = 1_000_000;
    const { s, fetch } = service({ now: () => t });
    await s.search(req);
    t += 8 * 86_400_000;
    const again = await s.search(req);
    expect(again.ok && !again.cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent identical searches", async () => {
    const { s, fetch, ledger } = service({ delay: 30 });
    const [a, b, c] = await Promise.all([s.search(req), s.search(req), s.search(req)]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ledger.used).toBe(1);
  });

  it("refuses past the cap with a clear message and no call", async () => {
    const { s, fetch } = service({ cap: 1 });
    await s.search(req);
    const r = await s.search({ ...req, q: "pharmacy" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("cap");
    expect(r.error).toMatch(/cap reached: 1 of 1/);
    expect(fetch).toHaveBeenCalledTimes(1);
    // cached answers keep working past the cap
    expect((await s.search(req)).ok).toBe(true);
  });

  it("does not bill a refused upstream request, and scrubs the key from errors", async () => {
    const { s, ledger } = service({ status: 401, body: { error: `Invalid API key ${KEY}` } });
    const r = await s.search(req);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(ledger.used).toBe(0);
  });

  it("not configured without a key", async () => {
    const { s } = service({ key: null });
    const r = await s.search(req);
    expect(!r.ok && r.code).toBe("not_configured");
    expect((await s.status()).configured).toBe(false);
  });

  it("fixture mode answers from files: no network, no credits, best-matching file", async () => {
    const { s, fetch, ledger } = service({ fixtures: FIX });
    const g = await s.search({ ...req, q: "groceries near Republic Square" });
    expect(g.ok && g.fixture).toBe(true);
    if (g.ok && g.data.engine === "google_maps") expect(g.data.places[0].title).toBe("Royal Blue Grocery");
    const d = await s.search({ ...req, q: "restaurants near Congress and 6th" });
    if (d.ok && d.data.engine === "google_maps") expect(d.data.places[0].title).toBe("Fixture Taqueria");
    const w = await s.search({ engine: "google", q: "what is the population of Austin" });
    if (w.ok && w.data.engine === "google") expect(w.data.entity?.title).toBe("Austin");
    expect(fetch).not.toHaveBeenCalled();
    expect(ledger.used).toBe(0);
    expect(s.liveCalls).toBe(0);
  });

  it("the ledger persists across instances and the cap comes from the environment", () => {
    const dir = tmp("ledger");
    const p = join(dir, "l.json");
    const a = new SerpLedger({ path: p, cap: 5 });
    expect(a.reserve().ok).toBe(true);
    a.commit("google", "q");
    const b = new SerpLedger({ path: p, cap: 5 });
    expect(b.snapshot()).toEqual({ used: 1, cap: 5, remaining: 4 });
    expect(serpCapFromEnv({})).toBe(200);
    expect(serpCapFromEnv({ MERIDIAN_SERP_CAP: "25" })).toBe(25);
    expect(serpCapFromEnv({ MERIDIAN_SERP_CAP: "off" })).toBeNull();
    writeFileSync(join(dir, "x"), "");
    expect(readdirSync(dir)).toContain("l.json");
  });
});

describe("route handler", () => {
  it("serves fixtures, never echoes the key, and reports status", async () => {
    const dir = tmp("route");
    vi.stubEnv("SERPAPI_API_KEY", KEY);
    vi.stubEnv("MERIDIAN_SERP_FIXTURES", FIX);
    vi.stubEnv("MERIDIAN_SERP_LEDGER", join(dir, "l.json"));
    vi.stubEnv("MERIDIAN_SERP_CACHE", join(dir, "cache"));
    vi.resetModules();
    const route = await import("@/app/api/serp/route");
    const post = await route.POST(new Request("http://x/api/serp", { method: "POST", body: JSON.stringify({ engine: "google_maps", q: "grocery", near: { lat: 30.27, lon: -97.74 } }) }));
    const text = await post.text();
    expect(post.status).toBe(200);
    expect(text).toContain("Royal Blue Grocery");
    expect(text).not.toContain(KEY);
    const bad = await route.POST(new Request("http://x/api/serp", { method: "POST", body: JSON.stringify({ engine: "yahoo", q: "x" }) }));
    expect(bad.status).toBe(400);
    const st = await route.GET(new Request("http://x/api/serp?account=1"));
    const sj = await st.text();
    expect(JSON.parse(sj)).toMatchObject({ configured: true, fixtures: true, credits: { used: 0, cap: 200 } });
    expect(sj).not.toContain(KEY);
    vi.unstubAllEnvs();
  });
});

describe("recorded live responses (tests/fixtures/serpapi/live)", () => {
  const live = (f: string) => JSON.parse(readFileSync(join(FIX, "live", f), "utf8"));
  it("Google's AI overview becomes a cited answer with key points", () => {
    const w = normalizeWeb("google", "What is the population of Austin", live("google__population-austin.json"));
    expect(w.answer?.kind).toBe("ai_overview");
    expect(w.answer?.text).toMatch(/1,002,632/);
    expect(w.answer?.n).toBeGreaterThan(0);
    expect(w.sources.find((s) => s.n === w.answer?.n)?.domain).toBe("census.gov");
    expect(w.answer?.points?.length).toBeGreaterThan(2);
    expect(w.answer?.text).not.toMatch(/Would you like/);
    expect(w.sources.length).toBeGreaterThanOrEqual(5);
  });
  it("live Maps results: positions, ratings, 'Closes soon' is open, utm stripped", () => {
    const r = normalizePlaces("groceries", live("google_maps__groceries.json"));
    expect(r.places.length).toBeGreaterThanOrEqual(8);
    expect(r.places.every((p) => Math.abs(p.lat - 30.27) < 0.2 && Math.abs(p.lon + 97.74) < 0.2)).toBe(true);
    const rb = r.places.find((p) => /Closes soon/.test(p.hours ?? ""));
    if (rb) expect(rb.open_now).toBe(true);
    expect(r.places.find((p) => /^Closed/.test(p.hours ?? ""))?.open_now).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/utm_|serpapi\.com/);
  });
});
