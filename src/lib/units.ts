// User-facing units are imperial. Models work in SI (metres, m², m/s, °C,
// m³, mm); every value shown to a person goes through one of these.
//
//   length       fmtLen(m)        "12 ft" · "850 ft" · "0.4 mi" · "2.3 mi"
//   height       fmtFt(m)         "142 ft"
//   area         fmtArea(m2)      "1,200 sq ft" · "3.4 acres" · "2.1 sq mi"
//   speed        fmtSpeed(mps)    "28 mph"   (fmtKmh for km/h values)
//   temperature  fmtF(c)          "93.4 °F"  (fmtDF for differences)
//   volume       fmtVol(m3)       "450 gal" · "12,000 cu ft" · "3.2 acre-ft"
//   depth/rain   fmtRain(mm)      "1.2 in"
//   density      fmtPerAcre(n/m2) "24 / acre"
//
// Raw conversions (toFt, toMi, toSqFt, toAcres, toMph, toF, toGal, …) and
// inverses (ftToM, …) are exported, and `displayUnit(siLabel)` maps a
// parameter's SI unit label to the imperial one a form shows.

// ---- factors --------------------------------------------------------------
export const M_PER_FT = 0.3048;
export const M_PER_MI = 1609.344;
export const M2_PER_SQFT = M_PER_FT * M_PER_FT;
export const M2_PER_ACRE = 4046.8564224;
export const M2_PER_SQMI = M_PER_MI * M_PER_MI;
export const MPS_PER_MPH = M_PER_MI / 3600;
export const M3_PER_GAL = 0.003785411784;
export const M3_PER_CUFT = M_PER_FT ** 3;
export const M3_PER_ACREFT = M2_PER_ACRE * M_PER_FT;
export const MM_PER_IN = 25.4;

// ---- raw conversions ------------------------------------------------------
export const toFt = (m: number) => m / M_PER_FT;
export const ftToM = (ft: number) => ft * M_PER_FT;
export const toIn = (m: number) => (m / M_PER_FT) * 12;
export const inToM = (inch: number) => (inch / 12) * M_PER_FT;
export const toMi = (m: number) => m / M_PER_MI;
export const miToM = (mi: number) => mi * M_PER_MI;
export const toSqFt = (m2: number) => m2 / M2_PER_SQFT;
export const sqFtToM2 = (sqft: number) => sqft * M2_PER_SQFT;
export const toAcres = (m2: number) => m2 / M2_PER_ACRE;
export const acresToM2 = (ac: number) => ac * M2_PER_ACRE;
export const toSqMi = (m2: number) => m2 / M2_PER_SQMI;
export const toMph = (mps: number) => mps / MPS_PER_MPH;
export const mphToMps = (mph: number) => mph * MPS_PER_MPH;
export const kmhToMph = (kmh: number) => kmh / 1.609344;
export const mphToKmh = (mph: number) => mph * 1.609344;
export const toGal = (m3: number) => m3 / M3_PER_GAL;
export const toCuFt = (m3: number) => m3 / M3_PER_CUFT;
export const toAcreFt = (m3: number) => m3 / M3_PER_ACREFT;
export const mmToIn = (mm: number) => mm / MM_PER_IN;
/** a per-m² density → per acre */
export const perAcre = (perM2: number) => perM2 * M2_PER_ACRE;
/** a temperature in °F */
export const toF = (c: number) => c * 1.8 + 32;
/** °F → °C */
export const fToC = (f: number) => (f - 32) / 1.8;
/** a temperature difference in °F */
export const dF = (dc: number) => dc * 1.8;

// ---- numbers --------------------------------------------------------------
const MINUS = "−";

/** thousands separators and fixed decimals: "12,400", "3.4", "−2" */
export function fmtNum(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return "–";
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return v < 0 && /[1-9]/.test(s) ? MINUS + s : s;
}
/** decimals by magnitude: 0 at ≥ 10, 1 at ≥ 1, 2 below */
const autoDigits = (v: number) => (Math.abs(v) >= 10 ? 0 : Math.abs(v) >= 1 ? 1 : 2);
const signed = (s: string, v: number) => (v > 0 && !s.startsWith(MINUS) && /[1-9]/.test(s) ? `+${s}` : s);

// ---- length ---------------------------------------------------------------
/** feet below 1,000 ft, miles above: "12 ft", "850 ft", "0.4 mi", "2.3 mi" */
export function fmtLen(m: number, digits?: number): string {
  if (!Number.isFinite(m)) return "–";
  const ft = toFt(m);
  if (Math.abs(ft) < 1000) return `${fmtNum(ft, digits ?? (Math.abs(ft) < 10 ? 1 : 0))} ft`;
  const mi = toMi(m);
  return `${fmtNum(mi, digits ?? (Math.abs(mi) < 10 ? 1 : 0))} mi`;
}
/** always feet: "142 ft" (heights, widths, setbacks) */
export function fmtFt(m: number, digits?: number): string {
  const ft = toFt(m);
  return `${fmtNum(ft, digits ?? (Math.abs(ft) < 10 && ft !== Math.round(ft) ? 1 : 0))} ft`;
}
/** always miles: "2.3 mi" */
export const fmtMi = (m: number, digits = 1) => `${fmtNum(toMi(m), digits)} mi`;
/** signed: "+12 ft" */
export const fmtDLen = (m: number) => signed(fmtLen(m), m);

