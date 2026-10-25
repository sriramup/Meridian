// The vision request that reads a sketch or photo into a SketchPlan: one Messages API call with the
// image as a base64 block and the plan schema as the one tool the model must call. Built as a pure
// function so its shape (image block, forced tool, caching, model choice) is tested without a key
// (tests/sketch-vision.test.ts); the route (src/app/api/vision/route.ts) sends it and books the cost.
//
// Model: MERIDIAN_MODEL_VISION, else the standard tier's model (src/agent/models.ts tierModels).
// Forcing: tool_choice {type:"tool"} guarantees exactly one structured answer — but forced tool use
// cannot be combined with thinking, and some models (Opus 5.5, Sonnet 5.5, Fable 5.1) reject a forced
// tool_choice outright. For those the request falls back to tool_choice "auto" + an instruction to
// call the tool; either way the server only reads the tool input, and normalisePlan validates it.
// Caching: the system prompt and the tool schema are byte-identical for every request (cache
// breakpoint on the system block), so only the image and the short instruction are paid in full.

import { tierModels } from "@/agent/models";
import { SKETCH_TOOL, SKETCH_TOOL_NAME, normalisePlan, type SketchPlan } from "./plan";

export type ImageMedia = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface VisionBody {
  /** base64 image data (no data: prefix) */
  image: string;
  media_type?: ImageMedia;
  /** the user's words sent with the image ("a riverside neighbourhood with a school") */
  hint?: string;
  /** pixel size of the image (for the prompt: the aspect ratio) */
  width?: number;
  height?: number;
}

export const VISION_SYSTEM = `You read hand-drawn and printed urban plans for a city-planning tool. The image is usually a photo of a whiteboard, paper sketch or printed map seen from above (bird's-eye / plan view). Turn it into structured data by calling ${SKETCH_TOOL_NAME} exactly once.

How to read a sketch:
- Coordinates are normalised to the image: x 0 = left edge … 1 = right edge, y 0 = top edge … 1 = bottom edge. Ignore photo borders, the board frame and glare; read what is drawn.
- Streets: every drawn street as a centreline polyline, ends extended to the street they meet so the network connects. Thick, double or emphasised lines and words like avenue / boulevard / highway are arterials; medium lines collectors; thin lines locals; dashed lines or "walk" / "promenade" pedestrian. Copy written street names.
- Water: rivers and canals as a centreline with a width in metres (wavy double lines, blue, "river"); lakes and ponds as outlines.
- Parks and greens: outlines (often hatched, scribbled trees, "park"). Plazas / squares as outlines.
- Facilities: boxes or symbols with a label (SCHOOL, HOSPITAL, STATION, FIRE, POLICE, LIBRARY…): the centre, and the box outline when drawn.
- Blocks: only those distinguished by a label, hatching, a use or a height ("offices", "housing 4–6 storeys", "MIXED USE"); the rest are filled with default_use / default_density.
- Rail and transit lines: hatched or dashed lines labelled rail / tram / metro / bus, with station dots.
- Extent: the real-world width and height the whole image covers. Use a scale bar or written dimensions when there is one; else infer from typical sizes (urban blocks 60–150 m a side, local streets 80–150 m apart, an arterial grid about 800 m apart, a school site 100–200 m) and say how confident you are.
- North: the direction of a drawn north arrow, else null.
- Be faithful: do not invent features that are not drawn. Prefer fewer, correct features over many guessed ones.

If the image is not a plan view of a place (a person, a selfie, a room, a document page, a street-level photo, an elevation or perspective drawing, a chart), call the tool with is_plan false, a short not_plan_reason, an extent of 0 × 0 and empty lists.`;

/** models that reject a forced tool_choice (and cannot turn thinking off) */
export function rejectsForcedTools(model: string): boolean {
  return /claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)(\b|$)/.test(model);
}

export function visionModel(env: Record<string, string | undefined> = process.env): string {
  return env.MERIDIAN_MODEL_VISION || tierModels(env).standard;
}

/** output ceiling: a dense plan is a few thousand tokens of coordinates */
export const VISION_MAX_TOKENS = 6000;

export function buildVisionRequest(body: VisionBody, env: Record<string, string | undefined> = process.env): { model: string; forced: boolean; params: Record<string, unknown> } {
  const model = visionModel(env);
  const forced = !rejectsForcedTools(model);
  const aspect = body.width && body.height ? ` The image is ${body.width} × ${body.height} pixels (width:height ${(body.width / body.height).toFixed(2)}).` : "";
  const hint = body.hint?.trim() ? `\nThe user wrote with it: “${body.hint.trim().slice(0, 400)}”` : "";
  const params: Record<string, unknown> = {
    model,
    max_tokens: VISION_MAX_TOKENS,
    system: [{ type: "text", text: VISION_SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: [SKETCH_TOOL],
    // forced: exactly one call of the plan tool, thinking off (forced tool use and thinking don't mix);
    // otherwise the model decides (it is told to call the tool) and thinks at low effort
    tool_choice: forced ? { type: "tool", name: SKETCH_TOOL_NAME, disable_parallel_tool_use: true } : { type: "auto", disable_parallel_tool_use: true },
    ...(forced ? { thinking: { type: "disabled" } } : { thinking: { type: "adaptive" } }),
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: body.media_type ?? "image/jpeg", data: body.image } },
          { type: "text", text: `Read this plan and call ${SKETCH_TOOL_NAME}.${aspect}${hint}` },
        ],
      },
    ],
  };
  return { model, forced, params };
}

/** the result the client gets back */
export type VisionResult = { ok: true; plan: SketchPlan } | { ok: false; not_plan: true; reason: string; plan: SketchPlan } | { ok: false; error: string };

/** read the response: only the plan tool's input counts (no free text is parsed) */
export function parseVisionResponse(msg: { content?: { type: string; name?: string; input?: unknown }[]; stop_reason?: string | null }): VisionResult {
  if (msg.stop_reason === "refusal") return { ok: false, error: "The model declined to read this image." };
  const use = (msg.content ?? []).find((b) => b.type === "tool_use" && b.name === SKETCH_TOOL_NAME);
  if (!use) return { ok: false, error: msg.stop_reason === "max_tokens" ? "The plan was too detailed to read in one pass; try a simpler or tighter crop." : "The model did not return a plan." };
  const plan = normalisePlan(use.input);
  if (!plan.is_plan) return { ok: false, not_plan: true, reason: plan.not_plan_reason ?? "this doesn't look like a plan", plan };
  return { ok: true, plan };
}

/** largest accepted request (base64 characters): ≈ 3.7 MB of image, far above a 1568 px JPEG */
export const MAX_IMAGE_B64 = 5_000_000;
