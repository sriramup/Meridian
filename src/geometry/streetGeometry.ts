// Procedural street + intersection geometry derived from the world model.
// Streets carry a centreline and an ordered cross-section; everything visible
// (strip surfaces, kerb returns, corner sidewalks, crosswalks, lane markings)
// is rebuilt from those parameters, so editing a section or moving a node
// regenerates consistent geometry for every affected street and junction.

import type { CrossSection, Ring, Street, StreetNode, StripType, Vec2 } from "@/world/types";
import { kerbOffsets, PED_REALM, sectionWidth, stripOffsets } from "./crossSection";
import { bandRing, endDirections, offsetPath, polyLength, slicePath } from "./polyline";
import { add, angle, dist, dot, lineIntersect, norm, perp, scale, sub, wrapAngle } from "./vec";

export interface NetworkAccess {
  node(id: string): StreetNode | undefined;
  street(id: string): Street | undefined;
}

export interface EndInfo {
  streetId: string;
  nodeId: string;
  atStart: boolean;
  u: Vec2;
  ang: number;
  kerbL: number;
  kerbR: number;
  rowL: number;
  rowR: number;
  trim: number;
  /** cut line direction for degree-2 mitred joints (null = perpendicular) */
  cut: Vec2 | null;
  crosswalk: boolean;
  stopBar: boolean;
}

export interface Marking {
  path: Vec2[];
  width: number;
  color: "white" | "yellow";
  /** dash, gap in metres; omitted = solid */
  dash?: [number, number];
  kind: "lane" | "centre" | "edge" | "stop" | "crosswalk" | "bike" | "bus";
}

export interface StripGeom {
  type: StripType;
  ring: Ring;
  dir: 1 | -1 | 0;
  index: number;
  width: number;
  bio?: boolean;
}

export interface StreetGeom {
  id: string;
  trimStart: number;
  trimEnd: number;
  path: Vec2[];
  strips: StripGeom[];
  markings: Marking[];
  /** full right-of-way band over the untrimmed centreline (for conflict checks) */
  row: Ring;
  length: number;
}

export interface NodeGeom {
  id: string;
  carriageway: Ring | null;
  corners: Ring[];
  island: Ring | null;
  markings: Marking[];
  plaza: boolean;
  ends: EndInfo[];
}

const KERB_RADIUS: Record<string, number> = {
  motorway: 12,
  motorway_link: 10,
  trunk: 9,
  primary: 7,
  secondary: 6,
  tertiary: 5,
  residential: 4.5,
  living: 3.5,
  service: 3,
  pedestrian: 2,
  busway: 6,
};

function endInfo(st: Street, nodeId: string, atStart: boolean): EndInfo {
  const dirs = endDirections(st.path);
  const u = atStart ? dirs.start : dirs.end;
  const k = kerbOffsets(st.section, st.section.shift ?? 0);
  const kerbL = atStart ? k.left : -k.right;
  const kerbR = atStart ? -k.right : k.left;
  const rowL = atStart ? k.rowLeft : -k.rowRight;
  const rowR = atStart ? -k.rowRight : k.rowLeft;
  return { streetId: st.id, nodeId, atStart, u, ang: angle(u), kerbL, kerbR, rowL, rowR, trim: 0, cut: null, crosswalk: false, stopBar: false };
}

const left = (u: Vec2) => perp(u);
const right = (u: Vec2) => scale(perp(u), -1);

function arcPoints(center: Vec2, from: Vec2, to: Vec2, r: number, steps = 6): Vec2[] {
  const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
  const a1 = Math.atan2(to[1] - center[1], to[0] - center[0]);
  const da = wrapAngle(a1 - a0);
  const out: Vec2[] = [];
  for (let i = 1; i < steps; i++) {
    const a = a0 + (da * i) / steps;
    out.push([center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r]);
  }
  return out;
}

interface Corner {
  a: number;
  b: number;
  theta: number;
  /** kerb corner and fillet */
  C: Vec2 | null;
  T: number;
  R: number;
  center: Vec2 | null;
  Crow: Vec2 | null;
  reflex: boolean;
}

