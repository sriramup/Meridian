// Reference resolution: turn what the user / model says ("this", "that tower",
// "Congress & 6th", "Republic Square", a feature id, a point) into geometry
// and ids in the world model.

import { circle, difference, isValidPoly, normalizePoly, pointInPoly, polyArea, polyBBox, polyCentroid, unionMany } from "@/geometry/polygon";
import { closestOnPath, polyLength } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import { LocalProjection } from "@/world/projection";
import type { AreaType, Building, Entity, Place, Polygon, Street, StreetNode, Vec2 } from "@/world/types";
import { streetBand } from "@/world/ops/validate";

export type Loc = Vec2 | string;
export type AreaRef = Vec2[] | string | { center: Vec2; radius: number };

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
// common abbreviations people type for long official names (general, not city-specific: initials of honorific names)
const ALIASES: [RegExp, string][] = [[/\bmlk\b/g, "martin luther king jr"], [/\bjunior\b/g, "jr"], [/\bsaint\b/g, "st"], [/\bmount\b/g, "mt"], [/\bfort\b/g, "ft"]];

/** normalised name: lower case, standard suffix / directional abbreviations, ordinals as numbers, no articles */
export const norm = (s: string) => {
  let x = s
    .toLowerCase()
    .replace(/[.,'’()]/g, "")
    .replace(/-/g, " ");
  for (const [re, to] of ALIASES) x = x.replace(re, to);
  x = x.replace(/\b(twenty|thirty|forty|fifty)[\s-]?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/g, (_, t: string, o: string) => String(TENS[t] + ORDINALS[o]));
  x = x.replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth)\b/g, (o) => String(ORDINALS[o]));
  return x
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bav\b/g, "ave")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\broad\b/g, "rd")
    .replace(/\blane\b/g, "ln")
    .replace(/\bplace\b/g, "pl")
    .replace(/\bparkway\b/g, "pkwy")
    .replace(/\bhighway\b/g, "hwy")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bterrace\b/g, "ter")
    .replace(/\bcircle\b/g, "cir")
    .replace(/\beast\b/g, "e")
    .replace(/\bwest\b/g, "w")
    .replace(/\bnorth\b/g, "n")
    .replace(/\bsouth\b/g, "s")
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const DIRS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);
const TYPES = new Set(["st", "ave", "blvd", "dr", "rd", "ln", "pl", "pkwy", "hwy", "way", "ct", "cir", "ter", "trl", "loop", "expy", "fwy", "sq", "plz", "aly", "row", "walk"]);
/** the distinctive tokens of a normalised street name: no directional prefix, no street type */
const core = (n: string) => n.split(" ").filter((t) => t && !DIRS.has(t) && !TYPES.has(t));
const typeOf = (n: string) => n.split(" ").filter((t) => TYPES.has(t));

/** edit distance (small strings only) */
function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** typo-tolerant token equality: numbers and short words must match exactly ("5" never matches "15") */
const tokEq = (a: string, b: string) => a === b || (!/\d/.test(a + b) && Math.min(a.length, b.length) >= 5 && lev(a, b) <= (Math.min(a.length, b.length) >= 8 ? 2 : 1));

/** fuzzy name score (0..1) */
export function nameScore(query: string, name?: string): number {
  if (!name) return 0;
  const q = norm(query),
    n = norm(name);
  if (!q) return 0;
  if (n === q) return 1;
  // same distinctive tokens, differing only in directional prefix / street type: "21st" ≡ "W 21st St",
  // "Guadalupe" ≡ "Guadalupe St"; a conflicting type ("Pine Ave" for "Pine St") scores lower
  const qc = core(q),
    nc = core(n);
  const streetish = typeOf(q).length + typeOf(n).length > 0 || /\d/.test(q);
  if (streetish && qc.length && qc.join(" ") === nc.join(" ")) {
    const qt = typeOf(q),
      ntp = typeOf(n);
    return qt.length && ntp.length && !qt.some((t) => ntp.includes(t)) ? 0.7 : 0.95;
  }
  // whole-token matches only: "5th" must not match "15th" or "TX 165"
  const tok = (x: string) => ` ${x} `;
  if (tok(n).startsWith(tok(q)) || tok(q).startsWith(tok(n))) return 0.9;
  if (tok(n).includes(tok(q))) return 0.8;
  // typos: every distinctive token matches (allowing one or two letters off) → nearly as good as exact
  if (qc.length && nc.length && qc.length === nc.length && qc.every((t, i) => tokEq(t, nc[i]))) return 0.85;
  // partial overlap on the distinctive tokens only ("Elm Street" shares nothing with "Pine Street")
  const qt = (qc.length ? qc : q.split(" ")).filter((t) => t.length > 1);
  const nt = n.split(" ");
  const hits = qt.filter((t) => nt.some((x) => tokEq(t, x))).length;
  return qt.length ? (0.7 * hits) / qt.length : 0;
}

