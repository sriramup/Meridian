// Utilities: power poles and lines, transformers, substations, water towers, cell towers,
// rooftop and ground-mount solar, wind turbines, utility cabinets.

import { fmtLen } from "@/lib/units";
import { polyArea, polyBBox, pointInPoly } from "@/geometry/polygon";
import type { Solid, Vec2 } from "@/world/types";
import type { PrimitiveDef } from "../types";
import { toLocal } from "../geometry/frame";
import { C, hexToRgb } from "../geometry/palette";
import { S, beam, box, cyl, moveSolids } from "../geometry/solids";
import { defaultPath, pathLength, propDef, siteOf, stations } from "./kinds";
import { Out } from "./make";
import { bool, choice, color, int, num, opts, reader } from "./params";
import { fenceSolids } from "./decor";

const UT = "utilities" as const;
const D = "Dimensions",
  A = "Appearance";

/** distribution pole: 12 m class wood pole, cross-arm with 3 insulators, optional transformer and street light */
export function poleSolids(height: number, kind: "wood" | "steel" | "concrete", crossarms: number, transformer: boolean, light: boolean): Solid[] {
  const col = kind === "wood" ? C.woodDark : kind === "steel" ? C.steel : C.concrete;
  const s: Solid[] = [cyl(0, 0, 0, kind === "wood" ? 0.3 : 0.35, height, col, kind === "wood" ? "wood" : kind === "steel" ? "metal" : "concrete")];
  for (let i = 0; i < crossarms; i++) {
    const z = height - 0.5 - i * 1.2;
    s.push(box(0, 0, z, 0.12, 2.4, 0.12, C.woodDark, "wood"));
    for (const y of [-1.0, 0, 1.0]) s.push(cyl(0, y, z + 0.12, 0.1, 0.25, [120, 150, 110], "glass"));
  }
  if (transformer) s.push(cyl(0.45, 0, height - 3.6, 0.6, 1.1, C.steel, "metal"));
  if (light) {
    const z = height * 0.62;
    s.push(beam([0, 0], [2.0, 0], z, 0.08, 0.08, C.steel, "metal"), box(2.0, 0, z - 0.15, 0.7, 0.3, 0.18, C.steelDark, "metal"), box(2.0, 0, z - 0.17, 0.55, 0.22, 0.03, C.light, "light"));
  }
  return s;
}

const poleParams = [
  num("height", "Pole height", 12, { group: D, unit: "m", min: 6, max: 40, step: 0.5, description: "Distribution 35–45 ft, sub-transmission 60–80 ft" }),
  choice("material", "Material", "wood", opts("wood", "steel", "concrete"), { group: A }),
  int("crossarms", "Cross-arms", 1, { group: D, min: 0, max: 4 }),
  bool("transformer", "Pole-mounted transformer", false, { group: A }),
  bool("light", "Street light", false, { group: A }),
];

