// Records the demo video from the real app (demo branch only).
//
//   node scripts/demo/mock-demo.mjs 3999 &
//   ANTHROPIC_API_KEY=mock MERIDIAN_ANTHROPIC_BASE_URL=http://localhost:3999 npx next start -p 3100 &
//   node scripts/demo/record.mjs <out-dir> [base-url] [scene,scene…]
//
// Each scene is captured over CDP (Page.startScreencast, JPEG frames with timestamps) from a headed
// Chromium on the real GPU, encoded to its own constant-frame-rate clip, then the clips are joined
// with short crossfades into <out-dir>/meridian-demo.mp4.

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";

const OUT = process.argv[2] ?? "demo-out";
const BASE = process.argv[3] ?? "http://localhost:3100";
const ONLY = process.argv[4]?.split(",");
const W = 1920,
  H = 1080,
  FPS = 30;
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: false, executablePath: CHROME, args: [`--window-size=${W},${H + 87}`, "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => {
  localStorage.setItem("meridian.theme", "dark");
  localStorage.setItem("meridian.sidebar", "0");
  localStorage.setItem("meridian.agentWidth", "480");
  localStorage.setItem("meridian.analysisDetails", "1");
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 160)));
await page.goto(`${BASE}/?city=austin&demo=1`);
await page.waitForFunction(() => window.__meridianMap && window.__meridianTools && window.__demo && window.__meridianAgent, null, { timeout: 180000 });
await page.waitForTimeout(6000);

