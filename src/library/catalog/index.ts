// The catalog: every primitive definition registers here (owned by the catalog author; the
// framework calls registerCatalog() once before the library is used). Families live one per file;
// a new primitive is one definition in the right family, usually a call to buildingType / propDef /
// rowDef / linearDef / areaDef with defaults over the shared builders in src/library/geometry.

import { registerPrimitive } from "../registry";
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

let done = false;

export function registerCatalog(): void {
  if (done) return;
  done = true;
  for (const d of CATALOG) registerPrimitive(d);
}
