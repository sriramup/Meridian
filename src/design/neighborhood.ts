// designNeighborhood: the whole pipeline in one operation (one changeset, one undo step).
//
//   brief → street grid (hierarchy) → civic superblocks (schools, campus, parks) → streets built →
//   blocks → reserved frontage (fire, police, restaurants, plaza, pocket parks for ¼-mi park access)
//   → intensity solved so the fabric meets the homes target → lots and buildings from the library →
//   courtyards, gardens, parking structures → civic site plans → parks → street trees.

import { difference, distToPoly, insetPoly, isValidPoly, normalizePoly, pointInPoly, polyArea, polyBBox, polyCentroid } from "@/geometry/polygon";
import { dist } from "@/geometry/vec";
import { ensureLibrary } from "@/library";
import { fmtAcres, fmtNum, toAcres } from "@/lib/units";
import type { Area, Building, Polygon, Street, StreetNode, Tree, Vec2 } from "@/world/types";
import { newId, type World } from "@/world/world";
import type { Actor } from "@/world/ops/buildings";
import { OpBuilder, programmeOf, type OpResult } from "@/world/ops/core";
import { streetTreeCandidates } from "@/world/ops/landscape";
import { placePrimitive } from "@/world/ops/library";
import { streetBand } from "@/world/ops/validate";
import { LOT_FACILITIES, cellsBounds, facilityPlacement, planCivicCells, reserveFacility, reserveOpenSpace, type CivicSite } from "./civic";
import { INTENSITY_RANGE, analyseBlock, lotPlacement, planFabric, roleOfClass, streetRefs, type Block, type FabricOptions, type FabricPlan, type Reservation } from "./fabric";
import { SCHOOL_NORMS, resolveProgramme, type DensityClass, type NeighborhoodSpec, type PaletteName } from "./programme";
import { type GridPlan, type StreetRole, buildStreetGrid, cellRect, planStreetGrid, toWorldG } from "./streets";
import { clip, efPt, makeRng, minWidth, minus, type Rng } from "./util";

const SOURCE = "Meridian design";
const RESTAURANT_NAMES = ["Juniper Kitchen", "Olive & Ash", "The Pecan Table", "Casa Verde", "Saffron House", "Blue Heron Grill", "Copper Fig", "Little Lantern"];
const CAFE_NAMES = ["Morning Field Coffee", "Hearth & Bean", "Corner Press"];

/** street-tree species by role: one species per street keeps each street coherent */
const TREE_SPECIES: Record<StreetRole, string[]> = { boulevard: ["live_oak"], avenue: ["live_oak", "bur_oak"], main: ["cedar_elm"], collector: ["cedar_elm", "bur_oak"], local: ["cedar_elm", "bur_oak", "live_oak", "redbud", "desert_willow"] };

function classifyDensity(netPerHa: number): DensityClass {
  return netPerHa < 40 ? "low" : netPerHa < 130 ? "medium" : netPerHa < 300 ? "high" : "very_high";
}

