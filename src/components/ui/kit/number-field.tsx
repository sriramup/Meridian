"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { cn, fieldBase, fieldSizes, type FieldSize } from "./cn";

export type NumberFieldProps = {
  value: number;
  onChange: (v: number) => void;
  /** Called once when a scrub drag or typed edit is committed (for undo grouping). */
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  /** Step for arrows, stepper and scrub (default 1). Shift ×10, Alt ×0.1. */
  step?: number;
  /** Decimal places shown; defaults to the step's decimals. */
  precision?: number;
  /** Unit suffix drawn inside the field ("m", "%", "fl"). */
  unit?: ReactNode;
  /** A short leading label or icon; dragging it (or the field while unfocused) scrubs the value. */
  label?: ReactNode;
  size?: FieldSize;
  /** Show the ▲▼ stepper (default true). */
  stepper?: boolean;
  /** Drag horizontally to change the value (default true). */
  scrub?: boolean;
  /** Pixels of drag per step (default 4). */
  scrubPixels?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  /** Format the idle display (the raw number is shown while editing). */
  format?: (v: number) => string;
};

const decimals = (n: number) => {
  const s = String(n);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
};

/**
 * A numeric input for engineering values: typed entry (simple arithmetic like "12*3" is evaluated),
 * ↑/↓ stepping, a ▲▼ stepper, and drag-to-scrub; always clamped to min/max and snapped to step.
 */