/** looser similarity for "did you mean" suggestions (never used to act on a name) */
export function looseScore(query: string, name?: string): number {
  if (!name) return 0;
  const s = nameScore(query, name);
  if (s >= 0.3) return s;
  const qc = core(norm(query)).filter((t) => t.length >= 3 && !/\d/.test(t));
  const nc = core(norm(name));
  if (!qc.length) return 0;
  const hits = qc.filter((t) => nc.some((x) => lev(t, x) <= (t.length >= 6 ? 2 : t.length >= 4 && t[0] === x[0] ? 2 : 1))).length;
  return (0.5 * hits) / qc.length;
}

export function entityPoint(e: Entity): Vec2 {
  switch (e.kind) {
    case "building":
      return polyCentroid(e.footprint);
    case "street":
    case "route":
    case "utility":
    case "path":
      return e.path[Math.floor(e.path.length / 2)];
    case "area":
    case "parcel":
      return polyCentroid(e.poly);
    default:
      return e.p;
  }
}

export function entityName(e: Entity): string {
  switch (e.kind) {
    case "building":
      return e.name ?? `${e.use} building (${e.floors} fl, ${e.address ?? e.id.slice(-8)})`;
    case "street":
      return e.name ?? `${e.cls} street`;
    case "node": {
      const names = [...new Set(rt().world.incident(e.id).map((s) => s.name).filter(Boolean))];
      return names.length ? names.join(" & ") : `junction ${e.id}`;
    }
    case "area":
      return e.name ?? e.type;
    case "parcel":
      return `parcel ${e.id} (${e.zoning})`;
    case "place":
      return e.name;
    case "stop":
      return e.name;
    case "route":
      return `${e.ref} ${e.name}`;
    case "poi":
      return e.name ?? e.category;
    case "prop":
      return e.name ?? e.type.split(".").pop()!.replace(/_/g, " ");
    default:
      return e.id;
  }
}

/** streets matching a name (all segments of the corridor) */
/**
 * Streets carrying the best-matching name. Equal-scoring names are all kept, so
 * "6th Street" is both West and East 6th Street and "Lamar Boulevard" is North
 * and South Lamar — the way people name corridors that change prefix midway.
 */
export function streetsNamed(name: string, slack = 0): Street[] {
  const w = rt().world;
  const scored = w.all("street").map((s) => ({ s, sc: nameScore(name, s.name) }));
  const best = Math.max(0, ...scored.map((x) => x.sc));
  if (best < 0.6) return [];
  return scored.filter((x) => x.sc >= best - slack - 1e-9).map((x) => x.s);
}

/** streets matching a name with their scores (≥ min), best first */
export function streetMatches(name: string, min = 0.6): { s: Street; sc: number }[] {
  return rt()
    .world.all("street")
    .map((s) => ({ s, sc: nameScore(name, s.name) }))
    .filter((x) => x.sc >= min)
    .sort((a, b) => b.sc - a.sc);
}

/**
 * Junction where two named streets meet. Every street matching each name is considered (not only
 * the best match), and the meeting with the best combined score wins — so "21st & Guadalupe" finds
 * West 21st Street × Guadalupe Street even when an "East 21st Street" scores the same and never meets
 * Guadalupe. Works the same on any world: city data or a canvas with user-named streets.
 */
