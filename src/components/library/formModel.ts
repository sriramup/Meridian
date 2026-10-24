// Pure logic behind the parameter form: which params show (their `when` conditions), how they
// are grouped into sections (basic first, advanced folded under "More options"), which widget
// each one gets, and how raw input is coerced to a valid value. No React here, so it is tested
// directly (tests/library-form.test.ts).

import { paramActive } from "@/library/registry";
import type { EnumParam, NumberParam, ParamSpec, ParamValues } from "@/library/types";

export interface FormSection {
  /** group name; "" for ungrouped params */
  title: string;
  params: ParamSpec[];
}

export interface FormLayout {
  sections: FormSection[];
  advanced: FormSection[];
  /** number of advanced params currently applicable (for the "More options (n)" label) */
  advancedCount: number;
}

/** group active params in first-appearance order of their group; advanced ones go in their own list */
export function layoutForm(specs: ParamSpec[], values: ParamValues): FormLayout {
  const basic = new Map<string, ParamSpec[]>();
  const adv = new Map<string, ParamSpec[]>();
  let advancedCount = 0;
  for (const p of specs) {
    if (!paramActive(p, values)) continue;
    const into = p.advanced ? adv : basic;
    if (p.advanced) advancedCount++;
    const g = p.group ?? "";
    let list = into.get(g);
    if (!list) into.set(g, (list = []));
    list.push(p);
  }
  const toSections = (m: Map<string, ParamSpec[]>) => [...m].map(([title, params]) => ({ title, params }));
  // ungrouped params lead the form
  const sections = toSections(basic).sort((a, b) => (a.title === "" ? -1 : b.title === "" ? 1 : 0));
  return { sections, advanced: toSections(adv), advancedCount };
}

export type Widget = "number" | "slider" | "segmented" | "select" | "switch" | "color" | "text" | "multi";

/** the input a param gets */
export function widgetFor(p: ParamSpec): Widget {
  switch (p.type) {
    case "number":
    case "integer":
      // a bounded, coarse range reads best as a slider with its value; open or fine ranges get a field
      return p.min !== undefined && p.max !== undefined && (p.max - p.min) / (p.step ?? (p.type === "integer" ? 1 : (p.max - p.min) / 100)) <= 200 && p.unit !== "m" && p.unit !== "m²" ? "slider" : "number";
    case "enum":
      return segmentable(p) ? "segmented" : "select";
    case "boolean":
      return "switch";
    case "color":
      return "color";
    case "text":
      return "text";
    case "multi":
      return "multi";
  }
}

/** a few short options fit a segmented control */
export function segmentable(p: EnumParam): boolean {
  if (p.options.length > 4 || p.options.length < 2) return false;
  return p.options.reduce((n, o) => n + o.label.length, 0) <= 26;
}

/** sensible step for a number param */
export function stepOf(p: NumberParam): number {
  if (p.step) return p.step;
  if (p.type === "integer") return 1;
  const span = p.min !== undefined && p.max !== undefined ? p.max - p.min : Math.abs(p.default) * 4 || 10;
  const raw = span / 100;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? mag * 10;
}

/** clamp and round a number to its spec; NaN falls back to the current value */
export function coerceNumber(p: NumberParam, raw: unknown, current: number): number {
  let n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw.replace(/[^0-9.eE+-]/g, "")) : NaN;
  if (!Number.isFinite(n)) return current;
  if (p.type === "integer") n = Math.round(n);
  else {
    const s = stepOf(p);
    // keep the precision of the step (0.05 → 2 decimals) without snapping user values to the grid
    const dec = Math.max(2, Math.min(6, -Math.floor(Math.log10(s)) + 1));
    n = +n.toFixed(dec);
  }
  if (p.min !== undefined) n = Math.max(p.min, n);
  if (p.max !== undefined) n = Math.min(p.max, n);
  return n;
}

/** coerce a raw widget value for any param; invalid input keeps the current value */
export function coerce(p: ParamSpec, raw: unknown, current: unknown): unknown {
  switch (p.type) {
    case "number":
    case "integer":
      return coerceNumber(p, raw, typeof current === "number" ? current : p.default);
    case "enum":
      return p.options.some((o) => o.value === raw) ? raw : current;
    case "boolean":
      return raw === true || raw === "true";
    case "color":
      return typeof raw === "string" && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : current;
    case "text":
      return String(raw ?? "").slice(0, p.maxLength ?? 200);
    case "multi": {
      const arr = Array.isArray(raw) ? raw : [raw];
      // keep option order so the value is stable regardless of click order
      return p.options.map((o) => o.value).filter((v) => arr.includes(v));
    }
  }
}

/** a number with its unit for labels and summaries */
export function formatValue(p: ParamSpec, v: unknown): string {
  switch (p.type) {
    case "number":
    case "integer": {
      const n = typeof v === "number" ? v : p.default;
      const s = stepOf(p);
      const dec = p.type === "integer" ? 0 : Math.max(2, Math.min(3, -Math.floor(Math.log10(s))));
      const txt = n.toLocaleString("en-US", { maximumFractionDigits: dec });
      return p.unit ? (p.unit === "%" || p.unit === "°" ? `${txt}${p.unit}` : `${txt} ${p.unit}`) : txt;
    }
    case "enum":
      return p.options.find((o) => o.value === v)?.label ?? String(v);
    case "boolean":
      return v ? "Yes" : "No";
    case "multi":
      return (Array.isArray(v) ? v : []).map((x) => p.options.find((o) => o.value === x)?.label ?? x).join(", ");
    default:
      return String(v ?? "");
  }
}

/** set one value; params whose `when` no longer holds keep their value but are hidden */
export function withValue(values: ParamValues, p: ParamSpec, raw: unknown): ParamValues {
  return { ...values, [p.key]: coerce(p, raw, values[p.key]) };
}

/** keys whose value differs from the default (for "Reset" and change dots) */
export function changedKeys(specs: ParamSpec[], values: ParamValues): string[] {
  return specs.filter((p) => JSON.stringify(values[p.key]) !== JSON.stringify(p.default)).map((p) => p.key);
}
