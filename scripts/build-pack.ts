/* eslint-disable no-console */
// Builds a city pack (public/data/<city>/) from raw OSM + municipal GIS +
// Census + DEM + weather downloads (see scripts/fetch_*.py).

import fs from "node:fs";
import path from "node:path";
import { buildSection, type SectionInputs } from "@/geometry/crossSection";
import { rowBand } from "@/geometry/streetGeometry";
import {
  obb,
  difference,
  intersection,
  isValidPoly,
  normalizePoly,
  overlapArea,
  pointInPoly,
  polyArea,
  polyBBox,
  polyCentroid,
  simplifyRing,
  unionMany,
} from "@/geometry/polygon";
import { closestOnPath, pathBBox, pointAt, polyLength, simplifyPath } from "@/geometry/polyline";
import { dist, norm, sub } from "@/geometry/vec";
import { rasterizeRings } from "@/sim/raster";
import { LocalProjection } from "@/world/projection";
import { GridIndex, type BBox } from "@/world/spatialIndex";
import type {
  Area,
  AreaType,
  Building,
  CensusBlock,
  CityMeta,
  CountStation,
  Mass,
  NodeControl,
  Parcel,
  Path as FootPath,
  Place,
  Poi,
  Polygon,
  RoadClass,
  Street,
  SidewalkSide,
  StreetNode,
  TransitRoute,
  TransitStop,
  Tree,
  Use,
  Utility,
  Vec2,
} from "@/world/types";
import { isHistoricZoning, zoningRule } from "@/world/zoning";
import { existingGFA, massVolume, PROGRAMME } from "@/world/ops/core";

const city = process.argv[2] ?? "austin";

interface CityConfig {
  name: string;
  region: string;
  bbox: [number, number, number, number]; // W S E N
  timezone: string;
  waterLevel: number;
  householdSize: number;
  initialView: { center: [number, number]; zoom: number; pitch: number; bearing: number };
}

const CONFIG: Record<string, CityConfig> = {
  austin: {
    name: "Austin",
    region: "Downtown, Central & East Austin",
    bbox: [-97.762, 30.253, -97.72, 30.292],
    timezone: "America/Chicago",
    waterLevel: 130.6, // Lady Bird Lake normal pool, 428.5 ft NAVD88
    householdSize: 1.75,
    initialView: { center: [-97.7431, 30.2672], zoom: 15.6, pitch: 58, bearing: -28 },
  },
};

const cfg = CONFIG[city];
if (!cfg) throw new Error(`unknown city ${city}`);
const RAW = "data/raw";
const OUT = `public/data/${city}`;
fs.mkdirSync(OUT, { recursive: true });

const [W, S, E, N] = cfg.bbox;
const proj = new LocalProjection((W + E) / 2, (S + N) / 2);
const P = (lon: number, lat: number): Vec2 => {
  const v = proj.toLocal(lon, lat);
  return [Math.round(v[0] * 10) / 10, Math.round(v[1] * 10) / 10];
};
const sw = proj.toLocal(W, S);
const ne = proj.toLocal(E, N);
const BOUNDS: BBox = [sw[0], sw[1], ne[0], ne[1]];
const inBounds = (p: Vec2, pad = 0) => p[0] >= BOUNDS[0] - pad && p[0] <= BOUNDS[2] + pad && p[1] >= BOUNDS[1] - pad && p[1] <= BOUNDS[3] + pad;

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------------------------------------------------------------- load raw
interface OsmArea { id: number; kind: "way" | "relation"; polys: [number, number][][][]; tags: Record<string, string> }
interface OsmWay { id: number; refs: number[]; coords: [number, number][]; tags: Record<string, string> }
interface OsmNode { id: number; lon: number; lat: number; tags: Record<string, string> }
interface OsmRoute { id: number; tags: Record<string, string>; members: { type: string; ref: number; role: string }[] }
const osm = JSON.parse(fs.readFileSync(`${RAW}/${city}-osm.json`, "utf8")) as {
  areas: OsmArea[]; ways: OsmWay[]; nodes: OsmNode[]; routes: OsmRoute[];
  ctxAreas: OsmArea[]; ctxWays: { id: number; coords: [number, number][]; tags: Record<string, string> }[];
  contextBbox: [number, number, number, number];
};
type GJ = { features: { properties: Record<string, any>; geometry: { type: string; coordinates: any } | null }[] };
const gis = (n: string): GJ => {
  const f = `${RAW}/${city}-gis/${n}.geojson`;
  const alt = `${RAW}/austin-gis/${n}.geojson`;
  const p = fs.existsSync(f) ? f : alt;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { features: [] };
};
const extra = (n: string): GJ => {
  const p = `${RAW}/${city}-extra/${n}.geojson`;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { features: [] };
};
log("loaded raw");

// geometry helpers on GeoJSON
function gjPolys(g: { type: string; coordinates: any } | null): Polygon[] {
  if (!g) return [];
  const conv = (poly: [number, number][][]): Polygon => normalizePoly(poly.map((r) => r.map(([x, y]) => P(x, y))));
  if (g.type === "Polygon") return [conv(g.coordinates)];
  if (g.type === "MultiPolygon") return g.coordinates.map(conv);
  return [];
}
function gjLines(g: { type: string; coordinates: any } | null): Vec2[][] {
  if (!g) return [];
  if (g.type === "LineString") return [g.coordinates.map(([x, y]: number[]) => P(x, y))];
  if (g.type === "MultiLineString") return g.coordinates.map((l: number[][]) => l.map(([x, y]) => P(x, y)));
  return [];
}
const osmPoly = (rings: [number, number][][]): Polygon =>
  normalizePoly(rings.map((r) => simplifyRing(r.map(([x, y]) => P(x, y)), 0.12)));

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};

// ---------------------------------------------------------------- zoning
interface ZoneRec { poly: Polygon; ztype: string; base: string }
const zones: ZoneRec[] = [];
const zoneIdx = new GridIndex(100);
gis("zoning").features.forEach((f, i) => {
  for (const poly of gjPolys(f.geometry)) {
    const id = `${i}:${zones.length}`;
    zones.push({ poly, ztype: f.properties.ZONING_ZTYPE ?? "", base: f.properties.ZONING_BASE ?? "" });
    zoneIdx.insert(String(zones.length - 1), polyBBox(poly));
    void id;
  }
});
const zoningAt = (p: Vec2): ZoneRec | null => {
  for (const k of zoneIdx.query([p[0], p[1], p[0], p[1]])) {
    const z = zones[+k];
    if (pointInPoly(p, z.poly)) return z;
  }
  return null;
};
const dbonus = gis("density_bonus").features.flatMap((f) => gjPolys(f.geometry).map((poly) => ({ poly, far: f.properties.FAR as number, h: f.properties.MAX_HEIGHT as number | null })));
const cvcs = gis("cvc").features.flatMap((f) => gjPolys(f.geometry).map((poly) => ({ poly, name: f.properties.ZONING_OVERLAY_SUB_NAME as string, elev: ((f.properties.ELEVATION_1 + f.properties.ELEVATION_2) / 2) * 0.3048 })));
const downtownDistricts = gis("downtown_districts").features.flatMap((f) => gjPolys(f.geometry).map((poly) => ({ poly, name: f.properties.DOWNTOWN_DISTRICTS as string })));
const isDowntown = (p: Vec2) => downtownDistricts.some((d) => pointInPoly(p, d.poly));
log("zoning", zones.length, "density bonus", dbonus.length, "cvc", cvcs.length);

// ---------------------------------------------------------------- POIs (for use inference)
const poiRaw: { p: Vec2; tags: Record<string, string>; name?: string; id: string }[] = [];
for (const n of osm.nodes) poiRaw.push({ p: P(n.lon, n.lat), tags: n.tags, name: n.tags.name, id: `n${n.id}` });
for (const a of osm.areas) {
  const t = a.tags;
  if (t.building || t["building:part"]) continue;
  if (t.amenity || t.shop || t.tourism || t.office || t.healthcare) {
    const poly = osmPoly(a.polys[0]);
    if (poly[0].length >= 3) poiRaw.push({ p: polyCentroid(poly), tags: t, name: t.name, id: `a${a.id}` });
  }
}
const poiIdx = new GridIndex(80);
poiRaw.forEach((q, i) => poiIdx.insert(String(i), [q.p[0], q.p[1], q.p[0], q.p[1]]));

// ---------------------------------------------------------------- LiDAR footprints
interface CityFp { poly: Polygon; h: number; base: number; used: boolean }
const cityFp: CityFp[] = [];
const fpIdx = new GridIndex(60);
for (const f of gis("footprints").features) {
  const h = (f.properties.MAX_HEIGHT ?? 0) * 0.3048;
  const base = (f.properties.BASE_ELEVATION ?? 0) * 0.3048;
  for (const poly of gjPolys(f.geometry)) {
    const p2 = normalizePoly(poly.map((r) => simplifyRing(r, 0.12)));
    if (!isValidPoly(p2)) continue;
    cityFp.push({ poly: p2, h, base, used: false });
    fpIdx.insert(String(cityFp.length - 1), polyBBox(p2));
  }
}
log("lidar footprints", cityFp.length);

// ---------------------------------------------------------------- DEM
function readNpy(file: string): { shape: number[]; data: Float32Array } {
  const buf = fs.readFileSync(file);
  const hlen = buf.readUInt16LE(8);
  const header = buf.subarray(10, 10 + hlen).toString("latin1");
  const shape = header.match(/\((\d+), (\d+)\)/)!.slice(1).map(Number);
  const off = 10 + hlen;
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + shape[0] * shape[1] * 4));
  return { shape, data };
}
const demMeta = JSON.parse(fs.readFileSync(`${RAW}/${city}-extra/dem.json`, "utf8"));
const demNpy = readNpy(`${RAW}/${city}-extra/dem.npy`);
const demOrigin = proj.toLocal(demMeta.west, demMeta.south);
const DEM = { x0: demOrigin[0] - demMeta.cell / 2, y0: demOrigin[1] - demMeta.cell / 2, cell: demMeta.cell, nx: demNpy.shape[1], ny: demNpy.shape[0], data: demNpy.data };
const demAt = (p: Vec2) => {
  const i = Math.max(0, Math.min(DEM.nx - 1, Math.floor((p[0] - DEM.x0) / DEM.cell)));
  const j = Math.max(0, Math.min(DEM.ny - 1, Math.floor((p[1] - DEM.y0) / DEM.cell)));
  return DEM.data[j * DEM.nx + i];
};

// ---------------------------------------------------------------- buildings
const USE_BY_TAG: Record<string, Use> = {
  apartments: "residential", residential: "residential", house: "residential", detached: "residential", semidetached_house: "residential", terrace: "residential", dormitory: "residential", condominium: "residential", bungalow: "residential",
  office: "office", commercial: "office", retail: "retail", supermarket: "retail", kiosk: "retail", hotel: "hotel",
  university: "education", school: "education", college: "education", kindergarten: "education",
  church: "religious", cathedral: "religious", chapel: "religious", mosque: "religious", synagogue: "religious", temple: "religious",
  hospital: "health", civic: "civic", government: "civic", public: "civic", fire_station: "civic", stadium: "civic", museum: "civic", train_station: "civic", transportation: "civic",
  parking: "parking", garage: "parking", garages: "parking", carport: "parking",
  industrial: "industrial", warehouse: "industrial", service: "utility", shed: "utility", roof: "other", construction: "other",
};

