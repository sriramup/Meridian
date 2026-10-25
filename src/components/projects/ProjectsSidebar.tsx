"use client";

// The projects sidebar: every project in this browser, newest work wherever the person put it.
// Click to open (no page load), double-click or F2 to rename, right-click for Rename / Duplicate /
// Delete, drag (or Alt+↑/↓) to reorder. A new project opens straight away with its name ready to type.

import { Building2, Copy, FolderOpen, Pencil, Plus, SquareDashed, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { confirmAction } from "../ConfirmDialog";
import {
  Badge,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Input,
  Tooltip,
  cn,
} from "../ui/kit";
import { presetOf } from "@/state/cities";
import { createProject, deleteProject, duplicateProject, openProject, renameProject, reorderProject, TEMPLATES, useProjects, type ProjectMeta } from "@/state/projects";
import { relativeTime } from "./time";

/** row height + gap (px): rows are a fixed height so a drag can be laid out by index */
const ROW = 46;
const GAP = 2;
const SLOT = ROW + GAP;

export const SIDEBAR_WIDTH = 252;

/** start a project from a template and put its name up for editing */
export async function newProject(base: string) {
  const p = await createProject(base, { open: false });
  useProjects.setState({ renamingId: p.id });
  await openProject(p.id);
}

export async function askDeleteProject(p: ProjectMeta) {
  const ok = await confirmAction({ title: `Delete “${p.name}”?`, body: "Its proposals and their history are removed from this browser. This can’t be undone.", confirm: "Delete project", danger: true });
  if (ok) await deleteProject(p.id);
}

export function ProjectsSidebar() {
  const list = useProjects((s) => s.list);
  const currentId = useProjects((s) => s.currentId);
  const switchingId = useProjects((s) => s.switching?.id ?? null);
  const durable = useProjects((s) => s.durable);
  const [, tick] = useState(0);
  // relative times stay current
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(iv);
  }, []);
  const [drag, setDrag] = useState<{ id: string; from: number; dy: number } | null>(null);
  const [settling, setSettling] = useState(false);
  const [announce, setAnnounce] = useState("");
  const rows = useRef<HTMLDivElement>(null);
  const over = drag ? Math.max(0, Math.min(list.length - 1, drag.from + Math.round(drag.dy / SLOT))) : -1;

  const focusRow = (i: number) => (rows.current?.querySelectorAll<HTMLElement>("[data-project-row]")[i])?.focus();
  const move = async (p: ProjectMeta, to: number) => {
    if (to < 0 || to >= list.length) return;
    await reorderProject(p.id, to);
    setAnnounce(`${p.name} moved to position ${to + 1} of ${list.length}`);
    requestAnimationFrame(() => focusRow(to));
  };

  const shift = (i: number) => {
    if (!drag || i === drag.from) return 0;
    if (drag.from < over && i > drag.from && i <= over) return -SLOT;
    if (drag.from > over && i >= over && i < drag.from) return SLOT;
    return 0;
  };

  return (
    <aside
      aria-label="Projects"
      className="flex h-full w-full flex-col border-r border-line-2"
      style={{ background: "var(--parchment), linear-gradient(270deg, #d8bd8c 0, #ecdab4 12px, #f4e6c7 60%, #eedcb6 100%)" }}
    >
      <div className="flex h-[64px] shrink-0 items-end justify-between px-3 pb-2">
        <span className="font-legend text-[13px] leading-none text-ink-3">Projects</span>
        <NewProjectMenu />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div ref={rows} role="list" aria-label="Projects" className="relative flex flex-col" style={{ gap: GAP }}>
          {list.map((p, i) => (
            <ProjectRow
              key={p.id}
              p={p}
              index={i}
              count={list.length}
              current={p.id === currentId}
              opening={p.id === switchingId && p.id !== currentId}
              dragging={drag?.id === p.id}
              offset={drag?.id === p.id ? drag.dy : shift(i)}
              animate={!!drag && !settling}
              onDragStart={() => setDrag({ id: p.id, from: i, dy: 0 })}
              onDragMove={(dy) => setDrag((d) => d && { ...d, dy: Math.max(-d.from * SLOT - 8, Math.min((list.length - 1 - d.from) * SLOT + 8, dy)) })}
              onDragEnd={() => {
                const to = over;
                setSettling(true);
                setDrag(null);
                requestAnimationFrame(() => setSettling(false));
                if (to >= 0 && to !== i) void move(p, to);
              }}
              onMove={(to) => void move(p, to)}
              onFocusRow={focusRow}
            />
          ))}
        </div>
      </div>
      <div className="shrink-0 px-3 pt-1 pb-2.5 text-[10.5px] leading-snug text-ink-4">{durable ? "Saved in this browser as you work" : "This browser blocks storage: export proposals to keep them"}</div>
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      <span id="projects-row-help" className="sr-only">
        Enter to open, F2 to rename, Alt and arrow keys to reorder, Delete to remove
      </span>
    </aside>
  );
}

