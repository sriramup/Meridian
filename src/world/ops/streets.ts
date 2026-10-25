// Street network operations with topology-aware cascades. Every change to a
// street's right-of-way is followed through to buildings, parcels, trees,
// kerb inlets, transit stops and the connected junctions; the consequences are
// either resolved (and recorded) or reported as unresolved conflicts.

import { carriagewayWidth, countType, kerbOffsets, laneCount, sectionWidth, buildSection, cloneSection } from "@/geometry/crossSection";
import { bufferPoly, circle, difference, isValidPoly, overlapArea, pointInPoly, polyArea, polyBBox, polyCentroid, union, unionMany } from "@/geometry/polygon";
import { bandRing, closestOnPath, curvatureStats, filletPath, minRadiusForSpeed, offsetPath, pathBBox, pointAt, polyLength, simplifyPath, slicePath, smoothPath } from "@/geometry/polyline";
import { add, dist, segIntersect, sub } from "@/geometry/vec";
import type { Area, Building, NodeControl, Parcel, Polygon, RoadClass, Street, StreetNode, Strip, TransitRoute, TransitStop, Tree, Utility, Vec2 } from "../types";
import { newId, type World } from "../world";
import { OpBuilder, fmt, programmeOf, type OpResult } from "./core";
import { applySectionEdits, type SectionEdit } from "./sectionEdit";
import { streetBand } from "./validate";
import type { Actor } from "./buildings";

export type ConflictPolicy = "trim" | "demolish" | "report";

const parkingSpaces = (s: Street) => (countType(s.section, "parking") * polyLength(s.path) * 0.8) / 6.7;

function carriagewayRing(s: Street) {
  const k = kerbOffsets(s.section, s.section.shift ?? 0);
  return bandRing(s.path, k.right, k.left);
}

/**
 * Resolve the physical consequences of a street changing from `before` to `after`
 * (either may be null for creation / removal).
 */
