import test from "node:test";
import assert from "node:assert/strict";
import {
  deliveredCount,
  formatGeneratedAt,
  groupProofTxs,
  normalizeProof,
} from "../src/lib/proof";

const TXS = [
  { hash: "a".repeat(40), label: "submit mira job 1" },
  { hash: "b".repeat(40), label: "submit kestrel job 5" },
  { hash: "c".repeat(40), label: "priority purchase" },
  { hash: "d".repeat(40), label: "REFUSED jump: contract panics" },
  { hash: "e".repeat(40), label: "start mira job 1" },
  { hash: "f".repeat(40), label: "deliver mira job 1 on time" },
  { hash: "g".repeat(40), label: "withdraw mira credit" },
];

test("normalizeProof keeps public proof fields, generatedAt and refusal", () => {
  const view = normalizeProof({
    deployed: true,
    contractId: "market.queue-demo.testnet",
    wasmSha256: "10546489ceb8c1127939023e043cf15ac13e3481b708d184e828c92b516396d6",
    generatedAt: "2026-11-13T09:01:51.640Z",
    explorer: "https://testnet.nearblocks.io/address/market.queue-demo.testnet",
    transactions: TXS,
    refusal: {
      tightJob: { id: 6, owner: "orion", durationSecs: 8, deadlineSecs: 60 },
      jumpingJob: { id: 7, owner: "kestrel", durationSecs: 60 },
      contractError: "priority infeasible: displaced job 6 would finish after its deadline",
      tx: "h".repeat(40),
      quote: { feasible: false, reason: "displaced job 6 would finish late" },
    },
  });

  assert.ok(view);
  assert.equal(view.contractId, "market.queue-demo.testnet");
  assert.equal(view.explorer, "https://testnet.nearblocks.io");
  assert.equal(view.generatedAt, "2026-11-13T09:01:51.640Z");
  assert.equal(view.txs.length, TXS.length);
  assert.equal(view.refusal?.tightJob?.id, "6");
  assert.equal(view.refusal?.jumpingJob?.owner, "kestrel");
  assert.match(view.refusal?.contractError ?? "", /deadline/);
});

test("a successful deployed:false response is not a deployment", () => {
  assert.equal(normalizeProof({ deployed: false, contractId: "market.queue-demo.testnet" }), null);
});

test("groupProofTxs covers every transaction exactly once", () => {
  const groups = groupProofTxs(TXS);
  const flat = groups.flatMap((group) => group.txs.map((tx) => tx.hash));
  assert.equal(flat.length, TXS.length);
  assert.deepEqual(new Set(flat), new Set(TXS.map((tx) => tx.hash)));
  assert.equal(groups.find((group) => group.key === "submissions")?.txs.length, 2);
  assert.equal(groups.find((group) => group.key === "refused")?.txs.length, 1);
  assert.equal(groups.find((group) => group.key === "credits")?.txs.length, 1);
});

test("deliveredCount and generated timestamps are display-safe", () => {
  assert.equal(deliveredCount(TXS), 1);
  assert.equal(formatGeneratedAt("2026-11-13T09:01:51.640Z"), "2026-11-13 09:01 UTC");
  assert.equal(formatGeneratedAt("not a date"), null);
  assert.equal(formatGeneratedAt(undefined), null);
});
