"use client";

// Input widgets for the parameter form, built on the shared ui kit. `onChange(v, final)`: final is
// false while a slider or scrub is still moving (callers debounce those), true on commit.

import { useEffect, useState } from "react";
import { ColorField, Input, NumberField, SelectField, Slider, Switch, ToggleGroup, ToggleGroupItem } from "@/components/ui/kit";

const trim = (dec: number) => (v: number) => String(+v.toFixed(dec));

/** a number with its unit: type (arithmetic allowed), step ▲▼, arrow keys (Shift ×10), or drag to scrub */
export function NumberInput({ value, onChange, min, max, step, unit, label, integer, decimals = 2 }: { value: number; onChange: (v: number, final: boolean) => void; min?: number; max?: number; step: number; unit?: string; label?: string; integer?: boolean; decimals?: number }) {
  return (
    <NumberField
      value={value}
      onChange={(v) => onChange(v, false)}
      onCommit={(v) => onChange(v, true)}
      min={min}
      max={max}
      step={step}
      precision={integer ? 0 : decimals}
      format={integer ? undefined : trim(decimals)}
      unit={unit}
      aria-label={label}
      className="w-full"
    />
  );
}

/** slider with a compact number field beside it */
export function SliderInput(p: { value: number; onChange: (v: number, final: boolean) => void; min: number; max: number; step: number; unit?: string; label?: string; integer?: boolean; decimals?: number }) {
  // the thumb follows the pointer locally; the value upstream may lag behind a debounce
  const [live, setLive] = useState<number | null>(null);
  const v = live ?? p.value;
  return (
    <div className="flex items-center gap-2.5">
      <Slider
        className="min-w-0 flex-1"
        size="sm"
        value={[v]}
        min={p.min}
        max={p.max}
        step={p.step}
        thumbLabels={p.label ? [p.label] : undefined}
        onValueChange={([x]) => {
          setLive(x);
          p.onChange(x, false);
        }}
        onValueCommit={([x]) => {
          setLive(null);
          p.onChange(x, true);
        }}
      />
      <div className="w-[96px] shrink-0">
        <NumberInput value={v} onChange={(x, f) => (f && setLive(null), p.onChange(x, f))} min={p.min} max={p.max} step={p.step} unit={p.unit} label={p.label} integer={p.integer} decimals={p.decimals} />
      </div>
    </div>
  );
}

export function SelectInput({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: { value: string; label: string; description?: string }[]; label?: string }) {
  return <SelectField value={value} onValueChange={onChange} options={options.map((o) => ({ value: o.value, label: o.label, hint: o.description }))} aria-label={label} className="w-full" />;
}

export function SwitchInput({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <Switch size="sm" checked={value} onCheckedChange={onChange} aria-label={label} />;
}

export function ColorInput({ value, onChange, swatches, label }: { value: string; onChange: (v: string) => void; swatches?: string[]; label?: string }) {
  return <ColorField value={value} onChange={onChange} swatches={swatches?.length ? swatches : undefined} aria-label={label} align="start" />;
}

export function TextInput({ value, onChange, maxLength, label, placeholder }: { value: string; onChange: (v: string) => void; maxLength?: number; label?: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      value={draft}
      maxLength={maxLength}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onChange(draft)}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

/** options as toggle chips (multi-select) */
export function ChipsInput({ value, onChange, options, label }: { value: string[]; onChange: (v: string[]) => void; options: { value: string; label: string }[]; label?: string }) {
  return (
    <ToggleGroup type="multiple" value={value} onValueChange={(v: string[]) => onChange(v)} aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
