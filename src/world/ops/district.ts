// District-scale generation: subdivide oversized blocks with new local streets,
// allocate open space, preserve protected buildings, and fill the remaining
// blocks with a massing typology whose height is solved to meet a housing
// target under a height cap.

import { generateMassing, type Typology } from "@/geometry/massing";
import { bufferPoly, difference, insetPoly, intersection, isValidPoly, obb, pointInPoly, polyArea, polyBBox, polyCentroid } from "@/geometry/polygon";
import { add, dist, rot, scale } from "@/geometry/vec";
import type { Building, Parcel, Polygon, Street, Use, Vec2 } from "../types";
import type { World } from "../world";
import { OpBuilder, PROGRAMME, fmt, programmeOf, type OpResult } from "./core";
import { createBuilding, type Actor } from "./buildings";
import { createArea, plantTrees } from "./landscape";
import { createStreet } from "./streets";
import { streetBand } from "./validate";

export type DistrictStyle = "european" | "grid" | "towers" | "tod" | "midrise" | "civic" | "infill";

export interface DistrictParams {
  area: Polygon;
  style: DistrictStyle;
  targetUnits?: number;
  targetPopulation?: number;
  maxFloors?: number;
  minFloors?: number;
  /** add local streets so no block exceeds ~blockSize metres */
  newStreets?: boolean;
  blockSize?: number;
  openSpaceRatio?: number;
  preserve?: string[];
  preserveHistoric?: boolean;
  /** keep every existing building (infill only on open land) */
  keepAllExisting?: boolean;
  /** with keepAllExisting: still rebuild private, non-historic lots whose buildings are worth less than half the land (appraisal roll) */
  redevelop?: "underused";
  /** targetUnits counts net new homes: units demolished on redeveloped lots are replaced on top */
  netTarget?: boolean;
  use?: Use;
  retailGround?: boolean;
  anchor?: Vec2;
  streetTrees?: boolean;
  name?: string;
}

const TYPO: Record<DistrictStyle, Typology> = { european: "courtyard", grid: "midrise", towers: "tower_podium", tod: "tower_podium", midrise: "midrise", civic: "courtyard", infill: "rowhouses" };

