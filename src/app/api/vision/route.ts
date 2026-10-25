import Anthropic from "@anthropic-ai/sdk";
import { ledger, SpendLedger } from "@/agent/spend";
import { buildVisionRequest, FRAME_MAX_TOKENS, MAX_IMAGE_B64, parseFrameResponse, parseVisionResponse, VISION_MAX_TOKENS, type VisionBody } from "@/sketch/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sketch reading: one vision call turns a bird's-eye sketch or photo into a SketchPlan (src/sketch/
 * plan.ts). Same client, base URL, spend ledger and cap as the agent route: the request's worst case
 * is reserved before it is sent and the real cost (from usage) is recorded after.
 *
 * POST { image: base64, media_type?, hint?, width?, height?, rectified? }
 *   → 200 { ok: true, plan, cost } | 200 { ok: false, not_plan: true, reason, plan } | 4xx/5xx { error }
 * POST { image, …, stage: "frame" }: the drawn map's corners, so the browser can straighten the photo
 *   → 200 { ok: true, frame: { tl, tr, br, bl } | null, cost } | 200 { ok: false, not_plan: true, reason }
 */

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  // explicit base URL so a host-level ANTHROPIC_BASE_URL meant for other tools is not picked up
  return new Anthropic({ apiKey, baseURL: process.env.MERIDIAN_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" });
}

/** an image is billed at about (w × h) / 750 tokens; a 1568 px long edge is ≈ 1,600 tokens */
function imageTokens(w?: number, h?: number) {
  return w && h ? Math.ceil((Math.min(w, 1568) * Math.min(h, 1568)) / 750) : 1600;
}

export async function POST(req: Request) {
  const c = client();
  if (!c) return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart." }, { status: 503 });
  let body: VisionBody;
  try {
    body = (await req.json()) as VisionBody;
  } catch {
    return Response.json({ error: "Expected a JSON body with a base64 image." }, { status: 400 });
  }
  if (typeof body.image !== "string" || body.image.length < 100) return Response.json({ error: "No image in the request." }, { status: 400 });
  if (body.image.length > MAX_IMAGE_B64) return Response.json({ error: "That image is too large to read; it should be downscaled in the browser first." }, { status: 413 });
  if (body.media_type && !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(body.media_type)) return Response.json({ error: "Unsupported image type." }, { status: 415 });

  const { model, params } = buildVisionRequest(body);
  const L = ledger();
  // worst case: the prompt (system + tool schema as characters, the image as tokens ≈ 3 chars each) plus the full output ceiling
  const promptChars = JSON.stringify(params.system).length + JSON.stringify(params.tools).length + 400 + imageTokens(body.width, body.height) * 3;
  const frame = body.stage === "frame";
  const r = L.reserve(SpendLedger.estimate(model, promptChars, frame ? FRAME_MAX_TOKENS : VISION_MAX_TOKENS));
  if (!r.ok) return Response.json({ error: r.message, spend: L.snapshot() }, { status: 402 });
  let committed = false;
  try {
    const msg = await c.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming, { signal: req.signal });
    const usd = L.commit(r.ticket, msg.model || model, msg.usage as never, "vision");
    committed = true;
    const out = frame ? parseFrameResponse(msg as never) : parseVisionResponse(msg as never);
    const cost = { usd, total_usd: L.total, cap_usd: L.cap };
    if ("error" in out) return Response.json({ ...out, cost }, { status: 502 });
    return Response.json({ ...out, model: msg.model || model, cost });
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = err instanceof Anthropic.APIError && err.status ? err.status : 502;
    return Response.json({ error: err.message || "The vision request failed." }, { status: status >= 400 ? status : 502 });
  } finally {
    if (!committed) L.release(r.ticket);
  }
}
