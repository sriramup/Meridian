"use client";

import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";
import { cn, fieldBase } from "./cn";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Grow with the content between minRows and maxRows (default true). */
  autosize?: boolean;
  minRows?: number;
  maxRows?: number;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autosize = true, minRows = 2, maxRows = 10, rows, onInput, value, style, ...props },
  ref,
) {
  const el = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => el.current!);

  const fit = useCallback(() => {
    const t = el.current;
    if (!t || !autosize) return;
    const cs = getComputedStyle(t);
    const line = parseFloat(cs.lineHeight) || 18;
    const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    t.style.height = "auto";
    const min = line * minRows + chrome;
    const max = line * maxRows + chrome;
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const natural = t.scrollHeight + border;
    t.style.height = `${Math.min(max, Math.max(min, natural))}px`;
    t.style.overflowY = natural > max + 1 ? "auto" : "hidden";
  }, [autosize, minRows, maxRows]);

  useLayoutEffect(fit, [fit, value]);

  return (
    <textarea
      ref={el}
      data-slot="textarea"
      rows={autosize ? minRows : rows}
      value={value}
      onInput={(e) => {
        fit();
        onInput?.(e);
      }}
      style={style}
      className={cn(fieldBase, "kit-scroll block w-full min-w-0 resize-none px-2.5 py-[7px] text-[12.5px] leading-[18px]", className)}
      {...props}
    />
  );
});