// ---- area -----------------------------------------------------------------
/** sq ft below ½ acre, acres below 1 sq mi, then sq mi */
export function fmtArea(m2: number, digits?: number): string {
  if (!Number.isFinite(m2)) return "–";
  const ac = toAcres(m2);
  if (Math.abs(ac) < 0.5) return `${fmtNum(toSqFt(m2), digits ?? 0)} sq ft`;
  if (Math.abs(ac) < 640) return `${fmtNum(ac, digits ?? (Math.abs(ac) < 10 ? 1 : 0))} acres`;
  return `${fmtNum(toSqMi(m2), digits ?? 1)} sq mi`;
}
/** always sq ft: "12,400 sq ft" (floor area) */
export const fmtSqFt = (m2: number) => `${fmtNum(toSqFt(m2))} sq ft`;
/** always acres: "3.4 acres" */
export const fmtAcres = (m2: number, digits = 1) => `${fmtNum(toAcres(m2), digits)} acres`;
export const fmtDArea = (m2: number) => signed(fmtArea(m2), m2);

// ---- speed ----------------------------------------------------------------
export const fmtSpeed = (mps: number, digits = 0) => `${fmtNum(toMph(mps), digits)} mph`;
export const fmtKmh = (kmh: number, digits = 0) => `${fmtNum(kmhToMph(kmh), digits)} mph`;

// ---- temperature ----------------------------------------------------------
/** "93.4 °F" */
export const fmtF = (c: number, digits = 1) => `${toF(c).toFixed(digits)} °F`;
/** signed difference, "−2.3 °F" / "+0.5 °F" ("0.0 °F" below `still` °F) */
export function fmtDF(dc: number, digits = 1, still = 0): string {
  const d = dF(dc);
  if (Math.abs(d) < still || Math.abs(d) < 0.5 * 10 ** -digits) return `${(0).toFixed(digits)} °F`;
  return `${d < 0 ? MINUS : "+"}${Math.abs(d).toFixed(digits)} °F`;
}

// ---- volume / depth -------------------------------------------------------
/** gallons below 10,000 gal, cubic feet below an acre-foot, then acre-ft */
export function fmtVol(m3: number): string {
  if (!Number.isFinite(m3)) return "–";
  const gal = toGal(m3);
  if (Math.abs(gal) < 10000) return `${fmtNum(gal)} gal`;
  if (Math.abs(m3) < M3_PER_ACREFT) return `${fmtNum(toCuFt(m3))} cu ft`;
  const af = toAcreFt(m3);
  return `${fmtNum(af, autoDigits(af))} acre-ft`;
}
export const fmtGal = (m3: number) => `${fmtNum(toGal(m3))} gal`;
export const fmtCuFt = (m3: number) => `${fmtNum(toCuFt(m3))} cu ft`;
export const fmtDVol = (m3: number) => signed(fmtVol(m3), m3);
/** rainfall in inches: "1.2 in" */
export const fmtRain = (mm: number, digits = 1) => `${fmtNum(mmToIn(mm), digits)} in`;
/** water depth: inches below a foot, then feet */
export const fmtDepth = (m: number, digits = 1) =>
  Math.abs(toFt(m)) < 1 ? `${fmtNum(toIn(m), 0)} in` : `${fmtNum(toFt(m), digits)} ft`;

// ---- density --------------------------------------------------------------
/** "24 homes / acre" from a per-m² density */
export function fmtPerAcre(perM2: number, what = ""): string {
  const v = perAcre(perM2);
  return `${fmtNum(v, autoDigits(v))}${what ? ` ${what}` : ""} / acre`;
}

// ---- parameter forms ------------------------------------------------------
/** How a value stored in an SI unit is shown and edited. */
export interface DisplayUnit {
  label: string;
  toDisplay: (si: number) => number;
  fromDisplay: (shown: number) => number;
  /** a sensible input step in display units */
  step?: number;
}
const ident = (v: number) => v;
const DISPLAY_UNITS: Record<string, DisplayUnit> = {
  m: { label: "ft", toDisplay: toFt, fromDisplay: ftToM, step: 1 },
  km: { label: "mi", toDisplay: (km) => toMi(km * 1000), fromDisplay: (mi) => miToM(mi) / 1000, step: 0.1 },
  cm: { label: "in", toDisplay: (cm) => toIn(cm / 100), fromDisplay: (i) => inToM(i) * 100, step: 1 },
  mm: { label: "in", toDisplay: mmToIn, fromDisplay: (i) => i * MM_PER_IN, step: 0.1 },
  m2: { label: "sq ft", toDisplay: toSqFt, fromDisplay: sqFtToM2, step: 10 },
  "m²": { label: "sq ft", toDisplay: toSqFt, fromDisplay: sqFtToM2, step: 10 },
  ha: { label: "acres", toDisplay: (ha) => toAcres(ha * 1e4), fromDisplay: (ac) => acresToM2(ac) / 1e4, step: 0.1 },
  "per m²": { label: "per acre", toDisplay: perAcre, fromDisplay: (v) => v / M2_PER_ACRE, step: 1 },
  m3: { label: "gal", toDisplay: toGal, fromDisplay: (g) => g * M3_PER_GAL, step: 10 },
  "m³": { label: "gal", toDisplay: toGal, fromDisplay: (g) => g * M3_PER_GAL, step: 10 },
  "m/s": { label: "mph", toDisplay: toMph, fromDisplay: mphToMps, step: 1 },
  "km/h": { label: "mph", toDisplay: kmhToMph, fromDisplay: mphToKmh, step: 1 },
  "°C": { label: "°F", toDisplay: toF, fromDisplay: fToC, step: 1 },
};
/** the imperial display unit for an SI unit label (identity for %, °, floors…) */
export function displayUnit(si: string | undefined): DisplayUnit {
  return (si && DISPLAY_UNITS[si]) || { label: si ?? "", toDisplay: ident, fromDisplay: ident };
}
