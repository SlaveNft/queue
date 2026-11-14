/**
 * The season's agents: who they are, what they privately know, how they decide.
 *
 * Demand is exogenous (each agent's principal hands it tasks on a random schedule). Strategy is
 * the model's: what to charge for being moved, when to pay to jump, when to wait or cancel.
 * The model only proposes. `clampAction` enforces hard limits in code, the contract enforces
 * the queue rules, and the agent's function-call key can only call five methods and spend
 * only the balance it deposited.
 */
import { extractJson, requestBody } from "./nearai.ts";
import type { ChainJob, Quote } from "./chain.ts";

export const YOCTO = 10n ** 24n;
export const near = (x: number | string) => {
  const [i, f = ""] = String(x).split(".");
  return BigInt(i || "0") * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24) || "0");
};
export const toNear = (y: bigint | string, dp = 5) => (Number(BigInt(y)) / 1e24).toFixed(dp);

export interface TaskTemplate {
  kind: string;
  title: string;
  /** The question the worker model answers. */
  prompt: string;
  durationSecs: [number, number];
  deadlineSecs: [number, number];
  /** What delivering on time is worth to the principal, in NEAR. Private. */
  valueNear: [number, number];
}

export interface Persona {
  id: string;
  name: string;
  /** Short public description, shown in the console. */
  blurb: string;
  /** Private brief the model sees every turn. */
  temperament: string;
  /** Mean seconds between new tasks. */
  arrivalEverySecs: number;
  tasks: TaskTemplate[];
}

const T = (kind: string, title: string, prompt: string, d: [number, number], dl: [number, number], v: [number, number]): TaskTemplate => ({
  kind, title, prompt, durationSecs: d, deadlineSecs: dl, valueNear: v,
});

export const PERSONAS: Persona[] = [
  {
    id: "kestrel", name: "Kestrel", blurb: "Ops agent. Board deadlines, little patience.",
    temperament: "You run operations for a CFO. Late work is worthless to you. You pay to jump when a deadline is at risk, but never more than the work is worth.",
    arrivalEverySecs: 150,
    tasks: [T("brief", "Board brief", "Write a 5-bullet board brief on a 12% drop in weekly active merchants, with one recommended action.", [12, 18], [70, 120], [0.05, 0.09])],
  },
  {
    id: "mira", name: "Mira", blurb: "Research agent. Patient, sells slack.",
    temperament: "You do background research with loose deadlines. Being moved back is income for you if your deadline is safe. Price your patience: raise your ask when you have little slack, lower it when you have a lot.",
    arrivalEverySecs: 110,
    tasks: [T("research", "Literature scan", "List 4 known approaches to fair scheduling of shared GPU inference, one line each, with the main trade-off.", [14, 22], [400, 700], [0.02, 0.035])],
  },
  {
    id: "atlas", name: "Atlas", blurb: "Data agent. Settlement audits on a clock.",
    temperament: "You audit payment settlements. Each audit has a firm cut-off but some slack. You buy priority only when the projected finish would miss your deadline.",
    arrivalEverySecs: 130,
    tasks: [T("audit", "Settlement audit", "Given 3 failed settlements (timeouts at 02:10, 02:14, 02:31 UTC from the same PSP), state the most likely cause and the next check, in 4 lines.", [10, 16], [120, 220], [0.03, 0.06])],
  },
  {
    id: "vale", name: "Vale", blurb: "Comms agent. Launch copy, flexible timing.",
    temperament: "You draft launch copy. Timing is flexible. You like earning from being moved but you will not sell a slot you need.",
    arrivalEverySecs: 120,
    tasks: [T("copy", "Launch note", "Draft a 60-word launch note for a pilot of priority queues for AI agents. Plain words, no hype.", [10, 18], [300, 600], [0.015, 0.03])],
  },
  {
    id: "juno", name: "Juno", blurb: "SRE agent. Incidents arrive hot.",
    temperament: "You handle production incidents. Some are urgent, some are routine summaries. Urgent ones must not wait behind research.",
    arrivalEverySecs: 140,
    tasks: [
      T("incident", "Incident triage", "p95 latency on checkout rose from 180ms to 900ms after deploy 4412; cache hit rate fell 30%. Give the likely cause and 3 ordered steps.", [10, 14], [60, 110], [0.05, 0.1]),
      T("summary", "Latency summary", "Summarize last week's latency incidents for the weekly ops note in 3 bullets.", [12, 18], [400, 700], [0.01, 0.02]),
    ],
  },
  {
    id: "orion", name: "Orion", blurb: "Compliance agent. Tight deadlines, high asks.",
    temperament: "You file compliance checks with hard regulatory deadlines. You keep a high ask so others pay properly to move you, and you never let a move risk your deadline.",
    arrivalEverySecs: 170,
    tasks: [T("compliance", "Sanctions check", "List the 4 checks a payments team runs before onboarding a new merchant in the EU, one line each.", [10, 14], [80, 140], [0.04, 0.07])],
  },
  {
    id: "lyra", name: "Lyra", blurb: "Analytics agent. Bargain hunter.",
    temperament: "You produce analytics digests. You are price-sensitive: you buy priority only when it is cheap relative to the value, and you set a low ask to stay attractive to move.",
    arrivalEverySecs: 120,
    tasks: [T("digest", "KPI digest", "Turn these KPIs into a 3-line digest: GMV +4%, refunds +11%, NPS 41 to 38, CAC flat.", [10, 16], [150, 320], [0.02, 0.04])],
  },
  {
    id: "sable", name: "Sable", blurb: "Trading-desk agent. Will pay for speed.",
    temperament: "You prepare market notes for a trading desk before the open. Speed is worth a lot to you; you pay for priority readily but respect your budget.",
    arrivalEverySecs: 160,
    tasks: [T("market", "Pre-open note", "Write a 4-line pre-open note: rates flat, oil +3%, a large tech earnings beat after hours.", [10, 14], [60, 100], [0.06, 0.12])],
  },
];

