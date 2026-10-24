// The library registry: definitions register themselves here; the palette, inspector, agent
// tools and ops read them back. Schema helpers (defaults, validation) are generic over ParamSpec.

import type { Category, ParamSpec, ParamValues, PrimitiveDef } from "./types";

const DEFS = new Map<string, PrimitiveDef>();

export function registerPrimitive(def: PrimitiveDef): PrimitiveDef {
  if (DEFS.has(def.id)) throw new Error(`library: duplicate primitive id ${def.id}`);
  const keys = new Set<string>();
  for (const p of def.params) {
    if (keys.has(p.key)) throw new Error(`library: ${def.id} has duplicate param ${p.key}`);
    keys.add(p.key);
  }
  DEFS.set(def.id, def);
  return def;
}

export function listPrimitives(category?: Category): PrimitiveDef[] {
  const all = [...DEFS.values()];
  return category ? all.filter((d) => d.category === category) : all;
}

export function getPrimitive(id: string): PrimitiveDef | undefined {
  return DEFS.get(id);
}

/** ranked by name, then tags, then description; every word of the query must match somewhere */
export function searchPrimitives(query: string, limit = 50): PrimitiveDef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return listPrimitives().slice(0, limit);
  const scored: { d: PrimitiveDef; s: number }[] = [];
  for (const d of DEFS.values()) {
    const name = d.name.toLowerCase();
    const tags = (d.tags ?? []).join(" ").toLowerCase();
    const desc = `${d.id} ${d.category} ${d.description}`.toLowerCase();
    let s = 0;
    let all = true;
    for (const w of words) {
      if (name.includes(w)) s += name.startsWith(w) ? 4 : 3;
      else if (tags.includes(w)) s += 2;
      else if (desc.includes(w)) s += 1;
      else all = false;
    }
    if (all) scored.push({ d, s });
  }
  return scored.sort((a, b) => b.s - a.s || a.d.name.localeCompare(b.d.name)).slice(0, limit).map((x) => x.d);
}

export function defaultParams(def: PrimitiveDef): ParamValues {
  const out: ParamValues = {};
  for (const p of def.params) out[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
  return out;
}

/** whether a param applies given the other values (its `when` condition) */
export function paramActive(p: ParamSpec, values: ParamValues): boolean {
  return !p.when || p.when.in.includes(values[p.when.key] as string | number | boolean);
}

/**
 * Merge `input` over the defaults, coercing and clamping each value to its spec. Unknown keys
 * and invalid values are reported, never silently kept.
 */
export function validateParams(def: PrimitiveDef, input: ParamValues = {}): { params: ParamValues; errors: string[] } {
  const params = defaultParams(def);
  const errors: string[] = [];
  const specs = new Map(def.params.map((p) => [p.key, p]));
  for (const [k, v] of Object.entries(input)) {
    const p = specs.get(k);
    if (!p) {
      errors.push(`unknown parameter "${k}" for ${def.id}`);
      continue;
    }
    if (v === undefined || v === null) continue;
    switch (p.type) {
      case "number":
      case "integer": {
        let n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) {
          errors.push(`${k}: expected a number`);
          break;
        }
        if (p.type === "integer") n = Math.round(n);
        if (p.min !== undefined && n < p.min) (errors.push(`${k}: ${n} is below the minimum ${p.min}; using ${p.min}`), (n = p.min));
        if (p.max !== undefined && n > p.max) (errors.push(`${k}: ${n} is above the maximum ${p.max}; using ${p.max}`), (n = p.max));
        params[k] = n;
        break;
      }
      case "enum":
        if (p.options.some((o) => o.value === v)) params[k] = v;
        else errors.push(`${k}: "${String(v)}" is not one of ${p.options.map((o) => o.value).join(", ")}`);
        break;
      case "boolean":
        params[k] = v === true || v === "true" || v === 1;
        break;
      case "color":
        if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) params[k] = v.toLowerCase();
        else errors.push(`${k}: expected a colour like #a1b2c3`);
        break;
      case "text":
        params[k] = String(v).slice(0, p.maxLength ?? 200);
        break;
      case "multi": {
        const arr = Array.isArray(v) ? v : [v];
        const ok = arr.filter((x) => p.options.some((o) => o.value === x));
        if (ok.length !== arr.length) errors.push(`${k}: ignored values not in ${p.options.map((o) => o.value).join(", ")}`);
        params[k] = ok;
        break;
      }
    }
  }
  return { params, errors };
}
