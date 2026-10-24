"use client";

// Input widgets for the parameter form. Kept behind this one module so the form can use the
// shared ui kit (src/components/ui/kit) wherever it provides the equivalent control.

import * as RSelect from "@radix-ui/react-select";
import * as RSlider from "@radix-ui/react-slider";
import { Check, ChevronDown, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../ui";

const box = "h-7 rounded-[5px] border border-line-2 bg-paper text-[12px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/** a number with its unit: type, step with − / +, arrow keys (Shift ×10), or drag the label to scrub */
export function NumberInput({ value, onChange, min, max, step, unit, label, integer }: { value: number; onChange: (v: number, final: boolean) => void; min?: number; max?: number; step: number; unit?: string; label?: string; integer?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, integer ? Math.round(n) : +n.toFixed(4)));
  const commit = () => {
    if (draft === null) return;
    const n = parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(n)) onChange(clamp(n), true);
  };
  const bump = (k: number) => onChange(clamp(value + k * step), true);
  const shown = draft ?? fmt(value, step, integer);
  return (
    <div className={cx("flex items-stretch overflow-hidden", box)} aria-label={label}>
      <button type="button" tabIndex={-1} aria-label="Decrease" onClick={() => bump(-1)} className="grid w-6 shrink-0 place-items-center text-ink-3 hover:bg-paper-3 hover:text-ink">
        <Minus size={11} />
      </button>
      <input
        inputMode="decimal"
        value={shown}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          else if (e.key === "Escape") setDraft(null);
          else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setDraft(null);
            bump((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1));
          }
        }}
        className="tabular w-0 min-w-0 flex-1 bg-transparent text-right outline-none"
      />
      {unit && <span className="flex items-center pr-1 pl-1 text-[11px] text-ink-4">{unit}</span>}
      <button type="button" tabIndex={-1} aria-label="Increase" onClick={() => bump(1)} className="grid w-6 shrink-0 place-items-center text-ink-3 hover:bg-paper-3 hover:text-ink">
        <Plus size={11} />
      </button>
    </div>
  );
}

function fmt(v: number, step: number, integer?: boolean) {
  if (integer) return String(Math.round(v));
  const dec = Math.max(0, Math.min(4, -Math.floor(Math.log10(step)) + 1));
  return String(+v.toFixed(dec));
}

/** label you can drag sideways to scrub a number */
export function ScrubLabel({ children, value, step, onChange, disabled }: { children: ReactNode; value: number; step: number; onChange: (v: number, final: boolean) => void; disabled?: boolean }) {
  const st = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  return (
    <span
      className={cx("select-none", !disabled && "cursor-ew-resize")}
      onPointerDown={(e) => {
        if (disabled) return;
        st.current = { x: e.clientX, v: value, moved: false };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = st.current;
        if (!s) return;
        const dx = e.clientX - s.x;
        if (Math.abs(dx) < 3 && !s.moved) return;
        s.moved = true;
        onChange(s.v + Math.round(dx / 4) * step * (e.shiftKey ? 10 : 1), false);
      }}
      onPointerUp={(e) => {
        const s = st.current;
        st.current = null;
        if (s?.moved) onChange(s.v + Math.round((e.clientX - s.x) / 4) * step * (e.shiftKey ? 10 : 1), true);
      }}
    >
      {children}
    </span>
  );
}

