// @ts-nocheck
/**
 * Run a QUEUE season: 8 model-driven agents share one model-backed worker.
 *
 *   npx tsx scripts/season/season.ts --sim --minutes 30            # in-memory rules, virtual clock
 *   npx tsx scripts/season/season.ts --testnet --minutes 30        # v2 contract on NEAR testnet
 *
 * Agents decide with NEAR AI when NEAR_AI_API_KEY is set, otherwise with a deterministic
 * fallback that is labelled as such in every log line. The worker answers each job on NEAR AI
 * and settles it with `complete_job_attested` (TEE signature checked by the contract); without a
 * key it uses `complete_job` with a deterministic answer, also labelled.
 *
 * Output: data/season/<run>/events.jsonl, summary.json, requests/<sha>.json, responses/<job>.json
 */
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT, loadEnv, readJson, account, loadKey, call, nearBalance } from "../lib.mjs";
import { NearChain, SimChain, type Chain, type ChainJob } from "./chain.ts";
import { PERSONAS, buildPrompt, parseAction, clampAction, fallbackAction, near, toNear, remainingSecs, SUBMIT_COST_NEAR, LIMITS, type Action, type OwnTask, type Observation, type Persona } from "./agents.ts";
import { nearAiConfig, chat, chatWithRetry, signature, attestedArgs, requestBody, sha256hex, NearAiError } from "./nearai.ts";

