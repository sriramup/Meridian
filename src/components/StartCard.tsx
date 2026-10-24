"use client";

import { Building2, LayoutGrid, MessageSquare, Spline, Square, TramFront, TreeDeciduous } from "lucide-react";
import { resetDraw } from "@/state/drawing";
import { switchCity } from "@/state/cities";
import { rt } from "@/state/runtime";
import { useApp, type Tool } from "@/state/store";
import { cx } from "./ui";

const START: { tool: Tool; icon: typeof Spline; name: string; note: string; key: string }[] = [
  { tool: "street", icon: Spline, name: "Streets", note: "lay out the network", key: "S" },
  { tool: "district", icon: LayoutGrid, name: "District", note: "generate blocks", key: "D" },
  { tool: "building", icon: Building2, name: "Building", note: "draw a footprint", key: "B" },
  { tool: "area", icon: Square, name: "Park or water", note: "open space", key: "A" },
  { tool: "tree", icon: TreeDeciduous, name: "Trees", note: "shade", key: "T" },
  { tool: "transit", icon: TramFront, name: "Transit line", note: "along streets", key: "R" },
];

/** shown on an empty canvas only: what can be placed, and where to begin */
export function StartCard() {
  useApp((s) => s.worldVersion);
  const tool = useApp((s) => s.tool);
  const agentOpen = useApp((s) => s.agentOpen);
  const R = rt();
  if (!R.meta.sandbox || R.world.entities.size > 0 || tool !== "select") return null;
  const pick = (t: Tool) => {
    resetDraw();
    useApp.getState().setTool(t);
  };
  return (
    <div className="pointer-events-auto chrome w-[380px] p-4">
      <div className="font-display text-[20px] leading-none font-semibold text-ink">Start a city</div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-3">An empty 3 × 3 km site; each grid square is 100 m. Everything you place runs through the heat, shade, stormwater, traffic and access models.</p>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {START.map((x) => {
          const Icon = x.icon;
          return (
            <button key={x.tool} onClick={() => pick(x.tool)} className={cx("group flex flex-col items-start gap-1 rounded-[7px] border border-line px-2 py-2 text-left transition-colors hover:border-accent/60 hover:bg-accent-2")}>
              <span className="flex w-full items-center justify-between">
                <Icon size={15} strokeWidth={1.7} className="text-accent" />
                <kbd className="font-mono text-[10px] text-ink-4">{x.key}</kbd>
              </span>
              <span className="text-[12px] font-medium text-ink">{x.name}</span>
              <span className="text-[10.5px] leading-tight text-ink-4">{x.note}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5 text-[11.5px]">
        {!agentOpen ? (
          <button onClick={() => useApp.getState().setAgentOpen(true)} className="flex items-center gap-1.5 text-ink-2 hover:text-ink">
            <MessageSquare size={13} /> Describe it to the agent
          </button>
        ) : (
          <span />
        )}
        <button onClick={() => switchCity("austin")} className="text-ink-3 hover:text-ink">
          Or open Austin →
        </button>
      </div>
    </div>
  );
}
