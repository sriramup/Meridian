"use client";

// Placing an armed library primitive: turn the pointer state into a PlacementInput for the
// definition's placement type, dry-run the real op (placePrimitive, not committed) for the live
// preview and its validity, and commit it on click / finish.

import { rectangle } from "@/geometry/polygon";
import { ensureLibrary, getPrimitive, type PlacementInput, type PrimitiveDef } from "@/library";
import { applyOp } from "@/state/actions";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import { instanceOf, placePrimitive } from "@/world/ops/library";
import { anchorOf, moveBy } from "./instanceOps";
import type { Entity, Vec2 } from "@/world/types";
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

/**
 * The placement the pointer currently describes, or null when there isn't one yet. `final` is
 * the committed shape (no rubber-band point at the cursor).
 */
export function currentPlacement(def: PrimitiveDef, final = false): PlacementInput | null {
  const s = useLibrary.getState();
  switch (def.placement) {
    case "point": {
      if (s.drag && dist(s.drag.from, s.drag.to) >= DRAG_MIN) {
        const r = (Math.atan2(s.drag.to[1] - s.drag.from[1], s.drag.to[0] - s.drag.from[0]) * 180) / Math.PI;
        return { at: s.drag.from, rotation: Math.round(r) };
      }
      const at = s.drag?.from ?? s.cursor;
      return at ? { at, rotation: s.rotation } : null;
    }
    case "rect": {
      if (s.drag && dist(s.drag.from, s.drag.to) >= DRAG_MIN * 3) {
        const h = screenHeading();
        const r = rectFromCorners(s.drag.from, s.drag.to, h);
        if (r.width < 1 || r.depth < 1) return null;
        return { at: r.at, rotation: h, site: [r.site] };
      }
      const at = s.drag?.from ?? s.cursor;
      return at ? { at, rotation: s.rotation } : null;
    }
    case "polygon": {
      const pts = final || !s.cursor ? s.points : [...s.points, s.cursor];
      return pts.length >= 3 ? { site: [pts] } : null;
    }
    case "path": {
      const pts = final || !s.cursor ? s.points : [...s.points, s.cursor];
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
}

/** the offset a move would apply (cursor minus the instance's anchor) */
function moveDelta(): { id: string; by: Vec2; at: Vec2 } | null {
  const s = useLibrary.getState();
  if (!s.moving || !s.cursor) return null;
  const info = instanceOf(rt().world, s.moving);
  const a = info ? anchorOf(info.placement) : null;
  if (!info || !a) return null;
  return { id: info.primary, by: [s.cursor[0] - a[0], s.cursor[1] - a[1]], at: s.cursor };
}

/** dry-run moving the picked-up instance to the cursor */
export function computeMovePreview(): Preview | null {
  const m = moveDelta();
  if (!m) return null;
  const res = moveBy(m.id, m.by);
  const place = { at: m.at };
  if (!res.ok || !res.changeset) return { ok: false, error: res.error ?? "Can't move it here", warnings: [], entities: [], place };
  const entities: Entity[] = [];
  for (const op of res.changeset.ops) if (op.type !== "remove") entities.push(op.type === "add" ? op.entity : op.after);
  return { ok: true, warnings: res.report.warnings, entities, place };
}

/** put the picked-up instance down at the cursor */
export function commitMove(): boolean {
  const m = moveDelta();
  const s = useLibrary.getState();
  if (!m) return false;
  const ok = applyOp(moveBy(m.id, m.by));
  if (ok) {
    const info = instanceOf(rt().world, m.id);
    if (info) useApp.getState().setSelection([info.primary]);
    s.endMove();
  }
  return ok;
}

/** dry-run the real op at the current placement (nothing is committed) */
export function computePreview(def: PrimitiveDef): Preview | null {
  const place = currentPlacement(def);
  if (!place) return null;
  const R = rt();
  const params = placementParams(def, place);
  let res: ReturnType<typeof placePrimitive>;
  try {
    res = placePrimitive(R.world, { def, params, ...place }, user);
  } catch (e) {
    return { ok: false, error: (e as Error).message, warnings: [], entities: [], place };
  }
  if (res.ok && res.changeset) {
    const created = new Set(res.created);
    const entities: Entity[] = [];
    for (const op of res.changeset.ops) {
      const e = op.type === "add" ? op.entity : op.type === "update" ? op.after : null;
      if (e && created.has(e.id)) entities.push(e);
    }
    return { ok: true, warnings: res.report.warnings, entities, place };
  }
  return { ok: false, error: res.error ?? "Can't be placed here", warnings: [], entities: ghost(def, place, params), place };
}

/** the generator's raw output (no conflict handling), drawn in red where a placement is refused */
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

/** place the armed primitive at the current placement; selects what was made */
export function commitPlacement(): boolean {
  const def = armedDef();
  if (!def) return false;
  const place = currentPlacement(def, true);
  if (!place) return false;
  const R = rt();
  const res = placePrimitive(R.world, { def, params: placementParams(def, place), ...place }, user);
  if (!applyOp(res)) return false;
  const primary = (res.data?.primary as string | undefined) ?? res.created[0];
  if (primary) useApp.getState().setSelection([primary]);
  const s = useLibrary.getState();
  // point / rect placement keeps the tool for the next one; drawn shapes start over
  useLibrary.setState({ points: [], drag: null, tick: s.tick + 1 });
  return true;
}
