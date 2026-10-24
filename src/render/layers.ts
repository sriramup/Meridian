import { COORDINATE_SYSTEM, type Layer, type Position } from "@deck.gl/core";
import { PathStyleExtension } from "@deck.gl/extensions";
import { PathLayer, PolygonLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { polyCentroid } from "@/geometry/polygon";
import { polyLength, pointAt } from "@/geometry/polyline";
import type { Runtime } from "@/state/runtime";
import type { AppState } from "@/state/store";
import type { Entity, Street, TransitRoute } from "@/world/types";
import { FacadeLayer } from "./FacadeLayer";
import { fadedGround } from "./edge";
import { coneMesh, crownMesh, cylinderMesh, sphereMesh } from "./meshes";
import { outlineFor, type MarkDatum, type MassDatum, type SurfaceDatum, type TreeDatum } from "./scene";
import type { RGB, RGBA, Theme } from "./theme";

const SPHERE = sphereMesh();
const CYL = cylinderMesh();
const CROWN = crownMesh();
const CONE = coneMesh();
const dashExt = new PathStyleExtension({ dash: true, highPrecisionDash: true });

const FLAT = { depthWriteEnabled: false, depthCompare: "always" } as const;

export interface LayerContext {
  rt: Runtime;
  theme: Theme;
  app: Pick<AppState, "selection" | "layers" | "highlight" | "theme" | "cameraMode">;
  zoom: number;
  /** of the modelled month: leaves turn in fall and are dead in winter */
  season: Season;
}

export type Season = "spring" | "summer" | "fall" | "winter";
/** meteorological seasons from a "MM-DD" date */
export function seasonOf(date: string): Season {
  const m = +date.slice(0, 2);
  return m >= 3 && m <= 5 ? "spring" : m <= 8 && m >= 6 ? "summer" : m >= 9 && m <= 11 ? "fall" : "winter";
}

/** autumn colours, picked per tree so a row doesn't turn as one */
const FALL: RGB[] = [
  [214, 116, 44],
  [232, 160, 58],
  [196, 84, 46],
  [226, 136, 40],
  [204, 150, 70],
];
/** dead winter leaves: dry browns and greys */
const WINTER: RGB[] = [
  [132, 106, 80],
  [118, 98, 80],
  [146, 120, 92],
];

/**
 * The scene in three stacked sections: analysis overlays go between them (ground overlays above
 * the street surfaces and below buildings, top overlays below the labels), so an overlay or the
 * clock changing doesn't rebuild the scene.
 */
export interface SceneLayers {
  ground: Layer[];
  solid: Layer[];
  labels: Layer[];
}

export function stackLayers(s: SceneLayers, extra: { ground: Layer[]; top: Layer[] }): Layer[] {
  return [...s.ground, ...extra.ground, ...s.solid, ...extra.top, ...s.labels];
}

/** zoom levels where the scene's level of detail changes; between them the layers are reused */
const ZOOM_STEPS = [14.4, 14.8, 15, 15.2, 16.6];
/** a zoom standing for its whole detail band, so a smooth zoom only rebuilds layers at the steps */
export function zoomBand(z: number): number {
  let band = 0;
  for (const s of ZOOM_STEPS) if (z >= s) band = s;
  return band;
}

/** tree instances gathered across chunks; reused while no chunk's trees changed */
let treeCache: { src: unknown[]; trees: TreeDatum[]; conifers: TreeDatum[]; all: TreeDatum[] } | null = null;
function treeData(chunks: { trees: TreeDatum[] }[]) {
  const src = chunks.map((c) => c.trees);
  if (treeCache && treeCache.src.length === src.length && src.every((t, i) => t === treeCache!.src[i])) return treeCache;
  const trees: TreeDatum[] = [];
  const conifers: TreeDatum[] = [];
  for (const list of src) for (const t of list) (t.shape === "conical" ? conifers : trees).push(t);
  return (treeCache = { src, trees, conifers, all: [...trees, ...conifers] });
}

let labelCache: { version: number; data: { text: string; position: Position; angle: number; size: number }[] } = { version: -1, data: [] };

function streetLabels(rt: Runtime) {
  const v = rt.world.version;
  if (labelCache.version === v) return labelCache.data;
  const byName = new Map<string, Street[]>();
  for (const s of rt.world.all("street")) {
    if (!s.name || s.cls === "service" || s.cls === "motorway_link") continue;
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name)!.push(s);
  }
  const data: typeof labelCache.data = [];
  for (const [name, list] of byName) {
    // one label per ~350 m of named street, placed on the longest segments
    const sorted = list.slice().sort((a, b) => polyLength(b.path) - polyLength(a.path));
    const placed: number[][] = [];
    for (const s of sorted) {
      const L = polyLength(s.path);
      if (L < 70) continue;
      const { p, dir } = pointAt(s.path, L / 2);
      if (placed.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 350)) continue;
      placed.push(p);
      let ang = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;
      data.push({ text: name.toUpperCase(), position: [p[0], p[1], 0.5], angle: ang, size: s.cls === "primary" || s.cls === "secondary" || s.cls === "motorway" ? 13 : 11 });
    }
  }
  labelCache = { version: v, data };
  return data;
}

