// SketchPlan: what one vision call reads off a bird's-eye sketch or photo of a plan (whiteboard,
// napkin, printed map). Pure data + functions, shared by the server route (src/app/api/vision),
// the client runtime (src/sketch/attach.ts) and the deterministic builder (src/sketch/build.ts).
//
// Coordinates are NORMALISED IMAGE coordinates: [x, y] with x from 0 (left edge) to 1 (right edge)
// and y from 0 (top edge) to 1 (bottom edge) of the image. The real-world size comes from `extent`;
// the builder maps the unit square onto the canvas (placement: centre, size, rotation).

export type StreetClass = "arterial" | "collector" | "local" | "pedestrian";
export type BlockUse = "residential" | "mixed" | "commercial" | "office" | "civic" | "industrial";
export type Density = "low" | "medium" | "high" | "very_high";
export type AreaKind = "park" | "plaza" | "water" | "green" | "parking" | "forest";
export type FacilityKind =
  | "school"
  | "university"
  | "hospital"
  | "clinic"
  | "station"
  | "fire"
  | "police"
  | "library"
  | "community"
  | "worship"
  | "museum"
  | "market"
  | "supermarket"
  | "stadium"
  | "hotel"
  | "city_hall"
  | "other";
export type TransitKind = "rail" | "metro" | "tram" | "brt" | "bus";

export type Pt = [number, number];

export interface SketchStreet {
  points: Pt[];
  class: StreetClass;
  name?: string;
  /** relative line weight as drawn, 1 (thin) … 5 (thick) */
  weight?: number;
}
export interface SketchBlock {
  poly: Pt[];
  use: BlockUse;
  density?: Density;
  floors?: number;
  label?: string;
}
export interface SketchArea {
  kind: AreaKind;
  /** a closed outline … */
  poly?: Pt[];
  /** … or a centreline with a width (rivers, canals, linear parks) */
  line?: Pt[];
  width_m?: number;
  name?: string;
}
export interface SketchFacility {
  kind: FacilityKind;
  at: Pt;
  /** its site outline when drawn as a box */
  poly?: Pt[];
  label?: string;
}
export interface SketchTransit {
  kind: TransitKind;
  points: Pt[];
  name?: string;
  stations?: Pt[];
}

export interface SketchPlan {
  is_plan: boolean;
  /** why it is not a plan (a selfie, a document, an elevation drawing…) */
  not_plan_reason?: string;
  /** a short name for the place, from a title written on the sketch or what it shows */
  title?: string;
  /** one sentence describing the sketch */
  description?: string;
  extent: {
    width_m: number;
    height_m: number;
    basis: "scale_bar" | "labels" | "block_sizes" | "street_spacing" | "guess";
    confidence: number;
  };
  /** direction of a drawn north arrow, degrees clockwise from image-up; null when none is drawn */
  north_deg?: number | null;
  default_use?: BlockUse;
  default_density?: Density;
  streets: SketchStreet[];
  blocks: SketchBlock[];
  areas: SketchArea[];
  facilities: SketchFacility[];
  transit: SketchTransit[];
  notes: string[];
}

// ---------------------------------------------------------------- tool schema (forced tool call)

const pt = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] normalised image coordinates: x 0 = left edge … 1 = right edge, y 0 = top edge … 1 = bottom edge" };
const line = { type: "array", items: pt, minItems: 2 };
const ring = { type: "array", items: pt, minItems: 3 };
const DENSITY = ["low", "medium", "high", "very_high"];
const USES = ["residential", "mixed", "commercial", "office", "civic", "industrial"];

export const SKETCH_TOOL_NAME = "report_sketch_plan";