loadEnv();
const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const MODE = flag("testnet") ? "testnet" : "sim";
const MINUTES = Number(opt("minutes", "30"));
const TURN_SECS = Number(opt("turn", "20"));
const RATE = Number(opt("rate", "1")); // >1 = more arrivals
const SEED = Number(opt("seed", "20261114"));
const NO_LLM = flag("no-llm");
// Strategic deadlines (sim experiment): this share of the agents claims a tighter deadline than it needs —
// the tightest the contract still admits. Under QUEUE a claimed deadline buys no position (order is FIFO
// until someone pays); under EDF it is the priority itself. The true deadline is logged privately so the
// verifier can score every rule against what the agents really needed.
const SHADE = Math.max(0, Math.min(1, Number(opt("shade", "0"))));
// Mechanism experiments (sim): --rescue buys the latest slot that meets a new job's own deadline in the same step
// as its submission, within the task's value (what v3's submit_job does atomically); --ask-cap bounds each ask by
// the job's own reward per second of work (v3's anti-holdout rule).
const RESCUE = flag("rescue");
// Agent behaviour. "model" (default): NEAR AI when a key is set, else the scripted fallback. "patience" (sim only):
// each task carries a private cost of waiting (NEAR per second, drawn at arrival); the agent asks exactly that cost
// times --markup to be moved back, and buys the earlier slot with the highest net gain in utility
// (value if on time minus waiting cost) whenever the gain exceeds the price.
const POLICY = opt("policy", "model");
// --waiting-costs: each task carries a private cost per second of waiting (as in --policy patience); model agents see
// it in their brief and the run logs it, so verify-season scores welfare (value minus waiting cost).
const WAITING_COSTS = flag("waiting-costs") || POLICY === "patience";
const MARKUP = Number(opt("markup", "1"));
const ASK_CAP = flag("ask-cap");
// Seconds the worker loses between settling one job and starting the next (transactions, polling).
// The worker settles this much before the declared duration ends, so the queue's projected times,
// which the contract's deadline checks rely on, do not drift.
// On testnet a settlement takes about 4 s to land and the next start a few more. 10 s, with the next job
// started in the same step, keeps the real cycle inside the declared duration.
const OVERHEAD = Number(opt("overhead", MODE === "testnet" ? "10" : "1"));
// The principal (the agent's owner) refills the agent's balance in the contract. Refunds, bonds and
// withdrawals leave the contract as native NEAR, which a function-call key cannot send back, so
// without this an agent's spendable balance only falls. The model never sees or uses the principal's key.
const TOPUP = !flag("no-topup");
const TOPUP_BELOW = near(opt("topup-below", "0.2"));
const TOPUP_AMOUNT = near(opt("topup-amount", "0.25"));
const TOPUP_EVERY = 60;
const WALLET_KEEP = near("0.15"); // native NEAR the principal keeps for gas
const RUN = opt("run", `${MODE}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
const OUT = path.join(ROOT, "data/season", RUN);
mkdirSync(path.join(OUT, "requests"), { recursive: true });
mkdirSync(path.join(OUT, "responses"), { recursive: true });

const ai = nearAiConfig();
// The model costs real money. On testnet it is on unless --no-llm; a sim run uses it only with --llm.
const useAi = !!ai.apiKey && !NO_LLM && (MODE === "testnet" || flag("llm"));
// Set when NEAR AI answers 401/402/403 (bad key or out of credit): stop calling for the rest of the run.
let aiDown: string | null = null;
function noteAiError(e: unknown, who: string) {
  if (e instanceof NearAiError && e.fatal && !aiDown) {
    aiDown = e.message.slice(0, 160);
    log({ t: rel(lastNow), who, kind: "near-ai-stopped", ok: false, error: aiDown, layer: "near-ai" });
  }
}
let lastNow = 0;
const REWARD = near("0.01");
const BOND = near("0.005");

// Seeded RNG so a sim season is reproducible.
let rs = SEED >>> 0;
const rand = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const between = ([a, b]: [number, number]) => a + (b - a) * rand();
const expo = (mean: number) => -Math.log(1 - rand()) * mean;
// Request nonces draw from their own generator, so a resubmission does not shift later arrivals.
let nonceRs = (SEED ^ 0x0ce) >>> 0;
const nonceRand = () => ((nonceRs = (nonceRs * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function log(e: Record<string, unknown>) {
  appendFileSync(path.join(OUT, "events.jsonl"), JSON.stringify(e) + "\n");
  const tag = e.ok === false ? "✗" : "·";
  const who = String(e.who ?? "").padEnd(8);
  console.log(`${tag} t+${String(e.t).padStart(4)} ${who} ${e.kind}${e.action ? " " + e.action : ""}${e.job != null ? " #" + e.job : ""}${e.error ? "  → " + e.error : ""}${e.reason ? "  « " + String(e.reason).slice(0, 90) : ""}`);
}

// ---------------------------------------------------------------------------
// Chain + accounts
// ---------------------------------------------------------------------------

let chain: Chain;
const acct: Record<string, string> = {};
let operatorId: string;
let pinned: string[] = [];
const principals: Record<string, any> = {};

if (MODE === "testnet") {
  const cfg = readJson("data/season/testnet.json");
  if (!cfg) throw new Error("data/season/testnet.json missing: run scripts/season/setup.ts first");
  const keys: Record<string, string> = {};
  for (const p of PERSONAS) {
    const a = cfg.agents[p.id];
    acct[p.id] = a.accountId;
    keys[a.accountId] = JSON.parse(readFileSync(path.join(ROOT, a.functionCallKeyFile), "utf8")).secretKey;
  }
  operatorId = cfg.operatorId;
  keys[operatorId] = JSON.parse(readFileSync(path.join(ROOT, cfg.operatorKeyFile), "utf8")).secretKey;
  chain = new NearChain(cfg.contractId, keys, operatorId);
  // Principal keys: used only by principalTopUps(), never by an agent's turn.
  if (TOPUP) for (const p of PERSONAS) principals[acct[p.id]] = account(acct[p.id], loadKey(acct[p.id]).secretKey);
  const onChain = await (await import("../lib.mjs")).view(cfg.contractId, "get_config", {});
  pinned = onChain.tee_signers ?? [];
  // v3 contracts carry an owner timelock; v2 (market4) does not.
  (chain as NearChain).rules = onChain.timelock_secs != null ? "v3" : "v2";
} else {
  const sim = new SimChain();
  // A sim with a model stands in for a contract with a pinned model key.
  sim.modelKeyPinned = useAi;
  operatorId = sim.operatorId;
  for (const p of PERSONAS) {
    acct[p.id] = `${p.id}.sim`;
    sim.fund(acct[p.id], near("0.6"));
  }
  chain = sim;
}
const ownerToPersona = Object.fromEntries(Object.entries(acct).map(([k, v]) => [v, k]));

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------

interface AgentState {
  p: Persona;
  nextArrival: number;
  nextTurn: number;
  pending: OwnTask[];
  tasks: Map<number, OwnTask>;
  recent: string[];
  busy?: boolean;
  lastPicture?: string;
  skips?: number;
  disabled?: boolean;
}
let turnsSkipped = 0;
let tasksExpired = 0;

const t0 = await chain.now();
const END = t0 + MINUTES * 60;
const agents: AgentState[] = PERSONAS.map((p, i) => ({
  p,
  nextArrival: t0 + Math.round(expo(p.arrivalEverySecs / RATE) * 0.5),
  nextTurn: t0 + 3 + i * Math.round(TURN_SECS / PERSONAS.length),
  pending: [],
  tasks: new Map(),
  recent: [],
}));
// The agents that over-claim urgency (see --shade): a seeded pick, so a sweep is reproducible.
// Its own generator: the arrivals stay identical across --shade levels, so runs pair up job for job.
let shadeRs = (SEED ^ 0x5eed) >>> 0;
const shadeRand = () => ((shadeRs = (shadeRs * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const shaders = new Set(
  [...PERSONAS]
    .map((p) => ({ id: p.id, k: shadeRand() }))
    .sort((x, y) => x.k - y.k)
    .slice(0, Math.round(SHADE * PERSONAS.length))
    .map((x) => x.id),
);
if (shaders.size) log({ t: 0, who: "season", kind: "strategic-deadlines", agents: [...shaders], share: SHADE });
const requestsByHash = new Map<string, string>();
const rel = (n: number) => n - t0;

const CONTRACT_TAG = MODE === "testnet" ? (chain as NearChain).contractId : "sim";

/**
 * The exact request the worker will send. Its sha256 is the job's input_hash, so the TEE signature on the answer
 * can only match this job. The body names the contract, the run and a fresh nonce, so a signed answer cannot be
 * reused on another deployment.
 */
function makeRequest(p: Persona, template: OwnTask["template"], now: number) {
  const body = requestBody(
    ai.model,
    "You are the QUEUE worker: one shared model answering agents' jobs in queue order. Answer concisely and concretely.",
    `[${CONTRACT_TAG} · ${RUN} · ${p.name} · ${template.kind} · ${now}-${Math.floor(nonceRand() * 1e6)}] ${template.prompt}`,
    { temperature: 0.3, maxTokens: 350 },
  );
  const inputHash = sha256hex(body);
  requestsByHash.set(inputHash, body);
  writeFileSync(path.join(OUT, "requests", `${inputHash}.json`), body);
  return { requestBody: body, inputHash };
}

// Waiting costs draw from their own generator, so turning the patience policy on does not shift arrivals.
let costRs = (SEED ^ 0xc057) >>> 0;
const costRand = () => ((costRs = (costRs * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function newTask(p: Persona, now: number): OwnTask {
  const template = p.tasks[Math.floor(rand() * p.tasks.length)];
  const durationSecs = Math.round(between(template.durationSecs));
  const deadlineSecs = Math.round(between(template.deadlineSecs));
  const valueYocto = near(between(template.valueNear).toFixed(5));
  // Private cost of waiting: waiting the whole deadline window would cost 10%-90% of the task's value.
  const waitCostNear = (Number(valueYocto) / 1e24) * (0.1 + 0.8 * costRand()) / Math.max(1, deadlineSecs);
  return { template, valueYocto, durationSecs, deadlineSecs, waitCostNear, ...makeRequest(p, template, now), arrivedAt: now } as OwnTask;
}

/** Utility of finishing a task at `finish`: its value minus the cost of waiting since arrival, 0 if late. */
function utility(t: any, deadlineAt: number, finish: number) {
  if (finish + 3 > deadlineAt) return 0;
  return Number(t.valueYocto) / 1e24 - (t.waitCostNear ?? 0) * Math.max(0, finish - t.arrivedAt);
}

/** The patience policy (see --policy). Deterministic; needs no model and no key. */
async function patienceAction(a: AgentState, o: Observation): Promise<Action> {
  if (o.pending && Number(o.balanceYocto) / 1e24 >= SUBMIT_COST_NEAR) {
    const c = (o.pending as any).waitCostNear ?? 0;
    return { action: "submit", ask_per_sec_near: Math.max(LIMITS.minAskNearPerSec, c * MARKUP), reason: `ask = my cost of waiting x ${MARKUP}` };
  }
  let best: { net: number; job: number; cutoff: number; total: number } | null = null;
  for (const { job, task } of o.own) {
    if (job.status !== "QUEUED" || !task) continue;
    const here = utility(task, job.deadline_at, job.projected_finish_at);
    for (let k = job.position - 2; k >= 0; k -= 1) {
      const cutoff = o.queue[k]?.projected_start_at;
      if (cutoff == null) continue;
      const q = await chain.quote(job.id, Math.max(o.now, cutoff)).catch(() => null);
      if (!q?.feasible || !q.displaced.length) continue;
      const total = Number(BigInt(q.total)) / 1e24;
      const net = utility(task, job.deadline_at, q.projected_finish_at) - here - total;
      if (net > 0.0002 && (!best || net > best.net)) best = { net, job: job.id, cutoff: Math.max(o.now, cutoff), total };
    }
  }
  if (best) return { action: "buy_priority", job_id: best.job, latest_start_in_secs: best.cutoff - o.now, max_spend_near: best.total * 1.0001, reason: `jump gains ${best.net.toFixed(5)} NEAR of utility net of its price` };
  return { action: "wait", reason: "no jump is worth its price" };
}

async function observe(a: AgentState, now: number, queue: ChainJob[], running: ChainJob | null): Promise<Observation> {
  const mine = queue.filter((j) => j.owner === acct[a.p.id]);
  if (running && running.owner === acct[a.p.id]) mine.unshift(running);
  const own = [];
  for (const job of mine) {
    const task = a.tasks.get(job.id);
    let quote, quoteCutoff;
    // A quote only matters when the deadline is at risk; skipping the rest saves RPC calls.
    const atRisk = job.deadline_at - job.projected_finish_at < job.duration_secs * 3;
    if (job.status === "QUEUED" && atRisk) {
      quoteCutoff = Math.max(now, job.deadline_at - job.duration_secs - 4);
      try {
        quote = await chain.quote(job.id, quoteCutoff);
      } catch {
        quote = undefined;
      }
    }
    own.push({ job, task, quote, quoteCutoff });
  }
  // Waiting costs are private to the agent and shown only in a waiting-cost season.
  const hide = (t?: OwnTask) => (t && !WAITING_COSTS ? { ...t, waitCostNear: undefined } : t);
  return { now, balanceYocto: await chain.credit(acct[a.p.id]), pending: hide(a.pending[0]), own: own.map((x) => ({ ...x, task: hide(x.task) })), queue, running, recent: a.recent };
}

async function decide(a: AgentState, o: Observation) {
  if (POLICY === "patience") return { action: await patienceAction(a, o), source: "patience" };
  if (useAi && !aiDown) {
    const body = buildPrompt(a.p, o, ai.model);
    try {
      // One attempt: an agent that misses a turn falls back to its rule, which is cheaper than a retry.
      const c = await chat({ ...ai, timeoutMs: 20_000 }, body);
      const parsed = parseAction(c.content);
      if (typeof parsed !== "string") return { action: parsed, source: "near-ai", chatId: c.chatId, latencyMs: c.latencyMs, usage: c.usage };
      return { action: fallbackAction(a.p, o), source: "fallback", why: `model answer unusable: ${parsed}`, usage: c.usage };
    } catch (e) {
      noteAiError(e, a.p.id);
      return { action: fallbackAction(a.p, o), source: "fallback", why: String(e.message ?? e).slice(0, 160) };
    }
  }
  return { action: fallbackAction(a.p, o), source: "fallback", why: aiDown ? `NEAR AI stopped: ${aiDown}` : NO_LLM ? "--no-llm" : !ai.apiKey ? "NEAR_AI_API_KEY not set" : "sim without --llm" };
}

/** Seconds until the worker is free: even a job that buys the front slot cannot start earlier. */
function frontWait(now: number, running: ChainJob | null) {
  return running ? Math.max(0, (running.started_at ?? now) + running.duration_secs - now) : 0;
}

/**
 * What the agent can see that could change its decision. Two turns with the same picture get the same answer,
 * so the second model call is skipped (about half of all turns would otherwise end in "wait").
 */
function picture(o: Observation) {
  const own = o.own
    .map((x) => {
      // Risk class, not raw seconds: positions and slack tick down as the queue drains without changing the choice.
      const slack = x.job.deadline_at - x.job.projected_finish_at;
      const risk = slack < 0 ? "late" : slack < x.job.duration_secs * 2 ? "tight" : slack < x.job.duration_secs * 6 ? "ok" : "safe";
      // A coarse clock: the bucket moves as slack halves, so a waiting agent is asked again before it is too late.
      const tick = Math.floor(Math.log2(1 + Math.max(0, slack) / Math.max(1, x.job.duration_secs)));
      return `${x.job.id}:${x.job.status}:${x.job.ask_per_sec}:${risk}:${tick}:${x.quote ? (x.quote.feasible ? "can-buy" : "no") : "-"}`;
    })
    .join("|");
  const p = o.pending;
  const pendingKey = p ? `${p.inputHash}:${Math.floor(Math.log2(1 + Math.max(0, remainingSecs(p, o.now)) / Math.max(1, p.durationSecs)))}` : "-";
  return `${pendingKey}#${own}#${Number(o.balanceYocto / 10n ** 22n)}`;
}

