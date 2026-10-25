"use client";

// Placing an armed library primitive: turn the pointer state into a PlacementInput for the
// definition's placement type, snap it (grid, building corners, 15° turns, street frontage), dry-run
// the real op (placePrimitive, not committed) for the live preview and its validity, and commit
// exactly what was previewed on click / finish.
//
// Collisions: the ops refuse any overlap with buildings and solid props (the safe default). When a
// small single-piece placement only just touches something, it slides out to the nearest free spot
// (flush against its neighbour); otherwise the preview turns red with the reason, shows the nearest
// free spot as a dashed outline, and a click does nothing.

import { polyArea, polyBBox, rectangle, translatePoly } from "@/geometry/polygon";
import { ensureLibrary, getPrimitive, type PlacementInput, type PrimitiveDef } from "@/library";
import { fmtArea, fmtFt, fmtLen } from "@/lib/units";
import { applyOp } from "@/state/actions";
import { rt } from "@/state/runtime";
import { gridStep, snapPoint, streetSnapOn, turnStep } from "@/state/snap";

export { snapPoint };
import { useApp } from "@/state/store";
import { blockedAt, nearestFreeOffset, obstacles, type Obstacle } from "@/world/ops/collision";
import { instanceOf, isSolidProp, placePrimitive, type LibraryOpResult } from "@/world/ops/library";
import { facingRotation, frontageSnap, frontDepthOf, nearestFrontage, snapAngle } from "@/world/ops/snap";
import { streetBand } from "@/world/ops/validate";
import type { Area, Building, Entity, Polygon, Prop, Street, Vec2 } from "@/world/types";
import { anchorOf, moveBy } from "./instanceOps";
import { armedParams, useLibrary } from "./libraryStore";

const user = { author: "user" as const };
/** a press that moves less than this (m) is a click, not a drag */
export const DRAG_MIN = 0.8;

export function armedDef(): PrimitiveDef | undefined {
  const id = useLibrary.getState().defId;
  if (!id) return undefined;
  ensureLibrary();
  return getPrimitive(id);
}

