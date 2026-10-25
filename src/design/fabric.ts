// Urban fabric: blocks → lots → buildings.
//
// Each block edge is classified by the street it fronts (boulevard … local). Edges are processed in
// order of importance; each takes a strip of lots whose depth suits its typology family (perimeter
// buildings 17–30 m deep forming a continuous street wall, or yard lots 22–36 m deep with front
// setbacks and rear gardens). Corners go to the more important street. Frontage is cut into lots of
// typology-appropriate width (seeded jitter), each lot gets a rung on the intensity ladder from its
// score (street class, corner, distance to the centre, the programme's solved intensity, jitter) and
// a building from the library catalog. What remains inside the block becomes a landscaped courtyard,
// rear gardens, or (at high density) a parking structure wrapped by the perimeter buildings.
// Nothing is left as unexplained bare land.

import { sectionWidth } from "@/geometry/crossSection";
import { isValidPoly, polyArea, polyCentroid } from "@/geometry/polygon";
import { closestOnPath } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import type { ParamValues } from "@/library";
import type { Polygon, Street, Vec2 } from "@/world/types";
import type { DensityClass, Programme } from "./programme";
import type { StreetRole } from "./streets";
import { CORNER_STORE, OFFICE, OFFICE_TOWER, PALETTES, PERIMETER, PERIMETER_FROM, edgeDepth, pickFacade, typologyFor, type Typology } from "./typologies";
import type { PaletteName } from "./programme";
import { type EdgeFrame, type Rng, clamp, cleanRing, clip, edgeFrame, efExtent, efPt, efRect, headingFacing, makeRng, minWidth, minus, smooth, splitLength } from "./util";

// ---------------------------------------------------------------- block analysis

export interface BlockEdge {
  f: EdgeFrame;
  role: StreetRole | "none";
  street?: string;
  /** street name (for addresses / reporting) */
  streetName?: string;
  /** depth of the block measured from this edge, m */
  across: number;
}

export interface Block {
  key: string;
  poly: Polygon;
  edges: BlockEdge[];
  centroid: Vec2;
  area: number;
}

export interface StreetRef {
  s: Street;
  role: StreetRole;
  half: number;
}

export const roleOfClass = (cls: Street["cls"]): StreetRole => (cls === "primary" || cls === "trunk" ? "boulevard" : cls === "secondary" ? "avenue" : cls === "tertiary" ? "collector" : "local");

/** classify a block's edges by the street each one fronts */
export function analyseBlock(key: string, poly: Polygon, streets: StreetRef[]): Block {
  const ring = cleanRing(poly[0]);
  const p: Polygon = [ring];
  const edges: BlockEdge[] = [];
  for (let i = 0; i < ring.length; i++) {
    const f = edgeFrame(ring[i], ring[(i + 1) % ring.length]);
    if (f.len < 4) continue;
    const mid = efPt(f, f.len / 2, -1.5);
    let best: StreetRef | undefined,
      bd = Infinity;
    for (const s of streets) {
      const c = closestOnPath(mid, s.s.path);
      if (c.d < s.half + 6 && c.d < bd) {
        bd = c.d;
        best = s;
      }
    }
    const [, , , t1] = efExtent(f, p);
    edges.push({ f, role: best?.role ?? "none", street: best?.s.id, streetName: best?.s.name, across: t1 });
  }
  return { key, poly: p, edges, centroid: polyCentroid(p), area: polyArea(p) };
}

export function streetRefs(streets: Street[], roleOf: (s: Street) => StreetRole): StreetRef[] {
  return streets.map((s) => ({ s, role: roleOf(s), half: sectionWidth(s.section) / 2 }));
}

// ---------------------------------------------------------------- lots

export type LotKind = "building" | "green" | "reserved";

