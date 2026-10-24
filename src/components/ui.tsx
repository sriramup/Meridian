"use client";

import * as Tooltip from "@radix-ui/react-tooltip";
import clsx from "clsx";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export const cx = clsx;

export function Tip({ label, kbd, side = "bottom", children }: { label: string; kbd?: string; side?: "top" | "bottom" | "left" | "right"; children: ReactNode }) {
  return (
    <Tooltip.Root delayDuration={350}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} sideOffset={6} className="z-50 flex items-center gap-2 rounded-[5px] border border-line-2 bg-paper-3 px-2 py-1 text-[11.5px] text-ink shadow-lg select-none">
          {label}
          {kbd && <kbd className="rounded bg-ink/10 px-1 font-mono text-[10.5px] text-ink-3">{kbd}</kbd>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

type IBProps = ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; size?: "sm" | "md" };
export const IconButton = forwardRef<HTMLButtonElement, IBProps>(function IconButton({ active, size = "md", className, ...p }, ref) {
  return (
    <button
      ref={ref}
      {...p}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-[6px] text-ink-2 transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-35",
        size === "md" ? "h-8 w-8" : "h-7 w-7",
        active ? "bg-accent text-on-accent hover:bg-accent" : "hover:bg-paper-3 active:bg-line",
        className,
      )}
    />
  );
});

type BProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "ghost" | "danger"; size?: "sm" | "md" };
export const Button = forwardRef<HTMLButtonElement, BProps>(function Button({ tone = "default", size = "md", className, ...p }, ref) {
  return (
    <button
      ref={ref}
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-[6px] font-medium transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-40",
        size === "md" ? "h-8 px-3 text-[12.5px]" : "h-7 px-2.5 text-[12px]",
        tone === "primary" && "bg-accent text-on-accent hover:brightness-110",
        tone === "default" && "border border-line-2 bg-paper text-ink hover:bg-paper-2",
        tone === "ghost" && "text-ink-2 hover:bg-paper-3",
        tone === "danger" && "border border-bad/30 bg-bad-2 text-bad hover:bg-bad/10",
        className,
      )}
    />
  );
});

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line-2 bg-paper px-1 font-mono text-[10.5px] text-ink-3">{children}</kbd>;
}

export function Segmented<T extends string>({ value, onChange, options, size = "sm" }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; size?: "sm" | "xs" }) {
  return (
    <div className="inline-flex rounded-[6px] border border-line bg-paper-2 p-[2px]">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-[4px] font-medium transition-colors",
            size === "sm" ? "h-6 px-2 text-[11.5px]" : "h-5 px-1.5 text-[11px]",
            value === o.value ? "bg-paper-3 text-rose shadow-[0_1px_2px_rgb(88_60_28/0.22)]" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
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
