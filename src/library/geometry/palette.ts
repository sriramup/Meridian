// Colour and material presets. Facade presets map to the renderer's BuildingStyle.facade family
// plus an explicit wall colour; roof presets give roof solid colours. All colours are muted so
// primitives sit inside the atlas-style theme (src/render/theme.ts) instead of shouting.

import type { BuildingStyle, SolidMaterial } from "@/world/types";
import type { RGB } from "./solids";

export interface FacadePreset {
  label: string;
  facade: BuildingStyle["facade"];
  color: RGB;
  /** trim / parapet / accent colour */
  trim: RGB;
}

export const FACADES = {
  brick_red: { label: "Red brick", facade: "masonry", color: [168, 92, 72], trim: [214, 204, 190] },
  brick_buff: { label: "Buff brick", facade: "masonry", color: [214, 188, 148], trim: [236, 228, 214] },
  brick_brown: { label: "Brown brick", facade: "masonry", color: [132, 94, 76], trim: [200, 190, 176] },
  limestone: { label: "Limestone", facade: "masonry", color: [226, 214, 190], trim: [240, 234, 222] },
  sandstone: { label: "Sandstone", facade: "masonry", color: [214, 180, 136], trim: [234, 220, 196] },
  granite: { label: "Granite", facade: "masonry", color: [168, 164, 160], trim: [206, 204, 200] },
  concrete: { label: "Concrete", facade: "concrete", color: [196, 194, 188], trim: [222, 220, 214] },
  precast_white: { label: "White precast", facade: "concrete", color: [236, 234, 228], trim: [250, 248, 244] },
  glass_blue: { label: "Blue glass curtain wall", facade: "glass", color: [150, 178, 200], trim: [200, 210, 220] },
  glass_green: { label: "Green glass curtain wall", facade: "glass", color: [150, 186, 176], trim: [204, 216, 210] },
  glass_bronze: { label: "Bronze glass", facade: "glass", color: [150, 132, 108], trim: [192, 178, 156] },
  glass_clear: { label: "Clear glass", facade: "glass", color: [196, 212, 222], trim: [226, 232, 236] },
  metal_dark: { label: "Dark metal panel", facade: "metal", color: [88, 92, 98], trim: [150, 154, 160] },
  metal_silver: { label: "Silver metal panel", facade: "metal", color: [188, 192, 196], trim: [220, 222, 226] },
  corrugated: { label: "Corrugated metal", facade: "metal", color: [170, 176, 180], trim: [120, 126, 132] },
  timber_light: { label: "Light timber", facade: "timber", color: [204, 168, 120], trim: [236, 222, 200] },
  timber_dark: { label: "Dark timber", facade: "timber", color: [124, 90, 64], trim: [200, 186, 166] },
  siding_white: { label: "White siding", facade: "timber", color: [240, 238, 232], trim: [196, 196, 192] },
  siding_blue: { label: "Blue siding", facade: "timber", color: [150, 172, 190], trim: [244, 242, 236] },
  siding_sage: { label: "Sage siding", facade: "timber", color: [164, 178, 150], trim: [244, 242, 236] },
  siding_yellow: { label: "Yellow siding", facade: "timber", color: [232, 210, 150], trim: [248, 246, 240] },
  stucco_white: { label: "White stucco", facade: "stucco", color: [244, 240, 230], trim: [214, 200, 176] },
  stucco_cream: { label: "Cream stucco", facade: "stucco", color: [238, 222, 190], trim: [190, 150, 110] },
  stucco_terracotta: { label: "Terracotta stucco", facade: "stucco", color: [214, 142, 106], trim: [240, 226, 206] },
  stucco_pink: { label: "Pink stucco", facade: "stucco", color: [228, 180, 170], trim: [246, 238, 230] },
} satisfies Record<string, FacadePreset>;

export type FacadeKey = keyof typeof FACADES;
export const FACADE_OPTIONS = (Object.keys(FACADES) as FacadeKey[]).map((k) => ({ value: k, label: FACADES[k].label }));