export function designNeighborhood(world: World, spec: NeighborhoodSpec, actor: Actor): OpResult {
  ensureLibrary();
  const b = new OpBuilder(world, actor.author);
  const seed = Math.floor(spec.seed ?? 1);
  const rng = makeRng(seed);
  const area = normalizePoly(spec.area);
  if (!isValidPoly(area) || polyArea(area) < 20000) return b.fail("The area is too small for a neighbourhood (needs at least 5 acres)");
  const hh = world.meta.calibration?.householdSize ?? 2.5;
  const areaM2 = polyArea(area);
  const homesReq = spec.homes ?? (spec.population ? spec.population / hh : undefined);
  const density0: DensityClass = spec.density ?? (homesReq ? classifyDensity(homesReq / ((areaM2 * 0.5) / 1e4)) : "high");
  const palette: PaletteName = spec.palette ?? rng.pick(["masonry", "texas", "modern", "masonry", "texas"] as PaletteName[]);

  // ---- 1. plan the grid and the civic superblocks
  const grid = planStreetGrid(world, area, { density: density0, seed, blockLength: spec.streets?.blockLength, blockDepth: spec.streets?.blockDepth, arterials: spec.streets?.arterials, centre: spec.centre });
  const progPre = resolveProgramme({ ...spec, density: density0 }, areaM2 * 0.62, hh);
  const cells = grid.cells.flat();
  const meanCell = cells.reduce((s, c) => s + Math.max(0, c.x1 - c.x0 - 18) * Math.max(0, c.y1 - c.y0 - 18), 0) / Math.max(1, cells.length);
  const parkCells = Math.max(1, Math.round((progPre.openSpace * areaM2 * 0.62 * 0.5) / Math.max(1, meanCell)));
  const civic = planCivicCells(grid, progPre, rng.fork(1), parkCells);

  // ---- 2. existing buildings
  const bb = polyBBox(area);
  const standing: Building[] = [];
  let demolished = 0;
  for (const e of world.query(bb, ["building"])) {
    const bld = b.get<Building>(e.id);
    if (!bld || !pointInPoly(polyCentroid(bld.footprint), area)) continue;
    if (spec.replaceExisting && !bld.historic) {
      b.remove(bld.id);
      demolished++;
    } else standing.push(bld);
  }

  // ---- 3. streets
  const built = spec.streets?.build === false ? { ids: [], roleOf: new Map<string, StreetRole>() } : buildStreetGrid(world, grid, area, density0, actor, b);
  const streets = streetsNear(world, b, [bb[0] - 40, bb[1] - 40, bb[2] + 40, bb[3] + 40]);
  const roleOf = (s: Street): StreetRole => built.roleOf.get(s.name ?? "") ?? roleOfClass(s.cls);
  const refs = streetRefs(streets, roleOf);
  const bands = streets.map(streetBand);
  const keepOut = standing.map((s) => s.footprint);

  // ---- 4. blocks
  const blockPieces = (poly: Polygon) => clip(area, poly, 50).flatMap((q) => minus(q, [...bands, ...keepOut], 60));
  const fabric: Block[] = [];
  const civicPolys = new Map<CivicSite, Polygon[]>();
  for (const site of civic) {
    if (site.keepStreets) civicPolys.set(site, site.cells.flatMap((c) => blockPieces(cellRect(grid, c)).sort((p, q) => polyArea(q) - polyArea(p)).slice(0, 1)));
    else civicPolys.set(site, blockPieces(cellRect(grid, cellsBounds(site.cells))).sort((p, q) => polyArea(q) - polyArea(p)).slice(0, 1));
  }
  for (const c of cells) {
    if (c.group) continue;
    blockPieces(cellRect(grid, c)).forEach((q, k) => {
      if (polyArea(q) < 250) return;
      fabric.push(analyseBlock(`${c.i}_${c.j}_${k}`, q, refs));
    });
  }
  if (!fabric.length && !civic.length) return b.fail("No buildable blocks inside the area");
  const blockLand = fabric.reduce((s, x) => s + x.area, 0) + [...civicPolys.values()].flat().reduce((s, q) => s + polyArea(q), 0);
  const prog = resolveProgramme({ ...spec, density: density0 }, blockLand, hh);
  const R = Math.hypot(grid.L, grid.W) / 2;
  const centre = grid.centre;

  // ---- 5. reserved frontage
  const res: Reservation[] = [];
  const parkPolys: Polygon[] = civic.filter((s) => s.kind === "park").flatMap((s) => civicPolys.get(s) ?? []);
  const lotFacilities: { r: Reservation; kind: string; name?: string }[] = [];
  const reserve = (kind: keyof typeof LOT_FACILITIES, near: Vec2, apart: Vec2[], name?: string) => {
    const lf = LOT_FACILITIES[kind];
    if (!lf) return null;
    const r = reserveFacility(fabric, res, lf, near, apart, R, rng.fork(res.length + 7));
    if (r) {
      res.push(r);
      lotFacilities.push({ r, kind, name });
    }
    return r;
  };
  // plaza at the main street crossing nearest the centre
  const mainBlocks = fabric.filter((x) => x.edges.some((e) => e.role === "main")).sort((p, q) => dist(p.centroid, centre) - dist(q.centroid, centre));
  let plaza: Reservation | null = null;
  if (prog.density !== "low" && mainBlocks.length) {
    plaza = reserveOpenSpace(mainBlocks[0], res, "plaza", 42, Math.min(34, mainBlocks[0].edges[0].across / 2), ["main", "collector"]);
    if (plaza) {
      res.push(plaza);
      parkPolys.push(plaza.poly);
    }
  }
  const req = prog.facilities;
  const fireAt: Vec2[] = [];
  for (const f of req.filter((x) => x.kind === "fire")) {
    const r = reserve("fire", centre, fireAt, f.name ?? "Fire Station");
    if (r) fireAt.push(polyCentroid(r.poly));
  }
  for (const f of req.filter((x) => x.kind === "police")) reserve("police", centre, [...fireAt, ...lotFacilities.filter((l) => l.kind === "police").map((l) => polyCentroid(l.r.poly))], f.name ?? "Police Station");
  // restaurants: the first half standalone with patios facing the plaza / park, the rest at grade in mixed-use buildings
  const nRest = req.filter((x) => x.kind === "restaurant").length;
  const hub = plaza ? polyCentroid(plaza.poly) : parkPolys[0] ? polyCentroid(parkPolys[0]) : centre;
  const restNames = [...RESTAURANT_NAMES].sort(() => rng.next() - 0.5);
  const groundFloor: { kind: "restaurant" | "cafe"; name: string }[] = [];
  for (let k = 0; k < nRest; k++) {
    const name = req.filter((x) => x.kind === "restaurant")[k]?.name ?? restNames[k % restNames.length];
    // each restaurant is its own small building with a patio (exact counts); at grade in a mixed-use building only if no frontage is left
    if (!reserve("restaurant", hub, lotFacilities.filter((l) => l.kind === "restaurant").map((l) => polyCentroid(l.r.poly)), name)) groundFloor.push({ kind: "restaurant", name });
  }
  for (const f of req.filter((x) => x.kind === "cafe")) {
    if (prog.density === "low") reserve("cafe", hub, [], f.name ?? CAFE_NAMES[0]);
    else groundFloor.push({ kind: "cafe", name: f.name ?? rng.pick(CAFE_NAMES) });
  }
  for (const kind of ["library", "clinic", "community_center", "daycare", "grocery", "hotel"] as const) for (const f of req.filter((x) => x.kind === kind)) reserve(kind, kind === "hotel" ? centre : hub, [], f.name);
  // pocket parks: every block within ¼ mi (400 m) of public open space, then top up to the open-space share
  const covered = (p: Vec2) => parkPolys.some((q) => distToPoly(p, q) <= 400 * 0.85);
  for (let iter = 0; iter < 12; iter++) {
    const unc = fabric.filter((x) => !covered(x.centroid));
    if (!unc.length) break;
    const pick = unc.map((x) => ({ x, n: unc.filter((y) => dist(y.centroid, x.centroid) < 400).length })).sort((p, q) => q.n - p.n)[0].x;
    const r = reserveOpenSpace(pick, res, "pocket_park", 36, Math.min(40, pick.edges[0]?.across ?? 40), ["local", "collector", "main"]);
    if (!r) break;
    res.push(r);
    parkPolys.push(r.poly);
  }
  const openTarget = prog.openSpace * blockLand;
  for (let iter = 0; iter < 10 && parkPolys.reduce((s, q) => s + polyArea(q), 0) < openTarget * 0.85; iter++) {
    const far = fabric.slice().sort((p, q) => minParkDist(q.centroid, parkPolys) - minParkDist(p.centroid, parkPolys))[0];
    const r = far ? reserveOpenSpace(far, res, "pocket_park", 40, Math.min(44, far.edges[0]?.across ?? 44), ["local", "collector", "main"]) : null;
    if (!r) break;
    res.push(r);
    parkPolys.push(r.poly);
  }

  // ---- 6. solve the intensity that meets the homes target
  const civicJobs = civic.reduce((s, c) => s + (c.kind === "university" ? (c.enrolment ?? 6000) / 8 : c.kind.endsWith("school") ? 60 : 0), 0) + lotFacilities.length * 25;
  const base: Omit<FabricOptions, "intensity"> = { prog, centre, radius: R * 0.85, seed, palette, parks: parkPolys, reservations: res, officeJobs: Math.max(0, (prog.jobs - civicJobs) * 0.7) };
  const [lo0, hi0] = INTENSITY_RANGE[prog.density];
  let lo = lo0,
    hi = hi0;
  let plan: FabricPlan = planFabric(fabric, { ...base, intensity: hi });
  if (plan.homes >= prog.homes) {
    for (let it = 0; it < 7; it++) {
      const mid = (lo + hi) / 2;
      const p = planFabric(fabric, { ...base, intensity: mid });
      if (p.homes >= prog.homes) {
        hi = mid;
        plan = p;
      } else lo = mid;
    }
  } else b.warn(`The fabric reaches about ${fmtNum(plan.homes)} homes of the ${fmtNum(prog.homes)} asked for under the ${prog.maxFloors}-floor cap`);
  const intensity = hi;

  // school seats sized to the homes the fabric holds (pupil yields per home, urban mixed housing:
  // ≈ 0.16 K–5, 0.08 grades 6–8, 0.10 grades 9–12); shortfalls and catchment gaps are reported
  const advisories: string[] = [];
  const schools: { name: string; kind: string; enrolment: number; demand: number }[] = [];
  for (const [kind, rate, label] of [["primary_school", 0.16, "Primary"], ["middle_school", 0.08, "Middle"], ["high_school", 0.1, "High"]] as const) {
    const sites = civic.filter((c) => c.kind === kind);
    if (!sites.length) continue;
    const demand = plan.homes * rate;
    const norm = SCHOOL_NORMS[kind].enrolment;
    for (const st of sites) if (!st.enrolment) st.enrolment = Math.round(Math.max(norm * 0.6, Math.min(norm * 1.5, demand / sites.length)) / 10) * 10;
    const seats = sites.reduce((t, st) => t + (st.enrolment ?? norm), 0);
    for (const st of sites) schools.push({ name: st.name, kind, enrolment: st.enrolment ?? norm, demand: Math.round(demand / sites.length) });
    if (demand > seats * 1.1) advisories.push(`${label} school demand ≈ ${fmtNum(demand)} pupils for ${fmtNum(seats)} seats: add ${Math.ceil((demand - seats) / norm)} more ${label.toLowerCase()} school${Math.ceil((demand - seats) / norm) > 1 ? "s" : ""}`);
    if (kind === "primary_school") {
      const at = sites.map((st) => cellCentre(grid, st.cells));
      let near = 0,
        all = 0;
      for (const l of plan.lots) {
        const c = polyCentroid(l.poly);
        all += l.homes;
        if (at.some((p) => dist(p, c) * 1.2 <= 805)) near += l.homes;
      }
      const share = all ? near / all : 1;
      if (share < 0.85) advisories.push(`Primary school${sites.length > 1 ? "s" : ""} within ½ mi of ${Math.round(share * 100)}% of homes: one more primary school would close the gap`);
    }
  }

  // ground-floor restaurants and cafés: retail corners nearest the hub
  const retailLots = plan.lots.filter((l) => l.retail && l.site).sort((p, q) => Number(q.corner) - Number(p.corner) || dist(polyCentroid(p.site!), hub) - dist(polyCentroid(q.site!), hub));
  const dining: { lot: (typeof plan.lots)[number]; name: string; kind: string }[] = [];
  for (const g of groundFloor) {
    const lot = retailLots.find((l) => !l.name && !dining.some((d) => dist(polyCentroid(d.lot.site!), polyCentroid(l.site!)) < 60));
    if (!lot) continue;
    lot.name = `${g.name}`;
    dining.push({ lot, name: g.name, kind: g.kind });
  }

  // ---- 7. build the fabric, block by block. Each block is placed in its own builder (blocks are
  // disjoint and outside every right-of-way, so they cannot conflict with each other) and merged:
  // collision checks then scan one block's entities, not the whole neighbourhood's.
  const brng = rng.fork(99);
  const typCount = new Map<string, number>();
  const sub = (fn: (sb: OpBuilder) => void) => {
    const sb = new OpBuilder(world, b.author, b.tag);
    fn(sb);
    for (const op of sb.ops()) {
      if (op.type === "add") b.add(op.entity);
      else if (op.type === "remove") b.remove(op.entity.id);
      else b.update(op.after);
    }
  };
  const lotsBy = groupBy(plan.lots, (l) => l.block);
  const coresBy = groupBy(plan.cores, (c) => c.block);
  let garages = 0,
    garageSpaces = 0;
  for (const blk of fabric) {
    sub((sb) => {
      for (const lot of lotsBy.get(blk.key) ?? []) {
        const pl = lotPlacement(lot, brng, palette);
        if (!pl) continue;
        const r = placePrimitive(world, { def: pl.def, params: pl.params, site: pl.site, at: pl.at, rotation: pl.rotation, onConflict: "carve", lenient: true }, actor, sb);
        if (!r.ok) continue;
        typCount.set(lot.t.label, (typCount.get(lot.t.label) ?? 0) + 1);
        for (const y of lot.yard) yardTree(sb, y, brng);
        const d = dining.find((x) => x.lot === lot);
        if (d) {
          const e = lot.edge;
          placePrimitive(world, { def: "streetscape.outdoor_dining", params: { tables: Math.max(3, Math.min(8, Math.floor((lot.s1 - lot.s0) / 3))), umbrellas: true, umbrellaColor: brng.pick(["#2a5a3c", "#b65a3c", "#f0f0ec"]) }, at: efPt(e.f, (lot.s0 + lot.s1) / 2, -2.2), rotation: (Math.atan2(e.f.u[1], e.f.u[0]) * 180) / Math.PI, onConflict: "carve", lenient: true }, actor, sb);
        }
      }
      for (const c of coresBy.get(blk.key) ?? []) {
        if (c.garage) {
          const site = insetPoly(c.poly, 1.2);
          if (site && isValidPoly(site)) {
            const fl = brng.int(4, 6);
            const r = placePrimitive(world, { def: "transport.parking_garage", params: { shape: "site", floors: fl, facade: brng.pick(["concrete", "precast_white", "brick_buff"]), greenRoof: brng.chance(0.3) }, site, rotation: 0, onConflict: "carve", lenient: true }, actor, sb);
            if (r.ok) {
              garages++;
              garageSpaces += Math.round((polyArea(site) * fl) / 30);
              continue;
            }
          }
        }
        courtyardTrees(sb, c.poly, c.family, brng);
      }
      // one landscaped ground area per block: everything not under a building, a patio, a yard of a
      // house or a reserved site is garden, courtyard or forecourt
      const cut: Polygon[] = res.filter((r) => r.block === blk.key).map((r) => r.poly);
      for (const e of sb.touched()) {
        if (e.kind === "building") cut.push((e as Building).footprint);
        else if (e.kind === "area") cut.push((e as Area).poly);
      }
      for (const g of minusAll(blk.poly, cut)) addArea(sb, "grass", g, polyArea(g) > 1500 ? "Courtyard garden" : undefined);
    });
  }

  // ---- 8. civic sites
  for (const site of civic) {
    const polys = civicPolys.get(site) ?? [];
    if (site.kind === "park") {
      for (const q of polys) sub((sb) => placePrimitive(world, { def: "parks.park", params: { paths: "both", playground: true, benches: 10, pavilion: brng.chance(0.5), flowerBeds: 3, treeSpacing: 14, treeCover: 60, seed: brng.int(1, 9999) }, site: q, name: site.name, onConflict: "carve", lenient: true }, actor, sb));
      continue;
    }
    if (site.kind === "university") {
      sub((sb) => campusDistrict(world, sb, actor, grid, site, polys, refs, brng));
      continue;
    }
    const q = polys[0];
    if (!q) continue;
    const blk = analyseBlock(site.name, q, refs);
    const pref: (StreetRole | "none")[] = site.kind === "primary_school" ? ["local", "collector", "main"] : ["collector", "main", "avenue", "local", "boulevard"];
    const front = blk.edges.slice().sort((p, q2) => rank(pref, p.role) - rank(pref, q2.role) || q2.f.len - p.f.len)[0];
    const heading = front ? ((Math.atan2(-front.f.n[1], -front.f.n[0]) * 180) / Math.PI - 90 + 360) % 360 : 0;
    const level = site.kind === "primary_school" ? "primary" : site.kind === "middle_school" ? "middle" : "high";
    sub((sb) => placePrimitive(world, { def: "composites.urban_school", params: { level, enrolment: Math.round(site.enrolment ?? 0), seed: brng.int(1, 9999) }, site: q, rotation: heading, name: site.name, onConflict: "carve", lenient: true }, actor, sb));
  }

  // ---- 9. reserved lots: facilities, plaza, pocket parks
  for (const r of res) {
    const blk = fabric.find((x) => x.key === r.block)!;
    sub((sb) => {
      if (r.kind === "plaza") {
        placePrimitive(world, { def: "parks.plaza", params: { centre: "fountain", treeSpacing: 9 }, site: r.poly, name: "Market Square", onConflict: "carve", lenient: true }, actor, sb);
        return;
      }
      if (r.kind === "pocket_park") {
        placePrimitive(world, { def: "parks.pocket_park", params: { playground: brng.chance(0.5), seed: brng.int(1, 9999) }, site: r.poly, onConflict: "carve", lenient: true }, actor, sb);
        return;
      }
      const lf = LOT_FACILITIES[r.kind as keyof typeof LOT_FACILITIES];
      if (!lf) return;
      const name = lotFacilities.find((x) => x.r === r)?.name;
      const { at, rotation } = facilityPlacement(blk, r, lf);
      placePrimitive(world, { def: lf.def, params: { ...lf.params, ...(name ? { name } : {}) }, at, rotation, name, onConflict: "carve", lenient: true }, actor, sb);
      const taken: Polygon[] = [];
      for (const e of sb.touched()) if (e.kind === "building") taken.push((e as Building).footprint);
      else if (e.kind === "area") taken.push((e as Area).poly);
      for (const g of minusAll(r.poly, taken)) addArea(sb, "grass", g);
    });
  }

  // ---- 10. street trees
  const created = built.ids.map((x) => ({ s: b.get<Street>(x.id), role: x.role })).filter((x): x is { s: Street; role: StreetRole } => !!x.s);
  const junctions = b.touched().filter((e): e is StreetNode => e.kind === "node").map((n) => n.p);
  let trees = 0;
  const byName = new Map<string, string>();
  for (const { s, role } of created) {
    const species = byName.get(s.name ?? s.id) ?? makeRng(seed ^ hashName(s.name ?? s.id)).pick(TREE_SPECIES[role]);
    byName.set(s.name ?? s.id, species);
    const { cands } = streetTreeCandidates(world, [s], role === "local" ? 10 : 9);
    for (const c of cands) {
      if (junctions.some((j) => dist(j, c.p) < 12)) continue;
      const sp = SPECIES_SIZE[species] ?? { r: 4, h: 9 };
      b.add<Tree>({ id: newId("t"), kind: "tree", p: c.p, r: sp.r, h: sp.h, species, streetId: s.id, source: `${SOURCE}: street tree`, provenance: "proposed", createdBy: b.tag });
      trees++;
    }
  }

  // ---- 11. report
  let homes = 0,
    jobs = 0,
    gfa = 0,
    nb = 0;
  for (const e of b.touched()) {
    if (e.kind !== "building" || !pointInPoly(polyCentroid((e as Building).footprint), area)) continue;
    const p = programmeOf(e as Building, hh);
    homes += p.units;
    jobs += p.jobs;
    gfa += p.gfa;
    nb++;
  }
  const name = spec.name ?? "Neighborhood";
  const acres = toAcres(areaM2);
  b.report.summary.unshift(
    `${name}: ${fmtNum(nb)} buildings, ≈${fmtNum(homes)} homes (≈${fmtNum(homes * hh)} residents), ≈${fmtNum(jobs)} jobs on ${fmtAcres(areaM2)} — ${fmtNum(homes / acres, 0)} homes per gross acre`,
    `Streets: ${countRoles(built.ids)}; ${civic.filter((c) => c.kind !== "park").map((c) => c.name).join(", ") || "no civic campuses"}`,
    `Open space: ${civic.filter((c) => c.kind === "park").length} neighborhood park${civic.filter((c) => c.kind === "park").length === 1 ? "" : "s"}, ${res.filter((r) => r.kind === "pocket_park").length} pocket parks${plaza ? ", a plaza" : ""}; ${fmtNum(trees)} street trees${garages ? `; ${garages} parking structures (≈${fmtNum(garageSpaces)} spaces)` : ""}`,
  );
  if (advisories.length) b.report.summary.splice(3, 0, ...advisories);
  if (demolished) b.summary(`Replaced ${demolished} existing buildings`);
  b.data = {
    homes: Math.round(homes),
    residents: Math.round(homes * hh),
    jobs: Math.round(jobs),
    gfa_sqft: Math.round(gfa * 10.7639),
    buildings: nb,
    density: prog.density,
    target_homes: prog.homes,
    intensity: Math.round(intensity * 100) / 100,
    typologies: Object.fromEntries(typCount),
    civic: civic.map((c) => ({ kind: c.kind, name: c.name })),
    facilities: lotFacilities.map((l) => ({ kind: l.kind, name: l.name })).concat(dining.map((d) => ({ kind: d.kind, name: d.name }))),
    schools,
    advisories,
    street_trees: trees,
    parking_structures: garages,
    palette,
    area: area,
  };
  return b.finish(`Design ${name}`);
}

