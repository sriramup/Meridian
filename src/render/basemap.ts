import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

/** Muted context basemap from OpenFreeMap vector tiles (OpenMapTiles schema). The study area itself is drawn by deck.gl from the world model. */
export function basemapStyle(theme: "model" | "night", plain = false): StyleSpecification {
  const night = theme === "night";
  const c = night
    ? { bg: "#14161a", water: "#121c25", park: "#18211b", road: "#24272c", major: "#2b2f35", label: "#7c8088", halo: "#14161a" }
    : { bg: "#e8d6b1", water: "#b4cac8", park: "#d3d4b0", road: "#d8c39d", major: "#cdb488", label: "#6e5234", halo: "#f1e3c3" };
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

/** switch day / night by recolouring the loaded style in place: tiles and the sky stay as they are */
export function setBasemapTheme(map: MapLibreMap, theme: "model" | "night", plain = false) {
  if (!map.isStyleLoaded()) {
    map.once("load", () => setBasemapTheme(map, theme, plain));
    return;
  }
  for (const l of basemapStyle(theme, plain).layers)
    if ("paint" in l && l.paint && map.getLayer(l.id)) for (const [k, v] of Object.entries(l.paint)) map.setPaintProperty(l.id, k, v);
}
