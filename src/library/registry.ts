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

/** lower-case words, accents folded: "Main-street café" → ["main", "street", "cafe"] */
const wordsOf = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/** a query word and its singular: "trees" → tree, "benches" → bench, "nurseries" → nursery */
function formsOf(w: string): string[] {
  const stem = w.length > 3 ? (/ies$/.test(w) ? w.slice(0, -3) + "y" : /(ch|sh|ss|x|z)es$/.test(w) ? w.slice(0, -2) : /[^s]s$/.test(w) ? w.slice(0, -1) : w) : w;
  return stem !== w ? [w, stem] : [w];
}

interface SearchIdx {
  name: string[];
  tags: string[];
  desc: string[];
  /** name and each tag as word strings, for phrase matches ("street tree") */
  phrases: string[];
}
const IDX = new Map<string, SearchIdx>();
function idxOf(d: PrimitiveDef): SearchIdx {
  let x = IDX.get(d.id);
  if (!x) {
    const tags = d.tags ?? [];
    x = { name: wordsOf(d.name), tags: tags.flatMap(wordsOf), desc: wordsOf(`${d.id} ${d.category} ${d.description}`), phrases: [d.name, ...tags].map((t) => wordsOf(t).join(" ")) };
    IDX.set(d.id, x);
  }
  return x;
}

/** how a word list matches a query word: 2 = a whole word, 1 = the start of a word, 0 = not at all ("tree" is not in "street") */
function hit(words: string[], forms: string[]): number {
  let best = 0;
  for (const w of words)
    for (const f of forms) {
      if (w === f) return 2;
      if (w.startsWith(f)) best = 1;
    }
  return best;
}

/**
 * Ranked by name, then tags (synonyms), then description; every word of the query must match the
 * start of a word somewhere. A whole word beats a prefix, and the query as a phrase in the name or
 * a tag ("street tree") beats words found apart.
 */
export function searchPrimitives(query: string, limit = 50): PrimitiveDef[] {
  const qw = wordsOf(query);
  if (!qw.length) return listPrimitives().slice(0, limit);
  const phrase = qw.join(" ");
  const scored: { d: PrimitiveDef; s: number }[] = [];
  for (const d of DEFS.values()) {
    const x = idxOf(d);
    let s = 0;
    let all = true;
    for (let i = 0; i < qw.length && all; i++) {
      const forms = formsOf(qw[i]);
      const n = hit(x.name, forms);
      if (n) {
        s += n === 2 ? 5 : 4;
        if (forms.some((f) => x.name[0]?.startsWith(f))) s += 0.5;
        continue;
      }
      const t = hit(x.tags, forms);
      if (t) {
        s += t === 2 ? 3 : 2.5;
        continue;
      }
      const ds = hit(x.desc, forms);
      if (ds) s += ds === 2 ? 1.2 : 1;
      else all = false;
    }
    if (!all) continue;
    if (qw.length > 1 && x.phrases.some((p) => p === phrase || p.startsWith(phrase + " ") || p.startsWith(phrase) || p.includes(" " + phrase))) s += 3;
    scored.push({ d, s });
  }
  return scored.sort((a, b) => b.s - a.s || a.d.name.length - b.d.name.length || a.d.name.localeCompare(b.d.name)).slice(0, limit).map((x) => x.d);
}

export function defaultParams(def: PrimitiveDef): ParamValues {
  const out: ParamValues = {};
  for (const p of def.params) out[p.key] = p.default !== null && typeof p.default === "object" ? JSON.parse(JSON.stringify(p.default)) : p.default;
  return out;
}

/** whether a param applies given the other values (its `when` condition) */
export function paramActive(p: ParamSpec, values: ParamValues): boolean {
  return !p.when || p.when.in.includes(values[p.when.key] as string | number | boolean);
}

export interface ParamIssue {
  key: string;
  /** unknown: no such parameter · invalid: value rejected (default kept) · clamped: coerced into range · filtered: some list values dropped */
  kind: "unknown" | "invalid" | "clamped" | "filtered";
  message: string;
}

/**
 * Merge `input` over the defaults, coercing and clamping each value to its spec. Unknown keys
 * and invalid values are reported, never silently kept. `errors` holds every message; `issues`
 * classifies them (clamped / filtered values were applied, unknown / invalid ones were not).
 */
