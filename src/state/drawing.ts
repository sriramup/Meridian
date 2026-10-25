"use client";

import type { Vec2 } from "@/world/types";
import { plantTreesAt } from "@/world/ops/landscape";
import { applyOp } from "./actions";
import { createDrawn, drawConflict, type DrawnTool } from "./create";
import { rt } from "./runtime";
import { useApp } from "./store";
import { LocalProjection } from "@/world/projection";
import { snapPoint } from "./snap";

export interface DrawState {
  points: Vec2[];
  cursor: Vec2 | null;
  /** a finished shape that runs into something, awaiting the user's go-ahead */
  pending: { tool: DrawnTool; points: Vec2[]; conflict: string } | null;
}

export const draw: DrawState = { points: [], cursor: null, pending: null };

export function resetDraw() {
  draw.points = [];
  draw.cursor = null;
  draw.pending = null;
  useApp.getState().bumpTool();
}

/** outline / line tools snap to building corners and the grid (Alt: free); trees are placed freely */
const snapped = (p: Vec2) => (useApp.getState().tool === "tree" ? p : snapPoint(p, true));

export function addPoint(p: Vec2) {
  draw.points.push(snapped(p));
  useApp.getState().bumpTool();
}

let rafPending = false;
export function setCursor(p: Vec2 | null) {
  draw.cursor = p && snapped(p);
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    // drawing tools preview the spot under the cursor (valid or not) even before the first click
    if (draw.points.length || useApp.getState().tool !== "select") useApp.getState().bumpTool();
  });
}

export function finishDrawing() {
  const tool = useApp.getState().tool;
  const closed = tool === "building" || tool === "area" || tool === "district";
  const open = tool === "street" || tool === "transit";
  if ((closed && draw.points.length >= 3) || (open && draw.points.length >= 2)) {
    // the element is made straight away with the palette's choices; a clash asks first
    const pts = draw.points.slice();
    draw.points = [];
    const conflict = drawConflict(tool, pts);
    if (conflict) draw.pending = { tool, points: pts, conflict };
    else createDrawn(tool, pts);
    useApp.getState().bumpTool();
    return;
  }
  if (tool === "tree") {
    const { species, mode } = useApp.getState().planting;
    if (mode === "row" && draw.points.length >= 2) applyOp(plantTreesAt(rt().world, { points: draw.points.slice(), species }, { author: "user" }));
  }
  draw.points = [];
  useApp.getState().bumpTool();
}

/** tools that draw a closed outline (finished by clicking the first corner again) */
export function drawsClosedShape(): boolean {
  const st = useApp.getState();
  return st.tool === "building" || st.tool === "area" || st.tool === "district";
}

/**
 * The point that finishes the drawing when clicked: the first corner of an outline (closing it) or
 * the last point of a street. Null unless p is within a few screen pixels of it.
 */
export function finishPoint(p: Vec2 | null, px = 12): Vec2 | null {
  if (!p || !draw.points.length) return null;
  const st = useApp.getState();
  const target = drawsClosedShape() ? (draw.points.length >= 3 ? draw.points[0] : null) : (st.tool === "street" || st.tool === "transit") && draw.points.length >= 2 ? draw.points[draw.points.length - 1] : null;
  if (!target) return null;
  const R = rt();
  if (!R.map) return null;
  const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
  const a = R.map.project(proj.toLonLat(target));
  const b = R.map.project(proj.toLonLat(p));
  return Math.hypot(a.x - b.x, a.y - b.y) <= px ? target : null;
}
