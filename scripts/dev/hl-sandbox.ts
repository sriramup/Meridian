// Headless check that a city designed from scratch on the blank canvas runs every model.
import { loadHeadless } from "./headless";

(async () => {
  const R = loadHeadless("sandbox");
  const { executeTool } = await import("@/agent/tools");
  const ctx = { requestApproval: async () => true, approvals: false };
  const run = async (name: string, input: Record<string, unknown> = {}) => {
    const t = performance.now();
    const r: any = await executeTool(name, input, ctx);
    console.log(`${r.isError ? "✕" : "✓"} ${name} (${Math.round(performance.now() - t)} ms) ${r.display?.title ?? ""} — ${r.display?.detail ?? ""}`);
    if (r.isError) console.log("   ", JSON.stringify(r.content).slice(0, 400));
    return r.content;
  };
  // a 3 × 3 block grid: two avenues, local streets, a boulevard through the middle
  await run("create_street", { path: [[-450, 0], [450, 0]], cls: "secondary", name: "Main Boulevard" });
  for (const x of [-300, 0, 300]) await run("create_street", { path: [[x, -450], [x, 450]], cls: x === 0 ? "tertiary" : "residential", name: `${x === 0 ? "Centre" : x < 0 ? "West" : "East"} Street` });
  for (const y of [-300, 300]) await run("create_street", { path: [[-450, y], [450, y]], cls: "residential", name: `${y < 0 ? "South" : "North"} Street` });
  console.log("streets", R.world.all("street").length, "nodes", R.world.all("node").length);
  await run("generate_district", { area: [[-290, 10], [-10, 10], [-10, 290], [-290, 290]], style: "midrise", target_units: 400, new_streets: true, name: "North-west blocks" });
  await run("create_building", { site: [[20, 20], [140, 20], [140, 120], [20, 120]], typology: "tower_podium", floors: 18, use: "mixed", name: "Tower" });
  await run("create_building", { site: [[160, -140], [280, -140], [280, -20], [160, -20]], typology: "courtyard", floors: 5, use: "education", name: "School" });
  await run("create_area", { type: "park", area: [[-290, -290], [-10, -290], [-10, -10], [-290, -10]], name: "Central Park" });
  await run("plant_trees", { street: "Main Boulevard", spacing: 10 });
  await run("create_transit_route", { mode: "bus", waypoints: [[-450, 0], [450, 0]], name: "Line 1", headway: 10 });
  for (const kind of ["metrics", "traffic", "heat", "sun", "runoff", "access", "bike"]) {
    const c = await run("run_simulation", { kind });
    console.log("   ", JSON.stringify(c).slice(0, 300));
  }
  const d = await run("describe_area", { area: [[-450, -450], [450, -450], [450, 450], [-450, 450]] });
  console.log("   ", JSON.stringify(d).slice(0, 400));
})();