async function agentTurn(a: AgentState, now: number, queue: ChainJob[], running: ChainJob | null) {
  // A key the RPC keeps rejecting (no allowance, key gone) cannot act: stop paying for its decisions.
  if (a.disabled) return;
  // Arrivals are closed: no new submissions, and no model calls for the drain (up to 20 minutes of turns).
  if (draining) a.pending = [];
  // Drop tasks that can no longer finish on time even from the front of the queue (bought priority included):
  // submitting them only loses the storage deposit, and keeping them makes the agent call the model every turn.
  const wait = frontWait(now, running);
  while (a.pending.length && remainingSecs(a.pending[0], now) < a.pending[0].durationSecs + wait + COMPLETE_MARGIN) {
    const t = a.pending.shift();
    log({ t: rel(now), who: a.p.id, kind: "task-expired", title: t.template.title, deadlineIn: remainingSecs(t, now), queueWait: wait });
    tasksExpired += 1;
  }
  const o = await observe(a, now, queue, running);
  if (!o.pending && !o.own.some((x) => x.job.status === "QUEUED")) return;
  // Nothing it can afford to do: a pending task but no money to submit it, and no queued job to manage.
  if (!o.own.some((x) => x.job.status === "QUEUED") && Number(o.balanceYocto) / 1e24 < SUBMIT_COST_NEAR) {
    turnsSkipped += 1;
    return;
  }
  const pic = picture(o);
  // Same picture as last time: same answer. Re-ask anyway after 4 skipped turns, so a stale "wait" cannot freeze it.
  if (pic === a.lastPicture && (a.skips ?? 0) < 4) {
    a.skips = (a.skips ?? 0) + 1;
    turnsSkipped += 1;
    return;
  }
  a.lastPicture = pic;
  a.skips = 0;
  const d = draining ? { action: fallbackAction(a.p, o), source: "fallback", why: "draining: arrivals closed" } : await decide(a, o);
  const base = { t: rel(now), who: a.p.id, kind: "decision", source: d.source, why: d.why, chatId: d.chatId, latencyMs: d.latencyMs, usage: d.usage };
  const c = clampAction(d.action, o);
  if (typeof c === "string") {
    log({ ...base, action: d.action.action, job: d.action.job_id, reason: d.action.reason, ok: false, error: `runtime limit: ${c}`, layer: "runtime" });
    // Tell the model next turn why its last proposal went nowhere, so it does not repeat it.
    a.recent.push(`${d.action.action}${d.action.job_id != null ? " #" + d.action.job_id : ""} REFUSED BY RUNTIME: ${c}`);
    if (a.recent.length > 8) a.recent.shift();
    return;
  }
  const act = c.action;
  let r, job = act.job_id;
  switch (act.action) {
    case "submit": {
      const t = a.pending.shift();
      // The deadline counts from the brief's arrival; take the time right before signing, not the turn's start.
      const atSign = await chain.now();
      const trueDeadlineSecs = Math.max(1, t.deadlineSecs - (atSign - t.arrivedAt));
      let claimedDeadlineSecs = trueDeadlineSecs;
      if (shaders.has(a.p.id)) {
        // Just enough to be admitted at the back of the queue: the end of the queue's projected work, plus this
        // job, plus the contract's 2 s start margin and 3 s for the transaction to land.
        const tail = Math.max(atSign, ...o.queue.map((q) => q.projected_finish_at), o.running ? o.running.started_at + o.running.duration_secs : atSign);
        claimedDeadlineSecs = Math.min(trueDeadlineSecs, Math.max(t.durationSecs + 5, tail - atSign + t.durationSecs + 5));
      }
      (t as any).trueDeadlineAt = atSign + trueDeadlineSecs;
      (t as any).claimedTighter = claimedDeadlineSecs < trueDeadlineSecs;
      r = await chain.submit(acct[a.p.id], {
        title: `${a.p.name}: ${t.template.title}`,
        input_hash: t.inputHash,
        input_uri: `data/season/${RUN}/requests/${t.inputHash}.json`,
        duration_secs: t.durationSecs,
        deadline_secs: claimedDeadlineSecs,
        reward: REWARD,
        bond: BOND,
        ask_per_sec: near((ASK_CAP ? Math.min(act.ask_per_sec_near, Number(REWARD) / 1e24 / t.durationSecs) : act.ask_per_sec_near).toFixed(8)),
      });
      job = r.jobId;
      if (RESCUE && r.ok && job != null) {
        const mine = (await chain.queue()).find((q) => q.id === job);
        if (mine && mine.projected_finish_at + 3 > mine.deadline_at) {
          const cutoff = mine.deadline_at - mine.duration_secs - 3;
          const q = await chain.quote(job, cutoff).catch(() => null);
          if (q?.feasible && q.displaced.length) {
            const storage = 0.006 + 0.003 * q.displaced.length;
            const price = Number(BigInt(q.total)) / 1e24;
            const value = Number(t.valueYocto) / 1e24;
            if (price + storage < value) {
              const rb = await chain.buy(acct[a.p.id], job, cutoff, BigInt(q.total));
              log({ t: rel(now), who: a.p.id, kind: "decision", source: "rescue", action: "buy_priority", job, reason: "submitted late at the back: buy the latest slot that meets its own deadline", ok: rb.ok, tx: rb.tx, error: rb.error, layer: rb.ok ? undefined : "contract" });
            }
          }
        }
      }
      if (!r.ok && r.unknown) {
        // The outcome could not be read. Before submitting again (a second job, a second payment), look for
        // this exact request in the queue.
        (chain as NearChain).invalidate?.();
        const mineHash = (j) => j && j.owner === acct[a.p.id] && j.input_hash === t.inputHash;
        // It may already be queued, running or even finished by the time we look (26 s or more later).
        let found = (await chain.queue().catch(() => [])).find(mineHash);
        if (!found) {
          const run = await chain.findRunning().catch(() => null);
          if (mineHash(run)) found = run;
        }
        if (!found) {
          const top = Number((await chain.stats().catch(() => ({ submitted: 0 }))).submitted ?? 0);
          for (let id = top; id > Math.max(0, top - 12) && !found; id -= 1) {
            const j = await chain.job(id).catch(() => null);
            if (mineHash(j)) found = j;
          }
        }
        if (found) {
          r = { ...r, ok: true, unknown: false, error: undefined, jobId: found.id };
          job = found.id;
        }
      }
      if (r.ok && job != null) a.tasks.set(job, t);
      else {
        // v2.1 refuses a request hash that is already claimed: give the task a fresh nonce before retrying.
        if (/already used by job/.test(String(r.error))) Object.assign(t, makeRequest(a.p, t.template, atSign));
        a.pending.unshift(t);
      }
      break;
    }
    case "set_ask":
      r = await chain.setAsk(acct[a.p.id], act.job_id, near(act.ask_per_sec_near.toFixed(8)));
      break;
    case "buy_priority": {
      const t = await chain.now();
      // No slot starts before the worker is free: a cutoff earlier than that (or in the past) only buys a refusal.
      // Ask for at least the earliest possible start.
      const fresh = await chain.queue();
      const earliest = Math.max(t, fresh.length ? fresh[0].projected_start_at : t);
      const latest = Math.max(t + act.latest_start_in_secs, earliest);
      // Price the jump the agent actually asked for. Storage depends on how many jobs it passes, so budget it from
      // the real quote, not a worst-case guess (which would leave no budget for a job deep in the queue).
      const q = await chain.quote(act.job_id, latest).catch(() => null);
      let maxSpend = act.max_spend_near;
      if (q?.feasible && q.displaced.length) {
        const own = o.own.find((x) => x.job.id === act.job_id);
        const storage = 0.006 + 0.003 * q.displaced.length;
        const spent = Number(BigInt(own?.job.priority_spend ?? "0")) / 1e24;
        const value = own?.task ? Number(own.task.valueYocto) / 1e24 : 0.05;
        const cap = Math.min(value - storage - spent, Number(o.balanceYocto) / 1e24 - 0.03 - storage - 0.02);
        const price = Number(BigInt(q.total)) / 1e24;
        if (price > cap) {
          log({ ...base, action: "buy_priority", job: act.job_id, reason: act.reason, ok: false, error: `runtime limit: the jump costs ${price.toFixed(5)} + ${storage.toFixed(3)} storage, more than the task is worth or the balance allows`, layer: "runtime" });
          a.recent.push(`buy_priority #${act.job_id} REFUSED BY RUNTIME: price ${price.toFixed(5)} above what the task is worth`);
          if (a.recent.length > 8) a.recent.shift();
          return;
        }
        // The model chose to buy without seeing this exact price; pay it (with 5% for a moving queue), within the cap.
        maxSpend = Math.min(cap, Math.max(act.max_spend_near, price * 1.05));
      }
      // An infeasible quote is still sent: the contract's refusal is public evidence that the rule holds.
      r = await chain.buy(acct[a.p.id], act.job_id, latest, near(Math.max(0, maxSpend).toFixed(8)));
      break;
    }
    case "cancel":
      r = await chain.cancel(acct[a.p.id], act.job_id);
      break;
    case "wait":
      log({ ...base, action: "wait", reason: act.reason });
      return;
  }
  const t = act.action === "submit" && job != null ? a.tasks.get(job) : undefined;
  const detail = act.action === "submit" ? { ask: act.ask_per_sec_near, valueNear: t ? toNear(t.valueYocto) : undefined, inputHash: t?.inputHash, ...(t && (t as any).waitCostNear != null && WAITING_COSTS ? { waitCostNear: (t as any).waitCostNear, arrivedAt: t.arrivedAt } : {}), ...(SHADE > 0 && t ? { trueDeadlineAt: (t as any).trueDeadlineAt, claimedTighter: (t as any).claimedTighter } : {}) } : act.action === "set_ask" ? { ask: act.ask_per_sec_near } : act.action === "buy_priority" ? { within: act.latest_start_in_secs, maxSpend: act.max_spend_near } : {};
  // Only a transaction the contract executed and refused is a contract refusal; RPC trouble is labelled as such.
  log({ ...base, action: act.action, job, reason: act.reason, note: c.note, ...detail, ok: r.ok, tx: r.tx, error: r.error, layer: r.ok ? undefined : r.unknown || r.rejected ? "rpc" : "contract" });
  if (r.rejected && /NotEnoughAllowance|AccessKeyNotFound|MethodNameMismatch|ReceiverMismatch|no key loaded/.test(String(r.error))) {
    a.disabled = true;
    log({ t: rel(now), who: a.p.id, kind: "agent-disabled", ok: false, error: String(r.error).slice(0, 160), layer: "rpc" });
  }
  a.recent.push(`${act.action}${job != null ? " #" + job : ""} ${r.ok ? "ok" : "REFUSED: " + r.error}`);
  if (a.recent.length > 8) a.recent.shift();
}