export interface Lot {
  block: string;
  poly: Polygon;
  edge: BlockEdge;
  /** frontage interval along the edge */
  s0: number;
  s1: number;
  depth: number;
  score: number;
  corner: boolean;
  t: Typology;
  floors: number;
  retail: boolean;
  /** site the building is drawn on (site / row placement) */
  site?: Polygon;
  /** placement point for point-placed types */
  at?: Vec2;
  heading: number;
  homes: number;
  jobs: number;
  gfa: number;
  /** yard / forecourt left on the lot (landscaped) */
  yard: Polygon[];
  name?: string;
  facade?: string;
  /** typology-specific numbers (house sizes and setbacks) */
  data?: Record<string, unknown>;
}

/** a frontage interval taken before subdivision (facilities, pocket parks, plazas, restaurants) */
export interface Reservation {
  block: string;
  edge: number;
  s0: number;
  s1: number;
  depth: number;
  kind: string;
  poly: Polygon;
  data?: Record<string, unknown>;
}

export interface FabricPlan {
  lots: Lot[];
  /** share of floor area in retail at grade */
  retailShare: number;
  cores: { block: string; poly: Polygon; garage: boolean; family: "yard" | "perimeter" }[];
  greens: Polygon[];
  homes: number;
  jobs: number;
  gfa: number;
}

export interface FabricOptions {
  intensity: number;
  prog: Programme;
  centre: Vec2;
  /** distance at which the centre's pull has faded (m) */
  radius: number;
  seed: number;
  palette: PaletteName;
  /** positions of parks (frontage bonus) */
  parks: Polygon[];
  reservations: Reservation[];
  /** jobs still to place in offices (after civic / retail) */
  officeJobs: number;
  /** the brief asks for shops: main streets get shopfronts even in a low-density programme */
  shops?: boolean;
  /** share of floor area to put in retail at grade (mix.retail) */
  retailShare?: number;
}

const ROLE_BONUS: Record<StreetRole | "none", number> = { boulevard: 1.3, avenue: 1.0, main: 1.1, collector: 0.5, local: -0.35, none: -0.5 };
const RETAIL_ROLES = new Set<StreetRole | "none">(["boulevard", "avenue", "main"]);

/** density → how much of the intensity ladder a programme may use */
export const INTENSITY_RANGE: Record<DensityClass, [number, number]> = { low: [-1.5, 2.2], medium: [0.5, 5.2], high: [2.5, 7.4], very_high: [4, 9.5] };

function edgeScore(e: BlockEdge, blk: Block, o: FabricOptions): number {
  const d = dist(efPt(e.f, e.f.len / 2, 0), o.centre);
  // the centre's pull: dense programmes peak sharply (towers at the core, mid-rise around it)
  const pull = o.prog.density === "very_high" ? 3 : o.prog.density === "high" ? 2.6 : 1.5;
  const centre = pull * (1 - smooth(d / o.radius));
  const park = o.parks.some((p) => dist(polyCentroid(p), efPt(e.f, e.f.len / 2, -15)) < 60) ? 0.3 : 0;
  return o.intensity + ROLE_BONUS[e.role] + centre + park;
}