let plantedCache: { all: TreeDatum[]; out: TreeDatum[] } | null = null;
function plantedTrees(all: TreeDatum[]) {
  if (plantedCache?.all !== all) plantedCache = { all, out: all.filter((t) => t.proposed) };
  return plantedCache.out;
}

let gridCache: { key: string; data: { path: Position[]; w: number; a: number }[] } | null = null;
function siteGrid(b: readonly number[], T: Theme, common: object): Layer {
  const key = b.join(",");
  if (gridCache?.key !== key) {
    const data: { path: Position[]; w: number; a: number }[] = [];
    for (let x = Math.ceil(b[0] / 100) * 100; x <= b[2]; x += 100) data.push({ path: [[x, b[1]], [x, b[3]]], w: x % 500 ? 1 : 1.4, a: x % 500 ? 0.35 : 0.7 });
    for (let y = Math.ceil(b[1] / 100) * 100; y <= b[3]; y += 100) data.push({ path: [[b[0], y], [b[2], y]], w: y % 500 ? 1 : 1.4, a: y % 500 ? 0.35 : 0.7 });
    data.push({ path: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]], w: 2, a: 1 });
    gridCache = { key, data };
  }
  const line = (T.id === "night" ? T.land.map((c) => c + 34) : T.land.map((c) => c - 34)) as [number, number, number];
  return new PathLayer<{ path: Position[]; w: number; a: number }>({
    id: "site-grid",
    ...common,
    data: gridCache.data,
    getPath: (d) => d.path,
    getWidth: (d) => d.w,
    widthUnits: "pixels",
    getColor: (d) => [...line, 255 * d.a] as RGBA,
    updateTriggers: { getColor: [T.id] },
    parameters: FLAT,
  });
}

type Outlined = { e: Entity | undefined; color: RGBA; width: number };

/**
 * Outlines: buildings' 3D edges are depth-tested (a corner or base edge behind the building is
 * not drawn through it); flat outlines stay on top of everything.
 */
function outlineLayers(id: string, common: object, rt: Runtime, items: Outlined[]): Layer[] {
  const solid: { path: Position[]; color: RGBA; width: number }[] = [];
  const flat: typeof solid = [];
  for (const it of items) if (it.e) for (const o of outlineFor(it.e, rt.world)) (o.solid ? solid : flat).push({ path: o.path, color: it.color, width: it.width });
  const layer = (sub: string, data: typeof solid, depthCompare: "less-equal" | "always") =>
    new PathLayer<(typeof solid)[number]>({
      id: `${id}-${sub}`,
      ...common,
      data,
      getPath: (d) => d.path,
      getColor: (d) => d.color,
      getWidth: (d) => d.width,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      parameters: { depthCompare, depthWriteEnabled: false },
    });
  return [...(solid.length ? [layer("solid", solid, "less-equal")] : []), ...(flat.length ? [layer("flat", flat, "always")] : [])];
}

/** the hover outline, kept out of the scene layers so moving the pointer doesn't rebuild them */
export function hoverLayers(rt: Runtime, T: Theme, hover: string | null, selection: string[]): Layer[] {
  if (!hover || selection.includes(hover)) return [];
  const origin = [rt.meta.origin.lon, rt.meta.origin.lat, 0] as [number, number, number];
  return outlineLayers("hover", { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: origin }, rt, [{ e: rt.world.get(hover), color: [...T.hover, 200], width: 2 }]);
}

