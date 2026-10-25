// Shared shapes for the SerpApi integration (server proxy src/app/api/serp/route.ts, normaliser
// ./normalize.ts, client ./client.ts and the agent tools). Pure types: safe to import anywhere.
//
// The browser never sees a raw SerpApi response, a SerpApi URL or the key: the proxy whitelists the
// request, calls SerpApi with the key server-side, and answers with these compact shapes.

export type SerpEngine = "google" | "google_maps" | "google_news" | "google_scholar";

/** what the browser may ask for (anything else is dropped by ./params.ts) */
export interface SerpRequest {
  engine: SerpEngine;
  /** the search words (1–200 chars) */
  q: string;
  /** google_maps: search around this point (WGS84) */
  near?: { lat: number; lon: number };
  /** google_maps: map zoom for the search viewport (3–21; default 15) */
  zoom?: number;
  /** google / google_news: a SerpApi location name, e.g. "Austin, Texas, United States" */
  location?: string;
  /** results wanted (google / scholar: 1–10) */
  num?: number;
  /** google_scholar: earliest publication year */
  since?: number;
}

export interface SerpSource {
  /** 1-based, stable within one response: the agent cites [n] */
  n: number;
  title: string;
  url: string;
  /** host without www. */
  domain: string;
  snippet?: string;
  /** publication or page date as SerpApi gives it ("Mar 3, 2025", "2 days ago") */
  date?: string;
  /** publisher / site name */
  source?: string;
}

export interface SerpFact {
  label: string;
  value: string;
}

export interface WebResult {
  engine: "google" | "google_news" | "google_scholar";
  query: string;
  /** Google's direct answer (answer box), when there is one */
  answer?: { text: string; title?: string; url?: string; domain?: string; /** its source number */ n?: number };
  /** knowledge-graph entity (a city, an agency…) with its facts */
  entity?: { title: string; type?: string; description?: string; facts: SerpFact[]; url?: string; domain?: string; n?: number };
  /** "People also ask" answers, each with its source */
  questions?: { q: string; a: string; url?: string; domain?: string }[];
  sources: SerpSource[];
}

export interface SerpPlace {
  /** stable id within the response ("g1"…) */
  id: string;
  title: string;
  lat: number;
  lon: number;
  rating?: number;
  reviews?: number;
  /** primary Google type ("Grocery store") */
  type?: string;
  types?: string[];
  address?: string;
  /** "Open ⋅ Closes 10 PM" */
  hours?: string;
  open_now?: boolean;
  /** "$$" or "$10–20" */
  price?: string;
  website?: string;
  phone?: string;
  thumbnail?: string;
  place_id?: string;
  description?: string;
}

export interface PlacesResult {
  engine: "google_maps";
  query: string;
  places: SerpPlace[];
}

export type SerpData = WebResult | PlacesResult;

/** a tool card's payload (ToolDisplay.serp): what the agents pane renders as a search card */
export type SerpCard = { kind: "web"; data: WebResult; cached?: boolean } | { kind: "places"; set: import("./store").PlaceSet; walk_minutes?: number };

export interface SerpCredits {
  /** searches billed by this server so far (cache hits and fixtures are free) */
  used: number;
  /** hard cap for this server (MERIDIAN_SERP_CAP) */
  cap: number | null;
  remaining: number | null;
}

/** POST /api/serp answer */
export type SerpResponse =
  | { ok: true; data: SerpData; cached: boolean; fixture?: boolean; credits: SerpCredits }
  | { ok: false; error: string; code: "not_configured" | "cap" | "bad_request" | "upstream" | "no_fixture"; credits?: SerpCredits };

/** GET /api/serp answer */
export interface SerpStatus {
  configured: boolean;
  fixtures: boolean;
  credits: SerpCredits;
  /** from SerpApi's account endpoint (costs no search), when asked for and reachable */
  account?: { searches_left: number | null; this_month_usage: number | null; plan?: string };
  cache: { ttl_days: number };
}
