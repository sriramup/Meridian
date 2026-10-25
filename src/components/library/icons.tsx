"use client";

import {
  Armchair, Bike, Building, Building2, Bus, Factory, Fish, Flower2, GraduationCap, Hospital, House, Landmark, Layers, Package, Store, Trees, TreeDeciduous, Waves, Zap, type LucideIcon,
} from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { useEffect, useRef, useState } from "react";
import type { Category, ParamValues, PrimitiveDef } from "@/library";
import { cachedThumbnail, requestThumbnail } from "./thumbnail";

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

/**
 * A rendered preview of what the primitive builds (library/thumbnail.ts), drawn once it scrolls into
 * view; its icon stands in until then, or when it has nothing to draw. `params` previews a
 * configured variant (redrawn, debounced, as they change).
 */
export function PrimitiveThumb({ def, width, height, params, className, iconSize = 22 }: { def: PrimitiveDef; width: number; height: number; params?: ParamValues; className?: string; iconSize?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null | undefined>(() => cachedThumbnail(def, width, height, params));
  const key = params ? JSON.stringify(params) : "";
  useEffect(() => {
    const hit = cachedThumbnail(def, width, height, params);
    if (hit !== undefined) {
      setUrl(hit);
      return;
    }
    let cancel = () => {};
    let t: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      // a configured preview follows the form: wait for typing / dragging to pause
      t = setTimeout(() => (cancel = requestThumbnail(def, width, height, setUrl, params)), params ? 120 : 0);
    };
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      start();
      return () => (clearTimeout(t), cancel());
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => (io.disconnect(), clearTimeout(t), cancel());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, width, height, key]);
  return (
    <div ref={box} className={className} style={{ width: "100%", height }}>
      {url ? (
        <img src={url} alt="" draggable={false} className="pointer-events-none mx-auto block h-full w-auto max-w-full object-contain select-none" />
      ) : (
        <div className="grid h-full place-items-center text-ink-4">
          <PrimitiveIcon def={def} size={iconSize} className={url === undefined ? "opacity-40" : "text-ink-3"} />
        </div>
      )}
    </div>
  );
}