/** the map's bearing as a world heading, so drawn rectangles line up with the screen */
function screenHeading(): number {
  const b = rt().map?.getBearing() ?? 0;
  return -b;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** a rectangle spanned by two opposite corners, its sides along `heading` */
export function rectFromCorners(a: Vec2, b: Vec2, heading: number): { site: Vec2[]; at: Vec2; width: number; depth: number } {
  const t = (heading * Math.PI) / 180;
  const u: Vec2 = [Math.cos(t), Math.sin(t)];
  const v: Vec2 = [-u[1], u[0]];
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const du = d[0] * u[0] + d[1] * u[1];
  const dv = d[0] * v[0] + d[1] * v[1];
  const at: Vec2 = [a[0] + d[0] / 2, a[1] + d[1] / 2];
  return { site: rectangle(at, Math.abs(du), Math.abs(dv), t), at, width: Math.abs(du), depth: Math.abs(dv) };
}

function streetsNear(p: Vec2, r: number): Street[] {
  return rt().world.query([p[0] - r, p[1] - r, p[0] + r, p[1] + r], ["street"]) as Street[];
}

/** heading of the street whose frontage p is on (for lining a dragged rectangle up with it) */
function streetHeading(p: Vec2): number | null {
  if (!streetSnapOn()) return null;
  const f = nearestFrontage(streetsNear(p, 80), p, 30);
  return f ? (Math.atan2(f.along[1], f.along[0]) * 180) / Math.PI : null;
}

/**
 * The placement the pointer currently describes (snapped), or null when there isn't one yet.
 * `final` is the committed shape (no rubber-band point at the cursor).
 */
export function currentPlacement(def: PrimitiveDef, final = false): PlacementInput | null {
  const s = useLibrary.getState();
  const cursor = s.cursor ? snapPoint(s.cursor, def.placement !== "point") : null;
  switch (def.placement) {
    case "point": {
      if (s.drag && dist(s.drag.from, s.drag.to) >= DRAG_MIN) {
        const from = snapPoint(s.drag.from);
        const r = (Math.atan2(s.drag.to[1] - from[1], s.drag.to[0] - from[0]) * 180) / Math.PI;
        const step = turnStep();
        return { at: from, rotation: step ? snapAngle(r, step) : Math.round(r * 10) / 10 };
      }
      const at = s.drag ? snapPoint(s.drag.from) : cursor;
      return at ? { at, rotation: s.rotation } : null;
    }
    case "rect": {
      if (s.drag && dist(s.drag.from, s.drag.to) >= DRAG_MIN * 3) {
        const from = snapPoint(s.drag.from, true);
        const to = snapPoint(s.drag.to, true);
        // lined up with the street it fronts, else the grid, else the screen
        const h = streetHeading(from) ?? (gridStep() ? 0 : screenHeading());
        const r = rectFromCorners(from, to, h);
        if (r.width < 1 || r.depth < 1) return null;
        return { at: r.at, rotation: h, site: [r.site] };
      }
      const at = s.drag ? snapPoint(s.drag.from) : cursor;
      return at ? { at, rotation: s.rotation } : null;
    }
    case "polygon": {
      const pts = final || !cursor ? s.points : [...s.points, cursor];
      return pts.length >= 3 ? { site: [pts] } : null;
    }
    case "path": {
      const pts = final || !cursor ? s.points : [...s.points, cursor];
      return pts.length >= 2 ? { path: pts } : null;
    }
  }
}

/**
 * Parameters for the current placement: the armed values, with a dragged rectangle's size written
 * into the definition's width / depth parameters when it has them (so the form and the generator agree).
 */
export function placementParams(def: PrimitiveDef, place: PlacementInput): Record<string, unknown> {
  const params = { ...armedParams() };
  if (def.placement !== "rect" || !place.site) return params;
  const r = place.site[0];
  const w = Math.hypot(r[1][0] - r[0][0], r[1][1] - r[0][1]);
  const d = Math.hypot(r[2][0] - r[1][0], r[2][1] - r[1][1]);
  for (const [keys, v] of [[["width", "length", "frontage"], w], [["depth"], d]] as const) {
    const spec = def.params.find((p) => (keys as readonly string[]).includes(p.key) && (p.type === "number" || p.type === "integer"));
    if (spec && (spec.type === "number" || spec.type === "integer")) params[spec.key] = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? 0, spec.type === "integer" ? Math.round(v) : Math.round(v * 10) / 10));
  }
  return params;
}

export interface Preview {
  ok: boolean;
  /** why it can't go there */
  error?: string;
  warnings: string[];
  /** what would be created (or, when blocked, what the generator makes there) */
  entities: Entity[];
  place: PlacementInput;
  /** the dry-run result, committed as it is on click */
  res?: LibraryOpResult;
  /** a short readout beside the cursor (dimensions, setback, heading, distance moved) */
  readout?: string;
  /** when blocked: where the nearest free spot is (outlines of the pieces moved there) */
  suggestion?: Polygon[];
  /** slid out of a collision to the nearest free spot */
  slid?: boolean;
}

// ------------------------------------------------------------------ collision helpers

/** footprints of what would stand solid on the ground (buildings and solid props) */
function solidPieces(ents: Entity[]): Polygon[] {
  const out: Polygon[] = [];
  for (const e of ents) {
    if (e.kind === "building") out.push((e as Building).footprint);
    else if (e.kind === "prop" && (e as Prop).footprint && isSolidProp(e as Prop)) out.push((e as Prop).footprint!);
  }
  return out.filter((p) => p?.[0]?.length >= 3);
}

/** what solid pieces must stay clear of near `pieces` (ignoring entities in `skip`) */
function obstaclesNear(pieces: Polygon[], reach: number, withStreets: boolean, skip: Set<string> = new Set()): Obstacle[] {
  const bb = pieces.map((p) => polyBBox(p)).reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])]);
  const q: [number, number, number, number] = [bb[0] - reach, bb[1] - reach, bb[2] + reach, bb[3] + reach];
  const polys: Polygon[] = [];
  for (const e of rt().world.query(q, withStreets ? ["building", "prop", "street"] : ["building", "prop"])) {
    if (skip.has(e.id)) continue;
    if (e.kind === "building") polys.push((e as Building).footprint);
    else if (e.kind === "prop") {
      const p = e as Prop;
      if (p.footprint && isSolidProp(p)) polys.push(p.footprint);
    } else if (!(e as Street).tunnel && (e as Street).cls !== "motorway") polys.push(streetBand(e as Street));
  }
  return obstacles(polys);
}

