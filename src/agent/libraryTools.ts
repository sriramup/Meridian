// Agent tools for the primitive library: search / describe definitions, place (with batches and
// layouts), configure, move / rotate / duplicate / remove instances, and the custom_building /
// custom_prop escape hatches. Every edit goes through the shared commit() in tools.ts, so plan /
// edit modes, zones, approvals and dry runs apply exactly as for every other tool.

import { kerbOffsets } from "@/geometry/crossSection";
import { pointInPoly, polyArea, polyBBox, polyCentroid, rectangle } from "@/geometry/polygon";
import { closestOnPath, offsetPath, pointAt, polyLength } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import { ensureLibrary, getPrimitive, listPrimitives, paramSummary, searchPrimitives, type Category, type ParamSpec, type PrimitiveDef } from "@/library";
import { rt } from "@/state/runtime";
import { OpBuilder } from "@/world/ops/core";
import { duplicateInstance, instanceOf, moveInstance, placePrimitive, reconfigureInstance, removeInstance, rotateInstance, type ConflictMode } from "@/world/ops/library";
import type { Entity, LibraryRef, Polygon, Street, Vec2 } from "@/world/types";
import { resolveArea, resolveLocation, resolveStreets } from "./resolve";
import type { OpResult } from "@/world/ops/core";
import type { ToolContext, ToolOutput } from "./tools";

export { LIBRARY_TOOL_DEFS } from "./libraryToolDefs";

type In = Record<string, any>;

/** the shared commit() of tools.ts (imported lazily: tools.ts spreads LIBRARY_TOOLS, so a static import would be circular) */
async function commit(res: OpResult, title: string, ctx: ToolContext): Promise<ToolOutput> {
  const t = await import("./tools");
  return t.commit(res, title, ctx);
}
const actor = { author: "agent" as const };
const MAX_PLACEMENTS = 600;

function err(title: string, message: string): ToolOutput {
  return { content: { error: message }, display: { title, detail: message, status: "error" }, isError: true };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const pt = (p: Vec2) => [r1(p[0]), r1(p[1])];
const deg = (rad: number) => (rad * 180) / Math.PI;
const headingTo = (from: Vec2, to: Vec2) => ((deg(Math.atan2(to[1] - from[1], to[0] - from[0])) % 360) + 360) % 360;

// ---------------------------------------------------------------- feature summaries (used by find_features / get_feature)

function libOf(e: Entity): LibraryRef | undefined {
  return "lib" in e ? (e as { lib?: LibraryRef }).lib : undefined;
}

/** compact library fields for find_features rows */
export function libraryBrief(e: Entity): Record<string, unknown> {
  const lib = libOf(e);
  return lib ? { library: { def: lib.def, instance: lib.instance, ...(lib.primary ? { primary: true } : {}) } } : {};
}

/** full library fields for get_feature: definition, parameters, placement and sibling features */
export function libraryDetail(e: Entity): Record<string, unknown> {
  const lib = libOf(e);
  if (!lib) return {};
  ensureLibrary();
  const info = instanceOf(rt().world, e.id);
  const def = getPrimitive(lib.def);
  return { library: { def: lib.def, def_name: def?.name, category: def?.category, instance: lib.instance, primary: !!lib.primary, params: lib.params, placement: { ...(lib.placement.at ? { at: pt(lib.placement.at) } : {}), ...(lib.placement.rotation != null ? { rotation: lib.placement.rotation } : {}), ...(lib.placement.site ? { site_m2: Math.round(polyArea(lib.placement.site)) } : {}), ...(lib.placement.path ? { path_points: lib.placement.path.length } : {}) }, features: info?.entities.slice(0, 40), feature_count: info?.entities.length, hint: "configure with these params keys to change it" } };
}

/** find_features where{def, category, instance} */
export function libraryMatch(e: Entity, W: Record<string, unknown>): boolean {
  const lib = libOf(e);
  if (!lib) return false;
  if (W.instance && lib.instance !== W.instance) return false;
  if (W.def && lib.def !== W.def && !lib.def.startsWith(String(W.def) + ".") && !lib.def.includes(String(W.def))) return false;
  if (W.category) {
    ensureLibrary();
    if (getPrimitive(lib.def)?.category !== W.category) return false;
  }
  return true;
}

// ---------------------------------------------------------------- definitions

function compactDef(d: PrimitiveDef) {
  return { id: d.id, name: d.name, category: d.category, placement: d.placement, description: d.description, params: d.params.map(paramSummary) };
}

function fullParam(p: ParamSpec) {
  const out: Record<string, unknown> = { key: p.key, label: p.label, type: p.type, default: p.default };
  if (p.description) out.description = p.description;
  if (p.group) out.group = p.group;
  if (p.when) out.only_when = p.when;
  if (p.type === "number" || p.type === "integer") Object.assign(out, { min: p.min, max: p.max, step: p.step, unit: p.unit });
  if (p.type === "enum" || p.type === "multi") out.options = p.options.map((o) => ("description" in o && o.description ? `${o.value} (${o.description})` : o.value));
  if (p.type === "json" && p.shape) out.shape = p.shape;
  if (p.type === "text" && p.maxLength) out.max_length = p.maxLength;
  return out;
}

// ---------------------------------------------------------------- placement resolution

interface Slot {
  at?: Vec2;
  rotation?: number;
  site?: Polygon;
  path?: Vec2[];
}

const loc = (x: unknown): Vec2 => resolveLocation(x as never).p;
const areaPoly = (x: unknown): Polygon => resolveArea(x as never).poly;
const spacingOf = (s: unknown, d: number): [number, number] => (Array.isArray(s) ? [Number(s[0]) || d, Number(s[1]) || d] : [Number(s) || d, Number(s) || d]);

/** deterministic PRNG for scatter layouts */
function rng(seed: number) {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a ^= a << 13;
    a ^= a >>> 17;
    a ^= a << 5;
    return ((a >>> 0) % 1_000_000) / 1_000_000;
  };
}

