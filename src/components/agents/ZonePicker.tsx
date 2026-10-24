"use client";

import { Check, ChevronDown, Globe, MousePointerClick, Pentagon, Scan, Search, SquareDashed } from "lucide-react";
import { useState } from "react";
import type { Zone } from "@/agent/types";
import { zoneFromSelection, zoneFromText } from "@/agent/zones";
import { useApp } from "@/state/store";
import { Button, Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/kit";
import { cx } from "../ui";
import { rgb, sessionColor } from "./model";
import { startZoneDraw, zoomToZone, type DrawMode } from "./zoneDraw";

type Found = { error?: string; note?: string; candidates: Zone[] } | null;

/**
 * Where the agent may edit: anywhere, a rectangle or polygon drawn on the map, the current
 * selection, or streets / a place described in words (resolved through the runtime's zones).
 */
export function ZonePicker({ value, onChange, colorKey, disabled }: { value: Zone | null; onChange: (z: Zone | null) => void; colorKey: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found>(null);
  const selection = useApp((s) => s.selection);
  const color = sessionColor(colorKey);

  const choose = (z: Zone | null, zoom = false) => {
    onChange(z);
    setOpen(false);
    if (z && zoom) zoomToZone(z.poly);
  };
  const drawZone = async (mode: DrawMode) => {
    setOpen(false);
    const z = await startZoneDraw(mode, colorKey);
    if (z) onChange(z);
  };
  const resolve = () => {
    const text = q.trim();
    if (!text) return;
    let r: ReturnType<typeof zoneFromText>;
    try {
      r = zoneFromText(text, { selection });
    } catch (e) {
      setFound({ error: (e as Error).message, candidates: [] });
      return;
    }
    if (r.ok && !r.candidates?.length) return choose(r.zone, true);
    if (r.ok) setFound({ note: r.note, candidates: [r.zone, ...r.candidates!.filter((c) => c.id !== r.zone.id)] });
    else setFound({ error: r.error, candidates: r.candidates ?? [] });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQ("");
          setFound(null);
        }
      }}
    >
      <Tooltip content={value ? `Edits limited to ${value.label}` : "The agent may edit anywhere"} side="top">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs" disabled={disabled} className="max-w-[220px] min-w-0 gap-1.5 px-1.5 text-ink-2" aria-label={`Zone: ${value ? value.label : "Anywhere"}`}>
            {value ? <span className="size-2.5 shrink-0 rounded-[2px] border border-dashed" style={{ borderColor: rgb(color), background: rgb(color, 0.18) }} /> : <Globe />}
            <span className="truncate">{value ? value.label : "Anywhere"}</span>
            <ChevronDown className="size-3 text-ink-4" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start" side="top" className="w-[320px] p-0">
        <Command shouldFilter={false} label="Agent zone">
          <CommandInput
            value={q}
            onValueChange={(v) => {
              setQ(v);
              setFound(null);
            }}
            placeholder="Streets or a place, e.g. 6th & Congress block"
          />
          <CommandList className="max-h-[360px]">
            {q.trim() && !found && (
              <CommandGroup>
                <CommandItem value="__resolve" onSelect={resolve}>
                  <Search />
                  <span className="min-w-0 truncate">
                    Find <span className="font-medium">“{q.trim()}”</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {found && (
              <CommandGroup heading={found.candidates.length ? (found.error ? "Did you mean" : "Matches") : undefined}>
                {(found.error || found.note) && <div className={cx("px-2 py-1.5 text-[12px] leading-snug", found.error ? "text-bad" : "text-ink-3")}>{found.error ?? found.note}</div>}
                {found.candidates.map((z) => (
                  <CommandItem key={z.id} value={`cand-${z.id}`} onSelect={() => choose(z, true)}>
                    <Scan />
                    <span className="min-w-0 truncate">{z.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {(q.trim() || found) && <CommandSeparator />}
            <CommandGroup heading="Zone">
              {value && (
                <CommandItem value="__current" onSelect={() => choose(value, true)}>
                  <span className="grid size-3.5 place-items-center">
                    <span className="size-2.5 rounded-[2px] border border-dashed" style={{ borderColor: rgb(color), background: rgb(color, 0.18) }} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{value.label}</span>
                  <Check className="size-3.5 text-rose" />
                </CommandItem>
              )}
              <CommandItem value="__anywhere" onSelect={() => choose(null)}>
                <Globe />
                <span className="flex-1">Anywhere</span>
                {!value && <Check className="size-3.5 text-rose" />}
              </CommandItem>
              <CommandItem value="__rect" onSelect={() => drawZone("rect")}>
                <SquareDashed />
                Draw rectangle
              </CommandItem>
              <CommandItem value="__poly" onSelect={() => drawZone("poly")}>
                <Pentagon />
                Draw polygon
              </CommandItem>
              <CommandItem
                value="__selection"
                disabled={!selection.length}
                onSelect={() => {
                  const z = zoneFromSelection(selection);
                  if (z) choose(z);
                }}
              >
                <MousePointerClick />
                <span className="flex-1">Use current selection</span>
                {selection.length > 0 && <span className="text-[11px] text-ink-4">{selection.length}</span>}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
