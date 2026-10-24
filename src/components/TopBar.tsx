"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, CircleHelp, Download, FilePlus2, GitCompare, LoaderCircle, Footprints, GitBranch, Layers, Moon, Redo2, Sparkles, Sun, Undo2, Upload, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rt, rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { useSims } from "@/sim/client";
import { compareWith } from "./ImpactPanel";
import { defaultParams } from "./AnalysisDock";
import { faceNorth, orbitDrag, overview } from "@/render/camera";
import { toggleNight, togglePedestrian } from "@/state/view";
import { Wordmark } from "./LoadingScreen";
import { CITY_PRESETS, switchCity } from "@/state/cities";
import { clearDesign, exportDesign, hasDesign, importDesign } from "@/state/persist";
import { IconButton, Tip, cx } from "./ui";
import { CommandSearch } from "./CommandSearch";

export function TopBar() {
  useApp((s) => s.scenarioVersion);
  const R = rt();
  const S = R.scenarios;
  const active = S.active;
  const bump = () => {
    useApp.getState().bumpWorld();
    useApp.getState().bumpScenarios();
  };
  return (
    <div className="pointer-events-auto flex h-10 min-w-0 items-center gap-1 chrome scroll-ends pr-1.5 pl-3">
      <button onClick={overview} className="mr-1 flex h-full shrink-0 items-center text-ink" title="Overview">
        <Wordmark className="@max-[700px]:[&>span]:hidden" />
      </button>
      <span className="mx-1 h-4 w-px bg-line-2" />
      <CityMenu />
      <CommandSearch />
      <span className="mx-1 h-4 w-px bg-line-2" />
      <DM.Root>
        <Tip label="Designs: switch, compare or try an alternative">
          <DM.Trigger asChild>
            <button className="flex h-7 min-w-0 items-center gap-1.5 rounded-[6px] px-2 text-[12.5px] font-medium text-ink outline-none hover:bg-paper-3">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: active.color }} />
              <span className="max-w-[140px] truncate">{active.name}</span>
              <span className="tabular shrink-0 text-[11px] font-normal text-ink-4 @max-[820px]:hidden">{active.cursor ? `${active.cursor} edit${active.cursor > 1 ? "s" : ""}` : ""}</span>
              <ChevronDown size={13} className="shrink-0 text-ink-4" />
            </button>
          </DM.Trigger>
        </Tip>
        <DM.Portal>
          <DM.Content sideOffset={6} align="start" className="z-50 w-72 rounded-[8px] border border-line bg-paper p-1 shadow-xl">
            <div className="px-2 pt-1.5 pb-1 font-legend text-[12.5px] leading-none text-ink-3">Scenarios</div>
            {[...S.scenarios.values()].map((s) => (
              <DM.Item
                key={s.id}
                onSelect={() => {
                  S.switchTo(s.id);
                  bump();
                }}
                className="group flex cursor-default items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12.5px] text-ink outline-none data-[highlighted]:bg-paper-3"
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="tabular text-[11px] text-ink-4">{s.cursor}</span>
                {s.id === S.activeId ? <Check size={13} className="text-ink-2" /> : <span className="w-[13px]" />}
                {s.id !== "baseline" && (
                  <button
                    className="hidden text-ink-4 group-hover:block hover:text-bad"
                    onClick={(e) => {
                      e.stopPropagation();
                      S.remove(s.id);
                      bump();
                    }}
                    title="Delete scenario"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </DM.Item>
            ))}
            {active.cursor > 0 && (
              <>
                <DM.Separator className="my-1 h-px bg-line" />
                <ChangesItem />
              </>
            )}
            <DM.Separator className="my-1 h-px bg-line" />
            <DM.Item
              onSelect={() => {
                S.branch(`Option ${String.fromCharCode(64 + S.scenarios.size)}`, "user");
                bump();
              }}
              className="flex cursor-default items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12.5px] text-ink-2 outline-none data-[highlighted]:bg-paper-3"
            >
              <GitBranch size={13} /> Branch from “{active.name}”
            </DM.Item>
          </DM.Content>
        </DM.Portal>
      </DM.Root>
      <Tip label="Undo" kbd="⌘Z">
        <IconButton
          size="sm"
          disabled={!S.canUndo()}
          onClick={() => {
            S.undo();
            bump();
          }}
        >
          <Undo2 size={15} strokeWidth={1.7} />
        </IconButton>
      </Tip>
      <Tip label="Redo" kbd="⇧⌘Z">
        <IconButton
          size="sm"
          disabled={!S.canRedo()}
          onClick={() => {
            S.redo();
            bump();
          }}
        >
          <Redo2 size={15} strokeWidth={1.7} />
        </IconButton>
      </Tip>
    </div>
  );
}

