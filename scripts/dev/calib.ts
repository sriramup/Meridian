import { loadWorld } from "./load";
import { programmeOf, buildingGFA } from "@/world/ops/core";
const w = loadWorld();
let units = 0, res = 0, gfa = 0, jobs = 0;
for (const b of w.all("building")) { const p = programmeOf(b, 1.75); units += p.units; jobs += p.jobs; gfa += p.gfa; if (b.use === "residential" || b.use === "mixed") res++; }
console.log({ buildings: w.count("building"), resLike: res, units: Math.round(units), jobs: Math.round(jobs), gfa: Math.round(gfa), census: w.meta.calibration });
const top = w.all("building").sort((a, b) => buildingGFA(b) - buildingGFA(a)).slice(0, 8).map((b) => [b.name, b.use, Math.round(buildingGFA(b)), b.floors, b.height]);
console.log(top);
const byUse: Record<string, number> = {}; for (const b of w.all("building")) byUse[b.use] = (byUse[b.use] ?? 0) + 1; console.log(byUse);
