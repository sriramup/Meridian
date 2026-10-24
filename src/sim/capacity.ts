// Development capacity, population and economic screening. Zoning parameters
// come from src/world/zoning.ts; costs use explicit, user-visible unit-cost
// assumptions (order-of-magnitude, 2026 USD) rather than hidden constants.

import { overlapArea, polyArea, polyBBox, polyCentroid, pointInPoly } from "@/geometry/polygon";
import { countType, sectionWidth } from "@/geometry/crossSection";
import { polyLength } from "@/geometry/polyline";
import { PROGRAMME, programmeOf } from "@/world/ops/core";
import type { Area, Building, Entity, Parcel, Polygon, Street, Tree } from "@/world/types";

export interface ParcelCapacity {
  id: string;
  area: number;
  zoning: string;
  maxFar: number | null;
  maxHeight: number | null;
  existingGfa: number;
  allowedGfa: number;
  addedGfa: number;
  addedUnits: number;
  utilisation: number;
  limitedBy: "far" | "height" | "cvc" | "none" | "historic" | "public" | "entitlement";
  historic: boolean;
  landUse: Parcel["landUse"];
}

export interface CapacityOptions {
  /** override: allow N floors everywhere in the selection */
  floors?: number;
  /** override height limit (m) */
  heightLimit?: number;
  coverage?: number;
  preserveHistoric?: boolean;
  residentialShare?: number;
}

