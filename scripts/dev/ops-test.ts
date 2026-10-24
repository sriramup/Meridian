import { loadWorld, dump } from "./load";
import { ScenarioManager } from "@/world/scenarios";
import { editStreetSections, setNodeControl, createStreet } from "@/world/ops/streets";
import { createBuilding, modifyBuildings } from "@/world/ops/buildings";
import { generateDistrict } from "@/world/ops/district";
import type { Street, Building, Parcel } from "@/world/types";
import { polyCentroid } from "@/geometry/polygon";
const OUT = process.env.OUT!;
const world = loadWorld();
const sm = new ScenarioManager(world);
const count0 = world.entities.size;
const A = { author: "agent" as const };
const show = (label: string, r: any) => { console.log(`\n== ${label}: ok=${r.ok} ${r.error ?? ""}`); for (const s of r.report.summary) console.log("  •", s); for (const w of r.report.warnings) console.log("  ⚠", w); for (const c of r.report.conflicts.slice(0, 6)) console.log("  ✕", c.resolved ? "[resolved]" : "[open]", c.message); console.log(`  ops: +${r.created.length} ~${r.modified.length} -${r.removed.length}`); };
// 1. corridor: add one lane each direction on Lavaca Street
const lav = world.all("street").filter((s) => s.name === "Lavaca Street");
const c = polyCentroid([lav.flatMap((s) => s.path)]);
dump(world, [c[0] - 150, c[1] - 150, c[0] + 150, c[1] + 150], `${OUT}/t1a.json`);
let r: any = editStreetSections(world, { streetIds: lav.map((s) => s.id), edits: [{ op: "add_lanes", count: 1, dir: "both" }], policy: "trim" }, A);
show("Lavaca +1 lane each way", r);
if (r.ok) sm.commit(r.changeset);
dump(world, [c[0] - 150, c[1] - 150, c[0] + 150, c[1] + 150], `${OUT}/t1b.json`);
// 2. roundabout at a residential 4-way junction
const n4 = world.all("node").find((n) => world.incident(n.id).length === 4 && world.incident(n.id).every((s) => s.cls === "residential") && Math.abs(n.p[0] - 900) < 600);
r = setNodeControl(world, n4!.id, "roundabout", {}, A);
show("roundabout", r);
if (r.ok) sm.commit(r.changeset);
dump(world, [n4!.p[0] - 80, n4!.p[1] - 80, n4!.p[0] + 80, n4!.p[1] + 80], `${OUT}/t2.json`);
// 3. tower on the largest vacant parcel downtown
const vac = world.all("parcel").filter((p) => p.landUse === "vacant" || p.landUse === "parking").filter((p) => p.zoningBase === "CBD").sort((a, b) => b.area - a.area)[0] as Parcel;
r = createBuilding(world, { site: vac.poly, spec: { typology: "tower_podium", floors: 30, use: "mixed" }, name: "Test Tower" }, A);
show(`tower on ${vac.id} (${vac.area} m², ${vac.zoning})`, r);
if (r.ok) sm.commit(r.changeset);
const pc = polyCentroid(vac.poly);
dump(world, [pc[0] - 120, pc[1] - 120, pc[0] + 120, pc[1] + 120], `${OUT}/t3.json`);
// 4. 20% taller
r = modifyBuildings(world, { ids: [r.building.id], heightScale: 1.2 }, A);
show("20% taller", r);
if (r.ok) sm.commit(r.changeset);
// 5. new street across a block
const p0 = [c[0] + 350, c[1] - 300] as [number, number];
r = createStreet(world, { path: [[p0[0] - 120, p0[1]], [p0[0] + 120, p0[1] + 20]], cls: "residential", name: "Test Lane" }, A);
show("new street", r);
if (r.ok) sm.commit(r.changeset);
dump(world, [p0[0] - 160, p0[1] - 160, p0[0] + 160, p0[1] + 160], `${OUT}/t5.json`);
// 6. district
const ec = [1100, -900] as [number, number];
const area = [[[ec[0] - 200, ec[1] - 150], [ec[0] + 200, ec[1] - 150], [ec[0] + 200, ec[1] + 150], [ec[0] - 200, ec[1] + 150]]] as any;
let t = performance.now();
r = generateDistrict(world, { area, style: "european", targetPopulation: 3000, maxFloors: 7, newStreets: true, name: "Test Quarter" }, A);
show(`district (${(performance.now() - t).toFixed(0)} ms)`, r);
if (r.ok) sm.commit(r.changeset);
dump(world, [ec[0] - 260, ec[1] - 260, ec[0] + 260, ec[1] + 260], `${OUT}/t6.json`);
// undo everything and verify exact restoration
const n = sm.active.cursor;
t = performance.now();
sm.undo(n);
console.log(`\nundo ${n} changesets in ${(performance.now() - t).toFixed(0)} ms; entities ${count0} -> ${world.entities.size}`);
const b0 = sm.materialize("baseline");
let diff = 0; for (const [id, e] of world.entities) if (b0.get(id) !== e) diff++;
console.log("entities differing from baseline after undo:", diff);
sm.redo(n);
console.log("redo ok; entities", world.entities.size);
