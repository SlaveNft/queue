/**
 * Shared QUEUE domain model.
 *
 * Money is always an integer string in yoctoNEAR (10^-24 NEAR). Never store
 * NEAR as a float. Times are Unix epoch milliseconds throughout the TypeScript
 * app; the Rust contract uses Unix seconds.
 */

export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "missed"
  | "cancelled"
  | "failed";

export type TaskKind = "incident-triage" | "csv-audit" | "launch-brief";

export type AgentRole = "buyer" | "slot-holder" | "operator" | "auditor";

export interface Agent {
  id: string;
  name: string;
  handle: string;
  role: AgentRole;
  accountId: string;
  color: string;
  blurb: string;
}

export interface MoveRecord {
  byJobId: string;
  amountYocto: string;
  delaySec: number;
  at: number;
}

export interface DisplacedJob {
  jobId: string;
  ownerId: string;
  title: string;
  amountYocto: string;
  delaySec: number;
  newFinishAt: number;
  deadlineAt: number;
  slackSec: number;
}

export interface QuoteCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface Quote {
  jobId: string;
  now: number;
  latestStartAt: number;
  insertIndex: number;
  projectedStartAt: number;
  projectedFinishAt: number;
  compensationYocto: string;
  feeYocto: string;
  totalYocto: string;
  displaced: DisplacedJob[];
  feasible: boolean;
  reason: string;
  checks: QuoteCheck[];
}

export interface PriorityRecord {
  id: string;
  jobId: string;
  at: number;
  insertIndex: number;
  compensationYocto: string;
  feeYocto: string;
  totalYocto: string;
  latestStartAt: number;
  displaced: Array<{
    jobId: string;
    ownerId: string;
    amountYocto: string;
    delaySec: number;
  }>;
}

export interface ArtifactCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface Artifact {
  id: string;
  jobId: string;
  title: string;
  markdown: string;
  sha256: string;
  createdAt: number;
  durationMs: number;
  checks: ArtifactCheck[];
}

export interface Job {
  id: string;
  seq: number;
  title: string;
  task: TaskKind;
  ownerId: string;
  ownerAccount: string;
  brief: string;
  input: string;
  durationSec: number;
  submittedAt: number;
  deadlineAt: number;
  rewardYocto: string;
  bondYocto: string;
  askPerSecYocto: string;
  status: JobStatus;
  expedited: boolean;
  priorityId?: string;
  prioritySpendYocto: string;
  movedCompensationYocto: string;
  startedAt?: number;
  finishedAt?: number;
  artifactId?: string;
  artifactHash?: string;
  moves: MoveRecord[];
  /** Attached by the server for queued jobs. */
  projectedStartAt?: number;
  projectedFinishAt?: number;
}

export interface ProjectedSlot {
  jobId: string;
  startAt: number;
  finishAt: number;
}

export interface Stats {
  submitted: number;
  completed: number;
  missed: number;
  failed: number;
  cancelled: number;
  running: number;
  queued: number;
  moves: number;
  totalPriorityYocto: string;
  totalCompensationYocto: string;
  totalFeesYocto: string;
  onTimeBps: number;
}

export type LedgerEventType =
  | "job.submitted"
  | "job.ask_changed"
  | "priority.quoted"
  | "priority.bought"
  | "slot.paid"
  | "job.started"
  | "job.progress"
  | "job.completed"
  | "job.missed"
  | "job.failed"
  | "job.cancelled"
  | "credit.withdrawn"
  | "audit.passed"
  | "audit.failed"
  | "scenario.phase";

export interface LedgerEvent {
  id: string;
  at: number;
  type: LedgerEventType | string;
  actor: string;
  summary: string;
  jobId?: string;
  amountYocto?: string;
  meta?: Record<string, unknown>;
}

export type ScenarioPhase =
  | "standby"
  | "arrival"
  | "quote"
  | "purchase"
  | "work"
  | "settled";

export interface Scenario {
  id: string;
  name: string;
  status: "idle" | "running" | "done";
  phase: ScenarioPhase;
  startedAt?: number;
  finishedAt?: number;
  steps: Array<{ key: string; label: string; at?: number; done: boolean }>;
}

export interface NetworkInfo {
  mode: "local" | "testnet";
  label: string;
  contractId?: string;
  explorer?: string;
  blockHeight?: number;
  note: string;
}

export interface QueueState {
  schemaVersion: 1;
  sessionId: string;
  mode: "local" | "testnet";
  now: number;
  service: {
    name: string;
    blurb: string;
    operator: string;
    feeBps: number;
  };
  agents: Agent[];
  running: Job | null;
  queue: Job[];
  recent: Job[];
  credits: Record<string, string>;
  /** Rehearsal wallet balances in yoctoNEAR. Local ledger only. */
  balances: Record<string, string>;
  /** Protocol fees accrued in the local rehearsal. */
  treasuryYocto: string;
  stats: Stats;
  activity: LedgerEvent[];
  scenario: Scenario;
  network: NetworkInfo;
  /**
   * True while the queue is still the untouched standby seed: no scenario has
   * run and no user action has changed it. Replacing it loses nothing.
   */
  untouched?: boolean;
}

export interface ApiError {
  ok: false;
  error: string;
  code?: string;
}

export type ApiResult<T> = ({ ok: true } & T) | ApiError;