function inferUse(poly: Polygon, tags: Record<string, string>, zone: ZoneRec | null): { use: Use; program: Partial<Record<Use, number>>; src: "mapped" | "derived" | "estimated" } {
  const bt = tags.building ?? "yes";
  const bb = polyBBox(poly);
  let shops = 0,
    offices = 0,
    food = 0,
    hotels = 0,
    homes = 0;
  for (const k of poiIdx.query(bb)) {
    const q = poiRaw[+k];
    if (!pointInPoly(q.p, poly)) continue;
    if (q.tags.shop) shops++;
    if (q.tags.office) offices++;
    if (["restaurant", "cafe", "bar", "fast_food", "pub", "nightclub"].includes(q.tags.amenity)) food++;
    if (q.tags.tourism === "hotel") hotels++;
    if (q.tags["addr:unit"]) homes++;
  }
  if (USE_BY_TAG[bt]) {
    const use = USE_BY_TAG[bt];
    if ((use === "residential" || use === "office") && shops + food > 0) return { use: "mixed", program: { retail: 0.12, [use]: 0.88 }, src: "derived" };
    return { use, program: { [use]: 1 }, src: "mapped" };
  }
  if (tags.amenity === "parking") return { use: "parking", program: { parking: 1 }, src: "mapped" };
  if (hotels) return { use: "hotel", program: { hotel: shops + food ? 0.9 : 1, ...(shops + food ? { retail: 0.1 } : {}) }, src: "derived" };
  const z = zone ? zoningRule(zone.ztype, zone.base) : null;
  const zb = zone?.base ?? "";
  if (offices && !shops && !food) return { use: "office", program: { office: 1 }, src: "derived" };
  if ((shops || food) && offices) return { use: "mixed", program: { retail: 0.2, office: 0.8 }, src: "derived" };
  if (shops || food) {
    if (zb === "CBD" || zb === "DMU") return { use: "mixed", program: { retail: 0.15, office: 0.85 }, src: "estimated" };
    return { use: "retail", program: { retail: 1 }, src: "derived" };
  }
  if (z && z.residential && !z.commercial) return { use: "residential", program: { residential: 1 }, src: "estimated" };
  if (zb === "P") return { use: "civic", program: { civic: 1 }, src: "estimated" };
  if (zb === "UNZ") return { use: "education", program: { education: 1 }, src: "estimated" };
  if (zb === "CBD" || zb === "DMU") return { use: "office", program: { office: 1 }, src: "estimated" };
  if (zb === "LI") return { use: "industrial", program: { industrial: 1 }, src: "estimated" };
  if (zb === "TOD" || zb === "PUD") return { use: "mixed", program: { residential: 0.8, retail: 0.2 }, src: "estimated" };
  return { use: "retail", program: { retail: 1 }, src: "estimated" };
}