export function solveNode(node: StreetNode, net: NetworkAccess): NodeGeom {
  const ends: EndInfo[] = [];
  const streets: Street[] = [];
  for (const sid of node.edges) {
    const st = net.street(sid);
    if (!st) continue;
    if (st.from === node.id) {
      ends.push(endInfo(st, node.id, true));
      streets.push(st);
    }
    if (st.to === node.id) {
      ends.push(endInfo(st, node.id, false));
      streets.push(st);
    }
  }
  const out: NodeGeom = { id: node.id, carriageway: null, corners: [], island: null, markings: [], plaza: !!node.plaza, ends };
  const P = node.p;
  if (ends.length <= 1) return out;

  const order = ends.map((_, i) => i).sort((i, j) => ends[i].ang - ends[j].ang);
  const sorted = order.map((i) => ends[i]);
  const sortedStreets = order.map((i) => streets[i]);

  if (sorted.length === 2) {
    // mitred joint between two segments of (usually) the same road
    const [a, b] = sorted;
    const sum = add(a.u, b.u);
    const cutDir = Math.hypot(sum[0], sum[1]) < 1e-3 ? perp(a.u) : norm(sum);
    a.cut = cutDir;
    b.cut = cutDir;
    return out;
  }

  if (node.control === "roundabout") return solveRoundabout(node, sorted, sortedStreets, out);

  const n = sorted.length;
  const corners: Corner[] = [];
  const need = new Array(n).fill(0.5);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = sorted[i],
      b = sorted[j];
    let theta = wrapAngle(b.ang - a.ang);
    if (theta <= 0) theta += 2 * Math.PI;
    const R = Math.min(KERB_RADIUS[sortedStreets[i].cls] ?? 5, KERB_RADIUS[sortedStreets[j].cls] ?? 5);
    const oA = add(P, scale(left(a.u), a.kerbL));
    const oB = add(P, scale(right(b.u), b.kerbR));
    const rA = add(P, scale(left(a.u), a.rowL));
    const rB = add(P, scale(right(b.u), b.rowR));
    const corner: Corner = { a: i, b: j, theta, C: null, T: 0, R, center: null, Crow: null, reflex: theta > Math.PI + 0.17 };
    if (theta < Math.PI - 0.17) {
      const hit = lineIntersect(oA, a.u, oB, b.u);
      if (hit) {
        const T = Math.min(R / Math.tan(theta / 2), 30);
        corner.C = hit.p;
        corner.T = T;
        need[i] = Math.max(need[i], hit.t + T);
        need[j] = Math.max(need[j], hit.u + T);
        const bis = norm(add(a.u, b.u));
        corner.center = add(hit.p, scale(bis, R / Math.sin(theta / 2)));
        const hr = lineIntersect(rA, a.u, rB, b.u);
        if (hr && hr.t > -5 && hr.u > -5) corner.Crow = hr.p;
      }
    } else if (corner.reflex) {
      const hit = lineIntersect(oA, a.u, oB, b.u);
      if (hit && hit.t < 0 && hit.u < 0 && hit.t > -25 && hit.u > -25) corner.C = hit.p;
      const hr = lineIntersect(rA, a.u, rB, b.u);
      if (hr && hr.t < 0 && hr.u < 0 && hr.t > -30 && hr.u > -30) corner.Crow = hr.p;
    }
    corners.push(corner);
  }

  // the junction must also be at least as deep as the widest crossing kerb
  for (let i = 0; i < n; i++) {
    const st = sortedStreets[i];
    const L = polyLength(st.path);
    const cap = Math.min(45, Math.max(1, L * 0.45));
    sorted[i].trim = Math.max(0.5, Math.min(cap, need[i]));
  }

  // carriageway polygon
  const poly: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const e = sorted[i];
    const base = add(P, scale(e.u, e.trim));
    const Rp = add(base, scale(right(e.u), e.kerbR));
    const Lp = add(base, scale(left(e.u), e.kerbL));
    poly.push(Rp, Lp);
    const c = corners[i];
    const nx = sorted[c.b];
    if (c.C && c.center && !c.reflex) {
      const TA = add(c.C, scale(e.u, c.T));
      const TB = add(c.C, scale(nx.u, c.T));
      if (dist(Lp, TA) > 0.05) poly.push(TA);
      poly.push(...arcPoints(c.center, TA, TB, c.R));
      poly.push(TB);
    } else if (c.C && c.reflex) {
      poly.push(c.C);
    }
  }
  out.carriageway = poly;

  // corner sidewalks
  for (const c of corners) {
    const a = sorted[c.a],
      b = sorted[c.b];
    const ba = add(P, scale(a.u, a.trim));
    const bb = add(P, scale(b.u, b.trim));
    const kA = add(ba, scale(left(a.u), a.kerbL));
    const rA = add(ba, scale(left(a.u), a.rowL));
    const kB = add(bb, scale(right(b.u), b.kerbR));
    const rB = add(bb, scale(right(b.u), b.rowR));
    if (a.rowL - a.kerbL < 0.3 && b.rowR - b.kerbR < 0.3) continue;
    const ring: Vec2[] = [kA, rA];
    if (c.Crow) ring.push(c.Crow);
    ring.push(rB, kB);
    if (c.C && c.center && !c.reflex) {
      const TA = add(c.C, scale(a.u, c.T));
      const TB = add(c.C, scale(b.u, c.T));
      ring.push(TB, ...arcPoints(c.center, TB, TA, c.R), TA);
    } else if (c.C && c.reflex) ring.push(c.C);
    out.corners.push(ring);
  }

  // crosswalks + stop bars
  const pedNode = !node.plaza;
  for (let i = 0; i < n; i++) {
    const e = sorted[i];
    const st = sortedStreets[i];
    const motor = st.cls === "motorway" || st.cls === "motorway_link";
    const hasPed = st.section.strips.some((s) => s.type === "sidewalk");
    e.crosswalk = pedNode && !motor && hasPed && st.cls !== "pedestrian";
    e.stopBar = !motor && (node.control === "signal" || node.control === "stop");
  }
  return out;
}

