// Navigation: one go_to call resolves what the user named (an intersection, a street, a place, a
// park, a building, a feature id or a point) and flies the camera there with the target highlighted.
// The same resolution runs on Austin and on a designed canvas with user-named streets
// (src/agent/resolve.ts), so "take me to 21st and Guadalupe" and "go to Pine Street" behave alike.

import { polyBBox } from "@/geometry/polygon";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { flyTo, pedestrianAt } from "@/render/camera";
import { LocalProjection } from "@/world/projection";
import type { Street, Vec2 } from "@/world/types";
import { searchPlaces, type PlaceResult } from "@/search";
import { flyToPlace } from "@/search/fly";
import { looseScore, polyOf, resolvePlace, type PlaceMatch } from "./resolve";
import type { ToolContext, ToolOutput } from "./tools";

type In = Record<string, any>;
type BBox = [number, number, number, number];

const r1 = (x: number) => Math.round(x * 10) / 10;
const pt = (p: Vec2) => [r1(p[0]), r1(p[1])];

function boundsOf(m: PlaceMatch): BBox | null {
  const R = rtMaybe();
  if (!R) return null;
  if (m.ids?.length) {
    const pts = m.ids.flatMap((id) => R.world.get<Street>(id)?.path ?? []);
    if (pts.length) return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  }
  if (m.poly) return polyBBox(m.poly) as BBox;
  if (m.id) {
    const e = R.world.get(m.id);
    const poly = e ? polyOf(e) : null;
    if (poly && e?.kind !== "street") return polyBBox(poly) as BBox;
  }
  return null;
}

const area = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);
const gap = (a: BBox, b: BBox) => Math.max(0, a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);

/**
 * Same-named pieces of one place (a campus mapped as several polygons) framed together: the largest
 * piece anchors the view and only pieces next to it join (a satellite site across town does not).
 */
function placeFrame(all: PlaceMatch[], top: PlaceMatch): { anchor: PlaceMatch; bb: BBox | null } {
  const same = all.filter((m) => m.name === top.name && m.type === top.type).map((m) => ({ m, bb: boundsOf(m) }));
  const withBox = same.filter((x): x is { m: PlaceMatch; bb: BBox } => !!x.bb).sort((a, b) => area(b.bb) - area(a.bb));
  if (!withBox.length) return { anchor: top, bb: null };
  const A = withBox[0];
  const near = withBox.filter((x) => gap(x.bb, A.bb) < 250).map((x) => x.bb);
  const bb: BBox = [Math.min(...near.map((b) => b[0])), Math.min(...near.map((b) => b[1])), Math.max(...near.map((b) => b[2])), Math.max(...near.map((b) => b[3]))];
  return { anchor: { ...A.m, p: [(A.bb[0] + A.bb[2]) / 2, (A.bb[1] + A.bb[3]) / 2] }, bb };
}

/** fly to frame a local-metre box (aerial, pitched) */
export function frame(bb: BBox, zoomOverride?: number) {
  const R = rtMaybe();
  const map = R?.map;
  const c: Vec2 = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
  if (!R || !map) return;
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  let zoom = zoomOverride;
  if (zoom === undefined) {
    const pad = 60;
    const sw = proj.toLonLat([bb[0] - pad, bb[1] - pad]);
    const ne = proj.toLonLat([bb[2] + pad, bb[3] + pad]);
    try {
      const cam = map.cameraForBounds([sw, ne] as never, { padding: 80 });
      zoom = cam?.zoom;
    } catch {
      zoom = undefined;
    }
    // a pitched view foreshortens the far side, so the flat fit leaves room: come in a little
    zoom = Math.max(14.8, Math.min(17.4, (zoom ?? 16.5) + 0.35));
  }
  flyTo(c, { zoom, pitch: 55 });
}

/** what a search hit is, in the agent's terms: an area's own type (park, plaza…), else the hit's kind */
function typeOf(r: PlaceResult): string {
  const e = r.ids.length ? rtMaybe()?.world.get(r.ids[0]) : undefined;
  if (e?.kind === "area") return e.type;
  if ((r.kind === "design" || r.kind === "area") && e) return e.kind;
  return r.kind;
}