export const UTILITIES: PrimitiveDef[] = [
  propDef({
    id: "utilities.power_pole",
    name: "Utility pole",
    category: UT,
    tags: ["power pole", "telephone pole", "electric pole", "distribution pole", "telegraph pole"],
    description: "Wood, steel or concrete distribution pole with cross-arms, insulators and optional transformer / street light.",
    icon: "utility-pole",
    params: poleParams,
    build: (r) => ({ solids: poleSolids(r.n("height"), r.s("material") as "wood", r.n("crossarms"), r.b("transformer"), r.b("light")) }),
  }),
  {
    id: "utilities.power_line",
    name: "Overhead power line",
    category: UT,
    tags: ["power lines", "electric lines", "wires", "distribution line", "transmission line", "pylons"],
    description: "Poles (or lattice pylons) along a drawn line with conductors strung between them.",
    icon: "cable",
    placement: "path",
    siting: { overlapProps: true },
    params: [...poleParams, num("span", "Span", 40, { group: D, unit: "m", min: 15, max: 400, step: 1, description: "Distribution 100–165 ft, transmission 800–1,300 ft" }), choice("kind", "Structure", "pole", [{ value: "pole", label: "Distribution poles" }, { value: "pylon", label: "Transmission pylons" }], { group: A }), int("conductors", "Conductors", 3, { group: D, min: 1, max: 6 })],
    generate(values, place, ctx) {
      const r = reader(values, this.params);
      const out = new Out(ctx);
      const path = place.path && place.path.length >= 2 ? place.path : defaultPath(place, 120);
      const sts = stations(path, r.n("span"));
      const pylon = r.s("kind") === "pylon";
      const h = pylon ? Math.max(25, r.n("height") * 2.5) : r.n("height");
      const nc = r.n("conductors");
      sts.forEach((st, i) => {
        const a = (st.rot * Math.PI) / 180;
        const base = pylon ? pylonSolids(h) : poleSolids(h, r.s("material") as "wood", Math.max(1, r.n("crossarms")), r.b("transformer") && i % 4 === 2, r.b("light"));
        const s: Solid[] = moveSolids(base, 0, 0, 90);
        const next = sts[i + 1];
        if (next) {
          const q = toLocal({ c: st.p, a, siteW: 0, siteD: 0 }, next.p);
          for (let k = 0; k < nc; k++) {
            const off = pylon ? (k - (nc - 1) / 2) * 4 : (k - (nc - 1) / 2) * 1.0;
            const z = (pylon ? h * 0.82 : h - 0.3) - (pylon ? 0 : 0);
            const sag = Math.max(0.3, Math.hypot(q[0], q[1]) * 0.02);
            // two straight pieces approximate the catenary sag
            const mid: Vec2 = [q[0] / 2, q[1] / 2 + off];
            s.push(wire([0, off], mid, z, z - sag), wire(mid, [q[0], q[1] + off], z - sag, z));
          }
        }
        out.prop("utilities.power_line", { c: st.p, a, siteW: 0, siteD: 0 }, s, { primary: i === 0 });
      });
      out.summary.push(`${sts.length} ${pylon ? "pylons" : "poles"} along ${fmtLen(pathLength(path))}`);
      return out.done();
    },
  },
  propDef({
    id: "utilities.transformer",
    name: "Pad-mounted transformer",
    category: UT,
    tags: ["transformer", "electrical box", "switchgear", "utility box", "green box"],
    description: "Ground-mounted distribution transformer / switchgear cabinet on a pad.",
    icon: "zap",
    params: [num("width", "Width", 1.8, { group: D, unit: "m", min: 0.6, max: 5, step: 0.1 }), num("height", "Height", 1.4, { group: D, unit: "m", min: 0.6, max: 3, step: 0.1 }), color("color", "Colour", "#4c6a50", { group: A })],
    build: (r) => ({ solids: [box(0, 0, 0, r.n("width") + 0.4, r.n("width") * 0.8 + 0.4, 0.15, C.concrete, "concrete"), box(0, 0, 0.15, r.n("width"), r.n("width") * 0.8, r.n("height"), hexToRgb(r.c("color")), "metal")] }),
  }),
  propDef({
    id: "utilities.utility_cabinet",
    name: "Street utility cabinet",
    category: UT,
    tags: ["telecom cabinet", "signal cabinet", "fiber cabinet", "control box", "junction box"],
    description: "Traffic-signal controller or telecom cabinet.",
    icon: "box",
    params: [choice("kind", "Type", "signal", opts("signal", "telecom", "meter"), { group: A }), color("color", "Colour", "#9aa0a4", { group: A })],
    build: (r) => ({ solids: [box(0, 0, 0, 1.0, 0.6, 0.12, C.concrete, "concrete"), box(0, 0, 0.12, r.s("kind") === "meter" ? 0.5 : 0.9, 0.5, r.s("kind") === "telecom" ? 1.5 : 1.3, hexToRgb(r.c("color")), "metal")] }),
  }),
  {
    id: "utilities.substation",
    name: "Electrical substation",
    category: UT,
    tags: ["substation", "switchyard", "power station", "grid", "electric utility"],
    description: "Fenced substation yard with transformers, gantries and a control building.",
    icon: "zap",
    placement: "rect",
    params: [num("width", "Width", 60, { group: D, unit: "m", min: 15, max: 400, step: 1 }), num("depth", "Depth", 40, { group: D, unit: "m", min: 15, max: 300, step: 1 }), int("transformers", "Transformers", 3, { group: D, min: 1, max: 12 })],
    generate(values, place, ctx) {
      const r = reader(values, this.params);
      const out = new Out(ctx);
      const { poly, frame } = siteOf(place, r.n("width"), r.n("depth"));
      const W = frame.siteW || r.n("width"),
        Dd = frame.siteD || r.n("depth");
      out.area("construction", poly, { primary: true, name: "Substation" });
      const s: Solid[] = [];
      const n = r.n("transformers");
      for (let i = 0; i < n; i++) {
        const x = -W / 2 + (W * (i + 0.5)) / n;
        s.push(box(x, 0, 0, 4, 3, 3.2, [150, 156, 150], "metal"), ...[-1, 0, 1].map((k) => cyl(x + k * 1.2, 0, 3.2, 0.3, 1.4, [120, 150, 110], "glass")));
        s.push(box(x - 3, Dd / 4, 0, 0.3, 0.3, 9, C.steel, "metal"), box(x + 3, Dd / 4, 0, 0.3, 0.3, 9, C.steel, "metal"), beam([x - 3, Dd / 4], [x + 3, Dd / 4], 8.7, 0.3, 0.3, C.steel, "metal"));
      }
      s.push(box(-W / 2 + 6, -Dd / 2 + 5, 0, 10, 6, 4, [200, 196, 186], "concrete"));
      for (const [a, b] of [[[-W / 2, -Dd / 2], [W / 2, -Dd / 2]], [[W / 2, -Dd / 2], [W / 2, Dd / 2]], [[W / 2, Dd / 2], [-W / 2, Dd / 2]], [[-W / 2, Dd / 2], [-W / 2, -Dd / 2]]] as [Vec2, Vec2][]) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        s.push(...moveSolids(fenceSolids(len, 2.4, C.steelDark), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI));
      }
      out.prop("utilities.substation", { ...frame, siteW: 0, siteD: 0 }, s, { primary: false });
      return out.done();
    },
  },
  propDef({
    id: "utilities.water_tower",
    name: "Water tower",
    category: UT,
    tags: ["elevated tank", "water tank", "standpipe", "reservoir"],
    description: "Elevated water storage: spheroid on a column, multi-leg tank, or a ground standpipe.",
    icon: "droplet",
    params: [choice("kind", "Type", "spheroid", opts("spheroid", "legged", "standpipe"), { group: A }), num("height", "Overall height", 40, { group: D, unit: "m", min: 10, max: 80, step: 1 }), num("tank", "Tank diameter", 16, { group: D, unit: "m", min: 4, max: 40, step: 0.5 }), color("color", "Colour", "#e8ecee", { group: A })],
    build: (r) => {
      const H = r.n("height"),
        d = r.n("tank");
      const c = hexToRgb(r.c("color"));
      const k = r.s("kind");
      if (k === "standpipe") return { solids: [cyl(0, 0, 0, d, H, c, "metal"), S("cone", [0, 0, H], [d, d, d * 0.15], c, "metal")] };
      if (k === "legged") {
        const s: Solid[] = [cyl(0, 0, H - d * 0.6, d, d * 0.45, c, "metal"), S("cone", [0, 0, H - d * 0.15], [d, d, d * 0.2], c, "metal"), S("hemisphere", [0, 0, H - d * 0.6], [d, d, d * 0.3], c, "metal", 0, [180, 0])];
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          s.push(S("cylinder", [Math.cos(a) * d * 0.55, Math.sin(a) * d * 0.55, 0], [0.5, 0.5, H - d * 0.6 + 0.2], C.steel, "metal", (a * 180) / Math.PI, [0, -4]));
        }
        s.push(cyl(0, 0, 0, 1.2, H - d * 0.6, C.steel, "metal"));
        return { solids: s };
      }
      return { solids: [S("cone", [0, 0, 0], [d * 0.5, d * 0.5, H * 0.3], c, "metal"), cyl(0, 0, 0, d * 0.22, H - d * 0.5, c, "metal"), S("sphere", [0, 0, H - d * 0.75], [d, d, d * 0.75], c, "metal")] };
    },
  }),
  propDef({
    id: "utilities.cell_tower",
    name: "Cell tower",
    category: UT,
    tags: ["telecom tower", "mobile mast", "antenna", "5g", "monopole", "lattice tower", "radio mast"],
    description: "Monopole, lattice tower or disguised 'monopine' with antenna panels and equipment shelter.",
    icon: "radio-tower",
    params: [choice("kind", "Type", "monopole", opts("monopole", "lattice", "monopine"), { group: A }), num("height", "Height", 35, { group: D, unit: "m", min: 8, max: 120, step: 1 }), int("arrays", "Antenna arrays", 3, { group: D, min: 1, max: 6 })],
    build: (r) => {
      const H = r.n("height"),
        k = r.s("kind");
      const s: Solid[] = [box(4, 0, 0, 3, 2.5, 2.6, [200, 196, 186], "metal")];
      if (k === "lattice") s.push(S("pyramid", [0, 0, 0], [H * 0.12, H * 0.12, H * 1.05], C.steel, "metal"));
      else s.push(S("cone", [0, 0, 0], [1.4, 1.4, H * 1.6], k === "monopine" ? C.trunk : C.steel, k === "monopine" ? "wood" : "metal"));
      if (k === "monopine") for (let i = 0; i < 5; i++) s.push(S("cone", [0, 0, H * 0.4 + i * H * 0.12], [7 - i * 1.1, 7 - i * 1.1, H * 0.2], C.foliageDark, "foliage"));
      const n = r.n("arrays");
      for (let j = 0; j < n; j++) {
        const z = H - 1.5 - j * 3;
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          s.push(box(Math.cos(a) * 1.4, Math.sin(a) * 1.4, z, 0.3, 0.6, 1.8, C.white, "plastic"));
        }
        s.push(S("torus", [0, 0, z + 1.6], [3, 3, 0.15], C.steel, "metal"));
      }
      return { solids: s };
    },
  }),
  {
    id: "utilities.rooftop_solar",
    name: "Rooftop solar array",
    category: UT,
    tags: ["solar panels", "pv", "photovoltaic", "solar roof", "renewable"],
    description: "Rows of tilted PV panels at roof height over a drawn area (place on a flat roof; ≈ 19 W/sq ft).",
    icon: "sun",
    placement: "rect",
    siting: { onBuildings: true, overlapProps: true },
    params: [num("width", "Width", 20, { group: D, unit: "m", min: 2, max: 300, step: 0.5 }), num("depth", "Depth", 12, { group: D, unit: "m", min: 2, max: 300, step: 0.5 }), num("elevation", "Roof height", 12, { group: D, unit: "m", min: 0, max: 400, step: 0.1, description: "Height of the roof the array sits on" }), num("tilt", "Panel tilt", 15, { group: D, unit: "°", min: 0, max: 45, step: 1 }), num("rowPitch", "Row spacing", 2.2, { group: D, unit: "m", min: 1, max: 6, step: 0.1 })],
    generate(values, place, ctx) {
      const r = reader(values, this.params);
      const out = new Out(ctx);
      const { frame } = siteOf(place, r.n("width"), r.n("depth"));
      const W = frame.siteW || r.n("width"),
        Dd = frame.siteD || r.n("depth");
      const rows = Math.max(1, Math.floor(Dd / r.n("rowPitch")));
      const z = r.n("elevation");
      const s: Solid[] = [];
      for (let i = 0; i < rows; i++) s.push(S("box", [0, -Dd / 2 + r.n("rowPitch") * (i + 0.5), z + 0.3], [W, Math.min(1.7, r.n("rowPitch") * 0.75), 0.06], [46, 62, 92], "glass", 0, [r.n("tilt"), 0]));
      out.prop("utilities.rooftop_solar", { ...frame, siteW: 0, siteD: 0 }, s, { primary: true });
      const kw = W * Dd * 0.2 * 0.75;
      out.summary.push(`Solar array ≈ ${Math.round(kw)} kWp (${Math.round(kw * 1500).toLocaleString()} kWh/yr)`);
      return out.done();
    },
  },
  {
    id: "utilities.solar_farm",
    name: "Solar farm",
    category: UT,
    tags: ["solar park", "pv plant", "ground-mount solar", "solar field", "agrivoltaics"],
    description: "Ground-mounted PV rows over a drawn area.",
    icon: "sun",
    placement: "polygon",
    params: [num("width", "Width (if not drawn)", 100, { group: D, unit: "m", min: 10, max: 3000 }), num("depth", "Depth (if not drawn)", 60, { group: D, unit: "m", min: 10, max: 3000 }), num("rowPitch", "Row spacing", 6, { group: D, unit: "m", min: 3, max: 15, step: 0.1 }), num("tilt", "Panel tilt", 25, { group: D, unit: "°", min: 0, max: 45, step: 1 })],
    generate(values, place, ctx) {
      const r = reader(values, this.params);
      const out = new Out(ctx);
      const { poly, frame } = siteOf(place, r.n("width"), r.n("depth"));
      out.area("grass", poly, { primary: true, name: "Solar farm" });
      const local = [poly[0].map((p) => toLocal(frame, p))];
      const [x0, y0, x1, y1] = polyBBox(local);
      const s: Solid[] = [];
      for (let y = y0 + 3; y < y1 - 2 && s.length < 1200; y += r.n("rowPitch")) {
        // clip each row to the site by sampling its extent
        let a = Infinity,
          b = -Infinity;
        for (let x = x0; x <= x1; x += 1) if (pointInPoly([x, y], local)) (a = Math.min(a, x), (b = Math.max(b, x)));
        if (b - a > 3) s.push(S("box", [(a + b) / 2, y, 1.0], [b - a - 2, 3.2, 0.08], [46, 62, 92], "glass", 0, [r.n("tilt"), 0]), box((a + b) / 2, y, 0, b - a - 2, 0.15, 1.0, C.steel, "metal"));
      }
      if (s.length) out.prop("utilities.solar_farm", { ...frame, siteW: 0, siteD: 0 }, s, { primary: false, height: 2.2 });
      out.summary.push(`Solar farm ≈ ${(polyArea(poly) * 0.045 / 1000).toFixed(1)} MWp`);
      return out.done();
    },
  },
  propDef({
    id: "utilities.wind_turbine",
    name: "Wind turbine",
    category: UT,
    tags: ["windmill", "wind power", "turbine", "renewable energy", "small wind"],
    description: "Three-blade horizontal-axis wind turbine (utility 260–400 ft hub, or small urban).",
    icon: "wind",
    params: [num("hub", "Hub height", 90, { group: D, unit: "m", min: 8, max: 160, step: 1 }), num("rotor", "Rotor diameter", 110, { group: D, unit: "m", min: 3, max: 200, step: 1 }), num("bladeAngle", "Blade position", 0, { group: A, unit: "°", min: 0, max: 120, step: 1, advanced: true })],
    build: (r) => {
      const H = r.n("hub"),
        D2 = r.n("rotor");
      const s: Solid[] = [S("cone", [0, 0, 0], [H * 0.055, H * 0.055, H * 1.6], C.white, "metal"), box(-D2 * 0.03, 0, H - D2 * 0.02, D2 * 0.12, D2 * 0.04, D2 * 0.04, C.white, "metal"), S("sphere", [D2 * 0.04, 0, H - D2 * 0.025], [D2 * 0.04, D2 * 0.04, D2 * 0.05], C.white, "metal")];
      for (let i = 0; i < 3; i++) {
        const a = r.n("bladeAngle") + i * 120;
        // blades in the y-z plane facing +x: start at the hub, roll so they radiate
        s.push(S("box", [D2 * 0.05, 0, H], [0.12, D2 * 0.035, D2 / 2], C.white, "metal", 0, [a, 0]));
      }
      return { solids: s };
    },
  }),
];

function wire(a: Vec2, b: Vec2, za: number, zb: number): Solid {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ang = -(Math.atan2(zb - za, len) * 180) / Math.PI;
  return S("box", [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (za + zb) / 2 - 0.015], [Math.hypot(len, zb - za), 0.03, 0.03], C.black, "metal", (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, [0, ang]);
}

function pylonSolids(h: number): Solid[] {
  const s: Solid[] = [S("pyramid", [0, 0, 0], [8, 8, h * 1.05], C.steel, "metal")];
  for (const z of [h * 0.82, h * 0.68]) s.push(box(0, 0, z, 1, 14, 0.6, C.steel, "metal"));
  return s;
}