/** how far a blocked placement may slide on its own: a little for its size, or most of a grid step (the grid can't land between) */
const slideReach = (size: number) => Math.max(Math.min(6, Math.max(1.5, size * 0.4)), Math.min(16, gridStep() * 0.75));

const isCollision = (err?: string) => !!err && /would overlap|inside a building|another object|on a tree|on top of an object/.test(err);

function shifted(place: PlacementInput, d: Vec2): PlacementInput {
  return {
    ...place,
    ...(place.at ? { at: [place.at[0] + d[0], place.at[1] + d[1]] as Vec2 } : {}),
    ...(place.site ? { site: translatePoly(place.site, d) } : {}),
    ...(place.path ? { path: place.path.map((q) => [q[0] + d[0], q[1] + d[1]] as Vec2) } : {}),
  };
}

/** the size of a footprint along / across a heading: "40 × 30 ft" */
function dims(poly: Polygon, heading: number): string {
  const t = (heading * Math.PI) / 180;
  const u: Vec2 = [Math.cos(t), Math.sin(t)];
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const q of poly[0]) {
    const a = q[0] * u[0] + q[1] * u[1];
    const b = -q[0] * u[1] + q[1] * u[0];
    x0 = Math.min(x0, a);
    x1 = Math.max(x1, a);
    y0 = Math.min(y0, b);
    y1 = Math.max(y1, b);
  }
  return `${fmtFt(x1 - x0).replace(" ft", "")} × ${fmtFt(y1 - y0)}`;
}

// ------------------------------------------------------------------ move

/** the offset a move would apply (snapped cursor minus the instance's anchor) */
function moveDelta(): { id: string; by: Vec2; at: Vec2; entities: string[] } | null {
  const s = useLibrary.getState();
  if (!s.moving || !s.cursor) return null;
  const info = instanceOf(rt().world, s.moving);
  const a = info ? anchorOf(info.placement) : null;
  if (!info || !a) return null;
  const at = snapPoint(s.cursor);
  return { id: info.primary, by: [at[0] - a[0], at[1] - a[1]], at, entities: info.entities };
}

function changed(res: LibraryOpResult): Entity[] {
  const out: Entity[] = [];
  if (res.changeset) for (const op of res.changeset.ops) if (op.type !== "remove") out.push(op.type === "add" ? op.entity : op.after);
  return out;
}

/** dry-run moving the picked-up instance to the cursor (sliding out of a light collision) */
export function computeMovePreview(): Preview | null {
  const m = moveDelta();
  if (!m) return null;
  const place = { at: m.at };
  const readout = `moved ${fmtLen(Math.hypot(m.by[0], m.by[1]))}`;
  const res = moveBy(m.id, m.by);
  if (res.ok && res.changeset) return { ok: true, warnings: res.report.warnings, entities: changed(res), place, res, readout };
  let suggestion: Polygon[] | undefined;
  if (isCollision(res.error)) {
    // slide out: the instance's solid pieces at the new spot, clear of everything but itself
    const W = rt().world;
    const own = new Set(m.entities);
    const pieces = solidPieces(m.entities.map((id) => W.get(id)).filter((e): e is Entity => !!e)).map((p) => translatePoly(p, m.by));
    if (pieces.length && pieces.length <= 4) {
      const size = Math.sqrt(Math.max(...pieces.map((p) => polyArea(p))));
      const d = nearestFreeOffset(pieces, obstaclesNear(pieces, 12, true, own), { maxR: slideReach(size), step: 0.5 });
      if (d && (d[0] || d[1])) {
        const by: Vec2 = [m.by[0] + d[0], m.by[1] + d[1]];
        const r2 = moveBy(m.id, by);
        if (r2.ok) return { ok: true, warnings: r2.report.warnings, entities: changed(r2), place: { at: [m.at[0] + d[0], m.at[1] + d[1]] }, res: r2, readout: `${readout} · flush`, slid: true };
      }
      const far = nearestFreeOffset(pieces, obstaclesNear(pieces, 45, true, own), { maxR: 40, step: 1 });
      if (far && (far[0] || far[1])) suggestion = pieces.map((p) => translatePoly(p, far));
    }
  }
  return { ok: false, error: shortError(res.error ?? "Can't move it here"), warnings: [], entities: [], place, readout, suggestion };
}

