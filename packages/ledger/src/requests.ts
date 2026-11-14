import { parseNear } from "@queue/core";
import { QueueError, type LedgerEngine } from "./engine.js";

/** Parse a NEAR amount from a request into yocto, naming the field on failure. */
export function nearToYocto(value: string | number, field: string): string {
  try {
    return parseNear(value).toString();
  } catch (error) {
    throw new QueueError(
      `${field}: ${error instanceof Error ? error.message : "invalid amount"}`,
      400,
      "BAD_AMOUNT",
    );
  }
}

/**
 * Turn "start within N seconds" into an absolute cutoff. A cutoff later than
 * the job's own last safe start is pointless, so it is clamped to that.
 */
export function clampLatestStart(
  engine: LedgerEngine,
  jobId: string,
  seconds: number | undefined,
): number {
  const state = engine.getState();
  const job = state.queue.find((item) => item.id === jobId);
  if (!job) throw new QueueError("Queued job not found.", 404, "JOB_NOT_FOUND");
  const safeLatest = job.deadlineAt - job.durationSec * 1000;
  const requested = seconds === undefined ? safeLatest : state.now + Math.round(seconds * 1000);
  return Math.min(requested, safeLatest);
}
