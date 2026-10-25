// Agent tools over the design generator (src/design/**, owned by the design-fabric work): a thin
// wrapper that resolves the site, maps tool input to NeighborhoodSpec, commits through the shared
// commit() of tools.ts (so plan mode, zones, approvals and dry runs apply exactly as for every other
// edit) and attaches the design's critique so the model can iterate before it reports.

import { polyArea, polyBBox } from "@/geometry/polygon";
import { frame } from "./navTools";
import { critiqueArea, designNeighborhood, facilitiesFromText, type FacilityRequest, type NeighborhoodSpec, type Scorecard } from "@/design";
import { rt } from "@/state/runtime";
import { useApp } from "@/state/store";
import type { OpResult } from "@/world/ops/core";
import type { Polygon, Vec2 } from "@/world/types";
import { resolveArea, resolveLocation } from "./resolve";
import type { ToolContext, ToolOutput } from "./tools";

export { DESIGN_TOOL_DEFS } from "./designToolDefs";

type In = Record<string, any>;
const actor = { author: "agent" as const };

async function commit(res: OpResult, title: string, ctx: ToolContext): Promise<ToolOutput> {
  // lazy: tools.ts spreads DESIGN_TOOLS, so a static import would be circular
  const t = await import("./tools");
  return t.commit(res, title, ctx);
}

function err(title: string, message: string): ToolOutput {
  return { content: { error: message }, display: { title, detail: message, status: "error" }, isError: true };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** the scorecard as the model reads it: compact, imperial, issues first */
export function scorecardBrief(sc: Scorecard, maxIssues = 6) {
  return {
    overall: sc.overall,
    grade: sc.grade,
    issues: sc.issues.slice(0, maxIssues).map((i) => ({ severity: i.severity, metric: i.metric, message: i.message, at: [Math.round(i.at[0]), Math.round(i.at[1])] })),
    weak_metrics: sc.metrics
      .filter((m) => m.score < 70)
      .sort((a, b) => a.score - b.score)
      .map((m) => ({ metric: m.key, value: m.value, score: m.score, target: m.target })),
    stats: sc.stats,
  };
}

function facilitiesOf(v: unknown): FacilityRequest[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return facilitiesFromText(v);
  if (Array.isArray(v)) return v.filter((f) => f && typeof f.kind === "string") as FacilityRequest[];
  return undefined;
}

export const DESIGN_TOOLS: Record<string, (i: In, ctx: ToolContext) => Promise<ToolOutput>> = {
  async design_neighborhood(i, ctx) {
    const { poly, label } = resolveArea(i.area);
    if (polyArea(poly) < 20_000) return err("Design neighborhood", `The site is only ${r1(polyArea(poly) / 4047)} acres — too small for a neighborhood (needs at least ~5 acres). Use create_building / generate_district for a single block.`);
    const centre: Vec2 | undefined = i.centre !== undefined ? resolveLocation(i.centre).p : undefined;
    const spec: NeighborhoodSpec = {
      area: poly as Polygon,
      name: i.name ?? (/^polygon \(|^view|^circle/.test(label) ? undefined : label),
      seed: i.seed,
      density: i.density,
      homes: i.homes,
      population: i.population,
      jobs: i.jobs,
      mix: i.mix,
      facilities: facilitiesOf(i.facilities),
      openSpace: i.open_space,
      maxFloors: i.max_floors,
      minFloors: i.min_floors,
      centre,
      streets: i.block_length || i.block_depth || i.arterials !== undefined ? { blockLength: i.block_length, blockDepth: i.block_depth, arterials: i.arterials } : undefined,
      replaceExisting: i.replace_existing,
      palette: i.palette,
    };
    let res: OpResult;
    try {
      res = designNeighborhood(rt().world, spec, actor);
    } catch (e) {
      return err("Design neighborhood", (e as Error).message);
    }
    const out = await commit(res, `Design ${spec.name ?? "neighborhood"}`, ctx);
    if (out.isError || !out.content || typeof out.content !== "object") return out;
    const c = out.content as Record<string, unknown>;
    // the generator reports every placement; the model needs the headline (the pane keeps the full list)
    if (Array.isArray(c.summary)) c.summary = (c.summary as string[]).slice(0, 3);
    if (Array.isArray(c.warnings)) c.warnings = (c.warnings as string[]).slice(0, 5);
    if (Array.isArray(c.created)) delete c.created;
    if (out.display.lines) out.display.lines = out.display.lines.slice(0, 4);
    // shortfalls the generator found (school seats vs demand, school walk coverage): put them first
    const adv = (c.data as { advisories?: string[] } | undefined)?.advisories;
    if (adv?.length) {
      c.advisories = adv;
      out.display.lines = [...adv.map((a) => `⚠ ${a}`), ...(out.display.lines ?? [])].slice(0, 6);
      if (out.display.status === "ok") out.display.status = "warn";
    }
    const homes = (c.data as { homes?: number } | undefined)?.homes;
    const acres = polyArea(poly) / 4046.86;
    if (homes && homes / acres < 12) c.note = `${Math.round(homes / acres)} homes per gross acre — a suburban result. For a walkable neighborhood (25–40 per acre) give the same programme a smaller site (about ${Math.round(homes / 30)} acres), or raise homes / density.`;
    // the generator's area echo is the input polygon: the model already has it
    if (c.data && typeof c.data === "object") delete (c.data as Record<string, unknown>).area;
    if (c.applied) {
      // show the result: frame the whole site (no separate camera call needed)
      frame(polyBBox(poly) as [number, number, number, number]);
      try {
        const sc = critiqueArea(rt().world, poly as Polygon, { maxIssues: 8 });
        c.critique = scorecardBrief(sc);
        out.display.metrics = [
          { label: "Design score", value: `${sc.overall} (${sc.grade})`, tone: sc.overall >= 75 ? "good" : sc.overall >= 55 ? "neutral" : "bad" },
          { label: "Homes", value: String((c.data as { homes?: number } | undefined)?.homes ?? sc.stats.homes) },
        ];
      } catch (e) {
        c.critique = { error: (e as Error).message };
      }
    }
    return out;
  },

  async critique_design(i) {
    const { poly, label } = resolveArea(i.area);
    let sc: Scorecard;
    try {
      sc = critiqueArea(rt().world, poly as Polygon, { maxIssues: Math.max(1, Math.min(12, i.max_issues ?? 8)) });
    } catch (e) {
      return err("Critique", (e as Error).message);
    }
    if (i.show_issues && sc.issues.length) {
      const st = useApp.getState();
      st.setAnnotations(sc.issues.slice(0, 6).map((x, k) => ({ id: `crit${Date.now()}${k}`, p: x.at, title: x.metric, body: x.message, tone: x.severity === "high" ? "warn" : "info" })));
    }
    return {
      content: scorecardBrief(sc, i.max_issues ?? 8),
      display: {
        title: `Design score ${sc.overall} (${sc.grade})`,
        detail: label,
        status: sc.overall >= 70 ? "ok" : "warn",
        lines: sc.issues.slice(0, 4).map((x) => x.message),
      },
    };
  },
};
