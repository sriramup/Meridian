// The place index: every findable place in a world (streets merged by name, intersections,
// districts and neighbourhoods, parks and landmarks, points of interest, named buildings and
// street addresses, named areas, transit stops, trails, and whatever a design named or placed),
// with a token dictionary for fast, typo-tolerant, as-you-type lookup.
//
// Built once per world and kept current from the world's changesets (World.subscribe), so a
// renamed street or a newly placed building is findable right away without a rebuild.

import { pathBBox, polyLength } from "@/geometry/polyline";
import { fmtLen } from "@/lib/units";
import { pointInPoly, polyArea, polyBBox, polyCentroid } from "@/geometry/polygon";
import type { BBox } from "@/world/spatialIndex";
import type { Entity, Place, Poi, Street, Vec2 } from "@/world/types";
import type { Changeset, World } from "@/world/world";
import { editDistance, tokenSim, typoBudget } from "./fuzzy";
import { abbreviate, isSoft, looksLikeAddress, normKey, queryForms, splitIntersection, titleCase, tokenize, words, type Token } from "./normalize";

export type PlaceKind =
  | "street"
  | "intersection"
  | "district"
  | "neighbourhood"
  | "park"
  | "landmark"
  | "campus"
  | "water"
  | "station"
  | "bridge"
  | "poi"
  | "building"
  | "address"
  | "area"
  | "stop"
  | "trail"
  | "design"
  | "geocoded";

/** a search hit, ready to show and to fly to */
export interface PlaceResult {
  /** stable key (recents, React) */
  key: string;
  kind: PlaceKind;
  /** icon name (see PlaceSearch's ICONS) */
  icon: string;
  label: string;
  /** short secondary line: "Street · 1.2 mi", "School · Hancock" */
  detail: string;
  /** where it is (local metres) */
  point: Vec2;
  /** its extent, for framing (local metres) */
  bbox: BBox;
  /** world entity ids it stands for (highlight, agent) */
  ids: string[];
  score: number;
}

interface Alias {
  toks: Token[];
  /** subtracted from the score (category words: "school" finds schools, below ones named so) */
  penalty?: number;
  /** an address: the house number must be matched */
  addr?: boolean;
  /** shown as the label when this alias is the one that matched */
  label?: string;
}

interface Entry {
  key: string;
  kind: PlaceKind;
  icon: string;
  label: string;
  aliases: Alias[];
  ids: string[];
  point: Vec2;
  bbox: BBox;
  /** ranking bonus: kind and prominence */
  base: number;
  /** what it is, for the secondary line ("School", "Park", "Office") */
  what: string;
  /** a precomputed secondary line (otherwise `what · neighbourhood`) */
  detail?: string;
  /** an address or other fact for the secondary line of a named building */
  extra?: string;
  /** normalised label */
  lk?: string;
  dead?: boolean;
}

interface QTok {
  forms: string[];
  soft: boolean;
  num: boolean;
  last: boolean;
}

const KIND_BASE: Record<PlaceKind, number> = {
  intersection: 0.1,
  street: 0.09,
  district: 0.09,
  neighbourhood: 0.09,
  design: 0.09,
  address: 0.08,
  park: 0.08,
  landmark: 0.075,
  campus: 0.08,
  water: 0.075,
  station: 0.075,
  bridge: 0.07,
  building: 0.055,
  poi: 0.055,
  area: 0.05,
  trail: 0.05,
  stop: -0.1,
  geocoded: 0.04,
};

const POI_WHAT: Record<Poi["category"], [string, string]> = {
  grocery: ["Grocery", "ShoppingBasket"],
  school: ["School", "School"],
  university: ["University", "GraduationCap"],
  health: ["Health care", "Hospital"],
  food: ["Food & drink", "UtensilsCrossed"],
  shop: ["Shop", "ShoppingBag"],
  civic: ["Civic", "Landmark"],
  culture: ["Culture", "Theater"],
  park: ["Park", "Trees"],
  worship: ["Place of worship", "Church"],
  transit: ["Transit", "Bus"],
  landmark: ["Landmark", "Landmark"],
  hotel: ["Hotel", "BedDouble"],
  other: ["Place", "MapPin"],
};

/** words a point of interest is also found by */
const POI_WORDS: Partial<Record<Poi["category"], string>> = {
  grocery: "grocery supermarket market",
  school: "school",
  university: "university college campus",
  health: "hospital clinic health doctor pharmacy",
  food: "restaurant food cafe coffee bar",
  shop: "shop store",
  hotel: "hotel",
  worship: "church worship",
  park: "park",
};

const PLACE_KIND: Record<Place["type"], [PlaceKind, string, string]> = {
  district: ["district", "District", "Map"],
  neighbourhood: ["neighbourhood", "Neighborhood", "Map"],
  landmark: ["landmark", "Landmark", "Landmark"],
  campus: ["campus", "Campus", "GraduationCap"],
  park: ["park", "Park", "Trees"],
  water: ["water", "Water", "Waves"],
  station: ["station", "Station", "TrainFront"],
  bridge: ["bridge", "Bridge", "Bridge"],
};

