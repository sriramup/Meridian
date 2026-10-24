"use client";

// The parameter form, generated from a definition's ParamSpec list: grouped sections, advanced
// parameters folded under "More options", `when` conditions hiding what doesn't apply. Used by the
// library palette (before placing) and the inspector (live re-configuration).

import { ChevronRight, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { NumberParam, ParamSpec, ParamValues, PrimitiveDef } from "@/library";
import { Segmented, cx } from "../ui";
import { ChipsInput, ColorInput, NumberInput, ScrubLabel, SelectInput, SliderInput, SwitchInput, TextInput } from "./fields";
import { changedKeys, coerce, formatValue, layoutForm, stepOf, widgetFor, type FormSection } from "./formModel";

export interface ParamFormProps {
  def: PrimitiveDef;
  values: ParamValues;
  /** `final` is false while a slider or scrub is still moving (callers debounce those) */
  onChange: (values: ParamValues, final: boolean) => void;
  onReset?: () => void;
}

export function ParamForm({ def, values, onChange, onReset }: ParamFormProps) {
  const [more, setMore] = useState(false);
  const layout = layoutForm(def.params, values);
  const set = (p: ParamSpec, raw: unknown, final = true) => onChange({ ...values, [p.key]: coerce(p, raw, values[p.key]) }, final);
  const changed = changedKeys(def.params, values).length;
  if (!def.params.length) return <p className="px-3 py-2 text-[11.5px] text-ink-4">No settings: it is placed as it is.</p>;
  return (
    <div className="pb-1">
      {layout.sections.map((s, i) => (
        <Section key={s.title || i} s={s} values={values} set={set} first={i === 0} />
      ))}
      {layout.advanced.length > 0 && (
        <div className="mt-1 border-t border-line">
          <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="flex w-full items-center gap-1 px-3 py-2 text-[11.5px] font-medium text-ink-3 hover:text-ink">
            <ChevronRight size={13} className={cx("transition-transform", more && "rotate-90")} />
            More options <span className="text-ink-4">({layout.advancedCount})</span>
          </button>
          {more && layout.advanced.map((s, i) => <Section key={s.title || i} s={s} values={values} set={set} first={false} />)}
        </div>
      )}
      {changed > 0 && onReset && (
        <div className="flex justify-end px-3 pt-1">
          <button type="button" onClick={onReset} className="flex items-center gap-1 text-[11px] text-ink-4 hover:text-ink">
            <RotateCcw size={11} /> Reset {changed} to defaults
          </button>
        </div>
      )}
    </div>
  );
}

function Section({ s, values, set, first }: { s: FormSection; values: ParamValues; set: (p: ParamSpec, raw: unknown, final?: boolean) => void; first: boolean }) {
  return (
    <section className={cx("px-3", first ? "pt-2" : "pt-2.5")}>
      {s.title && <h4 className="font-legend mb-1 text-[12px] leading-none text-ink-3">{s.title}</h4>}
      <div className="space-y-1.5">
        {s.params.map((p) => (
          <Field key={p.key} p={p} value={values[p.key]} set={set} />
        ))}
      </div>
    </section>
  );
}

function Field({ p, value, set }: { p: ParamSpec; value: unknown; set: (p: ParamSpec, raw: unknown, final?: boolean) => void }) {
  const w = widgetFor(p);
  const label = (
    <span className="truncate text-[12px] text-ink-2" title={p.description ? `${p.label}: ${p.description}` : p.label}>
      {p.label}
    </span>
  );
  const row = (control: React.ReactNode, labelNode = label) => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-center gap-2" data-param={p.key}>
      {labelNode}
      <div className="flex min-w-0 justify-end">{control}</div>
    </div>
  );
  const stacked = (control: React.ReactNode, right?: React.ReactNode) => (
    <div data-param={p.key}>
      <div className="mb-0.5 flex items-center justify-between gap-2">
        {label}
        {right}
      </div>
      {control}
    </div>
  );
  switch (w) {
    case "slider": {
      const n = p as NumberParam;
      return stacked(<SliderInput value={Number(value ?? n.default)} onChange={(v, f) => set(p, v, f)} min={n.min!} max={n.max!} step={stepOf(n)} unit={n.unit} label={p.label} integer={n.type === "integer"} />);
    }
    case "number": {
      const n = p as NumberParam;
      const v = Number(value ?? n.default);
      return row(
        <div className="w-full max-w-[150px]">
          <NumberInput value={v} onChange={(x, f) => set(p, x, f)} min={n.min} max={n.max} step={stepOf(n)} unit={n.unit} label={p.label} integer={n.type === "integer"} />
        </div>,
        <ScrubLabel value={v} step={stepOf(n)} onChange={(x, f) => set(p, x, f)}>
          {label}
        </ScrubLabel>,
      );
    }
    case "segmented":
      return row(<Segmented size="xs" value={String(value)} onChange={(v) => set(p, v)} options={(p.type === "enum" ? p.options : []).map((o) => ({ value: o.value, label: o.label, title: o.description }))} />);
    case "select":
      return row(<SelectInput value={String(value)} onChange={(v) => set(p, v)} options={p.type === "enum" ? p.options : []} label={p.label} />);
    case "switch":
      return row(<SwitchInput value={!!value} onChange={(v) => set(p, v)} label={p.label} />);
    case "color":
      return stacked(<ColorInput value={String(value ?? p.default)} onChange={(v) => set(p, v)} swatches={p.type === "color" ? p.swatches : undefined} label={p.label} />);
    case "text":
      return row(<TextInput value={String(value ?? "")} onChange={(v) => set(p, v)} maxLength={p.type === "text" ? p.maxLength : undefined} label={p.label} />);
    case "multi":
      return stacked(<ChipsInput value={Array.isArray(value) ? (value as string[]) : []} onChange={(v) => set(p, v)} options={p.type === "multi" ? p.options : []} />);
    case "json":
      return stacked(<pre className="max-h-24 overflow-auto rounded-[5px] border border-line bg-paper-2 px-2 py-1 font-mono text-[10.5px] text-ink-3">{formatValue(p, value)}</pre>);
  }
}
