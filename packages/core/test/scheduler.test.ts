import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moveJob, latestSafeStart, projectSchedule, quotePriority } from "../src/scheduler.js";
import { formatNear, parseNear } from "../src/money.js";
import type { Job, TaskKind } from "../src/types.js";

const NOW = 1_700_000_000_000;

function job(
  id: string,
  durationSec: number,
  deadlineOffsetSec: number,
  askPerSecYocto = "1000",
  task: TaskKind = "incident-triage",
): Job {
  return {
    id,
    seq: Number(id.slice(1)),
    title: `Job ${id}`,
    task,
    ownerId: "mira",
    ownerAccount: "mira.testnet",
    brief: "Do the work",
    input: "input",
    durationSec,
    submittedAt: NOW,
    deadlineAt: NOW + deadlineOffsetSec * 1000,
    rewardYocto: "10000",
    bondYocto: "5000",
    askPerSecYocto,
    status: "queued",
    expedited: false,
    prioritySpendYocto: "0",
    movedCompensationYocto: "0",
    moves: [],
  };
}

describe("projectSchedule", () => {
  it("stacks FIFO durations", () => {
    const queue = [job("J1", 10, 100), job("J2", 20, 100)];
    const schedule = projectSchedule(queue, null, NOW);
    assert.equal(schedule[0]?.startAt, NOW);
    assert.equal(schedule[0]?.finishAt, NOW + 10_000);
    assert.equal(schedule[1]?.startAt, NOW + 10_000);
    assert.equal(schedule[1]?.finishAt, NOW + 30_000);
  });

  it("waits for the running job", () => {
    const running = { ...job("J0", 30, 100), status: "running" as const, startedAt: NOW - 10_000 };
    const schedule = projectSchedule([job("J1", 5, 100)], running, NOW);
    assert.equal(schedule[0]?.startAt, NOW + 20_000);
  });
});

describe("quotePriority", () => {
  const queue = [
    job("J1", 10, 120, "1000"),
    job("J2", 10, 120, "2000"),
    job("J3", 10, 120, "3000"),
    job("J4", 5, 40, "0"),
  ];

  it("charges nothing when the job already meets the cutoff", () => {
    const quote = quotePriority({
      queue,
      running: null,
      jobId: "J4",
      latestStartAt: NOW + 60_000,
      now: NOW,
      feeBps: 100,
    });
    assert.equal(quote.feasible, true);
    assert.equal(quote.insertIndex, 3);
    assert.equal(quote.compensationYocto, "0");
    assert.equal(quote.displaced.length, 0);
  });

  it("picks the latest feasible index, not the front", () => {
    const quote = quotePriority({
      queue,
      running: null,
      jobId: "J4",
      latestStartAt: NOW + 25_000,
      now: NOW,
      feeBps: 100,
    });
    assert.equal(quote.feasible, true);
    assert.equal(quote.insertIndex, 2);
    assert.equal(quote.displaced.length, 1);
    // 3000/s * 5s = 15000, 1% = 150
    assert.equal(quote.compensationYocto, "15000");
    assert.equal(quote.feeYocto, "150");
    assert.equal(quote.totalYocto, "15150");
    assert.equal(quote.projectedStartAt, NOW + 20_000);
    assert.equal(quote.projectedFinishAt, NOW + 25_000);
  });

  it("displaces every crossed job and sums exact ask * duration", () => {
    const quote = quotePriority({
      queue,
      running: null,
      jobId: "J4",
      latestStartAt: NOW + 8_000,
      now: NOW,
      feeBps: 100,
    });
    assert.equal(quote.feasible, true);
    assert.equal(quote.insertIndex, 0);
    assert.equal(quote.displaced.length, 3);
    // (1000 + 2000 + 3000) * 5 = 30000, 1% = 300
    assert.equal(quote.compensationYocto, "30000");
    assert.equal(quote.feeYocto, "300");
    assert.equal(quote.totalYocto, "30300");
    assert.deepEqual(
      quote.displaced.map((item) => item.jobId),
      ["J1", "J2", "J3"],
    );
  });

  it("protects displaced deadlines", () => {
    const tight = [job("J1", 10, 13, "1000"), job("J2", 10, 100, "1000"), job("J3", 5, 50, "0")];
    const quote = quotePriority({
      queue: tight,
      running: null,
      jobId: "J3",
      latestStartAt: NOW + 1_000,
      now: NOW,
      feeBps: 100,
    });
    // J1 finishes at 15s, deadline 13s: infeasible. The latest index that meets
    // the cutoff is 0, so there is no fallback.
    assert.equal(quote.feasible, false);
    assert.match(quote.reason, /deadline/i);
    assert.equal(quote.displaced.length, 2);
  });

  it("refuses a cutoff that even the front cannot meet", () => {
    const quote = quotePriority({
      queue,
      running: null,
      jobId: "J4",
      latestStartAt: NOW - 1,
      now: NOW,
      feeBps: 100,
    });
    assert.equal(quote.feasible, false);
    assert.match(quote.reason, /passed/i);
  });

  it("refuses when the urgent job misses its own deadline", () => {
    const tight = [job("J1", 10, 100), job("J2", 70, 65, "0")];
    const quote = quotePriority({
      queue: tight,
      running: null,
      jobId: "J2",
      latestStartAt: NOW + 60_000,
      now: NOW,
      feeBps: 100,
    });
    assert.equal(quote.feasible, false);
    assert.match(quote.reason, /deadline/i);
  });

  it("respects the running job as the earliest start", () => {
    const running = {
      ...job("J0", 20, 100),
      status: "running" as const,
      startedAt: NOW - 10_000,
    };
    const quote = quotePriority({
      queue: [job("J1", 10, 200), job("J2", 5, 100, "0")],
      running,
      jobId: "J2",
      latestStartAt: NOW + 15_000,
      now: NOW,
      feeBps: 100,
    });
    assert.equal(quote.feasible, true);
    assert.equal(quote.projectedStartAt, NOW + 10_000);
  });
});

describe("moveJob", () => {
  it("moves a job and preserves the rest", () => {
    const queue = [job("J1", 1, 10), job("J2", 1, 10), job("J3", 1, 10)];
    const moved = moveJob(queue, "J3", 0);
    assert.deepEqual(moved.map((item) => item.id), ["J3", "J1", "J2"]);
  });
});

describe("latestSafeStart", () => {
  it("leaves a safety pad", () => {
    const j = job("J1", 10, 30);
    assert.equal(latestSafeStart(j, 2), j.deadlineAt - 12_000);
  });
});

describe("money", () => {
  it("parses and formats exact yocto amounts", () => {
    assert.equal(parseNear("0.01").toString(), "10000000000000000000000");
    assert.equal(formatNear("10000000000000000000000"), "0.01 NEAR");
    assert.equal(formatNear("1234567890000000000000000", { maxDecimals: 4 }), "1.2345 NEAR");
    assert.equal(formatNear("0", { minDecimals: 2 }), "0.00 NEAR");
  });

  it("rejects bad money input", () => {
    assert.throws(() => parseNear("1.2.3"));
    assert.throws(() => parseNear("-1"));
    assert.throws(() => parseNear("1e5"));
  });
});
