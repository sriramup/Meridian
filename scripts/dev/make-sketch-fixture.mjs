// Generates the sketch test fixtures with Playwright (an HTML canvas, hand-drawn-looking strokes):
//   tests/fixtures/sketch-whiteboard.png — a whiteboard-style bird's-eye sketch matching
//     tests/fixtures/sketch-plan.json (the mock vision reply): a thick avenue, a market street, local
//     streets, a river, a park, a SCHOOL box and labels;
//   tests/fixtures/selfie.png — a portrait "not a plan" image (a doodled face).
// Usage: node scripts/dev/make-sketch-fixture.mjs
import { writeFileSync, statSync } from "node:fs";
import { chromium } from "playwright";

const W = 1000,
  H = 750;

const page = `<!doctype html><canvas id=c></canvas><script>
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const j = (a) => (rnd() - 0.5) * a;
function make(w, h) { const c = document.getElementById("c"); c.width = w; c.height = h; return c.getContext("2d"); }
// a marker stroke through normalised points, wobbling a little, drawn twice like a real pen
function stroke(g, pts, w, color, wob = 3) {
  for (let pass = 0; pass < 2; pass++) {
    g.beginPath();
    g.lineWidth = w * (pass ? 0.75 : 1);
    g.strokeStyle = color;
    g.lineCap = "round"; g.lineJoin = "round";
    let first = true;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const n = Math.max(2, Math.round(Math.hypot((x1 - x0) * W, (y1 - y0) * H) / 40));
      for (let k = 0; k <= n; k++) {
        const t = k / n, x = (x0 + (x1 - x0) * t) * W + j(wob), y = (y0 + (y1 - y0) * t) * H + j(wob);
        if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y);
      }
    }
    g.stroke();
  }
}
function label(g, text, x, y, size, color, rot = 0) {
  g.save(); g.translate(x * W, y * H); g.rotate(rot); g.fillStyle = color;
  g.font = "600 " + size + "px 'Comic Sans MS', 'Chalkboard SE', 'Segoe Print', cursive";
  g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 0, 0); g.restore();
}
const W = ${W}, H = ${H};
function whiteboard() {
  const g = make(W, H);
  g.fillStyle = "#f3f4f1"; g.fillRect(0, 0, W, H);
  // board sheen and a darker frame edge as flat bands (a gradient would dither into noise and bloat the PNG)
  g.fillStyle = "#f8f9f6"; g.beginPath(); g.ellipse(W * 0.42, H * 0.38, W * 0.32, H * 0.26, -0.3, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "#d9dcd6"; g.lineWidth = 26; g.strokeRect(0, 0, W, H);
  // faint ghosts of an erased drawing
  g.globalAlpha = 0.07; stroke(g, [[0.1, 0.85], [0.4, 0.95]], 8, "#334"); stroke(g, [[0.8, 0.1], [0.95, 0.3]], 6, "#334"); g.globalAlpha = 1;
  const ink = "#1f2430", blue = "#1d5fb5", green = "#24813d", red = "#c2332b";
  // the river: two wavy banks
  const river = [[0.55, 1.0], [0.62, 0.9], [0.72, 0.8], [0.84, 0.72], [0.93, 0.66], [1.0, 0.63]];
  const off = (d) => river.map(([x, y], i) => { const a = river[Math.min(i + 1, river.length - 1)], b = river[Math.max(i - 1, 0)]; const dx = a[0] - b[0], dy = a[1] - b[1], L = Math.hypot(dx * W, dy * H); return [x - (dy * H / L) * d / W, y + (dx * W / L) * d / H]; });
  stroke(g, off(-22), 4, blue, 5); stroke(g, off(22), 4, blue, 5);
  for (let k = 0; k < 9; k++) { const t = 0.1 + k * 0.1, i = Math.floor(t * (river.length - 1)), f = t * (river.length - 1) - i; const p = [river[i][0] + (river[i + 1][0] - river[i][0]) * f, river[i][1] + (river[i + 1][1] - river[i][1]) * f]; stroke(g, [[p[0] - 0.012, p[1]], [p[0] - 0.004, p[1] - 0.008], [p[0] + 0.004, p[1]], [p[0] + 0.012, p[1] - 0.008]], 2, blue, 1); }
  label(g, "RIVER", 0.86, 0.79, 26, blue, -0.45);
  // Grand Avenue: a thick double line
  const ave = [[0.02, 0.45], [0.35, 0.44], [0.65, 0.46], [0.98, 0.45]];
  stroke(g, ave.map(([x, y]) => [x, y - 0.012]), 6, ink); stroke(g, ave.map(([x, y]) => [x, y + 0.012]), 6, ink);
  label(g, "GRAND AVE", 0.14, 0.415, 24, ink);
  // Market Street: medium
  stroke(g, [[0.5, 0.05], [0.5, 0.45], [0.51, 0.8]], 5, ink);
  label(g, "MARKET ST", 0.475, 0.6, 20, ink, -Math.PI / 2);
  // local streets: thin
  stroke(g, [[0.25, 0.08], [0.25, 0.45], [0.25, 0.92]], 3, ink);
  stroke(g, [[0.75, 0.08], [0.75, 0.45], [0.75, 0.66]], 3, ink);
  stroke(g, [[0.05, 0.2], [0.5, 0.2], [0.95, 0.2]], 3, ink);
  stroke(g, [[0.05, 0.72], [0.25, 0.72], [0.51, 0.72]], 3, ink);
  // the park, with scribbled trees
  stroke(g, [[0.27, 0.48], [0.48, 0.48], [0.48, 0.7], [0.27, 0.7], [0.27, 0.48]], 3.5, green, 2);
  for (const [x, y] of [[0.3, 0.52], [0.33, 0.6], [0.3, 0.66], [0.44, 0.52], [0.45, 0.63], [0.38, 0.67]]) { g.beginPath(); g.lineWidth = 2.5; g.strokeStyle = green; g.arc(x * W + j(2), y * H + j(2), 13, 0, Math.PI * 2); g.stroke(); }
  label(g, "PARK", 0.375, 0.59, 30, green);
  // the school
  stroke(g, [[0.54, 0.06], [0.72, 0.06], [0.72, 0.18], [0.54, 0.18], [0.54, 0.06]], 4, red, 2);
  label(g, "SCHOOL", 0.63, 0.12, 30, red);
  // labelled blocks
  for (let k = 0; k < 7; k++) stroke(g, [[0.54 + k * 0.025, 0.42], [0.58 + k * 0.022, 0.24]], 1.5, "#7a7f8a", 1);
  label(g, "MIXED USE", 0.625, 0.33, 22, ink);
  label(g, "HOUSING", 0.14, 0.585, 22, ink);
  // title and north arrow
  label(g, "RIVERBEND", 0.84, 0.09, 34, ink);
  stroke(g, [[0.06, 0.16], [0.06, 0.05]], 3, ink, 1); stroke(g, [[0.045, 0.08], [0.06, 0.05], [0.075, 0.08]], 3, ink, 1);
  label(g, "N", 0.06, 0.025, 22, ink);
  // quantise to the marker palette (plus half-tones for antialiasing): a photo-real PNG of a board
  // would be megabytes; this keeps the fixture small while looking drawn
  const pal = [[243, 244, 241], [248, 249, 246], [217, 220, 214], [31, 36, 48], [29, 95, 181], [36, 129, 61], [194, 51, 43], [122, 127, 138]];
  const tones = []; for (const c of pal) { tones.push(c); tones.push(c.map((v, i) => Math.round((v + pal[0][i]) / 2))); }
  const im = g.getImageData(0, 0, W, H), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < tones.length; k++) { const t = tones[k], e = (d[i] - t[0]) ** 2 + (d[i + 1] - t[1]) ** 2 + (d[i + 2] - t[2]) ** 2; if (e < bd) { bd = e; best = k; } }
    d[i] = tones[best][0]; d[i + 1] = tones[best][1]; d[i + 2] = tones[best][2]; d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return document.getElementById("c").toDataURL("image/png");
}
function selfie() {
  const w = 480, h = 640; const g = make(w, h);
  g.fillStyle = "#cfd8e3"; g.fillRect(0, 0, w, h);
  g.fillStyle = "#e9c2a0"; g.beginPath(); g.ellipse(240, 300, 130, 165, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#4a3426"; g.beginPath(); g.ellipse(240, 170, 140, 70, 0, Math.PI, 0); g.fill();
  g.fillStyle = "#2b2b2b"; for (const x of [190, 290]) { g.beginPath(); g.arc(x, 290, 12, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = "#9b4a3c"; g.lineWidth = 6; g.beginPath(); g.arc(240, 360, 50, 0.2, Math.PI - 0.2); g.stroke();
  g.fillStyle = "#3a5f8f"; g.fillRect(90, 480, 300, 160);
  return document.getElementById("c").toDataURL("image/png");
}
window.__out = { whiteboard: whiteboard(), selfie: selfie() };
</script>`;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" });
const p = await browser.newPage();
await p.setContent(page);
const out = await p.evaluate(() => window.__out);
await browser.close();
for (const [name, file] of [["whiteboard", "tests/fixtures/sketch-whiteboard.png"], ["selfie", "tests/fixtures/selfie.png"]]) {
  writeFileSync(file, Buffer.from(out[name].split(",")[1], "base64"));
  console.log(file, Math.round(statSync(file).size / 1024), "KB");
}
