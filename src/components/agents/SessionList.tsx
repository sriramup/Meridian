"use client";

import { Bot, Ellipsis, Pencil, Search, Square, SquarePen, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AgentSession } from "@/agent/types";
import { create } from "zustand";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Input, Kbd } from "@/components/ui/kit";
import { cx } from "../ui";
import { editCount, GROUP_LABEL, groupSessions, matchExcerpt, relTime, rgb, sessionColor, statusText } from "./model";
import { CloseButton, NewAgentButton, StatusIcon } from "./parts";
import { agents } from "./store";

let lastQuery = "";
/** the search field appears once there are enough agents to need it */
const SEARCH_FROM = 6;

/** re-render on a slow clock so relative times stay true */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function SessionList({ sessions, onNew, onClose }: { sessions: AgentSession[]; onNew: () => void; onClose: () => void }) {
  const [query, setQueryState] = useState(lastQuery);
  const setQuery = (q: string) => {
    lastQuery = q;
    setQueryState(q);
  };
  const [renaming, setRenaming] = useState<string | null>(null);
  const groups = useMemo(() => groupSessions(sessions, query), [sessions, query]);
  const now = useNow();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const running = sessions.filter((s) => s.status === "running").length;

  // ↑ / ↓ move between rows (and from the search field into the list)
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    if (e.key === "ArrowDown") rows[Math.min(rows.length - 1, i + 1)]?.focus();
    else if (i <= 0) search.current?.focus();
    else rows[i - 1]?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKey}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="font-display text-[19px] leading-none text-ink">Agents</h2>
        {running > 0 && <span className="text-[11.5px] text-ink-3">{running} running</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <NewAgentButton onNew={onNew} />
          <CloseButton onClose={onClose} />
        </div>
      </header>

      {(sessions.length >= SEARCH_FROM || query) && (
        <div className="shrink-0 px-3 pt-3 pb-1">
          <Input
            ref={search}
            size="md"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search agents"
            aria-label="Search agents"
            leading={<Search />}
            trailing={
              query ? (
                <button onClick={() => setQuery("")} className="grid size-4 place-items-center rounded-[3px] text-ink-4 hover:text-ink-2" aria-label="Clear search">
                  <X className="size-3" />
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      <div ref={list} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {sessions.length === 0 ? (
          <EmptyState
            className="pt-16"
            icon={<Bot strokeWidth={1.5} />}
            title="No agents yet"
            action={
              <Button size="sm" variant="primary" onClick={onNew}>
                <SquarePen strokeWidth={1.8} /> New agent
              </Button>
            }
          />
        ) : groups.length === 0 ? (
          <div className="px-2 py-8 text-center text-[12.5px] text-ink-4">No agents match “{query}”</div>
        ) : (
          groups.map((g) => (
            <section key={g.id} aria-label={GROUP_LABEL[g.id]} className="pt-2">
              <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1">
                <span className="font-legend text-[12px] leading-none text-ink-3">{GROUP_LABEL[g.id]}</span>
                <span className="tabular text-[11px] leading-none text-ink-4">{g.sessions.length}</span>
              </div>
              <ul>
                {g.sessions.map((s) => (
                  <li key={s.id}>
                    <Row session={s} now={now} query={query} renaming={renaming === s.id} setRenaming={(v) => setRenaming(v ? s.id : null)} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function Row({ session: s, now, query, renaming, setRenaming }: { session: AgentSession; now: number; query: string; renaming: boolean; setRenaming: (v: boolean) => void }) {
  const edits = editCount(s);
  const excerpt = query ? matchExcerpt(s, query) : null;
  const [menu, setMenu] = useState(false);
  const meta = [statusText(s), edits ? `${edits} edit${edits > 1 ? "s" : ""}` : null].filter(Boolean) as string[];
  if (renaming) return <RenameRow session={s} done={() => setRenaming(false)} />;
  return (
    <div className="group relative">
      <button
        data-row
        onClick={() => agents.view(s.id)}
        className="flex w-full flex-col gap-[3px] rounded-[6px] px-2 py-[7px] text-left outline-none hover:bg-paper-3/60 focus-visible:bg-paper-3/60 focus-visible:ring-2 focus-visible:ring-rose/35"
      >
        <span className="flex w-full items-center gap-2">
          <StatusIcon session={s} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{s.title}</span>
          <span className={cx("tabular shrink-0 text-[11px] text-ink-4 group-focus-within:invisible group-hover:invisible", menu && "invisible")}>{relTime(s.updatedAt, now)}</span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 pl-[22px] text-[11.5px] text-ink-3">
          {excerpt ? (
            <span className="truncate text-ink-3">
              <Highlight text={excerpt} term={query} />
            </span>
          ) : (
            <>
              <span className={cx("shrink-0", s.status === "needs_input" && "text-warn", s.status === "error" && "text-bad")}>{meta[0]}</span>
              {s.zone && (
                <>
                  <span aria-hidden className="text-ink-4">·</span>
                  <span className="size-2 shrink-0 rounded-[2px] border border-dashed" style={{ borderColor: rgb(sessionColor(s.id)), background: rgb(sessionColor(s.id), 0.2) }} />
                  <span className="min-w-0 truncate">{s.zone.label}</span>
                </>
              )}
              {meta.slice(1).map((m) => (
                <span key={m} className="flex shrink-0 items-center gap-1.5">
                  <span aria-hidden className="text-ink-4">·</span>
                  {m}
                </span>
              ))}
            </>
          )}
        </span>
      </button>
      <div className={cx("absolute top-[5px] right-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100", menu && "opacity-100")}>
        <SessionMenu session={s} open={menu} onOpenChange={setMenu} onRename={() => setRenaming(true)}>
          <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${s.title}`} className="hover:bg-paper-3">
            <Ellipsis />
          </Button>
        </SessionMenu>
      </div>
    </div>
  );
}

export function SessionMenu({ session: s, children, open, onOpenChange, onRename, align = "end" }: { session: AgentSession; children: React.ReactNode; open?: boolean; onOpenChange?: (o: boolean) => void; onRename: () => void; align?: "start" | "end" }) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[168px]" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem onSelect={() => setTimeout(onRename, 0)}>
          <Pencil /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem disabled={s.status !== "running" && s.status !== "needs_input"} onSelect={() => agents.stop(s.id)}>
          <Square /> Stop
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" onSelect={() => requestDelete(s)}>
          <Trash2 /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** the agent awaiting delete confirmation (an agent with no conversation is deleted straight away) */
const usePendingDelete = create<{ id: string | null }>(() => ({ id: null }));

function requestDelete(s: AgentSession) {
  if (!s.items.length) agents.deleteSession(s.id);
  else usePendingDelete.setState({ id: s.id });
}

/** confirms deleting an agent's conversation; mounted once by the pane */
export function DeleteAgentDialog({ sessions }: { sessions: AgentSession[] }) {
  const id = usePendingDelete((x) => x.id);
  const s = sessions.find((x) => x.id === id);
  const close = () => usePendingDelete.setState({ id: null });
  const edits = s ? editCount(s) : 0;
  return (
    <Dialog open={!!s} onOpenChange={(o) => !o && close()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete “{s?.title}”?</DialogTitle>
          <DialogDescription>
            {s?.status === "running" || s?.status === "needs_input" ? "It is still working and will be stopped. " : ""}
            Its conversation is removed.{edits === 1 ? " The edit it made stays in the plan; undo it from the scenario history if you don't want it." : edits > 1 ? ` The ${edits} edits it made stay in the plan; undo them from the scenario history if you don't want them.` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            autoFocus
            onClick={() => {
              if (s) agents.deleteSession(s.id);
              close();
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** inline title editor: Enter saves, Esc or leaving the field cancels / saves */
export function TitleInput({ session, done, className }: { session: AgentSession; done: () => void; className?: string }) {
  const [v, setV] = useState(session.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const save = () => {
    const t = v.trim();
    if (t && t !== session.title) agents.renameSession(session.id, t);
    done();
  };
  return (
    <Input
      ref={ref}
      size="sm"
      value={v}
      aria-label="Agent title"
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        else if (e.key === "Escape") {
          e.stopPropagation();
          done();
        }
      }}
      className={className}
    />
  );
}

function RenameRow({ session, done }: { session: AgentSession; done: () => void }) {
  return (
    <div className="flex items-center gap-2 px-2 py-[5px]">
      <StatusIcon session={session} />
      <TitleInput session={session} done={done} />
      <Kbd size="xs">↵</Kbd>
    </div>
  );
}

/** the search term marked in an excerpt (first term, case-insensitive) */
function Highlight({ text, term }: { text: string; term: string }) {
  const t = term.trim().split(/\s+/)[0];
  const i = t ? text.toLowerCase().indexOf(t.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[2px] bg-accent-2 px-px text-ink">{text.slice(i, i + t.length)}</mark>
      {text.slice(i + t.length)}
    </>
  );
}
