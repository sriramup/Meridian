// Recreation: playgrounds and sports facilities at regulation dimensions (field markings, goals,
// nets and hoops as solids over a pitch area), skate parks, pools, dog parks and fitness areas.

import type { AreaType, Solid, Vec2 } from "@/world/types";
import type { PrimitiveDef } from "../types";
import { frameOf, polyToWorld } from "../geometry/frame";
import { C, hexToRgb, shade } from "../geometry/palette";
import { S, beam, box, cyl, moveSolids, type RGB } from "../geometry/solids";
import { benchSolids } from "../geometry/props";
import { propDef } from "./kinds";
import { Out } from "./make";
import { rectL } from "./decor";
import { bool, choice, color, int, num, opts, reader } from "./params";
import type { ParamSpec } from "../types";

const RC = "recreation" as const;
const D = "Dimensions",
  A = "Appearance";

// ---------------------------------------------------------------- playgrounds

export type PlayKind = "toddler" | "school" | "adventure" | "nature" | "inclusive";

/** a playground of equipment fitted in a square of side `size` (m), with safety surfacing */
export function playgroundSolids(kind: PlayKind, size = 20, accent: RGB = C.orange, surface: RGB = C.rubber): Solid[] {
  const k = Math.max(0.5, size / 20);
  const s: Solid[] = [box(0, 0, 0, size, size, 0.05, kind === "nature" ? C.woodLight : surface, kind === "nature" ? "wood" : "plastic")];
  const post = kind === "nature" ? C.wood : C.steel;
  const deck = (x: number, y: number, h: number, w = 2.4) => {
    s.push(box(x, y, h, w, w, 0.12, shade(accent, 0.9), "plastic"));
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) s.push(box(x + dx * (w / 2 - 0.1), y + dy * (w / 2 - 0.1), 0, 0.12, 0.12, h + 1.0, post, "metal"));
    s.push(S("pyramid", [x, y, h + 1.0], [w + 0.3, w + 0.3, 1.0], accent, "plastic"));
  };
  const slide = (x: number, y: number, h: number, dir: number) => s.push(S("box", [x + dir * h * 0.9, y, h / 2], [h * 2.1, 0.7, 0.08], C.yellow, "plastic", 0, [0, dir * 28]));
  const swings = (x: number, y: number, seats: number) => {
    const L = seats * 1.4 + 0.6;
    s.push(S("box", [x, y, 0], [0.1, 0.1, 2.6], post, "metal", 0, [12, 0]), S("box", [x, y, 0], [0.1, 0.1, 2.6], post, "metal", 0, [-12, 0]));
    s.push(S("box", [x + L, y, 0], [0.1, 0.1, 2.6], post, "metal", 0, [12, 0]), S("box", [x + L, y, 0], [0.1, 0.1, 2.6], post, "metal", 0, [-12, 0]));
    s.push(beam([x, y], [x + L, y], 2.5, 0.12, 0.12, post, "metal"));
    for (let i = 0; i < seats; i++) {
      const sx = x + 0.9 + i * 1.4;
      s.push(box(sx - 0.25, y, 0.45, 0.02, 0.02, 2.05, C.steelDark, "metal"), box(sx + 0.25, y, 0.45, 0.02, 0.02, 2.05, C.steelDark, "metal"), box(sx, y, 0.42, 0.55, 0.2, 0.05, C.black, "plastic"));
    }
  };
  switch (kind) {
    case "toddler":
      deck(-2 * k, 1 * k, 0.9);
      slide(-2 * k + 1.2, 1 * k, 0.9, 1);
      for (const [x, y, c] of [[3 * k, -3 * k, C.red], [4.5 * k, -1 * k, C.blue], [-4 * k, -4 * k, C.green]] as [number, number, RGB][]) s.push(cyl(x, y, 0, 0.12, 0.5, C.steelDark, "metal"), S("sphere", [x, y, 0.4], [0.9, 0.4, 0.5], c, "plastic"));
      s.push(box(-5 * k, 5 * k, 0, 3, 3, 0.3, C.sand, "stone"));
      break;
    case "nature":
      for (let i = 0; i < 6; i++) s.push(S("cylinder", [(i - 2.5) * 2.2 * k, -3 * k, 0], [0.5, 0.5, 0.3 + (i % 3) * 0.25], C.wood, "wood"));
      s.push(S("cylinder", [-3 * k, 3 * k, 0.3], [0.6, 0.6, 7], C.wood, "wood", 15, [0, 90]));
      s.push(S("cone", [4 * k, 3 * k, 0], [3, 3, 2.6], C.wood, "wood"), box(0, 5 * k, 0, 4 * k, 2, 0.3, C.sand, "stone"));
      swings(-6 * k, -7 * k, 2);
      break;
    default: {
      // school / adventure / inclusive: multi-deck tower with bridge, slides, swings, climbing net
      const h1 = kind === "adventure" ? 2.4 : 1.5,
        h2 = kind === "adventure" ? 3.6 : 2.1;
      deck(-3 * k, 2 * k, h1);
      deck(2 * k, 2 * k, h2);
      s.push(beam([-3 * k + 1.2, 2 * k], [2 * k - 1.2, 2 * k], (h1 + h2) / 2, 0.9, 0.1, C.wood, "wood"));
      slide(2 * k + 1.2, 2 * k, h2, 1);
      slide(-3 * k - 1.2, 2 * k, h1, -1);
      swings(-6 * k, -5 * k, kind === "inclusive" ? 2 : 3);
      s.push(S("cone", [5 * k, -5 * k, 0], [3.5, 3.5, 3.2], [196, 58, 48], "metal"));
      if (kind === "inclusive") s.push(box(-3 * k, 2 * k - 3, 0, 1.2, 5, h1 / 2, shade(accent, 0.8), "plastic"), cyl(4 * k, -1 * k, 0, 2.5, 0.4, C.blue, "plastic"));
      if (kind === "adventure") s.push(S("cylinder", [0, -2 * k, 0], [0.15, 0.15, 6], C.steel, "metal"), beam([-6 * k, 7 * k], [6 * k, 7 * k], 3, 0.1, 0.1, C.steel, "metal"));
    }
  }
  return s;
}