export function parcelCapacity(entities: Map<string, Entity>, parcels: Parcel[], opts: CapacityOptions = {}): ParcelCapacity[] {
  const blds = [...entities.values()].filter((e) => e.kind === "building") as Building[];
  // spatial bucket buildings by centroid
  const bucket = new Map<string, Building[]>();
  for (const b of blds) {
    const c = polyCentroid(b.footprint);
    const k = `${Math.floor(c[0] / 100)},${Math.floor(c[1] / 100)}`;
    if (!bucket.has(k)) bucket.set(k, []);
    bucket.get(k)!.push(b);
  }
  const cov = opts.coverage ?? 0.7;
  const resShare = opts.residentialShare ?? 0.85;
  const out: ParcelCapacity[] = [];
  for (const p of parcels) {
    if (p.landUse === "row" || p.landUse === "water") continue;
    const bb = polyBBox(p.poly);
    let existing = 0;
    for (let x = Math.floor(bb[0] / 100) - 1; x <= Math.floor(bb[2] / 100) + 1; x++)
      for (let y = Math.floor(bb[1] / 100) - 1; y <= Math.floor(bb[3] / 100) + 1; y++)
        for (const b of bucket.get(`${x},${y}`) ?? []) {
          if (!pointInPoly(polyCentroid(b.footprint), p.poly)) continue;
          existing += programmeOf(b).gfa;
        }
    let allowed: number;
    let limitedBy: ParcelCapacity["limitedBy"] = "none";
    const hl = opts.heightLimit ?? (opts.floors ? opts.floors * 3.5 + 1 : p.maxHeight ?? null);
    // approx ground ~140 m ASL downtown; ceilings at/below grade are inconsistent source data and not applied
    const cvcAbove = p.cvcCeiling != null && p.cvcCeiling - 140 >= 3 ? p.cvcCeiling - 140 : null;
    const effH = [hl, cvcAbove].filter((v): v is number => v != null).reduce((a, b) => Math.min(a, b), Infinity);
    const hFloors = Number.isFinite(effH) ? Math.max(1, Math.floor((effH - 1) / 3.5)) : 60;
    const byHeight = p.area * cov * hFloors;
    const byFar = !opts.floors && p.maxFar != null ? p.area * p.maxFar : Infinity;
    if (p.zoningBase === "P" || p.zoningBase === "UNZ") {
      // public land, and state / university land outside city zoning
      allowed = existing;
      limitedBy = "public";
    } else if (p.zoningBase === "PUD" || (p.maxFar == null && p.maxHeight == null && p.cvcCeiling == null)) {
      // PUDs carry site-specific entitlements, and some districts have no envelope in the data:
      // without a regulatory limit, capacity is not invented
      allowed = existing;
      limitedBy = "entitlement";
    } else if ((opts.preserveHistoric ?? true) && p.historic) {
      allowed = existing;
      limitedBy = "historic";
    } else {
      allowed = Math.min(byHeight, byFar);
      limitedBy = byFar <= byHeight ? "far" : cvcAbove != null && cvcAbove <= (hl ?? Infinity) ? "cvc" : "height";
      if (!Number.isFinite(allowed)) allowed = p.area * 8;
    }
    const added = Math.max(0, allowed - existing);
    out.push({
      id: p.id,
      area: p.area,
      zoning: p.zoning,
      maxFar: p.maxFar,
      maxHeight: p.maxHeight,
      existingGfa: existing,
      allowedGfa: allowed,
      addedGfa: added,
      addedUnits: (added * resShare * PROGRAMME.resEfficiency) / PROGRAMME.unitSize,
      utilisation: allowed > 0 ? existing / allowed : 1,
      limitedBy,
      historic: p.historic,
      landUse: p.landUse,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------- scenario metrics

export interface ScenarioMetrics {
  population: number;
  units: number;
  jobs: number;
  gfa: number;
  buildings: number;
  newUnits: number;
  newResidents: number;
  canopyTrees: number;
  parkArea: number;
  parkPer1000: number;
  surfaceParking: number;
  onStreetSpaces: number;
  bikeKm: number;
  protectedBikeKm: number;
  busLaneKm: number;
  tramKm: number;
  laneKm: number;
  sidewalkArea: number;
  transitStops: number;
  pedStreetsKm: number;
}

export function scenarioMetrics(entities: Map<string, Entity>, hh: number, censusPop: number, baselineUnits?: number): ScenarioMetrics {
  let units = 0,
    jobs = 0,
    gfa = 0,
    nb = 0,
    newUnits = 0,
    trees = 0,
    park = 0,
    parking = 0,
    onStreet = 0,
    bike = 0,
    prot = 0,
    bus = 0,
    tram = 0,
    lane = 0,
    sidewalk = 0,
    stops = 0,
    ped = 0;
  for (const e of entities.values()) {
    if (e.kind === "building") {
      const p = programmeOf(e as Building, hh);
      units += p.units;
      jobs += p.jobs;
      gfa += p.gfa;
      nb++;
      if ((e as Building).createdBy && !(e as Building).existing) newUnits += p.units;
    } else if (e.kind === "tree") trees++;
    else if (e.kind === "area") {
      const a = e as Area;
      if (a.type === "park" || a.type === "plaza" || a.type === "pitch") park += polyArea(a.poly);
      if (a.type === "parking") parking += polyArea(a.poly);
    } else if (e.kind === "street") {
      const s = e as Street;
      const L = polyLength(s.path) / 1000;
      for (const st of s.section.strips) {
        if (st.type === "bike") bike += L;
        if (st.type === "cycletrack") {
          bike += L;
          prot += L;
        }
        if (st.type === "bus") bus += L;
        if (st.type === "tram") tram += L;
        if (st.type === "travel" || st.type === "turn") lane += L;
        if (st.type === "sidewalk") sidewalk += L * 1000 * st.width;
      }
      onStreet += (countType(s.section, "parking") * L * 1000 * 0.8) / 6.7;
      if (s.closed || s.cls === "pedestrian") ped += L;
      void sectionWidth;
    } else if (e.kind === "stop") stops++;
  }
  // population: Census 2020 baseline + residents of net-new units
  const base = baselineUnits ?? units;
  const population = censusPop + (units - base) * hh;
  return {
    population,
    units,
    jobs,
    gfa,
    buildings: nb,
    newUnits,
    newResidents: (units - base) * hh,
    canopyTrees: trees,
    parkArea: park,
    parkPer1000: population > 0 ? park / (population / 1000) : 0,
    surfaceParking: parking,
    onStreetSpaces: onStreet,
    bikeKm: bike,
    protectedBikeKm: prot,
    busLaneKm: bus,
    tramKm: tram,
    laneKm: lane,
    sidewalkArea: sidewalk,
    transitStops: stops,
    pedStreetsKm: ped,
  };
}

// ---------------------------------------------------------------------------- costs & schools

export const UNIT_COSTS = {
  "Residential high-rise construction ($/m² GFA)": 3400,
  "Residential mid-rise construction ($/m² GFA)": 2600,
  "Office construction ($/m² GFA)": 3600,
  "Demolition ($/m² GFA)": 140,
  "Street reconstruction ($/m² of carriageway)": 450,
  "Sidewalk ($/m²)": 220,
  "Protected bike lane ($/km, one direction)": 1_600_000,
  "Bus lane conversion ($/km)": 900_000,
  "Tram line incl. vehicles ($/km)": 75_000_000,
  "Street tree incl. soil cells ($/tree)": 4500,
  "Park construction ($/m²)": 320,
  "Green roof retrofit ($/m²)": 260,
  "Rain garden / bioretention ($/m²)": 420,
  "Retention pond ($/m³ storage)": 95,
  "Right-of-way acquisition ($/m², downtown)": 6500,
  // public infrastructure needed to serve new housing (budget_fit)
  "Utility connections & capacity ($/unit)": 14000,
  "School seat ($/student seat)": 45000,
  "Frontage upgrade: sidewalk, kerb, trees ($/m)": 2500,
  "New local street for large sites ($/m², carriageway + sidewalks)": 650,
};

export const STUDENT_RATES = {
  /** students per housing unit by type (Austin ISD-style planning factors) */
  multifamily: { elementary: 0.06, middle: 0.025, high: 0.03 },
  singleFamily: { elementary: 0.25, middle: 0.1, high: 0.12 },
  capacity: { elementary: 650, middle: 1000, high: 2200 },
};

export function schoolsNeeded(units: number, multifamilyShare = 0.9) {
  const r = (k: "elementary" | "middle" | "high") => units * (multifamilyShare * STUDENT_RATES.multifamily[k] + (1 - multifamilyShare) * STUDENT_RATES.singleFamily[k]);
  const e = r("elementary"),
    m = r("middle"),
    h = r("high");
  return {
    students: { elementary: e, middle: m, high: h },
    schools: { elementary: e / STUDENT_RATES.capacity.elementary, middle: m / STUDENT_RATES.capacity.middle, high: h / STUDENT_RATES.capacity.high },
  };
}

/** logistic growth bounded by capacity: P(t) = K / (1 + ((K − P0)/P0) e^(−rt)) */
export function projectGrowth(p0: number, capacity: number, rate: number, years: number) {
  const out: { year: number; value: number }[] = [];
  for (let t = 0; t <= years; t++) out.push({ year: t, value: capacity / (1 + ((capacity - p0) / p0) * Math.exp(-rate * t)) });
  return out;
}

export { overlapArea, polyArea };
export type { Polygon, Tree };
