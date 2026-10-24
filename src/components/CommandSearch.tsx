"use client";

// The search box finds things to do: tools, analyses, views and design actions, or hands the
// question to the agent. "/" or ⌘K to focus, arrows to choose, Enter to run.

import { Building2, CircleHelp, Compass, Download, Eye, Footprints, GitBranch, LayoutGrid, Map as MapIcon, MessageSquare, Moon, MousePointer2, Redo2, Ruler, Search, Spline, Square, Tags, TramFront, TreeDeciduous, Undo2, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { faceNorth, overview, tilt } from "@/render/camera";
import { switchCity } from "@/state/cities";
import { resetDraw } from "@/state/drawing";
import { exportDesign, hasDesign } from "@/state/persist";
import { rt } from "@/state/runtime";
import { useApp, type Tool } from "@/state/store";
import { toggleNight, togglePedestrian } from "@/state/view";
import { availableOverlays } from "./AnalysisDock";
import { cx } from "./ui";

interface Cmd {
  id: string;
  label: string;
  group: "Tools" | "Analyses" | "View" | "Design" | "Agent" | "Help";
  icon: LucideIcon;
  /** other words people might type for it */
  words?: string;
  keys?: string;
  /** currently on (a toggle or the open tool / overlay) */
  on?: boolean;
  run: () => void;
}

const TOOLS: { tool: Tool; label: string; icon: LucideIcon; keys: string; words: string }[] = [
  { tool: "select", label: "Select and inspect", icon: MousePointer2, keys: "V", words: "pick choose edit info" },
  { tool: "street", label: "Draw a street", icon: Spline, keys: "S", words: "road avenue boulevard lane bike path" },
  { tool: "building", label: "Draw a building", icon: Building2, keys: "B", words: "house homes tower office shop school" },
  { tool: "area", label: "Add a park, plaza or water", icon: Square, keys: "A", words: "green garden lake pond square open space" },
  { tool: "tree", label: "Plant trees", icon: TreeDeciduous, keys: "T", words: "tree shade oak elm canopy planting" },
  { tool: "district", label: "Generate a district", icon: LayoutGrid, keys: "D", words: "blocks neighbourhood neighborhood masterplan homes" },
  { tool: "transit", label: "Draw a transit line", icon: TramFront, keys: "R", words: "bus tram brt route stop train" },
  { tool: "measure", label: "Measure", icon: Ruler, keys: "M", words: "distance ruler length area" },
];

function commands(): Cmd[] {
  const st = useApp.getState();
  const R = rt();
  const bump = () => {
    st.bumpWorld();
    st.bumpScenarios();
  };
  const out: Cmd[] = TOOLS.map((t) => ({
    id: `tool:${t.tool}`,
    label: t.label,
    group: "Tools",
    icon: t.icon,
    keys: t.keys,
    words: t.words,
    on: st.tool === t.tool,
    run: () => {
      resetDraw();
      st.setTool(t.tool);
    },
  }));
  out.push({ id: "agent", label: "Ask the agent", group: "Agent", icon: MessageSquare, keys: "⌘J", words: "ai chat claude help question plan", run: () => st.askAgent() });
  for (const c of availableOverlays())
    out.push({ id: `overlay:${c.id}`, label: `${c.label} map`, group: "Analyses", icon: c.icon, words: c.hint, on: st.overlay === c.id, run: () => st.setOverlay(st.overlay === c.id ? null : c.id) });
  out.push(
    { id: "pedestrian", label: st.cameraMode === "pedestrian" ? "Leave street level" : "Walk at street level", group: "View", icon: Footprints, keys: "P", words: "pedestrian walk first person eye level", on: st.cameraMode === "pedestrian", run: togglePedestrian },
    { id: "night", label: st.theme === "night" ? "Daytime" : "Night time", group: "View", icon: Moon, keys: "N", words: "dark night day theme lights", run: toggleNight },
    { id: "north", label: "Face north", group: "View", icon: Compass, words: "compass reset rotation bearing", run: faceNorth },
    { id: "plan", label: "Look straight down", group: "View", icon: MapIcon, words: "plan top down 2d flat birds eye", run: () => tilt(-90) },
    { id: "overview", label: "See the whole site", group: "View", icon: MapIcon, words: "overview zoom out home reset view", run: overview },
    { id: "changes", label: st.showChanges ? "Stop highlighting changes" : "Highlight what the plan changes", group: "View", icon: Eye, words: "proposed new gold changes", on: st.showChanges, run: () => st.setShowChanges(!st.showChanges) },
    { id: "labels", label: st.layers.labels ? "Hide street names" : "Show street names", group: "View", icon: Tags, words: "labels names text", on: st.layers.labels, run: () => st.toggleLayer("labels") },
    { id: "undo", label: "Undo", group: "Design", icon: Undo2, keys: "⌘Z", words: "back revert", run: () => (R.scenarios.undo(), bump()) },
    { id: "redo", label: "Redo", group: "Design", icon: Redo2, keys: "⇧⌘Z", words: "again forward", run: () => (R.scenarios.redo(), bump()) },
    { id: "branch", label: "Try an alternative design", group: "Design", icon: GitBranch, words: "branch scenario option copy compare", run: () => (R.scenarios.branch(`Option ${String.fromCharCode(64 + R.scenarios.scenarios.size)}`, "user"), bump()) },
  );
  if (R.meta.sandbox) {
    out.push({ id: "austin", label: "Open Austin", group: "Design", icon: MapIcon, words: "city real texas measured", run: () => switchCity("austin") });
    if (hasDesign()) out.push({ id: "export", label: "Save the design as a file", group: "Design", icon: Download, words: "export download json backup", run: exportDesign });
  } else out.push({ id: "blank", label: "Open a blank canvas", group: "Design", icon: MapIcon, words: "sandbox new empty scratch", run: () => switchCity("sandbox") });
  out.push({ id: "help", label: "Controls and navigation", group: "Help", icon: CircleHelp, keys: "?", words: "help keys keyboard mouse rotate tilt move camera how", run: () => st.setHelpOpen(true) });
  return out;
}

/** every word of the query starts a word of the command (label first, then its other words) */
function score(c: Cmd, q: string): number {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const label = c.label.toLowerCase().split(/[\s,]+/);
  const extra = `${c.words ?? ""} ${c.group}`.toLowerCase().split(/[\s,;()·/]+/);
  let s = 0;
  for (const w of words) {
    if (label.some((x) => x.startsWith(w))) s += 3;
    else if (extra.some((x) => x.startsWith(w))) s += 1;
    else return -1;
  }
  return s;
}

/** what to offer before anything is typed */
const STARTERS = ["tool:tree", "tool:street", "tool:building", "agent", "overlay:heat", "pedestrian", "help"];

export function CommandSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const agentOpen = useApp((s) => s.agentOpen);
  useApp((s) => s.tool);
  useApp((s) => s.overlay);
  const results = useMemo<Cmd[]>(() => {
    if (!open) return [];
    const all = commands();
    if (!q.trim()) return STARTERS.map((id) => all.find((c) => c.id === id)).filter((c): c is Cmd => !!c);
    const hits = all
      .map((c) => ({ c, s: score(c, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 7)
      .map((x) => x.c);
    // anything else is a question for the agent
    hits.push({ id: "ask", label: `Ask the agent: “${q.trim()}”`, group: "Agent", icon: MessageSquare, run: () => useApp.getState().askAgent(q.trim()) });
    return hits;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input,textarea,select,[contenteditable]")) return;
      if (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const go = (c: Cmd) => {
    setQ("");
    setOpen(false);
    input.current?.blur();
    c.run();
  };
  // a fixed slot (narrower beside the agent, an icon on a small map); while typing the field
  // widens over its neighbours instead of pushing them
  return (
    <div className={cx("relative h-7 shrink-0", agentOpen ? "w-[150px]" : "w-[220px]", "@max-[900px]:w-[130px] @max-[740px]:w-7")}>
      <label className="absolute inset-y-0 left-0 z-10 flex w-full items-center gap-1.5 rounded-full border border-line-2 bg-paper/80 px-2.5 transition-[width] focus-within:w-[280px] focus-within:border-rose/50 focus-within:bg-paper @max-[740px]:px-[7px]">
        <Search size={13} className="shrink-0 text-ink-3" />
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((x) => Math.min(results.length - 1, x + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((x) => Math.max(0, x - 1));
            } else if (e.key === "Enter" && results[sel]) go(results[sel]);
            else if (e.key === "Escape") {
              setOpen(false);
              input.current?.blur();
            }
          }}
          placeholder="Find a tool or ask…"
          aria-label="Find a tool or action, or ask the agent"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-4"
        />
        {!q && <kbd className="rounded-[3px] border border-line-2 px-1 font-mono text-[10px] text-ink-4 @max-[900px]:hidden">/</kbd>}
      </label>
      {open && results.length > 0 && (
        <div className="chrome absolute top-9 left-0 z-50 w-[min(320px,calc(100cqw-120px))] p-1" role="listbox">
          {!q.trim() && <div className="px-2 pt-1 pb-1.5 text-[10.5px] tracking-[0.08em] text-ink-4 uppercase">Try</div>}
          {results.map((c, i) => {
            const Icon = c.icon;
            return (
              <button
                key={c.id}
                role="option"
                aria-selected={i === sel}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(c)}
                onMouseEnter={() => setSel(i)}
                className={cx("flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left", i === sel ? "bg-accent-2" : "")}
              >
                <Icon size={14} strokeWidth={1.7} className={cx("shrink-0", c.on ? "text-rose" : "text-ink-3")} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{c.label}</span>
                {c.on && <span className="text-[10px] text-rose">on</span>}
                {c.keys ? <kbd className="shrink-0 rounded-[3px] border border-line-2 px-1 font-mono text-[10px] text-ink-4">{c.keys}</kbd> : <span className="shrink-0 text-[10.5px] text-ink-4">{c.group}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
