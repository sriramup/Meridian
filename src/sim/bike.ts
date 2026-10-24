// Bicycle Level of Traffic Stress (Mekuria, Furth & Nixon 2012; Furth 2017 update)
// and low-stress connectivity. LTS 1 = suitable for children, 2 = most adults
// ("interested but concerned"), 3 = enthused and confident, 4 = strong and fearless.
// Segment stress comes from the bike facility, lanes per direction and speed;
// junction stress from crossing a busy street without a signal.

import { countType, laneCount } from "@/geometry/crossSection";
import { polyLength } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import type { Entity, Poi, Street, StreetNode, Vec2 } from "@/world/types";

export type LTS = 1 | 2 | 3 | 4;

const MPH = 1.609;

/** stress of riding along a street segment (null = bicycles not permitted) */
export function segmentLTS(s: Street): LTS | null {
  if (s.cls === "motorway" || s.cls === "motorway_link" || s.tunnel) return null;
  if (s.cls === "pedestrian" || s.cls === "living" || (s.closed && s.serviceAccess)) return 1;
  if (s.closed) return 1;
  const strips = s.section.strips;
  if (strips.some((x) => x.type === "cycletrack")) return 1;
  const v = s.speed ?? 40;
  const lanesPerDir = Math.max(laneCount(s.section, 1), laneCount(s.section, -1), s.oneway ? laneCount(s.section) : 0) || 1;
  const parking = countType(s.section, "parking") > 0;
  if (strips.some((x) => x.type === "bike")) {
    // painted lane (Furth 2017, Table 2)
    if (lanesPerDir >= 3 || v > 40 * MPH) return 4;
    if (lanesPerDir === 2 || v > 30 * MPH) return 3;
    if (v > 25 * MPH && parking) return 3;
    return 2;
  }
  // mixed traffic (Table 1): unmarked residential streets are calm, arterials are not
  if (s.cls === "service") return lanesPerDir > 1 ? 3 : 2;
  if (lanesPerDir >= 3) return 4;
  if (lanesPerDir === 2) return v <= 25 * MPH ? 3 : 4;
  if (s.cls === "residential") return v <= 25 * MPH ? 1 : v <= 30 * MPH ? 2 : 3;
  if (v <= 25 * MPH) return 2;
  return v <= 30 * MPH ? 3 : 4;
}

/** stress of crossing street s at an unsignalised junction */
export function crossingLTS(s: Street): LTS {
  // every lane a rider must cross counts (through, turn, bus, tram); a refuge median halves the crossing
  const lanes = s.section.strips.filter((x) => x.type === "travel" || x.type === "turn" || x.type === "bus" || x.type === "tram").length;
  const total = Math.max(1, lanes) - (s.section.strips.some((x) => x.type === "median") ? 1 : 0);
  const v = s.speed ?? 40;
  if (s.cls === "pedestrian" || s.cls === "living" || s.closed) return 1;
  if (total >= 5 || v > 35 * MPH) return 4;
  if (total >= 3 || v > 30 * MPH) return 3;
  if (total === 2 && v > 25 * MPH) return 2;
  return 1;
}

export interface BikeLink {
  a: number;
  b: number;
  streetId: string;
  name?: string;
  length: number;
  /** max of segment stress and the stress of the junction it enters */
  lts: LTS;
  seg: LTS;
}

export interface BikeNet {
  nodes: Vec2[];
  nodeIds: string[];
  index: Map<string, number>;
  links: BikeLink[];
  out: number[][];
}

/** directed bike graph with stress per link (one-way streets are rideable both ways only with a contraflow / two-way track) */
export function buildBikeNet(entities: Iterable<Entity>): BikeNet {
  const streets: Street[] = [];
  const nodes = new Map<string, StreetNode>();
  for (const e of entities) {
    if (e.kind === "street") streets.push(e);
    else if (e.kind === "node") nodes.set(e.id, e);
  }
  const incident = new Map<string, Street[]>();
  for (const s of streets)
    for (const n of [s.from, s.to]) {
      if (!incident.has(n)) incident.set(n, []);
      incident.get(n)!.push(s);
    }
  const net: BikeNet = { nodes: [], nodeIds: [], index: new Map(), links: [], out: [] };
  const idx = (id: string) => {
    let i = net.index.get(id);
    if (i === undefined) {
      const n = nodes.get(id);
      if (!n) return -1;
      i = net.nodes.length;
      net.nodes.push(n.p);
      net.nodeIds.push(id);
      net.index.set(id, i);
      net.out.push([]);
    }
    return i;
  };
  // junction stress when arriving along street s
  const nodeStress = (nid: string, s: Street): LTS => {
    const n = nodes.get(nid);
    if (!n) return 1;
    if (n.control === "signal") return 1;
    const others = (incident.get(nid) ?? []).filter((o) => o.id !== s.id && (o.name ?? o.id) !== (s.name ?? s.id) && segmentLTS(o) !== null);
    if (!others.length) return 1;
    if (n.control === "roundabout" || n.roundabout) return (n.roundabout?.lanes ?? 1) > 1 ? 3 : 2;
    return Math.max(...others.map(crossingLTS)) as LTS;
  };
  for (const s of streets) {
    const seg = segmentLTS(s);
    if (seg === null) continue;
    const a = idx(s.from),
      b = idx(s.to);
    if (a < 0 || b < 0) continue;
    const L = Math.max(1, polyLength(s.path));
    const twoWayBike = !s.oneway || s.section.strips.some((x) => x.type === "cycletrack" && x.dir === 0) || s.cls === "pedestrian" || s.cls === "living";
    const add = (from: number, to: number, toId: string) => {
      const lts = Math.max(seg, nodeStress(toId, s)) as LTS;
      net.out[from].push(net.links.length);
      net.links.push({ a: from, b: to, streetId: s.id, name: s.name, length: L, lts, seg });
    };
    add(a, b, s.to);
    if (twoWayBike) add(b, a, s.from);
  }
  return net;
}

