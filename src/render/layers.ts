import { COORDINATE_SYSTEM, type Layer, type Position } from "@deck.gl/core";
import { PathStyleExtension } from "@deck.gl/extensions";
import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { polyLength, pointAt } from "@/geometry/polyline";
import type { Runtime } from "@/state/runtime";
import type { AppState } from "@/state/store";
import type { Entity, Street, TransitRoute } from "@/world/types";
import { FacadeLayer } from "./FacadeLayer";
import { fadedGround } from "./edge";
import { coneMesh, crownMesh, cylinderMesh, sphereMesh } from "./meshes";
import { outlineFor, type Chunk, type MarkDatum, type MassDatum, type SurfaceDatum, type TreeDatum } from "./scene";
import type { ChunkLoader, ChunkView } from "./chunkLoader";
import { FAR, MID, NEAR } from "./lod";
import type { RGBA, Theme } from "./theme";

/** tree crowns by tier: clustered lobes near (~450 vertices), a sphere at mid range, a blob far */
const CROWN = crownMesh();
const SPHERE = sphereMesh();
const BLOB = sphereMesh(4, 6);
const CYL = cylinderMesh(6);
const CONE = coneMesh();
const BUILDING_MATERIAL = { ambient: 0.55, diffuse: 0.6, shininess: 24, specularColor: [40, 40, 40] as [number, number, number] };
const CONTEXT_MATERIAL = { ambient: 0.6, diffuse: 0.5, shininess: 0, specularColor: [0, 0, 0] as [number, number, number] };
const KERB_MATERIAL = { ambient: 0.9, diffuse: 0.25, shininess: 0, specularColor: [0, 0, 0] as [number, number, number] };
const TREE_MATERIAL = { ambient: 0.55, diffuse: 0.7, shininess: 4, specularColor: [20, 30, 20] as [number, number, number] };

/** crown proportions by habit: spreading oaks are wide and low, vase elms taller than wide */
const squash = (d: TreeDatum) => (d.shape === "spreading" ? 0.58 : d.shape === "vase" ? 0.95 : 0.82) * (0.94 + d.seed * 0.12);

function canopyLayer(id: string, mesh: unknown, data: TreeDatum[], shown: boolean, color: RGBA, common: object): Layer {
  return keep(id, [data, shown, color[0], color[1], color[2]], () =>
    new SimpleMeshLayer<TreeDatum>({
      id,
      ...common,
      data,
      visible: shown,
      mesh: mesh as never,
      getPosition: (d) => [d.position[0], d.position[1], Math.max(d.r * squash(d), d.h - d.r * squash(d))],
      getScale: (d) => [d.r, d.r, d.r * squash(d)],
      getOrientation: (d) => [0, d.seed * 360, 0],
      getColor: color,
      pickable: true,
      material: TREE_MATERIAL,
    }),
  );
}
const dashExt = new PathStyleExtension({ dash: true, highPrecisionDash: true });

const FLAT = { depthWriteEnabled: false, depthCompare: "always" } as const;

export interface LayerContext {
  rt: Runtime;
  theme: Theme;
  app: Pick<AppState, "selection" | "layers" | "highlight" | "theme" | "cameraMode">;
  /** zoom band (zoomBand) */
  zoom: number;
  /** which chunks are built, which of their layers exist, and each chunk's tier and visibility */
  loader: ChunkLoader;
}

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

/**
 * Layer instances kept between builds: when a layer's inputs (data reference, colour trigger,
 * visibility, detail…) are unchanged the same instance is handed back, so deck.gl skips even the
 * prop comparison, and a chunk's layer is never re-created (its GPU buffers stay put).
 */
const kept = new Map<string, { sig: unknown[]; layer: Layer }>();
let keptFor: unknown = null;
function keep<L extends Layer>(id: string, sig: unknown[], make: () => L): L {
  const k = kept.get(id);
  if (k && k.sig.length === sig.length && k.sig.every((v, i) => v === sig[i])) return k.layer as L;
  const layer = make();
  kept.set(id, { sig, layer });
  return layer;
}

