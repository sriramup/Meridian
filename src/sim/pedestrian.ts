// Pedestrian-activity proxy for prioritising shade and other sidewalk
// investments. There are no footfall counts in the pack, so activity is
// approximated from who is nearby: residents and jobs in buildings, plus people
// boarding and alighting at transit stops, each decayed with walking distance.
// It ranks places relative to each other; it is not a count of pedestrians.

import { polyCentroid } from "@/geometry/polygon";
import { programmeOf } from "@/world/ops/core";
import type { Entity, Street, TransitRoute, TransitStop, Vec2 } from "@/world/types";

/** Gaussian decay length (m): ~2 min walk; contributions beyond 3σ are dropped */
const SIGMA = 120;
const CUTOFF = SIGMA * 3;
const CELL = 100;
/** assumed boardings + alightings per scheduled departure at a stop (no ridership data in the pack) */
const RIDERS_PER_DEPARTURE = 6;

export const PED_ASSUMPTIONS = [
  `Pedestrian activity is a proxy, not a count: residents + jobs in buildings plus ${RIDERS_PER_DEPARTURE} riders per scheduled transit departure at each stop, each decayed with distance (Gaussian, σ = ${SIGMA} m).`,
  "Motorways, trunk roads and their links carry no pedestrian activity; other streets count only where they have a sidewalk or are pedestrian / living streets.",
];

export interface PedSource {
  p: Vec2;
  w: number;
}

export function pedSources(entities: Iterable<Entity>, householdSize?: number): PedSource[] {
  const out: PedSource[] = [];
  const routes = new Map<string, TransitRoute>();
  const stops: TransitStop[] = [];
  for (const e of entities) {
    if (e.kind === "building") {
      const pr = programmeOf(e, householdSize);
      const w = pr.residents + pr.jobs;
      if (w > 0) out.push({ p: polyCentroid(e.footprint), w });
    } else if (e.kind === "route") routes.set(e.id, e);
    else if (e.kind === "stop") stops.push(e);
  }
  for (const s of stops) {
    // departures per hour across every route serving the stop
    const dep = s.routes.reduce((a, id) => {
      const r = routes.get(id);
      return a + (r && r.headway > 0 ? 60 / r.headway : 0);
    }, 0);
    if (dep > 0) out.push({ p: s.p, w: dep * RIDERS_PER_DEPARTURE });
  }
  return out;
}

/** Returns a function giving the distance-weighted activity around a point. */
export function pedIndex(sources: PedSource[]): (p: Vec2) => number {
  const grid = new Map<string, PedSource[]>();
  for (const s of sources) {
    const k = `${Math.floor(s.p[0] / CELL)},${Math.floor(s.p[1] / CELL)}`;
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(s);
  }
  const r = Math.ceil(CUTOFF / CELL);
  return (p) => {
    const ix = Math.floor(p[0] / CELL),
      iy = Math.floor(p[1] / CELL);
    let sum = 0;
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        const l = grid.get(`${ix + dx},${iy + dy}`);
        if (!l) continue;
        for (const s of l) {
          const d2 = (s.p[0] - p[0]) ** 2 + (s.p[1] - p[1]) ** 2;
          if (d2 < CUTOFF * CUTOFF) sum += s.w * Math.exp(-d2 / (2 * SIGMA * SIGMA));
        }
      }
    return sum;
  };
}

const NO_PEDS = new Set(["motorway", "motorway_link", "trunk"]);

/** Whether people on foot use this street: a sidewalk, or a pedestrian / living street. */
export function walkable(s: Street): boolean {
  if (NO_PEDS.has(s.cls)) return false;
  return s.cls === "pedestrian" || s.cls === "living" || s.section.strips.some((x) => x.type === "sidewalk" || x.type === "plaza");
}

/**
 * Shade benefit: exposure above the hour's air temperature (roughly what full
 * shade could remove — shaded exposure tends to air temperature) × activity.
 * The square root keeps a few very dense blocks from swamping everything else.
 */
export const shadeBenefit = (exposureC: number, airC: number, activity: number) => Math.max(0, exposureC - airC) * Math.sqrt(activity);
