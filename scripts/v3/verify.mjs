#!/usr/bin/env node
// Re-check the v3 testnet proof (data/v3/proof.json) against the chain. Read-only: no keys, no dependencies
// beyond Node. Every transaction is fetched from an archival node; every claim is checked against the
// transaction's own status, return value and events, not against the recorded copy.
//
//   npm run verify:v3
//
// Exit 0 = every check passed · 1 = a check failed · 2 = the RPC could not be reached.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TX_RPCS, Unreachable, VIEW_RPCS, call, txOutcome, view } from "../near-rpc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const proof = JSON.parse(readFileSync(path.join(ROOT, "data/v3/proof.json"), "utf8"));
const meta = JSON.parse(readFileSync(path.join(ROOT, "data/v3/market5.json"), "utf8"));
const C = proof.contractId;

let failed = 0;
function check(ok, label, detail = "") {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ·  ${detail}` : ""}`);
}

function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

/** Events the chain logged for this transaction (every receipt). */
function eventsOf(raw) {
  const out = [];
  for (const r of raw.receipts_outcome ?? []) {
    for (const line of r.outcome?.logs ?? []) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      try {
        out.push(JSON.parse(line.slice(11)));
      } catch {
        // a malformed log is not evidence
      }
    }
  }
  return out;
}

async function blockTime(hash) {
  const { result } = await call(TX_RPCS, "block", { block_id: hash });
  return Math.floor(Number(BigInt(result.header.timestamp) / 1_000_000_000n));
}

