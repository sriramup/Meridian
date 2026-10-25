"use client";

// Pointer and keyboard handling for placing the armed primitive, and its live preview: the real
// op is dry-run under the cursor and what it would create is drawn as a ghost (red with the reason
// when it can't go there).
//
//   point    move to aim, click to place; press and drag to set the heading (15° steps, Shift
//            free); [ ] turn by 15°, R by 90°; near a street a building faces it and settles on
//            the frontage / setback line
//   rect     drag a rectangle (lined up with the street it fronts, else the grid, else the
//            screen); a click places the default size
//   With the grid on, points, corners, vertices and moves snap to it (Alt: free). A red preview
//   (a collision, with the reason) can't be placed; a dashed outline shows the nearest free spot.
//   polygon  click corners; click the first one, double-click or Enter to finish
//   path     click points; double-click or Enter (or click the last point) to finish
//   Esc clears the shape, then goes back to the list; Enter places / finishes; Backspace removes the last point;
//   hold Space to pan with the mouse while placing.

import { COORDINATE_SYSTEM, type Layer, type Position } from "@deck.gl/core";
import { PathStyleExtension } from "@deck.gl/extensions";
import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers";
import { useEffect, useMemo, useState } from "react";
import { useLayerSlot } from "@/render/layerSlots";
import { SolidInstances, solidLayers, type PackedLayer } from "@/render/solids";
import { rt } from "@/state/runtime";
import { useSnap } from "@/state/snap";
import { useApp } from "@/state/store";
import { useNight } from "@/render/daylight";
import { LocalProjection } from "@/world/projection";
import type { Building, Entity, Prop, Street, Tree, Vec2 } from "@/world/types";
import { useLibrary } from "./libraryStore";
import { armedDef, commitMove, commitPlacement, computeMovePreview, computePreview, currentPlacement, DRAG_MIN, snapPoint, type Preview } from "./placement";

const dashExt = new PathStyleExtension({ dash: true });

const RED: [number, number, number] = [214, 70, 60];
const BLUE: [number, number, number] = [52, 92, 190];
const FLAT = { depthCompare: "always", depthWriteEnabled: false } as const;

/** is the library tool armed with a definition (or carrying an instance being moved)? */
const armed = () => useApp.getState().tool === "library" && (!!useLibrary.getState().defId || !!useLibrary.getState().moving);
const moving = () => useApp.getState().tool === "library" && !!useLibrary.getState().moving;

