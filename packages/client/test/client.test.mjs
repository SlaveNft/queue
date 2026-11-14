import { test } from "node:test";
import assert from "node:assert/strict";
import { toYocto, fromYocto, QueueClient } from "../src/index.mjs";
import { handle, callTool, TOOLS } from "../src/mcp.mjs";
import { toToolCall } from "../src/cli.mjs";

const NEAR = 10n ** 24n;
const limits = { maxSpendYocto: toYocto("0.05") };

/** A stand-in for QueueClient: canned views, recorded writes. */
function stub({ canAct = true } = {}) {
  const calls = [];
  const job = { id: 7, owner: "a.testnet", status: "QUEUED", position: 1, duration_secs: 10, projected_start_at: 1000, projected_finish_at: 1010, deadline_at: 1100, ask_per_sec: (10n ** 18n).toString(), promised: true, verify: "operator", priority_spend: "0", moved_compensation: "0", penalty_paid: "0" };
  return {
    calls, contractId: "market5.test", accountId: canAct ? "me.testnet" : null, canAct,
    now: async () => 1000,
    queue: async () => [job],
    job: async () => job,
    config: async () => ({ accepting_work: true, operator_stake: NEAR.toString(), fee_bps: 100 }),
    credit: async () => (NEAR / 10n).toString(),
    storageDeposits: async () => ({ job: (17n * 10n ** 21n).toString(), priority_base: (6n * 10n ** 21n).toString(), priority_per_displaced: (3n * 10n ** 21n).toString() }),
    quote: async (id, latest) => ({ feasible: true, reason: "1 displaced", total: (10n ** 19n).toString(), insert_index: 0, displaced: [{ job_id: 3, owner: "b.testnet", amount: (10n ** 19n).toString(), slack_secs: 40 }], latest }),
    admission: async (d, dl) => ({ feasible_at_front: true, feasible_at_back: d < dl }),
    submit: async (a) => (calls.push(["submit", a]), { ok: true, tx: "T1", result: 9, events: [{ event: "job_submitted" }] }),
    buy: async (...a) => (calls.push(["buy", ...a]), { ok: false, tx: "T2", error: "priority infeasible: displaced job 3 would finish after its deadline" }),
    setAsk: async (...a) => (calls.push(["setAsk", ...a]), { ok: true, tx: "T3" }),
    cancel: async (...a) => (calls.push(["cancel", ...a]), { ok: true, tx: "T4" }),
    release: async (...a) => (calls.push(["release", ...a]), { ok: true, tx: "T5" }),
    withdraw: async () => (calls.push(["withdraw"]), { ok: true, tx: "T6" }),
    deposit: async (...a) => (calls.push(["deposit", ...a]), { ok: true, tx: "T7" }),
  };
}

test("NEAR amounts convert exactly, both ways", () => {
  assert.equal(toYocto("0.01"), 10n ** 22n);
  assert.equal(toYocto("1"), NEAR);
  assert.equal(toYocto("0.000000000000000000000001"), 1n);
  assert.throws(() => toYocto("1e-3"));
  assert.throws(() => toYocto("-1"));
  assert.equal(fromYocto(12_345n * 10n ** 20n), "1.2345");
  assert.equal(fromYocto(0n), "0");
});

test("a client without a key reads but cannot act", async () => {
  const c = new QueueClient({ fetchImpl: async () => ({ json: async () => ({}) }) });
  assert.equal(c.canAct, false);
  await assert.rejects(() => c.withdraw(), /no key/);
});

