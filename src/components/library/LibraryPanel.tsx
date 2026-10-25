"use client";

// The library palette (left, beside the tool rail): search and browse every primitive by
// category; picking one opens its parameter form and arms it for placement on the map.

import { ArrowLeft, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Kbd, Tooltip, cn } from "@/components/ui/kit";
import { ensureLibrary, getPrimitive, listPrimitives, searchPrimitives, type Category, type PrimitiveDef } from "@/library";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import { IconButton } from "../ui";
import { CATEGORY, CATEGORY_ORDER, PrimitiveIcon } from "./icons";
import { useLibrary } from "./libraryStore";
import { ParamForm } from "./ParamForm";

const HOW: Record<PrimitiveDef["placement"], string> = {
  point: "Click to place · Shift-click to place more · drag to aim · R or [ ] turn",
  rect: "Drag a rectangle · or click for the set size · Shift to place more · R turn",
  polygon: "Click the corners · Enter or click the first to finish",
  path: "Click along the line · Enter or double-click to finish",
};

/** close the library: back to selecting */
function closeLibrary() {
  useLibrary.getState().disarm();
  useApp.getState().setTool("select");
}

function CloseButton() {
  return (
    <Tooltip content="Close library" kbd="Esc">
      <IconButton size="sm" aria-label="Close library" data-testid="library-close" onClick={closeLibrary}>
        <X size={14} />
      </IconButton>
    </Tooltip>
  );
}

export function LibraryPanel() {
  const defId = useLibrary((s) => s.defId);
  const moving = useLibrary((s) => s.moving);
  ensureLibrary();
  const def = defId ? getPrimitive(defId) : undefined;
  return <div className="chrome flex max-h-[calc(100vh-190px)] w-[300px] flex-col overflow-hidden">{moving ? <Moving id={moving} /> : def ? <Configure def={def} /> : <Browse />}</div>;
}

/** while an instance is picked up: what is moving and how to put it down */
function Moving({ id }: { id: string }) {
  const e = rt().world.get(id);
  const ref = e && "lib" in e ? e.lib : undefined;
  const def = ref ? getPrimitive(ref.def) : undefined;
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        {def && <PrimitiveIcon def={def} size={14} className="text-rose" />}
        <span className="font-display text-[16px] leading-tight font-semibold text-ink">Moving {def?.name ?? "item"}</span>
      </div>
      <p className="mt-1 text-[11.5px] leading-snug text-ink-3">It follows the pointer; click to put it down where the preview isn’t red.</p>
      <div className="mt-2 flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10.5px] text-ink-4">
          <Kbd size="xs">Esc</Kbd> leave it where it was
        </span>
        <Button size="sm" variant="ghost" onClick={() => useLibrary.getState().endMove()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Browse() {
  const query = useLibrary((s) => s.query);
  const category = useLibrary((s) => s.category) as Category | null;
  const { setQuery, setCategory, arm } = useLibrary.getState();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // after the key that opened the library has been handled (so it isn't typed into the search)
    const t = setTimeout(() => (input.current?.focus(), input.current?.select()), 30);
    return () => clearTimeout(t);
  }, []);
  const total = listPrimitives().length;
  const groups = useMemo(() => {
    // our own ranking (names, then synonyms / tags, then descriptions); cmdk only handles the keyboard
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
  const counts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const d of listPrimitives()) m.set(d.category, (m.get(d.category) ?? 0) + 1);
    return m;
  }, [total]);
  // a new query or category starts at its best match, scrolled to the top (cmdk would otherwise
  // keep the row picked for the previous letters, deep in the list)
  const first = groups[0]?.defs[0]?.id ?? "";
  const [picked, setPicked] = useState(first);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    setPicked(first);
    if (list.current) list.current.scrollTop = 0;
  }, [query, category, first]);
  const item = (d: PrimitiveDef) => (
    <CommandItem key={d.id} value={d.id} onSelect={() => arm(d.id)} className="items-start gap-2.5 py-1.5">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-[5px] border border-line bg-paper">
        <PrimitiveIcon def={d} size={14} className="text-rose" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-ink">{d.name}</span>
        <span className="block truncate text-[11px] leading-snug text-ink-4">{d.description}</span>
      </span>
    </CommandItem>
  );
  return (
    <Command shouldFilter={false} value={picked} onValueChange={setPicked} className="min-h-0 flex-1" label="Library">
      <CommandInput
        ref={input}
        value={query}
        onValueChange={setQuery}
        placeholder="Search: bench, apartments, oak, café…"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          if (query) setQuery("");
          else if (category) setCategory(null);
          else useApp.getState().setTool("select");
        }}
        trailing={
          <span className="flex items-center gap-0.5">
            {(query || category) && (
              <button
                aria-label="Clear search"
                onClick={() => (setQuery(""), setCategory(null), input.current?.focus())}
                className="h-6 rounded-[5px] px-1.5 text-[11px] text-ink-4 hover:bg-paper-3 hover:text-ink"
              >
                Clear
              </button>
            )}
            <CloseButton />
          </span>
        }
      />
      {/* categories: one compact row of icons; the active one names itself */}
      <div className="flex flex-wrap gap-0.5 border-b border-line px-2 py-1.5" role="group" aria-label="Categories">
        {CATEGORY_ORDER.filter((c) => counts.has(c)).map((c) => {
          const Icon = CATEGORY[c].icon;
          const on = category === c;
          return (
            <Tooltip key={c} content={`${CATEGORY[c].label} · ${counts.get(c)}`}>
              <button
                aria-pressed={on}
                aria-label={CATEGORY[c].label}
                onClick={() => setCategory(on ? null : c)}
                className={cn("flex h-7 items-center gap-1 rounded-[5px] px-1.5 text-[11.5px] transition-colors", on ? "bg-accent text-on-accent" : "text-ink-3 hover:bg-paper-3 hover:text-ink")}
              >
                <Icon size={14} strokeWidth={1.7} />
                {on && <span className="font-medium">{CATEGORY[c].label}</span>}
              </button>
            </Tooltip>
          );
        })}
      </div>
      <CommandList ref={list} className="max-h-none min-h-0 flex-1">
        <CommandEmpty>{total ? `Nothing matches “${query}”.` : "The library is loading…"}</CommandEmpty>
        {groups.map((g) =>
          g.cat && !category ? (
            <CommandGroup key={g.cat} heading={CATEGORY[g.cat].label}>
              {g.defs.map(item)}
            </CommandGroup>
          ) : (
            <CommandGroup key="results">{g.defs.map(item)}</CommandGroup>
          ),
        )}
      </CommandList>
      <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[10.5px] text-ink-4">
        <span className="flex items-center gap-1">
          <Kbd size="xs">↑</Kbd>
          <Kbd size="xs">↓</Kbd> browse · <Kbd size="xs">↵</Kbd> pick
        </span>
        <span>{total} items</span>
      </div>
    </Command>
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
        <CloseButton />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ParamForm def={def} values={values} onChange={(v) => setParams(def.id, v)} onReset={() => resetParams(def.id)} />
      </div>
      <div className="border-t border-line px-3 py-1.5 text-[10.5px] leading-snug text-ink-4">
        {HOW[def.placement]}
        {(def.placement === "point" || def.placement === "rect") && <span className="tabular"> · heading {Math.round(rotation)}°</span>} · <Kbd size="xs">Space</Kbd> pan · <Kbd size="xs">Esc</Kbd> back
      </div>
    </>
  );
}
