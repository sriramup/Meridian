// Declarative cross-section edits (pure functions over a CrossSection).

import { cloneSection, DEFAULT_WIDTH, fitToRow, laneCount, MIN_WIDTH, PED_REALM, sectionWidth } from "@/geometry/crossSection";
import type { CrossSection, Strip, StripType } from "../types";

export type Side = "both" | "left" | "right";

export type SectionEdit =
  | { op: "add_lanes"; count?: number; dir?: "both" | "forward" | "backward"; width?: number }
  | { op: "remove_lanes"; count?: number; dir?: "both" | "forward" | "backward" }
  | { op: "set_lane_width"; width: number }
  | { op: "set_sidewalk"; width: number; side?: Side }
  | { op: "widen_sidewalks"; by: number; side?: Side }
  | { op: "add_bike_lanes"; kind?: "lane" | "track" | "two_way_track"; side?: Side; width?: number }
  | { op: "remove_bike_lanes"; side?: Side }
  | { op: "remove_parking"; side?: Side }
  | { op: "add_parking"; side?: Side }
  | { op: "add_median"; width?: number }
  | { op: "remove_median" }
  | { op: "add_planting"; width?: number; side?: Side }
  | { op: "add_raingardens"; width?: number; side?: Side; only_parking?: boolean }
  | { op: "bus_lanes"; on: boolean; mode?: "convert" | "add" }
  | { op: "tram"; on: boolean; mode?: "convert" | "add" }
  | { op: "set_oneway"; oneway: boolean }
  | { op: "pedestrianize" }
  | { op: "reopen"; lanes?: number }
  | { op: "replace"; strips: { type: StripType; width: number; dir?: 1 | -1 | 0 }[] };

export interface EditOutcome {
  section: CrossSection;
  oneway: boolean;
  closed: boolean;
  notes: string[];
}

const isTravel = (s: Strip) => s.type === "travel";
const sideIdx = (strips: Strip[], side: "left" | "right") => {
  // index range of the side's pedestrian realm
  const idx: number[] = [];
  if (side === "left") {
    for (let i = 0; i < strips.length && PED_REALM.has(strips[i].type); i++) idx.push(i);
  } else {
    for (let i = strips.length - 1; i >= 0 && PED_REALM.has(strips[i].type); i--) idx.push(i);
  }
  return idx;
};
const sides = (s?: Side): ("left" | "right")[] => (s === "left" ? ["left"] : s === "right" ? ["right"] : ["left", "right"]);

/** index just inside the kerb on a side (where kerbside strips are inserted) */
function kerbInsert(strips: Strip[], side: "left" | "right") {
  if (side === "left") {
    let i = 0;
    while (i < strips.length && PED_REALM.has(strips[i].type)) i++;
    return i;
  }
  let i = strips.length;
  while (i > 0 && PED_REALM.has(strips[i - 1].type)) i--;
  return i;
}

