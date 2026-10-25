"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { initProjects, useProjects } from "@/state/projects";
import { useApp } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { LoadingScreen } from "./LoadingScreen";
import { PromptDialog } from "./projects/PromptDialog";
import { ProjectsSidebar, SIDEBAR_WIDTH } from "./projects/ProjectsSidebar";

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
  }, []);
  return (
    <main className="fixed inset-0 flex overflow-hidden bg-paper" style={{ backgroundImage: "var(--parchment), radial-gradient(90% 80% at 50% 40%, #f8eccf 0%, #eedcb5 62%, #d9bd8a 100%)" }}>
      {mounted && (
        <TooltipPrimitive.Provider>
          {loaded && sidebarOpen && (
            <div className="relative z-20 h-full shrink-0" style={{ width: SIDEBAR_WIDTH }}>
              <ProjectsSidebar />
            </div>
          )}
          <div className="relative h-full min-w-0 flex-1">
            {status === "ready" && <Shell />}
            <LoadingScreen />
          </div>
          <ConfirmDialog />
          <PromptDialog />
        </TooltipPrimitive.Provider>
      )}
    </main>
  );
}
