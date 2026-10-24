import { loadHeadless } from "./headless";
loadHeadless();
const { executeTool } = await import("@/agent/tools");
const ctx = { requestApproval: async () => true, approvals: false };
for (const k of ["heat", "sun"]) { const t = performance.now(); const r: any = await executeTool("run_simulation", { kind: k }, ctx); console.log(k, (performance.now() - t).toFixed(0), "ms", r.content.runtime_s, r.content.mean_ped_exposure_c ?? ""); }
