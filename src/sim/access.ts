// Walking accessibility on the street + path network: multi-source shortest
// paths from each destination category, 15-minute neighbourhood score,
// transit-stop coverage, and population reachable from candidate sites.

import { buildNetwork, type Network } from "@/world/network";
import type { Entity, Poi, TransitRoute, TransitStop, Vec2 } from "@/world/types";
import { polyCentroid } from "@/geometry/polygon";
import { dist } from "@/geometry/vec";
import { programmeOf } from "@/world/ops/core";

export interface AccessInput {
  net: Network;
  /** origin points with weights (residents) */
  origins: { id: string; p: Vec2; w: number; node: number }[];
  dests: Record<string, Vec2[]>;
  /** emergency response: fire / EMS stations routed over the vehicle network */
  emergency?: { net: Network; sources: number[]; stations: { name: string; p: Vec2 }[] };
}

export interface AccessResult {
  /** per-category walking minutes for each origin (same order as origins) */
  minutes: Record<string, Float32Array>;
  /** count of categories within 15 min per origin */
  score15: Uint8Array;
  coverage: Record<string, number>;
  medianMinutes: Record<string, number>;
  /** node walking minutes to nearest destination per category (for maps) */
  nodeMinutes: Record<string, Float32Array>;
  nodes: Vec2[];
  assumptions: string[];
}

const WALK = 1.3; // m/s

