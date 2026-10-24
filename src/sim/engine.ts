// Simulation engine (runs inside a Web Worker; also usable headlessly).
// Keeps its own World copy and moves between scenarios by reverting/applying
// changesets, so every analysis runs on exactly the geometry the user sees.

import { polyCentroid } from "@/geometry/polygon";
import { pathBBox, polyLength as polyLengthOf } from "@/geometry/polyline";
import { programmeOf } from "@/world/ops/core";
import type { CensusBlock, CityMeta, CountStation, Entity, Vec2 } from "@/world/types";
import { World, type Changeset } from "@/world/world";
import { multiSource, nearestNodeIndex, nodeGrid, prepareAccess, reachable, runAccess } from "./access";
import { allocateGrowth } from "./growth";
import { runBike } from "./bike";
import { optimizeEmergency, type EmChangeKind } from "./emergency";
import { parcelCapacity, scenarioMetrics, type CapacityOptions } from "./capacity";
import { runFlood, runRunoff, DESIGN_STORMS } from "./environment";
import { heatReference, runHeat, sunHours, type HeatReference } from "./heat";
import { buildContextLandcover, contextGrid, type ContextInput } from "./contextLandcover";
import { buildLandcover, coverStats, IMPERVIOUS, LC, prepareLandcover, type Landcover } from "./landcover";
import { prepareTraffic } from "./prepareTraffic";
import { runTraffic, HOURLY_PROFILE } from "./traffic";
import { rasterizeRings, type GridSpec } from "./raster";

export interface EngineInit {
  meta: CityMeta & { grid: GridSpec };
  entities: Entity[];
  landcover: Uint8Array;
  dem: Uint16Array;
  census: CensusBlock[];
  counts: CountStation[];
  utcOffset: number;
  /** surrounding city, for the heat / shade / runoff maps beyond the study area */
  context?: ContextInput;
  /** measured canopy / minor paving on the context grid (base-raster encoding) */
  contextCover?: Uint8Array;
}

export type SimKind = "traffic" | "heat" | "context" | "runoff" | "flood" | "access" | "capacity" | "sun" | "metrics" | "sites" | "bike" | "emergency_opt" | "growth";

export interface SimJob {
  id: string;
  kind: SimKind;
  changesets: Changeset[];
  params: Record<string, unknown>;
}

export class Engine {
  world: World;
  applied: Changeset[] = [];
  baselineUnits = 0;
  private lcCache: { key: string; lc: Landcover; masses: { rings: number[][][]; base: number; top: number }[]; trees: { p: [number, number]; r: number; h: number }[] } | null = null;

  constructor(readonly init: EngineInit) {
    this.world = new World(init.meta);
    this.world.load(init.entities);
    this.world.takeDirty();
    let u = 0;
    for (const b of this.world.all("building")) u += programmeOf(b).units;
    this.baselineUnits = u;
  }

  /** move the engine's world to the scenario state described by `changesets` */
  setScenario(css: Changeset[]) {
    let common = 0;
    while (common < this.applied.length && common < css.length && this.applied[common].id === css[common].id) common++;
    for (let i = this.applied.length - 1; i >= common; i--) this.world.revert(this.applied[i]);
    for (let i = common; i < css.length; i++) this.world.apply(css[i]);
    this.applied = css.slice();
    this.world.takeDirty();
  }

  private key() {
    return this.applied.map((c) => c.id).join(",");
  }

  landcover() {
    const k = this.key();
    if (this.lcCache?.key === k) return this.lcCache;
    const li = prepareLandcover(this.world.entities.values(), this.world.streetGeom, this.world.nodeGeom, this.init.meta.grid, this.init.landcover);
    const lc = buildLandcover(li);
    this.lcCache = { key: k, lc, masses: li.buildings.flatMap((b) => b.masses), trees: li.trees };
    return this.lcCache;
  }

  private ref: HeatReference | null = null;
  private ctxLc: Landcover | null = null;
  /** baseline neighbourhood means shared by every scenario's heat run */
  private heatRef(changesets: SimJob["changesets"]): HeatReference {
    if (this.ref) return this.ref;
    this.setScenario([]);
    this.ref = heatReference(this.landcover().lc);
    this.setScenario(changesets);
    return this.ref;
  }