function rotateAbout(c: Vec2, v: Vec2, angDeg: number): Vec2 {
  const a = (angDeg * Math.PI) / 180;
  return [c[0] + v[0] * Math.cos(a) - v[1] * Math.sin(a), c[1] + v[0] * Math.sin(a) + v[1] * Math.cos(a)];
}

/** expand a layout into anchor points with headings */
function layoutSlots(L: In): { slots: Slot[]; notes: string[] } {
  const notes: string[] = [];
  const out: Slot[] = [];
  const t = L.type as string;
  if (t === "grid") {
    const c = loc(L.center ?? L.from);
    const rows = Math.max(1, Math.round(L.rows ?? 1)),
      cols = Math.max(1, Math.round(L.cols ?? 1));
    const [dx, dy] = spacingOf(L.spacing, 20);
    const rot = Number(L.rotation ?? 0);
    for (let r = 0; r < rows; r++)
      for (let k = 0; k < cols; k++) {
        const x = (k - (cols - 1) / 2) * dx + (L.stagger && r % 2 ? dx / 2 : 0);
        const y = (r - (rows - 1) / 2) * dy;
        out.push({ at: rotateAbout(c, [x, y], rot), rotation: rot });
      }
  } else if (t === "row") {
    const path: Vec2[] = L.path ? (L.path as unknown[]).map(loc) : [loc(L.from), loc(L.to)];
    const len = polyLength(path);
    const n = L.count ? Math.max(1, Math.round(L.count)) : Math.max(1, Math.floor(len / (Number(L.spacing) || 10)) + 1);
    for (let k = 0; k < n; k++) {
      const d = n === 1 ? len / 2 : (len * k) / (n - 1);
      const q = pointAt(path, d);
      out.push({ at: q.p, rotation: L.align === false ? 0 : deg(Math.atan2(q.dir[1], q.dir[0])) });
    }
  } else if (t === "ring") {
    const c = loc(L.center);
    const R = Number(L.radius) || 20;
    const n = Math.max(1, Math.round(L.count ?? 8));
    const a0 = Number(L.start_angle ?? 0);
    for (let k = 0; k < n; k++) {
      const a = a0 + (360 * k) / n;
      const p = rotateAbout(c, [R, 0], a);
      const face = (L.face as string) ?? "center";
      // front (+y) towards the centre, away from it, or the long (x) axis along the ring
      out.push({ at: p, rotation: face === "center" || face === "tangent" ? a + 90 : face === "out" ? a - 90 : 0 });
    }
  } else if (t === "scatter") {
    const poly = areaPoly(L.area);
    const n = Math.max(1, Math.min(MAX_PLACEMENTS, Math.round(L.count ?? 10)));
    const minS = Number(L.min_spacing ?? 0);
    const rand = rng(Number(L.seed ?? 1));
    const [x0, y0, x1, y1] = polyBBox(poly);
    let tries = 0;
    while (out.length < n && tries++ < n * 60) {
      const p: Vec2 = [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)];
      if (!pointInPoly(p, poly)) continue;
      if (minS && out.some((s) => dist(s.at!, p) < minS)) continue;
      out.push({ at: p, rotation: L.random_rotation ? rand() * 360 : 0 });
    }
    if (out.length < n) notes.push(`scatter fitted ${out.length} of ${n} positions at ${minS} m minimum spacing`);
  } else if (t === "along_street") {
    const streets: Street[] = resolveStreets(Array.isArray(L.street) ? { street_ids: L.street } : typeof L.street === "string" && rt().world.get(L.street) ? { street_ids: [L.street] } : { street: L.street });
    if (!streets.length) throw new Error(`No street matches ${JSON.stringify(L.street)}`);
    const sides: ("left" | "right")[] = L.side === "left" ? ["left"] : L.side === "right" ? ["right"] : ["left", "right"];
    const spacing = Number(L.spacing) || 15;
    for (const s of streets) {
      const k = kerbOffsets(s.section, s.section.shift ?? 0);
      for (const side of sides) {
        const sign = side === "left" ? 1 : -1;
        const off = L.offset !== undefined ? sign * Math.abs(Number(L.offset)) : side === "left" ? Math.min(k.left + 0.8, k.rowLeft - 0.4) : Math.max(k.right - 0.8, k.rowRight + 0.4);
        const line = offsetPath(s.path, off);
        const len = polyLength(line);
        const a0 = Number(L.start_offset ?? 8),
          a1 = len - Number(L.end_offset ?? 8);
        for (let d = a0; d <= a1 + 1e-6; d += spacing) {
          const q = pointAt(line, d);
          const along = deg(Math.atan2(q.dir[1], q.dir[0]));
          const face = (L.face as string) ?? "street";
          // an item's front is its local +y; facing the street points it at the centreline
          const towards = side === "left" ? along - 180 : along;
          out.push({ at: q.p, rotation: face === "along" ? along : face === "away" ? towards + 180 : towards });
        }
      }
    }
  } else if (t === "fill_area") {
    const poly = areaPoly(L.area);
    const [dx, dy] = spacingOf(L.spacing, 12);
    const margin = Number(L.margin ?? 0);
    const rot = Number(L.rotation ?? 0);
    const c = polyCentroid(poly);
    const [x0, y0, x1, y1] = polyBBox(poly);
    const R = Math.hypot(x1 - x0, y1 - y0) / 2 + Math.max(dx, dy);
    const hex = L.pattern === "hex";
    const rowStep = hex ? dy * 0.866 : dy;
    let row = 0;
    for (let y = -R; y <= R; y += rowStep, row++)
      for (let x = -R; x <= R; x += dx) {
        const p = rotateAbout(c, [x + (hex && row % 2 ? dx / 2 : 0), y], rot);
        if (!pointInPoly(p, poly)) continue;
        if (margin > 0 && poly.some((ring) => closestOnPath(p, [...ring, ring[0]]).d < margin)) continue;
        out.push({ at: p, rotation: rot });
        if (out.length > MAX_PLACEMENTS) break;
      }
  } else throw new Error(`Unknown layout type "${t}"`);
  if (Array.isArray(L.lot)) {
    const [w, d] = [Number(L.lot[0]) || 10, Number(L.lot[1]) || 10];
    for (const s of out) s.site = [rectangle(s.at!, w, d, ((s.rotation ?? 0) * Math.PI) / 180)];
  }
  return { slots: out, notes };
}

