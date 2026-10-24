"use client";

import * as S from "@radix-ui/react-select";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import { cn, fieldBase } from "./cn";
import { menuItem, menuLabel, menuSeparator } from "./menu-styles";

export const Select = S.Root;
export const SelectGroup = S.Group;
export const SelectValue = S.Value;

export const selectTriggerVariants = cva(
  // value and chevron sit on one optical centre line; the value truncates, the chevron never shrinks
  "group inline-flex min-w-0 cursor-default select-none items-center justify-between gap-1.5 whitespace-nowrap leading-none outline-none [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left [&>span]:leading-[1.25] data-[placeholder]:text-ink-4",
  {
    variants: {
      variant: {
        default: fieldBase,
        ghost:
          "rounded-[6px] border border-transparent bg-transparent text-ink hover:bg-paper-3 focus-visible:ring-2 focus-visible:ring-rose/40 aria-expanded:bg-paper-3 disabled:opacity-45",
      },
      size: {
        xs: "h-6 pr-1 pl-1.5 text-[11.5px] [&>svg]:size-3",
        sm: "h-7 pr-1.5 pl-2 text-[12px] [&>svg]:size-3.5",
        md: "h-8 pr-2 pl-2.5 text-[12.5px] [&>svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "sm" },
  },
);

export const SelectTrigger = forwardRef<
  ElementRef<typeof S.Trigger>,
  ComponentPropsWithoutRef<typeof S.Trigger> & VariantProps<typeof selectTriggerVariants>
>(function SelectTrigger({ className, children, variant, size, ...props }, ref) {
  return (
    <S.Trigger ref={ref} data-slot="select-trigger" className={cn(selectTriggerVariants({ variant, size }), className)} {...props}>
      {children}
      <S.Icon asChild>
        <ChevronDown className="shrink-0 text-ink-4 transition-transform duration-150 group-aria-expanded:rotate-180" />
      </S.Icon>
    </S.Trigger>
  );
});

export const SelectContent = forwardRef<ElementRef<typeof S.Content>, ComponentPropsWithoutRef<typeof S.Content>>(function SelectContent(
  { className, children, position = "popper", sideOffset = 4, collisionPadding = 8, ...props },
  ref,
) {
  return (
    <S.Portal>
      <S.Content
        ref={ref}
        position={position}
        sideOffset={position === "popper" ? sideOffset : undefined}
        collisionPadding={collisionPadding}
        className={cn(
          "kit-surface kit-pop relative z-50 min-w-[8rem] overflow-hidden text-ink",
          position === "popper" && "max-h-[min(var(--radix-select-content-available-height),22rem)] min-w-[var(--radix-select-trigger-width)]",
          className,
        )}
        {...props}
      >
        <S.ScrollUpButton className="flex h-5 cursor-default items-center justify-center text-ink-4">
          <ChevronUp className="size-3.5" />
        </S.ScrollUpButton>
        <S.Viewport className="p-1">{children}</S.Viewport>
        <S.ScrollDownButton className="flex h-5 cursor-default items-center justify-center text-ink-4">
          <ChevronDown className="size-3.5" />
        </S.ScrollDownButton>
      </S.Content>
    </S.Portal>
  );
});

export const SelectItem = forwardRef<ElementRef<typeof S.Item>, ComponentPropsWithoutRef<typeof S.Item> & { hint?: ReactNode }>(function SelectItem(
  { className, children, hint, ...props },
  ref,
) {
  return (
    <S.Item ref={ref} className={cn(menuItem, "pr-7", className)} {...props}>
      <S.ItemText>{children}</S.ItemText>
      {hint != null && <span className="ml-auto pl-3 text-[11px] text-ink-4">{hint}</span>}
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <S.ItemIndicator>
          <Check className="size-3.5 text-rose" strokeWidth={2.25} />
        </S.ItemIndicator>
      </span>
    </S.Item>
  );
});

export const SelectLabel = forwardRef<ElementRef<typeof S.Label>, ComponentPropsWithoutRef<typeof S.Label>>(function SelectLabel({ className, ...props }, ref) {
  return <S.Label ref={ref} className={cn(menuLabel, className)} {...props} />;
});

export const SelectSeparator = forwardRef<ElementRef<typeof S.Separator>, ComponentPropsWithoutRef<typeof S.Separator>>(function SelectSeparator(
  { className, ...props },
  ref,
) {
  return <S.Separator ref={ref} className={cn(menuSeparator, className)} {...props} />;
});

export type SelectOption<T extends string = string> = { value: T; label: ReactNode; hint?: ReactNode; disabled?: boolean };

/** One-line select: `<SelectField value onValueChange options />`. */
export function SelectField<T extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  size,
  variant,
  className,
  contentClassName,
  disabled,
  "aria-label": ariaLabel,
  id,
}: {
  value: T | undefined;
  onValueChange: (v: T) => void;
  options: readonly SelectOption<T>[];
  placeholder?: string;
  size?: "xs" | "sm" | "md";
  variant?: "default" | "ghost";
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  "aria-label"?: string;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onValueChange(v as T)} disabled={disabled}>
      <SelectTrigger id={id} size={size} variant={variant} aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled} hint={o.hint}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
