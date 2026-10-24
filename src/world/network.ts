// Directed link graph derived from street entities, shared by routing, the
// traffic model (serialised to a worker) and accessibility analysis.

import { hasSidewalk, laneCapacity, laneCount, countType } from "@/geometry/crossSection";
import { polyLength } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import type { Entity, Street, StreetNode, Vec2 } from "./types";

export type Mode = "car" | "bus" | "walk" | "bike" | "service";

export interface NetNode {
  id: string;
  p: Vec2;
  control: StreetNode["control"];
  plaza: boolean;
  roundabout?: { radius: number; lanes: number };
  tsp?: boolean;
  /** emergency-vehicle signal preemption */
  evp?: boolean;
}

export interface NetLink {
  i: number;
  streetId: string;
  from: string;
  to: string;
  /** index of from/to in nodes array */
  a: number;
  b: number;
  length: number;
  lanes: number;
  /** veh/h */
  capacity: number;
  /** free-flow speed m/s */
  speed: number;
  /** free-flow time (s) */
  t0: number;
  cls: Street["cls"];
  busLane: boolean;
  tram: boolean;
  name?: string;
}

export interface Network {
  nodes: NetNode[];
  nodeIndex: Map<string, number>;
  links: NetLink[];
  out: number[][];
}

const ARTERIAL = new Set<Street["cls"]>(["trunk", "primary", "secondary"]);

/**
 * Walking along a street: not on motorways, and not along an arterial with no sidewalk on either
 * side (pedestrian level of traffic stress 4). Local streets without sidewalks stay walkable (people
 * walk in the roadway); crossing any street at a junction is always possible.
 */
export function walkableAlong(s: Street): boolean {
  if (s.cls === "motorway" || s.cls === "motorway_link") return false;
  if (s.cls === "pedestrian" || s.cls === "living" || s.closed || hasSidewalk(s.section, "left") || hasSidewalk(s.section, "right")) return true;
  return !(ARTERIAL.has(s.cls) || (s.cls === "tertiary" && s.speed >= 48));
}

function allowed(s: Street, mode: Mode) {
  if (mode === "walk") return walkableAlong(s);
  if (mode === "bike") return s.cls !== "motorway" && s.cls !== "motorway_link";
  // pedestrian streets and closed streets admit service / emergency vehicles only where access is kept
  if (s.cls === "pedestrian" || s.closed) return mode === "service" && !!s.serviceAccess;
  return true;
}

export function buildNetwork(entities: Iterable<Entity>, mode: Mode = "car"): Network {
  const streets: Street[] = [];
  const nodeMap = new Map<string, StreetNode>();
  for (const e of entities) {
    if (e.kind === "street") streets.push(e);
    else if (e.kind === "node") nodeMap.set(e.id, e);
  }
  const nodes: NetNode[] = [];
  const nodeIndex = new Map<string, number>();
  const idx = (id: string) => {
    let i = nodeIndex.get(id);
    if (i === undefined) {
      const n = nodeMap.get(id);
      if (!n) return -1;
      i = nodes.length;
      nodes.push({ id, p: n.p, control: n.control, plaza: !!n.plaza, roundabout: n.roundabout, tsp: n.control === "signal" && !!n.tsp, evp: n.control === "signal" && !!n.evp });
      nodeIndex.set(id, i);
    }
    return i;
  };
  const links: NetLink[] = [];
  for (const s of streets) {
    if (!allowed(s, mode)) continue;
    const a = idx(s.from),
      b = idx(s.to);
    if (a < 0 || b < 0) continue;
    const L = Math.max(1, polyLength(s.path));
    const walk = mode === "walk" || mode === "bike";
    const speed = mode === "walk" ? 1.3 : mode === "bike" ? 4.5 : s.closed ? 3 : (s.speed / 3.6) * (s.cls === "motorway" ? 0.95 : 0.85);
    const sig = (nid: string) => nodeMap.get(nid)?.control === "signal";
    const mk = (from: string, to: string, ai: number, bi: number, dir: 1 | -1): NetLink => {
      const lanes = Math.max(1, laneCount(s.section, dir) || (s.oneway ? laneCount(s.section) : 0) || 1);
      const bus = s.section.strips.some((t) => t.type === "bus" && t.dir === dir);
      return {
        i: links.length,
        streetId: s.id,
        from,
        to,
        a: ai,
        b: bi,
        length: L,
        lanes,
        capacity: lanes * laneCapacity(s.cls, sig(to)),
        speed,
        t0: L / speed,
        cls: s.cls,
        busLane: bus,
        tram: countType(s.section, "tram") > 0,
        name: s.name,
      };
    };
    if (walk || !s.oneway) {
      links.push(mk(s.from, s.to, a, b, 1));
      links.push(mk(s.to, s.from, b, a, -1));
    } else links.push(mk(s.from, s.to, a, b, 1));
  }
  // plaza junctions block vehicle movements through the node
  if (mode !== "walk" && mode !== "bike") {
    for (let i = links.length - 1; i >= 0; i--) {
      const l = links[i];
      if (nodes[l.a].plaza || nodes[l.b].plaza) {
        // keep the link (access to the plaza edge) but make it a dead end by removing through movements later
      }
    }
  }
  const out: number[][] = nodes.map(() => []);
  links.forEach((l, i) => {
    l.i = i;
    out[l.a].push(i);
  });
  return { nodes, nodeIndex, links, out };
}