/** put the picked-up instance down where the preview shows it (nothing happens while it is red) */
export function commitMove(): boolean {
  const pv = computeMovePreview();
  const s = useLibrary.getState();
  if (!pv?.ok || !pv.res) return false;
  const id = s.moving;
  const ok = applyOp(pv.res);
  if (ok && id) {
    const info = instanceOf(rt().world, id);
    if (info) useApp.getState().setSelection([info.primary]);
    s.endMove();
  }
  return ok;
}

// ------------------------------------------------------------------ place

function dryRun(def: PrimitiveDef, place: PlacementInput, params: Record<string, unknown>): LibraryOpResult {
  try {
    return placePrimitive(rt().world, { def, params, ...place }, user);
  } catch (e) {
    return { ok: false, error: (e as Error).message, report: { summary: [], warnings: [], conflicts: [] }, created: [], removed: [], modified: [] } as unknown as LibraryOpResult;
  }
}

function created(res: LibraryOpResult): Entity[] {
  const ids = new Set(res.created);
  const out: Entity[] = [];
  if (res.changeset)
    for (const op of res.changeset.ops) {
      const e = op.type === "add" ? op.entity : op.type === "update" ? op.after : null;
      if (e && ids.has(e.id)) out.push(e);
    }
  return out;
}

/** dry-run the real op at the current (snapped) placement; nothing is committed */
export function computePreview(def: PrimitiveDef, final = false): Preview | null {
  let place = currentPlacement(def, final);
  if (!place) return null;
  const params = placementParams(def, place);
  const s = useLibrary.getState();
  const dragging = !!s.drag && dist(s.drag.from, s.drag.to) >= DRAG_MIN;
  let readout: string | undefined;
  let raw = ghost(def, place, params);

  // street frontage: a building (or a home on its lot) placed near a street faces it, and its front
  // (the lot's front line, when it has one) settles on the right-of-way or a setback line
  const blds = raw.filter((e) => e.kind === "building");
  if (place.at && !place.site && !dragging && streetSnapOn() && blds.length >= 1 && blds.length <= 3 && (def.placement === "point" || def.placement === "rect")) {
    const f = nearestFrontage(streetsNear(place.at, 80), place.at, 30);
    if (f) {
      const facing: PlacementInput = { ...place, rotation: Math.round(facingRotation(f) * 10) / 10 };
      const g = ghost(def, facing, params);
      const lots = g.filter((e) => e.kind === "area").map((e) => (e as Area).poly);
      const fp = lots.length ? lots : g.filter((e) => e.kind === "building").map((e) => (e as Building).footprint);
      if (fp.length) {
        // a lot carries its own front yard: its front line goes on the right-of-way line
        const snap = lots.length ? frontageSnap(f, place.at, frontDepthOf(fp, place.at, facing.rotation!), 8, [0]) : frontageSnap(f, place.at, frontDepthOf(fp, place.at, facing.rotation!));
        place = { ...facing, at: snap.at };
        raw = ghost(def, place, params);
        readout = snap.setback === null ? "faces the street" : snap.setback === 0 ? "on the frontage line" : `${fmtFt(snap.setback)} setback`;
      }
    }
  }

  // dimensions while drawing
  const main = raw.find((e) => e.kind === "building") as Building | undefined;
  const mainFp = main?.footprint ?? (raw.find((e) => e.kind === "prop") as Prop | undefined)?.footprint;
  if (def.placement === "rect" && place.site) readout = [dims(place.site, place.rotation ?? 0), readout].filter(Boolean).join(" · ");
  else if (def.placement !== "polygon" && def.placement !== "path" && mainFp) readout = [dims(mainFp, place.rotation ?? 0), readout, dragging || s.rotation ? `${Math.round(place.rotation ?? 0)}°` : null].filter(Boolean).join(" · ");
  else if (def.placement === "polygon" && place.site) {
    const ring = place.site[0];
    const seg = ring.length >= 2 && !final ? fmtLen(dist(ring[ring.length - 2], ring[ring.length - 1])) : null;
    readout = [seg, fmtArea(polyArea(place.site))].filter(Boolean).join(" · ");
  } else if (def.placement === "path" && place.path) {
    let L = 0;
    for (let i = 1; i < place.path.length; i++) L += dist(place.path[i - 1], place.path[i]);
    readout = fmtLen(L);
  }

  const res = dryRun(def, place, params);
  if (res.ok && res.changeset) return { ok: true, warnings: res.report.warnings, entities: created(res), place, res, readout };

  // a light collision of a small placement: slide out to the nearest free spot (flush)
  let suggestion: Polygon[] | undefined;
  const pieces = solidPieces(raw);
  if (isCollision(res.error) && pieces.length && pieces.length <= 4 && (def.placement === "point" || (def.placement === "rect" && !place.site))) {
    const size = Math.sqrt(Math.max(...pieces.map((p) => polyArea(p))));
    const withStreets = raw.some((e) => e.kind === "building");
    const obs = obstaclesNear(pieces, 12, withStreets);
    if (blockedAt(pieces, obs)) {
      const d = nearestFreeOffset(pieces, obs, { maxR: slideReach(size), step: 0.5 });
      if (d && (d[0] || d[1])) {
        const p2 = shifted(place, d);
        const r2 = dryRun(def, p2, params);
        if (r2.ok && r2.changeset) return { ok: true, warnings: r2.report.warnings, entities: created(r2), place: p2, res: r2, readout: [readout, "flush"].filter(Boolean).join(" · "), slid: true };
      }
      const far = nearestFreeOffset(pieces, obstaclesNear(pieces, 45, withStreets), { maxR: 40, step: 1 });
      if (far && (far[0] || far[1])) suggestion = pieces.map((p) => translatePoly(p, far));
    }
  }
  return { ok: false, error: shortError(res.error), warnings: [], entities: raw, place, readout, suggestion };
}

