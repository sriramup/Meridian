// Public API of the primitive library. Consumers (palette, inspector, agent tools, ops) import from
// here; call ensureLibrary() before reading the registry so the catalog has registered itself.

import { registerCatalog } from "./catalog";
import { registerBuiltins } from "./custom";

export * from "./types";
export * from "./registry";
export { toWorld, toLocal, solidOutline, propFootprint, solidsHeight, propSolidsWorld } from "./frame";

let ready = false;

/** register the catalog (and the framework's own escape-hatch primitives) once */
export function ensureLibrary(): void {
  if (ready) return;
  ready = true;
  registerBuiltins();
  registerCatalog();
}