const AREA_WHAT: Record<string, [string, string]> = {
  park: ["Park", "Trees"],
  plaza: ["Plaza", "LandPlot"],
  water: ["Water", "Waves"],
  grass: ["Lawn", "Trees"],
  wood: ["Woodland", "Trees"],
  parking: ["Parking", "Square"],
  retention: ["Pond", "Waves"],
  raingarden: ["Rain garden", "Trees"],
  permeable: ["Paving", "Square"],
  construction: ["Construction site", "Fence"],
  campus: ["Campus", "GraduationCap"],
  cemetery: ["Cemetery", "Trees"],
  pitch: ["Sports field", "LandPlot"],
};

const USE_WHAT: Record<string, string> = {
  residential: "Residential",
  office: "Office",
  retail: "Retail",
  mixed: "Mixed use",
  hotel: "Hotel",
  civic: "Civic",
  education: "Education",
  religious: "Place of worship",
  health: "Health care",
  industrial: "Industrial",
  parking: "Garage",
  utility: "Utility",
  other: "Building",
};

const STOP_WHAT: Record<string, string> = { bus: "Bus stop", rapid: "Rapid bus stop", rail: "Rail station", tram: "Tram stop", brt: "BRT station" };

/** "450 ft", "1.2 mi" (the app's imperial length format) */
export const fmtLength = (m: number) => fmtLen(m);

/** street segments of one name farther apart than this are separate streets */
const GROUP_GAP = 400;
/** a stray stretch this short beside a longer one of the same name is not offered on its own */
const STUB = 150;
/** intersection nodes closer than this are one intersection (dual carriageways, wide junctions) */
const JUNCTION_CLUSTER = 90;

const bboxGap = (a: BBox, b: BBox) => Math.max(0, a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);
const bboxUnion = (a: BBox, b: BBox): BBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const ptBox = (p: Vec2, r = 1): BBox => [p[0] - r, p[1] - r, p[0] + r, p[1] + r];
const center = (b: BBox): Vec2 => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

export interface IndexOptions {
  /** display name of a library primitive definition (unnamed placed primitives are found by it) */
  libraryName?: (defId: string) => string | undefined;
}

type LineKind = "street" | "trail";

export class PlaceIndex {
  readonly world: World;
  private opts: IndexOptions;
  private entries: Entry[] = [];
  private byKey = new Map<string, number>();
  private postings = new Map<string, number[]>();
  /** tokens that begin a name (very short prefixes only look here) */
  private heads = new Map<string, number[]>();
  private sortedHeads: string[] = [];
  /** entries per normalised label: a place known to several sources is a better-known place */
  private labelCount = new Map<string, number>();
  private addrCache: Map<string, { num: number; p: Vec2; label: string }[]> | null = null;
  private dictDirty = true;
  private sorted: string[] = [];
  private byLen = new Map<number, string[]>();
  private prefixes = new Map<number, Map<string, string[]>>();
  private tokCache = new Map<string, Map<string, number>>();
  /** "street|w 21 st" → ids of the streets with that name */
  private lines = new Map<string, Set<string>>();
  /** street name key → display name and tokens, for intersections */
  private streetNames = new Map<string, { label: string; toks: Token[] }>();
  /** node → the street-name pairs that meet there */
  private nodePairs = new Map<string, string[]>();
  /** "a|b" → nodes where streets a and b meet */
  private pairNodes = new Map<string, Set<string>>();
  private hoodCache = new Map<string, string>();
  private hoods: { name: string; poly?: Place["poly"]; p: Vec2; area: number; rank: number }[] | null = null;
  private dead = 0;
  private unsub: (() => void) | null = null;

  constructor(world: World, opts: IndexOptions = {}) {
    this.world = world;
    this.opts = opts;
    this.build();
    this.unsub = world.subscribe((cs, dir) => this.onChange(cs, dir));
  }

  dispose() {
    this.unsub?.();
    this.unsub = null;
  }

  get size() {
    return this.entries.length - this.dead;
  }

  // ---- building --------------------------------------------------------------------------

  private build() {
    this.entries = [];
    this.byKey.clear();
    this.postings.clear();
    this.heads.clear();
    this.labelCount.clear();
    this.addrCache = null;
    this.lines.clear();
    this.streetNames.clear();
    this.nodePairs.clear();
    this.pairNodes.clear();
    this.hoodCache.clear();
    this.hoods = null;
    this.dead = 0;
    const w = this.world;
    for (const s of w.all("street")) if (s.name) this.lineSet("street", s.name).add(s.id);
    for (const p of w.all("path")) if (p.name) this.lineSet("trail", p.name).add(p.id);
    for (const k of this.lines.keys()) this.rebuildLine(k);
    for (const e of w.entities.values()) this.addEntity(e);
    for (const n of w.byKind.get("node")!) this.updateNode(n);
    this.dictDirty = true;
  }

  private lineKey(kind: LineKind, name: string) {
    return `${kind}|${normKey(name)}`;
  }
  private lineSet(kind: LineKind, name: string) {
    const k = this.lineKey(kind, name);
    let s = this.lines.get(k);
    if (!s) this.lines.set(k, (s = new Set()));
    return s;
  }

