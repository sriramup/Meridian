// Tool definitions for the primitive library (pure data: imported by the server route through
// toolDefs.ts, so nothing here may import client code). Executors: src/agent/libraryTools.ts.

import type { ToolDef } from "./toolDefs";

const point = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] local metres" };
const polygon = { type: "array", items: point, minItems: 3, description: "outer ring [[x,y],...] in local metres" };
const location = { description: "[x,y] point, a feature id, a place name or 'A Street & B Street'", anyOf: [point, { type: "string" }] };
const area = { description: "polygon ring, place / feature id, or {center:[x,y], radius}", anyOf: [polygon, { type: "string" }, { type: "object", properties: { center: point, radius: { type: "number" } }, required: ["center", "radius"] }] };
const ids = { type: "array", items: { type: "string" }, description: "library instance ids (lib:…) or ids of any feature of an instance" };
const onConflict = { type: "string", enum: ["safe", "carve", "refuse", "replace"], description: "Existing buildings / solid objects in the way: safe (default; never overlap: a main building that would collide fails with the nearest free spot, a composite's colliding extras are skipped), refuse (fail on any collision), carve (keep them, cut the new one around them), replace (demolish them; historic buildings are always kept)." };
const dryRun = { type: "boolean", description: "Preview the change and its cascade without applying it." };

const layout = {
  type: "object",
  description:
    "Repeat the placement. type: grid{center, rows, cols, spacing (m or [dx,dy]), rotation°, stagger} | row{from, to (or path), count or spacing, align (default true: items face along the row)} | ring{center, radius, count, start_angle°, face:'center'|'out'|'tangent'|'none'} | scatter{area, count, min_spacing, seed, random_rotation} | along_street{street (id, name or ids), side:'left'|'right'|'both', offset (m from centreline; default just behind the kerb), spacing, start_offset, end_offset, face:'street'|'along'|'away'} | fill_area{area, spacing (m or [dx,dy]), pattern:'grid'|'hex', margin, rotation°}. lot:[w,d] gives each slot a rectangular site (for polygon / rect primitives, e.g. homes on lots). The item's own rotation is added to the layout's.",
  properties: {
    type: { type: "string", enum: ["grid", "row", "ring", "scatter", "along_street", "fill_area"] },
    center: location,
    from: location,
    to: location,
    path: { type: "array", items: location },
    area,
    street: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    side: { type: "string" },
    rows: { type: "number" },
    cols: { type: "number" },
    count: { type: "number" },
    spacing: { anyOf: [{ type: "number" }, point] },
    radius: { type: "number" },
    rotation: { type: "number" },
    start_angle: { type: "number" },
    face: { type: "string" },
    offset: { type: "number" },
    start_offset: { type: "number" },
    end_offset: { type: "number" },
    margin: { type: "number" },
    min_spacing: { type: "number" },
    seed: { type: "number" },
    pattern: { type: "string" },
    stagger: { type: "boolean" },
    align: { type: "boolean" },
    random_rotation: { type: "boolean" },
    lot: point,
  },
  required: ["type"],
};

const placement = {
  def: { type: "string", description: "primitive definition id from library_search, e.g. 'housing.apartment_block'" },
  params: { type: "object", description: "parameter values (see library_describe); omitted ones take their defaults" },
  at: location,
  rotation: { type: "number", description: "heading in degrees counter-clockwise from east" },
  face: { ...location, description: "turn the item to face this location (overrides rotation)" },
  site: area,
  size: { ...point, description: "[width, depth] m: a rectangular site around `at` for polygon primitives" },
  path: { type: "array", items: location, description: "centreline for path primitives (fences, rows, streets…)" },
  name: { type: "string" },
  layout,
};

