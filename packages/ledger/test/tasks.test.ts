import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { Job, TaskKind } from "@queue/core";
import { buildArtifact, runTask } from "../src/tasks.js";
import { INCIDENT_INPUT, LAUNCH_INPUT, SETTLEMENT_CSV } from "../src/fixtures.js";

function job(task: TaskKind, input: string, title = "Test job"): Job {
  return {
    id: "J-1005",
    seq: 1005,
    title,
    task,
    ownerId: "kestrel",
    ownerAccount: "kestrel.queue-demo.testnet",
    brief: "A deterministic worker fixture.",
    input,
    durationSec: 5,
    submittedAt: 0,
    deadlineAt: 60_000,
    rewardYocto: "0",
    bondYocto: "0",
    askPerSecYocto: "0",
    status: "running",
    expedited: false,
    prioritySpendYocto: "0",
    movedCompensationYocto: "0",
    moves: [],
  };
}

describe("worker tasks", () => {
  it("builds an incident-triage brief from the shipped log", () => {
    const value = buildArtifact(
      job("incident-triage", INCIDENT_INPUT, "Board brief: checkout incident"),
    );
    assert.match(value.markdown, /8,410 orders are stuck in a reserved state/);
    assert.match(value.markdown, /18\.4% 5xx rate/);
    assert.match(value.markdown, /next update is due \*\*14:20Z\*\*/);
    assert.ok(value.checks.every((check) => check.ok), "all structural checks pass");
    assert.equal(
      createHash("sha256").update(value.markdown, "utf8").digest("hex"),
      value.sha256,
      "the recorded hash is a real SHA-256 of the markdown",
    );
  });

  it("builds a launch brief from the Northline notes", () => {
    const value = buildArtifact(job("launch-brief", LAUNCH_INPUT, "Northline pilot"));
    assert.match(value.markdown, /Partner:\*\* Northline Labs/);
    assert.match(value.markdown, /approve the pilot page/);
    assert.match(value.markdown, /refundable test credit/);
    assert.ok(value.checks.every((check) => check.ok), "all structural checks pass");
  });

  it("treats non-finite CSV numbers as zero instead of printing infinity", () => {
    const csv = [
      "settlement_id,chain,asset,amount_usd,status,latency_ms,retry",
      "st-1,near,USDC,1e999,failed,1e999,1e999",
      "st-2,base,USDC,10,settled,800,0",
    ].join("\n");
    const value = buildArtifact(job("csv-audit", csv, "Settlement audit"));
    assert.equal(value.markdown.includes("∞"), false);
    assert.equal(value.markdown.includes("Infinity"), false);
    assert.match(value.markdown, /Settled volume: \*\*\$10\.00\*\*/);
    assert.match(value.markdown, /Average latency: \*\*400 ms\*\*/);
  });

  it("rejects empty input before spending worker time", () => {
    assert.throws(
      () => runTask(job("incident-triage", "   \n  ")),
      /no input/i,
    );
  });
});
