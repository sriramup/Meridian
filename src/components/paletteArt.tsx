"use client";

// Pictures for the drawing palettes, each drawn from the thing it describes: a street's real cross-
// section, a building form's real massing, a species' size and colour, a surface's map colour,
// and plan diagrams of the district patterns and transit modes.

import { useMemo } from "react";
import { buildSection } from "@/geometry/crossSection";
import { generateMassing, type Typology } from "@/geometry/massing";
import { GRAPHITE, MODEL } from "@/render/theme";
import type { Palette } from "@/state/store";
import { useTheme } from "@/state/theme";
import { speciesOf } from "@/world/species";
import type { Area, AreaType, Building, StripType, Tree, Use } from "@/world/types";
import { sceneThumbnail } from "./library/thumbnail";

const rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const usePalette = () => (useTheme((s) => s.theme) === "dark" ? GRAPHITE : MODEL);

// ---- streets ------------------------------------------------------------------------------

const LABEL: Partial<Record<StripType, string>> = { sidewalk: "Walk", planting: "Trees", parking: "Park", bike: "Bike", cycletrack: "Bike", travel: "Drive", bus: "Bus", turn: "Turn", median: "Median", tram: "Tram" };

/** the street the palette will draw, as a cross-section: every strip at its real width */
export function StreetSection({ cls, bike, trees, height = 50, labels = true }: { cls: Palette["street"]["cls"]; bike: Palette["street"]["bike"]; trees: boolean; height?: number; labels?: boolean }) {
  // the paper palette's street colours read best at this size, on either theme
  const T = MODEL;
  const sec = useMemo(
    () => buildSection({ cls, oneway: false, bikeLeft: bike === "none" ? null : bike, bikeRight: bike === "none" ? null : bike, parkingLeft: cls === "residential", parkingRight: cls === "residential", downtown: true }),
    [cls, bike],
  );
  const W = sec.strips.reduce((s, x) => s + x.width, 0);
  const VW = 196;
  const k = VW / W;
  const road = height - (labels ? 14 : 4);
  let x = 0;
  return (
    <svg viewBox={`0 0 ${VW} ${height}`} className="block w-full" role="img" aria-label={`Cross-section, ${Math.round(W / 0.3048)} ft`}>
      {sec.strips.map((s, i) => {
        const w = s.width * k;
        const x0 = x;
        x += w;
        const kerb = s.type === "sidewalk" || s.type === "planting" ? 0 : 3;
        const fill = rgb(T.strip[s.type] ?? T.strip.travel);
        const cx = x0 + w / 2;
        return (
          <g key={i}>
            <rect x={x0} y={road - 10 + kerb} width={w} height={10 - kerb + 4} fill={fill} />
            {s.type === "planting" && trees && (
              <g>
                <rect x={cx - 0.6} y={road - 18} width={1.2} height={8} fill="var(--color-ink-3)" />
                <circle cx={cx} cy={road - 21} r={Math.min(7, Math.max(4, w * 0.9))} fill={rgb(T.tree)} />
              </g>
            )}
            {s.type === "parking" && <rect x={x0 + w * 0.15} y={road - 11} width={w * 0.7} height={4} rx={1.2} fill="var(--color-ink-3)" opacity={0.55} />}
            {(s.type === "travel" || s.type === "bus") && s.dir !== 0 && (
              <path d={s.dir > 0 ? `M${cx - 3} ${road - 5}h6m-2 -2l2 2l-2 2` : `M${cx + 3} ${road - 5}h-6m2 -2l-2 2l2 2`} stroke="white" strokeOpacity={0.85} strokeWidth={0.9} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            )}
            {i > 0 && (s.type === "travel" || s.type === "turn") && sec.strips[i - 1].type === s.type && <line x1={x0} x2={x0} y1={road - 6} y2={road - 2} stroke="white" strokeOpacity={0.7} strokeWidth={0.6} strokeDasharray="1.2 1.2" />}
            {labels && w > 13 && LABEL[s.type] && (
              <text x={cx} y={height - 1.5} textAnchor="middle" fontSize={6.4} fill="var(--color-ink-4)" fontFamily="var(--font-sans)">
                {LABEL[s.type]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---- buildings, trees, surfaces (the 3D thumbnail renderer) --------------------------------

const SITE = [[[-30, -22], [30, -22], [30, 22], [-30, 22]]] as Building["footprint"];

/** the form the building palette will raise, on a sample 200 × 145 ft block */
export function MassingPreview({ typology, floors, use }: { typology: Typology; floors: number; use: Use }) {
  const T = usePalette();
  const url = useMemo(
    () =>
      sceneThumbnail(
        `massing:${typology}:${floors}:${use}:${T.id}`,
        () => {
          const m = generateMassing(SITE, { typology, floors, use });
          const b = { kind: "building", masses: m.masses, use, style: { facade: "concrete", color: T.building[use] ?? T.building.other }, solids: [] } as unknown as Building;
          return { buildings: [b] };
        },
        236,
        96,
      ),
    [typology, floors, use, T],
  );
  return url ? <img src={url} alt="" className="mx-auto block h-[96px] w-auto max-w-full select-none" draggable={false} /> : null;
}

/** one species at its mature size */
export function SpeciesThumb({ species, size = 34 }: { species: string; size?: number }) {
  const url = useMemo(() => {
    const sp = speciesOf(species);
    if (!sp) return null;
    return sceneThumbnail(`tree:${species}`, () => ({ trees: [{ kind: "tree", id: "t", p: [0, 0], r: sp.r, h: sp.h, species } as Tree] }), size, size);
  }, [species, size]);
  return url ? <img src={url} alt="" className="block shrink-0 select-none" style={{ width: size, height: size }} draggable={false} /> : null;
}

/** a small square of the surface, with shade trees where it gets them */
export function SurfaceThumb({ type }: { type: AreaType }) {
  // the paper palette's surface colours read best at this size, on either theme
  const T = MODEL;
  const url = useMemo(
    () =>
      sceneThumbnail(
        `surface:${type}`,
        () => {
          const poly = [[[-10, -7], [10, -7], [10, 7], [-10, 7]]] as Area["poly"];
          const area = { kind: "area", id: "a", type, poly, paint: T.area[type] } as unknown as Area;
          const leafy = type === "park" || type === "wood" || type === "raingarden";
          const spots: [number, number][] = type === "wood" ? [[-5, -2], [0, 3], [5, -3], [-2, -4], [6, 3]] : [[-5, 1], [4, -2]];
          const trees = leafy ? spots.map((p, i) => ({ kind: "tree", id: `t${i}`, p, r: type === "raingarden" ? 1.4 : 2.6, h: type === "raingarden" ? 3 : 7, species: "live_oak" }) as Tree) : [];
          return { areas: [area], trees };
        },
        84,
        40,
      ),
    [type, T],
  );
  return url ? <img src={url} alt="" className="mx-auto block h-[40px] w-auto select-none" draggable={false} /> : <span className="mb-1 block h-2.5 w-full rounded-[2px]" style={{ background: rgb(T.area[type] ?? [200, 200, 200]) }} />;
}

// ---- district patterns (plan diagrams) -----------------------------------------------------

type Rect = [number, number, number, number, string?];

/** the block pattern each district style lays out, as a small plan */
function districtPlan(style: Palette["district"]["style"]): Rect[] {
  const out: Rect[] = [];
  const B = "b",
    G = "g",
    H = "h";
  const blocks = (cols: number, rows: number, fn: (x: number, y: number, w: number, h: number, i: number, j: number) => void) => {
    const gw = 96 / cols,
      gh = 56 / rows;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) fn(i * gw + 2.5, j * gh + 2.5, gw - 5, gh - 5, i, j);
  };
  switch (style) {
    case "european":
      blocks(4, 2, (x, y, w, h) => {
        out.push([x, y, w, h, B]);
        out.push([x + 4, y + 4, w - 8, h - 8, G]);
      });
      break;
    case "grid":
      blocks(5, 3, (x, y, w, h) => out.push([x, y, w, h, B]));
      break;
    case "midrise":
      blocks(4, 2, (x, y, w, h) => {
        out.push([x, y, w, h * 0.38, B]);
        out.push([x, y + h * 0.62, w, h * 0.38, B]);
      });
      break;
    case "towers":
      blocks(4, 2, (x, y, w, h) => {
        out.push([x, y, w, h, B]);
        out.push([x + w * 0.3, y + h * 0.25, w * 0.4, h * 0.5, H]);
      });
      break;
    case "tod":
      blocks(5, 3, (x, y, w, h, i, j) => out.push([x, y, w, h, i === 2 && j === 1 ? H : Math.abs(i - 2) + Math.abs(j - 1) === 1 ? H : B]));
      break;
    case "civic":
      blocks(4, 3, (x, y, w, h, i, j) => out.push([x, y, w, h, (i === 1 || i === 2) && j === 1 ? G : B]));
      break;
    case "infill":
      blocks(4, 2, (x, y, w, h) => {
        for (let k = 0; k < 6; k++) {
          out.push([x + (k * w) / 6 + 0.4, y, w / 6 - 0.8, h * 0.36, B]);
          out.push([x + (k * w) / 6 + 0.4, y + h * 0.64, w / 6 - 0.8, h * 0.36, B]);
        }
      });
      break;
  }
  return out;
}

/** storey heights (m) of each style's plain blocks and its accent (tall) blocks */
const DISTRICT_H: Record<Palette["district"]["style"], [number, number]> = { european: [16, 16], grid: [13, 13], midrise: [21, 21], towers: [8, 46], tod: [12, 38], civic: [12, 12], infill: [8, 8] };

/** the district style as a small 3D block plan: plain blocks, tall accents and green space */
export function DistrictPlan({ style }: { style: Palette["district"]["style"] }) {
  const url = useMemo(
    () =>
      sceneThumbnail(
        `district:${style}`,
        () => {
          const [low, high] = DISTRICT_H[style];
          const S = 1.4; // plan units → metres
          const buildings: Building[] = [];
          const areas: Area[] = [];
          const ring = (x: number, y: number, w: number, h: number) => [[[x * S, -y * S], [(x + w) * S, -y * S], [(x + w) * S, -(y + h) * S], [x * S, -(y + h) * S]]] as Building["footprint"];
          // courtyards: the block minus its centre, as four bars
          const plan = districtPlan(style);
          const yards = plan.filter((r) => r[4] === "g" && style === "european");
          for (const [x, y, w, h, t] of plan) {
            if (t === "g") {
              areas.push({ kind: "area", id: `g${areas.length}`, type: "park", poly: ring(x, y, w, h), paint: MODEL.area.park } as unknown as Area);
              continue;
            }
            const yard = yards.find((g) => g[0] > x && g[1] > y && g[0] + g[2] < x + w && g[1] + g[3] < y + h);
            const top = t === "h" ? high : low;
            const mass = (poly: Building["footprint"], base: number, topH: number) => ({ poly, base, top: topH, role: "body" });
            const masses = yard
              ? [
                  mass(ring(x, y, w, yard[1] - y), 0, top),
                  mass(ring(x, yard[1] + yard[3], w, y + h - yard[1] - yard[3]), 0, top),
                  mass(ring(x, yard[1], yard[0] - x, yard[3]), 0, top),
                  mass(ring(yard[0] + yard[2], yard[1], x + w - yard[0] - yard[2], yard[3]), 0, top),
                ]
              : style === "towers" && t === "h"
                ? [mass(ring(x, y, w, h), 0, top)]
                : [mass(ring(x, y, w, h), 0, top)];
            buildings.push({ kind: "building", id: `b${buildings.length}`, masses, use: t === "h" ? "office" : "residential", style: { facade: "concrete" } } as unknown as Building);
          }
          // the street grid under it all
          areas.unshift({ kind: "area", id: "ground", type: "plaza", poly: ring(0, 0, 96, 56), paint: [178, 178, 180] } as unknown as Area);
          return { buildings, areas };
        },
        132,
        74,
      ),
    [style],
  );
  return url ? <img src={url} alt="" className="mx-auto block h-[74px] w-auto max-w-full select-none" draggable={false} /> : null;
}

// ---- transit -------------------------------------------------------------------------------

/** a line along streets: its stops, and the lane it runs in */
export function TransitDiagram({ mode, headway }: { mode: Palette["transit"]["mode"]; headway: number }) {
  const T = usePalette();
  const own = mode !== "bus";
  const color = mode === "tram" ? "var(--color-good)" : mode === "brt" ? "var(--color-bad)" : "var(--color-accent)";
  const perHour = Math.round(60 / headway);
  const path = "M8 40 C 40 40, 44 16, 80 16 S 140 30, 172 14 L 232 14";
  return (
    <svg viewBox="0 0 240 56" className="block w-full" aria-hidden>
      <path d={path} stroke={rgb(T.carriageway)} strokeOpacity={0.55} strokeWidth={own ? 13 : 9} fill="none" strokeLinecap="round" />
      {own && <path d={path} stroke={color} strokeOpacity={0.22} strokeWidth={11} fill="none" strokeLinecap="round" />}
      {mode === "tram" ? (
        <>
          <path d={path} stroke={color} strokeWidth={1.2} fill="none" transform="translate(0,-1.8)" />
          <path d={path} stroke={color} strokeWidth={1.2} fill="none" transform="translate(0,1.8)" />
        </>
      ) : (
        <path d={path} stroke={color} strokeWidth={2.4} fill="none" strokeLinecap="round" />
      )}
      {[
        [8, 40],
        [62, 22],
        [118, 22],
        [172, 14],
        [232, 14],
      ].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={3.4} fill="var(--color-paper)" stroke={color} strokeWidth={1.8} />
      ))}
      <text x={236} y={50} textAnchor="end" fontSize={8} fill="var(--color-ink-3)" fontFamily="var(--font-sans)">
        {perHour} {perHour === 1 ? "trip" : "trips"} an hour · {own ? "own lanes" : "in traffic"}
      </text>
    </svg>
  );
}