export function ViewControls({ agentOpen }: { agentOpen: boolean }) {
  const cam = useApp((s) => s.cameraMode);
  return (
    <div className="pointer-events-auto flex h-10 shrink-0 items-center gap-0.5 chrome scroll-ends px-1.5">
      <Compass />
      <Tip label={cam === "pedestrian" ? "Back up above the street" : "Walk at street level"} kbd="P">
        <IconButton size="sm" active={cam === "pedestrian"} onClick={togglePedestrian} aria-label="Street level">
          <Footprints size={15} strokeWidth={1.7} />
        </IconButton>
      </Tip>
      <ViewMenu />
      <Tip label="Controls and navigation" kbd="?">
        <IconButton size="sm" onClick={() => useApp.getState().setHelpOpen(true)} aria-label="Controls and navigation">
          <CircleHelp size={15} strokeWidth={1.7} />
        </IconButton>
      </Tip>
      {!agentOpen && (
        <>
          <span className="mx-0.5 h-4 w-px bg-line-2" />
          <Tip label="Ask the planning agent" kbd="⌘J">
            <button onClick={() => useApp.getState().askAgent()} className="flex h-7 items-center gap-1.5 rounded-full bg-accent px-2.5 text-[12px] font-medium text-on-accent hover:brightness-105">
              <Sparkles size={13} strokeWidth={1.8} /> Agent
            </button>
          </Tip>
        </>
      )}
    </div>
  );
}

