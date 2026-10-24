// Client-side tool executor: every agent tool maps onto the same world-model
// operations, simulations and view controls the user drives manually.

import { carriagewayWidth, describeSection, hasSidewalk, laneCount, sectionWidth } from "@/geometry/crossSection";
import { circle, convexHull, difference, intersection, isValidPoly, normalizePoly, overlapArea, pointInPoly, polyArea, polyBBox, polyCentroid, rectangle, unionMany, bufferPoly } from "@/geometry/polygon";
import { closestOnPath, curvatureStats, minRadiusForSpeed, pointAt, polyLength } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import { runSim, useSims, type SimRecord } from "@/sim/client";
import { TOOL_DEFS } from "./toolDefs";
import { schoolsNeeded, STUDENT_RATES, UNIT_COSTS } from "@/sim/capacity";
import { dqT } from "@/sim/heat";
import { GREEN_ROOF_SETBACK, plantedRoof } from "@/sim/landcover";
import { PED_ASSUMPTIONS, pedIndex, pedSources, shadeBenefit, walkable } from "@/sim/pedestrian";
import { rasterizeRings, sampleGrid } from "@/sim/raster";
import { rt } from "@/state/runtime";
import { useApp, type OverlayId } from "@/state/store";
import { overlayState } from "@/render/overlays";
import { flyTo, flyover, orbit, overview, pedestrianAt } from "@/render/camera";
import { buildNetwork, dijkstra, nearestNode, pathLinks, type NetLink } from "@/world/network";
import { bikeRoute, buildBikeNet, type BikeLink } from "@/sim/bike";
import { FIRE_LANE_WIDTH, type EmOptimizeResult, type EmPick } from "@/sim/emergency";
import { mergeBuildings, modifyBuildings, createBuilding, removeBuildings } from "@/world/ops/buildings";
import { OpBuilder, programmeOf, fmt, type OpResult } from "@/world/ops/core";
import { generateDistrict, type DistrictStyle } from "@/world/ops/district";
import { convertAreas, createArea, plantTrees, removeEntities } from "@/world/ops/landscape";
import type { SectionEdit } from "@/world/ops/sectionEdit";
import { createStreet, editStreetSections, moveStreets, realignStreets, removeStreets, setNodeControl, setSignalPreemption, setStreetAttributes, setTransitPriority, upgradeCurbRamps, type ConflictPolicy } from "@/world/ops/streets";
import { createTransitRoute, optimizeStops } from "@/world/ops/transit";
import type { Typology } from "@/geometry/massing";
import { checkBuilding, frontage, heightLimit, parcelsUnder, rowConflicts, streetBand } from "@/world/ops/validate";
import type { Area, AreaType, Building, Entity, Parcel, Polygon, Street, StreetNode, TransitRoute, Use, Vec2 } from "@/world/types";
import type { Changeset } from "@/world/world";
import { blockAt, entityName, entityPoint, junctionOf, polyOf, resolveArea, resolveLocation, resolvePlace, resolveStreets, viewBounds, viewCenter, type AreaRef, type Loc } from "./resolve";

export interface ToolDisplay {
  title: string;
  detail?: string;
  status: "ok" | "error" | "warn";
  lines?: string[];
  changesetId?: string;
  metrics?: { label: string; value: string; delta?: string; tone?: "good" | "bad" | "neutral" }[];
  simId?: string;
}

export interface ToolOutput {
  content: unknown;
  display: ToolDisplay;
  isError?: boolean;
}

export interface ToolContext {
  requestApproval: (req: { title: string; lines: string[] }) => Promise<boolean>;
  approvals: boolean;
  signal?: AbortSignal;
  /** compute the change and its cascade report without committing it */
  dryRun?: boolean;
}

type In = Record<string, any>;
const r1 = (x: number) => Math.round(x * 10) / 10;
/** employed residents per resident, central Austin (ACS 2022 5-yr, approx.) */
const EMPLOYED_SHARE = 0.58;
const pt = (p: Vec2) => [Math.round(p[0]), Math.round(p[1])];

function err(title: string, message: string): ToolOutput {
  return { content: { error: message }, display: { title, detail: message, status: "error" }, isError: true };
}

// ---------------------------------------------------------------- commit

async function commit(res: OpResult, title: string, ctx: ToolContext): Promise<ToolOutput> {
  if (!res.ok || !res.changeset) return err(title, res.error ?? "Operation failed");
  const R = rt();
  const cs = res.changeset;
  if (ctx.dryRun) {
    // preview: operations are computed against the world without mutating it, so nothing to undo
    const removedB = cs.ops.filter((o) => o.type === "remove" && o.entity.kind === "building").map((o) => (o as { entity: Building }).entity);
    return {
      content: {
        applied: false,
        preview: true,
        summary: res.report.summary,
        warnings: res.report.warnings,
        unresolved_conflicts: res.report.conflicts.filter((c) => !c.resolved).map((c) => c.message),
        resolved_conflicts: res.report.conflicts.filter((c) => c.resolved).length,
        would_create: res.created.length,
        would_modify: res.modified.length,
        would_remove: res.removed.length,
        buildings_demolished: removedB.length,
        gfa_demolished_m2: Math.round(removedB.reduce((s, b) => s + programmeOf(b).gfa, 0)),
        historic_demolished: removedB.filter((b) => b.historic).length,
        data: res.data,
      },
      display: { title: `Preview: ${cs.label}`, detail: "not applied", status: "ok", lines: res.report.summary.slice(0, 6) },
    };
  }
  const removedB = cs.ops.filter((o) => o.type === "remove" && o.entity.kind === "building").map((o) => (o as { entity: Building }).entity);
  const historic = removedB.filter((b) => b.historic);
  const needs = ctx.approvals && (historic.length > 0 || removedB.length > 25);
  if (needs) {
    const ok = await ctx.requestApproval({
      title: `Approve “${cs.label}”?`,
      lines: [
        ...(historic.length ? [`Demolishes ${historic.length} historic-designated building${historic.length > 1 ? "s" : ""}: ${historic.slice(0, 3).map((b) => b.name ?? b.id).join(", ")}`] : []),
        ...(removedB.length > 25 ? [`Demolishes ${removedB.length} buildings (${fmt.m2(removedB.reduce((s, b) => s + programmeOf(b).gfa, 0))} GFA)`] : []),
        ...res.report.summary.slice(0, 4),
      ],
    });
    if (!ok) return { content: { rejected: true, message: "The user declined this change. Nothing was applied. Propose an alternative that avoids the flagged impacts." }, display: { title, detail: "Declined by user — not applied", status: "warn" } };
  }
  const before = R.scenarios.activeId;
  R.scenarios.commit(cs);
  const st = useApp.getState();
  st.bumpWorld();
  st.bumpScenarios();
  const created = res.created.filter((id) => R.world.get(id)?.kind !== "node");
  st.setHighlight({ ids: [...created.filter((id) => R.world.get(id)?.kind === "building"), ...res.modified.filter((id) => R.world.get(id)?.kind === "street")].slice(0, 200) });
  const branched = before !== R.scenarios.activeId;
  const unresolved = res.report.conflicts.filter((c) => !c.resolved);
  return {
    content: {
      applied: true,
      changeset_id: cs.id,
      scenario: R.scenarios.active.name + (branched ? " (auto-branched from the existing city)" : ""),
      summary: res.report.summary,
      warnings: res.report.warnings,
      unresolved_conflicts: unresolved.map((c) => c.message),
      resolved_conflicts: res.report.conflicts.filter((c) => c.resolved).length,
      created: created.slice(0, 25),
      modified: res.modified.length,
      removed: res.removed.length,
      data: res.data,
    },
    display: {
      title: cs.label,
      status: unresolved.length || res.report.warnings.length ? "warn" : "ok",
      lines: [...res.report.summary, ...res.report.warnings.map((w) => `⚠ ${w}`), ...unresolved.map((c) => `✕ ${c.message}`)],
      changesetId: cs.id,
    },
  };
}

const actor = { author: "agent" as const };

// ---------------------------------------------------------------- feature summaries

function curveInfo(s: Street) {
  const c = curvatureStats(s.path);
  if (!(c.minRadius < 150)) return {};
  const need = Math.round(minRadiusForSpeed(s.speed ?? 40));
  return { min_curve_radius_m: Math.round(c.minRadius), design_min_radius_m: need, ...(c.minRadius < need ? { substandard_curve_at: pt(c.at!) } : {}) };
}

function brief(e: Entity, from?: Vec2) {
  const hh = rt().meta.calibration.householdSize;
  const base: Record<string, unknown> = { id: e.id, name: entityName(e) };
  const p = entityPoint(e);
  base.at = pt(p);
  if (from) base.dist_m = Math.round(dist(p, from));
  switch (e.kind) {
    case "building": {
      const pr = programmeOf(e, hh);
      Object.assign(base, { use: e.use, floors: e.floors, height_m: r1(e.height), footprint_m2: Math.round(polyArea(e.footprint)), gfa_m2: Math.round(pr.gfa), units: r1(pr.units), jobs: Math.round(pr.jobs), historic: !!e.historic, proposed: !!e.createdBy, height_source: e.heightSource });
      break;
    }
    case "street":
      Object.assign(base, { cls: e.cls, lanes: `${laneCount(e.section, 1)}+${laneCount(e.section, -1)}`, oneway: e.oneway, row_m: r1(sectionWidth(e.section)), length_m: Math.round(polyLength(e.path)), closed: !!e.closed, from: e.from, to: e.to, ...(e.bridge ? { bridge: true } : {}), ...curveInfo(e), ...(SIDEWALK_EXPECTED(e) ? { sidewalk_left: sidewalkSide(e, "left").label, sidewalk_right: sidewalkSide(e, "right").label } : {}) });
      break;
    case "node":
      Object.assign(base, { control: e.control, approaches: rt().world.incident(e.id).length, plaza: !!e.plaza, ...(e.ramps ? { curb_ramps: e.ramps } : {}), ...(e.evp ? { signal_preemption: true } : {}), ...(e.tsp ? { transit_priority: true } : {}) });
      break;
    case "parcel":
      Object.assign(base, { zoning: e.zoning, area_m2: e.area, land_use: e.landUse, max_far: e.maxFar, max_height_m: e.maxHeight, cvc_ceiling_m_asl: e.cvcCeiling, historic: e.historic, ...parcelEconomics(e) });
      break;
    case "area":
      Object.assign(base, { type: e.type, area_m2: Math.round(polyArea(e.poly)), proposed: !!e.createdBy });
      break;
    case "route":
      Object.assign(base, { mode: e.mode, headway_min: e.headway, stops: e.stops.length, length_km: r1(polyLength(e.path) / 1000) });
      break;
    case "stop":
      Object.assign(base, { mode: e.mode, routes: e.routes.length });
      break;
    case "poi":
      Object.assign(base, { category: e.category });
      break;
    case "place":
      Object.assign(base, { type: e.type });
      break;
  }
  return base;
}

function detail(e: Entity) {
  const R = rt();
  const w = R.world;
  const b = brief(e);
  if (e.kind === "building") {
    const hl = heightLimit(w, e.footprint, e.ground);
    const par = e.parcelId ? w.get<Parcel>(e.parcelId) : undefined;
    return {
      ...b,
      masses: e.masses.map((m) => ({ role: m.role, base_m: r1(m.base), top_m: r1(m.top), area_m2: Math.round(polyArea(m.poly)) })),
      program: e.program,
      ground_elevation_m: e.ground,
      parcel: par ? { id: par.id, zoning: par.zoning, area_m2: par.area, max_far: par.maxFar, max_height_m: par.maxHeight, cvc_ceiling_m_asl: par.cvcCeiling } : null,
      height_limit_m: hl.limit,
      height_limit_source: hl.source,
      issues: checkBuilding(w, e).map((i) => i.message),
      source: e.source,
      notes: e.notes,
    };
  }
  if (e.kind === "street") {
    const fr = frontage(w, e);
    return {
      ...b,
      strips: e.section.strips.map((s) => `${s.type}${s.dir ? (s.dir > 0 ? "→" : "←") : ""} ${s.width.toFixed(1)}m`),
      section: describeSection(e.section),
      carriageway_m: r1(carriagewayWidth(e.section)),
      speed_kmh: e.speed,
      building_line_m: { left: Number.isFinite(fr.left) ? r1(fr.left) : null, right: Number.isFinite(fr.right) ? r1(fr.right) : null, note: "distance from centreline to nearest building face on each side (left/right of from→to)" },
      direction: (() => {
        const a = e.path[0],
          z = e.path[e.path.length - 1];
        const ang = (Math.atan2(z[0] - a[0], z[1] - a[1]) * 180) / Math.PI;
        return `from→to heading ${Math.round((ang + 360) % 360)}°`;
      })(),
      row_source: e.rowSource,
      section_source: e.sectionSource,
    };
  }
  if (e.kind === "node") {
    return { ...b, streets: w.incident(e.id).map((s) => ({ id: s.id, name: s.name, cls: s.cls, lanes: `${laneCount(s.section, 1)}+${laneCount(s.section, -1)}` })), roundabout: e.roundabout };
  }
  if (e.kind === "parcel") {
    const blds = w.query(polyBBox(e.poly), ["building"]).filter((x) => pointInPoly(polyCentroid((x as Building).footprint), e.poly)) as Building[];
    const gfa = blds.reduce((s, x) => s + programmeOf(x).gfa, 0);
    return { ...b, buildings: blds.map((x) => x.id), existing_gfa_m2: Math.round(gfa), far_used: e.area ? r1(gfa / e.area) : null };
  }
  if (e.kind === "route") return { ...b, streets: e.streets.length, stop_ids: e.stops.slice(0, 40) };
  return b;
}

// ---------------------------------------------------------------- simulations formatting

