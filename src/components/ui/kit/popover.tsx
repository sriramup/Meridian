"use client";

import * as P from "@radix-ui/react-popover";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "./cn";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export const PopoverContent = forwardRef<ElementRef<typeof P.Content>, ComponentPropsWithoutRef<typeof P.Content>>(function PopoverContent(
  { className, align = "center", sideOffset = 6, collisionPadding = 8, ...props },
  ref,
) {
  return (
    <P.Portal>
      <P.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn("kit-surface kit-pop z-50 w-72 p-3 text-[12.5px] text-ink outline-none", className)}
        {...props}
      />
    </P.Portal>
  );
});
