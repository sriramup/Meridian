// Definition of the sketch tool (executor: ./sketchTools.ts, builder: src/sketch/build.ts). Kept apart
// from the executor so the server route imports every tool definition without client-side code.

import type { ToolDef } from "./toolDefs";

const point = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] local metres" };

export const SKETCH_TOOL_DEFS: ToolDef[] = [
  {
    name: "build_sketch",
    description:
      "Build a sketch or photo the user attached (a bird's-eye plan read by the vision reader) as if it were a preset, in one reversible step: its streets by class (arterials, collectors, locals, pedestrian streets) spliced into the network, rivers / lakes, parks and plazas, labelled facilities from the library (a SCHOOL box becomes a real school), rail lines, and every block filled with the design generator's building fabric at the drawn use and density, plus street trees. Placement: on a blank canvas it takes the centre when empty, else the nearest free space large enough (never touching what is there); in a city it uses the session zone, else the view centre — or pass center (a point or a place name). Existing buildings are built around unless replace_existing (large demolitions ask the user). Frames the camera on the result and returns homes, jobs, streets, parks and facilities built.",
    input_schema: {
      type: "object",
      properties: {
        sketch_id: { type: "string", description: "the sketch_id from the [runtime] note that came with the image" },
        center: { description: "where to put the sketch's centre: [x,y] or a place name; omit to let the tool choose (free space / zone / view centre)", anyOf: [point, { type: "string" }] },
        size_m: { type: "number", description: "length of the sketch's long side on the ground, metres (default: the vision reader's estimate). Only when the user gives a size or the estimate is clearly wrong." },
        rotation_deg: { type: "number", description: "extra rotation, degrees counter-clockwise (the sketch's own north arrow is already applied)" },
        name: { type: "string", description: "name for the place (default: the sketch's title)" },
        density: { type: "string", enum: ["low", "medium", "high", "very_high"], description: "override every block's density (only when the user asks)" },
        replace_existing: { type: "boolean", description: "demolish buildings already on the site (asks the user for approval when many); default false: build around them" },
        seed: { type: "number", description: "variant number for the building fabric" },
        dry_run: { type: "boolean", description: "Preview only: compute the build and its report without applying it." },
      },
      required: ["sketch_id"],
    },
  },
];
