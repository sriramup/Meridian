"use client";

import { Command as Cmdk } from "cmdk";
import { Search } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Spinner } from "./spinner";

/**
 * cmdk, skinned. Filtering and ↑/↓/Enter/Home/End come from cmdk; `loop` wraps at the ends.
 * Give each CommandItem a `value` (and `keywords`) when its children are not plain text.
 */
export const Command = forwardRef<ElementRef<typeof Cmdk>, ComponentPropsWithoutRef<typeof Cmdk>>(function Command({ className, loop = true, ...props }, ref) {
  return <Cmdk ref={ref} loop={loop} className={cn("flex size-full flex-col overflow-hidden text-ink", className)} {...props} />;
});

export const CommandInput = forwardRef<
  ElementRef<typeof Cmdk.Input>,
  ComponentPropsWithoutRef<typeof Cmdk.Input> & { trailing?: ReactNode; loading?: boolean; wrapperClassName?: string }
>(function CommandInput({ className, trailing, loading, wrapperClassName, ...props }, ref) {
  return (
    <div className={cn("flex h-10 shrink-0 items-center gap-2 border-b border-line px-3", wrapperClassName)} cmdk-input-wrapper="">
      {loading ? <Spinner size={14} className="text-ink-4" /> : <Search className="size-[15px] shrink-0 text-ink-4" />}
      <Cmdk.Input
        ref={ref}
        className={cn("h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4 disabled:opacity-50", className)}
        {...props}
      />
      {trailing}
    </div>
  );
});

export const CommandList = forwardRef<ElementRef<typeof Cmdk.List>, ComponentPropsWithoutRef<typeof Cmdk.List>>(function CommandList({ className, ...props }, ref) {
  return <Cmdk.List ref={ref} className={cn("kit-scroll max-h-[340px] overflow-x-hidden overflow-y-auto overscroll-contain p-1 scroll-py-1", className)} {...props} />;
});

export const CommandEmpty = forwardRef<ElementRef<typeof Cmdk.Empty>, ComponentPropsWithoutRef<typeof Cmdk.Empty>>(function CommandEmpty({ className, ...props }, ref) {
  return <Cmdk.Empty ref={ref} className={cn("py-6 text-center text-[12.5px] text-ink-4", className)} {...props} />;
});

export const CommandLoading = Cmdk.Loading;

export const CommandGroup = forwardRef<ElementRef<typeof Cmdk.Group>, ComponentPropsWithoutRef<typeof Cmdk.Group>>(function CommandGroup({ className, ...props }, ref) {
  return (
    <Cmdk.Group
      ref={ref}
      className={cn(
        "overflow-hidden text-ink [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-legend [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:leading-none [&_[cmdk-group-heading]]:text-ink-3",
        className,
      )}
      {...props}
    />
  );
});

export const CommandSeparator = forwardRef<ElementRef<typeof Cmdk.Separator>, ComponentPropsWithoutRef<typeof Cmdk.Separator>>(function CommandSeparator(
  { className, ...props },
  ref,
) {
  return <Cmdk.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
});

export const CommandItem = forwardRef<ElementRef<typeof Cmdk.Item>, ComponentPropsWithoutRef<typeof Cmdk.Item>>(function CommandItem({ className, ...props }, ref) {
  return (
    <Cmdk.Item
      ref={ref}
      className={cn(
        "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-[5px] px-2 py-1 text-[12.5px] text-ink outline-none",
        "data-[selected=true]:bg-paper-3 data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg[width='24']:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-ink-3",
        className,
      )}
      {...props}
    />
  );
});

export function CommandShortcut({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("ml-auto pl-3 font-mono text-[10.5px] tracking-wide text-ink-4", className)} {...props} />;
}

/** A command palette in a dialog (⌘K style). */
export function CommandDialog({
  open,
  onOpenChange,
  title = "Command palette",
  description = "Search for a command to run",
  children,
  className,
  commandProps,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  commandProps?: ComponentPropsWithoutRef<typeof Cmdk>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose size="md" className={cn("top-[18%] translate-y-0 gap-0 overflow-hidden p-0", className)}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command {...commandProps}>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}
