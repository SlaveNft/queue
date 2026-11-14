import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAction, clampAction, fallbackAction, buildPrompt, marketLine, near, PERSONAS, LIMITS, type Observation } from "./agents.ts";
import { attestedArgs, extractJson, sha256hex } from "./nearai.ts";
import { generateKeyPairSync, sign } from "node:crypto";

const job = (over: Record<string, unknown> = {}) => ({
  id: 7, owner: "mira.t", title: "x", input_hash: "h", input_uri: "", duration_secs: 10, deadline_at: 1100, submitted_at: 1000,
  reward: "1", bond: "1", ask_per_sec: near("0.0005").toString(), status: "QUEUED" as const, expedited: false,
  moved_compensation: "0", priority_spend: "0", position: 3, projected_start_at: 1050, projected_finish_at: 1060, ...over,
});
const obs = (over: Partial<Observation> = {}): Observation => ({
  now: 1000, balanceYocto: near("0.4"), own: [{ job: job() }], queue: [job()], running: null, recent: [], ...over,
});

test("parses JSON wrapped in prose, fences and think tags", () => {
  assert.deepEqual(extractJson('<think>hmm</think>```json\n{"action":"wait","reason":"ok"}\n```'), { action: "wait", reason: "ok" });
  const a = parseAction('Sure! {"action":"set_ask","job_id":7,"ask_per_sec_near":0.001,"reason":"tight"} hope that helps');
  assert.equal(typeof a, "object");
  assert.equal((a as { action: string }).action, "set_ask");
});

test("rejects malformed or unknown actions with a reason", () => {
  assert.match(String(parseAction("no json here")), /not a JSON/);
  assert.match(String(parseAction('{"action":"transfer","to":"x"}')), /unknown action/);
  assert.match(String(parseAction('{"action":"buy_priority","job_id":7}')), /needs/);
});

test("runtime limits: only own jobs, ask clamped, spend capped by value and balance", () => {
  const two = obs({ own: [{ job: job() }, { job: job({ id: 8 }) }] });
  assert.match(String(clampAction({ action: "set_ask", job_id: 99, ask_per_sec_near: 0.001, reason: "" }, two)), /not yours/);
  const ask = clampAction({ action: "set_ask", job_id: 7, ask_per_sec_near: 5, reason: "" }, obs());
  assert.ok(typeof ask === "object" && ask.action.action === "set_ask");
  // 0.0005 * 4 = 0.002 step cap, below the hard ceiling
  assert.ok(typeof ask === "object" && "ask_per_sec_near" in ask.action && ask.action.ask_per_sec_near <= 0.002 + 1e-12);
  const own = [{ job: job(), task: { valueYocto: near("0.05") } as never }];
  const buy = clampAction({ action: "buy_priority", job_id: 7, latest_start_in_secs: 3.6, max_spend_near: 10, reason: "" }, obs({ own }));
  assert.ok(typeof buy === "object" && buy.action.action === "buy_priority");
  if (typeof buy === "object" && buy.action.action === "buy_priority") {
    // Pre-filter assumes at least one jump: storage = 0.006 + 0.003 = 0.009; 0.05 value - 0.009 = 0.041 all-in cap.
    // (The runtime re-prices the exact jump from a fresh quote before sending.)
    assert.ok(Math.abs(buy.action.max_spend_near - 0.041) < 1e-9);
    assert.equal(buy.action.latest_start_in_secs, 4);
  }
  const broke = clampAction({ action: "buy_priority", job_id: 7, latest_start_in_secs: 0, max_spend_near: 1, reason: "" }, obs({ own, balanceYocto: near("0.01") }));
  assert.match(String(broke), /no budget/);
  assert.match(String(clampAction({ action: "submit", ask_per_sec_near: 0.001, reason: "" }, obs())), /no pending/);
  assert.ok(LIMITS.maxAskNearPerSec < 0.01);
});

test("fallback policy always returns a valid action", () => {
  for (const p of PERSONAS) {
    const a = fallbackAction(p, obs());
    assert.ok(["submit", "set_ask", "buy_priority", "cancel", "wait"].includes(a.action));
  }
});

test("attestedArgs accepts the model form only and rejects edits", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const c = { requestBody: '{"model":"m"}', responseBody: '{"id":"1"}' };
  const textP = `m:${sha256hex(c.requestBody)}:${sha256hex(c.responseBody)}`;
  const textG = `${sha256hex(c.requestBody)}:${sha256hex(c.responseBody)}`;
  const sg = (t: string) => sign(null, Buffer.from(t), privateKey).toString("hex");
  const p = attestedArgs(c, { text: textP, signature: sg(textP), signing_address: pub, signing_algo: "ed25519" }, "m", [pub]);
  assert.ok(p.ok && p.model === "m");
  const g = attestedArgs(c, { text: textG, signature: sg(textG), signing_address: pub, signing_algo: "ed25519" }, "m");
  assert.equal(g.ok, false, "gateway receipts are refused");
  const edited = attestedArgs({ ...c, responseBody: '{"id":"2"}' }, { text: textP, signature: sg(textP), signing_address: pub, signing_algo: "ed25519" }, "m");
  assert.equal(edited.ok, false);
  const unpinned = attestedArgs(c, { text: textP, signature: sg(textP), signing_address: pub, signing_algo: "ed25519" }, "m", ["00".repeat(32)]);
  assert.equal(unpinned.ok, false);
});

test("set_ask on an unknown id with a pending task becomes a submission", () => {
  const pending = { template: PERSONAS[0].tasks[0], valueYocto: near("0.05"), durationSecs: 12, deadlineSecs: 90, requestBody: "{}", inputHash: "h", arrivedAt: 1000 };
  const r = clampAction({ action: "set_ask", job_id: 9001, ask_per_sec_near: 0.001, reason: "price it" }, obs({ pending, own: [] }));
  assert.ok(typeof r === "object" && r.action.action === "submit" && /read as submit/.test(r.note ?? ""));
});

