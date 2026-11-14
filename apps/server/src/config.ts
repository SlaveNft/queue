import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, "../../..");

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export interface BindPolicyInput {
  nodeEnv: string;
  host: string;
  operatorToken: string;
  readOnly: boolean;
}

/**
 * A publicly reachable write API without a token lets any visitor reset the
 * demo or drain credits. Production therefore refuses this combination.
 * Read-only mode has no mutations to guard, so it is allowed token-free.
 */
export function unsafeBindReason(input: BindPolicyInput): string | null {
  if (input.nodeEnv !== "production") return null;
  if (isLoopback(input.host)) return null;
  if (input.readOnly) return null;
  if (input.operatorToken.trim().length > 0) return null;
  return (
    `Refusing to bind ${input.host} in production without QUEUE_OPERATOR_TOKEN. ` +
    "Set the token, bind 127.0.0.1, or set QUEUE_READ_ONLY=1."
  );
}

const port = numberFromEnv("QUEUE_PORT", 8789);
const host = process.env.QUEUE_HOST || "127.0.0.1";
const nodeEnv = process.env.NODE_ENV || "development";
const operatorToken = process.env.QUEUE_OPERATOR_TOKEN || "";
const readOnly = process.env.QUEUE_READ_ONLY === "1";

const bindError = unsafeBindReason({ nodeEnv, host, operatorToken, readOnly });
// `node --test` sets NODE_TEST_CONTEXT; a test harness must not kill the process.
const underTest = Boolean(process.env.NODE_TEST_CONTEXT);
if (bindError && !underTest) {
  console.error(JSON.stringify({ level: "error", event: "unsafe_bind", message: bindError }));
  process.exit(1);
}
if (nodeEnv === "production" && !isLoopback(host) && readOnly) {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "read_only_bind",
      message: `Serving the read-only console on ${host}. Mutations are disabled.`,
    }),
  );
}

export const config = {
  port,
  // Local by default; containers opt in to 0.0.0.0 (see Dockerfile).
  host,
  nodeEnv,
  dbPath:
    process.env.QUEUE_DB_PATH || path.join(PROJECT_ROOT, "data", "queue.db"),
  webOrigin: process.env.QUEUE_WEB_ORIGIN || "",
  operatorToken,
  version: process.env.QUEUE_VERSION || "1.0.0",
  build: process.env.QUEUE_BUILD || "dev",
  logLevel: process.env.QUEUE_LOG_LEVEL || "info",
  readOnly,
} as const;

export { LIMITS } from "@queue/ledger";
