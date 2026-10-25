// Demo-only mock of the Anthropic streaming Messages API: scripted agent flows for the demo video.
// Every flow calls real tools in the running app and reports the numbers those tools return.
//
//   node scripts/demo/mock-demo.mjs 3999
//   ANTHROPIC_API_KEY=mock MERIDIAN_ANTHROPIC_BASE_URL=http://localhost:3999 npm start
//
// Flows (matched on the latest request):
//   "cool" / "republic square"   heat around Republic Square: baseline → trees where people walk in the
//                                heat → green roofs → lots to park → heat again → callout → summary
//   "shade trees"                zone: trees on the zone's streets ranked by heat → heat in the zone
//   "bike"                       zone: Guadalupe loses a lane each way for protected bike lanes → PM traffic
//   "parking" + "homes|housing"  zone: the largest surface lots become courtyard housing
import http from "node:http";

const port = Number(process.argv[2] ?? 3999);

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "request-id": "req_demo" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function message(blocks, stop, model) {
  const ev = [{ type: "message_start", message: { id: `msg_demo_${Date.now()}`, type: "message", role: "assistant", model: model ?? "demo", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const chunk of b.text.match(/.{1,12}/gs) ?? []) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      for (const chunk of JSON.stringify(b.input).match(/.{1,30}/gs) ?? []) ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: chunk } });
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
  const request = parts.filter((t) => !t.startsWith("<context>") && !t.startsWith("[runtime]")).pop() ?? "";
  const results = messages.slice(idx + 1).filter((x) => x.role === "user" && Array.isArray(x.content)).flatMap((x) => x.content.filter((c) => c.type === "tool_result")).map(parse);
  return { request, results };
}

let n = 0;
const call = (name, input, text) => [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id: `toolu_demo_${++n}`, name, input }];
const step = (name, input, text, delay = 900) => ({ delay, turn: [call(name, input, text), "tool_use"] });
const done = (text, delay = 600) => ({ delay, turn: [[{ type: "text", text }], "end_turn"] });
const first = (r) => r?.data?.summary?.[0] ?? "";

const SQUARE = [-613, -523];
const AROUND = { center: SQUARE, radius: 320 };

function coolFlow(r) {
  switch (r.length) {
    case 0:
      return step("camera", { action: "fly_to", target: SQUARE, zoom: 16.6, pitch: 58, bearing: -28 }, "I'll start by measuring the walk around Republic Square at 3 PM, then put shade where people actually walk.", 700);
    case 1:
      return step("run_simulation", { kind: "heat", params: { area: AROUND, hour: 15, date: "07-17" } }, undefined, 700);
    case 2: {
      const a = r[1].data?.in_area ?? {};
      return step(
        "plant_trees",
        { within: AROUND, count: 70, target: "heat", species: "live_oak" },
        `Right now the ground around the square averages ${a.surface_f} °F at 3 PM and only ${a.shaded_paths} of the footpaths are shaded. Live oaks first, ranked by how many people walk in each spot of sun.`,
        1100,
      );
    }
    case 3:
      return step("green_roofs", { area: { center: SQUARE, radius: 300 }, max_count: 10 }, "Then the large flat roofs nearby.", 900);
    case 4:
      return step("convert_areas", { from_type: "parking", within: { center: SQUARE, radius: 350 }, type: "park" }, "And the small surface lots around the square become green space.", 900);
    case 5:
      return step("run_simulation", { kind: "heat", params: { area: AROUND, hour: 15, date: "07-17" } }, "Re-running the heat model on the new plan.", 900);
    case 6: {
      const a = r[1].data?.in_area ?? {},
        b = r[5].data?.in_area ?? {};
      const drop = Math.round((a.surface_f - b.surface_f) * 10) / 10;
      return step("annotate", { notes: [{ at: SQUARE, title: `−${drop} °F at street level`, body: `Shaded footpaths ${a.shaded_paths} → ${b.shaded_paths}`, tone: "good" }] }, undefined, 500);
    }
    default: {
      const a = r[1].data?.in_area ?? {},
        b = r[5].data?.in_area ?? {};
      return done(
        `Done. ${first(r[2])}, ${first(r[3]).replace(/^Green roofs on/, "green roofs on").replace(/ — .*/, "")}, and ${(r[4].data?.summary?.[1] ?? "").replace(/^\d+ areas /, "")}.\n\nAt 3 PM around the square:\n• Ground surface ${a.surface_f} → ${b.surface_f} °F\n• Shaded footpaths ${a.shaded_paths} → ${b.shaded_paths}\n• Tree canopy ${a.canopy} → ${b.canopy}\n\nThe biggest gains are on the west and south sides, where the most people walk.`,
      );
    }
  }
}