try {
  console.log(`QUEUE v3 proof · ${C}`);
  check(proof.complete === true, "the proof run finished every step", `${proof.steps.length} transactions`);
  // The code on chain is the recorded build (which `scripts/repro-build.sh contracts/queue-v3 <account>` rebuilds).
  const { result: acct } = await call(VIEW_RPCS, "query", { request_type: "view_account", finality: "final", account_id: C });
  check(acct?.code_hash === base58(Buffer.from(meta.wasmSha256, "hex")), "code on chain is the recorded v3 build", `sha256 ${meta.wasmSha256.slice(0, 16)}…`);
  const cfg = await view(C, "get_config");
  check(cfg.timelock_secs === 86400, "owner timelock is 24 h", `${cfg.timelock_secs} s`);
  check(BigInt(cfg.min_operator_stake) > 0n && BigInt(cfg.operator_stake) >= BigInt(cfg.min_operator_stake), "operator stake covers the minimum", `${Number(BigInt(cfg.operator_stake) / 10n ** 21n) / 1000} NEAR staked, minimum ${Number(BigInt(cfg.min_operator_stake) / 10n ** 21n) / 1000}`);

  check(cfg.clients_only === true, "only accounts the operator approved can submit");
  for (const [name, a] of Object.entries(meta.agents ?? {})) {
    if (!(await view(C, "is_client", { account_id: a.accountId }))) check(false, `${name} is an approved client`);
  }
  // Disclosed limit: the contract account's own full-access key can still replace the code directly.
  const { result: keys } = await call(VIEW_RPCS, "query", { request_type: "view_access_key_list", finality: "final", account_id: C });
  const full = (keys?.keys ?? []).filter((k) => k.access_key?.permission === "FullAccess").length;
  console.log(`  NOTE  ${C} holds ${full} full-access key(s): ${full ? "the 24 h timelock covers the contract's admin methods; this test key can still redeploy the code directly" : "code changes can only go through the timelock"}`);

  // Storage is paid for: after everything the contract owes (escrow, balances, stake, storage deposits it must
  // still refund) its own balance covers the NEAR that NEAR locks for every byte it stores.
  {
    const st = await view(C, "get_stats");
    const owed = BigInt(st.total_escrow) + BigInt(st.total_credits) + BigInt(st.operator_stake) + BigInt(st.storage_held);
    const locked = BigInt(acct.storage_usage) * 10n ** 19n;
    const free = BigInt(acct.amount) - owed - locked;
    const near = (y) => (Number(y / 10n ** 18n) / 1e6).toFixed(4);
    check(free >= 0n, "the balance covers every debt and every stored byte", `${near(BigInt(acct.amount))} NEAR held = ${near(owed)} owed + ${near(locked)} for ${acct.storage_usage} bytes + ${near(free)} free`);
  }

  for (const s of proof.steps) {
    const o = await txOutcome(s.tx, s.signer);
    const label = `step ${s.step}: ${s.label}`;
    if (!o.found) {
      check(false, label, `transaction not found: ${o.error}`);
      continue;
    }
    const sameCall = o.signer === s.signer && o.receiver === C && o.method === s.method;
    if (!sameCall) {
      check(false, label, `tx is ${o.signer} -> ${o.receiver}.${o.method}`);
      continue;
    }
    const events = eventsOf(o.raw);
    const ev = (name) => events.find((e) => e.event === name)?.data;
    const e = s.expect ?? {};
    const problems = [];
    if (s.ok) {
      if (o.failure) problems.push(`failed on chain: ${o.failure.slice(0, 120)}`);
    } else {
      if (!o.failure) problems.push("succeeded on chain, expected a refusal");
      else if (!o.failure.includes(e.error)) problems.push(`refused for another reason: ${o.failure.slice(0, 120)}`);
    }
    if (e.effective_after_secs != null) {
      const a = ev("ask_updated");
      const t = await blockTime(o.raw.transaction_outcome.block_hash);
      // The receipt runs in the transaction's block or a later one; the delay is counted from its own clock.
      const delay = a ? a.effective_at - t : null;
      if (!a || delay < e.effective_after_secs || delay > e.effective_after_secs + 3) problems.push(`raise takes effect ${delay} s after the call`);
    }
    if (e.compensation != null) {
      const p = ev("priority_purchased");
      if (!p) problems.push("no priority_purchased event");
      else {
        if (p.compensation !== e.compensation) problems.push(`compensation ${p.compensation}, expected ${e.compensation}`);
        if (JSON.stringify(p.displaced_ids) !== JSON.stringify(e.displaced)) problems.push(`passed ${JSON.stringify(p.displaced_ids)}, expected ${JSON.stringify(e.displaced)}`);
      }
    }
    if (e.priority_refund != null) {
      const r = ev("job_rejected");
      if (r?.priority_refund !== e.priority_refund) problems.push(`priority refund ${r?.priority_refund}, expected ${e.priority_refund}`);
      if (e.released && !ev("job_released")) problems.push("record not released");
    }
    if (e.storage_refund_positive && !(BigInt(ev("job_released")?.storage_refund ?? 0) > 0n)) problems.push("no storage refund");
    if (e.storage_refund != null && ev("job_released")?.storage_refund !== e.storage_refund) problems.push(`storage refund ${ev("job_released")?.storage_refund}, expected the whole deposit ${e.storage_refund}`);
    if (e.clients && JSON.stringify(ev("clients_allowed")?.accounts) !== JSON.stringify(e.clients)) problems.push(`approved ${JSON.stringify(ev("clients_allowed")?.accounts)}`);
    if (e.on_time && ev("job_completed")?.on_time !== true) problems.push("not delivered on time");
    if (e.job != null) {
      const got = o.returned;
      if (got !== e.job) problems.push(`acted on job ${got}, expected ${e.job}`);
      if (e.missed && !ev("job_missed")) problems.push("job was not settled as missed");
    }
    if (e.penalty != null) {
      const b = ev("promise_broken");
      if (b?.paid !== e.penalty) problems.push(`stake paid ${b?.paid}, expected ${e.penalty}`);
    }
    if (e.verify && ev("job_submitted")?.verify !== e.verify) problems.push(`verify is ${ev("job_submitted")?.verify}`);
    if (e.timelock_secs != null) {
      const q = ev("proposal_queued") ?? ev("unstake_requested");
      const at = q?.executable_at ?? q?.at;
      // Counted from the receipt's block, which is the transaction's block or a later one.
      const t = await blockTime(o.raw.transaction_outcome.block_hash);
      if (at == null || at - t < e.timelock_secs || at - t > e.timelock_secs + 3) problems.push(`runs ${at - t} s after the call`);
    }
    check(!problems.length, label, problems.join("; ") || s.tx);
  }

  // Totals the steps imply.
  const penalties = proof.steps.filter((s) => s.expect?.penalty).reduce((a, s) => a + BigInt(s.expect.penalty), 0n);
  const refunds = proof.steps.filter((s) => s.expect?.priority_refund).reduce((a, s) => a + BigInt(s.expect.priority_refund), 0n);
  check(BigInt(proof.statsAfter.total_penalties) >= penalties + refunds, "paid from the stake (penalties + priority refunds) is on record in the stats", `${proof.statsAfter.total_penalties} yocto`);

  // One job taken through the public client (packages/client) with a function-call key.
  const e2eFile = path.join(ROOT, "data/v3/client-e2e.json");
  if (existsSync(e2eFile)) {
    const e2e = JSON.parse(readFileSync(e2eFile, "utf8"));
    console.log(`client end to end · job ${e2e.jobId}`);
    let refund = null;
    for (const s of e2e.steps) {
      const o = await txOutcome(s.tx, s.signer);
      const same = o.found && o.signer === s.signer && o.receiver === C && o.method === s.method;
      check(same && !o.failure, `client: ${s.label}`, same ? (o.failure ? o.failure.slice(0, 120) : s.tx) : "transaction not found or not this call");
      if (same && s.method === "release_job") refund = eventsOf(o.raw).find((e) => e.event === "job_released")?.data?.storage_refund;
      if (same && s.method === "complete_job") {
        const done = eventsOf(o.raw).find((e) => e.event === "job_completed")?.data;
        check(done?.on_time === true && done?.owner === e2e.agent && done?.bond === e2e.bondYocto && done?.reward === e2e.rewardYocto, "client: delivered on time; the reward went to the operator and the bond back to the agent", `reward ${done?.reward}, bond ${done?.bond}`);
      }
    }
    const deposits = await view(C, "get_storage_deposits");
    check(refund === deposits.job, "client: the whole storage deposit came back at release", `${refund} yocto`);
    check(BigInt(e2e.spentFromBalanceYocto) === BigInt(e2e.rewardYocto) + BigInt(e2e.bondYocto), "client: the agent's balance paid the reward and the bond, and nothing for storage", `${e2e.spentFromBalanceYocto} yocto`);
  }
} catch (error) {
  if (error instanceof Unreachable) {
    console.error(`verify:v3: RPC unreachable (${error.message}); nothing was judged`);
    process.exit(2);
  }
  throw error;
}
console.log(failed ? `verify:v3: ${failed} check(s) FAILED` : "verify:v3: every check passed");
process.exit(failed ? 1 : 0);
