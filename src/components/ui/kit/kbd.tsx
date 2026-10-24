import type { HTMLAttributes } from "react";
import { cn } from "./cn";

/** A key cap. `size="xs"` fits inside tooltips and menu rows. */
export function Kbd({ className, size = "sm", ...props }: HTMLAttributes<HTMLElement> & { size?: "xs" | "sm" }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-[4px] border border-line-2 bg-[#f8eed6] font-mono font-medium leading-none text-ink-3 shadow-[0_1px_0_rgb(156_122_72/0.45)]",
        size === "sm" ? "h-[18px] min-w-[18px] px-1 text-[10.5px]" : "h-4 min-w-4 px-[3px] text-[10px]",
        className,
      )}
      {...props}
    />
  );
}

/** Several keys: `<KbdGroup keys={["⌘", "K"]} />`, or a string like "⌘K" / "Shift+Enter". */
export function KbdGroup({ keys, size, className }: { keys: string | string[]; size?: "xs" | "sm"; className?: string }) {
  const list = Array.isArray(keys) ? keys : splitKeys(keys);
  return (
    <span className={cn("inline-flex items-center gap-[3px]", className)}>
      {list.map((k, i) => (
        <Kbd key={i} size={size}>
          {k}
        </Kbd>
      ))}
    </span>
  );
}

function splitKeys(s: string): string[] {
  if (s.includes("+")) return s.split("+").map((k) => k.trim()).filter(Boolean);
  // modifier glyphs are separate caps: "⇧⌘Z" → ⇧ ⌘ Z
  const out: string[] = [];
  let rest = "";
  for (const ch of s) {
    if ("⌘⇧⌥⌃".includes(ch)) out.push(ch);
    else rest += ch;
  }
  if (rest) out.push(rest);
  return out;
}
