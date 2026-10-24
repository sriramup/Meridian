import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * A labelled form row for inspectors and parameter panels: label on the left, control on the
 * right, one 28px rhythm. `layout="stacked"` puts the label above (for wide controls).
 */
export function Field({
  label,
  hint,
  htmlFor,
  layout = "inline",
  labelWidth = 84,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  layout?: "inline" | "stacked";
  labelWidth?: number;
  className?: string;
  children: ReactNode;
}) {
  const lab = (
    <label htmlFor={htmlFor} className="min-w-0 truncate text-[12px] leading-none text-ink-3">
      {label}
    </label>
  );
  if (layout === "stacked")
    return (
      <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
        {lab}
        {children}
        {hint && <div className="text-[11px] leading-[1.4] text-ink-4">{hint}</div>}
      </div>
    );
  return (
    <div className={cn("grid min-h-7 min-w-0 items-center gap-x-2 gap-y-1", className)} style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr)` }}>
      {lab}
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
      {hint && <div className="col-start-2 text-[11px] leading-[1.4] text-ink-4">{hint}</div>}
    </div>
  );
}