/** the reason, short, without ids or the agent-facing advice (the map shows the free spot instead) */
export function shortError(e?: string): string {
  if (!e) return "Can't be placed here";
  let m = e.match(/would overlap (.+?)\.(?: |$)/);
  if (m) return `Overlaps ${m[1].replace(/ [a-z]+:[\w-]+$/, "")}`;
  m = e.match(/can't stand at \[[^\]]*\]: (.+?)\.?(?: Nearest|$)/) ?? e.match(/No room for .+? at \[[^\]]*\]: (.+?)\.?$/);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return e
    .replace(/ Nearest free spot:.*?\]\./, "")
    .replace(/ Move it, or use on_conflict.*$/, "")
    .replace(/ at \[-?\d+, -?\d+\]/, "")
    .replace(/^lib:\S+: /, "");
}

/** the generator's raw output (no conflict handling): drawn in red where a placement is refused */
function ghost(def: PrimitiveDef, place: PlacementInput, params: Record<string, unknown>): Entity[] {
  let n = 0;
  try {
    const g = def.generate(params, place, {
      id: (p) => `ghost:${p}${n++}`,
      ref: { def: def.id, instance: "ghost", params, placement: place },
      householdSize: rt().meta.calibration.householdSize || 2.5,
    });
    return [...(g.buildings ?? []), ...(g.props ?? []), ...(g.trees ?? []), ...(g.areas ?? []), ...(g.paths ?? [])];
  } catch {
    return [];
  }
}

/** place the armed primitive exactly as previewed; selects what was made. A red preview does nothing. */
export function commitPlacement(): boolean {
  const def = armedDef();
  if (!def) return false;
  const pv = computePreview(def, true);
  if (!pv?.ok || !pv.res) return false;
  const res = pv.res;
  if (!applyOp(res)) return false;
  const primary = (res.data?.primary as string | undefined) ?? res.created[0];
  if (primary) useApp.getState().setSelection([primary]);
  const s = useLibrary.getState();
  // point / rect placement keeps the tool for the next one; drawn shapes start over
  useLibrary.setState({ points: [], drag: null, tick: s.tick + 1 });
  return true;
}
