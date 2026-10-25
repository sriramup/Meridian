"use client";

// The parameter form, generated from a definition's ParamSpec list: grouped sections, advanced
// parameters folded under "More options", `when` conditions hiding what doesn't apply. Used by the
// library palette (before placing) and the inspector (live re-configuration).

import { ChevronRight, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleHeader, CollapsibleTrigger, Segmented, cn as cx } from "@/components/ui/kit";
import type { NumberParam, ParamSpec, ParamValues, PrimitiveDef } from "@/library";
import { ChipsInput, ColorInput, NumberInput, SelectInput, SliderInput, SwitchInput, TextInput } from "./fields";
import { changedKeys, coerce, formatValue, groupForm, groupSummary, shownNumber, widgetFor, type FormGroup } from "./formModel";

export interface ParamFormProps {
  def: PrimitiveDef;
  values: ParamValues;
  /** `final` is false while a slider or scrub is still moving (callers debounce those) */
  onChange: (values: ParamValues, final: boolean) => void;
  onReset?: () => void;
}

/** which groups are open, remembered per definition and group for the session */
const openState = new Map<string, boolean>();

export function ParamForm({ def, values, onChange, onReset }: ParamFormProps) {
  const [, rerender] = useState(0);
  const groups = groupForm(def.params, values);
  const set = (p: ParamSpec, raw: unknown, final = true) => onChange({ ...values, [p.key]: coerce(p, raw, values[p.key]) }, final);
  const changed = changedKeys(def.params, values).length;
  if (!def.params.length) return <p className="px-3 py-2 text-[11.5px] text-ink-4">No settings: it is placed as it is.</p>;
  // short forms show every group open; long ones open the first two and fold the rest to a summary
  const total = groups.reduce((n, g) => n + g.basic.length, 0);
  return (
    <div className="pb-1.5">
      {groups.map((g, i) => {
        const k = `${def.id}|${g.title}`;
        const open = openState.get(k) ?? (total <= 12 || i < 2 || !g.title);
        const toggle = (o: boolean) => {
          openState.set(k, o);
          rerender((x) => x + 1);
        };
        return <Group key={g.title || i} g={g} values={values} set={set} open={open} onOpenChange={toggle} defId={def.id} />;
      })}
      {changed > 0 && onReset && (
        <div className="flex justify-end px-3 pt-1.5">
          <button type="button" onClick={onReset} className="flex items-center gap-1 text-[11px] text-ink-4 hover:text-ink">
            <RotateCcw size={11} /> Reset {changed} to defaults
          </button>
        </div>
      )}
    </div>
  );
}

function Group({ g, values, set, open, onOpenChange, defId }: { g: FormGroup; values: ParamValues; set: (p: ParamSpec, raw: unknown, final?: boolean) => void; open: boolean; onOpenChange: (o: boolean) => void; defId: string }) {
  const [more, setMore] = useState(false);
  const body = (
    <div className="space-y-1.5 px-3 pb-2">
      {g.basic.map((p) => (
        <Field key={p.key} p={p} value={values[p.key]} set={set} />
      ))}
      {g.advanced.length > 0 && (
        <Collapsible open={more} onOpenChange={setMore}>
          <CollapsibleTrigger className="flex items-center gap-1 pt-0.5 text-[11px] text-ink-4 hover:text-ink">
            <ChevronRight size={12} className={cx("transition-transform", more && "rotate-90")} />
            {more ? "Fewer" : "More"} {g.title ? g.title.toLowerCase() : "options"} options ({g.advanced.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-1.5 pt-1.5">
              {g.advanced.map((p) => (
                <Field key={p.key} p={p} value={values[p.key]} set={set} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
  if (!g.title) return <div className="pt-2">{body}</div>;
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="border-t border-line first:border-t-0" data-group={`${defId}|${g.title}`}>
      <CollapsibleHeader className="h-8 rounded-none px-2.5">
        <span className="font-legend text-[12.5px] font-normal text-ink-2">{g.title}</span>
        {!open && <span className="ml-auto min-w-0 truncate pl-2 text-[11px] font-normal text-ink-4">{groupSummary(g, values)}</span>}
      </CollapsibleHeader>
      <CollapsibleContent>{body}</CollapsibleContent>
    </Collapsible>
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
      // stored in metres (SI), shown and typed in imperial units
      const d = shownNumber(p as NumberParam);
      return stacked(<SliderInput value={d.show(Number(value ?? (p as NumberParam).default))} onChange={(v, f) => set(p, d.store(v), f)} min={d.min!} max={d.max!} step={d.step} unit={d.unit} label={p.label} integer={d.integer} decimals={d.decimals} />);
    }
    case "number": {
      const d = shownNumber(p as NumberParam);
      const v = d.show(Number(value ?? (p as NumberParam).default));
      return row(
        <div className="w-full max-w-[150px]">
          <NumberInput value={v} onChange={(x, f) => set(p, d.store(x), f)} min={d.min} max={d.max} step={d.step} unit={d.unit} label={p.label} integer={d.integer} decimals={d.decimals} />
        </div>,
      );
    }
    case "segmented":
      return row(<Segmented size="xs" value={String(value)} onChange={(v) => set(p, v)} aria-label={p.label} options={(p.type === "enum" ? p.options : []).map((o) => ({ value: o.value, label: o.label, title: o.description }))} />);
    case "select":
      return row(<SelectInput value={String(value)} onChange={(v) => set(p, v)} options={p.type === "enum" ? p.options : []} label={p.label} />);
    case "switch":
      return row(<SwitchInput value={!!value} onChange={(v) => set(p, v)} label={p.label} />);
    case "color":
      return stacked(<ColorInput value={String(value ?? p.default)} onChange={(v) => set(p, v)} swatches={p.type === "color" ? p.swatches : undefined} label={p.label} />);
    case "text":
      return row(<TextInput value={String(value ?? "")} onChange={(v) => set(p, v)} maxLength={p.type === "text" ? p.maxLength : undefined} label={p.label} />);
    case "multi":
      return stacked(<ChipsInput value={Array.isArray(value) ? (value as string[]) : []} onChange={(v) => set(p, v)} options={p.type === "multi" ? p.options : []} label={p.label} />);
    case "json":
      return stacked(<pre className="max-h-24 overflow-auto rounded-[5px] border border-line bg-paper-2 px-2 py-1 font-mono text-[10.5px] text-ink-3">{formatValue(p, value)}</pre>);
  }
}