  private onChange(cs: Changeset | null, dir: 1 | -1) {
    if (!cs) {
      this.build();
      return;
    }
    const lines = new Set<string>();
    const nodes = new Set<string>();
    const touched = new Map<string, Entity | undefined>();
    const ops = dir === 1 ? cs.ops : [...cs.ops].reverse();
    for (const op of ops) {
      const before = op.type === "add" ? null : op.type === "remove" ? op.entity : op.before;
      const after = op.type === "remove" ? null : op.type === "add" ? op.entity : op.after;
      const [gone, now] = dir === 1 ? [before, after] : [after, before];
      for (const e of [gone, now]) {
        if (!e) continue;
        touched.set(e.id, undefined);
        if (e.kind === "street" || e.kind === "path") {
          const kind: LineKind = e.kind === "street" ? "street" : "trail";
          if (e.name) {
            const k = this.lineKey(kind, e.name);
            lines.add(k);
            if (e === gone) this.lines.get(k)?.delete(e.id);
          }
          if (e.kind === "street") {
            nodes.add(e.from);
            nodes.add(e.to);
          }
        }
        if (e.kind === "node") nodes.add(e.id);
        if (e.kind === "place") this.hoods = null;
      }
      if (now && (now.kind === "street" || now.kind === "path") && now.name) this.lineSet(now.kind === "street" ? "street" : "trail", now.name).add(now.id);
    }
    // the world already holds the result: re-read every touched entity from it
    for (const id of touched.keys()) {
      this.removeKey(id);
      const e = this.world.get(id);
      if (e) this.addEntity(e);
    }
    for (const k of lines) this.rebuildLine(k);
    for (const n of nodes) this.updateNode(n);
    if (this.hoods === null) this.hoodCache.clear();
    if (this.dead > 2000 && this.dead > this.entries.length / 3) this.build();
    this.tokCache.clear();
  }

  private removeKey(key: string) {
    const i = this.byKey.get(key);
    if (i === undefined) return;
    this.entries[i].dead = true;
    const lk = this.entries[i].lk!;
    this.labelCount.set(lk, (this.labelCount.get(lk) ?? 1) - 1);
    if (this.entries[i].kind === "address" || this.entries[i].aliases.some((a) => a.addr)) this.addrCache = null;
    this.byKey.delete(key);
    this.dead++;
  }

  private put(e: Entry) {
    this.removeKey(e.key);
    const i = this.entries.length;
    this.entries.push(e);
    this.byKey.set(e.key, i);
    const lk = (e.lk = normKey(e.label));
    this.labelCount.set(lk, (this.labelCount.get(lk) ?? 0) + 1);
    if (e.aliases.some((a) => a.addr)) this.addrCache = null;
    for (const a of e.aliases) {
      for (const t of a.toks) {
        let p = this.postings.get(t.t);
        if (!p) {
          this.postings.set(t.t, (p = []));
          this.dictDirty = true;
        }
        if (p[p.length - 1] !== i) p.push(i);
      }
      const h = a.addr || a.penalty ? null : a.toks.find((t) => !t.soft);
      if (h) {
        let p = this.heads.get(h.t);
        if (!p) {
          this.heads.set(h.t, (p = []));
          this.dictDirty = true;
        }
        if (p[p.length - 1] !== i) p.push(i);
      }
    }
  }

