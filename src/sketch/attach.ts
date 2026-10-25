// How a sketch joins the agent's conversation (used by src/agent/sessions.ts): the user turn carries
// the image itself (so the model sees it) and the plan the vision call read from it (compact JSON),
// with a runtime note to build it like a preset. Saved histories keep a placeholder, never the image.

import type Anthropic from "@anthropic-ai/sdk";
import { planCounts, planForModel } from "./plan";
import type { SketchAttachment, VisionReply } from "./store";

type Block = Anthropic.Beta.BetaContentBlockParam;
type Msg = Anthropic.Beta.BetaMessageParam;

/** what the user typed is optional with a sketch: this is the request when they typed nothing */
export const DEFAULT_SKETCH_REQUEST = "Build this sketch.";

export function sketchBlocks(att: SketchAttachment, read: VisionReply): Block[] {
  const image: Block = { type: "image", source: { type: "base64", media_type: att.media_type, data: att.data } };
  if (read.ok) {
    return [
      image,
      {
        type: "text",
        text: `[runtime] The user attached a sketch (“${att.name}”, sketch_id ${att.id}). The vision reader extracted this plan (normalised image coordinates: x 0 left … 1 right, y 0 top … 1 bottom; extent in metres): ${planForModel(read.plan, att.id)}\nBuild it as you would a preset: one build_sketch call with sketch_id "${att.id}" (it places the sketch in free space or at the session's zone / the user's named place, frames the camera, and returns what it built). Pass center / size_m / rotation_deg only when the user asked for a place, size or orientation. Then summarise what you built, naming its streets, parks, water and facilities.`,
      },
    ];
  }
  if ("not_plan" in read && read.not_plan) {
    return [image, { type: "text", text: `[runtime] The user attached an image (“${att.name}”), but the vision reader says it doesn't look like a plan: ${read.reason}. Don't build anything: tell the user in one or two sentences that this doesn't look like a bird's-eye plan, and what works (a photo of a whiteboard or paper sketch from above, or a map).` }];
  }
  return [image, { type: "text", text: `[runtime] The user attached an image (“${att.name}”), but reading it failed: ${"error" in read ? read.error : "unknown error"}. Tell the user, and suggest trying again or describing the plan in words.` }];
}

/** a one-line description of the reading for the pane's step card */
export function readingLines(read: VisionReply): { title: string; detail?: string; status: "ok" | "warn" | "error"; lines?: string[] } {
  if (read.ok) {
    const p = read.plan;
    const ft = (m: number) => (m >= 1609 * 0.6 ? `${(m / 1609.34).toFixed(1)} mi` : `${Math.round((m * 3.28084) / 10) * 10} ft`);
    return {
      title: `Read sketch${p.title ? `: ${p.title}` : ""}`,
      detail: planCounts(p),
      status: "ok",
      lines: [`About ${ft(p.extent.width_m)} × ${ft(p.extent.height_m)} (${p.extent.basis.replace("_", " ")}, ${Math.round(p.extent.confidence * 100)}% confident)`, ...(p.notes.length ? [`Labels: ${p.notes.slice(0, 8).join(", ")}`] : [])],
    };
  }
  if ("not_plan" in read && read.not_plan) return { title: "This doesn't look like a plan", detail: read.reason, status: "warn" };
  return { title: "Couldn't read the sketch", detail: "error" in read ? read.error : undefined, status: "error" };
}

/** a copy of the history without image data (persistence): each image becomes a short placeholder */
export function stripImages(messages: Msg[]): Msg[] {
  let changed = false;
  const out = messages.map((m) => {
    if (!Array.isArray(m.content) || !m.content.some((b) => (b as { type: string }).type === "image")) return m;
    changed = true;
    return { ...m, content: (m.content as Block[]).map((b) => (b.type === "image" ? ({ type: "text", text: "[image: the attached sketch, not kept in the saved history]" } as Block) : b)) } as Msg;
  });
  return changed ? out : messages;
}
