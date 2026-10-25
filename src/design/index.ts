// Meridian design generator — public API (wrap these as agent tools).
//
//   designNeighborhood(world, spec, actor) → OpResult
//     Lays out a complete neighbourhood inside spec.area in ONE changeset: a street hierarchy
//     (boulevards / avenues bounding it, collectors every ¼ mi, a main street, local streets forming
//     200–400 ft blocks), civic superblocks (university campus district, high / middle / primary
//     schools sized to enrolment norms, neighbourhood parks), reserved frontage (fire and police on
//     arterials, restaurants and cafés, a plaza, pocket parks so every home is within a ¼-mi walk of
//     open space), then fills every block with lots and buildings from the library catalog on an
//     intensity ladder solved to meet the homes target (detached houses → plexes → townhouses →
//     walk-ups → 5-over-1 → mid-rise → towers, offices for jobs), with courtyards, gardens, parking
//     structures and street trees. Deterministic per spec.seed. Undo is one step.
//     spec: NeighborhoodSpec { area (polygon ring in local metres), density? ("low" | "medium" |
//     "high" | "very_high"), homes? | population? | far?, jobs?, mix?, facilities? [{kind, count?,
//     name?, enrolment?}], openSpace?, maxFloors?, minFloors?, centre?, streets? {blockLength,
//     blockDepth, arterials, build}, replaceExisting?, palette?, seed?, name? }.
//     result.data: homes, residents, jobs, gfa_sqft, buildings, density, target_homes, typologies,
//     civic, facilities, street_trees, parking_structures, palette, area.
//
//   critiqueArea(world, area, opts?) → Scorecard
//     Scores any area 0–100 (grade A–F) on unbuilt land, coverage, FAR, building diversity, street-wall
//     continuity on main streets, park access (¼ mi), school access (½ mi), block size, intersection
//     density, street standards and height gradient, and returns the top issues with map locations
//     (local metres) and imperial-unit messages. Works on generated designs and measured cities.
//
//   facilitiesFromText(text) → FacilityRequest[]
//     Reads facilities out of a plain request ("a university, three schools, two restaurants and a few
//     parks") for spec.facilities.

export { designNeighborhood } from "./neighborhood";
export { critiqueArea, type Scorecard, type Metric, type DesignIssue, type CritiqueOptions } from "./critique";
export { facilitiesFromText, resolveProgramme, type NeighborhoodSpec, type FacilityRequest, type FacilityKind, type DensityClass, type PaletteName } from "./programme";
export { planStreetGrid, sectionFor, type GridPlan, type StreetRole } from "./streets";
