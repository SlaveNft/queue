import {
  formatNear,
  moveJob,
  onTimeBps,
  parseNear,
  projectSchedule,
  quotePriority,
  type Artifact,
  type Job,
  type LedgerEvent,
  type PriorityRecord,
  type Quote,
  type QueueState,
  type Scenario,
  type Stats,
} from "@queue/core";
import { AGENTS, AGENT_BY_ID, agentAccount, agentName, assertAgent } from "./agents.js";
import { LIMITS } from "./limits.js";
import { sha256Hex } from "./sha256.js";
import { STANDBY_SEEDS, URGENT_SEED, type JobSeed } from "./fixtures.js";

interface YoctoSeed extends Omit<JobSeed, "rewardNear" | "bondNear" | "askPerSecNear"> {
  rewardYocto: string;
  bondYocto: string;
  askPerSecYocto: string;
}

function toYoctoSeed(seed: JobSeed): YoctoSeed {
  return {
    ownerId: seed.ownerId,
    task: seed.task,
    title: seed.title,
    brief: seed.brief,
    input: seed.input,
    durationSec: seed.durationSec,
    deadlineInSec: seed.deadlineInSec,
    rewardYocto: parseNear(seed.rewardNear).toString(),
    bondYocto: parseNear(seed.bondNear).toString(),
    askPerSecYocto: parseNear(seed.askPerSecNear).toString(),
  };
}
import { buildArtifact } from "./tasks.js";

export class QueueError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "BAD_REQUEST",
  ) {
    super(message);
    this.name = "QueueError";
  }
}

interface PersistedState {
  schemaVersion: 1;
  sessionId: string;
  seq: number;
  prioritySeq: number;
  jobs: Job[];
  queueIds: string[];
  runningId: string | null;
  credits: Record<string, string>;
  balances: Record<string, string>;
  treasuryYocto: string;
  stats: Stats;
  activity: LedgerEvent[];
  activitySeq: number;
  scenario: Scenario;
  priorities: PriorityRecord[];
  artifacts: Artifact[];
  /** True once a user (not the scripted scenario) changed the queue. */
  dirty?: boolean;
}

export interface EngineHealth {
  db: "ok" | "degraded";
  lastPersistedAt: number | null;
  lastPersistError: string | null;
  persistFailures: number;
  storageWritable: boolean;
}

export interface CreateJobInput {
  ownerId: string;
  task: Job["task"];
  title: string;
  brief: string;
  input: string;
  durationSec: number;
  deadlineInSec: number;
  rewardYocto: string;
  bondYocto: string;
  askPerSecYocto: string;
}

/**
 * Where the ledger keeps its one JSON snapshot. The API server passes a SQLite
 * store; a browser tab uses the default in-memory store.
 */
export interface SnapshotStore {
  load(): string | null;
  save(json: string, updatedAtIso: string): void;
  close(): void;
}

export function memoryStore(): SnapshotStore {
  let snapshot: string | null = null;
  return {
    load: () => snapshot,
    save: (json) => {
      snapshot = json;
    },
    close: () => {
      snapshot = null;
    },
  };
}

type Timer = ReturnType<typeof setTimeout>;

/** Node keeps a process alive for a pending timer; a browser timer has no `unref`. */
function unref(timer: Timer): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // `randomUUID` needs a secure context; plain-http pages still have `getRandomValues`.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(b, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface EngineOptions {
  store?: SnapshotStore;
  clock?: () => number;
  seed?: boolean;
  /** Test seam: lets a test force an artifact whose hash does not match. */
  artifactFactory?: (job: Job) => Artifact;
}

/** Re-anchor an untouched standby queue this long before a deadline would break. */
const STANDBY_SAFETY_MS = 30_000;

/** Consecutive persist failures after which explicit mutations are refused. */
const STORAGE_FAILURE_LIMIT = 3;

const SHA256_HEX = /^[0-9a-f]{64}$/;

const SERVICE = {
  name: "Brief Desk",
  blurb: "One owned worker. Three task types. Every move priced.",
  operator: "worker.queue-demo.testnet",
  feeBps: 100,
};

const STEP_TEMPLATE = [
  { key: "arrival", label: "Kestrel's board brief arrives late", done: false },
  { key: "quote", label: "Quote finds the latest feasible jump", done: false },
  { key: "purchase", label: "Four slots are bought at their published ask", done: false },
  { key: "work", label: "Operator runs the 12-second brief", done: false },
  { key: "settled", label: "Artifact lands before the deadline", done: false },
];

function freshStats(): Stats {
  return {
    submitted: 0,
    completed: 0,
    missed: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    queued: 0,
    moves: 0,
    totalPriorityYocto: "0",
    totalCompensationYocto: "0",
    totalFeesYocto: "0",
    onTimeBps: 10_000,
  };
}

function freshScenario(): Scenario {
  return {
    id: randomUUID(),
    name: "Board-call scenario",
    status: "idle",
    phase: "standby",
    steps: STEP_TEMPLATE.map((step) => ({ ...step })),
  };
}

function freshState(): PersistedState {
  return {
    schemaVersion: 1,
    sessionId: randomUUID(),
    seq: 1000,
    prioritySeq: 0,
    jobs: [],
    queueIds: [],
    runningId: null,
    credits: {},
    balances: {
      kestrel: parseNear("0.5").toString(),
      mira: parseNear("1").toString(),
      atlas: parseNear("1").toString(),
      vale: parseNear("1").toString(),
      juno: parseNear("1").toString(),
      operator: parseNear("0.1").toString(),
      auditor: "0",
    },
    treasuryYocto: "0",
    stats: freshStats(),
    activity: [],
    activitySeq: 0,
    scenario: freshScenario(),
    priorities: [],
    artifacts: [],
    dirty: false,
  };
}

