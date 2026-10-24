import { COORDINATE_SYSTEM, type Layer, type Position } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers";
import { pointInPoly, polyBBox } from "@/geometry/polygon";
import { pointAt, polyLength } from "@/geometry/polyline";
import { speciesOf } from "@/world/species";
import { draw, finishPoint } from "@/state/drawing";
import { rtMaybe } from "@/state/runtime";
import { useApp } from "@/state/store";
import { TREE_PROBLEM_LABEL, pointProblem, shapeConflicts, streetConflicts, treeProblem } from "@/world/ops/placement";
import { streetBand } from "@/world/ops/validate";
import type { Building, Vec2 } from "@/world/types";

type C4 = [number, number, number, number];
const ROYAL: C4 = [40, 71, 166, 255];
const CREAM: C4 = [246, 221, 133, 255];
const RED: C4 = [226, 72, 64, 255];
const OK: C4 = [120, 196, 120, 255];
const FLAT = { depthCompare: "always", depthWriteEnabled: false } as const;

/** the trees a row / area planting would place, each with whether it can stand there */
function treeCandidates(tool: "single" | "row" | "area", pts: Vec2[], r: number, spacing: number): { p: Vec2; ok: boolean; why?: string }[] {
  const R = rtMaybe()!;
  const out: { p: Vec2; ok: boolean; why?: string }[] = [];
  const placed: Vec2[] = [];
  const test = (p: Vec2) => {
    const bad = treeProblem(R.world, p, r, placed);
    if (!bad) placed.push(p);
    out.push({ p, ok: !bad, why: bad ? TREE_PROBLEM_LABEL[bad] : undefined });
  };
  if (tool === "single") test(pts[0]);
  else if (tool === "row") {
    const L = polyLength(pts);
    for (let a = 0; a <= L + 1e-6 && out.length < 400; a += Math.max(3, spacing)) test(pointAt(pts, a).p);
  } else if (pts.length >= 3) {
    const [x0, y0, x1, y1] = polyBBox([pts]);
    const sp = Math.max(3, spacing);
    for (let x = x0; x < x1 && out.length < 600; x += sp)
      for (let y = y0; y < y1 && out.length < 600; y += sp) if (pointInPoly([x, y], [pts])) test([x, y]);
  }
  return out;
}

