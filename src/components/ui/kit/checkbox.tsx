"use client";

import * as Cb from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn, focusRing } from "./cn";

export const Checkbox = forwardRef<ElementRef<typeof Cb.Root>, ComponentPropsWithoutRef<typeof Cb.Root>>(function Checkbox({ className, ...props }, ref) {
  return (
    <Cb.Root
      ref={ref}
      className={cn(
        "peer inline-flex size-[15px] shrink-0 cursor-default items-center justify-center rounded-[4px] border border-line-2 bg-field text-on-accent shadow-[inset_0_1px_1px_rgb(88_60_28/0.1)] transition-colors duration-100 hover:border-ink-4",
        "aria-checked:border-accent-edge aria-checked:bg-accent aria-[checked=mixed]:border-accent-edge aria-[checked=mixed]:bg-accent disabled:cursor-not-allowed disabled:opacity-45",
        focusRing,
        className,
      )}
      {...props}
    >
      <Cb.Indicator className="flex items-center justify-center">
        {props.checked === "indeterminate" ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}
      </Cb.Indicator>
    </Cb.Root>
  );
});