function NewProjectMenu() {
  return (
    <DropdownMenu>
      <Tooltip content="New project" side="bottom">
        <DropdownMenuTrigger asChild>
          <button aria-label="New project" data-testid="new-project" className="flex h-7 items-center gap-1 rounded-[6px] border border-line-2 bg-[#f8eed6]/80 px-2 text-[12px] font-medium text-ink shadow-[0_1px_1px_rgb(88_60_28/0.10)] outline-none hover:bg-paper-2 focus-visible:ring-2 focus-visible:ring-rose/25">
            <Plus size={13} strokeWidth={2} /> New
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Start from</DropdownMenuLabel>
        {TEMPLATES.map((t) => {
          const Icon = t.kind === "sandbox" ? SquareDashed : Building2;
          return (
            <DropdownMenuItem key={t.id} onSelect={() => void newProject(t.id)} className="h-auto items-start py-1.5 leading-normal" data-testid={`new-${t.id}`}>
              <Icon className="mt-0.5 text-rose" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t.menuLabel}</span>
                <span className="block text-[11px] leading-snug text-ink-4">{t.blurb}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface RowProps {
  p: ProjectMeta;
  index: number;
  count: number;
  current: boolean;
  opening: boolean;
  dragging: boolean;
  offset: number;
  animate: boolean;
  onDragStart: () => void;
  onDragMove: (dy: number) => void;
  onDragEnd: () => void;
  onMove: (to: number) => void;
  onFocusRow: (i: number) => void;
}

function ProjectRow({ p, index, count, current, opening, dragging, offset, animate, onDragStart, onDragMove, onDragEnd, onMove, onFocusRow }: RowProps) {
  const renaming = useProjects((s) => s.renamingId === p.id);
  const press = useRef<{ y: number; id: number; moved: boolean } | null>(null);
  const preset = presetOf(p.base);
  const rename = () => useProjects.setState({ renamingId: p.id });

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || renaming) return;
    press.current = { y: e.clientY, id: e.pointerId, moved: false };
  };
  const moveP = (e: RPointerEvent<HTMLDivElement>) => {
    const pr = press.current;
    if (!pr || pr.id !== e.pointerId) return;
    const dy = e.clientY - pr.y;
    if (!pr.moved && Math.abs(dy) > 4 && count > 1) {
      pr.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      onDragStart();
    }
    if (pr.moved) onDragMove(dy);
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    const pr = press.current;
    press.current = null;
    if (!pr) return;
    if (pr.moved) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      onDragEnd();
    } else if (e.detail <= 1) void openProject(p.id);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      onMove(index + (e.key === "ArrowUp" ? -1 : 1));
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      onFocusRow(Math.max(0, Math.min(count - 1, index + (e.key === "ArrowUp" ? -1 : 1))));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void openProject(p.id);
    } else if (e.key === "F2") {
      e.preventDefault();
      rename();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void askDeleteProject(p);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={renaming}>
        <div
          role="listitem"
          data-project-row
          data-project-id={p.id}
          data-current={current || undefined}
          tabIndex={0}
          aria-current={current ? "page" : undefined}
          aria-label={`${p.name}, ${preset?.badge ?? p.base}, edited ${relativeTime(p.updatedAt)}`}
          aria-describedby="projects-row-help"
          onPointerDown={down}
          onPointerMove={moveP}
          onPointerUp={up}
          onPointerCancel={() => press.current?.moved && onDragEnd()}
          onDoubleClick={rename}
          onKeyDown={key}
          className={cn(
            "group relative flex shrink-0 cursor-default items-center gap-2 rounded-[7px] border px-2.5 outline-none select-none focus-visible:ring-2 focus-visible:ring-rose/25",
            current ? "border-line-2 bg-[#f8eed6]/85 shadow-[0_1px_1px_rgb(88_60_28/0.10)]" : "border-transparent hover:bg-paper-3/60",
            dragging && "z-10 border-line-2 bg-[#f8eed6] shadow-[0_8px_18px_-8px_rgb(60_36_12/0.55)]",
          )}
          style={{ height: ROW, transform: offset ? `translateY(${offset}px)` : undefined, transition: animate && !dragging ? "transform 160ms cubic-bezier(.2,.7,.3,1)" : "none" }}
        >
          {current && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-rose" />}
          <div className="min-w-0 flex-1">
            {renaming ? (
              <RenameField p={p} />
            ) : (
              <div className={cn("truncate text-[12.5px] leading-tight", current ? "font-semibold text-ink" : "font-medium text-ink-2")}>{p.name}</div>
            )}
            <div className="mt-1 flex items-center gap-1.5 text-[10.5px] leading-none text-ink-4">
              <Badge variant={p.base === "sandbox" ? "outline" : "accent"} className="h-[15px] px-1 text-[9.5px]">
                {preset?.badge ?? p.base}
              </Badge>
              <span className="truncate">{opening ? "Opening…" : relativeTime(p.updatedAt)}</span>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {!current && (
          <ContextMenuItem onSelect={() => void openProject(p.id)}>
            <FolderOpen /> Open
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => setTimeout(rename, 0)}>
          <Pencil /> Rename <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void duplicateProject(p.id)}>
          <Copy /> Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="danger" onSelect={() => void askDeleteProject(p)}>
          <Trash2 /> Delete…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** the inline name editor: Enter or leaving the field keeps the name, Escape restores it */
function RenameField({ p }: { p: ProjectMeta }) {
  const [v, setV] = useState(p.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    if (keep) void renameProject(p.id, v);
    useProjects.setState((s) => (s.renamingId === p.id ? { renamingId: null } : {}));
  };
  return (
    <Input
      ref={ref}
      size="xs"
      value={v}
      maxLength={80}
      aria-label="Project name"
      data-testid="project-rename"
      className="-ml-1.5 h-[20px] text-[12.5px] font-medium"
      onChange={(e) => setV(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}