export const LIBRARY_TOOL_DEFS: ToolDef[] = [
  {
    name: "library_search",
    effect: "read",
    description:
      "Search the primitive library: every placeable building block (buildings of all types and shapes, homes, apartments, campuses, shops, restaurants, offices, civic, parks, street furniture, lighting, flora, fauna, water, utilities, composites). query: words (name, synonyms); category filters. Returns definition ids with placement kind and a one-line summary of every parameter (key: type range = default). Empty query lists categories with counts. Call before place; use library_describe for full schemas.",
    input_schema: { type: "object", properties: { query: { type: "string" }, category: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "library_describe",
    effect: "read",
    description: "Full parameter schemas (type, range, unit, options with descriptions, defaults, groups, conditions) for primitive definition ids.",
    input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
  },
  {
    name: "place",
    effect: "edit",
    description:
      "Place library primitives. One placement: def + params + location (at for point, site or at for rect, site for polygon, path for path primitives). Batch: items:[{def, params, at|site|path, rotation, face, name, layout}] — top-level fields are defaults for every item; everything lands as ONE undoable change. layout repeats an item (grid, row, ring, scatter, along_street, fill_area). Every placed entity remembers its instance (lib:…) and parameters, so it can be re-configured later with configure. Conflicts: buildings are cut out of street right-of-way and water; on_conflict decides about existing buildings; trees need crown room; objects stay off carriageways / buildings / water / other objects unless designed for it — positions that don't fit are skipped and reported. Parameters are validated: unknown or invalid values fail the item (with the reason), out-of-range numbers are clamped (reported).",
    input_schema: { type: "object", properties: { ...placement, items: { type: "array", items: { type: "object", properties: placement } }, on_conflict: onConflict, dry_run: dryRun } },
  },
  {
    name: "configure",
    effect: "edit",
    description: "Change parameters of placed library instances; each is regenerated in place (same instance and feature ids, placement, other parameters and user-given names kept). ids + params applies one patch to all; items:[{id, params}] gives each its own. One undoable change.",
    input_schema: { type: "object", properties: { ids, params: { type: "object" }, items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, params: { type: "object" } }, required: ["id", "params"] } }, on_conflict: onConflict, dry_run: dryRun } },
  },
  {
    name: "move_instance",
    effect: "edit",
    description: "Move library instances by an offset (by:[dx,dy] m) or so the first one's anchor lands at `to` (others keep their relative positions). Regenerated at the new place with the same conflict rules.",
    input_schema: { type: "object", properties: { ids, by: point, to: location, on_conflict: onConflict, dry_run: dryRun }, required: ["ids"] },
  },
  {
    name: "rotate_instance",
    effect: "edit",
    description: "Rotate library instances by degrees (counter-clockwise) about their own anchor, or all about `about`.",
    input_schema: { type: "object", properties: { ids, degrees: { type: "number" }, about: location, on_conflict: onConflict, dry_run: dryRun }, required: ["ids", "degrees"] },
  },
  {
    name: "duplicate_instance",
    effect: "edit",
    description: "Copy library instances (same definition and parameters, optionally overridden by params) offset by [dx,dy] m, count times (each copy one more offset further).",
    input_schema: { type: "object", properties: { ids, offset: point, count: { type: "number" }, params: { type: "object" }, on_conflict: onConflict, dry_run: dryRun }, required: ["ids", "offset"] },
  },
  {
    name: "remove_instance",
    effect: "edit",
    description: "Remove whole library instances (every building, object, tree, area, path and street they generated).",
    input_schema: { type: "object", properties: { ids, dry_run: dryRun }, required: ["ids"] },
  },
  {
    name: "custom_building",
    effect: "edit",
    description:
      "Escape hatch: a building of any form from explicit massing variables when no catalog primitive fits (it is placed as primitive 'custom.building', so configure works on it). site (polygon) or at + width/depth/rotation. shape: rect|square|circle|ellipse|polygon(sides)|triangle|trapezoid|l_shape|u_shape|t_shape|h_shape|cross|courtyard|ring|site (wing = bar depth). typology: extrude (stack the plan; tiers + taper (top scale) + twist° make tapered / twisted / stepped towers; podium_floors + podium_inset) or a procedural typology (block, tower_podium, courtyard, slab, terraced, l_shape, u_shape, point_towers, twin_towers, stepped_tower, rowhouses, midrise, pavilion with tower_coverage, tower_count, bar_depth, setback_every, setback_depth, edge_setback, crown). floors, floor_height, ground_floor_height. roof: flat|gable|hip|shed|pyramid|dome|barrel|sawtooth|mansard (+ roof_height, roof_color), green_roof. color (#rrggbb or name), facade: glass|masonry|concrete|metal|timber|stucco. use + mix_residential/office/retail/hotel/civic/education/health/industrial (% of floor area), units / jobs to state occupancy. name.",
    input_schema: {
      type: "object",
      properties: {
        site: area,
        at: location,
        rotation: { type: "number" },
        shape: { type: "string" },
        width: { type: "number" },
        depth: { type: "number" },
        sides: { type: "number" },
        wing: { type: "number" },
        typology: { type: "string" },
        floors: { type: "number" },
        floor_height: { type: "number" },
        ground_floor_height: { type: "number" },
        tiers: { type: "number" },
        taper: { type: "number" },
        twist: { type: "number" },
        podium_floors: { type: "number" },
        podium_inset: { type: "number" },
        roof: { type: "string" },
        roof_height: { type: "number" },
        roof_color: { type: "string" },
        green_roof: { type: "boolean" },
        color: { type: "string" },
        facade: { type: "string" },
        use: { type: "string" },
        units: { type: "number" },
        jobs: { type: "number" },
        name: { type: "string" },
        params: { type: "object", description: "any other custom.building parameters (see library_describe custom.building)" },
        on_conflict: onConflict,
        dry_run: dryRun,
      },
    },
  },
  {
    name: "custom_prop",
    effect: "edit",
    description:
      "Escape hatch: any object from raw solids when no catalog primitive fits (placed as primitive 'custom.prop'; configure works on it). solids: [{shape: box|cylinder|cone|sphere|hemisphere|wedge (ridge along x)|pyramid|torus, at:[x,y,z] base centre in the object's frame (x east / y north before rotation, z up, m), size:[x,y,z] full extents, rot?: yaw°, tilt?: [pitch°, roll°], color: '#rrggbb' or [r,g,b], material?: foliage|wood|metal|stone|concrete|glass|water|fabric|plastic|fur|light}]. shade_radius / shade_height make it shade like a tree crown; cover sets what its footprint counts as (water, paving, planting, lawn, permeable, raingarden, woodland, bare). layout repeats it.",
    input_schema: { type: "object", properties: { at: location, rotation: { type: "number" }, face: location, solids: { type: "array", items: { type: "object" } }, shade_radius: { type: "number" }, shade_height: { type: "number" }, cover: { type: "string" }, allow_carriageway: { type: "boolean" }, name: { type: "string" }, layout, dry_run: dryRun }, required: ["at", "solids"] },
  },
];