/** what the map shows: day or night, change highlighting, and the layers */
function ViewMenu() {
  const theme = useApp((s) => s.theme);
  const showChanges = useApp((s) => s.showChanges);
  const layers = useApp((s) => s.layers);
  const toggle = useApp((s) => s.toggleLayer);
  const item = "flex cursor-default items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12.5px] text-ink outline-none data-[highlighted]:bg-accent-2";
  const box = (on: boolean) => <span className={cx("grid h-3.5 w-3.5 place-items-center rounded-[3px] border", on ? "border-rose/60 bg-accent text-on-accent" : "border-line-2")}>{on && <Check size={10} strokeWidth={3} />}</span>;
  return (
    <DM.Root>
      <Tip label="What the map shows">
          <DM.Trigger asChild>
            <IconButton size="sm" aria-label="What the map shows">
              <Layers size={15} strokeWidth={1.7} />
            </IconButton>
          </DM.Trigger>
      </Tip>
      <DM.Portal>
        <DM.Content sideOffset={6} align="end" className="chrome z-50 w-60 p-1">
          <DM.Item className={item} onSelect={(e) => (e.preventDefault(), toggleNight())}>
            {theme === "night" ? <Sun size={13} className="text-ink-3" /> : <Moon size={13} className="text-ink-3" />}
            <span className="flex-1">{theme === "night" ? "Daytime" : "Night time"}</span>
            <kbd className="font-mono text-[10px] text-ink-4">N</kbd>
          </DM.Item>
          <DM.CheckboxItem checked={showChanges} onSelect={(e) => e.preventDefault()} onCheckedChange={() => useApp.getState().setShowChanges(!showChanges)} className={item}>
            {box(showChanges)}
            Highlight what the plan changes
          </DM.CheckboxItem>
          <DM.Separator className="my-1 h-px bg-line" />
          {(
            [
              ["labels", "Street names"],
              ["markings", "Lane markings"],
              ["trees", "Trees"],
              ["paths", "Paths and trails"],
              ["transit", "Transit routes and stops"],
              ["context", "Surrounding city"],
            ] as const
          )
            .filter(([k]) => k !== "context" || !rt().meta.sandbox)
            .map(([k, label]) => (
              <DM.CheckboxItem key={k} checked={layers[k]} onSelect={(e) => e.preventDefault()} onCheckedChange={() => toggle(k)} className={item}>
                {box(layers[k])}
                {label}
              </DM.CheckboxItem>
            ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

/**
 * Compass showing the view's heading and tilt. Drag it to orbit (sideways turns, up/down tilts);
 * click to face north, and again to switch between plan view and 3D.
 */
function Compass() {
  const [view, setView] = useState({ bearing: 0, pitch: 0 });
  const moved = useRef(false);
  useEffect(() => {
    let map = rtMaybe()?.map;
    let raf = 0;
    const read = () => {
      raf = 0;
      if (map) setView({ bearing: map.getBearing(), pitch: map.getPitch() });
    };
    const on = () => (raf ||= requestAnimationFrame(read));
    let tries = 0;
    const iv = setInterval(() => {
      map = rtMaybe()?.map;
      if (!map && ++tries < 50) return;
      clearInterval(iv);
      map?.on("rotate", on);
      map?.on("pitch", on);
      read();
    }, 100);
    return () => {
      clearInterval(iv);
      cancelAnimationFrame(raf);
      map?.off("rotate", on);
      map?.off("pitch", on);
    };
  }, []);
  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    moved.current = false;
    const move = orbitDrag(e.clientX, e.clientY);
    const x0 = e.clientX,
      y0 = e.clientY;
    const mm = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 3) moved.current = true;
      if (moved.current) move(ev.clientX, ev.clientY);
    };
    const up = () => {
      el.removeEventListener("pointermove", mm);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", mm);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <Tip label="Drag to rotate & tilt · click to face north" kbd="Q E · ⇧↑↓">
      <IconButton size="sm" onPointerDown={down} onClick={() => !moved.current && faceNorth()} className="cursor-grab touch-none active:cursor-grabbing" aria-label="Compass: drag to rotate and tilt, click to face north">
        <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden style={{ transform: `rotateX(${view.pitch * 0.7}deg) rotate(${-view.bearing}deg)` }}>
          <circle r="8" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
          <path d="M0 -6.5 2.6 0H-2.6Z" fill="var(--color-bad, #e5484d)" />
          <path d="M0 6.5 2.6 0H-2.6Z" fill="currentColor" fillOpacity="0.55" />
        </svg>
      </IconButton>
    </Tip>
  );
}

/** which city is open: the blank canvas or a measured preset; design files for the canvas */
function CityMenu() {
  const R = rt();
  const file = useRef<HTMLInputElement>(null);
  const item = "flex cursor-default items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12.5px] text-ink outline-none data-[highlighted]:bg-paper-3 data-[disabled]:opacity-40";
  const go = (id: string) => {
    if (id === R.cityId) return;
    // the canvas saves itself; edits to a measured city live only in this session
    if (!R.meta.sandbox && R.scenarios.scenarios.size > 1 && !window.confirm(`Leave ${R.meta.name}? Scenario edits here are not saved.`)) return;
    switchCity(id);
  };
  return (
    <DM.Root>
      <Tip label="Change city, or save and open designs">
        <DM.Trigger asChild>
          <button className="flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-2 text-[12.5px] font-medium whitespace-nowrap text-ink outline-none hover:bg-paper-3">
            {R.meta.name}
            <ChevronDown size={13} className="text-ink-4" />
          </button>
        </DM.Trigger>
      </Tip>
      <DM.Portal>
        <DM.Content sideOffset={6} align="start" className="z-50 w-80 rounded-[8px] border border-line bg-paper p-1 shadow-xl">
          <div className="px-2 pt-1.5 pb-1 font-legend text-[12.5px] leading-none text-ink-3">Start from</div>
          {CITY_PRESETS.map((c) => (
            <DM.Item key={c.id} onSelect={() => go(c.id)} className={cx(item, "items-start")}>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{c.name}</span>
                <span className="block text-[11px] leading-snug text-ink-4">{c.blurb}</span>
              </span>
              {c.id === R.cityId ? <Check size={13} className="mt-0.5 text-ink-2" /> : <span className="w-[13px]" />}
            </DM.Item>
          ))}
          {R.meta.sandbox && (
            <>
              <DM.Separator className="my-1 h-px bg-line" />
              <DM.Item
                className={item}
                onSelect={async () => {
                  if (hasDesign() && !window.confirm("Clear this design and start again? Export it first to keep a copy.")) return;
                  await clearDesign();
                  window.location.reload();
                }}
              >
                <FilePlus2 size={13} className="text-ink-3" /> New blank canvas
              </DM.Item>
              <DM.Item className={item} disabled={!hasDesign()} onSelect={exportDesign}>
                <Download size={13} className="text-ink-3" /> Export design
              </DM.Item>
              <DM.Item className={item} onSelect={() => file.current?.click()}>
                <Upload size={13} className="text-ink-3" /> Open design file…
              </DM.Item>
              <div className="px-2 pt-1 pb-1.5 text-[10.5px] leading-snug text-ink-4">Your design is saved in this browser as you work.</div>
            </>
          )}
        </DM.Content>
      </DM.Portal>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (hasDesign() && !window.confirm("Open this file in place of the current design? Export the current one first to keep it.")) return;
          try {
            await importDesign(f);
            window.location.reload();
          } catch (err) {
            useApp.getState().notify((err as Error).message, "error");
          }
        }}
      />
    </DM.Root>
  );
}

/** analyses that can be shown as a difference against the current city */
const COMPARABLE = { heat: "heat", runoff: "runoff", traffic: "traffic" } as const;

/**
 * Show what the plan changed (in the scenario menu): with heat, stormwater or traffic open, colours
 * the map by the difference from Current; otherwise shows what the plan adds and removes.
 */
function ChangesItem() {
  const overlay = useApp((s) => s.overlay);
  const records = useSims((s) => s.records);
  const shown = useSims((s) => s.shown);
  const compare = useSims((s) => s.compare);
  const [busy, setBusy] = useState(false);
  const kind = overlay && overlay in COMPARABLE ? COMPARABLE[overlay as keyof typeof COMPARABLE] : null;
  const on = kind ? records.find((r) => r.id === compare[kind])?.scenarioId === "baseline" : overlay === "change";
  const toggle = async () => {
    const st = useApp.getState();
    if (!kind) return st.setOverlay(overlay === "change" ? "heat" : "change");
    setBusy(true);
    try {
      const params = records.find((r) => r.id === shown[kind])?.params ?? defaultParams(kind);
      await compareWith(kind, on ? "" : "baseline", params);
      st.bumpOverlay();
    } finally {
      setBusy(false);
    }
  };
  return (
    <DM.CheckboxItem
      checked={on}
      onSelect={(e) => e.preventDefault()}
      onCheckedChange={toggle}
      className="flex cursor-default items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12.5px] text-ink outline-none data-[highlighted]:bg-paper-3"
    >
      <span className={cx("grid h-3.5 w-3.5 place-items-center rounded-[3px] border", on ? "border-accent bg-accent text-on-accent" : "border-line-2")}>{on && <Check size={10} strokeWidth={3} />}</span>
      <span className="flex-1">Show changes</span>
      {busy ? <LoaderCircle size={12} className="animate-spin text-ink-3" /> : <GitCompare size={12} className="text-ink-4" />}
    </DM.CheckboxItem>
  );
}
