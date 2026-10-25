import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class names; later Tailwind utilities win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** The one keyboard focus ring used by every control in the kit. */
export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-rose/45 focus-visible:ring-offset-1 focus-visible:ring-offset-paper";

/** Floating surfaces (menus, popovers, select lists, tooltips are separate): see .kit-surface in globals.css. */
export const surface = "kit-surface kit-pop z-50 text-ink";

/** Shared text-field chrome (Input, Textarea, Select trigger, NumberField). */
export const fieldBase =
  "rounded-[6px] border border-line-2 bg-field/70 text-ink shadow-[inset_0_1px_1px_rgb(88_60_28/0.08)] transition-[border-color,box-shadow,background-color] duration-100 placeholder:text-ink-4 hover:border-ink-4/70 focus-visible:border-rose/55 focus-visible:ring-2 focus-visible:ring-rose/20 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-bad/60 aria-invalid:ring-bad/20";

export const fieldSizes = {
  xs: "h-6 text-[11.5px]",
  sm: "h-7 text-[12px]",
  md: "h-8 text-[12.5px]",
} as const;
export type FieldSize = keyof typeof fieldSizes;

// Icons: the kit sizes lucide icons left at their default size (width="24") to fit each control;
// an icon given an explicit `size` prop or a `size-*` class keeps it.
