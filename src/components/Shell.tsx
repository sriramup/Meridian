"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useEffect, useRef, useState } from "react";
import { initSimWorker } from "@/sim/client";
import { addPoint, draw, finishDrawing, finishPoint, resetDraw, setCursor } from "@/state/drawing";
import { togglePedestrian } from "@/state/view";
import { applyOp } from "@/state/actions";
import { rt } from "@/state/runtime";
import { useApp, type Tool, type OverlayId } from "@/state/store";
import { PANEL_EASE, usePanels, useViewInsets } from "@/state/panels";
import { LocalProjection } from "@/world/projection";
import { removeBuildings } from "@/world/ops/buildings";
import { plantTreesAt, removeEntities } from "@/world/ops/landscape";
import { removeInstance } from "@/world/ops/library";
import { removeStreets } from "@/world/ops/streets";
import { pointProblem, treeProblem } from "@/world/ops/placement";
import { speciesOf } from "@/world/species";
import type { TransitRoute, Vec2 } from "@/world/types";
import { AgentsPane, useAgentShortcuts } from "./agents/AgentsPane";
import { ZoneDrawSurface } from "./agents/ZoneDrawSurface";
import { ZoneLayers } from "./agents/ZoneLayers";
import { AnalysisDock } from "./AnalysisDock";
import { HelpDialog } from "./Help";
import { ExitStreetView } from "./pedestrian/ExitStreetView";
import { Inspector } from "./Inspector";
import { SlidePanel } from "./SlidePanel";
import { StartCard } from "./StartCard";
import { LibraryRuntime } from "./library/LibraryRuntime";
import { openLibrary } from "./library/libraryStore";
import { MapView } from "./MapView";
import { Annotations, ChangeReport, Toasts } from "./Overlays";
import { Toolbar } from "./Toolbar";
import { DiscoveredPlaces } from "./serp/DiscoveredPlaces";
import { TopBar, ViewControls } from "./TopBar";

export function Shell() {
  const agentOpen = useApp((s) => s.agentOpen);
  // side panels stop above the analysis dock, whose height follows the open overlay and the width
  const dock = useRef<HTMLDivElement>(null);
  const [dockH, setDockH] = useState(52);
  useEffect(() => {
    const ro = new ResizeObserver(() => dock.current && setDockH(dock.current.offsetHeight));
    if (dock.current) ro.observe(dock.current);
    return () => ro.disconnect();
  }, []);
  const clearDock = { bottom: dockH + 20 };
  const width = usePanels((s) => s.agentWidth);
  // the chrome sits in the part of the map the side panels leave visible
  const insets = useViewInsets();
  const drag = useRef(false);
  useShortcuts();
  useAgentShortcuts();
  useMapInteractions();
  useEffect(() => {
    // test / automation hook (same executor the agent uses)
    import("@/agent/tools").then((m) => {
      (window as unknown as { __meridianApp: unknown }).__meridianApp = useApp;
      import("@/sim/client").then((c) => ((window as unknown as { __meridianSims: unknown }).__meridianSims = c.useSims));
      (window as unknown as { __meridianTools: unknown }).__meridianTools = { run: (name: string, input: Record<string, unknown>) => m.executeTool(name, input, { requestApproval: async () => true, approvals: false }) };
      // the design generator and critique (src/design), with the agent's commit path
      import("@/design").then((d) => ((window as unknown as { __meridianDesign: unknown }).__meridianDesign = { ...d, commit: m.commit }));
    });
    // the multi-agent runtime for automation: AgentsApi functions, `.agents` (the useAgents store) and `.sessions` (the module)
    import("@/agent/sessions").then((m) => ((window as unknown as { __meridianAgent: unknown }).__meridianAgent = { ...m.agentsApi, agents: m.useAgents, sessions: m }));
    initSimWorker().catch((e) => useApp.getState().notify(`Simulation worker failed: ${(e as Error).message}`, "error"));
  }, []);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      usePanels.getState().setAgentWidth(window.innerWidth - e.clientX);
    };
    const up = () => (drag.current = false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);
  return (
    <TooltipPrimitive.Provider>
      <div className="absolute inset-0">
        {/* the map always fills the window: side panels open over it, so the canvas never resizes */}
        <div className="absolute inset-0">
          <MapView />
          <LibraryRuntime />
          <ZoneDrawSurface />
          <ZoneLayers paneOpen={agentOpen} />
          <div className="relative z-[5]">
            <Annotations />
          </div>
          <div className="pointer-events-none absolute inset-0 z-[6]">
            <DiscoveredPlaces />
          </div>
          {/* the chrome moves aside for the panels; its container queries measure what is visible */}
          <div className="@container pointer-events-none absolute inset-y-0 z-10" style={{ left: insets.left, right: insets.right, transition: `left ${PANEL_EASE}, right ${PANEL_EASE}` }}>
            <div className="absolute top-3 right-3 left-3 flex items-start justify-between gap-2">
              <TopBar />
              <ViewControls agentOpen={agentOpen} />
            </div>
            <div className="absolute top-16 left-3">
              <Toolbar />
            </div>
            <div className="absolute top-16 right-3 flex flex-col justify-start" style={clearDock}>
              <Inspector />
            </div>
            <div className="absolute left-3 flex flex-col justify-end" style={clearDock}>
              <ChangeReport />
            </div>
            <div ref={dock} className="absolute right-0 bottom-3 left-0 flex flex-col items-center gap-2">
              <ExitStreetView />
              <AnalysisDock />
            </div>
            <div className="absolute top-16 left-1/2 -translate-x-1/2">
              <Toasts />
            </div>
            <div className="absolute inset-0 grid place-items-center">
              <StartCard />
            </div>
            <Attribution />
            <HelpDialog />
          </div>
        </div>
        {/* a floating card over the map, inset like the top bar and the dock */}
        <SlidePanel side="right" open={agentOpen} width={width} className="z-20 py-3 pr-3">
          <div className="absolute top-0 bottom-0 -left-1 z-10 w-2 cursor-col-resize" onPointerDown={() => (drag.current = true)} />
          <AgentsPane onClose={() => useApp.getState().setAgentOpen(false)} />
        </SlidePanel>
      </div>
    </TooltipPrimitive.Provider>
  );
}

