// Param spec factories: short, typed helpers so definitions read like a schema table.

import type { BooleanParam, ColorParam, EnumParam, MultiParam, NumberParam, ParamSpec, ParamValues, TextParam } from "../types";

type Opt = { group?: string; advanced?: boolean; description?: string; when?: { key: string; in: (string | number | boolean)[] } };
type NumOpt = Opt & { min?: number; max?: number; step?: number; unit?: string };

export const num = (key: string, label: string, def: number, o: NumOpt = {}): NumberParam => ({ key, label, type: "number", default: def, ...o });
export const int = (key: string, label: string, def: number, o: NumOpt = {}): NumberParam => ({ key, label, type: "integer", default: def, step: 1, ...o });
export const choice = (key: string, label: string, def: string, options: { value: string; label: string; description?: string }[], o: Opt = {}): EnumParam => ({ key, label, type: "enum", default: def, options, ...o });
export const bool = (key: string, label: string, def: boolean, o: Opt = {}): BooleanParam => ({ key, label, type: "boolean", default: def, ...o });
export const color = (key: string, label: string, def: string, o: Opt & { swatches?: string[] } = {}): ColorParam => ({ key, label, type: "color", default: def, ...o });
export const text = (key: string, label: string, def = "", o: Opt & { maxLength?: number } = {}): TextParam => ({ key, label, type: "text", default: def, maxLength: 80, ...o });
export const multi = (key: string, label: string, def: string[], options: { value: string; label: string }[], o: Opt = {}): MultiParam => ({ key, label, type: "multi", default: def, options, ...o });

/** "a_b" → { value: "a_b", label: "A b" } */
export const opts = (...values: string[]) => values.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, " ") }));

/** override defaults (and optionally other fields) of a param list by key; unknown keys throw */
export function withDefaults(specs: ParamSpec[], defaults: ParamValues = {}, patch: Record<string, Partial<ParamSpec>> = {}): ParamSpec[] {
  const keys = new Set(specs.map((s) => s.key));
  for (const k of [...Object.keys(defaults), ...Object.keys(patch)]) if (!keys.has(k)) throw new Error(`library: override for unknown param ${k}`);
  return specs.map((s) => {
    let out = s;
    if (k(defaults, s.key)) out = { ...out, default: defaults[s.key] } as ParamSpec;
    if (patch[s.key]) out = { ...out, ...patch[s.key] } as ParamSpec;
    return out;
  });
}
const k = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** value readers that never return NaN / undefined (generators may be called with partial params) */
export function reader(params: ParamValues, specs: ParamSpec[]) {
  const spec = new Map(specs.map((s) => [s.key, s]));
  const raw = (key: string) => (params[key] !== undefined && params[key] !== null ? params[key] : spec.get(key)?.default);
  return {
    n(key: string, fallback = 0): number {
      const v = Number(raw(key));
      const s = spec.get(key) as NumberParam | undefined;
      if (!Number.isFinite(v)) return Number.isFinite(Number(s?.default)) ? Number(s!.default) : fallback;
      let x = v;
      if (s && (s.type === "number" || s.type === "integer")) {
        if (s.min !== undefined) x = Math.max(s.min, x);
        if (s.max !== undefined) x = Math.min(s.max, x);
        if (s.type === "integer") x = Math.round(x);
      }
      return x;
    },
    s(key: string, fallback = ""): string {
      const v = raw(key);
      const sp = spec.get(key);
      if (sp?.type === "enum" && !sp.options.some((o) => o.value === v)) return sp.default;
      return v === undefined ? fallback : String(v);
    },
    b(key: string): boolean {
      const v = raw(key);
      return v === true || v === "true" || v === 1;
    },
    c(key: string): string {
      const v = raw(key);
      return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : String(spec.get(key)?.default ?? "#cccccc");
    },
    m(key: string): string[] {
      const v = raw(key);
      return Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : [];
    },
  };
}
export type Reader = ReturnType<typeof reader>;