export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  {
    value,
    onChange,
    onCommit,
    min = -Infinity,
    max = Infinity,
    step = 1,
    precision,
    unit,
    label,
    size = "sm",
    stepper = true,
    scrub = true,
    scrubPixels = 4,
    disabled,
    className,
    id,
    "aria-label": ariaLabel,
    format,
  },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!);
  const prec = precision ?? Math.min(6, decimals(step));
  const [draft, setDraft] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const clampSnap = (v: number) => {
    // typed values keep their own value (rounded to the shown precision); stepping snaps to the step grid
    if (!Number.isFinite(v)) return valueRef.current;
    return Number(Math.min(max, Math.max(min, v)).toFixed(prec));
  };
  const set = (v: number, commit = false) => {
    const c = clampSnap(v);
    if (c !== valueRef.current) onChange(c);
    if (commit) onCommit?.(c);
    return c;
  };
  const stepBy = (dir: number, mult = 1, commit = true) => {
    const s = step * mult;
    // snap to the step grid while stepping
    const next = Math.round((valueRef.current + dir * s) / s) * s;
    set(next, commit);
  };
  const mult = (e: { shiftKey: boolean; altKey: boolean }) => (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);

  const display = draft ?? (format ? format(value) : value.toFixed(prec));

  const commitDraft = () => {
    if (draft == null) return;
    const v = evaluate(draft);
    setDraft(null);
    if (v != null) set(v, true);
  };

  // scrub: pointer down on the field (while unfocused) or on the label; a click without movement focuses the input
  const drag = useRef<{ x: number; start: number; moved: boolean; id: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!scrub || disabled || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-stepper]")) return;
    if (document.activeElement === input.current && t === input.current) return; // editing text: normal caret behaviour
    e.preventDefault();
    drag.current = { x: e.clientX, start: valueRef.current, moved: false, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    if (!d.moved) {
      d.moved = true;
      setScrubbing(true);
    }
    const s = step * mult(e);
    const steps = Math.round(dx / scrubPixels);
    set(Math.round((d.start + steps * s) / s) * s);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(d.id);
    if (d.moved) {
      setScrubbing(false);
      onCommit?.(valueRef.current);
    } else {
      input.current?.focus();
      input.current?.select();
    }
  };

  useEffect(() => {
    if (!scrubbing) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "ew-resize";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [scrubbing]);

  const pad = size === "xs" ? "px-1.5" : size === "sm" ? "px-2" : "px-2.5";
  return (
    <div
      data-slot="number-field"
      data-scrubbing={scrubbing || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        fieldBase,
        fieldSizes[size],
        "group/nf relative flex w-full min-w-0 items-center gap-1 overflow-hidden pr-0",
        pad,
        "has-[input:focus-visible]:border-rose/55 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-rose/20",
        scrub && !disabled && "cursor-ew-resize has-[input:focus]:cursor-auto",
        scrubbing && "border-rose/55 bg-[#f8eed6]",
        disabled && "pointer-events-none opacity-45",
        className,
      )}
    >
      {label != null && <span className="flex shrink-0 select-none items-center text-[11px] font-medium text-ink-4 [&_svg]:size-3.5">{label}</span>}
      <input
        ref={input}
        id={id}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-label={ariaLabel}
        aria-valuenow={value}
        aria-valuemin={Number.isFinite(min) ? min : undefined}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        value={display}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setDraft(value.toFixed(prec));
          requestAnimationFrame(() => e.target.select());
        }}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const base = draft != null ? (evaluate(draft) ?? value) : value;
            valueRef.current = base;
            const s = step * mult(e);
            const next = clampSnap(Math.round((base + (e.key === "ArrowUp" ? 1 : -1) * s) / s) * s);
            if (next !== value) onChange(next);
            onCommit?.(next);
            setDraft(next.toFixed(prec));
          } else if (e.key === "Enter") {
            commitDraft();
            setDraft(null);
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
            e.stopPropagation();
          }
        }}
        className={cn(
          "tabular h-full w-full min-w-0 flex-1 bg-transparent text-right outline-none",
          scrub && "cursor-[inherit] focus:cursor-text",
          scrubbing && "select-none",
        )}
      />
      {unit != null && <span className="shrink-0 select-none text-ink-4">{unit}</span>}
      {stepper ? (
        <span data-stepper="" className="ml-0.5 flex h-full w-4 shrink-0 flex-col border-l border-line/80 opacity-60 transition-opacity group-hover/nf:opacity-100">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Increase"
            disabled={disabled || value >= max}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => stepBy(1, mult(e))}
            className="flex flex-1 cursor-default items-center justify-center text-ink-4 hover:bg-paper-3 hover:text-ink disabled:opacity-30"
          >
            <ChevronUp className="size-2.5" strokeWidth={2.5} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Decrease"
            disabled={disabled || value <= min}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => stepBy(-1, mult(e))}
            className="flex flex-1 cursor-default items-center justify-center text-ink-4 hover:bg-paper-3 hover:text-ink disabled:opacity-30"
          >
            <ChevronDown className="size-2.5" strokeWidth={2.5} />
          </button>
        </span>
      ) : (
        <span className={size === "xs" ? "w-1.5" : "w-2"} />
      )}
    </div>
  );
});

/** Parse a typed number, allowing simple arithmetic (+ − × ÷, parentheses). Returns null when invalid. */
export function evaluate(text: string): number | null {
  const s = text.replace(/,/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").trim();
  if (!s) return null;
  if (!/^[\d.\s+\-*/()eE]+$/.test(s)) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  let i = 0;
  const peek = () => s[i];
  const ws = () => {
    while (s[i] === " ") i++;
  };
  const num = (): number => {
    ws();
    if (peek() === "(") {
      i++;
      const v = expr();
      ws();
      if (peek() === ")") i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      return -num();
    }
    if (peek() === "+") {
      i++;
      return num();
    }
    const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?|^\d+\.?/.exec(s.slice(i));
    if (!m) throw new Error("nan");
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const term = (): number => {
    let v = num();
    for (;;) {
      ws();
      const c = peek();
      if (c === "*") {
        i++;
        v *= num();
      } else if (c === "/") {
        i++;
        v /= num();
      } else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      ws();
      const c = peek();
      if (c === "+") {
        i++;
        v += term();
      } else if (c === "-") {
        i++;
        v -= term();
      } else return v;
    }
  };
  try {
    const v = expr();
    ws();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
