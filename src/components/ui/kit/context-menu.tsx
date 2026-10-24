"use client";

import * as CM from "@radix-ui/react-context-menu";
import { Check, ChevronRight } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";
import { cn } from "./cn";
import { menuContent, menuIndicator, menuItem, menuItemDanger, menuLabel, menuSeparator, menuShortcut } from "./menu-styles";

export const ContextMenu = CM.Root;
export const ContextMenuTrigger = CM.Trigger;
export const ContextMenuGroup = CM.Group;
export const ContextMenuPortal = CM.Portal;
export const ContextMenuSub = CM.Sub;
export const ContextMenuRadioGroup = CM.RadioGroup;

export const ContextMenuContent = forwardRef<ElementRef<typeof CM.Content>, ComponentPropsWithoutRef<typeof CM.Content>>(function ContextMenuContent(
  { className, collisionPadding = 8, ...props },
  ref,
) {
  return (
    <CM.Portal>
      <CM.Content ref={ref} collisionPadding={collisionPadding} className={cn(menuContent, className)} {...props} />
    </CM.Portal>
  );
});

type ItemProps = ComponentPropsWithoutRef<typeof CM.Item> & { inset?: boolean; variant?: "default" | "danger" };
export const ContextMenuItem = forwardRef<ElementRef<typeof CM.Item>, ItemProps>(function ContextMenuItem({ className, inset, variant, ...props }, ref) {
  return <CM.Item ref={ref} className={cn(menuItem, inset && "pl-7", variant === "danger" && menuItemDanger, className)} {...props} />;
});

export const ContextMenuCheckboxItem = forwardRef<ElementRef<typeof CM.CheckboxItem>, ComponentPropsWithoutRef<typeof CM.CheckboxItem>>(
  function ContextMenuCheckboxItem({ className, children, ...props }, ref) {
    return (
      <CM.CheckboxItem ref={ref} className={cn(menuItem, "pl-7", className)} {...props}>
        <span className={menuIndicator}>
          <CM.ItemIndicator>
            <Check className="size-3.5 text-rose" strokeWidth={2.25} />
          </CM.ItemIndicator>
        </span>
        {children}
      </CM.CheckboxItem>
    );
  },
);

export const ContextMenuRadioItem = forwardRef<ElementRef<typeof CM.RadioItem>, ComponentPropsWithoutRef<typeof CM.RadioItem>>(function ContextMenuRadioItem(
  { className, children, ...props },
  ref,
) {
  return (
    <CM.RadioItem ref={ref} className={cn(menuItem, "pl-7", className)} {...props}>
      <span className={menuIndicator}>
        <CM.ItemIndicator>
          <span className="block size-1.5 rounded-full bg-rose" />
        </CM.ItemIndicator>
      </span>
      {children}
    </CM.RadioItem>
  );
});

export const ContextMenuLabel = forwardRef<ElementRef<typeof CM.Label>, ComponentPropsWithoutRef<typeof CM.Label> & { inset?: boolean }>(function ContextMenuLabel(
  { className, inset, ...props },
  ref,
) {
  return <CM.Label ref={ref} className={cn(menuLabel, inset && "pl-7", className)} {...props} />;
});

export const ContextMenuSeparator = forwardRef<ElementRef<typeof CM.Separator>, ComponentPropsWithoutRef<typeof CM.Separator>>(function ContextMenuSeparator(
  { className, ...props },
  ref,
) {
  return <CM.Separator ref={ref} className={cn(menuSeparator, className)} {...props} />;
});

export function ContextMenuShortcut({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn(menuShortcut, className)} {...props} />;
}

export const ContextMenuSubTrigger = forwardRef<ElementRef<typeof CM.SubTrigger>, ComponentPropsWithoutRef<typeof CM.SubTrigger> & { inset?: boolean }>(
  function ContextMenuSubTrigger({ className, inset, children, ...props }, ref) {
    return (
      <CM.SubTrigger ref={ref} className={cn(menuItem, "data-[state=open]:bg-paper-3", inset && "pl-7", className)} {...props}>
        {children}
        <ChevronRight className="ml-auto size-3.5 text-ink-4" />
      </CM.SubTrigger>
    );
  },
);

export const ContextMenuSubContent = forwardRef<ElementRef<typeof CM.SubContent>, ComponentPropsWithoutRef<typeof CM.SubContent>>(function ContextMenuSubContent(
  { className, sideOffset = 2, collisionPadding = 8, ...props },
  ref,
) {
  return (
    <CM.Portal>
      <CM.SubContent ref={ref} sideOffset={sideOffset} collisionPadding={collisionPadding} className={cn(menuContent, className)} {...props} />
    </CM.Portal>
  );
});
