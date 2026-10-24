// The catalog: every primitive definition registers here (owned by the catalog author; the
// framework calls registerCatalog() once before the library is used). Families live one per file;
// a new primitive is one definition in the right family, usually a call to buildingType / propDef /
// rowDef / linearDef / areaDef with defaults over the shared builders in src/library/geometry.

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
for (const d of CATALOG) if (GROUND_LEVEL.has(d.id) || (d.category === "recreation" && d.placement === "rect")) d.siting = { ...d.siting, overlapProps: true };

let done = false;

export function registerCatalog(): void {
  if (done) return;
  done = true;
  // after a hot reload the registry may already hold these ids (dev only): keep the registered ones
  for (const d of CATALOG) if (!getPrimitive(d.id)) registerPrimitive(d);
}
