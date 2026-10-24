// Usage: node scripts/dev/act.mjs <script.json> <outPrefix>
// script: { steps: [ {tool, input} | {wait: ms} | {shot: name} | {click: text} | {eval: js} | {fill: {selector, text, enter}} | {waitFor: js} ], viewport? }
import { chromium } from "playwright";
import fs from "node:fs";
const [file, prefix] = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(file, "utf8"));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: script.viewport ?? { width: 1600, height: 1000 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(script.url ?? "http://localhost:3000/", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => window.__meridianTools && window.__meridian, null, { timeout: 120000 });
await page.waitForTimeout(script.settle ?? 6000);
let i = 0;
for (const st of script.steps) {
  i++;
  const t = Date.now();
  if (st.tool) {
    const r = await page.evaluate(async ([n, inp]) => { const o = await window.__meridianTools.run(n, inp); return { display: o.display, isError: o.isError, content: JSON.stringify(o.content).slice(0, 1600) }; }, [st.tool, st.input ?? {}]);
    console.log(`\n#${i} ${st.tool} (${Date.now() - t} ms) ${r.isError ? "ERROR" : ""}\n  ${r.display.title} — ${r.display.detail ?? ""}`);
    for (const l of (r.display.lines ?? []).slice(0, 10)) console.log("   ·", l);
    if (st.verbose || r.isError) console.log("   content:", r.content);
  } else if (st.wait) await page.waitForTimeout(st.wait);
  else if (st.click) { await page.getByText(st.click, { exact: st.exact ?? false }).first().click(); }
  else if (st.eval) { const r = await page.evaluate(st.eval); console.log(`#${i} eval:`, JSON.stringify(r)?.slice(0, 800)); }
  else if (st.key) await page.keyboard.press(st.key);
  else if (st.fill) { await page.locator(st.fill.selector).first().fill(st.fill.text); if (st.fill.enter) await page.keyboard.press("Enter"); }
  else if (st.waitFor) { await page.waitForFunction(st.waitFor.trim().startsWith("(") ? `(${st.waitFor})()` : st.waitFor, null, { timeout: st.timeout ?? 300000, polling: 1000 }); console.log(`#${i} waitFor ok (${Date.now() - t} ms)`); }
  else if (st.mouse) { await page.mouse.click(st.mouse[0], st.mouse[1]); }
  else if (st.shot) { await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); await page.screenshot({ path: `${prefix}-${st.shot}.png`, timeout: 180000 }); console.log(`#${i} shot ${st.shot}`); }
}
console.log("\nlogs:\n" + logs.filter((l) => !l.includes("luma.gl") && !l.includes("Style is not done")).slice(-15).join("\n"));
await browser.close();