export function cascadeRow(b: OpBuilder, before: Street | null, after: Street | null, policy: ConflictPolicy) {
  const world = b.world;
  const newBand = after ? streetBand(after) : null;
  const oldBand = before ? streetBand(before) : null;
  const label = after?.name ?? before?.name ?? "street";
  const stats = b.cascade;

  if (newBand) {
    const bb = polyBBox(newBand);
    // ---- buildings
    for (const e of world.query(bb, ["building"])) {
      const bld = b.get<Building>(e.id);
      if (!bld || b.isRemoved(e.id)) continue;
      const area = overlapArea(bld.footprint, newBand);
      const was = oldBand ? overlapArea(bld.footprint, oldBand) : 0;
      if (area - was < 1.5) continue; // pre-existing encroachment is a data artefact, not a new conflict
      const nm = bld.name ?? `building ${bld.id.slice(-6)}`;
      // encroachment depth ≈ new overlap / frontage length along the band
      const frontLen = Math.max(4, Math.sqrt(polyArea(bld.footprint)));
      const depth = (area - was) / frontLen;
      if (depth < 0.6) {
        stats.minor = (stats.minor ?? 0) + 1;
        continue;
      }
      if (policy === "report" || (bld.historic && policy !== "demolish")) {
        b.conflict(bld.id, "row", `${nm}${bld.historic ? " (historic-designated)" : ""} would encroach ≈${depth.toFixed(1)} m into the new right-of-way of ${label} — not changed`, false);
        continue;
      }
      const cut = bufferPoly(newBand, 0.3);
      const rem = difference(bld.footprint, cut).sort((x, y) => polyArea(y) - polyArea(x));
      const keep = rem[0];
      const pr = programmeOf(bld);
      if (policy === "trim" && keep && polyArea(keep) > 0.55 * polyArea(bld.footprint)) {
        const masses = bld.masses
          .map((m) => ({ ...m, poly: difference(m.poly, cut).sort((x, y) => polyArea(y) - polyArea(x))[0] }))
          .filter((m) => m.poly && isValidPoly(m.poly));
        const nb: Building = { ...bld, footprint: keep, masses: masses as Building["masses"], heightSource: bld.heightSource, notes: [bld.notes, `front trimmed for ${label} right-of-way`].filter(Boolean).join("; ") };
        b.update(nb);
        const lost = pr.gfa - programmeOf(nb).gfa;
        stats.trimmed++;
        stats.gfaLost += lost;
        b.conflict(bld.id, "row", `${nm}: façade set back ≈${depth.toFixed(1)} m; −${fmt.m2(lost)} GFA`, true);
      } else {
        if (bld.historic) b.warn(`${nm} is historic-designated — demolition requires Historic Landmark Commission approval`);
        b.remove(bld.id);
        stats.demolished++;
        stats.gfaLost += pr.gfa;
        stats.unitsLost += pr.units;
        b.conflict(bld.id, "row", `${nm} demolished (≈${depth.toFixed(1)} m inside the new right-of-way)`, true);
      }
    }
    // ---- parcels: right-of-way acquisition
    for (const e of world.query(bb, ["parcel"])) {
      const p = b.get<Parcel>(e.id);
      if (!p) continue;
      const area = overlapArea(p.poly, newBand);
      const was = oldBand ? overlapArea(p.poly, oldBand) : 0;
      if (area - was < 2) continue;
      const rem = difference(p.poly, newBand).sort((x, y) => polyArea(y) - polyArea(x))[0];
      if (rem && polyArea(rem) > 20) b.update<Parcel>({ ...p, poly: rem, area: Math.round(polyArea(rem)) });
      else b.remove(p.id);
      stats.parcels++;
      stats.taken += area - was;
    }
    // ---- trees in the new carriageway (planting strips keep theirs)
    const car = after ? [carriagewayRing(after)] : null;
    if (car) {
      for (const e of world.query(polyBBox(car), ["tree"])) {
        const t = b.get<Tree>(e.id);
        if (!t || !pointInPoly(t.p, car)) continue;
        const wasIn = before ? pointInPoly(t.p, [carriagewayRing(before)]) : false;
        if (wasIn) continue;
        b.remove(t.id);
        stats.trees++;
      }
    }
    // ---- areas the new ROW cuts through (parks, plazas, parking)
    for (const e of world.query(bb, ["area"])) {
      const a = b.get<Area>(e.id);
      if (!a || a.type === "water") continue;
      const area = overlapArea(a.poly, newBand);
      const was = oldBand ? overlapArea(a.poly, oldBand) : 0;
      if (area - was < 4) continue;
      const rem = difference(a.poly, newBand).sort((x, y) => polyArea(y) - polyArea(x))[0];
      if (rem && polyArea(rem) > 15) b.update<Area>({ ...a, poly: rem });
      else b.remove(a.id);
      const key = a.name ?? (a.type === "parking" ? "Surface parking" : a.type[0].toUpperCase() + a.type.slice(1));
      stats.areas.set(key, (stats.areas.get(key) ?? 0) + area - was);
      if (a.type === "park") stats.parkTaken += area - was;
    }
  }

  // ---- kerb inlets and transit stops follow the kerb
  if (before && after) {
    const kb = kerbOffsets(before.section, before.section.shift ?? 0);
    const ka = kerbOffsets(after.section, after.section.shift ?? 0);
    const moved = Math.abs(kb.left - ka.left) > 0.4 || Math.abs(kb.right - ka.right) > 0.4 || before.path !== after.path;
    if (moved) {
      const bb = pathBBox(before.path);
      const pad = sectionWidth(before.section) / 2 + 6;
      const sideKerbs = [
        { old: offsetPath(before.path, kb.left), neu: offsetPath(after.path, ka.left) },
        { old: offsetPath(before.path, kb.right), neu: offsetPath(after.path, ka.right) },
      ];
      for (const e of world.query([bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad], ["utility", "stop"])) {
        if (e.kind === "utility") {
          const u = b.get<Utility>(e.id);
          if (!u || u.type !== "inlet") continue;
          for (const k of sideKerbs) {
            const c = closestOnPath(u.path[0], k.old);
            if (c.d > 2.5) continue;
            const np = pointAt(k.neu, c.along).p;
            if (dist(np, u.path[0]) > 0.4) {
              b.update<Utility>({ ...u, path: [np] });
              stats.inlets++;
            }
            break;
          }
        } else {
          const s = b.get<TransitStop>(e.id);
          if (!s) continue;
          for (const k of sideKerbs) {
            const c = closestOnPath(s.p, k.old);
            if (c.d > 7) continue;
            const kp = pointAt(k.neu, c.along);
            const off: Vec2 = sub(s.p, c.p);
            const np = add(kp.p, off);
            if (dist(np, s.p) > 0.4) {
              b.update<TransitStop>({ ...s, p: np });
              stats.stops++;
            }
            break;
          }
        }
      }
    }
  }

  return stats;
}

function describeChange(b: OpBuilder, before: Street, after: Street) {
  const lf0 = laneCount(before.section, 1),
    lb0 = laneCount(before.section, -1),
    lf1 = laneCount(after.section, 1),
    lb1 = laneCount(after.section, -1);
  const w0 = sectionWidth(before.section),
    w1 = sectionWidth(after.section);
  const c0 = carriagewayWidth(before.section),
    c1 = carriagewayWidth(after.section);
  const parts: string[] = [];
  if (lf0 !== lf1 || lb0 !== lb1) parts.push(`lanes ${lf0}+${lb0} → ${lf1}+${lb1}`);
  if (Math.abs(w1 - w0) > 0.1) parts.push(`ROW ${w0.toFixed(1)} → ${w1.toFixed(1)} m`);
  if (Math.abs(c1 - c0) > 0.1) parts.push(`crossing distance ${c0.toFixed(1)} → ${c1.toFixed(1)} m`);
  const p0 = parkingSpaces(before),
    p1 = parkingSpaces(after);
  if (Math.abs(p1 - p0) >= 1) parts.push(`on-street parking ${p1 > p0 ? "+" : "−"}${Math.round(Math.abs(p1 - p0))} spaces`);
  return parts;
}

function nodesOf(world: World, ids: string[]) {
  const s = new Set<string>();
  for (const id of ids) {
    const st = world.get<Street>(id);
    if (st) {
      s.add(st.from);
      s.add(st.to);
    }
  }
  return s;
}

