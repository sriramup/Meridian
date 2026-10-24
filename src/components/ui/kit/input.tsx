"use client";

import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn, fieldBase, fieldSizes, type FieldSize } from "./cn";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: FieldSize;
  /** Content drawn inside the field before the text (an icon). */
  leading?: ReactNode;
  /** Content drawn inside the field after the text (a unit, a kbd hint, a clear button). */
  trailing?: ReactNode;
  /** Class for the wrapper when leading/trailing are used. */
  wrapperClassName?: string;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = "sm", leading, trailing, wrapperClassName, type = "text", ...props },
  ref,
) {
  const pad = size === "xs" ? "px-1.5" : size === "sm" ? "px-2" : "px-2.5";
  if (!leading && !trailing) {
    return <input ref={ref} type={type} data-slot="input" className={cn(fieldBase, fieldSizes[size], pad, "w-full min-w-0", className)} {...props} />;
  }
  return (
    <div
      data-slot="input-group"
      className={cn(
        fieldBase,
        fieldSizes[size],
        "flex w-full min-w-0 items-center gap-1.5 has-[input:focus-visible]:border-rose/55 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-rose/20 has-[input:disabled]:opacity-45",
        pad,
        wrapperClassName,
      )}
    >
      {leading && <span className="flex shrink-0 items-center text-ink-4 [&_svg]:size-3.5">{leading}</span>}
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn("h-full w-full min-w-0 bg-transparent outline-none placeholder:text-ink-4 disabled:cursor-not-allowed", className)}
        {...props}
      />
      {trailing && <span className="flex shrink-0 items-center text-ink-4 [&_svg]:size-3.5">{trailing}</span>}
    </div>
  );
});
