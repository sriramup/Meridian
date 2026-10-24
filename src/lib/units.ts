// Temperatures are modelled in °C and shown in °F.

/** a temperature in °F */
export const toF = (c: number) => c * 1.8 + 32;
/** a temperature difference in °F */
export const dF = (dc: number) => dc * 1.8;

/** "93.4 °F" */
export const fmtF = (c: number, digits = 1) => `${toF(c).toFixed(digits)} °F`;
/** a signed difference, "−2.3 °F" / "+0.5 °F" ("0.0 °F" below `still`) */
export function fmtDF(dc: number, digits = 1, still = 0): string {
  const d = dF(dc);
  if (Math.abs(d) < still || Math.abs(d) < 0.5 * 10 ** -digits) return `${(0).toFixed(digits)} °F`;
  return `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(digits)} °F`;
}
