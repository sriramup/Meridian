// Definitions of the design tools (executor: ./designTools.ts, generator: src/design/**). Kept apart
// from the executor so the server route imports every tool definition without client-side code.

import type { ToolDef } from "./toolDefs";

const point = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] local metres" };
const area = {
  description: "The site: polygon ring [[x,y],...] in local metres, a place / park / district name, a feature id, 'zone' (the session zone) or {center:[x,y], radius:m}.",
  anyOf: [{ type: "array", items: point, minItems: 3 }, { type: "string" }, { type: "object", properties: { center: point, radius: { type: "number" } }, required: ["center", "radius"] }],
};
const FACILITIES = ["university", "high_school", "middle_school", "primary_school", "daycare", "police", "fire", "restaurant", "cafe", "grocery", "library", "clinic", "community_center", "hotel", "park", "plaza"];

export const DESIGN_TOOL_DEFS: ToolDef[] = [
  {
    name: "design_neighborhood",
    description:
      "Design a complete neighborhood on a site in one reversible step: street hierarchy (bounding avenues, collectors about every quarter mile, a main street, local streets making 200–400 ft blocks), civic superblocks sized to standards (schools by enrolment, university, neighborhood parks), fire / police on arterials, cafés and restaurants on the main street, a plaza and pocket parks so every home is within a quarter-mile walk of open space, then every block filled from the building library on an intensity ladder (houses → plexes → townhouses → walk-ups → 5-over-1 → mid-rise → towers, offices for jobs) to meet the homes target, with street trees. The result includes the design's critique scorecard (0–100, issues with locations). Same inputs + seed → same design; change seed for a variant. Use it for any 'design / masterplan a neighborhood / district / town' request instead of composing streets and buildings by hand. Size the area to the programme: walkable mixed-use runs 25–40 homes per gross acre (2,400 homes ≈ 60–100 acres, a square of about 500–650 m); a much larger site gives a thin, suburban result.",
    input_schema: {
      type: "object",
      properties: {
        area,
        name: { type: "string" },
        homes: { type: "number", description: "target dwelling units (wins over population)" },
        population: { type: "number", description: "target residents (≈2.5 per home)" },
        jobs: { type: "number" },
        density: { type: "string", enum: ["low", "medium", "high", "very_high"], description: "overall intensity; inferred from the targets when omitted" },
        facilities: {
          description: `Civic and commercial programme: a list of {kind, count?, name?, enrolment?} (kind: ${FACILITIES.join(" | ")}), or the user's words ('a primary school, two parks and a few cafés').`,
          anyOf: [{ type: "array", items: { type: "object", properties: { kind: { type: "string", enum: FACILITIES }, count: { type: "number" }, name: { type: "string" }, enrolment: { type: "number" } }, required: ["kind"] } }, { type: "string" }],
        },
        mix: { type: "object", description: "share of floor area by use, e.g. {residential:0.8, retail:0.1, office:0.1}", properties: { residential: { type: "number" }, office: { type: "number" }, retail: { type: "number" } } },
        open_space: { type: "number", description: "share of block land kept as public parks / plazas (0–0.4)" },
        max_floors: { type: "number" },
        min_floors: { type: "number" },
        centre: { description: "the activity centre (main-street crossing): [x,y] or a place name; default the site centre", anyOf: [point, { type: "string" }] },
        block_length: { type: "number", description: "local street spacing along the long side of blocks (m); default by density" },
        block_depth: { type: "number", description: "block depth (m)" },
        arterials: { type: "boolean", description: "bound the site with avenues (default true)" },
        replace_existing: { type: "boolean", description: "demolish buildings already on the site (default: design around them)" },
        palette: { type: "string", enum: ["masonry", "texas", "modern", "coastal"] },
        seed: { type: "number", description: "variant number (default 1)" },
      },
      required: ["area"],
    },
  },
  {
    name: "critique_design",
    description:
      "Score an area's urban design 0–100 (grade A–F) against planning standards: unbuilt land, coverage, FAR, building-type diversity and repetition, street-wall continuity on main streets, park access (quarter mile), school access (half mile), block size, intersection density, street standards and height gradient. Returns metrics with targets and the top issues with map locations. Works on new designs and on the existing city. Use it after designing or editing, and fix high-severity issues before reporting.",
    input_schema: { type: "object", properties: { area, max_issues: { type: "number" }, show_issues: { type: "boolean", description: "place the issues as callouts on the map" } }, required: ["area"] },
    effect: "read",
  },
];
