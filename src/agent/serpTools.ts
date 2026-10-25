// SerpApi tools for the agent (definitions: ./serpToolDefs.ts). They run in the browser like every
// other tool and reach SerpApi only through the server proxy (/api/serp), which holds the key, caches
// and caps searches.
//   web_search    — research with citations (Google answers, knowledge-graph facts, numbered sources)
//   find_places   — Google Maps local discovery in the planner's frame: pins, walking times
//   import_places — discovered places as walk-access destinations (one reversible changeset)

import { polyCentroid } from "@/geometry/polygon";
import { fmtLen } from "@/lib/units";
import { rt } from "@/state/runtime";
import { SerpError, serpSearch } from "@/serp/client";
import { discoverPlaces, importPlaces, importedPoi, SERP_POI_SOURCE } from "@/serp/discover";
import { getSet, type LocalPlace } from "@/serp/store";
import { showOnMap } from "@/serp/view";
import type { SerpEngine, WebResult } from "@/serp/types";
import type { OpResult } from "@/world/ops/core";
import type { Vec2 } from "@/world/types";
import { resolveLocation, viewCenter } from "./resolve";
import type { ToolContext, ToolOutput } from "./tools";

export { SERP_TOOL_DEFS } from "./serpToolDefs";

type In = Record<string, any>;

function err(title: string, message: string): ToolOutput {
  return { content: { error: message }, display: { title, detail: message, status: "error" }, isError: true };
}

async function commit(res: OpResult, title: string, ctx: ToolContext): Promise<ToolOutput> {
  // lazy: tools.ts spreads SERP_TOOLS, so a static import would be circular
  const t = await import("./tools");
  return t.commit(res, title, ctx);
}

const ENGINE: Record<string, Exclude<SerpEngine, "google_maps">> = { web: "google", news: "google_news", scholar: "google_scholar" };
const stars = (r?: number) => (r === undefined ? "" : `${r.toFixed(1)}★`);

/** a place as the agent reads it: imperial distances, local position for the other tools */
export function placeBrief(p: LocalPlace, walkMinutes?: number) {
  return {
    id: p.id,
    name: p.title,
    type: p.type,
    counts_as: p.category,
    rating: p.rating,
    reviews: p.reviews,
    open_now: p.open_now,
    hours: p.hours,
    price: p.price,
    address: p.address,
    at: p.p.map((v) => Math.round(v)),
    distance: fmtLen(p.dist_m),
    walk_min: Math.round(p.walk_min),
    walk_basis: p.walk_basis === "network" ? "street network" : "straight line × 1.3 (outside the study area)",
    ...(walkMinutes ? { within_walk: p.walk_min <= walkMinutes } : {}),
    in_study_area: p.inside,
    ...(p.website ? { website: p.website } : {}),
  };
}

