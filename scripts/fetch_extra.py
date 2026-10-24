"""Fetch supplementary measured datasets for a study bbox:
  - 2020 Census blocks (POP100, HU100) from TIGERweb
  - TxDOT AADT count stations
  - Terrarium DEM tiles (AWS Open Data) -> elevation grid (meters)
  - Hourly weather for a summer reference day (Open-Meteo ERA5 archive)

Usage: python3 -I scripts/fetch_extra.py <city> W S E N lat lon refdate
"""
import io
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image

city = sys.argv[1]
W, S, E, N = map(float, sys.argv[2:6])
LAT, LON = float(sys.argv[6]), float(sys.argv[7])
REFDATE = sys.argv[8]
OUT = f"data/raw/{city}-extra"
os.makedirs(OUT, exist_ok=True)


def get(url, tries=4, raw=False):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                b = r.read()
                return b if raw else json.loads(b)
        except Exception:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 ** (i + 1))


def arcgis(url, name, fields="*", where="1=1"):
    feats, offset = [], 0
    while True:
        q = {"where": where, "geometry": f"{W},{S},{E},{N}", "geometryType": "esriGeometryEnvelope",
             "inSR": "4326", "spatialRel": "esriSpatialRelIntersects", "outFields": fields, "outSR": "4326",
             "returnGeometry": "true", "f": "geojson", "resultOffset": str(offset), "resultRecordCount": "1000"}
        d = get(url + "/query?" + urllib.parse.urlencode(q))
        if "error" in d:
            print(name, "ERROR", d["error"])
            return
        fs = d.get("features", [])
        feats += fs
        if len(fs) < 1000:
            break
        offset += 1000
    json.dump({"type": "FeatureCollection", "features": feats}, open(f"{OUT}/{name}.geojson", "w"), separators=(",", ":"))
    print(name, len(feats))


which = set(sys.argv[9:])

if not which or "census" in which:
    arcgis("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/10",
           "census_blocks", fields="GEOID,POP100,HU100,AREALAND,AREAWATER")

if not which or "aadt" in which:
    base = "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_AADT_Annuals_(Public_View)/FeatureServer"
    meta = get(base + "?f=json")
    lid = meta["layers"][0]["id"]
    arcgis(f"{base}/{lid}", "txdot_aadt")

if not which or "dem" in which:
    z = 15

    def tile(lon, lat):
        n = 2 ** z
        x = (lon + 180) / 360 * n
        y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
        return x, y

    x0, y0 = tile(W, N)
    x1, y1 = tile(E, S)
    tx0, ty0, tx1, ty1 = int(x0), int(y0), int(x1), int(y1)
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), dtype=np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            b = get(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx}/{ty}.png", raw=True)
            im = np.asarray(Image.open(io.BytesIO(b)).convert("RGB")).astype(np.float32)
            elev = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = elev
    # resample to a regular local-meter grid (5 m) covering bbox
    lat0 = (S + N) / 2
    mlat = 111132.92 - 559.82 * math.cos(2 * math.radians(lat0)) + 1.175 * math.cos(4 * math.radians(lat0))
    mlon = 111412.84 * math.cos(math.radians(lat0)) - 93.5 * math.cos(3 * math.radians(lat0))
    width_m = (E - W) * mlon
    height_m = (N - S) * mlat
    cell = 5.0
    nx, ny = int(width_m / cell) + 1, int(height_m / cell) + 1
    grid = np.zeros((ny, nx), dtype=np.float32)
    for j in range(ny):
        lat = S + (j * cell) / mlat
        for i in range(nx):
            lon = W + (i * cell) / mlon
            px, py = tile(lon, lat)
            fx, fy = (px - tx0) * 256 - 0.5, (py - ty0) * 256 - 0.5
            ix, iy = int(fx), int(fy)
            ax, ay = fx - ix, fy - iy
            v = (mosaic[iy, ix] * (1 - ax) * (1 - ay) + mosaic[iy, ix + 1] * ax * (1 - ay)
                 + mosaic[iy + 1, ix] * (1 - ax) * ay + mosaic[iy + 1, ix + 1] * ax * ay)
            grid[j, i] = v
    np.save(f"{OUT}/dem.npy", grid)
    json.dump({"west": W, "south": S, "cell": cell, "nx": nx, "ny": ny, "zoom": z,
               "min": float(grid.min()), "max": float(grid.max())}, open(f"{OUT}/dem.json", "w"))
    print("dem", nx, ny, float(grid.min()), float(grid.max()))

if not which or "weather" in which:
    q = {"latitude": LAT, "longitude": LON, "start_date": REFDATE, "end_date": REFDATE,
         "hourly": "temperature_2m,relative_humidity_2m,shortwave_radiation,wind_speed_10m,cloud_cover",
         "timezone": "America/Chicago" if city == "austin" else "America/New_York"}
    d = get("https://archive-api.open-meteo.com/v1/archive?" + urllib.parse.urlencode(q))
    json.dump(d, open(f"{OUT}/weather.json", "w"))
    print("weather", REFDATE, max(d["hourly"]["temperature_2m"]))