function isJobDone(job: Job): boolean {
  return ["done", "missed", "cancelled", "failed"].includes(job.status);
}

export class LedgerEngine {
  private state: PersistedState;
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, Timer>();
  private readonly scenarioTimers = new Set<Timer>();
  private scenarioToken = 0;
  /** Scenario token whose remaining queue the worker keeps draining. */
  private drainToken: number | null = null;
  private store: SnapshotStore | null;
  private readonly clock: () => number;
  private readonly artifactFactory: (job: Job) => Artifact;
  private lastPersistedAt: number | null = null;
  private lastPersistError: string | null = null;
  private persistFailures = 0;
  /** True while the built-in scenario is mutating state; those writes are not user activity. */
  private scenarioActing = false;

  constructor(options: EngineOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.artifactFactory = options.artifactFactory ?? buildArtifact;
    this.store = options.store ?? memoryStore();
    const loaded = this.load();
    this.state = loaded ?? freshState();
    if (!this.state.balances) {
      const fresh = freshState();
      this.state.balances = fresh.balances;
      this.state.treasuryYocto = "0";
    }
    // Snapshots written before these fields existed stay readable.
    if (!this.state.stats) this.state.stats = freshStats();
    if (typeof this.state.stats.failed !== "number") this.state.stats.failed = 0;
    if (typeof this.state.dirty !== "boolean") this.state.dirty = this.deriveDirty();
    if (!loaded && options.seed !== false) {
      this.seedStandby(false);
    }
    this.recover();
    this.maybeRecycle();
    this.persist();
  }

