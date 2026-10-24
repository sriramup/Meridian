import * as SunCalc from "suncalc";

/** UTC timestamp for a local wall-clock hour on a date in an IANA time zone */
export function localTimestamp(date: string, hour: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const h = Math.floor(hour);
  const min = Math.round((hour - h) * 60);
  const guess = Date.UTC(y, m - 1, d, h, min);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return guess - (asLocal - guess);
}

/**
 * Sun position with the conventions the models use: altitude in radians, azimuth in radians
 * measured from south, positive toward west. suncalc 2.x reports degrees with a north-based
 * clockwise azimuth (1.x reported radians from south), so convert here — the only place the
 * library is read.
 */
export function sunAltAz(date: Date, lat: number, lon: number): { alt: number; az: number } {
  const p = SunCalc.getPosition(date, lat, lon);
  return { alt: (p.altitude * Math.PI) / 180, az: (((p.azimuth - 180) * Math.PI) / 180) };
}

export function sunPosition(ts: number, lat: number, lon: number) {
  const p = sunAltAz(new Date(ts), lat, lon);
  // compass bearing (from north, clockwise)
  const bearing = ((p.az * 180) / Math.PI + 180 + 360) % 360;
  return { altitude: p.alt, azimuthRad: p.az, bearing, elevationDeg: (p.alt * 180) / Math.PI };
}

export function sunTimes(date: string, lat: number, lon: number) {
  const t = SunCalc.getTimes(new Date(date + "T12:00:00Z"), lat, lon);
  return { sunrise: t.sunrise?.getTime() ?? NaN, sunset: t.sunset?.getTime() ?? NaN };
}