interface Item {
  def: PrimitiveDef;
  params: In;
  slot: Slot;
  name?: string;
  index: number;
}

/** turn one tool item (with defaults) into concrete placements */
function expandItem(raw: In, index: number): { items: Item[]; notes: string[]; error?: string } {
  ensureLibrary();
  const defId = raw.def;
  if (!defId) return { items: [], notes: [], error: "missing def (a primitive id from library_search)" };
  const def = getPrimitive(String(defId));
  if (!def) {
    const near = searchPrimitives(String(defId).replace(/[._]/g, " "), 3).map((d) => d.id);
    return { items: [], notes: [], error: `unknown primitive "${defId}"${near.length ? ` — did you mean ${near.join(", ")}?` : ""}` };
  }
  const base: Slot = {};
  if (raw.at !== undefined) base.at = loc(raw.at);
  if (raw.site !== undefined) base.site = areaPoly(raw.site);
  if (raw.path !== undefined) base.path = (raw.path as unknown[]).map(loc);
  if (raw.rotation !== undefined) base.rotation = Number(raw.rotation);
  const params = (raw.params ?? {}) as In;
  let slots: Slot[] = [base];
  const notes: string[] = [];
  if (raw.layout) {
    const L = layoutSlots(raw.layout as In);
    notes.push(...L.notes);
    slots = L.slots.map((s) => ({ ...base, ...s, rotation: (s.rotation ?? 0) + (base.rotation ?? 0) }));
    if (!slots.length) return { items: [], notes, error: "the layout produced no positions" };
  }
  const items: Item[] = slots.map((s) => {
    const slot = { ...s };
    // front (+y) towards the target
    if (raw.face !== undefined && slot.at) slot.rotation = headingTo(slot.at, loc(raw.face)) - 90;
    if (def.placement === "polygon" && !slot.site && slot.at && Array.isArray(raw.size)) slot.site = [rectangle(slot.at, Number(raw.size[0]), Number(raw.size[1]), ((slot.rotation ?? 0) * Math.PI) / 180)];
    if (def.placement === "point" && !slot.at && slot.site) slot.at = polyCentroid(slot.site);
    if (def.placement === "path" && !slot.path && slot.site) slot.path = [...slot.site[0], slot.site[0][0]];
    return { def, params, slot, name: raw.name, index };
  });
  return { items, notes };
}

