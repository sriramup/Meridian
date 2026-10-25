"use client";

import { AmbientLight, LightingEffect, _SunLight as SunLight, type Layer, type PickingInfo } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { qualityGovernor } from "@/render/adaptiveQuality";
import maplibregl from "maplibre-gl";
import { memo, useEffect, useRef } from "react";
import { basemapStyle, setBasemapNight } from "@/render/basemap";
import { buildLayers, forgetLayers, hoverLayers, stackLayers, zoomBand, type SceneLayers } from "@/render/layers";
import { dayTheme } from "@/render/theme";
import { useTheme } from "@/state/theme";
import { skyFor } from "@/render/sky";
import { daylight, daylightFor, setDaylight, useNight } from "@/render/daylight";
import { ChunkLoader } from "@/render/chunkLoader";
import { cameraOf, setLodCamera, useLod } from "@/render/lod";
import { cityRadius } from "@/render/edge";
import { isOrbitDrag, orbitDrag } from "@/render/camera";
import { LocalProjection } from "@/world/projection";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import { useExtraLayers, useToolLayers } from "./useExtraLayers";
import { usePedestrianControls } from "./usePedestrian";
import { RASTER_OVERLAYS, impactPins, kerbLines, trafficTrips, tripsLayer } from "@/render/overlays";
import { useImpact } from "@/sim/impact";
import { useSims } from "@/sim/client";
import { slotLayers, useLayerSlots } from "@/render/layerSlots";

/** hover picking (a GPU pass over every pickable layer, read back) at most this often (ms) */
const HOVER_MS = 70;
/** how long the camera must have been still before idle work (the memory cap) runs (ms) */
const IDLE_MS = 400;
/** steepest tilt above street level: past ~71° the sky's horizon shows as a thin bright band along the top edge */
const MAX_TILT = 70;

type AppState = ReturnType<typeof useApp.getState>;

/**
 * Inputs that come from React (user actions: selection, the layers menu, overlays, tools…). The
 * camera never goes through React: chunk visibility, detail tiers and zoom bands are read from the
 * chunk loader and the map inside the frame loop, which re-stacks the layers itself, so moving
 * around causes no React renders or commits.
 */
interface Inputs {
  worldVersion: number;
  selection: string[];
  hover: string | null;
  layersOn: AppState["layers"];
  highlight: AppState["highlight"];
  cameraMode: AppState["cameraMode"];
  showChanges: boolean;
  overlay: AppState["overlay"];
  trafficShown: boolean;
  night: boolean;
  extra: { ground: Layer[]; top: Layer[] };
  tools: Layer[];
}