function simSummary(rec: SimRecord) {
  const r = rec.result;
  switch (rec.kind) {
    case "traffic":
      return {
        period: r.period,
        kpi: { veh_trips: Math.round(r.kpi.vehTrips), vehicle_km: Math.round(r.kpi.vmt), vehicle_hours: Math.round(r.kpi.vht), delay_veh_hours: Math.round(r.kpi.delayHours), avg_speed_kmh: r1(r.kpi.avgSpeedKmh), congested_links: r.kpi.congestedLinks, congested_km: r1(r.kpi.congestedKm), rel_gap: r.kpi.relGap.toFixed(4) },
        worst_junctions: r.nodes.slice(0, 8).map((n: any) => ({ id: n.id, name: n.name || n.id, los: n.los, vc: Math.round(n.vc * 100) / 100, clv: n.clv, control: n.control, at: pt(n.p) })),
        busiest_links: topLinks(r, 6),
        // routes touched by bus lanes / signal priority first (those are what scenarios change), then the slowest
        transit_routes: [...r.routes].sort((a: any, b: any) => Number(b.tspSignals > 0 || b.busLaneShare > 0) - Number(a.tspSignals > 0 || a.busLaneShare > 0) || b.minutes - a.minutes).slice(0, 10).map((x: any) => ({ id: x.id, ref: x.ref, name: x.name, minutes: r1(x.minutes), free_minutes: r1(x.freeMinutes), dedicated_share: Math.round(x.busLaneShare * 100) + "%", signals: x.signals, with_priority: x.tspSignals })),
        calibration: { stations: r.calibration.length, geh_under_5: r.calibration.filter((c: any) => c.geh < 5).length, detail: r.calibration.slice(0, 6) },
        assumptions: r.assumptions,
      };
    case "heat":
      return {
        peak_hour: r.kpi.peakHour,
        air_temp_c: r.airTemp.map((t: number) => r1(t)),
        hours: r.hours,
        mean_surface_c: r1(r.kpi.meanSurface),
        mean_ped_exposure_c: r1(r.kpi.meanExposure),
        ped_share_over_40c: Math.round(r.kpi.pedHotShare * 100) + "%",
        shaded_ped_share: Math.round(r.kpi.shadedPedShare * 100) + "%",
        canopy_cover: Math.round(r.kpi.canopy * 1000) / 10 + "%",
        impervious: Math.round(r.kpi.impervious * 1000) / 10 + "%",
        hottest_blocks: r.hottestBlocks.slice(0, 6).map(blockRow),
        // where people live: the hottest blocks with at least 50 residents (2020 Census)
        hottest_populated_blocks: r.hottestBlocks.filter((b: any) => (b.pop ?? 0) >= 50).slice(0, 6).map(blockRow),
        assumptions: r.assumptions,
      };
    case "runoff":
      return { ...(r.area ? { area: { area_m2: Math.round(r.area.m2), land_m2: Math.round(r.area.landM2), pervious_land_m2: Math.round(r.area.perviousM2), impervious_share_of_land: Math.round(r.area.imperviousFraction * 1000) / 10 + "%", runoff_m3: Math.round(r.area.runoffM3) } } : {}), storm: r.storm, rainfall_mm: r.rainfallMm, runoff_m3: Math.round(r.volumeM3), storage_m3: Math.round(r.storageM3), net_runoff_m3: Math.round(r.netVolumeM3), mean_depth_mm: r1(r.depthMm), impervious: Math.round(r.imperviousFraction * 1000) / 10 + "%", weighted_cn: r1(r.weightedCN), assumptions: r.assumptions };
    case "flood":
      return { water_surface_m: r1(r.wse), rise_m: r1(r.rise), flooded_m2: Math.round(r.floodedM2), buildings_exposed: r.buildings.length, residents_exposed: Math.round(r.residents), deepest: r.buildings.slice(0, 8).map((b: any) => ({ id: b.id, depth_m: r1(b.maxDepth) })), assumptions: r.assumptions };
    case "access":
      return {
        residents_covered: Object.fromEntries(Object.entries(r.coverage).map(([k, v]) => [k === "emergency" ? "emergency_within_4_min_drive" : k, Math.round((v as number) * 1000) / 10 + "%"])),
        median_walk_min: Object.fromEntries(Object.entries(r.medianMinutes).filter(([k]) => k !== "emergency").map(([k, v]) => [k, r1(v as number)])),
        ...(r.minutes.emergency ? { emergency: emergencyGaps(r) } : {}),
        assumptions: r.assumptions,
      };
    case "capacity": {
      const ps = r.parcels as any[];
      const total = ps.reduce((s, p) => s + p.addedUnits, 0);
      const by: Record<string, number> = {};
      for (const p of ps) by[p.limitedBy] = (by[p.limitedBy] ?? 0) + 1;
      return {
        parcels: ps.length,
        existing_gfa_m2: Math.round(ps.reduce((s, p) => s + p.existingGfa, 0)),
        allowed_gfa_m2: Math.round(ps.reduce((s, p) => s + p.allowedGfa, 0)),
        added_units_potential: Math.round(total),
        binding_constraint_counts: by,
        top_soft_sites: ps.filter((p) => p.addedGfa > 1000).sort((a, b) => b.addedGfa - a.addedGfa).slice(0, 10).map((p) => ({ id: p.id, zoning: p.zoning, area_m2: p.area, utilisation: Math.round(p.utilisation * 100) + "%", added_gfa_m2: Math.round(p.addedGfa), added_units: Math.round(p.addedUnits), limited_by: p.limitedBy })),
        assumptions: ["Allowed GFA = min(FAR × lot area, height-limited floors × 70% coverage); CVC ceilings above ~140 m ASL ground; historic, public and state/university (UNZ) parcels held at existing; PUDs and districts without a FAR/height envelope in the data held at existing (capacity is not invented)", "Units = 85% residential × 82% efficiency / 78 m² average unit"],
      };
    }
    case "sun":
      return { date: r.date, area: r.stats ? { mean_direct_sun_hours: r1(r.stats.meanHours), share_with_4h_plus: Math.round(r.stats.shareOver4h * 100) + "%" } : null };
    case "metrics":
      return metricsRow(r);
    case "bike":
      return {
        km_by_lts: Object.fromEntries(Object.entries(r.kmByLts).map(([k, v]) => [`lts_${k}`, r1(v as number)])),
        residents_within_15_min_by_bike: Object.fromEntries(Object.entries(r.coverage).map(([k, v]: [string, any]) => [k, { low_stress: Math.round(v.lowStress * 1000) / 10 + "%", any_route: Math.round(v.any * 1000) / 10 + "%" }])),
        low_stress_islands: r.islands.slice(0, 6).map((x: any) => ({ residents: Math.round(x.residents), km: r1(x.km), at: pt(x.at) })),
        critical_links: r.criticalLinks.slice(0, 10).map((x: any) => ({ street_id: x.streetId, name: x.name, lts: x.lts, would_join_residents: Math.round(x.joins), at: pt(x.at) })),
        assumptions: r.assumptions,
      };
    default:
      return r;
  }
}

const blockRow = (b: any) => ({ census_block: b.id, at: pt(b.p), exposure_c: r1(b.exposure), surface_c: r1(b.surface), canopy: Math.round(b.canopy * 100) + "%", impervious: Math.round(b.impervious * 100) + "%", residents_2020: b.pop });

/** mean modelled exposure (°C) over samples within r metres of p, ignoring cells with no value */
function meanExposure(p: Vec2, ex: Uint8Array, r: number): number {
  const g = rt().meta.grid;
  let s = 0,
    n = 0;
  for (let dx = -r; dx <= r; dx += 4)
    for (let dy = -r; dy <= r; dy += 4) {
      const v = sampleGrid(g, ex, [p[0] + dx, p[1] + dy]);
      if (v) {
        s += dqT(v);
        n++;
      }
    }
  return n ? s / n : 0;
}

/** lateral offsets (m, + = left of the path) of a street's sidewalk centres */
function sidewalkOffsets(s: Street): number[] {
  const W = sectionWidth(s.section);
  let x = W / 2 + (s.section.shift ?? 0);
  const out: number[] = [];
  for (const st of s.section.strips) {
    if (st.type === "sidewalk" || st.type === "plaza") out.push(x - st.width / 2);
    x -= st.width;
  }
  return out.length ? out : [0];
}

