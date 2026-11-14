// Read-only NEAR testnet RPC for the verifiers. No dependencies beyond Node.
//
// Two pools, because public RPC nodes differ in what they keep:
//  - VIEW_RPCS answer current state (views, account, code hash). Any node will do.
//  - TX_RPCS answer old transactions. A regular node forgets a transaction after about two
//    days (garbage collection), so transaction lookups go to archival nodes only.
// Free tiers rate-limit, so every call rotates across its pool, waits between requests to the
// same host, and backs off (honouring Retry-After) on HTTP 429 / 5xx and RPC timeouts.
//
// Override with QUEUE_RPC_URLS / QUEUE_ARCHIVAL_RPC_URLS (comma-separated). QUEUE_RPC_URL (one
// URL) is still honoured for views.

const list = (value) => String(value ?? "").split(",").map((u) => u.trim()).filter(Boolean);

export const VIEW_RPCS = list(process.env.QUEUE_RPC_URLS || process.env.QUEUE_RPC_URL ||
  "https://rpc.testnet.fastnear.com,https://archival-rpc.testnet.near.org,https://archival-rpc.testnet.fastnear.com");
export const TX_RPCS = list(process.env.QUEUE_ARCHIVAL_RPC_URLS ||
  "https://archival-rpc.testnet.fastnear.com,https://archival-rpc.testnet.near.org");

export class Unreachable extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN_GAP_MS = Number(process.env.QUEUE_RPC_MIN_GAP_MS ?? 120);
const lastCall = new Map();
const cursor = new Map();

async function pace(url) {
  const host = new URL(url).host;
  const wait = (lastCall.get(host) ?? 0) + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(host, Date.now());
}

/** Errors worth another node or another try: rate limits, timeouts, a node that has not seen the tx. */
function retryable(error) {
  const text = JSON.stringify(error ?? "");
  return /429|rate.?limit|too many|TIMEOUT_ERROR|Timeout|UNKNOWN_TRANSACTION|doesn't exist|GARBAGE_COLLECTED|NO_SYNCED_BLOCKS|upgrade to paid|free plan/i.test(text);
}

/**
 * One JSON-RPC call over a pool. Returns { result } or { error } for a definite answer (a panic in a
 * view, a contract error). Throws Unreachable only when every node failed for transport reasons.
 */
export async function call(pool, method, params, { tries = 8, timeoutMs = 20_000 } = {}) {
  const key = pool.join(",");
  let start = cursor.get(key) ?? 0;
  let last = "";
  let lastError = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const url = pool[(start + attempt) % pool.length];
    await pace(url);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        last = `${url}: HTTP ${response.status}`;
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, 600 * 2 ** Math.floor(attempt / pool.length)) + Math.random() * 300);
        continue;
      }
      const body = await response.json();
      if (body.error) {
        if (retryable(body.error)) {
          last = `${url}: ${JSON.stringify(body.error).slice(0, 160)}`;
          lastError = body.error;
          await sleep(300 + Math.random() * 200);
          continue;
        }
        cursor.set(key, (start + attempt) % pool.length);
        return { error: body.error };
      }
      cursor.set(key, (start + attempt) % pool.length);
      return { result: body.result };
    } catch (error) {
      last = `${url}: ${error?.message ?? error}`;
      await sleep(Math.min(8000, 600 * 2 ** Math.floor(attempt / pool.length)));
    }
  }
  // Every node answered, and every answer was "not found": that is a definite answer, not an outage.
  if (lastError && /UNKNOWN_TRANSACTION|doesn't exist/i.test(JSON.stringify(lastError))) return { error: lastError };
  throw new Unreachable(last || "no RPC answered");
}

/** A contract view at final finality. Throws on a panic or a missing result. */
export async function view(contractId, method, args = {}, pool = VIEW_RPCS) {
  const { result, error } = await call(pool, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (error || !result?.result) throw new Error(`${method}: ${JSON.stringify(error ?? result?.error ?? result).slice(0, 200)}`);
  return JSON.parse(Buffer.from(result.result).toString());
}

/**
 * A transaction's outcome from an archival node. `wait_until: "NONE"` returns at once for an executed
 * transaction (waiting for FINAL on a node that never saw it only ends in a timeout).
 */
export async function txOutcome(hash, signer) {
  const { result, error } = await call(TX_RPCS, "tx", { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" });
  if (error || !result?.transaction) return { found: false, error: JSON.stringify(error ?? "no transaction").slice(0, 160) };
  const statuses = [result.status, ...(result.receipts_outcome ?? []).map((r) => r.outcome.status)];
  const failure = statuses.find((status) => status && typeof status === "object" && "Failure" in status);
  const action = result.transaction.actions?.[0];
  const sv = result.receipts_outcome?.[0]?.outcome?.status?.SuccessValue ?? result.status?.SuccessValue;
  let returned = null;
  if (sv) {
    try {
      returned = JSON.parse(Buffer.from(sv, "base64").toString());
    } catch {
      returned = null;
    }
  }
  return {
    found: true,
    raw: result,
    signer: result.transaction.signer_id,
    receiver: result.transaction.receiver_id,
    method: action?.FunctionCall?.method_name ?? (typeof action === "string" ? action : Object.keys(action ?? {})[0]),
    failure: failure ? JSON.stringify(failure.Failure) : null,
    returned,
  };
}
