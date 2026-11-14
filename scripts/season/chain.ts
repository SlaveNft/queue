// @ts-nocheck — lib.mjs is untyped JS shared with the deploy/proof scripts.
/**
 * One interface, two backends:
 *  - NearChain: the v2 contract on NEAR testnet. Agents sign with their own function-call keys
 *    (no attached deposit; they spend the balance they deposited), the operator with its key.
 *  - SimChain: the same rules in memory with a virtual clock, for offline runs and tests.
 * Every action returns { ok, tx?, error? } instead of throwing, because a refusal is data.
 */
import { KeyPair, KeyPairSigner, actions, createTransaction, baseDecode, baseEncode } from "near-api-js";
import { TGAS } from "../lib.mjs";

/** Public testnet RPCs, tried in order. The free tiers rate-limit (HTTP 429), so we rotate and back off. */
export const RPCS = (process.env.QUEUE_RPC_URLS || "https://near-testnet.drpc.org,https://rpc.testnet.fastnear.com,https://archival-rpc.testnet.fastnear.com,https://test.rpc.fastnear.com")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let rpcIndex = 0;

/** JSON-RPC with rotation across RPCS and backoff on 429 / network errors. */
export async function rpc(method: string, params: unknown, tries = 10): Promise<any> {
  let last = "";
  // Round-robin: spread reads over every provider instead of exhausting one.
  const start = rpcIndex;
  rpcIndex = (rpcIndex + 1) % RPCS.length;
  for (let i = 0; i < tries; i += 1) {
    const url = RPCS[(start + i) % RPCS.length];
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 429 || r.status >= 500) {
        last = `${url} HTTP ${r.status}`;
        rpcIndex = (rpcIndex + 1) % RPCS.length;
        await sleep(400 * (i + 1));
        continue;
      }
      const j = await r.json();
      if (j.error) {
        const text = JSON.stringify(j.error);
        if (/429|rate limit|too many|timeout|upgrade to paid|free plan/i.test(text)) {
          last = text;
          rpcIndex = (rpcIndex + 1) % RPCS.length;
          await sleep(400 * (i + 1));
          continue;
        }
        throw new Error(text.slice(0, 300));
      }
      return j.result;
    } catch (e) {
      if (String(e).includes("{")) throw e;
      last = String((e as Error).message ?? e);
      rpcIndex = (rpcIndex + 1) % RPCS.length;
      await sleep(400 * (i + 1));
    }
  }
  throw new Error(`RPC unavailable after ${tries} tries: ${last.slice(0, 200)}`);
}

export async function view<T = any>(contractId: string, method: string, args: object = {}): Promise<T> {
  // Optimistic: transactions are awaited at EXECUTED_OPTIMISTIC, so views must not lag behind them.
  const res = await rpc("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  // A view that panics comes back as { error } inside a successful RPC result.
  if (!res?.result) throw new Error(`${method}: ${String(res?.error ?? "no result").slice(0, 200)}`);
  return JSON.parse(Buffer.from(res.result).toString());
}

/**
 * A signer that keeps its own nonce. Public RPCs behind load balancers lag by a block or two, so a nonce read
 * after our own transaction can be stale (InvalidNonce). We read the access key once with optimistic finality and
 * then only ever count up; on InvalidNonce we jump to the nonce the node reports.
 */
class Signer {
  private nonce: bigint | null = null;
  readonly signer: KeyPairSigner;
  readonly publicKey;
  constructor(readonly accountId: string, secret: string) {
    const kp = KeyPair.fromString(secret);
    this.signer = new KeyPairSigner(kp);
    this.publicKey = kp.getPublicKey();
  }
  async sign(receiverId: string, acts: unknown[]) {
    if (this.nonce === null) {
      const ak = await rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: this.accountId, public_key: this.publicKey.toString() });
      this.nonce = BigInt(ak.nonce);
    }
    this.nonce += 1n;
    const block = await rpc("block", { finality: "final" });
    const tx = createTransaction(this.accountId, this.publicKey, receiverId, this.nonce, acts as never, baseDecode(block.header.hash));
    const { signedTransaction, txHash } = await this.signer.signTransaction(tx);
    return { signed: signedTransaction, hash: baseEncode(txHash) };
  }
  bump(akNonce: bigint) {
    if (this.nonce === null || this.nonce < akNonce) this.nonce = akNonce;
  }
}
const account = (id: string, secret: string) => new Signer(id, secret);

export type Status = "QUEUED" | "RUNNING" | "DONE" | "MISSED" | "CANCELLED" | "FAILED" | "REJECTED";