export function nearestNodeIndex(nodes: Vec2[], grid: Map<string, number[]>, p: Vec2, cell = 150): number {
  let best = -1,
    bd = Infinity;
  const ix = Math.floor(p[0] / cell),
    iy = Math.floor(p[1] / cell);
  for (let r = 0; r <= 3 && best < 0; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        const l = grid.get(`${ix + dx},${iy + dy}`);
        if (!l) continue;
        for (const i of l) {
          const d = dist(nodes[i], p);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
  return best;
}

export function nodeGrid(nodes: Vec2[], cell = 150) {
  const g = new Map<string, number[]>();
  nodes.forEach((p, i) => {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k)!.push(i);
  });
  return g;
}

/** multi-source Dijkstra (metres) */
export function multiSource(net: Network, sources: number[], maxDist = 3000): Float64Array {
  const n = net.nodes.length;
  const d = new Float64Array(n).fill(Infinity);
  const heap: [number, number][] = [];
  const push = (v: number, c: number) => {
    heap.push([c, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const s of sources) {
    if (s < 0) continue;
    d[s] = 0;
    push(s, 0);
  }
  while (heap.length) {
    const [c, v] = pop();
    if (c > d[v] || c > maxDist) continue;
    for (const li of net.out[v]) {
      const l = net.links[li];
      const nc = c + l.length;
      if (nc < d[l.b]) {
        d[l.b] = nc;
        push(l.b, nc);
      }
    }
  }
  return d;
}

export function prepareAccess(entities: Iterable<Entity>, origins: { id: string; p: Vec2; w: number }[]): AccessInput {
  const ents = [...entities];
  const net = buildNetwork(ents, "walk");
  const nodes = net.nodes.map((n) => n.p);
  const g = nodeGrid(nodes);
  const dests: Record<string, Vec2[]> = { grocery: [], school: [], park: [], transit: [], frequent_transit: [], food: [], health: [] };
  const routes = new Map((ents.filter((e) => e.kind === "route") as TransitRoute[]).map((r) => [r.id, r]));
  for (const e of ents) {
    if (e.kind === "poi") {
      const p = e as Poi;
      if (p.category === "grocery") dests.grocery.push(p.p);
      else if (p.category === "school") dests.school.push(p.p);
      else if (p.category === "food") dests.food.push(p.p);
      else if (p.category === "health") dests.health.push(p.p);
    } else if (e.kind === "building" && e.createdBy && ((e.program.retail ?? 0) > 0 || (e.program.education ?? 0) > 0 || (e.program.health ?? 0) > 0)) {
      // proposed ground-floor retail becomes a local destination; supermarket-sized space counts as grocery;
      // proposed school and clinic floor space becomes a school / health destination
      const gfa = programmeOf(e).gfa;
      const retail = gfa * (e.program.retail ?? 0);
      const c = polyCentroid(e.footprint);
      if (retail >= 150) dests.food.push(c);
      if (retail >= 1500) dests.grocery.push(c);
      if (gfa * (e.program.education ?? 0) >= 1000) dests.school.push(c);
      if (gfa * (e.program.health ?? 0) >= 300) dests.health.push(c);
    } else if (e.kind === "area" && (e.type === "park" || e.type === "plaza")) {
      // park access points: polygon vertices thinned
      const r = e.poly[0];
      const step = Math.max(1, Math.floor(r.length / 8));
      for (let i = 0; i < r.length; i += step) dests.park.push(r[i]);
    } else if (e.kind === "stop") {
      const s = e as TransitStop;
      dests.transit.push(s.p);
      if (s.mode === "rail" || s.mode === "tram" || s.routes.some((id) => (routes.get(id)?.headway ?? 99) <= 15)) dests.frequent_transit.push(s.p);
    }
  }
  // fire & EMS stations (OSM-named) over the service network: closed streets are passable only with service access
  const stations = emergencyStations(ents);
  let emergency: AccessInput["emergency"];
  if (stations.length) {
    const enet = withContraflow(buildNetwork(ents, "service"));
    const en = enet.nodes.map((n) => n.p);
    const eg = nodeGrid(en);
    emergency = { net: enet, sources: stations.map((s) => nearestNodeIndex(en, eg, s.p)), stations };
  }
  return { net, origins: origins.map((o) => ({ ...o, node: nearestNodeIndex(nodes, g, o.p) })), dests, emergency };
}

/** NFPA 1710 first-engine travel-time standard */
export const RESPONSE_STANDARD_MIN = 4;
/** emergency vehicles run at this share of free-flow time (lights and sirens) */
export const EM_TIME_FACTOR = 0.85;
/** seconds lost entering a signalised junction; with preemption (EVP) the signal turns green ahead of the vehicle */
export const SIGNAL_PENALTY_S = 6;
export const PREEMPT_PENALTY_S = 1;

/**
 * Texas Transportation Code §546.001(4): an emergency vehicle may disregard the direction of
 * movement. Against one-way traffic it is modelled at half speed, never on motorways or trunk roads.
 */
export const CONTRAFLOW_TIME_FACTOR = 2;
export const contraflowAllowed = (cls: string) => !/^(motorway|motorway_link|trunk|trunk_link)$/.test(cls);

function withContraflow(net: Network): Network {
  const has = new Set(net.links.map((l) => `${l.streetId}|${l.a}|${l.b}`));
  for (const l of [...net.links]) {
    if (!contraflowAllowed(l.cls) || has.has(`${l.streetId}|${l.b}|${l.a}`)) continue;
    const r = { ...l, i: net.links.length, from: l.to, to: l.from, a: l.b, b: l.a, t0: l.t0 * CONTRAFLOW_TIME_FACTOR };
    net.links.push(r);
    net.out[r.a].push(r.i);
  }
  return net;
}

export function emergencyStations(ents: Entity[]): { name: string; p: Vec2 }[] {
  const named = /fire station|ems station|fire department/i;
  const out = (ents.filter((e) => (e.kind === "poi" || e.kind === "place") && named.test((e as Poi).name ?? "")) as Poi[]).map((e) => ({ name: e.name ?? "station", p: e.p }));
  // a building named as a station (e.g. one drawn on the blank canvas) is a station too
  for (const e of ents) if (e.kind === "building" && named.test(e.name ?? "")) out.push({ name: e.name!, p: polyCentroid(e.footprint) });
  return out;
}

/** free-flow vehicle travel minutes from the nearest station, per walk-network node and per origin */
function emergencyMinutes(inp: AccessInput): { node: Float32Array; origin: Float32Array } | null {
  const E = inp.emergency;
  if (!E) return null;
  const n = E.net.nodes.length;
  const d = new Float64Array(n).fill(Infinity);
  // Dijkstra on free-flow time (s)
  const heap: [number, number][] = [];
  const push = (v: number, c: number) => {
    heap.push([c, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (heap[q][0] <= heap[i][0]) break;
      [heap[q], heap[i]] = [heap[i], heap[q]];
      i = q;
    }
  };
  for (const s of E.sources) if (s >= 0) (d[s] = 0), push(s, 0);
  while (heap.length) {
    const [c, v] = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    if (c > d[v]) continue;
    for (const li of E.net.out[v]) {
      const L = E.net.links[li];
      // emergency vehicles run near free-flow speed; a penalty through signals unless preempted
      const nb = E.net.nodes[L.b];
      const nc = c + L.t0 * EM_TIME_FACTOR + (nb.control === "signal" ? (nb.evp ? PREEMPT_PENALTY_S : SIGNAL_PENALTY_S) : 0);
      if (nc < d[L.b]) (d[L.b] = nc), push(L.b, nc);
    }
  }
  const walkNodes = inp.net.nodes;
  const node = new Float32Array(walkNodes.length);
  walkNodes.forEach((wn, i) => {
    const j = E.net.nodeIndex.get(wn.id);
    node[i] = j === undefined ? Infinity : d[j] / 60;
  });
  const origin = new Float32Array(inp.origins.length);
  inp.origins.forEach((o, i) => {
    // last 30 m on foot from the kerb is part of turnout, not travel
    origin[i] = o.node >= 0 ? node[o.node] : Infinity;
  });
  return { node, origin };
}

export function runAccess(inp: AccessInput): AccessResult {
  const nodes = inp.net.nodes.map((n) => n.p);
  const g = nodeGrid(nodes);
  const minutes: Record<string, Float32Array> = {};
  const nodeMinutes: Record<string, Float32Array> = {};
  const coverage: Record<string, number> = {};
  const medianMinutes: Record<string, number> = {};
  const score15 = new Uint8Array(inp.origins.length);
  const totalW = inp.origins.reduce((s, o) => s + o.w, 0) || 1;
  for (const [cat, pts] of Object.entries(inp.dests)) {
    const src = pts.map((p) => nearestNodeIndex(nodes, g, p));
    const d = multiSource(inp.net, src, 4000);
    const nm = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) nm[i] = d[i] / WALK / 60;
    nodeMinutes[cat] = nm;
    const m = new Float32Array(inp.origins.length);
    let covered = 0;
    inp.origins.forEach((o, i) => {
      const v = o.node >= 0 ? (d[o.node] + dist(nodes[o.node], o.p)) / WALK / 60 : Infinity;
      m[i] = v;
      if (v <= 15 && cat !== "transit" && cat !== "frequent_transit") score15[i]++;
      const thr = cat === "transit" ? 400 / WALK / 60 : cat === "frequent_transit" ? 800 / WALK / 60 : 15;
      if (v <= thr) covered += o.w;
    });
    minutes[cat] = m;
    coverage[cat] = covered / totalW;
    const sorted = Array.from(m).filter(Number.isFinite).sort((a, b) => a - b);
    medianMinutes[cat] = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
  }
  const em = emergencyMinutes(inp);
  if (em) {
    minutes.emergency = em.origin;
    nodeMinutes.emergency = em.node;
    let covered = 0;
    inp.origins.forEach((o, i) => {
      if (em.origin[i] <= RESPONSE_STANDARD_MIN) covered += o.w;
    });
    coverage.emergency = covered / totalW;
    const sorted = Array.from(em.origin).filter(Number.isFinite).sort((a, b) => a - b);
    medianMinutes.emergency = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
  }
  return {
    minutes,
    score15,
    coverage,
    medianMinutes,
    nodeMinutes,
    nodes,
    assumptions: [
      "Walk network: all non-motorway street segments (both directions) at 1.3 m/s; off-street paths not yet joined to the network",
      "Coverage thresholds: any stop ≤ 400 m, frequent transit (≤15-min headway, rail, tram, BRT) ≤ 800 m, other amenities ≤ 15 min",
      "Destinations: OSM points of interest; park access at polygon edges; proposed ground-floor retail counts as a food/convenience destination (≥ 150 m²) and as a grocery when supermarket-sized (≥ 1,500 m²); proposed education space ≥ 1,000 m² counts as a school and health space ≥ 300 m² as a clinic",
      "Residents weighted by Census-anchored housing units × household size",
      ...(inp.emergency
        ? [`Emergency response: ${inp.emergency.stations.length} fire/EMS stations (OSM names) routed over the vehicle network at 85% of free-flow time + 6 s per signal (1 s where signal preemption is fitted), against one-way traffic at half speed (Texas Transportation Code §546.001; not on motorways), closed and pedestrian streets passable only with service access; coverage = residents within the NFPA 1710 ${RESPONSE_STANDARD_MIN}-min first-engine travel standard (turnout time excluded)`]
        : []),
    ],
  };
}

/** residents reachable within `maxMin` walking minutes of each candidate point */
export function reachable(inp: AccessInput, candidates: Vec2[], maxMin = 10): number[] {
  const nodes = inp.net.nodes.map((n) => n.p);
  const g = nodeGrid(nodes);
  const byNode = new Map<number, number>();
  for (const o of inp.origins) byNode.set(o.node, (byNode.get(o.node) ?? 0) + o.w);
  return candidates.map((c) => {
    const d = multiSource(inp.net, [nearestNodeIndex(nodes, g, c)], maxMin * 60 * WALK);
    let s = 0;
    for (const [nd, w] of byNode) if (d[nd] <= maxMin * 60 * WALK) s += w;
    return s;
  });
}