const SPECIES_SIZE: Record<string, { r: number; h: number }> = { live_oak: { r: 4.5, h: 9 }, cedar_elm: { r: 4, h: 10 }, bur_oak: { r: 4.5, h: 10 }, bald_cypress: { r: 2.5, h: 11 }, desert_willow: { r: 2.5, h: 6.5 }, redbud: { r: 3, h: 6 } };

const rank = (pref: (StreetRole | "none")[], r: StreetRole | "none") => {
  const i = pref.indexOf(r);
  return i < 0 ? 99 : i;
};

function hashName(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function minParkDist(p: Vec2, parks: Polygon[]) {
  return parks.reduce((m, q) => Math.min(m, distToPoly(p, q)), Infinity);
}

function countRoles(ids: { role: StreetRole; name: string }[]): string {
  const names = new Map<StreetRole, Set<string>>();
  for (const x of ids) names.set(x.role, (names.get(x.role) ?? new Set()).add(x.name));
  const label: Record<StreetRole, string> = { boulevard: "boulevard", avenue: "avenue", main: "main street", collector: "collector", local: "local street" };
  return (["boulevard", "avenue", "main", "collector", "local"] as StreetRole[])
    .filter((r) => names.get(r)?.size)
    .map((r) => `${names.get(r)!.size} ${label[r]}${names.get(r)!.size > 1 ? "s" : ""}`)
    .join(", ");
}

/** streets in a bbox as the builder sees them (committed and pending) */
function streetsNear(world: World, b: OpBuilder, bb: [number, number, number, number]): Street[] {
  const out = new Map<string, Street>();
  for (const e of world.query(bb, ["street"])) {
    const s = b.get<Street>(e.id);
    if (s) out.set(s.id, s);
  }
  for (const e of b.touched()) if (e.kind === "street") out.set(e.id, e);
  return [...out.values()].filter((s) => s.cls !== "motorway" && s.cls !== "motorway_link" && !s.tunnel);
}

function cellCentre(g: GridPlan, cs: GridPlan["cells"][number]) {
  const x = cs.reduce((t, c) => t + (c.x0 + c.x1) / 2, 0) / cs.length,
    y = cs.reduce((t, c) => t + (c.y0 + c.y1) / 2, 0) / cs.length;
  return toWorldG(g.frame, x, y);
}

function groupBy<T>(xs: T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x]);
  return m;
}

