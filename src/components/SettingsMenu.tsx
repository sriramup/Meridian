"use client";

// Settings (the gear beside the view controls): the interface theme, for now.

import { Check, Settings } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, cn } from "./ui/kit";
import { IconButton, Tip } from "./ui";
import { setTheme, THEMES, useTheme, type ThemeId } from "@/state/theme";

/** a miniature of each theme: a panel with a title bar, two lines of text and an accent pill */
const PREVIEW: Record<ThemeId, { bg: string; panel: string; line: string; ink: string; accent: string }> = {
  cartography: { bg: "#e6cfa2", panel: "#f4e6c7", line: "#bf9f6c", ink: "#4c331d", accent: "#cfa56a" },
  dark: { bg: "#0f0f11", panel: "#1f1f23", line: "#3a3a42", ink: "#c8c8ce", accent: "#4a7dff" },
};

function Swatch({ id }: { id: ThemeId }) {
  const c = PREVIEW[id];
  return (
    <svg viewBox="0 0 96 60" className="block h-auto w-full rounded-[6px]" aria-hidden>
      <rect width="96" height="60" fill={c.bg} />
      <rect x="8" y="8" width="56" height="44" rx="4" fill={c.panel} stroke={c.line} />
      <rect x="14" y="15" width="28" height="4" rx="2" fill={c.ink} />
      <rect x="14" y="25" width="42" height="3" rx="1.5" fill={c.ink} opacity="0.45" />
      <rect x="14" y="32" width="36" height="3" rx="1.5" fill={c.ink} opacity="0.45" />
      <rect x="14" y="41" width="18" height="6" rx="3" fill={c.accent} />
      <rect x="70" y="8" width="18" height="18" rx="4" fill={c.panel} stroke={c.line} />
    </svg>
  );
}

export function SettingsMenu() {
  const theme = useTheme((s) => s.theme);
  return (
    <Popover>
      <Tip label="Settings">
        <PopoverTrigger asChild>
          <IconButton size="sm" aria-label="Settings" data-testid="settings">
            <Settings size={15} strokeWidth={1.7} />
          </IconButton>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-[300px] p-3">
        <div className="font-legend text-[12px] leading-none text-ink-3">Theme</div>
        <div role="radiogroup" aria-label="Theme" className="mt-2.5 grid grid-cols-2 gap-2">
          {THEMES.map((t) => {
            const on = theme === t.id;
            return (
              <button
                key={t.id}
                role="radio"
                aria-checked={on}
                data-testid={`theme-${t.id}`}
                onClick={() => setTheme(t.id)}
                className={cn(
                  "group flex flex-col gap-1.5 rounded-[8px] border p-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-rose/40",
                  on ? "border-accent bg-accent-2/60" : "border-line hover:border-line-2 hover:bg-paper-3/50",
                )}
              >
                <Swatch id={t.id} />
                <span className="flex items-center justify-between gap-1 px-0.5">
                  <span className="text-[12px] font-medium text-ink">{t.name}</span>
                  {on && <Check size={13} strokeWidth={2.4} className="text-rose" />}
                </span>
                <span className="px-0.5 text-[10.5px] leading-snug text-ink-4">{t.blurb}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