/** plan every block's lots for an intensity (pure: nothing is placed) */
export function planFabric(blocks: Block[], o: FabricOptions): FabricPlan {
  const lots: Lot[] = [];
  const cores: FabricPlan["cores"] = [];
  const greens: Polygon[] = [];
  const pal = PALETTES[o.palette];
  for (const blk of blocks) {
    const rng = makeRng((o.seed ^ hashKey(blk.key)) >>> 0);
    const res = o.reservations.filter((r) => r.block === blk.key);
    const claimed: Polygon[] = res.map((r) => r.poly);
    const order = blk.edges.map((e, i) => ({ e, i, s: edgeScore(e, blk, o) })).sort((p, q) => roleRank(q.e.role) - roleRank(p.e.role) || q.e.f.len - p.e.f.len);
    let perimeter = 0,
      yard = 0,
      blockScore = -Infinity;
    for (const { e, s } of order) {
      blockScore = Math.max(blockScore, s);
      // main streets are continuous shopfront frontage wherever the programme is urban
      const fam = (o.prog.density !== "low" && s >= PERIMETER_FROM) || (e.role === "main" && (o.prog.density !== "low" || o.shops)) ? "perimeter" : "yard";
      let d = edgeDepth(fam, s, e.across / 2);
      if (fam === "perimeter" && e.across < 2 * d + 12) d = Math.max(12, e.across / 2);
      if (fam === "yard") d = Math.min(d, Math.max(18, e.across / 2));
      if (d < 8) continue;
      const strip = clip(efRect(e.f, -1, e.f.len + 1, 0, d), blk.poly, 4);
      const free = strip.flatMap((q) => minus(q, claimed, 6));
      for (const piece of free) {
        const [ps0, ps1] = efExtent(e.f, piece);
        const len = ps1 - ps0;
        if (len < 5) {
          greens.push(piece);
          claimed.push(piece);
          continue;
        }
        const startCorner = ps0 < 1.5 || dist(efPt(e.f, ps0, 0), e.f.a) < d + 2;
        const endCorner = ps1 > e.f.len - 1.5;
        const baseT = typologyFor(s, fam, o.prog.maxFloors);
        // main-street shophouses: fine grain where the programme is moderate
        const shop = fam === "perimeter" && e.role === "main" && s < 5.6 && o.prog.density !== "very_high";
        const t0 = shop ? PERIMETER.find((t) => t.key === "shophouse")! : baseT;
        const mean = (t0.frontage[0] + t0.frontage[1]) / 2;
        const n = Math.max(1, Math.round(len / mean));
        const widths = splitLength(len, n, rng, 0.22);
        let a = ps0;
        let prevFacade: string | undefined;
        for (let k = 0; k < n; k++) {
          const b = a + widths[k];
          const corner = (k === 0 && startCorner) || (k === n - 1 && endCorner);
          const lp = clip(piece, efRect(e.f, a, b, -1, d + 1), 4).sort((x, y) => polyArea(y) - polyArea(x))[0];
          a = b;
          if (!lp) continue;
          if (polyArea(lp) < 40 || minWidth(lp) < 4.5) {
            greens.push(lp);
            continue;
          }
          const score = s + (corner ? 0.35 : 0) + rng.range(-0.45, 0.45);
          let t = shop && !corner ? t0 : typologyFor(score, fam, o.prog.maxFloors);
          // a street of houses mixes plans: two-storey, L-shaped, cottages, ranches on wide lots
          if (fam === "yard" && t.key === "house") t = { ...t, def: rng.weighted(["housing.single_family_home", "housing.l_shaped_house", "housing.cottage", "housing.ranch_house"], [0.4, 0.25, 0.15, widths[k] >= 19 ? 0.25 : 0]) };
          if (fam === "yard" && t.key === "plex" && rng.chance(0.4)) t = { ...t, def: "housing.triplex", homes: 3 };
          const lot = makeLot(blk, e, lp, b - widths[k], b, d, score, corner, t, rng, o, pal, prevFacade);
          if (!lot) {
            greens.push(lp);
            continue;
          }
          prevFacade = lot.facade;
          lots.push(lot);
        }
        claimed.push(piece);
      }
      if (fam === "perimeter") perimeter++;
      else yard++;
    }
    // what is left inside the block: courtyard / rear gardens / parking structure
    const core = minus(blk.poly, claimed, 8);
    const fam = perimeter >= yard ? "perimeter" : "yard";
    for (const c of core) {
      const garage = fam === "perimeter" && blockScore >= 5.2 && o.prog.density !== "low" && o.prog.density !== "medium" && polyArea(c) > 1500 && minWidth(c) > 32 && rng.chance(o.prog.density === "very_high" ? 0.75 : 0.5);
      cores.push({ block: blk.key, poly: c, garage, family: fam });
    }
  }
  // offices for jobs: the most central, best-connected perimeter lots
  let need = o.officeJobs;
  if (need > 0) {
    const cands = lots.filter((l) => l.t.family === "perimeter" && l.t.key !== "shophouse" && (l.edge.role === "boulevard" || l.edge.role === "avenue" || l.edge.role === "main" || l.edge.role === "collector") && l.score >= 4.8 && l.depth >= 17).sort((p, q) => q.score - p.score);
    const rng = makeRng(o.seed ^ 0x0ff1ce);
    for (const l of cands) {
      if (need <= 0) break;
      if (rng.chance(0.35)) continue; // keep housing in the mix on every main street
      const tower = (l.t.key === "tower" || l.score >= 7.2) && o.prog.maxFloors >= 20 && l.depth >= 26;
      const t = tower ? OFFICE_TOWER : OFFICE;
      const nl = makeLot({ key: l.block } as Block, l.edge, l.poly, l.s0, l.s1, l.depth, l.score, l.corner, t, rng, o, pal, undefined);
      if (!nl) continue;
      Object.assign(l, nl);
      need -= l.jobs;
    }
  }
  const gfaAll = lots.reduce((t, l) => t + l.gfa, 0);
  const rg = lots.reduce((t, l) => t + (l.retail && l.site ? polyArea(l.site) : 0), 0);
  return { lots, cores, greens, retailShare: gfaAll > 0 ? rg / gfaAll : 0, homes: lots.reduce((s, l) => s + l.homes, 0), jobs: lots.reduce((s, l) => s + l.jobs, 0), gfa: lots.reduce((s, l) => s + l.gfa, 0) };
}

