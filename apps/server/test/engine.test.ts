import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseNear } from "@queue/core";
import { QueueEngine, QueueError } from "../src/engine.js";

const engines: QueueEngine[] = [];
const dirs: string[] = [];

function engine(options: { dbPath?: string } = {}): QueueEngine {
  const value = new QueueEngine({ dbPath: options.dbPath ?? ":memory:" });
  engines.push(value);
  return value;
}

function makeJobInput(): Parameters<QueueEngine["createJob"]>[0] {
  return {
    ownerId: "kestrel",
    task: "incident-triage",
    title: "Board brief now",
    brief: "Deliver before the board call.",
    input: "latency 4.8s; 5xx 18%",
    durationSec: 5,
    deadlineInSec: 30,
    rewardYocto: parseNear("0.02").toString(),
    bondYocto: parseNear("0.01").toString(),
    askPerSecYocto: "0",
  };
}

function makeJob(
  q: QueueEngine,
  overrides: Partial<Parameters<QueueEngine["createJob"]>[0]> = {},
): ReturnType<QueueEngine["createJob"]> {
  return q.createJob({ ...makeJobInput(), ...overrides });
}

afterEach(() => {
  for (const value of engines.splice(0)) value.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function conserved(state: ReturnType<QueueEngine["getState"]>): bigint {
  let total = BigInt(state.treasuryYocto);
  for (const value of Object.values(state.balances)) total += BigInt(value);
  for (const value of Object.values(state.credits)) total += BigInt(value);
  for (const job of state.queue) total += BigInt(job.rewardYocto) + BigInt(job.bondYocto);
  if (state.running) total += BigInt(state.running.rewardYocto) + BigInt(state.running.bondYocto);
  return total;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("QueueEngine", () => {
  it("reports the standby queue as untouched until a user or the scenario changes it", () => {
    const q = engine();
    assert.equal(q.getState().untouched, true);
    q.setAsk(q.getState().queue[0]!.id, "1");
    assert.equal(q.getState().untouched, false);
    q.reset();
    assert.equal(q.getState().untouched, true);
    q.runScenario();
    assert.equal(q.getState().untouched, false);
  });

  it("re-anchors an untouched standby queue before any promise looks broken", () => {
    let t = 1_800_000_000_000;
    const value = new QueueEngine({ dbPath: ":memory:", clock: () => t });
    engines.push(value);
    const before = value.getState();
    assert.equal(value.maybeRecycle(), false, "fresh standby is healthy");

    // Leave the page open: the queue never runs, projections slide forward.
    t += 95_000;
    assert.equal(value.maybeRecycle(), true, "decaying standby is re-anchored");
    const after = value.getState();
    assert.notEqual(after.sessionId, before.sessionId);
    for (const [index, job] of after.queue.entries()) {
      const ahead = after.queue.slice(0, index).reduce((sum, j) => sum + j.durationSec, 0);
      assert.ok(t + (ahead + job.durationSec) * 1000 < job.deadlineAt, `${job.id} has slack`);
    }
  });

  it("never re-anchors a queue the user has touched until every deadline is stale", () => {
    let t = 1_800_000_000_000;
    const value = new QueueEngine({ dbPath: ":memory:", clock: () => t });
    engines.push(value);
    const job = value.getState().queue[0]!;
    value.setAsk(job.id, parseNear("0.0005").toString());
    t += 95_000;
    assert.equal(value.maybeRecycle(), false, "a touched queue keeps its state");
  });

  it("never deletes a job the user created, even after both recycle windows", () => {
    let t = 1_800_000_000_000;
    const value = new QueueEngine({ dbPath: ":memory:", clock: () => t });
    engines.push(value);
    const session = value.getState().sessionId;
    const job = makeJob(value);
    t += 95_000; // standby decay window
    assert.equal(value.maybeRecycle(), false, "user work is not recycled");
    t += 120_000; // stale-deadline window
    assert.equal(value.maybeRecycle(), false, "stale user work is still kept");
    const state = value.getState();
    assert.equal(state.sessionId, session);
    assert.ok(state.queue.some((item) => item.id === job.id), "the user job is still queued");
    // Timeout is the only way it leaves the queue, and it remains in recent.
    value.sweepExpired();
    const swept = value.getState();
    assert.ok(!swept.queue.some((item) => item.id === job.id));
    assert.equal(swept.recent.find((item) => item.id === job.id)?.status, "missed");
  });

  it("marks an expired queued job missed, refunds reward and bond, and logs the timeout", () => {
    let t = 1_800_000_000_000;
    const value = new QueueEngine({ dbPath: ":memory:", clock: () => t });
    engines.push(value);
    const job = makeJob(value, { deadlineInSec: 5, durationSec: 1 });
    for (const other of value.getState().queue.filter((item) => item.id !== job.id)) {
      value.cancelJob(other.id);
    }
    const before = conserved(value.getState());
    t += 10_000;
    assert.equal(value.sweepExpired(), 1);
    const state = value.getState();
    assert.equal(state.queue.length, 0);
    const missed = state.recent.find((item) => item.id === job.id);
    assert.equal(missed?.status, "missed");
    assert.equal(state.stats.missed, 1);
    const event = state.activity.find(
      (item) => item.type === "job.missed" && item.jobId === job.id,
    );
    assert.equal(event?.meta?.reason, "timeout");
    assert.equal(
      BigInt(state.balances.kestrel ?? "0"),
      parseNear("0.5") - parseNear("0.02") - parseNear("0.01") +
        parseNear("0.02") + parseNear("0.01"),
    );
    assert.equal(conserved(state), before, "timeout refund conserves value");
    assert.equal(value.sweepExpired(), 0, "a terminal job is not swept twice");
  });

  it("sweeps expired work before starting the next job", () => {
    let t = 1_800_000_000_000;
    const value = new QueueEngine({ dbPath: ":memory:", clock: () => t });
    engines.push(value);
    const job = makeJob(value, { deadlineInSec: 5, durationSec: 1 });
    for (const other of value.getState().queue.filter((item) => item.id !== job.id)) {
      value.cancelJob(other.id);
    }
    t += 10_000;
    assert.throws(
      () => value.startNext(),
      (error: unknown) => error instanceof QueueError && error.code === "QUEUE_EMPTY",
    );
    assert.equal(value.getState().recent.find((item) => item.id === job.id)?.status, "missed");
  });

  it("accumulates prioritySpendYocto across two purchases, like checked_add", () => {
    const q = engine();
    const first = makeJob(q, { durationSec: 12, deadlineInSec: 30 });
    const firstCutoff = q.getState().now + 5_000;
    const firstBuy = q.buyPriority(first.id, firstCutoff, parseNear("0.05").toString());

    // A second buyer jumps ahead of the first job...
    const second = makeJob(q, { durationSec: 3, deadlineInSec: 20 });
    const secondBuy = q.buyPriority(
      second.id,
      q.getState().now + 2_000,
      parseNear("0.05").toString(),
    );
    // ...and becomes expensive to displace, so the first job's next purchase costs money.
    q.setAsk(second.id, parseNear("0.0005").toString());

    const repeat = q.buyPriority(
      first.id,
      q.getState().now + 1_000,
      parseNear("0.05").toString(),
    );
    assert.ok(BigInt(repeat.priority.totalYocto) > 0n, "repeat purchase costs something");

    const state = q.getState();
    const moved = state.queue.find((item) => item.id === first.id);
    assert.equal(
      moved?.prioritySpendYocto,
      (BigInt(firstBuy.priority.totalYocto) + BigInt(repeat.priority.totalYocto)).toString(),
    );
    assert.equal(
      state.stats.totalPriorityYocto,
      (
        BigInt(firstBuy.priority.totalYocto) +
        BigInt(secondBuy.priority.totalYocto) +
        BigInt(repeat.priority.totalYocto)
      ).toString(),
    );
  });

  it("rounds a cancellation bond fee like the contract: floor(bond / 4)", () => {
    const q = engine();
    q.reset();
    const oddBond = "1000000000000000000001"; // 0.001 NEAR + 1 yocto
    const job = makeJob(q, { bondYocto: oddBond });
    const before = conserved(q.getState());
    q.cancelJob(job.id);
    const state = q.getState();
    const bondFee = BigInt(oddBond) / 4n;
    const refund = BigInt(oddBond) - bondFee;
    assert.equal(state.treasuryYocto, bondFee.toString());
    assert.equal(
      BigInt(state.balances.kestrel ?? "0"),
      parseNear("0.5") - BigInt(oddBond) + refund,
    );
    assert.equal(conserved(state), before);
  });

  it("fails the audit when the recomputed hash does not match the artifact", async () => {
    const value = new QueueEngine({
      dbPath: ":memory:",
      artifactFactory: (job) => ({
        id: `ART-${job.id}`,
        jobId: job.id,
        title: job.title,
        markdown: "# tampered\n",
        sha256: "0".repeat(64),
        createdAt: 0,
        durationMs: 1,
        checks: [],
      }),
    });
    engines.push(value);
    value.reset();
    const job = makeJob(value, { durationSec: 1, deadlineInSec: 30 });
    for (const other of value.getState().queue.filter((item) => item.id !== job.id)) {
      value.cancelJob(other.id);
    }
    const before = conserved(value.getState());
    value.startNext();
    await waitFor(() => value.getState().recent.some((item) => item.id === job.id));
    const state = value.getState();
    const failed = state.recent.find((item) => item.id === job.id);
    assert.equal(failed?.status, "failed");
    assert.equal(state.stats.failed, 1);
    assert.equal(state.stats.missed, 0, "failed is not counted as missed");
    assert.equal(state.stats.completed, 0);
    const types = state.activity.map((item) => item.type);
    assert.ok(types.includes("job.failed"));
    assert.ok(types.includes("audit.failed"));
    assert.ok(!types.includes("audit.passed"));
    const artifact = value.getArtifactForJob(job.id);
    assert.equal(artifact?.checks.find((item) => item.key === "hash")?.ok, false);
    assert.equal(conserved(state), before, "failure refunds escrow");
  });

  it("counts a worker exception as failed, not missed", async () => {
    const value = new QueueEngine({
      dbPath: ":memory:",
      artifactFactory: () => {
        throw new Error("worker exploded");
      },
    });
    engines.push(value);
    value.reset();
    const job = makeJob(value, { durationSec: 1, deadlineInSec: 30 });
    for (const other of value.getState().queue.filter((item) => item.id !== job.id)) {
      value.cancelJob(other.id);
    }
    value.startNext();
    await waitFor(() => value.getState().recent.some((item) => item.id === job.id));
    const state = value.getState();
    assert.equal(state.recent.find((item) => item.id === job.id)?.status, "failed");
    assert.equal(state.stats.failed, 1);
    assert.equal(state.stats.missed, 0);
  });

  it("reports degraded health after persistence failures and refuses mutations", () => {
    const q = engine();
    assert.equal(q.health().db, "ok");
    const store = (q as unknown as { store: { save: (json: string, at: string) => void } }).store;
    store.save = () => {
      throw new Error("disk full");
    };
    // The engine logs each failed write; this test causes them on purpose, so keep them out of the output.
    const quiet = console.error;
    console.error = () => {};
    for (let i = 0; i < 3; i += 1) {
      q.setAsk(q.getState().queue[0]!.id, "1");
    }
    console.error = quiet;
    const health = q.health();
    assert.equal(health.db, "degraded");
    assert.equal(health.storageWritable, false);
    assert.equal(health.persistFailures, 3);
    assert.match(health.lastPersistError ?? "", /disk full/);
    assert.throws(
      () => q.createJob({ ...makeJobInput(), input: "x" }),
      (error: unknown) => error instanceof QueueError && error.code === "STORAGE_UNAVAILABLE",
    );
  });

  it("resumes the drain after a restart while a scenario job was running", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "queue-restart-"));
    dirs.push(dir);
    const file = path.join(dir, "queue.db");
    const first = engine({ dbPath: file });
    first.reset();
    for (const job of first.getState().queue) first.cancelJob(job.id);
    const running = makeJob(first, { durationSec: 1, deadlineInSec: 60 });
    const next = makeJob(first, { durationSec: 1, deadlineInSec: 60 });
    first.startNext();
    assert.equal(first.getState().running?.id, running.id);
    // A scenario that was live when the process stopped.
    (first as unknown as { state: { scenario: { status: string } } }).state.scenario.status =
      "running";
    (first as unknown as { persist: () => void }).persist();
    first.close();

    const second = engine({ dbPath: file });
    assert.equal(second.getState().running?.id, running.id, "running job resumed");
    await waitFor(() => second.getState().running?.id === next.id, 8_000);
    assert.equal(second.getState().stats.completed, 1);
    assert.ok(
      ["running", "done"].includes(
        second.getState().recent.find((item) => item.id === running.id)?.status ?? "",
      ),
    );
  });

  it("closes a restored running scenario that has no job to resume", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "queue-restart-"));
    dirs.push(dir);
    const file = path.join(dir, "queue.db");
    const first = engine({ dbPath: file });
    (first as unknown as { state: { scenario: { status: string } } }).state.scenario.status =
      "running";
    (first as unknown as { persist: () => void }).persist();
    first.close();
    const second = engine({ dbPath: file });
    const state = second.getState();
    assert.equal(state.scenario.status, "done");
    assert.ok(
      state.activity.some((item) => item.type === "scenario.phase" && /restart/i.test(item.summary)),
    );
  });


  it("seeds a four-job standby queue", () => {
    const q = engine();
    const state = q.getState();
    assert.equal(state.queue.length, 4);
    assert.equal(state.running, null);
    assert.equal(state.scenario.phase, "standby");
    assert.equal(state.stats.submitted, 4);
    assert.deepEqual(
      state.queue.map((job) => job.ownerId),
      ["mira", "atlas", "vale", "juno"],
    );
  });

  it("creates a job with exact money and validates limits", () => {
    const q = engine();
    const job = q.createJob({
      ownerId: "kestrel",
      task: "incident-triage",
      title: "Urgent board brief",
      brief: "Summarize the incident for the board.",
      input: "error rate 18%",
      durationSec: 5,
      deadlineInSec: 30,
      rewardYocto: parseNear("0.02").toString(),
      bondYocto: parseNear("0.01").toString(),
      askPerSecYocto: parseNear("0.0004").toString(),
    });
    assert.equal(job.rewardYocto, "20000000000000000000000");
    assert.equal(q.getState().queue.at(-1)?.id, job.id);
    assert.throws(
      () =>
        q.createJob({
          ownerId: "kestrel",
          task: "incident-triage",
          title: "x",
          brief: "short",
          input: "",
          durationSec: 5,
          deadlineInSec: 30,
          rewardYocto: parseNear("0.02").toString(),
          bondYocto: parseNear("0.01").toString(),
          askPerSecYocto: "0",
        }),
      (error: unknown) => error instanceof QueueError && error.code === "BAD_TITLE",
    );
  });

  it("buys priority, pays all displaced owners, and reorders the queue", () => {
    const q = engine();
    const initial = conserved(q.getState());
    const urgent = q.createJob({
      ownerId: "kestrel",
      task: "incident-triage",
      title: "Board brief now",
      brief: "Deliver before the board call.",
      input: "latency 4.8s; 5xx 18%",
      durationSec: 12,
      deadlineInSec: 30,
      rewardYocto: parseNear("0.02").toString(),
      bondYocto: parseNear("0.015").toString(),
      askPerSecYocto: "0",
    });
    const state = q.getState();
    const latest = state.now + 5_000;
    const quote = q.quote(urgent.id, latest);
    assert.equal(quote.feasible, true);
    assert.equal(quote.insertIndex, 0);
    assert.equal(quote.displaced.length, 4);
    assert.equal(quote.compensationYocto, "20040000000000000000000");
    assert.equal(quote.feeYocto, "200400000000000000000");

    const result = q.buyPriority(urgent.id, latest, parseNear("0.05").toString());
    assert.equal(result.priority.displaced.length, 4);
    const after = q.getState();
    assert.equal(after.queue[0]?.id, urgent.id);
    assert.equal(after.queue[0]?.expedited, true);
    assert.equal(after.stats.moves, 4);
    assert.equal(after.stats.totalPriorityYocto, quote.totalYocto);
    assert.equal(after.credits.mira, "5040000000000000000000");
    assert.equal(after.credits.atlas, "6960000000000000000000");
    assert.equal(after.credits.vale, "4320000000000000000000");
    assert.equal(after.credits.juno, "3720000000000000000000");
    assert.equal(after.queue[1]?.id, "J-1001");
    assert.equal(after.queue[1]?.moves.length, 1);
    assert.equal(after.activity[0]?.type, "priority.bought");
    assert.equal(conserved(after), initial);
  });

  it("rejects a budget below the quote and leaves the queue untouched", () => {
    const q = engine();
    const urgent = q.createJob({
      ownerId: "kestrel",
      task: "incident-triage",
      title: "Board brief now",
      brief: "Deliver before the board call.",
      input: "latency 4.8s",
      durationSec: 12,
      deadlineInSec: 30,
      rewardYocto: parseNear("0.02").toString(),
      bondYocto: parseNear("0.015").toString(),
      askPerSecYocto: "0",
    });
    const before = q.getState();
    const latest = before.now + 5_000;
    assert.throws(
      () => q.buyPriority(urgent.id, latest, parseNear("0.001").toString()),
      (error: unknown) => error instanceof QueueError && error.code === "BUDGET_TOO_LOW",
    );
    const after = q.getState();
    assert.deepEqual(after.queue.map((job) => job.id), before.queue.map((job) => job.id));
    assert.equal(after.stats.totalPriorityYocto, "0");
    assert.equal(after.credits.mira, "0");
  });

  it("cancels a normal job with a 25% bond fee and an expedited job with 100%", () => {
    const q = engine();
    const normal = q.createJob({
      ownerId: "kestrel",
      task: "incident-triage",
      title: "Normal job",
      brief: "A normal queued job.",
      input: "x",
      durationSec: 5,
      deadlineInSec: 60,
      rewardYocto: parseNear("0.02").toString(),
      bondYocto: parseNear("0.01").toString(),
      askPerSecYocto: "0",
    });
    q.cancelJob(normal.id);
    assert.equal(q.getState().balances.kestrel, parseNear("0.4975").toString());

    const urgent = q.createJob({
      ownerId: "kestrel",
      task: "incident-triage",
      title: "Expedited job",
      brief: "This one will buy a slot.",
      input: "x",
      durationSec: 2,
      deadlineInSec: 20,
      rewardYocto: parseNear("0.02").toString(),
      bondYocto: parseNear("0.01").toString(),
      askPerSecYocto: "0",
    });
    const before = q.getState();
    q.buyPriority(urgent.id, before.now + 1_000, parseNear("0.05").toString());
    q.cancelJob(urgent.id);
    assert.equal(q.getState().balances.kestrel, parseNear("0.4841266").toString());
  });

  it("runs a one-second job, releases reward and bond, and produces a real artifact", async () => {
    const q = engine();
    q.reset();
    const job = q.createJob({
      ownerId: "kestrel",
      task: "csv-audit",
      title: "Tiny settlement audit",
      brief: "Audit the export.",
      input: "id,chain,amount_usd,status,latency_ms\n1,near,10,settled,800\n2,base,5,failed,2000",
      durationSec: 1,
      deadlineInSec: 10,
      rewardYocto: parseNear("0.02").toString(),
      bondYocto: parseNear("0.01").toString(),
      askPerSecYocto: "0",
    });
    // Remove the four standby jobs so this job is at the head.
    for (const queued of q.getState().queue.filter((item) => item.id !== job.id)) {
      q.cancelJob(queued.id);
    }
    const started = q.startNext();
    assert.equal(started.job.id, job.id);
    assert.equal(started.missed, false);
    await waitFor(() => q.getState().recent.some((item) => item.id === job.id));
    const state = q.getState();
    const done = state.recent.find((item) => item.id === job.id);
    assert.equal(done?.status, "done");
    assert.equal(done?.artifactHash?.length, 64);
    assert.equal(state.stats.completed, 1);
    assert.equal(state.balances.operator, parseNear("0.12").toString());
    assert.equal(state.balances.kestrel, parseNear("0.48").toString());
    const artifact = q.getArtifactForJob(job.id);
    assert.match(artifact?.markdown ?? "", /Settlement audit/);
    assert.match(artifact?.markdown ?? "", /\$15\.00/);
  });

  it("withdraws a credit exactly once", () => {
    const q = engine();
    const urgent = q.createJob({
      ownerId: "kestrel",
      task: "incident-triage",
      title: "Board brief now",
      brief: "Deliver before the board call.",
      input: "latency 4.8s",
      durationSec: 5,
      deadlineInSec: 20,
      rewardYocto: parseNear("0.02").toString(),
      bondYocto: parseNear("0.01").toString(),
      askPerSecYocto: "0",
    });
    const before = q.getState();
    q.buyPriority(urgent.id, before.now + 1_000, parseNear("0.05").toString());
    const claimed = q.withdraw("mira");
    assert.equal(claimed.amountYocto, parseNear("0.0021").toString());
    assert.equal(q.getState().credits.mira, "0");
    assert.throws(() => q.withdraw("mira"), (error: unknown) => error instanceof QueueError);
  });

  it("persists jobs and credits across a restart", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "queue-test-"));
    dirs.push(dir);
    const file = path.join(dir, "queue.db");
    const first = engine({ dbPath: file });
    assert.equal(first.getState().queue.length, 4);
    first.close();
    const second = engine({ dbPath: file });
    assert.equal(second.getState().queue.length, 4);
    assert.equal(second.getState().queue[0]?.id, "J-1001");
  });

  it("clears running timers on reset", () => {
    const q = engine();
    q.startNext();
    assert.ok(q.getState().running);
    q.reset();
    assert.equal(q.getState().running, null);
    assert.equal(q.getState().queue.length, 4);
  });
});
