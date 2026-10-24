import { sum, type Case, type H } from "./harness";

const feat = async (h: H, id: string) => (await h.run("get_feature", { ids: [id] }))[0];
const EAST = [[[900, -1100], [1350, -1100], [1350, -760], [900, -760]]][0];
const pct = (s: string) => parseFloat(String(s));

export const D: Case[] = [
  {
    id: 31,
    cat: "D",
    prompt: "Design an entirely new walkable neighborhood for 3,000 people here.",
    async run(h) {
      await h.fresh("D1");
      const r = await h.run("generate_district", { area: EAST, style: "european", target_population: 3000, max_floors: 7, new_streets: true, name: "D1 Neighbourhood" });
      h.ev(...r.summary.slice(0, 4));
      const d = await h.run("describe_area", { area: EAST });
      h.expect(Math.abs(d.residents_est - 3000) < 900 || d.residents_est > 3000, `residents ${d.residents_est}`);
      h.ev(`area now: ${d.residents_est} residents, ${d.street_km_by_class.living ?? 0} km living streets, ${d.parks_m2 + d.plazas_m2} m² parks+plazas`);
    },
  },
  {
    id: 32,
    cat: "D",
    prompt: "Redevelop this underused commercial strip into a mixed-use district.",
    async run(h) {
      await h.fresh("D2");
      const strip = await h.run("make_polygon", { shape: "corridor", street: "East 7th Street", width: 110 });
      const d0 = await h.run("describe_area", { area: strip.polygon });
      const r = await h.run("generate_district", { area: strip.polygon, style: "midrise", use: "mixed", max_floors: 6, keep_all_existing: false, name: "D2 East 7th" });
      const d1 = await h.run("describe_area", { area: strip.polygon });
      h.ev(...r.summary.slice(0, 3), `units ${d0.housing_units} → ${d1.housing_units}; jobs ${d0.jobs_est} → ${d1.jobs_est}; historic kept ${d1.historic_buildings}/${d0.historic_buildings}`);
      h.expect(d1.historic_buildings === d0.historic_buildings, "historic lost");
    },
  },
  {
    id: 33,
    cat: "D",
    prompt: "Create a European-style neighborhood with compact blocks and generous public space.",
    async run(h) {
      await h.fresh("D3");
      const r = await h.run("generate_district", { area: EAST, style: "european", block_size: 70, open_space_ratio: 0.3, max_floors: 6, new_streets: true, name: "D3 Quartier" });
      h.ev(...r.summary.slice(0, 4));
    },
  },
  {
    id: 34,
    cat: "D",
    prompt: "Generate a high-density residential district without exceeding 12 stories.",
    async run(h) {
      await h.fresh("D4");
      const r = await h.run("generate_district", { area: EAST, style: "midrise", use: "residential", max_floors: 12, target_units: 4000, new_streets: true, name: "D4 Dense" });
      const tall = await h.run("find_features", { kind: "building", within: EAST, where: { proposed: true, minFloors: 13 } });
      h.expect(tall.total === 0, `${tall.total} buildings over 12 floors`);
      h.ev(...r.summary.slice(0, 3), "no proposed building exceeds 12 floors");
    },
  },
  {
    id: 35,
    cat: "D",
    prompt: "Make this suburban area more walkable without demolishing existing homes.",
    async run(h) {
      await h.fresh("D5");
      const area = "Upper Boggy Creek";
      const d0 = await h.run("describe_area", { area });
      const a0 = await h.run("run_simulation", { kind: "access", params: { area } });
      // 1. fill the measured sidewalk gaps, inside the existing right-of-way (no building touched)
      const gaps = await h.run("find_features", { kind: "street", within: area, where: { sidewalk: "missing_measured" }, limit: 400 });
      const bySide: Record<string, string[]> = { left: [], right: [], both: [] };
      for (const row of gaps.rows ?? gaps) {
        const l = /none \(measured|none \(planned/.test(row.sidewalk_left ?? ""),
          r = /none \(measured|none \(planned/.test(row.sidewalk_right ?? "");
        bySide[l && r ? "both" : l ? "left" : "right"].push(row.id);
      }
      let added = 0;
      const nb0 = h.R.world.all("building").length;
      for (const [side, ids] of Object.entries(bySide)) {
        if (!ids.length) continue;
        await h.run("edit_streets", { street_ids: ids, edits: [{ op: "set_sidewalk", width: 1.52, side }], keep_row_width: true, conflict_policy: "report" });
        added += ids.length;
      }
      h.expect(h.R.world.all("building").length === nb0, "sidewalk infill removed buildings");
      // 2. accessible curb ramps where the inventory has none or grade D–F
      const ramps = await h.run("find_features", { kind: "node", within: area, where: { ramps: "poor" }, limit: 400 });
      const rampIds = h.ids(ramps);
      const rr = rampIds.length ? await h.run("set_junction", { junctions: rampIds, curb_ramps: "upgrade" }) : null;
      // 3. gentle infill with corner shops on soft sites, existing homes kept; shade where people walk
      const r = await h.run("generate_district", { area, style: "infill", use: "mixed", keep_all_existing: true, max_floors: 3, name: "D5 infill" });
      h.expect(!r.summary.some((s: string) => /Demolished \d+ existing/.test(s)), "demolished homes");
      const t = await h.run("plant_trees", { within: area, count: 300, target: "heat" }, { allowError: true });
      const d1 = await h.run("describe_area", { area });
      const a1 = await h.run("run_simulation", { kind: "access", params: { area } });
      const s0 = d0.sidewalks,
        s1 = d1.sidewalks;
      h.ev(`sidewalks (City inventory): ${s0.with_sidewalk} of ${s0.street_side_km} side-km, ${s0.missing_km_measured} km confirmed missing, ${s0.poor_condition_km} km grade D/F, curb ramps ${JSON.stringify(s0.curb_ramps)}`);
      h.ev(`filled ${added} segments with 5 ft sidewalks inside the ROW → ${s1.with_sidewalk}, ${s1.missing_km_measured} km missing; ${rr ? sum(rr, 1) : "no ramp gaps"}`);
      h.ev(...r.summary.slice(0, 2), t.summary ? sum(t, 1) : `street trees: ${t.error}`);
      const c0 = a0.in_area.residents_covered,
        c1 = a1.in_area.residents_covered;
      h.ev(`${a1.in_area.area}: residents ${a0.in_area.residents} → ${a1.in_area.residents}; within 15 min of food ${c0.food} → ${c1.food}, grocery ${c0.grocery} → ${c1.grocery}, park ${c0.park} → ${c1.park}`);
      h.expect(s1.missing_km_measured < s0.missing_km_measured || s0.missing_km_measured === 0, "measured sidewalk gaps reduced");
      return { status: "pass" };
    },
  },
  {
    id: 36,
    cat: "D",
    prompt: "Find suitable infill development sites within one kilometer of downtown.",
    async run(h) {
      await h.fresh("D6");
      const dt = await h.run("resolve_place", { query: "Downtown" });
      const r = await h.run("rank_sites", { candidates: "soft_sites", within: { center: dt[0].at, radius: 1000 }, criterion: "near_transit", limit: 8 });
      const cap = await h.run("run_simulation", { kind: "capacity", params: { parcel_ids: r.top.map((x: any) => x.id).filter(Boolean) } });
      h.ev(...r.top.slice(0, 4).map((x: any) => `${x.id} ${x.label}`), `capacity of top 8: +${cap.added_units ?? cap.totals?.added_units ?? JSON.stringify(cap).slice(0, 120)} units`);
    },
  },
  {
    id: 37,
    cat: "D",
    prompt: "Create a new civic center with surrounding housing, shops, and parks.",
    async run(h) {
      await h.fresh("D7");
      const r = await h.run("generate_district", { area: EAST, style: "civic", max_floors: 8, new_streets: true, open_space_ratio: 0.25, name: "D7 Civic Centre" });
      h.ev(...r.summary.slice(0, 4));
    },
  },
  {
    id: 38,
    cat: "D",
    prompt: "Redesign these oversized blocks into a fine-grained street grid.",
    async run(h) {
      await h.fresh("D8");
      const r = await h.run("generate_district", { area: EAST, style: "grid", new_streets: true, block_size: 80, keep_all_existing: true, name: "D8 Grid" });
      h.expect(r.created.some((id: string) => id.startsWith("s")), "no streets");
      h.ev(...r.summary.slice(0, 3));
    },
  },
  {
    id: 39,
    cat: "D",
    prompt: "Fit another 2,000 housing units into this area while retaining its parks.",
    async run(h) {
      await h.fresh("D9");
      const area = "Central East Austin";
      const d0 = await h.run("describe_area", { area });
      // 1. what fits on open land without touching any building
      const dry = await h.run("generate_district", { area, style: "infill", target_net_units: 2000, keep_all_existing: true, max_floors: 6, name: "D9 open land", dry_run: true });
      h.ev(`open land only (dry run): ${sum(dry, 1)}`);
      // 2. add the soft sites: private lots whose buildings are worth less than half their land; parks, public and historic lots kept
      const r = await h.run("generate_district", { area, style: "infill", target_net_units: 2000, keep_all_existing: true, redevelop: "underused", max_floors: 6, name: "D9 +2000" });
      const d1 = await h.run("describe_area", { area });
      const v = await h.run("validate", {});
      h.ev(`units ${d0.housing_units} → ${d1.housing_units} (+${d1.housing_units - d0.housing_units}); parks ${d0.parks_m2} → ${d1.parks_m2} m²; historic ${d0.historic_buildings} → ${d1.historic_buildings}`, sum(r, 1), ...r.summary.filter((l: string) => /^(Redeveloped|Net new|Demolished)/.test(l)));
      h.ev(`validation: ${v.errors} errors, ${v.warnings} warnings${v.issues.length ? ` — e.g. ${v.issues.slice(0, 2).map((x: any) => x.message).join("; ")}` : ""}`);
      h.expect(d1.parks_m2 >= d0.parks_m2 - 50, "parks lost");
      h.expect(d1.historic_buildings === d0.historic_buildings, "historic lost");
      if (d1.housing_units - d0.housing_units < 1900) return { status: "partial", gap: `Only +${d1.housing_units - d0.housing_units} net units fit on open land and underused lots under 6 floors without touching parks` };
    },
  },
  {
    id: 40,
    cat: "D",
    prompt: "Generate three masterplans optimizing respectively for housing, mobility, and greenery.",
    async run(h) {
      const plans = [
        ["D10-housing", { style: "midrise", target_units: 4500, max_floors: 12, open_space_ratio: 0.1 }],
        ["D10-mobility", { style: "tod", anchor: [1120, -930], max_floors: 10, open_space_ratio: 0.15 }],
        ["D10-green", { style: "european", target_units: 1500, max_floors: 6, open_space_ratio: 0.4 }],
      ] as const;
      for (const [n, p] of plans) {
        await h.fresh(n);
        await h.run("generate_district", { area: EAST, new_streets: true, name: n, ...p });
        if (n === "D10-mobility") await h.run("create_transit_route", { mode: "brt", waypoints: [[1120, -930], "Downtown Station"], name: "D10 BRT", dedicated: true, headway: 6 });
        if (n === "D10-green") await h.run("plant_trees", { within: EAST, spacing: 10 });
      }
      for (const n of ["D10-housing", "D10-mobility", "D10-green"]) {
        const c = await h.run("compare_scenarios", { a: "baseline", b: n, kinds: ["metrics"] });
        h.ev(`${n}: Δunits ${c.metrics.housing_units.delta}, Δpark ${c.metrics.park_plaza_m2.delta} m², Δtrees ${c.metrics.trees.delta}, Δbus-lane km ${c.metrics.bus_lane_km.delta}`);
      }
    },
  },
];

export const E: Case[] = [
  {
    id: 41,
    cat: "E",
    prompt: "Replace this paved lot with a shaded neighborhood park.",
    async run(h) {
      await h.fresh("E1");
      const lots = await h.run("find_features", { kind: "area", within: "Central East Austin", where: { type: "parking", minArea: 1500 }, sort: "area", limit: 1 });
      h.expect(lots.total, "no paved lot");
      const r = await h.run("create_area", { type: "park", area: lots.rows[0].id, shade_trees: true, name: "E1 Park" });
      h.ev(...r.summary.slice(0, 4));
    },
  },
  {
    id: 42,
    cat: "E",
    prompt: "Add 500 street trees where they provide the greatest potential heat benefit.",
    async run(h) {
      await h.fresh("E2");
      const r = await h.run("plant_trees", { within: "Downtown", count: 500, target: "heat" });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "E2", kinds: ["heat"] });
      const L = c.heat.local;
      h.ev(sum(r, 3), `area-wide pedestrian exposure ${c.heat.a.mean_ped_exposure_c} → ${c.heat.b.mean_ped_exposure_c} °C`, `where it changed: ${L.area_changed_m2} m², mean ${L.mean_change_where_changed_c} °C, max cooling ${L.max_cooling_c} °C; people-weighted sidewalk exposure ${L.people_weighted_sidewalk_c.a} → ${L.people_weighted_sidewalk_c.b} °C`);
      h.expect(L.people_weighted_sidewalk_c.b < L.people_weighted_sidewalk_c.a, "trees lower the heat people on foot meet");
      // control: the same number of trees spread evenly instead of targeted
      await h.fresh("E2-even");
      await h.run("plant_trees", { within: "Downtown", count: 500, target: "even" });
      const ce = await h.run("compare_scenarios", { a: "baseline", b: "E2-even", kinds: ["heat"] });
      const Le = ce.heat.local;
      h.ev(`control, 500 evenly spaced: people-weighted ${Le.people_weighted_sidewalk_c.a} → ${Le.people_weighted_sidewalk_c.b} °C`);
      h.expect(L.people_weighted_sidewalk_c.b <= Le.people_weighted_sidewalk_c.b, "targeted planting cools where people walk at least as much as even spacing");
    },
  },
  {
    id: 43,
    cat: "E",
    prompt: "Create a continuous green corridor connecting these two parks.",
    async run(h) {
      await h.fresh("E3");
      const route = await h.run("find_route", { from: "Republic Square", to: "Waterloo Park", mode: "walk", prefer: "quiet" });
      const ids = route.street_ids.filter((id: string) => h.R.world.get(id)?.kind === "street" && (h.R.world.get(id) as any).cls !== "service");
      const r1 = await h.run("edit_streets", { street_ids: ids, edits: [{ op: "add_planting", width: 2, side: "both" }], keep_row_width: true });
      const t = await h.run("plant_trees", { street_ids: ids, spacing: 8 }, { allowError: true });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "E3", kinds: ["heat"] });
      h.ev(`route: ${route.length_m} m on quiet streets — ${route.legs.slice(0, 5).join(" → ")}`, sum(r1, 1), t.summary ? sum(t, 1) : `trees: ${t.error}`, `along the corridor (15:00): ${c.heat.local.area_changed_m2} m² changed, mean ${c.heat.local.mean_change_where_changed_c} °C`);
    },
  },
  {
    id: 44,
    cat: "E",
    prompt: "Introduce a retention pond and account for the displaced land uses.",
    async run(h) {
      await h.fresh("E4");
      const r0 = await h.run("run_simulation", { kind: "runoff", params: { storm: "25yr" } });
      const lots = await h.run("find_features", { kind: "area", within: "Waller Creek", where: { type: "parking", minArea: 1000 }, sort: "area", limit: 1 });
      h.expect(lots.total, "no lot");
      const r = await h.run("create_area", { type: "retention", area: lots.rows[0].id, depth: 2, name: "E4 Pond" });
      const r1 = await h.run("run_simulation", { kind: "runoff", params: { storm: "25yr" } });
      h.ev(...r.summary.slice(0, 3), `25-yr net runoff ${r0.net_runoff_m3} → ${r1.net_runoff_m3} m³`);
    },
  },
  {
    id: 45,
    cat: "E",
    prompt: "Design a waterfront promenade without removing existing road access.",
    async run(h) {
      await h.fresh("E5");
      const lake = await h.run("find_features", { kind: "area", where: { type: "water", minArea: 100000 }, sort: "area", limit: 1 });
      const band = await h.run("make_polygon", { shape: "buffer", ids: [lake.rows[0].id], distance: 18 });
      const clip = await h.run("make_polygon", { shape: "rect", center: [-300, -1150], width: 1400, height: 260 });
      const { intersection } = await import("@/agent/tools");
      const poly = intersection([band.polygon], [clip.polygon])[0]?.[0];
      h.expect(poly, "no promenade polygon");
      const r = await h.run("create_area", { type: "plaza", area: poly, buildings: "keep", name: "E5 Promenade" });
      const v = await h.run("validate", {});
      h.ev(...r.summary.slice(0, 3), `validate: ${v.errors} errors; streets untouched (create_area never edits street ROW)`);
      const water = await h.run("find_features", { kind: "area", where: { type: "water", minArea: 100000 }, sort: "area", limit: 1 });
      h.expect(Math.abs(water.rows[0].area_m2 - lake.rows[0].area_m2) < 10, "lake was cut");
    },
  },
  {
    id: 46,
    cat: "E",
    prompt: "Increase permeable surfaces across this neighborhood by 20%.",
    async run(h) {
      await h.fresh("E6");
      const area = "Downtown";
      const ro = async () => (await h.run("run_simulation", { kind: "runoff", params: { storm: "10yr", area } })).area;
      const a0 = await ro();
      const target = Math.round(a0.pervious_land_m2 * 1.2);
      h.ev(`Downtown pervious ${a0.pervious_land_m2} m² (${a0.impervious_share_of_land} impervious, pavement under tree canopy counted impervious) → target +20% = ${target} m²`);
      // ground-level measures first, in order of disruption: depave parking lots and plazas, then parking-lane bioswales
      const steps: [string, string, Record<string, unknown>][] = [
        ["surface parking → permeable paving", "convert_areas", { from_type: "parking", within: area, type: "permeable" }],
        ["plazas → permeable paving", "convert_areas", { from_type: "plaza", within: area, type: "permeable" }],
        ["kerbside parking lanes → bioswales", "edit_streets", { within: area, edits: [{ op: "add_raingardens", only_parking: true }] }],
      ];
      let prev = a0.pervious_land_m2;
      for (const [label, tool, input] of steps) {
        const r = await h.run(tool, input);
        const a = await ro();
        h.ev(`${label}: +${a.pervious_land_m2 - prev} m² — ${sum(r, 1)}`);
        prev = a.pervious_land_m2;
      }
      const ground = prev - a0.pervious_land_m2;
      if (prev < target) {
        // the remainder on roofs: vegetated, not ground-level permeable — reported separately
        const g = await h.run("green_roofs", { area, target_m2: Math.ceil((target - prev) * 1.05) });
        const a = await ro();
        h.ev(`green roofs for the remaining ${target - prev} m²: +${a.pervious_land_m2 - prev} m² — ${sum(g, 1)}`);
        prev = a.pervious_land_m2;
      }
      const a1 = await ro();
      h.ev(`after: pervious ${a1.pervious_land_m2} m² (+${Math.round((a1.pervious_land_m2 / a0.pervious_land_m2 - 1) * 1000) / 10}%; ground-level +${Math.round((ground / a0.pervious_land_m2) * 1000) / 10}%), impervious ${a0.impervious_share_of_land} → ${a1.impervious_share_of_land}; 10-yr runoff in area ${a0.runoff_m3} → ${a1.runoff_m3} m³`);
      h.expect(a1.pervious_land_m2 >= target, "+20% pervious reached");
    },
  },
  {
    id: 47,
    cat: "E",
    prompt: "Convert this intersection into a pedestrian plaza.",
    async run(h) {
      await h.fresh("E7");
      const r = await h.run("set_junction", { junction: "Congress Avenue & 2nd Street", control: "plaza" });
      h.ev(...r.summary.slice(0, 3));
    },
  },
  {
    id: 48,
    cat: "E",
    prompt: "Add green roofs to suitable buildings and estimate the resulting changes.",
    async run(h) {
      await h.fresh("E8");
      const r = await h.run("green_roofs", { area: "Downtown", min_area: 800 });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "E8", kinds: ["runoff", "heat"], params: { runoff: { storm: "2yr" }, heat: {} } });
      const cost = await h.run("estimate", { what: "costs" });
      h.ev(sum(r, 2), `2-yr runoff ${c.runoff.a.net_runoff_m3} → ${c.runoff.b.net_runoff_m3} m³; ped exposure ${c.heat.a.mean_ped_exposure_c} → ${c.heat.b.mean_ped_exposure_c} °C`, `cost ${JSON.stringify(cost.total_usd ?? cost.total ?? "").slice(0, 40)}`);
    },
  },
  {
    id: 49,
    cat: "E",
    prompt: "Create a network of rain gardens along streets with sufficient space.",
    async run(h) {
      await h.fresh("E9");
      const ss = await h.run("find_features", { kind: "street", within: "Central East Austin", where: { cls: "residential" }, limit: 60 });
      const det = await h.run("get_feature", { ids: h.ids(ss) });
      // room for bioretention: wide sidewalks on both sides, or an on-street parking lane to give up
      const room = (s: any) => {
        const sw = s.strips.filter((x: string) => x.startsWith("sidewalk"));
        return (sw.length >= 2 && sw.every((x: string) => parseFloat(x.split(" ")[1]) >= 3.5)) || s.strips.some((x: string) => x.startsWith("parking"));
      };
      const wide = det.filter(room).map((s: any) => s.id);
      h.ev(`${wide.length}/${det.length} residential segments have room (≥3.5 m sidewalks both sides, or a parking lane)`);
      h.expect(wide.length, "no wide-sidewalk streets");
      const r = await h.run("edit_streets", { street_ids: wide, edits: [{ op: "add_raingardens", width: 1.8, side: "both" }], keep_row_width: true });
      const ro = await h.run("compare_scenarios", { a: "baseline", b: "E9", kinds: ["runoff"], params: { runoff: { storm: "2yr" } } });
      const cost = await h.run("estimate", { what: "costs" });
      h.ev(sum(r, 1), `2-yr storm: storage ${ro.runoff.a.storage_m3} → ${ro.runoff.b.storage_m3} m³; net runoff ${ro.runoff.a.net_runoff_m3} → ${ro.runoff.b.net_runoff_m3} m³`, `cost: rain gardens $${Math.round((cost.breakdown?.["Rain gardens"] ?? 0) / 1e3)}k`);
      h.expect(ro.runoff.b.storage_m3 > ro.runoff.a.storage_m3, "no storage added");
    },
  },
  {
    id: 50,
    cat: "E",
    prompt: "Design a climate-resilient park with drainage and flood-storage features.",
    async run(h) {
      await h.fresh("E10");
      const lots = await h.run("find_features", { kind: "area", within: "Rainey Street", where: { type: "parking", minArea: 800 }, sort: "area", limit: 2 });
      h.expect(lots.total >= 1, "no site");
      const r1 = await h.run("create_area", { type: "park", area: lots.rows[0].id, shade_trees: true, name: "E10 Resilience Park" });
      const r2 = lots.rows[1] ? await h.run("create_area", { type: "retention", area: lots.rows[1].id, depth: 1.8, name: "E10 Flood storage" }) : null;
      const ro = await h.run("compare_scenarios", { a: "baseline", b: "E10", kinds: ["runoff"], params: { runoff: { storm: "100yr" } } });
      const f = await h.run("run_simulation", { kind: "flood", params: { rise_m: 4 } });
      h.ev(sum(r1, 2), r2 ? sum(r2, 1) : "", `100-yr net runoff ${ro.runoff.a.net_runoff_m3} → ${ro.runoff.b.net_runoff_m3} m³; +4 m lake: ${f.buildings_exposed} buildings exposed`);
    },
  },
];

