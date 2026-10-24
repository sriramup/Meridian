import { loadWorld } from "./load";
import { editStreetSections } from "@/world/ops/streets";
const world = loadWorld();
const show = (label: string, r: any) => { console.log(`\n== ${label}: ok=${r.ok} ${r.error ?? ""}`); for (const s of r.report.summary) console.log("  •", s); for (const w of r.report.warnings) console.log("  ⚠", w); for (const c of r.report.conflicts.slice(0, 10)) console.log("  ✕", c.resolved ? "[resolved]" : "[open]", c.message); console.log(`  ops: +${r.created.length} ~${r.modified.length} -${r.removed.length}`); };
const g = world.all("street").filter((s) => s.name === "Guadalupe Street");
const r: any = editStreetSections(world, { streetIds: g.map((s) => s.id), edits: [{ op: "remove_lanes", count: 1 } as any, { op: "add_bike_lanes", kind: "two_way_track", side: "east" } as any], keepRowWidth: true, policy: "trim" }, { author: "agent" });
show("Guadalupe road diet + east two-way track", r);
// which side did each segment's track land on?
let east = 0, west = 0;
for (const id of r.modified) { const s: any = world.get(id); if (!s || s.kind !== "street") continue; const i = s.section.strips.findIndex((x: any) => x.type === "cycletrack"); if (i < 0) continue; const a = s.path[0], z = s.path[s.path.length - 1]; const leftIsEast = -(z[1] - a[1]) > 0; const onLeft = i < s.section.strips.length / 2; ((onLeft === leftIsEast) ? (east++) : (west++)); }
console.log(`track side: east ${east}, west ${west}`);
const r2: any = editStreetSections(world, { streetIds: g.map((s) => s.id), edits: [{ op: "add_lanes", count: 1, dir: "both" } as any], policy: "trim" }, { author: "agent" });
show("Guadalupe widen (trim policy)", r2);