/** multi-source shortest distance (m) over links with stress ≤ maxLts */
export function bikeDistances(net: BikeNet, sources: number[], maxLts: LTS, maxDist: number): Float64Array {
  const n = net.nodes.length;
  const d = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap();
  for (const s of sources) if (s >= 0 && d[s] > 0) (d[s] = 0), heap.push(0, s);
  while (heap.size) {
    const [c, v] = heap.pop();
    if (c > d[v] || c > maxDist) continue;
    for (const li of net.out[v]) {
      const L = net.links[li];
      if (L.lts > maxLts) continue;
      const nc = c + L.length;
      if (nc < d[L.b]) (d[L.b] = nc), heap.push(nc, L.b);
    }
  }
  return d;
}

/** binary min-heap of [cost, node] */
class MinHeap {
  private c: number[] = [];
  private v: number[] = [];
  get size() {
    return this.c.length;
  }
  push(cost: number, node: number) {
    const c = this.c,
      v = this.v;
    let i = c.length;
    c.push(cost);
    v.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p] <= cost) break;
      c[i] = c[p];
      v[i] = v[p];
      i = p;
    }
    c[i] = cost;
    v[i] = node;
  }
  pop(): [number, number] {
    const c = this.c,
      v = this.v;
    const top: [number, number] = [c[0], v[0]];
    const lc = c.pop()!,
      lv = v.pop()!;
    if (c.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = -1;
        let mc = lc;
        if (l < c.length && c[l] < mc) (m = l), (mc = c[l]);
        if (r < c.length && c[r] < mc) m = r;
        if (m < 0) break;
        c[i] = c[m];
        v[i] = v[m];
        i = m;
      }
      c[i] = lc;
      v[i] = lv;
    }
    return top;
  }
}

/** least-cost bike route between two points; returns the links in order */
export function bikeRoute(net: BikeNet, from: Vec2, to: Vec2, cost: (l: BikeLink) => number): BikeLink[] | null {
  const s = nearest(net, from),
    t = nearest(net, to);
  if (s < 0 || t < 0) return null;
  const n = net.nodes.length;
  const d = new Float64Array(n).fill(Infinity);
  const pred = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  heap.push(0, s);
  d[s] = 0;
  while (heap.size) {
    const [c, v] = heap.pop();
    if (c > d[v]) continue;
    if (v === t) break;
    for (const li of net.out[v]) {
      const L = net.links[li];
      const nc = c + cost(L);
      if (nc < d[L.b]) {
        d[L.b] = nc;
        pred[L.b] = li;
        heap.push(nc, L.b);
      }
    }
  }
  if (!Number.isFinite(d[t])) return null;
  const out: BikeLink[] = [];
  for (let v = t, g = 0; pred[v] >= 0 && g < 100000; g++) {
    out.push(net.links[pred[v]]);
    v = net.links[pred[v]].a;
  }
  return out.reverse();
}

function nearest(net: BikeNet, p: Vec2): number {
  let best = -1,
    bd = Infinity;
  for (let i = 0; i < net.nodes.length; i++) {
    if (!net.out[i].length) continue;
    const d = dist(net.nodes[i], p);
    if (d < bd) (bd = d), (best = i);
  }
  return best;
}

export interface BikeResult {
  /** per street id: worst directional stress (for the map) */
  streetLts: Record<string, LTS>;
  kmByLts: Record<LTS, number>;
  /** residents who can reach each destination within 15 min (4 km) on low-stress (≤ LTS 2) routes, vs any route */
  coverage: Record<string, { lowStress: number; any: number }>;
  /** connected low-stress islands (undirected, LTS ≤ 2), largest first */
  islands: { residents: number; km: number; at: Vec2 }[];
  /** high-stress links whose upgrade would join two low-stress islands, ranked by residents connected */
  criticalLinks: { streetId: string; name?: string; lts: LTS; joins: number; at: Vec2 }[];
  assumptions: string[];
}