/** binary-heap Dijkstra; returns predecessor link per node and costs */
export function dijkstra(net: Network, src: number, cost: (l: NetLink) => number, opts: { target?: number; maxCost?: number } = {}) {
  const n = net.nodes.length;
  const d = new Float64Array(n).fill(Infinity);
  const pred = new Int32Array(n).fill(-1);
  const heap: number[] = [];
  const hd: number[] = [];
  const push = (v: number, c: number) => {
    heap.push(v);
    hd.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hd[p] <= hd[i]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      [hd[p], hd[i]] = [hd[i], hd[p]];
      i = p;
    }
  };
  const pop = () => {
    const v = heap[0],
      c = hd[0];
    const lv = heap.pop()!,
      lc = hd.pop()!;
    if (heap.length) {
      heap[0] = lv;
      hd[0] = lc;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && hd[l] < hd[m]) m = l;
        if (r < heap.length && hd[r] < hd[m]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        [hd[m], hd[i]] = [hd[i], hd[m]];
        i = m;
      }
    }
    return [v, c] as const;
  };
  d[src] = 0;
  push(src, 0);
  while (heap.length) {
    const [v, c] = pop();
    if (c > d[v]) continue;
    if (opts.target === v) break;
    if (opts.maxCost !== undefined && c > opts.maxCost) break;
    for (const li of net.out[v]) {
      const l = net.links[li];
      // no through-movement across a plaza junction (vehicles)
      if (net.nodes[v].plaza && pred[v] >= 0) continue;
      const nc = c + cost(l);
      if (nc < d[l.b]) {
        d[l.b] = nc;
        pred[l.b] = li;
        push(l.b, nc);
      }
    }
  }
  return { d, pred };
}

export function pathLinks(net: Network, pred: Int32Array, target: number): number[] {
  const out: number[] = [];
  let v = target;
  let guard = 0;
  while (pred[v] >= 0 && guard++ < 100000) {
    out.push(pred[v]);
    v = net.links[pred[v]].a;
  }
  return out.reverse();
}

export function nearestNode(net: Network, p: Vec2, filter?: (n: NetNode, i: number) => boolean): number {
  let best = -1,
    bd = Infinity;
  net.nodes.forEach((n, i) => {
    if (filter && !filter(n, i)) return;
    if (!net.out[i].length) return;
    const d = dist(n.p, p);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/** route between points preferring larger streets; returns ordered street ids and the polyline */
export function routeBetween(net: Network, pts: Vec2[], prefer: "arterial" | "shortest" = "arterial") {
  const pref = (l: NetLink) => (prefer === "shortest" ? l.length : l.length * (l.cls === "primary" || l.cls === "secondary" ? 0.7 : l.cls === "tertiary" ? 0.9 : l.cls === "residential" ? 1.5 : l.cls === "service" ? 4 : l.cls === "motorway" || l.cls === "motorway_link" ? 50 : 1.2));
  const streets: string[] = [];
  const nodesSeq: number[] = [];
  let ok = true;
  for (let k = 1; k < pts.length; k++) {
    const s = nearestNode(net, pts[k - 1], (n) => true && !!n);
    const t = nearestNode(net, pts[k]);
    if (s < 0 || t < 0) {
      ok = false;
      continue;
    }
    const { pred, d } = dijkstra(net, s, pref, { target: t });
    if (!Number.isFinite(d[t])) {
      ok = false;
      continue;
    }
    const ls = pathLinks(net, pred, t);
    if (!nodesSeq.length) nodesSeq.push(s);
    for (const li of ls) {
      const l = net.links[li];
      if (streets[streets.length - 1] !== l.streetId) streets.push(l.streetId);
      nodesSeq.push(l.b);
    }
  }
  return { streets, nodes: nodesSeq.map((i) => net.nodes[i]), ok };
}
