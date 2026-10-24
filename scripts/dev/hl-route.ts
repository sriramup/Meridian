import { loadHeadless } from "./headless";
loadHeadless();
const { executeTool } = await import("@/agent/tools");
const ctx = { requestApproval: async () => true, approvals: false };
const run = async (n: string, i: any) => { const t = performance.now(); const r: any = await executeTool(n, i, ctx); console.log(`\n${n} ${JSON.stringify(i).slice(0, 90)} ${(performance.now() - t).toFixed(0)} ms ${r.isError ? "ERR " + JSON.stringify(r.content) : ""}`); return r.content; };
for (const [mode, prefer] of [["walk", "shortest"], ["bike", "shortest"], ["bike", "low_stress"], ["drive", "shortest"]]) {
  const r = await run("find_route", { from: "Republic Square", to: "Waterloo Park", mode, prefer });
  if (r.legs) console.log(r.length_m, "m", r.minutes, "min", r.max_lts_on_route ?? "", r.legs.slice(0, 8).join(" → "));
}
const b = await run("run_simulation", { kind: "bike" });
console.log(JSON.stringify(b.km_by_lts), JSON.stringify(b.residents_within_15_min_by_bike.grocery));
