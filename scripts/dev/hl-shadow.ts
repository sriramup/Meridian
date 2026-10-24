// sanity checks for raster shadow propagation: a courtyard building's courtyard and a tower's shadow direction
import { loadHeadless } from "./headless";
loadHeadless();
const { executeTool } = await import("@/agent/tools");
const ctx = { requestApproval: async () => true, approvals: false };
const run = async (n: string, i: any) => ((await executeTool(n, i, ctx)) as any).content;
const r = await run("create_building", { site: "p:244472", typology: "courtyard", floors: 5, use: "residential", name: "C" });
const f = (await run("get_feature", { ids: [r.created.find((x: string) => x.startsWith("b"))] }))[0];
for (const d of ["2026-06-21", "2026-12-21"]) {
  const c = await run("run_simulation", { kind: "sun", params: { date: d, area: { center: f.at, radius: 12 } } });
  const n = await run("run_simulation", { kind: "sun", params: { date: d, area: { center: [f.at[0], f.at[1] + 300], radius: 30 } } });
  console.log(d, "courtyard centre", c.area.mean_direct_sun_hours, "h; open ground 300 m north", n.area.mean_direct_sun_hours, "h");
}
// north side of the tallest tower should be shadier than its south side in winter
const t = (await run("find_features", { kind: "building", sort: "height", limit: 1 })).rows[0];
for (const [lab, dy] of [["north", 40], ["south", -40]] as const) {
  const s = await run("run_simulation", { kind: "sun", params: { date: "2026-12-21", area: { center: [t.at[0], t.at[1] + (dy as number)], radius: 8 } } });
  console.log(t.name, t.height_m, "m:", lab, "side", s.area.mean_direct_sun_hours, "h");
}