/** a polygon minus many others in one clipping pass (falls back to one at a time) */
function minusAll(a: Polygon, cut: Polygon[]): Polygon[] {
  const valid = cut.filter((q) => isValidPoly(q));
  try {
    return difference(a, ...valid).filter((q) => isValidPoly(q) && polyArea(q) >= 6);
  } catch {
    return minus(a, valid, 6);
  }
}

function addArea(b: OpBuilder, type: Area["type"], poly: Polygon, name?: string) {
  if (!isValidPoly(poly) || polyArea(poly) < 4) return;
  b.add<Area>({ id: newId("a"), kind: "area", type, poly, source: SOURCE, provenance: "proposed", createdBy: b.tag, ...(name ? { name } : {}) });
}

function addTree(b: OpBuilder, p: Vec2, rng: Rng, species?: string) {
  const sp = species ?? rng.pick(["live_oak", "cedar_elm", "bur_oak", "redbud", "desert_willow"]);
  const s = SPECIES_SIZE[sp] ?? { r: 4, h: 9 };
  const k = rng.range(0.75, 1.05);
  b.add<Tree>({ id: newId("t"), kind: "tree", p, r: s.r * k, h: s.h * k, species: sp, source: `${SOURCE}: garden tree`, provenance: "proposed", createdBy: b.tag });
}