export const SERP_TOOLS: Record<string, (i: In, ctx: ToolContext) => Promise<ToolOutput>> = {
  async web_search(i, ctx) {
    const engine = ENGINE[String(i.kind ?? "web")] ?? "google";
    const q = String(i.query ?? "").trim();
    if (!q) return err("Web search", "query is required");
    let data: WebResult, cached: boolean;
    try {
      const r = await serpSearch({ engine, q, num: engine === "google" ? 8 : 6, ...(engine === "google" && i.location ? { location: String(i.location) } : {}) }, ctx.signal);
      data = r.data as WebResult;
      cached = r.cached;
    } catch (e) {
      return err("Web search", e instanceof SerpError ? e.message : (e as Error).message);
    }
    const n = data.sources.length;
    return {
      content: {
        query: q,
        searched: engine === "google" ? "Google" : engine === "google_news" ? "Google News" : "Google Scholar",
        via: "SerpApi",
        ...(data.answer ? { answer: { text: data.answer.text, cite: data.answer.n } } : {}),
        ...(data.entity ? { entity: { name: data.entity.title, type: data.entity.type, description: data.entity.description, facts: Object.fromEntries(data.entity.facts.map((f) => [f.label, f.value])), cite: data.entity.n } } : {}),
        ...(data.questions?.length ? { people_also_ask: data.questions.map((x) => ({ q: x.q, a: x.a, from: x.domain })) } : {}),
        sources: data.sources.map((s) => ({ n: s.n, title: s.title, domain: s.domain, date: s.date, snippet: s.snippet, url: s.url })),
        note: n ? "Cite figures as [n] (domain). Prefer official sources (census.gov, city and state agencies) over aggregators; give the year of any figure." : "No results: try other words, or say the data was not found.",
      },
      display: { title: `Searched ${engine === "google_news" ? "news" : engine === "google_scholar" ? "research" : "the web"}: “${q}”`, detail: n ? `${n} source${n > 1 ? "s" : ""}${data.answer ? " · answer" : data.entity ? ` · ${data.entity.title}` : ""}${cached ? " · cached" : ""}` : "no results", status: n ? "ok" : "warn", serp: { kind: "web", data, cached } },
    };
  },

  async find_places(i, ctx) {
    const R = rt();
    if (R.meta.sandbox) return err("Find places", "Google Maps discovery needs a real-city project: this blank canvas has no real places around it. web_search still works for research.");
    const q = String(i.query ?? "").trim();
    if (!q) return err("Find places", "query is required");
    let origin: { p: Vec2; label: string };
    try {
      const near = i.near;
      if (near === undefined || near === null || (typeof near === "string" && /^(the\s+)?(view|map|map cent(er|re)|here|current view)$/i.test(near.trim()))) origin = typeof near === "string" ? { p: viewCenter(), label: "the map centre" } : resolveLocation(undefined);
      else if (typeof near === "string" && /^(the\s+)?(session\s+)?zone$/i.test(near.trim())) {
        if (!ctx.zone) return err("Find places", "This session has no zone set; pass a place, intersection or [x,y] instead.");
        origin = { p: polyCentroid(ctx.zone.poly), label: ctx.zone.label };
      } else origin = resolveLocation(near);
    } catch (e) {
      return err("Find places", (e as Error).message);
    }
    const wm = Number(i.walk_minutes) > 0 ? Math.min(30, Number(i.walk_minutes)) : undefined;
    // a walk of N minutes covers about N × 78 m of street, roughly N × 60 m as the crow flies: search a little wider
    const radius = Number(i.radius_m) > 0 ? Number(i.radius_m) : wm ? Math.round(wm * 75) : 800;
    let set;
    try {
      set = await discoverPlaces({ query: q, origin: origin.p, label: origin.label, radius_m: radius, limit: Number(i.limit) || 10, open_now: !!i.open_now, by: "agent", signal: ctx.signal });
    } catch (e) {
      return err("Find places", e instanceof SerpError ? e.message : (e as Error).message);
    }
    if (set.places.length) showOnMap(set);
    const P = set.places;
    const within = wm ? P.filter((p) => p.walk_min <= wm) : [];
    const nearest = P[0];
    const imported = P.filter((p) => importedPoi(R.world, p)).length;
    return {
      content: {
        query: q,
        near: origin.label,
        origin: origin.p.map((v) => Math.round(v)),
        set_id: set.id,
        searched: "Google Maps",
        via: "SerpApi",
        count: P.length,
        ...(wm ? { walk_minutes: wm, within_walk: within.length, within_names: within.map((p) => p.title) } : {}),
        places: P.map((p) => placeBrief(p, wm)),
        ...(imported ? { already_imported: imported } : {}),
        note: P.length
          ? "Pins are on the map. Walking times use the street network at about 3 mph; places outside the study area are estimates. These are Google Maps listings, not the city's mapped POIs — offer import_places if the user wants the walk-access model to use them."
          : "No places found: try broader words or a larger radius.",
      },
      display: {
        title: `Found ${P.length} “${q}” near ${origin.label}`,
        detail: !P.length ? "none" : wm ? `${within.length} within a ${wm}-min walk` : `nearest ${Math.round(nearest.walk_min)} min walk${set.cached ? " · cached" : ""}`,
        status: P.length ? "ok" : "warn",
        serp: { kind: "places", set, walk_minutes: wm },
      },
    };
  },

  async import_places(i, ctx) {
    const set = getSet(i.set_id ? String(i.set_id) : null);
    if (!set) return err("Import places", i.set_id ? `No find_places result “${i.set_id}” in this session.` : "Run find_places first: there are no discovered places to import.");
    const ids: string[] | undefined = Array.isArray(i.ids) && i.ids.length ? i.ids.map(String) : undefined;
    const pick = ids ? set.places.filter((p) => ids.includes(p.id)) : set.places;
    if (!pick.length) return err("Import places", `None of ${ids?.join(", ")} are in ${set.id} (ids: ${set.places.map((p) => p.id).join(", ")}).`);
    const res = importPlaces(rt().world, pick, "agent", set.at);
    const out = await commit(res, "Import places", ctx);
    if (!out.isError && out.content && typeof out.content === "object") {
      out.content = { ...(out.content as object), imported: (res.data?.added as string[] | undefined)?.length ?? 0, skipped: res.data?.skipped, source: SERP_POI_SOURCE, next: "run_simulation access to see walk access with these destinations; undo removes them" };
      out.display = { ...out.display, title: ctx.dryRun ? out.display.title : `Imported ${(res.data?.added as string[]).length} places as destinations`, detail: `${set.query} · ${pick.map((p) => `${p.title}${p.rating ? ` ${stars(p.rating)}` : ""}`).slice(0, 2).join(", ")}${pick.length > 2 ? "…" : ""}` };
    }
    return out;
  },
};
