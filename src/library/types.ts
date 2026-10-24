// The primitive library: every placeable thing in a city (buildings of any type and shape,
// homes, campuses, shops, parks, street furniture, flora, fauna, water, utilities…) is a
// PrimitiveDef with a typed parameter schema. The schema drives three consumers with no
// per-primitive code: the sandbox palette and inspector (forms), the agent (tool schema and
// validation), and re-configuration of placed instances (regenerate from new params).
//
// Generators are pure: given params and a placement they return entities. They never touch
// the world; ops (src/world/ops/library.ts) commit them through OpBuilder so cascades, undo,
// scenarios, persistence, export and the simulation worker all see ordinary entities.

import type { Area, Building, Entity, LibraryRef, Path, Polygon, Prop, Street, Tree, Vec2 } from "@/world/types";

// ---------------------------------------------------------------- parameters

interface ParamBase {
  /** stable key used in params objects, tool input and saved files */
  key: string;
  label: string;
  description?: string;
  /** form section, e.g. "Massing", "Roof", "Facade", "Programme", "Planting" */
  group?: string;
  /** hidden behind "More options" in the form; still settable by the agent */
  advanced?: boolean;
  /** shown / applied only when another param has one of these values */
  when?: { key: string; in: (string | number | boolean)[] };
}

export interface NumberParam extends ParamBase {
  type: "number" | "integer";
  default: number;
  min?: number;
  max?: number;
  step?: number;
  /** display unit, e.g. "m", "m²", "°", "floors", "%", "per ha" */
  unit?: string;
}

export interface EnumParam extends ParamBase {
  type: "enum";
  default: string;
  options: { value: string; label: string; description?: string }[];
}

export interface BooleanParam extends ParamBase {
  type: "boolean";
  default: boolean;
}

/** "#rrggbb" */
export interface ColorParam extends ParamBase {
  type: "color";
  default: string;
  /** suggested swatches for the picker */
  swatches?: string[];
}

export interface TextParam extends ParamBase {
  type: "text";
  default: string;
  maxLength?: number;
}

/** a list of option values (e.g. uses in a mixed-use programme, species in a planting mix) */
export interface MultiParam extends ParamBase {
  type: "multi";
  default: string[];
  options: { value: string; label: string }[];
}

export type ParamSpec = NumberParam | EnumParam | BooleanParam | ColorParam | TextParam | MultiParam;
export type ParamValues = Record<string, unknown>;

// ---------------------------------------------------------------- definitions

/**
 * How a primitive is placed. point: click a spot (heading by drag or param). rect: drag a
 * rectangle (or point + width/depth params). polygon: draw a footprint / site. path: draw a line
 * (fences, hedges, walls, rows of lamps or trees, paths, streets).
 */
export type Placement = "point" | "rect" | "polygon" | "path";

export type Category =
  | "buildings"
  | "housing"
  | "commercial"
  | "civic"
  | "education"
  | "health"
  | "industrial"
  | "transport"
  | "streetscape"
  | "parks"
  | "recreation"
  | "flora"
  | "fauna"
  | "water"
  | "utilities"
  | "landmarks"
  | "composites";

export interface PlacementInput {
  /** anchor point (point placement; the centre for rect when no site is given) */
  at?: Vec2;
  /** heading, degrees counter-clockwise from east */
  rotation?: number;
  /** footprint / site polygon (rect and polygon placement) */
  site?: Polygon;
  /** centreline (path placement) */
  path?: Vec2[];
}

export interface GenerateContext {
  /** fresh entity id with a kind prefix (ids must be unique in the world) */
  id: (prefix: string) => string;
  /** the LibraryRef to stamp on every generated entity (primary flag set by the generator) */
  ref: LibraryRef;
  /** persons per household for programme estimates */
  householdSize: number;
}

/** what a generator returns: ordinary world entities, each stamped with ctx.ref */
export interface Generated {
  buildings?: Building[];
  props?: Prop[];
  trees?: Tree[];
  areas?: Area[];
  paths?: Path[];
  /** streets are created through the street ops (junction splicing), not added raw */
  streets?: { path: Vec2[]; cls: Street["cls"]; name?: string; bike?: "lane" | "track" | null; trees?: boolean }[];
  /** human-readable notes for the cascade report (what was made, key numbers) */
  summary?: string[];
  warnings?: string[];
}

export interface PrimitiveDef {
  /** dotted, stable id: "<category>.<name>", e.g. "housing.single_family_home" */
  id: string;
  name: string;
  category: Category;
  /** search keywords and synonyms ("apartment", "condo", "flats") */
  tags?: string[];
  /** one sentence: what it is and what it is for */
  description: string;
  placement: Placement;
  params: ParamSpec[];
  /** lucide icon name for the palette */
  icon?: string;
  generate(params: ParamValues, place: PlacementInput, ctx: GenerateContext): Generated;
}

export type { Entity };
