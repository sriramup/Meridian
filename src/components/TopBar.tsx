"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, CircleHelp, Download, FileJson, FileSpreadsheet, GitCompare, LoaderCircle, Footprints, GitBranch, Layers, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Redo2, Sparkles, Undo2, Upload, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rt, rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { useSims } from "@/sim/client";
import { compareWith } from "./ImpactPanel";
import { defaultParams } from "./AnalysisDock";
import { faceNorth, orbitDrag, overview } from "@/render/camera";
import { togglePedestrian } from "@/state/view";
import { Wordmark } from "./LoadingScreen";
import { renameProject, toggleSidebar, useProjects } from "@/state/projects";
import { exportableScenarios } from "@/state/proposalIO";
import { openProposalFile, saveProposal } from "@/state/proposalActions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/kit";
import { Input } from "./ui/kit";
import { IconButton, Tip, cx } from "./ui";
import { PlaceSearch } from "./PlaceSearch";
import { confirmAction } from "./ConfirmDialog";
import { promptText } from "./projects/PromptDialog";
import { SIDEBAR_KEY } from "./projects/ProjectsSidebar";

export function TopBar() {
  useApp((s) => s.scenarioVersion);
  const R = rt();
  const S = R.scenarios;
  const bump = () => {
    useApp.getState().bumpWorld();
    useApp.getState().bumpScenarios();
  };
  return (
    <div className="pointer-events-auto flex h-10 min-w-0 items-center gap-1 chrome scroll-ends pr-1.5 pl-1.5">
      <SidebarToggle />
      <button onClick={overview} className="mr-1 ml-0.5 flex h-full shrink-0 items-center text-ink" title="Overview">
        <Wordmark className="@max-[960px]:[&>span]:hidden" />
      </button>
      <span className="mx-1 h-4 w-px bg-line-2" />
      <ProjectName />
      <PlaceSearch />
      <span className="mx-1 h-4 w-px bg-line-2" />
      <ScenarioMenu />
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

/** the open project's name; click to rename it in place */
function ProjectName() {
  const project = useProjects((s) => s.list.find((p) => p.id === s.currentId));
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) requestAnimationFrame(() => input.current?.select());
  }, [editing]);
  if (!project) return null;
  const finish = (keep: boolean) => {
    if (keep) void renameProject(project.id, v);
    setEditing(false);
  };
  if (editing)
    return (
      <Input
        ref={input}
        size="xs"
        value={v}
        maxLength={80}
        aria-label="Project name"
        data-testid="topbar-project-rename"
        className="h-7 w-44 shrink-0 text-[12.5px] font-medium"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true);
          else if (e.key === "Escape") finish(false);
        }}
        onBlur={() => finish(true)}
      />
    );
  return (
    <Tip label="Rename project">
      <button
        data-testid="topbar-project-name"
        onClick={() => {
          setV(project.name);
          setEditing(true);
        }}
        className="flex h-7 max-w-[200px] min-w-0 shrink items-center rounded-[6px] px-2 text-[12.5px] font-semibold whitespace-nowrap text-ink outline-none hover:bg-paper-3 focus-visible:ring-2 focus-visible:ring-rose/25 @max-[820px]:max-w-[120px]"
      >
        <span className="truncate">{project.name}</span>
      </button>
    </Tip>
  );
}

/** opens and closes the projects sidebar (far left of the top bar) */
function SidebarToggle() {
  const open = useProjects((s) => s.sidebarOpen);
  return (
    <Tip label={open ? "Hide projects" : "Show projects"} kbd={SIDEBAR_KEY}>
      <IconButton size="sm" onClick={toggleSidebar} aria-label={open ? "Hide projects" : "Show projects"} aria-pressed={open} data-testid="sidebar-toggle">
        {open ? <PanelLeftClose size={15} strokeWidth={1.7} /> : <PanelLeftOpen size={15} strokeWidth={1.7} />}
      </IconButton>
    </Tip>
  );
}

