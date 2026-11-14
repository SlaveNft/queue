#!/usr/bin/env node
// Product demo: a real screen recording of the hosted console (apps/web/dist-pages) with burned-in captions.
// One click on "Run the live scenario", then the visible result: the purchase, the four paid agents, the
// deliveries, a withdrawal, the season numbers and the refused jump. No narration, no keys, no transactions.
//
//   npm run film:demo                                  (about 2 minutes; writes docs/media/queue-demo.mp4)
//   node scripts/record-demo.mjs [siteDir] [--out file.mp4] [--no-explorer] [--explorer <url>]
//
// How it records:
//   - the folder is served at http://127.0.0.1:<port>/queue-demo/ (same as verify-pages), opened in headless
//     Chromium laid out at 1280x720 CSS px and drawn at 1.5x, so every frame is a sharp 1920x1080 image;
//   - frames come from the DevTools screencast with their arrival time and are placed on a 30 fps timeline;
//     while the four displaced jobs run, that timeline moves at 1/4 of real time and the page shows "x4";
//   - captions, the pointer dot, the outline and the end card are elements injected into the page, so they
//     are part of the frames. Nothing in the app is changed, and nothing is written outside the output file.
//   - the explorer page for the refused jump is shown only if it loads and shows the failure within 10 s
//     (it usually sits behind a bot check); otherwise the refusal is shown in the page's own Season section.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const [, value] = args.splice(at, 2);
  return value;
};
const OUT = path.resolve(flag("--out") ?? path.join(ROOT, "docs/media/queue-demo.mp4"));
const explorerArg = flag("--explorer");
const noExplorer = args.includes("--no-explorer");
if (noExplorer) args.splice(args.indexOf("--no-explorer"), 1);
const DIST = path.resolve(args[0] ?? path.join(ROOT, "apps/web/dist-pages"));
const EXPLORER_URL = noExplorer
  ? null
  : (explorerArg ?? "https://testnet.nearblocks.io/txns/3BrEneh1ypSrWAGtr73nU6hE4u5wRSzJFsWbeKjtUhdj");
