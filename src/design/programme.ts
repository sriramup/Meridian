// The design brief: what a neighbourhood must contain, and the planning norms that turn a loose
// request ("a high-density neighbourhood with three schools and a few parks") into numbers.
//
// Density classes follow common US practice (net residential density on block land, i.e. excluding
// streets, parks and civic sites):
//   low        ≈  8 homes / acre  (20 / ha)  detached houses, duplexes            FAR ≈ 0.3
//   medium     ≈ 30 homes / acre  (75 / ha)  townhouses, plexes, walk-ups, main  FAR ≈ 1.0
//   high       ≈ 80 homes / acre (200 / ha)  5-over-1 mid-rise, perimeter blocks FAR ≈ 2.5–3
//   very_high  ≈160 homes / acre (400 / ha)  towers on podiums, offices          FAR ≈ 5+
// Open space: NRPA's suburban 10 acres / 1,000 residents is unattainable in cities; urban plans target
// 8–15 % of land as public open space, with every home within a 5-minute (¼ mi, 400 m) walk of a
// park or plaza (Trust for Public Land 10-minute-walk metric, tightened for dense areas).
// School sizing: US state facility guides (e.g. CEFPI / state DOE minimums) use ≈ 9–11 m² GFA per
// primary pupil, 12–14 per middle-school pupil, 14–16 per high-school pupil; urban sites are compact
// (multi-storey, play yards, fields at youth dimensions where land is short).

import type { Polygon, Vec2 } from "@/world/types";

export type DensityClass = "low" | "medium" | "high" | "very_high";

export type FacilityKind =
  | "university"
  | "high_school"
  | "middle_school"
  | "primary_school"
  | "daycare"
  | "police"
  | "fire"
  | "restaurant"
  | "cafe"
  | "grocery"
  | "library"
  | "clinic"
  | "community_center"
  | "hotel"
  | "park"
  | "plaza";

export interface FacilityRequest {
  kind: FacilityKind;
  count?: number;
  name?: string;
  /** pupils / students (schools, university) */
  enrolment?: number;
}

export interface NeighborhoodSpec {
  /** site boundary (local metres); streets are laid inside and along it */
  area: Polygon;
  name?: string;
  /** same seed + same inputs → same design */
  seed?: number;
  /** overall intensity; inferred from targets when omitted (default "high") */
  density?: DensityClass;
  /** programme targets (any subset); homes wins over population */
  homes?: number;
  population?: number;
  jobs?: number;
  /** gross floor-area ratio over block land (alternative to homes / jobs) */
  far?: number;
  /** share of floor area by use (defaults by density) */
  mix?: { residential?: number; office?: number; retail?: number };
  facilities?: FacilityRequest[];
  /** share of block land kept as public parks / plazas (default by density) */
  openSpace?: number;
  maxFloors?: number;
  minFloors?: number;
  /** the activity centre (main-street crossing); default: the area's centre */
  centre?: Vec2;
  /** street layout: grid spacing (m), keep/skip arterials */
  streets?: { blockLength?: number; blockDepth?: number; arterials?: boolean; build?: boolean };
  /** demolish buildings already inside the area (default false: build around them) */
  replaceExisting?: boolean;
  /** palette family for the whole neighbourhood (default chosen by seed) */
  palette?: PaletteName;
}

export type PaletteName = "masonry" | "texas" | "modern" | "coastal";

export interface Programme {
  density: DensityClass;
  homes: number;
  jobs: number;
  openSpace: number;
  maxFloors: number;
  minFloors: number;
  officeShare: number;
  retailShare: number;
  facilities: FacilityRequest[];
}

/** net homes per hectare of block land, by density class */
export const NET_DENSITY: Record<DensityClass, number> = { low: 20, medium: 75, high: 200, very_high: 400 };
/** default height caps (floors) */
export const MAX_FLOORS: Record<DensityClass, number> = { low: 3, medium: 6, high: 24, very_high: 45 };
export const MIN_FLOORS: Record<DensityClass, number> = { low: 1, medium: 2, high: 3, very_high: 4 };
/** public open-space share of block land */
export const OPEN_SPACE: Record<DensityClass, number> = { low: 0.08, medium: 0.1, high: 0.12, very_high: 0.1 };
/** jobs per home a balanced neighbourhood carries (local retail, services, some office) */
const JOBS_PER_HOME: Record<DensityClass, number> = { low: 0.1, medium: 0.35, high: 0.6, very_high: 1.2 };