// ---------------------------------------------------------------- sport markings

export type Sport = "soccer" | "football" | "baseball" | "basketball" | "tennis" | "pickleball" | "volleyball" | "track" | "cricket" | "rugby";

/** white-line markings and fixtures for a sport scaled to L × W (m) centred on the origin, long axis on x */
export function fieldMarkings(sport: Sport, L: number, W: number, line: RGB = C.white): Solid[] {
  const t = 0.12,
    z = 0.01,
    h = 0.02;
  const s: Solid[] = [];
  const ln = (a: Vec2, b: Vec2, w = t) => s.push(beam(a, b, z, w, h, line, "plastic"));
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    ln([x0, y0], [x1, y0]);
    ln([x1, y0], [x1, y1]);
    ln([x1, y1], [x0, y1]);
    ln([x0, y1], [x0, y0]);
  };
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 16) => {
    for (let i = 0; i < n; i++) {
      const p = a0 + ((a1 - a0) * i) / n,
        q = a0 + ((a1 - a0) * (i + 1)) / n;
      ln([cx + Math.cos(p) * r, cy + Math.sin(p) * r], [cx + Math.cos(q) * r, cy + Math.sin(q) * r]);
    }
  };
  const hl = L / 2,
    hw = W / 2;
  switch (sport) {
    case "soccer":
    case "rugby": {
      rect(-hl, -hw, hl, hw);
      ln([0, -hw], [0, hw]);
      if (sport === "soccer") {
        const k = L / 105;
        arc(0, 0, 9.15 * k, 0, Math.PI * 2, 24);
        for (const sg of [-1, 1]) {
          rect(sg * hl, -20.16 * k, sg * (hl - 16.5 * k), 20.16 * k);
          rect(sg * hl, -9.16 * k, sg * (hl - 5.5 * k), 9.16 * k);
          // goals 7.32 × 2.44 m
          s.push(box(sg * (hl + 0.6), -3.66 * k, 0, 0.12, 0.12, 2.44, C.white, "metal"), box(sg * (hl + 0.6), 3.66 * k, 0, 0.12, 0.12, 2.44, C.white, "metal"), box(sg * (hl + 0.6), 0, 2.38, 0.12, 7.44 * k, 0.12, C.white, "metal"));
          s.push(box(sg * (hl + 1.5), 0, 0, 0.05, 7.3 * k, 2.3, [236, 236, 236], "fabric"));
        }
      } else {
        for (const sg of [-1, 1]) {
          ln([sg * (hl - 22 * (L / 100)), -hw], [sg * (hl - 22 * (L / 100)), hw]);
          s.push(box(sg * hl, -2.8, 0, 0.15, 0.15, 10, C.white, "metal"), box(sg * hl, 2.8, 0, 0.15, 0.15, 10, C.white, "metal"), box(sg * hl, 0, 3, 0.15, 5.6, 0.15, C.white, "metal"));
        }
      }
      break;
    }
    case "football": {
      // 120 yd × 53⅓ yd incl. end zones (109.7 × 48.8 m); yard lines every 5 yd
      rect(-hl, -hw, hl, hw);
      const ez = L * (10 / 120);
      for (let i = 0; i <= 20; i++) {
        const x = -hl + ez + ((L - 2 * ez) * i) / 20;
        ln([x, -hw], [x, hw], i % 2 ? 0.1 : 0.15);
      }
      for (const sg of [-1, 1]) {
        s.push(S("box", [sg * (hl + 0.3), 0, 3.05], [0.12, 5.64, 0.12], C.yellow, "metal"), cyl(sg * (hl + 0.3), 0, 0, 0.2, 3.05, C.yellow, "metal"), box(sg * (hl + 0.3), -2.8, 3.05, 0.1, 0.1, 6, C.yellow, "metal"), box(sg * (hl + 0.3), 2.8, 3.05, 0.1, 0.1, 6, C.yellow, "metal"));
        s.push(box(sg * (hl - ez / 2), 0, 0, ez - 0.4, W - 0.4, 0.015, [70, 110, 160], "plastic"));
      }
      break;
    }
    case "baseball": {
      // home plate at -x; 27.43 m (90 ft) diamond; infield dirt; outfield fence radius ≈ min(L,W)
      const base = 27.43 * Math.min(1, L / 110);
      const hx = -hl + 6;
      const d = base / Math.SQRT2;
      s.push(S("box", [hx + d, 0, 0], [base * 1.15, base * 1.15, 0.015], [190, 150, 110], "stone", 45));
      s.push(S("box", [hx + d, 0, 0.016], [base * 0.82, base * 0.82, 0.015], [120, 168, 96], "foliage", 45));
      ln([hx, 0], [hx + d, d]);
      ln([hx + d, d], [hx + 2 * d, 0]);
      ln([hx + 2 * d, 0], [hx + d, -d]);
      ln([hx + d, -d], [hx, 0]);
      ln([hx, 0], [hx + L * 0.65, L * 0.65]);
      ln([hx, 0], [hx + L * 0.65, -L * 0.65]);
      for (const [x, y] of [[hx + d, d], [hx + 2 * d, 0], [hx + d, -d], [hx, 0]] as Vec2[]) s.push(box(x, y, 0.02, 0.4, 0.4, 0.08, C.white, "plastic"));
      s.push(cyl(hx + d * 0.98, 0, 0, 5.5, 0.25, [190, 150, 110], "stone"));
      // backstop
      s.push(S("box", [hx - 5, 0, 0], [0.1, 14, 4], C.steelDark, "metal", 0));
      // outfield fence as an arc
      const R = Math.min(L - 8, W * 0.95);
      for (let i = 0; i < 18; i++) {
        const a0 = -Math.PI / 4 + (Math.PI / 2) * (i / 18),
          a1 = -Math.PI / 4 + (Math.PI / 2) * ((i + 1) / 18);
        s.push(beam([hx + Math.cos(a0) * R, Math.sin(a0) * R], [hx + Math.cos(a1) * R, Math.sin(a1) * R], 0, 0.1, 2.4, [40, 90, 60], "metal"));
      }
      break;
    }
    case "basketball": {
      // FIBA 28 × 15 m; rim 3.05 m
      rect(-hl, -hw, hl, hw);
      ln([0, -hw], [0, hw]);
      arc(0, 0, 1.8, 0, Math.PI * 2, 16);
      for (const sg of [-1, 1]) {
        rect(sg * hl, -2.45, sg * (hl - 5.8), 2.45);
        arc(sg * (hl - 1.575), 0, 6.75, sg > 0 ? Math.PI / 2 : -Math.PI / 2, sg > 0 ? (3 * Math.PI) / 2 : Math.PI / 2, 18);
        s.push(cyl(sg * (hl + 0.4), 0, 0, 0.18, 3.9, C.steelDark, "metal"), box(sg * (hl - 1.0), 0, 2.9, 0.05, 1.8, 1.05, C.white, "glass"), S("torus", [sg * (hl - 1.4), 0, 3.05], [0.46, 0.46, 0.03], C.orange, "metal"), beam([sg * (hl + 0.4), 0], [sg * (hl - 1.0), 0], 3.4, 0.12, 0.12, C.steelDark, "metal"));
      }
      break;
    }
    case "tennis":
    case "pickleball":
    case "volleyball": {
      rect(-hl, -hw, hl, hw);
      if (sport === "tennis") {
        const sw = W * (8.23 / 10.97) / 2;
        ln([-hl, -sw], [hl, -sw]);
        ln([-hl, sw], [hl, sw]);
        ln([-6.4 * (L / 23.77), 0], [6.4 * (L / 23.77), 0]);
        ln([-6.4 * (L / 23.77), -sw], [-6.4 * (L / 23.77), sw]);
        ln([6.4 * (L / 23.77), -sw], [6.4 * (L / 23.77), sw]);
      } else if (sport === "pickleball") {
        for (const sg of [-1, 1]) ln([sg * 2.13, -hw], [sg * 2.13, hw]);
        ln([-hl, 0], [-2.13, 0]);
        ln([2.13, 0], [hl, 0]);
      } else for (const sg of [-1, 1]) ln([sg * 3, -hw], [sg * 3, hw]);
      const nh = sport === "volleyball" ? 2.43 : sport === "tennis" ? 0.914 : 0.86;
      s.push(cyl(0, -hw - 0.9, 0, 0.1, nh + (sport === "volleyball" ? 0 : 0.15), C.steelDark, "metal"), cyl(0, hw + 0.9, 0, 0.1, nh + (sport === "volleyball" ? 0 : 0.15), C.steelDark, "metal"));
      s.push(box(0, 0, sport === "volleyball" ? nh - 1 : 0, 0.03, W + 1.8, sport === "volleyball" ? 1 : nh, [40, 40, 40], "fabric"));
      break;
    }
    case "cricket":
      s.push(box(0, 0, 0, 20.12, 3.05, 0.015, [210, 196, 150], "stone"));
      for (const sg of [-1, 1]) for (const y of [-0.11, 0, 0.11]) s.push(box(sg * 10.06, y, 0, 0.04, 0.04, 0.71, C.woodLight, "wood"));
      arc(0, 0, Math.min(hl, hw) - 2, 0, Math.PI * 2, 40);
      break;
    case "track": {
      // 400 m standard: straights 84.39 m, inner radius 36.5 m, 8 lanes × 1.22 m (scaled to fit)
      const k = Math.min(L / 176.2, W / 92.5);
      const st = 84.39 * k,
        r0 = 36.5 * k,
        lw = 9.76 * k;
      const rm = r0 + lw / 2;
      const surf: RGB = [176, 88, 70];
      for (const sg of [-1, 1]) s.push(box(0, sg * rm, 0, st, lw, 0.015, surf, "plastic"));
      for (const sg of [-1, 1])
        for (let i = 0; i < 14; i++) {
          const a0 = -Math.PI / 2 + (Math.PI * i) / 14,
            a1 = -Math.PI / 2 + (Math.PI * (i + 1)) / 14;
          const m = (a0 + a1) / 2;
          const cx = sg * (st / 2) + sg * Math.cos(m) * rm,
            cy = Math.sin(m) * rm;
          s.push(S("box", [cx, cy, 0], [lw, 2 * rm * Math.sin(Math.PI / 28) + 0.3, 0.015], surf, "plastic", ((sg > 0 ? m : Math.PI - m) * 180) / Math.PI));
        }
      // football / soccer infield
      s.push(...fieldMarkings("football", Math.min(109.7 * k * 0.98, st + r0 * 0.9), 48.8 * k * 0.98).map((q) => ({ ...q, at: [q.at[0], q.at[1], q.at[2] + 0.01] as [number, number, number] })));
      break;
    }
  }
  return s;
}

