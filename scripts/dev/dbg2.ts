import { loadWorld } from "./load";
import { polyCentroid } from "@/geometry/polygon";
import { prepareAccess, runAccess } from "@/sim/access";
import { programmeOf } from "@/world/ops/core";
const w = loadWorld();
const ps = w.all("parcel");
const by: Record<string, number> = {}; for (const p of ps) by[p.landUse] = (by[p.landUse] ?? 0) + 1;
console.log(by, "area quantiles", [0.1, 0.5, 0.9].map((q) => ps.map((p) => p.area).sort((a, b) => a - b)[Math.floor(ps.length * q)]));
const origins = w.all("building").filter((b) => programmeOf(b).units > 0.5).map((b) => ({ id: b.id, p: polyCentroid(b.footprint), w: programmeOf(b).residents }));
const ai = prepareAccess(w.entities.values(), origins);
console.log("walk nodes", ai.net.nodes.length, "links", ai.net.links.length, "dests", Object.fromEntries(Object.entries(ai.dests).map(([k, v]) => [k, v.length])));
const ac = runAccess(ai);
const m = ac.minutes.transit;
let inf = 0, infW = 0, totW = 0; origins.forEach((o, i) => { totW += o.w; if (!Number.isFinite(m[i])) { inf++; infW += o.w; } });
console.log("transit: infinite", inf, "of", origins.length, "weight share", (infW / totW).toFixed(3));
// connected components
const comp = new Int32Array(ai.net.nodes.length).fill(-1); let nc = 0; const sizes: number[] = [];
for (let s = 0; s < comp.length; s++) { if (comp[s] >= 0) continue; const st = [s]; comp[s] = nc; let sz = 0; while (st.length) { const v = st.pop()!; sz++; for (const li of ai.net.out[v]) { const b = ai.net.links[li].b; if (comp[b] < 0) { comp[b] = nc; st.push(b); } } } sizes.push(sz); nc++; }
console.log("components", nc, "largest", Math.max(...sizes), "sizes>10", sizes.filter((x) => x > 10).length);
const big = origins.slice().sort((a, b) => b.w - a.w).slice(0, 5).map((o) => { const i = origins.indexOf(o); return [o.id, Math.round(o.w), m[i]]; });
console.log(big);
{
  const i = origins.findIndex((o) => o.id === "b:w328839215");
  const o = ai.origins[i];
  console.log("origin node", o.node, "comp", comp[o.node], "pos", o.p, "node pos", ai.net.nodes[o.node]?.p, "out", ai.net.out[o.node]?.length);
  const { multiSource } = await import("@/sim/access");
  const d = multiSource(ai.net, [o.node], 100000);
  const reach = [...d].filter(Number.isFinite).length;
  console.log("reachable from origin", reach);
}