function solveRoundabout(node: StreetNode, sorted: EndInfo[], streets: Street[], out: NodeGeom): NodeGeom {
  const P = node.p;
  const lanes = node.roundabout?.lanes ?? 1;
  const ringW = lanes * 5.0;
  const maxApproach = Math.max(...sorted.map((e) => Math.max(e.kerbL, e.kerbR)));
  const Ro = Math.max(node.roundabout?.radius ?? 16, maxApproach + ringW + 4);
  const Ri = Ro - ringW;
  const sidewalk = 3.5;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const L = polyLength(streets[i].path);
    e.trim = Math.min(L * 0.45, Ro + 4);
    e.crosswalk = streets[i].section.strips.some((s) => s.type === "sidewalk");
    e.stopBar = false;
  }
  // carriageway = outer circle + approach necks (as one ring traced around)
  const ring: Vec2[] = [];
  const n = sorted.length;
  for (let i = 0; i < n; i++) {
    const e = sorted[i];
    const nx = sorted[(i + 1) % n];
    const base = add(P, scale(e.u, e.trim));
    const Rp = add(base, scale(right(e.u), e.kerbR));
    const Lp = add(base, scale(left(e.u), e.kerbL));
    const ang0 = Math.atan2(e.u[1], e.u[0]) + Math.asin(Math.min(0.95, (e.kerbL + 1.5) / Ro));
    let ang1 = Math.atan2(nx.u[1], nx.u[0]) - Math.asin(Math.min(0.95, (nx.kerbR + 1.5) / Ro));
    while (ang1 < ang0) ang1 += Math.PI * 2;
    ring.push(Rp, Lp);
    const steps = Math.max(2, Math.ceil(((ang1 - ang0) * Ro) / 3));
    for (let s = 0; s <= steps; s++) {
      const a = ang0 + ((ang1 - ang0) * s) / steps;
      ring.push([P[0] + Math.cos(a) * Ro, P[1] + Math.sin(a) * Ro]);
    }
    const arc = (r: number, rev: boolean) => {
      const pts: Vec2[] = [];
      for (let s = 0; s <= steps; s++) {
        const a = ang0 + ((ang1 - ang0) * (rev ? steps - s : s)) / steps;
        pts.push([P[0] + Math.cos(a) * r, P[1] + Math.sin(a) * r]);
      }
      return pts;
    };
    const nb = add(P, scale(nx.u, nx.trim));
    out.corners.push([
      Lp,
      add(base, scale(left(e.u), e.rowL)),
      ...arc(Ro + sidewalk, false),
      add(nb, scale(right(nx.u), nx.rowR)),
      add(nb, scale(right(nx.u), nx.kerbR)),
      ...arc(Ro, true),
    ]);
  }
  out.carriageway = ring;
  const island: Vec2[] = [];
  for (let s = 0; s < 40; s++) {
    const a = (s / 40) * Math.PI * 2;
    island.push([P[0] + Math.cos(a) * Ri, P[1] + Math.sin(a) * Ri]);
  }
  out.island = island;
  // circulating lane line
  if (lanes > 1) {
    const mid: Vec2[] = [];
    for (let s = 0; s <= 48; s++) {
      const a = (s / 48) * Math.PI * 2;
      mid.push([P[0] + Math.cos(a) * (Ri + ringW / 2), P[1] + Math.sin(a) * (Ri + ringW / 2)]);
    }
    out.markings.push({ path: mid, width: 0.12, color: "white", dash: [3, 6], kind: "lane" });
  }
  return out;
}