const SPORT_DIMS: Record<Sport, [number, number, number]> = {
  // [length, width, run-off] m
  soccer: [105, 68, 5],
  football: [109.7, 48.8, 4],
  rugby: [100, 70, 5],
  baseball: [120, 120, 4],
  basketball: [28, 15, 2],
  tennis: [23.77, 10.97, 5.5],
  pickleball: [13.41, 6.1, 3],
  volleyball: [18, 9, 3],
  track: [176.2, 92.5, 3],
  cricket: [140, 130, 3],
};

function sportDef(sport: Sport, id: string, name: string, tags: string[], description: string, surface: AreaType, hardColor?: RGB): PrimitiveDef {
  const [L0, W0, ro] = SPORT_DIMS[sport];
  const params: ParamSpec[] = [
    num("length", "Playing length", L0, { group: D, unit: "m", min: L0 * 0.4, max: L0 * 1.3, step: 0.1, description: `Regulation ${L0} m` }),
    num("width", "Playing width", W0, { group: D, unit: "m", min: W0 * 0.4, max: W0 * 1.3, step: 0.1, description: `Regulation ${W0} m` }),
    num("runoff", "Run-off margin", ro, { group: D, unit: "m", min: 0, max: 20, step: 0.5 }),
    ...(hardColor ? [color("surfaceColor", "Court colour", "#" + hardColor.map((c) => c.toString(16).padStart(2, "0")).join(""), { group: A, swatches: ["#4a7a5c", "#3c6ca8", "#b05846", "#6a6c70"] })] : []),
    bool("fence", "Perimeter fence", sport === "tennis" || sport === "pickleball", { group: A }),
    bool("lights", "Floodlights", false, { group: A }),
    int("benches", "Spectator benches", sport === "basketball" || sport === "tennis" || sport === "pickleball" ? 2 : 4, { group: A, min: 0, max: 20 }),
  ];
  return {
    id,
    name,
    category: RC,
    tags,
    description,
    icon: "trophy",
    placement: "rect",
    params,
    generate(values, place, ctx) {
      const r = reader(values, params);
      const out = new Out(ctx);
      const f = frameOf(place);
      let L = r.n("length"),
        W = r.n("width");
      const m = r.n("runoff");
      if (f.siteW > 0) {
        // fit the field (with run-off) into the drawn rectangle, keeping proportions when it's too small
        const k = Math.min(1, (f.siteW - 2 * m) / L, (f.siteD - 2 * m) / W);
        if (k > 0.2) {
          L *= k;
          W *= k;
        }
      }
      const ground = rectL(0, 0, f.siteW > 0 ? f.siteW : L + 2 * m, f.siteD > 0 ? f.siteD : W + 2 * m);
      out.area(surface, polyToWorld(f, ground), { primary: true });
      const solids: Solid[] = [];
      if (hardColor) solids.push(box(0, 0, 0, L + 2 * m * 0.6, W + 2 * m * 0.6, 0.01, hexToRgb(r.c("surfaceColor"), hardColor), "plastic"));
      solids.push(...fieldMarkings(sport, L, W).map((q) => ({ ...q, at: [q.at[0], q.at[1], q.at[2] + (hardColor ? 0.01 : 0)] as [number, number, number] })));
      const GL = L + 2 * m,
        GW = W + 2 * m;
      if (r.b("fence")) {
        const fh = sport === "tennis" ? 3.0 : 2.4;
        for (const [a, b] of [[[-GL / 2, -GW / 2], [GL / 2, -GW / 2]], [[GL / 2, -GW / 2], [GL / 2, GW / 2]], [[GL / 2, GW / 2], [-GL / 2, GW / 2]], [[-GL / 2, GW / 2], [-GL / 2, -GW / 2]]] as [Vec2, Vec2][]) {
          solids.push(beam(a, b, fh - 0.05, 0.06, 0.06, C.steelDark, "metal"));
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const n = Math.max(1, Math.round(len / 3));
          for (let i = 0; i <= n; i++) solids.push(box(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, 0, 0.07, 0.07, fh, C.steelDark, "metal"));
        }
      }
      if (r.b("lights")) for (const [x, y] of [[-GL / 2, -GW / 2], [GL / 2, -GW / 2], [GL / 2, GW / 2], [-GL / 2, GW / 2]] as Vec2[]) solids.push(cyl(x, y, 0, 0.4, Math.max(12, L * 0.18), C.steel, "metal"), box(x, y, Math.max(12, L * 0.18), 2.4, 2.4, 1.2, C.light, "light"));
      const nb = r.n("benches");
      for (let i = 0; i < nb; i++) solids.push(...moveSolids(benchSolids("backless", Math.min(4, GL / (nb + 1))), -GL / 2 + (GL * (i + 1)) / (nb + 1), -GW / 2 - 1.5, 0));
      out.prop(id, f, solids, { primary: false, height: Math.max(0.1, ...solids.map((q) => q.at[2] + q.size[2])) }).cover = hardColor ? "paving" : "lawn";
      out.summary.push(`${name}: ${L.toFixed(1)} × ${W.toFixed(1)} m playing area`);
      return out.done();
    },
  };
}

