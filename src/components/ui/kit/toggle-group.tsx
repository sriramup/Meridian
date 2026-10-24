"use client";

import * as TG from "@radix-ui/react-toggle-group";
import { cva, type VariantProps } from "class-variance-authority";
import { createContext, forwardRef, useContext, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import { cn, focusRing } from "./cn";
import { Tooltip } from "./tooltip";

const groupVariants = cva("inline-flex items-center", {
  variants: {
    variant: {
      // a sunken track with a raised thumb: for mutually exclusive modes
      segmented: "gap-[2px] rounded-[6px] border border-line bg-paper-2/80 p-[2px]",
      // free-standing toggles (icon toolbars)
      ghost: "gap-0.5",
    },
    size: { xs: "", sm: "", md: "" },
  },
  defaultVariants: { variant: "segmented", size: "sm" },
});

// "on" is read from aria-checked/aria-pressed, not data-state: a Tooltip trigger wrapping an item
// overwrites data-state with its own open/closed state. (Classes are written out in full so
// Tailwind can see them.)

const itemVariants = cva(
  [
    "inline-flex cursor-default select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium leading-none transition-[background-color,color,box-shadow] duration-100",
    "disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0",
    focusRing,
  ],
  {
    variants: {
      variant: {
        segmented:
          "rounded-[4px] text-ink-3 hover:text-ink [&:is([aria-checked=true],[aria-pressed=true])]:bg-[#f8eed6] [&:is([aria-checked=true],[aria-pressed=true])]:text-rose [&:is([aria-checked=true],[aria-pressed=true])]:shadow-[0_1px_2px_rgb(88_60_28/0.22)]",
        ghost: "rounded-[6px] text-ink-2 hover:bg-paper-3 [&:is([aria-checked=true],[aria-pressed=true])]:bg-accent [&:is([aria-checked=true],[aria-pressed=true])]:text-on-accent",
      },
      size: {
        xs: "h-5 px-1.5 text-[11px] [&_svg[width='24']:not([class*='size-'])]:size-3",
        sm: "h-6 px-2 text-[11.5px] [&_svg[width='24']:not([class*='size-'])]:size-3.5",
        md: "h-7 px-2.5 text-[12px] [&_svg[width='24']:not([class*='size-'])]:size-3.5",
      },
      icon: { true: "px-0", false: "" },
    },
    compoundVariants: [
      { icon: true, size: "xs", className: "w-5" },
      { icon: true, size: "sm", className: "w-6" },
      { icon: true, size: "md", className: "w-7" },
      { variant: "ghost", size: "sm", className: "h-7" },
      { variant: "ghost", size: "md", className: "h-8" },
      { variant: "ghost", icon: true, size: "sm", className: "w-7" },
      { variant: "ghost", icon: true, size: "md", className: "w-8" },
    ],
    defaultVariants: { variant: "segmented", size: "sm", icon: false },
  },
);

type Ctx = VariantProps<typeof itemVariants>;
const GroupCtx = createContext<Ctx>({});

type GroupProps = ComponentPropsWithoutRef<typeof TG.Root> & VariantProps<typeof groupVariants>;

export const ToggleGroup = forwardRef<ElementRef<typeof TG.Root>, GroupProps>(function ToggleGroup({ className, variant, size, children, ...props }, ref) {
  return (
    <TG.Root ref={ref} className={cn(groupVariants({ variant, size }), className)} {...(props as ComponentPropsWithoutRef<typeof TG.Root>)}>
      <GroupCtx.Provider value={{ variant, size }}>{children}</GroupCtx.Provider>
    </TG.Root>
  );
});

export const ToggleGroupItem = forwardRef<ElementRef<typeof TG.Item>, ComponentPropsWithoutRef<typeof TG.Item> & { icon?: boolean }>(function ToggleGroupItem(
  { className, icon, ...props },
  ref,
) {
  const ctx = useContext(GroupCtx);
  return <TG.Item ref={ref} className={cn(itemVariants({ variant: ctx.variant, size: ctx.size, icon: !!icon }), className)} {...props} />;
});

export type SegmentedOption<T extends string> = { value: T; label: ReactNode; title?: string; disabled?: boolean; icon?: boolean };

/**
 * Single choice that can never be empty (clicking the active option keeps it). Arrow keys move
 * between options; `title` becomes a tooltip.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "sm",
  className,
  "aria-label": ariaLabel,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly SegmentedOption<T>[];
  size?: "xs" | "sm" | "md";
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="segmented"
      size={size}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onValueChange={(v: string) => v && onChange(v as T)}
      className={className}
    >
      {options.map((o) =>
        o.title ? (
          <Tooltip key={o.value} content={o.title}>
            <ToggleGroupItem value={o.value} disabled={o.disabled} icon={o.icon} aria-label={o.icon ? o.title : undefined}>
              {o.label}
            </ToggleGroupItem>
          </Tooltip>
        ) : (
          <ToggleGroupItem key={o.value} value={o.value} disabled={o.disabled} icon={o.icon}>
            {o.label}
          </ToggleGroupItem>
        ),
      )}
    </ToggleGroup>
  );
}