  /** (re)build the entries for every street / trail of one name: one per separate stretch */
  private rebuildLine(k: string) {
    const kind = k.slice(0, k.indexOf("|")) as LineKind;
    const nameKey = k.slice(k.indexOf("|") + 1);
    for (let j = 0; ; j++) {
      const key = `${k}#${j}`;
      if (!this.byKey.has(key)) break;
      this.removeKey(key);
    }
    const ids = [...(this.lines.get(k) ?? [])].filter((id) => {
      const e = this.world.get(id) as { name?: string } | undefined;
      return !!e?.name && normKey(e.name) === nameKey;
    });
    if (!ids.length) {
      this.lines.delete(k);
      if (kind === "street") this.streetNames.delete(nameKey);
      return;
    }
    const segs = ids.map((id) => {
      const s = this.world.get(id) as Street | Extract<Entity, { kind: "path" }>;
      return { id, name: s.name!, bbox: pathBBox(s.path) as BBox, len: polyLength(s.path) };
    });
    // most common spelling
    const counts = new Map<string, number>();
    for (const s of segs) counts.set(s.name, (counts.get(s.name) ?? 0) + s.len);
    const label = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (kind === "street") this.streetNames.set(nameKey, { label, toks: nameToks(label) });
    // stretches: segments within GROUP_GAP of each other (union-find on bbox gaps)
    const parent = segs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let a = 0; a < segs.length; a++)
      for (let b = a + 1; b < segs.length; b++) if (bboxGap(segs[a].bbox, segs[b].bbox) < GROUP_GAP) parent[find(a)] = find(b);
    const groups = new Map<number, typeof segs>();
    segs.forEach((s, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(s);
    });
    const ordered = [...groups.values()].sort((a, b) => b.reduce((x, s) => x + s.len, 0) - a.reduce((x, s) => x + s.len, 0));
    const toks = nameToks(label);
    const top = ordered[0].reduce((x, s) => x + s.len, 0);
    const several = ordered.filter((g) => g === ordered[0] || g.reduce((x, s) => x + s.len, 0) >= Math.min(STUB, top / 4)).length > 1;
    let j = 0;
    for (const g of ordered) {
      const len = g.reduce((x, s) => x + s.len, 0);
      if (g !== ordered[0] && len < STUB && len < top / 4) continue;
      const bbox = g.slice(1).reduce((b, s) => bboxUnion(b, s.bbox), g[0].bbox);
      // the point nearest the middle of the stretch that is on the street
      const mid = center(bbox);
      let point: Vec2 = mid,
        bestD = Infinity;
      for (const s of g) {
        const e = this.world.get(s.id) as Street;
        for (const p of e.path) {
          const d = (p[0] - mid[0]) ** 2 + (p[1] - mid[1]) ** 2;
          if (d < bestD) {
            bestD = d;
            point = p;
          }
        }
      }
      const designed = g.some((s) => (this.world.get(s.id) as Street).createdBy);
      this.put({
        key: `${k}#${j}`,
        kind: kind === "street" ? "street" : "trail",
        icon: kind === "street" ? "Route" : "Footprints",
        label,
        aliases: [{ toks }],
        ids: g.map((s) => s.id),
        point,
        bbox,
        base: KIND_BASE[kind] + 0.025 * Math.min(1, len / 2500) + (designed && this.world.meta.sandbox ? 0.01 : 0),
        // several stretches of one name: say where each is
        what: `${kind === "street" ? "Street" : "Trail"} · ${fmtLength(len)}`,
        detail: several ? undefined : `${kind === "street" ? "Street" : "Trail"} · ${fmtLength(len)}`,
      });
      j++;
    }
  }

  /** index one entity (streets and paths are indexed by name as stretches instead) */
  private addEntity(e: Entity) {
    switch (e.kind) {
      case "place": {
        const [kind, what, icon] = PLACE_KIND[e.type] ?? ["landmark", "Place", "MapPin"];
        const bbox = e.poly ? polyBBox(e.poly) : ptBox(e.p, 60);
        this.put({ key: e.id, kind, icon, label: e.name, aliases: [{ toks: nameToks(e.name) }], ids: [e.id, ...(e.refs ?? [])], point: e.p, bbox, base: KIND_BASE[kind] + 0.01, what });
        return;
      }
      case "poi": {
        if (!e.name) return;
        const [what, icon] = POI_WHAT[e.category] ?? POI_WHAT.other;
        const cat = POI_WORDS[e.category];
        this.put({ key: e.id, kind: "poi", icon, label: e.name, aliases: cat ? [{ toks: nameToks(e.name) }, { toks: tokenize(cat), penalty: 0.22 }] : [{ toks: nameToks(e.name) }], ids: [e.id], point: e.p, bbox: ptBox(e.p, 25), base: KIND_BASE.poi, what });
        return;
      }
      case "building": {
        const name = e.name ?? this.libName(e);
        if (!name && !e.address) return;
        const point = polyCentroid(e.footprint);
        const bbox = polyBBox(e.footprint);
        const area = Math.abs(polyArea(e.footprint));
        const prominence = 0.02 * Math.min(1, Math.max(0, (Math.log10(Math.max(area, 1)) - 2) / 2));
        const aliases: Alias[] = [];
        if (name) aliases.push({ toks: nameToks(name) });
        const addr = e.address ? titleCase(e.address) : undefined;
        if (addr) aliases.push({ toks: tokenize(addr), addr: true, label: abbreviateAddress(addr) });
        const design = !!e.createdBy && !e.name;
        const kind: PlaceKind = design ? "design" : name ? "building" : "address";
        this.put({
          key: e.id,
          kind,
          icon: kind === "address" ? "House" : design ? "PencilRuler" : "Building2",
          label: name ?? abbreviateAddress(addr!),
          aliases,
          ids: [e.id],
          point,
          bbox,
          base: KIND_BASE[kind] + prominence,
          what: kind === "address" ? "Address" : design ? "Placed" : USE_WHAT[e.use] ?? "Building",
          extra: name && addr ? abbreviateAddress(addr) : undefined,
        });
        return;
      }
      case "area": {
        const name = e.name ?? this.libName(e);
        if (!name) return;
        const [what, icon] = AREA_WHAT[e.type] ?? ["Area", "Square"];
        const design = !!e.createdBy && !e.name;
        this.put({ key: e.id, kind: design ? "design" : "area", icon: design ? "PencilRuler" : icon, label: name, aliases: [{ toks: nameToks(name) }], ids: [e.id], point: polyCentroid(e.poly), bbox: polyBBox(e.poly), base: KIND_BASE[design ? "design" : "area"], what: design ? "Placed" : what });
        return;
      }
      case "prop": {
        const name = e.name ?? this.libName(e);
        if (!name) return;
        const r = Math.max(4, e.height);
        this.put({ key: e.id, kind: "design", icon: "PencilRuler", label: name, aliases: [{ toks: nameToks(name) }], ids: [e.id], point: e.p, bbox: e.footprint ? polyBBox(e.footprint) : ptBox(e.p, r), base: KIND_BASE.design - (e.name ? 0 : 0.03), what: e.name ? "Placed" : "Placed" });
        return;
      }
      case "stop": {
        const label = titleCase(e.name).replace(/^\d+\s+/, "");
        this.put({ key: e.id, kind: "stop", icon: e.mode === "rail" || e.mode === "tram" ? "TrainFront" : "Bus", label, aliases: [{ toks: nameToks(label) }], ids: [e.id], point: e.p, bbox: ptBox(e.p, 20), base: KIND_BASE.stop, what: STOP_WHAT[e.mode] ?? "Stop" });
        return;
      }
    }
  }

  /** an unnamed placed library primitive is found by its definition's name (main entity only) */
  private libName(e: Entity): string | undefined {
    const lib = (e as { lib?: { def: string; primary?: boolean } }).lib;
    if (!lib?.primary) return undefined;
    return this.opts.libraryName?.(lib.def);
  }

  private updateNode(nodeId: string) {
    for (const pk of this.nodePairs.get(nodeId) ?? []) {
      const s = this.pairNodes.get(pk);
      s?.delete(nodeId);
      if (s && !s.size) this.pairNodes.delete(pk);
    }
    this.nodePairs.delete(nodeId);
    if (!this.world.get(nodeId)) return;
    const names = [...new Set(this.world.incident(nodeId).flatMap((s) => (s.name ? [normKey(s.name)] : [])))].sort();
    if (names.length < 2) return;
    const pairs: string[] = [];
    for (let a = 0; a < names.length; a++)
      for (let b = a + 1; b < names.length; b++) {
        const pk = `${names[a]}|${names[b]}`;
        pairs.push(pk);
        let s = this.pairNodes.get(pk);
        if (!s) this.pairNodes.set(pk, (s = new Set()));
        s.add(nodeId);
      }
    this.nodePairs.set(nodeId, pairs);
  }

  // ---- dictionary --------------------------------------------------------------------------

  private refreshDict() {
    if (!this.dictDirty) return;
    this.sorted = [...this.postings.keys()].sort();
    this.sortedHeads = [...this.heads.keys()].sort();
    this.byLen.clear();
    for (const t of this.sorted) {
      let b = this.byLen.get(t.length);
      if (!b) this.byLen.set(t.length, (b = []));
      b.push(t);
    }
    this.prefixes.clear();
    this.tokCache.clear();
    this.dictDirty = false;
  }

  /** dictionary tokens a query word matches, with their similarity (very short words: name starts only) */
  private matchTok(q: QTok): Map<string, number> {
    const ck = `${q.forms.join(",")}|${q.last ? 1 : 0}`;
    const hit = this.tokCache.get(ck);
    if (hit) return hit;
    const out = new Map<string, number>();
    const add = (t: string, s: number) => {
      if (s > (out.get(t) ?? 0)) out.set(t, s);
    };
    for (const f of q.forms) {
      if (this.postings.has(f)) add(f, 1);
      // prefixes (as you type, or a long word cut short)
      if (q.last || (!q.num && f.length >= 4)) {
        const dict = f.length <= 3 ? this.sortedHeads : this.sorted;
        let lo = 0,
          hi = dict.length;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (dict[m] < f) lo = m + 1;
          else hi = m;
        }
        for (let i = lo; i < dict.length && dict[i].startsWith(f); i++) add(dict[i], tokenSim(f, dict[i], q.last, q.num));
      }
      if (q.num) continue;
      const k = typoBudget(f.length);
      if (!k) continue;
      for (let L = f.length - k; L <= f.length + k; L++) for (const t of this.byLen.get(L) ?? []) if (t[0] === f[0] || t[1] === f[1] || t[0] === f[1]) add(t, tokenSim(f, t, q.last, false));
      // a typo in the part typed so far: compare with the first letters of every longer token
      if (q.last) {
        let pm = this.prefixes.get(f.length);
        if (!pm) {
          pm = new Map();
          for (const t of this.sorted)
            if (t.length > f.length) {
              const p = t.slice(0, f.length);
              const l = pm.get(p);
              if (l) l.push(t);
              else pm.set(p, [t]);
            }
          this.prefixes.set(f.length, pm);
        }
        for (const [p, ts] of pm) if (p !== f && (p[0] === f[0] || p[1] === f[1]) && editDistance(f, p, k) <= k) for (const t of ts) add(t, tokenSim(f, t, true, false));
      }
    }
    for (const [t, s] of out) if (s <= 0) out.delete(t);
    if (this.tokCache.size > 400) this.tokCache.clear();
    this.tokCache.set(ck, out);
    return out;
  }

  // ---- querying ------------------------------------------------------------------------------

  /** best places for a query, ranked (intersections included); `limit` defaults to 5 */
  search(query: string, limit = 5): PlaceResult[] {
    const q = query.trim();
    if (!q) return [];
    this.refreshDict();
    const qt = queryTokens(query);
    const out: PlaceResult[] = [];
    const hits: { e: Entry; score: number; alias?: string }[] = [];
    if (qt.length) {
      const hard = qt.filter((t) => !t.soft);
      const lists = hard.map((t) => ({ q: t, m: this.matchTok(t) }));
      // candidates: entries matching every required word (smallest list first)
      let cand: Set<number> | null = null;
      const order = lists.map((l) => ({ ...l, n: [...l.m.keys()].reduce((x, t) => x + (this.postings.get(t)?.length ?? 0), 0) })).sort((a, b) => a.n - b.n);
      for (const { q: w, m } of order) {
        const s = new Set<number>();
        // a short prefix being typed: only names that start with it
        const short = w.last && w.forms.every((f) => f.length <= 3);
        for (const t of m.keys()) {
          const list = short && !w.forms.includes(t) ? (this.heads.get(t) ?? []) : (this.postings.get(t) ?? []);
          for (const i of list) if (!cand || cand.has(i)) s.add(i);
        }
        cand = s;
        if (!s.size) break;
      }
      for (const i of cand ?? []) {
        const e = this.entries[i];
        if (e.dead) continue;
        let best = -1,
          alias: Alias | null = null;
        for (const a of e.aliases) {
          const s = scoreAlias(qt, a);
          if (s > best) {
            best = s;
            alias = a;
          }
        }
        if (best < 0.55) continue;
        const known = Math.min(3, (this.labelCount.get(e.lk!) ?? 1) - 1) * 0.025;
        hits.push({ e, score: best + e.base + known, alias: alias?.label });
      }
      // secondary lines only for the few that can be shown
      hits.sort((a, b) => b.score - a.score);
      for (const h of hits.slice(0, limit * 6)) out.push(this.result(h.e, h.score, h.alias));
      if (looksLikeAddress(q) && !out.some((r) => r.kind === "address" || /^\d/.test(r.label))) {
        const est = this.estimateAddress(q);
        if (est) out.push(est);
      }
    }
    out.push(...this.intersections(q));
    out.sort((a, b) => b.score - a.score);
    return dedupe(out).slice(0, limit);
  }

  /**
   * An address that is not in the data, placed between the nearest known numbers on the same
   * street ("1100 Congress" between 1001 and 1201 Congress Avenue). Null when the street has no
   * known numbers or the number is far outside them.
   */
  estimateAddress(q: string): PlaceResult | null {
    const w = words(q);
    const num = parseInt(w[0], 10);
    if (!Number.isFinite(num)) return null;
    const street = w.slice(1).join(" ");
    if (!this.addrCache) {
      this.addrCache = new Map();
      for (const e of this.entries) {
        if (e.dead) continue;
        const a = e.aliases.find((x) => x.addr);
        if (!a?.label) continue;
        const m = /^(\d+)[a-z]?\s+(.+)$/i.exec(a.label);
        if (!m) continue;
        const key = normKey(m[2]);
        let l = this.addrCache.get(key);
        if (!l) this.addrCache.set(key, (l = []));
        l.push({ num: parseInt(m[1], 10), p: e.point, label: m[2] });
      }
    }
    const matches = this.streetMatches(street);
    let best: PlaceResult | null = null;
    for (const sm of matches) {
      const list = this.addrCache.get(sm.key);
      if (!list?.length) continue;
      // same side of the street (parity) when there is one
      const side = list.filter((a) => a.num % 2 === num % 2);
      const use = side.length >= 2 ? side : list;
      let lo: (typeof use)[number] | null = null,
        hi: (typeof use)[number] | null = null;
      for (const a of use) {
        if (a.num <= num && (!lo || a.num > lo.num)) lo = a;
        if (a.num >= num && (!hi || a.num < hi.num)) hi = a;
      }
      let p: Vec2;
      if (lo && hi && hi.num !== lo.num) {
        const t = (num - lo.num) / (hi.num - lo.num);
        p = [lo.p[0] + (hi.p[0] - lo.p[0]) * t, lo.p[1] + (hi.p[1] - lo.p[1]) * t];
      } else if (lo && (hi || num - lo.num <= 200)) p = lo.p;
      else if (hi && hi.num - num <= 200) p = hi.p;
      else continue;
      const exact = (lo?.num === num ? lo : hi?.num === num ? hi : null) !== null;
      const label = `${num} ${abbreviate(sm.label)}`;
      const hood = this.hoodOf(`a:${label}`, p);
      const r: PlaceResult = {
        key: `addr:${normKey(label)}`,
        kind: "address",
        icon: "House",
        label,
        detail: exact ? (hood ? `Address · ${hood}` : "Address") : hood ? `Approximate address · ${hood}` : "Approximate address",
        point: p,
        bbox: ptBox(p, 30),
        ids: [],
        score: sm.score + KIND_BASE.address - 0.02,
      };
      if (!best || r.score > best.score) best = r;
    }
    return best;
  }

  private result(e: Entry, score: number, aliasLabel?: string): PlaceResult {
    let label = e.label,
      detail = e.detail;
    if (!detail) {
      const hood = this.hoodOf(e.key, e.point);
      if (aliasLabel && aliasLabel !== e.label) {
        // matched by address: show the address, with the building's name below
        label = aliasLabel;
        detail = e.label;
      } else if (e.extra) detail = `${e.what} · ${e.extra}`;
      else detail = hood && e.kind !== "district" && e.kind !== "neighbourhood" && hood !== e.label ? `${e.what} · ${hood}` : e.what;
    }
    return { key: e.key, kind: e.kind, icon: e.icon, label, detail, point: e.point, bbox: e.bbox, ids: e.ids, score };
  }

  /** street names matching one side of an intersection query, best first */
  private streetMatches(part: string): { key: string; label: string; score: number }[] {
    const qt = queryTokens(part);
    if (!qt.some((t) => !t.soft)) return [];
    const hits: { key: string; label: string; score: number }[] = [];
    for (const [key, v] of this.streetNames) {
      const s = scoreAlias(qt, { toks: v.toks });
      if (s >= 0.6) hits.push({ key, label: v.label, score: s });
    }
    hits.sort((a, b) => b.score - a.score);
    const best = hits[0]?.score ?? 0;
    return hits.filter((h) => h.score >= best - 0.12).slice(0, 8);
  }

  /** where streets matching `a` meet streets matching `b` (one result per distinct junction) */
  intersectionsOf(a: string, b: string, penalty = 0): PlaceResult[] {
    const A = this.streetMatches(a);
    if (!A.length) return [];
    const B = this.streetMatches(b);
    const out: PlaceResult[] = [];
    for (const x of A)
      for (const y of B) {
        if (x.key === y.key) continue;
        const nodes = this.pairNodes.get(x.key < y.key ? `${x.key}|${y.key}` : `${y.key}|${x.key}`);
        if (!nodes) continue;
        // cluster the nodes into separate junctions
        const pts = [...nodes].map((id) => ({ id, p: (this.world.get(id) as Extract<Entity, { kind: "node" }>).p }));
        const clusters: { ids: string[]; ps: Vec2[] }[] = [];
        for (const n of pts) {
          const c = clusters.find((c) => c.ps.some((p) => Math.hypot(p[0] - n.p[0], p[1] - n.p[1]) < JUNCTION_CLUSTER));
          if (c) {
            c.ids.push(n.id);
            c.ps.push(n.p);
          } else clusters.push({ ids: [n.id], ps: [n.p] });
        }
        for (const c of clusters) {
          const p: Vec2 = [c.ps.reduce((s, q) => s + q[0], 0) / c.ps.length, c.ps.reduce((s, q) => s + q[1], 0) / c.ps.length];
          const hood = this.hoodOf(`x:${c.ids[0]}`, p);
          out.push({
            key: `x:${[x.key, y.key].sort().join("|")}:${c.ids.sort()[0]}`,
            kind: "intersection",
            icon: "Signpost",
            label: `${abbreviate(x.label)} & ${abbreviate(y.label)}`,
            detail: hood ? `Intersection · ${hood}` : "Intersection",
            point: p,
            bbox: ptBox(p, 40),
            ids: c.ids,
            score: (x.score + y.score) / 2 + KIND_BASE.intersection - penalty,
          });
        }
      }
    return out;
  }

  private intersections(q: string): PlaceResult[] {
    const parts = splitIntersection(q);
    if (parts) return parts[1] ? this.intersectionsOf(parts[0], parts[1]) : [];
    // "21st guadalupe": try each split of the words
    const w = words(q);
    if (w.length < 2 || w.length > 6) return [];
    const out: PlaceResult[] = [];
    for (let i = 1; i < w.length; i++) out.push(...this.intersectionsOf(w.slice(0, i).join(" "), w.slice(i).join(" "), 0.08));
    return out;
  }

  // ---- neighbourhoods -------------------------------------------------------------------------

  /** the neighbourhood (or district) a point is in, for secondary lines */
  hoodOf(key: string, p: Vec2): string {
    const c = this.hoodCache.get(key);
    if (c !== undefined) return c;
    if (!this.hoods)
      this.hoods = this.world
        .all("place")
        .filter((x) => x.type === "neighbourhood" || x.type === "district")
        .map((x) => ({ name: x.name, poly: x.poly, p: x.p, area: x.poly ? Math.abs(polyArea(x.poly)) : 0, rank: x.type === "neighbourhood" ? 0 : 1 }));
    let best: string | null = null,
      bestK = Infinity;
    for (const h of this.hoods) {
      let k: number;
      if (h.poly) {
        if (!pointInPoly(p, h.poly)) continue;
        k = h.rank * 1e9 + h.area;
      } else {
        const d = Math.hypot(h.p[0] - p[0], h.p[1] - p[1]);
        if (d > 450) continue;
        // a named neighbourhood centre nearby beats a large polygon
        k = h.rank * 1e9 + d * d * 2;
      }
      if (k < bestK) {
        bestK = k;
        best = h.name;
      }
    }
    const name = best ?? "";
    this.hoodCache.set(key, name);
    return name;
  }

  /** every street-name pair key (tests, debugging) */
  pairCount() {
    return this.pairNodes.size;
  }
}

