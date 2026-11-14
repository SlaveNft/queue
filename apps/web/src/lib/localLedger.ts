import type { Artifact, Job, PriorityRecord, QueueState, Quote, Scenario } from "@queue/core";
import { LedgerEngine, QueueError, clampLatestStart, nearToYocto } from "@queue/ledger";

/**
 * The in-browser ledger: one `LedgerEngine` per tab, in memory. It is the same
 * engine, worker and scenario the API server runs; only the transport differs.
 * Reloading the page starts a fresh standby queue.
 */

let engine: LedgerEngine | null = null;

function ledger(): LedgerEngine {
  if (engine) return engine;
  engine = new LedgerEngine();
  const current = engine;
  // The same upkeep the API server runs every five seconds.
  window.setInterval(() => {
    try {
      current.sweepExpired();
      current.maybeRecycle();
    } catch {
      // Upkeep must never break the console; the next tick retries.
    }
  }, 5_000);
  return engine;
}

/** What crosses the HTTP boundary is plain JSON; hand React the same kind of copy. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface LocalNewJob {
  ownerId: string;
  task: Job["task"];
  title: string;
  brief: string;
  input: string;
  durationSec: number;
  deadlineInSec: number;
  rewardNear: string;
  bondNear: string;
  askPerSecNear: string;
}

export const localLedger = {
  QueueError,

  getState(): QueueState {
    return copy(ledger().getState());
  },

  /** Calls `listener` with a fresh snapshot after every change. Returns an unsubscribe function. */
  subscribe(listener: (state: QueueState) => void): () => void {
    const current = ledger();
    return current.subscribe(() => listener(copy(current.getState())));
  },

  getQuote(jobId: string, latestStartInSec: number): Quote {
    const current = ledger();
    return copy(current.quote(jobId, clampLatestStart(current, jobId, latestStartInSec)));
  },

  getArtifact(id: string): Artifact {
    return copy(ledger().getArtifact(id));
  },

  createJob(input: LocalNewJob): Job {
    return copy(
      ledger().createJob({
        ownerId: input.ownerId,
        task: input.task,
        title: input.title,
        brief: input.brief,
        input: input.input,
        durationSec: Math.round(Number(input.durationSec)),
        deadlineInSec: Math.round(Number(input.deadlineInSec)),
        rewardYocto: nearToYocto(input.rewardNear, "rewardNear"),
        bondYocto: nearToYocto(input.bondNear, "bondNear"),
        askPerSecYocto: nearToYocto(input.askPerSecNear, "askPerSecNear"),
      }),
    );
  },

  buyPriority(
    jobId: string,
    latestStartInSec: number,
    maxSpendNear: string,
  ): { quote: Quote; job: Job; priority: PriorityRecord } {
    const current = ledger();
    const latestStartAt = clampLatestStart(current, jobId, latestStartInSec);
    return copy(current.buyPriority(jobId, latestStartAt, nearToYocto(maxSpendNear, "maxSpendNear")));
  },

  moveAsk(jobId: string, askPerSecNear: string): Job {
    return copy(ledger().setAsk(jobId, nearToYocto(askPerSecNear, "askPerSecNear")));
  },

  cancelJob(jobId: string): Job {
    return copy(ledger().cancelJob(jobId));
  },

  startNext(): Job {
    return copy(ledger().startNext().job);
  },

  withdraw(agentId: string): { amountYocto: string; credits: Record<string, string> } {
    const current = ledger();
    const result = current.withdraw(agentId);
    return { amountYocto: result.amountYocto, credits: copy(current.getState().credits) };
  },

  runScenario(): Scenario {
    return copy(ledger().runScenario());
  },

  reset(): QueueState {
    return copy(ledger().reset());
  },
};
