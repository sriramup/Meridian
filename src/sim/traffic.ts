// Peak-hour traffic model (four-step "lite"): ITE-rate trip generation from
// measured-anchored land use, gravity distribution with external gateways
// calibrated to TxDOT AADT, static user-equilibrium assignment (Frank–Wolfe,
// BPR link performance), HCM roundabout entry capacity, and critical-lane-volume
// intersection screening. Planning-level and uncalibrated beyond the AADT
// gateway counts — results are for comparing scenarios, not engineering design.

import type { NetLink, Network } from "@/world/network";
import type { Vec2 } from "@/world/types";

export interface Zone {
  id: number;
  p: Vec2;
  units: number;
  officeJobs: number;
  retailJobs: number;
  otherJobs: number;
  hotelRooms: number;
  /** auto mode-share multiplier (transit-rich zones drive less) */
  autoShare: number;
  connectors: number[];
}

export interface Gateway {
  node: number;
  p: Vec2;
  /** peak-hour inbound / outbound vehicles */
  inbound: number;
  outbound: number;
  cls: string;
  name?: string;
  calibrated?: string;
}

export interface TrafficParams {
  period: "am" | "pm";
  demandScale: number;
  /** extra residents placed at a point (what-if) */
  iterations: number;
  /** external through-trip share for motorways */
}

export interface TrafficInput {
  net: Network;
  zones: Zone[];
  gateways: Gateway[];
  counts: { linkIndex: number; peakHour: number; road: string; aadt: number }[];
  routes: { id: string; name: string; ref: string; mode: string; links: number[]; stops: number; headway: number }[];
  params: TrafficParams;
}

export interface TrafficResult {
  period: "am" | "pm";
  flows: Float32Array;
  vc: Float32Array;
  time: Float32Array;
  speed: Float32Array;
  nodes: { node: number; clv: number; vc: number; los: string; control: string; approaches: number }[];
  kpi: {
    vehTrips: number;
    vmt: number;
    vht: number;
    delayHours: number;
    avgSpeedKmh: number;
    congestedLinks: number;
    congestedKm: number;
    relGap: number;
    iterations: number;
    internalTrips: number;
    externalTrips: number;
  };
  routes: { id: string; name: string; ref: string; mode: string; minutes: number; freeMinutes: number; busLaneShare: number; signals: number; tspSignals: number }[];
  calibration: { road: string; observed: number; modelled: number; geh: number }[];
  assumptions: string[];
}

// ITE Trip Generation (11th ed.) style peak-hour rates, adjusted for urban core.
const RATES = {
  am: { resPerUnit: 0.31, resIn: 0.25, officePerJob: 0.4, officeIn: 0.88, retailPerJob: 0.5, retailIn: 0.6, otherPerJob: 0.28, otherIn: 0.8, hotelPerRoom: 0.47, hotelIn: 0.58 },
  pm: { resPerUnit: 0.36, resIn: 0.61, officePerJob: 0.38, officeIn: 0.17, retailPerJob: 1.0, retailIn: 0.5, otherPerJob: 0.3, otherIn: 0.25, hotelPerRoom: 0.6, hotelIn: 0.51 },
};
const EXTERNAL_SHARE = 0.72; // share of trips with one end outside the study area
const BPR_A = 0.15,
  BPR_B = 4;

export function bpr(t0: number, v: number, c: number) {
  return t0 * (1 + BPR_A * Math.pow(Math.max(0, v) / Math.max(1, c), BPR_B));
}

/** HCM 6th ed. roundabout entry capacity (pc/h) vs conflicting circulating flow */
export function roundaboutEntryCapacity(circulating: number, lanes: number) {
  return lanes > 1 ? 2 * 1420 * Math.exp(-0.00085 * circulating) : 1380 * Math.exp(-0.00102 * circulating);
}

/** signal timing assumed for bus delay (typical downtown fixed-time plan) */
const SIGNAL_CYCLE = 90,
  SIGNAL_GC = 0.45;
/** transit signal priority effect sizes */
const TSP_DELAY_CUT = 0.4,
  TSP_CAPACITY_COST = 0.03;

