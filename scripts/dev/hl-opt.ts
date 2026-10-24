import { loadHeadless } from "./headless";
loadHeadless();
const { executeTool } = await import("@/agent/tools");
const ctx = { requestApproval: async () => true, approvals: false };
const t = performance.now();
const r: any = await executeTool("optimize_bottlenecks", { period: "pm", max_changes: 3 }, ctx);
console.log(((performance.now() - t) / 1000).toFixed(1), "s", r.isError ? "ERR" : "", JSON.stringify(r.content, null, 1).slice(0, 3500));