test("a submission the balance cannot cover is stopped before it costs a transaction", () => {
  const pending = { template: PERSONAS[0].tasks[0], valueYocto: near("0.05"), durationSecs: 12, deadlineSecs: 90, requestBody: "{}", inputHash: "h", arrivedAt: 1000 };
  assert.match(String(clampAction({ action: "submit", ask_per_sec_near: 0.001, reason: "" }, obs({ pending, own: [], balanceYocto: near("0.02") }))), /balance below the submit cost/);
  const ok = clampAction({ action: "submit", ask_per_sec_near: 0.001, reason: "" }, obs({ pending, own: [], balanceYocto: near("0.05") }));
  assert.ok(typeof ok === "object" && ok.action.action === "submit");
  // The fallback does not try to submit what it cannot pay for.
  assert.notEqual(fallbackAction(PERSONAS[0], obs({ pending, own: [], balanceYocto: near("0.02") })).action, "submit");
});

test("the prompt shows the deadline that remains, not the one at arrival", () => {
  const pending = { template: PERSONAS[0].tasks[0], valueYocto: near("0.05"), durationSecs: 12, deadlineSecs: 90, requestBody: "{}", inputHash: "h", arrivedAt: 1000 };
  const body = JSON.parse(buildPrompt(PERSONAS[0], obs({ pending, now: 1030 }), "m"));
  assert.match(body.messages[1].content, /deadline in 60s/);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.ok(body.max_tokens <= 300);
});

test("buy_priority on a foreign id is read as the agent's only queued job", () => {
  const own = [{ job: job({ id: 272, position: 2 }), task: { valueYocto: near("0.05") } as never }];
  const r = clampAction({ action: "buy_priority", job_id: 269, latest_start_in_secs: 5, max_spend_near: 0.02, reason: "" }, obs({ own }));
  assert.ok(typeof r === "object" && r.action.action === "buy_priority" && r.action.job_id === 272);
  assert.match(String(typeof r === "object" ? r.note : ""), /read as your only queued job #272/);
  // Two queued jobs: ambiguous, so still refused.
  const two = [{ job: job({ id: 272 }) }, { job: job({ id: 273 }) }];
  assert.match(String(clampAction({ action: "buy_priority", job_id: 269, latest_start_in_secs: 5, max_spend_near: 0.02, reason: "" }, obs({ own: two }))), /not yours/);
});

test("buy_priority start is bounded by the deadline and the cap counts earlier spend", () => {
  const own = [{ job: job({ position: 1, priority_spend: near("0.03").toString() }), task: { valueYocto: near("0.05") } as never }];
  const r = clampAction({ action: "buy_priority", job_id: 7, latest_start_in_secs: 1e30, max_spend_near: 1, reason: "" }, obs({ own }));
  assert.ok(typeof r === "object" && r.action.action === "buy_priority");
  if (typeof r === "object" && r.action.action === "buy_priority") {
    assert.equal(r.action.latest_start_in_secs, 100); // deadline_at 1100 - now 1000
    assert.ok(Math.abs(r.action.max_spend_near - (0.05 - 0.009 - 0.03)) < 1e-9);
  }
});

test("a set_ask read as a submission still respects the balance", () => {
  const pending = { template: PERSONAS[0].tasks[0], valueYocto: near("0.05"), durationSecs: 12, deadlineSecs: 90, requestBody: "{}", inputHash: "h", arrivedAt: 1000 };
  assert.match(String(clampAction({ action: "set_ask", job_id: 9001, ask_per_sec_near: 0.001, reason: "" }, obs({ pending, own: [], balanceYocto: near("0.01") }))), /balance below/);
});

test("the market line shows the spread of asks, the ceiling crowd and which asks were paid", () => {
  const ask = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();
  const q = [
    job({ id: 1, owner: "mira.t", ask_per_sec: ask(0.0002) }),
    job({ id: 2, owner: "atlas.t", ask_per_sec: ask(0.004), moved_compensation: "0" }),
    job({ id: 3, owner: "vale.t", ask_per_sec: ask(0.0006), moved_compensation: near("0.003").toString() }),
    job({ id: 4, owner: "kestrel.t", ask_per_sec: ask(0.001) }),
  ];
  const line = marketLine(q, "kestrel.");
  assert.match(line, /lowest 0\.000200, median 0\.000600, highest 0\.004000/);
  assert.match(line, /1 of 3 sit at the 0\.004 ceiling/);
  assert.match(line, /1 waiting job\(s\) were already paid to move back, at asks 0\.000600\.\.0\.000600/);
  assert.equal(marketLine([job({ owner: "kestrel.t" })], "kestrel."), "MARKET: no other jobs are waiting.");
});

test("a waiting cost reaches the prompt only when the task carries one", () => {
  const base = { template: PERSONAS[0].tasks[0], valueYocto: near("0.05"), durationSecs: 12, deadlineSecs: 90, requestBody: "{}", inputHash: "h", arrivedAt: 1000 };
  const without = JSON.parse(buildPrompt(PERSONAS[0], obs({ pending: base, now: 1000 }), "m")).messages[1].content;
  assert.doesNotMatch(without, /costs you/);
  const withCost = JSON.parse(buildPrompt(PERSONAS[0], obs({ pending: { ...base, waitCostNear: 0.00012 }, now: 1000 }), "m")).messages[1].content;
  assert.match(withCost, /Every second until it is done costs you 0\.000120 NEAR/);
  assert.match(withCost, /MARKET:/);
});
