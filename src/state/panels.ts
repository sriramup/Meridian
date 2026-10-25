// The side panels (projects on the left, agents on the right) open over the map: the map keeps its
// full size, so opening one never resizes the WebGL canvas (which flashed and jittered). The chrome
// (top bar, tools, dock) moves aside instead, and camera flights aim at the middle of what the panels
// leave visible.

import { create } from "zustand";
import { useProjects } from "./projects";
import { useApp } from "./store";

/** the projects sidebar's width (px) */
export const SIDEBAR_WIDTH = 252;
/** the agents pane's width range (px); it is resized by its left edge */
export const AGENT_WIDTH = { min: 340, max: 640, initial: 420 };
/** how panels slide (and the chrome follows) */
export const PANEL_EASE = "220ms cubic-bezier(0.2, 0.8, 0.2, 1)";

export const usePanels = create<{ agentWidth: number; setAgentWidth: (w: number) => void }>((set) => ({
  agentWidth: AGENT_WIDTH.initial,
  setAgentWidth: (w) => set({ agentWidth: Math.max(AGENT_WIDTH.min, Math.min(AGENT_WIDTH.max, w)) }),
}));

/** how much of the map each open panel covers (px) */
export function viewInsets(): { left: number; right: number } {
  const p = useProjects.getState();
  return {
    left: p.loaded && p.sidebarOpen ? SIDEBAR_WIDTH : 0,
    right: useApp.getState().agentOpen ? usePanels.getState().agentWidth : 0,
  };
}

/** the same, as a React hook */
export function useViewInsets(): { left: number; right: number } {
  const left = useProjects((s) => (s.loaded && s.sidebarOpen ? SIDEBAR_WIDTH : 0));
  const agentOpen = useApp((s) => s.agentOpen);
  const agentWidth = usePanels((s) => s.agentWidth);
  return { left, right: agentOpen ? agentWidth : 0 };
}

/** a flight's screen offset so its target lands in the middle of the visible map, between the panels */
export function centreOffset(): [number, number] {
  const i = viewInsets();
  return [(i.left - i.right) / 2, 0];
}
