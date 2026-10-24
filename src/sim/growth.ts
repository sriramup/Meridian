// Residential growth scenario: a logistic population path bounded by a capacity
// assumption, allocated year by year to lots with remaining zoned housing
// capacity. Each year's increment goes where capacity remains, weighted by how
// likely a lot is to redevelop (vacant and parking lots first; built lots by
// how little their buildings are worth relative to the land, from the
// appraisal roll) and by walking access to frequent transit. A scenario under
// stated assumptions, not a market forecast.

import { projectGrowth } from "./capacity";

export interface GrowthSite {
  id: string;
  /** remaining zoned housing capacity (units) */
  addedUnits: number;
  landUse: string;
  historic: boolean;
  value?: { land: number; improvements: number };
  owner?: string;
  /** walking minutes to the nearest frequent-transit stop */
  transitMin: number;
}

export interface GrowthParams {
  p0: number;
  capacity: number;
  rate: number;
  years: number;
  householdSize: number;
  baseYear: number;
  snapshots: number[];
}

export interface GrowthResult {
  series: { year: number; population: number }[];
  ids: string[];
  /** added residents per site at each snapshot year (same order as ids) */
  snapshots: { year: number; added: number[] }[];
  zonedCapacityResidents: number;
  /** growth the model could not place because zoned capacity ran out */
  unplaced: number;
  assumptions: string[];
}

/** relative likelihood that a lot redevelops within the horizon */
export function propensity(s: GrowthSite): number {
  if (s.historic) return 0;
  let p: number;
  if (s.landUse === "vacant" || s.landUse === "parking") p = 1;
  else if (s.value && s.value.land > 0) {
    // improvement-to-land value ratio: 0 → 1, 0.5 → 0.5, 1 → 0.2, 2 → 0.06
    const r = s.value.improvements / s.value.land;
    p = 1 / (1 + (r / 0.5) ** 2);
  } else p = 0.3;
  // public land redevelops on public timetables, not the market's
  return s.owner ? p * 0.5 : p;
}

export const accessWeight = (min: number) => (min <= 5 ? 1.5 : min <= 10 ? 1.2 : 1);

export function allocateGrowth(sites: GrowthSite[], p: GrowthParams): GrowthResult {
  const series = projectGrowth(p.p0, p.capacity, p.rate, p.years);
  const n = sites.length;
  const rem = Float64Array.from(sites, (s) => s.addedUnits * p.householdSize);
  const w = Float64Array.from(sites, (s) => propensity(s) * accessWeight(s.transitMin));
  const added = new Float64Array(n);
  const snapshots: GrowthResult["snapshots"] = [];
  let unplaced = 0;
  for (let t = 1; t <= p.years; t++) {
    let need = series[t].value - series[t - 1].value;
    // a few passes so growth blocked by full lots spills to the next most likely ones
    for (let pass = 0; pass < 4 && need > 0.5; pass++) {
      let W = 0;
      for (let i = 0; i < n; i++) W += w[i] * rem[i];
      if (W <= 0) break;
      let used = 0;
      for (let i = 0; i < n; i++) {
        if (!rem[i] || !w[i]) continue;
        const a = Math.min(rem[i], (need * w[i] * rem[i]) / W);
        rem[i] -= a;
        added[i] += a;
        used += a;
      }
      need -= used;
    }
    if (need > 0.5) unplaced += need;
    if (p.snapshots.includes(t)) snapshots.push({ year: p.baseYear + t, added: Array.from(added, (x) => Math.round(x * 10) / 10) });
  }
  return {
    series: series.map((x) => ({ year: p.baseYear + x.year, population: Math.round(x.value) })),
    ids: sites.map((s) => s.id),
    snapshots,
    zonedCapacityResidents: Math.round(sites.reduce((s, x) => s + x.addedUnits * p.householdSize, 0)),
    unplaced: Math.round(unplaced),
    assumptions: [
      `Population follows a logistic path from ${Math.round(p.p0).toLocaleString()} (Census ${p.baseYear}) toward ${Math.round(p.capacity).toLocaleString()} at ${(p.rate * 100).toFixed(1)} %/yr — a scenario assumption, not a forecast.`,
      "Each year's growth goes to lots with remaining zoned housing capacity, in proportion to remaining capacity × redevelopment likelihood × transit access.",
      "Redevelopment likelihood: vacant and surface-parking lots 1; built lots 1 / (1 + (improvement ÷ land value ÷ 0.5)²) from the TCAD appraisal roll; historic lots 0; public land × 0.5.",
      "Transit access: × 1.5 within a 5-minute walk of frequent transit, × 1.2 within 10 minutes.",
      "No market feasibility, construction cost or rent model; capacity is current zoning.",
    ],
  };
}