export const NAV_TOOLS: Record<string, (i: In, ctx: ToolContext) => Promise<ToolOutput>> = {
  async go_to(i) {
    const R = rtMaybe();
    if (!R) return { content: { error: "No world loaded" }, display: { title: "Go to", detail: "no world", status: "error" }, isError: true };
    const st = useApp.getState();
    const leaveStreetLevel = () => {
      if (!i.street_level && st.cameraMode === "pedestrian") st.setCameraMode("orbit");
    };
    // a point
    if (Array.isArray(i.place)) {
      const p: Vec2 = [Number(i.place[0]), Number(i.place[1])];
      leaveStreetLevel();
      if (i.street_level) {
        pedestrianAt(p);
        st.setCameraMode("pedestrian");
      } else flyTo(p, { zoom: i.zoom ?? 17.2, pitch: 55 });
      return { content: { went_to: { type: "point", at: pt(p) } }, display: { title: `Went to (${Math.round(p[0])}, ${Math.round(p[1])})`, status: "ok" } };
    }
    const q = String(i.place ?? "").trim();
    // a name: the top bar's place index, so the agent lands where the search box would (an
    // entity id, or a name the index doesn't know, falls through to the reference resolver)
    const hits = R.world.get(q) ? [] : searchPlaces(q, 5);
    const best = hits[0];
    if (best && best.score >= 0.75) {
      leaveStreetLevel();
      if (i.street_level) {
        pedestrianAt(best.point);
        st.setCameraMode("pedestrian");
      } else if (i.zoom !== undefined) flyTo(best.point, { zoom: i.zoom, pitch: 55 });
      else void flyToPlace(best);
      // a junction: its node(s) and the streets meeting there (set_junction takes the node id)
      const junction = best.kind === "intersection";
      const hl = junction ? [...best.ids, ...best.ids.flatMap((n) => R.world.incident(n).map((x) => x.id))] : best.ids;
      if (hl.length) st.setHighlight({ ids: [...new Set(hl)], label: best.label });
      const alternatives = hits
        .slice(1)
        .filter((h) => h.label !== best.label && h.score >= best.score - 0.12)
        .slice(0, 3)
        .map((h) => `${h.label} (${h.detail})`);
      const [x0, y0, x1, y1] = best.bbox;
      const size = Math.max(x1 - x0, y1 - y0);
      const streets = (junction ? hl : best.ids).filter((id) => R.world.get(id)?.kind === "street");
      return {
        content: {
          went_to: { name: best.label, type: junction ? "junction" : typeOf(best), what: best.detail, at: pt(best.point), id: junction || best.ids.length === 1 ? best.ids[0] : undefined, street_ids: streets.length ? streets.slice(0, 40) : undefined, extent_ft: size > 40 ? Math.round(size * 3.28084) : undefined },
          alternatives: alternatives.length ? alternatives : undefined,
          exact: best.score >= 1 || undefined,
        },
        display: { title: `Went to ${best.label}`, detail: alternatives.length ? `also: ${alternatives.join(" · ")}` : best.detail, status: "ok" },
      };
    }
    const matches = resolvePlace(q, 8);
    if (!matches.length) {
      const suggestions = suggest(q);
      return {
        content: { error: `Nothing named “${q}” on this map.`, suggestions },
        display: { title: `Go to “${q}”`, detail: suggestions.length ? `Not found — did you mean ${suggestions.slice(0, 3).join(", ")}?` : "Not found", status: "error" },
        isError: true,
      };
    }
    const framed = matches[0].type === "junction" ? { anchor: matches[0], bb: null } : placeFrame(matches, matches[0]);
    const top = framed.anchor;
    const bb = framed.bb;
    leaveStreetLevel();
    if (i.street_level) {
      pedestrianAt(top.p);
      st.setCameraMode("pedestrian");
    } else if (bb && (bb[2] - bb[0] > 40 || bb[3] - bb[1] > 40)) frame(bb, i.zoom);
    // a junction: close enough to read the corner, pitched less so towers on the corners don't hide it
    else flyTo(top.p, { zoom: i.zoom ?? (top.type === "junction" ? 17.3 : 17.2), pitch: top.type === "junction" ? 45 : 55 });
    // highlight: the junction's streets, the corridor, or the feature itself
    let ids: string[] = [];
    if (top.type === "junction" && top.id) ids = [top.id, ...R.world.incident(top.id).map((s) => s.id)];
    else if (top.ids?.length) ids = top.ids;
    else if (top.id && R.world.get(top.id)) ids = matches.filter((m) => m.name === top.name && m.id && R.world.get(m.id)).map((m) => m.id!);
    if (ids.length) st.setHighlight({ ids, label: top.name });
    const alternatives = matches
      .slice(1)
      .filter((m) => m.name !== top.name && m.score >= top.score - 0.12)
      .slice(0, 3)
      .map((m) => `${m.name} (${m.type})`);
    const size = bb ? Math.round(Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 3.28084) : undefined;
    return {
      content: { went_to: { name: top.name, type: top.type, at: pt(top.p), id: top.id, street_ids: top.ids?.slice(0, 40), extent_ft: size }, alternatives: alternatives.length ? alternatives : undefined, exact: top.score >= 0.95 || undefined },
      display: { title: `Went to ${top.name}`, detail: alternatives.length ? `also: ${alternatives.join(" · ")}` : top.type, status: "ok" },
    };
  },
};

/** closest names on the map for a query that resolved to nothing (streets, places, named areas and buildings) */
export function suggest(q: string, limit = 5): string[] {
  const R = rtMaybe();
  if (!R) return [];
  const w = R.world;
  const parts = q.split(/\s*(?:&|\band\b|\bat\b|\/)\s*/i).filter(Boolean);
  const names = new Map<string, number>();
  const consider = (name: string | undefined) => {
    if (!name) return;
    const sc = Math.max(...parts.map((p) => looseScore(p, name)));
    if (sc >= 0.25 && (names.get(name) ?? 0) < sc) names.set(name, sc);
  };
  for (const s of w.all("street")) consider(s.name);
  for (const p of w.all("place")) consider(p.name);
  for (const a of w.all("area")) consider(a.name);
  for (const b of w.all("building")) consider(b.name);
  return [...names.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([n]) => n);
}
