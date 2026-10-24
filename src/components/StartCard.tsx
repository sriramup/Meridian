"use client";

import { LayoutGrid, MessageSquare, Search, Spline } from "lucide-react";
import { useMemo } from "react";
import { Kbd } from "@/components/ui/kit";
import { ensureLibrary, listPrimitives, type Category } from "@/library";
import { resetDraw } from "@/state/drawing";
import { switchCity } from "@/state/cities";
import { rt } from "@/state/runtime";
import { useApp, type Tool } from "@/state/store";
import { CATEGORY } from "./library/icons";
import { useLibrary } from "./library/libraryStore";

/** the categories offered as starting points, in order (those the catalog has) */
const START: Category[] = ["housing", "buildings", "commercial", "civic", "education", "parks", "flora", "streetscape", "recreation", "water", "transport", "landmarks"];

function openLibrary(category: Category | null, query = "") {
  resetDraw();
  const lib = useLibrary.getState();
  lib.disarm();
  lib.setCategory(category);
  lib.setQuery(query);
  useApp.getState().setTool("library");
}

/** shown on an empty canvas only: start from the library, lay out streets, or describe it */
export function StartCard() {
  useApp((s) => s.worldVersion);
  const tool = useApp((s) => s.tool);
  const agentOpen = useApp((s) => s.agentOpen);
  const counts = useMemo(() => {
    ensureLibrary();
    const m = new Map<Category, number>();
    for (const d of listPrimitives()) m.set(d.category, (m.get(d.category) ?? 0) + 1);
    return m;
  }, []);
  const R = rt();
  if (!R.meta.sandbox || R.world.entities.size > 0 || tool !== "select") return null;
  const pick = (t: Tool) => {
    resetDraw();
    useApp.getState().setTool(t);
  };
  const cats = START.filter((c) => counts.has(c)).slice(0, 8);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return (
    <div className="pointer-events-auto chrome w-[440px] max-w-[calc(100vw-32px)] p-4">
      <div className="font-display text-[20px] leading-none font-semibold text-ink">Start a city</div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-3">An empty 3 × 3 km site (grid squares are 100 m). Place buildings, parks, streets and furniture from the library and set every dimension; everything runs through the heat, shade, stormwater, traffic and access models.</p>
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
        <button onClick={() => switchCity("austin")} className="text-ink-3 hover:text-ink">
          Or open Austin →
        </button>
      </div>
    </div>
  );
}