function yardTree(b: OpBuilder, y: Polygon, rng: Rng) {
  if (polyArea(y) < 70 || minWidth(y) < 6) return;
  const c = polyCentroid(y);
  if (pointInPoly(c, y)) addTree(b, c, rng, rng.pick(["redbud", "desert_willow", "cedar_elm"]));
}

/** a block interior: shared courtyard garden (perimeter blocks) or rear gardens (yard blocks), with trees */
function courtyardTrees(b: OpBuilder, poly: Polygon, family: "yard" | "perimeter", rng: Rng) {
  const inner = insetPoly(poly, 5.5);
  if (!inner || !isValidPoly(inner)) return;
  const [x0, y0, x1, y1] = polyBBox(inner);
  const sp = family === "perimeter" ? 11 : 13;
  const ox = rng.range(0, sp),
    oy = rng.range(0, sp);
  let n = 0;
  for (let x = x0 + (ox % sp); x <= x1; x += sp)
    for (let y = y0 + (oy % sp); y <= y1; y += sp) {
      if (n > 40) return;
      const p: Vec2 = [x + rng.range(-2, 2), y + rng.range(-2, 2)];
      if (!pointInPoly(p, inner) || rng.chance(0.3)) continue;
      addTree(b, p, rng);
      n++;
    }
}