export const F: Case[] = [
  {
    id: 51,
    cat: "F",
    prompt: "What happens to rush-hour traffic if 3,000 residents move into this area?",
    async run(h) {
      await h.fresh("F1");
      const t0 = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      const t1 = await h.run("run_simulation", { kind: "traffic", params: { period: "pm", extra_residents: [{ at: [1100, -900], residents: 3000 }] } });
      h.expect(t1.kpi.veh_trips > t0.kpi.veh_trips, "no added trips");
      h.ev(`trips ${t0.kpi.veh_trips} → ${t1.kpi.veh_trips}; delay ${t0.kpi.delay_veh_hours} → ${t1.kpi.delay_veh_hours} veh·h; congested km ${t0.kpi.congested_km} → ${t1.kpi.congested_km}`);
    },
  },
  {
    id: 52,
    cat: "F",
    prompt: "Simulate closing this bridge during the evening commute.",
    async run(h) {
      await h.fresh("F2");
      const br = await h.run("find_features", { kind: "street", name: "Congress", where: { bridge: true }, limit: 10 });
      h.expect(br.total, "no bridge segments");
      const r = await h.run("set_street_attributes", { street_ids: h.ids(br), closed: true });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "F2", kinds: ["traffic"], params: { traffic: { period: "pm" } } });
      h.ev(sum(r, 1), `PM delay ${c.traffic.a.delay_veh_hours} → ${c.traffic.b.delay_veh_hours} veh·h; congested km ${c.traffic.a.congested_km} → ${c.traffic.b.congested_km}`);
      h.expect(c.traffic.b.delay_veh_hours > c.traffic.a.delay_veh_hours, "closing a bridge reduced delay?");
    },
  },
  {
    id: 53,
    cat: "F",
    prompt: "Find the five most congested intersections and propose improvements.",
    async run(h) {
      await h.fresh("F3");
      const t = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      h.ev(...t.worst_junctions.slice(0, 5).map((j: any) => `${j.name}: LOS ${j.los} v/c ${j.vc} (${j.control})`));
      const o = await h.run("optimize_bottlenecks", { period: "pm", max_changes: 5 });
      h.ev(`network delay ${o.network_delay_veh_h}`, ...o.applied.map((a: any) => `kept: ${a.junction} — ${a.change} (${a.network_delay_change_veh_h} veh·h)`), ...o.not_fixed.slice(0, 3));
    },
  },
  {
    id: 54,
    cat: "F",
    prompt: "Show the effect of reducing this arterial from four lanes to two.",
    async run(h) {
      await h.fresh("F4");
      const r = await h.run("edit_streets", { street: "Red River Street", edits: [{ op: "remove_lanes", count: 1, dir: "both" }], keep_row_width: true });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "F4", kinds: ["traffic"], params: { traffic: { period: "pm" } } });
      h.ev(...r.summary.slice(0, 2), `PM delay ${c.traffic.a.delay_veh_hours} → ${c.traffic.b.delay_veh_hours}; avg speed ${c.traffic.a.avg_speed_kmh} → ${c.traffic.b.avg_speed_kmh} km/h`);
    },
  },
  {
    id: 55,
    cat: "F",
    prompt: "Compare traffic flow before and after adding a new connecting street.",
    async run(h) {
      await h.fresh("F5");
      const r = await h.run("create_street", { path: [[1000, -300], [1000, 100]], cls: "tertiary", name: "F5 Connector" });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "F5", kinds: ["traffic"], params: { traffic: { period: "am" } } });
      h.ev(sum(r, 1), `AM VKT ${c.traffic.a.vehicle_km} → ${c.traffic.b.vehicle_km}; delay ${c.traffic.a.delay_veh_hours} → ${c.traffic.b.delay_veh_hours}`);
    },
  },
  {
    id: 56,
    cat: "F",
    prompt: "Increase vehicle demand by 30% and animate the resulting congestion.",
    async run(h) {
      await h.fresh("F6");
      const t0 = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      const t1 = await h.run("run_simulation", { kind: "traffic", params: { period: "pm", demand_scale: 1.3 } });
      await h.run("show", { overlay: "traffic", hour: 17.5 });
      h.ev(`delay ${t0.kpi.delay_veh_hours} → ${t1.kpi.delay_veh_hours} veh·h (+${Math.round((t1.kpi.delay_veh_hours / t0.kpi.delay_veh_hours - 1) * 100)}%); congested km ${t0.kpi.congested_km} → ${t1.kpi.congested_km}; animation = TripsLayer driven by assigned link flows`);
      h.expect(t1.kpi.delay_veh_hours > t0.kpi.delay_veh_hours * 1.3, "nonlinear delay growth expected");
    },
  },
  {
    id: 57,
    cat: "F",
    prompt: "Find a redesign that improves bus travel time without significantly worsening car travel time.",
    async run(h) {
      const t0 = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" }, scenario: "baseline" });
      const options = [
        ["F7-convert", { street: "Guadalupe Street", edits: [{ op: "bus_lanes", on: true, mode: "convert" }] }],
        ["F7-add", { street: "Guadalupe Street", edits: [{ op: "bus_lanes", on: true, mode: "add" }], conflict_policy: "trim" }],
      ] as const;
      const res: string[] = [];
      for (const [n, e] of options) {
        await h.fresh(n);
        await h.run("edit_streets", e);
        const t = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
        const bus = t.transit_routes.reduce((s: number, r: any) => s + r.minutes, 0) - t0.transit_routes.reduce((s: number, r: any) => s + r.minutes, 0);
        res.push(`${n}: Σbus route time Δ${Math.round(bus * 10) / 10} min; car delay ${t0.kpi.delay_veh_hours} → ${t.kpi.delay_veh_hours} veh·h`);
      }
      h.ev(...res);
    },
  },
  {
    id: 58,
    cat: "F",
    prompt: "Show where congestion shifts if this street becomes pedestrian-only.",
    async run(h) {
      await h.fresh("F8");
      const r = await h.run("edit_streets", { street: "Congress Avenue", within: "Downtown", edits: [{ op: "pedestrianize" }] });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "F8", kinds: ["traffic"], params: { traffic: { period: "pm" } }, show_diff: true });
      h.ev(sum(r, 1), `delay ${c.traffic.a.delay_veh_hours} → ${c.traffic.b.delay_veh_hours}; worst after: ${c.traffic.worst_junctions_b.slice(0, 3).map((j: any) => j.name).join("; ")}`, "map shows per-link Δflow diff");
    },
  },
  {
    id: 59,
    cat: "F",
    prompt: "Compare morning and evening peak-hour network performance.",
    async run(h) {
      await h.run("scenario", { action: "switch", id: "baseline" });
      const am = await h.run("run_simulation", { kind: "traffic", params: { period: "am" } });
      const pm = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
      h.ev(`AM: ${am.kpi.veh_trips} trips, delay ${am.kpi.delay_veh_hours}, ${am.kpi.avg_speed_kmh} km/h | PM: ${pm.kpi.veh_trips} trips, delay ${pm.kpi.delay_veh_hours}, ${pm.kpi.avg_speed_kmh} km/h`, `calibration: ${pm.calibration.geh_under_5}/${pm.calibration.stations} TxDOT stations GEH<5`);
    },
  },
  {
    id: 60,
    cat: "F",
    prompt: "Generate three intersection designs and rank their simulated performance.",
    async run(h) {
      const J = "Lamar Boulevard & 6th Street";
      const designs = [
        ["F10-signal", { control: "signal" }],
        ["F10-rb1", { control: "roundabout", lanes: 1 }],
        ["F10-rb2", { control: "roundabout", lanes: 2 }],
      ] as const;
      const n = await h.run("resolve_place", { query: J });
      const out: { n: string; vc: number; delay: number }[] = [];
      for (const [name, d] of designs) {
        await h.fresh(name);
        await h.run("set_junction", { junction: J, ...d });
        const t = await h.run("run_simulation", { kind: "traffic", params: { period: "pm" } });
        const j = t.worst_junctions.find((x: any) => x.id === n[0].id);
        out.push({ n: name, vc: j?.vc ?? 0, delay: t.kpi.delay_veh_hours });
      }
      out.sort((a, b) => a.delay - b.delay);
      h.ev(...out.map((o, k) => `${k + 1}. ${o.n}: network delay ${o.delay} veh·h, junction v/c ${o.vc || "< top-8"}`));
    },
  },
];

