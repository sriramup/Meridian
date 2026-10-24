import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export const badgeVariants = cva(
  "inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] px-1.5 text-[10.5px] font-medium leading-none [&_svg]:size-3",
  {
    variants: {
      variant: {
        neutral: "bg-paper-3 text-ink-2",
        accent: "bg-accent-2 text-rose",
        good: "bg-good-2 text-good",
        warn: "bg-warn-2 text-warn",
        bad: "bg-bad-2 text-bad",
        proposed: "bg-proposed-2 text-proposed",
        outline: "border border-line-2 text-ink-3",
        solid: "bg-accent text-on-accent",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { dot?: boolean };

export function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && <span className="size-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}
