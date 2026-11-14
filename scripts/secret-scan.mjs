#!/usr/bin/env node
/**
 * Scan the public project tree for key material.
 *
 * The project has no git history at submission time, so this walks the working
 * tree directly. Runtime state (`.env`, `.testnet/`, SQLite files), build
 * output and dependencies are never scanned: they are not public artifacts.
 *
 * Exit codes: 0 = clean, 1 = suspicious material found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".testnet",
  ".playwright",
  "dist",
  "target",
  "coverage",
  "build",
]);

/** Files whose *names* mark them as private or generated. */
function skipFile(name) {
  const isPrivateEnv =
    name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
  return (
    isPrivateEnv ||
    name === "queue.db" ||
    name.startsWith("queue.db-") ||
    name.endsWith(".log") ||
    name.endsWith(".db") ||
    name.endsWith(".db-shm") ||
    name.endsWith(".db-wal")
  );
}

/**
 * Rules are precise enough to pass `.env.example` (empty assignments) and
 * source code that merely names the field. A public NEAR key is `ed25519:` +
 * 43–44 base58 chars; secret keys are exported as 64-byte base58 (88 chars),
 * and the brief also treats `ed25519:` + 64 hex as a leak.
 */
const RULES = [
  {
    name: "secretKey value",
    pattern: /"?secret_?key"?\s*[:=]\s*["'][^"']{8,}["']/i,
  },
  {
    name: "PRIVATE_KEY value",
    pattern: /PRIVATE_KEY\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{16,}/,
  },
  { name: "ed25519 private key (hex)", pattern: /ed25519:[0-9a-fA-F]{64}(?![0-9a-fA-F])/ },
  { name: "ed25519 private key (base58)", pattern: /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/ },
  // NEAR AI / OpenAI-style API keys, an assigned NEAR_AI_API_KEY, and bearer tokens copied from logs.
  { name: "API key (sk-…)", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "NEAR_AI_API_KEY value", pattern: /NEAR_AI_API_KEY\s*[=:]\s*["']?[A-Za-z0-9_-]{8,}/ },
  { name: "Bearer token", pattern: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  // A NEAR secret key exported without its `ed25519:` prefix (64 bytes in base58 is 86-88 chars).
  { name: "bare base58 secret key", pattern: /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{86,88}(?![A-Za-z0-9])/ },
];

const SENSITIVE_KEY = /secret|private|seed/i;

const findings = [];
let scanned = 0;

/**
 * The real secrets on this machine, if any: values of key/token variables in the local `.env` (never scanned,
 * never published). Any public file that contains one of them exactly is a leak, whatever its format, so a key
 * that matches no pattern above (e.g. a NEAR AI key without an `sk-` prefix) is still caught. Only the variable
 * name is ever reported, never the value.
 */
const LOCAL_SECRETS = (() => {
  try {
    const text = readFileSync(path.join(ROOT, ".env"), "utf8");
    return text
      .split("\n")
      .map((l) => l.match(/^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*["']?([^"'\s#]+)/))
      .filter((m) => m && m[2].length >= 16)
      .map((m) => ({ name: m[1], value: m[2] }));
  } catch {
    return [];
  }
})();
// Plus every secret key stored under .testnet/ (account key files), reported by file name only.
(function collectTestnetKeys(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectTestnetKeys(full);
    else if (e.name.endsWith(".json")) {
      try {
        const j = JSON.parse(readFileSync(full, "utf8"));
        const v = j.secretKey ?? j.private_key ?? j.secret_key;
        if (typeof v === "string" && v.length >= 32) LOCAL_SECRETS.push({ name: `.testnet/${path.relative(path.join(ROOT, ".testnet"), full)}`, value: v.replace(/^ed25519:/, "") });
      } catch {
        /* not a key file */
      }
    }
  }
})(path.join(ROOT, ".testnet"));

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

function scanFile(file) {
  if (file === SELF) return; // the scanner contains its own patterns
  if (LOCAL_SECRETS.length) {
    const raw = readFileSync(file, "utf8");
    for (const secret of LOCAL_SECRETS) {
      if (raw.includes(secret.value)) {
        findings.push({ file: path.relative(ROOT, file), line: 0, rule: `value of ${secret.name} from the local .env`, excerpt: "(value not shown)" });
      }
    }
  }
  const buffer = readFileSync(file);
  if (looksBinary(buffer)) return;
  scanned += 1;
  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      findings.push({
        file: path.relative(ROOT, file),
        line: index + 1,
        rule: rule.name,
        excerpt: line.length > 120 ? `${line.slice(0, 117)}…` : line,
      });
    }
  }
  if (file.endsWith(".json")) scanJsonKeys(file, buffer.toString("utf8"));
}

/** Only the public deployment metadata is recursed: package manifests use `private`/`seed` legitimately. */
const PUBLIC_METADATA = new Set([
  path.join(ROOT, "data", "deploy.json"),
  path.join(ROOT, "data", "onchain-proof.json"),
]);

/** Season metadata and run configs are public too; there `seed` is the run's RNG seed, not a key. */
const SEASON_METADATA = /^data\/season\/([^/]+\.json|[^/]+\/(config|summary)\.json)$/;

/** Public JSON must never carry a field whose name promises key material. */
function scanJsonKeys(file, text) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const season = SEASON_METADATA.test(rel);
  if (!PUBLIC_METADATA.has(file) && !season) return;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const visit = (node, at) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (SENSITIVE_KEY.test(key) && !(season && key === "seed")) {
        findings.push({
          file: path.relative(ROOT, file),
          line: 0,
          rule: "sensitive JSON field",
          excerpt: `${at}.${key}`,
        });
      }
      visit(child, `${at}.${key}`);
    }
  };
  visit(parsed, path.relative(ROOT, file));
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (skipFile(entry.name)) continue;
    const relative = path.relative(ROOT, full);
    if (relative.startsWith(`data${path.sep}`) && entry.name.startsWith("queue.db")) continue;
    if (!statSync(full).isFile()) continue;
    scanFile(full);
  }
}

walk(ROOT);

if (findings.length > 0) {
  console.error(`secret-scan: ${findings.length} suspicious line(s) in public files:`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} [${finding.rule}] ${finding.excerpt}`);
  }
  process.exit(1);
}

console.log(`secret-scan: clean (${scanned} public files scanned)`);