/** query words → tokens with the forms each may stand for (the last word may be half typed) */
export function queryTokens(q: string): QTok[] {
  const w = words(q);
  const typing = /[a-z0-9]$/i.test(q);
  const out = w.map((raw, i) => {
    // "21st" (or "twenty-first") is a whole word even while it is the last one
    const last = i === w.length - 1 && typing && !/^\d+(st|nd|rd|th)$/.test(raw) && !(/^\d+$/.test(raw) && !/\d$/.test(q));
    const forms = queryForms(raw, last);
    return { forms, soft: forms.every(isSoft), num: /^\d+$/.test(forms[0]), last };
  });
  // nothing but directions and types ("east avenue"): they are the name
  if (out.length && out.every((t) => t.soft)) for (const t of out) t.soft = false;
  return out;
}

/** a name's tokens; a name of only directions and types ("East Avenue", "Parkway") needs them all */
export function nameToks(name: string): Token[] {
  const t = tokenize(name);
  return t.length && t.every((x) => x.soft) ? t.map((x) => ({ ...x, soft: false })) : t;
}

/** how well a query matches a name (0..~1; −1 when a required word is missing) */
export function matchScore(query: string, name: string): number {
  return scoreAlias(queryTokens(query), { toks: nameToks(name) });
}

/** how well query tokens match one alias (−1: a required word is missing) */
export function scoreAlias(q: QTok[], a: Alias): number {
  const toks = a.toks;
  if (!toks.length) return -1;
  const used = new Uint8Array(toks.length);
  let sum = 0,
    wsum = 0,
    first = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const t = q[qi];
    let best = 0,
      bj = -1;
    for (let j = 0; j < toks.length; j++) {
      if (used[j]) continue;
      let s = 0;
      for (const f of t.forms) {
        const v = tokenSim(f, toks[j].t, t.last, t.num);
        if (v > s) s = v;
      }
      // a direction or type matches only its own kind (keeps "e" from eating "elm")
      if (t.soft && !toks[j].soft && s < 1) s = 0;
      if (s > best) {
        best = s;
        bj = j;
      }
    }
    const weight = t.soft ? 0.3 : 1;
    wsum += weight;
    if (bj < 0) {
      if (!t.soft) return -1;
      continue;
    }
    used[bj] = 1;
    sum += best * weight;
    if (qi === 0) first = bj;
  }
  if (a.addr) {
    // an address needs its house number and a word of its street
    const hn = toks.findIndex((t) => t.num);
    if (hn >= 0 && !used[hn]) return -1;
    if (!toks.some((t, j) => j !== hn && !t.soft && used[j])) return -1;
  }
  // a direction asked for that the name has otherwise ("101 e 21st" is not 101 W 21st)
  let clash = 0;
  for (const t of q) if (t.soft && /^[nsew]{1,2}$/.test(t.forms[0]) && !toks.some((x) => x.t === t.forms[0]) && toks.some((x) => /^[nsew]{1,2}$/.test(x.t))) clash++;
  let hardN = 0,
    hardHit = 0,
    dirMiss = 0;
  for (let j = 0; j < toks.length; j++)
    if (!toks[j].soft) {
      hardN++;
      if (used[j]) hardHit++;
    } else if (!used[j] && toks[j].t.length <= 2 && /^[nsew]{1,2}$/.test(toks[j].t)) dirMiss++;
  const cov = hardN ? hardHit / hardN : 1;
  const firstHard = toks.findIndex((t) => !t.soft);
  const orderBonus = first >= 0 && (first === firstHard || first === 0) ? 0.03 : 0;
  return (wsum ? sum / wsum : 0) * (0.8 + 0.2 * cov) + orderBonus - 0.015 * dirMiss - 0.2 * clash - (a.penalty ?? 0);
}