// ---- capture -----------------------------------------------------------------------------
const cdp = await ctx.newCDPSession(page);
let frames = [];
cdp.on("Page.screencastFrame", async (f) => {
  frames.push({ t: f.metadata.timestamp, data: f.data });
  try {
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
  } catch {}
});
async function capture(name, fn) {
  if (ONLY && !ONLY.includes(name)) return;
  console.log(`scene ${name}`);
  frames = [];
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const t0 = Date.now();
  await fn();
  await wait(120);
  await cdp.send("Page.stopScreencast");
  const dir = `${OUT}/frames-${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const list = [];
  frames.forEach((f, i) => {
    const file = `${dir}/${String(i).padStart(6, "0")}.jpg`;
    writeFileSync(file, Buffer.from(f.data, "base64"));
    const next = frames[i + 1]?.t ?? f.t + 1 / FPS;
    list.push(`file '${file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  list.push(`file '${dir}/${String(frames.length - 1).padStart(6, "0")}.jpg'`);
  writeFileSync(`${dir}/list.txt`, list.join("\n"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${dir}/list.txt`, "-vf", `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "15", `${OUT}/clip-${name}.mp4`]);
  console.log(`  ${frames.length} frames, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---- helpers -----------------------------------------------------------------------------
const wait = (ms) => page.waitForTimeout(ms);
const demo = (fn, ...args) => page.evaluate(([fn, args]) => window.__demo[fn](...args), [fn, args]);
const tool = (name, input) => page.evaluate(([n, i]) => window.__meridianTools.run(n, i), [name, input]);
const app = (fn) => page.evaluate(fn);
/** a full-frame title beat: in, held, out */
async function beat(b, hold = 2800) {
  await demo("beat", b);
  await wait(hold);
  await demo("beat", null);
}
const screenOf = (p) => demo("screenOf", p);
async function cursorTo(x, y, ms = 750) {
  await Promise.all([demo("cursor", x, y, ms), page.mouse.move(x, y, { steps: Math.max(2, Math.round(ms / 40)) })]);
}
async function clickAt(x, y, ms = 750) {
  await cursorTo(x, y, ms);
  await wait(120);
  await demo("press", true);
  await page.mouse.down();
  await wait(90);
  await page.mouse.up();
  await demo("press", false);
  await wait(200);
}
async function click(locator, ms) {
  const el = page.locator(locator).first();
  await el.waitFor({ state: "visible", timeout: 15000 });
  const b = await el.boundingBox();
  await clickAt(b.x + b.width / 2, b.y + b.height / 2, ms);
}
async function typeText(text, delay = 34) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await wait(delay + (ch === " " ? 30 : Math.random() * 24));
  }
}
async function drag(a, b, ms = 1100) {
  await cursorTo(a[0], a[1], 650);
  await demo("press", true);
  await page.mouse.down();
  const steps = Math.round(ms / 30);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const x = a[0] + (b[0] - a[0]) * e,
      y = a[1] + (b[1] - a[1]) * e;
    await Promise.all([page.mouse.move(x, y), demo("cursor", x, y, 30)]);
  }
  await page.mouse.up();
  await demo("press", false);
}
/** wait until every agent session is idle (or timeout) */
async function agentsIdle(timeout = 60000) {
  const t0 = Date.now();
  await wait(1500);
  while (Date.now() - t0 < timeout) {
    const busy = await app(() => {
      const s = window.__meridianAgent.agents.getState();
      const list = Object.values(s.sessions ?? s.byId ?? {});
      return list.some((x) => x.status === "running" || x.status === "thinking" || x.status === "working");
    });
    if (!busy) return;
    await wait(400);
  }
}
const SQUARE = [-613, -523];
const LOT = [261, -461];

// ---- scenes ------------------------------------------------------------------------------
// Text gets its own beats over a frosted view of the next shot; the product shots run clean.

const july3pm = () =>
  app(() => {
    const s = window.__meridianApp.getState();
    s.setDate("07-17");
    s.setHour(15);
    s.setPlaying(false);
    s.setSelection([]);
  });

// The problem, over a slow turn above downtown in the July heat.
await capture("01-open", async () => {
  await july3pm();
  await app(() => window.__meridianApp.getState().setOverlay("heat"));
  await demo("cine", true);
  await demo("jump", [-380, -420], { zoom: 15.25, pitch: 63, bearing: -52 });
  await wait(1200);
  const turn = demo("orbit", 40, 27000);
  await wait(1600);
  await beat({ lead: "A downtown parking lot hits 135 °F.", tail: "At 3 PM in July." }, 3400);
  await wait(900);
  await beat({ lead: "Six in ten sidewalks downtown", tail: "sit in full sun." }, 3000);
  await wait(900);
  await beat({ lead: "Testing a better street takes months.", note: "A traffic study, a heat study and a public meeting, each in its own report." }, 3800);
  await wait(1400);
  await beat({ brand: true, lead: "Meridian", note: "See what a change does to the city, before it is built." }, 4200);
  await turn;
});

// The real city.
await capture("02-city", async () => {
  await july3pm();
  await app(() => window.__meridianApp.getState().setOverlay(null));
  await demo("cine", true);
  await demo("jump", [64, -120], { zoom: 15.4, pitch: 60, bearing: 160 });
  await wait(800);
  await beat({ lead: "This is Austin.", tail: "Every building, street and tree." }, 2800);
  await demo("cine", false);
  await demo("fly", [64, 244], { zoom: 16.6, pitch: 62, bearing: 205, duration: 5200, curve: 1 });
  await demo("orbit", 40, 4200);
});

// Search.
await capture("03-search", async () => {
  await demo("cine", false);
  await beat({ lead: "Go anywhere." }, 1700);
  await click('input[aria-label="Search for a place, street or address"]', 900);
  await wait(250);
  await typeText("Main Building");
  await wait(900);
  await page.keyboard.press("Enter");
  await demo("hideCursor");
  await wait(2200);
  await demo("fly", [157, 1499], { zoom: 16.75, pitch: 62, bearing: -35, duration: 2600 });
  await demo("orbit", 55, 5200);
});

// Heat through a July day.
await capture("04-heat", async () => {
  await demo("cine", false);
  await demo("jump", [-250, -380], { zoom: 15.6, pitch: 58, bearing: -30 });
  await app(() => {
    const s = window.__meridianApp.getState();
    s.setOverlay(null);
    s.setDate("07-17");
    s.setHour(7);
    s.setPlaying(false);
  });
  await wait(600);
  await beat({ lead: "See the heat,", tail: "hour by hour." }, 2200);
  await click('button:has-text("Heat")', 900);
  await wait(2400);
  await click('button[aria-label="Play the day"]', 800);
  await demo("hideCursor");
  await wait(9800);
  await app(() => {
    const s = window.__meridianApp.getState();
    s.setPlaying(false);
    s.setHour(15);
  });
  await wait(1400);
});

// A parking lot becomes a park; the numbers move.
await capture("05-edit", async () => {
  await demo("cine", false);
  await july3pm();
  await app(() => window.__meridianApp.getState().setOverlay("heat"));
  await demo("jump", LOT, { zoom: 17.5, pitch: 52, bearing: -18 });
  await wait(700);
  await beat({ lead: "Change a block.", tail: "Watch the numbers move." }, 2400);
  await wait(500);
  const p = await screenOf(LOT);
  await clickAt(p[0], p[1], 1000);
  await wait(1100);
  await click('[aria-label="Convert to"]', 800);
  await wait(500);
  await click('[role="option"]:has-text("park")', 700);
  await demo("hideCursor");
  await wait(4200);
  await app(() => window.__meridianApp.getState().setSelection([]));
  await demo("orbit", -30, 3600);
});

// Ask the agent.
await capture("06-agent", async () => {
  await demo("cine", false);
  await july3pm();
  await app(() => {
    const s = window.__meridianApp.getState();
    s.setOverlay("heat");
    s.setAgentOpen(false);
  });
  await demo("jump", [-560, -470], { zoom: 15.9, pitch: 55, bearing: -20 });
  await wait(700);
  await beat({ lead: "Or just ask." }, 1800);
  await click('button:has-text("Agent")', 900);
  await wait(900);
  await click('[aria-label="Message the agent"]', 700);
  await typeText("Cool down the streets around Republic Square for people walking at 3 PM");
  await wait(500);
  await page.keyboard.press("Enter");
  await demo("hideCursor");
  await agentsIdle(60000);
  await wait(6000);
});

// Several agents, one zone each.
await capture("07-zones", async () => {
  await demo("cine", false);
  await july3pm();
  await app(() => {
    const s = window.__meridianApp.getState();
    s.setOverlay(null);
    s.setAgentOpen(true);
  });
  await tool("annotate", { clear: true });
  await demo("jump", [90, 120], { zoom: 15.15, pitch: 36, bearing: 0 });
  await wait(900);
  await beat({ lead: "Many agents, one city.", note: "Draw a zone for each job. They work at the same time, each inside its own." }, 3400);
  const zones = [
    { a: [-560, 850], b: [-180, 320], prompt: "Plant shade trees on the streets in this zone" },
    { a: [-280, 1080], b: [-60, 540], prompt: "Give Guadalupe protected bike lanes here, inside the existing curbs" },
    { a: [180, -100], b: [760, -820], prompt: "Turn the big surface parking lots here into homes" },
  ];
  for (const z of zones) {
    await click('button[aria-label="New agent"]', 700);
    await wait(500);
    await click('button[aria-label="Zone: Anywhere"]', 650);
    await wait(350);
    await click('[cmdk-item]:has-text("Draw rectangle")', 600);
    await wait(400);
    const a = await screenOf(z.a),
      b = await screenOf(z.b);
    await drag(a, b, 1000);
    await wait(600);
    await click('[aria-label="Message the agent"]', 650);
    await typeText(z.prompt, 26);
    await page.keyboard.press("Enter");
    await wait(700);
  }
  await click('button[aria-label="Back to all agents"]', 700);
  await demo("hideCursor");
  await agentsIdle(90000);
  await wait(3500);
});

// The models check it.
await capture("08-traffic", async () => {
  await demo("cine", false);
  await app(() => window.__meridianApp.getState().setOverlay("traffic"));
  await demo("jump", [-170, 790], { zoom: 16.3, pitch: 56, bearing: 24 });
  await wait(1200);
  await beat({ lead: "Every change is tested.", note: "Traffic, heat, shade and stormwater models run on every edit." }, 3200);
  await demo("orbit", 30, 7000);
});

await capture("09-close", async () => {
  await demo("cine", true);
  await app(() => window.__meridianApp.getState().setOverlay("heat"));
  await demo("jump", [-200, 300], { zoom: 14.6, pitch: 60, bearing: -10 });
  await wait(600);
  const turn = demo("orbit", 22, 8500);
  await wait(800);
  await demo("beat", { brand: true, lead: "Meridian", note: "Plan the city you want to live in." });
  await turn;
});

// ---- join ----------------------------------------------------------------------------------
const clips = ["01-open", "02-city", "03-search", "04-heat", "05-edit", "06-agent", "07-zones", "08-traffic", "09-close"].map((n) => `${OUT}/clip-${n}.mp4`).filter((f) => existsSync(f));
if (clips.length > 1) {
  const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
  const X = 0.5;
  let filter = "",
    prev = "[0:v]",
    offset = 0;
  for (let i = 1; i < clips.length; i++) {
    offset += dur(clips[i - 1]) - X;
    const outL = i === clips.length - 1 ? "[v]" : `[x${i}]`;
    filter += `${prev}[${i}:v]xfade=transition=fade:duration=${X}:offset=${offset.toFixed(3)}${outL};`;
    prev = outL;
  }
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...clips.flatMap((c) => ["-i", c]), "-filter_complex", filter.replace(/;$/, ""), "-map", "[v]", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${OUT}/meridian-demo.mp4`]);
  console.log(`wrote ${OUT}/meridian-demo.mp4`);
}