// --------------------------------------------------------------------------- section edits

/** map a compass side to the segment's left/right (relative to from→to) */
export function compass(s: Street, side: string): "left" | "right" {
  const a = s.path[0],
    z = s.path[s.path.length - 1];
  const leftN: Vec2 = [-(z[1] - a[1]), z[0] - a[0]];
  const want: Vec2 = side === "north" ? [0, 1] : side === "south" ? [0, -1] : side === "east" ? [1, 0] : [-1, 0];
  return leftN[0] * want[0] + leftN[1] * want[1] >= 0 ? "left" : "right";
}

export interface EditSectionParams {
  streetIds: string[];
  edits: SectionEdit[];
  /** keep this ROW edge fixed when the total width changes ('left'|'right' or a compass side) */
  anchor?: string;
  keepRowWidth?: boolean;
  policy?: ConflictPolicy;
  label?: string;
}

export function editStreetSections(world: World, p: EditSectionParams, actor: Actor): OpResult {
  const b = new OpBuilder(world, actor.author);
  const changes: string[] = [];
  const perSeg = new Map<string, number>();
  const compassSide = p.edits.map((e) => ("side" in e && typeof e.side === "string" && !["left", "right", "both"].includes(e.side) ? e.side : null)).find(Boolean);
  let nEdited = 0;
  const edited: string[] = [];
  for (const id of p.streetIds) {
    const st = b.get<Street>(id);
    if (!st || st.kind !== "street") continue;
    const edits = p.edits.map((e) => ("side" in e && e.side && !["left", "right", "both"].includes(e.side as string) ? { ...e, side: compass(st, e.side as string) } : e)) as SectionEdit[];
    const out = applySectionEdits(st.section, st.oneway, !!st.closed, edits, { keepRowWidth: p.keepRowWidth });
    // segments the edit leaves as they are are not rebuilt (e.g. rain gardens only where there is a parking lane)
    if (out.oneway === st.oneway && !!out.closed === !!st.closed && JSON.stringify(out.section.strips) === JSON.stringify(st.section.strips) && !p.anchor) continue;
    const W0 = sectionWidth(st.section);
    const W1 = sectionWidth(out.section);
    let shift = st.section.shift ?? 0;
    const anchor = p.anchor && !["left", "right", "centre"].includes(p.anchor) ? compass(st, p.anchor) : p.anchor;
    if (anchor === "left") shift += (W0 - W1) / 2;
    if (anchor === "right") shift += (W1 - W0) / 2;
    out.section.shift = Math.abs(shift) > 0.01 ? Math.round(shift * 100) / 100 : undefined;
    const ns: Street = { ...st, section: out.section, oneway: out.oneway, closed: out.closed || undefined, serviceAccess: out.closed ? true : st.serviceAccess, sectionSource: "proposed", createdBy: st.createdBy ?? b.tag };
    b.update(ns);
    cascadeRow(b, st, ns, p.policy ?? "trim");
    const d = describeChange(b, st, ns);
    if (nEdited === 0) changes.push(...out.notes.map((n) => (compassSide ? n.replace(/on the (left|right) side/, `on the ${compassSide} side`) : n)));
    if (d.length) {
      const k = `${st.name ?? id}: ${d.join(", ")}`;
      perSeg.set(k, (perSeg.get(k) ?? 0) + 1);
    }
    nEdited++;
    edited.push(id);
  }
  if (!nEdited) return b.fail(p.streetIds.length ? "The edit changes none of these streets (nothing to convert, or already in that state)" : "No streets matched");
  // one line per distinct before→after change (corridors repeat the same section many times)
  const segLines = [...perSeg].sort((x, y) => y[1] - x[1]);
  for (const [k, n] of segLines.slice(0, 4)) b.summary(n > 1 ? `${k} (${n} segments)` : k);
  if (segLines.length > 4) b.summary(`…and ${segLines.length - 4} other section variants`);
  const nodes = nodesOf(world, edited);
  const unchanged = p.streetIds.length - nEdited;
  b.summary(`${nEdited} segment${nEdited > 1 ? "s" : ""} rebuilt (${changes.join("; ")}); ${nodes.size} junctions regenerated${unchanged ? `; ${unchanged} segment${unchanged > 1 ? "s" : ""} unchanged` : ""}`);
  // continuity at the corridor ends
  const editedSet = new Set(edited);
  for (const nid of nodes) {
    const inc = world.incident(nid).filter((s) => !editedSet.has(s.id));
    const mine = world.incident(nid).filter((s) => editedSet.has(s.id));
    if (!mine.length) continue;
    for (const o of inc) {
      if (!o.name || o.name !== mine[0].name) continue;
      const after = b.get<Street>(mine[0].id)!;
      const dw = Math.abs(carriagewayWidth(after.section) - carriagewayWidth(o.section));
      if (dw > 1) b.warn(`Width transition at the ${o.name} corridor end (${dw.toFixed(1)} m change) — taper or extend the treatment`);
    }
  }
  return b.finish(p.label ?? `Edit ${nEdited} street segment${nEdited > 1 ? "s" : ""}`);
}

// --------------------------------------------------------------------------- junction control

