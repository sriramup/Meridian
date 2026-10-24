"use client";

import { AmbientLight, LightingEffect, _SunLight as SunLight, type Layer, type PickingInfo } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { basemapStyle, setBasemapTheme } from "@/render/basemap";
import { buildLayers, hoverLayers, seasonOf, stackLayers, zoomBand } from "@/render/layers";
import { MODEL, NIGHT } from "@/render/theme";
import { localTimestamp, sunAltAz } from "@/lib/sun";
import { skyFor } from "@/render/sky";
import { cityRadius } from "@/render/edge";
import { isOrbitDrag, orbitDrag } from "@/render/camera";
import { LocalProjection } from "@/world/projection";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import { useExtraLayers, useImpactLayers, useKerbLayers, useToolLayers } from "./useExtraLayers";
import { usePedestrianControls } from "./usePedestrian";
import { trafficTrips, tripsLayer } from "@/render/overlays";
import { SUN_YEAR, useSims } from "@/sim/client";

export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(15.5);
  const worldVersion = useApp((s) => s.worldVersion);
  const selection = useApp((s) => s.selection);
  const hover = useApp((s) => s.hover);
  const layersOn = useApp((s) => s.layers);
  const theme = useApp((s) => s.theme);
  // lighting and sky follow the clock in 3-minute steps (not every animation frame)
  const hour = useApp((s) => Math.round(s.hour * 20) / 20);
  const date = useApp((s) => s.date);
  const highlight = useApp((s) => s.highlight);
  const cameraMode = useApp((s) => s.cameraMode);
  const showChanges = useApp((s) => s.showChanges);
  const extra = useExtraLayers();
  const toolL = useToolLayers();
  const pinL = useImpactLayers(zoom);
  const kerbL = useKerbLayers(zoom);

  useEffect(() => {
    const R = rt();
    const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
    const iv = R.meta.initialView;
    const map = new maplibregl.Map({
      container: el.current!,
      style: basemapStyle(useApp.getState().theme, !!R.meta.sandbox),
      center: proj.toLonLat(iv.center),
      zoom: iv.zoom,
      pitch: iv.pitch,
      bearing: iv.bearing,
      maxPitch: 85,
      maxZoom: 23.2,
      minZoom: 12.6,
      // each city is its own place: the camera stays over it
      maxBounds: cityBounds(proj, R.meta.bounds),
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
      fadeDuration: 0,
    });
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    // right-drag and Ctrl-drag orbit (MapLibre); so do middle-drag and Shift / Alt-drag, which work
    // on a trackpad or a one-button mouse
    map.on("mousedown", (e) => {
      const o = e.originalEvent;
      if (!isOrbitDrag(o) || useApp.getState().cameraMode === "pedestrian") return;
      e.preventDefault(); // no pan or box zoom
      o.preventDefault(); // no middle-button autoscroll
      const move = orbitDrag(o.clientX, o.clientY);
      const mm = (ev: MouseEvent) => move(ev.clientX, ev.clientY);
      const mu = () => {
        window.removeEventListener("mousemove", mm);
        window.removeEventListener("mouseup", mu);
      };
      window.addEventListener("mousemove", mm);
      window.addEventListener("mouseup", mu);
    });
    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
      pickingRadius: 3,
      useDevicePixels: Math.min(2, window.devicePixelRatio || 1),
      onHover: (info: PickingInfo) => {
        const o = info.object as { id?: string } | undefined;
        useApp.getState().setHover(o?.id && typeof o.id === "string" ? o.id : null);
      },
      onClick: (info: PickingInfo, ev) => {
        const st = useApp.getState();
        if (st.tool !== "select") return;
        const o = info.object as { id?: string } | undefined;
        const id = o?.id && typeof o.id === "string" ? o.id : null;
        const shift = (ev?.srcEvent as MouseEvent | undefined)?.shiftKey;
        if (!id) {
          if (!shift) st.setSelection([]);
          return;
        }
        if (shift) st.toggleSelection(id);
        else st.setSelection([id]);
      },
      getCursor: ({ isHovering, isDragging }) => (isDragging ? "grabbing" : useApp.getState().tool !== "select" ? "crosshair" : isHovering ? "pointer" : "grab"),
    });
    map.addControl(overlay as unknown as maplibregl.IControl);
    R.map = map;
    R.overlay = overlay;
    let lastZoom = map.getZoom();
    const onMove = () => {
      const z = map.getZoom();
      if (Math.abs(z - lastZoom) > 0.2) {
        lastZoom = z;
        setZoom(Math.round(z * 5) / 5);
      }
    };
    map.on("move", onMove);
    map.on("load", () => setReady(true));
    // fps meter
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last > 1000) {
        useApp.getState().setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    setReady(true);
    return () => {
      cancelAnimationFrame(raf);
      map.remove();
      R.map = null;
      R.overlay = null;
    };
  }, []);

  usePedestrianControls(cameraMode);

  // sky follows the sun for the shown date and hour
  useEffect(() => {
    const R = rt();
    const map = R.map;
    if (!map) return;
    const alt = (sunAltAz(new Date(localTimestamp(`${SUN_YEAR}-${date}`, hour, R.meta.timezone)), R.meta.origin.lat, R.meta.origin.lon).alt * 180) / Math.PI;
    const apply = () => map.setSky(skyFor(theme === "night" ? Math.min(alt, -14) : alt));
    if (map.isStyleLoaded()) apply();
    else map.once("styledata", apply);
  }, [date, hour, theme, ready]);

  // theme switch recolours the basemap (the scene repaints itself in the layer build below)
  const firstTheme = useRef(theme);
  useEffect(() => {
    const R = rt();
    if (R.map && theme !== firstTheme.current) setBasemapTheme(R.map, theme, !!R.meta.sandbox);
    firstTheme.current = theme;
  }, [theme]);

  const effects = useMemo(() => {
    const R = rt();
    const T = theme === "night" ? NIGHT : MODEL;
    const ts = localTimestamp(`${SUN_YEAR}-${date}`, hour, R.meta.timezone);
    const ambient = new AmbientLight({ color: [255, 255, 255], intensity: T.ambient });
    const dbg = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const shadows = dbg?.get("shadows") === "1";
    const sun = new SunLight({ timestamp: ts, color: theme === "night" ? [150, 160, 200] : [255, 248, 236], intensity: T.sun, _shadow: shadows });
    if (dbg?.get("light") === "0") return [];
    const fx = new LightingEffect({ ambient, sun });
    fx.shadowColor = T.shadow;
    return [fx];
  }, [hour, date, theme]);

  // the scene's layers change only when the world, the view options or the detail band do;
  // hover and smooth zooming don't rebuild them
  const band = zoomBand(zoom);
  const season = seasonOf(date);
  const scene = useMemo(() => {
    if (!ready) return { ground: [], solid: [], labels: [] };
    const R = rt();
    const T = theme === "night" ? NIGHT : MODEL;
    // theme and change highlighting repaint colours in place (no re-tessellation)
    R.scene.setTheme(T);
    R.scene.setShowChanges(showChanges);
    R.scene.sync();
    return buildLayers({
      rt: R,
      theme: T,
      app: { selection, layers: layersOn, highlight, theme, cameraMode },
      zoom: band,
      season,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, worldVersion, selection, layersOn, theme, highlight, band, cameraMode, showChanges, season]);
  const layers: Layer[] = useMemo(() => stackLayers(scene, extra), [scene, extra]);
  const hoverL = useMemo(() => (ready ? hoverLayers(rt(), theme === "night" ? NIGHT : MODEL, hover, selection) : []), [ready, hover, selection, theme, worldVersion]);

  const overlay = useApp((s) => s.overlay);
  const trafficShown = useSims((s) => s.shown.traffic);
  useEffect(() => {
    const R = rt();
    const noAnim = new URLSearchParams(window.location.search).get("anim") === "0";
    if (overlay !== "traffic" || !trafficShown || noAnim) {
      R.overlay?.setProps({ layers: [...withKerbs(layers, kerbL), ...hoverL, ...pinL, ...toolL], effects });
      return;
    }
    // animate modelled vehicles on top of the static scene
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      const data = trafficTrips(useApp.getState().hour);
      const t = (performance.now() - t0) / 1000;
      R.overlay?.setProps({ layers: [...withKerbs(layers, kerbL), ...hoverL, tripsLayer(t * 1.0, data), ...pinL, ...toolL], effects });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [layers, kerbL, hoverL, pinL, toolL, effects, overlay, trafficShown]);

  return (
    <div className="absolute inset-0">
      <div ref={el} className="h-full w-full" />
    </div>
  );
}

/** street-edge lines go right after the analysis rasters (below buildings) */
function withKerbs(layers: Layer[], kerbs: Layer[]): Layer[] {
  if (!kerbs.length) return layers;
  let at = -1;
  layers.forEach((l, i) => {
    if (/^(heat|heatctx|sun|sunctx|runoff|runoffctx|flood)/.test(l.id)) at = i;
  });
  return at < 0 ? [...layers, ...kerbs] : [...layers.slice(0, at + 1), ...kerbs, ...layers.slice(at + 1)];
}

/** lon/lat box around the city disc (plus a margin for the view around the edge) */
function cityBounds(proj: LocalProjection, b: readonly number[]): [[number, number], [number, number]] {
  const cx = (b[0] + b[2]) / 2,
    cy = (b[1] + b[3]) / 2,
    r = cityRadius(b) + 300;
  return [proj.toLonLat([cx - r, cy - r]), proj.toLonLat([cx + r, cy + r])];
}