export const RECREATION: PrimitiveDef[] = [
  propDef({
    id: "recreation.playground",
    name: "Playground",
    category: RC,
    tags: ["play area", "tot lot", "play structure", "swings", "slide", "jungle gym", "adventure playground", "inclusive playground"],
    description: "Playground with safety surfacing: toddler, school-age, adventure, nature-play or inclusive equipment.",
    icon: "baby",
    params: [choice("kind", "Type", "school", opts("toddler", "school", "adventure", "nature", "inclusive"), { group: A }), num("size", "Size", 20, { group: D, unit: "m", min: 8, max: 60, step: 1, description: "Side of the play area incl. fall zones" }), color("accent", "Equipment colour", "#e48034", { group: A, swatches: ["#e48034", "#3c6ca8", "#c43a30", "#407e54", "#e8c440"] }), color("surface", "Surfacing", "#b0604a", { group: A, swatches: ["#b0604a", "#3c6ca8", "#407e54", "#c4a070"] })],
    build: (r) => ({ solids: playgroundSolids(r.s("kind") as PlayKind, r.n("size"), hexToRgb(r.c("accent")), hexToRgb(r.c("surface"))), cover: "permeable" }),
  }),
  sportDef("soccer", "recreation.soccer_field", "Soccer field", ["football pitch", "futbol", "association football", "pitch", "sports field"], "FIFA-size soccer pitch (105 × 68 m) with markings and goals; scale down for youth fields.", "pitch"),
  sportDef("football", "recreation.football_field", "American football field", ["gridiron", "football field", "nfl field", "high school football"], "American football field (120 × 53⅓ yd incl. end zones) with yard lines and goal posts.", "pitch"),
  sportDef("rugby", "recreation.rugby_field", "Rugby pitch", ["rugby", "rugby union", "rugby league"], "Rugby pitch (100 × 70 m) with H-posts.", "pitch"),
  sportDef("baseball", "recreation.baseball_field", "Baseball / softball field", ["ballpark", "diamond", "little league", "softball"], "Baseball diamond (90 ft bases) with infield, backstop and outfield fence; scale down for softball / little league.", "pitch"),
  sportDef("basketball", "recreation.basketball_court", "Basketball court", ["hoops", "court", "streetball", "half court"], "FIBA basketball court (28 × 15 m) with hoops.", "plaza", [74, 122, 92]),
  sportDef("tennis", "recreation.tennis_court", "Tennis court", ["tennis", "court", "hard court"], "Doubles tennis court (23.77 × 10.97 m) with net and fence.", "plaza", [60, 108, 168]),
  sportDef("pickleball", "recreation.pickleball_court", "Pickleball court", ["pickleball", "paddle", "court"], "Pickleball court (13.41 × 6.10 m) with net.", "plaza", [74, 122, 92]),
  sportDef("volleyball", "recreation.volleyball_court", "Volleyball court", ["beach volleyball", "sand volleyball", "volleyball"], "Volleyball court (18 × 9 m) on sand or hard court.", "plaza", [222, 204, 164]),
  sportDef("track", "recreation.running_track", "Running track", ["athletics track", "400m track", "stadium", "track and field", "oval"], "400 m eight-lane athletics track around a football / soccer infield.", "pitch"),
  sportDef("cricket", "recreation.cricket_ground", "Cricket ground", ["cricket", "oval", "pitch", "wicket"], "Cricket oval with a 20.12 m pitch and stumps.", "pitch"),
  propDef({
    id: "recreation.skate_park",
    name: "Skate park",
    category: RC,
    tags: ["skateboard", "bmx", "skate plaza", "bowl", "half pipe", "ramps"],
    description: "Concrete skate park with a bowl, quarter pipes, ledges and a rail.",
    icon: "zap",
    params: [num("width", "Width", 30, { group: D, unit: "m", min: 10, max: 80, step: 1 }), num("depth", "Depth", 20, { group: D, unit: "m", min: 8, max: 60, step: 1 }), bool("bowl", "Bowl", true, { group: A }), int("ramps", "Ramps", 4, { group: A, min: 0, max: 12 })],
    build: (r) => {
      const w = r.n("width"),
        d = r.n("depth");
      const s: Solid[] = [box(0, 0, 0, w, d, 0.1, [190, 188, 182], "concrete")];
      if (r.b("bowl")) s.push(S("torus", [-w / 4, 0, 0.1], [Math.min(w / 2, d) * 0.8, Math.min(w / 2, d) * 0.8, 1.4], [176, 174, 168], "concrete"));
      const n = r.n("ramps");
      for (let i = 0; i < n; i++) {
        const x = w * 0.1 + ((w * 0.38) * (i % 2)) - (i > 1 ? 0 : 0);
        const y = -d / 2 + 2 + ((d - 4) * Math.floor(i / 2)) / Math.max(1, Math.ceil(n / 2) - 1 || 1);
        s.push(S("wedge", [x, Math.max(-d / 2 + 1.5, Math.min(d / 2 - 1.5, y)), 0.1], [3, 4, 1.2], [176, 174, 168], "concrete", 0));
      }
      s.push(box(w / 4, 0, 0.1, 6, 0.6, 0.45, C.granite, "stone"), beam([w / 4 - 3, 2], [w / 4 + 3, 2], 0.6, 0.06, 0.06, C.steel, "metal"));
      return { solids: s, cover: "paving" };
    },
  }),
  propDef({
    id: "recreation.swimming_pool",
    name: "Swimming pool",
    category: RC,
    tags: ["pool", "lido", "natatorium", "aquatic center", "outdoor pool", "lap pool"],
    description: "Outdoor pool (25 m short course or 50 m Olympic) with a deck, lane lines and loungers.",
    icon: "waves",
    siting: { water: true },
    params: [num("length", "Pool length", 25, { group: D, unit: "m", min: 6, max: 60, step: 0.5, description: "25 m short course, 50 m long course" }), num("width", "Pool width", 12.5, { group: D, unit: "m", min: 3, max: 30, step: 0.5 }), int("lanes", "Lanes", 6, { group: D, min: 0, max: 10 }), num("deck", "Deck width", 4, { group: D, unit: "m", min: 1, max: 15, step: 0.5 }), int("loungers", "Loungers", 8, { group: A, min: 0, max: 40 })],
    build: (r) => {
      const L = r.n("length"),
        W = r.n("width"),
        dk = r.n("deck");
      const s: Solid[] = [box(0, 0, 0, L + 2 * dk, W + 2 * dk, 0.1, [226, 220, 208], "stone"), box(0, 0, 0.1, L, W, 0.02, [96, 176, 210], "water")];
      const n = r.n("lanes");
      for (let i = 1; i < n; i++) s.push(box(0, -W / 2 + (W * i) / n, 0.13, L, 0.1, 0.03, i % 2 ? C.red : C.yellow, "plastic"));
      const lo = r.n("loungers");
      for (let i = 0; i < lo; i++) s.push(S("box", [-L / 2 + (L * (i + 0.5)) / lo, W / 2 + dk * 0.6, 0.1], [0.65, 1.9, 0.35], C.white, "plastic"));
      return { solids: s, cover: "water" };
    },
  }),
  propDef({
    id: "recreation.outdoor_fitness",
    name: "Outdoor fitness station",
    category: RC,
    tags: ["outdoor gym", "calisthenics", "exercise equipment", "pull-up bars", "fitness trail"],
    description: "Outdoor gym: pull-up bars, parallel bars, sit-up bench and step platforms on safety surfacing.",
    icon: "dumbbell",
    params: [int("stations", "Stations", 5, { group: D, min: 1, max: 12 })],
    build: (r) => {
      const n = r.n("stations");
      const s: Solid[] = [box(0, 0, 0, n * 3 + 1, 5, 0.05, C.rubber, "plastic")];
      for (let i = 0; i < n; i++) {
        const x = -(n * 3) / 2 + 1.5 + i * 3;
        if (i % 3 === 0) s.push(box(x - 0.8, 0, 0, 0.1, 0.1, 2.4, C.steel, "metal"), box(x + 0.8, 0, 0, 0.1, 0.1, 2.4, C.steel, "metal"), beam([x - 0.8, 0], [x + 0.8, 0], 2.3, 0.06, 0.06, C.steel, "metal"));
        else if (i % 3 === 1) s.push(beam([x - 1, -0.3], [x + 1, -0.3], 1.1, 0.06, 0.06, C.steel, "metal"), beam([x - 1, 0.3], [x + 1, 0.3], 1.1, 0.06, 0.06, C.steel, "metal"), ...[[-1, -0.3], [1, -0.3], [-1, 0.3], [1, 0.3]].map(([dx, dy]) => box(x + dx, dy, 0, 0.08, 0.08, 1.1, C.steel, "metal")));
        else s.push(S("box", [x, 0, 0.3], [0.5, 1.8, 0.08], C.green, "plastic", 0, [15, 0]), box(x, -0.8, 0, 0.1, 0.1, 0.5, C.steel, "metal"));
      }
      return { solids: s, cover: "permeable" };
    },
  }),
];
