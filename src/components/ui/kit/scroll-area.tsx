"use client";

import * as SA from "@radix-ui/react-scroll-area";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type Ref } from "react";
import { cn } from "./cn";

/**
 * Overlay scrollbars that appear on hover/scroll. Give the ScrollArea a bounded height (h-…, max-h-…
 * or a flex parent with min-h-0). `viewportRef` reaches the scrolling element (e.g. stick to bottom).
 */
export const ScrollArea = forwardRef<
  ElementRef<typeof SA.Root>,
  ComponentPropsWithoutRef<typeof SA.Root> & {
    viewportRef?: Ref<HTMLDivElement>;
    viewportClassName?: string;
    orientation?: "vertical" | "horizontal" | "both";
  }
>(function ScrollArea({ className, children, viewportRef, viewportClassName, orientation = "vertical", type = "hover", ...props }, ref) {
  return (
    <SA.Root ref={ref} type={type} className={cn("relative overflow-hidden", className)} {...props}>
      <SA.Viewport ref={viewportRef} className={cn("size-full rounded-[inherit]", orientation === "vertical" && "[&>div]:block!", viewportClassName)} style={{ maxHeight: "inherit" }}>
        {children}
      </SA.Viewport>
      {orientation !== "horizontal" && <ScrollBar orientation="vertical" />}
      {orientation !== "vertical" && <ScrollBar orientation="horizontal" />}
      <SA.Corner />
    </SA.Root>
  );
});

export const ScrollBar = forwardRef<ElementRef<typeof SA.Scrollbar>, ComponentPropsWithoutRef<typeof SA.Scrollbar>>(function ScrollBar(
  { className, orientation = "vertical", ...props },
  ref,
) {
  return (
    <SA.Scrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        "z-10 flex touch-none select-none p-[2px] transition-opacity duration-150 data-[state=hidden]:opacity-0",
        orientation === "vertical" ? "h-full w-[9px]" : "h-[9px] flex-col",
        className,
      )}
      {...props}
    >
      <SA.Thumb className="relative flex-1 rounded-full bg-[#9c7a48]/45 transition-colors hover:bg-[#9c7a48]/70" />
    </SA.Scrollbar>
  );
});