function useMapPointer() {
  useEffect(() => {
    let detach: (() => void) | null = null;
    let space = false;
    const attach = () => {
      const R = rt();
      const map = R.map;
      if (!map) return false;
      const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
      const at = (e: { lngLat: { lng: number; lat: number } }): Vec2 => proj.toLocal(e.lngLat.lng, e.lngLat.lat);
      const px = (p: Vec2) => map.project(proj.toLonLat(p));
      const near = (a: Vec2, b: Vec2, r = 10) => {
        const A = px(a), B = px(b);
        return Math.hypot(A.x - B.x, A.y - B.y) <= r;
      };
      let raf = 0;
      let pending: Vec2 | null = null;
      const move = (e: { lngLat: { lng: number; lat: number } }) => {
        if (!armed()) return;
        pending = at(e);
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const s = useLibrary.getState();
          const p = pending;
          useLibrary.setState({ cursor: p, drag: s.drag && p ? { from: s.drag.from, to: p } : s.drag, tick: s.tick + 1 });
        });
      };
      const down = (e: { lngLat: { lng: number; lat: number }; originalEvent: MouseEvent }) => {
        if (!armed() || moving() || space || e.originalEvent.button !== 0) return;
        const def = armedDef();
        if (def?.placement !== "point" && def?.placement !== "rect") return;
        const p = at(e);
        useLibrary.setState({ drag: { from: p, to: p }, cursor: p });
      };
      const up = (e: { lngLat: { lng: number; lat: number }; originalEvent: MouseEvent }) => {
        const s = useLibrary.getState();
        if (!armed() || !s.drag) return;
        useLibrary.setState({ drag: { from: s.drag.from, to: at(e) } });
        // Shift keeps the item armed to place another
        commitPlacement(e.originalEvent.shiftKey);
        useLibrary.setState({ drag: null });
      };
      const click = (e: { lngLat: { lng: number; lat: number } }) => {
        if (!armed() || space) return;
        if (moving()) {
          useLibrary.setState({ cursor: at(e) });
          commitMove();
          return;
        }
        const def = armedDef();
        if (!def || def.placement === "point" || def.placement === "rect") return;
        const p = at(e);
        const s = useLibrary.getState();
        const pts = s.points;
        if (def.placement === "polygon" && pts.length >= 3 && near(p, pts[0])) return finish();
        if (def.placement === "path" && pts.length >= 2 && near(p, pts[pts.length - 1])) return finish();
        if (pts.length && near(p, pts[pts.length - 1], 4)) return; // the second click of a double-click
        useLibrary.setState({ points: [...pts, snapPoint(p, true)], tick: s.tick + 1 });
      };
      const dbl = (e: { preventDefault: () => void }) => {
        if (!armed()) return;
        e.preventDefault();
        finish();
      };
      const out = () => armed() && useLibrary.setState({ cursor: null, tick: useLibrary.getState().tick + 1 });
      map.on("mousemove", move);
      map.on("mousedown", down);
      map.on("mouseup", up);
      map.on("click", click);
      map.on("dblclick", dbl);
      map.on("mouseout", out);
      detach = () => {
        map.off("mousemove", move);
        map.off("mousedown", down);
        map.off("mouseup", up);
        map.off("click", click);
        map.off("dblclick", dbl);
        map.off("mouseout", out);
        cancelAnimationFrame(raf);
      };
      return true;
    };
    const finish = () => {
      const def = armedDef();
      if (def && currentPlacement(def, true)) commitPlacement();
    };
    const key = (e: KeyboardEvent) => {
      // G picks up the selected library instance to move it
      if (!armed() && e.type === "keydown" && e.key.toLowerCase() === "g" && !e.metaKey && !e.ctrlKey && !(e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable]")) {
        const app = useApp.getState();
        const sel = app.selection.length === 1 ? rt().world.get(app.selection[0]) : undefined;
        if (sel && "lib" in sel && sel.lib) {
          e.preventDefault();
          useLibrary.getState().startMove(sel.id);
        }
        return;
      }
      if (!armed()) return;
      const t = e.target as HTMLElement;
      if (t?.closest("input,textarea,select,[contenteditable],[role=combobox],[role=slider]")) return;
      const s = useLibrary.getState();
      if (e.type === "keyup") {
        if (e.code === "Space") {
          space = false;
          syncPan();
        }
        return;
      }
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (e.code === "Space") {
        space = true;
        syncPan();
        stop();
      } else if (e.key === "Escape" && s.moving) {
        stop();
        s.endMove();
      } else if (e.key === "Escape") {
        stop();
        if (s.points.length || s.drag) useLibrary.setState({ points: [], drag: null, tick: s.tick + 1 });
        else s.disarm();
      } else if (e.key === "Enter") {
        stop();
        const p = armedDef()?.placement;
        if (s.moving) commitMove();
        else if (p === "point" || p === "rect") commitPlacement();
        else finish();
      } else if (e.key === "Backspace" && s.points.length) {
        stop();
        useLibrary.setState({ points: s.points.slice(0, -1), tick: s.tick + 1 });
      } else if (e.key === "[" || e.key === "]") {
        stop();
        s.setRotation(s.rotation + (e.key === "[" ? 15 : -15));
      } else if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey && !s.moving) {
        stop();
        s.setRotation(s.rotation + (e.shiftKey ? -90 : 90));
      }
    };
    // left-drag aims / draws while a point or rect primitive is armed; Space restores panning
    const syncPan = () => {
      const map = rt().map;
      if (!map) return;
      const p = armedDef()?.placement;
      const capture = armed() && !moving() && !space && (p === "point" || p === "rect");
      if (capture) map.dragPan.disable();
      else map.dragPan.enable();
    };
    const unsubA = useApp.subscribe((s, prev) => s.tool !== prev.tool && syncPan());
    const unsubL = useLibrary.subscribe((s, prev) => (s.defId !== prev.defId || s.moving !== prev.moving) && syncPan());
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    let tries = 0;
    const iv = setInterval(() => {
      if (attach() || ++tries > 100) clearInterval(iv);
    }, 100);
    return () => {
      clearInterval(iv);
      detach?.();
      unsubA();
      unsubL();
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
    };
  }, []);
}

/** trees drawn as solids in the preview (trunk and crown) */
function treeAsProp(t: Tree): Prop {
  const trunk = Math.max(1.2, t.h - t.r * 1.5);
  return {
    id: t.id, kind: "prop", type: "tree", p: t.p, rot: 0, height: t.h, source: "", provenance: "proposed",
    solids: [
      { shape: "cylinder", at: [0, 0, 0], size: [0.4, 0.4, trunk], color: [110, 86, 64], material: "wood" },
      { shape: "sphere", at: [0, 0, Math.max(0.5, t.h - t.r * 1.7)], size: [t.r * 2, t.r * 2, t.r * 1.7], color: [104, 150, 84], material: "foliage" },
    ],
  };
}

const ghostCache = new SolidInstances();

