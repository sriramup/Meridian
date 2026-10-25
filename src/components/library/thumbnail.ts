"use client";

// Small isometric previews of library primitives, drawn from what each primitive actually
// generates (its buildings' volumes, its objects' solids, trees, ground areas and paths) with a
// plain 2D canvas: no WebGL context per tile. Each is drawn once per definition and parameter set
// and cached as an image URL; the palette asks for them lazily as tiles scroll into view.

import { defaultParams, type Generated, type ParamValues, type PlacementInput, type PrimitiveDef } from "@/library";
import { MODEL } from "@/render/theme";
import { speciesOf } from "@/world/species";
import type { Area, Building, Path, Prop, Solid, Tree, Vec2 } from "@/world/types";

type V3 = [number, number, number];
type RGB = [number, number, number];
interface Face {
  pts: V3[];
  /** cut-outs (a courtyard in a roof), drawn even-odd */
  holes?: V3[][];
  color: RGB;
  /** surface normal (for light); omitted for flat ground */
  n?: V3;
}
interface Ball {
  c: V3;
  r: number;
  color: RGB;
  /** vertical squash (1 = sphere) */
  sz: number;
}

/** the viewer: from the south-west, 32° above the horizon */
const AZ = Math.PI / 4;
const EL = (32 * Math.PI) / 180;
const CA = Math.cos(AZ),
  SA = Math.sin(AZ),
  CE = Math.cos(EL),
  SE = Math.sin(EL);
/** light from the upper left, a little behind the viewer */
const LIGHT: V3 = norm([-0.45, -0.25, 0.86]);

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function rot2(x: number, y: number, a: number): [number, number] {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}
/** screen x, screen y (down), depth (larger is farther) */
function project(p: V3): [number, number, number] {
  const u = p[0] * CA - p[1] * SA;
  const v = p[0] * SA + p[1] * CA;
  return [u, -(v * SE + p[2] * CE), v * CE - p[2] * SE];
}
const VIEW: V3 = norm([-SA * CE, -CA * CE, SE]);
const facing = (n: V3) => n[0] * VIEW[0] + n[1] * VIEW[1] + n[2] * VIEW[2] > -0.02;

function shade(c: RGB, n?: V3): string {
  const k = n ? 0.58 + 0.5 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) : 1;
  return `rgb(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0})`;
}

/** walls of one ring facing the viewer; `inward` for a hole (its walls face into it) */
function walls(out: Face[], ring: V3[], height: number, color: RGB, inward = false) {
  const n = ring.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1];
  const ccw = area > 0 !== inward;
  for (let i = 0; i < n; i++) {
    const a = ring[i],
      b = ring[(i + 1) % n];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const nrm = norm(ccw ? [dy, -dx, 0] : [-dy, dx, 0]);
    if (!facing(nrm)) continue;
    out.push({ pts: [a, b, [b[0], b[1], b[2] + height], [a[0], a[1], a[2] + height]], color, n: nrm });
  }
}

/** an extruded ring (with any holes): walls facing the viewer plus the top */
function prism(out: Face[], ring: V3[], height: number, color: RGB, top = true, holes: V3[][] = []) {
  walls(out, ring, height, color);
  for (const h of holes) walls(out, h, height, color, true);
  const lift = (r: V3[]) => r.map((p) => [p[0], p[1], p[2] + height] as V3);
  if (top) out.push({ pts: lift(ring), holes: holes.map(lift), color, n: [0, 0, 1] });
}

