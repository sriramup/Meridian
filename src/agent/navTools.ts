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
import { nameScore, polyOf, resolvePlace, type PlaceMatch } from "./resolve";
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

/** same-named pieces of one place (a campus mapped as several polygons) framed together */
function mergedBounds(all: PlaceMatch[], top: PlaceMatch): BBox | null {
  const same = all.filter((m) => m.name === top.name && m.type === top.type);
  const bbs = same.map(boundsOf).filter((b): b is BBox => !!b);
  if (!bbs.length) return null;
  return [Math.min(...bbs.map((b) => b[0])), Math.min(...bbs.map((b) => b[1])), Math.max(...bbs.map((b) => b[2])), Math.max(...bbs.map((b) => b[3]))];
}

/** fly to frame a local-metre box (aerial, pitched) */
function frame(bb: BBox, zoomOverride?: number) {
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
    // pitched views show more than the flat fit: back off a little, and keep within a useful range
    zoom = Math.max(14.5, Math.min(17.6, (zoom ?? 16.5) - 0.4));
  }
  flyTo(c, { zoom, pitch: 55 });
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
    const matches = resolvePlace(q, 8);
    if (!matches.length) {
      const suggestions = suggest(q);
      return {
        content: { error: `Nothing named “${q}” on this map.`, suggestions },
        display: { title: `Go to “${q}”`, detail: suggestions.length ? `Not found — did you mean ${suggestions.slice(0, 3).join(", ")}?` : "Not found", status: "error" },
        isError: true,
      };
    }
    const top = matches[0];
    const bb = top.type === "junction" ? null : mergedBounds(matches, top);
    leaveStreetLevel();
    if (i.street_level) {
      pedestrianAt(top.p);
      st.setCameraMode("pedestrian");
    } else if (bb && (bb[2] - bb[0] > 40 || bb[3] - bb[1] > 40)) frame(bb, i.zoom);
    else flyTo(top.p, { zoom: i.zoom ?? (top.type === "junction" ? 17.6 : 17.4), pitch: 55 });
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
    const sc = Math.max(...parts.map((p) => nameScore(p, name)));
    if (sc >= 0.3 && (names.get(name) ?? 0) < sc) names.set(name, sc);
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
