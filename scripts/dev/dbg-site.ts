import { loadWorld } from "./load";
import { clearSite } from "@/world/ops/buildings";
import { polyArea, obb } from "@/geometry/polygon";
import { generateMassing } from "@/geometry/massing";
import { rowConflicts } from "@/world/ops/validate";
const w = loadWorld();
const vac = w.all("parcel").filter((p) => p.landUse === "vacant" || p.landUse === "parking").filter((p) => p.zoningBase === "CBD").sort((a, b) => b.area - a.area).slice(0, 6);
for (const p of vac) {
  const s = clearSite(w, p.poly);
  const o = obb(p.poly[0]);
  const rc = rowConflicts(w, p.poly, { minArea: 0.5 }).map((r) => `${r.street.name}:${r.area.toFixed(0)}`);
  const g = s ? generateMassing(s, { typology: "tower_podium", floors: 30, use: "mixed" }) : null;
  console.log(p.id, p.landUse, p.area, "obb", o.length.toFixed(0), o.width.toFixed(0), "site", s ? polyArea(s).toFixed(0) : null, rc.join(","), g && g.masses.map((m) => [m.role, polyArea(m.poly).toFixed(0), m.base.toFixed(0), m.top.toFixed(0)]), g?.gfa.toFixed(0));
}
