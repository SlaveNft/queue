import { bpsOf } from "./money.js";
import type {
  Job,
  ProjectedSlot,
  Quote,
  QuoteCheck,
} from "./types.js";

/**
 * Projected FIFO schedule. The running job is not in `queue`; it blocks the
 * worker until its quoted duration has elapsed.
 */
export function projectSchedule(
  queue: Job[],
  running: Job | null,
  now: number,
): ProjectedSlot[] {
  let cursor = now;
  if (running) {
    const started = running.startedAt ?? now;
    cursor = Math.max(now, started + running.durationSec * 1000);
  }
  return queue.map((job) => {
    const startAt = cursor;
    const finishAt = startAt + job.durationSec * 1000;
    cursor = finishAt;
    return { jobId: job.id, startAt, finishAt };
  });
}

export function inboundStart(
  running: Job | null,
  now: number,
): number {
  if (!running) return now;
  return Math.max(now, (running.startedAt ?? now) + running.durationSec * 1000);
}

export interface QuoteInput {
  queue: Job[];
  running: Job | null;
  jobId: string;
  latestStartAt: number;
  now: number;
  feeBps: number;
}

/**
 * The exact priority rule used by the contract.
 *
 * The requester may jump any prefix of the jobs ahead of it. Jumping a job
 * delays it by the urgent job's duration. All delayed jobs must still meet
 * their deadlines. Among feasible positions we choose the latest one (fewest
 * jobs displaced). If `latestStartAt` is looser than the job's own deadline, the
 * deadline check still wins: the algorithm tries earlier positions until the
 * urgent job itself fits.
 */
