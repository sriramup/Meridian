"""Fetch City of Austin GIS layers (maps.austintexas.gov ArcGIS REST) clipped to
the study bbox as GeoJSON FeatureCollections in data/raw/austin-gis/.

Usage: python3 -I scripts/fetch_austin_gis.py W S E N
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

W, S, E, N = map(float, sys.argv[1:5])
BASE = "https://maps.austintexas.gov/arcgis/rest/services/Shared"
OUT = "data/raw/austin-gis"
os.makedirs(OUT, exist_ok=True)

LAYERS = {
    "zoning": "Zoning_1/MapServer/0",
    "lots": "LotLines/MapServer/0",
    "row": "Transportation_2/MapServer/0",
    "asmp": "Transportation_1/MapServer/7",
    "bus_stops": "Transportation_1/MapServer/3",
    "bus_routes": "Transportation_1/MapServer/4",
    "rail": "Transportation_1/MapServer/0",
    "footprints": "PlanimetricsSurvey_1/MapServer/0",
    "impervious": "PlanimetricsSurvey_1/MapServer/1",
    "fema": "Floodplain/MapServer/1",
    "drain_pipes": "DrainageInfrastructure/MapServer/6",
    "curb_inlets": "DrainageInfrastructure/MapServer/0",
    "cvc": "Zoning_2/MapServer/4",
    "density_bonus": "Zoning_2/MapServer/11",
    "downtown_districts": "Zoning_2/MapServer/9",
    "planning_areas": "Zoning_2/MapServer/20",
    "etod": "Zoning_2/MapServer/14",
    "sidewalks": "Transportation_1/MapServer/15",
    "curb_ramps": "Transportation_1/MapServer/17",
    "parks": "Infrastructure_2/MapServer/0",
    "soils": "Environmental_1/MapServer/13",
    "creeks": "Environmental_1/MapServer/5",
}


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 ** (i + 1))


def fetch(name, path):
    feats = []
    offset = 0
    page = 2000
    while True:
        q = {
            "where": "1=1",
            "geometry": f"{W},{S},{E},{N}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "*",
            "outSR": "4326",
            "returnGeometry": "true",
            "f": "geojson",
            "resultOffset": str(offset),
            "resultRecordCount": str(page),
        }
        url = f"{BASE}/{path}/query?" + urllib.parse.urlencode(q)
        d = get(url)
        if "error" in d:
            print(name, "ERROR", d["error"])
            return
        fs = d.get("features", [])
        feats.extend(fs)
        if len(fs) < page:
            break
        offset += page
    json.dump({"type": "FeatureCollection", "features": feats}, open(f"{OUT}/{name}.geojson", "w"),
              separators=(",", ":"))
    print(f"{name}: {len(feats)}")


def fetch_canopy():
    """City of Austin tree canopy 2022 (ArcGIS Online, CTM.Publisher), generalised to ~0.5 m."""
    url = "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/tree_canopy_2022/FeatureServer/0/query"
    feats, offset = [], 0
    while True:
        q = {"where": "1=1", "geometry": f"{W},{S},{E},{N}", "geometryType": "esriGeometryEnvelope", "inSR": "4326",
             "spatialRel": "esriSpatialRelIntersects", "outFields": "OBJECTID", "outSR": "4326", "f": "geojson",
             "maxAllowableOffset": "0.000005", "geometryPrecision": "6", "resultOffset": str(offset), "resultRecordCount": "2000"}
        fs = get(url + "?" + urllib.parse.urlencode(q)).get("features", [])
        feats.extend(fs)
        if len(fs) < 2000:
            break
        offset += 2000
    json.dump({"type": "FeatureCollection", "features": feats}, open(f"{OUT}/canopy_2022.geojson", "w"), separators=(",", ":"))
    print(f"canopy_2022: {len(feats)}")


def fetch_tcad():
    """Travis Central Appraisal District parcels (monthly snapshot assembled by Travis County TNR):
    land and improvement values, state property code and owner. Owner names stay in data/raw (not
    committed); the pack keeps only an ownership class and the names of public bodies."""
    url = "https://services1.arcgis.com/HGcSYZ5bvjRswoCb/arcgis/rest/services/TCAD_Parcels_Dec_2025/FeatureServer/0/query"
    fields = "PROP_ID,land_state_cd,land_type_desc,market_value,land_homesite_val,land_non_homesite_val,imprv_homesite_val,imprv_non_homesite_val,py_owner_name,GIS_acres,F1year_imprv"
    feats, offset = [], 0
    while True:
        q = {"where": "1=1", "geometry": f"{W},{S},{E},{N}", "geometryType": "esriGeometryEnvelope", "inSR": "4326",
             "spatialRel": "esriSpatialRelIntersects", "outFields": fields, "outSR": "4326", "f": "geojson",
             "geometryPrecision": "6", "resultOffset": str(offset), "resultRecordCount": "2000"}
        fs = get(url + "?" + urllib.parse.urlencode(q)).get("features", [])
        feats.extend(fs)
        if len(fs) < 2000:
            break
        offset += 2000
    json.dump({"type": "FeatureCollection", "features": feats}, open(f"{OUT}/tcad_parcels.geojson", "w"), separators=(",", ":"))
    print(f"tcad_parcels: {len(feats)}")


only = set(sys.argv[5:])
if not only or "canopy" in only:
    fetch_canopy()
if not only or "tcad" in only:
    fetch_tcad()
for name, path in LAYERS.items():
    if only and name not in only:
        continue
    try:
        fetch(name, path)
    except Exception as e:  # noqa: BLE001
        print(name, "FAILED", e)
