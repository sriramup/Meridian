"use client";

import { LayoutGrid, MessageSquare, Search, Spline, X } from "lucide-react";
import { useMemo } from "react";
import { Kbd } from "@/components/ui/kit";
import { ensureLibrary, listPrimitives, type Category } from "@/library";
import { resetDraw } from "@/state/drawing";
import { newProject } from "./projects/ProjectsSidebar";
import { setStartClosed, useProjects } from "@/state/projects";
import { rt } from "@/state/runtime";
import { useApp, type Tool } from "@/state/store";
import { CATEGORY } from "./library/icons";
import { openLibrary as open } from "./library/libraryStore";

function openLibrary(category: Category | null) {
  resetDraw();
  open(category);
}

/** the categories offered as starting points, in order (those the catalog has) */
const START: Category[] = ["housing", "buildings", "commercial", "civic", "education", "parks", "flora", "streetscape", "recreation", "water", "transport", "landmarks"];


/** shown on an empty canvas only: start from the library, lay out streets, or describe it */
export function StartCard() {
  useApp((s) => s.worldVersion);
  const tool = useApp((s) => s.tool);
  const agentOpen = useApp((s) => s.agentOpen);
  const closed = useProjects((s) => !!s.list.find((p) => p.id === s.currentId)?.startClosed);
  const counts = useMemo(() => {
    ensureLibrary();
    const m = new Map<Category, number>();
    for (const d of listPrimitives()) m.set(d.category, (m.get(d.category) ?? 0) + 1);
    return m;
  }, []);
  const R = rt();
  if (!R.meta.sandbox || R.world.entities.size > 0 || tool !== "select" || closed) return null;
  const pick = (t: Tool) => {
    resetDraw();
    useApp.getState().setTool(t);
  };
  const cats = START.filter((c) => counts.has(c)).slice(0, 8);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return (
    <div data-testid="start-card" className="pointer-events-auto chrome relative w-[440px] max-w-[calc(100vw-32px)] p-4">
      <button
        onClick={() => void setStartClosed(true)}
        aria-label="Close"
        title="Close"
        className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-[6px] text-ink-3 transition-colors outline-none hover:bg-paper-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-rose/25"
      >
        <X size={15} strokeWidth={1.8} />
      </button>
      <div className="pr-8 font-display text-[20px] leading-none font-semibold text-ink">Start a city</div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-3">An empty 1.9 × 1.9 mi site (strong grid lines every 100 ft). Place buildings, parks, streets and furniture from the library and set every dimension; everything runs through the heat, shade, stormwater, traffic and access models.</p>
      <button onClick={() => openLibrary(null)} className="mt-3 flex h-9 w-full items-center gap-2 rounded-[6px] border border-line-2 bg-paper px-2.5 text-left text-[12.5px] text-ink-4 transition-colors hover:border-gold">
        <Search size={14} className="text-ink-3" />
        <span className="flex-1">Search {total ? `${total} building blocks` : "the library"}: apartments, café, oak, bench…</span>
        <Kbd size="xs">L</Kbd>
      </button>
      {cats.length > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {cats.map((c) => {
            const Icon = CATEGORY[c].icon;
            return (
              <button key={c} onClick={() => openLibrary(c)} className="flex flex-col items-start gap-1 rounded-[7px] border border-line px-2 py-1.5 text-left transition-colors hover:border-accent/60 hover:bg-accent-2">
                <Icon size={15} strokeWidth={1.7} className="text-rose" />
                <span className="text-[11.5px] leading-tight font-medium text-ink">{CATEGORY[c].label}</span>
                <span className="text-[10px] text-ink-4">{counts.get(c)} types</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <button onClick={() => pick("street")} className="flex items-center gap-2 rounded-[7px] border border-line px-2 py-1.5 text-left hover:border-accent/60 hover:bg-accent-2">
          <Spline size={15} strokeWidth={1.7} className="text-rose" />
          <span className="flex-1 text-[11.5px] font-medium text-ink">Lay out streets</span>
          <Kbd size="xs">S</Kbd>
        </button>
        <button onClick={() => pick("district")} className="flex items-center gap-2 rounded-[7px] border border-line px-2 py-1.5 text-left hover:border-accent/60 hover:bg-accent-2">
          <LayoutGrid size={15} strokeWidth={1.7} className="text-rose" />
          <span className="flex-1 text-[11.5px] font-medium text-ink">Generate a district</span>
          <Kbd size="xs">D</Kbd>
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5 text-[11.5px]">
        {!agentOpen ? (
          <button onClick={() => useApp.getState().setAgentOpen(true)} className="flex items-center gap-1.5 text-ink-2 hover:text-ink">
            <MessageSquare size={13} /> Describe it to the agent
          </button>
        ) : (
          <span />
        )}
        <button onClick={() => void newProject("austin")} className="text-ink-3 hover:text-ink">
          Or start from Austin →
        </button>
      </div>
    </div>
  );
}
