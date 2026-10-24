"use client";

// The app's original small primitives, kept API-compatible as thin wrappers over the component kit
// (src/components/ui/kit). New code should import from "@/components/ui/kit" directly.
import clsx from "clsx";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Button as KitButton, Kbd as KitKbd, Segmented as KitSegmented, Tooltip } from "./ui/kit";

export const cx = clsx;

export function Tip({ label, kbd, side = "bottom", children }: { label: string; kbd?: string; side?: "top" | "bottom" | "left" | "right"; children: ReactNode }) {
  return (
    <Tooltip content={label} kbd={kbd} side={side}>
      {children}
    </Tooltip>
  );
}

type IBProps = ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; size?: "sm" | "md" };
export const IconButton = forwardRef<HTMLButtonElement, IBProps>(function IconButton({ active, size = "md", ...p }, ref) {
  return <KitButton ref={ref} variant="ghost" size={size === "md" ? "icon" : "icon-sm"} active={active} {...p} />;
});

type BProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "ghost" | "danger"; size?: "sm" | "md" };
export const Button = forwardRef<HTMLButtonElement, BProps>(function Button({ tone = "default", size = "md", ...p }, ref) {
  return <KitButton ref={ref} variant={tone} size={size} {...p} />;
});

export function Kbd({ children }: { children: ReactNode }) {
  return <KitKbd>{children}</KitKbd>;
}

export function Segmented<T extends string>({ value, onChange, options, size = "sm" }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; size?: "sm" | "xs" }) {
  return <KitSegmented value={value} onChange={onChange} options={options} size={size} />;
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
      <span className="font-legend text-[12.5px] leading-none text-ink-3">{children}</span>
      {right}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "neutral" }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10.5px] text-ink-4">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="tabular text-[14px] font-semibold text-ink">{value}</span>
        {sub && <span className={cx("tabular text-[11px]", tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-ink-3")}>{sub}</span>}
      </div>
    </div>
  );
}

export function Provenance({ kind }: { kind: string }) {
  const map: Record<string, [string, string]> = {
    measured: ["Measured", "bg-good-2 text-good"],
    mapped: ["Mapped", "bg-accent-2 text-rose"],
    derived: ["Derived", "bg-paper-3 text-ink-2"],
    estimated: ["Estimated", "bg-warn-2 text-warn"],
    proposed: ["Proposed", "bg-proposed-2 text-proposed"],
    modelled: ["Modelled", "bg-paper-3 text-ink-2"],
  };
  const [l, c] = map[kind] ?? [kind, "bg-paper-3 text-ink-2"];
  return <span className={cx("inline-flex h-[18px] items-center rounded-[4px] px-1.5 text-[10.5px] font-medium", c)}>{l}</span>;
}
