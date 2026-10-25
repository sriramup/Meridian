// Local discovery with Google Maps (via SerpApi) in the planner's frame: search around a point of the
// study area, convert each result's GPS position to local metres, measure the walk to it over the
// street network (the same 1.3 m/s walking speed as the walk-access model, src/sim/access.ts), and
// classify it the way the access model counts destinations. Optionally import results as Poi
// entities, as one reversible changeset, so walk access is computed against current Google Maps data.

import { dist } from "@/geometry/vec";
import { rt } from "@/state/runtime";
import { buildNetwork, dijkstra, nearestNode, type Network } from "@/world/network";
import { OpBuilder, type OpResult } from "@/world/ops/core";
import { LocalProjection } from "@/world/projection";
import type { Poi, Vec2 } from "@/world/types";
import { newId, type World } from "@/world/world";
import { serpSearch } from "./client";
import { addSet, type LocalPlace, type PlaceSet } from "./store";
import type { PlacesResult, SerpPlace } from "./types";

/** walking speed of the access model (m/s) */
export const WALK_MPS = 1.3;
/** detour factor for a straight line when no network path is known */
export const DETOUR = 1.3;
export const SERP_POI_SOURCE = "Google Maps via SerpApi";

const CATS: [RegExp, Poi["category"]][] = [
  [/\b(grocer|supermarket|food market|market|bodega|butcher|greengrocer|produce|h-e-b|whole foods|trader joe)/i, "grocery"],
  [/\b(pharmac|drugstore|clinic|hospital|doctor|medical|urgent care|health|dentist|physician)/i, "health"],
  [/\b(elementary|middle school|high school|school|preschool|kindergarten|academy)\b/i, "school"],
  [/\b(university|college|campus)\b/i, "university"],
  [/\b(restaurant|caf[eé]|coffee|bakery|bar\b|pub|diner|taco|taqueria|pizza|food|eatery|bistro|grill|barbecue|bbq|deli|brewery|ice cream|tea house)/i, "food"],
  [/\b(park|playground|garden|trail|green ?space)\b/i, "park"],
  [/\b(library|city hall|post office|courthouse|community center|government|police|fire station)\b/i, "civic"],
  [/\b(museum|gallery|theat(er|re)|cinema|music venue|arts?\b)/i, "culture"],
  [/\b(church|mosque|synagogue|temple|place of worship)\b/i, "worship"],
  [/\b(hotel|motel|inn|hostel)\b/i, "hotel"],
  [/\b(bus station|train station|transit|station)\b/i, "transit"],
  [/\b(store|shop|boutique|mall|retail|hardware|convenience)\b/i, "shop"],
];

/** the access model's category for a Google place type (the query helps when the type is vague) */
export function categoryOf(place: Pick<SerpPlace, "type" | "types" | "title">, query = ""): Poi["category"] {
  const text = [place.type, ...(place.types ?? [])].filter(Boolean).join(" ");
  for (const [re, c] of CATS) if (re.test(text)) return c;
  for (const [re, c] of CATS) if (re.test(query)) return c;
  return "other";
}

const inBounds = (p: Vec2, b: [number, number, number, number]) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** search viewport for a radius (m): about the radius across a 1,000 px map */
export const zoomFor = (radius: number) => Math.max(12, Math.min(18, Math.round(15 - Math.log2(Math.max(150, radius) / 900))));

/**
 * Google places → local places: position in metres, straight-line and walking distance from the
 * origin (network metres when both ends are in the study area), category. Pure given its inputs.
 */
export function localize(places: SerpPlace[], o: { origin: Vec2; proj: LocalProjection; bounds: [number, number, number, number]; walkTo?: (p: Vec2) => number | null; query?: string }): LocalPlace[] {
  return places.map((g) => {
    const p = o.proj.toLocal(g.lon, g.lat);
    const d = dist(p, o.origin);
    const inside = inBounds(p, o.bounds);
    const net = inside ? (o.walkTo?.(p) ?? null) : null;
    const walk = net !== null && Number.isFinite(net) ? Math.max(net, d) : d * DETOUR;
    return { ...g, p: [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] as Vec2, dist_m: Math.round(d), walk_m: Math.round(walk), walk_min: Math.round((walk / WALK_MPS / 60) * 10) / 10, walk_basis: net !== null && Number.isFinite(net) ? "network" : "estimate", inside, category: categoryOf(g, o.query) };
  });
}

/** one-to-many walking distances from a point over the walk network (null = unreachable) */
export function walker(net: Network, from: Vec2, maxM = 6000): (p: Vec2) => number | null {
  const s = nearestNode(net, from);
  if (s < 0) return () => null;
  const { d } = dijkstra(net, s, (l) => l.length, { maxCost: maxM });
  const lead = dist(net.nodes[s].p, from);
  return (p) => {
    const t = nearestNode(net, p);
    if (t < 0 || !Number.isFinite(d[t])) return null;
    return d[t] + lead + dist(net.nodes[t].p, p);
  };
}

