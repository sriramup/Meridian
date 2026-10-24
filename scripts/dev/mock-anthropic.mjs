// Mock of the Anthropic streaming Messages API for end-to-end tests of the agent
// pipeline without a key: scripted turns that call real tools, read their results
// from the conversation, and finish with a summary built from those results.
// Usage: node scripts/dev/mock-anthropic.mjs [port]
// then run the app with ANTHROPIC_API_KEY=mock MERIDIAN_ANTHROPIC_BASE_URL=http://localhost:<port>
import http from "node:http";

const port = Number(process.argv[2] ?? 3999);
const log = [];

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "request-id": "req_mock" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function message(blocks, stop) {
  const ev = [{ type: "message_start", message: { id: `msg_mock_${Date.now()}`, type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
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

const resultsOf = (messages) =>
  messages
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .flatMap((m) => m.content.filter((c) => c.type === "tool_result"))
    .map((c) => {
      try {
        return { error: !!c.is_error, data: JSON.parse(typeof c.content === "string" ? c.content : c.content?.[0]?.text ?? "null") };
      } catch {
        return { error: true, data: null };
      }
    });

let n = 0;
const call = (name, input, text) => [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id: `toolu_mock_${++n}`, name, input }];

function nextTurn(body) {
  const r = resultsOf(body.messages);
  const step = r.length;
  if (r.some((x) => x.error)) return [[{ type: "text", text: `A tool reported an error: ${JSON.stringify(r.find((x) => x.error).data).slice(0, 200)}` }], "end_turn"];
  switch (step) {
    case 0:
      return [call("resolve_place", { query: "Lavaca Street & 4th Street" }, "I'll find the intersection first."), "tool_use"];
    case 1: {
      const at = r[0].data[0].at;
      return [call("find_features", { kind: "parcel", near: at, radius: 300, where: { landUse: "vacant" }, limit: 3 }, `Found it at ${JSON.stringify(at)}. Looking for vacant parcels nearby.`), "tool_use"];
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
      return [[{ type: "text", text: `Done. ${b.summary[0]}. PM peak network delay is ${t.kpi.delay_veh_hours} veh·h (${t.kpi.congested_km} congested km).` }], "end_turn"];
    }
  }
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
      log.push({ url: req.url, tools: body.tools?.length, msgs: body.messages.length, model: body.model, stream: body.stream });
      console.log(JSON.stringify(log[log.length - 1]));
      const [blocks, stop] = nextTurn(body);
      sse(res, message(blocks, stop));
    });
  })
  .listen(port, () => console.log(`mock Anthropic API on :${port}`));
