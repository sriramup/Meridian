"use client";

import * as DM from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";
import { cn } from "./cn";
import { menuContent, menuIndicator, menuItem, menuItemDanger, menuLabel, menuSeparator, menuShortcut } from "./menu-styles";

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export const DropdownMenuGroup = DM.Group;
export const DropdownMenuPortal = DM.Portal;
export const DropdownMenuSub = DM.Sub;
export const DropdownMenuRadioGroup = DM.RadioGroup;

export const DropdownMenuContent = forwardRef<ElementRef<typeof DM.Content>, ComponentPropsWithoutRef<typeof DM.Content>>(function DropdownMenuContent(
  { className, sideOffset = 6, collisionPadding = 8, ...props },
  ref,
) {
  return (
    <DM.Portal>
      <DM.Content ref={ref} sideOffset={sideOffset} collisionPadding={collisionPadding} className={cn(menuContent, className)} {...props} />
    </DM.Portal>
  );
});

type ItemProps = ComponentPropsWithoutRef<typeof DM.Item> & { inset?: boolean; variant?: "default" | "danger" };
export const DropdownMenuItem = forwardRef<ElementRef<typeof DM.Item>, ItemProps>(function DropdownMenuItem({ className, inset, variant, ...props }, ref) {
  return <DM.Item ref={ref} className={cn(menuItem, inset && "pl-7", variant === "danger" && menuItemDanger, className)} {...props} />;
});

export const DropdownMenuCheckboxItem = forwardRef<ElementRef<typeof DM.CheckboxItem>, ComponentPropsWithoutRef<typeof DM.CheckboxItem>>(
  function DropdownMenuCheckboxItem({ className, children, ...props }, ref) {
    return (
      <DM.CheckboxItem ref={ref} className={cn(menuItem, "pl-7", className)} {...props}>
        <span className={menuIndicator}>
          <DM.ItemIndicator>
            <Check className="size-3.5 text-rose" strokeWidth={2.25} />
          </DM.ItemIndicator>
        </span>
        {children}
      </DM.CheckboxItem>
    );
  },
);

export const DropdownMenuRadioItem = forwardRef<ElementRef<typeof DM.RadioItem>, ComponentPropsWithoutRef<typeof DM.RadioItem>>(function DropdownMenuRadioItem(
  { className, children, ...props },
  ref,
) {
  return (
    <DM.RadioItem ref={ref} className={cn(menuItem, "pl-7", className)} {...props}>
      <span className={menuIndicator}>
        <DM.ItemIndicator>
          <span className="block size-1.5 rounded-full bg-rose" />
        </DM.ItemIndicator>
      </span>
      {children}
    </DM.RadioItem>
  );
});

export const DropdownMenuLabel = forwardRef<ElementRef<typeof DM.Label>, ComponentPropsWithoutRef<typeof DM.Label> & { inset?: boolean }>(function DropdownMenuLabel(
  { className, inset, ...props },
  ref,
) {
  return <DM.Label ref={ref} className={cn(menuLabel, inset && "pl-7", className)} {...props} />;
});

export const DropdownMenuSeparator = forwardRef<ElementRef<typeof DM.Separator>, ComponentPropsWithoutRef<typeof DM.Separator>>(function DropdownMenuSeparator(
  { className, ...props },
  ref,
) {
  return <DM.Separator ref={ref} className={cn(menuSeparator, className)} {...props} />;
});

export function DropdownMenuShortcut({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn(menuShortcut, className)} {...props} />;
}

export const DropdownMenuSubTrigger = forwardRef<ElementRef<typeof DM.SubTrigger>, ComponentPropsWithoutRef<typeof DM.SubTrigger> & { inset?: boolean }>(
  function DropdownMenuSubTrigger({ className, inset, children, ...props }, ref) {
    return (
      <DM.SubTrigger ref={ref} className={cn(menuItem, "data-[state=open]:bg-paper-3", inset && "pl-7", className)} {...props}>
        {children}
        <ChevronRight className="ml-auto size-3.5 text-ink-4" />
      </DM.SubTrigger>
    );
  },
);

export const DropdownMenuSubContent = forwardRef<ElementRef<typeof DM.SubContent>, ComponentPropsWithoutRef<typeof DM.SubContent>>(function DropdownMenuSubContent(
  { className, sideOffset = 4, collisionPadding = 8, ...props },
  ref,
) {
  return (
    <DM.Portal>
      <DM.SubContent ref={ref} sideOffset={sideOffset} collisionPadding={collisionPadding} className={cn(menuContent, className)} {...props} />
    </DM.Portal>
  );
});