export function toolLayers(): { ground: Layer[]; top: Layer[] } {
  const R = rtMaybe();
  const tool = useApp.getState().tool;
  if (!R || (tool === "select" && !draw.pending)) return { ground: [], top: [] };
  const common = { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: [R.meta.origin.lon, R.meta.origin.lat, 0] as [number, number, number] };
  const planting = useApp.getState().planting;
  const closing = finishPoint(draw.cursor);
  const live = [...draw.points, ...(draw.cursor && draw.points.length && !closing ? [draw.cursor] : [])];
  const pts = draw.pending ? draw.pending.points : live;
  const layers: Layer[] = [];
  const label = (p: Vec2, text: string, tone: "bad" | "ok" = "bad") =>
    new TextLayer({
      id: "draw-label",
      ...common,
      data: [{ p, t: text }],
      getPosition: (d: { p: Vec2 }) => [d.p[0], d.p[1], 1],
      getText: (d: { t: string }) => d.t,
      getSize: 12.5,
      getColor: [255, 255, 255, 255],
      background: true,
      getBackgroundColor: tone === "bad" ? [189, 58, 44, 240] : [20, 34, 77, 235],
      backgroundPadding: [7, 4],
      getPixelOffset: [0, -26],
      fontFamily: "Geist, system-ui, sans-serif",
      fontWeight: 600,
      characterSet: "auto",
      parameters: FLAT,
    });

  // ---- trees: every crown that would be planted, green where it can stand, red where it can't
  if (tool === "tree" && !draw.pending) {
    const sp = speciesOf(planting.species);
    const r = sp?.r ?? 4;
    const mode = planting.mode;
    const src = mode === "single" ? (draw.cursor ? [draw.cursor] : []) : live;
    const cands = src.length ? treeCandidates(mode, src, r, planting.spacing) : [];
    if (mode === "area" && src.length >= 2)
      layers.push(
        new SolidPolygonLayer({ id: "draw-fill", ...common, data: [{ polygon: src }], getPolygon: (d: { polygon: Position[] }) => d.polygon, getFillColor: [40, 71, 166, 36], parameters: FLAT }),
        new PathLayer({ id: "draw-path", ...common, data: [{ path: [...src, src[0]] }], getPath: (d: { path: Position[] }) => d.path.map((p) => [p[0], p[1], 0.5] as Position), getColor: ROYAL, getWidth: 2, widthUnits: "pixels", parameters: FLAT }),
      );
    if (mode === "row" && src.length >= 2)
      layers.push(new PathLayer({ id: "draw-path", ...common, data: [{ path: src }], getPath: (d: { path: Position[] }) => d.path.map((p) => [p[0], p[1], 0.5] as Position), getColor: [40, 71, 166, 150], getWidth: 1.5, widthUnits: "pixels", parameters: FLAT }));
    if (cands.length)
      layers.push(
        new ScatterplotLayer<{ p: Vec2; ok: boolean }>({
          id: "draw-crowns",
          ...common,
          data: cands,
          getPosition: (d) => [d.p[0], d.p[1], 0.6],
          getRadius: r,
          getFillColor: (d) => (d.ok ? [OK[0], OK[1], OK[2], 90] : [RED[0], RED[1], RED[2], 110]),
          getLineColor: (d) => (d.ok ? OK : RED),
          stroked: true,
          lineWidthUnits: "pixels",
          getLineWidth: 2,
          parameters: FLAT,
        }),
      );
    if (closing) layers.push(closeHandle(closing, common));
    const bad = cands.filter((c) => !c.ok);
    if (mode === "single" && bad.length) layers.push(label(cands[0].p, bad[0].why!));
    else if (mode !== "single" && draw.cursor && !closing) {
      // the corner under the cursor itself must be placeable
      const why = pointProblem(R.world, "area", draw.cursor);
      if (why) layers.push(cursorDot(draw.cursor, false, common), label(draw.cursor, why));
      else if (bad.length) layers.push(label(draw.cursor, `${bad.length} blocked`));
    }
    return { ground: [], top: layers };
  }

  // the spot under the cursor: red with the reason when a point can't go there
  const cursorWhy = draw.cursor && !draw.pending && !closing && tool !== "measure" ? pointProblem(R.world, tool, draw.cursor) : null;
  if (draw.cursor && !draw.pending && !closing) layers.push(cursorDot(draw.cursor, !cursorWhy, common));
  if (!pts.length) {
    if (cursorWhy) layers.push(label(draw.cursor!, cursorWhy));
    return { ground: [], top: layers };
  }
  const shapeTool = (draw.pending?.tool ?? tool) as string;
  const closed = shapeTool === "building" || shapeTool === "area" || shapeTool === "district";
  // ---- what the shape runs into: conflicting buildings and road right-of-way in red
  let bad = false;
  let message: string | null = null;
  let hitBuildings: Building[] = [];
  let bands: Vec2[][] = [];
  if (closed && pts.length >= 3) {
    const c = shapeConflicts(R.world, shapeTool as "building" | "area", pts as Vec2[]);
    bad = c.blocking;
    message = c.message;
    hitBuildings = c.buildings;
    bands = c.streets.map((s) => streetBand(s)[0]);
  } else if (shapeTool === "street" && pts.length >= 2) {
    hitBuildings = streetConflicts(R.world, pts as Vec2[]);
    if (hitBuildings.length) {
      bad = true;
      message = `Cuts through ${hitBuildings.length} building${hitBuildings.length > 1 ? "s" : ""}`;
    }
  }
  const stroke = bad ? RED : ROYAL;
  if (bands.length)
    layers.push(new SolidPolygonLayer({ id: "draw-row-conflict", ...common, data: bands.map((b) => ({ polygon: b })), getPolygon: (d: { polygon: Position[] }) => d.polygon, getFillColor: [226, 72, 64, 70], parameters: FLAT }));
  if (hitBuildings.length)
    layers.push(
      new SolidPolygonLayer<Building>({
        id: "draw-bld-conflict",
        ...common,
        data: hitBuildings,
        getPolygon: (b) => b.footprint[0] as Position[],
        extruded: true,
        getElevation: (b) => b.height + 0.3,
        getFillColor: [226, 72, 64, 150],
        material: false,
        parameters: { depthWriteEnabled: false },
      }),
    );
  if (closed && pts.length >= 3)
    layers.push(
      new SolidPolygonLayer({
        id: "draw-fill",
        ...common,
        data: [{ polygon: pts }],
        getPolygon: (d: { polygon: Position[] }) => d.polygon,
        getFillColor: bad ? [226, 72, 64, 55] : [40, 71, 166, 40],
        parameters: FLAT,
      }),
    );
  layers.push(
    new PathLayer({
      id: "draw-path",
      ...common,
      data: [{ path: closed && pts.length >= 3 ? [...pts, pts[0]] : pts }],
      getPath: (d: { path: Position[] }) => d.path.map((p) => [p[0], p[1], 0.5] as Position),
      getColor: stroke,
      getWidth: 2,
      widthUnits: "pixels",
      parameters: FLAT,
    }),
    new ScatterplotLayer({
      id: "draw-pts",
      ...common,
      data: pts,
      getPosition: (p: Position) => [p[0], p[1], 0.6],
      getRadius: 4,
      radiusUnits: "pixels",
      getFillColor: [255, 255, 255, 255],
      getLineColor: stroke,
      stroked: true,
      lineWidthMinPixels: 2,
      parameters: FLAT,
    }),
  );
  if (closing) layers.push(closeHandle(closing, common));
  if (cursorWhy) layers.push(label(draw.cursor!, cursorWhy));
  else if (message && !draw.pending) layers.push(label(pts[pts.length - 1] as Vec2, message));
  if (tool === "measure" && pts.length >= 2) {
    const L = polyLength(pts as [number, number][]);
    layers.push(label(pts[pts.length - 1] as Vec2, L >= 1000 ? `${(L / 1000).toFixed(2)} km` : `${L.toFixed(1)} m`, "ok"));
  }
  return { ground: [], top: layers };
}

/** a small marker where the next point would go: royal blue when it can, red when it can't */
function cursorDot(p: Vec2, ok: boolean, common: object): Layer {
  return new ScatterplotLayer({
    id: "draw-cursor",
    ...common,
    data: [p],
    getPosition: (q: Vec2) => [q[0], q[1], 0.7],
    getRadius: 5,
    radiusUnits: "pixels",
    getFillColor: ok ? [255, 255, 255, 255] : RED,
    getLineColor: ok ? ROYAL : [255, 255, 255, 255],
    stroked: true,
    lineWidthMinPixels: 2,
    parameters: FLAT,
  });
}

/** the point that finishes the drawing (first corner / last street point), enlarged while the cursor is on it */
function closeHandle(p: Vec2, common: object): Layer {
  return new ScatterplotLayer({
    id: "draw-close",
    ...common,
    data: [p],
    getPosition: (q: Vec2) => [q[0], q[1], 0.7],
    getRadius: 8,
    radiusUnits: "pixels",
    getFillColor: CREAM,
    getLineColor: ROYAL,
    stroked: true,
    lineWidthMinPixels: 2.5,
    parameters: FLAT,
  });
}
