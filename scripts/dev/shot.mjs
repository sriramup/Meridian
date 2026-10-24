// Usage: node scripts/dev/shot.mjs <url> <out.png> [waitMs] [w] [h] [evalJs]
import { chromium } from "playwright";
const [url, out, wait = "12000", w = "1600", h = "1000", js] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(+wait);
if (js) {
  const r = await page.evaluate(js);
  if (r !== undefined) console.log("eval:", JSON.stringify(r).slice(0, 2000));
  await page.waitForTimeout(4000);
}
await page.screenshot({ path: out });
console.log(logs.filter((l) => !l.includes("Download the React DevTools")).slice(-25).join("\n"));
await browser.close();
