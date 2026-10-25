// Definitions of the SerpApi tools (executors: ./serpTools.ts). Kept apart from the executors so the
// server route can import every tool definition without pulling in client-side code.

import type { ToolDef } from "./toolDefs";

export const SERP_TOOL_DEFS: ToolDef[] = [
  {
    name: "web_search",
    description:
      "Live Google search (via SerpApi) for facts the world model does not hold: a real city's population, growth, household size, median income or rent, rainfall and water data, ordinances and code requirements, transit facts, local development news, planning precedents and research. Returns Google's direct answer and knowledge-graph facts when there are any, plus numbered sources [n] with domain, date and snippet. Cite every figure you use from it as [n] with the source's domain, and say when a figure is an estimate or dated. kind 'news' searches recent news, 'scholar' academic papers. One search per question: write a precise query (place + measure + year), don't re-search what you already have. Each search costs a credit, repeats are cached.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "precise search words, e.g. 'Austin TX average household size 2023 census'" },
        kind: { type: "string", enum: ["web", "news", "scholar"], description: "web (default), news, or scholar" },
        location: { type: "string", description: "web only: where the search is run from, e.g. 'Austin, Texas, United States' (localises results)" },
      },
      required: ["query"],
    },
    effect: "read",
  },
  {
    name: "find_places",
    description:
      "Find real places with Google Maps (via SerpApi): groceries, pharmacies, schools, clinics, restaurants, cafés, parks… near a place name, intersection ('Congress & 6th'), feature id, [x,y] point, 'zone' (the session zone's centre) or 'view' (the map centre, the default). Drops numbered pins on the map and returns each place's name, Google type, rating and review count, open-now, address, local position [x,y], distance and walking time from the origin (over the street network inside the study area). Use it for amenity / walkability audits ('groceries within a 10-minute walk of Republic Square?') and local discovery. Real-city projects only. Results are current Google Maps listings, not the city's mapped POIs; to let the walk-access model use them, call import_places (only when the user asks or agrees).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "what to find, in Google Maps words: 'grocery store', 'pharmacy', 'tacos', 'elementary school'" },
        near: { description: "search origin: place name, intersection, feature id, [x,y], 'zone' or 'view' (default)", anyOf: [{ type: "string" }, { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }] },
        walk_minutes: { type: "number", description: "flag which places are within this walking time (e.g. 10); also sets the search radius" },
        radius_m: { type: "number", description: "search radius in metres (default 800, about a 10-minute walk)" },
        limit: { type: "number", description: "places to return (default 10, at most 20)" },
        open_now: { type: "boolean", description: "drop places Google lists as closed now" },
      },
      required: ["query"],
    },
    effect: "view",
  },
  {
    name: "import_places",
    description:
      "Add places found by find_places to the world as points of interest, so the walk-access model (run_simulation access) and bike model count them as destinations — groceries, schools, health and food places matter to access. One reversible changeset (undo removes them). Opt-in: only when the user asks for it or agrees to it. Skips places outside the study area or already mapped. Plan mode previews it.",
    input_schema: {
      type: "object",
      properties: {
        set_id: { type: "string", description: "the find_places result to import from (default: the latest)" },
        ids: { type: "array", items: { type: "string" }, description: "place ids from that result ('g1', 'g3'…); default all of them" },
        dry_run: { type: "boolean", description: "preview only: report what would be added" },
      },
    },
    effect: "edit",
  },
];

export const SERP_TOOL_NAMES = new Set(SERP_TOOL_DEFS.map((t) => t.name));
