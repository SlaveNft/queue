// QUEUE client: read the v3 contract with no keys; act on it with an account key.
//
//   import { QueueClient } from "@queue/client";
//   const q = new QueueClient();                                   // read-only, market5 on testnet
//   const w = new QueueClient({ accountId, secretKey });           // can act (prefer a function-call key)
//
// A function-call key for the contract cannot attach NEAR, so it can only spend the balance the account deposited
// with `deposit()` (from a full-access key). That is the recommended way to let an agent act.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";

export const DEFAULT_CONTRACT = "market5.queue-demo.testnet";
export const DEFAULT_RPC = "https://rpc.testnet.fastnear.com";
const YOCTO = 10n ** 24n;
const TGAS = 10n ** 12n;

/** "0.01" NEAR -> yocto (exact decimal parsing, no floats). */
export function toYocto(near) {
  const [whole, frac = ""] = String(near).trim().split(".");
  if (!/^\d+$/.test(whole || "0") || !/^\d*$/.test(frac) || frac.length > 24) throw new Error(`not a NEAR amount: ${near}`);
  return BigInt(whole || "0") * YOCTO + BigInt((frac + "0".repeat(24)).slice(0, 24));
}

/** yocto -> "0.0123" NEAR (trimmed). */
export function fromYocto(yocto, digits = 6) {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export class QueueClient {
  constructor({ contractId = DEFAULT_CONTRACT, rpcUrl = DEFAULT_RPC, accountId, secretKey, fetchImpl = fetch } = {}) {
    this.contractId = contractId;
    this.rpcUrl = rpcUrl;
    this.accountId = accountId ?? null;
    this.fetch = fetchImpl;
    this.account = accountId && secretKey ? new Account(accountId, new JsonRpcProvider({ url: rpcUrl }), new KeyPairSigner(KeyPair.fromString(secretKey))) : null;
  }

  get canAct() {
    return this.account != null;
  }

  async rpc(method, params) {
    const r = await this.fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await r.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 240)}`);
    return body.result;
  }

  async view(method, args = {}) {
    const result = await this.rpc("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: this.contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (result?.error) throw new Error(`${method}: ${result.error}`);
    return JSON.parse(Buffer.from(result.result).toString());
  }

  /** Chain time in seconds (latest block). Deadlines and cutoffs are in chain time. */
  async now() {
    const b = await this.rpc("block", { finality: "optimistic" });
    return Math.floor(Number(BigInt(b.header.timestamp) / 1_000_000_000n));
  }

  // -- reads (no key) ------------------------------------------------------
  config() { return this.view("get_config"); }
  queue() { return this.view("get_queue"); }
  job(jobId) { return this.view("get_job", { job_id: Number(jobId) }); }
  stats() { return this.view("get_stats"); }
  credit(accountId = this.accountId) { return this.view("get_credit", { account_id: accountId }); }
  proposals() { return this.view("get_proposals"); }
  storageDeposits() { return this.view("get_storage_deposits"); }
  /** What it costs to start by `latestStartAt` (chain seconds): slot, jobs passed, each one's payment, refusal reason. */
  quote(jobId, latestStartAt) { return this.view("get_quote", { job_id: Number(jobId), latest_start_at: Number(latestStartAt) }); }
  /** Where a job of this size would finish if submitted now: at the front (bought) and at the back (FIFO). */
  admission(durationSecs, deadlineSecs) { return this.view("get_admission", { duration_secs: Number(durationSecs), deadline_secs: Number(deadlineSecs) }); }

  // -- writes (need a key) -------------------------------------------------
  async call(method, args, { gasTgas = 60n, deposit = 0n } = {}) {
    if (!this.account) throw new Error("no key: set QUEUE_ACCOUNT_ID and QUEUE_PRIVATE_KEY to act");
    let outcome;
    try {
      outcome = await this.account.callFunctionRaw({ contractId: this.contractId, methodName: method, args, gas: BigInt(gasTgas) * TGAS, deposit: BigInt(deposit), waitUntil: "FINAL" });
    } catch (e) {
      // near-api-js throws when the contract refuses; the refusal is an answer, not a crash. Anything that never
      // reached the contract (bad key, no gas money, network) comes back the same way, with no tx.
      if (!e?.transactionResult) return { ok: false, tx: null, error: String(e?.panicMessage ?? e?.message ?? e).slice(0, 300) };
      outcome = e.transactionResult;
    }
    const failure = [outcome.status, ...(outcome.receipts_outcome ?? []).map((r) => r.outcome?.status)].find((s) => s && typeof s === "object" && "Failure" in s);
    const tx = outcome.transaction?.hash;
    if (failure) {
      const text = JSON.stringify(failure.Failure);
      const m = text.match(/Smart contract panicked: ([^"\\]+)/);
      return { ok: false, tx, error: (m ? m[1] : text).slice(0, 300) };
    }
    const sv = outcome.status?.SuccessValue;
    const events = (outcome.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? []).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => {
      try { return JSON.parse(l.slice(11)); } catch { return null; }
    }).filter(Boolean);
    return { ok: true, tx, result: sv ? JSON.parse(Buffer.from(sv, "base64").toString()) : null, events };
  }

  /** Full-access key only: move NEAR into the account's balance in the contract. */
  deposit(near) { return this.call("deposit", {}, { gasTgas: 30n, deposit: toYocto(near) }); }

  /**
   * Submit a job, paid from the balance. `priority` buys a slot in the same transaction:
   * `{ latestStartAt?: number, maxSpendNear: string, required?: boolean }` (without `latestStartAt` it buys only if
   * the job's own deadline needs it).
   */
  submit({ title, inputHash, inputUri = "", durationSecs, deadlineSecs, rewardNear = "0.002", bondNear = "0.001", askPerSecNear = "0", verify = null, priority = null }) {
    return this.call("submit_job", {
      title, input_hash: inputHash, input_uri: inputUri, duration_secs: Number(durationSecs), deadline_secs: Number(deadlineSecs),
      reward: toYocto(rewardNear).toString(), ask_per_sec: toYocto(askPerSecNear).toString(), bond: toYocto(bondNear).toString(),
      require_feasible_at_back: null, verify,
      priority: priority ? { latest_start_at: priority.latestStartAt ?? null, max_spend: toYocto(priority.maxSpendNear).toString(), required: priority.required ?? null } : null,
    });
  }
  setAsk(jobId, askPerSecNear) { return this.call("set_move_ask", { job_id: Number(jobId), ask_per_sec: toYocto(askPerSecNear).toString() }, { gasTgas: 15n }); }
  buy(jobId, latestStartAt, maxSpendNear) { return this.call("request_priority", { job_id: Number(jobId), latest_start_at: Number(latestStartAt), max_spend: toYocto(maxSpendNear).toString() }); }
  cancel(jobId) { return this.call("cancel_job", { job_id: Number(jobId) }, { gasTgas: 30n }); }
  release(jobId) { return this.call("release_job", { job_id: Number(jobId) }, { gasTgas: 30n }); }
  withdraw() { return this.call("withdraw_credit", {}, { gasTgas: 30n }); }
}

/** A client from the environment: QUEUE_CONTRACT, QUEUE_RPC_URL, QUEUE_ACCOUNT_ID, QUEUE_PRIVATE_KEY. */
export function clientFromEnv(env = process.env) {
  return new QueueClient({ contractId: env.QUEUE_CONTRACT || DEFAULT_CONTRACT, rpcUrl: env.QUEUE_RPC_URL || DEFAULT_RPC, accountId: env.QUEUE_ACCOUNT_ID, secretKey: env.QUEUE_PRIVATE_KEY });
}
