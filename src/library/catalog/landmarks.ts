// Landmarks: statues, obelisks, clock towers, monuments, arches, gateways, columns, sculptures,
// flagpoles and observation towers.

import type { Solid } from "@/world/types";
import type { PrimitiveDef } from "../types";
import { C, hexToRgb, shade } from "../geometry/palette";
import { S, box, cyl } from "../geometry/solids";
import { propDef } from "./kinds";
import { statueSolids } from "./parks";
import { bool, choice, color, int, num, opts } from "./params";

const LM = "landmarks" as const;
const D = "Dimensions",
  A = "Appearance";

export const LANDMARKS: PrimitiveDef[] = [
  propDef({
    id: "landmarks.statue",
    name: "Statue",
    category: LM,
    tags: ["sculpture", "monument", "figure", "equestrian statue", "bust", "memorial"],
    description: "Statue on a pedestal: standing figure, equestrian, bust or abstract sculpture.",
    icon: "person-standing",
    params: [choice("kind", "Subject", "standing", opts("standing", "equestrian", "bust", "abstract"), { group: A }), num("figure", "Figure height", 3, { group: D, unit: "m", min: 0.5, max: 30, step: 0.1 }), num("pedestal", "Pedestal size", 2.2, { group: D, unit: "m", min: 0.5, max: 12, step: 0.1 }), color("metal", "Figure colour", "#785e3e", { group: A, swatches: ["#785e3e", "#6e9a8c", "#d8d4cc", "#2a2c30", "#cea854"] }), color("base", "Pedestal colour", "#8c8a88", { group: A })],
    build: (r) => ({ solids: statueSolids(r.n("figure"), r.n("pedestal"), hexToRgb(r.c("metal")), hexToRgb(r.c("base")), r.s("kind") as "standing") }),
  }),
  propDef({
    id: "landmarks.obelisk",
    name: "Obelisk",
    category: LM,
    tags: ["needle", "monument", "memorial", "column"],
    description: "Tapering stone obelisk with a pyramidion on a stepped base.",
    icon: "triangle",
    params: [num("height", "Height", 20, { group: D, unit: "m", min: 2, max: 180, step: 0.5 }), num("base", "Shaft width", 2, { group: D, unit: "m", min: 0.3, max: 18, step: 0.1 }), color("color", "Stone", "#d8ceb8", { group: A })],
    build: (r) => {
      const h = r.n("height"),
        w = r.n("base");
      const c = hexToRgb(r.c("color"));
      const shaft = Math.max(0.5, h * 0.9 - w * 0.6);
      return { solids: [box(0, 0, 0, w * 2.4, w * 2.4, w * 0.3, shade(c, 0.9), "stone"), box(0, 0, w * 0.3, w * 1.7, w * 1.7, w * 0.3, shade(c, 0.95), "stone"), box(0, 0, w * 0.6, w, w, shaft, c, "stone"), S("pyramid", [0, 0, w * 0.6 + shaft], [w, w, Math.max(0.3, h - w * 0.6 - shaft)], shade(c, 1.08), "stone")] };
    },
  }),
  propDef({
    id: "landmarks.clock_tower",
    name: "Clock tower",
    category: LM,
    tags: ["campanile", "bell tower", "town clock", "tower"],
    description: "Freestanding clock / bell tower with four clock faces and a spire or cupola.",
    icon: "clock",
    params: [num("height", "Height", 24, { group: D, unit: "m", min: 5, max: 120, step: 0.5 }), num("width", "Width", 4, { group: D, unit: "m", min: 1.5, max: 20, step: 0.1 }), choice("top", "Top", "spire", opts("spire", "cupola", "flat", "lantern"), { group: A }), color("color", "Masonry", "#a85c48", { group: A }), color("roof", "Roof", "#4e545e", { group: A })],
    build: (r) => {
      const h = r.n("height"),
        w = r.n("width");
      const c = hexToRgb(r.c("color")),
        rc = hexToRgb(r.c("roof"));
      const body = h * 0.72;
      const s: Solid[] = [box(0, 0, 0, w * 1.15, w * 1.15, 1.2, shade(c, 0.9), "stone"), box(0, 0, 1.2, w, w, body - 1.2, c, "stone"), box(0, 0, body, w * 1.1, w * 1.1, 0.4, C.stone, "stone")];
      const fz = body - w * 0.7;
      for (const [x, y, rot] of [[0, w / 2, 0], [0, -w / 2, 0], [w / 2, 0, 90], [-w / 2, 0, 90]] as [number, number, number][]) s.push(S("cylinder", [x, y, fz], [w * 0.7, w * 0.7, 0.06], C.white, "plastic", rot, [90, 0]));
      const t = r.s("top");
      const rest = h - body - 0.4;
      if (t === "spire") s.push(S("pyramid", [0, 0, body + 0.4], [w * 1.05, w * 1.05, rest], rc, "metal"));
      else if (t === "cupola") s.push(cyl(0, 0, body + 0.4, w * 0.8, rest * 0.4, C.white, "stone"), S("hemisphere", [0, 0, body + 0.4 + rest * 0.4], [w * 0.85, w * 0.85, rest * 0.6], rc, "metal"));
      else if (t === "lantern") {
        for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) s.push(box((x * w) / 2.4, (y * w) / 2.4, body + 0.4, w * 0.12, w * 0.12, rest * 0.5, c, "stone"));
        s.push(box(0, 0, body + 0.4 + rest * 0.5, w, w, rest * 0.1, c, "stone"), S("pyramid", [0, 0, body + 0.4 + rest * 0.6], [w, w, rest * 0.4], rc, "metal"));
      } else s.push(box(0, 0, body + 0.4, w * 1.1, w * 1.1, Math.max(0.5, rest), c, "stone"));
      return { solids: s };
    },
  }),
  propDef({
    id: "landmarks.monument",
    name: "Monument / memorial",
    category: LM,
    tags: ["memorial", "war memorial", "cenotaph", "column", "victory column", "plinth"],
    description: "Commemorative monument: a column with a figure, a cenotaph block or a memorial wall.",
    icon: "landmark",
    params: [choice("kind", "Form", "column", opts("column", "cenotaph", "wall", "cairn"), { group: A }), num("height", "Height", 15, { group: D, unit: "m", min: 1, max: 80, step: 0.5 }), num("width", "Width", 3, { group: D, unit: "m", min: 0.5, max: 60, step: 0.1 }), color("color", "Stone", "#d8d4cc", { group: A })],
    build: (r) => {
      const h = r.n("height"),
        w = r.n("width");
      const c = hexToRgb(r.c("color"));
      const k = r.s("kind");
      const base: Solid[] = [box(0, 0, 0, w * 2.5, w * 2.5, 0.3, shade(c, 0.9), "stone"), box(0, 0, 0.3, w * 2, w * 2, 0.3, shade(c, 0.95), "stone")];
      if (k === "column") return { solids: [...base, box(0, 0, 0.6, w * 1.4, w * 1.4, h * 0.15, c, "stone"), cyl(0, 0, 0.6 + h * 0.15, w * 0.8, h * 0.7, c, "stone"), box(0, 0, 0.6 + h * 0.85, w, w, h * 0.04, c, "stone"), ...statueSolids(h * 0.11, w * 0.4, C.bronze, c).slice(3).map((q) => ({ ...q, at: [q.at[0], q.at[1], q.at[2] + h * 0.89] as [number, number, number] }))] };
      if (k === "wall") return { solids: [box(0, 0, 0, w * 6, 0.8, h * 0.2, hexToRgb("#2a2c30"), "stone"), box(0, -1.5, 0, w * 6, 2, 0.1, shade(c, 0.9), "stone")] };
      if (k === "cairn") return { solids: [S("cone", [0, 0, 0], [w * 2, w * 2, h * 0.3], C.granite, "stone"), S("sphere", [0, 0, h * 0.2], [w, w, h * 0.12], C.stone, "stone")] };
      return { solids: [...base, box(0, 0, 0.6, w, w * 0.6, h * 0.5, c, "stone"), box(0, 0, 0.6 + h * 0.5, w * 1.1, w * 0.7, h * 0.05, c, "stone")] };
    },
  }),
  propDef({
    id: "landmarks.arch",
    name: "Triumphal arch / gateway",
    category: LM,
    tags: ["arch", "gate", "gateway", "triumphal arch", "paifang", "torii", "entrance arch", "welcome sign"],
    description: "Monumental arch or gateway spanning a path: masonry triumphal arch, Asian paifang / torii, or a modern portal.",
    icon: "door-open",
    siting: { carriageway: true },
    params: [choice("style", "Style", "triumphal", opts("triumphal", "torii", "portal"), { group: A }), num("span", "Opening width", 8, { group: D, unit: "m", min: 2, max: 40, step: 0.5 }), num("height", "Height", 14, { group: D, unit: "m", min: 3, max: 60, step: 0.5 }), num("depth", "Depth", 5, { group: D, unit: "m", min: 0.5, max: 25, step: 0.5 }), color("color", "Colour", "#e2d6be", { group: A, swatches: ["#e2d6be", "#c43a30", "#3e4248", "#b8b0a4"] })],
    build: (r) => {
      const sp = r.n("span"),
        h = r.n("height"),
        d = r.n("depth");
      const c = hexToRgb(r.c("color"));
      const st = r.s("style");
      if (st === "torii") {
        const p = Math.max(0.4, sp * 0.08);
        return { solids: [cyl(-sp / 2, 0, 0, p, h * 0.85, c, "wood"), cyl(sp / 2, 0, 0, p, h * 0.85, c, "wood"), box(0, 0, h * 0.68, sp + p * 2, p * 0.8, p * 0.7, c, "wood"), S("box", [0, 0, h * 0.85], [sp * 1.4, p * 1.2, p * 0.9], C.black, "wood"), box(0, 0, h * 0.85 - 0.1, sp * 1.3, p, p * 0.6, c, "wood")] };
      }
      if (st === "portal") return { solids: [box(-sp / 2 - 0.5, 0, 0, 1, d, h, c, "metal"), box(sp / 2 + 0.5, 0, 0, 1, d, h, c, "metal"), box(0, 0, h, sp + 2, d, 1, c, "metal")] };
      const pier = Math.max(1.5, sp * 0.45);
      const top = h * 0.82;
      const ah = Math.max(2.5, top - sp / 2 - 1.5);
      const zt = Math.min(top - 0.3, ah + sp / 2 + 0.5);
      const s: Solid[] = [box(-sp / 2 - pier / 2, 0, 0, pier, d, top, c, "stone"), box(sp / 2 + pier / 2, 0, 0, pier, d, top, c, "stone"), box(0, 0, zt, sp + 0.1, d, top - zt, c, "stone"), box(0, 0, top, sp + pier * 2 + 0.6, d + 0.6, h * 0.04, shade(c, 1.05), "stone"), box(0, 0, top + h * 0.04, sp + pier * 2, d, h - top - h * 0.04, c, "stone")];
      // the arch: slices filling between the semicircular intrados and the attic
      const n = 14;
      for (let k = 0; k < n; k++) {
        const x = -sp / 2 + (sp * (k + 0.5)) / n;
        const zb = ah + Math.sqrt(Math.max(0, (sp / 2) ** 2 - x * x));
        if (zt - zb > 0.05) s.push(box(x, 0, zb, sp / n + 0.02, d, zt - zb, c, "stone"));
      }
      return { solids: s };
    },
  }),
  propDef({
    id: "landmarks.flagpole",
    name: "Flagpole",
    category: LM,
    tags: ["flag", "flag mast", "banner pole"],
    description: "Flagpole with a flag; ground-set poles are typically 20–50 ft.",
    icon: "flag",
    params: [num("height", "Height", 10, { group: D, unit: "m", min: 3, max: 60, step: 0.5 }), int("count", "Poles", 1, { group: D, min: 1, max: 9 }), color("flag", "Flag colour", "#3c5aa0", { group: A })],
    build: (r) => {
      const n = r.n("count"),
        h = r.n("height");
      const s: Solid[] = [];
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * 3;
        s.push(cyl(x, 0, 0, 0.14, h, C.steel, "metal"), S("sphere", [x, 0, h], [0.22, 0.22, 0.22], C.brass, "metal"), box(x + h * 0.09, 0, h - h * 0.13, h * 0.18, 0.03, h * 0.12, hexToRgb(r.c("flag")), "fabric"));
      }
      return { solids: s };
    },
  }),
  propDef({
    id: "landmarks.sculpture",
    name: "Public art sculpture",
    category: LM,
    tags: ["public art", "abstract sculpture", "installation", "art piece", "ring", "monolith"],
    description: "Abstract public-art piece: ring, stacked cubes, monolith or sphere.",
    icon: "shapes",
    params: [choice("form", "Form", "ring", opts("ring", "stack", "monolith", "sphere", "arc"), { group: A }), num("size", "Size", 5, { group: D, unit: "m", min: 0.5, max: 40, step: 0.1 }), color("color", "Colour", "#c43a30", { group: A, swatches: ["#c43a30", "#e8c440", "#3c6ca8", "#d8d4cc", "#2a2c30", "#cea854"] }), bool("plinth", "Plinth", true, { group: A })],
    build: (r) => {
      const z = r.n("size");
      const c = hexToRgb(r.c("color"));
      const s: Solid[] = r.b("plinth") ? [box(0, 0, 0, z * 0.6, z * 0.6, 0.5, C.granite, "stone")] : [];
      const b = r.b("plinth") ? 0.5 : 0;
      switch (r.s("form")) {
        case "stack":
          for (let i = 0; i < 4; i++) s.push(S("box", [0, 0, b + i * z * 0.22], [z * 0.3, z * 0.3, z * 0.22], i % 2 ? c : shade(c, 0.8), "metal", i * 22));
          break;
        case "monolith":
          s.push(box(0, 0, b, z * 0.25, z * 0.08, z, c, "stone"));
          break;
        case "sphere":
          s.push(S("sphere", [0, 0, b], [z * 0.6, z * 0.6, z * 0.6], c, "metal"));
          break;
        case "arc":
          s.push(S("torus", [0, (0.3 + z * 0.06) / 2, b], [z, z, 0.3 + z * 0.06], c, "metal", 0, [90, 0]));
          break;
        default:
          s.push(S("torus", [0, (0.4 + z * 0.08) / 2, b + z / 2], [z, z, 0.4 + z * 0.08], c, "metal", 0, [90, 0]));
      }
      return { solids: s };
    },
  }),
  propDef({
    id: "landmarks.observation_tower",
    name: "Observation tower",
    category: LM,
    tags: ["lookout tower", "viewing tower", "tv tower", "space needle", "telecom tower"],
    description: "Tall concrete shaft with an observation pod and antenna.",
    icon: "tower-control",
    params: [num("height", "Height", 120, { group: D, unit: "m", min: 15, max: 600, step: 1 }), num("pod", "Pod diameter", 24, { group: D, unit: "m", min: 4, max: 80, step: 0.5 }), color("color", "Colour", "#e2e0da", { group: A })],
    build: (r) => {
      const h = r.n("height"),
        p = r.n("pod");
      const c = hexToRgb(r.c("color"));
      return { solids: [S("cone", [0, 0, 0], [p * 0.5, p * 0.5, h * 1.25], c, "concrete"), cyl(0, 0, h * 0.78, p, p * 0.18, c, "concrete"), cyl(0, 0, h * 0.78 + p * 0.18, p * 0.96, p * 0.12, [150, 178, 200], "glass"), S("hemisphere", [0, 0, h * 0.78 + p * 0.3], [p, p, p * 0.15], c, "concrete"), cyl(0, 0, h * 0.85, 0.8, h * 0.15, C.steel, "metal")] };
    },
  }),
];