export function setNodeControl(world: World, nodeId: string, control: NodeControl | "plaza", opts: { radius?: number; lanes?: number; policy?: ConflictPolicy; tsp?: boolean }, actor: Actor): OpResult {
  const b = new OpBuilder(world, actor.author);
  const n = world.get<StreetNode>(nodeId);
  if (!n) return b.fail("Junction not found");
  const inc = world.incident(nodeId);
  const names = [...new Set(inc.map((s) => s.name).filter(Boolean))].join(" / ") || nodeId;
  if (control === "plaza") {
    b.update<StreetNode>({ ...n, plaza: true, control: "none" });
    b.summary(`${names}: junction converted to a pedestrian plaza; ${inc.length} approaches become cul-de-sacs`);
    b.warn("Through traffic across this junction is removed — run the traffic model to see where it reroutes");
    return b.finish(`Pedestrian plaza at ${names}`);
  }
  if (control === "roundabout") {
    const approachW = Math.max(...inc.map((s) => carriagewayWidth(s.section) / 2));
    const lanes = opts.lanes ?? (inc.some((s) => laneCount(s.section) > 2) ? 2 : 1);
    const R = Math.max(opts.radius ?? (lanes > 1 ? 24 : 16), approachW + lanes * 5 + 4);
    const footprint: Polygon = [circle(n.p, R + 4.5, 48)];
    b.update<StreetNode>({ ...n, control: "roundabout", plaza: undefined, roundabout: { radius: R, lanes } });
    // cascade: the circle + sidewalk ring against corner buildings, parcels, trees
    const policy = opts.policy ?? "trim";
    let dem = 0,
      trim = 0;
    for (const e of world.query(polyBBox(footprint), ["building"])) {
      const bld = e as Building;
      const area = overlapArea(bld.footprint, footprint);
      if (area < 2) continue;
      if (policy === "report") {
        b.conflict(bld.id, "row", `${bld.name ?? "Building"} intersects the roundabout footprint (${area.toFixed(0)} m²)`, false);
        continue;
      }
      const rem = difference(bld.footprint, footprint).sort((x, y) => polyArea(y) - polyArea(x))[0];
      if (policy === "trim" && rem && polyArea(rem) > 0.6 * polyArea(bld.footprint) && !bld.historic) {
        b.update<Building>({ ...bld, footprint: rem, masses: bld.masses.map((m) => ({ ...m, poly: difference(m.poly, footprint).sort((x, y) => polyArea(y) - polyArea(x))[0] ?? m.poly })) });
        trim++;
      } else {
        b.remove(bld.id);
        dem++;
      }
    }
    let taken = 0;
    for (const e of world.query(polyBBox(footprint), ["parcel"])) {
      const p = e as Parcel;
      const area = overlapArea(p.poly, footprint);
      if (area < 2) continue;
      const rem = difference(p.poly, footprint).sort((x, y) => polyArea(y) - polyArea(x))[0];
      if (rem) b.update<Parcel>({ ...p, poly: rem, area: Math.round(polyArea(rem)) });
      taken += area;
    }
    let trees = 0;
    for (const e of world.query(polyBBox(footprint), ["tree"])) {
      const t = e as Tree;
      const d = dist(t.p, n.p);
      if (d < R + 1 && d > R - lanes * 5 - 1) {
        b.remove(t.id);
        trees++;
      }
    }
    b.summary(`${names}: ${lanes}-lane roundabout, outer radius ${R.toFixed(0)} m (inscribed diameter ${(2 * R).toFixed(0)} m); ${inc.length} approaches rebuilt with entry flares and crossings set back`);
    if (taken) b.summary(`Corner right-of-way acquisition ${fmt.m2(taken)}`);
    if (trim) b.summary(`${trim} corner building${trim > 1 ? "s" : ""} trimmed`);
    if (dem) b.summary(`${dem} building${dem > 1 ? "s" : ""} demolished for the roundabout footprint`);
    if (trees) b.summary(`${trees} trees removed from the circulatory roadway`);
    b.summary("Capacity modelled with the HCM 6th-edition roundabout entry-capacity equation");
    return b.finish(`Roundabout at ${names}`);
  }
  const tsp = control === "signal" ? (opts.tsp ?? n.tsp) || undefined : undefined;
  if (opts.tsp && control !== "signal") b.warn("Transit signal priority needs a signal — not applied");
  b.update<StreetNode>({ ...n, control, plaza: undefined, roundabout: undefined, tsp });
  b.summary(`${names}: control set to ${control}${tsp ? " with transit signal priority (green extension / early green for buses)" : ""}`);
  return b.finish(`${control === "signal" ? (tsp && n.control === "signal" ? "Transit priority at" : "Signalise") : "Set control at"} ${names}`);
}