/** a chunk's areas followed by its street surfaces, kept while neither array changed */
const flatCache = new WeakMap<Chunk, { areas: SurfaceDatum[]; surfaces: SurfaceDatum[]; data: SurfaceDatum[] }>();
function flatData(c: Chunk): SurfaceDatum[] {
  const f = flatCache.get(c);
  if (f && f.areas === c.areas && f.surfaces === c.surfaces) return f.data;
  const data = c.areas.length ? (c.surfaces.length ? [...c.areas, ...c.surfaces] : c.areas) : c.surfaces;
  flatCache.set(c, { areas: c.areas, surfaces: c.surfaces, data });
  return data;
}

/** tree instances by tier, gathered across visible chunks; reused while nothing they depend on changed */
interface TreeSets {
  near: TreeDatum[];
  mid: TreeDatum[];
  far: TreeDatum[];
  trunks: TreeDatum[];
  conifers: TreeDatum[];
  all: TreeDatum[];
}
let treeCache: { sig: unknown[]; sets: TreeSets } | null = null;
function treeData(rt: Runtime, loader: ChunkLoader): TreeSets {
  const chunks = rt.scene.built();
  const sig: unknown[] = [];
  for (const c of chunks) {
    const v = loader.views.get(c.key);
    sig.push(c.trees, v?.visible ? v.tier : -1);
  }
  if (treeCache && treeCache.sig.length === sig.length && treeCache.sig.every((x, i) => x === sig[i])) return treeCache.sets;
  const sets: TreeSets = { near: [], mid: [], far: [], trunks: [], conifers: [], all: [] };
  for (const c of chunks) {
    const v = loader.views.get(c.key);
    for (const t of c.trees) sets.all.push(t);
    if (!v?.visible) continue;
    for (const t of c.trees) {
      if (t.shape === "conical") sets.conifers.push(t);
      else (v.tier === NEAR ? sets.near : v.tier === MID ? sets.mid : sets.far).push(t);
      // trunks are a few pixels wide even near the MID limit; far away they vanish
      if (v.tier !== FAR) sets.trunks.push(t);
    }
  }
  treeCache = { sig, sets };
  return sets;
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
  const { rt, theme: T, app, loader } = ctx;
  if (keptFor !== rt) {
    kept.clear();
    treeCache = null;
    keptFor = rt;
  }
  const origin = [rt.meta.origin.lon, rt.meta.origin.lat, 0] as [number, number, number];
  const common = { coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: origin };
  const scene = rt.scene;
  // chunks whose layers exist; an edit to one of them is rebuilt now (only its edited parts get
  // new arrays), the rest wait for the loader
  const chunks: { c: Chunk; v: ChunkView }[] = [];
  for (const c of scene.all()) {
    const v = loader.views.get(c.key);
    if (!v || !v.parts.size) continue;
    scene.ensure(c);
    chunks.push({ c, v });
  }
  const paint = scene.paint;
  const layers: Layer[] = [];
  const b = rt.meta.bounds;
  const lay = app.layers;

  // ---- ground
  layers.push(
    keep("ground", [T.id], () =>
      new SolidPolygonLayer<{ polygon: Position[][]; alpha: number }>({
        id: "ground",
        ...common,
        data: fadedGround(b),
        getPolygon: (d) => d.polygon,
        getFillColor: (d) => [...T.land, 255 * d.alpha] as RGBA,
        updateTriggers: { getFillColor: [T.id] },
        parameters: FLAT,
      }),
    ),
  );
  // blank canvas: a faint survey grid (100 m, stronger every 500 m) and the edge of the site
  if (rt.meta.sandbox) layers.push(keep("site-grid", [T.id, b.join(",")], () => siteGrid(b, T, common)));
  if (!rt.meta.sandbox && loader.globals.has("ctx-areas")) {
    layers.push(
      keep("ctx-areas", [T.id, lay.context], () =>
        new SolidPolygonLayer({
          id: "ctx-areas",
          ...common,
          data: rt.context.areas,
          visible: lay.context,
          getPolygon: (d: { polygon: Position[] }) => d.polygon,
          getFillColor: (d: { type: string; fade: number }) => [...(T.area[d.type as keyof Theme["area"]] ?? T.context), 200 * d.fade] as RGBA,
          updateTriggers: { getFillColor: [T.id] },
          parameters: FLAT,
        }),
      ),
      keep("ctx-roads", [T.id, lay.context], () =>
        new PathLayer({
          id: "ctx-roads",
          ...common,
          data: rt.context.roads,
          visible: lay.context,
          getPath: (d: { path: Position[] }) => d.path,
          getWidth: (d: { cls: string }) => (d.cls === "motorway" ? 22 : d.cls === "primary" || d.cls === "trunk" ? 16 : d.cls === "secondary" ? 13 : d.cls === "tertiary" ? 11 : 8),
          widthUnits: "meters",
          getColor: (d: { fade: number }) => [...T.contextRoad, 255 * d.fade] as RGBA,
          updateTriggers: { getColor: [T.id] },
          jointRounded: true,
          capRounded: true,
          parameters: FLAT,
        }),
      ),
    );
  }

  // ---- areas and street surfaces (one flat layer per chunk: areas first, so streets draw over
  // parks and plazas), then paths and markings (flat, draw order = stacking). One layer instead of
  // two halves the per-frame draw overhead of the ground, which every visible chunk pays.
  for (const { c, v } of chunks) {
    const flat = flatData(c);
    if (v.parts.has("surfaces") && flat.length)
      layers.push(
        keep(`flat-${c.key}`, [flat, paint, v.visible], () =>
          new SolidPolygonLayer<SurfaceDatum>({
            id: `flat-${c.key}`,
            ...common,
            data: flat,
            visible: v.visible,
            getPolygon: (d) => d.polygon as Position[][],
            getFillColor: (d) => d.color,
            updateTriggers: { getFillColor: paint },
            pickable: true,
            parameters: FLAT,
          }),
        ),
      );
  }
  for (const { c, v } of chunks)
    if (v.parts.has("paths") && c.paths.length) {
      const visible = lay.paths && v.visible && v.tier !== FAR;
      layers.push(
        keep(`paths-${c.key}`, [c.paths, paint, visible], () =>
          new PathLayer({
            id: `paths-${c.key}`,
            ...common,
            data: c.paths,
            visible,
            getPath: (d: { path: Position[] }) => d.path,
            getColor: (d: { color: RGBA }) => d.color,
            getWidth: (d: { width: number }) => d.width,
            updateTriggers: { getColor: paint },
            widthUnits: "meters",
            widthMinPixels: 1,
            parameters: FLAT,
          }),
        ),
      );
    }
  // lane markings: near chunks only (beyond, their 0.1-0.6 m lines are under a pixel and shimmer)
  for (const { c, v } of chunks)
    if (v.parts.has("marks") && c.marks.length) {
      const visible = lay.markings && v.visible && v.tier === NEAR;
      layers.push(
        keep(`marks-${c.key}`, [c.marks, paint, visible], () =>
          new PathLayer<MarkDatum, { getDashArray: (d: MarkDatum) => [number, number]; dashJustified: boolean }>({
            id: `marks-${c.key}`,
            ...common,
            data: c.marks,
            visible,
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
        ),
      );
    }

  // ---- kerbs / pedestrian realm (low extrusion)
  for (const { c, v } of chunks)
    if (v.parts.has("kerbs") && c.kerbs.length)
      layers.push(
        keep(`kerb-${c.key}`, [c.kerbs, paint, v.visible], () =>
          new SolidPolygonLayer<SurfaceDatum>({
            id: `kerb-${c.key}`,
            ...common,
            data: c.kerbs,
            visible: v.visible,
            getPolygon: (d) => d.polygon as Position[],
            getFillColor: (d) => d.color,
            updateTriggers: { getFillColor: paint },
            extruded: true,
            getElevation: (d) => (d.kind === "island" ? 0.25 : 0.15),
            pickable: true,
            material: KERB_MATERIAL,
          }),
        ),
      );

  // analysis overlays sit here: above the pedestrian realm and below buildings
  const ground = layers.splice(0);

  // ---- selection / highlight outlines
  const outlined: Outlined[] = app.selection.map((id) => ({ e: rt.world.get(id), color: [...T.selection, 255] as RGBA, width: 3 }));
  if (app.highlight) for (const id of app.highlight.ids) outlined.push({ e: rt.world.get(id), color: [...(app.highlight.color ?? T.proposedEdge), 255], width: 3 });

  // ---- buildings: full facades near and mid, plain extrusions far
  for (const { c, v } of chunks)
    if (v.parts.has("masses") && c.masses.length) {
      const detail = v.tier === FAR ? 0 : 1;
      layers.push(
        keep(`bld-${c.key}`, [c.masses, paint, v.visible, detail, T.night], () =>
          new FacadeLayer<MassDatum>({
            id: `bld-${c.key}`,
            ...common,
            data: c.masses,
            visible: v.visible,
            getPolygon: (d) => d.polygon,
            getElevation: (d) => d.height,
            getFillColor: (d) => d.color,
            updateTriggers: { getFillColor: paint },
            extruded: true,
            pickable: true,
            night: T.night,
            detail,
            material: BUILDING_MATERIAL,
          }),
        ),
      );
    }
  if (!rt.meta.sandbox)
    for (const cell of loader.cells)
      if (cell.admitted) {
        const visible = lay.context && cell.visible;
        layers.push(
          keep(`ctx-buildings-${cell.key}`, [T.id, visible], () =>
            new FacadeLayer<{ polygon: Position[]; height: number; fade: number }>({
              id: `ctx-buildings-${cell.key}`,
              ...common,
              data: cell.buildings as { polygon: Position[]; height: number; fade: number }[],
              visible,
              getPolygon: (d) => d.polygon,
              // at the city's rim: lower and closer to the ground colour
              getElevation: (d) => d.height * (0.1 + 0.9 * d.fade),
              getFillColor: (d) => T.contextBuilding.map((c, i) => T.land[i] + (c - T.land[i]) * d.fade).concat(251) as RGBA,
              updateTriggers: { getFillColor: [T.id] },
              extruded: true,
              night: T.night,
              detail: 0,
              material: CONTEXT_MATERIAL,
            }),
          ),
        );
      }

  // ---- trees: one green all year (never re-shaded by month); crowns by tier
  if (loader.globals.has("trees")) {
    const sets = treeData(rt, loader);
    const shown = lay.trees;
    const green: RGBA = [...T.tree, 255];
    const trunk: RGBA = [...T.trunk, 255];
    const planted = rt.scene.showChanges ? plantedTrees(sets.all) : [];
    if (planted.length)
      layers.push(
        // gold rings on the ground mark every tree the plan adds
        keep("tree-planted-rings", [planted, shown], () =>
          new ScatterplotLayer<TreeDatum>({
            id: "tree-planted-rings",
            ...common,
            data: planted,
            visible: shown,
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
        ),
      );
    layers.push(
      keep("tree-trunks", [sets.trunks, shown, T.id], () =>
        new SimpleMeshLayer<TreeDatum>({
          id: "tree-trunks",
          ...common,
          data: sets.trunks,
          visible: shown,
          mesh: CYL as never,
          getPosition: (d) => d.position,
          getScale: (d) => (d.shape === "conical" ? [0.25 + d.r * 0.04, 0.25 + d.r * 0.04, d.h * 0.3] : [0.22 + d.r * 0.03, 0.22 + d.r * 0.03, Math.max(1.5, d.h - d.r * squash(d) * 1.6)]),
          getColor: trunk,
        }),
      ),
      canopyLayer("tree-canopies-near", CROWN, sets.near, shown, green, common),
      canopyLayer("tree-canopies", SPHERE, sets.mid, shown, green, common),
      canopyLayer("tree-canopies-far", BLOB, sets.far, shown, green, common),
      keep("tree-conifers", [sets.conifers, shown, T.id], () =>
        new SimpleMeshLayer<TreeDatum>({
          id: "tree-conifers",
          ...common,
          data: sets.conifers,
          visible: shown,
          mesh: CONE as never,
          getPosition: (d) => [d.position[0], d.position[1], d.h * 0.22],
          getScale: (d) => [d.r, d.r, d.h * 0.8],
          getColor: green,
          pickable: true,
          material: TREE_MATERIAL,
        }),
      ),
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

  // ---- labels (created once; zooming out only hides them, so the glyph atlas is kept)
  if (loader.globals.has("labels")) {
    const visible = lay.labels && ctx.zoom >= 14.8;
    const data = streetLabels(rt);
    layers.push(
      keep("street-labels", [data, visible, T.id], () =>
        new TextLayer({
          id: "street-labels",
          ...common,
          data,
          visible,
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
      ),
    );
  }
  return { ground, solid, labels: layers };
}