// ---------------------------------------------------------------------------
// Private state per job the agent owns (the contract never sees the value).
// ---------------------------------------------------------------------------

export interface OwnTask {
  jobId?: number;
  template: TaskTemplate;
  valueYocto: bigint;
  durationSecs: number;
  deadlineSecs: number;
  requestBody: string;
  inputHash: string;
  arrivedAt: number;
  /** Private cost of one second of waiting, in NEAR; shown to the model only in waiting-cost seasons. */
  waitCostNear?: number;
}

export type Action =
  | { action: "submit"; ask_per_sec_near: number; reason: string }
  | { action: "set_ask"; job_id: number; ask_per_sec_near: number; reason: string }
  | { action: "buy_priority"; job_id: number; latest_start_in_secs: number; max_spend_near: number; reason: string }
  | { action: "cancel"; job_id: number; reason: string }
  | { action: "wait"; reason: string };

export interface Observation {
  now: number;
  balanceYocto: bigint;
  pending?: OwnTask;
  own: Array<{ job: ChainJob; task?: OwnTask; quote?: Quote; quoteCutoff?: number }>;
  queue: ChainJob[];
  running?: ChainJob | null;
  recent: string[];
}

/** Seconds left until a pending task's deadline (the brief's deadline counts from its arrival). */
export const remainingSecs = (t: OwnTask, now: number) => t.deadlineSecs - (now - t.arrivedAt);
/** What submit_job debits from the balance: reward + bond + the job's storage deposit. */
export const SUBMIT_COST_NEAR = 0.01 + 0.005 + 0.017;