/** data credits; on a narrow map they fold into a © chip (hover or focus to read) clear of the analysis bar */
function Attribution() {
  const text = rt().meta.sandbox ? (
    <>Sun path & typical weather: {rt().meta.region.replace(/^Sandbox · /, "")} (ERA5 via Open-Meteo)</>
  ) : (
    <>
      © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="hover:text-ink-2">OpenStreetMap</a> · City of Austin · US Census · TxDOT · OpenFreeMap
    </>
  );
  return (
    <div tabIndex={0} className="group chrome pointer-events-auto absolute right-2 bottom-1 rounded-[4px] px-1.5 text-[10px] text-ink-4 outline-none">
      <span className="@max-[1100px]:hidden @max-[1100px]:group-hover:inline @max-[1100px]:group-focus-within:inline">{text}</span>
      <span className="hidden @max-[1100px]:inline @max-[1100px]:group-hover:hidden @max-[1100px]:group-focus-within:hidden">©</span>
    </div>
  );
}

/** remove whatever is selected (buildings, streets, areas, trees, transit lines) as one edit each kind */
export function deleteSelection(): boolean {
  const R = rt();
  const st = useApp.getState();
  let ents = st.selection.map((id) => R.world.get(id)).filter((e): e is NonNullable<typeof e> => !!e);
  const actor = { author: "user" as const };
  const of = (k: string) => ents.filter((e) => e.kind === k).map((e) => e.id);
  let ok = false;
  // the main feature of a library instance takes the whole instance (its trees, objects, paths…) with it
  const insts = ents.filter((e) => "lib" in e && e.lib?.primary).map((e) => e.id);
  if (insts.length) {
    ok = applyOp(removeInstance(R.world, insts, actor)) || ok;
    ents = ents.filter((e) => R.world.get(e.id));
  }
  if (of("building").length) ok = applyOp(removeBuildings(R.world, of("building"), actor)) || ok;
  if (of("street").length) ok = applyOp(removeStreets(R.world, of("street"), { reclaim: "none" }, actor)) || ok;
  // a transit line takes its stops with it
  const routes = ents.filter((e) => e.kind === "route") as TransitRoute[];
  const other = [...of("area"), ...of("tree"), ...of("prop"), ...of("path"), ...routes.flatMap((r) => [r.id, ...r.stops.filter((s) => R.world.get(s))])];
  if (other.length) ok = applyOp(removeEntities(R.world, other, actor)) || ok;
  return ok;
}

