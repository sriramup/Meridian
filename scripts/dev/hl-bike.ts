import { loadHeadless } from "./headless";
loadHeadless();
const { executeTool } = await import("@/agent/tools");
const ctx = { requestApproval: async () => true, approvals: false };
const t = performance.now();
const r: any = await executeTool("run_simulation", { kind: "bike" }, ctx);
console.log((performance.now() - t).toFixed(0), "ms", JSON.stringify(r.content, null, 1).slice(0, 2500));