/** retail at grade up to the programme's share (run once on the solved plan) */
export function applyRetail(plan: FabricPlan, o: FabricOptions): void {
  const lots = plan.lots;
  // retail at grade up to the programme's share: corners first, then the busier streets, nearest the centre
  const gfaAll = lots.reduce((t, l) => t + l.gfa, 0);
  const retailGfa = () => lots.reduce((t, l) => t + (l.retail && l.site ? polyArea(l.site) : 0), 0);
  let rg = retailGfa();
  if ((o.retailShare ?? 0) > 0 && rg < (o.retailShare ?? 0) * gfaAll) {
    const cands = lots
      .filter((l) => !l.retail && l.site && l.t.family === "perimeter" && l.t.use !== "office" && l.t.key !== "urban_townhouse")
      .sort((p, q) => Number(q.corner) - Number(p.corner) || roleRank(q.edge.role) - roleRank(p.edge.role) || dist(polyCentroid(p.site!), o.centre) - dist(polyCentroid(q.site!), o.centre));
    for (const l of cands) {
      if (rg >= (o.retailShare ?? 0) * gfaAll) break;
      const fp = polyArea(l.site!);
      l.retail = true;
      l.homes = Math.max(0, l.homes - (fp * 0.82) / 78);
      l.jobs += fp / 45;
      rg += fp;
    }
    // still short: corner stores on residential corners, spread so shops are near every home
    const shopsAt = lots.filter((l) => l.retail).map((l) => polyCentroid(l.poly));
    const corners = lots.filter((l) => !l.retail && l.corner && l.t.family === "yard" && l.s1 - l.s0 >= 10 && l.depth >= 20);
    const rng = makeRng(o.seed ^ 0xc0e5);
    while (rg < (o.retailShare ?? 0) * gfaAll && corners.length) {
      corners.sort((p, q) => nearestD(polyCentroid(q.poly), shopsAt) - nearestD(polyCentroid(p.poly), shopsAt));
      const l = corners.shift()!;
      if (nearestD(polyCentroid(l.poly), shopsAt) < 150) break;
      const e = l.edge;
      const depth = rng.range(CORNER_STORE.depth[0], CORNER_STORE.depth[1]);
      const front = rng.range(CORNER_STORE.front[0], CORNER_STORE.front[1]);
      const site = clip(l.poly, efRect(e.f, l.s0 + 1, l.s1 - 1, front, front + depth), 4).sort((x, y) => polyArea(y) - polyArea(x))[0];
      if (!site || polyArea(site) < 60) continue;
      const fp = polyArea(site);
      const floors = rng.int(CORNER_STORE.floors[0], CORNER_STORE.floors[1]);
      Object.assign(l, { t: CORNER_STORE, site, at: undefined, data: undefined, yard: minus(l.poly, [site], 6), floors, retail: true, gfa: fp * floors, homes: (fp * (floors - 1) * 0.82) / 78, jobs: fp / 45, facade: pickFacade(PALETTES[o.palette], "shop", rng) });
      shopsAt.push(polyCentroid(l.poly));
      rg += fp;
    }
  }
  plan.retailShare = gfaAll > 0 ? rg / gfaAll : 0;
  plan.homes = lots.reduce((t, l) => t + l.homes, 0);
  plan.jobs = lots.reduce((t, l) => t + l.jobs, 0);
}

