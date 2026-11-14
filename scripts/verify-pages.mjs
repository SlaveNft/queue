#!/usr/bin/env node
// End-to-end check of the hosted console (apps/web/dist-pages), the way a judge meets it: a static folder
// under a sub-path, no API, no keys.
//
//   npm run verify:pages         (rebuilds the hosted console first; about 90 seconds)
//
// It serves the folder at http://127.0.0.1:<port>/queue-demo/, opens it in headless Chromium and requires:
//   - the page loads with no script error, no failed request and no call to /api;
//   - one click on "Run the live scenario" starts the run (no dialog in the way);
//   - the purchase pays four agents, the urgent job delivers, and the receipt ends at
//     "4 of 4 crossed promises kept" (5 of 5 jobs on time, computed by the engine in the tab);
//   - a displaced agent can withdraw its credit;
//   - the proof and season sections show the testnet contracts from the published records.
// Exit code 0 only if every check passes; 2 = Chromium is not installed (SKIP).
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { ROOT } from "./lib.mjs";

const DIST = path.join(ROOT, "apps/web/dist-pages");
const PREFIX = "/queue-demo/";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".mp3": "audio/mpeg", ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8",
};

if (!existsSync(path.join(DIST, "index.html"))) {
  const built = spawnSync("npm", ["run", "build:pages"], { cwd: ROOT, stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (!url.pathname.startsWith(PREFIX)) {
    res.writeHead(404).end("outside the site");
    return;
  }
  let file = path.join(DIST, decodeURIComponent(url.pathname.slice(PREFIX.length)) || "index.html");
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`verify-pages: ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
};

let browser;
try {
  browser = await chromium.launch();
} catch (error) {
  server.close();
  console.error("verify-pages: SKIP — headless Chromium is not installed. Run `npx playwright install chromium` once, then retry.");
  console.error(String(error instanceof Error ? error.message : error).split("\n")[0]);
  process.exit(2);
}
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const errors = [];
const badRequests = [];
const apiCalls = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.origin === new URL(base).origin && url.pathname.includes("/api/")) apiCalls.push(url.pathname);
});
page.on("response", (response) => {
  if (new URL(response.url()).origin === new URL(base).origin && response.status() >= 400) {
    badRequests.push(`${response.status()} ${response.url()}`);
  }
});

const text = () => page.evaluate(() => document.body.innerText);
const waitForText = async (pattern, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pattern.test(await text())) return true;
    await page.waitForTimeout(500);
  }
  return false;
};

try {
  await page.goto(base, { waitUntil: "networkidle" });
  check(await waitForText(/In-tab live/i, 8_000), "the console is live with the ledger in the tab");
  const standby = await text();
  check(/Triage the checkout incident/.test(standby) && /Summarize the latency escalation/.test(standby), "the standby queue shows the four seeded jobs");

  await page.getByRole("button", { name: /Run the live scenario from the hero/i }).click();
  await page.waitForTimeout(700);
  check((await page.getByRole("dialog").count()) === 0, "one click starts the scenario (no confirmation on an untouched queue)");
  check(await waitForText(/Board brief: checkout incident/, 10_000), "Kestrel's urgent job arrives");
  check(await waitForText(/\+0\.00504 NEAR/, 15_000), "the purchase pays Mira 0.00504 NEAR (her ask × 12 s)");
  const paid = await text();
  check(/\+0\.00696 NEAR/.test(paid) && /\+0\.00432 NEAR/.test(paid) && /\+0\.00372 NEAR/.test(paid), "Atlas, Vale and Juno are paid their own asks");
  check(await waitForText(/4 of 4 crossed promises kept/, 100_000), "every displaced job delivers before its own deadline (4 of 4 promises kept)");

  const withdraw = page.getByRole("button", { name: /^Withdraw .* for Mira/i }).first();
  if ((await withdraw.count()) > 0) {
    await withdraw.scrollIntoViewIfNeeded();
    await withdraw.click();
    check(await waitForText(/claimed/i, 5_000), "Mira withdraws her credit");
  } else {
    check(false, "Mira has a credit to withdraw");
  }

  const proof = await text();
  check(/market\.queue-demo\.testnet/.test(proof), "the proof section names the v1 testnet contract");
  check(/market4\.queue-demo\.testnet/.test(proof), "the season section names the season contract");
  check(apiCalls.length === 0, "no request to /api", apiCalls.slice(0, 3).join(", "));
  check(badRequests.length === 0, "no failed request", badRequests.slice(0, 3).join(", "));
  check(errors.length === 0, "no script error", errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  server.close();
}

if (failed > 0) {
  console.error(`verify-pages: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("verify-pages: OK — the hosted console runs the full scenario with no backend");
