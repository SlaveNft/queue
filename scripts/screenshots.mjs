#!/usr/bin/env node
// Regenerate docs/screenshots from a running console (npm run dev).
// Usage: node scripts/screenshots.mjs [baseUrl]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ROOT } from "./lib.mjs";

const base = process.argv[2] || "http://localhost:4178";
const api = process.env.QUEUE_API || "http://localhost:8789";
const out = path.join(ROOT, "docs", "screenshots");
mkdirSync(out, { recursive: true });

const post = (p) =>
  fetch(`${api}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const state = async () => (await (await fetch(`${api}/api/state`)).json()).state;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name, selector) {
  const file = path.join(out, `${name}.png`);
  if (selector) {
    const el = page.locator(selector).first();
    // Fixed chrome (sticky nav, skip link) is not part of the section and
    // looks like a broken layout when baked into an element screenshot.
    const hideChrome = await page.addStyleTag({
      content: ".nav, .skip-link { display: none !important; }",
    });
    await el.scrollIntoViewIfNeeded();
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.mouse.move(5, 5);
    await sleep(600);
    await el.screenshot({ path: file });
    await hideChrome.evaluate((node) => node.remove());
  } else {
    await page.screenshot({ path: file });
  }
  console.log(`saved ${path.relative(ROOT, file)}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });

await post("/api/demo/reset");
await page.goto(base, { waitUntil: "networkidle" });
await sleep(800);
await shot(page, "home");
await shot(page, "explainer", "#idea");
await shot(page, "console-standby", "#console");

await post("/api/demo/run");
// Mid-run: the purchase has landed and the urgent job is running.
for (let i = 0; i < 40; i += 1) {
  const s = await state();
  if (s.running && s.running.expedited) break;
  await sleep(250);
}
await sleep(2500);
await shot(page, "console-running", "#console");

// Urgent job delivered.
for (let i = 0; i < 80; i += 1) {
  const s = await state();
  if (s.scenario.status === "done") break;
  await sleep(250);
}
await sleep(1200);
await shot(page, "console-settled", "#console");

// Every displaced job delivered on time.
for (let i = 0; i < 300; i += 1) {
  const s = await state();
  if (s.stats.completed === 5 && !s.running && s.queue.length === 0) break;
  await sleep(250);
}
await sleep(1200);
await shot(page, "console-all-on-time", "#console");

// README hero: the real final state, matching its "all four delivered" caption.
await page.setViewportSize({ width: 1440, height: 1000 });
await page.locator("#console .console-grid, #console").first().evaluate((el) => el.scrollIntoView({ block: "start" }));
await page.evaluate(() => window.scrollBy(0, 120));
await sleep(600);
await page.screenshot({ path: path.join(out, "console-hero.png") });
console.log("saved docs/screenshots/console-hero.png");

// Social preview: 1200x630, same final console state.
const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: "dark" });
await og.goto(base, { waitUntil: "networkidle" });
await og.locator("#console").evaluate((el) => el.scrollIntoView({ block: "start" }));
await sleep(600);
await og.screenshot({ path: path.join(ROOT, "apps", "web", "public", "og.png") });
console.log("saved apps/web/public/og.png");
await og.close();

await shot(page, "mechanism", "#mechanism");
await shot(page, "proof", "#proof");
// The live season: wait for the run's numbers before the shot.
await page.waitForSelector("#season .season-stats", { timeout: 20000 }).catch(() => {});
await shot(page, "season", "#season");

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
await mobile.goto(base, { waitUntil: "networkidle" });
await sleep(800);
await shot(mobile, "mobile");

await browser.close();