// B, A and T open the library on buildings / parks / trees (the footprint, area and planting tools stay in the search)
const TOOL_KEYS: Record<string, Tool> = { v: "select", l: "library", s: "street", d: "district", r: "transit", m: "measure" };
const LIBRARY_KEYS: Record<string, string> = { b: "buildings", a: "parks", t: "flora" };
const OVERLAY_KEYS: Record<string, OverlayId> = { "1": "traffic", "2": "heat", "3": "density", "4": "access", "5": "zoning", "6": "transit", "7": "flood", "8": "runoff", "9": "sun", "0": "bike" };

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.closest("input,textarea,select,[contenteditable]")) return;
      const st = useApp.getState();
      const R = rt();
      const mod = e.metaKey || e.ctrlKey;
      const bump = () => {
        st.bumpWorld();
        st.bumpScenarios();
      };
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) R.scenarios.redo();
        else R.scenarios.undo();
        bump();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        R.scenarios.redo();
        bump();
        return;
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        st.setAgentOpen(!st.agentOpen);
        return;
      }
      if (mod) return;
      if (e.key === "Escape") {
        if (draw.points.length || draw.pending) resetDraw();
        else if (st.tool !== "select") st.setTool("select");
        else if (st.cameraMode === "pedestrian") togglePedestrian();
        else st.setSelection([]);
        st.setHighlight(null);
        return;
      }
      if (e.key === "Enter" && draw.points.length) {
        finishDrawing();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && st.selection.length) {
        if (deleteSelection()) st.setSelection([]);
        return;
      }
      // turn and tilt: Q / E and Shift + arrows (the map's own arrow keys pan while it has focus)
      const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-15, 0], ArrowRight: [15, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] };
      if (st.cameraMode !== "pedestrian" && e.shiftKey && ARROWS[e.key] && !target?.closest(".maplibregl-canvas")) {
        e.preventDefault();
        import("@/render/camera").then((m) => (ARROWS[e.key][0] ? m.turn(ARROWS[e.key][0]) : m.tilt(ARROWS[e.key][1])));
        return;
      }
      const k = e.key.toLowerCase();
      // (street level turns by dragging; its camera is its own)
      if ((k === "q" || k === "e") && st.cameraMode !== "pedestrian") {
        import("@/render/camera").then((m) => m.turn(k === "q" ? -15 : 15));
        return;
      }
      if (TOOL_KEYS[k]) {
        resetDraw();
        st.setTool(TOOL_KEYS[k]);
      } else if (LIBRARY_KEYS[k]) {
        resetDraw();
        openLibrary(LIBRARY_KEYS[k]);
      } else if (OVERLAY_KEYS[k]) st.setOverlay(st.overlay === OVERLAY_KEYS[k] ? null : OVERLAY_KEYS[k]);
      else if (k === "p") togglePedestrian();
      else if (k === "?") st.setHelpOpen(!st.helpOpen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** drawing / planting clicks on the map */
function useMapInteractions() {
  useEffect(() => {
    let detach: (() => void) | null = null;
    const attach = () => {
      const R = rt();
      const map = R.map;
      if (!map) return false;
      const proj = new LocalProjection(R.meta.origin.lon, R.meta.origin.lat);
      const toLocal = (ll: { lng: number; lat: number }): Vec2 => proj.toLocal(ll.lng, ll.lat);
      const click = (e: { lngLat: { lng: number; lat: number } }) => {
        const st = useApp.getState();
        if (st.tool === "select" || st.tool === "library" || draw.pending) return;
        const p = toLocal(e.lngLat);
        if (st.tool === "tree" && st.planting.mode === "single") {
          // a blocked spot is already shown in red under the cursor; clicking it does nothing
          const sp = speciesOf(st.planting.species);
          if (!treeProblem(R.world, p, sp?.r ?? 4)) applyOp(plantTreesAt(R.world, { points: [p], species: st.planting.species }, { author: "user" }));
          return;
        }
        if (finishPoint(p)) return finishDrawing();
        // invalid spots are shown in red under the cursor and can't be placed
        if (st.tool !== "measure" && pointProblem(R.world, st.tool === "tree" || st.tool === "district" ? "area" : st.tool, p)) return;
        addPoint(p);
      };
      const dbl = (e: { preventDefault: () => void }) => {
        const st = useApp.getState();
        if (st.tool !== "select" && draw.points.length) {
          e.preventDefault();
          finishDrawing();
        }
      };
      const move = (e: { lngLat: { lng: number; lat: number } }) => {
        if (useApp.getState().tool !== "select") setCursor(toLocal(e.lngLat));
      };
      const out = () => setCursor(null);
      map.on("click", click);
      map.on("dblclick", dbl);
      map.on("mousemove", move);
      map.on("mouseout", out);
      detach = () => {
        map.off("click", click);
        map.off("dblclick", dbl);
        map.off("mousemove", move);
        map.off("mouseout", out);
      };
      return true;
    };
    let tries = 0;
    const iv = setInterval(() => {
      if (attach() || ++tries > 50) clearInterval(iv);
    }, 100);
    return () => {
      clearInterval(iv);
      detach?.();
    };
  }, []);
  // double-click zoom would fight polygon finishing
  const tool = useApp((s) => s.tool);
  useEffect(() => {
    const map = rt().map;
    if (!map) return;
    if (tool === "select") map.doubleClickZoom.enable();
    else map.doubleClickZoom.disable();
  }, [tool]);
}