export function junctionOf(a: string, b: string): StreetNode | null {
  const w = rt().world;
  const A = streetMatches(a),
    B = streetMatches(b);
  if (!A.length || !B.length) return null;
  const at = new Map<string, { sc: number; name: string }>();
  for (const { s, sc } of A)
    for (const n of [s.from, s.to]) {
      const k = at.get(n);
      if (!k || k.sc < sc) at.set(n, { sc, name: norm(s.name ?? "") });
    }
  let best: StreetNode | null = null,
    bs = -1;
  for (const { s, sc } of B)
    for (const n of [s.from, s.to]) {
      const k = at.get(n);
      // a node where one street continues into itself is not a junction of two streets
      if (!k || k.name === norm(s.name ?? "")) continue;
      if (k.sc + sc > bs) {
        bs = k.sc + sc;
        best = w.get<StreetNode>(n) ?? null;
      }
    }
  if (best) return best;
  // nearest pair (streets that cross with a short offset, or meet mid-segment): best-scoring names first
  const topA = A.filter((x) => x.sc >= A[0].sc - 0.15).map((x) => x.s);
  const topB = B.filter((x) => x.sc >= B[0].sc - 0.15).map((x) => x.s);
  let bd = 40;
  for (const s of topB)
    for (const n of [s.from, s.to]) {
      const nn = w.get<StreetNode>(n);
      if (!nn) continue;
      for (const t of topA) {
        const d = closestOnPath(nn.p, t.path).d;
        if (d < bd) {
          bd = d;
          best = nn;
        }
      }
    }
  return best;
}

export interface PlaceMatch {
  name: string;
  type: string;
  p: Vec2;
  id?: string;
  ids?: string[];
  poly?: Polygon;
  score: number;
}

/** among equally good name matches, prefer the place a person most likely means */
const PLACE_RANK: Record<string, number> = { campus: 0.04, district: 0.03, park: 0.02, neighbourhood: 0.01 };

