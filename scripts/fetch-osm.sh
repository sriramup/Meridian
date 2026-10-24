#!/usr/bin/env bash
# Usage: scripts/fetch-osm.sh <city> <south> <west> <north> <east>
set -euo pipefail
CITY=$1; S=$2; W=$3; N=$4; E=$5
OUT=data/raw/$CITY-osm.json
mkdir -p data/raw
Q="[out:json][timeout:300][maxsize:1073741824];
(
  way[\"building\"]($S,$W,$N,$E);
  relation[\"building\"]($S,$W,$N,$E);
  way[\"building:part\"]($S,$W,$N,$E);
  way[\"highway\"]($S,$W,$N,$E);
  way[\"landuse\"]($S,$W,$N,$E);
  relation[\"landuse\"]($S,$W,$N,$E);
  way[\"leisure\"]($S,$W,$N,$E);
  relation[\"leisure\"]($S,$W,$N,$E);
  way[\"natural\"]($S,$W,$N,$E);
  relation[\"natural\"]($S,$W,$N,$E);
  way[\"waterway\"]($S,$W,$N,$E);
  way[\"amenity\"]($S,$W,$N,$E);
  way[\"railway\"]($S,$W,$N,$E);
  way[\"bridge\"]($S,$W,$N,$E);
  way[\"man_made\"=\"bridge\"]($S,$W,$N,$E);
  node[\"natural\"=\"tree\"]($S,$W,$N,$E);
  node[\"highway\"~\"traffic_signals|stop|crossing|bus_stop\"]($S,$W,$N,$E);
  node[\"public_transport\"]($S,$W,$N,$E);
  node[\"railway\"~\"station|stop|halt|tram_stop\"]($S,$W,$N,$E);
  node[\"amenity\"]($S,$W,$N,$E);
  node[\"shop\"]($S,$W,$N,$E);
  node[\"tourism\"]($S,$W,$N,$E);
  node[\"historic\"]($S,$W,$N,$E);
  node[\"place\"]($S,$W,$N,$E);
  relation[\"route\"~\"bus|tram|train|light_rail\"]($S,$W,$N,$E);
);
out body geom qt;"
curl -sS --max-time 600 -o "$OUT" --data-urlencode "data=$Q" https://maps.mail.ru/osm/tools/overpass/api/interpreter
ls -la "$OUT"