async function placeItems(rawItems: In[], onConflict: ConflictMode | undefined, ctx: ToolContext, title: string): Promise<ToolOutput> {
  const R = rt();
  const b = new OpBuilder(R.world, "agent");
  const placed: { item: number; instance: string; def: string; primary?: string }[] = [];
  const failures: { item: number; at?: unknown; error: string }[] = [];
  const notes: string[] = [];
  let total = 0;
  for (let k = 0; k < rawItems.length; k++) {
    let ex: ReturnType<typeof expandItem>;
    try {
      ex = expandItem(rawItems[k], k);
    } catch (e) {
      failures.push({ item: k, error: (e as Error).message });
      continue;
    }
    if (ex.error) {
      failures.push({ item: k, error: ex.error });
      continue;
    }
    notes.push(...ex.notes);
    for (const it of ex.items) {
      if (++total > MAX_PLACEMENTS) {
        failures.push({ item: k, error: `more than ${MAX_PLACEMENTS} placements in one call; split the request` });
        break;
      }
      const r = placePrimitive(R.world, { def: it.def, params: it.params, ...it.slot, name: it.name, onConflict }, actor, b);
      if (r.ok && r.instance) placed.push({ item: k, instance: r.instance, def: it.def.id, primary: (r.data?.primary as string) ?? r.created[0] });
      else failures.push({ item: k, at: it.slot.at ? pt(it.slot.at) : undefined, error: r.error ?? "failed" });
    }
  }
  if (!placed.length) {
    const msg = failures.length ? failures.slice(0, 8).map((f) => `item ${f.item}${f.at ? ` at ${JSON.stringify(f.at)}` : ""}: ${f.error}`).join("; ") : "nothing to place";
    return err(title, msg);
  }
  // collapse per-item summaries when many instances were placed
  if (placed.length > 6) {
    const byDef = new Map<string, number>();
    for (const p of placed) byDef.set(p.def, (byDef.get(p.def) ?? 0) + 1);
    const detail = b.report.summary.filter((s) => !/^Placed /.test(s));
    b.report.summary = [`Placed ${placed.length} instances: ${[...byDef].map(([d, n]) => `${n} × ${getPrimitive(d)?.name ?? d}`).join(", ")}`, ...dedupeLines(detail).slice(0, 12)];
  }
  if (failures.length) b.warn(`${failures.length} placement${failures.length > 1 ? "s" : ""} failed: ${failures.slice(0, 5).map((f) => `item ${f.item}${f.at ? ` at ${JSON.stringify(f.at)}` : ""}: ${f.error}`).join("; ")}${failures.length > 5 ? "; …" : ""}`);
  for (const n of notes) b.warn(n);
  b.data.instances = placed.slice(0, 60);
  if (placed.length > 60) b.data.instances_total = placed.length;
  if (failures.length) b.data.failures = failures.slice(0, 30);
  const label = placed.length === 1 ? `Place ${rawItems[placed[0].item].name ?? getPrimitive(placed[0].def)?.name}` : `Place ${placed.length} library instances`;
  return commit(b.finish(label), title, ctx);
}