/** the one tool the vision call must call: the plan as structured data (no free text parsed) */
export const SKETCH_TOOL = {
  name: SKETCH_TOOL_NAME,
  description: "Report the urban plan read from the image as structured data. Call it exactly once. If the image is not a bird's-eye plan or map of a place, set is_plan false with a short reason and leave the lists empty.",
  input_schema: {
    type: "object",
    properties: {
      is_plan: { type: "boolean", description: "true when the image is a bird's-eye (plan view) sketch, diagram or map of streets / blocks / a site" },
      not_plan_reason: { type: "string", description: "when is_plan is false: what the image shows instead, in a few words" },
      title: { type: "string", description: "a short name for the place: a title written on the sketch, else a descriptive one ('Riverside quarter')" },
      description: { type: "string", description: "one sentence: what the plan shows" },
      extent: {
        type: "object",
        description: "estimated real-world size of the whole image. Use a scale bar or written dimensions when present; else infer from typical sizes (urban blocks 60–150 m, local street spacing 80–150 m, a school site 100–200 m, a football pitch 105 m).",
        properties: {
          width_m: { type: "number" },
          height_m: { type: "number" },
          basis: { type: "string", enum: ["scale_bar", "labels", "block_sizes", "street_spacing", "guess"] },
          confidence: { type: "number", description: "0–1" },
        },
        required: ["width_m", "height_m", "basis", "confidence"],
      },
      north_deg: { type: ["number", "null"], description: "direction of a drawn north arrow in degrees clockwise from image-up (0 = up); null when none is drawn" },
      default_use: { type: "string", enum: USES, description: "dominant land use of unlabelled blocks" },
      default_density: { type: "string", enum: DENSITY, description: "overall intensity implied by the sketch (labels, building marks, block sizes)" },
      streets: {
        type: "array",
        description: "every drawn street as a centreline polyline (follow curves with extra points; extend ends to the street they meet). Class from line weight and labels: thick / double lines, 'avenue', 'boulevard', 'highway' → arterial; medium → collector; thin → local; dashed or 'walk' / 'promenade' → pedestrian.",
        items: {
          type: "object",
          properties: { points: line, class: { type: "string", enum: ["arterial", "collector", "local", "pedestrian"] }, name: { type: "string" }, weight: { type: "number", description: "relative drawn line weight 1–5" } },
          required: ["points", "class"],
        },
      },
      blocks: {
        type: "array",
        description: "blocks or parcels that are labelled, hatched or otherwise distinguished (use, density, heights). Unlabelled blocks between streets may be omitted: they are filled with the default use.",
        items: {
          type: "object",
          properties: { poly: ring, use: { type: "string", enum: USES }, density: { type: "string", enum: DENSITY }, floors: { type: "number" }, label: { type: "string" } },
          required: ["poly", "use"],
        },
      },
      areas: {
        type: "array",
        description: "open space and water: parks, greens, plazas / squares, rivers, lakes, forests, parking. Rivers and canals as a centreline `line` with `width_m`; everything else as an outline `poly`.",
        items: {
          type: "object",
          properties: { kind: { type: "string", enum: ["park", "plaza", "water", "green", "parking", "forest"] }, poly: ring, line, width_m: { type: "number" }, name: { type: "string" } },
          required: ["kind"],
        },
      },
      facilities: {
        type: "array",
        description: "labelled buildings or symbols: school, hospital, station, fire, police, library…; `at` is the centre, `poly` the drawn box when there is one",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["school", "university", "hospital", "clinic", "station", "fire", "police", "library", "community", "worship", "museum", "market", "supermarket", "stadium", "hotel", "city_hall", "other"] },
            at: pt,
            poly: ring,
            label: { type: "string" },
          },
          required: ["kind", "at"],
        },
      },
      transit: {
        type: "array",
        description: "rail, metro, tram or bus lines drawn on the plan (often hatched or dashed with station dots)",
        items: { type: "object", properties: { kind: { type: "string", enum: ["rail", "metro", "tram", "brt", "bus"] }, points: line, name: { type: "string" }, stations: { type: "array", items: pt } }, required: ["kind", "points"] },
      },
      notes: { type: "array", items: { type: "string" }, description: "other text written on the sketch (verbatim, short)" },
    },
    required: ["is_plan", "extent", "streets", "blocks", "areas", "facilities", "transit", "notes"],
  },
} as const;