/** school and campus norms (urban) */
export const SCHOOL_NORMS = {
  primary_school: { enrolment: 600, m2PerPupil: 10, floors: 3, siteM2: 9000, field: [60, 40] as [number, number] },
  middle_school: { enrolment: 800, m2PerPupil: 13, floors: 3, siteM2: 14000, field: [91, 55] as [number, number] },
  high_school: { enrolment: 1600, m2PerPupil: 15, floors: 4, siteM2: 26000, field: [110, 64] as [number, number] },
  university: { enrolment: 6000, m2PerPupil: 14, floors: 5, siteM2: 70000, field: [0, 0] as [number, number] },
} as const;

/** turn a brief into numbers; `blockLand` is the developable block area (m²) after streets */
export function resolveProgramme(spec: NeighborhoodSpec, blockLand: number, householdSize: number): Programme {
  const homesReq = spec.homes ?? (spec.population ? spec.population / householdSize : undefined);
  let density: DensityClass = spec.density ?? "high";
  if (!spec.density && homesReq) {
    const net = homesReq / Math.max(1, blockLand / 10000);
    density = net < 40 ? "low" : net < 130 ? "medium" : net < 300 ? "high" : "very_high";
  }
  const openSpace = spec.openSpace ?? OPEN_SPACE[density];
  const fabricLand = blockLand * (1 - openSpace) * 0.8; // civic sites take roughly a fifth
  let homes = homesReq ?? (NET_DENSITY[density] * fabricLand) / 10000;
  if (spec.far && !homesReq) homes = (spec.far * fabricLand * 0.8 * 0.82) / 78;
  const officeShare = spec.mix?.office ?? (density === "very_high" ? 0.3 : density === "high" ? 0.12 : density === "medium" ? 0.05 : 0);
  const retailShare = spec.mix?.retail ?? (density === "low" ? 0.02 : 0.06);
  const jobs = spec.jobs ?? homes * JOBS_PER_HOME[density];
  const facilities = expandFacilities(spec.facilities ?? []);
  return {
    density,
    homes: Math.round(homes),
    jobs: Math.round(jobs),
    openSpace,
    maxFloors: spec.maxFloors ?? MAX_FLOORS[density],
    minFloors: spec.minFloors ?? MIN_FLOORS[density],
    officeShare,
    retailShare,
    facilities,
  };
}

/** one entry per facility instance */
export function expandFacilities(list: FacilityRequest[]): FacilityRequest[] {
  const out: FacilityRequest[] = [];
  for (const f of list) for (let i = 0; i < Math.max(1, Math.round(f.count ?? 1)); i++) out.push({ ...f, count: 1, name: f.count && f.count > 1 && f.name ? `${f.name} ${i + 1}` : f.name });
  return out;
}

const WORDS: [RegExp, FacilityKind][] = [
  [/universit|college campus|\bcollege\b/i, "university"],
  [/high school|secondary school/i, "high_school"],
  [/middle school|junior high/i, "middle_school"],
  [/primary school|elementary school|grade school/i, "primary_school"],
  [/daycare|preschool|nursery/i, "daycare"],
  [/police/i, "police"],
  [/fire ?(station|house|hall)/i, "fire"],
  [/restaurants?|diner|bistro/i, "restaurant"],
  [/caf[eé]|coffee/i, "cafe"],
  [/grocery|supermarket/i, "grocery"],
  [/library/i, "library"],
  [/clinic|health cent/i, "clinic"],
  [/community (center|centre)|rec(reation)? cent/i, "community_center"],
  [/hotel/i, "hotel"],
  [/plaza|square/i, "plaza"],
  [/parks?\b/i, "park"],
];
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, few: 3, several: 3, couple: 2 };

/** parse facilities out of plain words ("two restaurants, a fire station and a few parks") */
export function facilitiesFromText(text: string): FacilityRequest[] {
  const out: FacilityRequest[] = [];
  const parts = text.split(/,|;|\band\b|\bwith\b|\bplus\b/i);
  for (const p of parts) {
    for (const [re, kind] of WORDS) {
      if (!re.test(p)) continue;
      const m = /\b(\d+|a|an|one|two|three|four|five|six|few|several|couple)\b(?:\s+of)?\s+[a-z\s]*$/i.exec(p.slice(0, p.search(re)));
      const w = m?.[1]?.toLowerCase();
      const count = w ? (Number(w) || NUM[w] || 1) : 1;
      if (!out.some((f) => f.kind === kind)) out.push({ kind, count });
      break;
    }
  }
  return out;
}