function tinted(packed: PackedLayer[], ok: boolean): PackedLayer[] {
  return packed.map((p) => {
    const c = new Uint8Array(p.colors.length);
    for (let i = 0; i < c.length; i += 4) {
      if (ok) {
        c[i] = p.colors[i];
        c[i + 1] = p.colors[i + 1];
        c[i + 2] = p.colors[i + 2];
        c[i + 3] = 215;
      } else {
        c[i] = (p.colors[i] + RED[0] * 2) / 3;
        c[i + 1] = (p.colors[i + 1] + RED[1] * 2) / 3;
        c[i + 2] = (p.colors[i + 2] + RED[2] * 2) / 3;
        c[i + 3] = 190;
      }
    }
    return { ...p, colors: c };
  });
}

function previewLayers(pv: Preview | null, defPlacement: string | undefined, night: boolean): Layer[] {
  const R = rt();
  const origin: [number, number, number] = [R.meta.origin.lon, R.meta.origin.lat, 0];
  const common = { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: origin };
  const s = useLibrary.getState();
  const layers: Layer[] = [];
  const ok = pv?.ok ?? true;
  const tone = ok ? BLUE : RED;
  if (pv) {
    const ents = pv.entities;
    const solidsOf: Entity[] = [];
    const masses: { polygon: Position[]; base: number; h: number }[] = [];
    const flats: { polygon: Position[][] }[] = [];
    const lines: { path: Position[]; w: number }[] = [];
    for (const e of ents) {
      if (e.kind === "prop") solidsOf.push(e);
      else if (e.kind === "tree") solidsOf.push(treeAsProp(e));
      else if (e.kind === "building") {
        const b = e as Building;
        for (const m of b.masses) masses.push({ polygon: m.poly[0].map((p) => [p[0], p[1], m.base]), base: m.base, h: Math.max(0.3, m.top - m.base) });
        if (b.solids?.length) solidsOf.push(b);
      } else if (e.kind === "area") flats.push({ polygon: e.poly as Position[][] });
      else if (e.kind === "path") lines.push({ path: e.path as Position[], w: 2.5 });
      else if (e.kind === "street") lines.push({ path: (e as Street).path as Position[], w: 12 });
    }
    if (flats.length)
      layers.push(new SolidPolygonLayer({ id: "lib-ghost-flat", ...common, data: flats, getPolygon: (d: { polygon: Position[][] }) => d.polygon, getFillColor: [...tone, 70], parameters: FLAT }));
    if (lines.length)
      layers.push(new PathLayer({ id: "lib-ghost-lines", ...common, data: lines, getPath: (d: { path: Position[] }) => d.path, getWidth: (d: { w: number }) => d.w, widthUnits: "meters", widthMinPixels: 2, getColor: [...tone, 110], capRounded: true, jointRounded: true, parameters: FLAT }));
    if (masses.length)
      layers.push(
        new SolidPolygonLayer({
          id: "lib-ghost-masses",
          ...common,
          data: masses,
          getPolygon: (d: { polygon: Position[] }) => d.polygon,
          extruded: true,
          getElevation: (d: { h: number }) => d.h,
          getFillColor: ok ? [232, 226, 212, 235] : [...RED, 200],
          material: { ambient: 0.6, diffuse: 0.5, shininess: 0, specularColor: [0, 0, 0] },
        }),
      );
    if (solidsOf.length) {
      ghostCache.update(solidsOf, 2);
      layers.push(...solidLayers(tinted(ghostCache.visibleLayers(), ok), { origin, night, pickable: false, idPrefix: "lib-ghost" }));
    }
  }
  // drawing aids: the clicked points and rubber band, a drag's heading
  const pts = s.points;
  if (pts.length) {
    const band = s.cursor ? [...pts, s.cursor] : pts;
    const closed = defPlacement === "polygon" && band.length >= 3;
    layers.push(
      new PathLayer({ id: "lib-draw-line", ...common, data: [{ path: closed ? [...band, band[0]] : band }], getPath: (d: { path: Position[] }) => d.path.map((p) => [p[0], p[1], 0.4] as Position), getColor: [...tone, 255], getWidth: 2, widthUnits: "pixels", parameters: FLAT }),
      new ScatterplotLayer({ id: "lib-draw-pts", ...common, data: pts, getPosition: (p: Vec2) => [p[0], p[1], 0.5], getRadius: 4, radiusUnits: "pixels", getFillColor: [255, 255, 255, 255], getLineColor: [...tone, 255], stroked: true, lineWidthMinPixels: 2, parameters: FLAT }),
    );
  }
  if (s.drag && defPlacement === "point" && Math.hypot(s.drag.to[0] - s.drag.from[0], s.drag.to[1] - s.drag.from[1]) >= DRAG_MIN)
    layers.push(new PathLayer({ id: "lib-draw-heading", ...common, data: [{ path: [s.drag.from, s.drag.to] }], getPath: (d: { path: Position[] }) => d.path.map((p) => [p[0], p[1], 0.4] as Position), getColor: [...tone, 255], getWidth: 2, widthUnits: "pixels", parameters: FLAT }));
  if (pv?.place.site && defPlacement === "rect")
    layers.push(new PathLayer({ id: "lib-draw-rect", ...common, data: [{ path: [...pv.place.site[0], pv.place.site[0][0]] }], getPath: (d: { path: Position[] }) => d.path.map((p) => [p[0], p[1], 0.4] as Position), getColor: [...tone, 255], getWidth: 2, widthUnits: "pixels", parameters: FLAT }));
  if (pv?.suggestion?.length)
    layers.push(
      new PathLayer({
        id: "lib-draw-free",
        ...common,
        data: pv.suggestion.map((q) => ({ path: [...q[0], q[0][0]] })),
        getPath: (d: { path: Position[] }) => d.path.map((p) => [p[0], p[1], 0.4] as Position),
        getColor: [...BLUE, 230],
        getWidth: 1.6,
        widthUnits: "pixels",
        getDashArray: [5, 4],
        dashJustified: true,
        extensions: [dashExt],
        parameters: FLAT,
      } as never),
    );
  const anchor = s.cursor ?? pv?.place.at;
  // a dragged rectangle's size sits on the rectangle, the rest beside the cursor
  const readAt = pv?.place.site && defPlacement === "rect" ? pv.place.at : anchor;
  if (pv?.readout && readAt && (pv.ok || !pv.error))
    layers.push(
      new TextLayer({
        id: "lib-draw-readout",
        ...common,
        data: [{ p: readAt, t: pv.readout }],
        getPosition: (d: { p: Vec2 }) => [d.p[0], d.p[1], 1],
        getText: (d: { t: string }) => d.t,
        getSize: 11.5,
        getColor: [255, 255, 255, 255],
        background: true,
        getBackgroundColor: [44, 62, 110, 225],
        backgroundPadding: [6, 3],
        getTextAnchor: "start",
        getPixelOffset: [14, 18],
        fontFamily: "Geist, system-ui, sans-serif",
        fontWeight: 500,
        characterSet: "auto",
        parameters: FLAT,
      }),
    );
  if (pv && !pv.ok && pv.error && anchor)
    layers.push(
      new TextLayer({
        id: "lib-draw-label",
        ...common,
        data: [{ p: anchor, t: pv.error.length > 90 ? pv.error.slice(0, 88) + "…" : pv.error }],
        getPosition: (d: { p: Vec2 }) => [d.p[0], d.p[1], 1],
        getText: (d: { t: string }) => d.t,
        getSize: 12,
        getColor: [255, 255, 255, 255],
        background: true,
        getBackgroundColor: [176, 77, 74, 240],
        backgroundPadding: [7, 4],
        // beside the cursor (not centred on it), so the palette never covers the start of the reason
        getTextAnchor: "start",
        getPixelOffset: [14, -22],
        fontFamily: "Geist, system-ui, sans-serif",
        fontWeight: 600,
        characterSet: "auto",
        maxWidth: 360,
        wordBreak: "break-word",
        parameters: FLAT,
      }),
    );
  return layers;
}

