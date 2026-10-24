import { forwardRef, type LabelHTMLAttributes } from "react";
import { cn } from "./cn";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(function Label({ className, ...props }, ref) {
  return (
    <label
      ref={ref}
      data-slot="label"
      className={cn("inline-flex select-none items-center gap-1.5 text-[11.5px] font-medium leading-none text-ink-3 peer-disabled:opacity-45", className)}
      {...props}
    />
  );
});