  private load(): PersistedState | null {
    if (!this.store) return null;
    try {
      const json = this.store.load();
      if (!json) return null;
      const parsed = JSON.parse(json) as PersistedState;
      if (parsed.schemaVersion !== 1) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private persist(): boolean {
    if (!this.store) return false;
    try {
      this.store.save(JSON.stringify(this.state), new Date(this.clock()).toISOString());
      this.lastPersistedAt = this.now();
      this.lastPersistError = null;
      this.persistFailures = 0;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.persistFailures += 1;
      this.lastPersistError = message;
      console.error(
        JSON.stringify({
          level: "error",
          event: "persist_failed",
          failures: this.persistFailures,
          message,
        }),
      );
      return false;
    }
  }

  /** Real persistence health, not a constant `"ok"`. */
  health(): EngineHealth {
    const storageWritable = this.storageWritable();
    return {
      db: storageWritable && this.store ? "ok" : "degraded",
      lastPersistedAt: this.lastPersistedAt,
      lastPersistError: this.lastPersistError,
      persistFailures: this.persistFailures,
      storageWritable,
    };
  }

  private storageWritable(): boolean {
    return this.persistFailures < STORAGE_FAILURE_LIMIT;
  }

  private assertStorage(): void {
    if (!this.storageWritable()) {
      throw new QueueError(
        "Local storage is unavailable; mutations are paused until a write succeeds.",
        503,
        "STORAGE_UNAVAILABLE",
      );
    }
  }

  /** An old snapshot may not carry the explicit flag; infer it from the ledger. */
  private deriveDirty(): boolean {
    const activity = this.state.activity ?? [];
    const submitted = activity.filter((event) => event.type === "job.submitted").length;
    if (submitted > STANDBY_SEEDS.length) return true;
    return activity.some(
      (event) => event.type !== "scenario.phase" && event.type !== "job.submitted",
    );
  }

  private noteUserAction(): void {
    if (!this.scenarioActing) this.state.dirty = true;
  }

  private emit(): void {
    this.persist();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A broken SSE client must never break a settlement.
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private now(): number {
    return this.clock();
  }

  private findJob(id: string): Job {
    const job = this.state.jobs.find((item) => item.id === id);
    if (!job) throw new QueueError(`Job ${id} does not exist.`, 404, "JOB_NOT_FOUND");
    return job;
  }

  private queuedJobs(): Job[] {
    const map = new Map(this.state.jobs.map((job) => [job.id, job]));
    return this.state.queueIds
      .map((id) => map.get(id))
      .filter((job): job is Job => Boolean(job && job.status === "queued"));
  }

  private runningJob(): Job | null {
    return this.state.runningId
      ? this.state.jobs.find((job) => job.id === this.state.runningId) ?? null
      : null;
  }

  private log(
    type: string,
    actor: string,
    summary: string,
    extra: Partial<LedgerEvent> = {},
  ): void {
    this.state.activitySeq += 1;
    const event: LedgerEvent = {
      id: `E-${String(this.state.activitySeq).padStart(4, "0")}`,
      at: this.now(),
      type,
      actor,
      summary,
      ...extra,
    };
    this.state.activity.unshift(event);
    if (this.state.activity.length > LIMITS.activityLimit) {
      this.state.activity.length = LIMITS.activityLimit;
    }
  }

  private nextJobId(): string {
    this.state.seq += 1;
    return `J-${this.state.seq}`;
  }

  private buildJob(seed: YoctoSeed): Job {
    const owner = assertAgent(seed.ownerId);
    if (owner.role !== "buyer" && owner.role !== "slot-holder") {
      throw new QueueError("This agent cannot own a job.", 400, "BAD_OWNER");
    }
    const now = this.now();
    const id = this.nextJobId();
    const escrow = BigInt(seed.rewardYocto) + BigInt(seed.bondYocto);
    const balance = BigInt(this.state.balances[owner.id] ?? "0");
    if (balance < escrow) {
      throw new QueueError(
        `${owner.name}'s rehearsal balance is too low for this escrow.`,
        402,
        "INSUFFICIENT_BALANCE",
      );
    }
    this.state.balances[owner.id] = (balance - escrow).toString();
    const job: Job = {
      id,
      seq: this.state.seq,
      title: seed.title.trim(),
      task: seed.task,
      ownerId: owner.id,
      ownerAccount: agentAccount(owner.id),
      brief: seed.brief.trim(),
      input: seed.input,
      durationSec: seed.durationSec,
      submittedAt: now,
      deadlineAt: now + seed.deadlineInSec * 1000,
      rewardYocto: seed.rewardYocto,
      bondYocto: seed.bondYocto,
      askPerSecYocto: seed.askPerSecYocto,
      status: "queued",
      expedited: false,
      prioritySpendYocto: "0",
      movedCompensationYocto: "0",
      moves: [],
    };
    this.state.jobs.push(job);
    this.state.queueIds.push(job.id);
    this.state.stats.submitted += 1;
    this.log("job.submitted", owner.name, `${owner.name} joined the queue with ${job.title}.`, {
      jobId: job.id,
      amountYocto: job.rewardYocto,
      meta: {
        durationSec: job.durationSec,
        askPerSecYocto: job.askPerSecYocto,
        deadlineAt: job.deadlineAt,
      },
    });
    return job;
  }

  private seedStandby(emit = true): void {
    for (const seed of STANDBY_SEEDS) {
      this.buildJob(toYoctoSeed(seed));
    }
    this.state.scenario = freshScenario();
    if (emit) this.emit();
  }

  getState(): QueueState {
    const queue = this.queuedJobs();
    const running = this.runningJob();
    const recent = this.state.jobs
      .filter(isJobDone)
      .sort((a, b) => (b.finishedAt ?? b.submittedAt) - (a.finishedAt ?? a.submittedAt))
      .slice(0, LIMITS.recentLimit);
    const credits: Record<string, string> = {};
    const balances: Record<string, string> = {};
    for (const agent of AGENTS) {
      credits[agent.id] = this.state.credits[agent.id] ?? "0";
      balances[agent.id] = this.state.balances[agent.id] ?? "0";
    }
    const stats = this.computeStats(queue.length, Boolean(running));
    const schedule = projectSchedule(queue, running, this.now());
    const queueWithSlots = queue.map((job, index) => ({
      ...job,
      projectedStartAt: schedule[index]?.startAt,
      projectedFinishAt: schedule[index]?.finishAt,
    }));
    return {
      schemaVersion: 1,
      sessionId: this.state.sessionId,
      mode: "local",
      now: this.now(),
      service: SERVICE,
      agents: AGENTS,
      running,
      queue: queueWithSlots,
      recent,
      credits,
      balances,
      treasuryYocto: this.state.treasuryYocto,
      stats,
      activity: this.state.activity,
      scenario: this.state.scenario,
      untouched:
        !this.state.dirty && this.state.scenario.status === "idle" && !running,
      network: {
        mode: "local",
        label: "Local settlement ledger",
        note:
          "The console executes the same rules as the NEAR contract on a local ledger. On-chain proof is shown separately; local rows are not blockchain transactions.",
      },
    };
  }

  private computeStats(queued: number, running: boolean): Stats {
    const stats = { ...this.state.stats };
    stats.queued = queued;
    stats.running = running ? 1 : 0;
    stats.onTimeBps = onTimeBps(stats.completed, stats.missed);
    return stats;
  }

  private validateSeed(input: CreateJobInput): void {
    if (input.title.trim().length < LIMITS.titleMin || input.title.length > LIMITS.titleMax) {
      throw new QueueError(
        `Title must be ${LIMITS.titleMin}–${LIMITS.titleMax} characters.`,
        400,
        "BAD_TITLE",
      );
    }
    if (input.brief.trim().length < LIMITS.briefMin || input.brief.length > LIMITS.briefMax) {
      throw new QueueError(
        `Brief must be ${LIMITS.briefMin}–${LIMITS.briefMax} characters.`,
        400,
        "BAD_BRIEF",
      );
    }
    if (input.input.length > LIMITS.inputMax) {
      throw new QueueError("Input is too large.", 413, "INPUT_TOO_LARGE");
    }
    if (input.input.trim().length === 0) {
      throw new QueueError("Input cannot be empty; the worker needs material to analyse.", 400, "BAD_INPUT");
    }
    if (
      !Number.isInteger(input.durationSec) ||
      input.durationSec < LIMITS.durationMinSec ||
      input.durationSec > LIMITS.durationMaxSec
    ) {
      throw new QueueError(
        `Duration must be ${LIMITS.durationMinSec}–${LIMITS.durationMaxSec} seconds.`,
        400,
        "BAD_DURATION",
      );
    }
    if (
      !Number.isInteger(input.deadlineInSec) ||
      input.deadlineInSec < LIMITS.deadlineMinSec ||
      input.deadlineInSec > LIMITS.deadlineMaxSec
    ) {
      throw new QueueError(
        `Deadline must be ${LIMITS.deadlineMinSec}–${LIMITS.deadlineMaxSec} seconds from now.`,
        400,
        "BAD_DEADLINE",
      );
    }
    const reward = BigInt(input.rewardYocto);
    const bond = BigInt(input.bondYocto);
    const ask = BigInt(input.askPerSecYocto);
    if (reward < LIMITS.rewardMinYocto || reward > LIMITS.rewardMaxYocto) {
      throw new QueueError("Reward is outside the demo limit (0.001–1 NEAR).", 400, "BAD_REWARD");
    }
    if (bond < LIMITS.bondMinYocto || bond > LIMITS.bondMaxYocto) {
      throw new QueueError("Bond is outside the demo limit (0.001–1 NEAR).", 400, "BAD_BOND");
    }
    if (ask < 0n || ask > LIMITS.askMaxYoctoPerSec) {
      throw new QueueError("Ask is outside the demo limit (0–0.01 NEAR/s).", 400, "BAD_ASK");
    }
    if (this.state.queueIds.length >= LIMITS.queueLimit) {
      throw new QueueError("The queue is full for this demo.", 409, "QUEUE_FULL");
    }
    if (input.task !== "incident-triage" && input.task !== "csv-audit" && input.task !== "launch-brief") {
      throw new QueueError("Unknown task type.", 400, "BAD_TASK");
    }
  }

  createJob(input: CreateJobInput): Job {
    this.assertStorage();
    this.validateSeed(input);
    this.noteUserAction();
    const job = this.buildJob({
      ownerId: input.ownerId,
      task: input.task,
      title: input.title,
      brief: input.brief,
      input: input.input,
      durationSec: input.durationSec,
      deadlineInSec: input.deadlineInSec,
      rewardYocto: input.rewardYocto,
      bondYocto: input.bondYocto,
      askPerSecYocto: input.askPerSecYocto,
    });
    this.emit();
    return job;
  }

  quote(jobId: string, latestStartAt: number): Quote {
    const job = this.findJob(jobId);
    if (job.status !== "queued") {
      throw new QueueError("Only queued jobs can be quoted.", 409, "NOT_QUEUED");
    }
    return quotePriority({
      queue: this.queuedJobs(),
      running: this.runningJob(),
      jobId,
      latestStartAt,
      now: this.now(),
      feeBps: SERVICE.feeBps,
    });
  }

  buyPriority(
    jobId: string,
    latestStartAt: number,
    maxSpendYocto: string,
  ): { quote: Quote; priority: PriorityRecord; job: Job } {
    this.assertStorage();
    const quote = this.quote(jobId, latestStartAt);
    if (!quote.feasible) {
      throw new QueueError(quote.reason, 409, "INFEASIBLE");
    }
    if (quote.insertIndex === -1 || quote.displaced.length === 0) {
      throw new QueueError("This job already meets the cutoff; no purchase is needed.", 409, "NO_PURCHASE_NEEDED");
    }
    const maxSpend = BigInt(maxSpendYocto);
    if (maxSpend < BigInt(quote.totalYocto)) {
      throw new QueueError(
        `Budget ${formatNear(maxSpendYocto)} is below the quote ${formatNear(quote.totalYocto)}.`,
        402,
        "BUDGET_TOO_LOW",
      );
    }
    if (maxSpend > LIMITS.maxSpendYocto) {
      throw new QueueError("Budget is above the demo limit.", 400, "BAD_BUDGET");
    }
    const buyerBalance = BigInt(this.state.balances[this.findJob(jobId).ownerId] ?? "0");
    const total = BigInt(quote.totalYocto);
    if (buyerBalance < total) {
      throw new QueueError(
        `Rehearsal balance ${formatNear(buyerBalance)} is below the priority total ${formatNear(total)}.`,
        402,
        "INSUFFICIENT_BALANCE",
      );
    }
    this.state.balances[this.findJob(jobId).ownerId] = (buyerBalance - total).toString();
    this.noteUserAction();

    const urgent = this.findJob(jobId);
    const at = this.now();
    this.state.prioritySeq += 1;
    const priority: PriorityRecord = {
      id: `P-${String(this.state.prioritySeq).padStart(4, "0")}`,
      jobId,
      at,
      insertIndex: quote.insertIndex,
      compensationYocto: quote.compensationYocto,
      feeYocto: quote.feeYocto,
      totalYocto: quote.totalYocto,
      latestStartAt,
      displaced: quote.displaced.map((item) => ({
        jobId: item.jobId,
        ownerId: item.ownerId,
        amountYocto: item.amountYocto,
        delaySec: item.delaySec,
      })),
    };
    this.state.priorities.push(priority);

    const moved = moveJob(this.queuedJobs(), jobId, quote.insertIndex);
    this.state.queueIds = moved.map((job) => job.id);

    for (const movedJob of quote.displaced) {
      const displaced = this.findJob(movedJob.jobId);
      displaced.moves.push({
        byJobId: jobId,
        amountYocto: movedJob.amountYocto,
        delaySec: movedJob.delaySec,
        at,
      });
      displaced.movedCompensationYocto = (
        BigInt(displaced.movedCompensationYocto) + BigInt(movedJob.amountYocto)
      ).toString();
      this.state.credits[displaced.ownerId] = (
        BigInt(this.state.credits[displaced.ownerId] ?? "0") + BigInt(movedJob.amountYocto)
      ).toString();
      this.log(
        "slot.paid",
        agentName(displaced.ownerId),
        `${agentName(displaced.ownerId)} moved back ${movedJob.delaySec}s and was paid ${formatNear(movedJob.amountYocto)}.`,
        {
          jobId: displaced.id,
          amountYocto: movedJob.amountYocto,
          meta: { byJobId: jobId, priorityId: priority.id },
        },
      );
    }

    this.state.treasuryYocto = (
      BigInt(this.state.treasuryYocto) + BigInt(quote.feeYocto)
    ).toString();
    urgent.expedited = true;
    urgent.priorityId = priority.id;
    urgent.prioritySpendYocto = (
      BigInt(urgent.prioritySpendYocto) + BigInt(quote.totalYocto)
    ).toString();
    this.state.stats.moves += quote.displaced.length;
    this.state.stats.totalPriorityYocto = (
      BigInt(this.state.stats.totalPriorityYocto) + BigInt(quote.totalYocto)
    ).toString();
    this.state.stats.totalCompensationYocto = (
      BigInt(this.state.stats.totalCompensationYocto) + BigInt(quote.compensationYocto)
    ).toString();
    this.state.stats.totalFeesYocto = (
      BigInt(this.state.stats.totalFeesYocto) + BigInt(quote.feeYocto)
    ).toString();

    this.log(
      "priority.bought",
      agentName(urgent.ownerId),
      `${agentName(urgent.ownerId)} bought slot ${quote.insertIndex} for ${formatNear(quote.totalYocto)}; ${quote.displaced.length} deadlines re-checked.`,
      {
        jobId,
        amountYocto: quote.totalYocto,
        meta: {
          priorityId: priority.id,
          compensationYocto: quote.compensationYocto,
          feeYocto: quote.feeYocto,
          displaced: quote.displaced.map((item) => item.jobId),
          latestStartAt,
        },
      },
    );

    this.advanceScenario("purchase");
    this.emit();
    return { quote, priority, job: urgent };
  }

  setAsk(jobId: string, askPerSecYocto: string): Job {
    this.assertStorage();
    const job = this.findJob(jobId);
    if (job.status !== "queued") {
      throw new QueueError("Only a queued job can change its ask.", 409, "NOT_QUEUED");
    }
    const ask = BigInt(askPerSecYocto);
    if (ask < 0n || ask > LIMITS.askMaxYoctoPerSec) {
      throw new QueueError("Ask is outside the demo limit (0–0.01 NEAR/s).", 400, "BAD_ASK");
    }
    this.noteUserAction();
    job.askPerSecYocto = ask.toString();
    this.log(
      "job.ask_changed",
      agentName(job.ownerId),
      `${agentName(job.ownerId)} set the move price to ${formatNear(ask)}/s.`,
      { jobId, meta: { askPerSecYocto: ask.toString() } },
    );
    this.emit();
    return job;
  }

  cancelJob(jobId: string): Job {
    this.assertStorage();
    const job = this.findJob(jobId);
    if (job.status !== "queued") {
      throw new QueueError("Only a queued job can be cancelled.", 409, "NOT_QUEUED");
    }
    this.noteUserAction();
    const bond = BigInt(job.bondYocto);
    // Matches the contract: floor(bond / 4) to treasury, the rest back to the owner.
    const bondFee = job.expedited ? bond : bond / 4n;
    const refundBond = bond - bondFee;
    this.state.queueIds = this.state.queueIds.filter((id) => id !== jobId);
    job.status = "cancelled";
    job.finishedAt = this.now();
    this.state.balances[job.ownerId] = (
      BigInt(this.state.balances[job.ownerId] ?? "0") + BigInt(job.rewardYocto) + refundBond
    ).toString();
    this.state.treasuryYocto = (BigInt(this.state.treasuryYocto) + bondFee).toString();
    this.state.stats.cancelled += 1;
    const refundTotal = BigInt(job.rewardYocto) + refundBond;
    this.log(
      "job.cancelled",
      agentName(job.ownerId),
      `${agentName(job.ownerId)} cancelled ${job.title}; ${formatNear(refundTotal)} refunded, ${formatNear(bondFee)} bond fee.`,
      {
        jobId,
        amountYocto: refundTotal.toString(),
        meta: { expedited: job.expedited, bondFeeYocto: bondFee.toString() },
      },
    );
    this.emit();
    return job;
  }

  /**
   * Contract parity for queued work: a promise whose deadline has passed is
   * terminal. The escrow (reward + bond) goes back to the owner immediately.
   */
  sweepExpired(now: number = this.now()): number {
    const expired = this.queuedJobs().filter((job) => job.deadlineAt < now);
    if (expired.length === 0) return 0;
    for (const job of expired) {
      this.state.queueIds = this.state.queueIds.filter((id) => id !== job.id);
      job.status = "missed";
      job.finishedAt = now;
      const refund = BigInt(job.rewardYocto) + BigInt(job.bondYocto);
      this.state.balances[job.ownerId] = (
        BigInt(this.state.balances[job.ownerId] ?? "0") + refund
      ).toString();
      this.state.stats.missed += 1;
      this.log(
        "job.missed",
        "Operator",
        `${job.id} waited past its deadline in the queue; reward and bond refunded.`,
        {
          jobId: job.id,
          amountYocto: refund.toString(),
          meta: { reason: "timeout", deadlineAt: job.deadlineAt },
        },
      );
    }
    this.emit();
    return expired.length;
  }

  startNext(): { job: Job; missed: boolean } {
    this.assertStorage();
    if (this.runningJob()) {
      throw new QueueError("The worker is already running a job.", 409, "WORKER_BUSY");
    }
    const now = this.now();
    this.sweepExpired(now);
    const head = this.queuedJobs()[0];
    if (!head) {
      throw new QueueError("The queue is empty.", 409, "QUEUE_EMPTY");
    }
    this.noteUserAction();
    if (now > head.deadlineAt) {
      this.state.queueIds = this.state.queueIds.filter((id) => id !== head.id);
      head.status = "missed";
      head.finishedAt = now;
      this.state.balances[head.ownerId] = (
        BigInt(this.state.balances[head.ownerId] ?? "0") +
        BigInt(head.rewardYocto) +
        BigInt(head.bondYocto)
      ).toString();
      this.state.stats.missed += 1;
      this.log(
        "job.missed",
        "Operator",
        `${head.id} reached the worker after its deadline; reward and bond refunded.`,
        {
          jobId: head.id,
          amountYocto: (BigInt(head.rewardYocto) + BigInt(head.bondYocto)).toString(),
          meta: { reason: "timeout" },
        },
      );
      this.emit();
      return { job: head, missed: true };
    }
    head.status = "running";
    head.startedAt = now;
    this.state.queueIds = this.state.queueIds.filter((id) => id !== head.id);
    this.state.runningId = head.id;
    this.log("job.started", "Operator", `Operator started ${head.id}: ${head.title}.`, {
      jobId: head.id,
      meta: { durationSec: head.durationSec, projectedFinishAt: now + head.durationSec * 1000 },
    });
    this.scheduleFinish(head);
    this.advanceScenario("work");
    this.emit();
    return { job: head, missed: false };
  }

  private scheduleFinish(job: Job): void {
    const existing = this.timers.get(job.id);
    if (existing) clearTimeout(existing);
    const elapsed = job.startedAt ? this.now() - job.startedAt : 0;
    const remaining = Math.max(0, job.durationSec * 1000 - elapsed);
    const timer = setTimeout(() => this.finishRunning(job.id), remaining);
    unref(timer);
    this.timers.set(job.id, timer);
  }

  private finishRunning(jobId: string): void {
    const job = this.findJob(jobId);
    if (this.state.runningId !== jobId || job.status !== "running") return;
    const now = this.now();
    const timer = this.timers.get(jobId);
    if (timer) clearTimeout(timer);
    this.timers.delete(jobId);
    this.state.runningId = null;

    try {
      const artifact = this.artifactFactory(job);
      this.state.artifacts.unshift(artifact);
      job.artifactId = artifact.id;
      job.artifactHash = artifact.sha256;

      const onTime = now <= job.deadlineAt;
      artifact.checks.push({
        key: "deadline",
        label: "Delivered before the deadline",
        ok: onTime,
        detail: `${Math.abs(Math.round((job.deadlineAt - now) / 1000))}s ${onTime ? "to spare" : "late"}.`,
      });
      // The auditor re-hashes the delivered text. This is independent of the
      // value the worker computed: a mismatch means the attestation is wrong.
      const rehashed = sha256Hex(artifact.markdown);
      const wellFormed =
        SHA256_HEX.test(artifact.sha256) && SHA256_HEX.test(rehashed);
      const hashOk =
        wellFormed &&
        rehashed === artifact.sha256 &&
        artifact.sha256 === job.artifactHash;
      artifact.checks.push({
        key: "hash",
        label: "Artifact hash re-hashes to the recorded value",
        ok: hashOk,
        detail: hashOk
          ? rehashed
          : `recorded ${artifact.sha256}, recomputed ${rehashed}`,
      });

      if (!hashOk) {
        this.failJob(job, now, new Error("artifact hash mismatch"));
      } else if (onTime) {
        job.status = "done";
        job.finishedAt = now;
        this.state.balances[job.ownerId] = (
          BigInt(this.state.balances[job.ownerId] ?? "0") + BigInt(job.bondYocto)
        ).toString();
        this.state.balances.operator = (
          BigInt(this.state.balances.operator ?? "0") + BigInt(job.rewardYocto)
        ).toString();
        this.state.stats.completed += 1;
        this.log(
          "job.completed",
          "Operator",
          `${job.id} delivered ${Math.round((job.deadlineAt - now) / 1000)}s before the deadline; hash ${artifact.sha256.slice(0, 12)}…`,
          {
            jobId: job.id,
            amountYocto: job.rewardYocto,
            meta: { artifactId: artifact.id, sha256: artifact.sha256, onTime: true },
          },
        );
        this.log(
          "audit.passed",
          "Auditor",
          `Auditor verified ${job.id}: hash, delivery time, and escrow release agree.`,
          { jobId: job.id, meta: { artifactId: artifact.id, checks: artifact.checks.length } },
        );
      } else {
        job.status = "missed";
        job.finishedAt = now;
        this.state.balances[job.ownerId] = (
          BigInt(this.state.balances[job.ownerId] ?? "0") +
          BigInt(job.rewardYocto) +
          BigInt(job.bondYocto)
        ).toString();
        this.state.stats.missed += 1;
        this.log(
          "job.missed",
          "Operator",
          `${job.id} finished late; reward and bond were refunded to ${agentName(job.ownerId)}.`,
          {
            jobId: job.id,
            amountYocto: (BigInt(job.rewardYocto) + BigInt(job.bondYocto)).toString(),
            meta: { artifactId: artifact.id, sha256: artifact.sha256, onTime: false },
          },
        );
        this.log("audit.failed", "Auditor", `Auditor refused late delivery for ${job.id}.`, {
          jobId: job.id,
          meta: { deadlineAt: job.deadlineAt, finishedAt: now },
        });
      }
      this.advanceScenario("settled");
    } catch (error) {
      this.failJob(job, now, error);
    }
    this.emit();
    this.continueDrain();
  }

  private failJob(job: Job, now: number, error: unknown): void {
    if (job.status === "failed") return;
    const message = error instanceof Error ? error.message : String(error);
    const refund = BigInt(job.rewardYocto) + BigInt(job.bondYocto);
    job.status = "failed";
    job.finishedAt = now;
    this.state.balances[job.ownerId] = (
      BigInt(this.state.balances[job.ownerId] ?? "0") + refund
    ).toString();
    this.state.stats.failed += 1;
    this.log("job.failed", "Operator", `${job.id} failed during execution; escrow refunded.`, {
      jobId: job.id,
      amountYocto: refund.toString(),
      meta: { error: message },
    });
    this.log("audit.failed", "Auditor", `Auditor rejected ${job.id}: ${message}.`, {
      jobId: job.id,
      meta: { error: message },
    });
    this.closeScenario(`Scenario closed: ${job.id} failed (${message}).`);
  }

  /** A failed or interrupted scenario never leaves the demo in `running`. */
  private closeScenario(reason: string): void {
    if (this.state.scenario.status !== "running") return;
    this.state.scenario.status = "done";
    this.state.scenario.finishedAt = this.now();
    this.log("scenario.phase", "QUEUE", reason, { meta: { phase: "closed" } });
  }

  /**
   * After the scenario's urgent job settles, the worker keeps going: every
   * displaced job runs next, so the console ends by showing the promise kept —
   * each agent that sold its slot still delivers before its own deadline.
   */
  private continueDrain(): void {
    if (this.drainToken === null || this.drainToken !== this.scenarioToken) return;
    if (this.runningJob() || this.queuedJobs().length === 0) return;
    const token = this.scenarioToken;
    const timer = setTimeout(() => {
      this.scenarioTimers.delete(timer);
      if (token !== this.scenarioToken || this.runningJob()) return;
      if (this.queuedJobs().length === 0) return;
      this.scenarioActing = true;
      try {
        this.startNext();
      } catch {
        // A manual action may have emptied or started the queue meanwhile.
      } finally {
        this.scenarioActing = false;
      }
    }, 900);
    unref(timer);
    this.scenarioTimers.add(timer);
  }

  withdraw(agentId: string): { amountYocto: string; credits: string } {
    this.assertStorage();
    const agent = AGENT_BY_ID.get(agentId);
    if (!agent) throw new QueueError("Unknown agent.", 404, "AGENT_NOT_FOUND");
    const amount = BigInt(this.state.credits[agentId] ?? "0");
    if (amount <= 0n) {
      throw new QueueError("There is no credit to claim for this agent.", 409, "NO_CREDIT");
    }
    this.noteUserAction();
    this.state.credits[agentId] = "0";
    this.state.balances[agentId] = (
      BigInt(this.state.balances[agentId] ?? "0") + amount
    ).toString();
    this.log(
      "credit.withdrawn",
      agent.name,
      `${agent.name} claimed ${formatNear(amount)} from the local settlement ledger.`,
      { amountYocto: amount.toString(), meta: { mode: "local" } },
    );
    this.emit();
    return { amountYocto: amount.toString(), credits: "0" };
  }

  getArtifact(id: string): Artifact {
    const artifact = this.state.artifacts.find((item) => item.id === id);
    if (!artifact) throw new QueueError("Artifact not found.", 404, "ARTIFACT_NOT_FOUND");
    return artifact;
  }

  getArtifactForJob(jobId: string): Artifact | null {
    const job = this.findJob(jobId);
    return job.artifactId
      ? this.state.artifacts.find((item) => item.id === job.artifactId) ?? null
      : null;
  }

  private advanceScenario(phase: Scenario["phase"]): void {
    const scenario = this.state.scenario;
    if (scenario.status !== "running") return;
    const order = ["arrival", "quote", "purchase", "work", "settled"] as const;
    const index = order.indexOf(phase as (typeof order)[number]);
    if (index < 0) return;
    for (let i = 0; i < order.length; i += 1) {
      const step = scenario.steps.find((item) => item.key === order[i]);
      if (!step) continue;
      if (i <= index && !step.done) {
        step.done = true;
        step.at = step.at ?? this.now();
      }
    }
    scenario.phase = phase;
    if (phase === "settled") {
      scenario.status = "done";
      scenario.finishedAt = this.now();
    }
    this.log("scenario.phase", "QUEUE", `Scenario: ${phase}.`, {
      meta: { phase },
    });
  }

  /**
   * A long-lived demo must not greet a judge with a queue whose deadlines all
   * expired hours ago. Recycling only happens while the queue is untouched by a
   * user; a job submitted from the console is never deleted. Active work is
   * never touched. The interval in `index.ts` is the only caller.
   */
  maybeRecycle(): boolean {
    if (this.state.scenario.status === "running" || this.runningJob()) return false;
    if (!this.storageWritable()) return false;
    if (this.state.dirty) return false;
    const queued = this.queuedJobs();
    if (queued.length === 0) {
      // A finished, drained scenario returns to standby after a quiet minute
      // and a half, so a judge arriving later still sees a queue to play with.
      // A pristine standby queue emptied by a timeout sweep is also reborn.
      const lastAt = this.state.activity[0]?.at ?? 0;
      if (this.state.scenario.status === "done" && this.now() - lastAt > 90_000) {
        this.reset();
        return true;
      }
      if (this.state.scenario.status !== "done" && this.state.stats.missed > 0) {
        this.reset();
        return true;
      }
      return false;
    }
    const latestDeadline = Math.max(...queued.map((job) => job.deadlineAt));
    if (latestDeadline + 60_000 <= this.now()) {
      this.reset();
      return true;
    }
    // An untouched standby queue never runs, so its projected finishes slide
    // toward the deadlines while the page sits open. Re-anchor it before the
    // first promise looks broken, instead of greeting a judge with red rows.
    const slots = projectSchedule(queued, null, this.now());
    const decaying = queued.some((job, index) => {
      const slot = slots[index];
      return slot ? slot.finishAt + STANDBY_SAFETY_MS > job.deadlineAt : false;
    });
    if (!decaying) return false;
    this.reset();
    return true;
  }

  reset(): QueueState {
    this.assertStorage();
    this.scenarioToken += 1;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.scenarioTimers) clearTimeout(timer);
    this.scenarioTimers.clear();
    this.state = freshState();
    this.seedStandby(false);
    this.log("scenario.phase", "QUEUE", "Queue reset to the standby scenario.", {
      meta: { phase: "standby" },
    });
    this.emit();
    return this.getState();
  }

  runScenario(): Scenario {
    this.assertStorage();
    this.reset();
    const token = ++this.scenarioToken;
    this.drainToken = token;
    const scenario = this.state.scenario;
    scenario.status = "running";
    scenario.phase = "arrival";
    scenario.startedAt = this.now();
    scenario.steps = STEP_TEMPLATE.map((step) => ({ ...step }));
    const firstStep = scenario.steps[0];
    if (firstStep) {
      scenario.steps[0] = { ...firstStep, done: true, at: this.now() };
    }
    this.log("scenario.phase", "QUEUE", "Kestrel's urgent board brief arrives.", {
      meta: { phase: "arrival" },
    });
    this.emit();

    const later = (ms: number, callback: () => void) => {
      const timer = setTimeout(() => {
        this.scenarioTimers.delete(timer);
        if (token !== this.scenarioToken) return;
        // Scenario writes do not make the queue "user touched".
        this.scenarioActing = true;
        try {
          callback();
        } catch (error) {
          this.log(
            "scenario.phase",
            "QUEUE",
            `Scenario stopped: ${error instanceof Error ? error.message : String(error)}`,
            { meta: { phase: "error" } },
          );
          this.closeScenario("Scenario closed after an internal error.");
          this.emit();
        } finally {
          this.scenarioActing = false;
        }
      }, ms);
      unref(timer);
      this.scenarioTimers.add(timer);
    };

    later(1_600, () => {
      const urgent = this.buildJob(toYoctoSeed(URGENT_SEED));
      scenario.phase = "quote";
      this.advanceScenario("quote");
      const latestStartAt = Math.min(
        this.now() + 5_000,
        urgent.deadlineAt - urgent.durationSec * 1000,
      );
      const quote = this.quote(urgent.id, latestStartAt);
      this.log(
        "priority.quoted",
        "QUEUE",
        `Quote: ${quote.displaced.length} moves, ${formatNear(quote.totalYocto)} total, ${quote.feasible ? "feasible" : quote.reason}.`,
        {
          jobId: urgent.id,
          amountYocto: quote.totalYocto,
          meta: {
            insertIndex: quote.insertIndex,
            compensationYocto: quote.compensationYocto,
            feeYocto: quote.feeYocto,
            displaced: quote.displaced.map((item) => item.jobId),
          },
        },
      );
      this.emit();

      later(1_200, () => {
        this.buyPriority(urgent.id, latestStartAt, parseNear("0.05").toString());

        later(1_000, () => {
          this.startNext();
          this.emit();
        });
      });
    });

    return scenario;
  }

  private recover(): void {
    const running = this.runningJob();
    if (running) {
      this.log(
        "scenario.phase",
        "QUEUE",
        `Server restarted while ${running.id} was running; the worker resumed.`,
        { jobId: running.id, meta: { phase: "recover" } },
      );
      this.scheduleFinish(running);
    }
    if (this.state.scenario.status === "running") {
      if (running) {
        // Keep the scenario open and resume the drain: when the recovered job
        // settles it closes the scenario and the displaced jobs run next.
        this.drainToken = this.scenarioToken;
        this.log(
          "scenario.phase",
          "QUEUE",
          `Scenario resumed after a restart; the worker will drain the queue after ${running.id}.`,
          { jobId: running.id, meta: { phase: "recover" } },
        );
      } else {
        // No job to resume: close the scenario explicitly instead of leaving a
        // permanently "running" header. Queued jobs stay available to start.
        this.closeScenario(
          "Scenario closed after a server restart: no job was running. Queued jobs remain available to the operator.",
        );
      }
    }
    this.sweepExpired();
  }

  close(): void {
    this.scenarioToken += 1;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.scenarioTimers) clearTimeout(timer);
    this.scenarioTimers.clear();
    this.store?.close();
    this.store = null;
    this.listeners.clear();
  }
}
