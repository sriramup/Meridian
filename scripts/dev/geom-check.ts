import fs from "node:fs";
import { World } from "@/world/world";
import type { Entity } from "@/world/types";
const meta = JSON.parse(fs.readFileSync("public/data/austin/meta.json", "utf8"));
const w = JSON.parse(fs.readFileSync("public/data/austin/world.json", "utf8"));
const world = new World(meta);
const all: Entity[] = [...w.nodes, ...w.streets, ...w.buildings, ...w.areas, ...w.trees, ...w.parcels, ...w.stops, ...w.routes, ...w.paths, ...w.pois, ...w.places];
let t = performance.now();
world.load(all);
console.log("load+geometry ms", (performance.now() - t).toFixed(0), "streets", world.streetGeom.size, "nodes", world.nodeGeom.size);
const [cx, cy, r] = process.argv.slice(2).map(Number);
const box = [cx - r, cy - r, cx + r, cy + r] as [number, number, number, number];
const out: any = { box, strips: [], nodes: [], marks: [], buildings: [] };
for (const e of world.query(box, ["street"])) {
  const g = world.streetGeom.get(e.id)!;
  for (const s of g.strips) out.strips.push({ t: s.type, r: s.ring });
  for (const m of g.markings) out.marks.push(m);
}
for (const e of world.query(box, ["node"])) {
  const g = world.nodeGeom.get(e.id);
  if (!g) continue;
  if (g.carriageway) out.nodes.push({ t: "carriageway", r: g.carriageway });
  for (const c of g.corners) out.nodes.push({ t: "corner", r: c });
  if (g.island) out.nodes.push({ t: "island", r: g.island });
  out.marks.push(...g.markings);
}
for (const e of world.query(box, ["building"])) out.buildings.push((e as any).footprint[0]);
fs.writeFileSync(process.env.OUT ?? "geom.json", JSON.stringify(out));
