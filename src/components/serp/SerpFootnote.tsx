"use client";

// The agent pane's footnote: "Web & Maps search powered by SerpApi", with the search budget in its
// tooltip (this server's cap and use, and the account's remaining searches — read from SerpApi's
// account endpoint, which costs no search).

import { useEffect, useState } from "react";
import { Tooltip } from "@/components/ui/kit";
import { onCredits, serpStatus } from "@/serp/client";
import type { SerpCredits, SerpStatus } from "@/serp/types";

export function SerpFootnote() {
  const [status, setStatus] = useState<SerpStatus | null>(null);
  const [credits, setCredits] = useState<SerpCredits | null>(null);
  useEffect(() => {
    let live = true;
    serpStatus(true).then((s) => live && setStatus(s));
    const off = onCredits((c) => setCredits(c));
    return () => {
      live = false;
      off();
    };
  }, []);
  const c = credits ?? status?.credits;
  const lines: string[] = [];
  if (status && !status.configured) lines.push("Search is not configured on this server (SERPAPI_API_KEY).");
  else if (status?.fixtures) lines.push("Answering from recorded results (fixture mode): no searches are spent.");
  if (c) lines.push(c.cap === null ? `${c.used} searches used on this server` : `${c.used} of ${c.cap} searches used on this server · ${c.remaining} left`);
  if (status?.account?.searches_left != null) lines.push(`${status.account.searches_left.toLocaleString("en-US")} searches left on the SerpApi account`);
  lines.push(`Repeated searches are cached for ${status?.cache.ttl_days ?? 7} days and cost nothing.`);
  return (
    <div className="flex shrink-0 justify-center px-3 pb-2 -mt-1.5">
      <Tooltip
        side="top"
        content={
          <div className="max-w-[260px] space-y-0.5 text-left">
            {lines.map((l) => (
              <div key={l}>{l}</div>
            ))}
          </div>
        }
      >
        <a href="https://serpapi.com" target="_blank" rel="noreferrer" data-serp-footnote className="text-[10.5px] text-ink-4 transition-colors hover:text-ink-3">
          Web & Maps search powered by <span className="font-medium underline decoration-line-2 underline-offset-2">SerpApi</span>
          {c && c.remaining !== null && c.remaining < 20 ? <span className="text-warn"> · {c.remaining} left</span> : null}
        </a>
      </Tooltip>
    </div>
  );
}
