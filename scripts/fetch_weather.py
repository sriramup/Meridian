"""Typical hourly weather for every day of the year at the pack origin (Open-Meteo archive, ERA5).

Averages each hour over a multi-year window and ±3 calendar days, giving a smooth "typical day"
for every month-day: public/data/<city>/weather.json with air temperature (°C) and shortwave
radiation (W/m²) per local hour. Usage: python3 scripts/fetch_weather.py [city] [first_year] [last_year]
"""

import json
import sys
import urllib.request
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

city = sys.argv[1] if len(sys.argv) > 1 else "austin"
y0 = int(sys.argv[2]) if len(sys.argv) > 2 else 2014
y1 = int(sys.argv[3]) if len(sys.argv) > 3 else 2023
WINDOW = 3  # ± days pooled around each month-day

root = Path(__file__).resolve().parent.parent / "public" / "data" / city
meta = json.loads((root / "meta.json").read_text())
lat, lon, tz = meta["origin"]["lat"], meta["origin"]["lon"], meta["timezone"]

url = (
    "https://archive-api.open-meteo.com/v1/archive"
    f"?latitude={lat}&longitude={lon}&start_date={y0}-01-01&end_date={y1}-12-31"
    f"&hourly=temperature_2m,shortwave_radiation&timezone={tz.replace('/', '%2F')}"
)
with urllib.request.urlopen(url, timeout=300) as r:
    h = json.load(r)["hourly"]

# day-of-year (non-leap numbering; Feb 29 folds into Feb 28) → hour → samples
t_acc = defaultdict(lambda: [[] for _ in range(24)])
s_acc = defaultdict(lambda: [[] for _ in range(24)])
for ts, temp, sw in zip(h["time"], h["temperature_2m"], h["shortwave_radiation"]):
    if temp is None:
        continue
    d = date.fromisoformat(ts[:10])
    md = (d.month, min(d.day, 28) if d.month == 2 else d.day)
    doy = (date(2023, *md) - date(2023, 1, 1)).days
    hr = int(ts[11:13])
    t_acc[doy][hr].append(temp)
    s_acc[doy][hr].append(sw or 0)

days = {}
for doy in range(365):
    d = date(2023, 1, 1) + timedelta(days=doy)
    near = [(doy + k) % 365 for k in range(-WINDOW, WINDOW + 1)]
    t = [round(sum(sum(t_acc[n][hr], 0) for n in near) / max(1, sum(len(t_acc[n][hr]) for n in near)), 1) for hr in range(24)]
    sw = [round(sum(sum(s_acc[n][hr], 0) for n in near) / max(1, sum(len(s_acc[n][hr]) for n in near))) for hr in range(24)]
    days[d.strftime("%m-%d")] = {"t": t, "sw": sw}

out = {
    "source": f"Open-Meteo archive (ERA5 reanalysis, ~25 km grid), hourly mean {y0}–{y1} over ±{WINDOW} days",
    "years": [y0, y1],
    "days": days,
}
(root / "weather.json").write_text(json.dumps(out, separators=(",", ":")))
peak = max(days, key=lambda k: max(days[k]["t"]))
print(f"{len(days)} month-days → {root / 'weather.json'} · warmest typical day {peak} ({max(days[peak]['t'])} °C)")
