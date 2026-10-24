// Request router: a fast heuristic (no model call, < 0.1 ms) that sorts each request into a tier.
// The server route maps the tier to a model, effort and thinking setting (src/app/api/agent/route.ts):
//   quick    — a direct question about the current state, a greeting, a clarification: a fast model at
//              low effort, thinking off; most are answered from the context snapshot with no tools.
//   standard — a concrete edit or a single analysis: the main model at medium effort.
//   deep     — masterplans, optimisation, alternatives / comparisons, multi-part briefs: the main model
//              at high effort.
// A tiny-model classifier was considered and rejected: it would add a round trip (~300–600 ms) to every
// request, more than the heuristic's misroutes cost (a misrouted quick request still has every tool).

export type Tier = "quick" | "standard" | "deep";

export interface Route {
  tier: Tier;
  /** why (for the pane / debugging) */
  reason: string;
}

const EDIT =
  /\b(add|build|create|make|place|put|plant|remove|delete|demolish|replace|widen|narrow|convert|change|set|turn|close|open|reopen|pedestriani[sz]e|extend|move|shift|realign|merge|split|draw|generate|design|upgrade|fix|improve|reduce|increase|raise|lower|undo|redo|revert|branch|switch|rename|green|give|install|swap|retrofit|densify|rezone|connect|link|insert|fill|apply|commit|do it|go ahead|proceed)\b/i;
const ANALYSIS = /\b(simulat|(run|rerun|re-run)\b[^.?!]{0,30}\b(traffic|heat|runoff|stormwater|flood|access|bike|sun|shade|growth|capacity|model|simulation)|model the|what (would|will) happen|impact|effect of|evaluate|assess|test|check|validate|rank|estimate|forecast|measure the)\w*/i;
const DEEP =
  /\b(masterplan|master plan|district|neighbourhood plan|neighborhood plan|optimi[sz]\w*|alternatives?|options|scenarios to|branches|compare|comparison|trade-?offs?|strategy|strategic|redesign|overhaul|transform|study|several|multiple|each of|whole (city|area|downtown|network)|network-wide|citywide|city-wide|minimi[sz]e|maximi[sz]e|best (way|site|location)s?|plan for|step by step|thorough|in depth|in-depth|comprehensive)\b/i;
const QUESTION = /^(what|what's|whats|which|where|who|when|how (many|much|tall|high|wide|long|big|far|old)|is|are|was|were|does|do|did|can you tell|tell me|show me what|why is|why are|any)\b/i;
const SMALLTALK = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|nice|yes|no|sure|got it|perfect)\b[\s!.,]*$/i;

/** classify one request (plan mode never uses the quick tier for edit-like requests, since those are proposals) */
export function routeRequest(text: string, opts: { mode?: "plan" | "edit"; hasSelection?: boolean } = {}): Route {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (!t) return { tier: "quick", reason: "empty" };
  if (SMALLTALK.test(t)) return { tier: "quick", reason: "small talk" };
  const sentences = t.split(/[.!?\n]+/).filter((s) => s.trim().split(/\s+/).length > 2).length;
  const deep = DEEP.test(t);
  const edit = EDIT.test(t);
  const analysis = ANALYSIS.test(t);
  if (deep || words > 70 || (sentences >= 3 && (edit || analysis))) return { tier: "deep", reason: deep ? "planning / optimisation / alternatives" : "long multi-part brief" };
  const question = QUESTION.test(t) || (/\?\s*$/.test(t) && !/^(can|could|would|will) you\b/i.test(t));
  // "what is the current x?" / "how many homes are in the selection?" — answer from the snapshot
  if (question && !analysis && words <= 30 && !(edit && /^(can|could|would|will|please)\b/i.test(t))) {
    if (!/\b(if|would|should|could)\b/i.test(t)) return { tier: "quick", reason: "direct question" };
  }
  if (edit || analysis) return { tier: "standard", reason: edit ? "edit" : "analysis" };
  if (opts.mode === "plan" && !question) return { tier: "standard", reason: "plan request" };
  return { tier: words <= 12 ? "quick" : "standard", reason: words <= 12 ? "short request" : "general request" };
}