/** offset a path and re-cut its end vertices against mitre cut lines */
function cutOffset(path: Vec2[], d: number, startCut: { p: Vec2; dir: Vec2 } | null, endCut: { p: Vec2; dir: Vec2 } | null): Vec2[] {
  const o = offsetPath(path, d);
  if (o.length >= 2 && startCut) {
    const hit = lineIntersect(o[0], sub(o[1], o[0]), startCut.p, startCut.dir);
    if (hit && Math.abs(hit.t) < 3) o[0] = hit.p;
  }
  if (o.length >= 2 && endCut) {
    const m = o.length;
    const hit = lineIntersect(o[m - 1], sub(o[m - 2], o[m - 1]), endCut.p, endCut.dir);
    if (hit && Math.abs(hit.t) < 3) o[m - 1] = hit.p;
  }
  return o;
}

export function buildStreetGeom(st: Street, startEnd: EndInfo | undefined, endEnd: EndInfo | undefined): StreetGeom {
  const L = polyLength(st.path);
  let t0 = startEnd?.trim ?? 0;
  let t1 = endEnd?.trim ?? 0;
  if (t0 + t1 > L - 0.5) {
    const s = Math.max(0, (L - 0.5) / Math.max(1e-6, t0 + t1));
    t0 *= s;
    t1 *= s;
  }
  const path = t0 > 0.01 || t1 > 0.01 ? slicePath(st.path, t0, L - t1) : st.path.slice();
  const shift = st.section.shift ?? 0;
  const startCut = startEnd?.cut ? { p: path[0], dir: startEnd.cut } : null;
  const endCut = endEnd?.cut ? { p: path[path.length - 1], dir: endEnd.cut } : null;

  const offs = stripOffsets(st.section, shift);
  const strips: StripGeom[] = offs.map((o) => {
    const l = cutOffset(path, o.left, startCut, endCut);
    const r = cutOffset(path, o.right, startCut, endCut);
    return { type: o.strip.type, ring: [...r, ...l.reverse()], dir: o.strip.dir, index: o.index, width: o.strip.width, bio: o.strip.bio };
  });

  const markings: Marking[] = [];
  const isMotor = (t: StripType) => t === "travel" || t === "turn" || t === "bus";
  for (let i = 0; i + 1 < offs.length; i++) {
    const a = offs[i].strip,
      b = offs[i + 1].strip;
    const x = offs[i].right;
    const line = () => cutOffset(path, x, startCut, endCut);
    if (a.type === "travel" && b.type === "travel") {
      if (a.dir === b.dir) markings.push({ path: line(), width: 0.12, color: "white", dash: [3, 9], kind: "lane" });
      else {
        markings.push({ path: cutOffset(path, x + 0.12, startCut, endCut), width: 0.11, color: "yellow", kind: "centre" });
        markings.push({ path: cutOffset(path, x - 0.12, startCut, endCut), width: 0.11, color: "yellow", kind: "centre" });
      }
    } else if ((a.type === "turn" && b.type === "travel") || (a.type === "travel" && b.type === "turn")) {
      markings.push({ path: cutOffset(path, x + (a.type === "turn" ? 0.15 : -0.15), startCut, endCut), width: 0.11, color: "yellow", dash: [3, 3], kind: "centre" });
      markings.push({ path: cutOffset(path, x + (a.type === "turn" ? -0.15 : 0.15), startCut, endCut), width: 0.11, color: "yellow", kind: "centre" });
    } else if (isMotor(a.type) !== isMotor(b.type) && !PED_REALM.has(a.type) && !PED_REALM.has(b.type)) {
      const bike = a.type === "bike" || b.type === "bike";
      markings.push({ path: line(), width: bike ? 0.15 : 0.12, color: "white", kind: bike ? "bike" : "edge" });
    } else if ((a.type === "bus" && b.type === "travel") || (a.type === "travel" && b.type === "bus")) {
      markings.push({ path: line(), width: 0.2, color: "white", kind: "bus" });
    }
  }

  // crosswalks & stop bars at each end
  const k = kerbOffsets(st.section, shift);
  const addEnd = (e: EndInfo | undefined, atStart: boolean) => {
    if (!e) return;
    const len = polyLength(path);
    if (len < 8) return;
    if (e.crosswalk) {
      const d = atStart ? 1.6 : len - 1.6;
      const p = slicePath(path, Math.max(0, d - 0.01), Math.min(len, d + 0.01));
      const dir = norm(sub(p[p.length - 1], p[0]));
      const c = p[0];
      const n = perp(dir);
      markings.push({ path: [add(c, scale(n, k.right)), add(c, scale(n, k.left))], width: 3, color: "white", dash: [0.5, 0.6], kind: "crosswalk" });
    }
    if (e.stopBar) {
      const d = atStart ? 3.8 : len - 3.8;
      const p = slicePath(path, Math.max(0, d - 0.01), Math.min(len, d + 0.01));
      const dir = norm(sub(p[p.length - 1], p[0]));
      const n = perp(dir);
      const arriving = offs.filter((o) => (o.strip.type === "travel" || o.strip.type === "bus") && o.strip.dir === (atStart ? -1 : 1));
      if (arriving.length) {
        const lo = Math.min(...arriving.map((o) => o.right));
        const hi = Math.max(...arriving.map((o) => o.left));
        markings.push({ path: [add(p[0], scale(n, lo)), add(p[0], scale(n, hi))], width: 0.45, color: "white", kind: "stop" });
      }
    }
  };
  addEnd(startEnd, true);
  addEnd(endEnd, false);

  const W = sectionWidth(st.section);
  const row = bandRing(st.path, -W / 2 + shift, W / 2 + shift);
  return { id: st.id, trimStart: t0, trimEnd: t1, path, strips, markings, row, length: L };
}

/** ROW band polygon for an arbitrary section along a path (used by cascade checks) */
export function rowBand(path: Vec2[], section: CrossSection): Ring {
  const W = sectionWidth(section);
  const s = section.shift ?? 0;
  return bandRing(path, -W / 2 + s, W / 2 + s);
}

export function edgeOffsets(section: CrossSection) {
  return kerbOffsets(section, section.shift ?? 0);
}

export { dot };
