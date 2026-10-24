// Emergency-access network optimiser. One vehicle graph holds the current
// network plus every candidate change as a disabled link or a per-node flag;
// a greedy search enables, at each step, the change that brings the most
// residents within the NFPA 1710 travel standard. Times follow the access
// model exactly (same graph rules, speeds, signal penalties and origin
// mapping), so the coverage it reports matches a full access run after the
// changes are committed.

import { pointInPoly } from "@/geometry/polygon";
import { closestOnPath, polyLength } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import { sectionWidth } from "@/geometry/crossSection";
import { buildNetwork } from "@/world/network";
import type { Entity, Street, StreetNode, Vec2 } from "@/world/types";
import type { World } from "@/world/world";
import { CONTRAFLOW_TIME_FACTOR, EM_TIME_FACTOR, PREEMPT_PENALTY_S, RESPONSE_STANDARD_MIN, SIGNAL_PENALTY_S, contraflowAllowed, emergencyStations, nearestNodeIndex, nodeGrid } from "./access";

export type EmChangeKind = "preempt" | "open" | "two_way" | "connector";

export interface EmCandidate {
  kind: EmChangeKind;
  label: string;
  /** preempt: signal node ids */
  nodes?: string[];
  /** open / two_way: street ids */
  streets?: string[];
  /** connector: straight fire lane between two existing nodes */
  from?: string;
  to?: string;
  path?: [Vec2, Vec2];
  /** connector: private parcels the lane would cross (needs an easement) */
  parcels?: number;
}

export interface EmPick extends EmCandidate {
  gain: number;
  coveredAfter: number;
}

export interface EmOptimizeResult {
  stations: number;
  residents: number;
  coveredBefore: number;
  coveredAfter: number;
  picks: EmPick[];
  candidates: Record<EmChangeKind, number>;
  evaluated: number;
  assumptions: string[];
}

/** IFC 503.2.1: fire apparatus access roads at least 20 ft (6.1 m) of unobstructed width */
export const FIRE_LANE_WIDTH = 6.1;
const CONNECT_MIN = 20,
  CONNECT_MAX = 120;

interface G {
  ids: string[];
  index: Map<string, number>;
  /** adjacency: link indices out of each node */
  out: number[][];
  lb: number[];
  lt: number[];
  /** 1 = in today's network; candidate links start at 0 */
  on: Uint8Array;
  /** which candidate enables a link (-1 = base) */
  owner: number[];
  signal: Uint8Array;
  evp: Uint8Array;
}

function graph(world: World): G {
  const ids: string[] = [];
  const index = new Map<string, number>();
  const signal: number[] = [],
    evp: number[] = [];
  const node = (id: string) => {
    let i = index.get(id);
    if (i === undefined) {
      const n = world.get<StreetNode>(id);
      if (!n) return -1;
      i = ids.length;
      ids.push(id);
      index.set(id, i);
      signal.push(n.control === "signal" ? 1 : 0);
      evp.push(n.control === "signal" && n.evp ? 1 : 0);
    }
    return i;
  };
  for (const n of world.all("node")) node(n.id);
  return { ids, index, out: ids.map(() => []), lb: [], lt: [], on: new Uint8Array(0), owner: [], signal: Uint8Array.from(signal), evp: Uint8Array.from(evp) };
}

function addLink(g: G, on: number[], a: number, b: number, t: number, owner: number) {
  g.out[a].push(g.lb.length);
  g.lb.push(b);
  g.lt.push(t);
  g.owner.push(owner);
  on.push(owner < 0 ? 1 : 0);
}

/** free-flow speed (m/s) the network model uses for a street */
const speedOf = (s: Street, opened = false) => (s.closed || opened || s.cls === "pedestrian" ? 3 : (s.speed / 3.6) * (s.cls === "motorway" ? 0.95 : 0.85));