// ---------------------------------------------------------------- validation / normalisation

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
const str = (x: unknown, max = 80): string | undefined => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : undefined);
const oneOf = <T extends string>(x: unknown, xs: readonly T[], d: T): T => (typeof x === "string" && (xs as readonly string[]).includes(x) ? (x as T) : d);
const nn = <T>(x: T | null): x is T => x !== null;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function point(x: unknown): Pt | null {
  if (!Array.isArray(x) || x.length < 2) return null;
  const a = Number(x[0]),
    b = Number(x[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // tolerate 0–100 (percent) and pixel-ish coordinates mistakenly returned: anything > 1.5 is rescaled later
  return [a, b];
}
function points(x: unknown, min: number): Pt[] | null {
  if (!Array.isArray(x)) return null;
  const out = x.map(point).filter((p): p is Pt => !!p);
  // drop consecutive duplicates
  const dedup = out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-4);
  return dedup.length >= min ? dedup : null;
}

const USE_LIST = USES as BlockUse[];
const DENSITY_LIST = DENSITY as Density[];
const AREA_LIST: AreaKind[] = ["park", "plaza", "water", "green", "parking", "forest"];
const FAC_LIST: FacilityKind[] = ["school", "university", "hospital", "clinic", "station", "fire", "police", "library", "community", "worship", "museum", "market", "supermarket", "stadium", "hotel", "city_hall", "other"];
const TRANSIT_LIST: TransitKind[] = ["rail", "metro", "tram", "brt", "bus"];

/** a facility kind from a free label ("SCHOOL", "Elem. sch", "Hosp.") */
export function facilityFromLabel(label: string | undefined): FacilityKind | null {
  const t = (label ?? "").toLowerCase();
  if (!t) return null;
  if (/univ|college|campus/.test(t)) return "university";
  if (/school|sch\b|elem|academy|kindergarten/.test(t)) return "school";
  if (/hospital|hosp\b|medical cent/.test(t)) return "hospital";
  if (/clinic|health/.test(t)) return "clinic";
  if (/station|stn\b|metro|subway|depot|terminal/.test(t)) return "station";
  if (/fire/.test(t)) return "fire";
  if (/police|sheriff/.test(t)) return "police";
  if (/librar/.test(t)) return "library";
  if (/community|rec(reation)? cent|civic cent/.test(t)) return "community";
  if (/church|mosque|temple|synagogue|chapel/.test(t)) return "worship";
  if (/museum|gallery/.test(t)) return "museum";
  if (/market|bazaar/.test(t)) return "market";
  if (/grocery|supermarket/.test(t)) return "supermarket";
  if (/stadium|arena/.test(t)) return "stadium";
  if (/hotel/.test(t)) return "hotel";
  if (/city hall|town hall/.test(t)) return "city_hall";
  return null;
}

/**
 * Coerce whatever the model returned into a valid SketchPlan: clamp coordinates into the unit square
 * (rescaling percent / pixel coordinates), drop malformed features, bound the extent to something
 * buildable (100 m … 4 km a side) and keep the lists to sensible sizes.
 */
export function normalisePlan(raw: unknown): SketchPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const isPlan = r.is_plan !== false;
  // detect the coordinate scale: if any coordinate exceeds 1.5, assume percent (≤ 100) or pixels
  let maxC = 0;
  const scan = (v: unknown) => {
    if (Array.isArray(v)) {
      if (v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") maxC = Math.max(maxC, Math.abs(v[0]), Math.abs(v[1]));
      else v.forEach(scan);
    } else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => k !== "extent" && k !== "north_deg" && scan(x));
  };
  for (const k of ["streets", "blocks", "areas", "facilities", "transit"]) scan(r[k]);
  const k = maxC <= 1.5 ? 1 : maxC <= 100.5 ? 100 : maxC;
  const P = (p: Pt): Pt => [r3(clamp01(p[0] / k)), r3(clamp01(p[1] / k))];
  const PS = (x: unknown, min: number) => points(x, min)?.map(P) ?? null;

  const ex = (r.extent ?? {}) as Record<string, unknown>;
  let w = num(ex.width_m, 0),
    h = num(ex.height_m, 0);
  if (!(w > 0) && !(h > 0)) w = h = 800;
  else if (!(w > 0)) w = h;
  else if (!(h > 0)) h = w;
  const big = Math.max(w, h);
  const s = big > 4000 ? 4000 / big : big < 100 ? 100 / big : 1;
  w *= s;
  h *= s;

  const streets: SketchStreet[] = (Array.isArray(r.streets) ? r.streets : [])
    .map((x: any) => {
      const ps = PS(x?.points, 2);
      if (!ps) return null;
      const weight = typeof x?.weight === "number" ? Math.max(1, Math.min(5, x.weight)) : undefined;
      return { points: ps, class: oneOf(x?.class, ["arterial", "collector", "local", "pedestrian"] as StreetClass[], weight && weight >= 4 ? "arterial" : "local"), ...(str(x?.name) ? { name: str(x?.name) } : {}), ...(weight ? { weight } : {}) };
    })
    .filter(nn)
    .slice(0, 80);
  const blocks: SketchBlock[] = (Array.isArray(r.blocks) ? r.blocks : [])
    .map((x: any) => {
      const ps = PS(x?.poly, 3);
      if (!ps) return null;
      const floors = typeof x?.floors === "number" && x.floors > 0 ? Math.min(60, Math.round(x.floors)) : undefined;
      return { poly: ps, use: oneOf(x?.use, USE_LIST, "residential"), ...(x?.density ? { density: oneOf(x.density, DENSITY_LIST, "medium") } : {}), ...(floors ? { floors } : {}), ...(str(x?.label) ? { label: str(x?.label) } : {}) };
    })
    .filter(nn)
    .slice(0, 120);
  const areas: SketchArea[] = (Array.isArray(r.areas) ? r.areas : [])
    .map((x: any) => {
      const poly = PS(x?.poly, 3);
      const ln = PS(x?.line, 2);
      if (!poly && !ln) return null;
      const kind = oneOf(x?.kind, AREA_LIST, "green");
      return { kind, ...(poly ? { poly } : { line: ln!, width_m: Math.max(4, Math.min(400, num(x?.width_m, kind === "water" ? 40 : 30))) }), ...(str(x?.name) ? { name: str(x?.name) } : {}) };
    })
    .filter(nn)
    .slice(0, 40);
  const facilities: SketchFacility[] = (Array.isArray(r.facilities) ? r.facilities : [])
    .map((x: any) => {
      const at = point(x?.at);
      const poly = PS(x?.poly, 3);
      const c = at ? P(at) : poly ? centroidOf(poly) : null;
      if (!c) return null;
      const kind = x?.kind && FAC_LIST.includes(x.kind) && x.kind !== "other" ? (x.kind as FacilityKind) : (facilityFromLabel(x?.label) ?? "other");
      return { kind, at: c, ...(poly ? { poly } : {}), ...(str(x?.label) ? { label: str(x?.label) } : {}) };
    })
    .filter(nn)
    .slice(0, 30);
  const transit: SketchTransit[] = (Array.isArray(r.transit) ? r.transit : [])
    .map((x: any) => {
      const ps = PS(x?.points, 2);
      if (!ps) return null;
      const st = Array.isArray(x?.stations) ? x.stations.map(point).filter(Boolean).map((p: Pt) => P(p)) : [];
      return { kind: oneOf(x?.kind, TRANSIT_LIST, "rail"), points: ps, ...(str(x?.name) ? { name: str(x?.name) } : {}), ...(st.length ? { stations: st.slice(0, 20) } : {}) };
    })
    .filter(nn)
    .slice(0, 8);
  const nd = r.north_deg;
  return {
    is_plan: isPlan && (streets.length > 0 || blocks.length > 0 || areas.length > 0 || facilities.length > 0),
    ...(isPlan ? {} : { not_plan_reason: str(r.not_plan_reason, 160) ?? "the image does not show a plan" }),
    ...(isPlan && !streets.length && !blocks.length && !areas.length && !facilities.length ? { not_plan_reason: str(r.not_plan_reason, 160) ?? "no streets, blocks or open spaces could be read from it" } : {}),
    ...(str(r.title, 60) ? { title: str(r.title, 60) } : {}),
    ...(str(r.description, 240) ? { description: str(r.description, 240) } : {}),
    extent: { width_m: Math.round(w), height_m: Math.round(h), basis: oneOf(ex.basis, ["scale_bar", "labels", "block_sizes", "street_spacing", "guess"] as const, "guess"), confidence: Math.round(clamp01(num(ex.confidence, 0.4)) * 100) / 100 },
    north_deg: typeof nd === "number" && Number.isFinite(nd) ? ((nd % 360) + 360) % 360 : null,
    default_use: oneOf(r.default_use, USE_LIST, "mixed"),
    default_density: oneOf(r.default_density, DENSITY_LIST, "medium"),
    streets,
    blocks,
    areas,
    facilities,
    transit,
    notes: (Array.isArray(r.notes) ? r.notes : []).map((x: unknown) => str(x, 120)).filter((x: string | undefined): x is string => !!x).slice(0, 20),
  };
}