const FFMPEG = process.env.FFMPEG ?? (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");

const CSS_W = 1280;
const CSS_H = 720;
const SCALE = 1.5; // 1280x720 CSS px -> 1920x1080 frame
const FPS = 30;
const FAST = 4; // speed of the edit while the four displaced jobs run

const CAPTIONS = {
  hero: "QUEUE — agents pay to cut the line.\nEveryone they pass is paid, and nobody is made late.",
  oneClick: "This is the real console. One click.",
  urgent: "Kestrel's 12\u00a0s job is urgent: its deadline is seconds away.\nIt buys four earlier slots.",
  paid: "Each agent it passes is paid its own posted price ×\u00a012\u00a0s:\nMira +0.00504, Atlas +0.00696, Vale +0.00432, Juno +0.00372 NEAR.",
  first: "The worker runs Kestrel's job first.",
  displaced: "Then the four agents that sold their slots run —\neach still delivers before its own deadline.",
  artifact: "The worker computes a real artifact from the input and records its SHA-256.",
  withdraw: "Displaced agents withdraw what they were paid.",
  season: "The same rule ran on NEAR testnet with eight model agents on NEAR\u00a0AI:\n135 of 138 jobs on time, 4 purchases moved 5 jobs, 0 of them late.",
  refusal: "A model agent tried a jump that would have made another agent late.\nThe contract refused it on chain.",
};

const END_CARD = `
  <div class="demo-end-brand"><span class="demo-end-bars"><i></i><i></i><i></i><i></i></span></div>
  <h1>QUEUE — the queue is a <em>market</em></h1>
  <p class="demo-end-lead">Re-check everything, no keys:</p>
  <p class="demo-end-cmds"><code>npm run verify</code><code>npm run verify:onchain</code><code>npm run verify:season</code><code>npm run verify:v2-deployed</code></p>
  <p class="demo-end-foot">Built at NEAR HACKATHON · NEAR testnet only · not audited</p>`;

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error(`record-demo: ${DIST} has no index.html. Build the hosted console first: npm run build:pages`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------------------
// Static server (the same shape as scripts/verify-pages.mjs).
const PREFIX = "/queue-demo/";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".mp3": "audio/mpeg", ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8",
};
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

// ---------------------------------------------------------------------------------------------------------
// Recorder: screencast frames -> a constant 30 fps stream of JPEGs piped into ffmpeg (stored as is), then
// one H.264 encode at the end. `speed` is how many real seconds one second of video covers.
const work = mkdtempSync(path.join(os.tmpdir(), "queue-demo-"));
const rawFile = path.join(work, "frames.mkv");

function run(cmd, argv, { stdin = "ignore" } = {}) {
  const child = spawn(cmd, argv, { stdio: [stdin, "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with ${code}`))));
  });
  return { child, done };
}

class Recorder {
  constructor() {
    this.ff = run(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "pipe:0", "-c:v", "copy", rawFile], { stdin: "pipe" });
    this.ff.done.catch(() => {});
    this.frame = null;
    this.running = false;
    this.speed = 1;
    this.videoT = 0;
    this.last = 0;
    this.slot = 0;
    this.received = 0;
    this.fresh = false;
    this.perSecond = []; // new (not repeated) frames in each second of video
  }
  tick() {
    if (!this.running) return;
    const now = Date.now() / 1000;
    this.videoT += (now - this.last) / this.speed;
    this.last = now;
    const slot = Math.floor(this.videoT * FPS);
    while (this.slot < slot) {
      this.ff.child.stdin.write(this.frame);
      const second = Math.floor(this.slot / FPS);
      this.perSecond[second] = (this.perSecond[second] ?? 0) + (this.fresh ? 1 : 0);
      this.fresh = false;
      this.slot += 1;
    }
  }
  onFrame(buffer) {
    this.tick();
    this.frame = buffer;
    this.fresh = true;
    this.received += 1;
  }
  resume() {
    if (!this.frame) throw new Error("no frame captured yet");
    this.last = Date.now() / 1000;
    this.running = true;
  }
  pause() {
    this.tick();
    this.running = false;
  }
  setSpeed(speed) {
    this.tick();
    this.speed = speed;
  }
  now() {
    this.tick();
    return this.videoT;
  }
  async finish() {
    this.tick();
    if (this.running && this.frame) {
      this.ff.child.stdin.write(this.frame);
      this.slot += 1;
    }
    this.running = false;
    this.ff.child.stdin.end();
    await this.ff.done;
    return this.slot / FPS;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Everything the film adds to the page. Idempotent, so it can be installed again after a navigation.
function installOverlay() {
  if (window.__demo) return;
  const style = document.createElement("style");
  style.textContent = `
    html { scroll-behavior: auto !important; }
    .nav { transition: transform .4s ease; }
    html.demo-nonav .nav { transform: translateY(-110%); }
    #demo-overlay, #demo-overlay * { box-sizing: border-box; }
    #demo-overlay { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
      font-family: "Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
    .demo-caption { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); width: max-content; max-width: 1140px;
      padding: 13px 26px 14px; border-radius: 14px; background: rgba(6, 6, 6, .9); border: 1px solid rgba(250, 255, 105, .4);
      box-shadow: 0 10px 44px rgba(0, 0, 0, .7); color: #fff; font-size: 28px; line-height: 1.28; font-weight: 600;
      letter-spacing: -.005em; text-align: center; white-space: pre-line; text-wrap: balance; opacity: 0; transition: opacity .18s linear; }
    .demo-badge { position: absolute; right: 20px; bottom: 26px; padding: 7px 13px 8px; border-radius: 9px; background: #faff69; color: #151515;
      font: 800 22px/1 "Inconsolata Variable", "SFMono-Regular", Menlo, monospace; letter-spacing: .02em; opacity: 0; transition: opacity .2s linear; }
    .demo-ring { position: absolute; left: 0; top: 0; border: 2px solid #faff69; border-radius: 7px;
      box-shadow: 0 0 0 5px rgba(250, 255, 105, .16), 0 0 26px rgba(250, 255, 105, .28); opacity: 0; transition: opacity .25s linear; }
    .demo-cursor { position: absolute; left: -13px; top: -13px; width: 26px; height: 26px; border-radius: 50%;
      background: rgba(250, 255, 105, .92); border: 3px solid #151515; box-shadow: 0 0 0 2px rgba(255, 255, 255, .9), 0 4px 14px rgba(0, 0, 0, .6);
      opacity: 0; transition: transform .9s cubic-bezier(.45, .05, .25, 1), opacity .25s linear; }
    .demo-cursor i { position: absolute; inset: -5px; border-radius: 50%; border: 3px solid #faff69; opacity: 0; }
    .demo-cursor.is-click i { animation: demo-pulse .5s ease-out; }
    @keyframes demo-pulse { from { transform: scale(.7); opacity: .95; } to { transform: scale(2.7); opacity: 0; } }
    .demo-end { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0;
      background: #050505; color: #fff; text-align: center; opacity: 0; transition: opacity .45s linear; }
    .demo-end-brand { display: flex; align-items: center; }
    .demo-end-bars { display: inline-flex; align-items: flex-end; gap: 4px; height: 38px; }
    .demo-end-bars i { width: 7px; background: #fff; }
    .demo-end-bars i:nth-child(1) { height: 17px; } .demo-end-bars i:nth-child(2) { height: 24px; }
    .demo-end-bars i:nth-child(3) { height: 31px; } .demo-end-bars i:nth-child(4) { height: 38px; background: #ff6a48; }
    .demo-end h1 { margin: 34px 0 0; font-size: 68px; line-height: 1.05; font-weight: 700; letter-spacing: -.035em; }
    .demo-end h1 em { font-style: normal; color: #faff69; }
    .demo-end-lead { margin: 52px 0 0; font-size: 26px; color: #d9d9d9; }
    .demo-end-cmds { margin: 22px 0 0; display: flex; justify-content: center; gap: 12px; }
    .demo-end-cmds code { padding: 9px 15px 10px; border: 1px solid rgba(250, 255, 105, .55); color: #faff69; background: #101010;
      font: 600 23px/1.1 "Inconsolata Variable", "SFMono-Regular", Menlo, monospace; white-space: nowrap; }
    .demo-end-foot { margin: 56px 0 0; font: 500 19px/1.3 "Inconsolata Variable", "SFMono-Regular", Menlo, monospace; letter-spacing: .06em; color: #a0a0a0; }
  `;
  document.head.appendChild(style);
  const root = document.createElement("div");
  root.id = "demo-overlay";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML =
    '<div class="demo-ring"></div><div class="demo-cursor"><i></i></div><div class="demo-caption"></div>' +
    '<div class="demo-badge"></div><div class="demo-end"></div>';
  document.body.appendChild(root);
  const part = (name) => root.querySelector(`.demo-${name}`);
  const caption = part("caption");
  const ring = part("ring");
  const cursor = part("cursor");
  const badge = part("badge");
  const end = part("end");
  let ringTarget = null;
  let captionTimer = 0;
  const track = () => {
    if (ringTarget && ringTarget.isConnected) {
      const r = ringTarget.getBoundingClientRect();
      const pad = 7;
      ring.style.transform = `translate(${r.left - pad}px, ${r.top - pad}px)`;
      ring.style.width = `${r.width + pad * 2}px`;
      ring.style.height = `${r.height + pad * 2}px`;
      ring.style.opacity = "1";
    } else {
      ring.style.opacity = "0";
    }
    requestAnimationFrame(track);
  };
  requestAnimationFrame(track);
  window.__demo = {
    caption(text) {
      clearTimeout(captionTimer);
      const wasVisible = caption.style.opacity === "1";
      caption.style.opacity = "0";
      if (!text) return;
      captionTimer = setTimeout(() => {
        caption.style.width = "";
        caption.textContent = text;
        // Shrink the pill to its longest line (a wrapped block otherwise keeps the full max-width).
        const range = document.createRange();
        range.selectNodeContents(caption);
        caption.style.width = `${Math.ceil(range.getBoundingClientRect().width) + 56}px`;
        caption.style.opacity = "1";
      }, wasVisible ? 190 : 0);
    },
    ring(element) {
      ringTarget = element ?? null;
    },
    badge(text) {
      if (text) badge.textContent = text;
      badge.style.opacity = text ? "1" : "0";
    },
    cursor(x, y, ms, visible = true) {
      cursor.style.transitionDuration = `${ms}ms, 250ms`;
      cursor.style.transform = `translate(${x}px, ${y}px)`;
      cursor.style.opacity = visible ? "1" : "0";
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    hideCursor() {
      cursor.style.opacity = "0";
    },
    press() {
      cursor.classList.remove("is-click");
      void cursor.offsetWidth;
      cursor.classList.add("is-click");
    },
    scrollTo(top, ms) {
      const from = window.scrollY;
      const to = Math.max(0, Math.min(top, document.documentElement.scrollHeight - window.innerHeight));
      const start = performance.now();
      return new Promise((resolve) => {
        const step = (now) => {
          const p = Math.min(1, (now - start) / ms);
          const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          window.scrollTo(0, from + (to - from) * eased);
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    },
    hideNav(hidden) {
      document.documentElement.classList.toggle("demo-nonav", hidden);
    },
    endCard(html) {
      end.innerHTML = html;
      end.style.opacity = "1";
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch();
const recorder = new Recorder();
const captionLog = [];
let explorerUsed = false;
let explorerNote = "skipped (--no-explorer)";
let duration = 0;

try {
  // The window is 1920x1080; the page inside it is laid out as 1280x720 at device pixel ratio 1.5 and drawn
  // at 1.5x. That is the only arrangement in which the screencast delivers full 1920x1080 frames.
  const context = await browser.newContext({ viewport: { width: CSS_W * SCALE, height: CSS_H * SCALE }, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: CSS_W, height: CSS_H, deviceScaleFactor: SCALE, mobile: false, scale: SCALE, dontSetVisibleSize: true,
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // --- helpers ---------------------------------------------------------------------------------------
  const demo = (method, ...params) => page.evaluate(([m, p]) => window.__demo[m](...p), [method, params]);
  const caption = async (key) => {
    const text = key ? CAPTIONS[key] : "";
    await demo("caption", text);
    if (text) captionLog.push({ at: recorder.now() + 0.19, text });
    else if (captionLog.length) captionLog.at(-1).until = recorder.now();
  };
  const ring = (selector, containing) =>
    page.evaluate(([sel, text]) => {
      const found = sel ? [...document.querySelectorAll(sel)].find((el) => !text || el.textContent.includes(text)) : null;
      window.__demo.ring(found ?? null);
      return Boolean(found);
    }, [selector ?? null, containing ?? null]);
  const scrollToEl = (selector, offset, ms, edge = "top") =>
    page.evaluate(([sel, off, time, side]) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`record-demo: ${sel} is not on the page`);
      return window.__demo.scrollTo(el.getBoundingClientRect()[side] + window.scrollY - off, time);
    }, [selector, offset, ms, edge]);
  const textOf = (selector) => page.evaluate((sel) => document.querySelector(sel)?.innerText ?? "", selector);
  const waitFor = async (selector, pattern, timeoutMs, label) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (pattern.test(await textOf(selector))) return;
      await sleep(80);
    }
    throw new Error(`record-demo: timed out waiting for ${label}`);
  };
  const centerOf = (selector, label) =>
    page.evaluate(([sel, name]) => {
      const el = [...document.querySelectorAll(sel)].find((node) => !name || new RegExp(name, "i").test(node.getAttribute("aria-label") ?? ""));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, [selector, label ?? null]);
  // The real pointer works in window pixels, which are 1.5x the page's CSS pixels.
  const pointAndClick = async (target, travelMs) => {
    await demo("cursor", target.x, target.y, travelMs);
    await page.mouse.move(target.x * SCALE, target.y * SCALE, { steps: 4 });
    await sleep(320);
    await demo("press");
    await page.mouse.down();
    await sleep(70);
    await page.mouse.up();
  };
  const parkPointer = () => page.mouse.move(6 * SCALE, 400 * SCALE);

  // --- is the explorer page usable? (decided before the recording starts) ----------------------------
  if (EXPLORER_URL) {
    const probe = await context.newPage();
    try {
      const started = Date.now();
      await probe.goto(EXPLORER_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
      while (Date.now() - started < 10_000) {
        if (/priority infeasible/i.test(await probe.evaluate(() => document.body?.innerText ?? ""))) {
          explorerUsed = true;
          break;
        }
        await sleep(400);
      }
      explorerNote = explorerUsed
        ? "used"
        : `skipped: the explorer page did not show the failure within 10 s (page title: "${(await probe.title()).slice(0, 60)}")`;
    } catch (error) {
      explorerNote = `skipped: ${String(error.message).split("\n")[0]}`;
    }
    await probe.close();
  }
  console.log(`record-demo: explorer step ${explorerNote}`);

  // --- load ------------------------------------------------------------------------------------------
  await page.goto(base, { waitUntil: "networkidle" });
  await waitFor("body", /In-tab live/i, 10_000, "the console to be live");
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(installOverlay);
  await parkPointer();
  await demo("cursor", 800, 430, 0, false);

  cdp.on("Page.screencastFrame", (frame) => {
    recorder.onFrame(Buffer.from(frame.data, "base64"));
    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: CSS_W * SCALE, maxHeight: CSS_H * SCALE, everyNthFrame: 1 });
  for (let i = 0; i < 50 && !recorder.frame; i += 1) await sleep(100);
  await sleep(400);
  recorder.resume();

  // --- 1. hero ---------------------------------------------------------------------------------------
  await sleep(500);
  await caption("hero");
  await demo("scrollTo", 128, 1000); // lifts the button clear of the caption
  await sleep(3300);
  await caption("oneClick");
  const runButton = await centerOf("button", "Run the live scenario from the hero");
  if (!runButton) throw new Error("record-demo: the hero button is not on the page");
  await demo("cursor", 800, 430, 0, true);
  await sleep(350);
  await pointAndClick(runButton, 900);
  const clicked = Date.now();
  const at = (ms) => sleep(Math.max(0, clicked + ms - Date.now()));

  // --- 2. the purchase -------------------------------------------------------------------------------
  await at(200);
  await demo("hideNav", true);
  await demo("hideCursor");
  await caption("urgent");
  // The page scrolls itself to #console; when that settles, bring the queue and the ticket into view.
  let lastY = -1;
  for (let i = 0; i < 30; i += 1) {
    const y = await page.evaluate(() => window.scrollY);
    if (y > 600 && y === lastY) break;
    lastY = y;
    await sleep(70);
  }
  await parkPointer();
  await scrollToEl(".console-grid", -24, 650); // the receipt's last line must clear the caption
  await waitFor("#console", /Board brief: checkout incident/, 10_000, "Kestrel's urgent job");
  await waitFor("#priority-ticket", /Last purchase/i, 15_000, "the purchase");
  await waitFor("#priority-ticket", /\+0\.00504 NEAR[\s\S]*\+0\.00696 NEAR[\s\S]*\+0\.00432 NEAR[\s\S]*\+0\.00372 NEAR/, 5_000, "the four payments");
  await at(6500);
  await caption("paid");
  await ring("#priority-ticket .displaced-block");
  await at(12_300);
  await caption("first");
  await ring(".queue-list > *");
  await waitFor("#priority-ticket .ticket-job-line", /delivered/i, 30_000, "Kestrel's delivery");
  await sleep(900);

  // --- 4. the four displaced jobs, at x4 -------------------------------------------------------------
  await ring(null);
  await caption("displaced");
  await demo("badge", `▶▶ ×${FAST}`);
  await sleep(220);
  recorder.setSpeed(FAST);
  await waitFor("#priority-ticket", /4 of 4 crossed promises kept/, 120_000, "4 of 4 crossed promises kept");
  await sleep(500);
  recorder.setSpeed(1);
  await demo("badge", "");
  await ring("#priority-ticket .quote-reason");
  await sleep(3000);

  // --- 3. the artifact (it stays on screen only once the worker is idle) ------------------------------
  await ring(null);
  await caption("artifact");
  await scrollToEl(".artifact-card", 574, 1000, "bottom");
  await ring(".artifact-hash");
  await sleep(4300);

  // --- 5. a displaced agent withdraws ----------------------------------------------------------------
  await ring(null);
  await caption("withdraw");
  await scrollToEl(".credits-panel", 10, 850);
  const withdraw = await centerOf("button", "^Withdraw .* for Mira");
  if (!withdraw) throw new Error("record-demo: Mira has no credit to withdraw");
  await demo("cursor", 900, 470, 0, true);
  await sleep(350);
  await pointAndClick(withdraw, 800);
  await waitFor(".credits-panel", /claimed/i, 5_000, "Mira's withdrawal");
  await parkPointer();
  await page.evaluate(() => {
    const notes = [...document.querySelectorAll(".credits-panel *")].filter((el) => /claimed/i.test(el.textContent) && !el.querySelector("ul"));
    window.__demo.ring(notes.find((el) => el.children.length === 0 || !/Total held/i.test(el.textContent)) ?? null);
  });
  await sleep(500);
  await demo("hideCursor");
  await sleep(2400);

  // --- 6. the season on testnet ----------------------------------------------------------------------
  await ring(null);
  await caption("season");
  await scrollToEl("#season .section-heading", 22, 1500);
  await page.waitForSelector("#season .season-stats", { timeout: 20_000 }).catch(() => {});
  await ring("#season .season-row-featured");
  await sleep(4600);
  await ring(null);
  await scrollToEl("#season .season-grid", 14, 900);
  await ring("#season .season-stats");
  await sleep(3900);

  // --- 7. the refusal --------------------------------------------------------------------------------
  await ring(null);
  let onExplorer = false;
  if (explorerUsed) {
    recorder.pause();
    try {
      await page.goto(EXPLORER_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await waitFor("body", /priority infeasible/i, 10_000, "the failed transaction on the explorer");
      await page.evaluate(installOverlay);
      await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (/priority infeasible/i.test(node.nodeValue) && !node.parentElement.closest("#demo-overlay")) {
            node.parentElement.scrollIntoView({ block: "center" });
            window.__demo.ring(node.parentElement);
            break;
          }
        }
      });
      await demo("caption", CAPTIONS.refusal);
      await sleep(900);
      onExplorer = true;
    } catch (error) {
      explorerUsed = false;
      explorerNote = `skipped during the recording: ${String(error.message).split("\n")[0]}`;
      await page.goto(base, { waitUntil: "networkidle" });
      await page.evaluate(installOverlay);
      await demo("hideNav", true);
      await page.waitForSelector("#season .season-episode", { timeout: 20_000 });
      await demo("caption", CAPTIONS.season);
      await page.evaluate(() => window.scrollTo(0, document.querySelector("#season .season-grid").getBoundingClientRect().top + window.scrollY - 14));
      await sleep(900);
    }
    recorder.resume();
    if (onExplorer) captionLog.push({ at: recorder.now(), text: CAPTIONS.refusal });
  }
  if (onExplorer) {
    await sleep(6500);
  } else {
    await caption("refusal");
    await scrollToEl("#season .season-episode", 436, 850);
    await ring("#season li.is-refused", "displaced job");
    await sleep(2700);
    await ring("#season .season-episode");
    await sleep(3600);
  }

  // --- 8. end card -----------------------------------------------------------------------------------
  await ring(null);
  await caption(null);
  await demo("endCard", END_CARD);
  await sleep(5600);

  await cdp.send("Page.stopScreencast").catch(() => {});
  duration = await recorder.finish();
  if (pageErrors.length) console.warn(`record-demo: page errors during the recording: ${pageErrors.slice(0, 3).join(" | ")}`);
} catch (error) {
  recorder.ff.child.kill("SIGKILL");
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
  console.error(String(error.stack ?? error));
  process.exit(1);
}
await browser.close();
server.close();

// ---------------------------------------------------------------------------------------------------------
// One encode: H.264 yuv420p, 30 fps, faststart, plus a silent AAC track so players and X accept the file.
mkdirSync(path.dirname(OUT), { recursive: true });
try {
  await run(FFMPEG, [
    "-y", "-loglevel", "error",
    "-i", rawFile,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-vf", `scale=${CSS_W * SCALE}:${CSS_H * SCALE}:flags=lanczos:in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p`,
    "-r", String(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-profile:v", "high", "-g", String(FPS * 2),
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", "64k", "-shortest", "-movflags", "+faststart",
    OUT,
  ]).done;
} finally {
  rmSync(work, { recursive: true, force: true });
}

const stamp = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
console.log(`record-demo: ${path.relative(ROOT, OUT)} · ${duration.toFixed(1)} s · ${(statSync(OUT).size / 1e6).toFixed(1)} MB · ${recorder.received} frames captured`);
console.log(`record-demo: explorer step ${explorerNote}`);
for (const entry of captionLog) console.log(`  ${stamp(entry.at)}  ${entry.text}`);
console.log(`  ${stamp(Math.max(0, duration - 5.6))}  [end card]`);
if (process.env.QUEUE_DEMO_STATS) console.log(`record-demo: new frames in each second of video (of ${FPS}): ${recorder.perSecond.join(" ")}`);
