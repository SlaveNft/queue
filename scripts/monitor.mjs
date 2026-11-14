#!/usr/bin/env node
/**
 * Watch the season contract and say when something is wrong. Read-only: public RPC views, no keys, no transactions.
 *
 *   npm run monitor                 one check; exit code 1 if any ALERT
 *   npm run monitor -- --watch 10   check every 10 minutes until stopped
 *
 * Checks: the contract holds at least what it owes (escrow + credits) on top of its storage; every job is in exactly
 * one state (the counters add up); whether new work is paused; who operates it; and which keys the contract account
 * still holds. Set QUEUE_CONTRACT to watch another deployment (default: the v2 season, market4).
 */
const ACCOUNT = process.env.QUEUE_CONTRACT ?? "market4.queue-demo.testnet";
const RPCS = (process.env.QUEUE_RPC_URLS || "https://rpc.testnet.near.org,https://rpc.testnet.fastnear.com,https://test.rpc.fastnear.com").split(",");
const YOCTO_PER_BYTE = 10n ** 19n;
const near = (y) => (Number(y / 10n ** 21n) / 1000).toFixed(3);

async function rpc(params) {
  let last;
  for (let i = 0; i < 3 * RPCS.length; i++) {
    try {
      const r = await fetch(RPCS[i % RPCS.length], { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.result) return j.result;
      last = new Error(JSON.stringify(j.error ?? j).slice(0, 200));
    } catch (e) { last = e; }
    await new Promise((ok) => setTimeout(ok, 800));
  }
  throw last;
}
const view = async (method, args = {}) => JSON.parse(Buffer.from((await rpc({ request_type: "call_function", account_id: ACCOUNT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })).result).toString());

async function check() {
  const alerts = [], notes = [];
  const st = await view("get_stats"), cfg = await view("get_config");
  const acc = await rpc({ request_type: "view_account", account_id: ACCOUNT });
  const owed = BigInt(st.total_escrow) + BigInt(st.total_credits);
  const spare = BigInt(acc.amount) - BigInt(acc.storage_usage) * YOCTO_PER_BYTE - owed;
  (spare >= 0n ? notes : alerts).push(`balance ${near(BigInt(acc.amount))} NEAR covers storage (${acc.storage_usage} bytes) and what it owes (escrow ${near(BigInt(st.total_escrow))} + credits ${near(BigInt(st.total_credits))}), ${near(spare)} NEAR to spare`);
  const states = st.completed + st.missed + st.cancelled + st.failed + st.running + st.queued;
  (states === st.submitted ? notes : alerts).push(`jobs: ${st.submitted} submitted = ${st.completed} done + ${st.missed} missed + ${st.cancelled} cancelled + ${st.failed} failed + ${st.running} running + ${st.queued} queued`);
  notes.push(`new work ${cfg.paused ? "PAUSED by the owner" : "open"}; operator ${cfg.operator_id}; fee ${cfg.fee_bps / 100}%; ${cfg.tee_signers.length} pinned TEE key(s)`);
  const keys = (await rpc({ request_type: "view_access_key_list", account_id: ACCOUNT })).keys;
  notes.push(`contract account keys: ${keys.length ? keys.map((k) => (k.access_key.permission === "FullAccess" ? "full access" : "function call")).join(", ") : "none (nobody can change its code)"}`);
  const at = new Date().toISOString().slice(0, 16).replace("T", " ");
  for (const n of notes) console.log(`${at}  ok     ${n}`);
  for (const a of alerts) console.log(`${at}  ALERT  ${a}`);
  return alerts.length;
}

const w = process.argv.indexOf("--watch");
if (w > 0) {
  const minutes = Number(process.argv[w + 1] ?? 10);
  for (;;) { try { await check(); } catch (e) { console.log(`ALERT  the contract could not be read: ${e.message ?? e}`); } await new Promise((ok) => setTimeout(ok, minutes * 60_000)); }
} else process.exit((await check()) ? 1 : 0);
