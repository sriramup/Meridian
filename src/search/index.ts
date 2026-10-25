// Place search: public API. One PlaceIndex per world, built on first use and kept current from
// the world's changesets. The top bar's PlaceSearch and the agent's reference resolution
// (src/agent/resolve.ts) both read it:
//
//   searchPlaces("21st & guadalupe")   → ranked PlaceResult[] (max 5 by default)
//   bestPlace("Republic Square")        → the best PlaceResult, or null
//   intersectionOf("21st", "Guadalupe") → the junction(s) where two named streets meet
//
// Results carry local-metre `point` and `bbox` and the world entity `ids` they stand for.

import { ensureLibrary, getPrimitive } from "@/library";
import { rtMaybe } from "@/state/runtime";
import type { World } from "@/world/world";
import { PlaceIndex, type PlaceResult } from "./placeIndex";

export { PlaceIndex, fmtLength, type PlaceKind, type PlaceResult } from "./placeIndex";
export { abbreviate, looksLikeAddress, normKey, splitIntersection, tokenize } from "./normalize";
export { matchScore } from "./placeIndex";

const indexes = new WeakMap<World, PlaceIndex>();

function libraryName(def: string): string | undefined {
  ensureLibrary();
  return getPrimitive(def)?.name;
}

/** the place index of `world` (default: the loaded city), built on first use */
export function placeIndexFor(world?: World): PlaceIndex | null {
  const w = world ?? rtMaybe()?.world;
  if (!w) return null;
  let ix = indexes.get(w);
  if (!ix) {
    ix = new PlaceIndex(w, { libraryName });
    indexes.set(w, ix);
  }
  return ix;
}

/** ranked places for a query in the loaded city (streets, junctions, places, addresses…) */
export function searchPlaces(query: string, limit = 5, world?: World): PlaceResult[] {
  return placeIndexFor(world)?.search(query, limit) ?? [];
}

/** the single best place for a query, or null when nothing matches well */
export function bestPlace(query: string, world?: World): PlaceResult | null {
  const r = searchPlaces(query, 1, world)[0];
  return r && r.score >= 0.75 ? r : null;
}

/** junctions where streets named like `a` and `b` meet, best first ("21st", "Guadalupe") */
export function intersectionOf(a: string, b: string, world?: World): PlaceResult[] {
  const ix = placeIndexFor(world);
  return ix ? ix.intersectionsOf(a, b).sort((x, y) => y.score - x.score) : [];
}