/** travel time (s) with the same rule as the access model's emergency routing */
function times(g: G, sources: number[], cutoff: number, pred?: Int32Array): Float64Array {
  const n = g.ids.length;
  const d = new Float64Array(n).fill(Infinity);
  pred?.fill(-1);
  const hv: number[] = [],
    hc: number[] = [];
  const push = (v: number, c: number) => {
    hv.push(v);
    hc.push(c);
    let i = hv.length - 1;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (hc[q] <= hc[i]) break;
      [hv[q], hv[i]] = [hv[i], hv[q]];
      [hc[q], hc[i]] = [hc[i], hc[q]];
      i = q;
    }
  };
  for (const s of sources) if (s >= 0) (d[s] = 0), push(s, 0);
  while (hv.length) {
    const v = hv[0],
      c = hc[0];
    const lv = hv.pop()!,
      lc = hc.pop()!;
    if (hv.length) {
      hv[0] = lv;
      hc[0] = lc;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < hv.length && hc[l] < hc[m]) m = l;
        if (r < hv.length && hc[r] < hc[m]) m = r;
        if (m === i) break;
        [hv[m], hv[i]] = [hv[i], hv[m]];
        [hc[m], hc[i]] = [hc[i], hc[m]];
        i = m;
      }
    }
    if (c > d[v] || c > cutoff) continue;
    for (const li of g.out[v]) {
      if (!g.on[li]) continue;
      const b = g.lb[li];
      const nc = c + g.lt[li] * EM_TIME_FACTOR + (g.signal[b] ? (g.evp[b] ? PREEMPT_PENALTY_S : SIGNAL_PENALTY_S) : 0);
      if (nc < d[b]) {
        d[b] = nc;
        if (pred) pred[b] = v;
        push(b, nc);
      }
    }
  }
  return d;
}

