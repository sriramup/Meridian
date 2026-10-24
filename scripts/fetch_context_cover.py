"""Measured land cover for the surrounding ("context") city, for the heat / shade / runoff models
beyond the study area.

Fetches City of Austin Tree Canopy 2022 and the minor paved surfaces of Impervious Cover 2023
(parking, pavement, driveways, sidewalks, patios, alleys) over the study bounds plus a margin, and
rasterises them onto the context grid (8 m, same extent as src/sim/contextLandcover.ts
contextGrid) in the base-raster encoding the study area uses: low 7 bits ground class (0 none,
3 paved, 4 parking), bit 0x80 tree canopy. Buildings and roads come from the context city at runtime.

Writes public/data/<city>/context_cover.bin. Usage: python3 scripts/fetch_context_cover.py [city]
"""

import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

city = sys.argv[1] if len(sys.argv) > 1 else "austin"
root = Path(__file__).resolve().parent.parent / "public" / "data" / city
meta = json.loads((root / "meta.json").read_text())
b = meta["bounds"]
PAD, CELL = 1900, 8
x0 = math.floor((b[0] - PAD) / CELL) * CELL
y0 = math.floor((b[1] - PAD) / CELL) * CELL
nx = math.ceil((b[2] + PAD - x0) / CELL)
ny = math.ceil((b[3] + PAD - y0) / CELL)

# local tangent-plane projection (src/world/projection.ts)
lon0, lat0 = meta["origin"]["lon"], meta["origin"]["lat"]
phi = math.radians(lat0)
MY = 111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
MX = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi)
to_local = lambda lon, lat: ((lon - lon0) * MX, (lat - lat0) * MY)
W, E = lon0 + x0 / MX, lon0 + (x0 + nx * CELL) / MX
S, N = lat0 + y0 / MY, lat0 + (y0 + ny * CELL) / MY


def get(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                return json.load(r)
        except Exception as e:  # transient server errors: back off and retry
            if k == tries - 1:
                raise
            print("  retry:", e)
            time.sleep(3 * (k + 1))


def fetch(url, where, page):
    feats, offset = [], 0
    while True:
        q = {"where": where, "geometry": f"{W},{S},{E},{N}", "geometryType": "esriGeometryEnvelope", "inSR": "4326",
             "spatialRel": "esriSpatialRelIntersects", "outFields": "OBJECTID", "outSR": "4326", "f": "geojson",
             "maxAllowableOffset": "0.00002", "geometryPrecision": "6", "resultOffset": str(offset), "resultRecordCount": str(page)}
        fs = get(url + "?" + urllib.parse.urlencode(q)).get("features", [])
        feats.extend(fs)
        print(f"  {len(feats)}")
        if len(fs) < page:
            return feats
        offset += page


def rings(geom):
    if not geom:
        return []
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def fill(poly, setter):
    """even-odd scanline fill of one polygon (list of rings, lon/lat) at cell centres"""
    rs = [[to_local(*p[:2]) for p in r] for r in poly]
    ys = [p[1] for r in rs for p in r]
    j0 = max(0, math.ceil((min(ys) - y0) / CELL - 0.5))
    j1 = min(ny - 1, math.floor((max(ys) - y0) / CELL - 0.5))
    for j in range(j0, j1 + 1):
        y = y0 + (j + 0.5) * CELL
        xs = []
        for r in rs:
            for k in range(len(r) - 1):
                (ax, ay), (bx, by) = r[k], r[k + 1]
                if (ay <= y) != (by <= y):
                    xs.append(ax + (y - ay) * (bx - ax) / (by - ay))
        xs.sort()
        for k in range(0, len(xs) - 1, 2):
            i0 = max(0, math.ceil((xs[k] - x0) / CELL - 0.5))
            i1 = min(nx - 1, math.floor((xs[k + 1] - x0) / CELL - 0.5))
            for i in range(i0, i1 + 1):
                setter(j * nx + i)


grid = bytearray(nx * ny)

print("impervious (minor paved surfaces)")
imp_url = "https://maps.austintexas.gov/arcgis/rest/services/Shared/PlanimetricsSurvey_1/MapServer/1/query"
for f in fetch(imp_url, "FEATURE IN ('Paved Parking','Unpaved Parking')", 5000):
    for poly in rings(f["geometry"]):
        fill(poly, lambda i: grid.__setitem__(i, (grid[i] & 0x80) | 4))
for f in fetch(imp_url, "FEATURE IN ('Pavement','Paved Driveway','Sidewalk','Patio','Paved Alley')", 5000):
    for poly in rings(f["geometry"]):
        fill(poly, lambda i: grid.__setitem__(i, (grid[i] & 0x80) | 3) if (grid[i] & 0x7F) == 0 else None)

print("tree canopy")
can_url = "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/tree_canopy_2022/FeatureServer/0/query"
for f in fetch(can_url, "1=1", 2000):
    for poly in rings(f["geometry"]):
        fill(poly, lambda i: grid.__setitem__(i, grid[i] | 0x80))

(root / "context_cover.bin").write_bytes(bytes(grid))
canopy = sum(1 for v in grid if v & 0x80) / len(grid)
paved = sum(1 for v in grid if v & 0x7F) / len(grid)
print(f"grid {nx}×{ny} @ {CELL} m · canopy {canopy:.1%} · minor paved {paved:.1%} → {root / 'context_cover.bin'}")
