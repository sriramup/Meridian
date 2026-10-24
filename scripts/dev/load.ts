import fs from "node:fs";
import { World } from "@/world/world";
import type { Entity } from "@/world/types";
export function loadWorld() {
  const meta = JSON.parse(fs.readFileSync("public/data/austin/meta.json", "utf8"));
  const w = JSON.parse(fs.readFileSync("public/data/austin/world.json", "utf8"));
  const util = JSON.parse(fs.readFileSync("public/data/austin/utilities.json", "utf8"));
  const world = new World(meta);
  const all: Entity[] = [...w.nodes, ...w.streets, ...w.buildings, ...w.areas, ...w.trees, ...w.parcels, ...w.stops, ...w.routes, ...w.paths, ...w.pois, ...w.places, ...util];
  world.load(all);
  world.takeDirty();
  return world;
}
export function dump(world: World, box: [number, number, number, number], file: string) {
  const out: any = { box, strips: [], nodes: [], marks: [], buildings: [], trees: [], areas: [] };
  for (const e of world.query(box, ["street"])) {
    const g = world.streetGeom.get(e.id)!;
    for (const s of g.strips) out.strips.push({ t: s.type, r: s.ring });
    for (const m of g.markings) out.marks.push(m);
  }
  for (const e of world.query(box, ["node"])) {
    const g = world.nodeGeom.get(e.id);
    if (!g) continue;
    if (g.carriageway) out.nodes.push({ t: g.plaza ? "plaza" : "carriageway", r: g.carriageway });
    for (const c of g.corners) out.nodes.push({ t: "corner", r: c });
    if (g.island) out.nodes.push({ t: "island", r: g.island });
    out.marks.push(...g.markings);
  }
  for (const e of world.query(box, ["building"])) out.buildings.push({ r: (e as any).footprint[0], p: !!(e as any).createdBy, h: (e as any).height });
  for (const e of world.query(box, ["tree"])) out.trees.push({ p: (e as any).p, r: (e as any).r, n: !!(e as any).createdBy });
  for (const e of world.query(box, ["area"])) out.areas.push({ t: (e as any).type, r: (e as any).poly[0] });
  fs.writeFileSync(file, JSON.stringify(out));
}