export function runTraffic(inp: TrafficInput, onProgress?: (p: number) => void): TrafficResult {
  const { net, zones, gateways, params } = inp;
  const R = RATES[params.period];
  const L = net.links.length;
  const nNodes = net.nodes.length;
  const assumptions = [
    `Trip rates: ITE Trip Generation 11th ed. ${params.period.toUpperCase()} peak-hour rates (residential ${R.resPerUnit}/unit, office ${R.officePerJob}/job) scaled by zone auto mode share`,
    `${Math.round(EXTERNAL_SHARE * 100)}% of internal-zone trips have an external end (study area ≈ 17 km²)`,
    "Gateway volumes from TxDOT AADT × K=0.09 × D=0.55 where a count exists; class defaults otherwise",
    "Static user equilibrium (Frank–Wolfe), BPR α=0.15 β=4; saturation flow 1,800 pc/h/ln × g/C by class",
    "Intersections screened with the critical lane volume method (capacity 1,450 veh/h); roundabouts with HCM 6 entry capacity",
    "No turn penalties, no queue spill-back, no transit/pedestrian interaction — compare scenarios, not absolute delays",
    "Assignment converges to a relative gap of ~0.5%: network-delay differences under ~1% between scenarios are within solver noise",
    `Bus route times: link times ×1.12, 20 s dwell per stop, Webster uniform signal delay at each signal (C = ${SIGNAL_CYCLE} s, g/C = ${SIGNAL_GC}); transit signal priority cuts bus signal delay by ${TSP_DELAY_CUT * 100}% (TCRP 118 reports 30–50%) and takes ${TSP_CAPACITY_COST * 100}% of capacity from conflicting approaches`,
  ];

  // ---- endpoints: zones then gateways
  type Endpoint = { nodes: number[]; prod: number; attr: number; external: boolean; w: number; through: number };
  const ends: Endpoint[] = [];
  let internalTrips = 0;
  for (const z of zones) {
    if (!z.connectors.length) continue;
    const s = z.autoShare * params.demandScale;
    const out =
      (z.units * R.resPerUnit * (1 - R.resIn) + z.officeJobs * R.officePerJob * (1 - R.officeIn) + z.retailJobs * R.retailPerJob * (1 - R.retailIn) + z.otherJobs * R.otherPerJob * (1 - R.otherIn) + z.hotelRooms * R.hotelPerRoom * (1 - R.hotelIn)) * s;
    const inn = (z.units * R.resPerUnit * R.resIn + z.officeJobs * R.officePerJob * R.officeIn + z.retailJobs * R.retailPerJob * R.retailIn + z.otherJobs * R.otherPerJob * R.otherIn + z.hotelRooms * R.hotelPerRoom * R.hotelIn) * s;
    ends.push({ nodes: z.connectors, prod: out, attr: inn, external: false, w: 0, through: 0 });
    internalTrips += out + inn;
  }
  const nZones = ends.length;
  for (const g of gateways) {
    // gateway weight ~ approach capacity (calibrated volume where counted); through volume for corridors
    const w = Math.max(g.inbound, g.outbound);
    const through = g.cls === "motorway" ? 0.8 * w : g.cls === "trunk" ? 0.3 * w : g.cls === "primary" ? 0.15 * w : 0.05 * w;
    ends.push({ nodes: [g.node], prod: g.inbound, attr: g.outbound, external: true, w, through: through * params.demandScale });
  }

  // ---- free-flow skims for distribution
  const csr = toCSR(net);
  const t0 = new Float64Array(L);
  for (let k = 0; k < L; k++) t0[k] = net.links[k].t0;
  const skim: Float64Array[] = [];
  for (let i = 0; i < ends.length; i++) skim.push(spt(csr, ends[i].nodes[0], t0).d);
  const tt = (i: number, j: number) => {
    const t = skim[i][ends[j].nodes[0]];
    return Number.isFinite(t) ? t / 60 : 1e6;
  };

  // ---- OD matrix: II (gravity), IE / EI (zone totals × external share over gateways), EE (through)
  const beta = 0.09;
  const od: Map<number, number>[] = ends.map(() => new Map());
  const add = (i: number, j: number, v: number) => {
    if (v <= 0 || i === j) return;
    od[i].set(j, (od[i].get(j) ?? 0) + v);
  };
  const extIdx = ends.map((e, i) => (e.external ? i : -1)).filter((i) => i >= 0);
  const intIdx = ends.map((e, i) => (!e.external ? i : -1)).filter((i) => i >= 0);
  let externalTrips = 0;
  const gatewayShare = (fromZone: number, outbound: boolean) => {
    // gateways weighted by capacity and (weakly) by proximity
    let den = 0;
    const w = extIdx.map((g) => {
      const t = outbound ? tt(fromZone, g) : tt(g, fromZone);
      const v = (outbound ? ends[g].attr : ends[g].prod) > 0 ? ends[g].w * Math.exp(-0.04 * t) : 0;
      den += v;
      return v;
    });
    return w.map((v) => (den > 0 ? v / den : 0));
  };
  for (const i of intIdx) {
    const P = ends[i].prod,
      A = ends[i].attr;
    const shOut = gatewayShare(i, true);
    const shIn = gatewayShare(i, false);
    extIdx.forEach((g, k) => {
      add(i, g, P * EXTERNAL_SHARE * shOut[k]);
      add(g, i, A * EXTERNAL_SHARE * shIn[k]);
    });
    externalTrips += (P + A) * EXTERNAL_SHARE;
    let den = 0;
    const w: number[] = [];
    for (const j of intIdx) {
      const v = ends[j].attr * Math.exp(-beta * tt(i, j));
      w.push(v);
      den += v;
    }
    if (den > 0) intIdx.forEach((j, k) => add(i, j, (P * (1 - EXTERNAL_SHARE) * w[k]) / den));
  }
  for (const g of extIdx) {
    const T = ends[g].through;
    if (T <= 0) continue;
    let den = 0;
    const w = extIdx.map((h) => {
      if (h === g || ends[h].attr <= 0) return 0;
      const a = gateways[g - nZones].p,
        b = gateways[h - nZones].p;
      const v = ends[h].through * Math.pow(Math.hypot(a[0] - b[0], a[1] - b[1]), 2);
      den += v;
      return v;
    });
    if (den > 0) extIdx.forEach((h, k) => add(g, h, (T * w[k]) / den));
  }

  // ---- Frank–Wolfe assignment
  const flows = new Float64Array(L);
  const aux = new Float64Array(L);
  const cap = new Float64Array(L);
  const time = new Float64Array(L);
  for (let k = 0; k < L; k++) cap[k] = net.links[k].capacity;
  // transit signal priority: green given to buses comes from the conflicting approaches
  const onRoute = new Set<number>();
  for (const r of inp.routes) for (const k of r.links) onRoute.add(k);
  for (let k = 0; k < L; k++) if (net.nodes[net.links[k].b].tsp && !onRoute.has(k)) cap[k] *= 1 - TSP_CAPACITY_COST;
  // roundabout entry links
  const raEntry: number[] = [];
  for (let k = 0; k < L; k++) {
    const n = net.nodes[net.links[k].b];
    if (n.control === "roundabout") raEntry.push(k);
  }
  const updateTimes = () => {
    for (let k = 0; k < L; k++) time[k] = bpr(net.links[k].t0, flows[k], cap[k]);
  };
  const aon = (target: Float64Array) => {
    target.fill(0);
    for (let i = 0; i < ends.length; i++) {
      const row = od[i];
      if (!row.size) continue;
      const src = ends[i].nodes[0];
      const { pred } = spt(csr, src, time);
      for (const [j, v] of row) {
        // split destination demand across its connector nodes
        const dn = ends[j].nodes;
        const share = v / dn.length;
        for (const t of dn) {
          let x = t;
          let guard = 0;
          while (pred[x] >= 0 && guard++ < 20000) {
            const li = pred[x];
            target[li] += share;
            x = net.links[li].a;
          }
        }
      }
    }
  };
  updateTimes();
  aon(flows);
  let relGap = 1;
  let it = 0;
  const maxIt = params.iterations;
  for (it = 1; it <= maxIt; it++) {
    // roundabout entry capacities from circulating flow
    for (const k of raEntry) {
      const node = net.links[k].b;
      let circ = 0;
      for (let q = 0; q < L; q++) if (net.links[q].b === node && q !== k) circ += flows[q] * 0.5;
      const lanes = net.nodes[node].roundabout?.lanes ?? 1;
      cap[k] = roundaboutEntryCapacity(circ, lanes);
    }
    updateTimes();
    aon(aux);
    // relative gap
    let num = 0,
      den = 0;
    for (let k = 0; k < L; k++) {
      num += time[k] * (flows[k] - aux[k]);
      den += time[k] * flows[k];
    }
    relGap = den > 0 ? Math.abs(num) / den : 0;
    if (relGap < 0.005) break;
    // line search (bisection on Beckmann objective derivative)
    let lo = 0,
      hi = 1;
    for (let s = 0; s < 18; s++) {
      const a = (lo + hi) / 2;
      let g = 0;
      for (let k = 0; k < L; k++) {
        const d = aux[k] - flows[k];
        if (d === 0) continue;
        g += d * bpr(net.links[k].t0, flows[k] + a * d, cap[k]);
      }
      if (g > 0) hi = a;
      else lo = a;
    }
    const step = Math.max(1 / (it + 1), (lo + hi) / 2);
    for (let k = 0; k < L; k++) flows[k] += step * (aux[k] - flows[k]);
    onProgress?.(it / maxIt);
  }
  updateTimes();

  // ---- outputs
  const out = {
    flows: new Float32Array(L),
    vc: new Float32Array(L),
    time: new Float32Array(L),
    speed: new Float32Array(L),
  };
  let vmt = 0,
    vht = 0,
    delay = 0,
    congested = 0,
    congestedKm = 0;
  for (let k = 0; k < L; k++) {
    const l = net.links[k];
    out.flows[k] = flows[k];
    out.vc[k] = flows[k] / Math.max(1, cap[k]);
    out.time[k] = time[k];
    out.speed[k] = (l.length / Math.max(0.1, time[k])) * 3.6;
    vmt += (flows[k] * l.length) / 1000;
    vht += (flows[k] * time[k]) / 3600;
    delay += (flows[k] * (time[k] - l.t0)) / 3600;
    if (out.vc[k] > 0.9 && flows[k] > 50) {
      congested++;
      congestedKm += l.length / 1000;
    }
  }
  // ---- intersections: critical lane volume screening
  const nodesOut: TrafficResult["nodes"] = [];
  const inLinks: number[][] = Array.from({ length: nNodes }, () => []);
  for (let k = 0; k < L; k++) inLinks[net.links[k].b].push(k);
  for (let n = 0; n < nNodes; n++) {
    const ins = inLinks[n];
    const node = net.nodes[n];
    if (ins.length < 3 && node.control !== "roundabout") continue;
    if (node.control === "none" && ins.length < 3) continue;
    // cluster approaches into two axes by bearing
    const axes: number[][] = [[], []];
    const ref = ins.length ? approachBearing(net, ins[0]) : 0;
    for (const k of ins) {
      const b = approachBearing(net, k);
      const d = Math.abs(Math.sin(b - ref));
      axes[d < 0.7 ? 0 : 1].push(k);
    }
    let clv = 0;
    for (const ax of axes) {
      let m = 0;
      for (const k of ax) m = Math.max(m, flows[k] / Math.max(1, net.links[k].lanes));
      clv += m;
    }
    let vc = clv / 1450;
    if (node.control === "roundabout") {
      let worst = 0;
      for (const k of ins) worst = Math.max(worst, flows[k] / Math.max(1, cap[k]));
      vc = worst;
    }
    const los = vc < 0.6 ? "A" : vc < 0.7 ? "B" : vc < 0.8 ? "C" : vc < 0.9 ? "D" : vc < 1.0 ? "E" : "F";
    nodesOut.push({ node: n, clv: Math.round(clv), vc, los, control: node.control, approaches: ins.length });
  }
  nodesOut.sort((a, b) => b.vc - a.vc);

  // ---- transit route travel times
  const routes = inp.routes.map((r) => {
    let sec = 0,
      free = 0,
      bl = 0,
      len = 0;
    let signals = 0,
      tsp = 0;
    for (const k of r.links) {
      const l = net.links[k];
      const busSpeedFactor = 1.12;
      const t = l.busLane || l.tram ? l.t0 * busSpeedFactor : time[k] * busSpeedFactor;
      // signal delay (Webster uniform term) at the junction the link enters; TSP cuts it
      const end = net.nodes[l.b];
      let sd = 0;
      if (end.control === "signal") {
        const x = Math.min(0.95, out.vc[k] || 0);
        sd = (0.5 * SIGNAL_CYCLE * (1 - SIGNAL_GC) ** 2) / (1 - x * SIGNAL_GC);
        signals++;
        if (end.tsp) {
          sd *= 1 - TSP_DELAY_CUT;
          tsp++;
        }
      }
      sec += t + sd;
      free += l.t0 * busSpeedFactor + (end.control === "signal" ? (0.5 * SIGNAL_CYCLE * (1 - SIGNAL_GC) ** 2) * (end.tsp ? 1 - TSP_DELAY_CUT : 1) : 0);
      len += l.length;
      if (l.busLane || l.tram) bl += l.length;
    }
    const dwell = r.stops * 20;
    return { id: r.id, name: r.name, ref: r.ref, mode: r.mode, minutes: (sec + dwell) / 60, freeMinutes: (free + dwell) / 60, busLaneShare: len ? bl / len : 0, signals, tspSignals: tsp };
  });

  // ---- calibration against counts
  const calibration = inp.counts.map((c) => {
    const m = flows[c.linkIndex] ?? 0;
    const o = c.peakHour;
    const geh = Math.sqrt((2 * (m - o) ** 2) / Math.max(1, m + o));
    return { road: c.road, observed: Math.round(o), modelled: Math.round(m), geh: Math.round(geh * 10) / 10 };
  });

  void tt;
  const vehTrips = [...od].reduce((s, row) => s + [...row.values()].reduce((a, b) => a + b, 0), 0);
  return {
    period: params.period,
    ...out,
    nodes: nodesOut,
    kpi: { vehTrips, vmt, vht, delayHours: delay, avgSpeedKmh: vht > 0 ? vmt / vht : 0, congestedLinks: congested, congestedKm, relGap, iterations: it, internalTrips, externalTrips },
    routes,
    calibration,
    assumptions,
  };
}