export const ROOFS = {
  asphalt_grey: { label: "Grey asphalt shingle", color: [104, 106, 110] as RGB, material: "concrete" as SolidMaterial },
  asphalt_brown: { label: "Brown asphalt shingle", color: [112, 92, 78] as RGB, material: "concrete" as SolidMaterial },
  terracotta: { label: "Terracotta tile", color: [184, 98, 70] as RGB, material: "stone" as SolidMaterial },
  slate: { label: "Slate", color: [78, 84, 94] as RGB, material: "stone" as SolidMaterial },
  metal_standing_seam: { label: "Standing-seam metal", color: [128, 138, 146] as RGB, material: "metal" as SolidMaterial },
  metal_red: { label: "Red metal", color: [150, 60, 52] as RGB, material: "metal" as SolidMaterial },
  metal_green: { label: "Green metal", color: [70, 110, 88] as RGB, material: "metal" as SolidMaterial },
  copper_patina: { label: "Copper patina", color: [110, 168, 150] as RGB, material: "metal" as SolidMaterial },
  white_membrane: { label: "White membrane (cool roof)", color: [236, 236, 232] as RGB, material: "plastic" as SolidMaterial },
  gravel: { label: "Gravel ballast", color: [176, 170, 160] as RGB, material: "stone" as SolidMaterial },
  wood_shake: { label: "Wood shake", color: [138, 110, 80] as RGB, material: "wood" as SolidMaterial },
  thatch: { label: "Thatch", color: [180, 150, 96] as RGB, material: "fabric" as SolidMaterial },
  glass: { label: "Glazed", color: [176, 200, 214] as RGB, material: "glass" as SolidMaterial },
  gold: { label: "Gilded", color: [206, 168, 84] as RGB, material: "metal" as SolidMaterial },
};
export type RoofKey = keyof typeof ROOFS;
export const ROOF_COLOR_OPTIONS = (Object.keys(ROOFS) as RoofKey[]).map((k) => ({ value: k, label: ROOFS[k].label }));

/** common named colours for props */
export const C = {
  wood: [150, 112, 76] as RGB,
  woodLight: [196, 160, 112] as RGB,
  woodDark: [104, 78, 56] as RGB,
  steel: [120, 126, 132] as RGB,
  steelDark: [62, 66, 72] as RGB,
  black: [40, 42, 46] as RGB,
  white: [240, 240, 236] as RGB,
  concrete: [196, 192, 186] as RGB,
  concreteDark: [150, 148, 144] as RGB,
  stone: [184, 176, 164] as RGB,
  granite: [140, 138, 136] as RGB,
  bronze: [120, 96, 62] as RGB,
  brass: [196, 164, 92] as RGB,
  red: [196, 58, 48] as RGB,
  yellow: [232, 196, 64] as RGB,
  orange: [228, 128, 52] as RGB,
  blue: [60, 108, 168] as RGB,
  green: [64, 126, 84] as RGB,
  glass: [190, 214, 226] as RGB,
  water: [120, 168, 196] as RGB,
  waterDeep: [86, 136, 170] as RGB,
  grass: [140, 172, 108] as RGB,
  foliage: [98, 136, 78] as RGB,
  foliageDark: [70, 104, 62] as RGB,
  trunk: [112, 88, 66] as RGB,
  soil: [130, 104, 80] as RGB,
  sand: [222, 204, 164] as RGB,
  rubber: [176, 96, 74] as RGB,
  asphalt: [92, 94, 98] as RGB,
  light: [255, 236, 180] as RGB,
  fabric: [208, 96, 72] as RGB,
};

export function hexToRgb(hex: string, fallback: RGB = [200, 200, 200]): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (c: RGB) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");

export const shade = (c: RGB, k: number): RGB => [Math.round(Math.min(255, c[0] * k)), Math.round(Math.min(255, c[1] * k)), Math.round(Math.min(255, c[2] * k))];
export const mix = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
