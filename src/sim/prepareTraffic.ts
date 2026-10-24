import { polyCentroid } from "@/geometry/polygon";
import { closestOnPath } from "@/geometry/polyline";
import { dist } from "@/geometry/vec";
import { programmeOf } from "@/world/ops/core";
import { buildNetwork, type Network } from "@/world/network";
import type { Building, CityMeta, CountStation, Entity, Street, TransitRoute, TransitStop, Vec2 } from "@/world/types";
import type { Gateway, TrafficInput, Zone } from "./traffic";

const GATEWAY_VOL: Record<string, number> = { motorway: 4200, motorway_link: 500, trunk: 1400, primary: 900, secondary: 650, tertiary: 320, residential: 50, living: 20, busway: 0, service: 10, pedestrian: 0 };

const normRoad = (s: string) =>
  s
    .toUpperCase()
    .replace(/IH0*(\d+)/, "I-$1")
    .replace(/INTERSTATE\s*/g, "I-")
    .replace(/NORTH |SOUTH |EAST |WEST /g, "")
    .replace(/\s+(FRONTAGE|EXPRESSWAY|HIGHWAY).*/, "")
    .trim();

export interface TrafficPrep {
  input: TrafficInput;
  net: Network;
}

export function prepareTraffic(entities: Map<string, Entity>, meta: CityMeta, counts: CountStation[], params: TrafficInput["params"], opts: { extraResidents?: { p: Vec2; residents: number }[] } = {}): TrafficPrep {
  // vehicle network without alleys / service lanes
  const ents = [...entities.values()];
  const net = buildNetwork(ents.filter((e) => e.kind !== "street" || ((e as Street).cls !== "service" && (e as Street).cls !== "living")), "car");
  const [x0, y0, x1, y1] = meta.bounds;
  const hh = meta.calibration.householdSize;

  // --- transit-rich areas (rail stations, frequent routes) drive less
  const frequentStops: Vec2[] = [];
  const routes = ents.filter((e) => e.kind === "route") as TransitRoute[];
  const stopsById = new Map((ents.filter((e) => e.kind === "stop") as TransitStop[]).map((s) => [s.id, s]));
  for (const r of routes) if (r.headway <= 15 || r.mode === "rail" || r.mode === "tram" || r.mode === "brt") for (const sid of r.stops) {
    const s = stopsById.get(sid);
    if (s) frequentStops.push(s.p);
  }

  // --- zones on a 300 m grid
  const Z = 300;
  const nx = Math.ceil((x1 - x0) / Z),
    ny = Math.ceil((y1 - y0) / Z);
  const zones: Zone[] = [];
  const zmap = new Map<number, Zone>();
  const zoneAt = (p: Vec2) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((p[0] - x0) / Z)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor((p[1] - y0) / Z)));
    const k = j * nx + i;
    let z = zmap.get(k);
    if (!z) {
      z = { id: k, p: [x0 + (i + 0.5) * Z, y0 + (j + 0.5) * Z], units: 0, officeJobs: 0, retailJobs: 0, otherJobs: 0, hotelRooms: 0, autoShare: 0.62, connectors: [] };
      zmap.set(k, z);
      zones.push(z);
    }
    return z;
  };
  for (const e of ents) {
    if (e.kind !== "building") continue;
    const b = e as Building;
    const c = polyCentroid(b.footprint);
    if (c[0] < x0 || c[0] > x1 || c[1] < y0 || c[1] > y1) continue;
    const pr = programmeOf(b, hh);
    const z = zoneAt(c);
    z.units += pr.units;
    const off = (b.program.office ?? 0) + (b.program.civic ?? 0) + (b.program.health ?? 0) + (b.program.education ?? 0) * 0.5;
    const ret = b.program.retail ?? 0;
    const tot = Math.max(1e-6, 1 - (b.program.residential ?? 0) - (b.program.parking ?? 0));
    z.officeJobs += pr.jobs * Math.min(1, off / tot);
    z.retailJobs += pr.jobs * Math.min(1, ret / tot);
    z.otherJobs += pr.jobs * Math.max(0, 1 - (off + ret) / tot);
    z.hotelRooms += pr.rooms;
  }
  for (const x of opts.extraResidents ?? []) {
    const z = zoneAt(x.p);
    z.units += x.residents / hh;
  }
  // centroid connectors: nearest two junctions (degree ≥ 2) to the zone's activity
  const candidates = net.nodes.map((n, i) => ({ n, i })).filter(({ i }) => net.out[i].length >= 1);
  for (const z of zones) {
    const near = candidates
      .map(({ n, i }) => ({ i, d: dist(n.p, z.p) }))
      .filter((x) => x.d < 260)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    z.connectors = near.map((x) => x.i);
    const transitRich = frequentStops.some((s) => dist(s, z.p) < 420);
    z.autoShare = transitRich ? 0.46 : 0.58;
  }

  // --- gateways: dangling nodes near the study boundary
  const deg = new Map<number, Set<number>>();
  for (const l of net.links) {
    if (!deg.has(l.a)) deg.set(l.a, new Set());
    if (!deg.has(l.b)) deg.set(l.b, new Set());
    deg.get(l.a)!.add(l.b);
    deg.get(l.b)!.add(l.a);
  }
  const gateways: Gateway[] = [];
  const edgeDist = (p: Vec2) => Math.min(p[0] - x0, x1 - p[0], p[1] - y0, y1 - p[1]);
  net.nodes.forEach((n, i) => {
    if ((deg.get(i)?.size ?? 0) !== 1) return;
    // a measured city connects to its region at the study edge; on the blank canvas every open end
    // of a collector or larger street is a connection to the wider region
    if (!meta.sandbox && edgeDist(n.p) > 220) return;
    const links = net.links.filter((l) => l.a === i || l.b === i);
    const cls = links[0]?.cls ?? "residential";
    if (cls === "residential" || cls === "living" || cls === "service") return;
    const v = GATEWAY_VOL[cls] ?? 50;
    if (v <= 0) return;
    const hasIn = links.some((l) => l.a === i);
    const hasOut = links.some((l) => l.b === i);
    gateways.push({ node: i, p: n.p, inbound: hasIn ? v : 0, outbound: hasOut ? v : 0, cls, name: links[0]?.name });
  });
  // --- calibrate gateways and count links to TxDOT AADT
  const peakDir = (aadt: number) => aadt * 0.09 * 0.55;
  const countLinks: TrafficInput["counts"] = [];
  for (const c of counts) {
    const road = normRoad(c.road);
    let best = -1,
      bd = 70;
    const mainLanes = road.startsWith("I-") && c.aadt > 60000;
    net.links.forEach((l, k) => {
      if (!l.name) return;
      const nm = normRoad(l.name);
      if (road.startsWith("I-") && (mainLanes ? l.cls !== "motorway" : l.cls === "motorway" || l.cls === "motorway_link")) return;
      if (!(nm.includes(road) || road.includes(nm) || (mainLanes && l.cls === "motorway"))) return;
      const a = net.nodes[l.a].p,
        b = net.nodes[l.b].p;
      const d = closestOnPath(c.p, [a, b]).d;
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    if (best >= 0) {
      // two-way roads: compare the peak direction of the matched link; one-way / divided carriageways carry ~half of AADT
      const twoWay = net.links.some((l) => l.streetId === net.links[best].streetId && l.a === net.links[best].b);
      countLinks.push({ linkIndex: best, peakHour: twoWay ? peakDir(c.aadt) : peakDir(c.aadt) * (net.links[best].cls === "motorway" ? 1 : 1.6), road: c.road, aadt: c.aadt });
    }
    // gateways on the same road within 600 m adopt the count
    for (const g of gateways) {
      if (!g.name) continue;
      const nm = normRoad(g.name);
      if (!(nm.includes(road) || road.includes(nm))) continue;
      if (dist(g.p, c.p) > 900) continue;
      const v = peakDir(c.aadt);
      const amIn = params.period === "am" ? 1.1 : 0.9;
      if (g.inbound) g.inbound = v * amIn * (g.cls === "motorway" ? 1 : 0.5);
      if (g.outbound) g.outbound = v * (2 - amIn) * (g.cls === "motorway" ? 1 : 0.5);
      g.calibrated = `${c.road} AADT ${c.aadt.toLocaleString()} (${c.year})`;
    }
  }
  // commute direction: inbound heavier in AM, outbound in PM (non-calibrated gateways)
  for (const g of gateways)
    if (!g.calibrated && g.cls !== "motorway") {
      const f = params.period === "am" ? [1.2, 0.8] : [0.8, 1.2];
      g.inbound *= f[0];
      g.outbound *= f[1];
    }

  // --- transit routes → link sequences
  const linksByStreet = new Map<string, number[]>();
  net.links.forEach((l, k) => {
    if (!linksByStreet.has(l.streetId)) linksByStreet.set(l.streetId, []);
    linksByStreet.get(l.streetId)!.push(k);
  });
  const routeLinks = routes
    .filter((r) => r.mode !== "rail")
    .map((r) => {
      const links: number[] = [];
      let prevEnd: number | null = null;
      for (const sid of r.streets) {
        const cand = linksByStreet.get(sid) ?? [];
        if (!cand.length) continue;
        let pick = cand[0];
        if (prevEnd !== null) {
          const m = cand.find((k) => net.links[k].a === prevEnd);
          if (m !== undefined) pick = m;
        } else if (cand.length > 1) {
          // orient by route path direction
          const a = net.nodes[net.links[cand[0]].a].p;
          const b = net.nodes[net.links[cand[0]].b].p;
          const ca = closestOnPath(a, r.path).along,
            cb = closestOnPath(b, r.path).along;
          pick = ca <= cb ? cand[0] : cand[1];
        }
        links.push(pick);
        prevEnd = net.links[pick].b;
      }
      return { id: r.id, name: r.name, ref: r.ref, mode: r.mode, links, stops: r.stops.length, headway: r.headway };
    })
    .filter((r) => r.links.length > 3);

  return { net, input: { net, zones, gateways, counts: countLinks, routes: routeLinks, params } };
}
