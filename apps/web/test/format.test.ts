import test from "node:test";
import assert from "node:assert/strict";
import type { Job } from "@queue/core";
import {
  deadlineTone,
  formatAskPerSec,
  formatRelative,
  progressOf,
  selectFocusJob,
  slackSeconds,
} from "../src/lib/format";

function job(overrides: Partial<Job> = {}): Job {
  const now = 1_800_000_000_000;
  return {
    id: "J-1000",
    seq: 1,
    title: "Incident triage",
    task: "incident-triage",
    ownerId: "mira",
    ownerAccount: "mira.testnet",
    brief: "Triage the incident.",
    input: "logs",
    durationSec: 10,
    submittedAt: now,
    deadlineAt: now + 60_000,
    rewardYocto: "12000000000000000000000",
    bondYocto: "6000000000000000000000",
    askPerSecYocto: "400000000000000000000",
    status: "queued",
    expedited: false,
    prioritySpendYocto: "0",
    movedCompensationYocto: "0",
    moves: [],
    ...overrides,
  };
}

test("selectFocusJob prefers an expedited queued job", () => {
  const now = 1_800_000_000_000;
  const queue = [
    job({ id: "J-1001", deadlineAt: now + 90_000 }),
    job({ id: "J-1002", ownerId: "atlas", expedited: true, deadlineAt: now + 200_000 }),
    job({ id: "J-1003", ownerId: "vale", deadlineAt: now + 120_000 }),
  ];
  assert.equal(selectFocusJob(queue, null, now)?.id, "J-1002");
});

test("selectFocusJob falls back to the least deadline slack", () => {
  const now = 1_800_000_000_000;
  const queue = [
    job({ id: "J-2001", durationSec: 10, deadlineAt: now + 90_000 }),
    job({ id: "J-2002", durationSec: 20, deadlineAt: now + 60_000 }),
    job({ id: "J-2003", durationSec: 5, deadlineAt: now + 120_000 }),
  ];
  assert.equal(selectFocusJob(queue, null, now)?.id, "J-2002");
});

test("selectFocusJob accounts for the running job and ignores finished jobs", () => {
  const now = 1_800_000_000_000;
  const running = job({
    id: "J-3000",
    status: "running",
    startedAt: now - 2_000,
    durationSec: 12,
  });
  const queue = [
    job({ id: "J-3001", durationSec: 10, deadlineAt: now + 60_000 }),
    job({ id: "J-3002", durationSec: 10, deadlineAt: now + 60_000, status: "cancelled" }),
  ];
  assert.equal(selectFocusJob(queue, running, now)?.id, "J-3001");
  assert.equal(selectFocusJob([], running, now), null);
});

test("money and timing helpers format without floating-point loss", () => {
  assert.equal(formatAskPerSec("400000000000000000000"), "0.0004 NEAR/s");
  assert.equal(formatAskPerSec("0"), "0 NEAR/s");
  assert.equal(deadlineTone(1_000_000, 990_000), "met");
  assert.equal(deadlineTone(1_000_000, 997_000), "tight");
  assert.equal(deadlineTone(1_000_000, 1_004_000), "late");
  assert.equal(slackSeconds(1_000_000, 986_000), 14);
});

test("relative time and progress are derived from timestamps", () => {
  const now = 1_800_000_000_000;
  assert.equal(formatRelative(now - 1_000, now), "just now");
  assert.equal(formatRelative(now - 12_000, now), "12s ago");
  assert.equal(formatRelative(now - 120_000, now), "2m ago");
  assert.equal(formatRelative(now + 45_000, now), "in 45s");

  assert.equal(progressOf(job({ status: "running", startedAt: now - 5_000 }), now), 0.5);
  assert.equal(progressOf(job({ status: "running", startedAt: now - 20_000 }), now), 1);
  assert.equal(progressOf(job({ status: "queued" }), now), 0);
  assert.equal(progressOf(job({ status: "done" }), now), 1);
});
