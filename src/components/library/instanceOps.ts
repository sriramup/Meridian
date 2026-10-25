"use client";

// Edits of a placed library instance from the inspector: live re-configuration (a slider drag
// becomes one undo step, regenerated at most every ~150 ms while it moves), rotate, move,
// duplicate and remove.

import { polyCentroid } from "@/geometry/polygon";
import { applyOp } from "@/state/actions";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import { duplicateInstance, instanceOf, moveInstance, reconfigureInstance, removeInstance, rotateInstance, type LibraryOpResult } from "@/world/ops/library";
import type { LibraryRef, Vec2 } from "@/world/types";
import { shortError } from "./placement";

const user = { author: "user" as const };

/** a placement's anchor: its point, the centre of its site, or the middle of its path */
export function anchorOf(pl: LibraryRef["placement"]): Vec2 | null {
  if (pl.at) return pl.at;
  if (pl.site) return polyCentroid(pl.site);
  if (pl.path?.length) return pl.path[Math.floor(pl.path.length / 2)];
  return null;
}

/** id of the changeset committed by the gesture in progress (replaced by the gesture's next step) */
let gestureCs: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let queued: { id: string; patch: Record<string, unknown>; final: boolean } | null = null;
const THROTTLE = 150;

/** the last refusal told to the user during this gesture (said once, not on every step) */
let toldOnce: string | null = null;

function run(id: string, patch: Record<string, unknown>, final: boolean) {
  const R = rt();
  // regenerate from the state before the gesture began
  const s = R.scenarios.active;
  const stepped = !!gestureCs && s.cursor > 0 && s.changesets[s.cursor - 1]?.id === gestureCs;
  if (stepped) R.scenarios.undo(1);
  const res = reconfigureInstance(R.world, id, patch, user);
  if (!res.ok || !res.changeset) {
    // refused (it would collide, or has no room): keep the gesture's last good step
    if (stepped) R.scenarios.redo(1);
    else gestureCs = null;
    if (final) gestureCs = null;
    useApp.getState().bumpWorld();
    const why = shortError(res.error ?? "Can't apply that");
    if (final || toldOnce !== why) useApp.getState().notify(why, "warn");
    toldOnce = final ? null : why;
    return;
  }
  gestureCs = null;
  const ok = applyOp(res);
  if (ok && !final) gestureCs = res.changeset.id;
  if (final) toldOnce = null;
}

/**
 * Re-configure an instance with new parameters. `final` false (a slider or scrub still moving):
 * applied at most every 150 ms; true: applied now and closes the gesture.
 */
export function reconfigure(id: string, patch: Record<string, unknown>, final: boolean) {
  queued = { id, patch, final };
  if (final) {
    if (timer) clearTimeout(timer);
    timer = null;
    const q = queued;
    queued = null;
    run(q.id, q.patch, true);
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const q = queued;
    queued = null;
    if (q) run(q.id, q.patch, q.final);
  }, THROTTLE);
}

/** turn about the instance's anchor */
export function rotateBy(id: string, deg: number): boolean {
  return applyOp(rotateInstance(rt().world, [id], deg, user));
}

/** set the absolute heading (degrees ccw from east) */
export function setHeading(id: string, deg: number): boolean {
  const info = instanceOf(rt().world, id);
  if (!info) return false;
  const d = deg - (info.placement.rotation ?? 0);
  return Math.abs(d) < 1e-6 ? true : rotateBy(id, d);
}

export function moveBy(id: string, by: Vec2): LibraryOpResult {
  return moveInstance(rt().world, [id], by, user);
}

/**
 * A copy beside the original, selected: to its right along its own heading (a building's side, so
 * copies make a row), else left, behind, in front, or the nearest free spot further out.
 */
export function duplicate(id: string): boolean {
  const R = rt();
  const info = instanceOf(R.world, id);
  if (!info) return false;
  // the instance's size along / across its heading
  const t = ((info.placement.rotation ?? 0) * Math.PI) / 180;
  const u: Vec2 = [Math.cos(t), Math.sin(t)];
  const v: Vec2 = [-u[1], u[0]];
  let w = 6,
    d = 6;
  const pts = info.entities.flatMap((eid) => {
    const e = R.world.get(eid);
    return e?.kind === "building" ? e.footprint[0] : e?.kind === "area" ? e.poly[0] : e?.kind === "prop" ? (e.footprint?.[0] ?? [e.p]) : e?.kind === "tree" ? [e.p] : [];
  });
  if (pts.length) {
    const a = pts.map((p) => p[0] * u[0] + p[1] * u[1]);
    const b = pts.map((p) => p[0] * v[0] + p[1] * v[1]);
    w = Math.max(...a) - Math.min(...a) + 2;
    d = Math.max(...b) - Math.min(...b) + 2;
  }
  const tries: Vec2[] = [];
  for (const k of [1, 2, 3]) tries.push([u[0] * w * k, u[1] * w * k], [-u[0] * w * k, -u[1] * w * k], [v[0] * d * k, v[1] * d * k], [-v[0] * d * k, -v[1] * d * k]);
  let res: LibraryOpResult | null = null;
  for (const off of tries) {
    res = duplicateInstance(R.world, [id], off, user);
    if (res.ok) break;
  }
  if (!res || !res.ok) {
    useApp.getState().notify("No free room beside it for a copy", "warn");
    return false;
  }
  if (!applyOp(res)) return false;
  const made = (res.data?.instances as string[] | undefined)?.[0];
  const copy = made ? instanceOf(R.world, made) : null;
  if (copy) useApp.getState().setSelection([copy.primary]);
  return true;
}

export function remove(id: string): boolean {
  const ok = applyOp(removeInstance(rt().world, [id], user));
  if (ok) useApp.getState().setSelection([]);
  return ok;
}
