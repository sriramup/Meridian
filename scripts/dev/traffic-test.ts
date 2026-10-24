import fs from "node:fs";
import { loadWorld } from "./load";
import { prepareTraffic } from "@/sim/prepareTraffic";
import { runTraffic } from "@/sim/traffic";
const w = loadWorld();
const ref = JSON.parse(fs.readFileSync("public/data/austin/reference.json", "utf8"));
for (const period of ["am", "pm"] as const) {
  let t = performance.now();
  const { input, net } = prepareTraffic(w.entities, w.meta, ref.counts, { period, demandScale: 1, iterations: 20 });
  const tp = performance.now() - t;
  t = performance.now();
  const r = runTraffic(input);
  console.log(period, "prep ms", tp.toFixed(0), "run ms", (performance.now() - t).toFixed(0), "links", net.links.length, "nodes", net.nodes.length, "zones", input.zones.length, "gateways", input.gateways.length, "counts", input.counts.length);
  console.log(" kpi", Object.fromEntries(Object.entries(r.kpi).map(([k, v]) => [k, Math.round(v * 1000) / 1000])));
  console.log(" worst nodes", JSON.stringify(r.nodes.slice(0,5).map(n=>[n.los,n.vc.toFixed(2)])));//, r.nodes.slice(0, 5).map((n) => [net.nodes[n.node].id, n.los, n.vc.toFixed(2), n.clv]));
  console.log(" calib", JSON.stringify(r.calibration));
  const top = [...r.flows].map((f, k) => [f, k]).sort((a, b) => b[0] - a[0]).slice(0, 6).map(([f, k]) => [net.links[k].name, Math.round(f), r.vc[k].toFixed(2)]);
  console.log(" top links", JSON.stringify(top));
  console.log(" routes", r.routes.slice(0, 4).map((x) => [x.ref, x.minutes.toFixed(1), x.freeMinutes.toFixed(1)]));
  console.log(" gateways calibrated", input.gateways.filter((g) => g.calibrated).map((g) => [g.name, Math.round(g.inbound), Math.round(g.outbound)]));
}
