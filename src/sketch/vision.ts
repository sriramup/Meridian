// The vision request that reads a sketch or photo into a SketchPlan: one Messages API call with the
// image as a base64 block and the plan schema as the one tool the model must call. Built as a pure
// function so its shape (image block, forced tool, caching, model choice) is tested without a key
// (tests/sketch-vision.test.ts); the route (src/app/api/vision/route.ts) sends it and books the cost.
//
// Two stages. "frame" finds the drawn map's four corners in the photo (a few hundred tokens out) so the
// browser can straighten it (src/sketch/rectify.ts) and draw a reference grid; "plan" then reads the
// straightened drawing. Reading coordinates off a tilted whiteboard photo is where vision models go
// wrong; off an upright one with a grid they are close to exact.
// Models: the plan read uses MERIDIAN_MODEL_VISION, the frame MERIDIAN_MODEL_VISION_FRAME, each else
// the standard tier's model (src/agent/models.ts tierModels). On harder sketches
// MERIDIAN_MODEL_VISION=claude-opus-5-5 reads the plan more faithfully (≈ $0.07 and ~25 s a read).
// Forcing: tool_choice {type:"tool"} guarantees exactly one structured answer — but forced tool use
// cannot be combined with thinking, and some models (Opus 5.5, Sonnet 5.5, Fable 5.1) reject a forced
// tool_choice outright. For those the request falls back to tool_choice "auto" + an instruction to
// call the tool; either way the server only reads the tool input, and normalisePlan validates it.
// Caching: the system prompt and the tool schema are byte-identical for every request (cache
// breakpoint on the system block), so only the image and the short instruction are paid in full.

import { tierModels } from "@/agent/models";
import { SKETCH_TOOL, SKETCH_TOOL_NAME, normalisePlan, type Pt, type SketchPlan } from "./plan";
import type { FrameCorners } from "./rectify";

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
  /**
   * "frame": find the four corners of the drawn map (cheap, a few hundred tokens out) so the browser
   * can straighten the photo; "plan" (default): read the plan
   */
  stage?: "frame" | "plan";
  /** the image was straightened to the drawn map's frame and carries a 0.1 reference grid */
  rectified?: boolean;
}

export const VISION_SYSTEM = `You read hand-drawn and printed urban plans for a city-planning tool. The image is usually a photo of a whiteboard, paper sketch or printed map seen from above (bird's-eye / plan view). Turn it into structured data by calling ${SKETCH_TOOL_NAME} exactly once.

How to read a sketch:
- Coordinates are normalised to the image: x 0 = left edge … 1 = right edge, y 0 = top edge … 1 = bottom edge. Ignore photo borders, the board frame, glare and writing outside the map ("please do not erase"); read what is drawn.
- When the image carries a faint cyan reference grid with labels at every 0.1, use it to read positions precisely. The grid is not part of the plan.
- Streets: every drawn street as ONE centreline polyline along its whole drawn length, straight through the junctions it crosses (do not break a street into pieces at each junction), its ends extended to the street or map edge it meets so the network connects. A street drawn as two parallel lines (its two kerbs) is one street: give the centreline between them. A dashed centre line marks a two-way street of some importance (collector or arterial). Thick, double or emphasised lines and words like avenue / boulevard / highway are arterials; medium lines collectors; thin lines locals; dotted lines or "walk" / "promenade" pedestrian. Copy written street names. Streets of a grid run straight: give them two points unless they visibly bend. The map's outer border line is not a street.
- Water: rivers and canals as a centreline with a width in metres (wavy double lines, blue, "river"); lakes and ponds as outlines.
- Parks and greens: outlines (often hatched, scribbled trees, "park"). Plazas / squares as outlines. Parking lots ("P", "parking") as outlines.
- Facilities: boxes or symbols with a label (SCHOOL, HIGH SCHOOL, HOSPITAL, STATION, FIRE, POLICE, LIBRARY…): the centre, and the box outline when drawn. A MALL or shopping centre is a facility of kind mall (give its box too).
- Blocks: the land between streets. Report EVERY block that carries a label, hatching or drawn buildings, with its outline running along the street edges around it. Drawn building symbols say what the block is: small pitched-roof houses → residential, low; rows of attached houses → residential, medium; boxy mid-rise buildings → mixed or residential, medium–high; tall towers with window grids → high or very_high with an estimate of floors from how tall they are drawn. A written label (MIXED USE, RETAIL, OFFICES, HOUSING 4–6 STOREYS) wins over the symbols for the use. Only empty, unlabelled blocks may be left out (they get default_use / default_density).
- Rail and transit lines: hatched or dashed lines labelled rail / tram / metro / bus, with station dots.
- Extent: the real-world width and height the whole image covers. Use a scale bar or written dimensions when there is one; else infer from what is drawn (a house lot 15–25 m wide, urban blocks 60–150 m a side, local streets 80–150 m apart, an arterial grid about 800 m apart, a school site 100–200 m, a mall 150–300 m) and say how confident you are.
- North: the direction of a drawn north arrow, else null.
- Be faithful: do not invent features that are not drawn. Prefer fewer, correct features over many guessed ones.

If the image is not a plan view of a place (a person, a selfie, a room, a document page, a street-level photo, an elevation or perspective drawing, a chart), call the tool with is_plan false, a short not_plan_reason, an extent of 0 × 0 and empty lists.`;