/** transit signal priority on or off at existing signals (e.g. every signal along a bus route) */
export function setTransitPriority(world: World, nodeIds: string[], on: boolean, actor: Actor, label?: string): OpResult {
  const b = new OpBuilder(world, actor.author);
  let n = 0,
    skipped = 0;
  for (const id of nodeIds) {
    const node = b.get<StreetNode>(id);
    if (!node || node.kind !== "node") continue;
    if (node.control !== "signal") {
      skipped++;
      continue;
    }
    if (!!node.tsp === on) continue;
    b.update<StreetNode>({ ...node, tsp: on || undefined });
    n++;
  }
  if (!n) return b.fail(skipped ? "None of these junctions is signalised" : "Nothing to change");
  b.summary(`Transit signal priority ${on ? "added at" : "removed from"} ${n} signal${n > 1 ? "s" : ""}${label ? ` along ${label}` : ""}${skipped ? ` (${skipped} unsignalised junctions skipped)` : ""}`);
  return b.finish(`${on ? "Transit priority" : "Remove transit priority"}${label ? ` — ${label}` : ""}`);
}

/** rebuild absent and poor (grade D–F) curb ramps at junctions to the current accessible standard */
export function upgradeCurbRamps(world: World, nodeIds: string[], actor: Actor): OpResult {
  const b = new OpBuilder(world, actor.author);
  let ramps = 0,
    junctions = 0,
    unknown = 0;
  for (const id of nodeIds) {
    const node = b.get<StreetNode>(id);
    if (!node || node.kind !== "node") continue;
    const r = node.ramps;
    if (!r) {
      unknown++;
      continue;
    }
    const fix = r.poor + r.absent;
    if (!fix) continue;
    b.update<StreetNode>({ ...node, ramps: { ok: r.ok + fix, poor: 0, absent: 0 } });
    ramps += fix;
    junctions++;
  }
  if (!ramps) return b.fail(unknown === nodeIds.length ? "No curb-ramp inventory at these junctions" : "No absent or poor curb ramps at these junctions");
  b.summary(`${ramps} curb ramp${ramps > 1 ? "s" : ""} built or rebuilt at ${junctions} junction${junctions > 1 ? "s" : ""} (directional ramps with detectable warning surfaces, PROWAG R304)${unknown ? `; ${unknown} junctions not in the City inventory left as they are` : ""}`);
  return b.finish(`Curb ramps at ${junctions} junction${junctions > 1 ? "s" : ""}`);
}

/** emergency-vehicle signal preemption (EVP) on or off at existing signals */
export function setSignalPreemption(world: World, nodeIds: string[], on: boolean, actor: Actor, label?: string): OpResult {
  const b = new OpBuilder(world, actor.author);
  let n = 0,
    skipped = 0;
  for (const id of nodeIds) {
    const node = b.get<StreetNode>(id);
    if (!node || node.kind !== "node") continue;
    if (node.control !== "signal") {
      skipped++;
      continue;
    }
    if (!!node.evp === on) continue;
    b.update<StreetNode>({ ...node, evp: on || undefined });
    n++;
  }
  if (!n) return b.fail(skipped ? "None of these junctions is signalised" : "Nothing to change");
  b.summary(`Emergency-vehicle signal preemption ${on ? "fitted at" : "removed from"} ${n} signal${n > 1 ? "s" : ""}${label ? ` ${label}` : ""}${skipped ? ` (${skipped} unsignalised junctions skipped)` : ""}`);
  return b.finish(`${on ? "Signal preemption" : "Remove signal preemption"}${label ? ` ${label}` : ""}`);
}

// --------------------------------------------------------------------------- network topology edits

/** split a street at distance `d` along its path; returns the new node id */
function splitStreet(b: OpBuilder, st: Street, d: number, nodeId?: string): { node: StreetNode; a: Street; c: Street } {
  const L = polyLength(st.path);
  const p = pointAt(st.path, d).p;
  const node: StreetNode = nodeId ? b.get<StreetNode>(nodeId)! : b.add<StreetNode>({ id: newId("n"), kind: "node", p, control: "none", edges: [] });
  const a: Street = { ...st, id: newId("s"), to: node.id, path: [...slicePath(st.path, 0, d).slice(0, -1), node.p], createdBy: st.createdBy };
  const c: Street = { ...st, id: newId("s"), from: node.id, path: [node.p, ...slicePath(st.path, d, L).slice(1)], createdBy: st.createdBy };
  b.remove(st.id);
  b.add(a);
  b.add(c);
  // keep references consistent
  for (const r of b.world.all("route")) {
    const rr = b.get<TransitRoute>(r.id)!;
    const i = rr.streets.indexOf(st.id);
    if (i >= 0) {
      const ns = rr.streets.slice();
      ns.splice(i, 1, a.id, c.id);
      b.update<TransitRoute>({ ...rr, streets: ns });
    }
  }
  return { node, a, c };
}

export interface CreateStreetParams {
  path: Vec2[];
  cls?: RoadClass;
  name?: string;
  lanes?: number;
  oneway?: boolean;
  bike?: "lane" | "track" | null;
  parking?: boolean;
  sidewalk?: number;
  median?: boolean;
  trees?: boolean;
  policy?: ConflictPolicy;
  snap?: number;
  /** explicit cross-section (overrides lanes / bike / parking / sidewalk / median) */
  strips?: Strip[];
  /** closed to general traffic, e.g. a bollard-controlled fire lane */
  closed?: boolean;
  serviceAccess?: boolean;
}