export function validateParams(def: PrimitiveDef, input: ParamValues = {}, base?: ParamValues): { params: ParamValues; errors: string[]; issues: ParamIssue[] } {
  const params = { ...defaultParams(def), ...(base ?? {}) };
  const issues: ParamIssue[] = [];
  const issue = (key: string, kind: ParamIssue["kind"], message: string) => issues.push({ key, kind, message });
  const specs = new Map(def.params.map((p) => [p.key, p]));
  for (const [k, v] of Object.entries(input ?? {})) {
    const p = specs.get(k);
    if (!p) {
      issue(k, "unknown", `unknown parameter "${k}" for ${def.id}`);
      continue;
    }
    if (v === undefined || v === null) continue;
    switch (p.type) {
      case "number":
      case "integer": {
        let n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
        if (!Number.isFinite(n)) {
          issue(k, "invalid", `${k}: expected a number`);
          break;
        }
        if (p.type === "integer") n = Math.round(n);
        if (p.min !== undefined && n < p.min) (issue(k, "clamped", `${k}: ${n} is below the minimum ${p.min}; using ${p.min}`), (n = p.min));
        if (p.max !== undefined && n > p.max) (issue(k, "clamped", `${k}: ${n} is above the maximum ${p.max}; using ${p.max}`), (n = p.max));
        params[k] = n;
        break;
      }
      case "enum": {
        const o = p.options.find((o) => o.value === v) ?? (typeof v === "string" ? p.options.find((o) => o.value.toLowerCase() === v.toLowerCase() || o.label.toLowerCase() === v.toLowerCase()) : undefined);
        if (o) params[k] = o.value;
        else issue(k, "invalid", `${k}: "${String(v)}" is not one of ${p.options.map((o) => o.value).join(", ")}`);
        break;
      }
      case "boolean":
        if (typeof v === "boolean") params[k] = v;
        else if (v === "true" || v === 1 || v === "1") params[k] = true;
        else if (v === "false" || v === 0 || v === "0") params[k] = false;
        else issue(k, "invalid", `${k}: expected true or false`);
        break;
      case "color": {
        const c = typeof v === "string" ? normColor(v) : Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number") ? "#" + v.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("") : null;
        if (c) params[k] = c;
        else issue(k, "invalid", `${k}: expected a colour like #a1b2c3`);
        break;
      }
      case "text": {
        const t = String(v);
        const max = p.maxLength ?? 200;
        if (t.length > max) issue(k, "clamped", `${k}: truncated to ${max} characters`);
        params[k] = t.slice(0, max);
        break;
      }
      case "multi": {
        const arr = Array.isArray(v) ? v : [v];
        const ok = arr.filter((x) => p.options.some((o) => o.value === x));
        if (ok.length !== arr.length) issue(k, "filtered", `${k}: ignored values not in ${p.options.map((o) => o.value).join(", ")}`);
        params[k] = ok;
        break;
      }
      case "json":
        try {
          params[k] = typeof v === "string" ? JSON.parse(v) : JSON.parse(JSON.stringify(v));
        } catch {
          issue(k, "invalid", `${k}: expected JSON${p.shape ? ` (${p.shape})` : ""}`);
        }
        break;
    }
  }
  return { params, errors: issues.map((i) => i.message), issues };
}

const NAMED: Record<string, string> = { white: "#ffffff", black: "#1a1a1a", red: "#c0392b", green: "#3c8d40", blue: "#2e6db4", yellow: "#e8c547", orange: "#e67e22", grey: "#8c8c8c", gray: "#8c8c8c", brown: "#8b5a2b", beige: "#d8c8a8", cream: "#f2ead3", brick: "#9c4a35", terracotta: "#c46a45", sand: "#d9c49b", navy: "#24395e", teal: "#2a8c8c", purple: "#7a4a9a", pink: "#e59ab0" };

/** "#abc", "#aabbcc", "aabbcc" or a basic colour name → "#aabbcc" */
export function normColor(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return "#" + h;
}

/** "#rrggbb" → [r, g, b] (0–255) */
export function hexToRgb(hex: string): [number, number, number] {
  const c = normColor(hex) ?? "#888888";
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

/** one line per parameter for compact listings: "floors: integer 1–80 floors = 6" */
export function paramSummary(p: ParamSpec): string {
  const d = JSON.stringify(p.default);
  switch (p.type) {
    case "number":
    case "integer":
      return `${p.key}: ${p.type}${p.min !== undefined || p.max !== undefined ? ` ${p.min ?? "…"}–${p.max ?? "…"}` : ""}${p.unit ? ` ${p.unit}` : ""} = ${d}`;
    case "enum":
      return `${p.key}: ${p.options.map((o) => o.value).join("|")} = ${d}`;
    case "multi":
      return `${p.key}: [${p.options.map((o) => o.value).join("|")}] = ${d}`;
    case "json":
      return `${p.key}: json${p.shape ? ` (${p.shape})` : ""}`;
    default:
      return `${p.key}: ${p.type} = ${d}`;
  }
}
