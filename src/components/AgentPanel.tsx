"use client";

import {
  Activity,
  Gauge,
  Siren,
  Navigation,
  ArrowUp,
  Building,
  Building2,
  Calculator,
  Check,
  ChevronRight,
  CircleDot,
  Combine,
  Crosshair,
  Eraser,
  GitBranch,
  GitCompare,
  GitMerge,
  History,
  Info,
  Layers,
  LayoutGrid,
  Leaf,
  ListOrdered,
  LoaderCircle,
  MapPin,
  MessageSquareText,
  MoveHorizontal,
  PanelRightClose,
  Repeat,
  RotateCcw,
  Route,
  Ruler,
  ScanSearch,
  Search,
  Shapes,
  ShieldCheck,
  SlidersHorizontal,
  Spline,
  Square,
  SquarePen,
  TramFront,
  BusFront,
  Trash2,
  TreeDeciduous,
  TriangleAlert,
  Undo2,
  Video,
  Waves,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { checkAgent, newConversation, resolveApproval, send, stop, useAgent, type ChatItem, type Segment, type ToolCallUI } from "@/agent/agent";
import { entityName } from "@/agent/resolve";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { Markdown } from "./Markdown";
import { Button, IconButton, Segmented, Tip, cx } from "./ui";

const ICON: Record<string, typeof Search> = {
  get_context: Crosshair,
  resolve_place: MapPin,
  find_features: Search,
  get_feature: Info,
  describe_area: ScanSearch,
  make_polygon: Shapes,
  measure: Ruler,
  find_route: Navigation,
  create_building: Building2,
  modify_buildings: Building,
  merge_buildings: Combine,
  remove_features: Trash2,
  green_roofs: Leaf,
  edit_streets: Route,
  set_junction: CircleDot,
  create_street: Spline,
  plan_street: Spline,
  move_streets: MoveHorizontal,
  realign_streets: Waves,
  remove_streets: Eraser,
  set_street_attributes: SlidersHorizontal,
  create_area: Square,
  convert_areas: Repeat,
  plant_trees: TreeDeciduous,
  create_transit_route: TramFront,
  optimize_stops: BusFront,
  generate_district: LayoutGrid,
  scenario: GitBranch,
  history: History,
  undo: Undo2,
  revert_change: RotateCcw,
  borrow_changes: GitMerge,
  run_simulation: Activity,
  optimize_bottlenecks: Gauge,
  optimize_emergency: Siren,
  compare_scenarios: GitCompare,
  validate: ShieldCheck,
  rank_sites: ListOrdered,
  estimate: Calculator,
  camera: Video,
  show: Layers,
  annotate: MessageSquareText,
};

const VERB: Record<string, string> = {
  get_context: "Reading context",
  resolve_place: "Resolving place",
  find_features: "Searching the city",
  get_feature: "Inspecting",
  describe_area: "Profiling area",
  make_polygon: "Constructing geometry",
  measure: "Measuring",
  find_route: "Routing",
  create_building: "Generating building",
  modify_buildings: "Modifying buildings",
  merge_buildings: "Merging buildings",
  remove_features: "Removing features",
  green_roofs: "Converting roofs",
  edit_streets: "Rebuilding street",
  set_junction: "Redesigning junction",
  create_street: "Laying out street",
  plan_street: "Comparing alignments",
  move_streets: "Shifting street",
  realign_streets: "Realigning",
  remove_streets: "Removing streets",
  set_street_attributes: "Updating streets",
  create_area: "Creating area",
  convert_areas: "Converting areas",
  plant_trees: "Planting trees",
  create_transit_route: "Routing transit",
  optimize_stops: "Optimising stops",
  generate_district: "Masterplanning district",
  scenario: "Managing scenarios",
  history: "Reading history",
  undo: "Undoing",
  revert_change: "Reverting change",
  borrow_changes: "Borrowing changes",
  run_simulation: "Running model",
  optimize_bottlenecks: "Searching junction fixes",
  optimize_emergency: "Searching emergency-access fixes",
  compare_scenarios: "Comparing scenarios",
  validate: "Validating",
  rank_sites: "Ranking sites",
  estimate: "Estimating",
  camera: "Moving camera",
  show: "Updating view",
  annotate: "Annotating",
};

const EXAMPLES: { group: string; items: string[] }[] = [
  {
    group: "Design",
    items: ["Build a 30-story mixed-use tower on the largest surface parking lot near Republic Square", "Turn the Congress Avenue & 6th Street intersection into a roundabout and rebuild the approaches", "Create a shaded green corridor from Republic Square to Waterloo Park with rain gardens along the way"],
  },
  {
    group: "Analyse",
    items: ["Find the five most congested intersections at 5 PM and fix them with the smallest changes that help", "Where does a low-stress bike network break down, and which links would join it up?", "Simulate closing the Congress Avenue bridge during the evening commute"],
  },
  {
    group: "Plan",
    items: ["Redesign the Rainey Street district for 3,000 more residents, improve transit, preserve parks and keep congestion manageable", "Act as an urban planning consultant: assess East Downtown, propose a masterplan, build it and test it"],
  },
];

/** on the blank canvas: build from scratch, then test it */
const SANDBOX_EXAMPLES: { group: string; items: string[] }[] = [
  {
    group: "Build",
    items: ["Lay out a walkable neighbourhood for 5,000 people around a central square, with a boulevard to the east edge of the site", "Add a tram line through the middle of the town and put the tallest buildings within a 5-minute walk of its stops", "Give the town a school, a clinic and a fire station where they reach the most residents"],
  },
  {
    group: "Test",
    items: ["Where will people on foot be hottest at 3 PM in July, and where would trees help most?", "Run traffic for the evening peak and fix any junction that fails", "Make a second design with the same number of homes but twice the open space, and compare them"],
  },
];

export function AgentPanel({ onClose }: { onClose: () => void }) {
  const items = useAgent((s) => s.items);
  const running = useAgent((s) => s.running);
  const configured = useAgent((s) => s.configured);
  const effort = useAgent((s) => s.effort);
  const setEffort = useAgent((s) => s.setEffort);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    checkAgent();
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-paper">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[13px] font-semibold text-ink">Agent</span>
        <span className="text-[11px] text-ink-4">{configured === false ? "not connected" : "spatial planning"}</span>
        <div className="ml-auto flex items-center gap-1">
          <Segmented
            size="xs"
            value={effort}
            onChange={setEffort}
            options={[
              { value: "medium", label: "Fast", title: "Lower reasoning effort — quicker for simple edits" },
              { value: "high", label: "Thorough", title: "Default — plans, validates and iterates" },
              { value: "xhigh", label: "Deep", title: "Maximum effort for masterplans and optimisation" },
            ]}
          />
          <Tip label="New conversation">
            <IconButton size="sm" onClick={newConversation} disabled={!items.length}>
              <SquarePen size={15} strokeWidth={1.7} />
            </IconButton>
          </Tip>
          <Tip label="Hide agent" kbd="⌘J">
            <IconButton size="sm" onClick={onClose}>
              <PanelRightClose size={15} strokeWidth={1.7} />
            </IconButton>
          </Tip>
        </div>
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto"
      >
        {items.length === 0 ? <EmptyState configured={configured} /> : <div className="space-y-4 px-4 py-4">{items.map((it) => <Item key={it.id} item={it} />)}</div>}
        {running && (
          <div className="flex items-center gap-2 px-4 pb-4 text-[12px] text-ink-3">
            <LoaderCircle size={13} className="animate-spin" />
            Working
          </div>
        )}
      </div>

      <Composer />
    </aside>
  );
}

