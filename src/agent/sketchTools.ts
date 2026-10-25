// Agent tool over the sketch builder (src/sketch/build.ts): resolves where the sketch goes (free space
// on a canvas, the session zone, a named place or the view centre), builds it in one changeset and
// commits through the shared commit() of tools.ts, so plan mode, zones, approvals and dry runs apply
// exactly as for every other edit. The camera frames the result.

import { polyBBox, polyCentroid } from "@/geometry/polygon";
import { fmtLen } from "@/lib/units";
import { rt } from "@/state/runtime";
import { buildSketch, chooseSite, sketchSize } from "@/sketch/build";
import { normalisePlan, type SketchPlan } from "@/sketch/plan";
import { getSketch, latestSketch } from "@/sketch/store";
import type { OpResult } from "@/world/ops/core";
import type { Vec2 } from "@/world/types";
import { frame } from "./navTools";
import { resolveLocation, viewCenter } from "./resolve";
import type { ToolContext, ToolOutput } from "./tools";

export { SKETCH_TOOL_DEFS } from "./sketchToolDefs";

type In = Record<string, any>;
const actor = { author: "agent" as const };

async function commit(res: OpResult, title: string, ctx: ToolContext): Promise<ToolOutput> {
  // lazy: tools.ts spreads SKETCH_TOOLS, so a static import would be circular
  const t = await import("./tools");
  return t.commit(res, title, ctx);
}

function err(title: string, message: string): ToolOutput {
  return { content: { error: message }, display: { title, detail: message, status: "error" }, isError: true };
}

export const SKETCH_TOOLS: Record<string, (i: In, ctx: ToolContext) => Promise<ToolOutput>> = {
  async build_sketch(i, ctx) {
    const title = "Build sketch";
    const rec = (typeof i.sketch_id === "string" ? getSketch(i.sketch_id) : null) ?? (i.plan ? null : latestSketch());
    const plan: SketchPlan | null = i.plan ? normalisePlan(i.plan) : (rec?.plan ?? null);
    if (!plan) return err(title, `No sketch “${i.sketch_id}” in this browser. Ask the user to attach the image again.`);
    if (!plan.is_plan) return err(title, `This doesn't look like a plan (${plan.not_plan_reason ?? "nothing to build"}). Tell the user instead of building.`);
    const R = rt();
    const world = R.world;
    const sandbox = !!R.meta.sandbox;
    const rotation = typeof i.rotation_deg === "number" ? i.rotation_deg : 0;
    let size: number | undefined = typeof i.size_m === "number" && i.size_m > 0 ? i.size_m : undefined;
    let centre: Vec2;
    let label: string;
    if (i.center !== undefined && i.center !== null) {
      const loc = resolveLocation(i.center);
      centre = loc.p;
      label = loc.label;
    } else if (ctx.zone) {
      centre = polyCentroid(ctx.zone.poly);
      label = `the zone “${ctx.zone.label}”`;
      // fit the sketch inside the zone unless a size was asked for
      if (!size) {
        const [x0, y0, x1, y1] = polyBBox(ctx.zone.poly);
        const { W, H } = sketchSize(plan);
        const k = Math.min(1, ((x1 - x0) / W) * 0.95, ((y1 - y0) / H) * 0.95);
        size = Math.max(W, H) * k;
      }
    } else if (sandbox) {
      centre = [0, 0];
      label = "the canvas centre";
    } else {
      centre = viewCenter();
      label = "the view centre";
    }
    let how = `${label}`;
    if (sandbox && !i.replace_existing && !ctx.zone) {
      // a blank canvas: the chosen spot if free, else the nearest free space large enough
      const s = chooseSite(world, plan, { prefer: centre, size_m: size, rotation_deg: rotation, label });
      if (!s) return err(title, "There is no free space on the canvas large enough for this sketch, even at half its size. Pass a smaller size_m, or replace_existing:true to build over what is there.");
      centre = s.centre;
      size = s.size_m;
      how = s.how;
    }
    const name = (typeof i.name === "string" && i.name.trim()) || plan.title || rec?.name?.replace(/\.[a-z0-9]+$/i, "") || "Sketch";
    let res: OpResult;
    try {
      res = buildSketch(world, plan, { centre, size_m: size, rotation_deg: rotation }, actor, { name, seed: i.seed, replaceExisting: !!i.replace_existing, density: i.density });
    } catch (e) {
      return err(title, (e as Error).message);
    }
    const out = await commit(res, `Build ${name}`, ctx);
    if (out.isError || !out.content || typeof out.content !== "object") return out;
    const c = out.content as Record<string, unknown>;
    if (Array.isArray(c.summary)) c.summary = (c.summary as string[]).slice(0, 3);
    if (Array.isArray(c.warnings)) c.warnings = (c.warnings as string[]).slice(0, 5);
    delete c.created;
    const d = (c.data ?? {}) as { placement?: { width_m: number; height_m: number }; bbox?: number[] };
    c.placed_at = `${how}; ${d.placement ? `${fmtLen(d.placement.width_m)} × ${fmtLen(d.placement.height_m)}` : ""}`;
    if (out.display.lines) out.display.lines = out.display.lines.slice(0, 4);
    out.display.detail = how;
    out.display.metrics = [
      { label: "Homes", value: String((c.data as { homes?: number })?.homes ?? 0) },
      { label: "Buildings", value: String((c.data as { buildings?: number })?.buildings ?? 0) },
    ];
    if (c.applied && d.bbox) frame(d.bbox as [number, number, number, number]);
    return out;
  },
};
