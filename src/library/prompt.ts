// System-prompt guidance for composing library primitives (merged into the agent's system prompt
// by the agent runtime).

export const LIBRARY_PROMPT = `## Building with the primitive library

The library holds configurable building blocks for everything placeable: buildings of every type and shape, homes, apartments, campuses, shops, restaurants, offices, civic buildings, parks, plazas, street furniture, lighting, play equipment, flora, fauna, water features, utilities and composites. Each primitive has a typed parameter schema; use as many parameters as the request implies — sizes, floors, shapes, roof forms, colours, materials, programme / occupancy, counts, spacing, species. Don't hard-code a fixed recipe: compose primitives to match exactly what the user asks for.

Workflow
1. library_search (words or a category) → candidate definition ids with every parameter summarised; library_describe for full schemas (ranges, options, conditions) when you need detail.
2. place: def + params + location. Point primitives take at; rect primitives take site or at (+ width / depth params); polygon primitives take site (or at + size); path primitives take path. rotation is degrees counter-clockwise from east; face:<location> turns an object's front toward something (fronts face local +y).
3. Batch: put many placements in ONE place call with items:[…] (shared defaults at the top level) and layouts — grid, row, ring, scatter, along_street (furniture / lamps / trees behind the kerb, facing the street), fill_area (lots with lot:[w,d] for houses, or planting) — so the whole composition is one undoable change.
4. Refine with configure (ids + params patch; regenerates in place keeping ids, placement, other params and user names), move_instance, rotate_instance, duplicate_instance, remove_instance. Every feature a primitive generated carries its instance id (lib:…); get_feature shows the definition and parameters, find_features kind "prop" (or any kind) with where{def, category, instance} finds them.
5. Nothing fits? custom_building (any massing: plan shape, tiers / taper / twist, podium, setbacks, roof form, colour, façade, use mix, stated homes / jobs) or custom_prop (raw solids). Both stay configurable.

Composition tips
- Build the frame first (streets), then buildings and sites, then landscape, then street furniture and details.
- Parameters are validated: unknown keys or invalid values fail that item with the reason (fix and retry); out-of-range numbers are clamped and reported.
- Conflicts are resolved, not ignored: buildings are cut out of street right-of-way and water; solid things never overlap: by default (on_conflict "safe") a building that would collide fails with the nearest free spot (use it, or move), "carve" cuts the new one around what is there, "replace" demolishes (never historic ones). Trees need room for their crowns; objects stay off carriageways, buildings, water and each other unless designed for it. Skipped positions are reported — read the summary and adjust spacing or location.
- Stated occupancy (homes, jobs) and use mix on buildings feed traffic, access, heat, runoff and the metrics; shade-casting objects (canopies, shade sails, trees) and ground covers (water, planting, paving) feed the heat, sun and runoff models.
- Use dry_run:true to preview a large composition before committing it.`;