/** slider with a compact number field beside it */
export function SliderInput(p: { value: number; onChange: (v: number, final: boolean) => void; min: number; max: number; step: number; unit?: string; label?: string; integer?: boolean }) {
  // local value while dragging, so the thumb follows the pointer even though commits are debounced upstream
  const [live, setLive] = useState<number | null>(null);
  const v = live ?? p.value;
  return (
    <div className="flex items-center gap-2">
      <RSlider.Root
        className="relative flex h-5 min-w-0 flex-1 touch-none items-center select-none"
        value={[v]}
        min={p.min}
        max={p.max}
        step={p.step}
        aria-label={p.label}
        onValueChange={([x]) => {
          setLive(x);
          p.onChange(x, false);
        }}
        onValueCommit={([x]) => {
          setLive(null);
          p.onChange(x, true);
        }}
      >
        <RSlider.Track className="relative h-[3px] grow rounded-full bg-line">
          <RSlider.Range className="absolute h-full rounded-full bg-gold" />
        </RSlider.Track>
        <RSlider.Thumb className="block h-3.5 w-3.5 rounded-full border border-line-2 bg-paper shadow-[0_1px_2px_rgb(60_40_20/0.35)] outline-none focus-visible:ring-2 focus-visible:ring-accent/50" />
      </RSlider.Root>
      <div className="w-[92px] shrink-0">
        <NumberInput value={v} onChange={(x, f) => (setLive(null), p.onChange(x, f))} min={p.min} max={p.max} step={p.step} unit={p.unit} label={p.label} integer={p.integer} />
      </div>
    </div>
  );
}

export function SelectInput({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: { value: string; label: string; description?: string }[]; label?: string }) {
  return (
    <RSelect.Root value={value} onValueChange={onChange}>
      <RSelect.Trigger aria-label={label} className={cx("flex w-full min-w-0 items-center justify-between gap-1 px-2", box)}>
        <span className="truncate">
          <RSelect.Value />
        </span>
        <RSelect.Icon>
          <ChevronDown size={13} className="text-ink-3" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content position="popper" sideOffset={4} className="z-50 max-h-[320px] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[6px] border border-line-2 bg-paper shadow-lg">
          <RSelect.Viewport className="p-1">
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} className="relative flex cursor-default flex-col rounded-[4px] py-1 pr-2 pl-6 text-[12px] text-ink outline-none select-none data-[highlighted]:bg-accent-2">
                <RSelect.ItemIndicator className="absolute top-1.5 left-1.5">
                  <Check size={12} />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                {o.description && <span className="text-[10.5px] leading-tight text-ink-4">{o.description}</span>}
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export function SwitchInput({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      className={cx("relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40", value ? "border-gold bg-gold" : "border-line-2 bg-paper-3")}
    >
      <span className={cx("block h-3 w-3 rounded-full bg-paper shadow transition-transform", value ? "translate-x-[15px]" : "translate-x-[2px]")} />
    </button>
  );
}

export function ColorInput({ value, onChange, swatches, label }: { value: string; onChange: (v: string) => void; swatches?: string[]; label?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <label className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-[5px] border border-line-2" style={{ background: value }}>
        <input type="color" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
      <input
        value={draft}
        aria-label={`${label ?? "Colour"} hex`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => (/^#?[0-9a-f]{6}$/i.test(draft) ? onChange(draft.startsWith("#") ? draft : `#${draft}`) : setDraft(value))}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        className={cx("w-[76px] px-1.5 font-mono", box)}
      />
      {swatches?.slice(0, 8).map((s) => (
        <button key={s} type="button" aria-label={s} title={s} onClick={() => onChange(s)} className={cx("h-[18px] w-[18px] rounded-[4px] border", s.toLowerCase() === value.toLowerCase() ? "border-ink ring-1 ring-ink" : "border-line-2")} style={{ background: s }} />
      ))}
    </div>
  );
}

export function TextInput({ value, onChange, maxLength, label, placeholder }: { value: string; onChange: (v: string) => void; maxLength?: number; label?: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      value={draft}
      maxLength={maxLength}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onChange(draft)}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      className={cx("w-full px-2", box)}
    />
  );
}

/** options as toggle chips (multi-select) */
export function ChipsInput({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}
            className={cx("h-6 rounded-[5px] border px-2 text-[11.5px] transition-colors", on ? "border-gold bg-accent-2 text-ink" : "border-line text-ink-3 hover:border-line-2 hover:text-ink")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