/** entities of `kinds` in a bbox as the builder sees them: committed ones plus those pending in the same builder */
function pendingQuery(b: OpBuilder, bb: [number, number, number, number], kinds: ("node" | "street")[]) {
  const out = new Map<string, StreetNode | Street>();
  for (const e of b.world.query(bb, kinds)) {
    const cur = b.get<StreetNode | Street>(e.id);
    if (cur) out.set(e.id, cur);
  }
  for (const e of b.touched()) {
    if (out.has(e.id) || !kinds.includes(e.kind as "node" | "street")) continue;
    const q = e.kind === "node" ? [e.p[0], e.p[1], e.p[0], e.p[1]] : e.kind === "street" ? pathBBox(e.path) : null;
    if (q && q[0] <= bb[2] && q[2] >= bb[0] && q[1] <= bb[3] && q[3] >= bb[1]) out.set(e.id, e as StreetNode | Street);
  }
  return [...out.values()];
}

/** streets meeting at a node, including streets pending in the builder */
function pendingIncident(b: OpBuilder, nodeId: string): Street[] {
  const out = new Map<string, Street>();
  for (const s of b.world.incident(nodeId)) {
    const cur = b.get<Street>(s.id);
    if (cur) out.set(s.id, cur);
  }
  for (const e of b.touched()) if (e.kind === "street" && (e.from === nodeId || e.to === nodeId)) out.set(e.id, e);
  return [...out.values()];
}