/** mean exposure on a street's sidewalks, sampled every ~10 m on each side */
function sidewalkExposure(s: Street, ex: Uint8Array): number {
  const g = rt().meta.grid;
  const L = polyLength(s.path);
  const offs = sidewalkOffsets(s);
  let sum = 0,
    n = 0;
  for (let d = Math.min(5, L / 2); d < L; d += 10) {
    const { p, dir } = pointAt(s.path, d);
    for (const o of offs) {
      const v = sampleGrid(g, ex, [p[0] - dir[1] * o, p[1] + dir[0] * o]);
      if (v) {
        sum += dqT(v);
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

/** mean exposure around a junction's corners, just beyond the widest approach's kerb */
function cornerExposure(n: StreetNode, ex: Uint8Array): number {
  const g = rt().meta.grid;
  const r = Math.max(6, ...rt().world.incident(n.id).map((s) => sectionWidth(s.section) / 2 - 1));
  let sum = 0,
    k = 0;
  for (let a = Math.PI / 8; a < 2 * Math.PI; a += Math.PI / 4) {
    const v = sampleGrid(g, ex, [n.p[0] + r * Math.cos(a), n.p[1] + r * Math.sin(a)]);
    if (v) {
      sum += dqT(v);
      k++;
    }
  }
  return k ? sum / k : 0;
}

/** "Main Street (1st Street – 2nd Street)": a segment named by the nearest named cross streets at each end */
function segmentLabel(s: Street): string {
  const w = rt().world;
  if (!s.name) return entityName(s);
  // from one end, follow the same-named street through alleys / driveways until a named cross street
  const cross = (node: string, via: Street): string | undefined => {
    let cur = node,
      prev = via;
    for (let hop = 0; hop < 6; hop++) {
      const inc = w.incident(cur).filter((x) => x.id !== prev.id);
      const named = inc.find((x) => x.name && x.name !== s.name);
      if (named) return named.name;
      const next = inc.find((x) => x.name === s.name);
      if (!next) return undefined;
      cur = next.from === cur ? next.to : next.from;
      prev = next;
    }
    return undefined;
  };
  const a = cross(s.from, s),
    b = cross(s.to, s);
  return a && b && a !== b ? `${s.name} (${a} – ${b})` : a || b ? `${s.name} (near ${a ?? b})` : s.name;
}

let pedCache: { world: unknown; version: number; f: (p: Vec2) => number } | null = null;
/** pedestrian-activity proxy for the active scenario, rebuilt when the world changes */
function pedActivity(): (p: Vec2) => number {
  const R = rt();
  if (!pedCache || pedCache.world !== R.world || pedCache.version !== R.world.version) {
    const ents = [...R.world.all("building"), ...R.world.all("route"), ...R.world.all("stop")];
    pedCache = { world: R.world, version: R.world.version, f: pedIndex(pedSources(ents, R.meta.calibration.householdSize)) };
  }
  return pedCache.f;
}

/** street segments → blocks: segments sharing a name and cross streets are merged (length-weighted score) */
/** sidewalk exposure weighted by pedestrian activity and length: the heat people on foot actually meet */
function peopleWeightedExposure(ex: Uint8Array): number {
  const act = pedActivity();
  let sw = 0,
    se = 0;
  for (const st of rt().world.all("street")) {
    if (!walkable(st)) continue;
    const L = polyLength(st.path);
    const e = sidewalkExposure(st, ex);
    if (!e) continue;
    const wgt = act(pointAt(st.path, L / 2).p) * L;
    sw += wgt;
    se += wgt * e;
  }
  return sw ? se / sw : 0;
}

function groupBlocks<C extends { id?: string; p: Vec2; label: string; street?: Street }>(cands: C[], scores: number[]) {
  const by = new Map<string, { c: C & { ids: string[] }; s: number; L: number }>();
  cands.forEach((c, k) => {
    const L = c.street ? polyLength(c.street.path) : 1;
    const g = by.get(c.label);
    if (!g) by.set(c.label, { c: { ...c, ids: [c.id!] }, s: scores[k] * L, L });
    else {
      g.c.ids.push(c.id!);
      g.s += scores[k] * L;
      g.L += L;
    }
  });
  const out = [...by.values()];
  return { cands: out.map((g) => g.c), scores: out.map((g) => g.s / g.L) };
}

function rankOut(cands: { id?: string; p: Vec2; label: string }[], scores: number[], unit: string, limit?: number, assumptions?: string[]): ToolOutput {
  const ranked = cands
    .map((c, k) => ({ ...c, score: scores[k] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit ?? 10);
  return {
    content: { criterion: unit, ranked_of: cands.length, top: ranked.map((r) => ({ id: r.id, ...((r as { ids?: string[] }).ids?.length! > 1 ? { street_ids: (r as { ids?: string[] }).ids } : {}), at: pt(r.p), label: r.label, score: Math.round(r.score * 10) / 10 })), ...(assumptions ? { assumptions } : {}) },
    display: { title: `Ranked ${cands.length} sites`, detail: unit, status: "ok", lines: ranked.slice(0, 5).map((r, k) => `${k + 1}. ${r.label} — ${Math.round(r.score)}`) },
  };
}

/** walk-access coverage for the residents inside one area (area-wide figures hide local change) */
function accessInArea(rec: SimRecord, area: { poly: Polygon; label: string }) {
  const r = rec.result;
  const inside: number[] = [];
  (r.origins as { p: Vec2 }[]).forEach((o, k) => pointInPoly(o.p, area.poly) && inside.push(k));
  const W = inside.reduce((s, k) => s + r.origins[k].w, 0) || 1;
  const cov: Record<string, string> = {};
  for (const [cat, m] of Object.entries(r.minutes as Record<string, Float32Array>)) {
    const thr = cat === "transit" ? 400 / 1.3 / 60 : cat === "frequent_transit" ? 800 / 1.3 / 60 : cat === "emergency" ? 4 : 15;
    cov[cat] = Math.round((inside.reduce((s, k) => s + (m[k] <= thr ? r.origins[k].w : 0), 0) / W) * 1000) / 10 + "%";
  }
  return { area: area.label, residents: Math.round(W), residents_covered: cov };
}

/** compass side of a junction that a street approaches from */
function approachSide(at: Vec2, s: Street): string {
  const far = dist(s.path[0], at) > dist(s.path[s.path.length - 1], at) ? s.path[0] : s.path[s.path.length - 1];
  const a = (Math.atan2(far[0] - at[0], far[1] - at[1]) * 180) / Math.PI;
  return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((a + 360) % 360) / 45) % 8];
}

/** local public bodies that ground-lease or donate land for affordable housing */
const PUBLIC_HOUSING_PARTNERS = new Set(["City of Austin", "Austin Housing Finance Corporation", "Housing Authority of the City of Austin", "Travis County", "Capital Metro", "Austin ISD", "Austin Community College"]);

/** appraisal value, ownership and programme eligibility of a lot, for tool rows */
function parcelEconomics(p: Parcel) {
  return {
    ...(p.value ? { land_value_usd: p.value.land, improvement_value_usd: p.value.improvements, land_usd_per_m2: Math.round(p.value.land / Math.max(1, p.area)), underused: p.value.improvements < 0.5 * p.value.land } : {}),
    owner: p.owner ?? (p.value ? "private" : "unknown"),
    ...(p.etod ? { etod: `subdistrict ${p.etod.subdistrict}, up to ${Math.round(p.etod.maxHeight)} m with the affordability bonus` } : {}),
  };
}

/** streets people are expected to walk along (alleys, driveways and motorways excluded) */
const SIDEWALK_EXPECTED = (s: Street) => !["motorway", "motorway_link", "service", "pedestrian", "living"].includes(s.cls) && !s.closed;

/** per-side sidewalk status: the current cross-section, with the City inventory's condition where measured */
function sidewalkSide(s: Street, side: "left" | "right") {
  const has = hasSidewalk(s.section, side);
  const m = s.sidewalks?.[side];
  const measuredAbsent = m && (m.status === "absent" || m.status === "shared");
  return {
    has,
    measured: !!m,
    poor: has && !!m && !measuredAbsent && (m.grade === "D" || m.grade === "F" || (m.deficient ?? 0) >= 0.5),
    narrow: has && !!m && !measuredAbsent && (m.width ?? 9) < 1.22,
    label: has ? (measuredAbsent ? "new (proposed)" : m ? `${m.status}${m.grade ? `, grade ${m.grade}` : ""}${m.width ? `, ${m.width} m` : ""}${m.deficient ? `, ${Math.round(m.deficient * 100)}% deficient` : ""}` : "yes (not in inventory)") : m ? (m.status === "shared" ? "none (planned shared street)" : "none (measured)") : "none (inferred)",
  };
}

/** sidewalk inventory for a set of streets: side-km with / without sidewalk, condition, and junction curb ramps */
function sidewalkInventory(streets: Street[], nodes: StreetNode[]) {
  let total = 0,
    has = 0,
    missingMeasured = 0,
    missingInferred = 0,
    poor = 0,
    narrow = 0;
  for (const s of streets) {
    if (!SIDEWALK_EXPECTED(s)) continue;
    const L = polyLength(s.path) / 1000;
    for (const side of ["left", "right"] as const) {
      const x = sidewalkSide(s, side);
      total += L;
      if (x.has) has += L;
      else if (x.measured) missingMeasured += L;
      else missingInferred += L;
      if (x.poor) poor += L;
      if (x.narrow) narrow += L;
    }
  }
  const ramps = nodes.reduce((a, n) => (n.ramps ? { ok: a.ok + n.ramps.ok, poor: a.poor + n.ramps.poor, absent: a.absent + n.ramps.absent } : a), { ok: 0, poor: 0, absent: 0 });
  return {
    street_side_km: r1(total),
    with_sidewalk: total ? `${Math.round((has / total) * 100)}%` : "—",
    missing_km_measured: r1(missingMeasured),
    missing_km_inferred: r1(missingInferred),
    poor_condition_km: r1(poor),
    narrower_than_4ft_km: r1(narrow),
    curb_ramps: ramps,
    source: "City of Austin Sidewalk Network & Curb Ramp inventory (A–F condition) where measured; OSM tags / street-class defaults elsewhere",
  };
}

/** where the heat changed: area-wide means hide local effects of local interventions */
function heatLocal(ra: SimRecord, rb: SimRecord) {
  const A = ra.result,
    B = rb.result;
  const hour = A.hours.includes(15) ? 15 : A.kpi.peakHour;
  const ia = A.hours.indexOf(hour),
    ib = B.hours.indexOf(hour);
  if (ia < 0 || ib < 0) return null;
  const ea: Uint8Array = A.exposure[ia],
    eb: Uint8Array = B.exposure[ib];
  const g = rt().meta.grid;
  let n = 0,
    sum = 0,
    cool = 0,
    warm = 0;
  for (let i = 0; i < ea.length; i++) {
    if (!ea[i] || !eb[i]) continue;
    const d = dqT(eb[i]) - dqT(ea[i]);
    if (Math.abs(d) < 0.25) continue;
    n++;
    sum += d;
    cool = Math.min(cool, d);
    warm = Math.max(warm, d);
  }
  return {
    hour,
    area_changed_m2: Math.round(n * g.cell * g.cell),
    mean_change_where_changed_c: n ? r1(sum / n) : 0,
    max_cooling_c: r1(cool),
    max_warming_c: r1(warm),
    // where people walk: area-wide means count empty lots and rooftops as much as busy sidewalks
    people_weighted_sidewalk_c: { a: r1(peopleWeightedExposure(ea)), b: r1(peopleWeightedExposure(eb)) },
    note: "pedestrian exposure difference (b − a) over cells that changed by ≥ 0.25 °C; people_weighted_sidewalk_c weights sidewalk exposure by the pedestrian-activity proxy (residents, jobs, transit riders nearby)",
  };
}

/** residents outside the response standard, clustered by the street junction they are nearest to */
function emergencyGaps(r: any) {
  const m = r.minutes.emergency as Float32Array;
  const cells = new Map<string, { residents: number; worst: number; unreachable: number; p: Vec2 }>();
  let beyond = 0,
    unreachable = 0,
    worst = 0;
  r.origins.forEach((o: { p: Vec2; w: number }, i: number) => {
    const v = m[i];
    if (!(v > 4)) return;
    const k = `${Math.floor(o.p[0] / 250)},${Math.floor(o.p[1] / 250)}`;
    const c = cells.get(k) ?? { residents: 0, worst: 0, unreachable: 0, p: o.p };
    if (Number.isFinite(v)) {
      beyond += o.w;
      worst = Math.max(worst, v);
      c.residents += o.w;
      c.worst = Math.max(c.worst, v);
    } else {
      unreachable += o.w;
      c.unreachable += o.w;
    }
    cells.set(k, c);
  });
  return {
    median_response_min: r1(r.medianMinutes.emergency),
    residents_beyond_4_min: Math.round(beyond),
    worst_reachable_min: r1(worst),
    residents_without_vehicle_route: Math.round(unreachable),
    gap_clusters: [...cells.values()].sort((a, b) => b.residents + b.unreachable - (a.residents + a.unreachable)).slice(0, 6).map((c) => ({ at: pt(c.p), residents_beyond_4_min: Math.round(c.residents), worst_min: c.residents ? r1(c.worst) : null, no_route: Math.round(c.unreachable) })),
    caveat: "Stations outside the study area are not modelled and the network is clipped at its edge, so coverage near the boundary is understated; 'no route' usually means a building whose nearest node only connects through the clip edge or a pedestrian-only street.",
  };
}

function topLinks(r: any, n: number) {
  const idx = [...r.flows.keys()].sort((a: number, b: number) => r.flows[b] - r.flows[a]).slice(0, n);
  return idx.map((k: number) => ({ street: r.links[k].name ?? r.links[k].street, veh_h: Math.round(r.flows[k]), vc: Math.round(r.vc[k] * 100) / 100 }));
}

function metricsRow(m: any) {
  return {
    population: Math.round(m.population),
    housing_units: Math.round(m.units),
    new_units: Math.round(m.newUnits),
    jobs: Math.round(m.jobs),
    gfa_m2: Math.round(m.gfa),
    trees: m.canopyTrees,
    park_plaza_m2: Math.round(m.parkArea),
    park_m2_per_1000: Math.round(m.parkPer1000),
    surface_parking_m2: Math.round(m.surfaceParking),
    on_street_spaces: Math.round(m.onStreetSpaces),
    bike_km: r1(m.bikeKm),
    protected_bike_km: r1(m.protectedBikeKm),
    bus_lane_km: r1(m.busLaneKm),
    tram_km: r1(m.tramKm),
    general_lane_km: r1(m.laneKm),
    pedestrian_street_km: r1(m.pedStreetsKm),
    transit_stops: m.transitStops,
    canopy_cover: m.cover ? Math.round(m.cover.canopyFraction * 1000) / 10 + "%" : undefined,
    impervious: m.cover ? Math.round(m.cover.imperviousFraction * 1000) / 10 + "%" : undefined,
  };
}

function scenarioId(ref?: string): string {
  const R = rt();
  if (!ref) return R.scenarios.activeId;
  if (R.scenarios.scenarios.has(ref)) return ref;
  const low = ref.toLowerCase();
  if (low === "baseline" || low.includes("existing")) return "baseline";
  for (const s of R.scenarios.scenarios.values()) if (s.name.toLowerCase() === low) return s.id;
  for (const s of R.scenarios.scenarios.values()) if (s.name.toLowerCase().includes(low)) return s.id;
  throw new Error(`Unknown scenario “${ref}”`);
}

const OVERLAY_OF: Record<string, OverlayId> = { traffic: "traffic", heat: "heat", runoff: "runoff", flood: "flood", access: "access", capacity: "zoning", sun: "sun", bike: "bike", growth: "growth" };

async function simulate(kind: string, params: In = {}, scenario?: string): Promise<SimRecord> {
  const p: Record<string, unknown> = {};
  if (kind === "traffic") {
    p.period = params.period ?? "pm";
    p.demandScale = params.demand_scale ?? 1;
    if (params.extra_residents) p.extraResidents = (params.extra_residents as { at: Loc; residents: number }[]).map((x) => ({ p: resolveLocation(x.at).p, residents: x.residents }));
  } else if (kind === "heat") {
    p.deltaT = params.delta_t ?? 0;
    if (params.hours) p.hours = params.hours;
    if (params.date) p.date = params.date;
  } else if (kind === "runoff") {
    p.storm = params.storm ?? "25yr";
    if (params.impervious_increase) p.impervious_increase = params.impervious_increase;
    if (params.area) p.area = resolveArea(params.area).poly;
  }
  else if (kind === "flood") p.rise = params.rise_m ?? 4;
  else if (kind === "capacity") {
    const opts: Record<string, unknown> = {};
    if (params.floors) opts.floors = params.floors;
    if (params.height_limit) opts.heightLimit = params.height_limit;
    p.options = opts;
    if (params.parcel_ids) p.parcelIds = params.parcel_ids;
    else if (params.area) {
      const { poly } = resolveArea(params.area);
      p.parcelIds = rt().world.query(polyBBox(poly), ["parcel"]).filter((x) => pointInPoly(polyCentroid((x as Parcel).poly), poly)).map((x) => x.id);
    }
  } else if (kind === "sun") {
    p.date = params.date ?? "2026-03-20";
    if (params.area) p.area = resolveArea(params.area).poly;
  }
  return runSim(kind as never, p, scenario ? scenarioId(scenario) : undefined);
}

// ---------------------------------------------------------------- tools

export const TOOLS: Record<string, (i: In, ctx: ToolContext) => Promise<ToolOutput>> = {
  async get_context() {
    const R = rt();
    const st = useApp.getState();
    const sel = st.selection.map((id) => R.world.get(id)).filter(Boolean).map((e) => detail(e!));
    const c = viewCenter();
    const b = viewBounds();
    const near = R.world
      .all("place")
      .map((p) => ({ name: p.name, type: p.type, d: dist(p.p, c) }))
      .filter((p) => p.d < 900)
      .sort((a, z) => a.d - z.d)
      .slice(0, 8)
      .map((p) => `${p.name} (${p.type}, ${Math.round(p.d)} m)`);
    const hist = R.scenarios.appliedChangesets().slice(-6).map((cs) => ({ id: cs.id, label: cs.label, author: cs.author }));
    const sims = useSims.getState().records.filter((r) => r.status === "done").slice(-5).map((r) => ({ kind: r.kind, scenario: r.scenarioName, at_edit: r.cursor }));
    const content = {
      selection: sel,
      view: { center: pt(c), bounds: b.map(Math.round), zoom: r1(R.map?.getZoom() ?? 0), pitch: Math.round(R.map?.getPitch() ?? 0), nearby: near },
      scenario: { active: R.scenarios.active.name, id: R.scenarios.activeId, edits: R.scenarios.active.cursor, all: [...R.scenarios.scenarios.values()].map((s) => ({ id: s.id, name: s.name, edits: s.cursor })) },
      recent_edits: hist,
      overlay: st.overlay,
      hour: st.hour,
      recent_simulations: sims,
      city: { name: R.meta.name, region: R.meta.region, bounds: R.meta.bounds.map(Math.round), census_population_2020: R.meta.calibration.censusPopulation, lodes_jobs_2023: R.meta.calibration.lodesJobs },
    };
    return { content, display: { title: "Read session context", detail: sel.length ? `${sel.length} selected · ${R.scenarios.active.name}` : `View near ${near[0] ?? "study area"}`, status: "ok" } };
  },

  async resolve_place(i) {
    const m = resolvePlace(i.query, i.limit ?? 5);
    if (!m.length) return err("Resolve place", `No match for “${i.query}”`);
    return { content: m.map((x) => ({ name: x.name, type: x.type, at: pt(x.p), id: x.id, street_ids: x.ids?.slice(0, 60), area_m2: x.poly ? Math.round(polyArea(x.poly)) : undefined })), display: { title: `Resolved “${i.query}”`, detail: m.slice(0, 3).map((x) => `${x.name} (${x.type})`).join(" · "), status: "ok" } };
  },

  async find_features(i) {
    const R = rt();
    const w = R.world;
    const kind = i.kind as Entity["kind"];
    let cands: Entity[];
    const near = i.near !== undefined ? resolveLocation(i.near).p : null;
    const radius = i.radius ?? (near ? 300 : undefined);
    if (i.within) {
      const { poly } = resolveArea(i.within);
      cands = w.query(polyBBox(poly), [kind]).filter((e) => pointInPoly(entityPoint(e), poly));
    } else if (near && radius) cands = w.query([near[0] - radius, near[1] - radius, near[0] + radius, near[1] + radius], [kind]).filter((e) => dist(entityPoint(e), near) <= radius);
    else cands = w.all(kind);
    const W = (i.where ?? {}) as In;
    const hh = R.meta.calibration.householdSize;
    cands = cands.filter((e) => {
      if (i.name && !(entityName(e).toLowerCase().includes(String(i.name).toLowerCase()) || ("name" in e && (e as { name?: string }).name?.toLowerCase().includes(String(i.name).toLowerCase())))) return false;
      if (e.kind === "building") {
        if (W.use && e.use !== W.use && !(W.use === "residential" && (e.program.residential ?? 0) > 0.5)) return false;
        if (W.minHeight && e.height < W.minHeight) return false;
        if (W.maxHeight && e.height > W.maxHeight) return false;
        if (W.minFloors && e.floors < W.minFloors) return false;
        if (W.historic !== undefined && !!e.historic !== W.historic) return false;
        if (W.proposed !== undefined && !!e.createdBy !== W.proposed) return false;
        if (W.minArea && polyArea(e.footprint) < W.minArea) return false;
      }
      if (e.kind === "street") {
        if (W.cls && e.cls !== W.cls) return false;
        if (W.bridge !== undefined && !!e.bridge !== W.bridge) return false;
        if (W.oneway !== undefined && !!e.oneway !== W.oneway) return false;
        if (W.closed !== undefined && !!e.closed !== W.closed) return false;
        if (W.maxRadius && !(curvatureStats(e.path).minRadius <= W.maxRadius)) return false;
        if (W.minLanes && laneCount(e.section) < W.minLanes) return false;
        if (W.sidewalk) {
          if (!SIDEWALK_EXPECTED(e)) return false;
          const L = sidewalkSide(e, "left"),
            R = sidewalkSide(e, "right");
          const ok = W.sidewalk === "missing" ? !L.has || !R.has : W.sidewalk === "missing_both" ? !L.has && !R.has : W.sidewalk === "missing_measured" ? (!L.has && L.measured) || (!R.has && R.measured) : W.sidewalk === "poor" ? L.poor || R.poor : W.sidewalk === "narrow" ? L.narrow || R.narrow : true;
          if (!ok) return false;
        }
      }
      if (e.kind === "parcel") {
        if (W.landUse && e.landUse !== W.landUse) return false;
        if (W.zoning && !e.zoning.startsWith(String(W.zoning).toUpperCase())) return false;
        if (W.minArea && e.area < W.minArea) return false;
        if (W.maxArea && e.area > W.maxArea) return false;
        if (W.historic !== undefined && e.historic !== W.historic) return false;
        if (W.owner && !(W.owner === "public" ? !!e.owner : W.owner === "private" ? !e.owner && !!e.value : (e.owner ?? "").toLowerCase().includes(String(W.owner).toLowerCase()))) return false;
        if (W.underused !== undefined && !!(e.value && e.value.improvements < 0.5 * e.value.land) !== W.underused) return false;
        if (W.etod !== undefined && !!e.etod !== W.etod) return false;
        if (W.maxLandValuePerM2 && !(e.value && e.value.land / e.area <= W.maxLandValuePerM2)) return false;
      }
      if (e.kind === "area") {
        if (W.type && e.type !== W.type) return false;
        if (W.minArea && polyArea(e.poly) < W.minArea) return false;
      }
      if (e.kind === "node") {
        if (W.control && e.control !== W.control) return false;
        const deg = w.incident(e.id).length;
        if (W.degree !== undefined ? deg !== W.degree : deg < 2) return false;
        if (W.ramps === "missing" && !(e.ramps?.absent ?? 0)) return false;
        if (W.ramps === "poor" && !((e.ramps?.poor ?? 0) + (e.ramps?.absent ?? 0))) return false;
      }
      if (e.kind === "poi" && W.category && e.category !== W.category) return false;
      if (e.kind === "route" && W.mode && e.mode !== W.mode) return false;
      return true;
    });
    const sort = i.sort ?? (near ? "distance" : undefined);
    const val = (e: Entity) => {
      if (sort === "distance" && near) return dist(entityPoint(e), near);
      if (sort === "height" && e.kind === "building") return -e.height;
      // curve deficiency: how far below the AASHTO minimum radius for the street's speed
      if (sort === "curvature" && e.kind === "street") return -minRadiusForSpeed(e.speed ?? 40) / curvatureStats(e.path).minRadius;
      if (sort === "area") return -(e.kind === "parcel" ? e.area : e.kind === "building" ? polyArea(e.footprint) : e.kind === "area" ? polyArea(e.poly) : 0);
      if (sort === "gfa" && e.kind === "building") return -programmeOf(e).gfa;
      if (sort === "residents" && e.kind === "building") return -programmeOf(e, hh).residents;
      if (sort === "jobs" && e.kind === "building") return -programmeOf(e).jobs;
      return 0;
    };
    if (sort) cands.sort((a, b) => val(a) - val(b));
    const total = cands.length;
    const rows = cands.slice(0, Math.min(60, i.limit ?? 20)).map((e) => brief(e, near ?? undefined));
    return { content: { total, rows }, display: { title: `Found ${total} ${kind}${total === 1 ? "" : "s"}`, detail: rows.slice(0, 3).map((r) => String(r.name)).join(" · "), status: total ? "ok" : "warn" } };
  },

  async get_feature(i) {
    const w = rt().world;
    const out = (i.ids as string[]).map((id) => {
      const e = w.get(id);
      return e ? detail(e) : { id, error: "not found" };
    });
    return { content: out, display: { title: `Inspected ${out.length} feature${out.length > 1 ? "s" : ""}`, detail: out.map((o: any) => o.name ?? o.id).slice(0, 3).join(" · "), status: "ok" } };
  },

  async describe_area(i) {
    const R = rt();
    const w = R.world;
    const { poly, label } = resolveArea(i.area);
    const bb = polyBBox(poly);
    const A = polyArea(poly);
    const inside = (e: Entity) => pointInPoly(entityPoint(e), poly);
    const blds = (w.query(bb, ["building"]) as Building[]).filter(inside);
    const hh = R.meta.calibration.householdSize;
    let gfa = 0,
      units = 0,
      jobs = 0,
      footprint = 0;
    const uses: Record<string, number> = {};
    for (const b of blds) {
      const p = programmeOf(b, hh);
      gfa += p.gfa;
      units += p.units;
      jobs += p.jobs;
      footprint += polyArea(b.footprint);
      uses[b.use] = (uses[b.use] ?? 0) + p.gfa;
    }
    const areas = (w.query(bb, ["area"]) as Area[]).filter((a) => overlapArea(a.poly, poly) > 1);
    const sumType = (t: AreaType) => areas.filter((a) => a.type === t).reduce((s, a) => s + overlapArea(a.poly, poly), 0);
    const streets = (w.query(bb, ["street"]) as Street[]).filter(inside);
    const byCls: Record<string, number> = {};
    let bike = 0,
      laneKm = 0;
    for (const s of streets) {
      const L = polyLength(s.path) / 1000;
      byCls[s.cls] = r1((byCls[s.cls] ?? 0) + L);
      laneKm += L * laneCount(s.section);
      if (s.section.strips.some((x) => x.type === "bike" || x.type === "cycletrack")) bike += L;
    }
    const parcels = (w.query(bb, ["parcel"]) as Parcel[]).filter(inside);
    const zon: Record<string, number> = {};
    for (const p of parcels) zon[p.zoningBase || "?"] = (zon[p.zoningBase || "?"] ?? 0) + p.area;
    const trees = w.query(bb, ["tree"]).filter(inside).length;
    const stops = w.query(bb, ["stop"]).filter(inside).length;
    const content = {
      area: label,
      area_ha: r1(A / 10000),
      buildings: blds.length,
      gfa_m2: Math.round(gfa),
      far_gross: r1(gfa / A),
      coverage: Math.round((footprint / A) * 100) + "%",
      housing_units: Math.round(units),
      residents_est: Math.round(units * hh),
      jobs_est: Math.round(jobs),
      // ACS-style commuter-adjusted activity; employed residents assumed to work outside a district this small
      activity: { nighttime_population: Math.round(units * hh), daytime_population: Math.round(units * hh * (1 - EMPLOYED_SHARE) + jobs), assumption: `daytime = residents × ${1 - EMPLOYED_SHARE} (not employed / work from home) + jobs located here; nighttime = residents` },
      use_mix_gfa: Object.fromEntries(Object.entries(uses).map(([k, v]) => [k, Math.round((v / Math.max(1, gfa)) * 100) + "%"])),
      tallest: blds.sort((a, b) => b.height - a.height).slice(0, 3).map((b) => `${b.name ?? b.id} ${Math.round(b.height)} m`),
      historic_buildings: blds.filter((b) => b.historic).length,
      parks_m2: Math.round(sumType("park") + sumType("pitch")),
      plazas_m2: Math.round(sumType("plaza")),
      water_m2: Math.round(sumType("water")),
      surface_parking_m2: Math.round(sumType("parking")),
      vacant_parcels: parcels.filter((p) => p.landUse === "vacant").length,
      parking_parcels: parcels.filter((p) => p.landUse === "parking").length,
      trees_mapped: trees,
      street_km_by_class: byCls,
      lane_km: r1(laneKm),
      bike_facility_km: r1(bike),
      sidewalks: sidewalkInventory(streets, (w.query(bb, ["node"]) as StreetNode[]).filter(inside)),
      transit_stops: stops,
      zoning_mix: Object.fromEntries(Object.entries(zon).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [k, Math.round((v / Math.max(1, parcels.reduce((s, p) => s + p.area, 0))) * 100) + "%"])),
      provenance: "Units/jobs anchored to Census 2020 and LODES 2023 block totals; GFA estimated from LiDAR heights; trees = mapped OSM trees only (undercounts canopy)",
    };
    return { content, display: { title: `Profiled ${label}`, detail: `${blds.length} bldgs · ~${fmt.int(units * hh)} residents · ~${fmt.int(jobs)} jobs`, status: "ok" } };
  },

  async make_polygon(i) {
    const w = rt().world;
    let poly: Polygon | null = null;
    switch (i.shape) {
      case "rect": {
        const c = resolveLocation(i.center).p;
        poly = normalizePoly([rectangle(c, i.width ?? 80, i.height ?? 60, ((i.angle_deg ?? 0) * Math.PI) / 180)]);
        break;
      }
      case "circle":
        poly = [circle(resolveLocation(i.center).p, i.radius ?? 100, 48)];
        break;
      case "block": {
        poly = blockAt(resolveLocation(i.at ?? i.center).p);
        break;
      }
      case "union":
      case "hull": {
        const ps = (i.ids as string[]).map((id) => w.get(id)).filter(Boolean).map((e) => polyOf(e!)).filter((p): p is Polygon => !!p);
        poly = i.shape === "hull" ? normalizePoly([convexHull(ps.flatMap((p) => p[0]))]) : unionMany(ps).sort((a, b) => polyArea(b) - polyArea(a))[0] ?? null;
        break;
      }
      case "buffer": {
        const ps = i.ids ? (i.ids as string[]).map((id) => w.get(id)).filter(Boolean).map((e) => polyOf(e!)).filter((p): p is Polygon => !!p) : [];
        if (i.path) ps.push([[...(i.path as Vec2[]), ...(i.path as Vec2[]).slice().reverse()]]);
        poly = unionMany(ps.map((p) => bufferPoly(p, i.distance ?? 20))).sort((a, b) => polyArea(b) - polyArea(a))[0] ?? null;
        break;
      }
      case "corridor": {
        const st = resolveStreets({ street_ids: i.ids, street: i.street });
        poly = unionMany(st.map((s) => bufferPoly(streetBand(s), Math.max(0, ((i.width ?? 60) - sectionWidth(s.section)) / 2)))).sort((a, b) => polyArea(b) - polyArea(a))[0] ?? null;
        break;
      }
    }
    if (!poly || !isValidPoly(poly)) return err("Make polygon", "Could not construct the polygon");
    const touches = w.query(polyBBox(poly), ["building", "parcel", "area"]).filter((e) => {
      const q = polyOf(e);
      return q && overlapArea(q, poly!) > 2;
    });
    return { content: { polygon: poly[0].map(pt), area_m2: Math.round(polyArea(poly)), centroid: pt(polyCentroid(poly)), touches: touches.slice(0, 30).map((e) => brief(e)) }, display: { title: `Built ${i.shape} polygon`, detail: `${fmt.m2(polyArea(poly))}`, status: "ok" } };
  },

  async measure(i) {
    if (i.area) {
      const { poly, label } = resolveArea(i.area);
      return { content: { area_m2: Math.round(polyArea(poly)), area_ha: r1(polyArea(poly) / 1e4), label }, display: { title: "Measured area", detail: fmt.m2(polyArea(poly)), status: "ok" } };
    }
    const a = resolveLocation(i.from),
      b = resolveLocation(i.to);
    const net = buildNetwork(rt().world.entities.values(), "walk");
    const s = nearestNode(net, a.p),
      t = nearestNode(net, b.p);
    const { d } = dijkstra(net, s, (l) => l.length, { target: t });
    const walk = d[t] + dist(net.nodes[s].p, a.p) + dist(net.nodes[t].p, b.p);
    return { content: { straight_m: Math.round(dist(a.p, b.p)), walk_m: Math.round(walk), walk_min: r1(walk / 1.3 / 60), from: a.label, to: b.label }, display: { title: `Measured ${a.label} → ${b.label}`, detail: `${Math.round(dist(a.p, b.p))} m straight · ${Math.round(walk)} m walking`, status: "ok" } };
  },

  async find_route(i) {
    const R = rt();
    const w = R.world;
    const pts = [i.from, ...((i.via as Loc[]) ?? []), i.to].map((x: Loc) => resolveLocation(x).p);
    const mode = (i.mode ?? "walk") as "walk" | "bike" | "drive";
    const prefer = (i.prefer ?? "shortest") as "shortest" | "quiet" | "arterial" | "low_stress";
    const ids: string[] = [];
    let length = 0;
    const path: Vec2[] = [];
    let maxLts = 0;
    if (mode === "bike") {
      const net = buildBikeNet(w.entities.values());
      const cost = (l: BikeLink) => l.length * (prefer === "low_stress" || prefer === "quiet" ? [0, 1, 1.15, 3, 8][l.lts] : 1);
      for (let k = 1; k < pts.length; k++) {
        const r = bikeRoute(net, pts[k - 1], pts[k], cost);
        if (!r) return err("Find route", `No bike route between waypoint ${k} and ${k + 1}`);
        for (const l of r) {
          if (ids[ids.length - 1] !== l.streetId) ids.push(l.streetId);
          length += l.length;
          maxLts = Math.max(maxLts, l.lts);
          path.push(net.nodes[l.a], net.nodes[l.b]);
        }
      }
    } else {
      const net = buildNetwork(w.entities.values(), mode === "drive" ? "car" : "walk");
      // quiet: avoid arterials and alleys / parking aisles, favour pedestrian and living streets
      const w8 = (l: NetLink) =>
        prefer === "shortest" ? 1 : prefer === "arterial" ? (l.cls === "primary" || l.cls === "secondary" ? 0.7 : l.cls === "tertiary" ? 0.9 : 1.6) : l.cls === "primary" || l.cls === "secondary" ? 2.2 : l.cls === "tertiary" ? 1.4 : l.cls === "service" ? 2 : l.cls === "pedestrian" || l.cls === "living" ? 0.8 : 1;
      for (let k = 1; k < pts.length; k++) {
        const s = nearestNode(net, pts[k - 1]),
          t = nearestNode(net, pts[k]);
        const { pred, d } = dijkstra(net, s, (l) => (mode === "drive" ? l.t0 : l.length) * w8(l), { target: t });
        if (!Number.isFinite(d[t])) return err("Find route", `No ${mode} route between waypoint ${k} and ${k + 1}`);
        for (const li of pathLinks(net, pred, t)) {
          const l = net.links[li];
          if (ids[ids.length - 1] !== l.streetId) ids.push(l.streetId);
          length += l.length;
          path.push(net.nodes[l.a].p, net.nodes[l.b].p);
        }
      }
    }
    // collapse into named legs for the description
    const legs: { name: string; m: number }[] = [];
    for (const id of ids) {
      const s = w.get<Street>(id);
      if (!s) continue;
      const nm = s.name ?? s.cls;
      const L = polyLength(s.path);
      if (legs.length && legs[legs.length - 1].name === nm) legs[legs.length - 1].m += L;
      else legs.push({ name: nm, m: L });
    }
    const speed = mode === "walk" ? 1.3 : mode === "bike" ? 4.5 : 9;
    useApp.getState().setHighlight({ ids: ids.slice(0, 400) });
    return {
      content: {
        mode,
        prefer,
        length_m: Math.round(length),
        minutes: r1(length / speed / 60),
        ...(mode === "bike" ? { max_lts_on_route: maxLts } : {}),
        legs: legs.map((l) => `${l.name} (${Math.round(l.m)} m)`),
        street_ids: ids,
        note: "street_ids can be passed straight to edit_streets / plant_trees / set_street_attributes to act on this corridor",
      },
      display: { title: `Route ${mode} · ${fmt.m(length)}`, detail: legs.slice(0, 4).map((l) => l.name).join(" → "), status: "ok" },
    };
  },

  async create_building(i, ctx) {
    const w = rt().world;
    const { poly, ids } = resolveArea(i.site);
    const replace = new Set<string>(i.replace_ids ?? []);
    // when the site is given as building ids, those buildings are being replaced
    for (const id of ids ?? []) if (w.get(id)?.kind === "building") replace.add(id);
    const res = createBuilding(
      w,
      {
        site: poly,
        spec: { typology: i.typology, floors: i.floors, use: i.use as Use, podiumFloors: i.podium_floors, towerCoverage: i.tower_coverage, towerCount: i.tower_count, barDepth: i.bar_depth, edgeSetback: i.edge_setback, orientation: i.orientation_deg != null ? (i.orientation_deg * Math.PI) / 180 : undefined },
        name: i.name,
        replace: [...replace],
        demolishConflicts: i.demolish_conflicts,
        greenRoof: i.green_roof,
        program: i.program,
      },
      actor,
    );
    return commit(res, `Build ${i.name ?? i.typology}`, ctx);
  },

  async modify_buildings(i, ctx) {
    const res = modifyBuildings(
      rt().world,
      {
        ids: i.ids,
        height: i.height,
        floors: i.floors,
        heightScale: i.height_scale,
        translate: i.translate,
        rotate: i.rotate_deg != null ? (i.rotate_deg * Math.PI) / 180 : undefined,
        footprintScale: i.footprint_scale,
        use: i.use,
        program: i.program,
        massing: i.massing ? { typology: i.massing.typology, keepGFA: i.massing.keep_gfa, floors: i.massing.floors, podiumFloors: i.massing.podium_floors, towerCoverage: i.massing.tower_coverage } : undefined,
        setbacks: i.setbacks ? { aboveFloor: i.setbacks.above_floor ?? 4, depth: i.setbacks.depth ?? 3 } : undefined,
        greenRoof: i.green_roof,
        name: i.name,
      },
      actor,
    );
    return commit(res, "Modify buildings", ctx);
  },

  async optimize_massing(i) {
    // search plan forms for one building: score each by direct sun on the open ground of its site, holding floor area
    const R = rt();
    const w = R.world;
    const b0 = w.get<Building>(i.id);
    if (!b0 || b0.kind !== "building") return err("Optimize massing", "Building not found");
    if (b0.historic) return err("Optimize massing", `${entityName(b0)} is historic-designated — its massing is not changed`);
    const date = i.date ?? "2026-12-21";
    const site: Polygon = i.site ? resolveArea(i.site).poly : b0.parcelId && w.get<Parcel>(b0.parcelId) ? w.get<Parcel>(b0.parcelId)!.poly : [convexHull(b0.footprint[0].concat(...b0.footprint.slice(1)) as Vec2[])];
    if (R.scenarios.activeId === "baseline") R.scenarios.branch(i.branch_name ?? `Massing study — ${entityName(b0)}`, "agent");
    const gfa0 = programmeOf(b0).gfa;
    const variants: { label: string; typology: Typology; openSide?: number }[] = [
      { label: "current form", typology: "block" },
      { label: "courtyard", typology: "courtyard" },
      ...[0, 1, 2, 3].map((k) => ({ label: `U-shape, open side ${k}`, typology: "u_shape" as Typology, openSide: k })),
      ...[0, 1, 2, 3].map((k) => ({ label: `L-shape, open side ${k}`, typology: "l_shape" as Typology, openSide: k })),
      { label: "slab", typology: "slab" },
      { label: "terraced", typology: "terraced" },
    ];
    const g = R.meta.grid;
    const score = async () => {
      const rec = await simulate("sun", { date });
      const hours: Float32Array = rec.result.grid;
      const fp = w.get<Building>(b0.id)!.footprint;
      const open = difference(site, bufferPoly(fp, 0.5));
      let s = 0,
        n = 0;
      for (const q of open) rasterizeRings(g, q as [number, number][][], (k) => ((s += hours[k]), n++));
      return n ? s / n : 0;
    };
    const tried: { label: string; sun_h: number; gfa_m2: number; height_m: number; cs?: Changeset; note?: string }[] = [];
    for (const v of variants) {
      if (v.label === "current form") {
        tried.push({ label: v.label, sun_h: r1(await score()), gfa_m2: Math.round(gfa0), height_m: r1(b0.height) });
        continue;
      }
      const res = modifyBuildings(w, { ids: [b0.id], massing: { typology: v.typology, keepGFA: i.keep_gfa !== false, openSide: v.openSide, maxHeight: i.max_height_m ?? Math.max(b0.height * 1.5, b0.height + 10) } }, actor);
      if (!res.ok || !res.changeset) {
        tried.push({ label: v.label, sun_h: NaN, gfa_m2: 0, height_m: 0, note: res.error });
        continue;
      }
      R.scenarios.commit(res.changeset);
      const b1 = w.get<Building>(b0.id)!;
      tried.push({ label: v.label, sun_h: r1(await score()), gfa_m2: Math.round(programmeOf(b1).gfa), height_m: r1(b1.height), cs: res.changeset, note: res.report.summary[0] });
      R.scenarios.undo(1);
    }
    // best = most sun while keeping at least 90% of the floor area
    const ok = tried.filter((t) => Number.isFinite(t.sun_h) && t.gfa_m2 >= gfa0 * 0.9);
    const best = ok.sort((a, b) => b.sun_h - a.sun_h)[0];
    if (best?.cs) R.scenarios.commit(best.cs);
    await simulate("sun", { date });
    useApp.getState().bumpWorld();
    useApp.getState().bumpScenarios();
    useApp.getState().setOverlay("sun");
    useApp.getState().bumpOverlay();
    const current = tried[0];
    return {
      content: {
        building: entityName(b0),
        date,
        objective: "mean direct-sun hours on the open ground of the site (courtyards, yards, forecourts)",
        chosen: best ? { form: best.label, sun_h: best.sun_h, gfa_m2: best.gfa_m2, height_m: best.height_m } : null,
        current: { sun_h: current.sun_h, gfa_m2: current.gfa_m2 },
        variants: tried.map(({ cs, ...t }) => (void cs, t)),
        method: "each plan form generated on the building's footprint with floors re-solved to hold floor area — capped by the height limit and a study cap (default 1.5× the current height, max_height_m to change) — scored with the shadow model on the chosen date; forms losing more than 10% of floor area are excluded",
      },
      display: { title: `Massing study: ${best?.label ?? "no improvement"}`, detail: `open-ground sun ${current.sun_h} → ${best?.sun_h ?? current.sun_h} h on ${date}`, status: "ok" },
    };
  },

  async merge_buildings(i, ctx) {
    return commit(mergeBuildings(rt().world, i.ids, { podiumFloors: i.podium_floors, name: i.name }, actor), "Merge buildings", ctx);
  },

  async remove_features(i, ctx) {
    const w = rt().world;
    const ids = (i.ids as string[]).filter((id) => w.get(id) && w.get(id)!.kind !== "street" && w.get(id)!.kind !== "node");
    const blds = ids.filter((id) => w.get(id)!.kind === "building");
    const res = blds.length === ids.length ? removeBuildings(w, ids, actor, i.reason ?? "Demolish") : removeEntities(w, ids, actor, i.reason ?? "Remove");
    return commit(res, "Remove features", ctx);
  },

  async green_roofs(i, ctx) {
    const w = rt().world;
    let cands: Building[] = [];
    if (i.ids) cands = (i.ids as string[]).map((id) => w.get<Building>(id)).filter((b): b is Building => !!b && b.kind === "building");
    else {
      const { poly } = resolveArea(i.area);
      cands = (w.query(polyBBox(poly), ["building"]) as Building[]).filter((b) => pointInPoly(polyCentroid(b.footprint), poly));
    }
    const minA = i.min_area ?? 150;
    const suitable = cands
      .filter((b) => !b.greenRoof && !b.historic && polyArea(b.footprint) >= minA && !(b.style?.facade === "glass" && b.height > 100) && b.use !== "parking")
      .map((b) => ({ b, planted: polyArea(plantedRoof(b.footprint)) }))
      .filter((x) => x.planted > 0)
      .sort((a, b) => b.planted - a.planted);
    // largest roofs first, until the planted-area target (if any) or the count cap is reached
    const ok: Building[] = [];
    let planted = 0;
    for (const x of suitable) {
      if (ok.length >= (i.max_count ?? 400) || (i.target_m2 && planted >= i.target_m2)) break;
      ok.push(x.b);
      planted += x.planted;
    }
    if (!ok.length) return err("Green roofs", "No suitable roofs found");
    const res = modifyBuildings(w, { ids: ok.map((b) => b.id), greenRoof: true }, actor);
    if (res.ok) res.report.summary.unshift(`Green roofs on ${ok.length} buildings — ${fmt.m2(planted)} planted (inside a ${GREEN_ROOF_SETBACK} m edge setback)${i.target_m2 ? (planted >= i.target_m2 ? `; target ${fmt.m2(i.target_m2)} met` : `; target ${fmt.m2(i.target_m2)} NOT met — only ${fmt.m2(planted)} of suitable roof`) : ""}`);
    if (res.ok && res.changeset) res.changeset.label = `Green roofs on ${ok.length} buildings`;
    // suppress per-building lines
    if (res.ok) res.report.summary = res.report.summary.filter((l) => !l.includes(" → "));
    return commit(res, "Green roofs", ctx);
  },

  async edit_streets(i, ctx) {
    const streets = resolveStreets(i as never);
    if (!streets.length) return err("Edit streets", "No streets matched — pass street_ids, a street name, or select a street");
    const edits = i.edits as SectionEdit[];
    const res = editStreetSections(rt().world, { streetIds: streets.map((s) => s.id), edits, keepRowWidth: i.keep_row_width, anchor: i.anchor, policy: i.conflict_policy as ConflictPolicy }, actor);
    if (res.ok && res.changeset) res.changeset.label = `${streets[0].name ?? "Street"}: ${(i.edits as SectionEdit[]).map((e) => e.op.replace(/_/g, " ")).join(", ")}`;
    return commit(res, `Edit ${streets[0].name ?? "streets"}`, ctx);
  },

  async set_junction(i, ctx) {
    const w = rt().world;
    if (i.route) {
      // corridor-wide transit signal priority along a bus route
      const route = (w.get(i.route) as TransitRoute | undefined) ?? (w.all("route") as TransitRoute[]).find((r) => r.ref === String(i.route) || r.name?.toLowerCase().includes(String(i.route).toLowerCase()));
      if (!route || route.kind !== "route") return err("Set junction", `Route “${i.route}” not found`);
      const nodes = new Set<string>();
      for (const sid of route.streets) {
        const s = w.get<Street>(sid);
        if (s) nodes.add(s.from), nodes.add(s.to);
      }
      return commit(setTransitPriority(w, [...nodes], i.transit_priority !== false, actor, `route ${route.ref ?? ""} ${route.name ?? ""}`.trim()), "Transit signal priority", ctx);
    }
    if (i.curb_ramps === "upgrade") {
      const ids: string[] = i.junctions ?? (i.junction ? [i.junction] : []);
      const nodes = ids.map((id) => w.get<StreetNode>(id) ?? (String(id).includes("&") ? junctionOf(...(String(id).split(/\s*&\s*/) as [string, string])) : undefined)).filter((n): n is StreetNode => !!n && n.kind === "node");
      if (!nodes.length) return err("Set junction", "Pass junction or junctions (ids) for curb_ramps");
      return commit(upgradeCurbRamps(w, nodes.map((n) => n.id), actor), "Curb ramps", ctx);
    }
    if (!i.junction || !i.control) return err("Set junction", "Pass junction and control (or route with transit_priority)");
    let node: StreetNode | undefined = w.get<StreetNode>(i.junction);
    if (!node || node.kind !== "node") {
      const parts = String(i.junction).split(/\s*(?:&|\band\b|\bat\b|\/)\s*/i);
      if (parts.length === 2) node = junctionOf(parts[0], parts[1]) ?? undefined;
      if (!node && /^(this|here|that|selected)/i.test(i.junction)) {
        const sel = useApp.getState().selection.map((id) => w.get(id)).find((e) => e?.kind === "node") as StreetNode | undefined;
        node = sel;
      }
    }
    if (!node) return err("Set junction", `Junction “${i.junction}” not found`);
    return commit(setNodeControl(w, node.id, i.control, { radius: i.radius, lanes: i.lanes, policy: i.conflict_policy, tsp: i.transit_priority }, actor), `Junction ${entityName(node)}`, ctx);
  },

  async create_street(i, ctx) {
    const path = (i.path as Loc[]).map((p) => resolveLocation(p).p);
    return commit(createStreet(rt().world, { path, cls: i.cls, name: i.name, lanes: i.lanes, oneway: i.oneway, bike: i.bike, median: i.median, parking: i.parking, sidewalk: i.sidewalk, trees: i.trees, policy: i.conflict_policy }, actor), `New street ${i.name ?? ""}`, ctx);
  },

  async plan_street(i, ctx) {
    // alignment search: candidate corridors between two points, each previewed with its full cascade
    const R = rt();
    const w = R.world;
    const a = resolveLocation(i.from).p,
      z = resolveLocation(i.to).p;
    const L = dist(a, z);
    const nrm: Vec2 = [-(z[1] - a[1]) / L, (z[0] - a[0]) / L];
    const mid: Vec2 = [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2];
    const spec = { cls: i.cls ?? "secondary", name: i.name, lanes: i.lanes, oneway: false, bike: i.bike, median: i.median, parking: i.parking, sidewalk: i.sidewalk, trees: i.trees ?? true, policy: "demolish" as ConflictPolicy };
    const cands: { label: string; make: () => OpResult }[] = [{ label: "straight", make: () => createStreet(w, { path: [a, z], ...spec }, actor) }];
    for (const off of [-0.18, -0.09, 0.09, 0.18]) {
      const m: Vec2 = [mid[0] + nrm[0] * off * L, mid[1] + nrm[1] * off * L];
      cands.push({ label: `bowed ${off > 0 ? "left" : "right"} ${Math.round(Math.abs(off) * L)} m`, make: () => createStreet(w, { path: [a, m, z], ...spec }, actor) });
    }
    // upgrade the existing street route instead of cutting a new one
    const net = buildNetwork(w.entities.values(), "car");
    const s0 = nearestNode(net, a),
      t0 = nearestNode(net, z);
    const { pred, d } = dijkstra(net, s0, (l) => l.length * (l.cls === "primary" || l.cls === "secondary" ? 0.8 : 1), { target: t0 });
    if (Number.isFinite(d[t0])) {
      const ids = [...new Set(pathLinks(net, pred, t0).map((k) => net.links[k].streetId))];
      const edits: SectionEdit[] = [{ op: "add_median", width: 3 }, { op: "add_planting", width: 2, side: "both" }];
      if (i.bike) edits.push({ op: "add_bike_lanes", kind: "track", side: "both" } as SectionEdit);
      cands.push({ label: `upgrade the existing route (${Math.round(d[t0])} m along ${[...new Set(ids.map((id) => w.get<Street>(id)?.name).filter(Boolean))].slice(0, 3).join(", ")})`, make: () => editStreetSections(w, { streetIds: ids, edits, policy: "demolish" }, actor) });
    }
    type Scored = { label: string; res: OpResult; ok: boolean; error?: string; buildings: number; gfa: number; historic: number; units: number; park: string };
    const scored: Scored[] = cands.map((c) => {
      const res = c.make();
      if (!res.ok || !res.changeset) return { label: c.label, res, ok: false, error: res.error, buildings: 0, gfa: 0, historic: 0, units: 0, park: "" };
      const gone = res.changeset.ops.filter((o) => o.type === "remove" && o.entity.kind === "building").map((o) => (o as { entity: Building }).entity);
      const parkTaken = res.report.warnings.find((x) => /park land/.test(x));
      return { label: c.label, res, ok: true, buildings: gone.length, gfa: Math.round(gone.reduce((s, b) => s + programmeOf(b).gfa, 0)), historic: gone.filter((b) => b.historic).length, units: Math.round(gone.reduce((s, b) => s + programmeOf(b).units, 0)), park: parkTaken ?? "" };
    });
    const ok = scored.filter((x) => x.ok);
    if (!ok.length) return err("Plan street", "No candidate alignment could be built");
    // least destructive: historic first, then homes, then floor area
    ok.sort((x, y) => x.historic - y.historic || x.units - y.units || x.gfa - y.gfa);
    const best = ok[0];
    const table = scored.map((x) => (x.ok ? { alignment: x.label, buildings_demolished: x.buildings, gfa_m2: x.gfa, homes: x.units, historic: x.historic, park: x.park || undefined } : { alignment: x.label, result: x.error }));
    if (i.dry_run) return { content: { preview: true, candidates: table, best: best.label }, display: { title: `Alignment study: ${best.label}`, detail: "not applied", status: "ok" } };
    const out = await commit(best.res, `Street via ${best.label}`, ctx);
    (out.content as Record<string, unknown>).alignment_study = { chosen: best.label, candidates: table, rule: "fewest historic demolitions, then fewest homes, then least floor area" };
    return out;
  },

  async move_streets(i, ctx) {
    const st = resolveStreets(i as never);
    if (!st.length) return err("Move streets", "No streets matched");
    return commit(moveStreets(rt().world, st.map((s) => s.id), i.offset, { policy: i.conflict_policy }, actor), "Shift street", ctx);
  },

  async realign_streets(i, ctx) {
    return commit(realignStreets(rt().world, i.street_ids, { radius: i.radius, designSpeed: i.design_speed_kmh, policy: i.conflict_policy }, actor), "Realign street", ctx);
  },

  async remove_streets(i, ctx) {
    return commit(removeStreets(rt().world, i.street_ids, { reclaim: i.reclaim ?? "none" }, actor), "Remove streets", ctx);
  },

  async set_street_attributes(i, ctx) {
    const st = resolveStreets(i as never);
    if (!st.length) return err("Street attributes", "No streets matched");
    const attrs: Partial<Street> = {};
    if (i.closed !== undefined) attrs.closed = i.closed;
    if (i.service_access !== undefined) attrs.serviceAccess = i.service_access;
    if (i.speed_kmh !== undefined) attrs.speed = i.speed_kmh;
    if (i.name !== undefined) attrs.name = i.name;
    if (i.cls !== undefined) attrs.cls = i.cls;
    return commit(setStreetAttributes(rt().world, st.map((s) => s.id), attrs, actor), "Street attributes", ctx);
  },

  async create_area(i, ctx) {
    const { poly } = resolveArea(i.area);
    return commit(createArea(rt().world, { type: i.type, poly, name: i.name, depth: i.depth, buildings: i.buildings, shadeTrees: i.shade_trees ? {} : undefined }, actor), `New ${i.type}`, ctx);
  },

  async convert_areas(i, ctx) {
    let ids: string[] = i.ids ?? [];
    let note = "";
    if (!ids.length && i.from_type) {
      // target-driven: largest areas of from_type inside `within` until target_m2 is reached
      const w = rt().world;
      const poly = i.within ? resolveArea(i.within).poly : null;
      const fromTypes = new Set<string>(Array.isArray(i.from_type) ? i.from_type : [i.from_type]);
      const cands = (w.all("area") as Area[])
        .filter((a) => fromTypes.has(a.type) && a.type !== i.type && (!poly || pointInPoly(polyCentroid(a.poly), poly)))
        .map((a) => ({ id: a.id, m2: polyArea(a.poly) }))
        .sort((a, b) => b.m2 - a.m2);
      let acc = 0;
      for (const c of cands) {
        if (i.target_m2 && acc >= i.target_m2) break;
        ids.push(c.id);
        acc += c.m2;
      }
      const avail = cands.reduce((a, c) => a + c.m2, 0);
      note = i.target_m2 ? (acc >= i.target_m2 ? `target ${fmt.m2(i.target_m2)} met with ${ids.length} of ${cands.length} ${[...fromTypes].join("/")} areas (${fmt.m2(acc)})` : `target ${fmt.m2(i.target_m2)} NOT met: only ${fmt.m2(avail)} of ${[...fromTypes].join("/")} available in the area`) : `${ids.length} ${[...fromTypes].join("/")} areas (${fmt.m2(acc)})`;
    }
    if (!ids.length) return err("Convert areas", i.from_type ? `No ${i.from_type} areas found${i.within ? " in that area" : ""}` : "Pass ids, or from_type (+ within, target_m2)");
    const res = convertAreas(rt().world, ids, i.type, actor);
    if (note && res.ok) res.report.summary.unshift(note);
    return commit(res, `Convert to ${i.type}`, ctx);
  },

  async plant_trees(i, ctx) {
    const R = rt();
    let streetIds: string[] | undefined;
    let within: Polygon | undefined;
    if (i.street_ids || i.street) streetIds = resolveStreets({ street_ids: i.street_ids, street: i.street, within: i.within }).map((s) => s.id);
    else if (i.within) {
      const { poly } = resolveArea(i.within);
      streetIds = (R.world.query(polyBBox(poly), ["street"]) as Street[]).filter((s) => pointInPoly(s.path[Math.floor(s.path.length / 2)], poly)).map((s) => s.id);
      within = undefined;
    } else streetIds = R.world.all("street").map((s) => s.id);
    let score: ((p: Vec2) => number) | undefined;
    let note = "";
    if (i.target === "heat" && i.count) {
      let rec = useSims.getState().records.filter((r) => r.kind === "heat" && r.status === "done" && r.scenarioId === R.scenarios.activeId).pop();
      if (!rec) rec = await simulate("heat", {});
      const hi = rec.result.hours.indexOf(15) >= 0 ? rec.result.hours.indexOf(15) : rec.result.hours.length - 1;
      const ex: Uint8Array = rec.result.exposure[hi];
      const air: number = rec.result.airTemp[hi];
      const act = pedActivity();
      // exposure a canopy could remove (above air temperature) where people actually walk
      score = (p) => shadeBenefit(meanExposure(p, ex, 8), air, act(p));
      note = ` (ranked by shade benefit: modelled ${rec.result.hours[hi]}:00 sidewalk exposure above air temperature × √pedestrian activity, from ${rec.scenarioName})`;
    }
    const res = plantTrees(R.world, { streetIds, within, count: i.count, spacing: i.spacing, score, species: i.species }, actor);
    if (res.ok && note) res.report.summary.push(`Positions chosen${note}`);
    return commit(res, "Plant trees", ctx);
  },

  async create_transit_route(i, ctx) {
    const pts = (i.waypoints as Loc[]).map((p) => resolveLocation(p).p);
    return commit(createTransitRoute(rt().world, { mode: i.mode, waypoints: pts, name: i.name, headway: i.headway, stopSpacing: i.stop_spacing, dedicated: i.dedicated }, actor), `New ${i.mode} route`, ctx);
  },

  async optimize_stops(i, ctx) {
    const R = rt();
    const hh = R.meta.calibration.householdSize;
    const demand = R.world.all("building").map((b) => {
      const p = programmeOf(b, hh);
      return { p: polyCentroid(b.footprint), w: p.residents + p.jobs * 0.5 };
    });
    return commit(optimizeStops(R.world, i.route_ids, demand.filter((d) => d.w > 0), { spacingMin: i.min_spacing, maxStops: i.max_stops }, actor), "Optimise stops", ctx);
  },

  async generate_district(i, ctx) {
    const { poly, label } = resolveArea(i.area);
    const res = generateDistrict(
      rt().world,
      {
        area: poly,
        style: (i.style ?? "midrise") as DistrictStyle,
        targetPopulation: i.target_population,
        maxFloors: i.max_floors,
        minFloors: i.min_floors,
        newStreets: i.new_streets,
        blockSize: i.block_size,
        openSpaceRatio: i.open_space_ratio,
        preserve: i.preserve_ids,
        keepAllExisting: i.keep_all_existing,
        redevelop: i.redevelop,
        targetUnits: i.target_net_units ?? i.target_units,
        netTarget: i.target_net_units !== undefined,
        anchor: i.anchor !== undefined ? resolveLocation(i.anchor).p : undefined,
        use: i.use,
        // an area given as coordinates has no name of its own
        name: i.name ?? (/^polygon \(/.test(label) ? "District" : label),
      },
      actor,
    );
    return commit(res, `Masterplan ${i.name ?? label}`, ctx);
  },

  async scenario(i) {
    const R = rt();
    const S = R.scenarios;
    const st = useApp.getState();
    const list = () => [...S.scenarios.values()].map((s) => ({ id: s.id, name: s.name, edits: s.cursor, active: s.id === S.activeId, parent: s.parentId }));
    switch (i.action) {
      case "list":
        return { content: list(), display: { title: "Listed scenarios", detail: `${S.scenarios.size} branches`, status: "ok" } };
      case "branch": {
        const from = i.from ? scenarioId(i.from) : S.activeId;
        const s = S.branch(i.name ?? `Option ${S.scenarios.size}`, "agent", from);
        if (S.activeId !== s.id) S.switchTo(s.id);
        st.bumpWorld();
        st.bumpScenarios();
        return { content: { created: s.id, name: s.name, from: S.scenarios.get(from)!.name, edits_inherited: s.cursor }, display: { title: `Branched “${s.name}”`, detail: `from ${S.scenarios.get(from)!.name}`, status: "ok" } };
      }
      case "switch": {
        const id = scenarioId(i.id ?? i.name);
        S.switchTo(id);
        st.bumpWorld();
        st.bumpScenarios();
        return { content: { active: S.active.name, id }, display: { title: `Switched to “${S.active.name}”`, status: "ok" } };
      }
      case "rename": {
        S.rename(scenarioId(i.id), i.name);
        st.bumpScenarios();
        return { content: list(), display: { title: `Renamed scenario`, detail: i.name, status: "ok" } };
      }
      case "delete": {
        S.remove(scenarioId(i.id ?? i.name));
        st.bumpWorld();
        st.bumpScenarios();
        return { content: list(), display: { title: "Deleted scenario", status: "ok" } };
      }
    }
    return err("Scenario", `Unknown action ${i.action}`);
  },

  async history(i) {
    const S = rt().scenarios;
    const css = S.appliedChangesets().slice(-(i.limit ?? 15));
    return { content: css.map((c) => ({ id: c.id, label: c.label, author: c.author, summary: c.report?.summary.slice(0, 3) })), display: { title: "Read edit history", detail: `${S.active.cursor} edits in ${S.active.name}`, status: "ok" } };
  },

  async undo(i) {
    const S = rt().scenarios;
    const n = i.steps ?? 1;
    const done = i.redo ? S.redo(n) : S.undo(n);
    useApp.getState().bumpWorld();
    useApp.getState().bumpScenarios();
    return { content: { [i.redo ? "redone" : "undone"]: done.map((c) => c.label), edits_now: S.active.cursor, note: "Simulation settings and results are unchanged; re-run models to evaluate the new state." }, display: { title: `${i.redo ? "Redid" : "Undid"} ${done.length} edit${done.length === 1 ? "" : "s"}`, detail: done.map((c) => c.label).join(" · "), status: done.length ? "ok" : "warn" } };
  },

  async revert_change(i) {
    const S = rt().scenarios;
    const label = S.appliedChangesets().find((c) => c.id === i.changeset_id)?.label;
    const ok = S.revertChangeset(i.changeset_id);
    useApp.getState().bumpWorld();
    useApp.getState().bumpScenarios();
    if (!ok) return err("Revert change", "Changeset not found in the active scenario");
    return { content: { reverted: label, edits_now: S.active.cursor }, display: { title: `Reverted “${label}”`, detail: "later edits re-applied where still valid", status: "ok" } };
  },

  async borrow_changes(i, ctx) {
    const R = rt();
    const from = R.scenarios.scenarios.get(scenarioId(i.from));
    if (!from) return err("Borrow changes", "Source scenario not found");
    const mine = new Set(R.scenarios.appliedChangesets().map((c) => c.id));
    let css = R.scenarios.appliedChangesets(from.id).filter((c) => !mine.has(c.id));
    if (i.changeset_ids?.length) css = css.filter((c) => i.changeset_ids.includes(c.id));
    if (i.label_contains) css = css.filter((c) => c.label.toLowerCase().includes(String(i.label_contains).toLowerCase()));
    const applied: string[] = [],
      skipped: string[] = [];
    for (const cs of css) {
      const ok = cs.ops.every((op) => (op.type === "add" ? !R.world.get(op.entity.id) : op.type === "remove" ? !!R.world.get(op.entity.id) : R.world.get(op.before.id) === op.before));
      if (!ok) {
        skipped.push(cs.label);
        continue;
      }
      const copy: Changeset = { ...cs, id: cs.id + "b" + Date.now().toString(36), label: `${cs.label} (from ${from.name})` };
      R.scenarios.commit(copy);
      applied.push(cs.label);
    }
    useApp.getState().bumpWorld();
    useApp.getState().bumpScenarios();
    void ctx;
    return { content: { applied, skipped_conflicting: skipped }, display: { title: `Borrowed ${applied.length} change${applied.length === 1 ? "" : "s"} from “${from.name}”`, detail: skipped.length ? `${skipped.length} skipped (conflicts with this scenario)` : undefined, status: skipped.length ? "warn" : "ok" } };
  },

  async run_simulation(i) {
    const rec = await simulate(i.kind, i.params ?? {}, i.scenario);
    const ov = OVERLAY_OF[i.kind];
    if (ov) useApp.getState().setOverlay(ov);
    useApp.getState().bumpOverlay();
    const s = simSummary(rec) as Record<string, unknown>;
    if (i.kind === "access" && i.params?.area) s.in_area = accessInArea(rec, resolveArea(i.params.area));
    return { content: { scenario: rec.scenarioName, at_edit: rec.cursor, runtime_s: r1((rec.ms ?? 0) / 1000), ...s }, display: { title: `${rec.label} — ${rec.scenarioName}`, detail: `${r1((rec.ms ?? 0) / 1000)} s`, status: "ok", simId: rec.id } };
  },

  async optimize_bottlenecks(i) {
    // greedy local search: at each of the worst non-motorway junctions, try small candidate fixes,
    // re-run the assignment for each, keep the one that most reduces network delay (if any)
    const R = rt();
    const w = R.world;
    const period = (i.period ?? "pm") as "am" | "pm";
    const maxChanges = Math.max(1, Math.min(6, i.max_changes ?? 3));
    const targetVc = i.target_vc ?? 0.95;
    const allow = new Set<string>(i.allow ?? ["lanes", "signal", "roundabout"]);
    const exclude = new Set<string>(i.exclude_junctions ?? []);
    if (R.scenarios.activeId === "baseline") R.scenarios.branch(i.branch_name ?? "Bottleneck fixes", "agent");
    const run = async () => (await simulate("traffic", { period })).result;
    let base = await run();
    const startDelay = base.kpi.delayHours;
    const highway = (s: Street) => s.cls === "motorway" || s.cls === "motorway_link" || /interstate|expressway|mopac|frontage/i.test(s.name ?? "");
    const tried: Record<string, unknown>[] = [];
    const applied: Record<string, unknown>[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (let step = 0; step < maxChanges; step++) {
      const worst = (base.nodes as { id: string; name: string; vc: number; control: string }[]).find((n) => !seen.has(n.id) && !exclude.has(n.id) && n.vc > targetVc && !w.incident(n.id).every(highway));
      if (!worst) break;
      seen.add(worst.id);
      const inc = w.incident(worst.id).filter((s) => !highway(s));
      const flow = new Map<string, number>();
      (base.links as { street: string }[]).forEach((l, k) => {
        if (inc.some((s) => s.id === l.street)) flow.set(l.street, Math.max(flow.get(l.street) ?? 0, base.flows[k]));
      });
      inc.sort((a, b) => (flow.get(b.id) ?? 0) - (flow.get(a.id) ?? 0));
      const cands: { label: string; make: () => OpResult }[] = [];
      if (allow.has("lanes"))
        for (const s of inc.slice(0, 2)) cands.push({ label: `+1 lane each way on the ${approachSide(w.get<StreetNode>(worst.id)!.p, s)} approach (${s.name ?? s.cls}, ${s.id}; within the existing ROW where possible)`, make: () => editStreetSections(w, { streetIds: [s.id], edits: [{ op: "add_lanes", count: 1, dir: "both" }], keepRowWidth: true, policy: "report" }, actor) });
      if (allow.has("signal") && worst.control !== "signal") cands.push({ label: "signalise", make: () => setNodeControl(w, worst.id, "signal", {}, actor) });
      if (allow.has("roundabout") && worst.control !== "roundabout" && inc.length >= 3 && inc.length <= 5) cands.push({ label: "two-lane roundabout", make: () => setNodeControl(w, worst.id, "roundabout", { lanes: 2, policy: "report" }, actor) });
      let best: { entry: Record<string, unknown>; cs: Changeset; r: any; d: number } | null = null;
      for (const c of cands) {
        const res = c.make();
        if (!res.ok || !res.changeset) {
          tried.push({ junction: worst.name, change: c.label, result: res.error ?? "not applicable" });
          continue;
        }
        const demolished = res.changeset.ops.filter((o) => o.type === "remove" && o.entity.kind === "building").length;
        const unresolved = res.report.conflicts.filter((x) => !x.resolved).length;
        if (demolished || unresolved) {
          tried.push({ junction: worst.name, change: c.label, result: `rejected: ${demolished ? `${demolished} demolitions` : ""}${demolished && unresolved ? ", " : ""}${unresolved ? `${unresolved} buildings inside the widened ROW` : ""}` });
          continue;
        }
        R.scenarios.commit(res.changeset);
        const r = await run();
        R.scenarios.undo(1);
        const after = (r.nodes as { id: string; vc: number }[]).find((n) => n.id === worst.id);
        const d = r.kpi.delayHours - base.kpi.delayHours;
        const entry = { junction: worst.name, change: c.label, network_delay_change_veh_h: Math.round(d), junction_vc: `${r1(worst.vc)} → ${after ? r1(after.vc) : "below screening list"}`, geometry: res.report.summary[0] };
        tried.push(entry);
        if (!best || d < best.d) best = { entry, cs: res.changeset, r, d };
      }
      if (best && best.d < -1) {
        R.scenarios.commit(best.cs);
        base = best.r;
        applied.push(best.entry);
      } else skipped.push(`${worst.name} (v/c ${r1(worst.vc)}): no candidate reduced network delay${cands.length ? "" : " — no applicable candidates"}`);
    }
    await run(); // leave the overlay on the final state
    useApp.getState().bumpWorld();
    useApp.getState().bumpScenarios();
    useApp.getState().setOverlay("traffic");
    useApp.getState().bumpOverlay();
    const remaining = (base.nodes as { id: string; name: string; vc: number }[]).filter((n) => n.vc > targetVc && !w.incident(n.id).every(highway)).slice(0, 5);
    return {
      content: {
        scenario: R.scenarios.active.name,
        period,
        network_delay_veh_h: `${Math.round(startDelay)} → ${Math.round(base.kpi.delayHours)}`,
        applied,
        tried,
        not_fixed: skipped,
        still_over_target: remaining.map((n) => `${n.name} v/c ${r1(n.vc)}`),
        method: "greedy: worst junction first; candidates = +1 lane each way on the two busiest approaches (no demolition, ROW held where possible), signalisation, two-lane roundabout; each evaluated with a full re-assignment; a change is kept only if it lowers network delay. Not a global optimum.",
      },
      display: { title: `Optimised bottlenecks: ${applied.length} change${applied.length === 1 ? "" : "s"}`, detail: `delay ${Math.round(startDelay)} → ${Math.round(base.kpi.delayHours)} veh·h`, status: applied.length ? "ok" : "warn", lines: [...applied.map((a) => `✓ ${a.junction}: ${a.change} (${a.network_delay_change_veh_h} veh·h)`), ...skipped.map((s) => `· ${s}`)] },
    };
  },

  async optimize_emergency(i, ctx) {
    // search in the worker over candidate network changes; commit the chosen ones as real edits and re-run the access model
    const R = rt();
    const w = R.world;
    const before = emergencyGaps((await simulate("access")).result);
    const rec = await runSim("emergency_opt", { maxChanges: Math.max(1, Math.min(8, i.max_changes ?? 4)), minGain: i.min_gain ?? 25, allow: i.allow });
    const plan = rec.result as EmOptimizeResult;
    if (!plan.stations) return err("Emergency access", "No fire or EMS stations in the study area");
    const pct = (x: number) => `${r1((x / Math.max(1, plan.residents)) * 100)}%`;
    const searched = { candidates: plan.candidates, evaluations: plan.evaluated, residents_within_4_min_predicted: `${fmt.int(plan.coveredBefore)} (${pct(plan.coveredBefore)}) → ${fmt.int(plan.coveredAfter)} (${pct(plan.coveredAfter)})` };
    const describe = (p: EmPick) => ({ change: p.label, kind: p.kind, residents_newly_within_4_min: p.gain, ...(p.parcels ? { private_parcels_crossed: p.parcels } : {}) });
    if (!plan.picks.length)
      return { content: { message: `No candidate change brings at least ${i.min_gain ?? 25} more residents within 4 minutes`, before, searched, assumptions: plan.assumptions }, display: { title: "No emergency-access change found", detail: `${plan.evaluated} evaluations`, status: "warn" } };
    if (ctx.dryRun) return { content: { dry_run: true, proposed: plan.picks.map(describe), searched, assumptions: plan.assumptions }, display: { title: `Emergency access: ${plan.picks.length} changes proposed (preview)`, status: "ok", lines: plan.picks.map((p) => `· ${p.label} (+${p.gain})`) } };
    if (R.scenarios.activeId === "baseline") R.scenarios.branch(i.branch_name ?? "Emergency access", "agent");
    const applied: Record<string, unknown>[] = [];
    const skipped: string[] = [];
    for (const p of plan.picks) {
      let res: OpResult;
      if (p.kind === "preempt") res = setSignalPreemption(w, p.nodes!, true, actor, p.label.replace(/^Signal preemption \(EVP\) at \d+ signals /, ""));
      else if (p.kind === "open") res = setStreetAttributes(w, p.streets!, { serviceAccess: true }, actor);
      else if (p.kind === "two_way") res = editStreetSections(w, { streetIds: p.streets!, edits: [{ op: "set_oneway", oneway: false }], keepRowWidth: true, policy: "report" }, actor);
      else {
        const b = new OpBuilder(w, actor.author);
        const lane = FIRE_LANE_WIDTH / 2;
        const made = createStreet(w, { path: p.path!, cls: "service", name: "Emergency access lane", snap: 1, policy: "report", closed: true, serviceAccess: true, strips: [{ type: "travel", width: lane, dir: 1 }, { type: "travel", width: lane, dir: -1 }] }, actor, b);
        if (made.ok) b.summary(`Fire lane ${FIRE_LANE_WIDTH} m wide behind removable bollards: emergency vehicles only${p.parcels ? `; crosses ${p.parcels} private parcel${p.parcels > 1 ? "s" : ""} (needs an easement)` : ""}`);
        res = made.ok ? b.finish("Emergency access lane") : made;
      }
      if (!res.ok || !res.changeset) {
        skipped.push(`${p.label}: ${res.error ?? "not applicable"}`);
        continue;
      }
      const demolished = res.changeset.ops.filter((o) => o.type === "remove" && o.entity.kind === "building").length;
      const unresolved = res.report.conflicts.filter((x) => !x.resolved).length;
      if (demolished || unresolved) {
        skipped.push(`${p.label}: rejected (${demolished ? `${demolished} demolitions` : `${unresolved} buildings inside the right-of-way`})`);
        continue;
      }
      R.scenarios.commit(res.changeset);
      applied.push({ ...describe(p), geometry: res.report.summary[0] });
    }
    const afterRec = await simulate("access");
    const after = emergencyGaps(afterRec.result);
    useApp.getState().bumpWorld();
    useApp.getState().bumpScenarios();
    useApp.getState().setOverlay("access");
    useApp.getState().bumpOverlay();
    const cov = (g: ReturnType<typeof emergencyGaps>) => plan.residents - g.residents_beyond_4_min - g.residents_without_vehicle_route;
    return {
      content: {
        scenario: R.scenarios.active.name,
        applied,
        not_applied: skipped,
        residents_within_4_min: `${fmt.int(cov(before))} → ${fmt.int(cov(after))} (+${fmt.int(cov(after) - cov(before))})`,
        median_response_min: `${before.median_response_min} → ${after.median_response_min}`,
        residents_beyond_4_min: `${fmt.int(before.residents_beyond_4_min)} → ${fmt.int(after.residents_beyond_4_min)}`,
        remaining_gaps: after.gap_clusters.slice(0, 4),
        searched,
        note: "Two-way conversions change general traffic too: run traffic before recommending them. Coverage is travel time only (NFPA 1710 excludes turnout).",
        assumptions: plan.assumptions,
      },
      display: {
        title: `Emergency access: ${applied.length} change${applied.length === 1 ? "" : "s"}`,
        detail: `within 4 min ${fmt.int(cov(before))} → ${fmt.int(cov(after))} residents · median ${before.median_response_min} → ${after.median_response_min} min`,
        status: applied.length ? "ok" : "warn",
        lines: [...applied.map((a) => `✓ ${a.change} (+${a.residents_newly_within_4_min})`), ...skipped.map((x) => `· ${x}`)],
      },
    };
  },

  async compare_scenarios(i) {
    const a = scenarioId(i.a),
      b = scenarioId(i.b);
    const kinds: string[] = i.kinds ?? ["metrics", "traffic", "heat"];
    const out: Record<string, unknown> = {};
    const metrics: ToolDisplay["metrics"] = [];
    for (const k of kinds) {
      const ra = await simulate(k, i.params?.[k] ?? i.params ?? {}, a);
      const rb = await simulate(k, i.params?.[k] ?? i.params ?? {}, b);
      const sa = simSummary(ra) as any,
        sb = simSummary(rb) as any;
      if (k === "metrics") {
        const d: Record<string, unknown> = {};
        for (const key of Object.keys(sa)) {
          const va = sa[key],
            vb = sb[key];
          if (typeof va === "number" && typeof vb === "number") d[key] = { a: va, b: vb, delta: Math.round((vb - va) * 10) / 10 };
          else d[key] = { a: va, b: vb };
        }
        out.metrics = d;
        for (const key of ["population", "housing_units", "jobs", "park_plaza_m2", "trees", "protected_bike_km"]) if (typeof sa[key] === "number") metrics!.push({ label: key.replace(/_/g, " "), value: fmt.int(sb[key]), delta: `${sb[key] - sa[key] >= 0 ? "+" : ""}${fmt.int(sb[key] - sa[key])}`, tone: sb[key] - sa[key] > 0 ? "good" : sb[key] - sa[key] < 0 ? "bad" : "neutral" });
      } else if (k === "traffic") {
        out.traffic = { a: sa.kpi, b: sb.kpi, worst_junctions_b: sb.worst_junctions.slice(0, 5), routes_b: sb.transit_routes };
        metrics!.push({ label: "delay veh·h", value: fmt.int(sb.kpi.delay_veh_hours), delta: `${sb.kpi.delay_veh_hours - sa.kpi.delay_veh_hours >= 0 ? "+" : ""}${fmt.int(sb.kpi.delay_veh_hours - sa.kpi.delay_veh_hours)}`, tone: sb.kpi.delay_veh_hours > sa.kpi.delay_veh_hours ? "bad" : "good" });
        metrics!.push({ label: "avg speed km/h", value: String(sb.kpi.avg_speed_kmh), delta: `${r1(sb.kpi.avg_speed_kmh - sa.kpi.avg_speed_kmh)}`, tone: sb.kpi.avg_speed_kmh < sa.kpi.avg_speed_kmh ? "bad" : "good" });
        if (i.show_diff !== false) {
          useSims.getState().setShown("traffic", rb.id);
          useSims.getState().setCompare("traffic", ra.id);
        }
      } else if (k === "heat") {
        out.heat = { a: { mean_ped_exposure_c: sa.mean_ped_exposure_c, ped_share_over_40c: sa.ped_share_over_40c, canopy: sa.canopy_cover }, b: { mean_ped_exposure_c: sb.mean_ped_exposure_c, ped_share_over_40c: sb.ped_share_over_40c, canopy: sb.canopy_cover }, local: heatLocal(ra, rb) };
        metrics!.push({ label: "ped. exposure °C", value: String(sb.mean_ped_exposure_c), delta: `${r1(sb.mean_ped_exposure_c - sa.mean_ped_exposure_c)}`, tone: sb.mean_ped_exposure_c > sa.mean_ped_exposure_c ? "bad" : "good" });
        if (i.show_diff) {
          useSims.getState().setShown("heat", rb.id);
          useSims.getState().setCompare("heat", ra.id);
        }
      } else out[k] = { a: sa, b: sb };
    }
    const S = rt().scenarios;
    useApp.getState().bumpOverlay();
    return { content: { a: S.scenarios.get(a)!.name, b: S.scenarios.get(b)!.name, ...out }, display: { title: `Compared ${S.scenarios.get(a)!.name} → ${S.scenarios.get(b)!.name}`, status: "ok", metrics } };
  },

  async validate(i) {
    const R = rt();
    const w = R.world;
    let targets: Entity[];
    if (i.ids) targets = (i.ids as string[]).map((id) => w.get(id)).filter((e): e is Entity => !!e);
    else if (i.area) {
      const { poly } = resolveArea(i.area);
      targets = w.query(polyBBox(poly), ["building", "street"]).filter((e) => pointInPoly(entityPoint(e), poly));
    } else {
      const diff = R.scenarios.diff("baseline", R.scenarios.activeId);
      targets = [...diff.added, ...diff.modified].map((id) => w.get(id)).filter((e): e is Entity => !!e && (e.kind === "building" || e.kind === "street"));
    }
    const issues: { id: string; name: string; severity: string; kind: string; message: string }[] = [];
    const baseline = R.scenarios.materialize("baseline");
    for (const e of targets) {
      if (e.kind === "building") {
        const before = baseline.get(e.id);
        // existing buildings: report only issues the proposal introduced (not pre-existing conditions)
        const pre = before && before.kind === "building" ? new Set(checkBuilding(w, before).map((x) => x.kind)) : new Set<string>();
        for (const iss of checkBuilding(w, e)) if (!pre.has(iss.kind)) issues.push({ id: e.id, name: entityName(e), severity: iss.severity, kind: iss.kind, message: iss.message });
        // street frontage / access
        const near = w.query([...polyBBox(e.footprint)].map((v, k) => v + (k < 2 ? -30 : 30)) as [number, number, number, number], ["street"]);
        if (!near.length) issues.push({ id: e.id, name: entityName(e), severity: "warning", kind: "access", message: "No street within 30 m — needs access / frontage" });
      } else if (e.kind === "street") {
        for (const n of [e.from, e.to]) if (w.incident(n).length === 1 && e.cls !== "service") issues.push({ id: e.id, name: entityName(e), severity: "info", kind: "network", message: `Dead end at ${n}` });
        const conf = rowConflicts(w, streetBand(e));
        void conf;
      }
    }
    const errors = issues.filter((x) => x.severity === "error").length;
    return { content: { checked: targets.length, errors, warnings: issues.filter((x) => x.severity === "warning").length, issues: issues.slice(0, 60) }, display: { title: `Validated ${targets.length} features`, detail: `${errors} errors · ${issues.length - errors} warnings/info`, status: errors ? "warn" : "ok", lines: issues.slice(0, 12).map((x) => `${x.severity === "error" ? "✕" : "⚠"} ${x.name}: ${x.message}`) } };
  },

  async rank_sites(i) {
    const R = rt();
    const w = R.world;
    let cands: { id?: string; p: Vec2; label: string; area?: number; street?: Street; node?: StreetNode; parcel?: Parcel }[] = [];
    const within = i.within ? resolveArea(i.within).poly : null;
    const inside = (p: Vec2) => !within || pointInPoly(p, within);
    const shade = i.criterion === "shade_benefit";
    if (i.candidates === "vacant_parcels" || i.candidates === "parking_lots" || i.candidates === "soft_sites") {
      const want = i.candidates === "vacant_parcels" ? ["vacant"] : i.candidates === "parking_lots" ? ["parking"] : ["vacant", "parking"];
      cands = w.all("parcel").filter((p) => want.includes(p.landUse) && p.area > 400 && inside(polyCentroid(p.poly))).map((p) => ({ id: p.id, p: polyCentroid(p.poly), label: `${p.zoning} ${p.area} m²`, area: p.area, parcel: p }));
      if (i.candidates === "parking_lots") for (const a of w.all("area")) if (a.type === "parking" && polyArea(a.poly) > 600 && inside(polyCentroid(a.poly))) cands.push({ id: a.id, p: polyCentroid(a.poly), label: `surface parking ${Math.round(polyArea(a.poly))} m²`, area: polyArea(a.poly) });
    } else if (i.candidates === "public_land" || i.candidates === "underused") {
      // publicly owned lots (not parks, water or right-of-way), or private lots whose buildings are worth less than half the land
      const ok = (p: Parcel) =>
        p.area > 400 && !p.historic && !["park", "water", "row"].includes(p.landUse) && inside(polyCentroid(p.poly)) && (i.candidates === "public_land" ? !!p.owner : !p.owner && !!p.value && p.value.improvements < 0.5 * p.value.land);
      cands = w.all("parcel").filter(ok).map((p) => ({ id: p.id, p: polyCentroid(p.poly), label: `${p.zoning} ${p.area} m²${p.owner ? ` · ${p.owner}` : ""}`, area: p.area, parcel: p }));
    } else if (i.candidates === "junctions")
      cands = w
        .all("node")
        .filter((n) => w.incident(n.id).length >= 3 && inside(n.p) && (!shade || w.incident(n.id).some(walkable)))
        .map((n) => ({ id: n.id, p: n.p, label: entityName(n), node: n }));
    else if (i.candidates === "streets")
      cands = w
        .all("street")
        .map((s) => ({ s, mid: pointAt(s.path, polyLength(s.path) / 2).p }))
        .filter(({ s, mid }) => walkable(s) && inside(mid) && polyLength(s.path) > 20)
        .map(({ s, mid }) => ({ id: s.id, p: mid, label: segmentLabel(s), street: s }));
    else cands = ((i.points as Vec2[]) ?? []).map((p) => ({ p, label: `(${Math.round(p[0])}, ${Math.round(p[1])})` }));
    if (!cands.length) return err("Rank sites", "No candidate sites found");
    // the walk-reach sim is the expensive criterion; raster-sampled criteria can rank every candidate
    if (i.criterion === "residents_walk") cands = cands.slice(0, 400);
    else cands = cands.slice(0, 5000);
    let scores: number[] = [];
    let unit = "";
    const extra = ((i.extra_residents as { at: Loc; residents: number }[]) ?? []).map((x) => ({ p: resolveLocation(x.at).p, residents: x.residents }));
    if (i.criterion === "residents_walk") {
      const rec = await runSim("sites", { candidates: cands.map((c) => c.p), minutes: i.minutes ?? 10, extra });
      scores = rec.result.reach;
      unit = `residents within ${i.minutes ?? 10} min walk`;
    } else {
      const heatLike = i.criterion === "heat" || shade;
      let rec = useSims.getState().records.filter((r) => r.kind === (heatLike ? "heat" : "access") && r.status === "done" && r.scenarioId === R.scenarios.activeId).pop();
      if (!rec) rec = await simulate(heatLike ? "heat" : "access");
      if (heatLike) {
        const hi = rec.result.hours.indexOf(15) >= 0 ? rec.result.hours.indexOf(15) : 0;
        const ex: Uint8Array = rec.result.exposure[hi];
        const air: number = rec.result.airTemp[hi];
        // sample where people stand: sidewalks along a street, corners of a junction
        const exposure = cands.map((c) => (c.street ? sidewalkExposure(c.street, ex) : c.node ? cornerExposure(c.node, ex) : meanExposure(c.p, ex, 8)));
        if (shade) {
          const act = pedActivity();
          const activity = cands.map((c) => act(c.p));
          scores = cands.map((_, k) => shadeBenefit(exposure[k], air, activity[k]));
          unit = `shade benefit at ${rec.result.hours[hi]}:00 = (sidewalk exposure − air ${r1(air)} °C) × √(pedestrian activity)`;
          if (i.candidates === "streets") {
            // describe each block by its length-weighted exposure and activity
            const gE = groupBlocks(cands, exposure),
              gA = groupBlocks(cands, activity),
              g = groupBlocks(cands, scores);
            g.cands.forEach((c, k) => (c.label += ` · ${r1(gE.scores[k])} °C, activity ${Math.round(gA.scores[k])}`));
            return rankOut(g.cands, g.scores, unit + " — street blocks", i.limit, PED_ASSUMPTIONS);
          }
          cands.forEach((c, k) => (c.label += ` · ${r1(exposure[k])} °C, activity ${Math.round(activity[k])}`));
          return rankOut(cands, scores, unit, i.limit, PED_ASSUMPTIONS);
        }
        scores = exposure;
        if (i.candidates === "streets") {
          const g = groupBlocks(cands, scores);
          return rankOut(g.cands, g.scores, `°C pedestrian exposure at ${rec.result.hours[hi]}:00 (sidewalks, street blocks)`, i.limit);
        }
        unit = `°C pedestrian exposure at ${rec.result.hours[hi]}:00`;
      } else {
        const cat = i.criterion === "park_gap" ? "park" : "frequent_transit";
        const lpms = cands.map((c) => (c.parcel?.value ? c.parcel.value.land / Math.max(1, c.parcel.area) : NaN)).filter(Number.isFinite).sort((a, b) => a - b);
        const medianLpm = lpms[Math.floor(lpms.length / 2)] ?? 1;
        const nodes: Vec2[] = rec.result.nodes;
        const nm: Float32Array = rec.result.nodeMinutes[cat];
        const origins: { p: Vec2; w: number }[] = rec.result.origins;
        scores = cands.map((c) => {
          // walk minutes from the site to the nearest frequent-transit stop / park, weighted by nearby residents
          let best = Infinity,
            bi = -1;
          nodes.forEach((p, k) => {
            const d = dist(p, c.p);
            if (d < best) {
              best = d;
              bi = k;
            }
          });
          const m = bi >= 0 ? nm[bi] : 99;
          if (i.criterion === "near_transit") {
            c.label += ` · ${Number.isFinite(m) ? r1(m) : "> 50"} min walk to frequent transit`;
            // developable land, weighted by how walkable the nearest frequent stop is
            return (c.area ?? 400) * (m <= 5 ? 1 : m <= 10 ? 0.5 : 0.1);
          }
          if (i.criterion === "affordable_housing") {
            const par = c.parcel;
            const lpm = par?.value ? par.value.land / Math.max(1, par.area) : null;
            const transit = m <= 5 ? 1 : m <= 10 ? 0.6 : m <= 15 ? 0.25 : 0;
            // land a local public body can ground-lease counts as nearly free; otherwise cheaper land scores higher
            // exempt state / federal / university land carries token appraisals and is not on offer: neutral cost
            const cost = par?.owner ? (PUBLIC_HOUSING_PARTNERS.has(par.owner) ? 2 : 1) : lpm ? Math.max(0.5, Math.min(2, medianLpm / lpm)) : 1;
            const bonus = par?.etod ? 1.25 : 1;
            c.label += ` · ${Number.isFinite(m) ? r1(m) : "> 50"} min to frequent transit · land ${lpm ? `$${fmt.int(lpm)}/m²` : "n/a"}${par?.owner && !c.label.includes(par.owner) ? ` · ${par.owner}` : ""}${par?.etod ? ` · ETOD ${par.etod.subdistrict}` : ""}`;
            return Math.min(10, (c.area ?? 400) / 1000) * transit * cost * bonus;
          }
          const res = origins.filter((o) => dist(o.p, c.p) < 500).reduce((s, o) => s + o.w, 0) + extra.filter((x) => dist(x.p, c.p) < 800).reduce((s, x) => s + x.residents, 0);
          return m * Math.sqrt(res + 1);
        });
        unit =
          i.criterion === "near_transit"
            ? "site area (m²) × transit weight (≤ 5 min walk to frequent transit ×1, ≤ 10 min ×0.5, else ×0.1)"
            : i.criterion === "affordable_housing"
              ? `affordable-housing site score = size (1,000 m² units, max 10) × transit (≤ 5 min walk to frequent transit 1, ≤ 10 0.6, ≤ 15 0.25) × land cost (land of a local public housing partner ×2; other public land ×1, its exempt appraisal is not a price; private land median $${fmt.int(medianLpm)}/m² ÷ the lot's land value, 0.5–2) × ETOD eligibility 1.25`
              : `gap score (walk minutes to ${cat} × √residents within 500 m)`;
      }
    }
    return rankOut(cands, scores, unit, i.limit);
  },

  async estimate(i) {
    const R = rt();
    if (i.what === "schools") {
      let units = i.units;
      if (!units) {
        const d = R.scenarios.diff("baseline", R.scenarios.activeId);
        units = d.added.map((id) => d.b.get(id)).filter((e) => e?.kind === "building").reduce((s, e) => s + programmeOf(e as Building).units, 0);
      }
      const s = schoolsNeeded(units);
      return { content: { units: Math.round(units), students: Object.fromEntries(Object.entries(s.students).map(([k, v]) => [k, Math.round(v)])), schools_needed: Object.fromEntries(Object.entries(s.schools).map(([k, v]) => [k, Math.round(v * 100) / 100])), assumptions: "Student generation 0.06/0.025/0.03 per multifamily unit (elem/middle/high), 0.25/0.10/0.12 per single-family; capacities 650 / 1,000 / 2,200" }, display: { title: "Estimated school demand", detail: `${Math.round(units)} units → ${Math.round(s.students.elementary + s.students.middle + s.students.high)} students`, status: "ok" } };
    }
    if (i.what === "growth") {
      const p0 = R.meta.calibration.censusPopulation;
      const years = i.years ?? 20;
      // year-by-year allocation to lots (worker): capacity × redevelopment likelihood × transit access
      const rec = await simulate("growth", { years, capacity: i.capacity, rate: i.rate });
      const g = rec.result as { series: { year: number; population: number }[]; ids: string[]; snapshots: { year: number; added: number[] }[]; zonedCapacityResidents: number; unplaced: number; assumptions: string[] };
      const hoods = [...R.world.all("place")].filter((pl) => pl.poly && (pl.type === "neighbourhood" || pl.type === "district") && pl.id !== "place:downtown");
      const where = g.ids.map((id) => {
        const par = R.world.get<Parcel>(id);
        return par ? (hoods.find((pl) => pointInPoly(polyCentroid(par.poly), pl.poly!))?.name ?? "elsewhere") : "elsewhere";
      });
      const byArea = (snap: { added: number[] }) => {
        const by = new Map<string, number>();
        snap.added.forEach((v, k) => v > 0 && by.set(where[k], (by.get(where[k]) ?? 0) + v));
        return [...by.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 8)
          .map(([name, v]) => {
            const h = hoods.find((pl) => pl.name === name);
            return { area: name, added_residents: Math.round(v), added_per_ha: h ? r1(v / (polyArea(h.poly!) / 10000)) : null };
          });
      };
      const last = g.snapshots[g.snapshots.length - 1];
      const topLots = last.added
        .map((v, k) => ({ v, k }))
        .sort((x, y) => y.v - x.v)
        .slice(0, 5)
        .map(({ v, k }) => {
          const par = R.world.get<Parcel>(g.ids[k])!;
          return { id: g.ids[k], zoning: par.zoning, land_use: par.landUse, added_residents: Math.round(v), at: pt(polyCentroid(par.poly)) };
        });
      useSims.getState().setShown("growth", rec.id);
      overlayState.growthYear = last.year;
      useApp.getState().setOverlay("growth");
      useApp.getState().bumpOverlay();
      return {
        content: {
          model: "logistic growth bounded by a capacity assumption, allocated year by year to lots (scenario, not a forecast)",
          series: g.series.filter((x) => (x.year - 2020) % 5 === 0 || x.year === last.year),
          zoned_capacity_residents: g.zonedCapacityResidents,
          unplaced_residents: g.unplaced,
          by_area: Object.fromEntries(g.snapshots.map((sn) => [String(sn.year), byArea(sn)])),
          top_lots: topLots,
          map: `Growth overlay on, showing ${last.year}; snapshot years ${g.snapshots.map((sn) => sn.year).join(", ")} (show overlay 'growth' mode <year>)`,
          assumptions: g.assumptions,
        },
        display: { title: "Projected growth", detail: `${fmt.int(p0)} → ${fmt.int(g.series[g.series.length - 1].population)} by ${last.year} · mapped by lot`, status: "ok" },
      };
    }
    if (i.what === "budget_fit") {
      // which soft sites deliver the most homes for a public-infrastructure budget (greedy by cost per unit)
      const C = { ...UNIT_COSTS, ...(i.unit_costs ?? {}) } as Record<string, number>;
      if (!i.budget) return err("Estimate", "budget_fit needs budget (USD)");
      const poly = i.within ? resolveArea(i.within).poly : null;
      const capRec = await simulate("capacity", {});
      const s = STUDENT_RATES.multifamily;
      const studentsPerUnit = s.elementary + s.middle + s.high;
      const sites = (capRec.result.parcels as { id: string; addedUnits: number; area: number; zoning: string }[])
        .filter((p) => p.addedUnits >= 5)
        .map((p) => ({ p, par: R.world.get<Parcel>(p.id) }))
        .filter(({ par }) => par && (!poly || pointInPoly(polyCentroid(par.poly), poly)))
        .map(({ p, par }) => {
          const frontage = Math.sqrt(par!.area);
          const newStreet = par!.area > 8000 ? Math.sqrt(par!.area) * 16 * C["New local street for large sites ($/m², carriageway + sidewalks)"] : 0;
          const cost = p.addedUnits * (C["Utility connections & capacity ($/unit)"] + studentsPerUnit * C["School seat ($/student seat)"]) + frontage * C["Frontage upgrade: sidewalk, kerb, trees ($/m)"] + newStreet;
          return { id: p.id, zoning: par!.zoning, units: p.addedUnits, cost, perUnit: cost / p.addedUnits };
        })
        .sort((a, b) => a.perUnit - b.perUnit);
      const chosen: typeof sites = [];
      let spent = 0,
        units = 0;
      for (const x of sites) {
        if (spent + x.cost > i.budget) continue;
        chosen.push(x);
        spent += x.cost;
        units += x.units;
      }
      const allUnits = sites.reduce((a, x) => a + x.units, 0);
      return {
        content: {
          budget_usd: i.budget,
          sites_selected: chosen.length,
          added_units: Math.round(units),
          infrastructure_cost_usd: Math.round(spent),
          cost_per_unit_usd: units ? Math.round(spent / units) : null,
          share_of_zoned_capacity: allUnits ? Math.round((units / allUnits) * 1000) / 10 + "%" : null,
          top_sites: chosen.slice(0, 12).map((x) => ({ parcel: x.id, zoning: x.zoning, added_units: Math.round(x.units), infrastructure_usd: Math.round(x.cost) })),
          method: "zoned capacity per soft site (capacity model) costed for public infrastructure — utility connections/capacity and school seats per unit, frontage upgrades, a new local street on sites > 0.8 ha — then sites taken cheapest-per-unit first until the budget is spent (greedy knapsack). Building construction is private and excluded.",
          unit_costs: Object.fromEntries(Object.entries(C).filter(([k]) => /unit\)|seat|Frontage|New local street/.test(k))),
        },
        display: { title: "Housing per infrastructure dollar", detail: `${fmt.int(units)} units on ${chosen.length} sites for $${(spent / 1e6).toFixed(0)}M`, status: "ok" },
      };
    }
    // costs of the active scenario's changes
    const C = { ...UNIT_COSTS, ...(i.unit_costs ?? {}) } as Record<string, number>;
    const d = R.scenarios.diff("baseline", R.scenarios.activeId);
    const items: Record<string, number> = {};
    const addC = (k: string, v: number) => (items[k] = (items[k] ?? 0) + v);
    for (const id of d.added) {
      const e = d.b.get(id)!;
      if (e.kind === "building") {
        const g = programmeOf(e as Building).gfa;
        const key = e.use === "office" ? "Office construction ($/m² GFA)" : (e as Building).height > 45 ? "Residential high-rise construction ($/m² GFA)" : "Residential mid-rise construction ($/m² GFA)";
        addC("Buildings", g * C[key]);
        if ((e as Building).greenRoof) addC("Green roofs", polyArea((e as Building).footprint) * 0.8 * C["Green roof retrofit ($/m²)"]);
      } else if (e.kind === "area") {
        const a = polyArea((e as Area).poly);
        if ((e as Area).type === "park" || (e as Area).type === "plaza") addC("Parks & plazas", a * C["Park construction ($/m²)"]);
        if ((e as Area).type === "raingarden") addC("Rain gardens", a * C["Rain garden / bioretention ($/m²)"]);
        if ((e as Area).type === "retention") addC("Retention ponds", a * ((e as Area).depth ?? 1.5) * C["Retention pond ($/m³ storage)"]);
      } else if (e.kind === "tree") addC("Street trees", C["Street tree incl. soil cells ($/tree)"]);
      else if (e.kind === "street") addC("New streets", polyLength((e as Street).path) * carriagewayWidth((e as Street).section) * C["Street reconstruction ($/m² of carriageway)"]);
      else if (e.kind === "route" && (e as TransitRoute).mode === "tram") addC("Tram", (polyLength((e as TransitRoute).path) / 1000) * C["Tram line incl. vehicles ($/km)"]);
    }
    for (const id of d.modified) {
      const a = d.a.get(id)!,
        b = d.b.get(id)!;
      if (a.kind === "street" && b.kind === "street" && a.section !== b.section) {
        const L = polyLength(b.path);
        addC("Street reconstruction", L * carriagewayWidth(b.section) * C["Street reconstruction ($/m² of carriageway)"]);
        const pb = b.section.strips.filter((s) => s.type === "cycletrack").length - a.section.strips.filter((s) => s.type === "cycletrack").length;
        if (pb > 0) addC("Protected bike lanes", (L / 1000) * pb * C["Protected bike lane ($/km, one direction)"]);
        const bioW = (sec: Street["section"]) => sec.strips.filter((s) => s.bio).reduce((w, s) => w + s.width, 0);
        const db = bioW(b.section) - bioW(a.section);
        if (db > 0) addC("Rain gardens", db * L * C["Rain garden / bioretention ($/m²)"]);
      }
      if (a.kind === "parcel" && b.kind === "parcel") addC("Right-of-way acquisition", Math.max(0, polyArea(a.poly) - polyArea(b.poly)) * C["Right-of-way acquisition ($/m², downtown)"]);
      if (a.kind === "building" && b.kind === "building" && !a.greenRoof && b.greenRoof) addC("Green roofs", polyArea(b.footprint) * 0.8 * C["Green roof retrofit ($/m²)"]);
    }
    for (const id of d.removed) {
      const e = d.a.get(id)!;
      if (e.kind === "building") addC("Demolition", programmeOf(e as Building).gfa * C["Demolition ($/m² GFA)"]);
    }
    const total = Object.values(items).reduce((s, v) => s + v, 0);
    const budget = i.budget;
    return {
      content: { total_usd: Math.round(total), breakdown: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, Math.round(v)])), unit_costs: C, within_budget: budget ? total <= budget : undefined, note: "Order-of-magnitude capital costs (2026 USD) from stated unit costs; excludes land, soft costs, financing and utilities relocation" },
      display: { title: "Estimated capital cost", detail: `$${(total / 1e6).toFixed(1)}M${budget ? ` vs budget $${(budget / 1e6).toFixed(0)}M` : ""}`, status: budget && total > budget ? "warn" : "ok", lines: Object.entries(items).map(([k, v]) => `${k}: $${(v / 1e6).toFixed(1)}M`) },
    };
  },

  async camera(i) {
    switch (i.action) {
      case "overview":
        overview();
        break;
      case "pedestrian":
        pedestrianAt(resolveLocation(i.target).p, i.bearing);
        useApp.getState().setCameraMode("pedestrian");
        break;
      case "orbit":
        orbit(resolveLocation(i.target).p);
        break;
      case "flyover":
        await flyover(((i.targets as Loc[]) ?? [i.target]).map((t) => resolveLocation(t).p));
        break;
      default: {
        const t = resolveLocation(i.target);
        flyTo(t.p, { zoom: i.zoom, pitch: i.pitch, bearing: i.bearing });
        if (useApp.getState().cameraMode === "pedestrian") useApp.getState().setCameraMode("orbit");
      }
    }
    return { content: { ok: true }, display: { title: `Camera: ${i.action}${i.target ? ` → ${typeof i.target === "string" ? i.target : "point"}` : ""}`, status: "ok" } };
  },

  async show(i) {
    const st = useApp.getState();
    if (i.overlay !== undefined) st.setOverlay(i.overlay === "none" ? null : (i.overlay as OverlayId));
    if (i.hour !== undefined) st.setHour(Math.max(0, Math.min(23.9, i.hour)));
    if (i.mode) {
      if (i.overlay === "heat" || st.overlay === "heat") overlayState.heatMode = i.mode;
      else if (i.overlay === "density" || st.overlay === "density") overlayState.densityMode = i.mode;
      else if (i.overlay === "access" || st.overlay === "access") overlayState.accessCategory = i.mode;
      else if (i.overlay === "zoning" || st.overlay === "zoning") overlayState.capacityMode = i.mode;
      else if (i.overlay === "growth" || st.overlay === "growth") overlayState.growthYear = Number(i.mode) || null;
    }
    if (i.compare_with !== undefined) {
      const kind = ({ traffic: "traffic", heat: "heat", runoff: "runoff" } as Record<string, "traffic" | "heat" | "runoff">)[i.overlay ?? st.overlay ?? ""];
      if (kind) {
        if (i.compare_with === null || i.compare_with === "none") useSims.getState().setCompare(kind, undefined);
        else {
          const cmp = await simulate(kind, {}, i.compare_with);
          const cur = await simulate(kind, {});
          useSims.getState().setShown(kind, cur.id);
          useSims.getState().setCompare(kind, cmp.id);
        }
      }
    }
    if (i.timelapse) {
      const { from = 6, to = 20, seconds = 12 } = i.timelapse;
      const t0 = performance.now();
      const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: () => void) => setTimeout(f, 50);
      await new Promise<void>((resolve) => {
        const step = () => {
          const f = (performance.now() - t0) / (seconds * 1000);
          useApp.getState().setHour(from + (to - from) * Math.min(1, f));
          if (f < 1) raf(step);
          else resolve();
        };
        raf(step);
      });
    }
    st.bumpOverlay();
    return { content: { overlay: useApp.getState().overlay, hour: useApp.getState().hour }, display: { title: `Showing ${i.overlay ?? st.overlay ?? "base map"}${i.hour !== undefined ? ` at ${String(Math.floor(i.hour)).padStart(2, "0")}:00` : ""}`, status: "ok" } };
  },

  async annotate(i) {
    const st = useApp.getState();
    const notes = ((i.notes as { at: Loc; title: string; body?: string; tone?: "info" | "warn" | "good" }[]) ?? []).map((n, k) => ({ id: `ann${Date.now()}${k}`, p: resolveLocation(n.at).p, title: n.title, body: n.body, tone: n.tone ?? "info" }));
    st.setAnnotations(i.clear ? notes : [...st.annotations, ...notes]);
    if (i.highlight) st.setHighlight({ ids: i.highlight });
    return { content: { placed: notes.length }, display: { title: `Annotated ${notes.length} location${notes.length === 1 ? "" : "s"}`, status: "ok" } };
  },
};