export interface ChainJob {
  id: number;
  owner: string;
  title: string;
  input_hash: string;
  input_uri: string;
  duration_secs: number;
  deadline_at: number;
  submitted_at: number;
  reward: string;
  bond: string;
  ask_per_sec: string;
  status: Status;
  expedited: boolean;
  moved_compensation: string;
  priority_spend: string;
  started_at?: number | null;
  finished_at?: number | null;
  artifact_hash?: string | null;
  attested?: boolean;
  /** v3: "model" jobs settle only with the model's verified signature; "operator" jobs on the operator's word. */
  verify?: "model" | "operator";
  /** v3: a raised ask waiting for `ask_effective_at` (absent once in force). */
  ask_pending?: string | null;
  ask_effective_at?: number;
  position: number;
  projected_start_at: number;
  projected_finish_at: number;
}

export interface Displaced {
  job_id: number;
  owner: string;
  amount: string;
  delay_secs: number;
  new_finish_at: number;
  deadline_at: number;
  slack_secs: number;
}

export interface Quote {
  job_id: number;
  now: number;
  insert_index: number;
  projected_start_at: number;
  projected_finish_at: number;
  compensation: string;
  fee: string;
  total: string;
  displaced: Displaced[];
  feasible: boolean;
  reason: string;
}

export interface TxResult {
  ok: boolean;
  tx?: string;
  error?: string;
  /** No outcome could be read (RPC trouble): the transaction may or may not have landed. Not a contract refusal. */
  unknown?: boolean;
  /** The RPC rejected the transaction before execution (e.g. allowance, expired). Not a contract refusal. */
  rejected?: boolean;
  result?: unknown;
  events?: Array<{ event: string; data: Record<string, unknown> }>;
}

export interface SubmitArgs {
  title: string;
  input_hash: string;
  input_uri: string;
  duration_secs: number;
  deadline_secs: number;
  reward: bigint;
  bond: bigint;
  ask_per_sec: bigint;
}

export interface StorageDeposits {
  job: bigint;
  priorityBase: bigint;
  priorityPerDisplaced: bigint;
}

export interface Chain {
  kind: "testnet" | "sim";
  /** Contract rules: "v2" (market4) or "v3" (stake, verify policy, reject/release, timelock). */
  rules: "v2" | "v3";
  now(): Promise<number>;
  queue(): Promise<ChainJob[]>;
  job(id: number): Promise<ChainJob>;
  quote(jobId: number, latestStartAt: number): Promise<Quote>;
  credit(accountId: string): Promise<bigint>;
  stats(): Promise<Record<string, unknown>>;
  deposits(): Promise<StorageDeposits>;
  submit(agent: string, a: SubmitArgs): Promise<TxResult & { jobId?: number }>;
  setAsk(agent: string, jobId: number, ask: bigint): Promise<TxResult>;
  buy(agent: string, jobId: number, latestStartAt: number, maxSpend: bigint): Promise<TxResult>;
  cancel(agent: string, jobId: number): Promise<TxResult>;
  withdraw(agent: string): Promise<TxResult>;
  startNext(): Promise<TxResult & { jobId?: number }>;
  complete(jobId: number, artifactHash: string): Promise<TxResult>;
  completeAttested(jobId: number, response: string, signature: string, signer: string, model: string | null): Promise<TxResult>;
  claimTimeout(caller: string, jobId: number): Promise<TxResult>;
  /** v3, operator: refuse a queued job before it starts (escrow back to its owner, record released). */
  reject(jobId: number, reason: string): Promise<TxResult>;
  /** Operator: give up on the running job; its owner gets reward + bond back and the operator is paid nothing. */
  fail(jobId: number, reasonHash: string): Promise<TxResult>;
  /** v3, operator: "the worker is up" (new work is refused after OPERATOR_HEARTBEAT_SECS without an operator call). */
  heartbeat(): Promise<TxResult>;
  /** The job the contract is running right now, if any. */
  findRunning(): Promise<ChainJob | null>;
}

// ---------------------------------------------------------------------------
// NEAR testnet
// ---------------------------------------------------------------------------