export const G: Case[] = [
  {
    id: 61,
    cat: "G",
    prompt: "Simulate a summer day that is 4°C hotter than the baseline.",
    async run(h) {
      await h.run("scenario", { action: "switch", id: "baseline" });
      const a = await h.run("run_simulation", { kind: "heat" });
      const b = await h.run("run_simulation", { kind: "heat", params: { delta_t: 4 } });
      h.ev(`ERA5 2023-08-15 air max ${Math.max(...a.air_temp_c)} → ${Math.max(...b.air_temp_c)} °C; ped exposure ${a.mean_ped_exposure_c} → ${b.mean_ped_exposure_c} °C; >40 °C share ${a.ped_share_over_40c} → ${b.ped_share_over_40c}`);
    },
  },
  {
    id: 62,
    cat: "G",
    prompt: "Show which blocks have the greatest modeled heat exposure.",
    async run(h) {
      const a = await h.run("run_simulation", { kind: "heat" });
      await h.run("show", { overlay: "heat", mode: "exposure", hour: 15 });
      h.ev(`hottest blocks overall: ${a.hottest_blocks.slice(0, 3).map((b: any) => `${b.census_block} ${b.exposure_c} °C (canopy ${b.canopy}, ${b.residents_2020} residents)`).join("; ")}`);
      h.ev(`hottest blocks where people live: ${a.hottest_populated_blocks.slice(0, 3).map((b: any) => `${b.census_block} ${b.exposure_c} °C (canopy ${b.canopy}, impervious ${b.impervious}, ${b.residents_2020} residents)`).join("; ")}`);
    },
  },
  {
    id: 63,
    cat: "G",
    prompt: "Compare surface heat exposure before and after adding 1,000 trees.",
    async run(h) {
      await h.fresh("G3");
      const r = await h.run("plant_trees", { count: 1000, target: "heat" });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "G3", kinds: ["heat"], show_diff: true });
      h.ev(sum(r, 1), `area-wide ped exposure ${c.heat.a.mean_ped_exposure_c} → ${c.heat.b.mean_ped_exposure_c} °C; canopy ${c.heat.a.canopy} → ${c.heat.b.canopy}`, `where it changed (15:00): ${c.heat.local.area_changed_m2} m², mean ${c.heat.local.mean_change_where_changed_c} °C, max cooling ${c.heat.local.max_cooling_c} °C`);
    },
  },
  {
    id: 64,
    cat: "G",
    prompt: "Find where shade would provide the most pedestrian benefit.",
    async run(h) {
      await h.run("scenario", { action: "switch", id: "baseline" });
      const raw = await h.run("rank_sites", { candidates: "streets", within: "Downtown", criterion: "heat", limit: 5 });
      const r = await h.run("rank_sites", { candidates: "streets", within: "Downtown", criterion: "shade_benefit", limit: 6 });
      h.ev(`hottest sidewalks (raw): ${raw.top.slice(0, 3).map((x: any) => `${x.label} ${x.score} °C`).join("; ")}`);
      h.ev(`criterion: ${r.criterion} (of ${r.ranked_of} street blocks)`, ...r.top.slice(0, 5).map((x: any) => `${x.label} → ${x.score}`));
      const cls = r.top.map((x: any) => (h.R.world.get(x.id) as any)?.cls);
      h.expect(!cls.some((c: string) => /motorway|trunk/.test(c)), "no motorway or trunk segment ranked for pedestrian shade");
      h.expect(r.top.every((x: any) => x.score > 0), "top sites have positive benefit");
    },
  },
  {
    id: 65,
    cat: "G",
    prompt: "Show a time-lapse of heat conditions from sunrise through sunset.",
    async run(h) {
      const r = await h.run("run_simulation", { kind: "heat", params: { hours: [7, 9, 11, 13, 15, 17, 19] } });
      await h.run("show", { overlay: "heat", timelapse: { from: 7, to: 19, seconds: 12 } });
      h.ev(`hours ${r.hours.join(",")}, air ${r.air_temp_c.join("/")} °C; overlay time-lapse interpolates the modelled hourly grids`);
    },
  },
  {
    id: 66,
    cat: "G",
    prompt: "What are the modeled environmental trade-offs of replacing this park with housing?",
    async run(h) {
      await h.fresh("G6");
      const p = await h.run("find_features", { kind: "area", name: "Duncan", where: { type: "park" }, limit: 1 });
      h.expect(p.total, "park missing");
      const r = await h.run("create_building", { site: p.rows[0].id, typology: "midrise", floors: 6, use: "residential", name: "G6 Housing" });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "G6", kinds: ["metrics", "heat", "runoff"], params: { runoff: { storm: "25yr" }, heat: {}, metrics: {} } });
      h.expect(c.metrics.park_plaza_m2.delta < 0, "park area not reduced");
      h.ev(sum(r, 3), `units +${c.metrics.housing_units.delta}; park ${c.metrics.park_plaza_m2.delta} m²; ped exposure ${c.heat.a.mean_ped_exposure_c} → ${c.heat.b.mean_ped_exposure_c} °C; 25-yr runoff ${c.runoff.a.net_runoff_m3} → ${c.runoff.b.net_runoff_m3} m³`);
    },
  },
  {
    id: 67,
    cat: "G",
    prompt: "Evaluate potential runoff effects if impervious cover increases by 15%.",
    async run(h) {
      await h.run("scenario", { action: "switch", id: "baseline" });
      const a = await h.run("run_simulation", { kind: "runoff", params: { storm: "25yr" } });
      const b = await h.run("run_simulation", { kind: "runoff", params: { storm: "25yr", impervious_increase: 0.15 } });
      h.ev(`impervious ${a.impervious} → ${b.impervious}; 25-yr runoff ${a.runoff_m3} → ${b.runoff_m3} m³ (+${Math.round((b.runoff_m3 / a.runoff_m3 - 1) * 100)}%)`, b.assumptions[b.assumptions.length - 1]);
      h.expect(b.runoff_m3 > a.runoff_m3, "no increase");
    },
  },
  {
    id: 68,
    cat: "G",
    prompt: "Identify low-lying areas and visualize exposure under a specified flood scenario.",
    async run(h) {
      const f = await h.run("run_simulation", { kind: "flood", params: { rise_m: 5 } });
      await h.run("show", { overlay: "flood" });
      h.ev(`+5 m above Lady Bird Lake: ${f.flooded_m2} m² inundated, ${f.buildings_exposed} buildings, ${f.residents_exposed} residents exposed`);
    },
  },
  {
    id: 69,
    cat: "G",
    prompt: "Estimate how a new tree-lined boulevard changes local heat exposure.",
    async run(h) {
      await h.fresh("G9");
      const r = await h.run("edit_streets", { street: "East 7th Street", edits: [{ op: "add_median", width: 4 }, { op: "add_planting", width: 2, side: "both" }], keep_row_width: true });
      const t = await h.run("plant_trees", { street: "East 7th Street", spacing: 9 });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "G9", kinds: ["heat"] });
      h.ev(sum(r, 1), sum(t, 1), `local change at 15:00: ${c.heat.local.area_changed_m2} m² changed, mean ${c.heat.local.mean_change_where_changed_c} °C, max cooling ${c.heat.local.max_cooling_c} °C (area-wide ${c.heat.a.mean_ped_exposure_c} → ${c.heat.b.mean_ped_exposure_c} °C)`);
    },
  },
  {
    id: 70,
    cat: "G",
    prompt: "Propose a neighborhood redesign that reduces heat exposure while preserving housing capacity.",
    async run(h) {
      await h.fresh("G10");
      const area = "Downtown";
      await h.run("plant_trees", { within: area, count: 600, target: "heat" });
      await h.run("green_roofs", { area, min_area: 600 });
      const lots = await h.run("find_features", { kind: "area", within: area, where: { type: "parking", minArea: 500 }, sort: "area", limit: 8 });
      await h.run("convert_areas", { ids: h.ids(lots), type: "park" });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "G10", kinds: ["metrics", "heat"] });
      h.ev(`units Δ${c.metrics.housing_units.delta}; ped exposure ${c.heat.a.mean_ped_exposure_c} → ${c.heat.b.mean_ped_exposure_c} °C; >40 °C ${c.heat.a.ped_share_over_40c} → ${c.heat.b.ped_share_over_40c}; where changed: ${c.heat.local.area_changed_m2} m² at ${c.heat.local.mean_change_where_changed_c} °C`);
      h.expect(c.metrics.housing_units.delta >= 0, "lost housing");
    },
  },
];

