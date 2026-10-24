import { sum, type Case, type H } from "./harness";

const bld = (r: any) => (r.created as string[]).filter((id) => id.startsWith("b"));
const feat = async (h: H, id: string) => (await h.run("get_feature", { ids: [id] }))[0];

/** a vacant or surface-parking parcel near a location */
export async function softParcel(h: H, near: unknown, radius = 300, minArea = 800) {
  for (const landUse of ["vacant", "parking"]) {
    const ps = await h.run("find_features", { kind: "parcel", near, radius, where: { landUse, minArea }, limit: 5 });
    if (ps.total) return ps.rows[0];
  }
  return null;
}

export const A: Case[] = [
  {
    id: 1,
    cat: "A",
    prompt: "Build a 30-story mixed-use tower on the vacant parcel beside this intersection.",
    async run(h) {
      await h.fresh("A1");
      const j = await h.run("resolve_place", { query: "Lavaca Street & 4th Street" });
      const p = await softParcel(h, j[0].at, 300);
      h.expect(p, "no soft parcel near the intersection");
      const r = await h.run("create_building", { site: p.id, typology: "tower_podium", floors: 30, use: "mixed", name: "A8 Tower" });
      const f = await feat(h, bld(r)[0]);
      h.expect(f.floors >= 28, `floors ${f.floors}`);
      h.ev(`${p.id} (${p.zoning}, ${p.area_m2} m², ${p.dist_m} m from junction) → ${f.floors} floors, ${f.height_m} m, ${f.gfa_m2} m² GFA`);
      h.ev(sum(r, 3));
      if (f.issues.length) h.ev("constraints:", f.issues.join("; "));
    },
  },
  {
    id: 2,
    cat: "A",
    prompt: "Make that tower 20% taller without increasing its footprint.",
    async run(h) {
      const t = await h.run("find_features", { kind: "building", name: "A8 Tower", where: { proposed: true } });
      h.expect(t.total, "A8 tower missing");
      const before = await feat(h, t.rows[0].id);
      const r = await h.run("modify_buildings", { ids: [before.id], height_scale: 1.2 });
      const after = await feat(h, before.id);
      h.expect(after.height_m > before.height_m * 1.15, "not taller");
      h.expect(Math.abs(after.footprint_m2 - before.footprint_m2) < 1, "footprint changed");
      h.ev(`${before.height_m} m → ${after.height_m} m; footprint ${before.footprint_m2} → ${after.footprint_m2} m²`, sum(r));
    },
  },
  {
    id: 3,
    cat: "A",
    prompt: "Turn these three buildings into one connected development.",
    async run(h) {
      await h.fresh("A10");
      const j = await h.run("resolve_place", { query: "Lavaca Street & 9th Street" });
      const blk = await h.run("make_polygon", { shape: "block", at: [j[0].at[0] + 45, j[0].at[1] + 45] });
      const bs = await h.run("find_features", { kind: "building", within: blk.polygon, where: { historic: false, minArea: 150 }, sort: "area", limit: 3 });
      h.ev(`block ${blk.area_m2} m², ${bs.total} candidate buildings`);
      h.expect(bs.total >= 3, "fewer than 3 buildings on block");
      const r = await h.run("merge_buildings", { ids: h.ids(bs).slice(0, 3), name: "A10 Development" });
      h.expect(r.applied, "merge not applied");
      h.ev(sum(r, 3));
    },
  },
  {
    id: 4,
    cat: "A",
    prompt: "Replace this parking lot with two residential towers and a public plaza.",
    async run(h) {
      await h.fresh("A11");
      const lots = await h.run("find_features", { kind: "area", within: { center: [0, 0], radius: 1600 }, where: { type: "parking", minArea: 2500 }, sort: "area", limit: 1 });
      h.expect(lots.total, "no parking lot");
      const lot = lots.rows[0];
      const poly = (await h.run("make_polygon", { shape: "union", ids: [lot.id] })).polygon;
      const r = await h.run("create_building", { site: lot.id, typology: "twin_towers", floors: 28, use: "residential", edge_setback: 4, name: "A11 Towers" });
      const towers = await feat(h, bld(r)[0]);
      const plaza = await h.run("create_area", { type: "plaza", area: poly, buildings: "keep", shade_trees: true, name: "A11 Plaza" });
      h.expect(plaza.applied, "plaza not applied");
      const nTowers = towers.masses.filter((m: any) => m.role === "tower").length;
      h.expect(nTowers >= 2, `towers ${nTowers}`);
      h.ev(`${lot.id} ${lot.area_m2} m² → ${nTowers} towers ${towers.height_m} m, ${Math.round(towers.units)} units`, sum(plaza, 2));
    },
  },
  {
    id: 5,
    cat: "A",
    prompt: "Add setbacks to the upper floors of every building on this block.",
    async run(h) {
      await h.fresh("A12");
      const blk = await h.run("make_polygon", { shape: "block", at: "Congress Avenue & 7th Street" });
      const bs = await h.run("find_features", { kind: "building", within: blk.polygon, where: { minFloors: 4 }, limit: 60 });
      h.expect(bs.total, "no buildings ≥4 floors");
      const r = await h.run("modify_buildings", { ids: h.ids(bs), setbacks: { above_floor: 4, depth: 3 } });
      h.ev(`${bs.total} buildings on the block (≥4 floors)`, sum(r, 3));
      h.expect(r.modified >= 1, "nothing modified");
      if (r.modified < bs.total) return { status: "partial", gap: `${bs.total - r.modified} buildings skipped (historic or too shallow for a 3 m setback) — reported, not faked` };
    },
  },
  {
    id: 6,
    cat: "A",
    prompt: "Redesign that bulky office building as a slimmer tower with a podium.",
    async run(h) {
      await h.fresh("A13");
      const bs = await h.run("find_features", { kind: "building", within: { center: [0, -300], radius: 1500 }, where: { use: "office", minArea: 1500, maxHeight: 50, historic: false }, sort: "area", limit: 1 });
      h.expect(bs.total, "no bulky office");
      const b0 = await feat(h, bs.rows[0].id);
      const r = await h.run("modify_buildings", { ids: [b0.id], massing: { typology: "tower_podium", keep_gfa: true, podium_floors: 3, tower_coverage: 0.35 } });
      const b1 = await feat(h, b0.id);
      h.expect(b1.masses.some((m: any) => m.role === "tower"), "no tower mass");
      h.ev(`${b0.name}: ${b0.floors} fl/${b0.height_m} m/${b0.gfa_m2} m² → ${b1.floors} fl/${b1.height_m} m/${b1.gfa_m2} m²`, sum(r));
      h.ev(`limit ${b1.height_limit_m ?? "none"} m; notes: ${b1.notes ?? ""}`);
      if (b1.issues.length) h.ev("constraints:", b1.issues.join("; "));
    },
  },
  {
    id: 7,
    cat: "A",
    prompt: "Generate a courtyard apartment complex that fits the available parcel.",
    async run(h) {
      await h.fresh("A14");
      const ps = await h.run("find_features", { kind: "parcel", where: { landUse: "vacant", minArea: 3000 }, sort: "area", limit: 1 });
      h.expect(ps.total, "no large vacant parcel");
      const r = await h.run("create_building", { site: ps.rows[0].id, typology: "courtyard", floors: 5, use: "residential", name: "A14 Courtyard" });
      const f = await feat(h, bld(r)[0]);
      h.ev(`${ps.rows[0].id} ${ps.rows[0].area_m2} m² ${ps.rows[0].zoning} → ${f.floors} floors, ${Math.round(f.units)} units, footprint ${f.footprint_m2} m²`, sum(r, 2));
    },
  },
  {
    id: 8,
    cat: "A",
    prompt: "Rearrange these buildings to improve sunlight in the central courtyard.",
    async run(h) {
      let c = await h.run("find_features", { kind: "building", name: "A14 Courtyard", where: { proposed: true } });
      if (!c.total) {
        await h.fresh("A14");
        const ps = await h.run("find_features", { kind: "parcel", where: { landUse: "vacant", minArea: 3000 }, sort: "area", limit: 1 });
        await h.run("create_building", { site: ps.rows[0].id, typology: "courtyard", floors: 5, use: "residential", name: "A14 Courtyard" });
        c = await h.run("find_features", { kind: "building", name: "A14 Courtyard", where: { proposed: true } });
      }
      const o = await h.run("optimize_massing", { id: c.rows[0].id, date: "2026-12-21" });
      h.ev(`winter-solstice sun on the open ground: current ${o.current.sun_h} h → ${o.chosen?.form} ${o.chosen?.sun_h} h (GFA ${o.current.gfa_m2} → ${o.chosen?.gfa_m2} m²)`, `variants: ${o.variants.filter((v: any) => Number.isFinite(v.sun_h)).map((v: any) => `${v.label} ${v.sun_h} h`).join(", ")}`);
      h.expect(o.chosen && o.chosen.sun_h >= o.current.sun_h, "no form at least as sunny");
    },
  },
  {
    id: 9,
    cat: "A",
    prompt: "Convert the old warehouse district into residential lofts and neighborhood retail.",
    async run(h) {
      await h.fresh("A16");
      const d0 = await h.run("describe_area", { area: "Warehouse District" });
      const bs = await h.run("find_features", { kind: "building", within: "Warehouse District", where: { historic: false, maxHeight: 30 }, limit: 60 });
      h.expect(bs.total, "no low-rise buildings");
      const r = await h.run("modify_buildings", { ids: h.ids(bs), use: "mixed", program: { residential: 0.8, retail: 0.2 } });
      const d1 = await h.run("describe_area", { area: "Warehouse District" });
      h.expect(d1.housing_units > d0.housing_units, "no new units");
      h.ev(`${bs.total} low-rise buildings converted; units ${d0.housing_units} → ${d1.housing_units}; jobs ${d0.jobs_est} → ${d1.jobs_est}`, sum(r));
    },
  },
  {
    id: 10,
    cat: "A",
    prompt: "Create three different architectural massing options for this development.",
    async run(h) {
      const site = await softParcel(h, "Rainey Street", 700, 1000);
      h.expect(site, "no site");
      const rows: string[] = [];
      for (const [k, t, fl] of [["A17-courtyard", "courtyard", 8], ["A17-tower", "tower_podium", 30], ["A17-stepped", "stepped_tower", 18]] as const) {
        await h.fresh(k);
        const r = await h.run("create_building", { site: site.id, typology: t, floors: fl, use: "residential", name: k });
        const f = await feat(h, bld(r)[0]);
        rows.push(`${t}: ${f.height_m} m, ${f.gfa_m2} m² GFA, ${Math.round(f.units)} units${f.issues.length ? ` (${f.issues.length} constraint flags)` : ""}`);
      }
      const cmp = await h.run("compare_scenarios", { a: "A17-courtyard", b: "A17-tower", kinds: ["metrics"] });
      h.ev(...rows.map((x) => x));
      h.ev(`compare courtyard→tower: Δunits ${cmp.metrics.housing_units.delta}`);
    },
  },
];

