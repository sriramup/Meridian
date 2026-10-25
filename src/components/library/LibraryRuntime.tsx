"use client";

import { LibraryPlacement } from "./LibraryPlacement";
import { LibrarySolids } from "./LibrarySolids";
import { SnapGrid } from "./SnapGrid";

/** the library's map-side pieces: the solids renderer, the placement tool and the editing grid */
export function LibraryRuntime() {
  return (
    <>
      <LibrarySolids />
      <LibraryPlacement />
      <SnapGrid />
    </>
  );
}