export function buildLayers(ctx: LayerContext): SceneLayers {
  const { rt, theme: T, app } = ctx;
  const origin = [rt.meta.origin.lon, rt.meta.origin.lat, 0] as [number, number, number];
  const common = { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: origin };
  const chunks = rt.scene.list();
  const paint = rt.scene.paint;
  const layers: Layer[] = [];
  const b = rt.meta.bounds;
  const pad = 2400;

  // ---- ground
  layers.push(
    new SolidPolygonLayer<{ polygon: Position[][]; alpha: number }>({
      id: "ground",
      ...common,
      data: fadedGround(b),
      getPolygon: (d) => d.polygon,
      getFillColor: (d) => [...T.land, 255 * d.alpha] as RGBA,
      updateTriggers: { getFillColor: [T.id] },
      parameters: FLAT,
    }),
  );
  // blank canvas: a faint survey grid (100 m, stronger every 500 m) and the edge of the site
  if (rt.meta.sandbox) layers.push(siteGrid(b, T, common));
  if (app.layers.context && !rt.meta.sandbox) {
    layers.push(
      new SolidPolygonLayer({
        id: "ctx-areas",
        ...common,
        data: rt.context.areas,
        getPolygon: (d: { polygon: Position[] }) => d.polygon,
        getFillColor: (d: { type: string; fade: number }) => [...(T.area[d.type as keyof Theme["area"]] ?? T.context), 200 * d.fade] as RGBA,
        updateTriggers: { getFillColor: [T.id] },
        parameters: FLAT,
      }),
      new PathLayer({
        id: "ctx-roads",
        ...common,
        data: rt.context.roads,
        getPath: (d: { path: Position[] }) => d.path,
        getWidth: (d: { cls: string }) => (d.cls === "motorway" ? 22 : d.cls === "primary" || d.cls === "trunk" ? 16 : d.cls === "secondary" ? 13 : d.cls === "tertiary" ? 11 : 8),
        widthUnits: "meters",
        getColor: (d: { fade: number }) => [...T.contextRoad, 255 * d.fade] as RGBA,
        updateTriggers: { getColor: [T.id] },
        jointRounded: true,
        capRounded: true,
        parameters: FLAT,
      }),
    );
  }

  // ---- areas, paths, street surfaces, markings (flat, draw order = stacking)
  for (const c of chunks) {
    if (c.areas.length)
      layers.push(
        new SolidPolygonLayer<SurfaceDatum>({
          id: `areas-${c.key}`,
          ...common,
          data: c.areas,
          getPolygon: (d) => d.polygon as Position[][],
          getFillColor: (d) => d.color,
          updateTriggers: { getFillColor: paint },
          pickable: true,
          parameters: FLAT,
        }),
      );
  }
  if (app.layers.paths)
    for (const c of chunks)
      if (c.paths.length)
        layers.push(
          new PathLayer({
            id: `paths-${c.key}`,
            ...common,
            data: c.paths,
            getPath: (d: { path: Position[] }) => d.path,
            getColor: (d: { color: RGBA }) => d.color,
            getWidth: (d: { width: number }) => d.width,
            updateTriggers: { getColor: paint },
            widthUnits: "meters",
            widthMinPixels: 1,
            parameters: FLAT,
          }),
        );
  for (const c of chunks)
    if (c.surfaces.length)
      layers.push(
        new SolidPolygonLayer<SurfaceDatum>({
          id: `surf-${c.key}`,
          ...common,
          data: c.surfaces,
          getPolygon: (d) => d.polygon as Position[],
          getFillColor: (d) => d.color,
          updateTriggers: { getFillColor: paint },
          pickable: true,
          parameters: FLAT,
        }),
      );
  if (app.layers.markings && ctx.zoom >= 15.2)
    for (const c of chunks)
      if (c.marks.length)
        layers.push(
          new PathLayer<MarkDatum, { getDashArray: (d: MarkDatum) => [number, number]; dashJustified: boolean }>({
            id: `marks-${c.key}`,
            ...common,
            data: c.marks,
            getPath: (d) => d.path,
            getColor: (d) => d.color,
            getWidth: (d) => d.width,
            widthUnits: "meters",
            getDashArray: (d) => d.dash,
            updateTriggers: { getColor: paint },
            dashJustified: false,
            capRounded: false,
            extensions: [dashExt],
            parameters: FLAT,
          }),
        );

  // ---- kerbs / pedestrian realm (low extrusion)
  for (const c of chunks)
    if (c.kerbs.length)
      layers.push(
        new SolidPolygonLayer<SurfaceDatum>({
          id: `kerb-${c.key}`,
          ...common,
          data: c.kerbs,
          getPolygon: (d) => d.polygon as Position[],
          getFillColor: (d) => d.color,
          updateTriggers: { getFillColor: paint },
          extruded: true,
          getElevation: (d) => (d.kind === "island" ? 0.25 : 0.15),
          pickable: true,
          material: { ambient: 0.9, diffuse: 0.25, shininess: 0, specularColor: [0, 0, 0] },
        }),
      );

  // analysis overlays sit here: above the pedestrian realm and below buildings
  const ground = layers.splice(0);

  // ---- selection / highlight outlines
  const outlined: Outlined[] = app.selection.map((id) => ({ e: rt.world.get(id), color: [...T.selection, 255] as RGBA, width: 3 }));
  if (app.highlight) for (const id of app.highlight.ids) outlined.push({ e: rt.world.get(id), color: [...(app.highlight.color ?? T.proposedEdge), 255], width: 3 });

  // ---- buildings
  for (const c of chunks)
    if (c.masses.length)
      layers.push(
        new FacadeLayer<MassDatum>({
          id: `bld-${c.key}`,
          ...common,
          data: c.masses,
          getPolygon: (d) => d.polygon,
          getElevation: (d) => d.height,
          getFillColor: (d) => d.color,
          updateTriggers: { getFillColor: paint },
          extruded: true,
          pickable: true,
          night: T.night,
          detail: ctx.zoom >= 14.4 ? 1 : 0,
          material: { ambient: 0.55, diffuse: 0.6, shininess: 24, specularColor: [40, 40, 40] },
        }),
      );
  if (app.layers.context)
    layers.push(
      new FacadeLayer<{ polygon: Position[]; height: number; fade: number }>({
        id: "ctx-buildings",
        ...common,
        data: rt.context.buildings,
        getPolygon: (d: { polygon: Position[] }) => d.polygon,
        // at the city's rim: lower and closer to the ground colour
        getElevation: (d: { height: number; fade: number }) => d.height * (0.1 + 0.9 * d.fade),
        getFillColor: (d: { fade: number }) => T.contextBuilding.map((c, i) => T.land[i] + (c - T.land[i]) * d.fade).concat(251) as RGBA,
        updateTriggers: { getFillColor: [T.id] },
        extruded: true,
        night: T.night,
        detail: ctx.zoom >= 15 ? 1 : 0,
        material: { ambient: 0.6, diffuse: 0.5, shininess: 0, specularColor: [0, 0, 0] },
      }),
    );

  // ---- trees
  if (app.layers.trees) {
    const { trees, conifers, all } = treeData(chunks);
    const season = ctx.season;
    const tint = (d: TreeDatum): RGBA => {
      const pick = (c: RGB[]) => c[Math.floor(d.seed * 997) % c.length];
      const base = season === "fall" ? pick(FALL) : season === "winter" ? pick(WINTER) : d.color ?? (d.proposed ? [118, 172, 96] : T.tree);
      const k = (0.9 + d.seed * 0.2) * (T.id === "night" && season !== "spring" && season !== "summer" ? 0.55 : 1);
      return [Math.min(255, base[0] * k), Math.min(255, base[1] * k), Math.min(255, base[2] * k), 255];
    };
    // bare in winter: the dead leaves that are left make a thinner crown (the tree keeps its height)
    const leafy = season === "winter" ? 0.72 : 1;
    // crown proportions by habit: spreading oaks are wide and low, vase elms taller than wide
    const squash = (d: TreeDatum) => (d.shape === "spreading" ? 0.58 : d.shape === "vase" ? 0.95 : 0.82) * (0.94 + d.seed * 0.12);
    const close = ctx.zoom >= 16.6;
    const planted = rt.scene.showChanges ? plantedTrees(all) : [];
    if (planted.length)
      layers.push(
        // gold rings on the ground mark every tree the plan adds
        new ScatterplotLayer<TreeDatum>({
          id: "tree-planted-rings",
          ...common,
          data: planted,
          getPosition: (d) => [d.position[0], d.position[1], 0.5],
          getRadius: (d) => d.r + 1.4,
          getFillColor: [232, 190, 112, 90],
          getLineColor: [240, 196, 96, 255],
          stroked: true,
          lineWidthUnits: "pixels",
          getLineWidth: 2.5,
          lineWidthMinPixels: 1.5,
          parameters: { depthWriteEnabled: false },
        }),
      );
    layers.push(
      new SimpleMeshLayer<TreeDatum>({
        id: "tree-trunks",
        ...common,
        data: all,
        mesh: CYL as never,
        getPosition: (d) => d.position,
        getScale: (d) => (d.shape === "conical" ? [0.25 + d.r * 0.04, 0.25 + d.r * 0.04, d.h * 0.3] : [0.22 + d.r * 0.03, 0.22 + d.r * 0.03, Math.max(1.5, d.h - d.r * squash(d) * 1.6)]),
        getColor: [...T.trunk, 255],
      }),
      new SimpleMeshLayer<TreeDatum>({
        id: "tree-canopies",
        ...common,
        data: trees,
        mesh: (close ? CROWN : SPHERE) as never,
        getPosition: (d) => [d.position[0], d.position[1], Math.max(d.r * squash(d), d.h - d.r * squash(d))],
        getScale: (d) => [d.r * leafy, d.r * leafy, d.r * squash(d) * leafy],
        getOrientation: (d) => [0, d.seed * 360, 0],
        getColor: tint,
        pickable: true,
        updateTriggers: { getColor: [T.id, season], getScale: [season] },
        material: { ambient: 0.55, diffuse: 0.7, shininess: 4, specularColor: [20, 30, 20] },
      }),
      new SimpleMeshLayer<TreeDatum>({
        id: "tree-conifers",
        ...common,
        data: conifers,
        mesh: CONE as never,
        getPosition: (d) => [d.position[0], d.position[1], d.h * 0.22],
        getScale: (d) => [d.r * leafy, d.r * leafy, d.h * 0.8],
        getColor: tint,
        updateTriggers: { getColor: [T.id, season], getScale: [season] },
        pickable: true,
        material: { ambient: 0.55, diffuse: 0.7, shininess: 4, specularColor: [20, 30, 20] },
      }),
    );
  }

  layers.push(...outlineLayers("outlines", common, rt, outlined));

  // ---- transit
  if (app.layers.transit) {
    const routes = rt.world.all("route") as TransitRoute[];
    layers.push(
      new PathLayer<TransitRoute>({
        id: "transit-routes",
        ...common,
        data: routes,
        getPath: (d) => d.path.map((p) => [p[0], p[1], 1.2] as Position),
        getColor: (d) => {
          const h = d.color.replace("#", "");
          return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 210];
        },
        getWidth: (d) => (d.mode === "rail" ? 5 : d.mode === "rapid" || d.mode === "brt" || d.mode === "tram" ? 4 : 2.5),
        widthUnits: "meters",
        widthMinPixels: 1.5,
        pickable: true,
        jointRounded: true,
        parameters: { depthCompare: "always", depthWriteEnabled: false },
      }),
      new ScatterplotLayer({
        id: "transit-stops",
        ...common,
        data: rt.world.all("stop"),
        getPosition: (d: { p: [number, number] }) => [d.p[0], d.p[1], 1.5],
        getRadius: (d: { mode: string }) => (d.mode === "rail" ? 9 : 4),
        radiusUnits: "meters",
        radiusMinPixels: 2.5,
        getFillColor: [255, 255, 255, 255],
        getLineColor: [40, 60, 90, 255],
        lineWidthMinPixels: 1.2,
        stroked: true,
        pickable: true,
        parameters: { depthCompare: "always", depthWriteEnabled: false },
      }),
    );
  }

  // (top overlays sit here)
  const solid = layers.splice(0);

  // ---- labels
  if (app.layers.labels && ctx.zoom >= 14.8) {
    layers.push(
      new TextLayer({
        id: "street-labels",
        ...common,
        data: streetLabels(rt),
        getText: (d: { text: string }) => d.text,
        getPosition: (d: { position: Position }) => d.position,
        getAngle: (d: { angle: number }) => d.angle,
        getSize: (d: { size: number }) => d.size,
        getColor: T.text,
        fontFamily: "Geist, Inter, system-ui, sans-serif",
        fontWeight: 600,
        characterSet: "auto",
        billboard: false,
        sizeUnits: "pixels",
        outlineWidth: 3,
        outlineColor: T.textHalo,
        fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        parameters: { depthCompare: "always", depthWriteEnabled: false },
      }),
    );
  }
  void polyCentroid;
  return { ground, solid, labels: layers };
}