export function optimizeEmergency(
  world: World,
  origins: { p: Vec2; w: number }[],
  opts: { maxChanges?: number; minGain?: number; allow?: EmChangeKind[]; bounds?: [number, number, number, number] } = {},
): EmOptimizeResult {
  const ents = [...world.entities.values()] as Entity[];
  const stations = emergencyStations(ents);
  const allow = new Set<EmChangeKind>(opts.allow ?? ["preempt", "open", "two_way", "connector"]);
  const g = graph(world);
  const on: number[] = [];
  const cands: EmCandidate[] = [];
  const streets = world.all("street");
  // ---- today's service network (same rules as buildNetwork(..., "service"))
  const inService = (s: Street) => (s.cls === "pedestrian" || s.closed ? !!s.serviceAccess : true);
  for (const s of streets) {
    const a = g.index.get(s.from)!,
      b = g.index.get(s.to)!;
    if (a === undefined || b === undefined) continue;
    const t = Math.max(1, polyLength(s.path)) / speedOf(s);
    if (inService(s)) {
      addLink(g, on, a, b, t, -1);
      if (!s.oneway) addLink(g, on, b, a, t, -1);
      else if (contraflowAllowed(s.cls)) addLink(g, on, b, a, t * CONTRAFLOW_TIME_FACTOR, -1);
    }
  }
  // origins map to the walk network's nearest node, exactly as the access model does
  const walk = buildNetwork(ents, "walk");
  const wn = walk.nodes.map((n) => n.p);
  const wg = nodeGrid(wn);
  const oNode = origins.map((o) => {
    const k = nearestNodeIndex(wn, wg, o.p);
    return k >= 0 ? (g.index.get(walk.nodes[k].id) ?? -1) : -1;
  });
  // stations snap to the nearest node of today's vehicle network, as in the access model
  const touched = new Set<number>();
  g.out.forEach((ls, a) => ls.forEach((li) => on[li] && (touched.add(a), touched.add(g.lb[li]))));
  const vIdx = [...touched].sort((a, b) => a - b);
  const vPts = vIdx.map((i) => world.get<StreetNode>(g.ids[i])!.p);
  const vGrid = nodeGrid(vPts);
  const sources = stations.map((st) => {
    const k = nearestNodeIndex(vPts, vGrid, st.p);
    return k >= 0 ? vIdx[k] : -1;
  });
  // ---- candidates
  // 1. signal preemption on each station's first-due routes into the 3–6 minute ring (where seconds matter)
  g.on = Uint8Array.from(on);
  const cutoff = RESPONSE_STANDARD_MIN * 60;
  if (allow.has("preempt")) {
    const all = times(g, sources, cutoff * 1.5);
    const pred = new Int32Array(g.ids.length);
    stations.forEach((st, k) => {
      if (sources[k] < 0) return;
      const d = times(g, [sources[k]], cutoff * 1.5, pred);
      const sig = new Set<number>();
      const seen = new Set<number>();
      oNode.forEach((v) => {
        if (v < 0 || seen.has(v) || !(d[v] > cutoff * 0.75 && d[v] <= cutoff * 1.5) || d[v] > all[v] + 1e-6) return;
        seen.add(v);
        for (let u = v; u >= 0; u = pred[u]) if (g.signal[u] && !g.evp[u]) sig.add(u);
      });
      if (sig.size) cands.push({ kind: "preempt", label: `Signal preemption (EVP) at ${sig.size} signals on ${st.name}'s first-due routes to areas 3–6 min out`, nodes: [...sig].map((i) => g.ids[i]) });
    });
  }
  // 2. car-free streets wide enough for fire apparatus, opened to emergency vehicles only (removable bollards)
  if (allow.has("open"))
    for (const s of streets) {
      if (inService(s) || s.cls === "motorway" || sectionWidth(s.section) < FIRE_LANE_WIDTH) continue;
      const a = g.index.get(s.from),
        b = g.index.get(s.to);
      if (a === undefined || b === undefined) continue;
      const ci = cands.length;
      const t = Math.max(1, polyLength(s.path)) / speedOf(s, true);
      addLink(g, on, a, b, t, ci);
      addLink(g, on, b, a, t, ci);
      cands.push({ kind: "open", label: `Emergency access through ${s.name ?? `${s.cls} street ${s.id}`} (${sectionWidth(s.section).toFixed(1)} m wide; removable bollards)`, streets: [s.id] });
    }
  // 3. two-way conversion of one-way corridors (by street name, every one-way segment of it)
  if (allow.has("two_way")) {
    const byName = new Map<string, Street[]>();
    for (const s of streets) if (s.oneway && s.name && !/motorway|trunk/.test(s.cls) && inService(s) && !/interstate|frontage|service road|ramp/i.test(s.name)) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    for (const [name, segs] of byName) {
      const ci = cands.length;
      let n = 0;
      for (const s of segs) {
        const a = g.index.get(s.from),
          b = g.index.get(s.to);
        if (a === undefined || b === undefined) continue;
        addLink(g, on, b, a, Math.max(1, polyLength(s.path)) / speedOf(s), ci);
        n++;
      }
      if (n) cands.push({ kind: "two_way", label: `Two-way conversion of ${name} (${n} one-way segment${n > 1 ? "s" : ""})`, streets: segs.map((s) => s.id) });
    }
  }
  // 4. fire lanes from dead ends to the nearest node of another street, avoiding buildings, water and other streets
  if (allow.has("connector")) {
    const [bx0, by0, bx1, by1] = opts.bounds ?? [-Infinity, -Infinity, Infinity, Infinity];
    const blockedAt = (p: Vec2) =>
      world.query([p[0] - 1, p[1] - 1, p[0] + 1, p[1] + 1], ["building", "area"]).some((e) => (e.kind === "building" ? pointInPoly(p, e.footprint) : e.kind === "area" && e.type === "water" && pointInPoly(p, e.poly)));
    for (const n of world.all("node")) {
      const inc = world.incident(n.id).filter(inService);
      // public dead ends only: private driveways and parking aisles are not part of the street network
      if (inc.length !== 1 || world.incident(n.id).length !== 1 || inc[0].private) continue;
      // dead ends at the study-area edge are clip artefacts, not cul-de-sacs
      if (n.p[0] - bx0 < 150 || bx1 - n.p[0] < 150 || n.p[1] - by0 < 150 || by1 - n.p[1] < 150) continue;
      const own = inc[0];
      let best: { m: StreetNode; d: number } | null = null;
      for (const e of world.query([n.p[0] - CONNECT_MAX, n.p[1] - CONNECT_MAX, n.p[0] + CONNECT_MAX, n.p[1] + CONNECT_MAX], ["node"])) {
        const m = e as StreetNode;
        if (m.id === n.id || m.id === own.from || m.id === own.to) continue;
        const minc = world.incident(m.id).filter(inService);
        if (!minc.length || minc.some((s) => s.id === own.id || s.cls === "motorway" || s.cls === "motorway_link" || s.bridge || s.tunnel)) continue;
        const d = dist(n.p, m.p);
        if (d < CONNECT_MIN || d > CONNECT_MAX || (best && d >= best.d)) continue;
        // clear corridor: lane centre and both edges free of buildings / water, no other street crossed
        const ux = (m.p[0] - n.p[0]) / d,
          uy = (m.p[1] - n.p[1]) / d;
        let ok = true;
        for (let t = 4; t <= d - 4 && ok; t += 3)
          for (const off of [-FIRE_LANE_WIDTH / 2, 0, FIRE_LANE_WIDTH / 2]) {
            const p: Vec2 = [n.p[0] + ux * t - uy * off, n.p[1] + uy * t + ux * off];
            if (blockedAt(p)) {
              ok = false;
              break;
            }
          }
        if (!ok) continue;
        for (let t = 8; t <= d - 8 && ok; t += 4) {
          const p: Vec2 = [n.p[0] + ux * t, n.p[1] + uy * t];
          for (const e of world.query([p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4], ["street"])) if (closestOnPath(p, (e as Street).path).d < 4) ok = false;
        }
        if (ok) best = { m, d };
      }
      if (!best) continue;
      const a = g.index.get(n.id)!,
        b = g.index.get(best.m.id)!;
      const ci = cands.length;
      const t = best.d / 3;
      addLink(g, on, a, b, t, ci);
      addLink(g, on, b, a, t, ci);
      const mid: Vec2 = [(n.p[0] + best.m.p[0]) / 2, (n.p[1] + best.m.p[1]) / 2];
      const parcels = world.query([mid[0] - 1, mid[1] - 1, mid[0] + 1, mid[1] + 1], ["parcel"]).filter((e) => e.kind === "parcel" && e.landUse !== "row" && pointInPoly(mid, e.poly)).length;
      const other = world.incident(best.m.id).find((s) => s.name)?.name ?? "the next street";
      cands.push({ kind: "connector", label: `Fire lane (${FIRE_LANE_WIDTH} m, bollard-controlled, ${Math.round(best.d)} m) from the dead end of ${own.name ?? (own.cls === "service" ? "an alley" : `a ${own.cls} street`)} to ${other}`, from: n.id, to: best.m.id, path: [n.p, best.m.p], parcels });
    }
  }
  g.on = Uint8Array.from(on);
  // ---- greedy
  const totalW = origins.reduce((s, o) => s + o.w, 0);
  const covered = () => {
    const d = times(g, sources, cutoff);
    let c = 0;
    oNode.forEach((k, i) => {
      if (k >= 0 && d[k] <= cutoff) c += origins[i].w;
    });
    return c;
  };
  const linksOf = new Map<number, number[]>();
  g.owner.forEach((o, li) => o >= 0 && linksOf.set(o, [...(linksOf.get(o) ?? []), li]));
  const setCand = (ci: number, v: 0 | 1) => {
    const c = cands[ci];
    for (const li of linksOf.get(ci) ?? []) g.on[li] = v;
    if (c.kind === "preempt") for (const id of c.nodes!) g.evp[g.index.get(id)!] = v;
  };
  // preemption flags already fitted stay on; candidate flags are toggled
  const fitted = Uint8Array.from(g.evp);
  const before = covered();
  let cur = before;
  const picks: EmPick[] = [];
  const used = new Set<number>();
  let evaluated = 0;
  const maxChanges = opts.maxChanges ?? 5,
    minGain = opts.minGain ?? 25;
  // tie-break toward lighter interventions
  const weight: Record<EmChangeKind, number> = { preempt: 1, open: 1.05, connector: 1.15, two_way: 1.3 };
  for (let step = 0; step < maxChanges; step++) {
    let best = -1,
      bestGain = 0,
      bestScore = 0;
    for (let ci = 0; ci < cands.length; ci++) {
      if (used.has(ci)) continue;
      setCand(ci, 1);
      const c = covered();
      if (cands[ci].kind === "preempt") for (const id of cands[ci].nodes!) g.evp[g.index.get(id)!] = fitted[g.index.get(id)!];
      else setCand(ci, 0);
      evaluated++;
      const gain = c - cur;
      const score = gain / weight[cands[ci].kind];
      if (gain >= minGain && score > bestScore) (best = ci), (bestGain = gain), (bestScore = score);
    }
    if (best < 0) break;
    setCand(best, 1);
    if (cands[best].kind === "preempt") for (const id of cands[best].nodes!) fitted[g.index.get(id)!] = 1;
    used.add(best);
    cur += bestGain;
    picks.push({ ...cands[best], gain: Math.round(bestGain), coveredAfter: Math.round(cur) });
  }
  const count = (k: EmChangeKind) => cands.filter((c) => c.kind === k).length;
  return {
    stations: stations.length,
    residents: Math.round(totalW),
    coveredBefore: Math.round(before),
    coveredAfter: Math.round(cur),
    picks,
    candidates: { preempt: count("preempt"), open: count("open"), two_way: count("two_way"), connector: count("connector") },
    evaluated,
    assumptions: [
      `Greedy search: each step enables the candidate that brings the most residents within the ${RESPONSE_STANDARD_MIN}-min NFPA 1710 travel standard (≥ ${minGain} residents to count); interactions are re-evaluated every step, but the set is not proven optimal.`,
      `Signal preemption cuts the per-signal penalty from ${SIGNAL_PENALTY_S} s to ${PREEMPT_PENALTY_S} s (published before/after studies report 14–23 % shorter responses on equipped corridors).`,
      `Car-free streets open to emergency vehicles only where they are at least ${FIRE_LANE_WIDTH} m wide (IFC 503.2.1), at the model's closed-street speed (3 m/s).`,
      `Fire lanes are straight ${FIRE_LANE_WIDTH} m bollard-controlled links of ${CONNECT_MIN}–${CONNECT_MAX} m from a dead end to the nearest node of another street, clear of buildings, water and other streets; lanes crossing private parcels need an easement. Dead ends within 150 m of the study-area edge are skipped (clip artefacts).`,
      "Two-way conversion is evaluated for emergency access only; its effect on general traffic needs a traffic run.",
    ],
  };
}