function centroidOf(ps: Pt[]): Pt {
  const n = ps.length;
  return [r3(ps.reduce((s, p) => s + p[0], 0) / n), r3(ps.reduce((s, p) => s + p[1], 0) / n)];
}

/** what the plan holds, as counts in words ("7 streets (1 arterial), a river, a park, a school") */
export function planCounts(p: SketchPlan): string {
  const parts: string[] = [];
  if (p.streets.length) {
    const art = p.streets.filter((s) => s.class === "arterial").length;
    parts.push(`${p.streets.length} street${p.streets.length > 1 ? "s" : ""}${art ? ` (${art} arterial)` : ""}`);
  }
  const water = p.areas.filter((a) => a.kind === "water").length;
  const parks = p.areas.filter((a) => a.kind === "park" || a.kind === "green" || a.kind === "forest").length;
  const plazas = p.areas.filter((a) => a.kind === "plaza").length;
  if (water) parts.push(water === 1 ? (p.areas.find((a) => a.kind === "water")?.line ? "a river" : "water") : `${water} water bodies`);
  if (parks) parts.push(parks === 1 ? "a park" : `${parks} parks`);
  if (plazas) parts.push(plazas === 1 ? "a plaza" : `${plazas} plazas`);
  if (p.blocks.length) parts.push(`${p.blocks.length} labelled block${p.blocks.length > 1 ? "s" : ""}`);
  for (const f of p.facilities.slice(0, 4)) parts.push(`a ${f.label ? f.label.toLowerCase() : f.kind.replace("_", " ")}`);
  if (p.facilities.length > 4) parts.push(`${p.facilities.length - 4} more facilities`);
  if (p.transit.length) parts.push(`${p.transit.length} transit line${p.transit.length > 1 ? "s" : ""}`);
  return parts.join(", ");
}

