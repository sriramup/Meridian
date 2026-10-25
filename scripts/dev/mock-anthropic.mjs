// Mock of the Anthropic streaming Messages API for end-to-end tests of the agent runtime without a
// key: scripted flows that call real tools, read their results from the conversation, and finish
// with a summary built from them.
//
// Usage: node scripts/dev/mock-anthropic.mjs [port]
// then run the app with ANTHROPIC_API_KEY=mock MERIDIAN_ANTHROPIC_BASE_URL=http://localhost:<port>
// and, for plan mode (served by Gemini, src/agent/providers.ts), GEMINI_API_KEY=mock
// MERIDIAN_GEMINI_BASE_URL=http://localhost:<port> — otherwise a real GEMINI_API_KEY in .env.local
// sends plan-mode turns to the real Gemini API.
//
// The flow is picked from the latest user request text (the block after the <context> snapshot),
// first match wins (case-insensitive):
//   "… near X" | "… around X" | "… within N-minute walk of X" (find / where are / restaurants / groceries / cafés …)
//                               live local discovery (SerpApi): find_places {query, near: X, walk_minutes: N} → a short list
//                               with ratings, walk times and open-now; with "import" / "as destinations" in the request it
//                               continues import_places → run_simulation access → summary
//   "look up X" | "research X" | "search the web for X" | "what is the population of X"
//                               live research (SerpApi): web_search {query} → the answer / facts cited as [n] (domain)
//                               and a Sources list
//   "take me to X" | "go to X" | "show me X" | "where is X" | "fly to X" | "zoom to X"
//                               navigation: go_to {place: X} → "Here's <name>." (or the suggestions when nothing matches)
//   "design / create / build / make / plan … neighbourhood / district / town" | "neighbourhood for"
//                               design flow: design_neighborhood when the server offers it (site sized to the programme
//                               at ~30 homes per gross acre, facilities = the request's words; it frames itself) → summary
//                               with homes, residents, jobs, civic uses and the critique score; without that tool:
//                               streets → school + parks → generate_district ×2 (parallel calls per turn) → summary
//   "lavaca"                    legacy Austin flow: resolve Lavaca & 4th → vacant parcel → 30-storey tower → PM traffic
//   "long" | "slow" | "grid"    long-running task: 4 streets drawn one per turn (≈1.2 s delay per turn), so two
//                               sessions visibly run in parallel; "at X, Y" sets where (default: zone centre or 0,0)
//   "demolish" | "clear the block"
//                               approval flow: find_features (buildings within 200 m of "X, Y", else the zone centre,
//                               else 0,0; up to 60) → remove_features on all of them. More than 25 buildings (or any
//                               historic one) triggers the approval prompt (session status "needs_input"). Apply →
//                               "Cleared N buildings."; Decline → the model adapts with a smaller step: it removes
//                               only the 3 nearest buildings (under the approval threshold) and says so. With 25 or
//                               fewer buildings in range it removes them without asking.
//   "outside"                   (checked before the zone flow) see below
//   "only work" | "set zone" | "zone:" | "work anywhere"
//                               set_zone with the words after "only work in/between…" or "zone:" → confirmation
//   "undo"                      undo (this session's last edit) → summary
//   "outside"                   zone violation: builds 900 m outside the session zone → refused → rebuilds at the zone centre
//   "build" | "add" | "tower" | "building"
//                               edit flow: create_building (at "X, Y", else the zone centre, else 0,0) → summary;
//                               in plan mode (from the <context> block) the executor turns it into a dry run and the
//                               summary says nothing was applied
//   a user turn carrying an image (a sketch)  (checked first)
//                               sketch flow: the runtime has already read it (vision request, below) → build_sketch
//                               {sketch_id} → summary naming what was built and where; a "doesn't look like a plan"
//                               note → a one-line explanation, nothing built
//   question words (what / how many / which / where / is / are / does …) with none of the above
//                               quick answer: immediate text from the <context> block, no tools
//   anything else               a short text reply
// Vision requests (the sketch reader, src/app/api/vision: non-streaming, tool report_sketch_plan) get a JSON
// message whose tool input is the canned plan of the test fixture (tests/fixtures/sketch-plan.json); an image
// taller than it is wide (the "selfie" fixture) is answered is_plan:false.
// Usage: every response carries cache-shaped usage (tools + system read from cache after the first
// request per model, the new history written, the newest turn uncached), so the server's spend ledger
// (src/agent/spend.ts) records realistic entries; point MERIDIAN_SPEND_LEDGER at a scratch file when
// testing against the mock, and set MERIDIAN_SPEND_CAP_USD low to exercise the cap.
// Turn latency: quick answers are immediate; other turns wait MOCK_DELAY ms (default 250; long flow 1200).
// Gemini: POST /v1beta/models/<model>:streamGenerateContent runs the same flows on the translated request
// (functionCall / functionResponse parts read as tool_use / tool_result) and streams Gemini SSE chunks
// (a thought part first on tool turns, then text and function calls). A request mentioning "rate limit"
// or "429" gets 429 RESOURCE_EXHAUSTED (retryDelay 15s), "overloaded" or "503" a 503 UNAVAILABLE, so
// the route's fallback to Claude can be exercised; MOCK_GEMINI_STATUS=429|503 fails every Gemini request.
import http from "node:http";
import { readFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 3999);
const SKETCH_PLAN = JSON.parse(readFileSync(new URL("../../tests/fixtures/sketch-plan.json", import.meta.url), "utf8"));
const BASE_DELAY = Number(process.env.MOCK_DELAY ?? 250);

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "request-id": "req_mock" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function message(blocks, stop, model, usage) {
  const ev = [{ type: "message_start", message: { id: `msg_mock_${Date.now()}`, type: "message", role: "assistant", model: model ?? "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, ...usage } } }];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const chunk of b.text.match(/.{1,24}/gs) ?? []) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      for (const chunk of json.match(/.{1,30}/gs) ?? []) ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: chunk } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 42 } });
  ev.push({ type: "message_stop" });
  return ev;
}

const textOf = (c) => (typeof c === "string" ? c : c?.type === "text" ? c.text : "");
const parse = (c) => {
  try {
    return { error: !!c.is_error, data: JSON.parse(typeof c.content === "string" ? c.content : (c.content?.[0]?.text ?? "null")) };
  } catch {
    return { error: true, data: null };
  }
};

/** the latest user request, its <context> block, and the tool results that followed it */
function conversation(messages) {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = typeof m.content === "string" ? [m.content] : m.content.map(textOf);
    if (parts.some((t) => t && !t.startsWith("<context>") && !t.startsWith("[runtime]"))) {
      idx = i;
      break;
    }
  }
  const m = messages[idx] ?? { content: [] };
  const parts = typeof m.content === "string" ? [m.content] : m.content.map(textOf).filter(Boolean);
  const context = parts.find((t) => t.startsWith("<context>")) ?? "";
  const request = parts.filter((t) => !t.startsWith("<context>") && !t.startsWith("[runtime]")).pop() ?? "";
  const results = messages.slice(idx + 1).filter((x) => x.role === "user" && Array.isArray(x.content)).flatMap((x) => x.content.filter((c) => c.type === "tool_result")).map(parse);
  return { context, request, results };
}

// navigation phrasing (kept in step with src/agent/router.ts navigationTarget)
const NAV = /^(?:(?:can|could|would) you |please |now )*(?:take me (?:to|back to)|bring me to|go (?:to|back to)|fly (?:me )?to|zoom (?:in )?(?:to|on)|jump to|navigate to|head to|show me|where(?:'s| is| are))\s+(.+?)[\s?.!]*$/i;

let n = 0;
const call = (name, input, text) => [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id: `toolu_mock_${++n}`, name, input }];
const say = (text) => [[{ type: "text", text }], "end_turn"];
const sq = (x, y, h = 18) => [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]];

function ctxInfo(context) {
  const plan = /^mode: plan/m.test(context);
  const zm = context.match(/^zone: “([^”]+)”.*?centre \[(-?\d+), (-?\d+)\]/m);
  const zone = zm ? { label: zm[1], c: [Number(zm[2]), Number(zm[3])] } : null;
  const line = (k) => context.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1] ?? "";
  return { plan, zone, line };
}

function at(request, fallback) {
  const m = request.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  return m ? [Number(m[1]), Number(m[2])] : fallback;
}

function legacy(r) {
  const step = r.length;
  if (r.some((x) => x.error)) return say(`A tool reported an error: ${JSON.stringify(r.find((x) => x.error).data).slice(0, 200)}`);
  switch (step) {
    case 0:
      return [call("resolve_place", { query: "Lavaca Street & 4th Street" }, "I'll find the intersection first."), "tool_use"];
    case 1: {
      const p = r[0].data[0].at;
      return [call("find_features", { kind: "parcel", near: p, radius: 300, where: { landUse: "vacant" }, limit: 3 }, `Found it at ${JSON.stringify(p)}. Looking for vacant parcels nearby.`), "tool_use"];
    }
    case 2: {
      const p = r[1].data.rows[0];
      return [call("create_building", { site: p.id, typology: "tower_podium", floors: 30, use: "mixed", name: "Mock Tower" }, `Building on ${p.id} (${p.zoning}, ${p.area_m2} m²).`), "tool_use"];
    }
    case 3:
      return [call("run_simulation", { kind: "traffic", params: { period: "pm" } }), "tool_use"];
    default: {
      const b = r[2].data,
        t = r[3].data;
      return say(`Done. ${b.summary[0]}. PM peak network delay is ${t.kpi.delay_veh_hours} veh·h (${t.kpi.congested_km} congested km).`);
    }
  }
}

// design flow: the order a good planner works in — street hierarchy, civic sites, fabric, critique, fix,
// report. Uses design_neighborhood / critique_design when the server offers them, else the general tools.
function designFlow(body, r, home) {
  const has = (n) => (body.tools ?? []).some((t) => t.name === n);
  const [cx, cy] = home;
  const P = (pts) => pts.map(([x, y]) => [cx + x, cy + y]);
  const phases = [];
  if (has("design_neighborhood")) {
    // size the site to the programme: ~30 homes per gross acre, 2.5 residents per home
    const req = conversation(body.messages).request;
    const num = Number((req.match(/(\d[\d,]*)\s*(residents|people|population|homes|units)/i)?.[1] ?? "6000").replace(/,/g, ""));
    const homes = /homes|units/i.test(req.match(/\d[\d,]*\s*(\w+)/)?.[1] ?? "") ? num : num / 2.5;
    const side = Math.round(Math.sqrt((homes / 30) * 4047) / 10) * 10;
    const h = side / 2;
    phases.push({ say: "Designing the neighborhood: street hierarchy, civic sites, then the building fabric.", calls: [["design_neighborhood", { area: P([[-h, -h], [h, -h], [h, h], [-h, h]]), homes: Math.round(homes), facilities: req, name: "Mock Neighborhood" }]] });
    const done = r.length;
    if (done < 1) return { delay: 400, turn: [phases[done].calls.flatMap(([n, i], j) => call(n, i, j === 0 && phases[done].say ? phases[done].say : undefined)), "tool_use"] };
    const d = r[0].data ?? {};
    if (r[0].error) return { delay: 200, turn: say(`The design failed: ${String(d.error ?? "").slice(0, 200)}`) };
    const c = d.critique ?? {};
    const sqft = d.data?.gfa_sqft ? ` (${Math.round(d.data.gfa_sqft / 1e5) / 10}M sq ft)` : "";
    return { delay: 200, turn: say(`Designed it: about ${d.data?.homes ?? "?"} homes for ${d.data?.residents ?? "?"} residents and ${d.data?.jobs ?? "?"} jobs${sqft}, with ${(d.data?.civic ?? []).map((x) => x.name).slice(0, 4).join(", ")}. Design score ${c.overall ?? "?"} (${c.grade ?? "?"})${c.issues?.length ? `; still weak: ${c.issues.slice(0, 2).map((x) => x.message).join("; ")}` : ""}.`) };
  }
  else {
    phases.push({
      say: "Street hierarchy first: a main street, a central avenue and edge roads.",
      calls: [
        ["create_street", { path: P([[-600, 0], [600, 0]]), cls: "secondary", name: "Main Street", parking: true, trees: true, bike: "lane" }],
        ["create_street", { path: P([[0, -500], [0, 500]]), cls: "tertiary", name: "Central Avenue", trees: true }],
        ["create_street", { path: P([[-600, -500], [600, -500]]), cls: "tertiary", name: "South Road" }],
        ["create_street", { path: P([[-600, 500], [600, 500]]), cls: "tertiary", name: "North Road" }],
      ],
    });
    phases.push({
      say: "Civic sites next: the school and two parks.",
      calls: [
        ["create_building", { site: P([[60, 220], [200, 220], [200, 320], [60, 320]]), typology: "courtyard", floors: 2, use: "education", name: "Elementary School" }],
        ["create_area", { type: "park", area: P([[-380, 180], [-220, 180], [-220, 320], [-380, 320]]), name: "North Green", shade_trees: true }],
        ["create_area", { type: "park", area: P([[220, -330], [380, -330], [380, -180], [220, -180]]), name: "South Park", shade_trees: true }],
      ],
    });
    phases.push({
      say: "Now the fabric: mixed-use along Main Street, homes behind it.",
      calls: [
        ["generate_district", { area: P([[-590, 15], [590, 15], [590, 490], [-590, 490]]), style: "european", target_units: 1300, max_floors: 5, new_streets: true, block_size: 120 }],
        ["generate_district", { area: P([[-590, -490], [590, -490], [590, -15], [-590, -15]]), style: "midrise", target_units: 1300, max_floors: 5, new_streets: true, block_size: 120 }],
      ],
    });
  }
  if (has("critique_design")) phases.push({ say: "Checking the design.", calls: [["critique_design", { area: P([[-600, -500], [600, -500], [600, 500], [-600, 500]]) }]] });
  // which phase: count the tool-result batches seen so far
  const done = r.length;
  let k = 0,
    used = 0;
  while (k < phases.length && used + phases[k].calls.length <= done) used += phases[k++].calls.length;
  if (k < phases.length) return { delay: 400, turn: [phases[k].calls.flatMap(([n, i], j) => call(n, i, j === 0 ? phases[k].say : undefined)), "tool_use"] };
  const failed = r.filter((x) => x.error).length;
  const crit = r[r.length - 1]?.data;
  const issues = crit?.issues?.length ? ` Remaining issues: ${crit.issues.slice(0, 3).map((x) => (typeof x === "string" ? x : x.message ?? x.code)).join("; ")}.` : "";
  return { delay: 300, turn: say(`Done: a walkable neighbourhood with a main street, a school and parks.${failed ? ` ${failed} step${failed > 1 ? "s" : ""} failed.` : ""}${issues}`) };
}

/** the sketch note of the latest user turn that carries an image, if any */
function sketchTurn(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    if (m.content.some((c) => c.type === "tool_result")) continue;
    if (!m.content.some((c) => c.type === "image")) return null;
    const note = m.content.map(textOf).find((t) => t.startsWith("[runtime] The user attached")) ?? "";
    return { note, id: note.match(/sketch_id (\w+)/)?.[1] ?? null, notPlan: /doesn't look like a plan|reading it failed/.test(note) };
  }
  return null;
}

function sketchFlow(sk, r) {
  if (sk.notPlan) return { delay: 150, turn: say(/reading it failed/.test(sk.note) ? "I couldn't read that image — please try again, or describe the plan in words." : "That doesn't look like a bird's-eye plan, so I haven't built anything. Try a photo of a whiteboard or paper sketch taken from above, or a map.") };
  if (!r.length) return { delay: 300, turn: [call("build_sketch", { sketch_id: sk.id }, "Building your sketch as drawn."), "tool_use"] };
  const last = r[r.length - 1];
  if (last.error) return { delay: 150, turn: say(`I couldn't build it: ${String(last.data?.error ?? "").slice(0, 200)}`) };
  const d = last.data?.data ?? {};
  const st = d.streets ?? {};
  const streets = [st.arterial ? `${st.arterial} avenue${st.arterial > 1 ? "s" : ""}` : "", st.collector ? `${st.collector} collector${st.collector > 1 ? "s" : ""}` : "", st.local ? `${st.local} local streets` : ""].filter(Boolean).join(", ");
  const extras = [d.water ? "the river" : "", d.parks ? `${d.parks} park${d.parks > 1 ? "s" : ""}` : "", ...(d.facilities ?? []).map((f) => f.name)].filter(Boolean).join(", ");
  return { delay: 200, turn: say(`Built **${d.name ?? "the sketch"}**: ${streets}; ${extras}. About ${d.homes ?? "?"} homes and ${d.jobs ?? "?"} jobs in ${d.buildings ?? "?"} buildings. Placed at ${last.data?.placed_at ?? "the canvas"}.`) };
}

function nextTurn(body) {
  const sk = sketchTurn(body.messages);
  if (sk) return sketchFlow(sk, conversation(body.messages).results);
  const { context, request, results: r } = conversation(body.messages);
  const q = request.toLowerCase();
  const { plan, zone, line } = ctxInfo(context);
  const home = zone?.c ?? [0, 0];
  const last = r[r.length - 1];

  if (/lavaca/.test(q)) return { turn: legacy(r) };

  const has = (name) => (body.tools ?? []).some((t) => t.name === name);
  const disc = discovery(request);
  if (disc && has("find_places")) return placesFlow(disc, r, last);
  const research = researchQuery(request);
  if (research && has("web_search")) return researchFlow(research, r, last);

  const nav = request.match(NAV);
  if (nav && !/\b(heat|traffic|overlay|model|options|where (to|should|could))\b/i.test(nav[1])) {
    if (!r.length) return { delay: 120, turn: [call("go_to", { place: nav[1] }), "tool_use"] };
    if (last.error) return { delay: 0, turn: say(`I couldn't find “${nav[1]}” on this map${last.data?.suggestions?.length ? ` — did you mean ${last.data.suggestions.slice(0, 3).join(", ")}?` : "."}`) };
    const g = last.data.went_to;
    return { delay: 0, turn: say(`Here's ${g.name}${g.type === "junction" ? "" : ` (${g.type})`}.${last.data.alternatives?.length ? ` Also matching: ${last.data.alternatives.join(", ")}.` : ""}`) };
  }

  if (/\b(design|masterplan|master plan|create|build|make|lay out|plan)\b.*\b(neighbou?rhood|district|town|quarter)\b|\bneighbou?rhood for\b/.test(q)) return designFlow(body, r, home);

  if (/\b(long|slow|grid)\b/.test(q)) {
    const [x, y] = at(request, home);
    const paths = [
      [[x - 150, y - 60], [x + 150, y - 60]],
      [[x - 150, y + 60], [x + 150, y + 60]],
      [[x - 90, y - 150], [x - 90, y + 150]],
      [[x + 90, y - 150], [x + 90, y + 150]],
    ];
    if (r.length < paths.length) return { delay: 1200, turn: [call("create_street", { path: paths[r.length], cls: "residential", name: `Mock Street ${r.length + 1}` }, r.length ? undefined : `Laying out a 4-street grid around [${x}, ${y}].`), "tool_use"] };
    const ok = r.filter((x) => !x.error && (x.data?.applied || x.data?.preview)).length;
    return { delay: 600, turn: say(`Done: ${ok} of ${paths.length} streets ${plan ? "previewed (plan mode — nothing applied)" : "built"} around [${x}, ${y}].${r.some((x) => x.error) ? ` ${r.filter((x) => x.error).length} were refused: ${String(r.find((x) => x.error).data?.error ?? "").slice(0, 160)}` : ""}`) };
  }

  if (/\bdemolish|clear the block\b/.test(q)) {
    const [x, y] = at(request, home);
    if (r.length === 0) return { turn: [call("find_features", { kind: "building", near: [x, y], radius: 200, limit: 60 }, `Looking for the buildings around [${x}, ${y}].`), "tool_use"] };
    const ids = (r[0].data?.rows ?? []).map((b) => b.id);
    if (r.length === 1) {
      if (!ids.length) return { turn: say(`There are no buildings within 200 m of [${x}, ${y}].`) };
      return { turn: [call("remove_features", { ids, reason: "clear the block" }, `Removing all ${ids.length} buildings${ids.length > 25 ? " — this needs your approval" : ""}.`), "tool_use"] };
    }
    if (r.length === 2) {
      if (r[1].data?.rejected) return { turn: [call("remove_features", { ids: ids.slice(0, 3), reason: "smaller first step" }, "Understood — I'll leave the block and only clear the three nearest lots instead."), "tool_use"] };
      return { turn: say(r[1].error ? `That failed: ${String(r[1].data?.error).slice(0, 200)}` : `Cleared ${ids.length} buildings around [${x}, ${y}].`) };
    }
    return { turn: say(last.error ? `That failed: ${String(last.data?.error).slice(0, 200)}` : `Done: kept the block and removed only the 3 nearest buildings, which doesn't need approval.`) };
  }

  if (/\boutside\b/.test(q)) {
    const out = [home[0] + 900, home[1] + 900];
    if (r.length === 0) return { turn: [call("create_building", { site: sq(out[0], out[1]), typology: "block", floors: 5, use: "residential", name: "Mock Outside" }, "Placing the building."), "tool_use"] };
    if (r.length === 1 && r[0].error) return { turn: [call("create_building", { site: sq(home[0], home[1]), typology: "block", floors: 5, use: "residential", name: "Mock Inside" }, "That site is outside my zone, so I'll build at the zone centre instead."), "tool_use"] };
    return { turn: say(last.error ? `That didn't work either: ${String(last.data?.error).slice(0, 200)}` : `Built inside the zone${zone ? ` (${zone.label})` : ""}: ${last.data?.summary?.[0] ?? "done"}.`) };
  }

  if (/\bonly work\b|\bset (the )?zone\b|\bzone:|\bwork anywhere\b/.test(q)) {
    if (!r.length) {
      const words = request.match(/only work (?:in |inside |within )?(.+?)[.!]?$/i)?.[1] ?? request.match(/zone:?\s*(.+?)[.!]?$/i)?.[1] ?? request;
      const clear = /\b(anywhere|clear|no zone)\b/i.test(request);
      return { turn: [call("set_zone", clear ? { clear: true } : { zone: words }), "tool_use"] };
    }
    return { turn: say(last.error ? `I couldn't set that zone: ${last.data?.error}` : last.data?.zone ? `Zone set to ${last.data.zone}. I'll keep my edits inside it.` : "Zone cleared — I can work anywhere.") };
  }

  if (/\bundo\b/.test(q)) {
    if (!r.length) return { turn: [call("undo", { steps: 1 }), "tool_use"] };
    return { turn: say(last.error ? `Undo failed: ${last.data?.error}` : last.data?.undone?.length ? `Undid “${last.data.undone[0]}”.` : last.data?.message ?? "Nothing to undo.") };
  }

  if (/\b(build|add|tower|building)\b/.test(q)) {
    const [x, y] = at(request, home);
    if (!r.length) return { turn: [call("create_building", { site: sq(x, y), typology: "block", floors: /tower/.test(q) ? 20 : 6, use: "residential", name: /tower/.test(q) ? "Mock Tower" : "Mock Block" }, `Placing it at [${x}, ${y}].`), "tool_use"] };
    if (last.error) return { turn: say(`I couldn't do that: ${String(last.data?.error).slice(0, 240)}`) };
    if (last.data?.preview) return { turn: say(`Plan: a ${/tower/.test(q) ? "20" : "6"}-storey block at [${x}, ${y}]. Preview: ${last.data.summary?.[0] ?? "ok"}. Nothing was applied (plan mode).`) };
    return { turn: say(`Built it: ${last.data?.summary?.[0] ?? "done"}${zone ? ` (inside ${zone.label})` : ""}.`) };
  }

  if (/^(what|what's|whats|how many|how much|which|where|who|when|is|are|does|do)\b/.test(q)) {
    const answer = /building|street|tree|area|parcel/.test(q) ? `The world has ${line("world")}.` : /scenario|edit/.test(q) ? `Scenario: ${line("scenario")}.` : /zone/.test(q) ? `Zone: ${line("zone")}.` : /mode/.test(q) ? `Mode: ${line("mode")}.` : `Currently: ${line("scenario")}; ${line("world")}.`;
    return { delay: 0, turn: say(answer) };
  }
  return { turn: say("Understood. Tell me what to build, change or analyse.") };
}

// ---- live search flows (SerpApi tools; the app's server answers them from fixtures in tests)
const PLACE_WORDS = /\b(restaurants?|caf[eé]s?|coffee( shops?)?|bars?|groceries|grocery( stores?)?|supermarkets?|pharmac(y|ies)|clinics?|tacos?|bakery|bakeries|schools?|parks?|gyms?|daycares?)\b/i;
function discovery(request) {
  const t = request.trim().replace(/[?.!]+$/, "");
  const m = t.match(/^(?:(?:can you |please )?(?:find|show me|where are|where can i (?:get|find)|are there|is there|any)\s+)?(?:the |some |any )?(.+?)\s+(?:within (?:an? |a )?(\d+)[- ]minute walk (?:of|from)|near|around|close to)\s+(.+)$/i);
  if (!m || !(PLACE_WORDS.test(m[1]) || /^(find|where are)\b/i.test(t))) return null;
  const what = m[1].replace(/\b(good|best|nearby)\b/gi, "").replace(/\s+/g, " ").trim();
  const near = m[3].replace(/\s+(and|then)\s+(import|add)\b.*$/i, "").replace(/,.*$/, "").trim();
  return { what, near, walk: m[2] ? Number(m[2]) : undefined, importToo: /\b(import|as destinations|add them)\b/i.test(t) };
}
function placesFlow(d, r, last) {
  const input = { query: d.what, near: d.near, ...(d.walk ? { walk_minutes: d.walk } : {}) };
  if (!r.length) return { delay: 150, turn: [call("find_places", input, `Searching Google Maps for ${d.what} near ${d.near}.`), "tool_use"] };
  const f = r[0];
  if (f.error) return { delay: 0, turn: say(`I couldn't search for places: ${String(f.data?.error ?? "").slice(0, 200)}`) };
  const P = f.data.places ?? [];
  const list = P.slice(0, 5).map((p, i) => `${i + 1}. **${p.name}** — ${p.rating ? `${p.rating}★ (${p.reviews ?? 0}), ` : ""}${p.walk_min} min walk${p.open_now === true ? ", open now" : p.open_now === false ? ", closed now" : ""}`).join("\n");
  if (d.importToo && r.length === 1 && P.length) return { delay: 150, turn: [call("import_places", { set_id: f.data.set_id }, "Adding them as walk-access destinations."), "tool_use"] };
  if (d.importToo && r.length === 2 && !r[1].error) return { delay: 150, turn: [call("run_simulation", { kind: "access" }, "Re-running walk access with them."), "tool_use"] };
  const head = d.walk ? `${f.data.within_walk} of ${P.length} ${d.what} are within a ${d.walk}-minute walk of ${f.data.near}${f.data.within_walk ? ` (${f.data.within_names.join(", ")})` : ""}. Nearest: ${P[0]?.name} at ${P[0]?.walk_min} min.` : `Found ${P.length} ${d.what} near ${f.data.near}:`;
  const tail = d.importToo ? (r[1]?.error ? `\n\nImport failed: ${String(r[1].data?.error).slice(0, 160)}` : `\n\nImported ${r[1]?.data?.imported ?? 0} as destinations; walk access re-run${last?.data?.kpi ? "" : ""}. Undo removes them.`) : d.walk ? "\n\nWant me to add these as destinations so the walk-access model uses them?" : "";
  return { delay: 150, turn: say(`${head}\n\n${list}${tail}\n\n_Google Maps via SerpApi._`) };
}
function researchQuery(request) {
  const t = request.trim().replace(/[?!]+$/, "");
  const m = t.match(/^(?:please |can you )?(?:look up|lookup|research|search (?:the web |online )?for|google)\s+(.+)$/i);
  if (m) return m[1];
  if (/^(what(?:'s| is) the (population|household size|median (household )?income|average household size|rainfall)\b)/i.test(t)) return t;
  return null;
}
function researchFlow(query, r, last) {
  if (!r.length) return { delay: 150, turn: [call("web_search", { query }, "Searching the web."), "tool_use"] };
  if (last.error) return { delay: 0, turn: say(`The search failed: ${String(last.data?.error ?? "").slice(0, 200)}`) };
  const d = last.data;
  const src = (n) => d.sources.find((s) => s.n === n);
  let fact = "";
  if (d.answer) fact = `${d.answer.text} [${d.answer.cite}] (${src(d.answer.cite)?.domain})`;
  else if (d.entity) fact = `${d.entity.name}: ${Object.entries(d.entity.facts).slice(0, 3).map(([k, v]) => `${k.toLowerCase()} ${v}`).join("; ")} [${d.entity.cite}] (${src(d.entity.cite)?.domain})`;
  else if (d.sources[0]) fact = `${d.sources[0].snippet} [1] (${d.sources[0].domain})`;
  else return { delay: 0, turn: say("The search found nothing useful for that.") };
  const sources = d.sources.slice(0, 4).map((s) => `- [${s.n}] ${s.title} — ${s.domain}`).join("\n");
  return { delay: 100, turn: say(`${fact}\n\n**Sources**\n${sources}`) };
}

const seenModels = new Set();
const prevHistory = new Map();

/** a Gemini generateContent request as the Messages API body the flows read */
function fromGemini(model, g) {
  const part = (p) => {
    if (p.functionCall) return { type: "tool_use", id: p.functionCall.id, name: p.functionCall.name, input: p.functionCall.args ?? {} };
    if (p.functionResponse) {
      const r = p.functionResponse.response ?? {};
      return { type: "tool_result", tool_use_id: p.functionResponse.id, content: JSON.stringify("error" in r ? r.error : "output" in r ? r.output : r), is_error: "error" in r || undefined };
    }
    if (p.inlineData) return { type: "image", source: { type: "base64", media_type: p.inlineData.mimeType, data: p.inlineData.data } };
    return { type: "text", text: p.text ?? "" };
  };
  return {
    model,
    system: g.systemInstruction,
    tools: (g.tools ?? []).flatMap((t) => t.functionDeclarations ?? []).map((d) => ({ name: d.name })),
    messages: (g.contents ?? []).map((c) => ({ role: c.role === "model" ? "assistant" : "user", content: (c.parts ?? []).map(part) })),
  };
}

function gemini(res, model, g) {
  const body = fromGemini(model, g);
  const { request } = conversation(body.messages);
  const fail = process.env.MOCK_GEMINI_STATUS ?? (/\b(rate.?limit|429)\b/i.test(request) ? "429" : /\b(overloaded|503)\b/i.test(request) ? "503" : "");
  if (fail) {
    console.log(JSON.stringify({ gemini: true, model, status: Number(fail) }));
    const error =
      fail === "503"
        ? { code: 503, message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", status: "UNAVAILABLE" }
        : { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "15s" }] };
    res.writeHead(Number(fail), { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
    return;
  }
  const { turn, delay } = nextTurn(body);
  const [blocks, stop] = turn;
  console.log(JSON.stringify({ gemini: true, model, msgs: body.messages.length, tools: body.tools.length, thinking: g.generationConfig?.thinkingConfig?.thinkingLevel ?? g.thinkingConfig?.thinkingLevel, stop }));
  const parts = [];
  if (blocks.some((b) => b.type === "tool_use")) parts.push([{ text: "**Planning the next step**\n\nChoosing the tool for this request.", thought: true }]);
  let signed = false;
  for (const b of blocks) {
    if (b.type === "text") for (const piece of b.text.match(/.{1,24}/gs) ?? []) parts.push([{ text: piece }]);
    else {
      // like Gemini 3: parallel calls carry one signature, on the first call of the step
      parts.push([{ functionCall: { id: `call_mock_${++n}`, name: b.name, args: b.input }, ...(signed ? {} : { thoughtSignature: "bW9jay1zaWduYXR1cmU=" }) }]);
      signed = true;
    }
  }
  parts.push([{ text: "" }]);
  const prompt = Math.round(JSON.stringify(g).length / 3.5);
  const warm = seenModels.has(model);
  seenModels.add(model);
  const usageMetadata = { promptTokenCount: prompt, cachedContentTokenCount: warm ? Math.round(prompt * 0.6) : 0, candidatesTokenCount: 42, thoughtsTokenCount: 30, totalTokenCount: prompt + 72 };
  const chunks = parts.map((p, i) => ({ candidates: [{ content: { role: "model", parts: p }, index: 0, ...(i === parts.length - 1 ? { finishReason: stop === "max_tokens" ? "MAX_TOKENS" : "STOP" } : {}) }], usageMetadata, modelVersion: model, responseId: `mock_${n}` }));
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
    res.end();
  }, delay ?? BASE_DELAY);
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const gm = req.method === "POST" && /^\/v1beta\/models\/([^:/]+):streamGenerateContent/.exec(req.url);
      if (gm) {
        gemini(res, decodeURIComponent(gm[1]), JSON.parse(raw));
        return;
      }
      if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
        res.writeHead(404).end("{}");
        return;
      }
      const body = JSON.parse(raw);
      if (!body.stream && (body.tools ?? []).some((t) => t.name === "report_sketch_plan")) {
        // the sketch reader: one non-streaming call, answered with the fixture's plan (or "not a plan")
        const text = (body.messages?.[0]?.content ?? []).map(textOf).join(" ");
        const m = text.match(/(\d+) × (\d+) pixels/);
        const portrait = m && Number(m[2]) > Number(m[1]) * 1.1;
        const input = portrait ? { is_plan: false, not_plan_reason: "a photo of a person, not a plan", extent: { width_m: 0, height_m: 0, basis: "guess", confidence: 0 }, streets: [], blocks: [], areas: [], facilities: [], transit: [], notes: [] } : SKETCH_PLAN;
        const hasImage = (body.messages?.[0]?.content ?? []).some((c) => c.type === "image" && c.source?.type === "base64" && c.source.data?.length > 100);
        console.log(JSON.stringify({ vision: true, model: body.model, image: hasImage, forced: body.tool_choice?.type, portrait: !!portrait }));
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json", "request-id": "req_mock_vision" });
          res.end(JSON.stringify({ id: `msg_mock_v${Date.now()}`, type: "message", role: "assistant", model: body.model, stop_reason: "tool_use", stop_sequence: null, content: [{ type: "tool_use", id: `toolu_mock_v${++n}`, name: "report_sketch_plan", input }], usage: { input_tokens: 1750, output_tokens: portrait ? 60 : 1150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
        }, 600);
        return;
      }
      const { turn, delay } = nextTurn(body);
      console.log(JSON.stringify({ tools: body.tools?.length, msgs: body.messages.length, model: body.model, effort: body.output_config?.effort, thinking: body.thinking?.type, stop: turn[1] }));
      // usage shaped like the real API's with caching: the stable prefix (tools + system) is read from
      // cache after the first request per model, the history since the last breakpoint is written,
      // and only the newest user turn is uncached — so the server's spend ledger sees realistic fields
      const prefix = Math.round((JSON.stringify(body.tools ?? []).length + JSON.stringify(body.system ?? "").length) / 3.5);
      const history = Math.round(JSON.stringify(body.messages).length / 3.5);
      const lastTurn = Math.round(JSON.stringify(body.messages[body.messages.length - 1] ?? "").length / 3.5);
      const warm = seenModels.has(body.model);
      seenModels.add(body.model);
      const usage = { input_tokens: lastTurn, cache_creation_input_tokens: (warm ? 0 : prefix) + Math.max(0, history - lastTurn - (prevHistory.get(body.model) ?? 0)), cache_read_input_tokens: (warm ? prefix : 0) + Math.min(prevHistory.get(body.model) ?? 0, Math.max(0, history - lastTurn)) };
      prevHistory.set(body.model, Math.max(0, history - lastTurn));
      setTimeout(() => sse(res, message(turn[0], turn[1], body.model, usage)), delay ?? BASE_DELAY);
    });
  })
  .listen(port, () => console.log(`mock Anthropic + Gemini API on :${port}`));