export const B: Case[] = [
  {
    id: 11,
    cat: "B",
    prompt: "Add one travel lane in each direction along this corridor and adjust everything affected.",
    async run(h) {
      await h.fresh("B1");
      const r = await h.run("edit_streets", { street: "Lavaca Street", edits: [{ op: "add_lanes", count: 1, dir: "both" }], conflict_policy: "trim" });
      h.expect(r.modified > 1, "nothing modified");
      h.ev(...r.summary.slice(0, 7));
      h.ev(`${r.resolved_conflicts} resolved conflicts, ${r.unresolved_conflicts.length} unresolved`);
    },
  },
  {
    id: 12,
    cat: "B",
    prompt: "Narrow this road and expand both sidewalks.",
    async run(h) {
      await h.fresh("B2");
      const r = await h.run("edit_streets", { street: "West 5th Street", edits: [{ op: "set_lane_width", width: 3.0 }, { op: "widen_sidewalks", by: 1.5, side: "both" }], keep_row_width: true });
      h.ev(...r.summary.slice(0, 4));
      h.expect(r.modified > 0, "no change");
    },
  },
  {
    id: 13,
    cat: "B",
    prompt: "Shift this street 15 meters east while preserving adjacent road connections.",
    async run(h) {
      await h.fresh("B3");
      const ss = await h.run("find_features", { kind: "street", name: "Brazos Street", near: "Brazos Street & 3rd Street", radius: 90, limit: 4 });
      h.expect(ss.total, "no Brazos segments");
      const r = await h.run("move_streets", { street_ids: h.ids(ss).slice(0, 2), offset: [15, 0], conflict_policy: "trim" });
      h.ev(...r.summary.slice(0, 4));
      const v = await h.run("validate", {});
      const dangling = v.issues.filter((x: any) => x.kind === "network");
      h.ev(`validate: ${dangling.length} dangling ends`);
      h.expect(dangling.length === 0, "connections broken");
    },
  },
  {
    id: 14,
    cat: "B",
    prompt: "Turn this four-way intersection into a roundabout and rebuild the approaches.",
    async run(h) {
      await h.fresh("B4");
      const r = await h.run("set_junction", { junction: "East 11th Street & Navasota Street", control: "roundabout" });
      h.ev(...r.summary.slice(0, 4));
    },
  },
  {
    id: 15,
    cat: "B",
    prompt: "Extend this road until it connects with the arterial to the north.",
    async run(h) {
      await h.fresh("B5");
      // a dead-end local street with an arterial within 400 m to its north
      const ends = await h.run("find_features", { kind: "node", within: { center: [600, 300], radius: 1600 }, where: { degree: 1 }, limit: 60 });
      h.expect(ends.total, "no dead ends");
      let done: any = null;
      for (const e of ends.rows) {
        const node = (await h.run("get_feature", { ids: [e.id] }))[0];
        const st = node.streets[0];
        if (!st || !["residential", "tertiary", "living"].includes(st.cls)) continue;
        const arts = await h.run("find_features", { kind: "street", near: [e.at[0], e.at[1] + 220], radius: 220, where: { cls: "secondary" }, limit: 3 });
        const art = arts.rows.find((a: any) => a.at[1] > e.at[1] + 40);
        if (!art) continue;
        const r = await h.run("create_street", { path: [e.at, [e.at[0], art.at[1]]], cls: st.cls === "living" ? "residential" : st.cls, name: st.name ? `${st.name} (extension)` : "B5 extension" }, { allowError: true });
        if (r.applied) {
          done = { r, from: st.name ?? st.id, to: art.name };
          break;
        }
      }
      h.expect(done, "no extension succeeded");
      h.ev(`${done.from} extended north to ${done.to}`, sum(done.r, 3));
    },
  },
  {
    id: 16,
    cat: "B",
    prompt: "Realign this dangerous curve and adjust nearby parcels and structures.",
    async run(h) {
      await h.fresh("B6");
      const c = await h.run("find_features", { kind: "street", where: { maxRadius: 80, minLanes: 2 }, sort: "curvature", limit: 5 });
      h.expect(c.total, "no tight curves");
      const worst = c.rows[0];
      const r = await h.run("realign_streets", { street_ids: [worst.id], conflict_policy: "trim" });
      h.ev(`${worst.name}: ${worst.min_curve_radius_m} m curve vs ${worst.design_min_radius_m} m required`, ...r.summary.slice(0, 4), ...r.warnings.slice(0, 1));
    },
  },
  {
    id: 17,
    cat: "B",
    prompt: "Remove a vehicle lane and introduce a protected two-way cycle track.",
    async run(h) {
      await h.fresh("B7");
      const r = await h.run("edit_streets", { street: "Guadalupe Street", edits: [{ op: "remove_lanes", count: 1, dir: "forward" }, { op: "add_bike_lanes", kind: "two_way_track", side: "east" }], keep_row_width: true });
      h.ev(...r.summary.slice(0, 5));
      h.expect(r.summary.some((s: string) => s.includes("east side")), "track side not reported");
    },
  },
  {
    id: 18,
    cat: "B",
    prompt: "Split this superblock with a new local street network.",
    async run(h) {
      await h.fresh("B8");
      const blk = await h.run("make_polygon", { shape: "block", at: "Huston-Tillotson University" });
      h.ev(`block ${Math.round(blk.area_m2 / 10000 * 10) / 10} ha`);
      const r = await h.run("generate_district", { area: blk.polygon, style: "grid", new_streets: true, block_size: 110, keep_all_existing: true, target_units: 0, name: "B8 grid" });
      h.ev(...r.summary.slice(0, 4));
      h.expect(r.created.some((id: string) => id.startsWith("s")), "no new streets");
    },
  },
  {
    id: 19,
    cat: "B",
    prompt: "Convert this one-way road to two-way traffic and update intersections.",
    async run(h) {
      await h.fresh("B9");
      const r = await h.run("edit_streets", { street: "San Jacinto Boulevard", edits: [{ op: "set_oneway", oneway: false }] });
      h.ev(...r.summary.slice(0, 4));
      const t = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      h.ev(`PM traffic after conversion: ${t.kpi.delay_veh_hours} veh·h delay, ${t.kpi.congested_km} congested km`);
    },
  },
  {
    id: 20,
    cat: "B",
    prompt: "Design a new boulevard through this district while minimizing demolition.",
    async run(h) {
      await h.fresh("B10");
      const r = await h.run("plan_street", { from: [700, 240], to: [1500, 260], cls: "secondary", lanes: 2, median: true, trees: true, bike: "track", name: "B10 Boulevard" });
      const st = r.alignment_study;
      h.ev(...st.candidates.map((c: any) => (c.result ? `${c.alignment}: ${c.result}` : `${c.alignment}: ${c.buildings_demolished} buildings, ${c.homes} homes, ${c.gfa_m2} m² GFA${c.historic ? `, ${c.historic} historic` : ""}`)));
      h.ev(`built: ${st.chosen} (${st.rule})`, sum(r, 2));
      h.expect(r.applied, "nothing built");
    },
  },
];

