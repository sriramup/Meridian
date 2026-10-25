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
  /\b(add|build|create|make|place|put|plant|remove|delete|demolish|replace|widen|narrow|convert|change|set|turn|close|open|reopen|pedestriani[sz]e|extend|move|shift|realign|merge|split|draw|generate|design|upgrade|fix|improve|reduce|increase|raise|lower|undo|redo|revert|branch|switch|rename|green|give|install|swap|retrofit|densify|rezone|connect|link|insert|fill|apply|commit|do it|go ahead|proceed|lay|layout|pave|landscape|line|plot|sketch|rotate|copy|duplicate|paint|fence|align|restrict|limit|clear|lay out|put in|try|start|continue|keep going|again)\b/i;
const ANALYSIS = /\b(simulat|suggest|propose|recommend|find|locate|identify|where (should|could|would)|show (me )?(where|the)|(run|rerun|re-run)\b[^.?!]{0,30}\b(traffic|heat|runoff|stormwater|flood|access|bike|sun|shade|growth|capacity|model|simulation)|model the|what (would|will) happen|impact|effect of|evaluate|assess|test|check|validate|rank|estimate|forecast|measure the)\w*/i;
const DEEP =
  /\b(masterplan|master plan|district|neighbourhood plan|neighborhood plan|optimi[sz]\w*|alternatives?|options|scenarios to|branches|compare|comparison|trade-?offs?|strategy|strategic|redesign|overhaul|transform|study|several|multiple|each of|whole (city|area|downtown|network)|network-wide|citywide|city-wide|minimi[sz]e|maximi[sz]e|best (way|site|location)s?|plan for|step by step|thorough|in depth|in-depth|comprehensive)\b/i;
const QUESTION = /^(what|what's|whats|which|where|who|when|how (many|much|tall|high|wide|long|big|far|old)|is|are|was|were|does|do|did|can you tell|tell me|show me what|why is|why are|any)\b/i;
// "take me to 21st and Guadalupe", "go to Pine Street", "show me the university", "where is Republic Square?"
// — resolve + fly the camera: one go_to call, so the quick tier. Not when the sentence also asks for an
// edit or analysis ("go to 6th and widen it"), and "show me" followed by an overlay / model is not a place.
const NAV = /^(?:(?:can|could|would) you |please |now |ok(?:ay)?,? |and )*(?:take me (?:to|back to)|bring me to|go (?:to|back to)|fly (?:me )?to|zoom (?:in )?(?:to|on)|jump to|navigate to|head to|center (?:on|the map on)|centre (?:on|the map on)|focus on|show me|where(?:'s| is| are))\s+(.+?)[\s?.!]*$/i;
const NOT_PLACE = /\b(heat|traffic|overlay|map of|model|simulation|density|access|runoff|flood|zoning|growth|transit coverage|bike stress|sun|shadow|shade|kpis?|results?|options?|alternatives?|how|why|what|where (?:to|i|we|should|could)|best|sites?|spots?|gaps?|bottlenecks?|changes?|history|difference|compare)\b/i;

/** "take me to X" → X (null when the request is not plain navigation) */
export function navigationTarget(text: string): string | null {
  const m = NAV.exec(text.trim());
  if (!m) return null;
  const target = m[1].trim();
  if (!target || target.split(/\s+/).length > 10 || NOT_PLACE.test(target)) return null;
  const rest = target.replace(/\b(and|&|at)\b/gi, " ");
  if (EDIT.test(rest) && !/\b(street|st|avenue|ave|road|rd|park|square|plaza|blvd|boulevard|drive|lane)\b/i.test(rest)) return null;
  return target;
}

const SMALLTALK = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|nice|yes|no|sure|got it|perfect)\b[\s!.,]*$/i;

/** classify one request (plan mode never uses the quick tier for edit-like requests, since those are proposals) */
export function routeRequest(text: string, opts: { mode?: "plan" | "edit"; hasSelection?: boolean } = {}): Route {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (!t) return { tier: "quick", reason: "empty" };
  if (SMALLTALK.test(t)) return { tier: "quick", reason: "small talk" };
  if (navigationTarget(t)) return { tier: "quick", reason: "navigation" };
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
  // only questions and small talk take the fast tier: an unrecognised instruction is most likely a task
  return question ? { tier: "quick", reason: "short question" } : { tier: "standard", reason: "general request" };
}