interface CSR {
  n: number;
  start: Int32Array;
  link: Int32Array;
  head: Int32Array;
  tail: Int32Array;
  plaza: Uint8Array;
}

function toCSR(net: Network): CSR {
  const n = net.nodes.length;
  const L = net.links.length;
  const start = new Int32Array(n + 1);
  for (const l of net.links) start[l.a + 1]++;
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n);
  const link = new Int32Array(L);
  const head = new Int32Array(L);
  const tail = new Int32Array(L);
  net.links.forEach((l, k) => {
    link[fill[l.a]++] = k;
    head[k] = l.b;
    tail[k] = l.a;
  });
  const plaza = new Uint8Array(n);
  net.nodes.forEach((x, i) => (plaza[i] = x.plaza ? 1 : 0));
  return { n, start, link, head, tail, plaza };
}

/** shortest-path tree over CSR with a typed binary heap (lazy deletion) */
function spt(g: CSR, src: number, cost: Float64Array) {
  const d = new Float64Array(g.n).fill(Infinity);
  const pred = new Int32Array(g.n).fill(-1);
  let cap = 1024;
  let hn = new Int32Array(cap);
  let hk = new Float64Array(cap);
  let size = 0;
  const push = (v: number, c: number) => {
    if (size === cap) {
      cap *= 2;
      const a = new Int32Array(cap);
      a.set(hn);
      hn = a;
      const b = new Float64Array(cap);
      b.set(hk);
      hk = b;
    }
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= c) break;
      hn[i] = hn[p];
      hk[i] = hk[p];
      i = p;
    }
    hn[i] = v;
    hk[i] = c;
  };
  d[src] = 0;
  push(src, 0);
  while (size > 0) {
    const v = hn[0],
      c = hk[0];
    size--;
    if (size > 0) {
      const lv = hn[size],
        lc = hk[size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= size) break;
        const r = l + 1;
        const m = r < size && hk[r] < hk[l] ? r : l;
        if (hk[m] >= lc) break;
        hn[i] = hn[m];
        hk[i] = hk[m];
        i = m;
      }
      hn[i] = lv;
      hk[i] = lc;
    }
    if (c > d[v]) continue;
    if (g.plaza[v] && pred[v] >= 0) continue;
    for (let e = g.start[v], end = g.start[v + 1]; e < end; e++) {
      const li = g.link[e];
      const nc = c + cost[li];
      const w = g.head[li];
      if (nc < d[w]) {
        d[w] = nc;
        pred[w] = li;
        push(w, nc);
      }
    }
  }
  return { d, pred };
}

function approachBearing(net: Network, k: number) {
  const l = net.links[k];
  const a = net.nodes[l.a].p,
    b = net.nodes[l.b].p;
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

/** hourly share of daily traffic for an urban arterial (typical weekday profile) */
export const HOURLY_PROFILE = [0.008, 0.005, 0.004, 0.004, 0.007, 0.018, 0.045, 0.068, 0.071, 0.058, 0.052, 0.055, 0.058, 0.057, 0.059, 0.066, 0.075, 0.08, 0.066, 0.049, 0.038, 0.032, 0.024, 0.016];