/** memoised: it takes no props, so the workspace re-rendering around it (pane drags) never re-renders it */
export const MapView = memo(function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const overlayExtra = useExtraLayers();
  // feature modules' layers (zones, library props, street-level cursor…) join the overlay bands
  const slots = useLayerSlots((s) => s.slots);
  const merged = useRef({ overlayExtra, slots, bands: bandsOf(overlayExtra, slots) });
  if (merged.current.overlayExtra !== overlayExtra || merged.current.slots !== slots) merged.current = { overlayExtra, slots, bands: bandsOf(overlayExtra, slots) };
  const inputs: Inputs = {
    worldVersion: useApp((s) => s.worldVersion),
    selection: useApp((s) => s.selection),
    hover: useApp((s) => s.hover),
    layersOn: useApp((s) => s.layers),
    highlight: useApp((s) => s.highlight),
    cameraMode: useApp((s) => s.cameraMode),
    showChanges: useApp((s) => s.showChanges),
    overlay: useApp((s) => s.overlay),
    trafficShown: useSims((s) => !!s.shown.traffic),
    night: useNight((s) => s.night),
    extra: merged.current.bands,
    tools: useToolLayers(),
  };
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const composeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const R = rt();
    const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
    const iv = R.startView ?? R.meta.initialView;
    const place = { lat: R.meta.origin.lat, lon: R.meta.origin.lon, timezone: R.meta.timezone };
    setDaylight(daylightFor(useApp.getState().hour, place));
    const plain = !!R.meta.sandbox;
    const dbg = new URLSearchParams(window.location.search);
    const map = new maplibregl.Map({
      container: el.current!,
      style: basemapStyle(daylight.night, plain),
      center: proj.toLonLat(iv.center),
      zoom: iv.zoom,
      pitch: iv.pitch,
      bearing: iv.bearing,
      maxPitch: MAX_TILT,
      maxZoom: 23.2,
      minZoom: 12.6,
      // each city is its own place: the camera stays over it
      maxBounds: cityBounds(proj, R.meta.bounds),
      attributionControl: false,
      renderWorldCopies: false,
      // resizes are handled below, redrawn before the browser paints
      trackResize: false,
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

    // ---- lighting: one effect for the session; the clock moves its lights in place (uniforms only).
    // The moon (opposite the sun) is always present, at zero intensity by day, so the shader never changes.
    const ambient = new AmbientLight({ color: [255, 255, 255], intensity: daylight.ambient.intensity });
    const sun = new SunLight({ timestamp: daylight.sunTs, color: daylight.sun.color, intensity: daylight.sun.intensity, _shadow: dbg.get("shadows") === "1" });
    const moon = new SunLight({ timestamp: daylight.moonTs, color: daylight.moon.color, intensity: daylight.moon.intensity });
    const fx = new LightingEffect({ ambient, sun, moon });
    fx.shadowColor = dayTheme().shadow;

    let deckDrew = true;
    const overlay = new MapboxOverlay({
      interleaved: false,
      onAfterRender: () => {
        deckDrew = true;
      },
      layers: [],
      effects: dbg.get("light") === "0" ? [] : [fx],
      pickingRadius: 3,
      useDevicePixels: Math.min(2, window.devicePixelRatio || 1),
      // resizing the drawing buffer clears it; draw again at once (this runs inside luma's resize
      // observer, before the frame is painted) rather than on the next frame, which would show the
      // city blank for a frame
      onResize: () => deck?.redraw("Canvas resized"),
      onHover: (info: PickingInfo) => {
        // street level has its own ground cursor; nothing highlights under it
        const st = useApp.getState();
        if (st.cameraMode === "pedestrian") return;
        const o = info.object as { id?: string } | undefined;
        const id = o?.id && typeof o.id === "string" ? o.id : null;
        if (st.hover !== id) st.setHover(id);
      },
      onClick: (info: PickingInfo, ev) => {
        const st = useApp.getState();
        if (st.tool !== "select" || st.cameraMode === "pedestrian") return;
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
    const deck = (overlay as unknown as { _deck?: DeckInternals })._deck;
    throttleHover(deck);

    // ---- size: MapLibre's own resize tracking redraws a frame after it resizes, so for one painted
    // frame the canvas is blank (a blink whenever a pane opens or the window resizes). Resize here
    // and redraw synchronously instead, inside the observer, before the paint.
    const container = el.current!;
    const sizeObserver = new ResizeObserver(() => {
      const c = map.getCanvas();
      if (c.clientWidth === container.clientWidth && c.clientHeight === container.clientHeight) return;
      map.resize();
      if (map.isStyleLoaded()) map.redraw();
    });
    sizeObserver.observe(container);

    // ---- chunk loading and level of detail follow the camera
    const loader = new ChunkLoader(R.scene, R.context);
    (window as unknown as { __meridianLoader: ChunkLoader }).__meridianLoader = loader;
    (window as unknown as { __meridianMap: maplibregl.Map }).__meridianMap = map;
    let moving = false;
    let lastMoveAt = 0;
    const updateCamera = () => {
      const c = map.getCenter();
      const canvas = map.getCanvas();
      const cam = cameraOf({ center: proj.toLocal(c.lng, c.lat), lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), fov: map.getVerticalFieldOfView(), width: canvas.clientWidth || 1, height: canvas.clientHeight || 1 });
      setLodCamera(cam);
      loader.setCamera(cam);
    };
    updateCamera();
    map.on("move", () => {
      lastMoveAt = performance.now();
      updateCamera();
    });
    map.on("resize", updateCamera);
    // no hover picking (a GPU read-back) while the camera moves; clicks after it settles still pick
    map.on("movestart", () => {
      moving = loader.moving = true;
      // straight to deck.gl: the overlay's setProps would re-send every prop (views, layers…)
      deck?.setProps({ _pickable: false });
    });
    map.on("moveend", () => {
      moving = loader.moving = false;
      deck?.setProps({ _pickable: true });
    });
    // tilt opens up as the camera comes down: from 60° over the whole city to MAX_TILT near the
    // street, so a zoomed-out view can't be tipped into a horizon of sky and grazing roofs. Street
    // level (which sets its own pitch) runs unlimited.
    const pitchLimit = () => {
      if (map.isEasing() || useApp.getState().cameraMode === "pedestrian") return MAX_TILT;
      const t = Math.max(0, Math.min(1, (map.getZoom() - 14) / 2.5));
      return 60 + (MAX_TILT - 60) * t;
    };
    const applyPitchLimit = () => {
      // street level sets (and afterwards restores) its own limits
      if (useApp.getState().cameraMode === "pedestrian") return;
      const lim = pitchLimit();
      if (Math.abs(map.getMaxPitch() - lim) > 0.5) map.setMaxPitch(lim);
    };
    map.on("movestart", () => {
      if (map.isEasing() && useApp.getState().cameraMode !== "pedestrian") map.setMaxPitch(MAX_TILT);
    });
    map.on("zoomend", applyPitchLimit);
    map.on("moveend", applyPitchLimit);
    map.on("zoom", () => {
      if (!map.isEasing()) applyPitchLimit();
    });

    // ---- day and night follow the clock: lights, shader uniforms, sky and basemap colours.
    // At most once a frame, and no layer props change (nothing is re-tessellated or re-uploaded).
    let hourDirty = false;
    let skyDirty = true;
    let skyKey = "";
    let baseNight = Math.round(daylight.night * 40) / 40;
    const applyHour = () => {
      hourDirty = false;
      const d = daylightFor(useApp.getState().hour, place);
      setDaylight(d);
      ambient.intensity = d.ambient.intensity;
      ambient.color = d.ambient.color;
      sun.timestamp = d.sunTs;
      sun.intensity = d.sun.intensity;
      sun.color = d.sun.color;
      moon.timestamp = d.moonTs;
      moon.intensity = d.moon.intensity;
      skyDirty = true;
      deck?.redraw("daylight");
    };
    const applySky = () => {
      if (!map.isStyleLoaded()) return;
      skyDirty = false;
      const sky = skyFor(daylight.alt);
      const key = JSON.stringify(sky);
      if (key !== skyKey) {
        skyKey = key;
        map.setSky(sky);
      }
      // the basemap in 1/40 steps of night (imperceptible), so style updates stay rare
      const n = Math.round(daylight.night * 40) / 40;
      if (n !== baseNight) {
        baseNight = n;
        setBasemapNight(map, n, plain);
      }
    };
    const unHour = useApp.subscribe((s, p) => {
      if (s.hour !== p.hour) hourDirty = true;
    });
    map.on("styledata", () => (skyDirty = true));

    // ---- layer composition, outside React
    let sceneKey: unknown[] = [];
    let scene: SceneLayers = { ground: [], solid: [], labels: [] };
    let pushed: Layer[] = [];
    let lodSeen = -1;
    let bandSeen = -1;
    let trafficRaf = 0;
    let trafficT0 = -1;
    const kerbCache = { key: "", layers: [] as Layer[] };
    const pinCache = { key: [] as unknown[], layers: [] as Layer[] };
    const compose = () => {
      const I = inputsRef.current;
      const zoom = map.getZoom();
      const band = zoomBand(zoom);
      const lodVersion = useLod.getState().version;
      lodSeen = lodVersion;
      bandSeen = band;
      // the scene's layers change only when the world, the view options, the detail band or chunk
      // tiers / visibility do; hover and smooth zooming don't rebuild them
      const key = [I.worldVersion, I.selection, I.layersOn, I.highlight, I.cameraMode, I.showChanges, I.night, band, lodVersion];
      if (key.length !== sceneKey.length || key.some((v, i) => v !== sceneKey[i])) {
        sceneKey = key;
        R.scene.setShowChanges(I.showChanges);
        if (R.scene.sync()) {
          loader.invalidate();
          if (loader.cam) loader.setCamera(loader.cam, false);
        }
        scene = buildLayers({ rt: R, theme: dayTheme(), app: { selection: I.selection, layers: I.layersOn, highlight: I.highlight, cameraMode: I.cameraMode, night: I.night }, zoom: band, loader });
      }
      // street-edge lines over raster overlays: in the ground band (so never over buildings,
      // whenever the rasters arrive), faded in as the camera comes down, following chunk visibility
      const t = Math.max(0, Math.min(1, (zoom - 14.4) / 1.6));
      const opacity = Math.round(t * t * (3 - 2 * t) * 10) / 10;
      const kerbOn = !!I.overlay && RASTER_OVERLAYS.has(I.overlay) && opacity > 0;
      const kKey = kerbOn ? `${I.overlay}|${opacity}|${I.worldVersion}|${useLod.getState().loaded}` : "";
      if (kKey !== kerbCache.key) {
        kerbCache.key = kKey;
        kerbCache.layers = kerbOn ? kerbLines(opacity) : [];
      }
      const kerbs = kerbCache.layers.map((l) => {
        const v = loader.views.get(l.id.slice("kerb-lines-".length));
        const visible = !v || v.visible;
        return l.props.visible === visible ? l : l.clone({ visible });
      });
      kerbCache.layers = kerbs;
      // degrees-saved pins per edit: only when zoomed in far enough for them to sit on their street
      const pKey = [I.overlay === "heat" && zoom >= 15, useImpact.getState().impact];
      if (pKey[0] !== pinCache.key[0] || pKey[1] !== pinCache.key[1]) {
        pinCache.key = pKey;
        pinCache.layers = pKey[0] ? impactPins() : [];
      }
      const ground = kerbs.length ? [...I.extra.ground, ...kerbs] : I.extra.ground;
      const layers = [...stackLayers(scene, { ground, top: I.extra.top }), ...hoverLayers(R, dayTheme(), I.hover, I.selection), ...pinCache.layers, ...I.tools];
      cancelAnimationFrame(trafficRaf);
      if (I.overlay === "traffic" && I.trafficShown && dbg.get("anim") !== "0") {
        // modelled vehicles animate on top of the static scene
        if (trafficT0 < 0) trafficT0 = performance.now();
        const loop = () => {
          const data = trafficTrips(useApp.getState().hour);
          overlay.setProps({ layers: [...layers, tripsLayer((performance.now() - trafficT0) / 1000, data)] });
          trafficRaf = requestAnimationFrame(loop);
        };
        pushed = [];
        loop();
        return;
      }
      trafficT0 = -1;
      // nothing changed (e.g. a camera step inside one band): no setProps, so deck.gl doesn't diff
      if (layers.length === pushed.length && layers.every((l, i) => l === pushed[i])) return;
      pushed = layers;
      overlay.setProps({ layers });
    };
    composeRef.current = compose;
    const unImpact = useImpact.subscribe(() => compose());
    // the interface theme picks the map's day palette (paper or graphite): recolour in place
    const unTheme = useTheme.subscribe(() => {
      R.scene.setTheme(dayTheme());
      fx.shadowColor = dayTheme().shadow;
      sceneKey = [];
      baseNight = -1;
      skyDirty = true;
      compose();
      deck?.redraw("theme");
    });

    // ---- the frame loop: fps meter, the clock, the loader's per-frame work, re-stacking and idle
    // work. The loader adds layers only after deck.gl has drawn the previous batch, so tessellation
    // and uploads stay spread over frames.
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    let lastAdmit = 0;
    let admitted = false;
    let lastIdle = performance.now();
    // the 3D layer's pixel density steps down only if moving frames stay slow (render/adaptiveQuality.ts)
    const quality = qualityGovernor(
      window.devicePixelRatio || 1,
      (ratio) => {
        deck?.setProps({ useDevicePixels: ratio });
        deck?.redraw("pixel density");
      },
      dbg.get("quality") !== "full",
    );
    let prevFrame = performance.now();
    const tick = () => {
      frames++;
      const now = performance.now();
      if (moving && document.visibilityState === "visible") quality.sample(now - prevFrame, now);
      prevFrame = now;
      if (now - last > 1000) {
        useApp.getState().setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      if (hourDirty) applyHour();
      if (skyDirty) applySky();
      if (admitted && deckDrew) {
        // the frame that initialised the last batch has been drawn: let the loader fit its budget
        loader.noteFrame(now - lastAdmit);
        admitted = false;
      }
      if (loader.pending && (deckDrew || now - lastAdmit > 250) && loader.work()) {
        deckDrew = false;
        admitted = true;
        lastAdmit = now;
        useLod.setState((s) => ({ version: s.version + 1 }));
      }
      if (useLod.getState().version !== lodSeen || zoomBand(map.getZoom()) !== bandSeen) compose();
      else if (!moving && now - lastMoveAt > IDLE_MS && now - lastIdle > 5000) {
        // idle: keep GPU buffer memory under the cap (hidden far detail goes first)
        lastIdle = now;
        const bytes = deck?.device?.statsManager?.getStats("GPU Time and Memory")?.get("Buffer Memory")?.count ?? 0;
        const dropped = loader.trim(bytes);
        if (dropped.length) {
          forgetLayers(dropped.map((k) => `marks-${k}`));
          useLod.setState((s) => ({ version: s.version + 1 }));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    compose();
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(trafficRaf);
      unHour();
      unImpact();
      unTheme();
      sizeObserver.disconnect();
      composeRef.current = null;
      map.remove();
      R.map = null;
      R.overlay = null;
    };
  }, []);

  usePedestrianControls(inputs.cameraMode);

  // a React input changed (selection, layers, overlays, tools…): re-stack now (a no-op when the
  // resulting layers are the same)
  useEffect(() => {
    composeRef.current?.();
  });

  return (
    // clips the canvas while a side pane moves (it is pinned at one size then: render/paneTransition.ts)
    <div className="absolute inset-0 overflow-hidden">
      <div ref={el} className="h-full w-full" />
    </div>
  );
});

/** analysis overlays and feature slots by band: ground (below buildings) and top */
function bandsOf(o: { ground: Layer[]; top: Layer[] }, slots: ReturnType<typeof useLayerSlots.getState>["slots"]) {
  return { ground: [...o.ground, ...slotLayers(slots, "ground")], top: [...slotLayers(slots, "solid"), ...o.top, ...slotLayers(slots, "top")] };
}

interface DeckInternals {
  _onPointerMove: (ev: { type?: string }) => void;
  redraw: (reason?: string) => void;
  setProps: (p: { _pickable?: boolean; useDevicePixels?: number }) => void;
  device?: { statsManager?: { getStats: (n: string) => { get: (n: string) => { count: number } | undefined } | undefined } };
}

/**
 * Hover picking renders every pickable layer into the picking buffer and reads it back. deck.gl
 * does that on every frame the pointer moves; once per HOVER_MS (the last position always picked)
 * looks the same and leaves the frame budget to drawing.
 */
function throttleHover(deck: DeckInternals | undefined) {
  if (!deck || typeof deck._onPointerMove !== "function") return;
  const pick = deck._onPointerMove.bind(deck);
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { type?: string } | null = null;
  deck._onPointerMove = (ev) => {
    if (ev.type === "pointerleave") {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      return pick(ev);
    }
    const now = performance.now();
    if (now - last >= HOVER_MS) {
      last = now;
      pending = null;
      return pick(ev);
    }
    pending = ev;
    if (!timer)
      timer = setTimeout(() => {
        timer = null;
        if (!pending) return;
        last = performance.now();
        const e = pending;
        pending = null;
        pick(e);
      }, HOVER_MS - (now - last));
  };
}

/** lon/lat box around the fully drawn part of the city */
function cityBounds(proj: LocalProjection, b: readonly number[]): [[number, number], [number, number]] {
  const cx = (b[0] + b[2]) / 2,
    cy = (b[1] + b[3]) / 2,
    r = cityRadius(b);
  return [proj.toLonLat([cx - r, cy - r]), proj.toLonLat([cx + r, cy + r])];
}