  run(job: SimJob, progress: (p: number) => void): { result: unknown; transfer: ArrayBuffer[] } {
    this.setScenario(job.changesets);
    const meta = this.init.meta;
    const P = job.params as Record<string, never>;
    switch (job.kind) {
      case "traffic": {
        const period = (P.period as "am" | "pm") ?? "pm";
        const extra = (P.extraResidents as { p: Vec2; residents: number }[] | undefined) ?? [];
        const { input, net } = prepareTraffic(this.world.entities, meta, this.init.counts, { period, demandScale: (P.demandScale as number) ?? 1, iterations: (P.iterations as number) ?? 20 }, { extraResidents: extra });
        const r = runTraffic(input, progress);
        // link geometry for rendering (offset to the travel side happens on the client)
        const paths: number[][] = [];
        const meta2: { street: string; name?: string; cls: string; lanes: number; capacity: number; length: number }[] = [];
        for (const l of net.links) {
          const s = this.world.street(l.streetId);
          let p = s ? s.path : [net.nodes[l.a].p, net.nodes[l.b].p];
          if (s && s.from !== l.from) p = p.slice().reverse();
          paths.push(p.flat());
          meta2.push({ street: l.streetId, name: l.name, cls: l.cls, lanes: l.lanes, capacity: l.capacity, length: l.length });
        }
        const nodes = r.nodes.slice(0, 400).map((n) => ({ ...n, id: net.nodes[n.node].id, p: net.nodes[n.node].p, name: [...new Set(this.world.incident(net.nodes[n.node].id).map((s) => s.name).filter(Boolean))].join(" / ") }));
        const result = { ...r, nodes, paths, links: meta2, gateways: input.gateways.map((g) => ({ p: g.p, inbound: g.inbound, outbound: g.outbound, name: g.name, calibrated: g.calibrated })), hourly: HOURLY_PROFILE };
        return { result, transfer: [r.flows.buffer, r.vc.buffer, r.time.buffer, r.speed.buffer] as ArrayBuffer[] };
      }
      case "heat": {
        const ref = this.heatRef(job.changesets);
        const { lc, masses, trees } = this.landcover();
        const hours = (P.hours as number[]) ?? [7, 9, 11, 13, 15, 17, 19];
        const blocks = this.init.census.map((c) => ({ id: c.geoid, rings: c.poly }));
        const wx = (P.weather as { t: number[]; sw: number[] } | undefined) ?? meta.weather.hourly;
        const r = runHeat(lc, { t: wx.t, sw: wx.sw }, { date: (P.date as string) ?? meta.weather.date, deltaT: (P.deltaT as number) ?? 0, hours, lat: meta.origin.lat, lon: meta.origin.lon, utcOffset: (P.utcOffset as number) ?? this.init.utcOffset, masses, trees, blocks, ref }, progress);
        const cover = coverStats(lc);
        // centroid for each hottest block
        const hb = r.hottestBlocks.map((b) => {
          const c = this.init.census.find((x) => x.geoid === b.id);
          return { ...b, p: c ? polyCentroid(c.poly) : ([0, 0] as Vec2), pop: c?.pop ?? 0 };
        });
        return { result: { ...r, shade: [], hottestBlocks: hb, cover, grid: meta.grid }, transfer: [...r.exposure, ...r.surface].map((a) => a.buffer as ArrayBuffer) };
      }
      case "context": {
        // the surrounding city (study-area edits can't reach it, so it is scenario-independent)
        if (!this.init.context) throw new Error("no context city in this pack");
        this.ctxLc ??= buildContextLandcover(this.init.context, contextGrid(meta.bounds), this.init.contextCover);
        const lc = this.ctxLc;
        const model = (P.model as string) ?? "heat";
        if (model === "sun") {
          const grid = sunHours(lc, [], [], (P.date as string) ?? "2026-03-20", meta.origin.lat, meta.origin.lon, (P.utcOffset as number) ?? this.init.utcOffset);
          return { result: { model, grid, gridSpec: lc.grid }, transfer: [grid.buffer as ArrayBuffer] };
        }
        if (model === "runoff") {
          const r = runRunoff(lc, ((P.storm as string) ?? "25yr") as keyof typeof DESIGN_STORMS, []);
          return { result: { model, grid: r.grid, gridSpec: lc.grid }, transfer: [r.grid.buffer as ArrayBuffer] };
        }
        const ref = this.heatRef(job.changesets);
        const hours = (P.hours as number[]) ?? [7, 9, 11, 13, 15, 17, 19];
        const wx = (P.weather as { t: number[]; sw: number[] } | undefined) ?? meta.weather.hourly;
        const r = runHeat(lc, { t: wx.t, sw: wx.sw }, { date: (P.date as string) ?? meta.weather.date, deltaT: (P.deltaT as number) ?? 0, hours, lat: meta.origin.lat, lon: meta.origin.lon, utcOffset: (P.utcOffset as number) ?? this.init.utcOffset, masses: [], trees: [], ref }, progress);
        return { result: { model, hours: r.hours, exposure: r.exposure, surface: r.surface, airTemp: r.airTemp, gridSpec: lc.grid }, transfer: [...r.exposure, ...r.surface].map((a) => a.buffer as ArrayBuffer) };
      }
      case "sun": {
        const { lc, masses, trees } = this.landcover();
        const grid = sunHours(lc, masses, trees, (P.date as string) ?? "2026-03-20", meta.origin.lat, meta.origin.lon, (P.utcOffset as number) ?? this.init.utcOffset);
        let stats: Record<string, number> | null = null;
        const area = P.area as number[][][] | undefined;
        if (area) {
          let s = 0,
            n = 0,
            full = 0;
          const g = meta.grid;
          const xs = area[0].map((p) => p[0]),
            ys = area[0].map((p) => p[1]);
          for (let j = 0; j < g.ny; j++)
            for (let i = 0; i < g.nx; i++) {
              const x = g.x0 + (i + 0.5) * g.cell,
                y = g.y0 + (j + 0.5) * g.cell;
              if (x < Math.min(...xs) || x > Math.max(...xs) || y < Math.min(...ys) || y > Math.max(...ys)) continue;
              if (!pip([x, y], area[0] as Vec2[])) continue;
              s += grid[j * g.nx + i];
              n++;
              if (grid[j * g.nx + i] >= 4) full++;
            }
          stats = { meanHours: n ? s / n : 0, cells: n, shareOver4h: n ? full / n : 0 };
        }
        return { result: { grid, stats, date: P.date ?? "2026-03-20", gridSpec: meta.grid }, transfer: [grid.buffer as ArrayBuffer] };
      }
      case "runoff": {
        const { lc } = this.landcover();
        const storage: { volumeM3: number; label: string }[] = [];
        for (const a of this.world.all("area")) {
          if (a.type === "retention") storage.push({ volumeM3: areaOf(a.poly) * (a.depth ?? 1.5), label: a.name ?? "retention pond" });
          if (a.type === "raingarden") storage.push({ volumeM3: areaOf(a.poly) * 0.3, label: "rain garden" });
        }
        // kerbside bioretention strips: 0.15 m ponding + 0.15 m effective soil storage
        let bio = 0;
        for (const s of this.world.all("street")) for (const st of s.section.strips) if (st.bio) bio += st.width * polyLengthOf(s.path);
        if (bio > 0) storage.push({ volumeM3: bio * 0.3, label: "street rain gardens" });
        const storm = ((P.storm as string) ?? "25yr") as keyof typeof DESIGN_STORMS;
        const r = runRunoff(lc, storm, storage, this.init.census.map((c) => ({ id: c.geoid, rings: c.poly })), { imperviousIncrease: (P.impervious_increase as number) || undefined });
        // optional land-cover breakdown inside an area of interest
        let area: { m2: number; landM2: number; perviousM2: number; imperviousFraction: number; runoffM3: number } | null = null;
        const poly = P.area as number[][][] | undefined;
        if (poly) {
          const g = meta.grid;
          let n = 0,
            water = 0,
            imp = 0,
            q = 0;
          const surf = r.surface!;
          rasterizeRings(g, poly as [number, number][][], (i) => {
            n++;
            const c = surf[i];
            if (c === LC.WATER) return void water++;
            if (IMPERVIOUS.has(c)) imp++;
            q += r.grid[i];
          });
          const cellA = g.cell * g.cell;
          const land = n - water;
          // shares are of land only (open water is neither pervious ground nor impervious cover)
          area = { m2: n * cellA, landM2: land * cellA, perviousM2: (land - imp) * cellA, imperviousFraction: land ? imp / land : 0, runoffM3: (q / 1000) * cellA };
        }
        return { result: { ...r, surface: undefined, area, gridSpec: meta.grid }, transfer: [r.grid.buffer as ArrayBuffer] };
      }
      case "flood": {
        const { lc } = this.landcover();
        const rise = (P.rise as number) ?? 4;
        const r = runFlood(lc, this.init.dem, meta.grid, meta.waterLevel + rise, meta.waterLevel, this.world.all("building").map((b) => ({ id: b.id, rings: b.footprint, residents: programmeOf(b, meta.calibration.householdSize).residents })));
        return { result: { ...r, gridSpec: meta.grid }, transfer: [r.depth.buffer as ArrayBuffer] };
      }
      case "access": {
        const hh = meta.calibration.householdSize;
        const origins = this.world
          .all("building")
          .map((b) => ({ id: b.id, p: polyCentroid(b.footprint), w: programmeOf(b, hh).residents }))
          .filter((o) => o.w > 0.5);
        const inp = prepareAccess(this.world.entities.values(), origins);
        const r = runAccess(inp);
        const candidates = P.candidates as Vec2[] | undefined;
        const reach = candidates?.length ? reachable(inp, candidates, (P.minutes as number) ?? 10) : undefined;
        const transfer = [...Object.values(r.nodeMinutes).map((a) => a.buffer), ...Object.values(r.minutes).map((a) => a.buffer), r.score15.buffer] as ArrayBuffer[];
        return { result: { ...r, origins: origins.map((o) => ({ id: o.id, p: o.p, w: o.w })), reach }, transfer };
      }
      case "bike": {
        const hh = meta.calibration.householdSize;
        const origins = this.world
          .all("building")
          .map((b) => ({ p: polyCentroid(b.footprint), w: programmeOf(b, hh).residents }))
          .filter((o) => o.w > 0.5);
        return { result: runBike([...this.world.entities.values()], origins), transfer: [] };
      }
      case "emergency_opt": {
        const hh = meta.calibration.householdSize;
        const origins = this.world
          .all("building")
          .map((b) => ({ p: polyCentroid(b.footprint), w: programmeOf(b, hh).residents }))
          .filter((o) => o.w > 0.5);
        const g = meta.grid;
        const r = optimizeEmergency(this.world, origins, {
          maxChanges: P.maxChanges as number | undefined,
          minGain: P.minGain as number | undefined,
          allow: P.allow as EmChangeKind[] | undefined,
          bounds: [g.x0, g.y0, g.x0 + g.nx * g.cell, g.y0 + g.ny * g.cell],
        });
        return { result: r, transfer: [] };
      }
      case "growth": {
        const hh = meta.calibration.householdSize;
        const parcels = new Map(this.world.all("parcel").map((p) => [p.id, p]));
        const caps = parcelCapacity(this.world.entities, [...parcels.values()], {}).filter((c) => c.addedUnits > 0.5);
        // walking minutes from each lot to the nearest frequent-transit stop
        const origins = caps.map((c) => ({ id: c.id, p: polyCentroid(parcels.get(c.id)!.poly), w: 1 }));
        const inp = prepareAccess(this.world.entities.values(), origins);
        const nodes = inp.net.nodes.map((nd) => nd.p);
        const grid = nodeGrid(nodes);
        const d = multiSource(inp.net, inp.dests.frequent_transit.map((q) => nearestNodeIndex(nodes, grid, q)), 6000);
        const p0 = meta.calibration.censusPopulation;
        const years = (P.years as number) ?? 20;
        const r = allocateGrowth(
          caps.map((c, k) => {
            const par = parcels.get(c.id)!;
            const o = inp.origins[k];
            const m = o.node >= 0 ? d[o.node] / 1.3 / 60 : Infinity;
            return { id: c.id, addedUnits: c.addedUnits, landUse: par.landUse, historic: par.historic, value: par.value, owner: par.owner, transitMin: m };
          }),
          { p0, capacity: (P.capacity as number) ?? p0 * 1.8, rate: (P.rate as number) ?? 0.035, years, householdSize: hh, baseYear: 2020, snapshots: [5, 10, 15, 20, 25, 30].filter((y) => y < years).concat(years) },
        );
        return { result: r, transfer: [] };
      }
      case "capacity": {
        const ids = P.parcelIds as string[] | undefined;
        const parcels = ids?.length ? ids.map((id) => this.world.get(id)).filter((e): e is Extract<Entity, { kind: "parcel" }> => !!e && e.kind === "parcel") : this.world.all("parcel");
        const r = parcelCapacity(this.world.entities, parcels, (P.options as CapacityOptions) ?? {});
        return { result: { parcels: r }, transfer: [] };
      }
      case "metrics": {
        const m = scenarioMetrics(this.world.entities, meta.calibration.householdSize, meta.calibration.censusPopulation, this.baselineUnits);
        const { lc } = this.landcover();
        return { result: { ...m, cover: coverStats(lc) }, transfer: [] };
      }
      case "sites": {
        // score candidate sites by residents within a walk time (for squares, stations, schools)
        const hh = meta.calibration.householdSize;
        const origins = this.world
          .all("building")
          .map((b) => ({ id: b.id, p: polyCentroid(b.footprint), w: programmeOf(b, hh).residents + (P.includeJobs ? programmeOf(b).jobs * 0.5 : 0) }))
          .filter((o) => o.w > 0.5);
        // planned residents not yet in buildings (e.g. a future district)
        for (const [k, x] of ((P.extra as { p: Vec2; residents: number }[]) ?? []).entries()) origins.push({ id: `extra${k}`, p: x.p, w: x.residents });
        const inp = prepareAccess(this.world.entities.values(), origins);
        const cands = P.candidates as Vec2[];
        const reach = reachable(inp, cands, (P.minutes as number) ?? 10);
        return { result: { reach }, transfer: [] };
      }
    }
    throw new Error(`unknown sim ${job.kind}`);
  }
}

function areaOf(poly: number[][][]) {
  const r = poly[0];
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i],
      q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}
function pip(p: Vec2, r: Vec2[]) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (r[i][1] > p[1] !== r[j][1] > p[1] && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
  }
  return inside;
}
export { pathBBox };