// ---------------------------------------------------------------------------
// Principal top-ups
// ---------------------------------------------------------------------------

let nextTopUp = 0;
const topping = new Set<string>();
const dry = new Set<string>();
async function topUpOne(a: AgentState, now: number) {
  const id = acct[a.p.id];
  const balance = await chain.credit(id);
  if (balance >= TOPUP_BELOW) return;
  if (chain.kind === "sim") {
    const moved = (chain as SimChain).topUp(id, TOPUP_AMOUNT);
    if (moved > 0n) log({ t: rel(now), who: a.p.id, kind: "principal-topup", amountNear: toNear(moved), ok: true });
    return;
  }
  const wallet = await nearBalance(id);
  const spare = wallet > WALLET_KEEP ? wallet - WALLET_KEEP : 0n;
  const amount = spare < TOPUP_AMOUNT ? spare : TOPUP_AMOUNT;
  if (amount < near("0.05")) {
    // Say it once per agent, not every minute.
    if (!dry.has(a.p.id)) log({ t: rel(now), who: a.p.id, kind: "principal-topup", ok: false, error: "principal wallet too low to refill" });
    dry.add(a.p.id);
    return;
  }
  dry.delete(a.p.id);
  try {
    const r = await call(principals[id], (chain as NearChain).contractId, "deposit", {}, amount, 30n);
    (chain as NearChain).invalidate();
    log({ t: rel(now), who: a.p.id, kind: "principal-topup", amountNear: toNear(amount), ok: true, tx: r.tx_hash });
  } catch (e) {
    log({ t: rel(now), who: a.p.id, kind: "principal-topup", ok: false, error: String(e.message ?? e).slice(0, 160) });
  }
}
async function principalTopUps(now: number) {
  if (!TOPUP || now < nextTopUp) return;
  nextTopUp = now + TOPUP_EVERY;
  for (const a of agents) {
    if (chain.kind === "sim") await topUpOne(a, now);
    else if (!topping.has(a.p.id)) {
      topping.add(a.p.id);
      void topUpOne(a, now)
        .catch((e) => log({ t: rel(now), who: a.p.id, kind: "principal-topup", ok: false, error: String(e.message ?? e).slice(0, 160) }))
        .finally(() => topping.delete(a.p.id));
    }
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

interface Answer { args?: any; hash?: string; source: string; why?: string }
interface Work {
  jobId: number;
  startedAt: number;
  duration: number;
  deadline: number;
  result: Promise<Answer>;
  /** Set once `result` resolves, so the worker can settle on time without blocking on a slow answer. */
  value?: Answer;
  /** The paid model answer, kept the moment it arrives: a late signature must not throw it away. */
  chat?: { responseBody: string };
  /** No model work to wait for (outsider job, or it cannot finish): settle at once. */
  settleNow?: boolean;
  /** The contract refused the attested form once; use operator attestation from now on. */
  attestedRefused?: boolean;
  /** Consecutive settlement failures; after 5 the run stops calling the model. */
  failures?: number;
}
let work: Work | null = null;
/** Seconds a head must have to spare when it starts (mirrors COMPLETE_MARGIN_SECS in v2.1). */
const COMPLETE_MARGIN = 2;
/** Longest a season job may hold the worker, whatever it declared (season jobs declare 6-30 s). */
const MAX_HOLD_SECS = 120;
/** Request hashes already answered by the model in this run: a duplicate job gets no second paid call. */
const answeredHashes = new Set<string>();

const ourAccounts = new Set<string>(Object.values(acct));
const REQUEST_FILE = /^data\/season\/[\w.-]+\/requests\/([0-9a-f]{64})\.json$/;

/**
 * The request body for a job, only if it is one of OUR agents' requests: from memory, or from a request file
 * of an earlier run whose name and content both hash to the job's input_hash. A job's input_uri is chosen by
 * whoever submitted it, so it is never used as a free path (it could point at .env).
 */
function requestFor(job: ChainJob): string | undefined {
  if (!ourAccounts.has(job.owner)) return undefined;
  const known = requestsByHash.get(job.input_hash);
  if (known) return known;
  const m = REQUEST_FILE.exec(job.input_uri ?? "");
  if (!m || m[1] !== job.input_hash) return undefined;
  const file = path.join(ROOT, job.input_uri);
  if (!existsSync(file)) return undefined;
  const body = readFileSync(file, "utf8");
  return sha256hex(body) === job.input_hash ? body : undefined;
}

function runModel(job: ChainJob, now: number, w: Work): Promise<Answer> {
  const deterministic = (why: string): Answer => {
    const answer = `Deterministic fallback answer for job ${job.id} (${why}).`;
    writeFileSync(path.join(OUT, "responses", `${job.id}.json`), JSON.stringify({ job: job.id, source: "fallback", why, answer }, null, 2));
    return { hash: sha256hex(answer), source: "fallback", why };
  };
  const startedAt = job.started_at ?? now;
  if (!ourAccounts.has(job.owner)) return Promise.resolve(deterministic("job from an account outside this season: no model call"));
  // A job that can no longer finish is not worth a paid call.
  if (startedAt + job.duration_secs + COMPLETE_MARGIN > job.deadline_at) return Promise.resolve(deterministic("cannot finish before its deadline: no model call"));
  if (answeredHashes.has(job.input_hash)) return Promise.resolve(deterministic("this request was already answered in this run: no second model call"));
  const body = requestFor(job);
  if (!body) return Promise.resolve(deterministic("request body not found"));
  if (!useAi || aiDown) return Promise.resolve(deterministic(aiDown ? `NEAR AI stopped: ${aiDown}` : NO_LLM ? "--no-llm" : !ai.apiKey ? "NEAR_AI_API_KEY not set" : "sim without --llm"));
  // Time left in the slot: never spend more waiting for the model than the job can absorb.
  const cutoff = Math.min(startedAt + Math.min(job.duration_secs, MAX_HOLD_SECS), job.deadline_at - 1);
  const slotMs = (cutoff - now) * 1000;
  if (slotMs < 3000) return Promise.resolve(deterministic("too little time left in the slot for a model call"));
  return (async () => {
    let c;
    try {
      // At most two attempts, only on network errors, timeouts, 429 or 5xx, inside the slot.
      c = await chatWithRetry({ ...ai, timeoutMs: 20_000 }, body, { tries: 2, budgetMs: Math.min(40_000, slotMs) });
    } catch (e) {
      noteAiError(e, "worker");
      return deterministic(String(e.message ?? e).slice(0, 160));
    }
    answeredHashes.add(job.input_hash);
    w.chat = { responseBody: c.responseBody };
    const record = (extra: Record<string, unknown>) =>
      writeFileSync(path.join(OUT, "responses", `${job.id}.json`), JSON.stringify({ job: job.id, source: "near-ai", chatId: c.chatId, latencyMs: c.latencyMs, usage: c.usage, requestSha256: sha256hex(body), responseSha256: sha256hex(c.responseBody), response: c.responseBody, ...extra }, null, 2));
    try {
      // The signature may not outlast the slot: bound it by the time left.
      const left = Math.max(1000, Math.min(20_000, (cutoff - (await chain.now())) * 1000));
      const sig = await signature(ai, c.chatId, ai.model, left);
      const chk = attestedArgs(c, sig, ai.model, MODE === "testnet" ? pinned : undefined);
      record({ signature: sig, check: chk });
      if (chk.ok) return { args: { response: c.responseBody, ...chk }, source: "near-ai" };
      return { hash: sha256hex(c.responseBody), source: "near-ai-unattested", why: chk.problems.join("; ") };
    } catch (e) {
      // The answer is real and paid for; only its signature is missing. Commit the answer's own hash.
      noteAiError(e, "worker");
      record({ signature: null, signatureError: String(e.message ?? e).slice(0, 160) });
      return { hash: sha256hex(c.responseBody), source: "near-ai-unsigned", why: String(e.message ?? e).slice(0, 160) };
    }
  })();
}

function beginWork(job: ChainJob, startedAt: number, now: number) {
  const w = { jobId: job.id, startedAt, duration: job.duration_secs, deadline: job.deadline_at } as Work;
  w.settleNow = !ourAccounts.has(job.owner) || startedAt + job.duration_secs + COMPLETE_MARGIN > job.deadline_at;
  w.result = runModel({ ...job, started_at: startedAt }, now, w);
  w.result.then((v) => (w.value = v)).catch(() => undefined);
  work = w;
}

/** v3: the contract stops taking new work 180 s after the operator's last call; an idle worker says it is up. */
const HEARTBEAT_EVERY_SECS = 90;
let lastOperatorCall = 0;

async function workerStep(now: number, running: ChainJob | null, queue: ChainJob[]) {
  if (chain.rules === "v3" && !running && !queue.length && !work && now - lastOperatorCall >= HEARTBEAT_EVERY_SECS) {
    const r = await chain.heartbeat();
    log({ t: rel(now), who: "worker", kind: "heartbeat", ok: r.ok, tx: r.tx, error: r.error });
    if (r.ok) lastOperatorCall = now;
  }
  if (!work && running) {
    // A running job we did not start in this process (resume, or a start whose outcome we could not read).
    beginWork(running, running.started_at ?? now, now);
    log({ t: rel(now), who: "worker", kind: "adopt-running", job: running.id });
  }
  if (!work) {
    await startHead(now, queue);
    return;
  }
  const w = work;
  // An outsider's job or one that cannot finish is settled at once: finishing early only moves later jobs
  // earlier, so it cannot break a deadline (a 24 h job from a stranger must not hold a paid season).
  const hold = Math.min(w.duration, MAX_HOLD_SECS);
  const due = (w.settleNow && w.value) || now >= w.startedAt + Math.max(1, hold - OVERHEAD);
  if (!due) return;
  // Settle once both the time and the answer are in. If the answer is late, wait at most until the declared
  // slot ends (and never past the deadline); then settle with what exists, so the queue does not slide back.
  const cutoff = Math.min(w.startedAt + hold, w.deadline - 1);
  let res = w.value;
  if (!res && now < cutoff) return;
  if (!res && w.chat) {
    // The model answered but its signature did not arrive in time: commit the real, paid answer's hash.
    res = { hash: sha256hex(w.chat.responseBody), source: "near-ai-unsigned", why: "signature late" };
  } else if (!res) {
    const answer = `Deterministic fallback answer for job ${w.jobId} (the model answer did not arrive within the slot).`;
    res = { hash: sha256hex(answer), source: "fallback", why: "model answer late" };
  }
  let r;
  if (res.args && !w.attestedRefused) {
    r = await chain.completeAttested(w.jobId, res.args.response, res.args.signature, res.args.signer, res.args.model);
    log({ t: rel(now), who: "worker", kind: "complete_attested", job: w.jobId, source: res.source, ok: r.ok, tx: r.tx, error: r.error, layer: r.ok ? undefined : r.unknown || r.rejected ? "rpc" : "contract" });
    if (!r.ok && !r.unknown && !r.rejected) w.attestedRefused = true;
  }
  if (!r?.ok && chain.rules === "v3" && (await chain.job(w.jobId).catch(() => null))?.verify === "model") {
    // v3: a model job is paid only for a verified model answer. Without one the operator gives up the job and
    // its owner gets reward + bond back; the operator is paid nothing.
    const why = res.args ? "attested settlement refused" : String(res.why ?? res.source);
    r = await chain.fail(w.jobId, sha256hex(why));
    log({ t: rel(now), who: "worker", kind: "fail", job: w.jobId, source: res.source, why, ok: r.ok, tx: r.tx, error: r.error, layer: r.ok ? undefined : r.unknown || r.rejected ? "rpc" : "contract" });
  } else if (!r?.ok && (!res.args || w.attestedRefused)) {
    const hash = res.args ? sha256hex(res.args.response) : res.hash;
    r = await chain.complete(w.jobId, hash);
    log({ t: rel(now), who: "worker", kind: "complete", job: w.jobId, source: res.args ? "operator-fallback" : res.source, why: res.why, ok: r.ok, tx: r.tx, error: r.error, layer: r.ok ? undefined : r.unknown || r.rejected ? "rpc" : "contract" });
  }
  // Let go of the job only when the chain no longer shows it running; otherwise the next step retries.
  if (!r?.ok) {
    (chain as NearChain).invalidate?.();
    const j = await chain.job(w.jobId).catch(() => null);
    if (!j || j.status === "RUNNING") {
      w.failures = (w.failures ?? 0) + 1;
      if (w.failures === 5 && !aiDown) {
        // The worker cannot settle: every agent call from here on would be wasted money.
        aiDown = `worker stuck on job ${w.jobId}: ${String(r?.error ?? "").slice(0, 100)}`;
        log({ t: rel(now), who: "worker", kind: "near-ai-stopped", ok: false, error: aiDown, layer: "near-ai" });
      }
      return;
    }
  }
  work = null;
  // Start the next job in the same step: waiting for the next poll would cost about 3 s per job.
  if (chain.kind === "testnet") {
    (chain as NearChain).invalidate();
    await startHead(await chain.now(), await chain.queue());
  }
}

/** Why the worker cannot serve this job, or null if it can (v3 refuses such jobs before they start). */
function unservable(job: ChainJob): string | null {
  if (!ourAccounts.has(job.owner)) return "unsupported: job from an account outside this season";
  if (!requestFor(job)) return "unsupported: request body not found or does not match input_hash";
  return null;
}

async function startHead(now: number, queue: ChainJob[]) {
  if (!queue.length) return;
  lastOperatorCall = now;
  const head = queue[0];
  const why = chain.rules === "v3" ? unservable(head) : null;
  if (why) {
    // v3: refuse it instead of running a paid stub. Its owner gets reward + bond back (and any priority spend,
    // from the stake); the next step starts the next head.
    const r = await chain.reject(head.id, why);
    log({ t: rel(now), who: "worker", kind: "reject", job: head.id, why, ok: r.ok, tx: r.tx, error: r.error, layer: r.ok ? undefined : r.unknown || r.rejected ? "rpc" : "contract" });
    return;
  }
  const r = await chain.startNext();
  log({ t: rel(now), who: "worker", kind: "start", job: r.jobId, ok: r.ok, tx: r.tx, error: r.error, layer: r.ok ? undefined : r.unknown || r.rejected ? "rpc" : "contract" });
  if (r.ok && r.jobId != null) {
    // Read the outcome from this transaction's own events: a view right after it can lag a block or two.
    const started = r.events?.find((e) => e.event === "job_started");
    const missed = r.events?.find((e) => e.event === "job_missed");
    if (missed && !started) {
      log({ t: rel(now), who: "worker", kind: "missed-before-start", job: r.jobId });
      return;
    }
    const startedAt = Number(started?.data?.started_at ?? now);
    const known = head.id === r.jobId ? head : await chain.job(r.jobId).catch(() => null);
    if (known) beginWork({ ...known, status: "RUNNING" }, startedAt, now);
    // else: the next step finds it with findRunning() and adopts it.
    return;
  }
  if (r.unknown || /already running/.test(String(r.error))) {
    // The start may have landed without us seeing it: adopt whatever the contract is running.
    const j = await chain.findRunning().catch(() => null);
    if (j) {
      beginWork(j, j.started_at ?? now, now);
      log({ t: rel(now), who: "worker", kind: "adopt-running", job: j.id });
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// Preflight (testnet): each agent's function-call key pays gas from a fixed allowance. A key that runs dry
// turns every action into a slow RPC rejection, so stop before spending any model call.
let wasmSha256: string | null = null;
if (MODE === "testnet") {
  const cfg = readJson("data/season/testnet.json");
  wasmSha256 = cfg.wasmSha256 ?? null;
  const { rpc } = await import("./chain.ts");
  const low: string[] = [];
  for (const p of PERSONAS) {
    const a = cfg.agents[p.id];
    if (!a.functionCallKey) continue;
    try {
      const ak = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: a.accountId, public_key: a.functionCallKey });
      const allowance = ak?.permission?.FunctionCall?.allowance;
      if (allowance != null && BigInt(allowance) < near("0.05")) low.push(`${p.id} (${toNear(BigInt(allowance))} NEAR)`);
    } catch (e) {
      low.push(`${p.id} (key not readable: ${String(e.message ?? e).slice(0, 60)})`);
    }
  }
  if (low.length && !flag("ignore-allowance")) {
    console.error(`function-call key gas allowance below 0.05 NEAR for: ${low.join(", ")}. Re-run setup to re-issue keys, or pass --ignore-allowance.`);
    process.exit(1);
  }
}
if (useAi) {
  const turns = Math.ceil((MINUTES * 60) / TURN_SECS) * PERSONAS.length;
  console.log(`NEAR AI budget guard: at most ${turns} agent calls (fewer: unchanged turns are skipped) plus one worker call per job, up to 2 attempts each.`);
}
writeFileSync(path.join(OUT, "config.json"), JSON.stringify({ run: RUN, mode: MODE, contractId: MODE === "testnet" ? (chain as NearChain).contractId : null, wasmSha256, minutes: MINUTES, turnSecs: TURN_SECS, overheadSecs: OVERHEAD, topUp: TOPUP ? { belowNear: toNear(TOPUP_BELOW), amountNear: toNear(TOPUP_AMOUNT), everySecs: TOPUP_EVERY } : null, rate: RATE, seed: SEED, model: useAi ? ai.model : null, agents: acct, operatorId, pinnedSigners: pinned, startedAt: t0 }, null, 2));
console.log(`QUEUE season ${RUN}: ${MODE}, ${MINUTES} min, ${PERSONAS.length} agents, decisions by ${useAi ? "NEAR AI " + ai.model : "deterministic fallback"}`);

const sim = chain.kind === "sim" ? (chain as SimChain) : null;
let now = t0;
let draining = false;
// A job left RUNNING by an earlier process: finish it first (without a model call if its slot is over).
if (MODE === "testnet") {
  const j = await chain.findRunning().catch(() => null);
  if (j) {
    beginWork(j, j.started_at ?? t0, t0);
    log({ t: 0, who: "worker", kind: "resume-running", job: j.id });
  }
}
// On testnet the worker runs its own loop so agents' transactions never delay a settlement.
let stopWorker = false;
const workerLoop = MODE === "testnet"
  ? (async () => {
      while (!stopWorker) {
        try {
          const n = await chain.now();
          // With no job in hand, ask the contract whether one is running (a start we could not confirm).
          const rj = work ? null : Number((await chain.stats()).running) ? await chain.findRunning() : null;
          await workerStep(n, rj, await chain.queue());
        } catch (e) {
          log({ t: rel(await chain.now().catch(() => t0)), who: "worker", kind: "error", error: String(e.message ?? e).slice(0, 200) });
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })()
  : null;
let summarizing = false;
process.on("SIGINT", () => {
  if (summarizing) process.exit(130);
  summarizing = true;
  console.error("\ninterrupted: writing the summary (Ctrl-C again to quit at once)");
  stopWorker = true;
  writeSummary().finally(() => process.exit(130));
});
while (true) {
  try {
  now = await chain.now();
  lastNow = now;
  if (now >= END && !draining) {
    draining = true;
    log({ t: rel(now), who: "season", kind: "arrivals-closed" });
  }
  const queue = await chain.queue();
  let runningJob: ChainJob | null = null;
  if (work) runningJob = await chain.job(work.jobId);
  // arrivals
  if (!draining) {
    for (const a of agents) {
      while (now >= a.nextArrival) {
        const t = newTask(a.p, a.nextArrival);
        a.pending.push(t);
        log({ t: rel(now), who: a.p.id, kind: "task-arrived", title: t.template.title, duration: t.durationSecs, deadlineIn: t.deadlineSecs, valueNear: toNear(t.valueYocto) });
        a.nextArrival += Math.max(20, Math.round(expo(a.p.arrivalEverySecs / RATE)));
      }
    }
  }
  await principalTopUps(now);
  // agent turns (parallel on testnet, sequential in sim for determinism)
  const due = agents.filter((a) => now >= a.nextTurn);
  for (const a of due) a.nextTurn = now + TURN_SECS + Math.round((rand() - 0.5) * 6);
  if (MODE === "testnet") {
    // Fire and forget, one turn per agent at a time.
    for (const a of due) {
      if (a.busy) continue;
      a.busy = true;
      void agentTurn(a, now, queue, runningJob)
        .catch((e) => log({ t: rel(now), who: a.p.id, kind: "error", error: String(e.message ?? e).slice(0, 200) }))
        .finally(() => (a.busy = false));
    }
  } else {
    for (const a of due) await agentTurn(a, now, queue, runningJob);
    await workerStep(now, work ? null : await chain.findRunning(), await chain.queue()).catch((e) => log({ t: rel(now), who: "worker", kind: "error", error: String(e.message ?? e).slice(0, 200) }));
  }
  // done?
  if (draining) {
    const q = await chain.queue();
    if (!q.length && !work && !agents.some((a) => a.busy)) break;
    if (now > END + 20 * 60) break;
  }
  } catch (e) {
    // A transient RPC failure must never end the season.
    log({ t: rel(now), who: "season", kind: "error", error: String(e.message ?? e).slice(0, 200) });
    if (!sim) await new Promise((r) => setTimeout(r, 3000));
  }
  if (sim) sim.advance(1);
  else await new Promise((r) => setTimeout(r, 3000));
}

stopWorker = true;
await workerLoop;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// Snapshot every job the season touched, as the chain reports it, and write the summary. Also called on Ctrl-C,
// so an interrupted paid run still leaves its numbers behind.
async function writeSummary() {
  const allIds = new Set<number>();
  for (const l of readFileSync(path.join(OUT, "events.jsonl"), "utf8").trim().split("\n")) {
    const e = JSON.parse(l);
    if (typeof e.job === "number") allIds.add(e.job);
  }
  const jobs = [];
  for (const id of [...allIds].sort((a, b) => a - b)) {
    try {
      const j = await chain.job(id);
      // A refused action can name an older job; only this run's jobs belong in its snapshot.
      if (Number(j.submitted_at ?? t0) >= t0) jobs.push(j);
    } catch {
      /* not a job id */
    }
  }
  writeFileSync(path.join(OUT, "jobs.json"), JSON.stringify(jobs, null, 2));

  const events = readFileSync(path.join(OUT, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const dec = events.filter((e) => e.kind === "decision");
  const count = (f) => events.filter(f).length;
  const summary = {
    run: RUN,
    mode: MODE,
    model: useAi ? ai.model : null,
    agents: PERSONAS.length,
    minutes: MINUTES,
    decisions: dec.length,
    decisionsByModel: count((e) => e.kind === "decision" && e.source === "near-ai"),
    jobsSubmitted: count((e) => e.action === "submit" && e.ok),
    priorityPurchases: count((e) => e.action === "buy_priority" && e.ok),
    askChanges: count((e) => e.action === "set_ask" && e.ok),
    cancels: count((e) => e.action === "cancel" && e.ok),
    contractRefusals: count((e) => e.ok === false && e.layer === "contract"),
    runtimeLimitHits: count((e) => e.ok === false && e.layer === "runtime"),
    attestedCompletions: count((e) => e.kind === "complete_attested" && e.ok),
    operatorCompletions: count((e) => e.kind === "complete" && e.ok),
    principalTopUps: count((e) => e.kind === "principal-topup" && e.ok),
    rpcUnknownOrRejected: count((e) => e.ok === false && e.layer === "rpc"),
    turnsSkippedUnchanged: turnsSkipped,
    tasksExpired,
    nearAiStopped: aiDown,
    stats: await chain.stats().catch((e) => ({ error: `stats unreadable: ${String(e.message ?? e).slice(0, 120)}` })),
  };
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log("\nsummary", JSON.stringify(summary, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  return summary;
}

await writeSummary();