const floorsFor = (h: number, use: Use) => {
  const fh = use === "office" ? 4.0 : use === "parking" ? 3.2 : use === "residential" || use === "hotel" ? 3.3 : 3.8;
  return Math.max(1, Math.round((h - 1.2) / fh));
};
const parseH = (v?: string) => {
  if (!v) return undefined;
  const m = v.match(/([\d.]+)\s*(ft|')?/);
  if (!m) return undefined;
  const x = parseFloat(m[1]);
  return m[2] ? x * 0.3048 : x;
};

const buildings: Building[] = [];
const bById = new Map<string, Building>();
const bIdx = new GridIndex(60);
const parts = osm.areas.filter((a) => a.tags["building:part"] && a.tags["building:part"] !== "no");
const partIdx = new GridIndex(60);
const partPolys = parts.map((a) => osmPoly(a.polys[0]));
partPolys.forEach((p, i) => partIdx.insert(String(i), polyBBox(p)));

for (const a of osm.areas) {
  const t = a.tags;
  if (!t.building || t.building === "no") continue;
  if (["roof", "carport"].includes(t.building) && !t.height) continue; // canopies – no enclosed volume
  if (t.location === "underground" || t.layer?.startsWith("-")) continue;
  for (const rings of a.polys) {
    const poly = osmPoly(rings);
    if (!isValidPoly(poly)) continue;
    const c = polyCentroid(poly);
    if (!inBounds(c)) continue;
    const area = polyArea(poly);
    // LiDAR match
    let best = -1,
      bestOv = 0;
    for (const k of fpIdx.query(polyBBox(poly))) {
      const f = cityFp[+k];
      const ov = overlapArea(poly, f.poly);
      if (ov > bestOv) {
        bestOv = ov;
        best = +k;
      }
    }
    let height: number;
    let hsrc: Building["heightSource"];
    let ground = demAt(c);
    const tagH = parseH(t.height);
    const levels = t["building:levels"] ? parseFloat(t["building:levels"]) : undefined;
    if (best >= 0 && bestOv > 0.3 * Math.min(area, polyArea(cityFp[best].poly)) && cityFp[best].h > 2) {
      cityFp[best].used = true;
      height = cityFp[best].h;
      hsrc = "measured";
      if (cityFp[best].base > 50) ground = cityFp[best].base;
      // mark other strongly-overlapping footprints as used too
      for (const k of fpIdx.query(polyBBox(poly))) {
        const f = cityFp[+k];
        if (!f.used && overlapArea(poly, f.poly) > 0.5 * polyArea(f.poly)) f.used = true;
      }
    } else if (tagH) {
      height = tagH;
      hsrc = "mapped";
    } else if (levels) {
      height = levels * 3.4 + 1;
      hsrc = "derived";
    } else {
      height = t.building === "house" || t.building === "detached" ? 6.5 : t.building === "garage" || t.building === "shed" ? 3 : 8;
      hsrc = "estimated";
    }
    const zone = zoningAt(c);
    const u = inferUse(poly, t, zone);
    // masses from building:parts
    const masses: Mass[] = [];
    for (const k of partIdx.query(polyBBox(poly))) {
      const pp = partPolys[+k];
      const pc = polyCentroid(pp);
      if (!pointInPoly(pc, poly)) continue;
      const pt = parts[+k].tags;
      const top = parseH(pt.height) ?? (pt["building:levels"] ? parseFloat(pt["building:levels"]) * 3.4 : height);
      const base = parseH(pt.min_height) ?? (pt["building:min_level"] ? parseFloat(pt["building:min_level"]) * 3.4 : 0);
      if (top > base + 0.5) masses.push({ poly: pp, base, top, role: base > 0 ? "tower" : "body" });
    }
    if (masses.length) {
      const maxTop = Math.max(...masses.map((m) => m.top));
      // reconcile mapped parts with measured overall height
      if (hsrc === "measured" && maxTop > 0 && Math.abs(maxTop - height) / height > 0.12) {
        const s = height / maxTop;
        for (const m of masses) {
          m.top *= s;
          m.base *= s;
        }
      }
      const covered = masses.reduce((s, m) => s + polyArea(m.poly), 0);
      if (covered < area * 0.6) {
        // the outline's remainder outside the parts (not the whole outline — that would bury the parts in a
        // duplicate volume); its height from the LiDAR footprints over it, else the lowest part
        const partsUnion = unionMany(masses.map((m) => m.poly));
        let rest: Polygon[] = [poly];
        for (const pu of partsUnion) rest = rest.flatMap((q) => difference(q, pu));
        for (const q of rest.filter((q) => isValidPoly(q) && polyArea(q) > 30)) {
          let hs = 0,
            ws = 0;
          for (const k of fpIdx.query(polyBBox(q))) {
            const f = cityFp[+k];
            const ov = overlapArea(q, f.poly);
            if (ov > 0.3 * polyArea(f.poly) && f.h > 2) {
              hs += f.h * ov;
              ws += ov;
            }
          }
          const top = ws > 0.3 * polyArea(q) ? hs / ws : Math.min(...masses.map((m) => m.top));
          masses.unshift({ poly: q, base: 0, top, role: "podium" });
        }
      }
    } else masses.push({ poly, base: 0, top: height, role: "body" });
    const hist = !!(t.historic || t.heritage || (zone && isHistoricZoning(zone.ztype)));
    const name = t.name;
    const facade: Building["style"] = {
      facade: height > 55 && (u.use === "office" || u.use === "mixed" || u.use === "hotel" || u.use === "residential") ? "glass" : u.use === "parking" ? "concrete" : hist || u.use === "religious" || u.use === "civic" ? "masonry" : u.use === "residential" && height < 15 ? "stucco" : "concrete",
      tint: hash(`b${a.id}`),
    };
    const id = `b:${a.kind[0]}${a.id}${a.polys.length > 1 ? `_${masses.length}_${Math.round(c[0])}` : ""}`;
    const b: Building = {
      id,
      kind: "building",
      footprint: poly,
      masses,
      height: Math.round(height * 10) / 10,
      floors: levels ?? floorsFor(height, u.use),
      use: u.use,
      program: u.program,
      name,
      address: t["addr:housenumber"] && t["addr:street"] ? `${t["addr:housenumber"]} ${t["addr:street"]}` : undefined,
      osmType: t.building,
      historic: hist || undefined,
      ground: Math.round(ground * 10) / 10,
      heightSource: hsrc,
      useSource: u.src,
      source: hsrc === "measured" ? "OSM footprint · City of Austin 2023 LiDAR height" : "OpenStreetMap",
      style: facade,
    };
    buildings.push(b);
    bById.set(id, b);
    bIdx.insert(id, polyBBox(poly));
  }
}
// LiDAR-only buildings missing from OSM. OSM is newer (2026) than the LiDAR
// (2023): a LiDAR footprint inside a site OSM now maps as construction is a
// building since demolished (e.g. the Austin Convention Center rebuild), so it is
// recorded as superseded rather than resurrected.
const construction = osm.areas.filter((a) => a.tags.landuse === "construction" && !a.tags.building).flatMap((a) => a.polys.map((pl) => ({ poly: osmPoly(pl), name: a.tags.name as string | undefined, note: a.tags.note as string | undefined })));
const superseded: { name?: string; area: number }[] = [];
let lidarOnly = 0;
for (let i = 0; i < cityFp.length; i++) {
  const f = cityFp[i];
  if (f.used || f.h < 2.5) continue;
  const area = polyArea(f.poly);
  if (area < 20) continue;
  const c = polyCentroid(f.poly);
  if (!inBounds(c)) continue;
  let ov = 0;
  for (const k of bIdx.query(polyBBox(f.poly))) {
    const b = bById.get(k);
    if (b) ov += overlapArea(f.poly, b.footprint);
  }
  if (ov > 0.3 * area) continue;
  const site = construction.find((cs) => overlapArea(f.poly, cs.poly) > 0.5 * area);
  if (site) {
    superseded.push({ name: site.name, area: Math.round(area) });
    continue;
  }
  const zone = zoningAt(c);
  const u = inferUse(f.poly, { building: "yes" }, zone);
  const id = `b:c${i}`;
  buildings.push({
    id, kind: "building", footprint: f.poly, masses: [{ poly: f.poly, base: 0, top: f.h, role: "body" }],
    height: Math.round(f.h * 10) / 10, floors: floorsFor(f.h, u.use), use: u.use, program: u.program,
    ground: Math.round((f.base > 50 ? f.base : demAt(c)) * 10) / 10, heightSource: "measured", useSource: u.src,
    source: "City of Austin Building Footprints 2023 (LiDAR)", style: { facade: f.h > 55 ? "glass" : "concrete", tint: hash(id) },
  });
  bById.set(id, buildings[buildings.length - 1]);
  bIdx.insert(id, polyBBox(f.poly));
  lidarOnly++;
}
log("buildings", buildings.length, "lidar-only", lidarOnly, "measured", buildings.filter((b) => b.heightSource === "measured").length, "superseded by OSM construction sites", superseded.length, superseded.filter((s) => s.area > 2000).map((s) => `${s.name ?? "?"} ${s.area} m²`).join("; "));

// ---------------------------------------------------------------- street network
const CLASS: Record<string, RoadClass> = {
  motorway: "motorway", motorway_link: "motorway_link", trunk: "trunk", trunk_link: "motorway_link",
  primary: "primary", primary_link: "primary", secondary: "secondary", secondary_link: "secondary",
  tertiary: "tertiary", tertiary_link: "tertiary", residential: "residential", unclassified: "residential",
  living_street: "living", service: "service", pedestrian: "pedestrian", busway: "busway",
};
const vehWays = osm.ways.filter((w) => {
  const t = w.tags;
  const c = CLASS[t.highway];
  if (!c) return false;
  if (t.area === "yes") return false;
  if (c === "service" && (["parking_aisle", "driveway", "drive-through", "emergency_access"].includes(t.service) || t.access === "private" || t.access === "no")) return false;
  return true;
});
const useCount = new Map<number, number>();
for (const w of vehWays) w.refs.forEach((r, i) => useCount.set(r, (useCount.get(r) ?? 0) + (i === 0 || i === w.refs.length - 1 ? 1 : 2)));
const nodeLL = new Map<number, [number, number]>();
for (const w of vehWays) w.refs.forEach((r, i) => nodeLL.set(r, w.coords[i]));

interface Seg { osm: number; refs: number[]; tags: Record<string, string> }
let segs: Seg[] = [];
for (const w of vehWays) {
  let start = 0;
  for (let i = 1; i < w.refs.length; i++) {
    const r = w.refs[i];
    if (i === w.refs.length - 1 || (useCount.get(r) ?? 0) > 2) {
      segs.push({ osm: w.id, refs: w.refs.slice(start, i + 1), tags: w.tags });
      start = i;
    }
  }
}
// normalise oneway=-1
for (const s of segs) if (s.tags.oneway === "-1") s.refs = s.refs.slice().reverse();
// merge compatible chains through degree-2 nodes
const sig = (t: Record<string, string>) =>
  ["highway", "name", "lanes", "lanes:forward", "lanes:backward", "oneway", "maxspeed", "cycleway", "cycleway:both", "cycleway:left", "cycleway:right", "sidewalk", "sidewalk:both", "bridge", "layer", "tunnel", "parking:both", "lanes:bus", "busway"].map((k) => t[k] ?? "").join("|");
{
  const ends = new Map<number, number[]>();
  segs.forEach((s, i) => {
    for (const r of [s.refs[0], s.refs[s.refs.length - 1]]) {
      if (!ends.has(r)) ends.set(r, []);
      ends.get(r)!.push(i);
    }
  });
  const dead = new Set<number>();
  for (const [r, list] of ends) {
    if (list.length !== 2) continue;
    const [i, j] = list;
    if (i === j || dead.has(i) || dead.has(j)) continue;
    const a = segs[i],
      b = segs[j];
    if (sig(a.tags) !== sig(b.tags)) continue;
    const ow = a.tags.oneway === "yes" || a.tags.oneway === "-1" || a.tags.highway === "motorway";
    let merged: number[] | null = null;
    if (a.refs[a.refs.length - 1] === r && b.refs[0] === r) merged = [...a.refs, ...b.refs.slice(1)];
    else if (b.refs[b.refs.length - 1] === r && a.refs[0] === r) merged = [...b.refs, ...a.refs.slice(1)];
    else if (!ow && a.refs[a.refs.length - 1] === r && b.refs[b.refs.length - 1] === r) merged = [...a.refs, ...b.refs.slice(0, -1).reverse()];
    else if (!ow && a.refs[0] === r && b.refs[0] === r) merged = [...a.refs.slice().reverse(), ...b.refs.slice(1)];
    if (!merged || merged[0] === merged[merged.length - 1]) continue;
    // replace a with merged, kill b, update end lists
    segs[i] = { osm: a.osm, refs: merged, tags: a.tags };
    dead.add(j);
    const bEnds = [b.refs[0], b.refs[b.refs.length - 1]];
    for (const e of bEnds) {
      const l = ends.get(e);
      if (!l) continue;
      const idx = l.indexOf(j);
      if (idx >= 0) l[idx] = i;
    }
    ends.set(r, []);
  }
  segs = segs.filter((_, i) => !dead.has(i));
}

// ASMP measured ROW + existing lanes
const normName = (s?: string) =>
  (s ?? "")
    .toUpperCase()
    .replace(/[.,']/g, "")
    .replace(/\bAVENUE\b/g, "AVE").replace(/\bSTREET\b/g, "ST").replace(/\bBOULEVARD\b/g, "BLVD").replace(/\bDRIVE\b/g, "DR")
    .replace(/\bROAD\b/g, "RD").replace(/\bLANE\b/g, "LN").replace(/\bEAST\b/g, "E").replace(/\bWEST\b/g, "W").replace(/\bNORTH\b/g, "N")
    .replace(/\bSOUTH\b/g, "S").replace(/\bPARKWAY\b/g, "PKWY").replace(/\bPLACE\b/g, "PL").replace(/\bTRAIL\b/g, "TRL").replace(/\bCIRCLE\b/g, "CIR")
    .replace(/\bMARTIN LUTHER KING JR\b/g, "MLK").replace(/\bDR MLK\b/g, "MLK")
    .replace(/\s+/g, " ")
    .trim();
interface Asmp { path: Vec2[]; name: string; row: number | null; lanes: number | null; xs: string; level: number; bike: string | null }
const asmp: Asmp[] = [];
const asmpIdx = new GridIndex(80);
for (const f of gis("asmp").features) {
  const pr = f.properties;
  for (const line of gjLines(f.geometry)) {
    asmp.push({ path: line, name: normName(pr.NAME), row: pr.MEAN_ROW ? pr.MEAN_ROW * 0.3048 : null, lanes: pr.EXIST_LANES ?? null, xs: pr.EX_XS_GENERAL ?? "", level: pr.STREET_LEVEL ?? 0, bike: pr.BICYCLE_FACILITY ?? null });
    asmpIdx.insert(String(asmp.length - 1), pathBBox(line));
  }
}
function matchAsmp(pathL: Vec2[], name: string): Asmp | null {
  const mid = pathL[Math.floor(pathL.length / 2)];
  const midp = polyLength(pathL) > 2 ? pathL : pathL;
  const d0 = norm(sub(pathL[pathL.length - 1], pathL[0]));
  let best: Asmp | null = null,
    bd = 18;
  for (const k of asmpIdx.query([mid[0] - 20, mid[1] - 20, mid[0] + 20, mid[1] + 20])) {
    const a = asmp[+k];
    const c = closestOnPath(mid, a.path);
    if (c.d > bd) continue;
    const seg = a.path[Math.min(a.path.length - 2, c.seg)];
    const seg2 = a.path[Math.min(a.path.length - 1, c.seg + 1)];
    const d1 = norm(sub(seg2, seg));
    if (Math.abs(d0[0] * d1[0] + d0[1] * d1[1]) < 0.8) continue;
    if (name && a.name && a.name !== name && !a.name.includes(name) && !name.includes(a.name)) continue;
    best = a;
    bd = c.d;
  }
  void midp;
  return best;
}

const parseSpeed = (v?: string) => {
  if (!v) return undefined;
  const m = v.match(/(\d+)\s*(mph)?/);
  if (!m) return undefined;
  return m[2] || !v.includes("km") ? Math.round(+m[1] * 1.609) : +m[1];
};
const DEFAULT_SPEED: Record<RoadClass, number> = { motorway: 97, motorway_link: 56, trunk: 72, primary: 56, secondary: 48, tertiary: 40, residential: 40, service: 24, living: 16, pedestrian: 8, busway: 48 };
const side = (t: Record<string, string>, base: string, s: "left" | "right") => t[`${base}:${s}`] ?? t[`${base}:both`] ?? t[base];
const bikeOf = (v?: string): "lane" | "track" | null => (v === "lane" ? "lane" : v === "track" || v === "separate" ? "track" : null);
const parkOf = (t: Record<string, string>, s: "left" | "right") => {
  const v = t[`parking:${s}`] ?? t["parking:both"] ?? t[`parking:lane:${s}`] ?? t["parking:lane:both"];
  if (!v) return undefined;
  return ["lane", "street_side", "parallel", "diagonal", "perpendicular", "half_on_kerb", "on_kerb"].includes(v);
};
const sidewalkOf = (t: Record<string, string>, s: "left" | "right") => {
  const v = t[`sidewalk:${s}`] ?? t["sidewalk:both"];
  if (v) return v === "yes" || v === "separate";
  const sw = t.sidewalk;
  if (!sw) return undefined;
  if (sw === "both" || sw === "separate" || sw === "yes") return true;
  if (sw === "no" || sw === "none") return false;
  return sw === s;
};

// ---- City of Austin sidewalk inventory: presence, condition and width per street side.
// Each inventory line is sampled every 5 m and assigned to the nearest parallel street segment within
// 25 m, on the side it lies; a side is measured "present" when >= 40 % of its length has sidewalk.
interface SwAcc { exist: number; absent: number; shared: number; grade: number; graded: number; deficient: number; assessed: number; widths: number[] }
const SW_STEP = 5;
const SW_WIDTH_M: Record<string, number> = { "1": 0.8, "2": 0.91, "3": 1.22, "4": 1.52, "5": 1.83, "6": 2.44 };
const segPaths = new Map<Seg, Vec2[]>();
const segIdx = new GridIndex(60);
segs.forEach((sg, k) => {
  const cls = CLASS[sg.tags.highway];
  if (!cls || cls === "motorway" || cls === "motorway_link") return;
  const path = simplifyPath(sg.refs.map((r) => P(...nodeLL.get(r)!)), 0.3);
  segPaths.set(sg, path);
  const bb = pathBBox(path);
  segIdx.insert(String(k), [bb[0] - 25, bb[1] - 25, bb[2] + 25, bb[3] + 25]);
});
const swAcc = new Map<Seg, { left: SwAcc; right: SwAcc }>();
const newAcc = (): SwAcc => ({ exist: 0, absent: 0, shared: 0, grade: 0, graded: 0, deficient: 0, assessed: 0, widths: [] });
let swSamples = 0,
  swMatched = 0;
for (const f of gis("sidewalks").features) {
  const pr = f.properties;
  const type = pr.PEDESTRIAN_FACILITY_TYPE as string;
  const kind = ["EXISTING_SIDEWALK", "DRIVEWAY", "SHARED_USE_PATH", "PROTECTED_STREET_PATH"].includes(type) ? "exist" : ["PLANNED_SIDEWALK", "POTENTIAL_SIDEWALK"].includes(type) ? "absent" : ["PLANNED_SHARED_STREET", "SHARED_STREET"].includes(type) ? "shared" : null;
  if (!kind) continue;
  for (const line of gjLines(f.geometry)) {
    const L = polyLength(line);
    if (L < 1) continue;
    for (let d = Math.min(SW_STEP / 2, L / 2); d < L; d += SW_STEP) {
      const { p, dir } = pointAt(line, d);
      swSamples++;
      let best: { sg: Seg; side: "left" | "right"; d: number } | null = null;
      for (const k of segIdx.query([p[0] - 1, p[1] - 1, p[0] + 1, p[1] + 1])) {
        const sg = segs[+k];
        const path = segPaths.get(sg)!;
        const c = closestOnPath(p, path);
        if (c.d > 25 || c.d < 1 || (best && c.d >= best.d)) continue;
        const sd = norm(sub(path[Math.min(path.length - 1, c.seg + 1)], path[c.seg]));
        if (Math.abs(sd[0] * dir[0] + sd[1] * dir[1]) < 0.8) continue;
        best = { sg, side: sd[0] * (p[1] - c.p[1]) - sd[1] * (p[0] - c.p[0]) > 0 ? "left" : "right", d: c.d };
      }
      if (!best) continue;
      swMatched++;
      let e = swAcc.get(best.sg);
      if (!e) swAcc.set(best.sg, (e = { left: newAcc(), right: newAcc() }));
      const a = e[best.side];
      a[kind] += SW_STEP;
      if (kind !== "exist") continue;
      const r = +pr.RATING_OVERALL;
      if (r >= 1 && r <= 5) (a.grade += r * SW_STEP), (a.graded += SW_STEP);
      if (pr.FUNCTIONAL_CONDITION === "FUNCTIONALLY DEFICIENT" || pr.FUNCTIONAL_CONDITION === "FUNCTIONALLY ACCEPTABLE") {
        a.assessed += SW_STEP;
        if (pr.FUNCTIONAL_CONDITION === "FUNCTIONALLY DEFICIENT") a.deficient += SW_STEP;
      }
      if (SW_WIDTH_M[pr.WIDTH_SIDEWALK]) a.widths.push(SW_WIDTH_M[pr.WIDTH_SIDEWALK]);
    }
  }
}
log(`sidewalk inventory: ${swMatched}/${swSamples} samples matched to street sides`);
const swSide = (a: SwAcc | undefined, L: number): SidewalkSide | undefined => {
  if (!a || a.exist + a.absent + a.shared < 0.25 * L) return undefined;
  const coverage = Math.min(1, a.exist / L);
  const status = coverage >= 0.4 ? (coverage >= 0.8 ? "existing" : "partial") : a.shared > a.absent ? "shared" : a.absent >= 0.4 * L ? "absent" : "partial";
  const g = a.graded ? Math.round(a.grade / a.graded) : 0;
  const w = a.widths.sort((x, y) => x - y)[Math.floor(a.widths.length / 2)];
  return { status, coverage: Math.round(coverage * 100) / 100, ...(g ? { grade: (["A", "B", "C", "D", "F"] as const)[g - 1] } : {}), ...(a.assessed ? { deficient: Math.round((a.deficient / a.assessed) * 100) / 100 } : {}), ...(w ? { width: w } : {}) };
};
let swMeasured = 0;
const nodes = new Map<string, StreetNode>();
const streets: Street[] = [];
let sid = 0;
const nodeRef = (r: number) => `n:${r}`;
let measuredRow = 0,
  measuredLanes = 0;
for (const s of segs) {
  const t = s.tags;
  const cls = CLASS[t.highway];
  const pts0 = s.refs.map((r) => {
    const ll = nodeLL.get(r)!;
    return P(ll[0], ll[1]);
  });
  const pts = simplifyPath(pts0, 0.3);
  const L = polyLength(pts);
  if (L < 0.5) continue;
  const mid = pts[Math.floor(pts.length / 2)];
  if (!inBounds(mid, 120)) continue;
  const oneway = t.oneway === "yes" || t.oneway === "1" || t.oneway === "true" || t.oneway === "-1" || t.junction === "roundabout" || cls === "motorway" || cls === "motorway_link" && t.oneway !== "no";
  const name = t.name ?? t.ref;
  const am = cls !== "service" && cls !== "pedestrian" ? matchAsmp(pts, normName(t.name)) : null;
  const lanesTag = t.lanes ? parseInt(t.lanes) : undefined;
  const lanes = lanesTag ?? (am?.lanes && am.lanes > 0 ? am.lanes : undefined);
  if (!lanesTag && am?.lanes) measuredLanes++;
  const busFwd = (t["lanes:bus:forward"] && +t["lanes:bus:forward"] > 0) || /designated/.test(t["bus:lanes"] ?? t["bus:lanes:forward"] ?? "") || t["busway:right"] === "lane" || t.busway === "lane";
  const downtown = isDowntown(mid);
  const swm = swAcc.get(s);
  const swL = swSide(swm?.left, L),
    swR = swSide(swm?.right, L);
  const swPresent = (x?: SidewalkSide) => (x ? x.status === "existing" || x.status === "partial" : undefined);
  if (swL || swR) swMeasured++;
  const inp: SectionInputs = {
    cls,
    oneway,
    lanes: lanes && busFwd && t["lanes:bus"] ? Math.max(1, lanes - (+t["lanes:bus"] || 0)) : lanes && busFwd && t["lanes:bus:forward"] ? Math.max(1, lanes - +t["lanes:bus:forward"]) : lanes,
    lanesForward: t["lanes:forward"] ? parseInt(t["lanes:forward"]) - (busFwd && t["lanes:bus:forward"] ? +t["lanes:bus:forward"] : 0) : undefined,
    lanesBackward: t["lanes:backward"] ? parseInt(t["lanes:backward"]) : undefined,
    centreTurn: !!t["lanes:both_ways"] || /\b5U\b|\b3U\b/.test(am?.xs ?? ""),
    median: /D\b|D-/.test(am?.xs ?? "") && !oneway,
    bikeLeft: bikeOf(side(t, "cycleway", "left")),
    bikeRight: bikeOf(side(t, "cycleway", "right")),
    parkingLeft: parkOf(t, "left") ?? (/OP/.test(am?.xs ?? "") && cls !== "primary" ? true : cls === "residential" && !oneway),
    parkingRight: parkOf(t, "right") ?? (/OP/.test(am?.xs ?? "") && cls !== "primary" ? true : cls === "residential"),
    // the City's inventory, where it covers this side, overrides OSM tags and class defaults
    sidewalkLeft: swPresent(swL) ?? sidewalkOf(t, "left"),
    sidewalkRight: swPresent(swR) ?? sidewalkOf(t, "right"),
    busLanes: !!busFwd,
    row: am?.row && am.row > 8 && am.row < 70 ? am.row : t.width ? parseFloat(t.width) + 6 : undefined,
    downtown,
  };
  if (cls === "service") {
    inp.parkingLeft = inp.parkingRight = false;
    inp.sidewalkLeft = inp.sidewalkLeft ?? false;
    inp.sidewalkRight = inp.sidewalkRight ?? false;
  }
  if (inp.row && am?.row) measuredRow++;
  const section = buildSection(inp);
  const from = nodeRef(s.refs[0]);
  const to = nodeRef(s.refs[s.refs.length - 1]);
  for (const [nid, p] of [
    [from, pts[0]],
    [to, pts[pts.length - 1]],
  ] as [string, Vec2][]) {
    if (!nodes.has(nid)) nodes.set(nid, { id: nid, kind: "node", p, control: "none", edges: [] });
  }
  const id = `s:${++sid}`;
  const st: Street = {
    id, kind: "street", from, to, path: pts, name, cls, oneway, section,
    speed: parseSpeed(t.maxspeed) ?? DEFAULT_SPEED[cls],
    bridge: t.bridge === "yes" || t.bridge === "viaduct" || undefined,
    tunnel: t.tunnel === "yes" || undefined,
    layer: t.layer ? parseInt(t.layer) : undefined,
    private: cls === "service" && t.service !== "alley" ? true : undefined,
    rowSource: am?.row ? "measured" : "estimated",
    sectionSource: t.lanes || t["cycleway:both"] || t["cycleway:right"] ? "mapped" : am?.lanes ? "derived" : "estimated",
    source: `OSM way ${s.osm}${am ? " · ASMP street network" : ""}${swL || swR ? " · City sidewalk inventory" : ""}`,
    ...(swL || swR ? { sidewalks: { ...(swL ? { left: swL } : {}), ...(swR ? { right: swR } : {}) } } : {}),
  };
  streets.push(st);
  nodes.get(from)!.edges.push(id);
  if (to !== from) nodes.get(to)!.edges.push(id);
}
const streetById = new Map(streets.map((s) => [s.id, s]));
log(`sidewalk inventory applied to ${swMeasured}/${streets.length} segments`);
// curb ramps from the City inventory, attached to the nearest junction within 20 m
{
  const jIdx = new GridIndex(50);
  for (const n of nodes.values()) if (n.edges.length >= 2) jIdx.insert(n.id, [n.p[0], n.p[1], n.p[0], n.p[1]]);
  let attached = 0;
  for (const f of gis("curb_ramps").features) {
    if (f.geometry?.type !== "Point") continue;
    const p = P(f.geometry.coordinates[0], f.geometry.coordinates[1]);
    let best: StreetNode | null = null,
      bd = 20;
    for (const id of jIdx.query([p[0] - 20, p[1] - 20, p[0] + 20, p[1] + 20])) {
      const n = nodes.get(id)!;
      const d = dist(n.p, p);
      if (d < bd) (bd = d), (best = n);
    }
    if (!best) continue;
    const r = f.properties.RATING as string | null;
    const absent = r === "6" || f.properties.CURB_RAMP_TYPE === "ABSENT";
    if (!absent && !r) continue;
    const rr = (best.ramps ??= { ok: 0, poor: 0, absent: 0 });
    if (absent) rr.absent++;
    else if (+r! >= 4) rr.poor++;
    else rr.ok++;
    attached++;
  }
  log(`curb ramps: ${attached} attached to junctions`);
}
// signal / stop control from mapped nodes (snap to nearest junction within 18 m)
const nodeIdx = new GridIndex(50);
for (const n of nodes.values()) nodeIdx.insert(n.id, [n.p[0], n.p[1], n.p[0], n.p[1]]);
let signals = 0;
for (const n of osm.nodes) {
  const hw = n.tags.highway;
  if (hw !== "traffic_signals" && hw !== "stop") continue;
  const p = P(n.lon, n.lat);
  let best: StreetNode | null = null,
    bd = hw === "stop" ? 14 : 22;
  for (const k of nodeIdx.query([p[0] - 22, p[1] - 22, p[0] + 22, p[1] + 22])) {
    const nd = nodes.get(k)!;
    if (nd.edges.length < 3) continue;
    const d = dist(nd.p, p);
    if (d < bd) {
      bd = d;
      best = nd;
    }
  }
  const direct = nodes.get(nodeRef(n.id));
  const target = direct && direct.edges.length >= 2 ? direct : best;
  if (!target) continue;
  if (hw === "traffic_signals") {
    if (target.control !== "signal") signals++;
    target.control = "signal";
  } else if (target.control === "none") target.control = "stop";
}
for (const n of nodes.values()) if (n.control === "none" && n.edges.length >= 3) {
  const cl = n.edges.map((e) => streetById.get(e)?.cls);
  if (cl.every((c) => c === "residential" || c === "service" || c === "living")) n.control = "stop";
}
log("streets", streets.length, "nodes", nodes.size, "signals", signals, "measured ROW", measuredRow, "ASMP lanes", measuredLanes);

// ---------------------------------------------------------------- areas
const areas: Area[] = [];
const ctxRect: Polygon = [[[BOUNDS[0] - 400, BOUNDS[1] - 400], [BOUNDS[2] + 400, BOUNDS[1] - 400], [BOUNDS[2] + 400, BOUNDS[3] + 400], [BOUNDS[0] - 400, BOUNDS[3] + 400]]];
function areaType(t: Record<string, string>): AreaType | null {
  if (t.building) return null;
  if (t.natural === "water" || t.water || t.waterway === "riverbank" || t.landuse === "reservoir" || t.landuse === "basin") return t.water === "pond" || t.landuse === "basin" ? "retention" : "water";
  if (["park", "garden", "playground", "dog_park", "nature_reserve", "common"].includes(t.leisure) || ["recreation_ground", "village_green"].includes(t.landuse)) return "park";
  if (t.leisure === "pitch" || t.leisure === "track" || t.leisure === "stadium") return "pitch";
  if (["grass", "flowerbed", "meadow"].includes(t.landuse) || t.natural === "grassland") return "grass";
  if (["wood", "scrub", "shrubbery", "heath"].includes(t.natural) || t.landuse === "forest") return "wood";
  if (t.amenity === "parking" && !["underground", "multi-storey", "rooftop"].includes(t.parking)) return "parking";
  if ((t.highway === "pedestrian" && t.area === "yes") || t.place === "square") return "plaza";
  if (t.landuse === "construction") return "construction";
  if (t.landuse === "cemetery" || t.amenity === "grave_yard") return "cemetery";
  if (t.amenity === "university" || t.amenity === "college") return "campus";
  return null;
}
for (const a of osm.areas) {
  const type = areaType(a.tags);
  if (!type) continue;
  for (const rings of a.polys) {
    let poly = osmPoly(rings);
    if (!isValidPoly(poly)) continue;
    const bb = polyBBox(poly);
    if (bb[2] < BOUNDS[0] - 400 || bb[0] > BOUNDS[2] + 400 || bb[3] < BOUNDS[1] - 400 || bb[1] > BOUNDS[3] + 400) continue;
    if (bb[0] < ctxRect[0][0][0] || bb[2] > ctxRect[0][1][0] || bb[1] < ctxRect[0][0][1] || bb[3] > ctxRect[0][2][1]) {
      const clipped = intersection(poly, ctxRect);
      if (!clipped.length) continue;
      poly = clipped.sort((x, y) => polyArea(y) - polyArea(x))[0];
    }
    if (type === "parking" && polyArea(poly) < 60) continue;
    areas.push({ id: `a:${a.kind[0]}${a.id}${a.polys.length > 1 ? `_${areas.length}` : ""}`, kind: "area", type, poly, name: a.tags.name, source: "OpenStreetMap", provenance: "mapped" });
  }
}
// City parks not already mapped
for (const f of gis("parks").features) {
  for (const poly of gjPolys(f.geometry)) {
    if (!isValidPoly(poly)) continue;
    const c = polyCentroid(poly);
    if (!inBounds(c, 200)) continue;
    const covered = areas.filter((a) => a.type === "park").reduce((s, a) => s + overlapArea(a.poly, poly), 0);
    if (covered > 0.5 * polyArea(poly)) {
      // attach the official name if the OSM park lacks one
      const host = areas.find((a) => a.type === "park" && !a.name && overlapArea(a.poly, poly) > 0.5 * polyArea(a.poly));
      if (host) host.name = f.properties.LOCATION_NAME;
      continue;
    }
    areas.push({ id: `a:cp${f.properties.OBJECTID}`, kind: "area", type: "park", poly, name: f.properties.LOCATION_NAME, source: "City of Austin Parks (PARD)", provenance: "measured" });
  }
}
log("areas", areas.length);

// ---------------------------------------------------------------- trees
const trees: Tree[] = osm.nodes
  .filter((n) => n.tags.natural === "tree")
  .map((n) => {
    const p = P(n.lon, n.lat);
    const crown = n.tags.diameter_crown ? parseFloat(n.tags.diameter_crown) / 2 : 4;
    const h = parseH(n.tags.height) ?? 9;
    return { id: `t:${n.id}`, kind: "tree" as const, p, r: Math.max(1.5, Math.min(10, crown)), h, source: "OpenStreetMap", provenance: "mapped" as const };
  })
  .filter((t) => inBounds(t.p));
log("trees", trees.length);

// ---------------------------------------------------------------- parcels
const parcels: Parcel[] = [];
const bandIdx = new GridIndex(80);
const bands = streets.filter((st) => st.cls !== "motorway" && !st.tunnel).map((st) => [rowBand(st.path, st.section)] as Polygon);
bands.forEach((bnd, i) => bandIdx.insert(String(i), polyBBox(bnd)));
const parkPolys = areas.filter((a) => a.type === "park" || a.type === "pitch");
const parkingPolys = areas.filter((a) => a.type === "parking");
const waterPolys = areas.filter((a) => a.type === "water");
const aIdx = new GridIndex(80);
areas.forEach((a, i) => aIdx.insert(String(i), polyBBox(a.poly)));
for (const f of gis("lots").features) {
  const polys = gjPolys(f.geometry).map((p) => normalizePoly(p.map((r) => simplifyRing(r, 0.1)))).filter(isValidPoly);
  if (!polys.length) continue;
  const poly = polys.sort((a, b) => polyArea(b) - polyArea(a))[0];
  const c = polyCentroid(poly);
  if (!inBounds(c)) continue;
  const area = polyArea(poly);
  if (area < 30) continue;
  const zone = zoningAt(pointInPoly(c, poly) ? c : poly[0][0]);
  const rule = zoningRule(zone?.ztype ?? "", zone?.base);
  let maxFar = rule.far;
  let maxHeight = rule.heightFt != null ? rule.heightFt * 0.3048 : null;
  // the Downtown Density Bonus Program (LDC 25-2-586) applies to CBD and DMU sites only
  const ddbEligible = zone?.base === "CBD" || zone?.base === "DMU" || /DDB/.test(zone?.ztype ?? "");
  const db = ddbEligible ? dbonus.find((d) => pointInPoly(c, d.poly)) : undefined;
  if (db) {
    maxFar = Math.max(maxFar ?? 0, db.far);
    maxHeight = db.h ? Math.max(maxHeight ?? 0, db.h * 0.3048) : null;
  }
  let cvc: number | null = null;
  for (const v of cvcs) if (overlapArea(poly, v.poly) > 0.05 * area) cvc = cvc == null ? v.elev : Math.min(cvc, v.elev);
  const bb = polyBBox(poly);
  let bCover = 0;
  for (const k of bIdx.query(bb)) {
    const b = bById.get(k);
    if (b) bCover += overlapArea(poly, b.footprint);
  }
  let parkCover = 0,
    parkingCover = 0,
    waterCover = 0;
  for (const k of aIdx.query(bb)) {
    const a = areas[+k];
    if (a.type === "park" || a.type === "pitch") parkCover += overlapArea(poly, a.poly);
    else if (a.type === "parking") parkingCover += overlapArea(poly, a.poly);
    else if (a.type === "water") waterCover += overlapArea(poly, a.poly);
  }
  let rowCover = 0;
  for (const k of bandIdx.query(bb)) rowCover += overlapArea(poly, bands[+k]);
  const box = obb(poly[0]);
  const compact = box.width > 12 && area / Math.max(1, box.length * box.width) > 0.55;
  const landUse: Parcel["landUse"] =
    rowCover > 0.35 * area ? "row" : waterCover > 0.5 * area ? "water" : parkCover > 0.5 * area ? "park" : bCover > 0.12 * area ? "building" : parkingCover > 0.35 * area ? "parking" : zone?.base === "P" && bCover > 0.02 * area ? "civic" : bCover < 0.03 * area && compact ? "vacant" : bCover > 0.03 * area ? "building" : "row";
  parcels.push({
    id: `p:${f.properties.OBJECTID}`, kind: "parcel", poly, area: Math.round(area),
    zoning: zone?.ztype ?? "UNKNOWN", zoningBase: zone?.base ?? "", maxFar, maxHeight: maxHeight != null ? Math.round(maxHeight * 10) / 10 : null,
    cvcCeiling: cvc != null ? Math.round(cvc * 10) / 10 : null, historic: zone ? isHistoricZoning(zone.ztype) : false, landUse,
    source: "City of Austin Lot Lines · Zoning",
  });
}
void parkPolys; void parkingPolys; void waterPolys;
// ---- appraisal values and public ownership (TCAD monthly snapshot, Travis County TNR). Only the names of
// public bodies are kept; private owners are recorded as such, without names.
const PUBLIC_OWNERS: [RegExp, string][] = [
  [/^CITY OF AUSTIN\b/, "City of Austin"],
  [/^AUSTIN HOUSING FINANCE CORP/, "Austin Housing Finance Corporation"],
  [/^HOUSING AUTHORITY OF (THE )?(CITY OF AUSTIN|AUSTIN|COA)\b/, "Housing Authority of the City of Austin"],
  [/^TRAVIS COUNTY( TRUSTEE)?$|^TRAVIS COUNTY (OF|HEALTHCARE|HOSPITAL)/, "Travis County"],
  [/^STATE OF TEXAS( BUILDING COMMIS| TEXAS TRANSPORTATION| YOUTH COUNCIL)?|^TEXAS FACILITIES COMMISSION|^TEXAS DEPARTMENT OF TRANSPORTATION/, "State of Texas"],
  [/^(BOARD OF REGENTS OF THE( UNIVERSITY OF TEXAS SYSTEM)?|UNIVERSITY OF TEXAS( SYSTEM| AT AUSTIN| BOARD OF REGENTS)?)$/, "University of Texas System"],
  [/^AUSTIN INDEPENDENT SCHOOL/, "Austin ISD"],
  [/^AUSTIN COMMUNITY COLLEGE/, "Austin Community College"],
  [/^CAPITAL METROPOLITAN/, "Capital Metro"],
  [/^UNITED STATES (OF AMERICA|GOVERNMENT)/, "United States"],
  [/^AUSTIN TRAVIS COUNTY MH-?MR/, "Integral Care"],
];
{
  interface Tcad { poly: Polygon; c: Vec2; area: number; land: number; imprv: number; owner: string | null }
  const tcad: Tcad[] = [];
  const tIdx = new GridIndex(60);
  const num = (v: unknown) => +(v as number) || 0;
  for (const f of gis("tcad_parcels").features) {
    const polys = gjPolys(f.geometry).filter(isValidPoly);
    if (!polys.length) continue;
    const poly = polys.sort((a, b) => polyArea(b) - polyArea(a))[0];
    const area = polyArea(poly);
    if (area < 10) continue;
    const pr = f.properties;
    const name = String(pr.py_owner_name ?? "").toUpperCase().replace(/\s+/g, " ").trim();
    tcad.push({ poly, c: polyCentroid(poly), area, land: num(pr.land_homesite_val) + num(pr.land_non_homesite_val), imprv: num(pr.imprv_homesite_val) + num(pr.imprv_non_homesite_val), owner: PUBLIC_OWNERS.find(([re]) => re.test(name))?.[1] ?? null });
    tIdx.insert(String(tcad.length - 1), polyBBox(poly));
  }
  let valued = 0,
    publicLots = 0;
  for (const p of parcels) {
    const c = polyCentroid(p.poly);
    const inside: Tcad[] = [];
    let container: Tcad | null = null;
    for (const k of tIdx.query(polyBBox(p.poly))) {
      const t = tcad[+k];
      if (pointInPoly(t.c, p.poly)) inside.push(t);
      else if (!container && pointInPoly(c, t.poly)) container = t;
    }
    // appraisal parcels inside the lot are summed (condominium units stack on one footprint);
    // a lot inside a larger appraisal parcel takes its area share
    const src = inside.length ? inside : container ? [container] : [];
    if (!src.length) continue;
    const share = inside.length ? 1 : Math.min(1, p.area / container!.area);
    const land = src.reduce((s, t) => s + t.land, 0) * share,
      imprv = src.reduce((s, t) => s + t.imprv, 0) * share;
    if (land + imprv > 0) {
      p.value = { land: Math.round(land), improvements: Math.round(imprv) };
      valued++;
    }
    const owners = new Set(src.map((t) => t.owner));
    if (owners.size === 1 && src[0].owner) {
      p.owner = src[0].owner;
      publicLots++;
    }
  }
  log(`appraisal: ${valued}/${parcels.length} lots valued, ${publicLots} publicly owned`);
  // Equitable Transit-Oriented Development overlay (LDC 25-2-653): affordability-linked height bonus
  const etod = gis("etod").features.flatMap((f) => gjPolys(f.geometry).map((poly) => ({ poly, sub: String(f.properties.ZONING_OVERLAY_SUB_NAME ?? "").replace(/^Subdistrict\s*/i, ""), h: num(f.properties.MAX_HEIGHT) * 0.3048 })));
  let inEtod = 0;
  for (const p of parcels) {
    const c = polyCentroid(p.poly);
    const e = etod.find((x) => pointInPoly(c, x.poly));
    if (e) {
      p.etod = { subdistrict: e.sub, maxHeight: Math.round(e.h * 10) / 10 };
      inEtod++;
    }
  }
  log(`ETOD overlay: ${inEtod} lots eligible`);
}
const parcelById = new Map(parcels.map((p) => [p.id, p]));
// attach parcel ids to buildings
const pIdx = new GridIndex(60);
parcels.forEach((p, i) => pIdx.insert(String(i), polyBBox(p.poly)));
for (const b of buildings) {
  const c = polyCentroid(b.footprint);
  for (const k of pIdx.query([c[0], c[1], c[0], c[1]])) if (pointInPoly(c, parcels[+k].poly)) b.parcelId = parcels[+k].id;
  const par = b.parcelId ? parcelById.get(b.parcelId) : undefined;
  if (par?.historic) b.historic = true;
}
log("parcels", parcels.length, "vacant", parcels.filter((p) => p.landUse === "vacant").length, "parking", parcels.filter((p) => p.landUse === "parking").length);

// ---------------------------------------------------------------- transit
const stops: TransitStop[] = [];
for (const f of gis("bus_stops").features) {
  const pr = f.properties;
  if (pr.STATUS && pr.STATUS !== "Active") continue;
  const p = P(pr.LONGITUDE, pr.LATITUDE);
  if (!inBounds(p)) continue;
  stops.push({ id: `stop:${pr.STOP_ID}`, kind: "stop", p, name: pr.STOP_NAME ?? "", mode: "bus", routes: [], source: "Capital Metro (via City of Austin GIS)", provenance: "measured" });
}
const HEADWAY: Record<string, number> = { "High Frequency": 15, Local: 30, "UT Shuttle": 15, Crosstown: 30, Flyer: 30, Express: 45, "Night Owl": 60, Rail: 30, Special: 60 };
const routeMap = new Map<string, { name: string; ref: string; type: string; color: string; lines: Vec2[][] }>();
for (const f of gis("bus_routes").features) {
  const pr = f.properties;
  if (pr.SERVICENM !== "Weekday") continue;
  const key = `${pr.ROUTE_ID}-${pr.DIRECTION}`;
  if (!routeMap.has(key)) routeMap.set(key, { name: pr.ROUTENAME, ref: String(pr.ROUTE_ID), type: pr.ROUTETYPE, color: pr.ROUTECOLOR && pr.ROUTECOLOR !== "000000" ? `#${pr.ROUTECOLOR}` : "#2a6bd1", lines: [] });
  routeMap.get(key)!.lines.push(...gjLines(f.geometry));
}
const sIdx = new GridIndex(60);
streets.forEach((s, i) => sIdx.insert(String(i), pathBBox(s.path)));
function mapMatch(line: Vec2[]): string[] {
  const out: string[] = [];
  const L = polyLength(line);
  for (let d = 0; d <= L; d += 12) {
    const { p, dir } = (() => {
      let acc = 0;
      for (let i = 1; i < line.length; i++) {
        const l = dist(line[i - 1], line[i]);
        if (acc + l >= d) {
          const tt = l < 1e-6 ? 0 : (d - acc) / l;
          return { p: [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * tt, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * tt] as Vec2, dir: norm(sub(line[i], line[i - 1])) };
        }
        acc += l;
      }
      return { p: line[line.length - 1], dir: [1, 0] as Vec2 };
    })();
    if (!inBounds(p)) continue;
    let best: string | null = null,
      bd = 14;
    for (const k of sIdx.query([p[0] - 15, p[1] - 15, p[0] + 15, p[1] + 15])) {
      const s = streets[+k];
      if (s.cls === "service" || s.cls === "pedestrian") continue;
      const c = closestOnPath(p, s.path);
      if (c.d >= bd) continue;
      const a = s.path[c.seg],
        b = s.path[Math.min(s.path.length - 1, c.seg + 1)];
      const sd = norm(sub(b, a));
      if (Math.abs(sd[0] * dir[0] + sd[1] * dir[1]) < 0.75) continue;
      best = s.id;
      bd = c.d;
    }
    if (best && out[out.length - 1] !== best) out.push(best);
  }
  return out;
}
const routes: TransitRoute[] = [];
for (const [key, r] of routeMap) {
  // keep in-bounds portions
  const inside = r.lines.map((l) => l.filter((p) => inBounds(p, 50))).filter((l) => l.length > 1);
  if (!inside.length) continue;
  const pathL = inside.sort((a, b) => polyLength(b) - polyLength(a))[0];
  if (polyLength(pathL) < 200) continue;
  const mode = r.type === "Rail" ? "rail" : /80\d/.test(r.ref) ? "rapid" : "bus";
  const id = `r:${key}`;
  const route: TransitRoute = { id, kind: "route", mode, name: r.name, ref: r.ref, color: r.color, path: simplifyPath(pathL, 1), streets: mode === "rail" ? [] : mapMatch(pathL), stops: [], headway: /80\d/.test(r.ref) ? 12 : HEADWAY[r.type] ?? 30, source: "Capital Metro GTFS shapes (via City of Austin GIS)", provenance: "measured" };
  for (const s of stops) {
    if (s.mode !== "bus") continue;
    if (closestOnPath(s.p, route.path).d < 22) {
      route.stops.push(s.id);
      s.routes.push(id);
    }
  }
  // order stops along route
  route.stops.sort((a, b) => closestOnPath(stops.find((s) => s.id === a)!.p, route.path).along - closestOnPath(stops.find((s) => s.id === b)!.p, route.path).along);
  routes.push(route);
}
// MetroRail stations
const stationSeen = new Set<string>();
for (const n of osm.nodes) {
  if (n.tags.railway !== "station" || stationSeen.has(n.tags.name ?? "")) continue;
  stationSeen.add(n.tags.name ?? "");
  const p = P(n.lon, n.lat);
  if (!inBounds(p)) continue;
  const rid = routes.find((r) => r.mode === "rail")?.id;
  const st: TransitStop = { id: `stop:rail-${n.id}`, kind: "stop", p, name: `${n.tags.name} Station`, mode: "rail", routes: rid ? [rid] : [], source: "OpenStreetMap", provenance: "mapped" };
  stops.push(st);
  if (rid) routes.find((r) => r.id === rid)!.stops.push(st.id);
}
log("stops", stops.length, "routes", routes.length);

// ---------------------------------------------------------------- utilities
const utilities: Utility[] = [];
gis("drain_pipes").features.forEach((f, i) => {
  for (const line of gjLines(f.geometry)) {
    if (!line.some((p) => inBounds(p))) continue;
    const pp = simplifyPath(line, 0.5);
    if (polyLength(pp) < 2) continue;
    utilities.push({ id: `u:p${f.properties.OBJECTID ?? i}`, kind: "utility", type: "storm_pipe", path: pp, size: f.properties.WIDTH ?? undefined, source: "City of Austin Drainage Infrastructure" });
  }
});
gis("curb_inlets").features.forEach((f, i) => {
  const g = f.geometry;
  if (!g || g.type !== "Point") return;
  const p = P(g.coordinates[0], g.coordinates[1]);
  if (!inBounds(p)) return;
  utilities.push({ id: `u:i${f.properties.OBJECTID ?? i}`, kind: "utility", type: "inlet", path: [p], source: "City of Austin Drainage Infrastructure" });
});
log("utilities", utilities.length);

// ---------------------------------------------------------------- paths
const paths: FootPath[] = [];
for (const w of osm.ways) {
  const t = w.tags;
  const hw = t.highway;
  if (!hw || !["footway", "path", "cycleway", "steps", "track", "bridleway"].includes(hw)) continue;
  if (t.footway === "sidewalk" || t.footway === "crossing" || t.footway === "access_aisle" || t.footway === "traffic_island") continue;
  const pts = simplifyPath(w.coords.map(([x, y]) => P(x, y)), 0.4);
  if (polyLength(pts) < 4 || !pts.some((p) => inBounds(p))) continue;
  paths.push({ id: `w:${w.id}`, kind: "path", path: pts, type: hw === "cycleway" ? "cycleway" : hw === "steps" ? "steps" : hw === "track" ? "trail" : t.name?.match(/trail/i) ? "trail" : hw === "path" ? "path" : "footway", name: t.name, source: "OpenStreetMap" });
}
log("paths", paths.length);

// ---------------------------------------------------------------- POIs and places
function poiCat(t: Record<string, string>): Poi["category"] | null {
  const a = t.amenity, s = t.shop, tr = t.tourism;
  if (s === "supermarket" || s === "grocery" || s === "greengrocer" || s === "convenience") return "grocery";
  if (a === "school" || a === "kindergarten" || a === "childcare") return "school";
  if (a === "university" || a === "college") return "university";
  if (["hospital", "clinic", "doctors", "pharmacy", "dentist"].includes(a) || t.healthcare) return "health";
  if (["restaurant", "cafe", "fast_food", "bar", "pub", "food_court", "ice_cream", "biergarten"].includes(a)) return "food";
  if (["townhall", "courthouse", "police", "fire_station", "post_office", "library", "community_centre", "social_facility"].includes(a)) return "civic";
  if (["museum", "gallery", "attraction"].includes(tr) || ["theatre", "arts_centre", "cinema", "music_venue"].includes(a)) return "culture";
  if (a === "place_of_worship") return "worship";
  if (tr === "hotel" || tr === "hostel") return "hotel";
  if (s) return "shop";
  if (t.historic) return "landmark";
  return null;
}
const pois: Poi[] = [];
for (const q of poiRaw) {
  const cat = poiCat(q.tags);
  if (!cat || !inBounds(q.p)) continue;
  pois.push({ id: `poi:${q.id}`, kind: "poi", p: q.p, name: q.name, category: cat, source: "OpenStreetMap" });
}
const places: Place[] = [];
for (const d of downtownDistricts) places.push({ id: `place:dd-${d.name}`, kind: "place", name: d.name, type: "district", p: polyCentroid(d.poly), poly: d.poly, source: "City of Austin Downtown Austin Plan districts" });
// Downtown as a whole (the union of the Downtown Austin Plan districts)
if (downtownDistricts.length) {
  const dt = unionMany(downtownDistricts.map((d) => d.poly)).sort((a, b) => polyArea(b) - polyArea(a))[0];
  if (dt) places.push({ id: "place:downtown", kind: "place", name: "Downtown", type: "district", p: polyCentroid(dt), poly: dt, source: "City of Austin Downtown Austin Plan districts (union)" });
}
// adopted Neighborhood Planning Areas (sub-districts merged), clipped to the context ring
const titleCase = (x: string) => x.toLowerCase().replace(/(^|[\s-])\w/g, (m) => m.toUpperCase());
const npaByName = new Map<string, Polygon[]>();
for (const f of fs.existsSync(`${RAW}/austin-gis/planning_areas.geojson`) ? gis("planning_areas").features : []) {
  const nm = titleCase(String(f.properties.PLANNING_AREA_NAME));
  npaByName.set(nm, [...(npaByName.get(nm) ?? []), ...gjPolys(f.geometry)]);
}
const clipBox: Polygon = [[[BOUNDS[0] - 600, BOUNDS[1] - 600], [BOUNDS[2] + 600, BOUNDS[1] - 600], [BOUNDS[2] + 600, BOUNDS[3] + 600], [BOUNDS[0] - 600, BOUNDS[3] + 600]]];
for (const [nm, polys] of npaByName) {
  const u = unionMany(polys).flatMap((q) => intersection(q, clipBox)).sort((a, b) => polyArea(b) - polyArea(a))[0];
  if (u && polyArea(u) > 20000 && inBounds(polyCentroid(u), 400)) places.push({ id: `place:npa-${nm.replace(/\W+/g, "-")}`, kind: "place", name: nm, type: "neighbourhood", p: polyCentroid(u), poly: u.map((r) => simplifyRing(r, 2)), source: "City of Austin Neighborhood Planning Areas" });
}
for (const n of osm.nodes) {
  if (["neighbourhood", "suburb", "quarter"].includes(n.tags.place) && n.tags.name) {
    const p = P(n.lon, n.lat);
    // an official boundary with the same name wins over the OSM label point
    if (places.some((q) => q.poly && q.name.toLowerCase() === String(n.tags.name).toLowerCase())) continue;
    if (inBounds(p, 300)) places.push({ id: `place:n${n.id}`, kind: "place", name: n.tags.name, type: "neighbourhood", p, source: "OpenStreetMap (label point; no mapped boundary)" });
  }
}
for (const a of areas) if (a.name && (a.type === "park" || a.type === "water" || a.type === "campus" || a.type === "plaza")) places.push({ id: `place:${a.id}`, kind: "place", name: a.name, type: a.type === "campus" ? "campus" : a.type === "water" ? "water" : "park", p: polyCentroid(a.poly), poly: a.poly, refs: [a.id], source: a.source });
for (const b of buildings) if (b.name && (b.height > 60 || b.historic || b.use === "civic" || b.use === "religious")) places.push({ id: `place:${b.id}`, kind: "place", name: b.name, type: "landmark", p: polyCentroid(b.footprint), refs: [b.id], source: b.source });
for (const st of streets) if (st.bridge && st.name && polyLength(st.path) > 60 && st.cls !== "service") {
  const nm = `${st.name} bridge`;
  const ex = places.find((p) => p.name === nm);
  if (ex) ex.refs!.push(st.id);
  else places.push({ id: `place:br-${st.id}`, kind: "place", name: nm, type: "bridge", p: st.path[Math.floor(st.path.length / 2)], refs: [st.id], source: "OpenStreetMap" });
}
for (const s of stops) if (s.mode === "rail") places.push({ id: `place:${s.id}`, kind: "place", name: s.name, type: "station", p: s.p, refs: [s.id], source: s.source });
log("pois", pois.length, "places", places.length);

// ---------------------------------------------------------------- census + counts
const census: CensusBlock[] = [];
for (const f of extra("census_blocks").features) {
  for (const poly of gjPolys(f.geometry)) {
    if (!isValidPoly(poly)) continue;
    census.push({ geoid: f.properties.GEOID, pop: f.properties.POP100, hu: f.properties.HU100, poly: normalizePoly(poly.map((r) => simplifyRing(r, 0.5))) });
  }
}
const counts: CountStation[] = extra("txdot_aadt").features
  .filter((f) => f.geometry && f.properties.AADT_RPT_QTY)
  .map((f) => ({ id: String(f.properties.TRFC_STATN_ID), road: String(f.properties.ON_ROAD ?? ""), aadt: f.properties.AADT_RPT_QTY, year: f.properties.AADT_RPT_YEAR, p: P(f.geometry!.coordinates[0], f.geometry!.coordinates[1]) }))
  .filter((c) => inBounds(c.p));
const fema: { zone: string; poly: Polygon }[] = [];
for (const f of gis("fema").features) for (const poly of gjPolys(f.geometry)) if (isValidPoly(poly)) fema.push({ zone: f.properties.FLOOD_ZONE, poly: normalizePoly(poly.map((r) => simplifyRing(r, 0.5))) });
log("census blocks", census.length, "pop", census.reduce((s, c) => s + c.pop, 0), "counts", counts.length, "fema", fema.length);

// ---------------------------------------------------------------- measured occupancy allocation
{
  const lodesFile = `${RAW}/${city}-extra/lodes_wac_2023.json`;
  const lodes: Record<string, { jobs: number }> = fs.existsSync(lodesFile) ? JSON.parse(fs.readFileSync(lodesFile, "utf8")) : {};
  const blockIdx = new GridIndex(80);
  census.forEach((c, i) => blockIdx.insert(String(i), polyBBox(c.poly)));
  const resW = new Map<string, number>(),
    jobW = new Map<string, number>();
  const blockOf = new Map<string, number>();
  for (const b of buildings) {
    const c = polyCentroid(b.footprint);
    for (const k of blockIdx.query([c[0], c[1], c[0], c[1]])) if (pointInPoly(c, census[+k].poly)) blockOf.set(b.id, +k);
    const g = existingGFA(polyArea(b.footprint), b.floors);
    const res = (b.program.residential ?? 0) + (b.use === "residential" ? 0 : 0);
    resW.set(b.id, g * res);
    const nonRes = 1 - (b.program.residential ?? 0) - (b.program.parking ?? 0) - (b.program.utility ?? 0) - (b.program.other ?? 0) - (b.program.religious ?? 0) * 0.8;
    jobW.set(b.id, g * Math.max(0, nonRes));
  }
  const sumRes = new Map<number, number>(),
    sumJob = new Map<number, number>(),
    sumAll = new Map<number, number>();
  for (const b of buildings) {
    const k = blockOf.get(b.id);
    if (k === undefined) continue;
    sumRes.set(k, (sumRes.get(k) ?? 0) + resW.get(b.id)!);
    sumJob.set(k, (sumJob.get(k) ?? 0) + jobW.get(b.id)!);
    sumAll.set(k, (sumAll.get(k) ?? 0) + existingGFA(polyArea(b.footprint), b.floors));
  }
  let hu = 0,
    jobs = 0,
    unallocHU = 0,
    unallocJobs = 0;
  for (const b of buildings) {
    const k = blockOf.get(b.id);
    const g = existingGFA(polyArea(b.footprint), b.floors);
    let units = 0,
      j = 0;
    if (k !== undefined) {
      const blk = census[k];
      const sr = sumRes.get(k) ?? 0;
      const sj = sumJob.get(k) ?? 0;
      const tot = sumAll.get(k) ?? 0;
      units = sr > 0 ? (blk.hu * resW.get(b.id)!) / sr : tot > 0 ? (blk.hu * g) / tot : 0;
      const bj = lodes[blk.geoid]?.jobs ?? 0;
      j = sj > 0 ? (bj * jobW.get(b.id)!) / sj : tot > 0 ? (bj * g) / tot : 0;
    }
    b.existing = { units: Math.round(units * 10) / 10, jobs: Math.round(j * 10) / 10, gfa: Math.round(g), volume: Math.round(massVolume(b)), use: b.use };
    hu += units;
    jobs += j;
  }
  for (let k = 0; k < census.length; k++) {
    if ((sumAll.get(k) ?? 0) === 0) unallocHU += census[k].hu;
    if ((sumAll.get(k) ?? 0) === 0) unallocJobs += lodes[census[k].geoid]?.jobs ?? 0;
  }
  const totalJobs = Object.values(lodes).reduce((s, v) => s + v.jobs, 0);
  log("allocated HU", Math.round(hu), "of", census.reduce((s, c) => s + c.hu, 0), "(unallocated", unallocHU, ") jobs", Math.round(jobs), "of", totalJobs, "(unallocated", unallocJobs, ")");
  (globalThis as unknown as { __jobs: number }).__jobs = totalJobs;
  void PROGRAMME;
}

// ---------------------------------------------------------------- rasters (4 m)
const CELL = 4;
const grid = { x0: Math.floor(BOUNDS[0]), y0: Math.floor(BOUNDS[1]), cell: CELL, nx: Math.ceil((BOUNDS[2] - BOUNDS[0]) / CELL), ny: Math.ceil((BOUNDS[3] - BOUNDS[1]) / CELL) };
// base land cover from measured impervious surfaces (structures / roads come from the world model at runtime)
const LC = { pervious: 0, paved: 3, bare: 8, pool: 9 } as const;
const lc = new Uint8Array(grid.nx * grid.ny);
const impClass: Record<string, number> = {
  "Paved Driveway": LC.paved, Patio: LC.paved, Pavement: LC.paved, "Paved Parking": LC.paved, Courtyard: LC.paved, "Paved Alley": LC.paved,
  Miscellaneous: LC.paved, "Open Storage": LC.paved, Bridge: LC.paved, "Covered Deck": LC.paved, "Uncovered Deck": LC.paved, Sidewalk: LC.paved,
  "Median > 10 Feet": LC.paved, "Unpaved Driveway": LC.bare, "Unpaved Parking": LC.bare, "Compacted Soil": LC.bare, "In Ground Pool": LC.pool,
};
let impMeasured = 0;
{
  const imp = gis("impervious");
  for (const f of imp.features) {
    const feat = f.properties.FEATURE as string;
    const v = impClass[feat];
    if (feat !== "Structure" && feat !== "Open Space") for (const poly of gjPolys(f.geometry)) impMeasured += polyArea(poly);
    else if (feat === "Structure") for (const poly of gjPolys(f.geometry)) impMeasured += polyArea(poly);
    if (v === undefined) continue;
    for (const poly of gjPolys(f.geometry)) rasterizeRings(grid, poly, (i) => (lc[i] = v));
  }
}
const studyArea = (BOUNDS[2] - BOUNDS[0]) * (BOUNDS[3] - BOUNDS[1]);
log("landcover raster", grid.nx, grid.ny, "measured impervious fraction", (impMeasured / studyArea).toFixed(3));
// measured tree canopy (City of Austin 2022) as a flag bit over the ground class
const CANOPY_BIT = 0x80;
let canopyCells = 0;
if (fs.existsSync(`${RAW}/austin-gis/canopy_2022.geojson`))
  for (const f of gis("canopy_2022").features)
    for (const poly of gjPolys(f.geometry))
      rasterizeRings(grid, poly, (i) => {
        if (!(lc[i] & CANOPY_BIT)) canopyCells++;
        lc[i] |= CANOPY_BIT;
      });
log("measured canopy cover", ((canopyCells * CELL * CELL) / studyArea).toFixed(3));
// DEM resampled onto the analysis grid (decimetres, uint16)
const dem = new Uint16Array(grid.nx * grid.ny);
for (let j = 0; j < grid.ny; j++)
  for (let i = 0; i < grid.nx; i++) dem[j * grid.nx + i] = Math.round(demAt([grid.x0 + (i + 0.5) * CELL, grid.y0 + (j + 0.5) * CELL]) * 10);
fs.writeFileSync(`${OUT}/landcover.bin`, Buffer.from(lc.buffer));
fs.writeFileSync(`${OUT}/dem.bin`, Buffer.from(dem.buffer));

// ---------------------------------------------------------------- context ring
const ctxBuildings: [number[], number][] = [];
for (const a of osm.ctxAreas) {
  const t = a.tags;
  if (!t.building) continue;
  const poly = osmPoly(a.polys[0]);
  if (!isValidPoly(poly)) continue;
  const c = polyCentroid(poly);
  if (inBounds(c)) continue;
  const h = parseH(t.height) ?? (t["building:levels"] ? parseFloat(t["building:levels"]) * 3.4 + 1 : 6.5);
  ctxBuildings.push([poly[0].flatMap((p) => p), Math.round(h * 10) / 10]);
}
const ctxRoads = osm.ctxWays
  .filter((w) => w.tags.highway && CLASS[w.tags.highway] && CLASS[w.tags.highway] !== "service")
  .map((w) => ({ c: CLASS[w.tags.highway], p: simplifyPath(w.coords.map(([x, y]) => P(x, y)), 0.8).flatMap((p) => p) }));
const ctxAreas = osm.ctxAreas
  .map((a) => ({ t: areaType(a.tags), poly: osmPoly(a.polys[0]) }))
  .filter((a) => a.t && ["park", "water", "wood", "grass", "pitch"].includes(a.t) && isValidPoly(a.poly) && polyArea(a.poly) > 400)
  .map((a) => ({ t: a.t, r: a.poly[0].flatMap((p) => p) }));
fs.writeFileSync(`${OUT}/context.json`, JSON.stringify({ buildings: ctxBuildings, roads: ctxRoads, areas: ctxAreas }));
log("context", ctxBuildings.length, ctxRoads.length, ctxAreas.length);

// ---------------------------------------------------------------- meta + write
const weather = JSON.parse(fs.readFileSync(`${RAW}/${city}-extra/weather.json`, "utf8"));
const centre = proj.toLocal(cfg.initialView.center[0], cfg.initialView.center[1]);
const ctxB = osm.contextBbox;
const csw = proj.toLocal(ctxB[0], ctxB[1]);
const cne = proj.toLocal(ctxB[2], ctxB[3]);
const today = new Date().toISOString().slice(0, 10);
const meta: CityMeta & { grid: typeof grid; impervious: { measuredFraction: number } } = {
  id: city,
  name: cfg.name,
  region: cfg.region,
  origin: { lon: proj.lon0, lat: proj.lat0 },
  bounds: BOUNDS,
  contextBounds: [csw[0], csw[1], cne[0], cne[1]],
  timezone: cfg.timezone,
  waterLevel: cfg.waterLevel,
  sources: [
    { id: "osm", name: "OpenStreetMap (BBBike extract 2026-10-17)", url: "https://www.openstreetmap.org/copyright", license: "ODbL", retrieved: today, kind: "mapped" },
    { id: "coa-footprints", name: "City of Austin Building Footprints 2023 (LiDAR heights)", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/PlanimetricsSurvey_1/MapServer/0", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "coa-impervious", name: "City of Austin Impervious Cover 2023", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/PlanimetricsSurvey_1/MapServer/1", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "coa-canopy", name: "City of Austin Tree Canopy 2022", url: "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/tree_canopy_2022/FeatureServer", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "coa-npa", name: "City of Austin Neighborhood Planning Areas & Downtown Austin Plan districts", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/Zoning_2/MapServer/20", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "coa-zoning", name: "City of Austin Zoning, Density Bonus & Capitol View Corridors", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/Zoning_1/MapServer", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "coa-lots", name: "City of Austin Lot Lines", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/LotLines/MapServer/0", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "coa-sidewalks", name: "City of Austin Sidewalk Network & Curb Ramp inventory (Public Works; presence, A–F condition, width)", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/Transportation_1/MapServer/15", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "tcad", name: "Travis Central Appraisal District parcels (land & improvement values; public owners only), Travis County TNR monthly snapshot", url: "https://services1.arcgis.com/HGcSYZ5bvjRswoCb/arcgis/rest/services/TCAD_Parcels_Dec_2025/FeatureServer", license: "Public record", retrieved: today, kind: "measured" },
    { id: "coa-etod", name: "City of Austin ETOD overlay (LDC 25-2-653)", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/Zoning_2/MapServer/14", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "coa-asmp", name: "Austin Strategic Mobility Plan street network (existing lanes, ROW)", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/Transportation_1/MapServer/7", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "capmetro", name: "Capital Metro routes & stops", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/Transportation_1/MapServer", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "coa-drainage", name: "City of Austin storm drain pipes & inlets", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/DrainageInfrastructure/MapServer", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "fema", name: "FEMA floodplain (via City of Austin)", url: "https://maps.austintexas.gov/arcgis/rest/services/Shared/Floodplain/MapServer/1", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "census", name: "US Census 2020 blocks (POP100, HU100), TIGERweb", url: "https://tigerweb.geo.census.gov/", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "lodes", name: "LEHD LODES 8 workplace jobs (WAC 2023)", url: "https://lehd.ces.census.gov/data/", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "txdot", name: "TxDOT AADT annual counts", url: "https://gis-txdot.opendata.arcgis.com/", license: "Public domain", retrieved: today, kind: "measured" },
    { id: "dem", name: "AWS Terrain Tiles (Terrarium, z15; USGS 3DEP-derived)", url: "https://registry.opendata.aws/terrain-tiles/", license: "Various open", retrieved: today, kind: "measured" },
    { id: "era5", name: `Open-Meteo ERA5 reanalysis, ${weather.hourly.time[0].slice(0, 10)}`, url: "https://open-meteo.com/", license: "CC BY 4.0", retrieved: today, kind: "measured" },
  ],
  weather: {
    date: weather.hourly.time[0].slice(0, 10),
    source: "Open-Meteo archive (ERA5 reanalysis, ~25 km grid — not an urban station)",
    hourly: { t: weather.hourly.temperature_2m, rh: weather.hourly.relative_humidity_2m, sw: weather.hourly.shortwave_radiation, wind: weather.hourly.wind_speed_10m, cloud: weather.hourly.cloud_cover },
  },
  calibration: { householdSize: cfg.householdSize, censusPopulation: census.reduce((s, c) => s + c.pop, 0), censusHousingUnits: census.reduce((s, c) => s + c.hu, 0), lodesJobs: (globalThis as unknown as { __jobs: number }).__jobs ?? 0 },
  initialView: { center: centre, zoom: cfg.initialView.zoom, pitch: cfg.initialView.pitch, bearing: cfg.initialView.bearing },
  grid,
  impervious: { measuredFraction: impMeasured / studyArea },
};

const round1 = (k: string, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v);
const world = {
  buildings, streets, nodes: [...nodes.values()], areas, trees, parcels, stops, routes, paths, pois, places,
};
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 1));
fs.writeFileSync(`${OUT}/world.json`, JSON.stringify(world, round1));
fs.writeFileSync(`${OUT}/utilities.json`, JSON.stringify(utilities, round1));
fs.writeFileSync(`${OUT}/reference.json`, JSON.stringify({ census, counts, fema }, round1));
for (const f of fs.readdirSync(OUT)) log(f, (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2), "MB");
void difference;
