// Fauna: decorative animals built from simple solids — birds (single or flocks), waterfowl,
// pets, urban wildlife and farm / park animals. Purely visual (no simulation effect); sizes are
// typical adult body lengths and shoulder heights.

import { fmtDepth } from "@/lib/units";
import type { Solid } from "@/world/types";
import type { PrimitiveDef } from "../types";
import { C, hexToRgb, shade } from "../geometry/palette";
import { birdSolids, quadrupedSolids, scatter, type BirdSpec, type QuadrupedSpec } from "../geometry/props";
import { scaleSolids } from "../geometry/solids";
import { propDef } from "./kinds";
import { bool, color, int, num } from "./params";
import type { RGB } from "../geometry/solids";

const FA = "fauna" as const;
const D = "Dimensions",
  A = "Appearance",
  G = "Group";

const hex = (c: RGB) => "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");

interface AnimalPreset {
  id: string;
  name: string;
  tags: string[];
  description: string;
  icon: string;
  /** default group size */
  count: number;
  spread: number;
  color: RGB;
  accent?: RGB;
  water?: boolean;
  build: (col: RGB, acc: RGB | undefined, i: number) => Solid[];
  /** reference body length (m) the builder is drawn at */
  length: number;
}

const quad = (q: Omit<QuadrupedSpec, "color" | "accent">) => (col: RGB, acc: RGB | undefined, i: number) => quadrupedSolids({ ...q, color: i % 3 === 2 ? shade(col, 0.85) : col, accent: acc });
const bird = (b: Omit<BirdSpec, "color" | "head">, head?: boolean) => (col: RGB, acc: RGB | undefined, i: number) => birdSolids({ ...b, color: i % 2 ? shade(col, 0.9) : col, head: head ? acc : undefined, wingsOpen: b.wingsOpen || (i % 5 === 3 && !b.floating) });