const nearestD = (p: Vec2, ps: Vec2[]) => ps.reduce((m, q) => Math.min(m, dist(p, q)), Infinity);
const roleRank = (r: StreetRole | "none") => ({ boulevard: 5, avenue: 4, main: 3.5, collector: 3, local: 2, none: 0 })[r];
const hashKey = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

function makeLot(blk: Block, e: BlockEdge, lp: Polygon, s0: number, s1: number, d: number, score: number, corner: boolean, t: Typology, rng: Rng, o: FabricOptions, pal: (typeof PALETTES)[PaletteName], prevFacade: string | undefined): Lot | null {
  const heading = headingFacing([-e.f.n[0], -e.f.n[1]]);
  const front = rng.range(t.front[0], t.front[1]);
  const w = s1 - s0;
  const maxF = o.prog.maxFloors;
  // floors: position within the rung, ±1 for a lively skyline, capped by the programme
  const frac = clamp((score - Math.floor(score)) * 0.6 + rng.next() * 0.4, 0, 1);
  let floors = Math.round(t.floors[0] + (t.floors[1] - t.floors[0]) * frac);
  floors = clamp(floors, Math.min(o.prog.minFloors, t.floors[0]), Math.min(maxF, t.floors[1] + 1));
  const retail = t.family === "perimeter" && t.use !== "office" && t.key !== "urban_townhouse" && (RETAIL_ROLES.has(e.role) || (e.role === "collector" && score >= 4.6) || (corner && dist(efPt(e.f, (s0 + s1) / 2, 0), o.centre) < o.radius * 0.35));
  const facade = pickFacade(pal, t.facades, rng, prevFacade);
  const lot: Lot = { block: blk.key, poly: lp, edge: e, s0, s1, depth: d, score, corner, t, floors, retail, heading, homes: 0, jobs: 0, gfa: 0, yard: [], facade };
  if (t.family === "perimeter") {
    const bd = Math.min(d, Math.max(t.depth[0], d));
    const zone = clip(lp, efRect(e.f, s0 - 1, s1 + 1, front, Math.min(d, front + bd)), 4).sort((x, y) => polyArea(y) - polyArea(x))[0];
    if (!zone || polyArea(zone) < 30) return null;
    lot.site = zone;
    lot.yard = minus(lp, [zone], 6);
    const fp = polyArea(zone);
    if (t.key === "urban_townhouse") {
      const units = Math.max(1, Math.floor(w / 6));
      lot.homes = units;
      lot.gfa = units * 6 * t.depth[1] * floors;
      // rowhouses keep a rear patio: the row is shallower than the lot
      const z2 = clip(lp, efRect(e.f, s0 - 1, s1 + 1, front, front + t.depth[1]), 4)[0];
      if (z2) {
        lot.site = z2;
        lot.yard = minus(lp, [z2], 6);
      }
    } else {
      const tower = t.key === "tower" || t.key === "office_tower";
      const podium = tower ? 4 : 0;
      const plate = tower ? Math.min(fp * 0.55, 950) : fp;
      lot.gfa = tower ? fp * podium + plate * Math.max(0, floors - podium) : fp * floors;
      const retailShare = retail ? fp / Math.max(1, lot.gfa) : 0;
      if (t.use === "office") lot.jobs = (lot.gfa * (1 - retailShare)) / 23 + (lot.gfa * retailShare) / 45;
      else {
        lot.homes = (lot.gfa * (1 - retailShare) * 0.82) / 78;
        lot.jobs = (lot.gfa * retailShare) / 45;
      }
    }
    return lot;
  }
  // yard family: building at the front of the lot, garden behind
  const bd = rng.range(t.depth[0], t.depth[1]);
  if (front + bd + 4 > d) return null;
  const side = t.side;
  if (w - 2 * side < 6) return null;
  if (t.place === "point") {
    const bw = Math.min(w - 2 * side, t.key === "house" ? rng.range(10, 13) : rng.range(12, 15));
    lot.at = efPt(e.f, (s0 + s1) / 2, front + bd / 2);
    lot.site = efRect(e.f, (s0 + s1) / 2 - bw / 2, (s0 + s1) / 2 + bw / 2, front, front + bd);
    lot.homes = t.homes ?? 1;
    lot.gfa = bw * bd * floors;
    lot.yard = [];
    lot.data = { width: bw, depth: bd, front, rear: d - front - bd, sideSetback: Math.max(0.5, (w - bw) / 2 - 0.3), lotW: w };
    return lot;
  }
  const zone = clip(lp, efRect(e.f, s0 + side, s1 - side, front, front + bd), 4).sort((x, y) => polyArea(y) - polyArea(x))[0];
  if (!zone || polyArea(zone) < 40) return null;
  lot.site = zone;
  lot.yard = minus(lp, [zone], 6);
  const fp = polyArea(zone);
  lot.gfa = fp * floors;
  if (t.place === "row") lot.homes = Math.max(1, Math.floor((s1 - s0 - 2 * side) / 6.5));
  else lot.homes = (lot.gfa * 0.82) / 78;
  return lot;
}