export const FRAME_TOOL_NAME = "report_sketch_frame";

const corner = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] normalised image coordinates (x 0 left … 1 right, y 0 top … 1 bottom)" };

/** stage 1: where the drawn map sits in the photo, so it can be straightened before it is read */
export const FRAME_TOOL = {
  name: FRAME_TOOL_NAME,
  description: "Report where the drawn plan sits in the photo: the four corners of the map, and whether the image is a plan at all. Call it exactly once.",
  input_schema: {
    type: "object",
    properties: {
      is_plan: { type: "boolean", description: "true when the image shows a bird's-eye (plan view) sketch, diagram or map of streets / blocks / a site" },
      not_plan_reason: { type: "string", description: "when is_plan is false: what the image shows instead, in a few words" },
      has_border: { type: "boolean", description: "true when the map has a drawn outer border" },
      top_left: corner,
      top_right: corner,
      bottom_right: corner,
      bottom_left: corner,
    },
    required: ["is_plan", "has_border", "top_left", "top_right", "bottom_right", "bottom_left"],
  },
} as const;

export const FRAME_SYSTEM = `You locate hand-drawn and printed urban plans in photos for a city-planning tool, so the photo can be straightened before the plan is read. Call ${FRAME_TOOL_NAME} exactly once.

- The map is usually drawn on a whiteboard or paper and photographed at an angle, and the drawing itself is often rotated on the board. Report the four corners of the map as a quadrilateral that hugs it: its drawn outer border when there is one, else the tightest four-sided outline around all its streets and buildings whose sides run along the drawing's main street directions.
- Name the corners as the map is meant to be read: turn the map in your head until its streets run horizontally and vertically and most of its written labels read upright; top_left is then its top-left corner, and so on clockwise. Text outside the map ("please do not erase", a title, a signature) is not part of it.
- Coordinates are normalised to the image: x 0 = left edge … 1 = right edge, y 0 = top edge … 1 = bottom edge. A faint cyan reference grid with labels at every 0.1 may be drawn over the image to help you; use it to place the corners precisely.
- If the image is not a plan view of a place (a person, a room, a document page, a street-level photo, a chart), set is_plan false with a short reason and give the image's own corners.`;

/** models that reject a forced tool_choice (and cannot turn thinking off) */
export function rejectsForcedTools(model: string): boolean {
  return /claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)(\b|$)/.test(model);
}

export function visionModel(env: Record<string, string | undefined> = process.env, stage: "frame" | "plan" = "plan"): string {
  if (stage === "frame") return env.MERIDIAN_MODEL_VISION_FRAME || tierModels(env).standard;
  return env.MERIDIAN_MODEL_VISION || tierModels(env).standard;
}

/** output ceiling: a dense plan is a few thousand tokens of coordinates (plus thinking on models that think) */
export const VISION_MAX_TOKENS = 12000;
export const FRAME_MAX_TOKENS = 3000;