const ANIMALS: AnimalPreset[] = [
  { id: "pigeons", name: "Pigeons", tags: ["pigeon", "rock dove", "birds", "flock"], description: "A flock of rock pigeons pecking on paving.", icon: "bird", count: 12, spread: 3, color: [150, 154, 166], accent: [96, 120, 120], length: 0.32, build: bird({ length: 0.32, legs: 0.06 }, true) },
  { id: "songbirds", name: "Songbirds", tags: ["sparrow", "robin", "finch", "birds", "grackle"], description: "Small songbirds on the ground.", icon: "bird", count: 6, spread: 2, color: [140, 110, 80], accent: [190, 90, 60], length: 0.15, build: bird({ length: 0.15, legs: 0.03 }, true) },
  { id: "ducks", name: "Ducks", tags: ["mallard", "duck", "waterfowl", "pond birds"], description: "Mallards floating on a pond (or waddling on the bank).", icon: "bird", count: 6, spread: 4, color: [130, 110, 84], accent: [40, 110, 70], water: true, length: 0.55, build: bird({ length: 0.55, floating: true, neck: 0.15 }, true) },
  { id: "geese", name: "Geese", tags: ["canada goose", "goose", "waterfowl"], description: "Canada geese on a lawn or water.", icon: "bird", count: 5, spread: 5, color: [120, 104, 88], accent: [30, 30, 32], water: true, length: 0.9, build: bird({ length: 0.9, neck: 0.55, legs: 0.2 }, true) },
  { id: "swans", name: "Swans", tags: ["swan", "mute swan", "waterfowl"], description: "Swans gliding on water.", icon: "bird", count: 2, spread: 6, color: [244, 244, 240], accent: [244, 244, 240], water: true, length: 1.3, build: bird({ length: 1.3, neck: 0.7, floating: true }, true) },
  { id: "chickens", name: "Chickens", tags: ["hens", "poultry", "backyard chickens", "rooster"], description: "Backyard hens.", icon: "egg", count: 5, spread: 3, color: [200, 140, 90], accent: [200, 60, 50], length: 0.4, build: bird({ length: 0.4, legs: 0.12, neck: 0.2 }, true) },
  { id: "dog", name: "Dog", tags: ["dog", "pet", "puppy", "labrador", "canine"], description: "A dog (size from terrier to large retriever).", icon: "dog", count: 1, spread: 3, color: [196, 150, 90], accent: [222, 196, 150], length: 0.8, build: quad({ length: 0.8, height: 0.58, neck: 0.25, neckAngle: 45, head: 0.28, tail: 0.4, tailAngle: 30, ears: "floppy", girth: 0.5 }) },
  { id: "cat", name: "Cat", tags: ["cat", "kitten", "pet", "feline"], description: "A cat (sitting or walking).", icon: "cat", count: 1, spread: 2, color: [90, 86, 84], accent: [220, 214, 204], length: 0.45, build: (col, acc, i) => quadrupedSolids({ length: 0.45, height: 0.26, neck: 0.15, neckAngle: 55, head: 0.3, tail: 0.6, tailAngle: 50, ears: "pointed", girth: 0.55, sitting: i % 2 === 0, color: col, accent: acc }) },
  { id: "squirrels", name: "Squirrels", tags: ["squirrel", "grey squirrel", "fox squirrel", "wildlife", "rodent"], description: "Squirrels with bushy tails.", icon: "squirrel", count: 3, spread: 4, color: [140, 120, 104], accent: [176, 150, 120], length: 0.25, build: (col, acc, i) => quadrupedSolids({ length: 0.25, height: 0.12, neck: 0.15, neckAngle: 60, head: 0.32, tail: 1.0, tailAngle: 70, ears: "pointed", girth: 0.7, bushyTail: true, sitting: i % 2 === 1, color: col, accent: acc }) },
  { id: "rabbits", name: "Rabbits", tags: ["rabbit", "bunny", "cottontail", "hare"], description: "Cottontail rabbits on a lawn.", icon: "rabbit", count: 3, spread: 4, color: [150, 130, 110], accent: [236, 232, 224], length: 0.35, build: (col, acc) => quadrupedSolids({ length: 0.35, height: 0.18, neck: 0.1, neckAngle: 60, head: 0.35, tail: 0.12, tailAngle: 60, ears: "long", girth: 0.9, sitting: true, color: col, accent: acc }) },
  { id: "deer", name: "Deer", tags: ["white-tailed deer", "doe", "buck", "stag", "wildlife"], description: "White-tailed deer (bucks with antlers).", icon: "paw-print", count: 3, spread: 8, color: [160, 120, 84], accent: [236, 226, 210], length: 1.6, build: (col, acc, i) => quadrupedSolids({ length: 1.6, height: 1.0, neck: 0.4, neckAngle: 55, head: 0.22, tail: 0.12, tailAngle: 50, ears: "pointed", girth: 0.4, antlers: i === 0, color: col, accent: acc }) },
  { id: "horses", name: "Horses", tags: ["horse", "pony", "equine", "mounted police", "carriage horse"], description: "Horses (≈ 5 ft 3 in at the shoulder).", icon: "paw-print", count: 2, spread: 6, color: [110, 74, 52], accent: [40, 34, 30], length: 2.2, build: quad({ length: 2.2, height: 1.6, neck: 0.42, neckAngle: 55, head: 0.28, tail: 0.4, tailAngle: -40, ears: "pointed", girth: 0.42 }) },
  { id: "cows", name: "Cattle", tags: ["cow", "cattle", "livestock", "farm animals", "longhorn"], description: "Grazing cattle.", icon: "beef", count: 4, spread: 10, color: [60, 50, 46], accent: [236, 232, 224], length: 2.2, build: quad({ length: 2.2, height: 1.4, neck: 0.2, neckAngle: 10, head: 0.25, tail: 0.35, tailAngle: -70, ears: "pointed", girth: 0.6 }) },
  { id: "sheep", name: "Sheep", tags: ["sheep", "lamb", "flock", "goats", "grazing"], description: "Grazing sheep (useful for meadow management!).", icon: "cloud", count: 6, spread: 8, color: [236, 232, 220], accent: [40, 38, 36], length: 1.2, build: quad({ length: 1.2, height: 0.8, neck: 0.15, neckAngle: 20, head: 0.25, tail: 0.1, tailAngle: -60, ears: "floppy", girth: 0.75 }) },
];

