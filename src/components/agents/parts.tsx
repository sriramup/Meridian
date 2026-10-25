"use client";

import { CircleAlert, CircleCheck, CircleDashed, CircleX, PanelRightClose, SquarePen } from "lucide-react";
import type { AgentSession } from "@/agent/types";
import { Button, Spinner, Tooltip } from "@/components/ui/kit";
import { cx } from "../ui";
import { statusText } from "./model";

/** a session's state as a static glyph (a steady spinner while it runs; nothing blinks) */
export function StatusIcon({ session, size = 14, className }: { session: Pick<AgentSession, "status" | "items">; size?: number; className?: string }) {
  const label = statusText(session);
  const c = cx("shrink-0", className);
  if (session.status === "running") return <Spinner size={size} label={label} className={cx(c, "text-rose")} />;
  if (session.status === "needs_input") return <CircleAlert size={size} strokeWidth={2} aria-label={label} className={cx(c, "text-warn")} />;
  if (session.status === "error") return <CircleX size={size} strokeWidth={2} aria-label={label} className={cx(c, "text-bad")} />;
  if (label === "New") return <CircleDashed size={size} strokeWidth={1.8} aria-label={label} className={cx(c, "text-ink-4")} />;
  return <CircleCheck size={size} strokeWidth={1.8} aria-label={label} className={cx(c, "text-ink-4")} />;
}

export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Tooltip content="Hide agents" kbd="⌘J">
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Hide agents">
        <PanelRightClose strokeWidth={1.7} />
      </Button>
    </Tooltip>
  );
}

export function NewAgentButton({ onNew }: { onNew: () => void }) {
  return (
    <Tooltip content="New agent" kbd="C">
      <Button variant="ghost" size="icon-sm" onClick={onNew} aria-label="New agent">
        <SquarePen strokeWidth={1.7} />
      </Button>
    </Tooltip>
  );
}
