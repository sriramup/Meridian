"use client";

import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";
import { cn, focusRing } from "./cn";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export const DialogPortal = D.Portal;

export const DialogOverlay = forwardRef<ElementRef<typeof D.Overlay>, ComponentPropsWithoutRef<typeof D.Overlay>>(function DialogOverlay(
  { className, ...props },
  ref,
) {
  return <D.Overlay ref={ref} className={cn("kit-fade fixed inset-0 z-50 bg-scrim", className)} {...props} />;
});

const sizes = { sm: "max-w-[380px]", md: "max-w-[480px]", lg: "max-w-[640px]", xl: "max-w-[860px]" } as const;

export const DialogContent = forwardRef<
  ElementRef<typeof D.Content>,
  ComponentPropsWithoutRef<typeof D.Content> & { size?: keyof typeof sizes; hideClose?: boolean }
>(function DialogContent({ className, children, size = "md", hideClose, ...props }, ref) {
  return (
    <D.Portal>
      <DialogOverlay />
      <D.Content
        ref={ref}
        className={cn(
          "chrome kit-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-48px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto p-5 text-ink outline-none",
          sizes[size],
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <D.Close
            aria-label="Close"
            className={cn("absolute top-3 right-3 inline-flex size-7 items-center justify-center rounded-[6px] text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink", focusRing)}
          >
            <X className="size-4" />
          </D.Close>
        )}
      </D.Content>
    </D.Portal>
  );
});

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 pr-8", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-end gap-2 pt-1", className)} {...props} />;
}

export const DialogTitle = forwardRef<ElementRef<typeof D.Title>, ComponentPropsWithoutRef<typeof D.Title>>(function DialogTitle({ className, ...props }, ref) {
  return <D.Title ref={ref} className={cn("font-display text-[19px] leading-tight text-ink", className)} {...props} />;
});

export const DialogDescription = forwardRef<ElementRef<typeof D.Description>, ComponentPropsWithoutRef<typeof D.Description>>(function DialogDescription(
  { className, ...props },
  ref,
) {
  return <D.Description ref={ref} className={cn("text-[12.5px] leading-[1.5] text-ink-3", className)} {...props} />;
});
