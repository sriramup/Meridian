import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { basemapColors } from "./daylight";

/**
 * Muted context basemap from OpenFreeMap vector tiles (OpenMapTiles schema). The study area itself
 * is drawn by deck.gl from the world model. `night` (0 day … 1 night, daylight.ts) blends its colours.
 */
export function basemapStyle(night: number, plain = false): StyleSpecification {
  const c = basemapColors(night);
  // the blank canvas has no real place under it: just the backdrop (the climate city's tiles would show through)
  if (plain) return { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": c.bg } }] };
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: { omt: { type: "vector", url: "https://tiles.openfreemap.org/planet" } },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": c.bg } },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": c.park } },
      { id: "landcover", type: "fill", source: "omt", "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["grass", "wood"]]], paint: { "fill-color": c.park, "fill-opacity": 0.7 } },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": c.water } },
      {
        id: "roads-minor",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["minor", "service", "tertiary"]]],
        paint: { "line-color": c.road, "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 12, 0.5, 18, 10] },
      },
      {
        id: "roads-major",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "trunk", "motorway"]]],
        paint: { "line-color": c.major, "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 10, 0.8, 18, 18] },
      },
      {
        id: "place-labels",
        type: "symbol",
        source: "omt",
        "source-layer": "place",
        filter: ["in", ["get", "class"], ["literal", ["city", "town", "suburb", "neighbourhood"]]],
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-transform": "uppercase", "text-letter-spacing": 0.12 },
        paint: { "text-color": c.label, "text-halo-color": c.halo, "text-halo-width": 1.2 },
      },
    ],
  };
}

/**
 * Follow the clock by recolouring the loaded style in place (tiles and the sky stay as they are).
 * Only colour properties that changed are set, so a step of the hour costs a few paint updates.
 */
const applied = new WeakMap<MapLibreMap, Map<string, unknown>>();
export function setBasemapNight(map: MapLibreMap, night: number, plain = false) {
  if (!map.isStyleLoaded()) {
    map.once("load", () => setBasemapNight(map, night, plain));
    return;
  }
  let seen = applied.get(map);
  if (!seen) applied.set(map, (seen = new Map()));
  for (const l of basemapStyle(night, plain).layers)
    if ("paint" in l && l.paint && map.getLayer(l.id))
      for (const [k, v] of Object.entries(l.paint)) {
        if (!k.endsWith("color")) continue;
        const key = `${l.id}|${k}`;
        if (seen.get(key) === v) continue;
        seen.set(key, v);
        map.setPaintProperty(l.id, k, v);
      }
}
