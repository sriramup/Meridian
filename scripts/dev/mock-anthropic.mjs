// Mock of the Anthropic streaming Messages API for end-to-end tests of the agent runtime without a
// key: scripted flows that call real tools, read their results from the conversation, and finish
// with a summary built from them.
//
// Usage: node scripts/dev/mock-anthropic.mjs [port]
// then run the app with ANTHROPIC_API_KEY=mock MERIDIAN_ANTHROPIC_BASE_URL=http://localhost:<port>
//
// The flow is picked from the latest user request text (the block after the <context> snapshot),
// first match wins (case-insensitive):
//   "lavaca"                    legacy Austin flow: resolve Lavaca & 4th → vacant parcel → 30-storey tower → PM traffic
//   "long" | "slow" | "grid"    long-running task: 4 streets drawn one per turn (≈1.2 s delay per turn), so two
//                               sessions visibly run in parallel; "at X, Y" sets where (default: zone centre or 0,0)
//   "outside"                   (checked before the zone flow) see below
//   "only work" | "set zone" | "zone:" | "work anywhere"
//                               set_zone with the words after "only work in/between…" or "zone:" → confirmation
//   "undo"                      undo (this session's last edit) → summary
//   "outside"                   zone violation: builds 900 m outside the session zone → refused → rebuilds at the zone centre
//   "build" | "add" | "tower" | "building"
//                               edit flow: create_building (at "X, Y", else the zone centre, else 0,0) → summary;
//                               in plan mode (from the <context> block) the executor turns it into a dry run and the
//                               summary says nothing was applied
//   question words (what / how many / which / where / is / are / does …) with none of the above
//                               quick answer: immediate text from the <context> block, no tools
//   anything else               a short text reply
// Turn latency: quick answers are immediate; other turns wait MOCK_DELAY ms (default 250; long flow 1200).
import http from "node:http";

const port = Number(process.argv[2] ?? 3999);
const BASE_DELAY = Number(process.env.MOCK_DELAY ?? 250);

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "request-id": "req_mock" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function message(blocks, stop, model) {
  const ev = [{ type: "message_start", message: { id: `msg_mock_${Date.now()}`, type: "message", role: "assistant", model: model ?? "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
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

function nextTurn(body) {
  const { context, request, results: r } = conversation(body.messages);
  const q = request.toLowerCase();
  const { plan, zone, line } = ctxInfo(context);
  const home = zone?.c ?? [0, 0];
  const last = r[r.length - 1];

  if (/lavaca/.test(q)) return { turn: legacy(r) };

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

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
        res.writeHead(404).end("{}");
        return;
      }
      const body = JSON.parse(raw);
      const { turn, delay } = nextTurn(body);
      console.log(JSON.stringify({ tools: body.tools?.length, msgs: body.messages.length, model: body.model, effort: body.output_config?.effort, thinking: body.thinking?.type, stop: turn[1] }));
      setTimeout(() => sse(res, message(turn[0], turn[1], body.model)), delay ?? BASE_DELAY);
    });
  })
  .listen(port, () => console.log(`mock Anthropic API on :${port}`));
