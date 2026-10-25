"use client";

// How to get around: the controls guide (the ? button, or "?"). Street level's only on-screen
// control is its exit (pedestrian/ExitStreetView); everything else is explained here.

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useApp } from "@/state/store";

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
              <Row k={<><Keys>P</Keys><Keys>footprints</Keys></>}>Step down into the street, and back up</Row>
              <Row k={<Keys>click</Keys>}>Walk to the spot under the cursor</Row>
              <Row k={<Keys>click arrow</Keys>}>Step along the street</Row>
              <Row k={<Keys>double-click</Keys>}>Jump straight to a spot</Row>
              <Row k={<Keys>drag</Keys>}>Look around</Row>
              <Row k={<><Keys>scroll</Keys><Keys>pinch</Keys></>}>Zoom the view in and out</Row>
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
              <Row k={<><Keys>/</Keys><Keys>⌘K</Keys></>}>Search for a place, street or address</Row>
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
