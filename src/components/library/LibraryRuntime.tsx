"use client";

import { LibraryPlacement } from "./LibraryPlacement";
import { LibrarySolids } from "./LibrarySolids";

/** the library's map-side pieces: the solids renderer and the placement tool */
export function LibraryRuntime() {
  return (
    <>
      <LibrarySolids />
      <LibraryPlacement />
    </>
  );
}