/** check streamed tool input against the tool's JSON schema (required keys and top-level types) before running it */
export function validateToolInput(name: string, input: unknown): string | null {
  const def = TOOL_DEFS.find((d) => d.name === name);
  if (!def) return `Unknown tool ${name}`;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "INVALID_INPUT: tool input must be a JSON object";
  const schema = def.input_schema as { properties?: Record<string, { type?: string; anyOf?: { type?: string }[]; enum?: unknown[] }>; required?: string[] };
  for (const k of schema.required ?? []) if ((input as In)[k] === undefined) return `INVALID_INPUT: missing required field “${k}”`;
  const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "number" ? "number" : typeof v);
  for (const [k, v] of Object.entries(input as In)) {
    const p = schema.properties?.[k];
    if (!p || v === undefined) continue;
    const allowed = p.type ? [p.type] : p.anyOf?.map((a) => a.type).filter(Boolean) ?? [];
    const t = typeOf(v);
    if (allowed.length && !allowed.some((a) => a === t || (a === "integer" && t === "number"))) return `INVALID_INPUT: “${k}” should be ${allowed.join(" or ")}, got ${t}`;
    if (p.enum && !p.enum.includes(v)) return `INVALID_INPUT: “${k}” must be one of ${p.enum.join(", ")}`;
  }
  return null;
}

export async function executeTool(name: string, input: In, ctx: ToolContext): Promise<ToolOutput> {
  const fn = TOOLS[name];
  if (!fn) return err(name, `Unknown tool ${name}`);
  const invalid = validateToolInput(name, input ?? {});
  if (invalid) return err(name, invalid);
  try {
    return await fn(input ?? {}, input?.dry_run ? { ...ctx, dryRun: true } : ctx);
  } catch (e) {
    return err(name, (e as Error).message);
  }
}

export { intersection, difference, parcelsUnder, closestOnPath, nearestNode };