/**
 * The plan as the agent reads it: compact JSON (coordinates to 2 decimals) so the model sees the
 * layout and labels without paying for the full precision the builder uses.
 */
export function planForModel(p: SketchPlan, sketchId: string): string {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const P = (q: Pt) => [r2(q[0]), r2(q[1])];
  const compact = {
    sketch_id: sketchId,
    title: p.title,
    description: p.description,
    extent_m: [p.extent.width_m, p.extent.height_m],
    extent_basis: p.extent.basis,
    extent_confidence: p.extent.confidence,
    north_deg: p.north_deg,
    default_use: p.default_use,
    default_density: p.default_density,
    streets: p.streets.map((s) => ({ c: s.class, ...(s.name ? { n: s.name } : {}), p: s.points.map(P) })),
    blocks: p.blocks.map((b) => ({ use: b.use, ...(b.density ? { d: b.density } : {}), ...(b.floors ? { f: b.floors } : {}), ...(b.label ? { l: b.label } : {}), p: b.poly.map(P) })),
    areas: p.areas.map((a) => ({ k: a.kind, ...(a.name ? { n: a.name } : {}), ...(a.poly ? { p: a.poly.map(P) } : { line: a.line!.map(P), w_m: a.width_m }) })),
    facilities: p.facilities.map((f) => ({ k: f.kind, at: P(f.at), ...(f.label ? { l: f.label } : {}) })),
    transit: p.transit.map((t) => ({ k: t.kind, ...(t.name ? { n: t.name } : {}), p: t.points.map(P) })),
    notes: p.notes,
  };
  return JSON.stringify(compact);
}
