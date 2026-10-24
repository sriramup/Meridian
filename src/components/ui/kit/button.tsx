"use client";

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn, focusRing } from "./cn";
import { Spinner } from "./spinner";

export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 cursor-default select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] font-medium leading-none",
    "transition-[background-color,border-color,color,box-shadow,filter] duration-100",
    "disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    focusRing,
  ],
  {
    variants: {
      variant: {
        default:
          "border border-line-2 bg-[#f8eed6]/80 text-ink shadow-[0_1px_1px_rgb(88_60_28/0.10)] hover:border-ink-4/70 hover:bg-paper-2 active:bg-paper-3",
        primary:
          "border border-[#b98d52] bg-accent text-on-accent shadow-[inset_0_1px_0_rgb(255_244_220/0.45),0_1px_1px_rgb(88_60_28/0.18)] hover:brightness-[1.06] active:brightness-95",
        outline: "border border-line-2 bg-transparent text-ink-2 hover:bg-paper-3/70 hover:text-ink active:bg-paper-3",
        ghost: "border border-transparent text-ink-2 hover:bg-paper-3 hover:text-ink active:bg-line",
        danger: "border border-bad/30 bg-bad-2 text-bad hover:border-bad/45 hover:bg-[#ebc5b2] active:bg-[#e5baa5]",
      },
      size: {
        xs: "h-6 px-2 text-[11.5px] [&_svg[width='24']:not([class*='size-'])]:size-3",
        sm: "h-7 px-2.5 text-[12px] [&_svg[width='24']:not([class*='size-'])]:size-3.5",
        md: "h-8 px-3 text-[12.5px] [&_svg[width='24']:not([class*='size-'])]:size-3.5",
        icon: "size-8 [&_svg[width='24']:not([class*='size-'])]:size-4",
        "icon-sm": "size-7 [&_svg[width='24']:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-6 [&_svg[width='24']:not([class*='size-'])]:size-3.5",
      },
      active: {
        true: "border-[#b98d52] bg-accent text-on-accent hover:border-[#b98d52] hover:bg-accent hover:text-on-accent hover:brightness-[1.04]",
        false: "",
      },
    },
    defaultVariants: { variant: "default", size: "md", active: false },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  Omit<VariantProps<typeof buttonVariants>, "active"> & {
    /** Render the child element (e.g. a link) with button styling. */
    asChild?: boolean;
    /** A toggled-on state (sets aria-pressed). */
    active?: boolean;
    /** Shows a spinner before the label (icon buttons: instead of the icon) and disables the button. */
    loading?: boolean;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, active, loading, asChild, disabled, children, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? "button")}
      data-slot="button"
      aria-pressed={active === undefined ? undefined : active}
      aria-busy={loading || undefined}
      disabled={asChild ? undefined : disabled || loading}
      className={cn(buttonVariants({ variant, size, active: !!active }), className)}
      {...props}
    >
      {loading && !asChild ? (
        <>
          <Spinner size={size === "xs" ? 11 : 13} />
          {typeof size === "string" && size.startsWith("icon") ? null : children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
});
