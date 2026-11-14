#!/usr/bin/env node
// Build the hosted console: a static site with no backend.
//
//   npm run build:pages        -> apps/web/dist-pages/
//
// The console runs the ledger engine (packages/ledger) in the browser tab, and reads the two public proof
// payloads from static JSON written here by the same functions that serve GET /api/onchain and GET /api/season.
// The season section reads the live queue straight from NEAR testnet RPC, as it does locally.
// Nothing is published by this script; serve the folder with any static host (GitHub Pages: .github/workflows/pages.yml).
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.mjs";
import { readOnchainPayload, readSeasonPayload } from "../apps/server/src/public-data.ts";

const OUT = path.join(ROOT, "apps/web/dist-pages");
rmSync(OUT, { recursive: true, force: true });

const env = { ...process.env, VITE_QUEUE_BACKEND: "browser" };
for (const [cmd, args] of [
  ["npm", ["-w", "@queue/web", "run", "typecheck"]],
  ["npx", ["-w", "@queue/web", "vite", "build"]],
]) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`build-pages: ${cmd} ${args.join(" ")} failed`);
    process.exit(r.status ?? 1);
  }
}

const onchain = readOnchainPayload(ROOT);
const season = readSeasonPayload(ROOT);
if (onchain.deployed !== true || season.deployed !== true || !season.run) {
  console.error("build-pages: data/onchain-proof.json or data/season is missing; the hosted proof sections would be empty");
  process.exit(1);
}
mkdirSync(path.join(OUT, "static"), { recursive: true });
writeFileSync(path.join(OUT, "static/onchain.json"), JSON.stringify(onchain));
writeFileSync(path.join(OUT, "static/season.json"), JSON.stringify(season));
// GitHub Pages runs Jekyll unless told not to; Jekyll drops files it does not understand.
writeFileSync(path.join(OUT, ".nojekyll"), "");
console.log(`build-pages: wrote ${path.relative(ROOT, OUT)} (static/onchain.json, static/season.json)`);
