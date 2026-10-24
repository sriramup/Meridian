"use client";

import * as C from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn, focusRing } from "./cn";

export const Collapsible = C.Root;
export const CollapsibleTrigger = C.Trigger;

export const CollapsibleContent = forwardRef<ElementRef<typeof C.Content>, ComponentPropsWithoutRef<typeof C.Content>>(function CollapsibleContent(
  { className, ...props },
  ref,
) {
  return <C.Content ref={ref} className={cn("kit-collapse overflow-hidden", className)} {...props} />;
});

/** A full-width section header row with a rotating chevron, for use inside <Collapsible>. */
export const CollapsibleHeader = forwardRef<ElementRef<typeof C.Trigger>, ComponentPropsWithoutRef<typeof C.Trigger>>(function CollapsibleHeader(
  { className, children, ...props },
  ref,
) {
  return (
    <C.Trigger
      ref={ref}
      className={cn(
        "group flex h-7 w-full cursor-default select-none items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[12px] font-medium text-ink-2 hover:bg-paper-3/70 hover:text-ink",
        focusRing,
        className,
      )}
      {...props}
    >
      <ChevronRight className="size-3.5 shrink-0 text-ink-4 transition-transform duration-150 group-data-[state=open]:rotate-90" />
      {children}
    </C.Trigger>
  );
});
