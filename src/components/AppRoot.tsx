"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { initProjects, toggleSidebar, useProjects } from "@/state/projects";
import { useApp } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { LoadingScreen } from "./LoadingScreen";
import { PromptDialog } from "./projects/PromptDialog";
import { PANEL_EASE, SIDEBAR_WIDTH } from "@/state/panels";
import { ProjectsSidebar } from "./projects/ProjectsSidebar";
import { SlidePanel } from "./SlidePanel";
import { SketchStartHost } from "./sketch/SketchStart";

const Shell = dynamic(() => import("./Shell").then((m) => m.Shell), { ssr: false });

/**
 * The page: the projects sidebar beside the workspace. One page for the whole session: opening a
 * project swaps the runtime under the loading card (src/state/projects.ts), never the document.
 */
export function AppRoot() {
  const status = useApp((s) => s.status);
  const sidebarOpen = useProjects((s) => s.sidebarOpen);
  const loaded = useProjects((s) => s.loaded);
  // the app is client-only (WebGL, workers); rendering nothing on the server leaves no markup for
  // browser extensions to rewrite before hydration
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    initProjects().catch((e: Error) => useApp.setState({ status: "error", error: e.message }));
    // ⌘B / Ctrl+B shows and hides the projects sidebar from anywhere (text fields have no bold here)
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "b") return;
      if ((e.target as HTMLElement | null)?.closest("[contenteditable]")) return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <main className="fixed inset-0 overflow-hidden bg-paper" style={{ backgroundImage: "var(--parchment), radial-gradient(90% 80% at 50% 40%, #f8eccf 0%, #eedcb5 62%, #d9bd8a 100%)" }}>
      {mounted && (
        <TooltipPrimitive.Provider>
          {/* the workspace keeps the whole window; the sidebar slides in over it (no canvas resize) */}
          <div className="absolute inset-0">{status === "ready" && <Shell />}</div>
          {/* only positions the loading card: it must never take the map's pointer events */}
          <div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: loaded && sidebarOpen ? SIDEBAR_WIDTH : 0, transition: `left ${PANEL_EASE}` }}>
            <LoadingScreen />
          </div>
          {loaded && (
            <SlidePanel side="left" open={sidebarOpen} width={SIDEBAR_WIDTH} className="z-30">
              <ProjectsSidebar />
            </SlidePanel>
          )}
          <ConfirmDialog />
          <PromptDialog />
          <SketchStartHost />
        </TooltipPrimitive.Provider>
      )}
    </main>
  );
}