/** "1100 Congress Avenue" → "1100 Congress Ave" */
function abbreviateAddress(a: string): string {
  const m = /^(\S+)\s+(.*)$/.exec(a);
  return m ? `${m[1]} ${abbreviate(m[2])}` : a;
}

const inBox = (p: Vec2, b: BBox, pad: number) => p[0] >= b[0] - pad && p[0] <= b[2] + pad && p[1] >= b[1] - pad && p[1] <= b[3] + pad;

/**
 * One result per place: the same name nearby is the same place (a park as place, area and point
 * of interest; a street and a landmark named after it), and a transit stop at a junction or place
 * already offered adds nothing.
 */
function dedupe(rs: PlaceResult[]): PlaceResult[] {
  const out: PlaceResult[] = [];
  for (const r of rs) {
    const k = normKey(r.label);
    const near = out.find((o) => {
      if (o.key === r.key) return true;
      const d = Math.hypot(o.point[0] - r.point[0], o.point[1] - r.point[1]);
      if (normKey(o.label) === k && (d < 300 || inBox(r.point, o.bbox, 100) || inBox(o.point, r.bbox, 100))) return true;
      if (r.kind === "stop" && d < 120) return true;
      // the same junction found two ways
      return o.kind === "intersection" && r.kind === "intersection" && d < JUNCTION_CLUSTER;
    });
    if (!near) out.push(r);
    else if (near.kind !== r.kind && r.kind !== "poi" && r.kind !== "stop" && r.kind !== "address" && r.bbox[2] - r.bbox[0] > near.bbox[2] - near.bbox[0] && inBox(near.point, r.bbox, 50)) {
      // keep the better-ranked entry, framed by the larger outline (a park's polygon)
      near.bbox = r.bbox;
    }
  }
  return out;
}