export interface DiscoverOpts {
  query: string;
  origin: Vec2;
  label: string;
  radius_m?: number;
  limit?: number;
  open_now?: boolean;
  by?: "agent" | "search";
  show?: boolean;
  signal?: AbortSignal;
}

/** search Google Maps around a local point and keep the results as a place set (drawn on the map) */
export async function discoverPlaces(o: DiscoverOpts): Promise<PlaceSet> {
  const R = rt();
  if (R.meta.sandbox) throw new Error("Google Maps discovery needs a real-city project: a blank canvas has no real places around it.");
  const radius = Math.max(100, Math.min(5000, o.radius_m ?? 800));
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  const [lon, lat] = proj.toLonLat(o.origin);
  const { data, cached } = await serpSearch({ engine: "google_maps", q: o.query, near: { lat, lon }, zoom: zoomFor(radius) }, o.signal);
  const places = (data as PlacesResult).places ?? [];
  const net = buildNetwork(R.world.entities.values(), "walk");
  let local = localize(places, { origin: o.origin, proj, bounds: R.meta.bounds, walkTo: walker(net, o.origin, Math.max(6000, radius * 4)), query: o.query });
  if (o.open_now) local = local.filter((p) => p.open_now !== false);
  local.sort((a, b) => a.walk_m - b.walk_m);
  local = local.slice(0, Math.max(1, Math.min(20, o.limit ?? 10)));
  return addSet({ query: o.query, origin: { p: o.origin, label: o.label }, radius_m: radius, places: local, by: o.by ?? "agent", cached }, o.show ?? true);
}

/** the Poi already imported for a discovered place, if any */
export function importedPoi(world: World, place: Pick<LocalPlace, "place_id" | "title" | "p">): Poi | undefined {
  for (const e of world.query([place.p[0] - 40, place.p[1] - 40, place.p[0] + 40, place.p[1] + 40], ["poi"]) as Poi[]) {
    if (e.source !== SERP_POI_SOURCE) continue;
    if ((place.place_id && e.tags?.place_id === place.place_id) || e.name === place.title) return e;
  }
  return undefined;
}

/**
 * Discovered places as walk-access destinations: one changeset adding a Poi per place (undo removes
 * them all). Skips places outside the study area, already imported, or already mapped (an existing
 * POI of the same category and name within 40 m).
 */
export function importPlaces(world: World, places: LocalPlace[], author: "user" | "agent", fetchedAt = Date.now()): OpResult {
  const b = new OpBuilder(world, author);
  const added: string[] = [];
  const skipped: string[] = [];
  const date = new Date(fetchedAt).toISOString().slice(0, 10);
  for (const pl of places) {
    if (!pl.inside) {
      skipped.push(`${pl.title} (outside the study area)`);
      continue;
    }
    if (importedPoi(world, pl)) {
      skipped.push(`${pl.title} (already imported)`);
      continue;
    }
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const mapped = (world.query([pl.p[0] - 40, pl.p[1] - 40, pl.p[0] + 40, pl.p[1] + 40], ["poi"]) as Poi[]).find((e) => e.category === pl.category && e.name && norm(e.name) === norm(pl.title));
    if (mapped) {
      skipped.push(`${pl.title} (already mapped)`);
      continue;
    }
    const tags: Record<string, string> = { fetched: date };
    if (pl.place_id) tags.place_id = pl.place_id;
    if (pl.type) tags.google_type = pl.type;
    if (pl.address) tags.address = pl.address;
    if (pl.rating !== undefined) tags.rating = String(pl.rating);
    const poi = b.add<Poi>({ id: newId("poi"), kind: "poi", p: pl.p, name: pl.title, category: pl.category, tags, source: SERP_POI_SOURCE });
    added.push(poi.id);
  }
  b.data.added = added;
  b.data.skipped = skipped;
  if (!added.length) return b.fail(skipped.length ? `Nothing to import: ${skipped.slice(0, 4).join("; ")}` : "No places to import");
  const cats = [...new Set(places.filter((p) => p.inside).map((p) => p.category))].join(", ");
  b.summary(`Imported ${added.length} Google Maps place${added.length > 1 ? "s" : ""} as walk-access destinations (${cats})`);
  if (skipped.length) b.summary(`Skipped ${skipped.length}: ${skipped.slice(0, 4).join("; ")}${skipped.length > 4 ? "…" : ""}`);
  return b.finish(`Import ${added.length} place${added.length > 1 ? "s" : ""} from Google Maps`);
}