export function buildVisionRequest(body: VisionBody, env: Record<string, string | undefined> = process.env): { model: string; forced: boolean; params: Record<string, unknown> } {
  const frame = body.stage === "frame";
  const model = visionModel(env, frame ? "frame" : "plan");
  const forced = !rejectsForcedTools(model);
  const toolName = frame ? FRAME_TOOL_NAME : SKETCH_TOOL_NAME;
  const aspect = body.width && body.height ? ` The image is ${body.width} × ${body.height} pixels (width:height ${(body.width / body.height).toFixed(2)}).` : "";
  const hint = body.hint?.trim() ? `\nThe user wrote with it: “${body.hint.trim().slice(0, 400)}”` : "";
  const straightened = !frame && body.rectified ? " The photo has been straightened: the drawn map fills the image, upright, with its streets running along the image axes, and a cyan reference grid with labels marks every 0.1." : "";
  const ask = frame ? `Find the drawn map in this photo and call ${FRAME_TOOL_NAME}.${aspect}` : `Read this plan and call ${SKETCH_TOOL_NAME}.${aspect}${straightened}${hint}`;
  const params: Record<string, unknown> = {
    model,
    max_tokens: frame ? FRAME_MAX_TOKENS : VISION_MAX_TOKENS,
    system: [{ type: "text", text: frame ? FRAME_SYSTEM : VISION_SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: [frame ? FRAME_TOOL : SKETCH_TOOL],
    // forced: exactly one call of the tool, thinking off (forced tool use and thinking don't mix);
    // otherwise the model decides (it is told to call the tool) and thinks — briefly for the frame,
    // properly for the plan, where reading the layout right is the whole point
    tool_choice: forced ? { type: "tool", name: toolName, disable_parallel_tool_use: true } : { type: "auto", disable_parallel_tool_use: true },
    ...(forced ? { thinking: { type: "disabled" } } : { thinking: { type: "adaptive" } }),
    output_config: { effort: frame ? "low" : "medium" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: body.media_type ?? "image/jpeg", data: body.image } },
          { type: "text", text: ask },
        ],
      },
    ],
  };
  return { model, forced, params };
}

/** the result the client gets back */
export type VisionResult = { ok: true; plan: SketchPlan } | { ok: false; not_plan: true; reason: string; plan: SketchPlan } | { ok: false; error: string };

/** the frame stage's result: corners null when none could be read (the plan is then read unstraightened) */
export type FrameResult = { ok: true; frame: FrameCorners | null } | { ok: false; not_plan: true; reason: string } | { ok: false; error: string };

type RawMsg = { content?: { type: string; name?: string; input?: unknown }[]; stop_reason?: string | null };

/** read the response: only the plan tool's input counts (no free text is parsed) */
export function parseVisionResponse(msg: RawMsg): VisionResult {
  if (msg.stop_reason === "refusal") return { ok: false, error: "The model declined to read this image." };
  const use = (msg.content ?? []).find((b) => b.type === "tool_use" && b.name === SKETCH_TOOL_NAME);
  if (!use) return { ok: false, error: msg.stop_reason === "max_tokens" ? "The plan was too detailed to read in one pass; try a simpler or tighter crop." : "The model did not return a plan." };
  const plan = normalisePlan(use.input);
  if (!plan.is_plan) return { ok: false, not_plan: true, reason: plan.not_plan_reason ?? "this doesn't look like a plan", plan };
  return { ok: true, plan };
}

const cornerOf = (x: unknown): Pt | null => {
  if (!Array.isArray(x) || x.length < 2) return null;
  let a = Number(x[0]),
    b = Number(x[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // percent returned by mistake
  if (a > 1.5 || b > 1.5) [a, b] = [a / 100, b / 100];
  return [Math.max(-0.05, Math.min(1.05, a)), Math.max(-0.05, Math.min(1.05, b))];
};

export function parseFrameResponse(msg: RawMsg): FrameResult {
  if (msg.stop_reason === "refusal") return { ok: false, error: "The model declined to read this image." };
  const use = (msg.content ?? []).find((b) => b.type === "tool_use" && b.name === FRAME_TOOL_NAME);
  if (!use) return { ok: true, frame: null };
  const r = (use.input ?? {}) as Record<string, unknown>;
  if (r.is_plan === false) return { ok: false, not_plan: true, reason: (typeof r.not_plan_reason === "string" && r.not_plan_reason.trim().slice(0, 160)) || "the image does not show a plan" };
  const [tl, tr, br, bl] = [r.top_left, r.top_right, r.bottom_right, r.bottom_left].map(cornerOf);
  return { ok: true, frame: tl && tr && br && bl ? { tl, tr, br, bl } : null };
}

/** largest accepted request (base64 characters): ≈ 3.7 MB of image, far above a 1568 px JPEG */
export const MAX_IMAGE_B64 = 5_000_000;