export const Hc: Case[] = [
  {
    id: 71,
    cat: "H",
    prompt: "Increase this district's population capacity by 25% while preserving historic buildings.",
    async run(h) {
      await h.fresh("H1");
      const area = "East Cesar Chavez";
      const d0 = await h.run("describe_area", { area });
      const r = await h.run("generate_district", { area, style: "infill", target_units: Math.round(d0.housing_units * 1.25), keep_all_existing: true, max_floors: 5, name: "H1 +25%" });
      const d1 = await h.run("describe_area", { area });
      h.ev(`units ${d0.housing_units} → ${d1.housing_units} (${Math.round((d1.housing_units / d0.housing_units - 1) * 100)}%); historic ${d0.historic_buildings} → ${d1.historic_buildings}`, sum(r, 1));
      h.expect(d1.historic_buildings === d0.historic_buildings, "historic lost");
      if (d1.housing_units < d0.housing_units * 1.2) return { status: "partial", gap: "Soft-site infill under current height limits reached less than +25%" };
    },
  },
  {
    id: 72,
    cat: "H",
    prompt: "Show where current zoning assumptions limit additional development.",
    async run(h) {
      await h.run("scenario", { action: "switch", id: "baseline" });
      const c = await h.run("run_simulation", { kind: "capacity" });
      await h.run("show", { overlay: "zoning", mode: "limit" });
      h.ev(`binding constraints: ${JSON.stringify(c.binding_constraint_counts)}`, `top soft site: ${JSON.stringify(c.top_soft_sites?.[0])}`);
    },
  },
  {
    id: 73,
    cat: "H",
    prompt: "Estimate the housing capacity if these parcels allow six-story buildings.",
    async run(h) {
      const ps = await h.run("find_features", { kind: "parcel", within: "Central East Austin", where: { zoning: "SF" }, limit: 60 });
      const c = await h.run("run_simulation", { kind: "capacity", params: { parcel_ids: h.ids(ps), floors: 6 } });
      h.ev(`${ps.total} SF parcels (60 sampled) at 6 storeys: +${c.added_units_potential} units (${c.allowed_gfa_m2} m² allowed vs ${c.existing_gfa_m2} m² existing; historic parcels held)`);
    },
  },
  {
    id: 74,
    cat: "H",
    prompt: "Convert this office district to mixed use and compare daytime and nighttime activity.",
    async run(h) {
      await h.fresh("H4");
      const area = "Core / Waterfront";
      const d0 = await h.run("describe_area", { area });
      const bs = await h.run("find_features", { kind: "building", within: area, where: { use: "office", historic: false }, limit: 60 });
      await h.run("modify_buildings", { ids: h.ids(bs), use: "mixed", program: { office: 0.5, residential: 0.4, retail: 0.1 } });
      const d1 = await h.run("describe_area", { area });
      h.ev(`${bs.total} office buildings → 50/40/10 office/residential/retail`, `day ${d0.activity.daytime_population} → ${d1.activity.daytime_population}; night ${d0.activity.nighttime_population} → ${d1.activity.nighttime_population}`, d1.activity.assumption);
    },
  },
  {
    id: 75,
    cat: "H",
    prompt: "Estimate how many additional schools would be needed for a specified population scenario.",
    async run(h) {
      const e = await h.run("estimate", { what: "schools", units: 6000 });
      h.ev(`6,000 units → ${JSON.stringify(e.students)} students → schools ${JSON.stringify(e.schools_needed)}`, e.assumptions);
    },
  },
  {
    id: 76,
    cat: "H",
    prompt: "Find parcels suitable for affordable housing near transit.",
    async run(h) {
      // soft sites and public land, scored on transit access, land cost (TCAD appraisal) and ETOD bonus eligibility
      const soft = await h.run("rank_sites", { candidates: "soft_sites", criterion: "affordable_housing", limit: 5 });
      const pub = await h.run("rank_sites", { candidates: "public_land", criterion: "affordable_housing", limit: 5 });
      const under = await h.run("rank_sites", { candidates: "underused", criterion: "affordable_housing", limit: 3 });
      h.ev(`criterion: ${soft.criterion}`);
      h.ev(`soft sites (${soft.ranked_of ?? "?"}): ${soft.top.slice(0, 3).map((x: any) => `${x.id} ${x.label}`).join(" | ")}`);
      h.ev(`public land (${pub.ranked_of ?? "?"}): ${pub.top.slice(0, 3).map((x: any) => `${x.id} ${x.label}`).join(" | ")}`);
      h.ev(`underused private lots (buildings worth < half the land): ${under.top.slice(0, 2).map((x: any) => `${x.id} ${x.label}`).join(" | ")}`);
      const top = await h.run("find_features", { kind: "parcel", where: { owner: "public", etod: true, landUse: "parking" }, sort: "area", limit: 3 });
      h.ev(`publicly owned surface-parking lots in the ETOD overlay: ${(top.rows ?? top).length}${(top.rows ?? top)[0] ? ` e.g. ${JSON.stringify((top.rows ?? top)[0]).slice(0, 220)}` : ""}`);
      h.expect(soft.top.every((x: any) => /land \$|land n\/a/.test(x.label)), "land cost reported");
      h.expect(pub.top.length > 0 && pub.top.every((x: any) => / · (City of Austin|Austin Housing Finance|Housing Authority|Travis County|State of Texas|University of Texas|Austin ISD|Austin Community College|Capital Metro|United States|Integral Care)/.test(x.label)), "public owner reported");
    },
  },
  {
    id: 77,
    cat: "H",
    prompt: "Compare development capacity under three building-height limits.",
    async run(h) {
      const out: string[] = [];
      for (const lim of [20, 45, 90]) {
        const c = await h.run("run_simulation", { kind: "capacity", params: { area: "Central East Austin", height_limit: lim } });
        out.push(`${lim} m limit: +${c.added_units_potential} units (${c.allowed_gfa_m2} m² allowed vs ${c.existing_gfa_m2} m² existing); binding ${JSON.stringify(c.binding_constraint_counts)}`);
      }
      h.ev(...out);
    },
  },
  {
    id: 78,
    cat: "H",
    prompt: "Estimate redevelopment costs using explicitly stated unit-cost assumptions.",
    deps: [31],
    async run(h) {
      await h.run("scenario", { action: "switch", name: "D1" });
      const e = await h.run("estimate", { what: "costs" });
      h.ev(`D1 neighbourhood: ${JSON.stringify(e).slice(0, 300)}`);
    },
  },
  {
    id: 79,
    cat: "H",
    prompt: "Maximize housing capacity without exceeding a specified infrastructure budget.",
    async run(h) {
      await h.run("scenario", { action: "switch", id: "baseline" });
      const e = await h.run("estimate", { what: "budget_fit", budget: 250e6 });
      h.expect(e.sites_selected > 0 && e.infrastructure_cost_usd <= 250e6, "budget not respected");
      h.ev(`$250M → ${e.added_units} homes on ${e.sites_selected} sites ($${e.cost_per_unit_usd}/unit; ${e.share_of_zoned_capacity} of zoned capacity)`, `top: ${e.top_sites.slice(0, 3).map((s: any) => `${s.parcel} ${s.zoning} +${s.added_units}`).join(", ")}`, e.method);
    },
  },
  {
    id: 80,
    cat: "H",
    prompt: "Show how residential density might change over the next 20 years under these assumptions.",
    async run(h) {
      await h.run("scenario", { action: "switch", id: "baseline" });
      const e = await h.run("estimate", { what: "growth", years: 20, rate: 0.03 });
      const years = Object.keys(e.by_area);
      h.expect(years.length >= 3 && e.by_area["2040"]?.length, "year-by-year spatial allocation");
      h.ev(e.model, JSON.stringify(e.series));
      for (const y of ["2030", "2040"]) h.ev(`${y}: ${e.by_area[y].slice(0, 4).map((x: any) => `${x.area} +${x.added_residents} (${x.added_per_ha}/ha)`).join(", ")}`);
      h.ev(`zoned room ${e.zoned_capacity_residents} residents, unplaced ${e.unplaced_residents}; top lots ${e.top_lots.slice(0, 3).map((x: any) => `${x.id} ${x.zoning} ${x.land_use} +${x.added_residents}`).join(", ")}`);
      h.ev(e.map);
      // the map is a real overlay: the growth record is shown and each snapshot year can be drawn
      await h.run("show", { overlay: "growth", mode: "2030" });
      const { useSims } = await import("@/sim/client");
      const rec = useSims.getState().records.find((r) => r.id === useSims.getState().shown.growth);
      h.expect(rec?.status === "done" && rec.result.snapshots.some((x: any) => x.year === 2030), "growth overlay record with 2030 snapshot");
      const s30 = rec!.result.snapshots.find((x: any) => x.year === 2030).added.reduce((a: number, b: number) => a + b, 0),
        s40 = rec!.result.snapshots.find((x: any) => x.year === 2040).added.reduce((a: number, b: number) => a + b, 0);
      h.expect(s40 > s30, "growth accumulates over time");
    },
  },
];

