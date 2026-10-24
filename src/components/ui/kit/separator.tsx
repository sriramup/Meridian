"use client";

import * as Sep from "@radix-ui/react-separator";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "./cn";

export const Separator = forwardRef<ElementRef<typeof Sep.Root>, ComponentPropsWithoutRef<typeof Sep.Root>>(function Separator(
  { className, orientation = "horizontal", decorative = true, ...props },
  ref,
) {
  return (
    <Sep.Root
      ref={ref}
      orientation={orientation}
      decorative={decorative}
      className={cn("shrink-0 bg-line-2/80", orientation === "horizontal" ? "h-px w-full" : "h-4 w-px self-center", className)}
      {...props}
    />
  );
});
