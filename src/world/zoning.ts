// Simplified site-development parameters for City of Austin base zoning
// districts (Land Development Code Title 25). Values are planning-level
// approximations for capacity screening, not legal determinations.

export interface ZoningRule {
  label: string;
  /** base floor-area ratio (null = governed by other limits / not applicable) */
  far: number | null;
  /** base height limit in feet (null = no base-district limit) */
  heightFt: number | null;
  residential: boolean;
  commercial: boolean;
  developable: boolean;
}

const R = (label: string, far: number | null, heightFt: number | null, residential: boolean, commercial: boolean, developable = true): ZoningRule => ({ label, far, heightFt, residential, commercial, developable });

export const ZONING: Record<string, ZoningRule> = {
  CBD: R("Central Business District", 8, null, true, true),
  DMU: R("Downtown Mixed Use", 5, 120, true, true),
  CH: R("Commercial Highway", 8, 120, false, true),
  CS: R("General Commercial Services", 2, 60, false, true),
  "CS-1": R("Commercial-Liquor Sales", 2, 60, false, true),
  GR: R("Community Commercial", 1, 60, false, true),
  LR: R("Neighborhood Commercial", 0.5, 40, false, true),
  GO: R("General Office", 1, 60, false, true),
  LO: R("Limited Office", 0.7, 40, false, true),
  NO: R("Neighborhood Office", 0.35, 35, false, true),
  "MF-1": R("Multifamily (limited density)", 0.5, 40, true, false),
  "MF-2": R("Multifamily (low density)", 0.6, 40, true, false),
  "MF-3": R("Multifamily (medium density)", 0.75, 40, true, false),
  "MF-4": R("Multifamily (moderate-high density)", 1.0, 60, true, false),
  "MF-5": R("Multifamily (high density)", 1.5, 60, true, false),
  "MF-6": R("Multifamily (highest density)", 2.0, 90, true, false),
  "SF-1": R("Single Family (large lot)", 0.4, 35, true, false),
  "SF-2": R("Single Family (standard lot)", 0.4, 35, true, false),
  "SF-3": R("Family Residence", 0.4, 35, true, false),
  "SF-4A": R("Single Family (small lot)", 0.4, 35, true, false),
  "SF-5": R("Urban Family Residence", 0.4, 35, true, false),
  "SF-6": R("Townhouse & Condominium", 0.4, 35, true, false),
  TOD: R("Transit Oriented Development", 3, 60, true, true),
  LI: R("Limited Industrial", 1, 60, false, true),
  P: R("Public", null, null, false, false, false),
  PUD: R("Planned Unit Development", null, null, true, true),
  UNZ: R("Unzoned (state / university)", null, null, true, true),
  L: R("Lake", null, null, false, false, false),
};

/** resolve the rule for a full zoning string like "MF-4-NP" or "CBD-DDB400" */
export function zoningRule(ztype: string, base?: string): ZoningRule {
  const z = (ztype || "").toUpperCase();
  const m = z.match(/^(SF-\d[A-Z]?|MF-\d|CS-1|[A-Z]+)/);
  const key = m ? m[1] : base ?? "";
  if (ZONING[key]) return ZONING[key];
  if (base && ZONING[base]) return ZONING[base];
  if (key.startsWith("MF")) return ZONING["MF-3"];
  if (key.startsWith("SF")) return ZONING["SF-3"];
  return R(key || "Unknown", null, null, true, true);
}

/** historic landmark (-H) or historic district (-HD) combining district */
export const isHistoricZoning = (ztype: string) => /(^|-)H(D)?(-|$)/.test((ztype || "").toUpperCase());
