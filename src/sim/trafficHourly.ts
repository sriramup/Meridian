// Traffic at any hour of the day from the peak-hour assignments.
//
// The model assigns the AM and PM peak hours (sim/traffic). Any other hour is the nearer peak's
// pattern (morning: inbound-heavy AM; afternoon/evening: PM; blended linearly 10:00–14:00) scaled
// by the typical weekday hourly profile relative to that peak hour, and every link's travel time is
// re-evaluated with the same BPR curve at the scaled volume. So volumes, v/c, speeds, delay,
// congestion and trips all follow the clock. It is not re-equilibrated (routes keep their peak
// pattern), which is the usual planning approximation for off-peak hours.

import { HOURLY_PROFILE } from "./traffic";

const BPR_A = 0.15,
  BPR_B = 4;
/** v/c above which a link counts as congested (as in sim/traffic) */
export const CONGESTED_VC = 0.9;

export interface PeakAssignment {
  period: "am" | "pm";
  flows: ArrayLike<number>;
  vc: ArrayLike<number>;
  time: ArrayLike<number>;
  vehTrips: number;
}

/** what the hourly view needs from a traffic result (the main run, plus the other peak when a day was run) */
export interface TrafficDay {
  period: "am" | "pm";
  flows: ArrayLike<number>;
  vc: ArrayLike<number>;
  time: ArrayLike<number>;
  links: { length: number; capacity: number }[];
  kpi: { vehTrips: number };
  hourly?: number[];
  /** the other peak's assignment (runs made for the day view) */
  alt?: PeakAssignment;
}

export interface TrafficHourKpi {
  /** vehicle trips starting in the hour */
  vehTrips: number;
  /** vehicle-hours of delay over free flow in the hour */
  delayHours: number;
  /** network mean speed, m/s (distance-weighted) */
  avgSpeed: number;
  /** length of links over CONGESTED_VC, m */
  congestedM: number;
  /** vehicle-miles in the hour, as vehicle-metres */
  vehM: number;
}

export interface TrafficHour {
  hour: number;
  flows: Float32Array;
  vc: Float32Array;
  /** congested speed per link, m/s */
  speed: Float32Array;
  kpi: TrafficHourKpi;
}

/** the hour (index into the profile) of each modelled peak */
export const PEAK_HOUR = { am: 8, pm: 17 } as const;

/** the profile's share at a fractional clock hour (each entry is the hour k..k+1, centred at k + ½) */
export function profileAt(h: number, prof: readonly number[] = HOURLY_PROFILE): number {
  const x = (((h - 0.5) % 24) + 24) % 24;
  const k = Math.floor(x),
    f = x - k;
  return prof[k] * (1 - f) + prof[(k + 1) % 24] * f;
}

/** weight of the AM pattern at clock hour h (the PM pattern gets 1 − w) */
export function amWeight(h: number): number {
  const x = ((h % 24) + 24) % 24;
  if (x < 3) return 0; // after midnight: the evening's pattern winding down
  if (x <= 10) return 1;
  if (x >= 14) return 0;
  return (14 - x) / 4;
}

function peaksOf(r: TrafficDay): { am?: PeakAssignment; pm?: PeakAssignment } {
  const main: PeakAssignment = { period: r.period, flows: r.flows, vc: r.vc, time: r.time, vehTrips: r.kpi.vehTrips };
  const out: { am?: PeakAssignment; pm?: PeakAssignment } = { [r.period]: main };
  if (r.alt) out[r.alt.period] = r.alt;
  return out;
}

/** per-link volumes, v/c, speeds and network KPIs at clock hour h */
export function trafficAt(r: TrafficDay, h: number): TrafficHour {
  const prof = r.hourly ?? HOURLY_PROFILE;
  const P = peaksOf(r);
  const wAm = P.am && P.pm ? amWeight(h) : P.am ? 1 : 0;
  const share = profileAt(h, prof);
  // each peak's contribution: its weight × (this hour's volume / its peak hour's volume)
  const parts: [PeakAssignment, number][] = [];
  if (P.am && wAm > 0) parts.push([P.am, (wAm * share) / prof[PEAK_HOUR.am]]);
  if (P.pm && wAm < 1) parts.push([P.pm, ((1 - wAm) * share) / prof[PEAK_HOUR.pm]]);
  const L = r.links.length;
  const flows = new Float32Array(L),
    vc = new Float32Array(L),
    speed = new Float32Array(L);
  let trips = 0;
  for (const [p, s] of parts) trips += p.vehTrips * s;
  let delay = 0,
    vehM = 0,
    vehS = 0,
    congestedM = 0;
  const ref = parts[0]?.[0] ?? P.am ?? P.pm!;
  for (let k = 0; k < L; k++) {
    let f = 0;
    for (const [p, s] of parts) f += p.flows[k] * s;
    // capacity from the reference run (v/c = flow / capacity), else the link's stated capacity
    const cap = ref.vc[k] > 1e-9 && ref.flows[k] > 1e-6 ? ref.flows[k] / ref.vc[k] : Math.max(1, r.links[k].capacity);
    const t0 = ref.time[k] / (1 + BPR_A * Math.pow(ref.vc[k], BPR_B));
    const x = f / cap;
    const t = t0 * (1 + BPR_A * Math.pow(x, BPR_B));
    const len = r.links[k].length;
    flows[k] = f;
    vc[k] = x;
    speed[k] = len / Math.max(0.1, t);
    vehM += f * len;
    vehS += f * t;
    delay += (f * (t - t0)) / 3600;
    if (x > CONGESTED_VC && f > 50) congestedM += len;
  }
  return { hour: h, flows, vc, speed, kpi: { vehTrips: trips, delayHours: delay, avgSpeed: vehS > 0 ? vehM / vehS : 0, congestedM, vehM } };
}

const memo = new WeakMap<object, Map<number, TrafficHour>>();
/** trafficAt, memoised per result in tenth-of-an-hour steps */
export function trafficAtCached(r: TrafficDay, h: number): TrafficHour {
  const q = Math.round((((h % 24) + 24) % 24) * 10) / 10;
  let m = memo.get(r);
  if (!m) memo.set(r, (m = new Map()));
  let hit = m.get(q);
  if (!hit) {
    hit = trafficAt(r, q);
    if (m.size > 48) m.delete(m.keys().next().value!);
    m.set(q, hit);
  }
  return hit;
}
