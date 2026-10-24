// The catalog: every primitive definition registers here (the framework calls registerCatalog()
// once before the library is used). Families live one per file; a new primitive is one definition
// in the right family, usually a call to a factory with defaults over the shared builders:
//
//   buildingType / buildingRowType / buildingClusterType  (building.ts)  the universal building
//       schema (BUILDING_PARAMS: footprint shape, massing, roof, facade, programme) with new
//       defaults, extra params and an optional `decorate` (porches, pumps, playgrounds, parking)
//   propDef      one Prop from solids at a point          rowDef     props repeated along a path
//   linearDef    one prop per path segment (fences, walls) areaDef    an Area on a drawn site
//   custom generate(values, place, ctx) with `Out` (make.ts) for composites
//
// Conventions
// - Frames: local x right, y forward; `rotation` / heading is degrees CCW from east. Buildings face
//   local +y (entrances, awnings, porches, forecourts, parking go on the +y side).
// - Rect / polygon placement: buildings fit their width / depth to the drawn site when `fitToSite`
//   (shape "site" uses the drawn outline itself); site-scale primitives fill the drawn polygon and
//   fall back to their width / depth params around a point.
// - Params: label + unit (m, m², %, °, floors) + min / max / step; group is one of Footprint,
//   Massing, Roof, Facade, Programme, Site, Dimensions, Appearance, Planting, Facilities, Layout,
//   Group; `advanced` for rarely used ones; `when` shows shape-specific params only when relevant;
//   0 means "automatic" for heights, unit and job counts and targets.
// - Programme: `use`, `groundUse`, `secondaryUse` / share set Building.program; explicit `units` /
//   `jobs` become Building.occupancy so the simulations use the stated numbers.
// - Every entity carries ctx.ref (one primary per instance); ids come from ctx.id; generators are
//   deterministic per instance (seeded from the instance id or a `seed` param).

import { getPrimitive, registerPrimitive } from "../registry";
import type { PrimitiveDef } from "../types";
import { CIVIC, EDUCATION, HEALTH } from "./civic";
import { COMMERCIAL } from "./commercial";
import { COMPOSITES } from "./composites";
import { FAUNA } from "./fauna";
import { LANDMARKS } from "./landmarks";
import { PARKS } from "./parks";
import { UTILITIES } from "./utilities";
import { WATER } from "./water";
import { FLORA } from "./flora";
import { INDUSTRIAL, TRANSPORT } from "./industrial";
import { RECREATION } from "./recreation";
import { HOUSING } from "./housing";
import { STREETSCAPE } from "./streetscape";
import { UNIVERSAL } from "./universal";

/** every catalog definition, in palette order */
export const CATALOG: PrimitiveDef[] = [...UNIVERSAL, ...HOUSING, ...COMMERCIAL, ...CIVIC, ...EDUCATION, ...HEALTH, ...INDUSTRIAL, ...TRANSPORT, ...STREETSCAPE, ...PARKS, ...RECREATION, ...FLORA, ...FAUNA, ...WATER, ...UTILITIES, ...LANDMARKS, ...COMPOSITES];

/**
 * Ground-level and site-scale primitives: their flat props (stall striping, field lines, planting
 * beds, pond edges, headstones, panel rows) may lie under other objects, and other objects may
 * stand on them, so they don't block placement.
 */
const GROUND_LEVEL = new Set([
  "transport.parking_lot",
  "transport.transit_hub",
  "flora.flower_bed",
  "flora.wildflower_meadow",
  "flora.ornamental_grasses",
  "flora.lawn",
  "flora.woodland",
  "water.pond",
  "water.retention_pond",
  "water.rain_garden",
  "water.bioswale",
  "water.reflecting_pool",
  "water.canal",
  "water.stream",
  "parks.community_garden",
  "parks.cemetery",
  "parks.dog_park",
  "utilities.solar_farm",
  "streetscape.tree_grate",
]);
for (const d of CATALOG) if (GROUND_LEVEL.has(d.id) || (d.category === "recreation" && d.placement === "rect")) d.siting = { ...d.siting, overlapProps: true, ...(d.category === "water" ? { water: true } : {}) };

let done = false;

export function registerCatalog(): void {
  if (done) return;
  done = true;
  // after a hot reload the registry may already hold these ids (dev only): keep the registered ones
  for (const d of CATALOG) if (!getPrimitive(d.id)) registerPrimitive(d);
}