function pyramid(out: Face[], ring: V3[], apex: V3, color: RGB) {
  const cx = ring.reduce((t, p) => t + p[0], 0) / ring.length,
    cy = ring.reduce((t, p) => t + p[1], 0) / ring.length;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w: V3 = [apex[0] - a[0], apex[1] - a[1], apex[2] - a[2]];
    let nrm = norm([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
    // outward: horizontally away from the base centre
    if (nrm[0] * ((a[0] + b[0]) / 2 - cx) + nrm[1] * ((a[1] + b[1]) / 2 - cy) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
    if (!facing(nrm)) continue;
    out.push({ pts: [a, b, apex], color, n: nrm });
  }
}

function solid(out: Face[], balls: Ball[], s: Solid, ox: number, oy: number, yaw: number) {
  const [sx, sy, sz] = s.size.map(Math.abs) as V3;
  const a = yaw + ((s.rot ?? 0) * Math.PI) / 180;
  const [cx, cy] = rot2(s.at[0], s.at[1], yaw);
  const base: V3 = [ox + cx, oy + cy, s.at[2]];
  const ringOf = (k: number, rx: number, ry: number, z = base[2]): V3[] =>
    Array.from({ length: k }, (_, i) => {
      const t = (i / k) * Math.PI * 2 + (k === 4 ? Math.PI / 4 : 0);
      const [x, y] = rot2(Math.cos(t) * rx * (k === 4 ? Math.SQRT2 : 1), Math.sin(t) * ry * (k === 4 ? Math.SQRT2 : 1), a);
      return [base[0] + x, base[1] + y, z];
    });
  switch (s.shape) {
    case "box":
      prism(out, ringOf(4, sx / 2, sy / 2), sz, s.color);
      break;
    case "cylinder":
    case "torus":
      prism(out, ringOf(14, sx / 2, sy / 2), Math.max(0.05, sz), s.color);
      break;
    case "cone":
      pyramid(out, ringOf(14, sx / 2, sy / 2), [base[0], base[1], base[2] + sz], s.color);
      break;
    case "pyramid":
      pyramid(out, ringOf(4, sx / 2, sy / 2), [base[0], base[1], base[2] + sz], s.color);
      break;
    case "wedge": {
      // a gable prism: ridge along x
      const ring = ringOf(4, sx / 2, sy / 2);
      const [rx, ry] = rot2(sx / 2, 0, a);
      const r1: V3 = [base[0] - rx, base[1] - ry, base[2] + sz];
      const r2: V3 = [base[0] + rx, base[1] + ry, base[2] + sz];
      for (const [p, q] of [
        [ring[0], ring[1]],
        [ring[2], ring[3]],
      ] as [V3, V3][]) {
        const mid: V3 = [(p[0] + q[0]) / 2 - base[0], (p[1] + q[1]) / 2 - base[1], 0];
        const nrm = norm([mid[0], mid[1], sz * 0.6]);
        if (facing(nrm)) out.push({ pts: [p, q, Math.hypot(q[0] - r2[0], q[1] - r2[1]) < Math.hypot(q[0] - r1[0], q[1] - r1[1]) ? r2 : r1, Math.hypot(p[0] - r1[0], p[1] - r1[1]) < Math.hypot(p[0] - r2[0], p[1] - r2[1]) ? r1 : r2], color: s.color, n: nrm });
      }
      break;
    }
    case "sphere":
      balls.push({ c: [base[0], base[1], base[2] + sz / 2], r: Math.max(sx, sy) / 2, color: s.color, sz: sz / Math.max(sx, sy, 0.01) });
      break;
    case "hemisphere":
      balls.push({ c: [base[0], base[1], base[2]], r: Math.max(sx, sy) / 2, color: s.color, sz: (2 * sz) / Math.max(sx, sy, 0.01) });
      break;
  }
}

const DEFAULT_BUILDING: RGB = [226, 222, 214];
const GROUND_SHADOW = "rgba(0,0,0,0.13)";

/** the generator's output for a definition, at a neutral placement around the origin */
function generate(def: PrimitiveDef, params: ParamValues) {
  const big = ["parks", "water", "composites", "recreation"].includes(def.category);
  const w = big ? 64 : def.category === "buildings" || def.category === "housing" || def.category === "commercial" || def.category === "civic" || def.category === "education" || def.category === "health" ? 32 : 20;
  const d = w * 0.72;
  const place: PlacementInput =
    def.placement === "polygon"
      ? { site: [[[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]] }
      : def.placement === "path"
        ? { path: [[-w * 0.6, 0], [w * 0.6, 0]] }
        : { at: [0, 0], rotation: 0 };
  let n = 0;
  return def.generate(params, place, { id: (p) => `thumb:${p}${n++}`, ref: { def: def.id, instance: "thumb", params, placement: place }, householdSize: 2.5 });
}

function draw(def: PrimitiveDef, params: ParamValues, W: number, H: number, dpr: number): string | null {
  return renderGenerated(generate(def, params), W, H, dpr);
}

/** geometry to draw: a primitive's output, or anything shaped like it (palettes draw their own) */
export type Drawable = Pick<Generated, "buildings" | "props" | "trees" | "areas" | "paths" | "streets">;

function renderGenerated(g: Drawable, W: number, H: number, dpr: number): string | null {
  const faces: Face[] = [];
  const balls: Ball[] = [];
  const ground: { ring: Vec2[]; color: RGB }[] = [];
  const lines: { path: Vec2[]; width: number; color: RGB }[] = [];
  for (const a of (g.areas ?? []) as Area[]) ground.push({ ring: a.poly[0], color: a.paint ?? MODEL.area[a.type] ?? [200, 205, 190] });
  for (const p of (g.paths ?? []) as Path[]) lines.push({ path: p.path, width: p.type === "cycleway" ? 2.4 : 2, color: p.paint ?? (p.type === "cycleway" ? [120, 170, 136] : [206, 196, 180]) });
  for (const s of g.streets ?? []) lines.push({ path: s.path, width: 9, color: [150, 150, 152] });
  for (const b of (g.buildings ?? []) as Building[]) {
    const color = b.style?.color ?? (b.style?.facade === "glass" ? MODEL.glass : MODEL.building[b.use] ?? DEFAULT_BUILDING);
    for (const m of b.masses)
      prism(
        faces,
        m.poly[0].map(([x, y]) => [x, y, m.base] as V3),
        Math.max(0.3, m.top - m.base),
        color,
        true,
        m.poly.slice(1).map((r) => r.map(([x, y]) => [x, y, m.base] as V3)),
      );
    if (b.greenRoof) for (const m of b.masses) faces.push({ pts: m.poly[0].map(([x, y]) => [x, y, m.top + 0.05] as V3), color: MODEL.area.park, n: [0, 0, 1] });
    for (const s of b.solids ?? []) solid(faces, balls, s, 0, 0, 0);
  }
  for (const p of (g.props ?? []) as Prop[]) for (const s of p.solids) solid(faces, balls, p.paint ? { ...s, color: p.paint } : s, p.p[0], p.p[1], (p.rot * Math.PI) / 180);
  for (const t of (g.trees ?? []) as Tree[]) {
    const c = t.paint ?? speciesOf(t.species)?.color ?? [96, 134, 74];
    prism(faces, Array.from({ length: 6 }, (_, i) => [t.p[0] + Math.cos((i / 6) * Math.PI * 2) * 0.25, t.p[1] + Math.sin((i / 6) * Math.PI * 2) * 0.25, 0] as V3), t.h * 0.45, [110, 88, 66]);
    balls.push({ c: [t.p[0], t.p[1], t.h * 0.62], r: t.r, color: c, sz: Math.min(1.1, (t.h * 0.55) / (t.r * 2)) * 1.6 });
  }
  if (!faces.length && !balls.length && !ground.length && !lines.length) return null;

  // fit everything into the tile
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const grow = (p: V3, pad = 0) => {
    const [sx, sy] = project(p);
    x0 = Math.min(x0, sx - pad);
    x1 = Math.max(x1, sx + pad);
    y0 = Math.min(y0, sy - pad);
    y1 = Math.max(y1, sy + pad);
  };
  for (const f of faces) for (const p of f.pts) grow(p);
  for (const b of balls) {
    grow(b.c, b.r);
    grow([b.c[0], b.c[1], b.c[2] + b.r * b.sz], b.r * 0.3);
  }
  for (const r of ground) for (const [x, y] of r.ring) grow([x, y, 0]);
  for (const l of lines) for (const [x, y] of l.path) grow([x, y, 0], l.width);
  const pad = 0.12;
  const k = Math.min((W * (1 - 2 * pad)) / Math.max(0.5, x1 - x0), (H * (1 - 2 * pad)) / Math.max(0.5, y1 - y0));
  const ox = W / 2 - ((x0 + x1) / 2) * k,
    oy = H / 2 - ((y0 + y1) / 2) * k;
  const toScreen = (p: V3): [number, number] => {
    const [sx, sy] = project(p);
    return [ox + sx * k, oy + sy * k];
  };

  const cv = document.createElement("canvas");
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const c = cv.getContext("2d");
  if (!c) return null;
  c.scale(dpr, dpr);
  c.lineJoin = "round";
  c.lineCap = "round";

  // ground: areas, then paths and streets, then a soft contact shadow under the solids
  for (const r of ground) {
    c.beginPath();
    r.ring.forEach(([x, y], i) => {
      const [sx, sy] = toScreen([x, y, 0]);
      if (i) c.lineTo(sx, sy);
      else c.moveTo(sx, sy);
    });
    c.closePath();
    c.fillStyle = shade(r.color);
    c.fill();
  }
  for (const l of lines) {
    c.beginPath();
    l.path.forEach(([x, y], i) => {
      const [sx, sy] = toScreen([x, y, 0]);
      if (i) c.lineTo(sx, sy);
      else c.moveTo(sx, sy);
    });
    c.strokeStyle = shade(l.color);
    c.lineWidth = Math.max(1.2, l.width * k * 0.8);
    c.stroke();
  }
  const foot = faces.flatMap((f) => f.pts.filter((p) => p[2] < 0.2));
  if (foot.length || balls.length) {
    const pts = [...foot.map((p) => toScreen([p[0], p[1], 0])), ...balls.map((b) => toScreen([b.c[0], b.c[1], 0]))];
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length,
      my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const rx = Math.max(6, (Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))) / 2 + 4);
    const ry = Math.max(3, (Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))) / 2 + 2);
    const grad = c.createRadialGradient(mx, my, 0, mx, my, rx);
    grad.addColorStop(0, GROUND_SHADOW);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    c.save();
    c.translate(mx, my);
    c.scale(1, ry / rx);
    c.translate(-mx, -my);
    c.fillStyle = grad;
    c.beginPath();
    c.arc(mx, my, rx, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  // solids back to front (painter's order by mean depth)
  type Item = { depth: number; paint: () => void };
  const items: Item[] = [];
  for (const f of faces) {
    const depth = f.pts.reduce((s, p) => s + project(p)[2], 0) / f.pts.length - (f.n && f.n[2] > 0.9 ? 0.01 : 0);
    items.push({
      depth,
      paint: () => {
        c.beginPath();
        for (const ring of [f.pts, ...(f.holes ?? [])]) {
          ring.forEach((p, i) => {
            const [sx, sy] = toScreen(p);
            if (i) c.lineTo(sx, sy);
            else c.moveTo(sx, sy);
          });
          c.closePath();
        }
        c.fillStyle = shade(f.color, f.n);
        c.fill("evenodd");
        // a hairline of the same colour hides seams between neighbouring faces
        c.strokeStyle = c.fillStyle;
        c.lineWidth = 0.6;
        c.stroke();
      },
    });
  }
  for (const b of balls) {
    items.push({
      depth: project(b.c)[2],
      paint: () => {
        const [sx, sy] = toScreen(b.c);
        const r = b.r * k;
        const ry = r * Math.max(0.45, Math.min(1.3, b.sz * CE + SE * 0.4));
        const grad = c.createRadialGradient(sx - r * 0.35, sy - ry * 0.4, r * 0.1, sx, sy, r * 1.05);
        grad.addColorStop(0, shade(b.color, [0, 0, 1]));
        grad.addColorStop(1, shade(b.color, [0.5, 0.6, -0.2]));
        c.fillStyle = grad;
        c.beginPath();
        c.ellipse(sx, sy, r, ry, 0, 0, Math.PI * 2);
        c.fill();
      },
    });
  }
  items.sort((a, b) => b.depth - a.depth);
  for (const it of items) it.paint();
  return cv.toDataURL("image/png");
}

const cache = new Map<string, string | null>();
const keyOf = (def: PrimitiveDef, params: ParamValues | undefined, w: number, h: number) => `${def.id}|${w}x${h}|${params ? JSON.stringify(params) : ""}`;

/** a cached preview, or undefined if it hasn't been drawn yet (null: nothing drawable) */
export function cachedThumbnail(def: PrimitiveDef, w: number, h: number, params?: ParamValues): string | null | undefined {
  return cache.get(keyOf(def, params, w, h));
}

/** draw (or fetch from the cache) a preview: an image URL, or null when the primitive has nothing to draw */
export function thumbnail(def: PrimitiveDef, w: number, h: number, params?: ParamValues): string | null {
  const key = keyOf(def, params, w, h);
  if (cache.has(key)) return cache.get(key)!;
  let url: string | null = null;
  try {
    url = draw(def, params ?? defaultParams(def), w, h, Math.min(2, window.devicePixelRatio || 1));
  } catch {
    url = null;
  }
  // a parameter-specific preview (the configure view) is one of many: keep the cache bounded
  if (params && cache.size > 400) for (const k of [...cache.keys()].slice(0, 100)) if (k.split("|")[2]) cache.delete(k);
  cache.set(key, url);
  return url;
}

/** a cached preview of any geometry under `key` (the palettes' massing, species and surfaces) */
export function sceneThumbnail(key: string, build: () => Drawable, w: number, h: number): string | null {
  const k = `scene:${key}|${w}x${h}`;
  if (cache.has(k)) return cache.get(k)!;
  let url: string | null = null;
  try {
    url = renderGenerated(build(), w, h, Math.min(2, window.devicePixelRatio || 1));
  } catch {
    url = null;
  }
  cache.set(k, url);
  return url;
}

// ---- lazy drawing: tiles queue themselves as they scroll into view; idle time works the queue

const queue: { run: () => void }[] = [];
let scheduled = false;
type Idle = (cb: (d: { timeRemaining: () => number }) => void) => void;
function work(left: () => number) {
  scheduled = false;
  const t0 = performance.now();
  // a few per slice so scrolling stays smooth
  while (queue.length && (left() > 2 || performance.now() - t0 < 6)) queue.shift()!.run();
  if (queue.length) schedule();
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  const ric = (window as unknown as { requestIdleCallback?: Idle }).requestIdleCallback;
  if (ric) ric((d) => work(() => d.timeRemaining()));
  else setTimeout(() => work(() => 8), 16);
}

/** draw a preview in idle time; `done` gets the URL. Returns a cancel function. */
export function requestThumbnail(def: PrimitiveDef, w: number, h: number, done: (url: string | null) => void, params?: ParamValues): () => void {
  const hit = cachedThumbnail(def, w, h, params);
  if (hit !== undefined) {
    done(hit);
    return () => {};
  }
  const job = { run: () => done(thumbnail(def, w, h, params)) };
  queue.push(job);
  schedule();
  return () => {
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
  };
}
