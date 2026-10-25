"use client";

// The agent composer's "Search" toggle: while on, the session's runs are told to ground their answers
// with live Google / Google Maps search (SerpApi) and cite sources (src/serp/store.ts searchNote).

import { Globe } from "lucide-react";
import { Button, Tooltip } from "@/components/ui/kit";
import { setSearchOn, useSerp } from "@/serp/store";
import { cx } from "../ui";

export function SearchToggle({ sessionKey, disabled }: { sessionKey: string; disabled?: boolean }) {
  const on = useSerp((s) => !!s.searchOn[sessionKey]);
  return (
    <Tooltip content={on ? "Search on: the agent grounds its answer in live Google & Maps results, with sources" : "Ground answers in live Google & Google Maps search (SerpApi)"} side="top">
      <Button
        variant="ghost"
        size="xs"
        disabled={disabled}
        aria-pressed={on}
        aria-label="Search the web and maps"
        onClick={() => setSearchOn(sessionKey, !on)}
        className={cx("gap-1 px-1.5", on ? "border-rose/30 bg-accent-2 text-rose hover:bg-accent-2 hover:text-rose" : "text-ink-3")}
      >
        <Globe className={cx("size-3.5", on && "text-rose")} strokeWidth={on ? 2.1 : 1.8} />
        <span>Search</span>
      </Button>
    </Tooltip>
  );
}
