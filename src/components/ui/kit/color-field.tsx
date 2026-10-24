"use client";

import { Check, Pipette } from "lucide-react";
import { useEffect, useState } from "react";
import { cn, fieldBase, fieldSizes, focusRing, type FieldSize } from "./cn";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/** Map-friendly default swatches: atlas inks and washes plus clear planning colours. */
export const DEFAULT_SWATCHES = [
  "#2e1c0e", "#77583a", "#9a7d5c", "#bf9f6c", "#d9c39b", "#f3e5c6",
  "#8a3d1c", "#9e3b2c", "#c4572f", "#cfa56a", "#a97c37", "#e3b448",
  "#56774a", "#7f9c5a", "#c6d3b0", "#3f6f73", "#6c8fa8", "#b3c9cf",
  "#5c4a7a", "#8d6f9f", "#cdbfd6", "#4a4a4a", "#8a8a8a", "#ffffff",
];

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Normalise "#abc", "abc", "#AABBCC" to "#aabbcc"; null when not a hex colour. */
export function normalizeHex(s: string): string | null {
  const m = HEX.exec(s.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return `#${h}`;
}

export type ColorFieldProps = {
  value: string;
  onChange: (hex: string) => void;
  swatches?: readonly string[];
  size?: FieldSize;
  /** Show the hex text next to the swatch in the trigger (default true). */
  showHex?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  align?: "start" | "center" | "end";
};

/** A colour picker: trigger with swatch + hex, popover with swatches, a hex input and the system picker. */
export function ColorField({ value, onChange, swatches = DEFAULT_SWATCHES, size = "sm", showHex = true, disabled, className, "aria-label": ariaLabel = "Colour", align = "start" }: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value.replace("#", ""));
  useEffect(() => setText(value.replace("#", "")), [value, open]);
  const current = normalizeHex(value);
  const commit = () => {
    const h = normalizeHex(text);
    if (h) onChange(h);
    else setText(value.replace("#", ""));
  };
  const chip = size === "xs" ? "size-3.5" : "size-4";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`${ariaLabel}: ${value}`}
        className={cn(
          fieldBase,
          fieldSizes[size],
          "inline-flex cursor-default items-center gap-1.5 data-[state=open]:border-rose/55",
          showHex ? (size === "xs" ? "pr-2 pl-1" : "pr-2.5 pl-1.5") : "justify-center px-0 " + (size === "xs" ? "w-6" : size === "sm" ? "w-7" : "w-8"),
          className,
        )}
      >
        <span className={cn(chip, "shrink-0 rounded-[3px] ring-1 ring-[#2e1c0e]/20 ring-inset")} style={{ background: value }} />
        {showHex && <span className="tabular font-mono text-[11px] leading-none text-ink-2 uppercase">{value.replace("#", "")}</span>}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[212px] p-2.5">
        <div className="grid grid-cols-6 gap-1.5" role="listbox" aria-label="Swatches">
          {swatches.map((c) => {
            const on = current === normalizeHex(c);
            return (
              <button
                key={c}
                type="button"
                role="option"
                aria-selected={on}
                aria-label={c}
                title={c}
                onClick={() => onChange(normalizeHex(c) ?? c)}
                className={cn(
                  "relative flex size-[26px] cursor-default items-center justify-center rounded-[4px] ring-1 ring-[#2e1c0e]/15 ring-inset transition-transform duration-100 hover:scale-110",
                  on && "ring-2 ring-rose ring-offset-1 ring-offset-paper",
                  focusRing,
                )}
                style={{ background: c }}
              >
                {on && <Check className="size-3.5" strokeWidth={3} style={{ color: luminance(c) > 0.55 ? "#2e1c0e" : "#fbf3e1" }} />}
              </button>
            );
          })}
        </div>
        <div className="mt-2.5 flex items-center gap-1.5">
          <div className={cn(fieldBase, fieldSizes.sm, "flex min-w-0 flex-1 items-center gap-1 px-2 has-[input:focus-visible]:border-rose/55 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-rose/20")}>
            <span className="font-mono text-[11px] text-ink-4">#</span>
            <input
              aria-label="Hex colour"
              value={text}
              maxLength={7}
              spellCheck={false}
              onChange={(e) => {
                setText(e.target.value.replace("#", ""));
                const h = normalizeHex(e.target.value);
                if (h && e.target.value.replace("#", "").length === 6) onChange(h);
              }}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commit();
                  setOpen(false);
                }
              }}
              className="h-full w-full min-w-0 bg-transparent font-mono text-[11.5px] uppercase outline-none"
            />
          </div>
          <label
            title="Pick any colour"
            className={cn("relative flex size-7 shrink-0 cursor-default items-center justify-center rounded-[6px] border border-line-2 text-ink-3 hover:bg-paper-3 hover:text-ink has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-rose/40")}
          >
            <Pipette className="size-3.5" />
            <input type="color" aria-label="System colour picker" value={current ?? "#000000"} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-default opacity-0" />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function luminance(hex: string) {
  const h = normalizeHex(hex);
  if (!h) return 0;
  const n = parseInt(h.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
