import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { parseNear } from "@queue/core";
import { createApp } from "../src/app.js";
import { QueueEngine } from "../src/engine.js";

let server: Server;
let base: string;
let engine: QueueEngine;

async function asJson(response: Response): Promise<any> {
  return response.json();
}

before(async () => {
  engine = new QueueEngine({ dbPath: ":memory:" });
  const app = createApp({ engine, version: "test" });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  engine.close();
});

describe("HTTP API", () => {
  it("serves health and state", async () => {
    const health = await asJson(await fetch(`${base}/api/health`));
    assert.equal(health.ok, true);
    assert.equal(health.version, "test");
    assert.equal(health.db, "ok");
    assert.equal(health.storageWritable, true);
    assert.equal(typeof health.lastPersistedAt, "number");
    const state = await asJson(await fetch(`${base}/api/state`));
    assert.equal(state.ok, true);
    assert.equal(state.state.queue.length, 4);
    assert.equal(state.state.mode, "local");
  });

  it("does not recycle state from GET /api/state", async () => {
    let t = 1_800_000_000_000;
    const local = new QueueEngine({ dbPath: ":memory:", clock: () => t });
    const app = createApp({ engine: local, version: "test" });
    const srv = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => srv.once("listening", () => resolve()));
    const address = srv.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const first = await asJson(await fetch(`${url}/api/state`));
      t += 95_000;
      const second = await asJson(await fetch(`${url}/api/state`));
      assert.equal(
        second.state.sessionId,
        first.state.sessionId,
        "a GET must not reset the queue",
      );
      assert.equal(local.maybeRecycle(), true, "the interval still recycles a decaying queue");
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      local.close();
    }
  });

  it("degrades /api/health when persistence fails", async () => {
    const local = new QueueEngine({ dbPath: ":memory:" });
    const app = createApp({ engine: local, version: "test" });
    const srv = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => srv.once("listening", () => resolve()));
    const address = srv.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const store = (local as unknown as { store: { save: (json: string, at: string) => void } }).store;
      store.save = () => {
        throw new Error("disk full");
      };
      // The engine logs each failed write; this test causes them on purpose, so keep them out of the output.
      const quiet = console.error;
      console.error = () => {};
      for (let i = 0; i < 3; i += 1) {
        local.setAsk(local.getState().queue[0]!.id, "1");
      }
      console.error = quiet;
      const response = await fetch(`${url}/api/health`);
      assert.equal(response.status, 503);
      const body = await asJson(response);
      assert.equal(body.ok, false);
      assert.equal(body.db, "degraded");
      assert.equal(body.storageWritable, false);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      local.close();
    }
  });

  it("returns 413 BODY_TOO_LARGE for an oversized body", async () => {    const response = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerId: "kestrel",
        task: "incident-triage",
        title: "Huge body",
        brief: "This request is larger than the body limit.",
        input: "x".repeat(300_000),
        durationSec: 5,
        deadlineInSec: 30,
        rewardNear: "0.02",
        bondNear: "0.01",
        askPerSecNear: "0",
      }),
    });
    assert.equal(response.status, 413);
    const body = await asJson(response);
    assert.equal(body.ok, false);
    assert.equal(body.code, "BODY_TOO_LARGE");
  });

  it("rejects an invalid job", async () => {
    const response = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerId: "kestrel",
        task: "incident-triage",
        title: "x",
        brief: "too short",
        input: "",
        durationSec: 5,
        deadlineInSec: 30,
        rewardNear: "0.02",
        bondNear: "0.01",
        askPerSecNear: "0",
      }),
    });
    assert.equal(response.status, 400);
    const body = await asJson(response);
    assert.equal(body.ok, false);
    assert.equal(body.code, "VALIDATION");
  });

  it("creates a job, quotes it, and buys priority", async () => {
    const create = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerId: "kestrel",
        task: "incident-triage",
        title: "Board brief now",
        brief: "Deliver the incident brief before the board call.",
        input: "latency 4.8s\n5xx rate 18%",
        durationSec: 12,
        deadlineInSec: 35,
        rewardNear: "0.02",
        bondNear: "0.015",
        askPerSecNear: "0",
      }),
    });
    assert.equal(create.status, 201);
    const created = await asJson(create);
    const jobId = created.job.id;

    const quoteResponse = await fetch(
      `${base}/api/quote?jobId=${jobId}&latestStartInSec=5`,
    );
    assert.equal(quoteResponse.status, 200);
    const quoted = await asJson(quoteResponse);
    assert.equal(quoted.quote.feasible, true);
    assert.equal(quoted.quote.displaced.length, 4);

    const buy = await fetch(`${base}/api/jobs/${jobId}/priority`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ latestStartInSec: 5, maxSpendNear: "0.05" }),
    });
    assert.equal(buy.status, 200);
    const bought = await asJson(buy);
    assert.equal(bought.ok, true);
    assert.equal(bought.state.queue[0].id, jobId);
    assert.equal(bought.state.stats.moves, 4);

    const withdraw = await fetch(`${base}/api/credits/mira/withdraw`, {
      method: "POST",
    });
    assert.equal(withdraw.status, 200);
    const paid = await asJson(withdraw);
    assert.equal(paid.amountYocto, parseNear("0.00504").toString());
  });

  it("returns either a real deployment record or an honest pending state", async () => {
    const response = await fetch(`${base}/api/onchain`);
    const body = await asJson(response);
    assert.equal(body.ok, true);
    assert.equal(typeof body.deployed, "boolean");
    assert.equal(JSON.stringify(body).includes("secretKey"), false);
    if (body.deployed) {
      assert.equal(typeof body.deploy.contractId, "string");
      assert.match(body.deploy.contractId, /\.testnet$/);
    } else {
      assert.match(body.note, /deploy/i);
    }
  });

  it("serves the featured season from data/season without key material", async () => {
    const res = await fetch(`${base}/api/season`);
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.ok, true);
    if (!body.deployed || !body.run) return; // a tree without season data is allowed
    assert.equal(typeof body.run.id, "string");
    assert.ok(Array.isArray(body.run.decisions) && body.run.decisions.length <= 60);
    assert.equal(body.run.summary.stats, undefined, "lifetime contract counters are not presented as the run's");
    if (body.run.comparison) assert.ok(body.run.comparison.market.onTime <= body.run.comparison.market.jobs);
    // Public keys only: no private-key fields, no secret-looking values.
    assert.doesNotMatch(text, /secret_?key|private_?key|KeyFile|sk-[A-Za-z0-9_-]{20,}|ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/i);
  });

  it("serves Prometheus metrics", async () => {
    const response = await fetch(`${base}/api/metrics`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /queue_jobs_queued/);
    assert.match(text, /queue_http_requests_total/);
  });

  it("returns a JSON 404 for unknown API routes", async () => {
    const response = await fetch(`${base}/api/does-not-exist`);
    assert.equal(response.status, 404);
    const body = await asJson(response);
    assert.equal(body.code, "NOT_FOUND");
  });
});