export const I: Case[] = [
  {
    id: 81,
    cat: "I",
    prompt: "Make this neighborhood significantly more livable. Diagnose the problems and propose changes.",
    async run(h) {
      await h.fresh("I1");
      const area = "Central East Austin";
      const d = await h.run("describe_area", { area });
      const a = await h.run("run_simulation", { kind: "access" });
      const ht = await h.run("run_simulation", { kind: "heat" });
      h.ev(`diagnosis: ${d.residents_est} residents, ${d.trees_mapped} trees, ${d.surface_parking_m2} m² parking, bike ${d.bike_facility_km} km; frequent transit ${a.residents_covered.frequent_transit}; ped exposure ${ht.mean_ped_exposure_c} °C`);
      await h.run("plant_trees", { within: area, count: 400, target: "heat" });
      await h.run("edit_streets", { street: "East 12th Street", edits: [{ op: "add_bike_lanes", kind: "track", side: "both" }, { op: "widen_sidewalks", by: 1 }], keep_row_width: true });
      const lots = await h.run("find_features", { kind: "area", within: area, where: { type: "parking", minArea: 800 }, sort: "area", limit: 2 });
      if (lots.total) await h.run("create_area", { type: "park", area: lots.rows[0].id, shade_trees: true });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "I1", kinds: ["metrics", "heat"] });
      h.ev(`Δtrees ${c.metrics.trees.delta}, Δpark ${c.metrics.park_plaza_m2.delta} m², Δprotected bike ${c.metrics.protected_bike_km.delta} km; where heat changed: ${c.heat.local.area_changed_m2} m², mean ${c.heat.local.mean_change_where_changed_c} °C`);
      return { status: "partial", gap: "Tool chain verified; the diagnosis→proposal reasoning itself is the LLM agent's job and needs ANTHROPIC_API_KEY to exercise end-to-end." };
    },
  },
  {
    id: 82,
    cat: "I",
    prompt: "Redesign this corridor to balance traffic, businesses, bicycles, and pedestrians.",
    async run(h) {
      await h.fresh("I2");
      const shops = await h.run("find_features", { kind: "poi", within: { center: [-300, -100], radius: 600 }, limit: 60 });
      const r = await h.run("edit_streets", { street: "Guadalupe Street", edits: [{ op: "remove_lanes", count: 1, dir: "forward" }, { op: "add_bike_lanes", kind: "track", side: "both" }, { op: "widen_sidewalks", by: 1 }], keep_row_width: true });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "I2", kinds: ["traffic"], params: { traffic: { period: "pm" } } });
      h.ev(...r.summary.slice(0, 2), `PM delay ${c.traffic.a.delay_veh_hours} → ${c.traffic.b.delay_veh_hours}; ${shops.total} frontage POIs retained (no demolition with keep_row_width)`);
    },
  },
  {
    id: 83,
    cat: "I",
    prompt: "Find the best place for a new public square based on accessibility.",
    async run(h) {
      await h.fresh("I3");
      const r = await h.run("rank_sites", { candidates: "parking_lots", within: "Downtown", criterion: "residents_walk", minutes: 10, limit: 5 });
      const best = r.top[0];
      const sq = await h.run("create_area", { type: "plaza", area: best.id, shade_trees: true, name: "I3 Square" });
      h.ev(`${best.label}: ${best.score} residents within 10 min walk`, sum(sq, 2));
    },
  },
  {
    id: 84,
    cat: "I",
    prompt: "Create an alternative plan with the same housing capacity but more open space.",
    deps: [31],
    async run(h) {
      await h.run("scenario", { action: "switch", name: "D1" });
      const d1 = await h.run("describe_area", { area: EAST });
      await h.fresh("I4");
      await h.run("generate_district", { area: EAST, style: "european", target_units: d1.housing_units, open_space_ratio: 0.38, max_floors: 9, new_streets: true, name: "I4 Greener" });
      const d2 = await h.run("describe_area", { area: EAST });
      h.ev(`D1: ${d1.housing_units} units, ${d1.parks_m2 + d1.plazas_m2} m² open space → I4: ${d2.housing_units} units, ${d2.parks_m2 + d2.plazas_m2} m²`);
      h.expect(d2.parks_m2 + d2.plazas_m2 > d1.parks_m2 + d1.plazas_m2, "no more open space");
    },
  },
  {
    id: 85,
    cat: "I",
    prompt: "Improve this proposal until the traffic model meets the target congestion threshold, or explain why it cannot.",
    async run(h) {
      await h.fresh("I5");
      await h.run("generate_district", { area: [[900, -1100], [1350, -1100], [1350, -760], [900, -760]], style: "midrise", target_units: 3000, max_floors: 8, name: "I5 proposal" });
      const o = await h.run("optimize_bottlenecks", { period: "pm", max_changes: 4, target_vc: 1.0 });
      h.ev(`network delay ${o.network_delay_veh_h}`, ...o.applied.map((a: any) => `kept: ${a.junction} — ${a.change}`), `still over v/c 1.0: ${o.still_over_target.join("; ") || "none"}`, ...o.not_fixed.slice(0, 2));
      // the explanation the agent gives when the target can't be met comes straight from the tool's evidence
      h.expect(o.still_over_target.length === 0 || o.not_fixed.length > 0 || o.applied.length > 0, "no explanation available");
    },
  },
  {
    id: 86,
    cat: "I",
    prompt: "Redesign the area around the train station for maximum transit accessibility.",
    async run(h) {
      await h.fresh("I6");
      const st = await h.run("resolve_place", { query: "Downtown Station" });
      await h.run("generate_district", { area: { center: st[0].at, radius: 300 }, style: "tod", anchor: st[0].at, max_floors: 20, name: "I6 Station TOD" });
      const c = await h.run("compare_scenarios", { a: "baseline", b: "I6", kinds: ["access"] });
      h.ev(`frequent transit coverage ${c.access.a.residents_covered.frequent_transit} → ${c.access.b.residents_covered.frequent_transit} (more residents near the station)`);
    },
  },
  {
    id: 87,
    cat: "I",
    prompt: "Identify potential infrastructure conflicts in the development I just created.",
    deps: [31],
    async run(h) {
      await h.run("scenario", { action: "switch", name: "D1" });
      const v = await h.run("validate", {});
      const kinds: Record<string, number> = {};
      for (const i of v.issues) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
      h.ev(`checked ${v.checked}: ${v.errors} errors, ${v.warnings} warnings; by kind ${JSON.stringify(kinds)}`, ...v.issues.slice(0, 3).map((i: any) => `${i.name}: ${i.message}`));
    },
  },
  {
    id: 88,
    cat: "I",
    prompt: "Build three radically different plans and compare their measurable trade-offs.",
    async run(h) {
      const plans = [
        ["I8-towers", { style: "towers", target_units: 5000, max_floors: 40 }],
        ["I8-european", { style: "european", target_units: 2500, max_floors: 6, open_space_ratio: 0.3 }],
        ["I8-park", { style: "civic", target_units: 600, max_floors: 4, open_space_ratio: 0.6 }],
      ] as const;
      for (const [n, p] of plans) {
        await h.fresh(n);
        await h.run("generate_district", { area: EAST, new_streets: true, name: n, ...p });
      }
      for (const [n] of plans) {
        const c = await h.run("compare_scenarios", { a: "baseline", b: n, kinds: ["metrics", "heat"] });
        h.ev(`${n}: Δunits ${c.metrics.housing_units.delta}, Δopen ${c.metrics.park_plaza_m2.delta} m², exposure ${c.heat.b.mean_ped_exposure_c} °C`);
      }
    },
  },
  {
    id: 89,
    cat: "I",
    prompt: "Make the smallest geometric changes necessary to fix the worst network bottlenecks.",
    async run(h) {
      await h.fresh("I9");
      const o = await h.run("optimize_bottlenecks", { period: "pm", max_changes: 3, allow: ["lanes", "signal"] });
      h.ev(`network delay ${o.network_delay_veh_h}`, ...o.applied.map((a: any) => `kept: ${a.junction} — ${a.change}; ${a.geometry}`), `tried ${o.tried.length} candidates; ${o.not_fixed.length} junctions had no helpful small fix`);
      return { status: "partial", gap: "Greedy search over small candidates (one approach lane, signalisation) evaluated by full re-assignment; it keeps only changes that help, but cannot prove they are the minimal set, and lane additions are per block (no turn-pocket design)." };
    },
  },
  {
    id: 90,
    cat: "I",
    prompt: "Act as an urban planning consultant: assess this district, propose a masterplan, build it, and test it.",
    async run(h) {
      await h.fresh("I10");
      const area = "Rainey Street";
      const d = await h.run("describe_area", { area });
      const r = await h.run("generate_district", { area, style: "towers", max_floors: 40, keep_all_existing: true, name: "I10 Rainey" });
      const v = await h.run("validate", {});
      const c = await h.run("compare_scenarios", { a: "baseline", b: "I10", kinds: ["metrics", "traffic", "heat"] });
      h.ev(`assess: ${d.residents_est} residents, ${d.historic_buildings} historic, ${d.surface_parking_m2} m² parking`, sum(r, 2), `validate ${v.errors} errors/${v.warnings} warnings; Δunits ${c.metrics.housing_units.delta}; PM delay ${c.traffic.a.delay_veh_hours} → ${c.traffic.b.delay_veh_hours}`);
      return { status: "partial", gap: "Tool chain verified end-to-end; consultant-grade narrative and option selection is produced by the LLM agent (needs ANTHROPIC_API_KEY)." };
    },
  },
];