export function generateDistrict(world: World, p: DistrictParams, actor: Actor): OpResult {
  const b = new OpBuilder(world, actor.author);
  const hh = world.meta.calibration.householdSize;
  const targetUnits = p.targetUnits ?? (p.targetPopulation ? p.targetPopulation / hh : undefined);
  const maxF = Math.max(2, p.maxFloors ?? (p.style === "towers" || p.style === "tod" ? 30 : p.style === "european" ? 7 : 8));
  const minF = Math.min(maxF, p.minFloors ?? (p.style === "infill" ? 2 : 3));
  const use: Use = p.use ?? (p.style === "civic" ? "mixed" : "mixed");
  const bb = polyBBox(p.area);

  // ---- 1. new local streets through oversized blocks
  const newStreetIds: string[] = [];
  const streetsIn = () => [...world.query(bb, ["street"]).map((e) => b.get<Street>(e.id)).filter((s): s is Street => !!s && !b.isRemoved(s.id)), ...(b.touched().filter((e) => e.kind === "street") as Street[])];
  const blocksOf = () => {
    let land: Polygon[] = [p.area];
    const seen = new Set<string>();
    for (const s of streetsIn()) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      land = land.flatMap((q) => difference(q, streetBand(s)));
    }
    return land.filter((q) => isValidPoly(q) && polyArea(q) > 300);
  };
  if (p.newStreets) {
    const size = p.blockSize ?? (p.style === "european" ? 70 : 100);
    let k = 0;
    for (const blk of blocksOf()) {
      const o = obb(blk[0]);
      if (o.length < size * 1.6) continue;
      const n = Math.max(1, Math.round(o.length / size) - 1);
      const u = rot([1, 0], o.angle),
        v = rot([0, 1], o.angle);
      for (let i = 1; i <= n; i++) {
        const along = -o.length / 2 + (o.length * i) / (n + 1);
        const c = add(o.center, scale(u, along));
        const half = o.width / 2 + 18;
        const path: Vec2[] = [add(c, scale(v, -half)), add(c, scale(v, half))];
        const r = createStreet(world, { path, cls: p.style === "european" ? "living" : "residential", name: `${p.name ?? "New"} Street ${++k}`, trees: true, sidewalk: p.style === "european" ? 4 : 3, parking: p.style !== "european", policy: "demolish" }, actor, b);
        if (r.ok) newStreetIds.push(...((r.data?.streetIds as string[]) ?? []));
      }
    }
    if (newStreetIds.length) b.summary(`${newStreetIds.length} new local street segments subdivide the oversized blocks (~${size} m grain)`);
  }

  // ---- 2. blocks and existing buildings
  const blocks = blocksOf();
  if (!blocks.length) return b.fail("No developable blocks inside the area");
  const keep = new Set(p.preserve ?? []);
  const kept: Building[] = [];
  let demolished = 0,
    demoGfa = 0,
    demoUnits = 0,
    redeveloped = 0;
  const demolish = (bld: Building) => {
    const pr = programmeOf(bld);
    demoGfa += pr.gfa;
    demoUnits += pr.units;
    demolished++;
    b.remove(bld.id);
  };
  // soft sites by the planners' measure: private, non-historic lots whose buildings are worth less than half the land
  const redevelop = !!p.keepAllExisting && p.redevelop === "underused";
  const isSoft = (par?: Parcel) => !!par && !par.owner && !par.historic && !["park", "water", "row"].includes(par.landUse) && !!par.value && par.value.improvements < 0.5 * par.value.land;
  /** buildings on candidate lots: kept or rebuilt once the lots are chosen (step 5) */
  const onLot = new Map<string, Building[]>();
  for (const e of world.query(bb, ["building"])) {
    const bld = b.get<Building>(e.id);
    if (!bld || b.isRemoved(e.id)) continue;
    if (!pointInPoly(polyCentroid(bld.footprint), p.area)) continue;
    const par = bld.parcelId ? world.get<Parcel>(bld.parcelId) : undefined;
    if (redevelop && !bld.historic && !keep.has(bld.id) && isSoft(par)) {
      onLot.set(par!.id, [...(onLot.get(par!.id) ?? []), bld]);
      continue;
    }
    if (p.keepAllExisting || keep.has(bld.id) || (bld.historic && p.preserveHistoric !== false)) {
      kept.push(bld);
      continue;
    }
    demolish(bld);
  }
  const candidates = [...onLot.values()].flat();
  const standing = [...kept, ...candidates];

  // ---- 3. open space
  const totalLand = blocks.reduce((s, q) => s + polyArea(q), 0);
  const osr = p.openSpaceRatio ?? (p.style === "european" ? 0.18 : p.style === "civic" ? 0.25 : 0.12);
  const centre = p.anchor ?? polyCentroid(p.area);
  const order = blocks
    .map((q) => ({ q, a: polyArea(q), d: dist(polyCentroid(q), centre) }))
    .sort((x, y) => x.d - y.d);
  const parks = new Set<Polygon>();
  let parkLand = 0;
  if (osr > 0) {
    // prefer central, medium-sized blocks without standing buildings
    for (const o of order) {
      if (parkLand >= osr * totalLand) break;
      if (standing.some((k) => pointInPoly(polyCentroid(k.footprint), o.q))) continue;
      // never give a whole oversized block to open space (with one or two blocks that left nothing to build)
      if (o.a > osr * totalLand * 1.8) continue;
      parks.add(o.q);
      parkLand += o.a;
      if (p.style === "civic" && parks.size === 1) break;
    }
    for (const q of parks) createArea(world, { type: p.style === "civic" ? "plaza" : "park", poly: q, name: parks.size === 1 ? `${p.name ?? "District"} ${p.style === "civic" ? "Civic Square" : "Park"}` : undefined, buildings: "demolish", shadeTrees: { spacing: 12 } }, actor, b);
  }

  // ---- 4. building sites: open land, and (with redevelop) candidate lots as sites of their own
  type Site = { site: Polygon; d: number };
  const sites: Site[] = [];
  const lotParcels = redevelop
    ? world
        .query(bb, ["parcel"])
        .map((e) => e as Parcel)
        .filter((par) => pointInPoly(polyCentroid(par.poly), p.area) && isSoft(par) && !kept.some((k) => k.parcelId === par.id) && ![...parks].some((q) => pointInPoly(polyCentroid(par.poly), q)))
    : [];
  const lotPoly = new Map(lotParcels.map((par) => [par.id, insetPoly(par.poly, 1.5) ?? par.poly]));
  for (const o of order) {
    if (parks.has(o.q)) continue;
    let site: Polygon[] = [insetPoly(o.q, p.style === "european" || p.style === "civic" ? 0.5 : 2) ?? o.q];
    for (const k of standing) site = site.flatMap((q) => difference(q, bufferPoly(k.footprint, 4)));
    for (const lot of lotPoly.values()) site = site.flatMap((q) => difference(q, lot));
    for (const q of site) if (isValidPoly(q) && polyArea(q) > 250) sites.push({ site: q, d: dist(polyCentroid(q), centre) });
  }
  const lotSites = new Map<string, Site[]>();
  for (const par of lotParcels) {
    let site: Polygon[] = [lotPoly.get(par.id)!];
    for (const k of standing) if (k.parcelId !== par.id) site = site.flatMap((q) => difference(q, bufferPoly(k.footprint, 2)));
    lotSites.set(par.id, site.filter((q) => isValidPoly(q) && polyArea(q) > 150).map((q) => ({ site: q, d: dist(polyCentroid(q), centre) })));
  }
  if (!sites.length && !lotSites.size && !parks.size) return b.fail("No buildable sites after preserving existing buildings");

  // ---- 5. solve floors for the housing target
  const typology = TYPO[p.style];
  const resShare = use === "mixed" ? 0.85 : use === "residential" ? 1 : 0;
  const floorsAt = (base: number, d: number) => {
    if (p.style === "tod" || p.style === "towers") {
      // taper with distance from the anchor (station / centre)
      const t = Math.min(1, d / 400);
      return Math.max(minF, Math.round(base * (1 - 0.6 * t)));
    }
    return base;
  };
  const unitsOf = (list: Site[], base: number) => {
    let u = 0;
    for (const s of list) {
      const g = generateMassing(s.site, { typology, floors: Math.min(maxF, floorsAt(base, s.d)), use: "residential", podiumFloors: 3 });
      u += (g.gfa * resShare * PROGRAMME.resEfficiency) / PROGRAMME.unitSize;
    }
    return u;
  };
  // redevelopment: the fewest lots, most underused first, at the lowest height that could reach the target
  if (lotParcels.length) {
    const ratio = (par: Parcel) => par.value!.improvements / Math.max(1, par.value!.land);
    const queue = [...lotParcels].sort((x, y) => ratio(x) - ratio(y));
    const lotUnits = (par: Parcel) => (onLot.get(par.id) ?? []).reduce((s, x) => s + programmeOf(x).units, 0);
    const need = (sel: Parcel[]) => (targetUnits ?? 0) + (p.netTarget ? sel.reduce((s, x) => s + lotUnits(x), 0) : 0);
    let chosen: Parcel[] = queue;
    if (targetUnits && targetUnits > 0) {
      const all = (f: number) => unitsOf(sites, f) + queue.reduce((s, par) => s + unitsOf(lotSites.get(par.id)!, f), 0);
      let lo = minF,
        hi = maxF;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (all(mid) >= need(queue)) hi = mid;
        else lo = mid + 1;
      }
      chosen = [];
      let u = unitsOf(sites, lo);
      for (const par of queue) {
        if (u >= need(chosen)) break;
        chosen.push(par);
        u += unitsOf(lotSites.get(par.id)!, lo);
      }
    }
    const pick = new Set(chosen.map((x) => x.id));
    for (const [pid, blds] of onLot) {
      if (pick.has(pid)) for (const x of blds) (demolish(x), redeveloped++);
      else kept.push(...blds);
    }
    for (const par of chosen) sites.push(...lotSites.get(par.id)!);
    if (chosen.length) b.summary(`Redeveloped ${chosen.length} of ${queue.length} underused private lots (buildings worth less than half their land, TCAD appraisal), most underused first`);
  } else for (const blds of onLot.values()) kept.push(...blds);
  const target = targetUnits && p.netTarget ? targetUnits + demoUnits : targetUnits;
  const unitsFor = (base: number) => unitsOf(sites, base);
  let floors = Math.round((minF + maxF) / 2);
  if (target && target > 0) {
    let lo = minF,
      hi = maxF;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (unitsFor(mid) >= target) hi = mid;
      else lo = mid + 1;
    }
    floors = lo;
    const reach = unitsFor(floors);
    if (reach < target * 0.97) b.warn(`Target of ${fmt.int(target)} units${p.netTarget && demoUnits >= 1 ? ` (${fmt.int(targetUnits!)} net + ${fmt.int(demoUnits)} replaced)` : ""} cannot be met under ${maxF} floors on the available land (max ≈${fmt.int(reach)})`);
  } else floors = p.style === "european" ? 6 : p.style === "grid" || p.style === "midrise" ? 7 : p.style === "infill" ? 3 : Math.min(maxF, 24);

  let units = 0,
    gfa = 0,
    jobs = 0,
    nb = 0;
  // target_units: 0 → restructure streets / open space only
  const streetsOnly = p.targetUnits === 0 && !p.targetPopulation;
  for (const s of streetsOnly ? [] : sites) {
    const f = Math.min(maxF, floorsAt(floors, s.d));
    const r = createBuilding(
      world,
      {
        site: s.site,
        spec: { typology, floors: f, use, podiumFloors: p.style === "tod" ? 4 : 3 },
        program: use === "mixed" ? { residential: resShare, retail: p.retailGround === false ? 0 : 0.1, office: Math.max(0, 1 - resShare - 0.1) } : undefined,
        demolishConflicts: false,
        notes: `${p.style} district block`,
      },
      actor,
      b,
    );
    if (r.ok && r.building) {
      const pr = programmeOf(r.building, hh);
      units += pr.units;
      gfa += pr.gfa;
      jobs += pr.jobs;
      nb++;
    }
  }
  // ---- 6. street trees on the new streets
  if (p.streetTrees !== false && newStreetIds.length) plantTrees(world, { streetIds: newStreetIds, spacing: 9 }, actor, b);

  b.report.summary.unshift(
    streetsOnly
      ? `${p.name ?? "District"}: street network and open space restructured; no new buildings (target_units 0); open space ${((parkLand / totalLand) * 100).toFixed(0)}% of block land`
      : `${p.name ?? "District"} (${p.style}): ${nb} buildings, ${fmt.m2(gfa)} GFA, ~${fmt.int(units)} homes (~${fmt.int(units * hh)} residents at ${hh} per household), ~${fmt.int(jobs)} jobs; up to ${floors} floors; open space ${((parkLand / totalLand) * 100).toFixed(0)}% of block land`,
  );
  if (redeveloped || p.netTarget) b.summary(`Net new homes ≈ ${fmt.int(units - demoUnits)} (${fmt.int(units)} built − ${fmt.int(demoUnits)} demolished)`);
  if (demolished) b.summary(`Demolished ${demolished} existing buildings (−${fmt.m2(demoGfa)} GFA${demoUnits >= 1 ? `, −${fmt.int(demoUnits)} units` : ""}); kept ${kept.length}${kept.some((k) => k.historic) ? " incl. historic" : ""}`);
  else if (kept.length) b.summary(`All ${kept.length} existing buildings retained`);
  b.data = { units, netUnits: units - demoUnits, population: units * hh, gfa, jobs, floors, buildings: nb, demolished, redeveloped, openSpace: parkLand / totalLand, newStreets: newStreetIds.length };
  return b.finish(`${p.name ?? "District"} masterplan (${p.style})`);
}

export { intersection };