function dedupeLines(lines: string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const key = l.replace(/\d[\d,.]*/g, "#");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const key = l.replace(/\d[\d,.]*/g, "#");
    if (seen.has(key)) continue;
    seen.add(key);
    const n = counts.get(key)!;
    out.push(n > 1 ? `${l} (×${n} similar)` : l);
  }
  return out;
}

function instanceIds(ids: unknown): string[] {
  return (Array.isArray(ids) ? ids : ids ? [ids] : []).map(String);
}

// ---------------------------------------------------------------- executors

export const LIBRARY_TOOLS: Record<string, (i: In, ctx: ToolContext) => Promise<ToolOutput>> = {
  async library_search(i) {
    ensureLibrary();
    const q = String(i.query ?? "").trim();
    const cat = i.category as Category | undefined;
    if (!q && !cat) {
      const counts: Record<string, number> = {};
      for (const d of listPrimitives()) counts[d.category] = (counts[d.category] ?? 0) + 1;
      return { content: { total: listPrimitives().length, categories: counts, hint: "search with a query or category; custom.building and custom.prop build anything not in the catalog" }, display: { title: "Library categories", detail: Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(" · "), status: "ok" } };
    }
    let defs = q ? searchPrimitives(q, 200) : listPrimitives(cat);
    if (cat) defs = defs.filter((d) => d.category === cat);
    // loose fallback: any word matches
    if (!defs.length && q) {
      const seen = new Set<string>();
      for (const w of q.split(/\s+/)) for (const d of searchPrimitives(w, 20)) if (!seen.has(d.id) && (!cat || d.category === cat)) (seen.add(d.id), defs.push(d));
    }
    const limit = Math.min(60, i.limit ?? 15);
    const rows = defs.slice(0, limit).map(compactDef);
    return { content: { total: defs.length, results: rows, ...(defs.length ? {} : { hint: "nothing matched: try other words, a category, or custom.building / custom.prop" }) }, display: { title: `Library: ${defs.length} match${defs.length === 1 ? "" : "es"}${q ? ` for “${q}”` : ""}`, detail: rows.slice(0, 4).map((r) => r.name).join(" · "), status: defs.length ? "ok" : "warn" } };
  },

  async library_describe(i) {
    ensureLibrary();
    const out = instanceIds(i.ids).map((id) => {
      const d = getPrimitive(id);
      if (!d) return { id, error: "unknown primitive" };
      return { id: d.id, name: d.name, category: d.category, placement: d.placement, description: d.description, tags: d.tags, siting: d.siting, params: d.params.map(fullParam) };
    });
    return { content: out, display: { title: `Described ${out.length} primitive${out.length === 1 ? "" : "s"}`, detail: out.map((o: In) => o.name ?? o.id).join(" · "), status: "ok" } };
  },

  async place(i, ctx) {
    const { items, on_conflict, dry_run: _d, ...defaults } = i;
    const list: In[] = Array.isArray(items) && items.length ? items.map((it: In) => ({ ...defaults, ...it, params: { ...(defaults.params ?? {}), ...(it.params ?? {}) } })) : [defaults];
    return placeItems(list, on_conflict, ctx, "Place");
  },

  async configure(i, ctx) {
    const w = rt().world;
    const b = new OpBuilder(w, "agent");
    const jobs: { id: string; params: In }[] = Array.isArray(i.items) && i.items.length ? i.items.map((x: In) => ({ id: String(x.id), params: x.params ?? {} })) : instanceIds(i.ids).map((id) => ({ id, params: i.params ?? {} }));
    if (!jobs.length) return err("Configure", "give ids + params, or items:[{id, params}]");
    const done = new Set<string>();
    const errors: string[] = [];
    let n = 0;
    for (const j of jobs) {
      const info = instanceOf(w, j.id);
      if (!info) {
        errors.push(`${j.id}: not a library instance`);
        continue;
      }
      if (done.has(info.instance)) continue;
      done.add(info.instance);
      const r = reconfigureInstance(w, info.instance, j.params, actor, { onConflict: i.on_conflict }, b);
      if (r.ok) n++;
      else errors.push(`${j.id}: ${r.error}`);
    }
    if (!n) return err("Configure", errors.join("; "));
    for (const e of errors) b.warn(e);
    b.data.instances = [...done];
    return commit(b.finish(n === 1 ? `Configure ${getPrimitive(instanceOf(w, [...done][0])?.def ?? "")?.name ?? "instance"}` : `Configure ${n} instances`), "Configure", ctx);
  },

  async move_instance(i, ctx) {
    const w = rt().world;
    const ids = instanceIds(i.ids);
    let by: Vec2 | null = Array.isArray(i.by) ? [Number(i.by[0]), Number(i.by[1])] : null;
    if (!by && i.to !== undefined) {
      const info = ids.map((id) => instanceOf(w, id)).find(Boolean);
      if (!info) return err("Move", "no library instance among ids");
      const pl = info.placement;
      const a = pl.at ?? (pl.site ? polyCentroid(pl.site) : pl.path ? pl.path[Math.floor(pl.path.length / 2)] : null);
      if (!a) return err("Move", "instance has no anchor");
      const t = loc(i.to);
      by = [t[0] - a[0], t[1] - a[1]];
    }
    if (!by) return err("Move", "give by:[dx,dy] or to");
    return commit(moveInstance(w, ids, by, actor, { onConflict: i.on_conflict }), "Move", ctx);
  },

  async rotate_instance(i, ctx) {
    const w = rt().world;
    return commit(rotateInstance(w, instanceIds(i.ids), Number(i.degrees), actor, { about: i.about !== undefined ? loc(i.about) : undefined, onConflict: i.on_conflict }), "Rotate", ctx);
  },

  async duplicate_instance(i, ctx) {
    const w = rt().world;
    const off: Vec2 = [Number(i.offset?.[0] ?? 0), Number(i.offset?.[1] ?? 0)];
    if (!off[0] && !off[1]) return err("Duplicate", "offset must move the copy, e.g. [30, 0]");
    return commit(duplicateInstance(w, instanceIds(i.ids), off, actor, { count: i.count, params: i.params, onConflict: i.on_conflict }), "Duplicate", ctx);
  },

  async remove_instance(i, ctx) {
    return commit(removeInstance(rt().world, instanceIds(i.ids), actor), "Remove", ctx);
  },

  async custom_building(i, ctx) {
    const { site, at, rotation, name, params, on_conflict, dry_run: _d, ...rest } = i;
    if (site === undefined && at === undefined) return err("Custom building", "give site (polygon / place) or at + width / depth");
    const item: In = { def: "custom.building", params: { ...rest, ...(params ?? {}), ...(name ? { name } : {}) }, rotation, name };
    if (site !== undefined) {
      item.site = site;
      if (!rest.shape && !(params ?? {}).shape) item.params.shape = "site";
    } else item.at = at;
    return placeItems([item], on_conflict, ctx, "Custom building");
  },

  async custom_prop(i, ctx) {
    const { at, rotation, face, layout, name, dry_run: _d, ...rest } = i;
    return placeItems([{ def: "custom.prop", at, rotation, face, layout, name, params: { ...rest, ...(name ? { name } : {}) } }], undefined, ctx, "Custom object");
  },
};
