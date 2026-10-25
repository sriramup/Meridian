"use client";

import * as Sw from "@radix-ui/react-switch";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn, focusRing } from "./cn";

export const Switch = forwardRef<ElementRef<typeof Sw.Root>, ComponentPropsWithoutRef<typeof Sw.Root> & { size?: "sm" | "md" }>(function Switch(
  { className, size = "md", ...props },
  ref,
) {
  return (
    <Sw.Root
      ref={ref}
      className={cn(
        "peer inline-flex shrink-0 cursor-default items-center rounded-full border border-line-2 bg-paper-3 p-px shadow-[inset_0_1px_2px_rgb(88_60_28/0.18)] transition-colors duration-150",
        "aria-checked:border-accent-edge aria-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-45",
        size === "md" ? "h-[18px] w-8" : "h-4 w-7",
        focusRing,
        className,
      )}
      {...props}
    >
      <Sw.Thumb
        className={cn(
          "pointer-events-none block rounded-full bg-knob shadow-[0_1px_2px_rgb(60_36_12/0.35)] ring-1 ring-accent-edge/40 transition-transform duration-150 data-[state=unchecked]:translate-x-0",
          size === "md" ? "size-3.5 data-[state=checked]:translate-x-[14px]" : "size-3 data-[state=checked]:translate-x-3",
        )}
      />
    </Sw.Root>
  );
});
