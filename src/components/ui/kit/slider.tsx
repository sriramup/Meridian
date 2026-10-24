"use client";

import * as Sl from "@radix-ui/react-slider";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "./cn";

/** Radix slider: one thumb per value (pass [v] or [lo, hi]). `thumbLabels` names each thumb for screen readers. */
export const Slider = forwardRef<
  ElementRef<typeof Sl.Root>,
  ComponentPropsWithoutRef<typeof Sl.Root> & { size?: "sm" | "md"; thumbLabels?: string[] }
>(function Slider({ className, size = "md", value, defaultValue, thumbLabels, min = 0, max = 100, ...props }, ref) {
  const count = (value ?? defaultValue ?? [min]).length;
  return (
    <Sl.Root
      ref={ref}
      min={min}
      max={max}
      value={value}
      defaultValue={defaultValue}
      className={cn(
        "relative flex w-full touch-none select-none items-center data-[disabled]:opacity-45 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        size === "md" ? "h-5" : "h-4",
        className,
      )}
      {...props}
    >
      <Sl.Track className="relative h-[4px] w-full grow overflow-hidden rounded-full bg-line shadow-[inset_0_1px_1px_rgb(88_60_28/0.18)] data-[orientation=vertical]:h-full data-[orientation=vertical]:w-[4px]">
        <Sl.Range className="absolute h-full bg-[#b88c50] data-[orientation=vertical]:w-full" />
      </Sl.Track>
      {Array.from({ length: count }, (_, i) => (
        <Sl.Thumb
          key={i}
          aria-label={thumbLabels?.[i]}
          className={cn(
            "block cursor-grab rounded-full border border-[#9c7a48] bg-[#fbf3e1] shadow-[0_1px_2px_rgb(60_36_12/0.35)] transition-[box-shadow] duration-100 outline-none hover:ring-4 hover:ring-accent/30 focus-visible:ring-4 focus-visible:ring-rose/30 active:cursor-grabbing data-[disabled]:pointer-events-none",
            size === "md" ? "size-3.5" : "size-3",
          )}
        />
      ))}
    </Sl.Root>
  );
});
