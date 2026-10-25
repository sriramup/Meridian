// End-to-end check of the sketch input against a dev server running on the mock Anthropic API:
//   node scripts/dev/mock-anthropic.mjs 4012
//   PORT=3111 ANTHROPIC_API_KEY=mock MERIDIAN_ANTHROPIC_BASE_URL=http://localhost:4012 \
//     MERIDIAN_SPEND_LEDGER=.scratch/mock-spend.json npx next dev -p 3111
//   node scripts/dev/sketch-e2e.mjs [http://localhost:3111] [outDir]
// Steps: preset from the Start card (file chooser) → read + build → screenshots → undo → redo →
// upload in the composer of a second agent onto the canvas that now has a design (lands in free
// space) → paste → camera dialog (fake device) → a selfie is refused. Screenshots go to outDir.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const [base = "http://localhost:3111", out = ".scratch/e2e"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const FIX = "tests/fixtures/sketch-whiteboard.png";
const SELFIE = "tests/fixtures/selfie.png";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ["camera", "clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => m.type() === "error" && logs.push(`[console] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const step = (s) => console.log(`— ${s}`);
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const world = () => page.evaluate(async () => (await window.__meridianTools.run("get_context", {})).content);
const counts = async () => {
  const c = await world();
  return JSON.stringify(c).match(/(\d+) buildings?/)?.[1] ?? JSON.stringify(c).slice(0, 200);
};

step("open the app (fresh browser: a blank canvas)");
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForSelector("[data-testid=start-card]", { timeout: 120000 });
await page.waitForTimeout(1500);
await shot("01-start-card");

step("preset: Start card → From a sketch or photo… → choose the fixture");
await page.click("[data-testid=start-from-sketch]");
await page.waitForSelector("[data-testid=sketch-start-drop]");
await shot("02-preset-dialog");
const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("[data-testid=sketch-start-drop]")]);
await chooser.setFiles(FIX);

step("the agent reads and builds it");
await page.waitForSelector("text=/Built\\s+Riverbend/", { timeout: 180000 });
await page.waitForTimeout(5000);
await shot("03-built");
console.log("buildings after first build:", await counts());
const projectName = await page.locator("[data-project-row]").first().innerText();
console.log("project rows:", (await page.locator("[data-project-row]").allInnerTexts()).map((t) => t.split("\n")[0]));

step("close the pane and look at the result");
await page.keyboard.press("Escape");
await page.evaluate(() => window.__meridianApp.getState().setAgentOpen(false));
await page.waitForTimeout(3000);
await shot("04-built-map");

step("undo the build in one step, then redo");
const before = await counts();
await page.evaluate(() => window.__meridianTools.run("undo", { steps: 1 }));
await page.waitForTimeout(2500);
const afterUndo = await counts();
await shot("05-undone");
await page.evaluate(() => window.__meridianTools.run("redo", {}).catch(() => null));
await page.waitForTimeout(2500);
console.log("undo:", before, "→", afterUndo, "→ redo:", await counts());

step("second sketch from the composer (upload) onto the canvas that has a design");
await page.evaluate(() => window.__meridianApp.getState().setAgentOpen(true));
await page.waitForTimeout(800);
await page.evaluate(() => window.__meridianAgent.createSession());
await page.waitForTimeout(800);
await page.click("[data-testid=sketch-attach]");
const [chooser2] = await Promise.all([page.waitForEvent("filechooser"), page.click("[data-testid=sketch-upload]")]);
await chooser2.setFiles(FIX);
await page.waitForSelector("[data-testid=sketch-chip] img", { timeout: 30000 });
await page.fill("textarea[aria-label='Message the agent']", "Here is a second neighborhood");
await shot("06-composer-chip");
await page.keyboard.press("Enter");
await page.waitForSelector("text=/nearest free space/", { timeout: 180000 });
await page.waitForTimeout(5000);
await shot("07-second-build");
console.log("buildings after second build:", await counts());

step("paste an image into the composer");
await page.evaluate(() => window.__meridianAgent.createSession());
await page.waitForTimeout(600);
const b64 = (await import("node:fs")).readFileSync(SELFIE).toString("base64");
await page.focus("textarea[aria-label='Message the agent']");
await page.evaluate(async (data) => {
  const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const file = new File([bin], "image.png", { type: "image/png" });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelector("textarea[aria-label='Message the agent']").dispatchEvent(ev);
}, b64);
await page.waitForSelector("[data-testid=sketch-chip] img", { timeout: 30000 });
await shot("08-pasted");
step("…it is a selfie: the agent says it's not a plan and builds nothing");
const n0 = await counts();
await page.keyboard.press("Enter");
await page.waitForSelector("text=/doesn't look like a bird's-eye plan/", { timeout: 120000 });
await page.waitForTimeout(1500);
await shot("09-not-a-plan");
console.log("buildings before/after selfie:", n0, await counts());

step("camera dialog with the fake device: capture → retake → use");
await page.evaluate(() => window.__meridianAgent.createSession());
await page.waitForTimeout(600);
await page.click("[data-testid=sketch-attach]");
await page.click("[data-testid=sketch-camera]");
await page.waitForSelector("text=Capture", { timeout: 20000 });
await page.waitForTimeout(1500);
await shot("10-camera-live");
await page.click("text=Capture");
await page.waitForSelector("text=Use photo");
await shot("11-camera-captured");
await page.click("text=Retake");
await page.waitForSelector("text=Capture");
await page.click("text=Capture");
await page.click("text=Use photo");
await page.waitForSelector("[data-testid=sketch-chip] img", { timeout: 30000 });
await shot("12-camera-chip");

step("camera permission denied");
const denied = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const p2 = await denied.newPage();
await p2.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
});
await p2.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
await p2.waitForSelector("[data-testid=start-card]", { timeout: 120000 });
await p2.click("[data-testid=start-from-sketch]");
await p2.click("[data-testid=sketch-start-camera]");
await p2.waitForSelector("text=Camera access is blocked", { timeout: 20000 });
await p2.screenshot({ path: `${out}/13-camera-denied.png` });

step("preset from the projects sidebar New menu");
await page.click("[data-testid=new-project]");
await page.click("[data-testid=new-from-sketch]");
await page.waitForSelector("[data-testid=sketch-start-drop]");
await shot("14-new-menu-dialog");
await page.keyboard.press("Escape");

console.log(logs.slice(-20).join("\n"));
await browser.close();
console.log(`screenshots in ${out}; project row: ${projectName.split("\n")[0]}`);