function EmptyState({ configured }: { configured: boolean | null }) {
  return (
    <div className="px-4 pt-6 pb-4">
      <p className="text-[13px] leading-relaxed text-ink-2">
        Describe what you want to change, test or understand. The agent investigates the city, edits the live world model with full cascades, runs the models and shows you the evidence.
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-3">Select buildings, streets or junctions to refer to them as “this”, or just name places.</p>
      {configured === false && (
        <div className="mt-4 rounded-[6px] border border-warn/30 bg-warn-2 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
          <div className="font-medium text-ink">Agent not connected</div>
          Set <code className="font-mono text-[11.5px]">ANTHROPIC_API_KEY</code> in <code className="font-mono text-[11.5px]">.env.local</code> and restart the server. Everything else — editing, simulations, scenarios — works without it.
        </div>
      )}
      {(rtMaybe()?.meta.sandbox ? SANDBOX_EXAMPLES : EXAMPLES).map((g) => (
        <div key={g.group} className="mt-5">
          <div className="mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-4 uppercase">{g.group}</div>
          <div className="space-y-px">
            {g.items.map((t) => (
              <button key={t} onClick={() => send(t)} disabled={configured === false} className="group flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] leading-snug text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-50">
                <ChevronRight size={13} className="mt-[3px] shrink-0 text-ink-4 group-hover:text-ink-2" />
                {t}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  if (item.kind === "user") return <UserMsg text={item.text} refs={item.refs} />;
  if (item.kind === "notice")
    return <div className={cx("rounded-[6px] px-3 py-2 text-[12px]", item.tone === "error" ? "border border-bad/25 bg-bad-2 text-bad" : "bg-paper-2 text-ink-3")}>{item.text}</div>;
  if (item.kind === "approval") return <Approval item={item} />;
  return <AssistantMsg segments={item.segments} done={item.done} />;
}

function UserMsg({ text, refs }: { text: string; refs: string[] }) {
  const R = rtMaybe();
  return (
    <div className="flex flex-col items-end">
      {refs.length > 0 && (
        <div className="mb-1 flex max-w-[90%] flex-wrap justify-end gap-1">
          {refs.map((id) => {
            const e = R?.world.get(id);
            return (
              <span key={id} className="inline-flex h-5 items-center rounded-[4px] bg-accent-2 px-1.5 text-[10.5px] font-medium text-accent">
                {e ? entityName(e) : id}
              </span>
            );
          })}
        </div>
      )}
      <div className="max-w-[90%] rounded-[8px] bg-paper-3 px-3 py-2 text-[13px] leading-[1.5] whitespace-pre-wrap text-ink">{text}</div>
    </div>
  );
}

function AssistantMsg({ segments, done }: { segments: Segment[]; done: boolean }) {
  // group consecutive tool segments into one activity timeline
  const groups = useMemo(() => {
    const out: ({ type: "tools"; calls: ToolCallUI[] } | Segment)[] = [];
    for (const s of segments) {
      if (s.type === "tool") {
        const last = out[out.length - 1];
        if (last && last.type === "tools") last.calls.push(s.call);
        else out.push({ type: "tools", calls: [s.call] });
      } else out.push(s);
    }
    return out;
  }, [segments]);
  if (!segments.length && done) return null;
  return (
    <div className="space-y-2">
      {groups.map((g, i) =>
        g.type === "thinking" ? (
          <Thinking key={i} text={g.text} live={!done && i === groups.length - 1} />
        ) : g.type === "text" ? (
          g.text.trim() ? <Markdown key={i} text={g.text} /> : null
        ) : g.type === "tools" ? (
          <ToolTimeline key={i} calls={g.calls} />
        ) : null,
      )}
    </div>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const first = text.trim().split("\n").find((l) => l.trim()) ?? "";
  return (
    <div className="text-[12px] text-ink-3">
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-1.5 text-left hover:text-ink-2">
        <ChevronRight size={13} className={cx("mt-[2px] shrink-0 transition-transform", open && "rotate-90")} />
        <span className={cx("min-w-0", !open && "truncate")}>
          <span className="font-medium text-ink-2">{live ? "Reasoning" : "Reasoned"}</span>
          {!open && first && <span className="text-ink-4"> — {first.replace(/\*\*/g, "")}</span>}
        </span>
      </button>
      {open && <div className="mt-1 ml-[19px] border-l border-line pl-3 whitespace-pre-wrap leading-relaxed text-ink-3">{text.trim()}</div>}
    </div>
  );
}

function ToolTimeline({ calls }: { calls: ToolCallUI[] }) {
  return (
    <div className="rounded-[8px] border border-line bg-paper-2/60">
      {calls.map((c, i) => (
        <ToolRow key={c.id} call={c} last={i === calls.length - 1} />
      ))}
    </div>
  );
}

function ToolRow({ call, last }: { call: ToolCallUI; last: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = ICON[call.name] ?? Activity;
  const d = call.display;
  const busy = call.status === "running" || call.status === "streaming";
  const isEdit = !!d?.changesetId;
  const hasDetail = !!(d?.lines?.length || d?.metrics?.length || call.input);
  const title = d?.title ?? VERB[call.name] ?? call.name;
  return (
    <div className={cx(!last && "border-b border-line")}>
      <button onClick={() => hasDetail && setOpen(!open)} className={cx("flex w-full items-center gap-2.5 px-2.5 py-[7px] text-left", hasDetail && "hover:bg-paper-3/60")}>
        <span className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-[5px]", isEdit ? "bg-proposed-2 text-proposed" : call.name === "run_simulation" || call.name === "compare_scenarios" ? "bg-accent-2 text-accent" : "bg-paper text-ink-3 ring-1 ring-line")}>
          {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Icon size={13} strokeWidth={1.8} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate text-[12.5px]", busy ? "text-ink-2" : "font-medium text-ink")}>{busy ? VERB[call.name] ?? call.name : title}</span>
          {d?.detail && !busy && <span className="block truncate text-[11.5px] text-ink-3">{d.detail}</span>}
        </span>
        {call.status === "error" && <TriangleAlert size={13} className="shrink-0 text-bad" />}
        {d?.status === "warn" && call.status === "done" && <TriangleAlert size={13} className="shrink-0 text-warn" />}
        {call.status === "done" && d?.status === "ok" && isEdit && <Check size={13} className="shrink-0 text-good" />}
        {call.ms !== undefined && call.ms > 400 && <span className="tabular shrink-0 text-[10.5px] text-ink-4">{(call.ms / 1000).toFixed(1)}s</span>}
      </button>
      {open && (
        <div className="space-y-2 px-2.5 pb-2.5 pl-[42px]">
          {d?.metrics && d.metrics.length > 0 && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {d.metrics.map((m) => (
                <div key={m.label} className="min-w-0">
                  <div className="truncate text-[10.5px] text-ink-4">{m.label}</div>
                  <div className="tabular text-[12.5px] font-medium text-ink">
                    {m.value} {m.delta && <span className={cx("text-[11px]", m.tone === "good" ? "text-good" : m.tone === "bad" ? "text-bad" : "text-ink-3")}>({m.delta})</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {d?.lines && d.lines.length > 0 && (
            <ul className="space-y-0.5 text-[11.5px] leading-snug text-ink-2">
              {d.lines.slice(0, 14).map((l, k) => (
                <li key={k} className={cx(l.startsWith("⚠") ? "text-warn" : l.startsWith("✕") ? "text-bad" : "")}>
                  {l}
                </li>
              ))}
              {d.lines.length > 14 && <li className="text-ink-4">+{d.lines.length - 14} more</li>}
            </ul>
          )}
          {call.input && (
            <details className="text-[11px] text-ink-4">
              <summary className="cursor-pointer select-none hover:text-ink-3">Parameters</summary>
              <pre className="scroll-thin mt-1 max-h-48 overflow-auto rounded-[5px] bg-paper p-2 font-mono text-[10.5px] leading-snug text-ink-3 ring-1 ring-line">{JSON.stringify(call.input, null, 1)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function Approval({ item }: { item: Extract<ChatItem, { kind: "approval" }> }) {
  return (
    <div className="rounded-[8px] border border-warn/35 bg-warn-2/60 p-3">
      <div className="flex items-start gap-2">
        <TriangleAlert size={15} className="mt-px shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-ink">{item.title}</div>
          <ul className="mt-1 space-y-0.5 text-[12px] leading-snug text-ink-2">
            {item.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          {item.state === "pending" ? (
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" tone="primary" onClick={() => resolveApproval(item.id, true)}>
                Apply
              </Button>
              <Button size="sm" onClick={() => resolveApproval(item.id, false)}>
                Decline
              </Button>
            </div>
          ) : (
            <div className={cx("mt-2 text-[11.5px] font-medium", item.state === "approved" ? "text-good" : "text-ink-3")}>{item.state === "approved" ? "Approved" : "Declined"}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Composer() {
  const [text, setText] = useState("");
  const running = useAgent((s) => s.running);
  const configured = useAgent((s) => s.configured);
  const selection = useApp((s) => s.selection);
  const ref = useRef<HTMLTextAreaElement>(null);
  const R = rtMaybe();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(180, el.scrollHeight) + "px";
  }, [text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey))) && !(e.target as HTMLElement)?.closest("input,textarea")) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const submit = () => {
    if (!text.trim() || running) return;
    send(text.trim());
    setText("");
  };
  const chips: ReactNode =
    selection.length > 0 ? (
      <div className="flex flex-wrap items-center gap-1 px-3 pt-2">
        <span className="text-[10.5px] text-ink-4">Referring to</span>
        {selection.slice(0, 4).map((id) => {
          const e = R?.world.get(id);
          return (
            <span key={id} className="inline-flex h-5 max-w-[180px] items-center truncate rounded-[4px] bg-accent-2 px-1.5 text-[10.5px] font-medium text-accent">
              {e ? entityName(e) : id}
            </span>
          );
        })}
        {selection.length > 4 && <span className="text-[10.5px] text-ink-4">+{selection.length - 4}</span>}
        <button className="ml-0.5 text-ink-4 hover:text-ink-2" onClick={() => useApp.getState().setSelection([])} title="Clear selection">
          <X size={12} />
        </button>
      </div>
    ) : null;
  return (
    <div className="shrink-0 border-t border-line p-3">
      <div className="chrome focus-within:border-ink-4">
        {chips}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          disabled={configured === false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") ref.current?.blur();
          }}
          placeholder={configured === false ? "Agent not connected" : "Describe a change, a question or an objective…"}
          className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-[1.5] text-ink outline-none placeholder:text-ink-4"
        />
        <div className="flex items-center justify-end px-2 pb-2">
          {running ? (
            <Button size="sm" tone="default" onClick={stop}>
              <Square size={11} fill="currentColor" /> Stop
            </Button>
          ) : (
            <IconButton size="sm" onClick={submit} disabled={!text.trim()} className={cx(text.trim() && "bg-accent text-on-accent hover:brightness-110")}>
              <ArrowUp size={15} strokeWidth={2} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}
