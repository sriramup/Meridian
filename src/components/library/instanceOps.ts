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

/** commit, replacing the gesture's previous step so the whole gesture is one undo entry */
function commitGesture(res: LibraryOpResult, final: boolean): boolean {
  const R = rt();
  const s = R.scenarios.active;
  if (gestureCs && s.cursor > 0 && s.changesets[s.cursor - 1]?.id === gestureCs) R.scenarios.undo(1);
  gestureCs = null;
  if (!res.ok || !res.changeset) {
    // the gesture's last good state was undone above; report why this one failed
    useApp.getState().bumpWorld();
    useApp.getState().notify(res.error ?? "Can't apply that", "warn");
    return false;
  }
  const ok = applyOp(res);
  if (ok && !final) gestureCs = res.changeset.id;
  return ok;
}

function run(id: string, patch: Record<string, unknown>, final: boolean) {
  const R = rt();
  // regenerate from the state before the gesture began
  const s = R.scenarios.active;
  if (gestureCs && s.cursor > 0 && s.changesets[s.cursor - 1]?.id === gestureCs) {
    R.scenarios.undo(1);
    gestureCs = null;
  }
  const res = reconfigureInstance(R.world, id, patch, user);
  commitGesture(res, final);
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

/** a copy beside the original, selected */
export function duplicate(id: string): boolean {
  const R = rt();
  const info = instanceOf(R.world, id);
  if (!info) return false;
  // offset by about the instance's size so the copy sits next to it
  let w = 6;
  const e = R.world.get(info.primary);
  if (e && (e.kind === "building" || e.kind === "area" || e.kind === "prop")) {
    const poly = e.kind === "building" ? e.footprint : e.kind === "area" ? e.poly : e.footprint;
    if (poly) {
      const xs = poly[0].map((p) => p[0]);
      w = Math.max(...xs) - Math.min(...xs) + 2;
    }
  }
  const res = duplicateInstance(R.world, [id], [w, 0], user);
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
