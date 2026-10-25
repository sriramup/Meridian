// Keeps the map smooth while a side pane opens, closes or is dragged wider.
//
// Resizing the map canvas reallocates MapLibre's and deck.gl's framebuffers and redraws the whole
// city, so doing it every frame of a slide drops frames. Instead the canvas is pinned at one size
// for the whole move (anchored to the edge away from the pane, the overflow clipped) and resized
// once: at the start when the map grows, at the end when it shrinks. Camera padding on the pane's
// side moves the view's centre so the picture never jumps on that resize, and eases with the pane
// so the city glides to its new centre in step with it.

import type { Map as MapLibreMap, PaddingOptions } from "maplibre-gl";
import { rtMaybe } from "@/state/runtime";

/** the panes' easing (CSS cubic-bezier(0.25, 1, 0.5, 1), ease-out quart) */
export const PANE_EASE_CSS = "cubic-bezier(0.25, 1, 0.5, 1)";
const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

const ZERO: PaddingOptions = { top: 0, bottom: 0, left: 0, right: 0 };
let token = 0;

function pin(el: HTMLElement, width: number, anchor: "left" | "right") {
  el.style.position = "absolute";
  el.style.top = "0";
  el.style.height = "100%";
  el.style.width = `${width}px`;
  el.style[anchor] = "0";
  el.style[anchor === "left" ? "right" : "left"] = "auto";
}

function unpin(el: HTMLElement) {
  for (const k of ["position", "top", "height", "width", "left", "right"]) el.style.removeProperty(k);
}

/**
 * Draw the resized map in this task, before the browser paints: a canvas is cleared when it is
 * resized, and waiting for the next frame shows it blank for one (a blink). deck.gl's layer redraws
 * itself the same way from its resize callback (MapView).
 */
function redrawNow(map: MapLibreMap) {
  if (map.isStyleLoaded()) map.redraw();
}

function mapOf(): MapLibreMap | null {
  return rtMaybe()?.map ?? null;
}

/**
 * The map's box is about to change width by `delta` px (negative: narrower) over `duration` ms
 * because a pane on `side` is moving. Call when the pane's own transition starts.
 */
export function paneTransition(side: "left" | "right", delta: number, duration: number) {
  const map = mapOf();
  if (!map || !delta) return;
  const el = map.getContainer();
  const box = el.parentElement;
  if (!box) return;
  const my = ++token;
  // the box's width now (a transition already under way counts from where it has got to)
  const from = box.clientWidth;
  const to = Math.max(1, from + delta);
  const anchor = side === "right" ? "left" : "right";
  map.stop();
  if (to > from) {
    // growing: take the final size now; padding keeps the visible part exactly as it was
    pin(el, to, anchor);
    map.resize();
    map.setPadding({ ...ZERO, [side]: to - from });
    redrawNow(map);
    map.easeTo({ padding: ZERO, duration, easing: easeOutQuart });
  } else {
    // shrinking: keep this size until the pane has covered the difference, and move the view's
    // centre to where the narrower map will have it
    pin(el, from, anchor);
    map.setPadding(ZERO);
    map.easeTo({ padding: { ...ZERO, [side]: from - to }, duration, easing: easeOutQuart });
  }
  setTimeout(() => {
    if (my !== token) return;
    unpin(el);
    map.resize();
    map.setPadding(ZERO);
    redrawNow(map);
  }, duration + 30);
}

/** a pane edge is being dragged: pin the map at the widest it can get until the drag ends */
export function paneDragStart(side: "left" | "right", paneWidth: number) {
  const map = mapOf();
  if (!map) return;
  const el = map.getContainer();
  const box = el.parentElement;
  if (!box) return;
  ++token;
  const from = box.clientWidth;
  const full = from + paneWidth;
  pin(el, full, side === "right" ? "left" : "right");
  map.stop();
  map.resize();
  map.setPadding({ ...ZERO, [side]: paneWidth });
  redrawNow(map);
}

/** the drag ended: one resize to the final width, then glide to the new centre */
export function paneDragEnd(side: "left" | "right") {
  const map = mapOf();
  if (!map) return;
  const el = map.getContainer();
  const box = el.parentElement;
  if (!box) return;
  // the view's centre sat at half the starting width from the edge away from the pane
  const centre = (el.clientWidth - (map.getPadding()[side] ?? 0)) / 2;
  const now = box.clientWidth;
  unpin(el);
  map.resize();
  // padding that keeps that centre where it is on the resized canvas, so nothing jumps
  const away = side === "right" ? "left" : "right";
  const pad = now - 2 * centre;
  map.setPadding(pad >= 0 ? { ...ZERO, [side]: pad } : { ...ZERO, [away]: -pad });
  redrawNow(map);
  map.easeTo({ padding: ZERO, duration: 240, easing: easeOutQuart });
}