export function applySectionEdits(section0: CrossSection, oneway0: boolean, closed0: boolean, edits: SectionEdit[], opts: { keepRowWidth?: boolean } = {}): EditOutcome {
  const section = cloneSection(section0);
  section.shift = section0.shift;
  let oneway = oneway0;
  let closed = closed0;
  const notes: string[] = [];
  const W0 = sectionWidth(section0);
  const S = section.strips;
  const laneW = () => S.find(isTravel)?.width ?? 3.3;

  for (const e of edits) {
    switch (e.op) {
      case "add_lanes": {
        const n = e.count ?? 1;
        const dirs: (1 | -1)[] = oneway ? [1] : e.dir === "forward" ? [1] : e.dir === "backward" ? [-1] : [1, -1];
        for (const d of dirs)
          for (let k = 0; k < n; k++) {
            const w = e.width ?? laneW();
            if (d === 1) {
              let at = -1;
              S.forEach((s, i) => s.type === "travel" && s.dir === 1 && (at = i));
              if (at < 0) at = S.findIndex((s) => s.type === "median" || s.type === "turn");
              S.splice(at + 1, 0, { type: "travel", dir: 1, width: w });
            } else {
              const at = S.findIndex((s) => s.type === "travel" && s.dir === -1);
              S.splice(at < 0 ? kerbInsert(S, "left") : at, 0, { type: "travel", dir: -1, width: w });
            }
          }
        notes.push(`+${n} travel lane${n > 1 ? "s" : ""}${dirs.length > 1 ? " each direction" : ""}`);
        break;
      }
      case "remove_lanes": {
        const n = e.count ?? 1;
        const dirs: (1 | -1)[] = oneway ? [1] : e.dir === "forward" ? [1] : e.dir === "backward" ? [-1] : [1, -1];
        let removed = 0;
        for (const d of dirs)
          for (let k = 0; k < n; k++) {
            const lanes = S.map((s, i) => [s, i] as const).filter(([s]) => s.type === "travel" && s.dir === d);
            if (lanes.length <= 1) {
              notes.push(`kept the last ${d === 1 ? "forward" : "backward"} lane`);
              break;
            }
            // remove the kerbside lane in that direction
            const [, i] = d === 1 ? lanes[lanes.length - 1] : lanes[0];
            S.splice(i, 1);
            removed++;
          }
        notes.push(`−${removed} travel lane${removed === 1 ? "" : "s"}`);
        break;
      }
      case "set_lane_width": {
        for (const s of S) if (s.type === "travel" || s.type === "turn") s.width = Math.max(MIN_WIDTH.travel, e.width);
        notes.push(`lanes set to ${e.width.toFixed(1)} m`);
        break;
      }
      case "set_sidewalk":
      case "widen_sidewalks": {
        for (const sd of sides(e.side)) {
          const idx = sideIdx(S, sd).filter((i) => S[i].type === "sidewalk");
          if (!idx.length) {
            const w = e.op === "set_sidewalk" ? e.width : DEFAULT_WIDTH.sidewalk + e.by;
            if (sd === "left") S.unshift({ type: "sidewalk", dir: 0, width: w });
            else S.push({ type: "sidewalk", dir: 0, width: w });
            continue;
          }
          const s = S[idx[0]];
          s.width = Math.max(MIN_WIDTH.sidewalk, e.op === "set_sidewalk" ? e.width : s.width + e.by);
        }
        notes.push(e.op === "set_sidewalk" ? `sidewalks ${e.width.toFixed(1)} m` : `sidewalks ${e.by >= 0 ? "+" : ""}${e.by.toFixed(1)} m`);
        break;
      }
      case "add_bike_lanes": {
        const kind = e.kind ?? "track";
        if (kind === "two_way_track") {
          const sd = e.side === "left" ? "left" : "right";
          const at = kerbInsert(S, sd);
          const strips: Strip[] = [{ type: "cycletrack", dir: 0, width: e.width ?? 3.6 }, { type: "buffer", dir: 0, width: 0.9 }];
          S.splice(at, 0, ...(sd === "right" ? strips.reverse() : strips));
          notes.push(`two-way protected cycle track (${(e.width ?? 3.6).toFixed(1)} m + 0.9 m buffer) on the ${sd} side`);
        } else {
          for (const sd of sides(oneway && !e.side ? "right" : e.side)) {
            const at = kerbInsert(S, sd);
            const d: 1 | -1 = sd === "right" ? 1 : oneway ? 1 : -1;
            const strips: Strip[] = kind === "track" ? [{ type: "cycletrack", dir: d, width: e.width ?? 2.1 }, { type: "buffer", dir: 0, width: 0.9 }] : [{ type: "bike", dir: d, width: e.width ?? 1.8 }];
            // bike lanes sit between parking and traffic; tracks at the kerb
            let pos = at;
            if (kind === "lane") {
              if (sd === "left") while (pos < S.length && (S[pos].type === "parking" || S[pos].type === "cycletrack" || S[pos].type === "buffer")) pos++;
              else while (pos > 0 && (S[pos - 1].type === "parking" || S[pos - 1].type === "cycletrack" || S[pos - 1].type === "buffer")) pos--;
            }
            S.splice(pos, 0, ...(sd === "right" ? strips.slice().reverse() : strips));
          }
          notes.push(kind === "track" ? "protected cycle tracks" : "painted bike lanes");
        }
        break;
      }
      case "remove_bike_lanes": {
        for (let i = S.length - 1; i >= 0; i--) if (S[i].type === "bike" || S[i].type === "cycletrack") S.splice(i, 1);
        for (let i = S.length - 1; i >= 0; i--) if (S[i].type === "buffer") S.splice(i, 1);
        notes.push("bike facilities removed");
        break;
      }
      case "remove_parking": {
        let n = 0;
        for (const sd of sides(e.side)) {
          const range = sd === "left" ? S.map((_, i) => i).slice(0, Math.ceil(S.length / 2)) : S.map((_, i) => i).slice(Math.floor(S.length / 2));
          for (let k = range.length - 1; k >= 0; k--) {
            const i = range[k];
            if (S[i]?.type === "parking") {
              S.splice(i, 1);
              n++;
            }
          }
        }
        notes.push(n ? `removed ${n} parking lane${n > 1 ? "s" : ""}` : "no on-street parking to remove");
        break;
      }
      case "add_parking": {
        for (const sd of sides(e.side)) {
          const at = kerbInsert(S, sd);
          S.splice(at, 0, { type: "parking", dir: sd === "right" ? 1 : -1, width: 2.4 });
        }
        notes.push("on-street parking added");
        break;
      }
      case "add_median": {
        const i = S.findIndex((s) => s.type === "turn" || s.type === "median");
        if (i >= 0) S.splice(i, 1, { type: "median", dir: 0, width: e.width ?? 3 });
        else {
          const f = S.findIndex((s) => s.type === "travel" && s.dir === 1);
          if (f >= 0 && !oneway) S.splice(f, 0, { type: "median", dir: 0, width: e.width ?? 3 });
        }
        notes.push(`planted median ${(e.width ?? 3).toFixed(1)} m`);
        break;
      }
      case "remove_median": {
        for (let i = S.length - 1; i >= 0; i--) if (S[i].type === "median") S.splice(i, 1);
        notes.push("median removed");
        break;
      }
      case "add_planting": {
        for (const sd of sides(e.side)) {
          const idx = sideIdx(S, sd);
          const hasPlant = idx.some((i) => S[i].type === "planting");
          if (hasPlant) idx.filter((i) => S[i].type === "planting").forEach((i) => (S[i].width = Math.max(S[i].width, e.width ?? 2)));
          else {
            const at = kerbInsert(S, sd);
            S.splice(at, 0, { type: "planting", dir: 0, width: e.width ?? 2, trees: true });
          }
        }
        notes.push(`planting strips ${(e.width ?? 2).toFixed(1)} m`);
        break;
      }
      case "add_raingardens": {
        // kerbside bioretention, in order of preference: rebuild planting strips as rain gardens; else turn the
        // parking lane into curb-extension bioswales (keeps the ROW); else add a strip at the kerb
        let inParking = 0;
        for (const sd of sides(e.side)) {
          const idx = sideIdx(S, sd).filter((i) => S[i].type === "planting");
          if (idx.length) {
            // existing strips keep their width (and the ROW) unless a width is asked for
            idx.forEach((i) => (S[i] = { ...S[i], width: e.width ? Math.max(S[i].width, e.width) : S[i].width, bio: true }));
            continue;
          }
          const park = sd === "left" ? S.findIndex((x) => x.type === "parking") : S.map((x) => x.type).lastIndexOf("parking");
          const parkOnSide = park >= 0 && (sd === "left" ? park < S.findIndex((x) => x.type === "travel" || x.type === "bus") : park > S.map((x) => x.type).lastIndexOf("travel"));
          if (parkOnSide) {
            S[park] = { type: "planting", dir: 0, width: S[park].width, trees: true, bio: true };
            inParking++;
          } else if (!e.only_parking) S.splice(kerbInsert(S, sd), 0, { type: "planting", dir: 0, width: e.width ?? 1.8, trees: true, bio: true });
        }
        notes.push(`rain gardens (bioretention) ${(e.width ?? 1.8).toFixed(1)} m${inParking ? `; ${inParking} parking lane${inParking > 1 ? "s" : ""} converted to curb-extension bioswales` : ""}`);
        break;
      }
      case "bus_lanes": {
        if (!e.on) {
          for (const s of S) if (s.type === "bus") s.type = "travel";
          notes.push("bus lanes returned to general traffic");
          break;
        }
        const dirs: (1 | -1)[] = oneway ? [1] : [1, -1];
        for (const d of dirs) {
          if (S.some((s) => s.type === "bus" && s.dir === d)) continue;
          const lanes = S.map((s, i) => [s, i] as const).filter(([s]) => s.type === "travel" && s.dir === d);
          if ((e.mode ?? "convert") === "convert" && lanes.length >= 2) {
            const [, i] = d === 1 ? lanes[lanes.length - 1] : lanes[0];
            S[i] = { type: "bus", dir: d, width: Math.max(3.4, S[i].width) };
            notes.push(`kerbside ${d === 1 ? "forward" : "backward"} lane → dedicated bus lane`);
          } else {
            const at = d === 1 ? (lanes.length ? lanes[lanes.length - 1][1] + 1 : kerbInsert(S, "right")) : lanes.length ? lanes[0][1] : kerbInsert(S, "left");
            S.splice(at, 0, { type: "bus", dir: d, width: 3.6 });
            notes.push(`added a ${d === 1 ? "forward" : "backward"} bus lane (only one general lane — widening)`);
          }
        }
        break;
      }
      case "tram": {
        if (!e.on) {
          for (const s of S) if (s.type === "tram") s.type = "travel";
          notes.push("tram lanes returned to traffic");
          break;
        }
        const dirs: (1 | -1)[] = oneway ? [1] : [1, -1];
        for (const d of dirs) {
          if (S.some((s) => s.type === "tram" && s.dir === d)) continue;
          const lanes = S.map((s, i) => [s, i] as const).filter(([s]) => s.type === "travel" && s.dir === d);
          if ((e.mode ?? "convert") === "convert" && lanes.length >= 2) {
            // inner lane (next to centre) becomes the tramway
            const [, i] = d === 1 ? lanes[0] : lanes[lanes.length - 1];
            S[i] = { type: "tram", dir: d, width: Math.max(3.3, S[i].width) };
          } else {
            const centre = S.findIndex((s) => s.type === "travel" && s.dir === 1);
            S.splice(centre < 0 ? Math.floor(S.length / 2) : centre, 0, { type: "tram", dir: d, width: 3.4 });
          }
        }
        notes.push(oneway ? "dedicated tram lane" : "dedicated tram lanes both directions (centre-running)");
        break;
      }
      case "set_oneway": {
        if (e.oneway === oneway) break;
        const travel = S.filter((s) => s.type === "travel");
        if (!e.oneway) {
          // one-way → two-way: split lanes, backward lanes on the left
          const n = Math.max(2, travel.length);
          const back = Math.floor(n / 2);
          const w = laneW();
          const start = S.findIndex((s) => s.type === "travel");
          const firstNonTravel = S.slice(start).findIndex((s) => s.type !== "travel");
          const end = firstNonTravel < 0 ? S.length : start + firstNonTravel;
          const newLanes: Strip[] = [];
          for (let i = 0; i < back; i++) newLanes.push({ type: "travel", dir: -1, width: w });
          for (let i = 0; i < n - back; i++) newLanes.push({ type: "travel", dir: 1, width: w });
          S.splice(start, end - start, ...newLanes);
          // parking / bike on the left now serve the backward direction
          for (let i = 0; i < start; i++) if (S[i].dir === 1 && !PED_REALM.has(S[i].type)) S[i].dir = -1;
          if (travel.length < 2) notes.push("added a lane so both directions have one");
          notes.push(`converted to two-way (${n - back} + ${back} lanes)`);
        } else {
          for (const s of S) if (s.type === "travel" || s.type === "bus" || s.type === "bike" || s.type === "parking") s.dir = 1;
          for (let i = S.length - 1; i >= 0; i--) if (S[i].type === "turn") S.splice(i, 1);
          notes.push(`converted to one-way (${laneCount({ strips: S }, 1)} lanes)`);
        }
        oneway = e.oneway;
        break;
      }
      case "pedestrianize": {
        const kerbW = S.filter((s) => !PED_REALM.has(s.type)).reduce((a, s) => a + s.width, 0);
        const left = S.filter((s, i) => PED_REALM.has(s.type) && i < S.findIndex((x) => !PED_REALM.has(x.type)));
        const right = S.filter((s, i) => PED_REALM.has(s.type) && i > S.length - 1 - S.slice().reverse().findIndex((x) => !PED_REALM.has(x.type)));
        S.splice(0, S.length, ...left, { type: "plaza", dir: 0, width: Math.max(3, kerbW) }, ...right);
        closed = true;
        notes.push(`carriageway (${kerbW.toFixed(1)} m) converted to a pedestrian street`);
        break;
      }
      case "reopen": {
        const i = S.findIndex((s) => s.type === "plaza");
        if (i >= 0) {
          const w = S[i].width;
          const n = Math.max(oneway ? 1 : 2, e.lanes ?? Math.floor(w / 3.3));
          const lanes: Strip[] = [];
          for (let k = 0; k < n; k++) lanes.push({ type: "travel", dir: oneway ? 1 : k < n / 2 ? -1 : 1, width: w / n });
          S.splice(i, 1, ...lanes);
        }
        closed = false;
        notes.push("reopened to traffic");
        break;
      }
      case "replace": {
        S.splice(0, S.length, ...e.strips.map((s) => ({ type: s.type, width: s.width, dir: s.dir ?? 0 })));
        notes.push("cross-section replaced");
        break;
      }
    }
  }
  if (opts.keepRowWidth) {
    const before = sectionWidth(section);
    fitToRow(section, W0);
    const left = sectionWidth(section) - W0;
    if (left > 0.1) notes.push(`right-of-way could not be fully held: +${left.toFixed(1)} m beyond the existing ${W0.toFixed(1)} m (every strip at its minimum width)`);
    else if (Math.abs(before - W0) > 0.2) notes.push(`right-of-way width held (${before > W0 ? "planting / sidewalks narrowed to fit" : "surplus given to sidewalks"})`);
  }
  for (const s of S) s.width = Math.round(s.width * 100) / 100;
  return { section, oneway, closed, notes };
}