/** a proposal name not used yet: "Option B", "Option C"… */
function nextOptionName(names: string[]) {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  for (let i = 0; i < 26 * 4; i++) {
    const n = `Option ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? ` ${Math.floor(i / 26) + 1}` : ""}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return "Option";
}

/** the proposals of the open project: switch, rename, start new or branch, delete, export / import */
function ScenarioMenu() {
  useApp((s) => s.scenarioVersion);
  const R = rt();
  const S = R.scenarios;
  const active = S.active;
  const file = useRef<HTMLInputElement>(null);
  const bump = () => {
    useApp.getState().bumpWorld();
    useApp.getState().bumpScenarios();
  };
  const canExport = active.id !== "baseline" && active.cursor > 0;
  const many = exportableScenarios(R).length > 1;
  const names = () => [...S.scenarios.values()].map((s) => s.name);
  const make = async (from: "baseline" | "active") => {
    const src = from === "baseline" ? S.scenarios.get("baseline")! : S.active;
    const name = await promptText({
      title: from === "baseline" ? "New proposal" : `Branch from “${src.name}”`,
      body: from === "baseline" ? `Starts from ${R.meta.sandbox ? "the empty site" : "the existing city"}.` : `Starts as a copy of “${src.name}” with its ${src.cursor} edit${src.cursor === 1 ? "" : "s"}; the original stays as it is.`,
      label: "Proposal name",
      value: nextOptionName(names()),
      confirm: from === "baseline" ? "Create proposal" : "Create branch",
    });
    if (!name) return;
    S.branch(name, "user", src.id);
    bump();
  };
  const rename = async () => {
    const name = await promptText({ title: "Rename proposal", label: "Proposal name", value: active.name, confirm: "Rename" });
    if (name && name !== active.name) {
      S.rename(active.id, name);
      bump();
    }
  };
  const remove = async () => {
    if (active.id === "baseline") return;
    const ok = !active.changesets.length || (await confirmAction({ title: `Delete “${active.name}”?`, body: `Its ${active.changesets.length} edit${active.changesets.length === 1 ? "" : "s"} and their history are removed. Export it first to keep a copy.`, confirm: "Delete proposal", danger: true }));
    if (!ok) return;
    S.remove(active.id);
    bump();
  };
  return (
    <DropdownMenu>
      <Tip label="Proposals: switch, rename, start new, branch, export or import">
        <DropdownMenuTrigger asChild>
          <button data-testid="proposal-menu" className="flex h-7 min-w-0 items-center gap-1.5 rounded-[6px] px-2 text-[12.5px] font-medium text-ink outline-none hover:bg-paper-3">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: active.color }} />
            <span className="max-w-[140px] truncate">{active.name}</span>
            <span className="tabular shrink-0 text-[11px] font-normal text-ink-4 @max-[1000px]:hidden">{active.cursor ? `${active.cursor} edit${active.cursor > 1 ? "s" : ""}` : ""}</span>
            <ChevronDown size={13} className="shrink-0 text-ink-4" />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Proposals</DropdownMenuLabel>
        {[...S.scenarios.values()].map((s) => (
          <DropdownMenuItem
            key={s.id}
            onSelect={() => {
              S.switchTo(s.id);
              bump();
            }}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="tabular text-[11px] text-ink-4">{s.cursor || ""}</span>
            {s.id === S.activeId ? <Check size={13} className="text-ink-2" /> : <span className="w-[13px]" />}
          </DropdownMenuItem>
        ))}
        {active.cursor > 0 && (
          <>
            <DropdownMenuSeparator />
            <ChangesItem />
          </>
        )}
        <DropdownMenuSeparator />
        {active.id !== "baseline" && (
          <DropdownMenuItem onSelect={() => void make("active")}>
            <GitBranch /> <span className="min-w-0 truncate">Branch from “{active.name}”…</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => void make("baseline")}>
          <Plus /> New proposal…
        </DropdownMenuItem>
        {active.id !== "baseline" && (
          <>
            <DropdownMenuItem onSelect={() => void rename()}>
              <Pencil /> Rename…
            </DropdownMenuItem>
            <DropdownMenuItem variant="danger" onSelect={() => void remove()}>
              <Trash2 /> Delete proposal…
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!canExport && !many}>
            <Download /> Export proposal
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64">
            <DropdownMenuItem disabled={!canExport} onSelect={() => saveProposal("json")}>
              <FileJson /> <span className="flex-1">JSON</span>
              <span className="text-[11px] text-ink-4">exact, re-importable</span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canExport} onSelect={() => saveProposal("csv")}>
              <FileSpreadsheet /> <span className="flex-1">CSV</span>
              <span className="text-[11px] text-ink-4">a row per feature</span>
            </DropdownMenuItem>
            {many && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => saveProposal("json", "all")}>
                  <FileJson /> <span className="flex-1">All proposals (JSON)</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => file.current?.click()}>
          <Upload /> Import proposal…
        </DropdownMenuItem>
      </DropdownMenuContent>
      <input
        ref={file}
        type="file"
        accept=".json,.csv,application/json,text/csv"
        className="hidden"
        data-testid="import-proposal"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void openProposalFile(f);
        }}
      />
    </DropdownMenu>
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

/** what the map shows: change highlighting and the layers (day and night follow the clock) */
function ViewMenu() {
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
  // the needle follows the camera by writing its transform directly: no React render per frame
  const needle = useRef<SVGSVGElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    let map = rtMaybe()?.map;
    let raf = 0;
    const read = () => {
      raf = 0;
      if (map && needle.current) needle.current.style.transform = `rotateX(${map.getPitch() * 0.7}deg) rotate(${-map.getBearing()}deg)`;
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
        <svg ref={needle} width="18" height="18" viewBox="-9 -9 18 18" aria-hidden>
          <circle r="8" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
          <path d="M0 -6.5 2.6 0H-2.6Z" fill="var(--color-bad, #e5484d)" />
          <path d="M0 6.5 2.6 0H-2.6Z" fill="currentColor" fillOpacity="0.55" />
        </svg>
      </IconButton>
    </Tip>
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