/** create a new street, splicing it into the existing network at its ends and at every crossing */
export function createStreet(world: World, p: CreateStreetParams, actor: Actor, ob?: OpBuilder): OpResult {
  const b = ob ?? new OpBuilder(world, actor.author);
  const cls = p.cls ?? "residential";
  const path = simplifyPath(p.path, 0.3);
  if (polyLength(path) < 10) return b.fail("Street too short");
  const snap = p.snap ?? 14;
  // ---- collect split points along the new path: [along, existing street to split | node id]
  type Hit = { along: number; p: Vec2; node?: string; street?: Street; d?: number };
  const hits: Hit[] = [];
  const findEnd = (pt: Vec2, at: number) => {
    let best: Hit | null = null;
    for (const e of pendingQuery(b, [pt[0] - snap, pt[1] - snap, pt[0] + snap, pt[1] + snap], ["node"])) {
      const n = e as StreetNode;
      if (!pendingIncident(b, n.id).some((s) => s.cls !== "motorway" && !s.bridge)) continue;
      const d = dist(n.p, pt);
      if (d < snap && (!best || d < dist(best.p, pt))) best = { along: at, p: n.p, node: n.id };
    }
    if (best) return best;
    for (const e of pendingQuery(b, [pt[0] - snap, pt[1] - snap, pt[0] + snap, pt[1] + snap], ["street"])) {
      const s = b.get<Street>(e.id);
      if (!s || s.cls === "motorway" || s.bridge || s.tunnel) continue;
      const c = closestOnPath(pt, s.path);
      if (c.d < snap * 0.85 && (!best || c.d < dist(best.p, pt))) best = { along: at, p: c.p, street: s, d: c.along };
    }
    return best;
  };
  const L = polyLength(path);
  const startHit = findEnd(path[0], 0);
  const endHit = findEnd(path[path.length - 1], L);
  if (startHit) hits.push(startHit);
  // interior crossings
  const bb = pathBBox(path);
  for (const e of pendingQuery(b, [bb[0] - 5, bb[1] - 5, bb[2] + 5, bb[3] + 5], ["street"])) {
    const s = b.get<Street>(e.id);
    if (!s || s.cls === "motorway" || s.bridge || s.tunnel) continue;
    if (startHit?.street?.id === s.id || endHit?.street?.id === s.id) continue;
    let acc = 0;
    for (let i = 1; i < path.length; i++) {
      for (let j = 1; j < s.path.length; j++) {
        const x = segIntersect(path[i - 1], path[i], s.path[j - 1], s.path[j]);
        if (!x) continue;
        const along = acc + dist(path[i - 1], x);
        if (along < 8 || along > L - 8) continue;
        const sc = closestOnPath(x, s.path);
        // snap to an existing node when the crossing is close to one
        const near = [s.from, s.to].map((nid) => b.get<StreetNode>(nid)!).find((n) => n && dist(n.p, x) < 10);
        hits.push(near ? { along, p: near.p, node: near.id } : { along, p: x, street: s, d: sc.along });
      }
      acc += dist(path[i - 1], path[i]);
    }
  }
  if (endHit) hits.push(endHit);
  hits.sort((a, c) => a.along - c.along);
  // dedupe hits on the same existing street (keep the first)
  const seen = new Set<string>();
  const uniq = hits.filter((h) => {
    const k = h.node ?? h.street!.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // ---- resolve split points into node ids
  const pts: { along: number; nodeId: string; p: Vec2 }[] = [];
  for (const h of uniq) {
    if (h.node) pts.push({ along: h.along, nodeId: h.node, p: h.p });
    else if (h.street) {
      const cur = b.get<Street>(h.street.id);
      if (!cur) continue;
      const { node } = splitStreet(b, cur, h.d!);
      if (cur.cls !== "service") b.update<StreetNode>({ ...b.get<StreetNode>(node.id)!, control: cls === "primary" || cls === "secondary" || cur.cls === "primary" || cur.cls === "secondary" ? "signal" : "stop" });
      pts.push({ along: h.along, nodeId: node.id, p: node.p });
    }
  }
  // free ends
  if (!pts.length || pts[0].along > 1) pts.unshift({ along: 0, nodeId: b.add<StreetNode>({ id: newId("n"), kind: "node", p: path[0], control: "none", edges: [] }).id, p: path[0] });
  if (pts[pts.length - 1].along < L - 1) pts.push({ along: L, nodeId: b.add<StreetNode>({ id: newId("n"), kind: "node", p: path[path.length - 1], control: "none", edges: [] }).id, p: path[path.length - 1] });
  // ---- new segments
  const section = p.strips
    ? { strips: p.strips.map((x) => ({ ...x })) }
    : buildSection({ cls, oneway: !!p.oneway, lanes: p.lanes, median: p.median, bikeLeft: p.bike ?? null, bikeRight: p.bike ?? null, parkingLeft: p.parking ?? cls === "residential", parkingRight: p.parking ?? cls === "residential", downtown: true });
  if (p.sidewalk) for (const s of section.strips) if (s.type === "sidewalk") s.width = p.sidewalk;
  if (p.trees) for (const s of section.strips) if (s.type === "planting") s.trees = true;
  const created: Street[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1],
      c = pts[i];
    const sub = slicePath(path, a.along, c.along);
    sub[0] = a.p;
    sub[sub.length - 1] = c.p;
    if (polyLength(sub) < 3) continue;
    const st: Street = {
      id: newId("s"),
      kind: "street",
      from: a.nodeId,
      to: c.nodeId,
      path: sub,
      name: p.name,
      cls,
      oneway: !!p.oneway,
      section: cloneSection(section),
      ...(p.closed ? { closed: true, serviceAccess: !!p.serviceAccess } : {}),
      speed: cls === "primary" ? 56 : cls === "secondary" ? 48 : cls === "tertiary" ? 40 : 32,
      rowSource: "proposed",
      sectionSource: "proposed",
      source: actor.author === "agent" ? "Generated by Meridian agent" : "Drawn by user",
      createdBy: b.tag,
    };
    b.add(st);
    created.push(st);
    cascadeRow(b, null, st, p.policy ?? "demolish");
  }
  const joined = uniq.length;
  b.summary(`New ${cls} street${p.name ? ` “${p.name}”` : ""}: ${fmt.m(L)}, ${created.length} segment${created.length > 1 ? "s" : ""}, ${sectionWidth(section).toFixed(1)} m ROW; connected at ${joined} point${joined === 1 ? "" : "s"} (${uniq.filter((h) => h.street).length} existing streets split)`);
  b.data.streetIds = created.map((s) => s.id);
  if (ob) return { ok: true, report: b.report, created: created.map((s) => s.id), removed: [], modified: [], data: b.data };
  return b.finish(`New street${p.name ? ` ${p.name}` : ""}`);
}

export function removeStreets(world: World, ids: string[], opts: { reclaim?: "plaza" | "park" | "none" }, actor: Actor): OpResult {
  const b = new OpBuilder(world, actor.author);
  const bands: Polygon[] = [];
  const removed = new Set(ids);
  for (const id of ids) {
    const s = b.get<Street>(id);
    if (!s) continue;
    bands.push(streetBand(s));
    b.remove(id);
  }
  // drop orphaned nodes
  for (const nid of nodesOf(world, ids)) {
    if (world.incident(nid).every((s) => removed.has(s.id))) b.remove(nid);
  }
  if (opts.reclaim && opts.reclaim !== "none" && bands.length) {
    let land = unionMany(bands);
    // keep remaining streets' ROW clear
    const bb = polyBBox(land[0]);
    for (const e of world.query(bb, ["street"])) if (!removed.has(e.id)) land = land.flatMap((q) => difference(q, streetBand(e as Street)));
    for (const q of land) if (isValidPoly(q) && polyArea(q) > 30) b.add<Area>({ id: newId("a"), kind: "area", type: opts.reclaim, poly: q, source: "Reclaimed right-of-way", provenance: "proposed", createdBy: b.tag });
    b.summary(`${fmt.m2(land.reduce((s, q) => s + polyArea(q), 0))} of former right-of-way reclaimed as ${opts.reclaim}`);
  }
  // transit routes that used these streets
  for (const r of world.all("route")) if (r.streets.some((s) => removed.has(s))) b.warn(`Transit route ${r.ref} ${r.name} used a removed street — reroute required`);
  b.summary(`Removed ${ids.length} street segment${ids.length > 1 ? "s" : ""}; adjacent junctions regenerated`);
  return b.finish(`Remove ${ids.length} street segment${ids.length > 1 ? "s" : ""}`);
}

/** translate whole street segments (and their junctions), stretching every connected street to stay attached */
export function moveStreets(world: World, ids: string[], offset: Vec2, opts: { policy?: ConflictPolicy }, actor: Actor): OpResult {
  const b = new OpBuilder(world, actor.author);
  const sel = new Set(ids);
  const nodes = nodesOf(world, ids);
  const before = new Map<string, Street>();
  for (const nid of nodes) {
    const n = b.get<StreetNode>(nid);
    if (n) b.update<StreetNode>({ ...n, p: add(n.p, offset) });
  }
  const touched = new Set<string>();
  for (const nid of nodes) for (const s of world.incident(nid)) touched.add(s.id);
  for (const sid of touched) {
    const s = b.get<Street>(sid)!;
    before.set(sid, s);
    let path: Vec2[];
    if (sel.has(sid)) path = s.path.map((q) => add(q, offset));
    else {
      // connected street: move the attached end, blending the shift over ~30 m
      path = s.path.slice();
      const L = polyLength(path);
      const cum: number[] = [0];
      for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i - 1], path[i]));
      const fromMoved = nodes.has(s.from),
        toMoved = nodes.has(s.to);
      path = path.map((q, i) => {
        let w = 0;
        if (fromMoved) w = Math.max(w, 1 - cum[i] / Math.min(L, 30));
        if (toMoved) w = Math.max(w, 1 - (L - cum[i]) / Math.min(L, 30));
        return add(q, [offset[0] * Math.max(0, w), offset[1] * Math.max(0, w)]);
      });
      if (fromMoved) path[0] = add(s.path[0], offset);
      if (toMoved) path[path.length - 1] = add(s.path[s.path.length - 1], offset);
    }
    const ns: Street = { ...s, path, createdBy: s.createdBy ?? b.tag, rowSource: "proposed" };
    b.update(ns);
  }
  for (const sid of touched) cascadeRow(b, before.get(sid)!, b.get<Street>(sid)!, opts.policy ?? "trim");
  // land released by the old alignment
  let released = 0;
  for (const id of ids) {
    const o = before.get(id)!;
    const n = b.get<Street>(id)!;
    released += difference(streetBand(o), streetBand(n)).reduce((s, q) => s + polyArea(q), 0);
  }
  b.summary(`Shifted ${ids.length} segment${ids.length > 1 ? "s" : ""} by ${Math.hypot(offset[0], offset[1]).toFixed(1)} m; ${touched.size - ids.length} connecting streets re-attached; ${nodes.size} junctions rebuilt`);
  if (released > 5) b.summary(`${fmt.m2(released)} of former right-of-way released for reuse`);
  return b.finish(`Shift ${world.get<Street>(ids[0])?.name ?? "street"}`);
}

