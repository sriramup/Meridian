"use client";

import {
  Armchair, Bike, Building, Building2, Bus, Factory, Fish, Flower2, GraduationCap, Hospital, House, Landmark, Layers, Package, Store, Trees, TreeDeciduous, Waves, Zap, type LucideIcon,
} from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import type { Category, PrimitiveDef } from "@/library";

export const CATEGORY: Record<Category, { label: string; icon: LucideIcon }> = {
  buildings: { label: "Buildings", icon: Building2 },
  housing: { label: "Housing", icon: House },
  commercial: { label: "Shops & business", icon: Store },
  civic: { label: "Civic", icon: Landmark },
  education: { label: "Education", icon: GraduationCap },
  health: { label: "Health", icon: Hospital },
  industrial: { label: "Industrial", icon: Factory },
  transport: { label: "Streets & transport", icon: Bus },
  streetscape: { label: "Street furniture", icon: Armchair },
  parks: { label: "Parks & open space", icon: Trees },
  recreation: { label: "Recreation", icon: Bike },
  flora: { label: "Trees & planting", icon: TreeDeciduous },
  fauna: { label: "Animals", icon: Fish },
  water: { label: "Water", icon: Waves },
  utilities: { label: "Utilities", icon: Zap },
  landmarks: { label: "Landmarks", icon: Building },
  composites: { label: "Sites & ensembles", icon: Layers },
};

export const CATEGORY_ORDER = Object.keys(CATEGORY) as Category[];

const NAMES = new Set<string>(iconNames);

/** the definition's own lucide icon when it names one, otherwise its category's */
export function PrimitiveIcon({ def, size = 15, className }: { def: PrimitiveDef; size?: number; className?: string }) {
  const Fallback = CATEGORY[def.category]?.icon ?? Package;
  const name = def.icon?.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  if (name && NAMES.has(name)) return <DynamicIcon name={name as IconName} size={size} strokeWidth={1.7} className={className} fallback={() => <Fallback size={size} strokeWidth={1.7} className={className} />} />;
  return <Fallback size={size} strokeWidth={1.7} className={className} />;
}

export { Flower2 };
