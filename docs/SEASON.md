# QUEUE v2 — the live season

The v1 contract (`market.queue-demo.testnet`) proves the settlement rule with a scripted story. v2 puts the same rule under load: **eight model-driven agents share one model-backed worker** on NEAR testnet for 30 minutes. Every agent signs its own transactions with a key that can do almost nothing, and every completion is checked against a signature from a NEAR AI key the owner pinned.

| | |
| --- | --- |
| Season contract | [`market4.queue-demo.testnet`](https://testnet.nearblocks.io/address/market4.queue-demo.testnet), source `contracts/queue-v2` (62 tests). `npm run verify:v2-deployed` builds that source and compares it with the code on chain. |
| Owner | `owner2.queue-demo.testnet` (a separate account: pins the model key, can pause; holds no escrow) |
| Operator | `worker.queue-demo.testnet` |
| Agents | kestrel, mira, atlas, vale, juno, orion, lyra, sable `.queue-demo.testnet` |
| Model | `Qwen/Qwen3.6-35B-A3B-FP8` on NEAR AI, for the agents and for the worker |
| Public metadata | [`data/season/testnet.json`](../data/season/testnet.json) (no secrets) |
| The run | [`data/season/testnet-season-4/`](../data/season/testnet-season-4/): `events.jsonl`, `jobs.json`, `summary.json`, `comparison.json`, every request body and every signed response |

The season is jobs #135–#275 on this contract. Jobs #1–#134 are a shakedown run of the same build made before the season, and job #276 is the payout-recovery check described below; neither is counted here.

## Result (30 minutes, 13 Nov 2026)

Re-check every number below with `npm run verify:season` (read-only, no keys).

| | |
| --- | --- |
| Decisions | 262, all made by the model; 17 turns were skipped because nothing the agent could see had changed |
| Jobs | 146 tasks arrived; 141 were submitted, 3 cancelled by their owners, **138 ran** |
| On time | **135 of 138**. The 3 late jobs were never moved by a purchase and never started: the contract settled them as missed and refunded them in full |
| Market moves | **4 paid priority purchases** ([sable #209](https://testnet.nearblocks.io/txns/BJwL3P9CAfqC7xFT5aCPcj7xQmruofZwKd3EehoogXGv), [orion #217](https://testnet.nearblocks.io/txns/Bqekxk6fKTHoErhVRXwre1PT3byxLiyARvuVJdWgS2jV), [kestrel #219](https://testnet.nearblocks.io/txns/71jrPre4K2e6L6xJyjbASaAVLYaGQ7mXvVRA31uacTRH), [sable #258](https://testnet.nearblocks.io/txns/G3H7Huy8NarYtHs96HymAY57aCSKvRSFkafPsX3zLccn)) moved **5 jobs** back. Each was paid its own posted price, **0.0965 NEAR** in total, and **none of them ended late**. 16 ask changes |
| Signed settlements | **135** jobs settled with `complete_job_attested` ([example, job 145](https://testnet.nearblocks.io/txns/Hnuu7i6H3qH1v56gudxjL5aVQAGRVjo8FDc6ag9XZ2K8)); 0 by operator attestation |
| Contract refusals | **7** failed transactions, each re-checked over RPC (listed below) |
| Runtime limits | 2 purchases stopped in code before reaching the chain: the jump cost more than the task was worth |
| Inference cost | about $0.06 for the whole season (agents and worker) |

**The contract refused an unsafe jump made by a model.** Kestrel's model tried to move job #219 ahead of job #217. That would have pushed #217 past its deadline, and the contract [failed the transaction](https://testnet.nearblocks.io/txns/3BrEneh1ypSrWAGtr73nU6hE4u5wRSzJFsWbeKjtUhdj): `priority infeasible: displaced job 217 would finish at 1794600686, after its deadline 1794600670`. Kestrel then bought a later slot that kept every deadline.

The other six refusals: two purchases the buyer's own deadline could no longer make (#187, #192), one with nothing left to buy (#190), two submissions of jobs that could not finish even from the front of the queue, and one ask change on a job that had already started.

### Compared with FIFO and a blind priority fee

The market row is what ran on chain. The other two rows replay the same 138 jobs under a different rule, keeping each job's real service time and the measured gap between jobs (mean 3.93 s).

| Same 138 jobs | On time | Value on time (agents' private values) | Paid to jobs moved back | Late, though on time under FIFO |
| --- | ---: | ---: | ---: | ---: |
| QUEUE market (what ran) | **135** | **5.895 NEAR** | 0.0965 NEAR | **0** |
| FIFO | 134 | 5.816 NEAR | — | — |
| Blind priority fee | 134 | 5.746 NEAR | 0 (0.263 NEAR goes to the operator) | 4 |

Read the throughput column with care. The replays rest on one constant, the worker gap. Across ±0.5 s of it the three rules stay within a job or two of each other:

| Worker gap | Replay of the market's order | FIFO | Blind fee |
| ---: | ---: | ---: | ---: |
| 3.43 s | 136 | 136 | 136 |
| 3.68 s | 135 | 135 | 134 |
| **3.93 s (measured)** | **135** | **134** | **134** |
| 4.18 s | 133 | 132 | 132 |
| 4.43 s | 132 | 131 | 132 |

So on throughput the market is **level with FIFO**: it reorders one queue, it does not add capacity. What does not depend on the timing model is read straight from chain: who was paid, who was refused, and that no job moved by a purchase ended late. A blind fee on the same jobs makes 4 jobs late that FIFO would have delivered, and pays their owners nothing.

One run, one seed. This is evidence that the rule holds with model agents, not a welfare study.

## How it works

### Agents pay from a balance, so they can sign with a function-call key

A NEAR function-call access key cannot attach a deposit. v2 therefore has `deposit()`: each agent deposits once with its full key, and from then on `submit_job` (with an explicit `bond`) and `request_priority`, called with **zero attached deposit**, spend from that balance. The balance is the same pull credit that displacement payments go to, so money an agent earns by being moved back can pay for its own jump later.

Each agent's runtime holds only a function-call key for the season contract, limited to `submit_job`, `set_move_ask`, `request_priority`, `cancel_job` and `withdraw_credit`. It cannot transfer NEAR, call another contract or attach a deposit, and `withdraw_credit` only ever pays the caller's own account.

An agent has **two separate budgets**: its balance in the contract (queue actions debit it, storage deposits included) and the key's **gas allowance** (0.25 NEAR), which only pays transaction fees. A leaked agent key can spend the first on queue actions and burn the second on gas; it cannot move NEAR anywhere else.

### Completion is verified, not just attested

`complete_job_attested(job_id, response, signature, signer, model)`:

- `input_hash` is fixed at submission as `sha256` of the **exact request body** the worker will send to NEAR AI. The body is published under `requests/`, and it names the contract, the run and a fresh nonce.
- The first job to submit a request hash owns it. A copy of that hash is refused at submission, and a claimed request can settle only its own job.
- The contract hashes `response` itself and rebuilds the signed text `{model}:{input_hash}:{sha256(response)}`. Only this model form is accepted; a gateway receipt (`{input_hash}:{sha256(response)}`) is refused because it does not show which model ran.
- It verifies the ed25519 signature against a key the owner pinned with `set_tee_signers`, and the model id against the one pinned with `set_tee_model`. The season pins `model_attestations[].signing_address` for the model from NEAR AI's public `/v1/attestation/report` (saved in `data/season/attestation-*.json`).
- **One signed answer settles one job.**

So a completion verifies only for an answer to *this job's* exact request, signed by the pinned model key, used once. An edited answer, an answer to another prompt, a reused answer, a gateway receipt, a wrong model name or an unpinned key is refused (all tested). `complete_job` (operator attestation) exists as a labelled fallback; `get_job(..).attested` says which path a job took.

What this does **not** prove: that the hardware quote is genuine, that the answer is good, or that the answer was produced inside the job's slot. The contract checks a signature by a pinned key; it does not verify an Intel/NVIDIA quote. This is **pinned-key attestation**, not a trustless TEE proof.

### The rules the contract enforces

- **Deadline safety with margins.** A purchase is refused if any job it passes would finish within 3 s of its deadline, plus 1 s for each hand-off ahead of that job. The buyer's own slot needs the same 3 s. Settling one job and starting the next are separate transactions, so every start lands a little after its projection; the margins absorb that.
- **No hopeless work.** `submit_job` requires `deadline_secs >= duration_secs` and refuses a job that could not finish even from the front slot. A job that is merely late at the back is welcome: buying earlier slots is what the market is for. Patient agents can opt in to a stricter check with `require_feasible_at_back`, and `get_admission` shows both finish times before submitting.
- **The worker's time is not wasted.** `start_next` settles a head that can no longer finish (2 s completion margin) as missed, with a full refund, instead of starting it.
- **Bounded prices.** Asks are capped at 1 NEAR per second, so a quote is always computed.
- **Storage is paid for.** A job's 0.017 NEAR deposit covers everything it can ever write (worst case measured in tests: 1,669 of 1,700 bytes); a priority record pays 0.006 NEAR plus 0.003 per job passed. `max_spend` caps the price, not this storage; the runtime budgets both.
- **Payouts cannot strand money.** Every native transfer carries a private callback that restores a failed payout as a pull credit. Checked on the live contract: a job's owner account was deleted while the job ran, the bond transfer failed, and the contract [credited the bond back](https://testnet.nearblocks.io/txns/BsiMG2jX11ZeTY2ee7avSMASgCXZSPHrSkNMCiZEUnm3) (`payout_failed_credited`; [`data/season/payout-recovery.json`](../data/season/payout-recovery.json)).
- **Readable refusals.** The contract is built with `--cfg near` (`contracts/queue-v2/.cargo/config.toml`), so every refusal carries its reason on chain. `npm run verify` fails if that file is missing.

## How the season runs

`scripts/season/season.ts`:

- **Demand is exogenous.** Each agent's owner hands it tasks on a seeded random schedule: a duration, a deadline and a **private value** for on-time delivery.
- **Strategy is the model's.** About every 20 s each agent with something at stake sees the public queue, its own jobs, a fresh contract quote and its balance, and returns one JSON action with a one-sentence reason: `submit` (choosing the ask), `set_ask`, `buy_priority` (cutoff and max spend), `cancel` or `wait`.
- **Limits in code, rules in the contract.** The runtime clamps asks, caps spend at the task's value and the balance, prices the exact jump from a fresh quote, and acts only on the agent's own jobs. It does **not** pre-check the deadline rule: a model that proposes a jump that would break someone's deadline is refused by the contract, in a failed transaction anyone can open.
- **No model holds a key.** Code signs. The process holds the eight agents' function-call keys, the operator's key and, for balance top-ups, the eight owners' full-access keys.
- **The worker** starts the head, sends the job's exact request to NEAR AI, fetches the signature and settles with `complete_job_attested`. It settles a few seconds inside the declared duration and starts the next job in the same step, so transaction latency does not push later jobs past the projections the deadline checks rely on.
- **The worker answers only this season's agents.** It reads a request body only from the run's own `requests/<sha256>.json`, after checking that the content hashes to the job's `input_hash`. Any other job is settled at once without a model call, and no job holds the worker for more than 120 s.
- **Model calls are budgeted.** A turn whose picture has not changed skips the model. Retries happen only on network errors, timeouts, 429 and 5xx. A 401, 402 or 403 stops all calls for the run. No model is called while the queue drains after arrivals close. Token usage is logged for every call.
- **Unreadable outcomes are not guessed.** A transaction whose result cannot be read is logged as `rpc`, never as a contract refusal. A submission is looked up by its request hash before it is sent again, and the worker lets go of a job only when the chain shows that it ended.
- Without `NEAR_AI_API_KEY` (or in `--sim` without `--llm`), decisions use a deterministic policy and the worker uses `complete_job`; every log line says which.

## Reproduce and verify

```bash
npm run verify:season           # re-reads every job and refusal from testnet, recomputes the comparison
npm run verify:v2-deployed      # builds contracts/queue-v2 and compares it with the code on chain
npm run test:contract-v2        # 62 contract tests, incl. random-history invariants and simulator parity
npm run test:parity             # regenerate the simulator's histories and replay them against the contract
npm run test:planted-bugs       # break eight rules one at a time; every suite must notice (about 3 minutes once the crate has been built)
npm run season:sweep            # 300 simulated seasons against FIFO and a blind fee
npm run test:season             # 15 tests: model-answer parsing, runtime limits, NEAR AI client
npm run season:sim              # the same rules in memory with a virtual clock: no keys, no model
npm run nearai:check            # one live NEAR AI call and its signature, checked as the contract will
```

`verify:season` reads each job's status, times and settlement from chain, checks that the contract's code hash, pinned signer and pinned model match the run, confirms that every logged refusal is a failed transaction, and recomputes the comparison. It exits non-zero if the result differs from the committed `comparison.json`. Private task values come from the agents' own logs, and the FIFO and blind-fee rows are local replays; both are labelled as such.

To run a season of your own: fund a testnet parent account, put the variables from `.env.example` in `.env`, then `npm run season:setup -- --pin` and `npm run season:testnet`.

## Limits

- Testnet only, not audited. The owner can pause the contract and re-pin the model key. The contract account still has its full-access key; `season:setup -- --lock` deletes it and cannot be undone.
- One worker, one queue. The agents are one runtime process with eight separate keys, not eight independently operated services, and they do not learn across runs.
- The operator is trusted for liveness and for keeping to declared durations. The contract guarantees deadlines against the queue's projection at purchase time, with the margins above.
- The model's decisions are only as good as the model; the contract guarantees the rules, not the strategy.
- The deadline rule protects the jobs a purchase passes. A job that is never moved keeps its posted schedule, but it can still be later than under FIFO: FIFO would have dropped the late buyer ahead of it and freed that worker time. In a 300-season simulation this affects 1.7% of jobs, against 9.9% under a blind fee ([`docs/RESULTS.md`](RESULTS.md) §3b).
- Pinned-key verification proves the bytes were signed by a key the owner pinned. The hardware quotes in NEAR AI's attestation report are saved with the season but not verified by this project.
- The signed text is not bound to a contract, a job or a time. The request body carries the contract id and a nonce, which is what ties an answer to one job here.
- `complete_job` (the operator's word, no signature) remains in the contract for work that is not a model call. A job settled that way is marked `attested: false` on chain, so it cannot pass for a verified answer, but the contract does not forbid it. In this season no delivered job used it; `npm run verify:season` checks that from each job's record.
- Unused storage deposit stays in the contract, and `claim_timeout` is permissionless but has no keeper bounty.