function animalDef(a: AnimalPreset): PrimitiveDef {
  return propDef({
    id: `fauna.${a.id}`,
    name: a.name,
    category: FA,
    tags: ["animal", "wildlife", ...a.tags],
    description: `${a.description} Decorative.`,
    icon: a.icon,
    siting: { water: !!a.water, overlapProps: true },
    params: [
      int("count", "Number", a.count, { group: G, min: 1, max: 60 }),
      num("spread", "Spread radius", a.spread, { group: G, unit: "m", min: 0, max: 50, step: 0.5, description: "Animals are scattered within this radius" }),
      num("size", "Size", 100, { group: D, unit: "%", min: 30, max: 250, step: 5, description: `100 % ≈ ${fmtDepth(a.length)} long` }),
      color("color", "Colour", hex(a.color), { group: A }),
      ...(a.accent ? [color("accent", "Accent colour", hex(a.accent), { group: A })] : []),
      int("seed", "Arrangement", 1, { group: G, min: 1, max: 999, advanced: true }),
    ],
    build: (r) => {
      const col = hexToRgb(r.c("color"), a.color);
      const acc = a.accent ? hexToRgb(r.c("accent"), a.accent) : undefined;
      const k = r.n("size") / 100;
      const n = r.n("count");
      const solids = n === 1 ? a.build(col, acc, 0) : scatter((i) => a.build(col, acc, i), n, r.n("spread"), r.n("seed"));
      return { solids: scaleSolids(solids, k) };
    },
  });
}

export const FAUNA: PrimitiveDef[] = [...ANIMALS.map(animalDef)];

/** a crowd of people for scale and liveliness (pedestrians, an audience, a market crowd) */
export const PEOPLE: PrimitiveDef = propDef({
  id: "fauna.people",
  name: "People",
  category: FA,
  tags: ["pedestrians", "crowd", "person", "figures", "scale figures", "people"],
  description: "Simple standing figures (≈ 5 ft 7 in) for scale and liveliness: a few pedestrians or a crowd.",
  icon: "users",
  siting: { overlapProps: true },
  params: [int("count", "People", 6, { group: G, min: 1, max: 200 }), num("spread", "Spread radius", 5, { group: G, unit: "m", min: 0, max: 60, step: 0.5 }), bool("varied", "Varied clothing", true, { group: A }), int("seed", "Arrangement", 1, { group: G, min: 1, max: 999, advanced: true })],
  build: (r) => {
    const cols: RGB[] = [[60, 90, 140], [180, 70, 60], [70, 70, 74], [210, 180, 90], [90, 130, 90], [220, 220, 214], [130, 90, 140]];
    const person = (i: number): Solid[] => {
      const c = r.b("varied") ? cols[i % cols.length] : ([90, 96, 104] as RGB);
      const h = 1.6 + ((i * 37) % 30) / 100;
      return [
        { shape: "cylinder", at: [0, -0.08, 0], size: [0.13, 0.13, h * 0.47], color: [60, 60, 70], material: "fabric" },
        { shape: "cylinder", at: [0, 0.08, 0], size: [0.13, 0.13, h * 0.47], color: [60, 60, 70], material: "fabric" },
        { shape: "cylinder", at: [0, 0, h * 0.45], size: [0.26, 0.4, h * 0.36], color: c, material: "fabric" },
        { shape: "sphere", at: [0, 0, h * 0.81], size: [0.2, 0.2, h * 0.17], color: [[226, 190, 160], [176, 130, 100], [120, 84, 60], [240, 210, 180]][i % 4] as RGB, material: "plastic" },
      ];
    };
    return { solids: r.n("count") === 1 ? person(0) : scatter(person, r.n("count"), r.n("spread"), r.n("seed")) };
  },
});

FAUNA.push(PEOPLE);
export { C };