export const C: Case[] = [
  {
    id: 21,
    cat: "C",
    prompt: "Add dedicated bus lanes along the busiest corridor.",
    async run(h) {
      await h.fresh("C1");
      const t = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      const busiest = t.transit_routes.sort((a: any, b: any) => b.minutes - b.free_minutes - (a.minutes - a.free_minutes))[0];
      h.ev(`slowest bus route vs free-flow: ${busiest.ref} ${busiest.name} ${busiest.minutes} min (free ${busiest.free_minutes})`);
      const r = await h.run("edit_streets", { street: "Guadalupe Street", edits: [{ op: "bus_lanes", on: true, mode: "convert" }] });
      const t2 = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      const route = (x: any) => x.transit_routes.find((q: any) => q.ref === busiest.ref);
      h.ev(sum(r, 2), `route ${busiest.ref}: ${route(t)?.minutes} → ${route(t2)?.minutes} min; car delay ${t.kpi.delay_veh_hours} → ${t2.kpi.delay_veh_hours} veh·h`);
    },
  },
  {
    id: 22,
    cat: "C",
    prompt: "Find the best location for a new transit station serving 5,000 additional residents.",
    async run(h) {
      await h.fresh("C2");
      // the 5,000 residents arrive with a planned district east of downtown
      const site: [number, number] = [1120, -930];
      const extra = [{ at: site, residents: 5000 }];
      const without = await h.run("rank_sites", { candidates: "junctions", within: { center: site, radius: 1200 }, criterion: "residents_walk", minutes: 10, limit: 3 });
      const r = await h.run("rank_sites", { candidates: "junctions", within: { center: site, radius: 1200 }, criterion: "residents_walk", minutes: 10, limit: 5, extra_residents: extra });
      h.ev(`ranked by residents within a 10-min walk incl. the 5,000 planned: ${r.top.slice(0, 3).map((x: any) => `${x.label} @${x.at} (${x.score})`).join("; ")}`, `without them the top site would be ${without.top[0].label} (${without.top[0].score})`);
      const tr = await h.run("run_simulation", { kind: "traffic", params: { period: "am", extra_residents: extra } });
      h.ev(`AM traffic with the 5,000 residents: ${tr.kpi.veh_trips} trips, delay ${tr.kpi.delay_veh_hours} veh·h`);
      h.expect(r.top[0].score >= 5000, "planned residents not counted");
    },
  },
  {
    id: 23,
    cat: "C",
    prompt: "Design a tram route connecting downtown with the university.",
    async run(h) {
      await h.fresh("C3");
      const r = await h.run("create_transit_route", { mode: "tram", waypoints: ["Republic Square", "University of Texas at Austin"], name: "C3 Tram", headway: 8, dedicated: true });
      h.ev(...r.summary.slice(0, 4));
      const t = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      const tram = t.transit_routes.find((x: any) => /C3 Tram/.test(x.name));
      h.ev(`tram run time ${tram?.minutes} min (dedicated ${tram?.dedicated_share})`);
    },
  },
  {
    id: 24,
    cat: "C",
    prompt: "Create a continuous protected bike network across this neighborhood.",
    async run(h) {
      await h.fresh("C4");
      const b0 = await h.run("run_simulation", { kind: "bike" });
      // upgrade the high-stress links that split the largest low-stress islands, plus the connecting corridors
      const crit = b0.critical_links.slice(0, 8);
      const names = [...new Set(crit.map((c: any) => c.name).filter(Boolean))] as string[];
      let edited = 0;
      for (const c of crit) {
        const near = await h.run("find_features", { kind: "street", name: c.name ?? "", near: c.at, radius: 400, limit: 12 });
        const ids = near.rows.filter((r: any) => !/Interstate|Expressway|Frontage/i.test(r.name ?? "")).map((r: any) => r.id);
        if (!ids.length) continue;
        const r = await h.run("edit_streets", { street_ids: ids, edits: [{ op: "add_bike_lanes", kind: "track", side: "both" }], keep_row_width: true, conflict_policy: "report" }, { allowError: true });
        if (r.applied) edited += r.modified;
      }
      const b1 = await h.run("run_simulation", { kind: "bike" });
      const cov = (b: any) => b.residents_within_15_min_by_bike.grocery.low_stress;
      h.ev(`model-picked links: ${names.slice(0, 6).join(", ")}; ${edited} street and junction entities updated for protected tracks`);
      h.ev(`low-stress km ${Math.round(b0.km_by_lts.lts_1 + b0.km_by_lts.lts_2)} → ${Math.round(b1.km_by_lts.lts_1 + b1.km_by_lts.lts_2)}; residents reaching a grocery on low-stress routes ${cov(b0)} → ${cov(b1)}; largest low-stress island ${b0.low_stress_islands[0].residents} → ${b1.low_stress_islands[0].residents} residents`);
      h.expect(parseFloat(cov(b1)) > parseFloat(cov(b0)), "low-stress coverage did not improve");
    },
  },
  {
    id: 25,
    cat: "C",
    prompt: "Redesign the transit stops to reduce walking distances.",
    async run(h) {
      await h.fresh("C5");
      const rs = await h.run("find_features", { kind: "route", name: "Martin Luther King", limit: 1 });
      h.expect(rs.total, "route missing");
      const r = await h.run("optimize_stops", { route_ids: [rs.rows[0].id], min_spacing: 300 });
      h.ev(...r.summary.slice(0, 4));
    },
  },
  {
    id: 26,
    cat: "C",
    prompt: "Make the area around this station transit-oriented and walkable.",
    async run(h) {
      await h.fresh("C6");
      const st = await h.run("resolve_place", { query: "Plaza Saltillo Station" });
      const r = await h.run("generate_district", { area: { center: st[0].at, radius: 350 }, style: "tod", anchor: st[0].at, max_floors: 12, new_streets: true, name: "C6 TOD" });
      h.ev(...r.summary.slice(0, 4));
      const a = await h.run("run_simulation", { kind: "access" });
      h.ev(`frequent transit coverage city-wide: ${a.residents_covered.frequent_transit}`);
    },
  },
  {
    id: 27,
    cat: "C",
    prompt: "Prioritize buses at these intersections and estimate the impact on car traffic.",
    async run(h) {
      await h.fresh("C7");
      const t0 = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      // the route with the most signals is where priority pays off
      const target = [...t0.transit_routes].sort((a: any, b: any) => b.signals - a.signals)[0];
      const r = await h.run("set_junction", { route: target.id, transit_priority: true });
      const t1 = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      const after = t1.transit_routes.find((x: any) => x.id === target.id);
      h.ev(sum(r, 1), `route ${target.ref} ${target.name}: ${target.minutes} → ${after?.minutes} min (${after?.with_priority}/${after?.signals} signals prioritised)`, `cars: network delay ${t0.kpi.delay_veh_hours} → ${t1.kpi.delay_veh_hours} veh·h, avg speed ${t0.kpi.avg_speed_kmh} → ${t1.kpi.avg_speed_kmh} km/h`);
      h.expect(after && after.minutes < target.minutes, "bus not faster");
    },
  },
  {
    id: 28,
    cat: "C",
    prompt: "Remove half the downtown surface parking and propose alternatives.",
    async run(h) {
      await h.fresh("C8");
      const lots = await h.run("find_features", { kind: "area", within: "Downtown", where: { type: "parking", minArea: 300 }, sort: "area", limit: 60 });
      h.expect(lots.total, "no parking");
      const total = lots.rows.reduce((s: number, r: any) => s + r.area_m2, 0);
      let acc = 0;
      const pick: any[] = [];
      for (const l of lots.rows) {
        if (acc >= total / 2) break;
        pick.push(l);
        acc += l.area_m2;
      }
      const big = pick.slice(0, 2);
      for (const l of big) await h.run("create_building", { site: l.id, typology: "midrise", floors: 8, use: "mixed", name: `C8 infill ${l.id}` }, { allowError: true });
      const rest = pick.slice(2);
      const r = rest.length ? await h.run("convert_areas", { ids: h.ids(rest), type: "park" }) : null;
      h.ev(`${pick.length} lots, ${Math.round(acc)} of ${Math.round(total)} m² (top-60 lots) → 2 mixed-use infill buildings + ${rest.length} pocket parks`, r ? sum(r) : "");
    },
  },
  {
    id: 29,
    cat: "C",
    prompt: "Create a pedestrian-only street while maintaining delivery access.",
    async run(h) {
      await h.fresh("C9");
      const n = await h.run("resolve_place", { query: "East 6th Street & Trinity Street" });
      const r = await h.run("set_street_attributes", { street: "East 6th Street", within: { center: n[0].at, radius: 260 }, closed: true, service_access: true });
      h.ev(...r.summary.slice(0, 3));
      const t = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      h.ev(`PM delay ${t.kpi.delay_veh_hours} veh·h`);
    },
  },
  {
    id: 30,
    cat: "C",
    prompt: "Optimize the street network for emergency vehicle access.",
    async run(h) {
      await h.fresh("C10");
      const a = await h.run("run_simulation", { kind: "access" });
      h.expect(a.emergency, "no emergency analysis");
      h.ev(`before: median response ${a.emergency.median_response_min} min; ${a.emergency.residents_beyond_4_min} residents beyond 4 min; ${a.emergency.residents_without_vehicle_route} with no vehicle route`);
      const o = await h.run("optimize_emergency", { max_changes: 4 });
      h.ev(`searched ${JSON.stringify(o.searched.candidates)} (${o.searched.evaluations} evaluations); predicted ${o.searched.residents_within_4_min_predicted}`);
      for (const x of o.applied) h.ev(`✓ ${x.change}: +${x.residents_newly_within_4_min} residents — ${x.geometry}`);
      if (o.not_applied.length) h.ev(`not applied: ${o.not_applied.join("; ")}`);
      h.ev(`full access model: within 4 min ${o.residents_within_4_min}; median ${o.median_response_min} min; beyond 4 min ${o.residents_beyond_4_min}`);
      h.expect(o.applied.length > 0, "at least one change applied");
      const [b0, b1] = String(o.residents_within_4_min).split(" (")[0].split(" → ").map((x: string) => Number(x.replace(/,/g, "")));
      h.expect(b1 > b0, "coverage improves in the full model");
    },
  },
];
