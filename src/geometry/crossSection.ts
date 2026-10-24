import type { CrossSection, RoadClass, Strip, StripType } from "@/world/types";

export const DEFAULT_WIDTH: Record<StripType, number> = {
  sidewalk: 3.0,
  planting: 1.8,
  parking: 2.4,
  bike: 1.8,
  cycletrack: 2.2,
  buffer: 0.9,
  travel: 3.3,
  bus: 3.6,
  turn: 3.3,
  median: 2.4,
  tram: 3.4,
  shoulder: 2.4,
  plaza: 3.0,
};

/** strips that sit behind the kerb (pedestrian realm) */
export const PED_REALM: ReadonlySet<StripType> = new Set(["sidewalk", "planting", "plaza"]);
/** strips general traffic can drive in */
export const MOTOR: ReadonlySet<StripType> = new Set(["travel", "turn"]);

export const MIN_WIDTH: Record<StripType, number> = {
  sidewalk: 1.5, // ADA minimum clear width 1.2 m + buffer
  planting: 1.0,
  parking: 2.1,
  bike: 1.5,
  cycletrack: 1.8,
  buffer: 0.5,
  travel: 2.9,
  bus: 3.3,
  turn: 2.9,
  median: 1.2,
  tram: 3.0,
  shoulder: 0.6,
  plaza: 1.5,
};

export const sectionWidth = (s: CrossSection) => s.strips.reduce((a, t) => a + t.width, 0);

/** whether a side's pedestrian realm (left = start of the strip list) has a sidewalk */
export function hasSidewalk(s: CrossSection, side: "left" | "right"): boolean {
  const st = side === "left" ? s.strips : [...s.strips].reverse();
  for (const x of st) {
    if (x.type === "sidewalk" || x.type === "plaza") return true;
    if (x.type !== "planting" && x.type !== "buffer") return false;
  }
  return false;
}

/** kerb-to-kerb width */
export const carriagewayWidth = (s: CrossSection) =>
  s.strips.filter((t) => !PED_REALM.has(t.type)).reduce((a, t) => a + t.width, 0);

export function laneCount(s: CrossSection, dir?: 1 | -1) {
  return s.strips.filter((t) => MOTOR.has(t.type) && t.type === "travel" && (dir === undefined || t.dir === dir)).length;
}

export function countType(s: CrossSection, type: StripType) {
  return s.strips.filter((t) => t.type === type).length;
}

/**
 * Lateral offsets for each strip: [left, right] offsets measured to the left
 * of the street path (positive = left of the from->to direction).
 */
export function stripOffsets(s: CrossSection, shift = 0): { strip: Strip; left: number; right: number; index: number }[] {
  const W = sectionWidth(s);
  let x = W / 2 + shift;
  return s.strips.map((strip, index) => {
    const left = x;
    x -= strip.width;
    return { strip, left, right: x, index };
  });
}

/** offsets of the kerb lines (left kerb, right kerb) */
export function kerbOffsets(s: CrossSection, shift = 0): { left: number; right: number; rowLeft: number; rowRight: number } {
  const offs = stripOffsets(s, shift);
  const W = sectionWidth(s);
  const car = offs.filter((o) => !PED_REALM.has(o.strip.type));
  if (!car.length) return { left: shift, right: shift, rowLeft: W / 2 + shift, rowRight: -W / 2 + shift };
  return { left: car[0].left, right: car[car.length - 1].right, rowLeft: W / 2 + shift, rowRight: -W / 2 + shift };
}

const S = (type: StripType, dir: 1 | -1 | 0 = 0, width = DEFAULT_WIDTH[type], trees?: boolean): Strip =>
  trees ? { type, dir, width, trees } : { type, dir, width };

export interface SectionInputs {
  cls: RoadClass;
  oneway: boolean;
  lanes?: number;
  lanesForward?: number;
  lanesBackward?: number;
  centreTurn?: boolean;
  median?: boolean;
  bikeLeft?: "lane" | "track" | null;
  bikeRight?: "lane" | "track" | null;
  parkingLeft?: boolean;
  parkingRight?: boolean;
  sidewalkLeft?: boolean;
  sidewalkRight?: boolean;
  busLanes?: boolean;
  /** total right-of-way width if known (m) */
  row?: number;
  downtown?: boolean;
}

function defaultLanes(cls: RoadClass, oneway: boolean): number {
  switch (cls) {
    case "motorway":
      return 3;
    case "trunk":
      return oneway ? 3 : 4;
    case "primary":
      return oneway ? 3 : 4;
    case "secondary":
      return oneway ? 2 : 4;
    case "tertiary":
      return oneway ? 2 : 2;
    case "motorway_link":
      return 1;
    case "service":
      return oneway ? 1 : 2;
    case "busway":
      return 2;
    default:
      return oneway ? 1 : 2;
  }
}