/** a university as campus blocks that keep the street grid */
function campusDistrict(world: World, b: OpBuilder, actor: Actor, g: GridPlan, site: CivicSite, polys: Polygon[], refs: ReturnType<typeof streetRefs>, rng: Rng) {
  if (!polys.length) return;
  const c = polys.reduce((s, q) => [s[0] + polyCentroid(q)[0] / polys.length, s[1] + polyCentroid(q)[1] / polys.length] as Vec2, [0, 0] as Vec2);
  const order = polys.map((q) => ({ q, d: dist(polyCentroid(q), c), out: dist(polyCentroid(q), g.centre) })).sort((p, q2) => p.d - q2.d);
  const roles: string[] = [];
  const n = order.length;
  roles.push("library");
  const rest = n - 1;
  const plan = ["academic", "science", "residential", "union", "academic", "athletics", "residential", "science", "academic"];
  for (let k = 0; k < rest; k++) roles.push(plan[k % plan.length]);
  // residential blocks face the neighbourhood (closest to the centre), athletics the far edge
  const style = rng.pick(["collegiate", "collegiate", "mission", "modern"]);
  order.forEach((o, k) => {
    const blk = analyseBlock(`campus${k}`, o.q, refs);
    const front = blk.edges.slice().sort((p, q2) => q2.f.len - p.f.len)[0];
    const heading = front ? ((Math.atan2(-front.f.n[1], -front.f.n[0]) * 180) / Math.PI - 90 + 360) % 360 : 0;
    placePrimitive(world, { def: "composites.campus_block", params: { role: roles[k], style, floors: rng.int(4, 6), seed: rng.int(1, 9999) }, site: o.q, rotation: heading, name: k === 0 ? site.name : undefined, lenient: true }, actor, b);
  });
}
