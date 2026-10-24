"use client";

import * as T from "@radix-ui/react-tooltip";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import { cn } from "./cn";
import { Kbd } from "./kbd";

/** The app root mounts one provider (Shell); mount another only for a separate React root. */
export const TooltipProvider = T.Provider;
export const TooltipRoot = T.Root;
export const TooltipTrigger = T.Trigger;

export const TooltipContent = forwardRef<ElementRef<typeof T.Content>, ComponentPropsWithoutRef<typeof T.Content>>(function TooltipContent(
  { className, sideOffset = 6, collisionPadding = 6, ...props },
  ref,
) {
  return (
    <T.Portal>
      <T.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "kit-tip kit-pop z-[60] flex max-w-[280px] select-none items-center gap-2 rounded-[5px] px-2 py-[5px] text-[11.5px] leading-[1.3] font-medium",
          className,
        )}
        {...props}
      />
    </T.Portal>
  );
});

export type TooltipProps = {
  /** Tooltip text; omit (or pass empty) to render the trigger without a tooltip. */
  content: ReactNode;
  /** A keyboard shortcut shown at the right, e.g. "⌘K". */
  kbd?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  delayDuration?: number;
  /** The trigger: a single element that accepts a ref (Button, IconButton, …). */
  children: ReactNode;
  className?: string;
};

export function Tooltip({ content, kbd, side = "bottom", align, delayDuration = 350, children, className }: TooltipProps) {
  if (content == null || content === "") return <>{children}</>;
  return (
    <T.Root delayDuration={delayDuration}>
      <T.Trigger asChild>{children}</T.Trigger>
      <TooltipContent side={side} align={align} className={className}>
        <span>{content}</span>
        {kbd && (
          <Kbd size="xs" className="-mr-0.5">
            {kbd}
          </Kbd>
        )}
      </TooltipContent>
    </T.Root>
  );
}
