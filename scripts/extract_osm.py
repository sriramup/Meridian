"""Extract a study area (detailed, editable) and a context ring (visual only)
from an OSM PBF into a compact JSON consumed by scripts/build-pack.ts.

Usage: python3 -I scripts/extract_osm.py <pbf> <out.json> S W N E  cS cW cN cE
"""
import json
import sys

import osmium

pbf, out = sys.argv[1], sys.argv[2]
S, W, N, E = map(float, sys.argv[3:7])
cS, cW, cN, cE = map(float, sys.argv[7:11])

POLY_KEYS = ("building", "building:part", "landuse", "leisure", "natural", "amenity",
             "water", "man_made", "place", "highway", "public_transport", "parking")
KEEP_TAGS = None  # keep everything; the pack builder whitelists


def in_box(lon, lat, s, w, n, e):
    return s <= lat <= n and w <= lon <= e


def ring_bbox_hit(coords, s, w, n, e):
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return not (max(xs) < w or min(xs) > e or max(ys) < s or min(ys) > n)


def r6(v):
    return round(v, 7)


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.areas = []
        self.ways = []
        self.nodes = []
        self.routes = []
        self.ctx_areas = []
        self.ctx_ways = []

    def node(self, n):
        if not n.location.valid() or len(n.tags) == 0:
            return
        lon, lat = n.location.lon, n.location.lat
        if not in_box(lon, lat, S, W, N, E):
            return
        tags = {t.k: t.v for t in n.tags}
        keys = ("natural", "highway", "public_transport", "railway", "amenity", "shop",
                "tourism", "historic", "place", "leisure", "office", "craft", "healthcare")
        if any(k in tags for k in keys):
            self.nodes.append({"id": n.id, "lon": r6(lon), "lat": r6(lat), "tags": tags})

    def way(self, w):
        tags = {t.k: t.v for t in w.tags}
        if not any(k in tags for k in ("highway", "waterway", "railway", "barrier", "bridge", "man_made")):
            return
        try:
            coords = [(r6(nd.lon), r6(nd.lat)) for nd in w.nodes]
            refs = [nd.ref for nd in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2:
            return
        rec = {"id": w.id, "refs": refs, "coords": coords, "tags": tags}
        if ring_bbox_hit(coords, S, W, N, E):
            self.ways.append(rec)
        elif ring_bbox_hit(coords, cS, cW, cN, cE) and ("highway" in tags or "waterway" in tags or "railway" in tags):
            self.ctx_ways.append({"id": w.id, "coords": coords, "tags": {k: tags[k] for k in ("highway", "waterway", "railway", "name", "bridge", "layer", "tunnel") if k in tags}})

    def relation(self, r):
        tags = {t.k: t.v for t in r.tags}
        if tags.get("type") == "route" and tags.get("route") in ("bus", "tram", "train", "light_rail", "subway"):
            members = [{"type": m.type, "ref": m.ref, "role": m.role} for m in r.members]
            self.routes.append({"id": r.id, "tags": tags, "members": members})

    def area(self, a):
        tags = {t.k: t.v for t in a.tags}
        if not any(k in tags for k in POLY_KEYS):
            return
        polys = []
        try:
            for outer in a.outer_rings():
                o = [(r6(n.lon), r6(n.lat)) for n in outer]
                holes = [[(r6(n.lon), r6(n.lat)) for n in inner] for inner in a.inner_rings(outer)]
                polys.append([o] + holes)
        except osmium.InvalidLocationError:
            return
        if not polys:
            return
        allc = [c for p in polys for c in p[0]]
        rec = {"id": a.orig_id(), "kind": "way" if a.from_way() else "relation", "polys": polys, "tags": tags}
        if ring_bbox_hit(allc, S, W, N, E):
            self.areas.append(rec)
        elif ring_bbox_hit(allc, cS, cW, cN, cE):
            keep = ("building", "building:part", "height", "building:levels", "min_height", "landuse",
                    "leisure", "natural", "water", "amenity", "name")
            self.ctx_areas.append({"id": rec["id"], "kind": rec["kind"], "polys": polys,
                                   "tags": {k: tags[k] for k in keep if k in tags}})


h = H()
h.apply_file(pbf, locations=True, idx="flex_mem")

# second pass: resolve stop node coordinates for routes even if outside (already within)
json.dump({
    "bbox": [W, S, E, N], "contextBbox": [cW, cS, cE, cN],
    "areas": h.areas, "ways": h.ways, "nodes": h.nodes, "routes": h.routes,
    "ctxAreas": h.ctx_areas, "ctxWays": h.ctx_ways,
}, open(out, "w"), separators=(",", ":"))
print("areas", len(h.areas), "ways", len(h.ways), "nodes", len(h.nodes), "routes", len(h.routes),
      "ctxAreas", len(h.ctx_areas), "ctxWays", len(h.ctx_ways))