// ---------------------------------------------------------------- building params per lot

/** the library placement for a lot */
export function lotPlacement(l: Lot, rng: Rng, palette: PaletteName, suburban = true): { def: string; params: ParamValues; site?: Polygon; at?: Vec2; rotation: number } | null {
  const pal = PALETTES[palette];
  const t = l.t;
  const flatRoof = () => (rng.chance(0.18) ? { roofType: "flat", greenRoof: true } : rng.chance(0.15) ? { roofType: "flat", solar: true, roofMaterial: "white_membrane" } : { roofType: "flat", roofMaterial: rng.pick(["gravel", "white_membrane", "gravel"]) });
  const name = l.name ? { name: l.name } : {};
  if (t.place === "point") {
    const d = l.data as { width: number; depth: number; front: number; rear: number; sideSetback: number; lotW: number };
    // urban fabric parks on the street (or rear lanes): no front driveways / garages
    const garage = suburban && d.lotW - d.width > 8.5 && t.key === "house" ? "attached" : "none";
    return {
      def: t.def,
      at: l.at,
      rotation: l.heading,
      params: { width: garage === "attached" ? Math.min(d.width, d.lotW - 8.5) : t.def === "housing.ranch_house" ? Math.min(d.lotW - 2 * 1.5, 18) : d.width, depth: d.depth, floors: t.def === "housing.ranch_house" || t.def === "housing.cottage" ? 1 : l.floors, facade: l.facade, roofMaterial: rng.pick(pal.pitched), roofType: rng.pick(["gable", "hip", "gable"]), yard: true, frontSetback: d.front, rearSetback: Math.max(1, d.rear), sideSetback: d.sideSetback, driveway: suburban, garage, garageCars: 2, porch: rng.chance(0.6), chimney: rng.chance(0.25), fitToSite: false, ...name },
    };
  }
  if (!l.site || !isValidPoly(l.site)) return null;
  if (t.place === "row") {
    const flat = t.key === "urban_townhouse" || rng.chance(0.5);
    return {
      def: t.def,
      site: l.site,
      rotation: l.heading,
      params: { fitToSite: true, unitWidth: rng.range(5.6, 7.2), depth: t.depth[1], floors: l.floors, heightVariation: 0, varyColour: false, stagger: rng.pick([0, 0, 0.6]), facade: l.facade, ...(flat ? { roofType: "flat", parapetHeight: 0.9 } : { roofType: "gable", ridge: "short", roofPitch: rng.range(30, 40), roofMaterial: rng.pick(pal.pitched), overhang: 0 }), ...name },
    };
  }
  const base: ParamValues = { shape: "site", floors: l.floors, facade: l.facade, siteInset: 0, ...name };
  // balconies are generated on every wall; on attached (party-wall) buildings they would project into
  // the neighbour, so only free-standing buildings and towers above their podium get them
  const balc = (p: number) => (t.side > 0 || t.key === "tower" ? rng.chance(p) : false);
  switch (t.key) {
    case "walkup":
      return { def: t.def, site: l.site, rotation: l.heading, params: { ...base, ...(rng.chance(0.45) ? { roofType: "hip", roofPitch: 22, roofMaterial: rng.pick(pal.pitched), parapetHeight: 0 } : flatRoof()), balconies: balc(0.5) } };
    case "shophouse":
      return { def: t.def, site: l.site, rotation: l.heading, params: { ...base, groundUse: "retail", awning: rng.chance(0.7), awningColor: rng.pick(["#b65a3c", "#2a5a3c", "#3c6ca8", "#7a4a2a", "#24395e"]), parapetHeight: rng.range(0.8, 1.8) } };
    case "apartments":
      return { def: t.def, site: l.site, rotation: l.heading, params: { ...base, ...flatRoof(), balconies: balc(0.55), groundUse: l.retail ? "retail" : "same", awning: l.retail && rng.chance(0.6) } };
    case "five_over_one":
      return { def: t.def, site: l.site, rotation: l.heading, params: { ...base, ...flatRoof(), podiumFloors: 1, towerCoverage: 100, groundUse: l.retail ? "retail" : "same", awning: l.retail, balconies: balc(0.6), setbackEvery: rng.chance(0.2) ? l.floors - 1 : 0, setbackDepth: 2 } };
    case "midrise":
      return { def: t.def, site: l.site, rotation: l.heading, params: { ...base, ...flatRoof(), use: "residential", groundUse: l.retail ? "retail" : "same", groundFloorHeight: l.retail ? 5 : 0, awning: l.retail && rng.chance(0.5), balconies: balc(0.5), setbackEvery: rng.chance(0.4) ? Math.max(4, l.floors - 2) : 0, setbackDepth: 2.5, penthouse: rng.chance(0.5) } };
    case "tower": {
      const podium = rng.int(3, 5);
      return { def: t.def, site: l.site, rotation: l.heading, params: { ...base, ...flatRoof(), podiumFloors: podium, towerCoverage: clamp(Math.round((Math.min(950, polyArea(l.site) * 0.6) / polyArea(l.site)) * 100), 30, 70), towerOffsetY: -rng.range(0, 3), groundUse: l.retail ? "retail" : "same", balconies: balc(0.7), topScale: rng.chance(0.2) ? 85 : 100, setbackEvery: rng.chance(0.25) ? 8 : 0, setbackDepth: 1.5, penthouse: true } };
    }
    case "corner_store":
      return { def: t.def, site: l.site, rotation: l.heading, params: { ...base, ...flatRoof(), use: "residential", groundUse: "retail", awning: true, awningColor: rng.pick(["#b65a3c", "#2a5a3c", "#3c6ca8", "#7a4a2a"]), parapetHeight: rng.range(0.9, 1.6) } };
    case "office":
      return { def: t.def, site: l.site, rotation: l.heading, params: { ...base, ...flatRoof(), groundUse: "retail", penthouse: true, setbackEvery: rng.chance(0.3) ? Math.max(4, l.floors - 3) : 0, setbackDepth: 3 } };
    case "office_tower":
      return { def: t.def, site: l.site, rotation: l.heading, params: { ...base, roofType: "flat", podiumFloors: rng.int(3, 5), towerCoverage: 55, groundUse: "retail", penthouse: true, topScale: rng.chance(0.3) ? 80 : 100 } };
    default:
      return { def: t.def, site: l.site, rotation: l.heading, params: { ...base, ...flatRoof() } };
  }
}
