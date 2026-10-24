// The universal building: every parameter exposed, sensible mid-rise defaults.

import type { PrimitiveDef } from "../types";
import { buildingType } from "./building";

export const UNIVERSAL: PrimitiveDef[] = [
  buildingType({
    id: "buildings.building",
    name: "Building (fully configurable)",
    category: "buildings",
    tags: ["custom building", "generic", "any building", "massing", "block", "tower", "structure", "edifice"],
    description:
      "Any building: choose plan shape (rect, L, T, U, H, courtyard, cross, Z, trapezoid, triangle, circle, ellipse, polygon, rounded, crescent, stepped or the drawn outline), floors and floor heights, podium and tower, setbacks, taper, twist, roof, facade and programme.",
    icon: "building",
  }),
  buildingType({
    id: "buildings.tower",
    name: "Tower (fully configurable)",
    category: "buildings",
    tags: ["skyscraper", "high-rise", "tower", "supertall", "twisting tower", "tapered tower"],
    description: "A tall building with podium, tower plate, taper and twist exposed; any use.",
    icon: "building-2",
    defaults: { use: "office", width: 50, depth: 50, floors: 40, podiumFloors: 5, towerCoverage: 40, facade: "glass_blue", penthouse: true, groundUse: "retail" },
  }),
];
