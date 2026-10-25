// Definition of the navigation tool (executor: ./navTools.ts). Kept apart from the executor so the
// server route can import every tool definition without pulling in client-side map code.

import type { ToolDef } from "./toolDefs";

export const NAV_TOOL_DEFS: ToolDef[] = [
  {
    name: "go_to",
    description:
      "Take the user somewhere: resolves an intersection ('21st & Guadalupe', 'W 21st St and Guadalupe St'), a street ('Pine Street' — frames the whole corridor), a place, park, campus, landmark, named building, feature id or [x,y] point, then flies the camera there and highlights it. Fuzzy: tolerates missing St/Ave, E/W prefixes, ordinals in words and small typos. Use it alone for 'take me to / show me / where is …' requests — no other lookup is needed. Returns what it resolved and close alternatives; if nothing matches it returns suggestions (ask the user which one they meant).",
    input_schema: {
      type: "object",
      properties: {
        place: { description: "what to go to: a name, an intersection, a feature id, or [x,y]", anyOf: [{ type: "string" }, { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }] },
        street_level: { type: "boolean", description: "eye-level street view at the target instead of the aerial view" },
        zoom: { type: "number", description: "override the framing (15 district … 18.5 a single building)" },
      },
      required: ["place"],
    },
    effect: "view",
  },
];