/** smooth a curve to a larger radius, cascading conflicts along the new alignment */
export function realignStreets(world: World, ids: string[], opts: { radius?: number; designSpeed?: number; policy?: ConflictPolicy }, actor: Actor): OpResult {
  const b = new OpBuilder(world, actor.author);
  let n = 0;
  for (const id of ids) {
    const s = b.get<Street>(id);
    if (!s) continue;
    const before = curvatureStats(s.path);
    const V = opts.designSpeed ?? s.speed ?? 40;
    const R = opts.radius ?? Math.round(minRadiusForSpeed(V));
    if (!(before.minRadius < R * 0.95)) {
      b.summary(`${s.name ?? id}: tightest curve already ${before.minRadius.toFixed(0)} m ≥ ${R} m design radius — unchanged`);
      continue;
    }
    const f = filletPath(s.path, R);
    const after = curvatureStats(f.path);
    const ns: Street = { ...s, path: f.path, createdBy: s.createdBy ?? b.tag, rowSource: "proposed" };
    b.update(ns);
    cascadeRow(b, s, ns, opts.policy ?? "trim");
    n++;
    const basis = opts.radius ? "requested" : `AASHTO minimum for ${V} km/h, e = 4%`;
    b.summary(`${s.name ?? id}: tightest curve ${before.minRadius.toFixed(0)} m → ${after.minRadius.toFixed(0)} m (design radius ${R} m, ${basis})`);
    if (after.minRadius < R * 0.9) b.warn(`${s.name ?? id}: only ${after.minRadius.toFixed(0)} m achievable within the existing alignment — the bend is too close to the junctions for a ${R} m curve; consider a lower speed limit or moving the junction`);
  }
  if (!n) b.summary("No curves needed realignment");
  return b.finish(`Realign ${world.get<Street>(ids[0])?.name ?? "street"}`);
}

export function setStreetAttributes(world: World, ids: string[], attrs: Partial<Pick<Street, "name" | "speed" | "cls" | "closed" | "serviceAccess">>, actor: Actor): OpResult {
  const b = new OpBuilder(world, actor.author);
  for (const id of ids) {
    const s = b.get<Street>(id);
    if (!s) continue;
    b.update<Street>({ ...s, ...attrs, createdBy: s.createdBy ?? b.tag });
  }
  const what = Object.entries(attrs)
    .map(([k, v]) => `${k} → ${v}`)
    .join(", ");
  b.summary(`${ids.length} segment${ids.length > 1 ? "s" : ""}: ${what}`);
  if (attrs.closed) b.warn("Closed to general traffic; the traffic model will reassign trips to parallel streets");
  return b.finish(attrs.closed ? `Close ${world.get<Street>(ids[0])?.name ?? "street"}` : `Update ${ids.length} street segment${ids.length > 1 ? "s" : ""}`);
}

export { union, unionMany, overlapArea, polyCentroid };