function treesFlow(r) {
  switch (r.length) {
    case 0:
      return step("run_simulation", { kind: "heat", params: { area: "zone", hour: 15, date: "07-17" } }, "Measuring the zone at 3 PM first.", 1600);
    case 1:
      return step("plant_trees", { within: "zone", count: 90, target: "heat", species: "cedar_elm" }, "Planting where the most people walk in full sun.", 2200);
    case 2:
      return step("run_simulation", { kind: "heat", params: { area: "zone", hour: 15, date: "07-17" } }, undefined, 1800);
    default: {
      const a = r[0].data?.in_area ?? {},
        b = r[2].data?.in_area ?? {};
      return done(`${first(r[1])}. Shaded footpaths in the zone ${a.shaded_paths} → ${b.shaded_paths}; ground surface ${a.surface_f} → ${b.surface_f} °F at 3 PM.`, 1200);
    }
  }
}

function bikeFlow(r) {
  switch (r.length) {
    case 0:
      return step(
        "edit_streets",
        { street: "Guadalupe Street", within: "zone", edits: [{ op: "remove_lanes", count: 1 }, { op: "add_bike_lanes", kind: "track" }] },
        "Guadalupe: one travel lane each way becomes a protected bike lane, inside the existing curbs.",
        2400,
      );
    case 1:
      return step("run_simulation", { kind: "traffic", params: { period: "pm" } }, "Checking the evening peak.", 2600);
    default: {
      const s = r[0].data?.summary ?? [];
      const k = r[1].data?.kpi ?? {};
      const worst = (r[1].data?.worst_junctions ?? []).find((j) => /guadalupe/i.test(j.name));
      return done(`${(s.find((x) => /segments rebuilt/.test(x)) ?? s[0] ?? "").replace(/;.*$/, "")}. In the 5 PM peak the network averages ${k.avg_speed_kmh} km/h${worst ? `; the busiest Guadalupe junction is ${worst.name.replace(/ \/ /g, " & ")} (level of service ${worst.los})` : ""}.`, 1400);
    }
  }
}

function housingFlow(r) {
  switch (r.length) {
    case 0:
      return step("find_features", { kind: "area", within: "zone", where: { type: "parking", minArea: 2500 }, limit: 3 }, "Finding the largest surface lots in the zone.", 1700);
    case 1: {
      const rows = r[0].data?.rows ?? [];
      if (!rows.length) return done("There are no large surface lots in this zone.");
      return step("create_building", { site: rows[0].id, typology: "courtyard", floors: 7, use: "residential", name: "Courtyard Homes" }, `Starting with the largest, ${Math.round(rows[0].area_m2 * 10.764).toLocaleString("en-US")} sq ft of asphalt.`, 2200);
    }
    case 2: {
      const rows = r[0].data?.rows ?? [];
      if (rows.length < 2) return done(`${first(r[1])}.`);
      return step("create_building", { site: rows[1].id, typology: "u_shape", floors: 6, use: "residential", name: "Garden Court" }, undefined, 2200);
    }
    default: {
      const units = [r[1], r[2]].map((x) => Number((first(x).match(/~(\d[\d,]*) units/) ?? [])[1]?.replace(/,/g, "") ?? 0)).reduce((a, b) => a + b, 0);
      return done(`Two lots become ${units.toLocaleString("en-US")} homes in courtyard buildings. ${(r[1].data?.summary?.[1] ?? "").replace(/^Displaces/, "That replaces")}.`, 1200);
    }
  }
}

function pick(request) {
  const q = request.toLowerCase();
  if (/shade trees|plant/.test(q)) return treesFlow;
  if (/bike/.test(q)) return bikeFlow;
  if (/parking/.test(q) && /homes|housing/.test(q)) return housingFlow;
  if (/cool|republic square|heat/.test(q)) return coolFlow;
  return null;
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (!req.url.startsWith("/v1/messages")) {
        res.writeHead(404).end();
        return;
      }
      const { request, results } = conversation(body.messages ?? []);
      const flow = pick(request);
      const out = flow ? flow(results) : done("Tell me what to change, and where.");
      setTimeout(() => sse(res, message(out.turn[0], out.turn[1], body.model)), out.delay ?? 400);
    });
  })
  .listen(port, () => console.log(`demo mock on :${port}`));
