#!/usr/bin/env node
// QUEUE from a terminal. Reads need nothing; actions read QUEUE_ACCOUNT_ID and QUEUE_PRIVATE_KEY from the environment.
//
//   npm run queue -- status
//   npm run queue -- quote 12 --within 20
//   npm run queue -- submit --title "nightly digest" --input sha256:<hex> --duration 20 --deadline 300 --ask 0.0002 [--buy 0.01]
//   npm run queue -- deposit 0.05        (full-access key; a function-call key cannot attach NEAR)
//   npm run queue -- buy 12 --within 20 --max 0.01 | set-ask 12 0.0005 | cancel 12 | release 12 | withdraw | balance
//
// Output is JSON. QUEUE_CONTRACT (default market5.queue-demo.testnet) and QUEUE_RPC_URL select the target.
import { pathToFileURL } from "node:url";
import { clientFromEnv } from "./index.mjs";
import { callTool, limitsFromEnv } from "./mcp.mjs";

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

/** CLI command -> the same tool the MCP server exposes, so both paths share one implementation. */
export function toToolCall(argv) {
  const { positional, flags } = parseArgs(argv);
  const [cmd, a1, a2] = positional;
  const n = (v) => (v === undefined || v === true ? undefined : Number(v));
  switch (cmd) {
    case "status": return ["queue_status", {}];
    case "job": return ["queue_job", { job_id: n(a1) }];
    case "quote": return ["queue_quote", { job_id: n(a1), start_within_secs: n(flags.within) ?? 0 }];
    case "admission": return ["queue_admission", { duration_secs: n(flags.duration), deadline_secs: n(flags.deadline) }];
    case "balance": return ["queue_balance", {}];
    case "deposit": return ["queue_deposit", { amount_near: String(a1) }];
    case "submit": return ["queue_submit", { title: flags.title, input_hash: flags.input, duration_secs: n(flags.duration), deadline_secs: n(flags.deadline), ask_per_sec_near: String(flags.ask ?? "0"), reward_near: flags.reward, bond_near: flags.bond, priority_max_spend_near: flags.buy, priority_start_within_secs: n(flags.within) }];
    case "buy": return ["queue_buy_priority", { job_id: n(a1), start_within_secs: n(flags.within) ?? 0, max_spend_near: String(flags.max) }];
    case "set-ask": return ["queue_set_ask", { job_id: n(a1), ask_per_sec_near: String(a2) }];
    case "cancel": return ["queue_cancel", { job_id: n(a1) }];
    case "release": return ["queue_release", { job_id: n(a1) }];
    case "withdraw": return ["queue_withdraw", {}];
    default: return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const call = toToolCall(process.argv.slice(2));
  if (!call) {
    console.error("usage: queue status | job <id> | quote <id> --within <s> | admission --duration <s> --deadline <s> | balance | deposit <near> | submit --title t --input h --duration s --deadline s --ask n [--buy max] [--within s] | buy <id> --within <s> --max <near> | set-ask <id> <near> | cancel <id> | release <id> | withdraw");
    process.exit(64);
  }
  const out = await callTool(call[0], call[1], clientFromEnv(), limitsFromEnv());
  console.log(out.content[0].text);
  process.exit(out.isError ? 1 : 0);
}