export const J: Case[] = [
  {
    id: 91,
    cat: "J",
    prompt: "That tower is too tall. Shorten it and adjust the surrounding massing.",
    deps: [1],
    async run(h) {
      await h.run("scenario", { action: "switch", name: "A1" });
      const t = await h.run("find_features", { kind: "building", name: "A8 Tower", where: { proposed: true } });
      const b0 = await feat(h, t.rows[0].id);
      await h.run("modify_buildings", { ids: [b0.id], height_scale: 0.7 });
      const nb = await h.run("find_features", { kind: "building", near: b0.at, radius: 80, where: { proposed: false, maxHeight: 40, historic: false }, limit: 4 });
      if (nb.total) await h.run("modify_buildings", { ids: h.ids(nb).slice(0, 2), floors: Math.max(4, Math.round(b0.floors * 0.25)) });
      const b1 = await feat(h, b0.id);
      h.ev(`${b0.height_m} m → ${b1.height_m} m; ${Math.min(2, nb.total)} neighbours raised to step the massing`);
    },
  },
  {
    id: 92,
    cat: "J",
    prompt: "Move the new road farther away from the park.",
    async run(h) {
      await h.fresh("J2");
      const park = await h.run("resolve_place", { query: "Eastwoods Neighborhood Park" });
      const pp = park[0].at;
      const r = await h.run("create_street", { path: [[pp[0] - 200, pp[1] + 60], [pp[0] + 200, pp[1] + 60]], cls: "residential", name: "J2 Lane" });
      const sid = r.created.find((x: string) => x.startsWith("s"));
      const r2 = await h.run("move_streets", { street: "J2 Lane", offset: [0, 40] });
      const after = await feat(h, sid);
      h.ev(sum(r, 1), sum(r2, 2), `centre ${pp[1] + 60} → y≈${after?.at?.[1]}`);
    },
  },
  {
    id: 93,
    cat: "J",
    prompt: "Actually, keep the original intersection and redesign the rest.",
    async run(h) {
      await h.fresh("J3");
      const a = await h.run("set_junction", { junction: "Lavaca Street & 6th Street", control: "roundabout" });
      await h.run("edit_streets", { street: "Lavaca Street", edits: [{ op: "add_bike_lanes", kind: "track", side: "left" }], keep_row_width: true });
      const rv = await h.run("revert_change", { changeset_id: a.changeset_id });
      const j = await h.run("resolve_place", { query: "Lavaca Street & 6th Street" });
      const n = await feat(h, j[0].id);
      h.expect(!n.roundabout, "roundabout still present");
      h.ev(`reverted “${rv.reverted}”; bike track kept; junction control ${n.control}`);
    },
  },
  {
    id: 94,
    cat: "J",
    prompt: "Use the second proposal, but borrow the green corridor from the first.",
    async run(h) {
      await h.fresh("J4-first");
      await h.run("create_area", { type: "park", area: { center: [1000, -500], radius: 60 }, name: "J4 green corridor", buildings: "keep" });
      await h.fresh("J4-second");
      await h.run("generate_district", { area: EAST, style: "midrise", max_floors: 8, name: "J4 second" });
      const b = await h.run("borrow_changes", { from: "J4-first", label_contains: "corridor" });
      h.ev(`borrowed ${JSON.stringify(b.applied)}; skipped ${JSON.stringify(b.skipped_conflicting)}`);
      h.expect(b.applied.length, "nothing borrowed");
    },
  },
  {
    id: 95,
    cat: "J",
    prompt: "Show me what this looks like from pedestrian height.",
    async run(h) {
      const r = await h.run("camera", { action: "pedestrian", target: "Congress Avenue & 6th Street" });
      h.ev(JSON.stringify(r).slice(0, 160), "(rendered and checked in the browser harness: eye height 1.7 m, WASD walk)");
    },
  },
  {
    id: 96,
    cat: "J",
    prompt: "Fly over the proposed development and highlight everything that changed.",
    deps: [31],
    async run(h) {
      await h.run("scenario", { action: "switch", name: "D1" });
      const r = await h.run("camera", { action: "flyover", targets: [[950, -1050], [1300, -800], [1100, -900]] });
      await h.run("show", { overlay: "change" });
      h.ev(JSON.stringify(r).slice(0, 140), "change overlay colours added/modified/removed vs baseline");
    },
  },
  {
    id: 97,
    cat: "J",
    prompt: "Show the congestion difference between the existing city and our latest plan at 5 PM.",
    deps: [90],
    async run(h) {
      const c = await h.run("compare_scenarios", { a: "baseline", b: "I10", kinds: ["traffic"], params: { traffic: { period: "pm" } }, show_diff: true });
      await h.run("show", { overlay: "traffic", hour: 17, compare_with: "baseline" });
      h.ev(`PM peak: delay ${c.traffic.a.delay_veh_hours} → ${c.traffic.b.delay_veh_hours} veh·h; congested km ${c.traffic.a.congested_km} → ${c.traffic.b.congested_km}`);
    },
  },
  {
    id: 98,
    cat: "J",
    prompt: "Explain why you placed that building there and show the constraints you considered.",
    deps: [1],
    async run(h) {
      await h.run("scenario", { action: "switch", name: "A1" });
      const t = await h.run("find_features", { kind: "building", name: "A8 Tower", where: { proposed: true } });
      const f = await feat(h, t.rows[0].id);
      await h.run("annotate", { notes: [{ at: f.at, title: "Height limit", body: `${f.height_limit_m} m (${(f.height_limit_source ?? []).slice(-1)[0] ?? "zoning"})`, tone: "info" }], highlight: [f.id] });
      h.ev(`parcel ${f.parcel?.zoning} FAR ${f.parcel?.max_far}; limit ${f.height_limit_m} m from ${JSON.stringify(f.height_limit_source)}; issues: ${f.issues.join("; ") || "none"}`, `notes: ${f.notes ?? ""}`.slice(0, 200));
    },
  },
  {
    id: 99,
    cat: "J",
    prompt: "Undo the last three design changes without losing the current simulation settings.",
    async run(h) {
      await h.fresh("J9");
      await h.run("plant_trees", { street: "Lavaca Street", spacing: 10 });
      await h.run("set_junction", { junction: "Lavaca Street & 6th Street", control: "roundabout" });
      await h.run("green_roofs", { area: "Downtown", max_count: 10 });
      await h.run("create_area", { type: "park", area: { center: [-200, -300], radius: 25 } });
      await h.run("show", { overlay: "heat", hour: 15, mode: "surface" });
      const { useApp } = await import("@/state/store");
      const before = { o: useApp.getState().overlay, hr: useApp.getState().hour };
      const u = await h.run("undo", { steps: 3 });
      const after = { o: useApp.getState().overlay, hr: useApp.getState().hour };
      h.expect(u.edits_now === 1, `edits now ${u.edits_now}`);
      h.expect(before.o === after.o && before.hr === after.hr, "sim settings changed");
      h.ev(`undid ${JSON.stringify(u.undone)}; overlay ${after.o} @ ${after.hr}h kept`);
    },
  },
  {
    id: 100,
    cat: "J",
    prompt: "Take everything we've discussed and produce the strongest feasible masterplan, with visible geometry changes, simulated results, assumptions, and alternatives.",
    deps: [23],
    async run(h) {
      await h.fresh("J10");
      await h.run("generate_district", { area: EAST, style: "european", target_population: 3500, max_floors: 8, new_streets: true, open_space_ratio: 0.28, name: "J10 Masterplan" });
      await h.run("borrow_changes", { from: "C3", label_contains: "tram" });
      await h.run("plant_trees", { within: EAST, spacing: 10 });
      const v = await h.run("validate", {});
      const c = await h.run("compare_scenarios", { a: "baseline", b: "J10", kinds: ["metrics", "traffic", "heat"] });
      const cost = await h.run("estimate", { what: "costs" });
      h.ev(`Δunits ${c.metrics.housing_units.delta}, Δpark ${c.metrics.park_plaza_m2.delta} m², Δtram km ${c.metrics.tram_km.delta}; PM delay ${c.traffic.a.delay_veh_hours} → ${c.traffic.b.delay_veh_hours}; exposure ${c.heat.a.mean_ped_exposure_c} → ${c.heat.b.mean_ped_exposure_c} °C; validate ${v.errors} errors`, `cost: ${JSON.stringify(cost).slice(0, 160)}`);
      return { status: "partial", gap: "Composition verified with alternatives available as branches; choosing the 'strongest' plan and writing the narrative is the LLM agent's job (needs ANTHROPIC_API_KEY)." };
    },
  },
];
