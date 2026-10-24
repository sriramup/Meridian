import type { ReactNode } from "react";
import { cn } from "./cn";

/** A quiet centred placeholder for empty lists: an icon, one line, optional hint and action. */
export function EmptyState({ icon, title, hint, action, className }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1.5 px-4 py-8 text-center", className)}>
      {icon && <div className="mb-1 text-ink-4 [&_svg]:size-5">{icon}</div>}
      <div className="text-[12.5px] font-medium text-ink-2">{title}</div>
      {hint && <div className="max-w-[260px] text-[11.5px] leading-[1.45] text-ink-4">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
