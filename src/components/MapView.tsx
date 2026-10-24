"use client";

import { AmbientLight, LightingEffect, _SunLight as SunLight, type Layer, type PickingInfo } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { basemapStyle, setBasemapTheme } from "@/render/basemap";
import { buildLayers, hoverLayers, stackLayers, zoomBand } from "@/render/layers";
import { MODEL, NIGHT } from "@/render/theme";
import { localTimestamp, sunAltAz } from "@/lib/sun";
import { LIGHTING_DATE, skyFor } from "@/render/sky";
import { ChunkLoader } from "@/render/chunkLoader";
import { cameraOf, setLodCamera, useLod } from "@/render/lod";
import { cityRadius } from "@/render/edge";
import { isOrbitDrag, orbitDrag } from "@/render/camera";
import { LocalProjection } from "@/world/projection";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import { useExtraLayers, useImpactLayers, useKerbLayers, useToolLayers } from "./useExtraLayers";
import { usePedestrianControls } from "./usePedestrian";
import { trafficTrips, tripsLayer } from "@/render/overlays";
import { useSims } from "@/sim/client";
import { slotLayers, useLayerSlots } from "@/render/layerSlots";

export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(15.5);
  const worldVersion = useApp((s) => s.worldVersion);
  const selection = useApp((s) => s.selection);
  const hover = useApp((s) => s.hover);
  const layersOn = useApp((s) => s.layers);
  const theme = useApp((s) => s.theme);
  // lighting and sky follow the clock in 3-minute steps (not every animation frame). They depend on
  // the hour only: the month changes the modelled surface temperatures, never how the city is lit
  const hour = useApp((s) => Math.round(s.hour * 20) / 20);
  const lodVersion = useLod((s) => s.version);
  const loaderRef = useRef<ChunkLoader | null>(null);
  const highlight = useApp((s) => s.highlight);
  const cameraMode = useApp((s) => s.cameraMode);
  const showChanges = useApp((s) => s.showChanges);
  const overlayExtra = useExtraLayers();
  // feature modules' layers (zones, library props, street-level cursor…) join the overlay bands
  const slots = useLayerSlots((s) => s.slots);
  const extra = useMemo(
    () => ({ ground: [...overlayExtra.ground, ...slotLayers(slots, "ground")], top: [...slotLayers(slots, "solid"), ...overlayExtra.top, ...slotLayers(slots, "top")] }),
    [overlayExtra, slots],
  );
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
    // a glide after a fling that settles softly, capped so a flick doesn't throw the camera across town
    map.dragPan.enable({ linearity: 0.25, deceleration: 2200, maxSpeed: 1600 });
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
    let deckDrew = true;
    const overlay = new MapboxOverlay({
      interleaved: false,
      onAfterRender: () => {
        deckDrew = true;
      },
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
    // chunk loading and level of detail follow the camera
    const loader = new ChunkLoader(R.scene, R.context);
    loaderRef.current = loader;
    (window as unknown as { __meridianLoader: ChunkLoader }).__meridianLoader = loader;
    const updateCamera = () => {
      const c = map.getCenter();
      const canvas = map.getCanvas();
      const cam = cameraOf({ center: proj.toLocal(c.lng, c.lat), lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), fov: map.getVerticalFieldOfView(), width: canvas.clientWidth || 1, height: canvas.clientHeight || 1 });
      setLodCamera(cam);
      loader.setCamera(cam);
    };
    updateCamera();
    let lastZoom = map.getZoom();
    const onMove = () => {
      updateCamera();
      const z = map.getZoom();
      if (Math.abs(z - lastZoom) > 0.2) {
        lastZoom = z;
        setZoom(Math.round(z * 5) / 5);
      }
    };
    map.on("move", onMove);
    map.on("resize", updateCamera);
    // no hover picking (a GPU read-back) while the camera moves; clicks after it settles still pick
    map.on("movestart", () => overlay.setProps({ _pickable: false } as never));
    map.on("moveend", () => overlay.setProps({ _pickable: true } as never));
    map.on("load", () => setReady(true));
    // fps meter, and the chunk loader's per-frame work: it adds layers only after deck.gl has drawn
    // the previous batch, so tessellation and uploads stay spread over frames
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    let lastAdmit = 0;
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last > 1000) {
        useApp.getState().setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      if (loader.pending && (deckDrew || now - lastAdmit > 250) && loader.work()) {
        deckDrew = false;
        lastAdmit = now;
        useLod.setState((s) => ({ version: s.version + 1 }));
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
      loaderRef.current = null;
    };
  }, []);

  usePedestrianControls(cameraMode);

  // sky follows the sun for the hour (on the fixed lighting date)
  useEffect(() => {
    const R = rt();
    const map = R.map;
    if (!map) return;
    const alt = (sunAltAz(new Date(localTimestamp(LIGHTING_DATE, hour, R.meta.timezone)), R.meta.origin.lat, R.meta.origin.lon).alt * 180) / Math.PI;
    const apply = () => map.setSky(skyFor(theme === "night" ? Math.min(alt, -14) : alt));
    if (map.isStyleLoaded()) apply();
    else map.once("styledata", apply);
  }, [hour, theme, ready]);

  // theme switch recolours the basemap (the scene repaints itself in the layer build below)
  const firstTheme = useRef(theme);
  useEffect(() => {
    const R = rt();
    if (R.map && theme !== firstTheme.current) setBasemapTheme(R.map, theme, !!R.meta.sandbox);
    firstTheme.current = theme;
  }, [theme]);

  // one lighting effect for the session: the hour and theme update its lights in place (no new
  // effect, no shader or pass churn), then deck.gl redraws
  const lighting = useMemo(() => {
    const dbg = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    if (dbg?.get("light") === "0") return null;
    const ambient = new AmbientLight({ color: [255, 255, 255], intensity: MODEL.ambient });
    const sun = new SunLight({ timestamp: Date.now(), color: [255, 248, 236], intensity: MODEL.sun, _shadow: dbg?.get("shadows") === "1" });
    return { ambient, sun, fx: new LightingEffect({ ambient, sun }) };
  }, []);
  const effects = useMemo(() => (lighting ? [lighting.fx] : []), [lighting]);
  useEffect(() => {
    if (!lighting) return;
    const R = rt();
    const T = theme === "night" ? NIGHT : MODEL;
    lighting.ambient.intensity = T.ambient;
    lighting.sun.timestamp = localTimestamp(LIGHTING_DATE, hour, R.meta.timezone);
    lighting.sun.color = theme === "night" ? [150, 160, 200] : [255, 248, 236];
    lighting.sun.intensity = T.sun;
    lighting.fx.shadowColor = T.shadow;
    (R.overlay as unknown as { _deck?: { redraw: (r: string) => void } } | null)?._deck?.redraw("lighting");
  }, [lighting, hour, theme, ready]);

  // the scene's layers change only when the world, the view options or the detail band do;
  // hover and smooth zooming don't rebuild them
  const band = zoomBand(zoom);
  const scene = useMemo(() => {
    const loader = loaderRef.current;
    if (!ready || !loader) return { ground: [], solid: [], labels: [] };
    const R = rt();
    const T = theme === "night" ? NIGHT : MODEL;
    // theme and change highlighting repaint colours in place (no re-tessellation)
    R.scene.setTheme(T);
    R.scene.setShowChanges(showChanges);
    if (R.scene.sync()) {
      loader.invalidate();
      if (loader.cam) loader.setCamera(loader.cam);
    }
    return buildLayers({
      rt: R,
      theme: T,
      app: { selection, layers: layersOn, highlight, theme, cameraMode },
      zoom: band,
      loader,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, worldVersion, selection, layersOn, theme, highlight, band, cameraMode, showChanges, lodVersion]);
  // street-edge lines over raster overlays follow their chunk's visibility
  const kerbShown = useMemo(() => {
    const loader = loaderRef.current;
    if (!loader || !kerbL.length) return kerbL;
    return kerbL.map((l) => {
      const v = loader.views.get(l.id.slice("kerb-lines-".length));
      const visible = !v || v.visible;
      return l.props.visible === visible ? l : l.clone({ visible });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kerbL, lodVersion]);
  const layers: Layer[] = useMemo(() => stackLayers(scene, extra), [scene, extra]);
  const hoverL = useMemo(() => (ready ? hoverLayers(rt(), theme === "night" ? NIGHT : MODEL, hover, selection) : []), [ready, hover, selection, theme, worldVersion]);

  const overlay = useApp((s) => s.overlay);
  const trafficShown = useSims((s) => s.shown.traffic);
  useEffect(() => {
    const R = rt();
    const noAnim = new URLSearchParams(window.location.search).get("anim") === "0";
    if (overlay !== "traffic" || !trafficShown || noAnim) {
      R.overlay?.setProps({ layers: [...withKerbs(layers, kerbShown), ...hoverL, ...pinL, ...toolL], effects });
      return;
    }
    // animate modelled vehicles on top of the static scene
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      const data = trafficTrips(useApp.getState().hour);
      const t = (performance.now() - t0) / 1000;
      R.overlay?.setProps({ layers: [...withKerbs(layers, kerbShown), ...hoverL, tripsLayer(t * 1.0, data), ...pinL, ...toolL], effects });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [layers, kerbShown, hoverL, pinL, toolL, effects, overlay, trafficShown]);

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

/** lon/lat box around the fully drawn part of the city */
function cityBounds(proj: LocalProjection, b: readonly number[]): [[number, number], [number, number]] {
  const cx = (b[0] + b[2]) / 2,
    cy = (b[1] + b[3]) / 2,
    r = cityRadius(b);
  return [proj.toLonLat([cx - r, cy - r]), proj.toLonLat([cx + r, cy + r])];
}