const RIDE = 4000; // 15 min at 4.5 m/s

export function runBike(entities: Entity[], origins: { p: Vec2; w: number }[]): BikeResult {
  const net = buildBikeNet(entities);
  const streetLts: Record<string, LTS> = {};
  const kmByLts: Record<LTS, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const len = new Map<string, number>();
  for (const l of net.links) {
    streetLts[l.streetId] = Math.max(streetLts[l.streetId] ?? 1, l.seg) as LTS;
    len.set(l.streetId, l.length);
  }
  for (const [id, L] of len) kmByLts[streetLts[id]] += L / 1000;
  const originNode = origins.map((o) => ({ ...o, n: nearest(net, o.p) }));
  const totalW = originNode.reduce((a, o) => a + o.w, 0) || 1;
  // destinations
  const dests: Record<string, Vec2[]> = { grocery: [], school: [], park: [], transit: [] };
  for (const e of entities) {
    if (e.kind === "poi" && ((e as Poi).category === "grocery" || (e as Poi).category === "school")) dests[(e as Poi).category].push(e.p);
    else if (e.kind === "area" && (e.type === "park" || e.type === "plaza")) dests.park.push(e.poly[0][0]);
    else if (e.kind === "stop") dests.transit.push(e.p);
  }
  const coverage: BikeResult["coverage"] = {};
  for (const [cat, pts] of Object.entries(dests)) {
    if (!pts.length) continue;
    const src = pts.map((p) => nearest(net, p));
    // reverse reachability is symmetric enough for a coverage screen on a mostly two-way network
    const low = bikeDistances(net, src, 2, RIDE),
      any = bikeDistances(net, src, 4, RIDE);
    let wl = 0,
      wa = 0;
    for (const o of originNode) {
      if (o.n < 0) continue;
      if (low[o.n] <= RIDE) wl += o.w;
      if (any[o.n] <= RIDE) wa += o.w;
    }
    coverage[cat] = { lowStress: wl / totalW, any: wa / totalW };
  }
  // low-stress islands (undirected union-find over LTS ≤ 2 links)
  const parent = net.nodes.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const l of net.links) if (l.lts <= 2) parent[find(l.a)] = find(l.b);
  const comp = new Map<number, { residents: number; km: number; at: Vec2 }>();
  for (const o of originNode) {
    if (o.n < 0) continue;
    const r = find(o.n);
    const c = comp.get(r) ?? { residents: 0, km: 0, at: net.nodes[o.n] };
    c.residents += o.w;
    comp.set(r, c);
  }
  for (const l of net.links) {
    if (l.lts > 2) continue;
    const c = comp.get(find(l.a));
    if (c) c.km += l.length / 2000; // each street appears in both directions
  }
  const islands = [...comp.values()].sort((a, b) => b.residents - a.residents);
  // critical links: high-stress streets bridging two different low-stress islands
  const crit = new Map<string, { streetId: string; name?: string; lts: LTS; joins: number; at: Vec2 }>();
  for (const l of net.links) {
    if (l.lts <= 2) continue;
    const ra = find(l.a),
      rb = find(l.b);
    if (ra === rb) continue;
    const a = comp.get(ra)?.residents ?? 0,
      b = comp.get(rb)?.residents ?? 0;
    const joins = Math.min(a, b);
    if (joins < 50) continue;
    const prev = crit.get(l.streetId);
    if (!prev || prev.joins < joins) crit.set(l.streetId, { streetId: l.streetId, name: l.name, lts: l.lts, joins, at: net.nodes[l.a] });
  }
  return {
    streetLts,
    kmByLts,
    coverage,
    islands: islands.slice(0, 12),
    criticalLinks: [...crit.values()].sort((a, b) => b.joins - a.joins).slice(0, 15),
    assumptions: [
      "Bicycle Level of Traffic Stress after Mekuria, Furth & Nixon (2012) / Furth (2017): protected tracks LTS 1; painted lanes by lanes per direction, speed and parking; mixed traffic by street class, lanes and speed",
      "Junction stress: crossing a street without a signal adds the crossing street's stress (lanes and speed); single-lane roundabouts LTS 2, multi-lane LTS 3",
      "Low-stress = LTS ≤ 2 (the 'interested but concerned' majority); coverage = residents within 15 min (4 km at 4.5 m/s) of each destination type",
      "Speeds are posted/default limits, not measured operating speeds; no traffic volumes (the ADT refinements of Furth 2017 are not applied)",
    ],
  };
}