function panicText(failure: unknown): string {
  const text = JSON.stringify(failure);
  const m = text.match(/Smart contract panicked: ([^"\\]+)/);
  return (m ? m[1] : text).slice(0, 300);
}

export class NearChain implements Chain {
  kind = "testnet" as const;
  /** Set from the contract's config after construction (`timelock_secs` exists only in v3). */
  rules: "v2" | "v3" = "v2";
  private signers = new Map<string, unknown>();
  private queues = new Map<string, Promise<unknown>>();

  /** keys: accountId -> secret key (agents: their function-call key; operator: its own key). */
  constructor(readonly contractId: string, keys: Record<string, string>, readonly operatorId: string) {
    for (const [id, secret] of Object.entries(keys)) this.signers.set(id, account(id, secret));
  }

  /** Serialize transactions per signer so nonces never race. */
  private serial<T>(who: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(who) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(who, next.catch(() => undefined));
    return next;
  }

  private send(who: string, method: string, args: object, gas = 30n): Promise<TxResult> {
    const acc = this.signers.get(who);
    if (!acc) return Promise.resolve({ ok: false, rejected: true, error: `no key loaded for ${who}` });
    return this.serial(who, async () => {
      let outcome;
      let built;
      try {
        built = await acc.sign(this.contractId, [actions.functionCall(method, Buffer.from(JSON.stringify(args)), gas * TGAS, 0n)]);
      } catch (e) {
        return { ok: false, rejected: true, error: `could not build the transaction: ${String(e?.message ?? e).slice(0, 240)}` };
      }
      // Submit without waiting, then ask any RPC in the pool for the result by hash. Resubmitting the same
      // signed bytes is harmless, and a contract refusal comes back as a normal Failure status with its text.
      const lookup = async (hash: string, tries: number) => {
        for (let i = 0; i < tries; i += 1) {
          await sleep(i === 0 ? 1200 : 1000);
          try {
            const r = await rpc("tx", { tx_hash: hash, sender_account_id: acc.accountId, wait_until: "EXECUTED_OPTIMISTIC" }, 3);
            if (r?.transaction) return r;
          } catch {
            /* not known yet */
          }
        }
        return null;
      };
      let b64 = Buffer.from(built.signed.encode()).toString("base64");
      let submitError = "";
      for (let i = 0; i < 3; i += 1) {
        try {
          await rpc("send_tx", { signed_tx_base64: b64, wait_until: "NONE" }, 6);
          submitError = "";
          break;
        } catch (e) {
          submitError = String(e?.message ?? e);
          const m = submitError.match(/"ak_nonce":(\d+)/);
          if (m) {
            // InvalidNonce has two causes: our nonce was stale, or an earlier attempt of THIS transaction already
            // landed (an RPC retry after a timeout). Look for this hash first; re-signing blindly could run the
            // action twice (a second submit or purchase).
            acc.bump(BigInt(m[1]));
            outcome = await lookup(built.hash, 4);
            if (outcome || i > 0) break;
            built = await acc.sign(this.contractId, [actions.functionCall(method, Buffer.from(JSON.stringify(args)), gas * TGAS, 0n)]);
            b64 = Buffer.from(built.signed.encode()).toString("base64");
            continue;
          }
          if (/InvalidTxError|InvalidTransaction|NotEnoughAllowance|NotEnoughBalance|Expired|AccessKeyNotFound|MethodNameMismatch|ReceiverMismatch/.test(submitError)) {
            // The node refused the transaction itself: nothing executed, and waiting for a result is pointless.
            return { ok: false, rejected: true, tx: built.hash, error: `rejected by RPC: ${submitError.slice(0, 220)}` };
          }
        }
      }
      if (!outcome) outcome = await lookup(built.hash, 25);
      if (!outcome) return { ok: false, unknown: true, tx: built.hash, error: `no result for ${built.hash}${submitError ? `: ${submitError.slice(0, 200)}` : ""}` };
      this.invalidate();
      const statuses = [outcome?.status, ...(outcome?.receipts_outcome ?? []).map((r) => r.outcome?.status)];
      // Only the first receipt (the contract call itself) decides success; later receipts are payouts.
      const main = outcome?.receipts_outcome?.[0]?.outcome?.status ?? outcome?.status;
      const failure = main && typeof main === "object" && "Failure" in main ? main.Failure : null;
      const logs = (outcome.receipts_outcome || []).flatMap((r) => r.outcome?.logs || []);
      const events = logs
        .filter((l) => l.startsWith("EVENT_JSON:"))
        .map((l) => {
          try {
            return JSON.parse(l.slice(11));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const sv = outcome?.status?.SuccessValue;
      let result = null;
      if (sv) {
        try {
          result = JSON.parse(Buffer.from(sv, "base64").toString());
        } catch {
          result = null;
        }
      }
      void statuses;
      return failure
        ? { ok: false, tx: outcome.transaction.hash, error: panicText(failure), events }
        : { ok: true, tx: outcome.transaction.hash, result, events };
    });
  }

  // Chain time = local clock + an offset refreshed from a final block every 30 s (saves RPC calls).
  private offset: number | null = null;
  private offsetAt = 0;
  private cache = new Map<string, { at: number; v: Promise<any> }>();
  private cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.v;
    const v = fn();
    this.cache.set(key, { at: Date.now(), v });
    v.catch(() => this.cache.delete(key));
    return v;
  }
  invalidate() {
    this.cache.clear();
  }
  async now() {
    if (this.offset === null || Date.now() - this.offsetAt > 30_000) {
      const block = await rpc("block", { finality: "final" });
      this.offset = Math.floor(Number(block.header.timestamp_nanosec) / 1e9) - Math.floor(Date.now() / 1000);
      this.offsetAt = Date.now();
    }
    return Math.floor(Date.now() / 1000) + this.offset;
  }
  queue() {
    return this.cached("queue", 3000, () => view(this.contractId, "get_queue", {}));
  }
  job(id: number) {
    return this.cached(`job:${id}`, 2000, () => view(this.contractId, "get_job", { job_id: id }));
  }
  quote(jobId: number, latestStartAt: number) {
    return view(this.contractId, "get_quote", { job_id: jobId, latest_start_at: latestStartAt });
  }
  async credit(accountId: string) {
    return BigInt(await this.cached(`credit:${accountId}`, 8000, () => view(this.contractId, "get_credit", { account_id: accountId })));
  }
  stats() {
    return view(this.contractId, "get_stats", {});
  }
  async deposits() {
    const d = await view(this.contractId, "get_storage_deposits", {});
    return { job: BigInt(d.job), priorityBase: BigInt(d.priority_base), priorityPerDisplaced: BigInt(d.priority_per_displaced) };
  }
  async submit(agent: string, a: SubmitArgs) {
    const r = await this.send(agent, "submit_job", {
      title: a.title,
      input_hash: a.input_hash,
      input_uri: a.input_uri,
      duration_secs: a.duration_secs,
      deadline_secs: a.deadline_secs,
      reward: a.reward.toString(),
      ask_per_sec: a.ask_per_sec.toString(),
      bond: a.bond.toString(),
    });
    return { ...r, jobId: typeof r.result === "number" ? r.result : undefined };
  }
  setAsk(agent: string, jobId: number, ask: bigint) {
    return this.send(agent, "set_move_ask", { job_id: jobId, ask_per_sec: ask.toString() }, 15n);
  }
  buy(agent: string, jobId: number, latestStartAt: number, maxSpend: bigint) {
    return this.send(agent, "request_priority", { job_id: jobId, latest_start_at: latestStartAt, max_spend: maxSpend.toString() }, 60n);
  }
  cancel(agent: string, jobId: number) {
    return this.send(agent, "cancel_job", { job_id: jobId });
  }
  withdraw(agent: string) {
    return this.send(agent, "withdraw_credit", {});
  }
  async startNext() {
    const r = await this.send(this.operatorId, "start_next", {}, 50n);
    return { ...r, jobId: typeof r.result === "number" ? r.result : undefined };
  }
  complete(jobId: number, artifactHash: string) {
    return this.send(this.operatorId, "complete_job", { job_id: jobId, artifact_hash: artifactHash }, 80n);
  }
  completeAttested(jobId: number, response: string, signature: string, signer: string, model: string | null) {
    return this.send(this.operatorId, "complete_job_attested", { job_id: jobId, response, signature, signer, model }, 120n);
  }
  claimTimeout(caller: string, jobId: number) {
    return this.send(caller, "claim_timeout", { job_id: jobId });
  }
  reject(jobId: number, reason: string) {
    if (this.rules !== "v3") return Promise.resolve({ ok: false, error: "reject_job needs the v3 contract" });
    return this.send(this.operatorId, "reject_job", { job_id: jobId, reason: reason.slice(0, 128) }, 60n);
  }
  fail(jobId: number, reasonHash: string) {
    return this.send(this.operatorId, "fail_job", { job_id: jobId, reason_hash: reasonHash }, 50n);
  }
  heartbeat() {
    if (this.rules !== "v3") return Promise.resolve({ ok: true });
    return this.send(this.operatorId, "heartbeat", {}, 10n);
  }
  /** The contract has no view for the running id: read the newest job_started activity, then scan back by id. */
  async findRunning(): Promise<ChainJob | null> {
    this.invalidate();
    const stats = await this.stats();
    if (!Number(stats.running)) return null;
    const recent = await view(this.contractId, "get_activity", { limit: 128 }).catch(() => []);
    for (const a of recent as Array<{ type?: string; job_id?: number | null }>) {
      if (a.type !== "job_started" || a.job_id == null) continue;
      const j = await this.job(a.job_id).catch(() => null);
      if (j?.status === "RUNNING") return j;
    }
    for (let id = Number(stats.submitted ?? 0); id >= 1; id -= 1) {
      const j = await this.job(id).catch(() => null);
      if (j?.status === "RUNNING") return j;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory simulation with the contract's rules
// ---------------------------------------------------------------------------

interface SimJob extends ChainJob {}
/** Mirrors DEADLINE_MARGIN_SECS in contracts/queue-v2. */
/** Which contract rules the simulator follows: "v2" (deployed on market4) or "v3". */
export const SIM_RULES = process.env.QUEUE_SIM_RULES === "v3" ? "v3" : "v2";
const SIM_DEADLINE_MARGIN_SECS = 3;
/** Mirrors COMPLETE_MARGIN_SECS: a head with less spare time than this is settled as missed, not started. */
const SIM_COMPLETE_MARGIN_SECS = 2;
/** Mirrors MARGIN_PER_HANDOFF_SECS. */
const SIM_MARGIN_PER_HANDOFF_SECS = 1;
/** Mirrors ASK_RAISE_DELAY_SECS in contracts/queue-v3: a raised ask counts only after this delay. */
export const SIM_ASK_RAISE_DELAY_SECS = 30;

/** The ask a quote uses at `now` (v3: a raise counts only once its delay has passed). */
function effectiveAsk(j: ChainJob, now: number): bigint {
  if (SIM_RULES === "v3" && j.ask_pending != null && now >= (j.ask_effective_at ?? 0)) return BigInt(j.ask_pending);
  return BigInt(j.ask_per_sec);
}

export class SimChain implements Chain {
  kind = "sim" as const;
  rules = SIM_RULES;
  /** v3: the operator's stake, which pays back priority spend on a rejection (penalties are not simulated). */
  stake = 0n;
  /** v3: as the contract, jobs default to model verification only while a model key is pinned. */
  modelKeyPinned = false;
  clock: number;
  jobs = new Map<number, SimJob>();
  order: number[] = [];
  running: number | null = null;
  credits = new Map<string, bigint>();
  /** Native NEAR paid out to accounts (refunds, bonds, rewards, withdrawals): not spendable through the contract. */
  wallets = new Map<string, bigint>();
  nextId = 1;
  txSeq = 0;
  /** Request hash -> job id, as the contract's claim keys. */
  claims = new Map<string, number>();
  stat = { submitted: 0, completed: 0, missed: 0, cancelled: 0, attested: 0, moves: 0, total_priority: 0n, total_compensation: 0n, total_fees: 0n };
  readonly dep: StorageDeposits = { job: 17n * 10n ** 21n, priorityBase: 6n * 10n ** 21n, priorityPerDisplaced: 3n * 10n ** 21n };

  constructor(start = 1_800_000_000, readonly operatorId = "worker.sim", readonly treasuryId = "treasury.sim", readonly feeBps = 100) {
    this.clock = start;
  }
  advance(secs: number) {
    this.clock += secs;
  }
  /** Internal balance (deposit, displacement compensation, fees, excess): spendable with a function-call key. */
  fund(accountId: string, amount: bigint) {
    this.credits.set(accountId, (this.credits.get(accountId) ?? 0n) + amount);
  }
  /** The agent's principal sends native NEAR the contract paid out back in as a deposit. */
  topUp(accountId: string, amount: bigint): bigint {
    const have = this.wallets.get(accountId) ?? 0n;
    const moved = amount < have ? amount : have;
    if (moved <= 0n) return 0n;
    this.wallets.set(accountId, have - moved);
    this.fund(accountId, moved);
    return moved;
  }
  /** Native transfer out of the contract, as the live contract does for refunds, bonds and rewards. */
  pay(accountId: string, amount: bigint) {
    this.wallets.set(accountId, (this.wallets.get(accountId) ?? 0n) + amount);
  }
  private tx(): string {
    this.txSeq += 1;
    return `sim-${this.txSeq}`;
  }
  private refuse(error: string): TxResult {
    return { ok: false, tx: this.tx(), error };
  }
  private spend(who: string, amount: bigint): string | null {
    const have = this.credits.get(who) ?? 0n;
    if (have < amount) return `balance too low: need ${amount} yocto, have ${have}; deposit first or attach NEAR`;
    this.credits.set(who, have - amount);
    return null;
  }
  private base(now: number): number {
    if (this.running == null) return now;
    const r = this.jobs.get(this.running)!;
    return Math.max(now, (r.started_at ?? now) + r.duration_secs);
  }
  private view(raw: SimJob): ChainJob {
    // v3 views show the ask in force; a pending raise is listed only while it waits.
    const j: SimJob = SIM_RULES === "v3"
      ? { ...raw, ask_per_sec: effectiveAsk(raw, this.clock).toString(), ask_pending: raw.ask_pending != null && this.clock < (raw.ask_effective_at ?? 0) ? raw.ask_pending : null }
      : raw;
    const idx = this.order.indexOf(j.id);
    if (j.status === "QUEUED" && idx >= 0) {
      let cursor = this.base(this.clock);
      for (let i = 0; i < idx; i += 1) cursor += this.jobs.get(this.order[i])!.duration_secs;
      return { ...j, position: idx + 1, projected_start_at: cursor, projected_finish_at: cursor + j.duration_secs };
    }
    if (j.status === "RUNNING") {
      const start = j.started_at ?? this.clock;
      return { ...j, position: 0, projected_start_at: start, projected_finish_at: start + j.duration_secs };
    }
    return { ...j, position: 0 };
  }

  async now() {
    return this.clock;
  }
  async queue() {
    return this.order.map((id) => this.view(this.jobs.get(id)!));
  }
  async job(id: number) {
    const j = this.jobs.get(id);
    if (!j) throw new Error("job not found");
    return this.view(j);
  }
  async credit(a: string) {
    return this.credits.get(a) ?? 0n;
  }
  async deposits() {
    return this.dep;
  }
  async stats() {
    return { ...this.stat, queued: this.order.length, running: this.running ? 1 : 0 };
  }

  quoteSync(jobId: number, latest: number): Quote {
    const now = this.clock;
    const pos = this.order.indexOf(jobId);
    const empty = (reason: string): Quote => ({ job_id: jobId, now, insert_index: 0, projected_start_at: 0, projected_finish_at: 0, compensation: "0", fee: "0", total: "0", displaced: [], feasible: false, reason });
    if (pos < 0) return empty("job is not queued");
    if (latest < now) return empty("latest_start_at is in the past");
    const urgent = this.jobs.get(jobId)!;
    const starts: number[] = [];
    let cursor = this.base(now);
    for (const id of this.order) {
      starts.push(cursor);
      cursor += this.jobs.get(id)!.duration_secs;
    }
    let chosen = -1;
    for (let k = pos; k >= 0; k -= 1) {
      if (starts[k] > latest) continue;
      if (starts[k] + urgent.duration_secs + SIM_DEADLINE_MARGIN_SECS > urgent.deadline_at) continue;
      chosen = k;
      break;
    }
    if (chosen < 0) return empty(starts[0] > latest ? "even the front of the queue starts after the cutoff" : "even the front of the queue misses this job's deadline");
    const displaced: Array<Displaced & { margin: number; doomed?: boolean }> = this.order.slice(chosen, pos).map((id, i) => {
      const j = this.jobs.get(id)!;
      const oldFinish = starts[chosen + i] + j.duration_secs;
      const nf = oldFinish + urgent.duration_secs;
      // Margin grows by one second per hand-off ahead of the job, as in the contract.
      const margin = SIM_DEADLINE_MARGIN_SECS + SIM_MARGIN_PER_HANDOFF_SECS * i;
      // v3: a job already projected to miss its deadline has no promise left to keep: it cannot block the jump,
      // but it is still paid its ask (every job passed is paid).
      const doomed = SIM_RULES === "v3" && oldFinish + SIM_COMPLETE_MARGIN_SECS > j.deadline_at;
      return { job_id: id, owner: j.owner, amount: (effectiveAsk(j, now) * BigInt(urgent.duration_secs)).toString(), delay_secs: urgent.duration_secs, new_finish_at: nf, deadline_at: j.deadline_at, slack_secs: j.deadline_at - nf, margin, doomed };
    });
    const comp = displaced.reduce((s, d) => s + BigInt(d.amount), 0n);
    const fee = (comp * BigInt(this.feeBps)) / 10_000n;
    // Same margin as the contract (DEADLINE_MARGIN_SECS): zero slack is not enough, since every start lands late.
    const breaker = displaced.find((d) => !d.doomed && d.slack_secs < d.margin);
    return {
      job_id: jobId, now, insert_index: chosen, projected_start_at: starts[chosen], projected_finish_at: starts[chosen] + urgent.duration_secs,
      compensation: comp.toString(), fee: fee.toString(), total: (comp + fee).toString(), displaced,
      feasible: !breaker,
      reason: breaker
        ? breaker.slack_secs < 0
          ? `displaced job ${breaker.job_id} would finish at ${breaker.new_finish_at}, after its deadline ${breaker.deadline_at}`
          : `displaced job ${breaker.job_id} would finish at ${breaker.new_finish_at}, inside the safety margin before its deadline ${breaker.deadline_at}`
        : `${displaced.length} displaced`,
    };
  }
  async quote(jobId: number, latest: number) {
    return this.quoteSync(jobId, latest);
  }

  async submit(agent: string, a: SubmitArgs) {
    if (a.deadline_secs < a.duration_secs) return this.refuse("deadline_secs must be at least duration_secs: the job could never finish on time");
    if (a.reward <= 0n) return this.refuse("reward must be > 0");
    if (a.ask_per_sec > 10n ** 24n) return this.refuse("ask_per_sec must be at most 1 NEAR per second");
    const claim = /^(sha256:)?(0x)?[0-9a-f]{64}$/i.test(a.input_hash.trim()) ? a.input_hash.trim().replace(/^sha256:/, "").replace(/^0x/, "").toLowerCase() : null;
    if (claim && this.claims.has(claim)) return this.refuse(`this request hash is already used by job ${this.claims.get(claim)}; submit a fresh request`);
    if (a.bond <= 0n) return this.refuse("bond must be > 0");
    if (this.order.length >= 128) return this.refuse("queue is full (max 128)");
    if (this.base(this.clock) + a.duration_secs + SIM_COMPLETE_MARGIN_SECS > this.clock + a.deadline_secs) return this.refuse("this job cannot finish by its deadline even at the front of the queue");
    const err = this.spend(agent, a.reward + a.bond + this.dep.job);
    if (err) return this.refuse(err);
    const id = this.nextId++;
    this.jobs.set(id, {
      id, owner: agent, title: a.title, input_hash: a.input_hash, input_uri: a.input_uri, duration_secs: a.duration_secs,
      deadline_at: this.clock + a.deadline_secs, submitted_at: this.clock, reward: a.reward.toString(), bond: a.bond.toString(),
      ask_per_sec: a.ask_per_sec.toString(), status: "QUEUED", expedited: false, moved_compensation: "0", priority_spend: "0",
      // As the v3 contract: with a model key pinned, a job naming its request by sha256 is a model job.
      verify: SIM_RULES === "v3" ? (claim && this.modelKeyPinned ? "model" : "operator") : undefined,
      position: 0, projected_start_at: 0, projected_finish_at: 0,
    });
    this.order.push(id);
    if (claim) this.claims.set(claim, id);
    this.stat.submitted += 1;
    return { ok: true, tx: this.tx(), jobId: id, result: id };
  }
  async setAsk(agent: string, jobId: number, ask: bigint) {
    const j = this.jobs.get(jobId);
    if (!j) return this.refuse("job not found");
    if (j.owner !== agent) return this.refuse("only the job owner can set the ask");
    if (j.status !== "QUEUED") return this.refuse("only queued jobs can change their ask");
    if (ask > 10n ** 24n) return this.refuse("ask_per_sec must be at most 1 NEAR per second");
    if (SIM_RULES === "v3") {
      // As the v3 contract: a cut is immediate, a raise waits SIM_ASK_RAISE_DELAY_SECS.
      const current = effectiveAsk(j, this.clock);
      j.ask_per_sec = current.toString();
      if (ask > current) {
        j.ask_pending = ask.toString();
        j.ask_effective_at = this.clock + SIM_ASK_RAISE_DELAY_SECS;
      } else {
        j.ask_per_sec = ask.toString();
        j.ask_pending = null;
        j.ask_effective_at = this.clock;
      }
      return { ok: true, tx: this.tx() };
    }
    j.ask_per_sec = ask.toString();
    return { ok: true, tx: this.tx() };
  }
  async buy(agent: string, jobId: number, latest: number, maxSpend: bigint) {
    const j = this.jobs.get(jobId);
    if (!j) return this.refuse("job not found");
    if (j.owner !== agent) return this.refuse("only the job owner can buy priority");
    const q = this.quoteSync(jobId, latest);
    if (!q.feasible) return this.refuse(`priority infeasible: ${q.reason}`);
    if (!q.displaced.length) return this.refuse("nothing to buy: the job is already in its best feasible slot");
    if (BigInt(q.total) > maxSpend) return this.refuse("priority total exceeds max_spend");
    const storage = this.dep.priorityBase + this.dep.priorityPerDisplaced * BigInt(q.displaced.length);
    const err = this.spend(agent, BigInt(q.total) + storage);
    if (err) return this.refuse(err);
    const old = this.order.indexOf(jobId);
    this.order.splice(old, 1);
    this.order.splice(q.insert_index, 0, jobId);
    j.expedited = true;
    j.priority_spend = (BigInt(j.priority_spend) + BigInt(q.total)).toString();
    for (const d of q.displaced) {
      const dj = this.jobs.get(d.job_id)!;
      dj.moved_compensation = (BigInt(dj.moved_compensation) + BigInt(d.amount)).toString();
      this.fund(d.owner, BigInt(d.amount));
    }
    this.fund(this.treasuryId, BigInt(q.fee));
    this.stat.moves += q.displaced.length;
    this.stat.total_priority += BigInt(q.total);
    this.stat.total_compensation += BigInt(q.compensation);
    this.stat.total_fees += BigInt(q.fee);
    return { ok: true, tx: this.tx(), result: q };
  }
  async cancel(agent: string, jobId: number) {
    const j = this.jobs.get(jobId);
    if (!j) return this.refuse("job not found");
    if (j.owner !== agent) return this.refuse("only the job owner can cancel");
    if (j.status !== "QUEUED") return this.refuse("only queued jobs can cancel");
    const bond = BigInt(j.bond);
    const cut = j.expedited ? bond : bond / 4n;
    j.status = "CANCELLED";
    j.finished_at = this.clock;
    this.order.splice(this.order.indexOf(jobId), 1);
    this.fund(this.treasuryId, cut);
    this.pay(agent, BigInt(j.reward) + bond - cut);
    this.stat.cancelled += 1;
    return { ok: true, tx: this.tx() };
  }
  async withdraw(agent: string) {
    const amount = this.credits.get(agent) ?? 0n;
    this.credits.delete(agent);
    this.pay(agent, amount);
    return { ok: true, tx: this.tx(), result: amount.toString() };
  }
  async startNext() {
    if (this.running != null) return this.refuse("a job is already running");
    if (!this.order.length) return this.refuse("queue is empty");
    const id = this.order.shift()!;
    const j = this.jobs.get(id)!;
    if (this.clock + j.duration_secs + SIM_COMPLETE_MARGIN_SECS > j.deadline_at) {
      // As the contract: a head that can no longer finish on time is settled as missed, never started.
      j.status = "MISSED";
      j.finished_at = this.clock;
      this.stat.missed += 1;
      this.pay(j.owner, BigInt(j.reward) + BigInt(j.bond));
      return { ok: true, tx: this.tx(), jobId: id, result: id, events: [{ event: "job_missed", data: { job_id: id, reason: this.clock > j.deadline_at ? "deadline_passed_before_start" : "cannot_finish_before_deadline" } }] };
    }
    j.status = "RUNNING";
    j.started_at = this.clock;
    this.running = id;
    return { ok: true, tx: this.tx(), jobId: id, result: id, events: [{ event: "job_started", data: { job_id: id, started_at: this.clock } }] };
  }
  private settle(jobId: number, hash: string, attested: boolean): TxResult {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== "RUNNING" || this.running !== jobId) return this.refuse("job is not running");
    j.artifact_hash = hash;
    j.finished_at = this.clock;
    this.running = null;
    if (this.clock > j.deadline_at) {
      j.status = "MISSED";
      this.stat.missed += 1;
      this.pay(j.owner, BigInt(j.reward) + BigInt(j.bond));
    } else {
      j.status = "DONE";
      j.attested = attested;
      this.stat.completed += 1;
      if (attested) this.stat.attested += 1;
      this.pay(this.operatorId, BigInt(j.reward));
      this.pay(j.owner, BigInt(j.bond));
    }
    return { ok: true, tx: this.tx() };
  }
  async complete(jobId: number, hash: string) {
    if (SIM_RULES === "v3" && this.jobs.get(jobId)?.verify === "model") {
      return this.refuse("this job asked for a model answer: settle it with complete_job_attested, or fail_job");
    }
    return this.settle(jobId, hash, false);
  }
  async reject(jobId: number, _reason: string) {
    if (SIM_RULES !== "v3") return this.refuse("reject_job needs the v3 contract");
    const j = this.jobs.get(jobId);
    if (!j || j.status !== "QUEUED") return this.refuse("only queued jobs can be rejected");
    this.order.splice(this.order.indexOf(jobId), 1);
    j.status = "REJECTED";
    j.finished_at = this.clock;
    const back = BigInt(j.priority_spend) < this.stake ? BigInt(j.priority_spend) : this.stake;
    this.stake -= back;
    // The record is released at once; the contract refunds the bytes it frees (at most the deposit). The
    // simulator credits the whole job deposit, an upper bound.
    this.fund(j.owner, back + this.dep.job);
    this.pay(j.owner, BigInt(j.reward) + BigInt(j.bond));
    return { ok: true, tx: this.tx() };
  }
  async heartbeat() {
    return { ok: true, tx: this.tx() };
  }
  async fail(jobId: number, _reasonHash: string) {
    const j = this.jobs.get(jobId);
    if (!j || j.status !== "RUNNING" || this.running !== jobId) return this.refuse("job is not running");
    j.status = "FAILED";
    j.finished_at = this.clock;
    this.running = null;
    this.pay(j.owner, BigInt(j.reward) + BigInt(j.bond));
    return { ok: true, tx: this.tx() };
  }
  async completeAttested(jobId: number, response: string) {
    const { createHash } = await import("node:crypto");
    return this.settle(jobId, createHash("sha256").update(response).digest("hex"), true);
  }
  async findRunning() {
    return this.running == null ? null : this.view(this.jobs.get(this.running)!);
  }
  async claimTimeout(_caller: string, jobId: number) {
    const j = this.jobs.get(jobId);
    if (!j || (j.status !== "QUEUED" && j.status !== "RUNNING")) return this.refuse("only queued or running jobs can time out");
    if (this.clock <= j.deadline_at) return this.refuse("job deadline has not passed");
    if (j.status === "RUNNING") this.running = null;
    else this.order.splice(this.order.indexOf(jobId), 1);
    j.status = "MISSED";
    j.finished_at = this.clock;
    this.stat.missed += 1;
    this.pay(j.owner, BigInt(j.reward) + BigInt(j.bond));
    return { ok: true, tx: this.tx() };
  }
}