/** Build a cross-section from mapped attributes, filling gaps with class defaults. */
export function buildSection(inp: SectionInputs): CrossSection {
  const { cls } = inp;
  if (cls === "pedestrian") {
    const w = Math.max(6, inp.row ?? 10);
    return { strips: [S("plaza", 0, w)] };
  }
  const motorwayish = cls === "motorway" || cls === "motorway_link" || cls === "trunk";
  const laneW = motorwayish ? 3.6 : cls === "residential" || cls === "service" || cls === "living" ? 3.0 : 3.3;
  let fwd: number, bwd: number;
  const total = inp.lanes ?? defaultLanes(cls, inp.oneway);
  if (inp.oneway) {
    fwd = Math.max(1, inp.lanesForward ?? total);
    bwd = 0;
  } else {
    let t = total;
    let centre = !!inp.centreTurn;
    if (!centre && t % 2 === 1 && t >= 3) {
      centre = true;
      t -= 1;
    }
    inp.centreTurn = centre;
    fwd = inp.lanesForward ?? Math.max(1, Math.ceil(t / 2));
    bwd = inp.lanesBackward ?? Math.max(1, t - fwd);
  }

  const strips: Strip[] = [];
  // left side (looking from->to): backward lanes are on the left in right-hand traffic
  const swL = inp.sidewalkLeft ?? !motorwayish;
  const swR = inp.sidewalkRight ?? !motorwayish;
  if (swL) strips.push(S("sidewalk"));
  if (swL && inp.downtown && cls !== "service") strips.push(S("planting", 0, 1.5, true));
  if (inp.bikeLeft === "track") strips.push(S("cycletrack", inp.oneway ? 1 : -1), S("buffer", 0, 0.9));
  if (inp.parkingLeft) strips.push(S("parking", inp.oneway ? 1 : -1));
  if (inp.bikeLeft === "lane") strips.push(S("bike", inp.oneway ? 1 : -1));
  if (motorwayish) strips.push(S("shoulder", 0, cls === "motorway_link" ? 1.2 : 1.8));
  if (inp.busLanes && !inp.oneway) strips.push(S("bus", -1));
  for (let i = 0; i < bwd; i++) strips.push(S("travel", -1, laneW));
  if (!inp.oneway) {
    if (inp.median) strips.push(S("median", 0, motorwayish ? 4 : 3.0));
    else if (inp.centreTurn) strips.push(S("turn", 0, 3.3));
  }
  for (let i = 0; i < fwd; i++) strips.push(S("travel", 1, laneW));
  if (inp.busLanes) strips.push(S("bus", 1));
  if (motorwayish) strips.push(S("shoulder", 0, cls === "motorway_link" ? 1.8 : 3.0));
  if (inp.bikeRight === "lane") strips.push(S("bike", 1));
  if (inp.parkingRight) strips.push(S("parking", 1));
  if (inp.bikeRight === "track") strips.push(S("buffer", 0, 0.9), S("cycletrack", 1));
  if (swR && inp.downtown && cls !== "service") strips.push(S("planting", 0, 1.5, true));
  if (swR) strips.push(S("sidewalk"));

  const sec: CrossSection = { strips };
  if (inp.row && inp.row > 0) fitToRow(sec, inp.row);
  return sec;
}

/**
 * Distribute any surplus / deficit between the section and a measured ROW
 * width into the pedestrian realm (sidewalks, then planting), never shrinking
 * strips below their minimums.
 */
export function fitToRow(sec: CrossSection, row: number) {
  const W = sectionWidth(sec);
  let delta = row - W;
  const peds = sec.strips.filter((s) => s.type === "sidewalk");
  if (!peds.length || Math.abs(delta) < 0.2) return sec;
  if (delta > 0) {
    // wide ROW: grow sidewalks up to 6 m, then add / widen planting
    const per = delta / peds.length;
    for (const s of peds) {
      const add = Math.min(per, Math.max(0, 6 - s.width));
      s.width += add;
      delta -= add;
    }
    if (delta > 0.2) {
      const plant = sec.strips.filter((s) => s.type === "planting");
      if (plant.length) plant.forEach((p) => (p.width += delta / plant.length));
      else peds.forEach((s) => (s.width += delta / peds.length));
    }
  } else {
    // narrow ROW: take from planting, then buffers, then sidewalks, in proportion to each strip's slack
    let need = -delta;
    for (const t of ["planting", "buffer", "sidewalk"] as StripType[]) {
      const ss = sec.strips.filter((x) => x.type === t);
      const cap = ss.reduce((a, s) => a + Math.max(0, s.width - (MIN_WIDTH[t] ?? 0)), 0);
      if (cap <= 0) continue;
      const f = Math.min(1, need / cap);
      for (const s of ss) {
        const take = Math.max(0, s.width - (MIN_WIDTH[t] ?? 0)) * f;
        s.width -= take;
        need -= take;
      }
      if (need < 0.01) break;
    }
  }
  for (const s of sec.strips) s.width = Math.round(s.width * 100) / 100;
  return sec;
}

export function cloneSection(s: CrossSection): CrossSection {
  return { strips: s.strips.map((x) => ({ ...x })) };
}

export function describeSection(s: CrossSection): string {
  const parts: string[] = [];
  let run: { t: StripType; n: number } | null = null;
  for (const st of s.strips) {
    if (run && run.t === st.type) run.n++;
    else {
      if (run) parts.push(run.n > 1 ? `${run.n}×${run.t}` : run.t);
      run = { t: st.type, n: 1 };
    }
  }
  if (run) parts.push(run.n > 1 ? `${run.n}×${run.t}` : run.t);
  return `${parts.join(" | ")} (${sectionWidth(s).toFixed(1)} m)`;
}

/** per-lane hourly capacity (veh/h/lane) used by the traffic model */
export function laneCapacity(cls: RoadClass, signalised: boolean): number {
  if (cls === "motorway") return 1900;
  if (cls === "motorway_link") return 1500;
  if (cls === "trunk") return signalised ? 900 : 1600;
  const sat = 1800; // HCM base saturation flow, pc/h/ln
  const gC = cls === "primary" ? 0.5 : cls === "secondary" ? 0.45 : cls === "tertiary" ? 0.42 : 0.38;
  return signalised ? Math.round(sat * gC) : cls === "residential" || cls === "service" || cls === "living" ? 600 : 900;
}