test("a contract refusal is a result with the contract's reason, however the library reports it", async () => {
  const failed = { transaction: { hash: "TXF" }, status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: the worker is offline: nothing was charged" } } } } }, receipts_outcome: [] };
  const c = new QueueClient({ fetchImpl: async () => ({ json: async () => ({}) }) });
  // near-api-js >= 7.5 throws on a failed execution and carries the outcome on the error
  c.account = { callFunctionRaw: async () => { throw Object.assign(new Error("Contract panicked"), { transactionResult: failed }); } };
  assert.deepEqual(await c.cancel(1), { ok: false, tx: "TXF", error: "the worker is offline: nothing was charged" });
  // older behaviour: the failed outcome is returned
  c.account = { callFunctionRaw: async () => failed };
  assert.deepEqual(await c.cancel(1), { ok: false, tx: "TXF", error: "the worker is offline: nothing was charged" });
  // never reached the contract
  c.account = { callFunctionRaw: async () => { throw new Error("fetch failed"); } };
  assert.deepEqual(await c.cancel(1), { ok: false, tx: null, error: "fetch failed" });
  // success: return value and events decoded
  c.account = { callFunctionRaw: async () => ({ transaction: { hash: "TXS" }, status: { SuccessValue: Buffer.from("9").toString("base64") }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" }, logs: ['EVENT_JSON:{"event":"job_submitted"}', "plain log"] } }] }) };
  assert.deepEqual(await c.cancel(1), { ok: true, tx: "TXS", result: 9, events: [{ event: "job_submitted" }] });
});

test("MCP: initialize, list tools, and a notification gets no reply", async () => {
  const c = stub();
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, c, limits);
  assert.equal(init.result.serverInfo.name, "queue");
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /at most 0\.05 NEAR per call/);
  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, c, limits);
  assert.equal(list.result.tools.length, TOOLS.length);
  assert.ok(list.result.tools.every((t) => t.inputSchema && !("write" in t)));
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, c, limits), null);
  const bad = await handle({ jsonrpc: "2.0", id: 3, method: "nope" }, c, limits);
  assert.equal(bad.error.code, -32601);
});

test("MCP: reads work without a key; writes say why they cannot", async () => {
  const c = stub({ canAct: false });
  const status = JSON.parse((await callTool("queue_status", {}, c, limits)).content[0].text);
  assert.equal(status.waiting[0].starts_in_secs, 0);
  assert.equal(status.waiting[0].ask_per_sec_near, "0.000001");
  const q = JSON.parse((await callTool("queue_quote", { job_id: 7, start_within_secs: 20 }, c, limits)).content[0].text);
  assert.equal(q.passes[0].paid_near, "0.00001");
  const w = await callTool("queue_withdraw", {}, c, limits);
  assert.equal(w.isError, true);
  assert.match(w.content[0].text, /no key/);
  assert.equal(c.calls.length, 0);
});

test("MCP: the spend cap stops a call before anything is signed", async () => {
  const c = stub();
  const big = await callTool("queue_buy_priority", { job_id: 7, start_within_secs: 5, max_spend_near: "0.06" }, c, limits);
  assert.equal(big.isError, true);
  assert.match(big.content[0].text, /above this server's cap/);
  const sub = await callTool("queue_submit", { title: "t", input_hash: "h", duration_secs: 5, deadline_secs: 60, ask_per_sec_near: "0", priority_max_spend_near: "0.04" }, c, limits);
  assert.equal(sub.isError, true, "escrow + storage + priority counts toward the cap");
  const dep = await callTool("queue_deposit", { amount_near: "0.2" }, c, limits);
  assert.equal(dep.isError, true, "a deposit above the cap is refused too");
  assert.equal(c.calls.length, 0);
  const ok = await callTool("queue_deposit", { amount_near: "0.05" }, c, limits);
  assert.equal(ok.isError, undefined);
  assert.deepEqual(c.calls[0], ["deposit", "0.05"]);
});

test("MCP: a contract refusal comes back as an error with the contract's reason", async () => {
  const c = stub();
  const r = await callTool("queue_buy_priority", { job_id: 7, start_within_secs: 5, max_spend_near: "0.01" }, c, limits);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /would finish after its deadline/);
  assert.deepEqual(c.calls[0], ["buy", 7, 1005, "0.01"]);
  const s = JSON.parse((await callTool("queue_submit", { title: "t", input_hash: "h", duration_secs: 5, deadline_secs: 60, ask_per_sec_near: "0.0001" }, c, limits)).content[0].text);
  assert.equal(s.result, 9);
  assert.equal(c.calls[1][1].askPerSecNear, "0.0001");
});

test("CLI commands map onto the same tools", () => {
  assert.deepEqual(toToolCall(["quote", "12", "--within", "20"]), ["queue_quote", { job_id: 12, start_within_secs: 20 }]);
  assert.deepEqual(toToolCall(["set-ask", "12", "0.0005"]), ["queue_set_ask", { job_id: 12, ask_per_sec_near: "0.0005" }]);
  assert.equal(toToolCall(["submit", "--title", "x", "--input", "h", "--duration", "5", "--deadline", "60", "--ask", "0.001", "--buy", "0.01"])[1].priority_max_spend_near, "0.01");
  assert.deepEqual(toToolCall(["deposit", "0.05"]), ["queue_deposit", { amount_near: "0.05" }]);
  assert.equal(toToolCall(["frobnicate"]), null);
});
