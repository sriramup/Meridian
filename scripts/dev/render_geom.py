import json, sys
from PIL import Image, ImageDraw
d = json.load(open(sys.argv[1])); out = sys.argv[2]; title = sys.argv[3] if len(sys.argv) > 3 else ""
x0, y0, x1, y1 = d["box"]; S = 1000
sc = S / (x1 - x0)
T = lambda p: ((p[0] - x0) * sc, (y1 - p[1]) * sc)
im = Image.new("RGB", (S, S), (236, 234, 230)); dr = ImageDraw.Draw(im)
col = {"sidewalk": (205,200,192), "planting": (170,190,150), "parking": (150,150,154), "bike": (90,150,110), "cycletrack": (60,160,100), "buffer": (230,230,230), "travel": (110,110,114), "bus": (190,70,60), "turn": (120,120,124), "median": (150,175,130), "tram": (200,120,40), "shoulder": (130,130,134), "plaza": (225,210,185), "carriageway": (110,110,114), "corner": (205,200,192), "island": (150,175,130)}
acol = {"park": (190,210,170), "grass": (200,215,185), "water": (160,190,205), "parking": (215,210,205), "plaza": (225,215,195), "retention": (140,180,195)}
for a in d.get("areas", []):
    if len(a["r"]) > 2: dr.polygon([T(p) for p in a["r"]], fill=acol.get(a["t"], (220,220,215)))
for b in d["buildings"]:
    r = b["r"] if isinstance(b, dict) else b
    prop = isinstance(b, dict) and b.get("p")
    if len(r) > 2: dr.polygon([T(p) for p in r], fill=(240,160,110) if prop else (250,248,244), outline=(150,146,140))
for s in d["strips"]:
    if len(s["r"]) > 2: dr.polygon([T(p) for p in s["r"]], fill=col.get(s["t"], (255,0,255)))
for n in d["nodes"]:
    if len(n["r"]) > 2: dr.polygon([T(p) for p in n["r"]], fill=col.get(n["t"], (225,210,185)))
for m in d["marks"]:
    c = (255,255,255) if m["color"] == "white" else (230,190,40)
    w = max(1, int(m["width"] * sc))
    pts = [T(p) for p in m["path"]]
    if len(pts) > 1: dr.line(pts, fill=c, width=w)
for t in d.get("trees", []):
    x, y = T(t["p"]); r = t["r"] * sc
    dr.ellipse([x-r, y-r, x+r, y+r], fill=(90,160,80) if t["n"] else (120,150,100))
if title: dr.text((10, 10), title, fill=(0,0,0))
im.save(out)
