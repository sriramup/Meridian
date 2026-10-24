"use client";

// Turn a finished drawing into an element with the palette's choices (picked before drawing),
// commit it and select it for fine-tuning in the inspector.

import { buildSection, sectionWidth } from "@/geometry/crossSection";
import type { Typology } from "@/geometry/massing";
import { createBuilding } from "@/world/ops/buildings";
import type { OpResult } from "@/world/ops/core";
import { generateDistrict } from "@/world/ops/district";
import { createArea } from "@/world/ops/landscape";
import { shapeConflicts, streetConflicts } from "@/world/ops/placement";
import { createStreet } from "@/world/ops/streets";
import { createTransitRoute } from "@/world/ops/transit";
import type { Use, Vec2 } from "@/world/types";
import { applyOp } from "./actions";
import { rt } from "./runtime";
import { useApp, type Palette } from "./store";

export type DrawnTool = "building" | "area" | "street" | "district" | "transit";

const actor = { author: "user" as const };

/** right-of-way of the street the palette would draw (for previews and conflict checks) */
export function paletteStreetWidth(p: Palette["street"]): number {
  return sectionWidth(buildSection({ cls: p.cls, oneway: false, bikeLeft: p.bike === "none" ? null : p.bike, bikeRight: p.bike === "none" ? null : p.bike, parkingLeft: p.cls === "residential", parkingRight: p.cls === "residential", downtown: true }));
}

/** what a finished shape would run into; null when it is clean */
export function drawConflict(tool: DrawnTool, pts: Vec2[]): string | null {
  const R = rt();
  if (tool === "street") {
    const n = streetConflicts(R.world, pts, paletteStreetWidth(useApp.getState().palette.street)).length;
    return n ? `Cuts through ${n} building${n > 1 ? "s" : ""}, which would be demolished` : null;
  }
  if (tool === "building" || tool === "area") {
    const c = shapeConflicts(R.world, tool, pts);
    return c.blocking ? c.message : null;
  }
  return null;
}

/** a name that is not used yet ("Fire Station", "Fire Station 2", …) */
function nextName(base: string, kind: "building" | "route"): string {
  const used = new Set(rt().world.all(kind).map((e) => e.name));
  if (!used.has(base)) return base;
  let k = 2;
  while (used.has(`${base} ${k}`)) k++;
  return `${base} ${k}`;
}

/** `replace`: a building may replace the buildings it overlaps */
export function createDrawn(tool: DrawnTool, pts: Vec2[], opts: { replace?: boolean } = {}): boolean {
  const R = rt();
  const P = useApp.getState().palette;
  let res: OpResult;
  switch (tool) {
    case "building": {
      const fire = P.building.use === "fire_station";
      res = createBuilding(R.world, { site: [pts], spec: { typology: P.building.typology as Typology, floors: P.building.floors, use: (fire ? "civic" : P.building.use) as Use }, name: fire ? nextName("Fire Station", "building") : undefined, demolishConflicts: opts.replace }, actor);
      break;
    }
    case "area":
      res = createArea(R.world, { type: P.area.type, poly: [pts] }, actor);
      break;
    case "street":
      res = createStreet(R.world, { path: pts, cls: P.street.cls, bike: P.street.bike === "none" ? null : P.street.bike, trees: P.street.trees }, actor);
      break;
    case "district":
      // existing buildings inside are kept; new local streets split big blocks
      res = generateDistrict(R.world, { area: [pts], style: P.district.style, targetUnits: P.district.homes || undefined, maxFloors: P.district.maxFloors, newStreets: P.district.newStreets, keepAllExisting: true, name: "District" }, actor);
      break;
    case "transit":
      res = createTransitRoute(R.world, { mode: P.transit.mode, waypoints: pts, headway: P.transit.headway, dedicated: P.transit.mode !== "bus", name: nextName(P.transit.mode === "tram" ? "Tram" : P.transit.mode === "brt" ? "Rapid" : "Line", "route") }, actor);
      break;
  }
  if (!applyOp(res)) return false;
  if (tool === "transit" && !useApp.getState().layers.transit) useApp.getState().toggleLayer("transit");
  // select what was made so the inspector can fine-tune it
  const main = res.created.find((id) => {
    const k = R.world.get(id)?.kind;
    return tool === "street" ? k === "street" : tool === "transit" ? k === "route" : tool === "district" ? false : k === tool;
  });
  useApp.getState().setSelection(main ? [main] : []);
  return true;
}
