"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { initProjects, toggleSidebar, useProjects } from "@/state/projects";
import { useApp } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { LoadingScreen } from "./LoadingScreen";
import { PromptDialog } from "./projects/PromptDialog";
import { ProjectsSidebar, SIDEBAR_WIDTH } from "./projects/ProjectsSidebar";
import { SidePanel, usePaneWidth } from "./SidePanel";

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
  const [sidebarWidth, setSidebarWidth] = usePaneWidth("meridian.sidebarWidth", SIDEBAR_WIDTH, 196, 400);
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
    <main className="app-backdrop fixed inset-0 flex overflow-hidden">
      {mounted && (
        <TooltipPrimitive.Provider>
          <SidePanel open={loaded && sidebarOpen} side="left" width={sidebarWidth} onResize={setSidebarWidth} label="projects" className="z-20">
            <ProjectsSidebar />
          </SidePanel>
          <div className="relative h-full min-w-0 flex-1">
            {status === "ready" && <Shell />}
            <LoadingScreen />
          </div>
          <ConfirmDialog />
          <PromptDialog />
          <SketchStartHost />
        </TooltipPrimitive.Provider>
      )}
    </main>
  );
}
