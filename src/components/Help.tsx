"use client";

// How to get around: the controls guide (the ? button, or "?"), a one-time hint for newcomers,
// and the walking controls while at street level.

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "@/state/store";
import { togglePedestrian } from "@/state/view";

const HINT_KEY = "meridian.nav-hint-seen";

function Keys({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 items-center rounded-[5px] border border-line-2 bg-paper-2 px-1.5 font-sans text-[10.5px] font-medium whitespace-nowrap text-ink-2 shadow-[0_1px_0_rgb(88_60_28/0.15)]">{children}</kbd>;
}

function Row({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-[12.5px]">
      <span className="text-ink-2">{children}</span>
      <span className="flex shrink-0 flex-wrap justify-end gap-1">{k}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="font-display text-[17px] text-ink">{title}</h3>
      <div className="mt-1 divide-y divide-line/70">{children}</div>
    </section>
  );
}

/** the full controls guide */
export function HelpDialog() {
  const open = useApp((s) => s.helpOpen);
  const setOpen = useApp((s) => s.setHelpOpen);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(70_48_24/0.22)]" />
        <Dialog.Content className="chrome fixed top-1/2 left-1/2 z-50 max-h-[86vh] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 scroll-thin">
          <div className="flex items-start justify-between">
            <div>
              <Dialog.Title className="font-display text-[24px] leading-none text-ink">Finding your way</Dialog.Title>
              <Dialog.Description className="mt-1.5 text-[12.5px] text-ink-3">Mouse, trackpad and keys. Every button also explains itself when you hover over it.</Dialog.Description>
            </div>
            <Dialog.Close className="grid h-7 w-7 place-items-center rounded-full text-ink-3 hover:bg-paper-3 hover:text-ink" aria-label="Close">
              <X size={15} />
            </Dialog.Close>
          </div>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <Section title="Moving around">
              <Row k={<Keys>drag</Keys>}>Move the map</Row>
              <Row k={<Keys>scroll</Keys>}>Zoom in and out</Row>
              <Row k={<><Keys>right-drag</Keys><Keys>⇧ drag</Keys></>}>Turn and tilt the view</Row>
              <Row k={<Keys>drag compass</Keys>}>Turn and tilt (top right)</Row>
              <Row k={<Keys>click compass</Keys>}>Face north, then flat or 3D</Row>
              <Row k={<><Keys>Q</Keys><Keys>E</Keys></>}>Turn left or right</Row>
              <Row k={<><Keys>⇧↑</Keys><Keys>⇧↓</Keys></>}>Tilt up or down</Row>
            </Section>
            <Section title="At street level">
              <Row k={<Keys>P</Keys>}>Step down into the street, and back up</Row>
              <Row k={<Keys>drag</Keys>}>Look around</Row>
              <Row k={<><Keys>W A S D</Keys><Keys>arrows</Keys></>}>Walk</Row>
              <Row k={<Keys>⇧</Keys>}>Hold to run</Row>
              <Row k={<Keys>scroll</Keys>}>Step forward or back</Row>
              <Row k={<Keys>Esc</Keys>}>Back up above the street</Row>
            </Section>
            <Section title="Making things">
              <Row k={<><Keys>L</Keys><Keys>B</Keys><Keys>A</Keys><Keys>T</Keys></>}>Library: everything you can place (B buildings, A parks, T trees)</Row>
              <Row k={<><Keys>click</Keys><Keys>drag</Keys></>}>Place it; drag to aim it, or drag out a rectangle</Row>
              <Row k={<><Keys>[</Keys><Keys>]</Keys></>}>Turn what you are placing</Row>
              <Row k={<Keys>Space</Keys>}>Hold to pan while placing</Row>
              <Row k={<Keys>G</Keys>}>Pick up the selected item and move it</Row>
              <Row k={<><Keys>Enter</Keys><Keys>click last point</Keys></>}>Finish a shape</Row>
              <Row k={<Keys>Esc</Keys>}>Cancel, or put the tool down</Row>
              <Row k={<Keys>Delete</Keys>}>Remove what is selected</Row>
              <Row k={<><Keys>⌘Z</Keys><Keys>⇧⌘Z</Keys></>}>Undo and redo</Row>
            </Section>
            <Section title="Finding things">
              <Row k={<><Keys>/</Keys><Keys>⌘K</Keys></>}>Search for a tool or an action</Row>
              <Row k={<Keys>⌘J</Keys>}>Ask the agent</Row>
              <Row k={<Keys>N</Keys>}>Day or night</Row>
              <Row k={<Keys>?</Keys>}>This guide</Row>
            </Section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** a line of hints along the bottom: once for newcomers in the map view, always while walking */
export function NavHint() {
  const cam = useApp((s) => s.cameraMode);
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    try {
      setSeen(localStorage.getItem(HINT_KEY) === "1");
    } catch {
      setSeen(false);
    }
  }, []);
  const dismiss = () => {
    setSeen(true);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* private window: the hint simply shows again next time */
    }
  };
  const walking = cam === "pedestrian";
  if (!walking && seen) return null;
  const hints = walking ? [["drag", "look around"], ["W A S D", "walk"], ["⇧", "run"], ["scroll", "step"]] : [["drag", "move"], ["right-drag", "turn & tilt"], ["scroll", "zoom"]];
  return (
    <div className="chrome pointer-events-auto flex items-center gap-3 rounded-full py-1 pr-1.5 pl-3.5 text-[11.5px] text-ink-2">
      {hints.map(([k, v]) => (
        <span key={k} className="flex items-center gap-1.5 whitespace-nowrap">
          <Keys>{k}</Keys>
          {v}
        </span>
      ))}
      {walking ? (
        <button onClick={togglePedestrian} className="rounded-full bg-accent px-2.5 py-0.5 font-medium text-on-accent hover:brightness-105">
          Back up <span className="opacity-60">Esc</span>
        </button>
      ) : (
        <>
          <button onClick={() => useApp.getState().setHelpOpen(true)} className="rounded-full px-2 py-0.5 font-medium text-rose hover:bg-accent-2">
            All controls <span className="opacity-60">?</span>
          </button>
          <button onClick={dismiss} className="grid h-5 w-5 place-items-center rounded-full text-ink-4 hover:bg-paper-3 hover:text-ink" aria-label="Dismiss" title="Got it">
            <X size={12} />
          </button>
        </>
      )}
    </div>
  );
}