export function quotePriority(input: QuoteInput): Quote {
  const { queue, running, jobId, latestStartAt, now, feeBps } = input;
  const empty = (
    reason: string,
    overrides: Partial<Quote> = {},
  ): Quote => ({
    jobId,
    now,
    latestStartAt,
    insertIndex: -1,
    projectedStartAt: 0,
    projectedFinishAt: 0,
    compensationYocto: "0",
    feeYocto: "0",
    totalYocto: "0",
    displaced: [],
    feasible: false,
    reason,
    checks: [],
    ...overrides,
  });

  const pos = queue.findIndex((job) => job.id === jobId);
  if (pos < 0) {
    return empty("This job is not in the queued set.");
  }
  const urgent = queue[pos];
  if (!urgent) {
    return empty("This job is not in the queued set.");
  }
  if (urgent.status !== "queued") {
    return empty("Only a queued job can buy priority.");
  }
  if (latestStartAt < now) {
    return empty("The requested start cutoff has already passed.", {
      checks: [
        {
          key: "cutoff",
          label: "Start cutoff is still ahead",
          ok: false,
          detail: "Pick a cutoff later than now.",
        },
      ],
    });
  }

  const baseline = projectSchedule(queue, running, now);
  const base = inboundStart(running, now);
  const durationMs = urgent.durationSec * 1000;

  let prefixMs = 0;
  const starts: number[] = [];
  for (const job of queue) {
    starts.push(base + prefixMs);
    prefixMs += job.durationSec * 1000;
  }

  // Find the latest insertion index that satisfies both the requested cutoff
  // and the urgent job's own deadline. Starting later never helps the deadline.
  let chosen = -1;
  let chosenStart = 0;
  for (let k = pos; k >= 0; k -= 1) {
    const startAt = starts[k];
    if (startAt === undefined) continue;
    if (startAt > latestStartAt) continue;
    if (startAt + durationMs > urgent.deadlineAt) continue;
    chosen = k;
    chosenStart = startAt;
    break;
  }

  if (chosen < 0) {
    const frontStart = starts[0] ?? base;
    const cutoffReason =
      frontStart > latestStartAt
        ? "Even the front of the queue starts after the requested cutoff."
        : "Even the front of the queue misses this job's deadline.";
    return empty(cutoffReason, {
      checks: [
        {
          key: "start_cutoff",
          label: "Fits before the start cutoff",
          ok: false,
          detail: `Earliest possible start is ${new Date(frontStart).toISOString()}.`,
        },
        {
          key: "own_deadline",
          label: "Meets the job deadline",
          ok: frontStart + durationMs <= urgent.deadlineAt,
          detail: `A ${urgent.durationSec}s job at the front would finish ${frontStart + durationMs <= urgent.deadlineAt ? "in time" : "late"}.`,
        },
      ],
    });
  }

  const displaced = queue.slice(chosen, pos).map((job) => {
    const baseSlot = baseline.find((slot) => slot.jobId === job.id);
    const oldFinish = baseSlot?.finishAt ?? chosenStart;
    const newFinishAt = oldFinish + durationMs;
    const amount = BigInt(job.askPerSecYocto) * BigInt(urgent.durationSec);
    return {
      jobId: job.id,
      ownerId: job.ownerId,
      title: job.title,
      amountYocto: amount.toString(),
      delaySec: urgent.durationSec,
      newFinishAt,
      deadlineAt: job.deadlineAt,
      slackSec: Math.floor((job.deadlineAt - newFinishAt) / 1000),
    };
  });

  const compensation = displaced.reduce(
    (sum, item) => sum + BigInt(item.amountYocto),
    0n,
  );
  const fee = bpsOf(compensation, feeBps);
  const deadlineBreakers = displaced.filter(
    (item) => item.newFinishAt > item.deadlineAt,
  );
  const ownFinish = chosenStart + durationMs;
  const checks: QuoteCheck[] = [
    {
      key: "cutoff",
      label: "Starts before the cutoff",
      ok: chosenStart <= latestStartAt,
      detail: `${Math.ceil((latestStartAt - chosenStart) / 1000)}s of margin.`,
    },
    {
      key: "own_deadline",
      label: "Delivers by the job deadline",
      ok: ownFinish <= urgent.deadlineAt,
      detail: `${Math.ceil((urgent.deadlineAt - ownFinish) / 1000)}s of margin.`,
    },
    {
      key: "deadlines",
      label: "No displaced deadline breaks",
      ok: deadlineBreakers.length === 0,
      detail:
        deadlineBreakers.length === 0
          ? `${displaced.length} promise${displaced.length === 1 ? "" : "s"} checked.`
          : `${deadlineBreakers.map((item) => item.jobId).join(", ")} would miss.`,
    },
    {
      key: "compensation",
      label: "Compensation is explicit",
      ok: true,
      detail: `${displaced.length} agent${displaced.length === 1 ? "" : "s"} paid for ${urgent.durationSec}s of delay.`,
    },
  ];

  if (deadlineBreakers.length > 0) {
    return {
      jobId,
      now,
      latestStartAt,
      insertIndex: chosen,
      projectedStartAt: chosenStart,
      projectedFinishAt: ownFinish,
      compensationYocto: compensation.toString(),
      feeYocto: fee.toString(),
      totalYocto: (compensation + fee).toString(),
      displaced,
      feasible: false,
      reason: `Moving ${deadlineBreakers[0]?.jobId ?? "a job"} would break its deadline. The protocol refuses this purchase.`,
      checks,
    };
  }

  return {
    jobId,
    now,
    latestStartAt,
    insertIndex: chosen,
    projectedStartAt: chosenStart,
    projectedFinishAt: ownFinish,
    compensationYocto: compensation.toString(),
    feeYocto: fee.toString(),
    totalYocto: (compensation + fee).toString(),
    displaced,
    feasible: true,
    reason:
      displaced.length === 0
        ? "This job already meets the cutoff; no purchase is needed."
        : displaced.length === 1
          ? `1 agent moves back ${urgent.durationSec}s and is paid immediately.`
          : `${displaced.length} agents move back ${urgent.durationSec}s and are paid immediately.`,
    checks,
  };
}

/** Move a job to an insertion index. Returns a new array. */
export function moveJob(
  queue: Job[],
  jobId: string,
  insertIndex: number,
): Job[] {
  const from = queue.findIndex((job) => job.id === jobId);
  if (from < 0) throw new Error("job not found");
  if (insertIndex < 0 || insertIndex > queue.length - 1) {
    throw new Error("insert index out of bounds");
  }
  const next = [...queue];
  const [job] = next.splice(from, 1);
  if (!job) throw new Error("job not found");
  next.splice(insertIndex, 0, job);
  return next;
}

/** Default cutoff used by the UI: deadline minus duration, minus a safety pad. */
export function latestSafeStart(job: Job, safetySec = 2): number {
  return job.deadlineAt - job.durationSec * 1000 - safetySec * 1000;
}

export function onTimeBps(completed: number, missed: number): number {
  const total = completed + missed;
  if (total === 0) return 10_000;
  return Math.round((completed / total) * 10_000);
}