export const LIMITS = {
  maxAskNearPerSec: 0.004,
  minAskNearPerSec: 0.00001,
  /** One turn may move an ask at most this factor up or down. */
  maxAskStep: 4,
  /** Keep this much balance for future submissions. */
  reserveNear: 0.03,
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** What the market looks like to a pricing agent: the asks other jobs post, and what purchases actually paid. */
export function marketLine(queue: ChainJob[], selfPrefix: string): string {
  const others = queue.filter((j) => !j.owner.startsWith(selfPrefix));
  const nearPerSec = (j: ChainJob) => Number(BigInt(j.ask_per_sec)) / 1e24;
  const asks = others.map(nearPerSec).sort((a, b) => a - b);
  const fmt = (x: number) => x.toFixed(6);
  if (!asks.length) return "MARKET: no other jobs are waiting.";
  const atCeiling = asks.filter((a) => a >= LIMITS.maxAskNearPerSec * 0.99).length;
  // Jobs that were paid to move back show which asks buyers actually pay.
  const paid = others.filter((j) => BigInt(j.moved_compensation ?? "0") > 0n);
  const paidAsks = paid.map(nearPerSec).sort((a, b) => a - b);
  const paidPart = paid.length
    ? ` ${paid.length} waiting job(s) were already paid to move back, at asks ${fmt(paidAsks[0])}..${fmt(paidAsks[paidAsks.length - 1])}.`
    : " No waiting job has been paid to move back yet.";
  return `MARKET: asks of other waiting jobs (NEAR/s): lowest ${fmt(asks[0])}, median ${fmt(asks[Math.floor(asks.length / 2)])}, highest ${fmt(asks[asks.length - 1])}; ${atCeiling} of ${asks.length} sit at the ${LIMITS.maxAskNearPerSec} ceiling.${paidPart}`;
}

function jobLine(j: ChainJob, now: number, mine: boolean) {
  const slack = j.deadline_at - j.projected_finish_at;
  // Other agents' jobs carry no id: the agent can only act on its own, and ids invited mistakes.
  const who = mine ? `YOUR job #${j.id}` : `${j.owner.split(".")[0]}'s job`;
  return `${who}: pos ${j.position} ${j.duration_secs}s, starts in ${Math.max(0, j.projected_start_at - now)}s, deadline in ${j.deadline_at - now}s, slack ${slack}s, ask ${toNear(j.ask_per_sec, 6)} NEAR/s`;
}

export function buildPrompt(p: Persona, o: Observation, model: string): string {
  const system = [
    `You are ${p.name}, an autonomous agent sharing ONE worker with other agents through QUEUE, a paid slot market on NEAR.`,
    "Rules: jobs run FIFO. Any job owner may buy an earlier slot: every job it jumps moves back by the buyer's duration and is paid that job's own ask (NEAR per second) x the buyer's duration, plus a 1% fee. The contract refuses any jump that would make a jumped job miss its deadline. Your ask is the price others pay to move YOUR job back.",
    `Your private brief: ${p.temperament}`,
    "Late work earns you nothing and your money is refunded. On-time work earns its private value. Spending on priority is a cost. Payments you receive for being moved are income.",
    "Pricing your ask: a buyer passes the cheapest jobs it needs, so an ask far above the others is rarely paid and earns nothing; the ceiling is a limit, not a target. Price it at what a second of delay really costs you, plus the premium you think a buyer will pay; lower it when you have slack and want to be paid for waiting, raise it when you cannot afford to wait.",
    "You may only use set_ask, buy_priority or cancel with a job id listed under YOUR JOBS. A job id from QUEUE is not yours; using it will be rejected.",
    'Answer with ONE JSON object and nothing else. Allowed: {"action":"submit","ask_per_sec_near":n,"reason":"..."} (only if you have a pending task), {"action":"set_ask","job_id":n,"ask_per_sec_near":n,"reason":"..."}, {"action":"buy_priority","job_id":n,"latest_start_in_secs":n,"max_spend_near":n,"reason":"..."}, {"action":"cancel","job_id":n,"reason":"..."}, {"action":"wait","reason":"..."}. Reason: one short sentence.',
  ].join("\n");

  const lines: string[] = [];
  const queuedIds = o.own.filter((x) => x.job.status === "QUEUED").map((x) => x.job.id);
  // First line, so the model cannot miss which ids it may act on.
  lines.push(`YOUR_QUEUED_JOB_IDS: [${queuedIds.join(", ")}]`);
  lines.push(`Now: t=${o.now}. Your balance: ${toNear(o.balanceYocto)} NEAR.`);
  if (o.pending) {
    const t = o.pending;
    const waiting = t.waitCostNear != null ? ` Every second until it is done costs you ${t.waitCostNear.toFixed(6)} NEAR of that value.` : "";
    lines.push(`PENDING TASK (not yet submitted): "${t.template.title}", ${t.durationSecs}s of work, deadline in ${remainingSecs(t, o.now)}s, worth ${toNear(t.valueYocto)} NEAR to you if on time.${waiting} Submitting costs reward+bond+storage ≈ ${toNear(near(0.01) + near(0.005) + near(0.017))} NEAR (bond returned on delivery; storage refunded when the finished job is released). Choose its ask.`);
  }
  const mineQueued = o.own.filter((x) => x.job.status === "QUEUED").map((x) => x.job.id);
  lines.push(mineQueued.length ? `You may only act on YOUR job ids: ${mineQueued.map((i) => "#" + i).join(", ")}. Every other job belongs to another agent.` : "You have no queued jobs.");
  if (o.own.length) {
    lines.push("YOUR JOBS:");
    for (const { job, task, quote, quoteCutoff } of o.own) {
      let l = `- ${jobLine(job, o.now, true)}`;
      if (task) l += `, worth ${toNear(task.valueYocto)} NEAR if on time`;
      if (task?.waitCostNear != null) l += `, waiting costs you ${task.waitCostNear.toFixed(6)} NEAR/s`;
      if (job.status === "RUNNING") l += " [RUNNING]";
      lines.push(l);
      if (quote && quoteCutoff !== undefined) {
        lines.push(quote.feasible
          ? `  quote to start within ${quoteCutoff - o.now}s: jump ${quote.displaced.length} job(s) for ${toNear(quote.total, 6)} NEAR (+storage ${toNear(near(0.006) + near(0.003) * BigInt(quote.displaced.length), 3)}), would finish with ${job.deadline_at - quote.projected_finish_at}s to spare`
          : `  quote to start within ${quoteCutoff - o.now}s: REFUSED by the rules (${quote.reason})`);
      }
    }
  }
  lines.push(`QUEUE (${o.queue.length} waiting${o.running ? `, #${o.running.id} running` : ""}):`);
  for (const j of o.queue.slice(0, 14)) lines.push(`- ${jobLine(j, o.now, j.owner.startsWith(p.id + "."))}`);
  if (o.queue.length > 14) lines.push(`- … ${o.queue.length - 14} more`);
  lines.push(marketLine(o.queue, p.id + "."));
  if (o.recent.length) lines.push(`RECENT: ${o.recent.slice(-6).join(" | ")}`);
  lines.push("Decide your single best action now.");
  return requestBody(model, system, lines.join("\n"), { temperature: 0.5, maxTokens: 300, json: true });
}

// ---------------------------------------------------------------------------
// Parsing + hard limits
// ---------------------------------------------------------------------------

export function parseAction(text: string): Action | string {
  const j = extractJson(text) as Record<string, unknown> | undefined;
  if (!j || typeof j !== "object") return "answer is not a JSON object";
  const reason = String(j.reason ?? "").slice(0, 200);
  // Models sometimes write "#62" or "0.001 NEAR"; keep the number.
  const num = (k: string) => {
    if (typeof j[k] !== "string") return Number(j[k]);
    const m = String(j[k]).match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/i);
    return m ? Number(m[0]) : NaN;
  };
  switch (j.action) {
    case "submit":
      return Number.isFinite(num("ask_per_sec_near")) ? { action: "submit", ask_per_sec_near: num("ask_per_sec_near"), reason } : "submit needs ask_per_sec_near";
    case "set_ask":
      return Number.isInteger(num("job_id")) && Number.isFinite(num("ask_per_sec_near")) ? { action: "set_ask", job_id: num("job_id"), ask_per_sec_near: num("ask_per_sec_near"), reason } : "set_ask needs job_id and ask_per_sec_near";
    case "buy_priority":
      return Number.isInteger(num("job_id")) && Number.isFinite(num("latest_start_in_secs")) && Number.isFinite(num("max_spend_near"))
        ? { action: "buy_priority", job_id: num("job_id"), latest_start_in_secs: num("latest_start_in_secs"), max_spend_near: num("max_spend_near"), reason }
        : "buy_priority needs job_id, latest_start_in_secs, max_spend_near";
    case "cancel":
      return Number.isInteger(num("job_id")) ? { action: "cancel", job_id: num("job_id"), reason } : "cancel needs job_id";
    case "wait":
      return { action: "wait", reason };
    default:
      return `unknown action ${String(j.action)}`;
  }
}

/**
 * Code-side limits. Returns the action to execute (possibly clamped, with a note) or a
 * refusal string. These are policy limits of the agent runtime; the contract's rules are
 * separate and are NOT pre-checked here, so a model that proposes an unsafe jump is refused
 * on chain, in public.
 */
export function clampAction(a: Action, o: Observation): { action: Action; note?: string } | string {
  const ownIds = new Set(o.own.map((x) => x.job.id));
  const clampAsk = (x: number, prev?: number) => {
    let v = Math.min(LIMITS.maxAskNearPerSec, Math.max(LIMITS.minAskNearPerSec, x));
    if (prev && prev > 0) v = Math.min(prev * LIMITS.maxAskStep, Math.max(prev / LIMITS.maxAskStep, v));
    return v;
  };
  switch (a.action) {
    case "submit": {
      if (!o.pending) return "no pending task to submit";
      // The contract would refuse it ("balance too low"); stop it here instead of paying for a failed transaction.
      if (Number(o.balanceYocto) / 1e24 < SUBMIT_COST_NEAR) return `balance below the submit cost (${SUBMIT_COST_NEAR} NEAR)`;
      const v = clampAsk(a.ask_per_sec_near);
      return { action: { ...a, ask_per_sec_near: v }, note: v !== a.ask_per_sec_near ? `ask clamped to ${v}` : undefined };
    }
    case "set_ask": {
      if (!ownIds.has(a.job_id) && o.pending) {
        // The model priced its pending task with the wrong verb: that is a submission at this ask.
        const r = clampAction({ action: "submit", ask_per_sec_near: a.ask_per_sec_near, reason: a.reason }, o);
        if (typeof r === "string") return r;
        return { action: r.action, note: `set_ask on unknown job #${a.job_id} read as submit of the pending task${r.note ? "; " + r.note : ""}` };
      }
      const queuedOwn = o.own.filter((x) => x.job.status === "QUEUED");
      if (!ownIds.has(a.job_id) && queuedOwn.length === 0) return { action: { action: "wait", reason: a.reason }, note: `set_ask on job #${a.job_id} with no own queued job read as wait` };
      if (!ownIds.has(a.job_id) && queuedOwn.length === 1) {
        const fixed = queuedOwn[0].job.id;
        return clampAction({ ...a, job_id: fixed }, o) as never;
      }
      if (!ownIds.has(a.job_id)) return `job ${a.job_id} is not yours`;
      const job = o.own.find((x) => x.job.id === a.job_id)!.job;
      if (job.status !== "QUEUED") return `job ${a.job_id} is not queued`;
      const prev = Number(BigInt(job.ask_per_sec)) / 1e24;
      const v = clampAsk(a.ask_per_sec_near, prev);
      // Re-stating the current ask is a decision to keep it, not an error.
      if (Math.abs(v - prev) < 1e-9) return { action: { action: "wait", reason: a.reason || "keep the current ask" } };
      return { action: { ...a, ask_per_sec_near: v }, note: v !== a.ask_per_sec_near ? `ask clamped to ${v}` : undefined };
    }
    case "buy_priority": {
      const queuedOwnB = o.own.filter((x) => x.job.status === "QUEUED");
      if (!ownIds.has(a.job_id) && queuedOwnB.length === 1) {
        // Same repair as set_ask: with one queued job, the model meant that one.
        const r = clampAction({ ...a, job_id: queuedOwnB[0].job.id }, o);
        if (typeof r === "string") return r;
        return { action: r.action, note: `buy_priority on job #${a.job_id} read as your only queued job #${queuedOwnB[0].job.id}${r.note ? "; " + r.note : ""}` };
      }
      if (!ownIds.has(a.job_id)) return `job ${a.job_id} is not yours`;
      const own = o.own.find((x) => x.job.id === a.job_id)!;
      if (own.job.status !== "QUEUED") return `job ${a.job_id} is not queued`;
      // The contract charges total + priority storage; a cap that ignores storage can
      // promise more than the balance covers. Keep the all-in cap below value/balance.
      // Pre-filter only: storage grows with every job jumped, and the runtime re-prices the exact jump from a fresh
      // quote before sending. Here assume the quote the agent saw, or at least one job.
      const displaced = Math.max(own.quote?.displaced.length ?? 0, 1);
      const storage = 0.006 + 0.003 * displaced;
      // Repeated purchases for one job share its value: subtract what was already spent on it.
      const spent = Number(BigInt(own.job.priority_spend ?? "0")) / 1e24;
      const cap = own.task ? Math.max(0, Number(own.task.valueYocto) / 1e24 - storage - spent) : 0.05;
      const spendable = Math.max(0, Number(o.balanceYocto) / 1e24 - LIMITS.reserveNear - storage - 0.02);
      const max = Math.min(a.max_spend_near, cap, spendable);
      if (max <= 0) return "no budget left for priority after storage";
      // Bounded by the job's own deadline: a huge number would also serialize as 1e+30, which the contract cannot parse.
      const within = Math.min(Math.max(0, Math.round(a.latest_start_in_secs)), Math.max(0, own.job.deadline_at - o.now));
      return { action: { ...a, latest_start_in_secs: within, max_spend_near: max }, note: max !== a.max_spend_near ? `max spend capped at ${max.toFixed(5)} (value/balance after ${storage.toFixed(5)} storage)` : undefined };
    }
    case "cancel":
      return ownIds.has(a.job_id) ? { action: a } : `job ${a.job_id} is not yours`;
    case "wait":
      return { action: a };
  }
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no key, or the model answer was unusable)
// ---------------------------------------------------------------------------

export function fallbackAction(p: Persona, o: Observation): Action {
  if (o.pending && Number(o.balanceYocto) / 1e24 >= SUBMIT_COST_NEAR) {
    const slackRatio = remainingSecs(o.pending, o.now) / Math.max(1, o.pending.durationSecs);
    const ask = slackRatio > 20 ? 0.0002 : slackRatio > 8 ? 0.0006 : 0.0015;
    return { action: "submit", ask_per_sec_near: ask, reason: `fallback: ask from slack ratio ${slackRatio.toFixed(0)}` };
  }
  for (const { job, task, quote, quoteCutoff } of o.own) {
    if (job.status !== "QUEUED" || !task) continue;
    const late = job.projected_finish_at > job.deadline_at;
    if (late && quote?.feasible && quote.displaced.length && quoteCutoff !== undefined) {
      const total = Number(BigInt(quote.total)) / 1e24;
      const value = Number(task.valueYocto) / 1e24;
      if (total < value * 0.6) {
        return { action: "buy_priority", job_id: job.id, latest_start_in_secs: quoteCutoff - o.now, max_spend_near: total * 1.15, reason: "fallback: projected late, quote below 60% of value" };
      }
    }
    const slack = job.deadline_at - job.projected_finish_at;
    const ask = Number(BigInt(job.ask_per_sec)) / 1e24;
    if (slack < job.duration_secs * 2 && ask < 0.002) {
      return { action: "set_ask", job_id: job.id, ask_per_sec_near: ask * 2, reason: "fallback: little slack, raise ask" };
    }
  }
  return { action: "wait", reason: "fallback: nothing worth doing" };
}