/** mounted once: placement interaction and the ghost preview */
export function LibraryPlacement() {
  useMapPointer();
  const tool = useApp((s) => s.tool);
  // night looks (glowing lamps) switch with the clock (render/daylight.ts)
  const theme = useNight((s) => (s.night ? "night" : "model"));
  const tick = useLibrary((s) => s.tick);
  const defId = useLibrary((s) => s.defId);
  const movingId = useLibrary((s) => s.moving);
  const worldVersion = useApp((s) => s.worldVersion);
  // snapping settings and modifier keys change the preview too
  const snapKey = useSnap((s) => `${s.gridSandbox}${s.gridCity}${s.sizeFt}${s.street}${s.free}${s.freeTurn}`);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    if (tool !== "library" || (!defId && !movingId)) return setPreview(null);
    if (movingId) return setPreview(computeMovePreview());
    const def = armedDef();
    setPreview(def ? computePreview(def) : null);
  }, [tool, defId, movingId, tick, worldVersion, snapKey]);
  const layers = useMemo(() => (tool === "library" && (defId || movingId) ? previewLayers(preview, movingId ? "point" : armedDef()?.placement, theme === "night") : null), [preview, tool, defId, movingId, theme, tick]);
  useLayerSlot("library-placement", "top", layers);
  return null;
}
