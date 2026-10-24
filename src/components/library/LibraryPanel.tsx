"use client";

// The library palette (left, beside the tool rail): search and browse every primitive by
// category; picking one opens its parameter form and arms it for placement on the map.

import { ArrowLeft, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ensureLibrary, getPrimitive, listPrimitives, searchPrimitives, type Category, type PrimitiveDef } from "@/library";
import { useApp } from "@/state/store";
import { IconButton, Kbd, cx } from "../ui";
import { CATEGORY, CATEGORY_ORDER, PrimitiveIcon } from "./icons";
import { useLibrary } from "./libraryStore";
import { ParamForm } from "./ParamForm";

const HOW: Record<PrimitiveDef["placement"], string> = {
  point: "Click to place · drag to aim · [ ] turn",
  rect: "Drag a rectangle · or click for the set size",
  polygon: "Click the corners · Enter or click the first to finish",
  path: "Click along the line · Enter or double-click to finish",
};

export function LibraryPanel() {
  const defId = useLibrary((s) => s.defId);
  ensureLibrary();
  const def = defId ? getPrimitive(defId) : undefined;
  return <div className="chrome flex max-h-[calc(100vh-190px)] w-[300px] flex-col overflow-hidden">{def ? <Configure def={def} /> : <Browse />}</div>;
}

function Browse() {
  const query = useLibrary((s) => s.query);
  const category = useLibrary((s) => s.category) as Category | null;
  const { setQuery, setCategory, arm } = useLibrary.getState();
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);
  const groups = useMemo(() => {
    const all = query.trim() ? searchPrimitives(query, 200) : listPrimitives();
    const list = category ? all.filter((d) => d.category === category) : all;
    if (query.trim()) return [{ cat: null as Category | null, defs: list }];
    const by = new Map<Category, PrimitiveDef[]>();
    for (const d of list) {
      if (!by.has(d.category)) by.set(d.category, []);
      by.get(d.category)!.push(d);
    }
    return CATEGORY_ORDER.filter((c) => by.has(c)).map((c) => ({ cat: c as Category | null, defs: by.get(c)!.sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [query, category]);
  const flat = groups.flatMap((g) => g.defs);
  const counts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const d of listPrimitives()) m.set(d.category, (m.get(d.category) ?? 0) + 1);
    return m;
  }, []);
  useEffect(() => setHi(0), [query, category]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);
  let idx = -1;
  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-2">
        <Search size={14} className="shrink-0 text-ink-3" />
        <input
          ref={input}
          value={query}
          placeholder="Search the library: bench, apartments, oak…"
          aria-label="Search the library"
          role="combobox"
          aria-expanded
          aria-controls="lib-list"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setHi(Math.min(flat.length - 1, hi + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setHi(Math.max(0, hi - 1)));
            else if (e.key === "Enter" && flat[hi]) arm(flat[hi].id);
            else if (e.key === "Escape") {
              e.stopPropagation();
              if (query) setQuery("");
              else if (category) setCategory(null);
              else useApp.getState().setTool("select");
            }
          }}
          className="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-4"
        />
        {(query || category) && (
          <IconButton size="sm" aria-label="Clear" onClick={() => (setQuery(""), setCategory(null), input.current?.focus())}>
            <X size={13} />
          </IconButton>
        )}
      </div>
      {/* categories: one compact row of icons; the active one names itself */}
      <div className="flex flex-wrap gap-0.5 border-b border-line px-2 py-1.5" role="tablist" aria-label="Categories">
        {CATEGORY_ORDER.filter((c) => counts.has(c)).map((c) => {
          const Icon = CATEGORY[c].icon;
          const on = category === c;
          return (
            <button
              key={c}
              role="tab"
              aria-selected={on}
              title={`${CATEGORY[c].label} (${counts.get(c)})`}
              onClick={() => setCategory(on ? null : c)}
              className={cx("flex h-7 items-center gap-1 rounded-[5px] px-1.5 text-[11.5px] transition-colors", on ? "bg-accent text-on-accent" : "text-ink-3 hover:bg-paper-3 hover:text-ink")}
            >
              <Icon size={14} strokeWidth={1.7} />
              {on && <span className="font-medium">{CATEGORY[c].label}</span>}
            </button>
          );
        })}
      </div>
      <div ref={listRef} id="lib-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1">
        {!flat.length && <p className="px-3 py-4 text-[12px] text-ink-4">{listPrimitives().length ? `Nothing matches “${query}”.` : "The library is loading…"}</p>}
        {groups.map((g) => (
          <div key={g.cat ?? "results"}>
            {g.cat && !category && <div className="font-legend sticky top-0 z-[1] bg-paper-2/95 px-3 pt-2 pb-1 text-[12px] leading-none text-ink-3 backdrop-blur-[2px]">{CATEGORY[g.cat].label}</div>}
            {g.defs.map((d) => {
              idx++;
              const i = idx;
              return (
                <button
                  key={d.id}
                  role="option"
                  aria-selected={i === hi}
                  data-idx={i}
                  onMouseMove={() => i !== hi && setHi(i)}
                  onClick={() => arm(d.id)}
                  className={cx("flex w-full items-start gap-2.5 px-3 py-1.5 text-left", i === hi ? "bg-accent-2" : "")}
                >
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-[5px] border border-line bg-paper text-rose">
                    <PrimitiveIcon def={d} size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{d.name}</span>
                    <span className="block truncate text-[11px] leading-snug text-ink-4">{d.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[10.5px] text-ink-4">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> browse · <Kbd>↵</Kbd> pick
        </span>
        <span>{listPrimitives().length} items</span>
      </div>
    </>
  );
}

function Configure({ def }: { def: PrimitiveDef }) {
  const values = useLibrary((s) => s.params[def.id]) ?? {};
  const rotation = useLibrary((s) => s.rotation);
  const { disarm, setParams, resetParams } = useLibrary.getState();
  return (
    <>
      <div className="flex items-start gap-2 border-b border-line px-2 py-2">
        <IconButton size="sm" aria-label="Back to the library" onClick={disarm}>
          <ArrowLeft size={14} />
        </IconButton>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-1.5">
            <PrimitiveIcon def={def} size={14} className="shrink-0 text-rose" />
            <span className="font-display truncate text-[16px] leading-tight font-semibold text-ink">{def.name}</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-ink-3">{def.description}</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ParamForm def={def} values={values} onChange={(v) => setParams(def.id, v)} onReset={() => resetParams(def.id)} />
      </div>
      <div className="border-t border-line px-3 py-1.5 text-[10.5px] leading-snug text-ink-4">
        {HOW[def.placement]}
        {(def.placement === "point" || def.placement === "rect") && <span className="tabular"> · heading {Math.round(rotation)}°</span>} · <Kbd>Space</Kbd> pan · <Kbd>Esc</Kbd> back
      </div>
    </>
  );
}