export function resolvePlace(query: string, limit = 5): PlaceMatch[] {
  const R = rt();
  const w = R.world;
  const q = query.trim().replace(/^(the|a)\s+/i, "");
  const out: PlaceMatch[] = [];
  // intersection "A & B" / "A and B" / "A at B"
  const m = q.split(/\s*(?:&|\band\b|\bat\b|\/|\+|\bx\b|\bcorner of\b)\s*/i).filter(Boolean);
  if (m.length === 2) {
    const n = junctionOf(m[0], m[1]);
    if (n) out.push({ name: entityName(n), type: "junction", p: n.p, id: n.id, score: 1 });
  }
  // feature id
  const byId = w.get(q);
  if (byId) out.push({ name: entityName(byId), type: byId.kind, p: entityPoint(byId), id: byId.id, score: 1 });
  for (const p of w.all("place")) {
    const sc = nameScore(q, p.name);
    if (sc >= 0.6) out.push({ name: p.name, type: p.type, p: p.poly ? polyCentroid(p.poly) : p.p, id: p.refs?.[0] ?? p.id, poly: p.poly, score: sc + (PLACE_RANK[p.type] ?? 0) });
  }
  // named open spaces, plazas and water drawn on the map (a designed canvas has no gazetteer)
  for (const a of w.all("area")) {
    const sc = nameScore(q, a.name);
    if (sc >= 0.7) out.push({ name: a.name!, type: a.type, p: polyCentroid(a.poly), id: a.id, poly: a.poly, score: sc - 0.01 });
  }
  const st = streetsNamed(q);
  if (st.length) {
    const pts = st.flatMap((s) => s.path);
    const c = pts[Math.floor(pts.length / 2)];
    out.push({ name: st[0].name ?? q, type: "street", p: c, ids: st.map((s) => s.id), score: 0.85 });
  }
  for (const b of w.all("building")) {
    const sc = nameScore(q, b.name);
    if (sc >= 0.8) out.push({ name: b.name!, type: "building", p: polyCentroid(b.footprint), id: b.id, score: sc - 0.05 });
  }
  for (const p of w.all("poi")) {
    const sc = nameScore(q, p.name);
    if (sc >= 0.85) out.push({ name: p.name!, type: p.category, p: p.p, id: p.id, score: sc - 0.1 });
  }
  // generic kinds ("the school") when no name matched well
  if (!out.some((x) => x.score >= 0.8)) out.push(...kindMatches(q));
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.score - a.score)
    .filter((x) => {
      const k = `${x.name}:${Math.round(x.p[0] / 30)}:${Math.round(x.p[1] / 30)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);
}

/**
 * Generic kinds people name instead of a proper name ("the school", "a park", "the fire station"):
 * matched on building use / name words, area types and POI categories, nearest to the view first.
 */
const KINDS: { re: RegExp; label: string; building?: (b: Building) => boolean; area?: AreaType[]; poi?: RegExp; place?: string[] }[] = [
  { re: /^(elementary |primary |middle |high )?schools?$/, label: "school", building: (b) => b.use === "education" && !/gym|annex|portable/i.test(b.name ?? ""), poi: /school/ },
  { re: /^(university|college|campus)$/, label: "campus", area: ["campus"], place: ["campus"] },
  { re: /^(parks?|green|playground)$/, label: "park", area: ["park"] },
  { re: /^(plaza|square|town square)$/, label: "plaza", area: ["plaza"] },
  { re: /^(lake|pond|river|water)$/, label: "water", area: ["water", "retention"] },
  { re: /^(fire station|firehouse|fire hall)$/, label: "fire station", building: (b) => /fire/i.test(b.name ?? ""), poi: /fire/ },
  { re: /^(police station|police)$/, label: "police station", building: (b) => /police/i.test(b.name ?? ""), poi: /police/ },
  { re: /^(hospital|clinic|health cent(er|re))$/, label: "clinic", building: (b) => b.use === "health", poi: /hospital|clinic|doctor/ },
  { re: /^(library)$/, label: "library", building: (b) => /librar/i.test(b.name ?? ""), poi: /library/ },
  { re: /^(grocery( store)?|supermarket|market)$/, label: "grocery", building: (b) => /grocer|market|supermarket/i.test(b.name ?? ""), poi: /supermarket|grocery/ },
  { re: /^(cafe|café|coffee shop)$/, label: "café", building: (b) => /caf[eé]|coffee|bean|espresso/i.test(b.name ?? ""), poi: /cafe/ },
  { re: /^(restaurant)$/, label: "restaurant", building: (b) => b.use === "retail" && !!b.name, poi: /restaurant/ },
  { re: /^(office|offices|office building)$/, label: "office", building: (b) => b.use === "office" },
  { re: /^(hotel)$/, label: "hotel", building: (b) => b.use === "hotel" },
];

export function kindMatches(query: string, limit = 3): PlaceMatch[] {
  const q = query.toLowerCase().replace(/^(the|a|an|our|my|nearest|closest)\s+/g, "").replace(/^(nearest|closest)\s+/, "").trim();
  const k = KINDS.find((x) => x.re.test(q));
  if (!k) return [];
  const R = rt();
  const w = R.world;
  const c = R.map ? viewCenter() : (R.meta.initialView?.center ?? [0, 0]);
  const out: PlaceMatch[] = [];
  if (k.building) for (const b of w.all("building")) if (k.building(b)) out.push({ name: b.name ?? k.label, type: k.label, p: polyCentroid(b.footprint), id: b.id, poly: b.footprint, score: 0.75 });
  if (k.area) for (const a of w.all("area")) if (k.area.includes(a.type) && polyArea(a.poly) > 400) out.push({ name: a.name ?? k.label, type: a.type, p: polyCentroid(a.poly), id: a.id, poly: a.poly, score: 0.75 });
  if (k.place) for (const p of w.all("place")) if (k.place.includes(p.type)) out.push({ name: p.name, type: p.type, p: p.poly ? polyCentroid(p.poly) : p.p, id: p.id, poly: p.poly, score: 0.75 });
  if (k.poi) for (const p of w.all("poi")) if (k.poi.test(p.category)) out.push({ name: p.name ?? k.label, type: p.category, p: p.p, id: p.id, score: 0.74 });
  // nearest first; named and larger features break near-ties
  const rank = (m: PlaceMatch) => dist(m.p, c) - (m.name !== k.label ? 60 : 0) - Math.sqrt(m.poly ? polyArea(m.poly) : 0);
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

export function viewCenter(): Vec2 {
  const R = rt();
  const map = R.map;
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  if (!map) return R.meta.initialView.center;
  const c = map.getCenter();
  return proj.toLocal(c.lng, c.lat);
}

export function viewBounds(): [number, number, number, number] {
  const R = rt();
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  const map = R.map;
  if (!map) return R.meta.bounds;
  const b = map.getBounds();
  const sw = proj.toLocal(b.getWest(), b.getSouth());
  const ne = proj.toLocal(b.getEast(), b.getNorth());
  return [sw[0], sw[1], ne[0], ne[1]];
}

const HERE = /^(this|that|these|those|here|there|selection|selected|it|current)(\b.*)?$/i;

export function resolveLocation(loc: Loc | undefined): { p: Vec2; id?: string; label: string } {
  const R = rt();
  if (loc === undefined || loc === null) {
    const sel = useApp.getState().selection;
    if (sel.length) {
      const e = R.world.get(sel[0]);
      if (e) return { p: entityPoint(e), id: e.id, label: entityName(e) };
    }
    return { p: viewCenter(), label: "view centre" };
  }
  if (Array.isArray(loc)) return { p: [Number(loc[0]), Number(loc[1])], label: `(${Math.round(loc[0])}, ${Math.round(loc[1])})` };
  if (HERE.test(loc.trim())) return resolveLocation(undefined);
  const e = R.world.get(loc);
  if (e) return { p: entityPoint(e), id: e.id, label: entityName(e) };
  const m = resolvePlace(loc, 1)[0];
  if (!m) throw new Error(`Could not resolve location “${loc}”. Use resolve_place or find_features first.`);
  return { p: m.p, id: m.id, label: m.name };
}

/** the city block (space between street ROWs) containing a point */
export function blockAt(p: Vec2, maxR = 260): Polygon | null {
  const w = rt().world;
  let land: Polygon[] = [[circle(p, maxR, 48)]];
  for (const e of w.query([p[0] - maxR, p[1] - maxR, p[0] + maxR, p[1] + maxR], ["street"])) {
    const s = e as Street;
    // a city block is bounded by public streets — alleys and private drives run through it
    if (s.tunnel || s.cls === "service" || s.private) continue;
    land = land.flatMap((q) => difference(q, streetBand(s)));
  }
  const hit = land.find((q) => pointInPoly(p, q));
  if (hit) return hit;
  // point on a street: nearest piece
  return land.sort((a, b) => dist(polyCentroid(a), p) - dist(polyCentroid(b), p))[0] ?? null;
}

export function resolveArea(a: AreaRef | undefined): { poly: Polygon; label: string; ids?: string[] } {
  const R = rt();
  const w = R.world;
  if (a === undefined) {
    const sel = useApp.getState().selection;
    const polys = sel.map((id) => w.get(id)).filter(Boolean).map((e) => polyOf(e!)).filter((p): p is Polygon => !!p);
    if (polys.length) {
      const u = polys.length > 1 ? unionMany(polys).sort((x, y) => polyArea(y) - polyArea(x))[0] : polys[0];
      return { poly: u, label: "selection", ids: sel };
    }
    const b = viewBounds();
    const c = viewCenter();
    const r = Math.min(400, Math.max(120, Math.min(b[2] - b[0], b[3] - b[1]) / 3));
    return { poly: [circle(c, r, 40)], label: `view (r=${Math.round(r)} m)` };
  }
  if (Array.isArray(a)) {
    const poly = normalizePoly([a.map((p) => [Number(p[0]), Number(p[1])] as Vec2)]);
    if (!isValidPoly(poly)) throw new Error("Polygon is degenerate");
    return { poly, label: `polygon (${Math.round(polyArea(poly))} m²)` };
  }
  if (typeof a === "object") return { poly: [circle(a.center, a.radius, 40)], label: `circle r=${a.radius} m` };
  if (HERE.test(a.trim())) return resolveArea(undefined);
  const ids = a.split(/[,\s]+/).filter((x) => /^[a-z]+:/.test(x));
  if (ids.length && ids.every((id) => w.get(id))) {
    const polys = ids.map((id) => polyOf(w.get(id)!)).filter((p): p is Polygon => !!p);
    if (polys.length) return { poly: polys.length > 1 ? unionMany(polys).sort((x, y) => polyArea(y) - polyArea(x))[0] : polys[0], label: ids.length > 1 ? `${ids.length} features` : entityName(w.get(ids[0])!), ids };
    const e = w.get(ids[0])!;
    return { poly: [circle(entityPoint(e), 150, 32)], label: `around ${entityName(e)}` };
  }
  const m = resolvePlace(a, 3);
  const withPoly = m.find((x) => x.poly);
  if (withPoly?.poly && withPoly.score >= 0.8) return { poly: withPoly.poly, label: withPoly.name };
  if (m[0]) {
    if (m[0].ids) {
      // a street corridor: buffer it
      const st = m[0].ids.map((id) => w.get<Street>(id)!).filter(Boolean);
      const bands = st.map((s) => streetBand(s));
      return { poly: unionMany(bands).sort((x, y) => polyArea(y) - polyArea(x))[0], label: `${m[0].name} corridor`, ids: m[0].ids };
    }
    if (m[0].id) {
      const e = w.get(m[0].id);
      const p = e ? polyOf(e) : null;
      if (p) return { poly: p, label: m[0].name };
    }
    // neighbourhoods mapped only as a label point: an explicit, labelled approximation
    const r = m[0].type === "neighbourhood" ? 400 : 250;
    return { poly: [circle(m[0].p, r, 40)], label: `${m[0].name} (approximate: ${r} m around its map label — no official boundary in the data)` };
  }
  throw new Error(`Could not resolve area “${a}”`);
}

export function polyOf(e: Entity): Polygon | null {
  if (e.kind === "building") return e.footprint;
  if (e.kind === "area" || e.kind === "parcel") return e.poly;
  if (e.kind === "place" && (e as Place).poly) return (e as Place).poly!;
  if (e.kind === "street") return streetBand(e);
  if (e.kind === "prop" && e.footprint) return e.footprint;
  return null;
}

/** streets selected by ids / name / area / between two cross streets */
export function resolveStreets(p: { street_ids?: string[]; street?: string; within?: AreaRef; between?: string[] }): Street[] {
  const w = rt().world;
  let list: Street[] = [];
  if (p.street_ids?.length) list = p.street_ids.map((id) => w.get<Street>(id)).filter((s): s is Street => !!s && s.kind === "street");
  else if (p.street) list = streetsNamed(p.street);
  else {
    const sel = useApp.getState().selection.map((id) => w.get(id)).filter((e): e is Street => !!e && e.kind === "street");
    if (sel.length) {
      // extend a single selected segment to its whole named corridor within view
      list = sel;
    }
  }
  if (p.within && list.length) {
    const { poly } = resolveArea(p.within);
    list = list.filter((s) => pointInPoly(s.path[Math.floor(s.path.length / 2)], poly));
  } else if (p.within && !list.length) {
    const { poly } = resolveArea(p.within);
    const bb = polyBBox(poly);
    list = w.query(bb, ["street"]).filter((s) => pointInPoly((s as Street).path[Math.floor((s as Street).path.length / 2)], poly)) as Street[];
  }
  if (p.between?.length === 2 && list.length) {
    const a = junctionOf(list[0].name ?? "", p.between[0]);
    const b = junctionOf(list[0].name ?? "", p.between[1]);
    if (a && b) {
      // keep segments whose midpoints project between the two junctions along the corridor
      const axis: Vec2 = [b.p[0] - a.p[0], b.p[1] - a.p[1]];
      const L2 = axis[0] ** 2 + axis[1] ** 2;
      list = list.filter((s) => {
        const m = s.path[Math.floor(s.path.length / 2)];
        const t = ((m[0] - a.p[0]) * axis[0] + (m[1] - a.p[1]) * axis[1]) / L2;
        const off = Math.abs((m[0] - a.p[0]) * axis[1] - (m[1] - a.p[1]) * axis[0]) / Math.sqrt(L2);
        return t > -0.02 && t < 1.02 && off < 40;
      });
    }
  }
  return list.filter((s) => polyLength(s.path) > 0.5);
}

/** map a compass side to the street's left/right */
export function compassSide(s: Street, side?: string): "left" | "right" | "both" | undefined {
  if (!side || side === "both" || side === "left" || side === "right") return side as "left" | "right" | "both" | undefined;
  const a = s.path[0],
    b = s.path[s.path.length - 1];
  const dir: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const leftN: Vec2 = [-dir[1], dir[0]];
  const want: Vec2 = side === "north" ? [0, 1] : side === "south" ? [0, -1] : side === "east" ? [1, 0] : [-1, 0];
  return leftN[0] * want[0] + leftN[1] * want[1] >= 0 ? "left" : "right";
}
