# QUEUE — mechanism

This document states the exact rules the TypeScript scheduler and the Rust contract are required to share, proves the properties the demo relies on, and lists the places where the current build is weaker than the headline.

**Scope.** The interactive console runs a **local settlement ledger** with the same rules. The Rust contract is the on-chain settlement layer; it is testnet-only and not audited. Where the two differ, the difference is called out. The contract source is `contracts/queue/src/lib.rs`; the TypeScript reference is `packages/core/src/scheduler.ts`.

## 1. Actors and terms

| Term | Meaning |
| --- | --- |
| **Job owner** | An agent that submits work and escrows `reward + bond`. A queued owner is also a **slot holder**. |
| **Urgent requester** | A job owner buying an earlier position for its own queued job. |
| **Displaced job** | A job crossed by an accepted purchase. It moves back by exactly the urgent job's duration. |
| **Operator** | The single worker that starts the head and completes or fails the running job. |
| **Treasury** | The account that receives the protocol fee and cancellation bond penalties. |
| **Contract owner** | The account allowed to set operator, treasury, fee, and pause. |
| **Credit** | A pull-payment claim held by the contract for a displaced owner. |

All amounts are integer **yoctoNEAR** (`1 NEAR = 10^24 yocto`). No money path uses floating point. The TypeScript app stores money as decimal strings; the contract uses `U128` and `u128`. Time is Unix seconds in the contract and Unix milliseconds in the TypeScript app; the server converts at the boundary. Deadline comparisons are inclusive: `finish_at <= deadline_at` is on time.

## 2. State and projection

The queue is an ordered list of jobs with status `QUEUED`. At most one job is `RUNNING`. Every job has:

- `duration_secs` — the worker's quoted processing time.
- `deadline_at` — the owner's promised finish.
- `reward` — paid to the operator on an on-time completion.
- `bond` — returned on success; partially or fully forfeited on cancellation.
- `ask_per_sec` — the owner's published price to move this job back by one second.

The projected schedule is FIFO:

```text
cursor = now
if a job is running:
    cursor = max(now, running.started_at + running.duration_secs)

for each queued job in order:
    projected_start = cursor
    projected_finish = projected_start + duration_secs
    cursor = projected_finish
```

Equivalently, for a job at zero-based queue position `i`:

```text
projected_start(i) = max(now, running_finish) + Σ duration(j) for j < i
```

The running job is not in the queued list. It blocks the worker until its quoted duration has elapsed. A job that is already late is not silently skipped; `start_next` marks it missed and refunds it.

## 3. The quote algorithm

Inputs:

- `job_id` — the urgent job. It must be queued.
- `latest_start_at` — the latest projected start the requester will accept, inclusive.
- `max_spend` — the maximum total (compensation + fee) the requester will pay.
- `now` — the quote timestamp.
- `fee_bps` — the protocol fee in basis points (100 = 1% in the demo).

Let `pos` be the urgent job's index in the queued list. For each candidate insertion index `k` from `0` to `pos`:

```text
start(k) = max(now, running_finish) + Σ duration(j) for j < k
displaced(k) = jobs at positions k, k+1, ..., pos-1
```

Eligibility requires both:

```text
start(k) <= latest_start_at
start(k) + urgent.duration_secs <= urgent.deadline_at
```

Choose the **largest** eligible `k`. That is the latest insertion and therefore the one that displaces the fewest jobs. If no `k` is eligible, the quote is infeasible: even the front of the queue starts too late, or the urgent job cannot meet its own deadline.

For the chosen `k`, each displaced job `i` moves back by exactly `urgent.duration_secs`:

```text
new_finish(i) = old_finish(i) + urgent.duration_secs
compensation(i) = ask_per_sec(i) * urgent.duration_secs
compensation = Σ compensation(i)
fee = floor(compensation * fee_bps / 10_000)
total = compensation + fee
```

The purchase is feasible only if **every** displaced job still meets its deadline:

```text
new_finish(i) <= deadline_at(i)   for all displaced i
```

If any check fails, the quote is infeasible and the whole purchase is refused. There is no partial fill, no "move everyone except the tight one", and no retry with a different price inside the same call.

### Why the latest insertion is the right one

Two monotonicity facts make the rule deterministic:

1. **Fewer displaced jobs.** For `k' > k`, `displaced(k')` is a suffix subset of `displaced(k)`. Since asks are non-negative, the compensation of `k'` is less than or equal to the compensation of `k`. The latest eligible `k` is therefore the cheapest eligible insertion, not just the smallest move.
2. **Deadline safety is inherited by subsets.** Every displaced job is delayed by the same `urgent.duration_secs`, regardless of how many jobs are displaced. If a later insertion's displaced set is deadline-safe, every earlier insertion's set contains that safe set plus additional jobs; the additional jobs must be checked separately. If a later insertion is unsafe because some job `i` would break, an earlier insertion contains the same job `i` and is also unsafe. Therefore, once the latest cutoff-feasible insertion fails a displaced deadline, no earlier insertion can rescue it.

The contract and the TypeScript scheduler must return the same `insert_index`, displaced set, compensation, fee, and feasibility for the same inputs. This is the parity requirement in `packages/core/test/scheduler.test.ts` and the contract tests.

## 4. Settlement and refunds

### 4.1 Priority purchase

The requester calls `request_priority(job_id, latest_start_at, max_spend)` with a payable deposit.

- The contract recomputes the quote against current state. A quote is not a reservation.
- `total <= max_spend` is required. If the total exceeds the cap, the call fails and nothing moves.
- `deposit >= total` is required. Any excess `deposit - total` is **credited to the requester for withdrawal**, not transferred in the same receipt. This is a pull payment for safety; call `withdraw_credit()` to move it.
- The contract reorders the queue, marks the urgent job `expedited`, records the priority purchase, and credits each displaced owner with `ask_per_sec * urgent.duration_secs`.
- The fee is credited to the treasury as a pull payment.
- Displaced owners withdraw with `withdraw_credit()`. Credits accumulate per account; a withdrawal transfers the whole credit.

In the local console, there is no deposit and no token transfer. The engine checks `max_spend >= total` and records the total in the ledger. A local "credit" is a claim in the snapshot, not a NEAR balance. This distinction is shown in the UI.

### 4.2 Completion

`complete_job(job_id, artifact_hash)` is operator-only and only for the running job.

- **On time** (`now <= deadline_at`): reward to the operator, bond back to the owner, status `DONE`, artifact hash stored.
- **Late** (`now > deadline_at`): status `MISSED`, reward + bond refunded to the owner, artifact hash still recorded. The operator is not paid for late work.
- **Failure:** `fail_job(job_id, reason_hash)` sets `FAILED`, refunds reward + bond to the owner, and records the failure hash. The operator is not paid.
- The artifact hash is an attestation. The contract does not verify that the hash corresponds to useful work. The local worker and auditor check the hash and the deadline; on-chain this is a trusted-operator assumption.
- Pause keeps `complete_job` and `fail_job` available; see §4.5.

### 4.3 Cancellation

`cancel_job(job_id)` is owner-only and only for a queued job. Pause keeps cancellation available; see §4.5.

| Case | Reward | Bond | Status |
| --- | --- | --- | --- |
| Queued, not expedited | Fully refunded | 75% refunded, 25% to treasury | `CANCELLED` |
| Queued, expedited | Fully refunded | 100% to treasury | `CANCELLED` |
| Running | Not allowed | Not allowed | — |

A cancellation does **not** reverse compensation already credited to displaced owners, and does not refund the priority fee. The purchase settled. This is why abandoning an expedited slot costs the full bond.

For the demo's normal bond of `0.01 NEAR`: `0.0025 NEAR` to treasury, `0.0075 NEAR` refunded. For Kestrel's urgent bond of `0.015 NEAR`: `0.00375 NEAR` to treasury, `0.01125 NEAR` refunded. After an expedited purchase, the full `0.015 NEAR` goes to treasury.

### 4.4 Missed and timed out

`start_next()` starts the head. If the head is already past its deadline, it is marked `MISSED` and reward + bond are refunded. `claim_timeout(job_id)` lets anyone settle an overdue queued or running job as missed, with the same refund.

A missed job is refunded **in full**, including the bond. The bond is a cancellation penalty, not a no-show penalty. This is a real economic weakness; see §10.

### 4.5 Pause

The contract owner can pause. Pause blocks new obligations but never exit paths:

- Blocked while paused: `submit_job`, `set_move_ask`, `request_priority`, `start_next`.
- Allowed while paused: `cancel_job`, `complete_job`, `fail_job`, `claim_timeout`, `withdraw_credit`.

Consequence: a malicious owner can still freeze new work indefinitely; there is no multisig or timelock. A running job can be settled, and a queued owner can cancel and recover their funds.

## 5. Worked example (four jobs displaced)

This is the local demo scenario. The numbers match the seeded queue in `packages/ledger/src/fixtures.ts` and the scenario runner in `packages/ledger/src/engine.ts`.

**Setup.** The worker is idle at `t = 0`. Four jobs are queued in this order:

| Position | Owner | Work | Duration | Deadline | Ask/sec | Projected start | Projected finish |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Mira | Incident triage | 11s | t+150s | 0.00042 NEAR | t+0s | t+11s |
| 2 | Atlas | Settlement audit | 9s | t+120s | 0.00058 NEAR | t+11s | t+20s |
| 3 | Vale | Launch brief | 10s | t+180s | 0.00036 NEAR | t+20s | t+30s |
| 4 | Juno | Latency summary | 12s | t+160s | 0.00031 NEAR | t+30s | t+42s |

For the arithmetic, set `t = 0` at the moment the urgent job is submitted; the scenario runner does this about 1.6s after reset. Kestrel's job is 12s, deadline `t+34s`, reward `0.02 NEAR`, bond `0.015 NEAR`, ask irrelevant. Its FIFO position would be 5, starting at `t+42s` and finishing at `t+54s` — 20 seconds late.

**Cutoff.** The scenario runner uses `latest_start_at = t+5s`. It is not 18s in the shipped runner; see §9.

**Eligible positions.** Kestrel's own deadline requires `start + 12s <= t+34s`, so any start up to `t+22s` is acceptable on its own. The cutoff is the binding constraint:

| Insert at | Start | `start <= t+5s`? | Displaced count |
| ---: | ---: | :---: | ---: |
| 0 (front) | t+0s | yes | 4 |
| 1 | t+11s | no | 3 |
| 2 | t+20s | no | 2 |
| 3 | t+30s | no | 1 |
| 4 | t+42s | no | 0 |

The largest eligible index is 0. Kestrel inserts at the front and all four jobs are displaced.

**Compensation.** Each displaced job moves back by Kestrel's 12 seconds:

| Displaced | Old finish | New finish | Deadline | Slack | Ask/sec | Paid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Mira | t+11s | t+23s | t+150s | 127s | 0.00042 | 0.00504 NEAR |
| Atlas | t+20s | t+32s | t+120s | 88s | 0.00058 | 0.00696 NEAR |
| Vale | t+30s | t+42s | t+180s | 138s | 0.00036 | 0.00432 NEAR |
| Juno | t+42s | t+54s | t+160s | 106s | 0.00031 | 0.00372 NEAR |

```text
compensation = 0.00504 + 0.00696 + 0.00432 + 0.00372
             = 0.02004 NEAR
fee          = floor(0.02004 * 100 / 10_000)
             = 0.0002004 NEAR
total        = 0.0202404 NEAR
```

Exact yocto:

```text
Mira    5,040,000,000,000,000,000,000
Atlas   6,960,000,000,000,000,000,000
Vale    4,320,000,000,000,000,000,000
Juno    3,720,000,000,000,000,000,000
-----------------------------------------
comp   20,040,000,000,000,000,000,000
fee       200,400,000,000,000,000,000
total  20,240,400,000,000,000,000,000
```

**Deadline check.** Every new finish is at or before its deadline: `t+23 <= 150`, `t+32 <= 120`, `t+42 <= 180`, `t+54 <= 160`. Kestrel finishes at `t+12s <= t+34s`. Feasible.

**Payment.** The contract path requires `max_spend >= 0.0202404`. If Kestrel attaches `0.05 NEAR`, the contract credits `0.0297596 NEAR` to Kestrel for withdrawal. The on-chain proof script attaches exactly the total and sets `max_spend` to the total, so its refunded amount is zero. The local console sets `max_spend` to `0.05` in the automated scenario and records the total; no tokens move.

**After the purchase.** The queue is Kestrel, Mira, Atlas, Vale, Juno. Kestrel starts at `t+0s`, finishes at `t+12s`. The four displaced jobs start at `t+12s`, `t+23s`, `t+32s`, `t+42s` and finish at `t+23s`, `t+32s`, `t+42s`, `t+54s`. No job after Kestrel's old position is delayed, because Kestrel vacated the back position.

**Credits.** Mira, Atlas, Vale, and Juno each receive a pull-payment credit equal to their compensation. They withdraw separately. The treasury receives `0.0002004 NEAR`. On an on-time completion, the operator receives `0.02 NEAR` and Kestrel's bond `0.015 NEAR` is returned.

**Kestrel's net cost.** Priority `0.0202404` + reward `0.02` = `0.0402404 NEAR`, with the bond returned. The recipients are the four displaced owners (`0.02004`), the operator (`0.02`), and the treasury (`0.0002004`). The sums match exactly.

**On-chain proof.** The same quote was run against the live testnet contract `market.queue-demo.testnet`; `data/onchain-proof.json` records four displaced, compensation `0.02004`, fee `0.0002004`, total `0.0202404`, the urgent job `DONE` with `finished_at <= deadline_at`, four positive credits, and all four withdrawals cleared. The script requested a 5s cutoff, but time advanced between submit and quote, so the proof's quote shows a 6s effective cutoff (`latest_start_at - now = 6`); it still selects the front and displaces four. The proof's seed rewards/bonds are smaller (`0.01`/`0.005`) and the urgent job is `0.005`/`0.005`, but the displacement and compensation match the rules above. Transaction links are in the README.

## 6. Cancellation and completion examples

Using Kestrel's job:

| Action | Reward | Bond | Priority payment | Result |
| --- | --- | --- | --- | --- |
| Cancel before buying | `0.02` refunded | `0.015`: `0.01125` refunded, `0.00375` treasury | none | `CANCELLED` |
| Buy, then cancel while queued | `0.02` refunded | `0.015` all to treasury | `0.0202404` stays with displaced + treasury | `CANCELLED` |
| Start, complete on time | `0.02` to operator | `0.015` back to Kestrel | unchanged | `DONE` |
| Start, complete late | `0.02` + `0.015` refunded to Kestrel | refunded | unchanged | `MISSED`, artifact hash recorded |
| Never started, deadline passes | `0.02` + `0.015` refunded | refunded | unchanged | `MISSED` via timeout |

The "buy, then cancel" row is intentionally expensive. The purchase already paid the displaced owners; the protocol does not claw that back. The full bond is the penalty for abandoning the slot.

## 7. Invariants

These are the properties a correct implementation must preserve. The contract tests and the TypeScript tests should each cover them.

**I1 — Conservation.** Every yocto that enters the contract leaves as a refund, a credit withdrawal, an operator reward, a treasury fee, or remains as a liability. No path mints money. Local mode is not custody: it tracks claims and totals, and does not hold NEAR.

**I2 — Deadline safety at purchase.** For every accepted purchase, each displaced job's new finish is `<=` its deadline, and the urgent job's new finish is `<=` its own deadline. The protocol never accepts a trade that breaks a promise at the moment of the trade.

**I3 — FIFO otherwise.** The queue order changes only by an accepted priority purchase, a cancellation, or starting the head. The operator cannot start an arbitrary job; `start_next` starts the head.

**I4 — Exact compensation.** Each displaced job is paid exactly `ask_per_sec * urgent.duration_secs`, in integer yocto. The fee is the only rounding point: `floor(compensation * fee_bps / 10_000)`. No floating point.

**I5 — Latest feasible insertion.** Among eligible insertions, the protocol chooses the largest index. This minimizes the number of displaced jobs and, with non-negative asks, the compensation. The proof is in §3.

**I6 — Terminal states are immutable.** `DONE`, `MISSED`, `CANCELLED`, and `FAILED` cannot be settled again. A second `complete_job`, `cancel_job`, or `claim_timeout` must fail. Credits are zeroed before transfer.

**I7 — Access control.** Only the owner can cancel or change a job's ask. Only the operator can start, complete, or fail. Only the contract owner can change operator, treasury, fee, or pause. Only the credited account can withdraw its credit.

**I8 — Pause policy is explicit.** Pause blocks new obligations but preserves every exit path: cancel, complete, fail, timeout, and withdraw. A malicious owner can still freeze new work; there is no multisig or timelock.

**I9 — Time boundary.** `finish_at <= deadline_at` is on time; `start_at <= latest_start_at` is eligible. The TypeScript app converts milliseconds to seconds at the contract boundary and must not introduce an off-by-one.

**I10 — No reentrancy or double withdrawal.** `withdraw_credit` debits the credit before scheduling the transfer and does not call back into the contract. A second withdrawal sees zero.

### Proof sketch for I2 and I5

For a fixed urgent job, let `D(k)` be the displaced set for insertion `k`. For `k1 < k2`, `D(k2) ⊂ D(k1)`. Every job in `D(k)` is delayed by the same `d_u`, so for a job `i`, `new_finish(i) = old_finish(i) + d_u` independent of `k` as long as `i` is displaced. If `D(k2)` is deadline-safe, all its jobs are safe; `D(k1)` adds jobs that must be checked, so it may be unsafe. If `D(k2)` is unsafe because some `i` breaks, `i` is also in `D(k1)`, so `D(k1)` is unsafe too. Therefore the latest cutoff-feasible `k` is the best candidate, and a deadline failure there cannot be fixed by moving earlier. The algorithm's single-pass choice is correct.

## 8. Why this is not a bidding war

The closest existing category is paid priority/queue-position markets: spot/preemptible capacity, on-chain priority fees, standby upgrades, appointment rescheduling. QUEUE's narrow difference is posted asks, per-second compensation, and a deadline check on every displaced job. It is not a new chain primitive or a general marketplace.

A bidding war has repeated rounds, a common clearing price, and a winner who pays more than the previous bid. QUEUE has none of those:

1. **The price is posted by the displaced, not bid by the buyer.** Each slot holder publishes `ask_per_sec`. The buyer cannot name a per-job price.
2. **The buyer's only lever is scope.** `latest_start_at` chooses how far forward the buyer needs to be. Paying above the sum of asks does not buy a better position; excess is credited back for withdrawal.
3. **One atomic quote, no rounds.** The contract recomputes once and either accepts the whole displacement or rejects it. There is no second-price auction, no outbidding, and no time extensions.
4. **The operator does not clear a price.** The fee is a fixed `fee_bps` of compensation. The operator cannot set a reserve or favor a buyer.
5. **No continuous escalation.** There is no mempool auction for the same slot. A second buyer can change the queue, but it must run its own quote and pay its own displaced set.

It is still a market: asks can change, a front job can hold out, and the buyer can decline. "Not a bidding war" is a mechanism claim, not a fairness claim. The protocol does not guarantee that a buyer can always jump, or that an ask is reasonable.

## 9. Demo arithmetic and the 18s/5s difference

The build spec's prose example uses `latestStartInSec = 18`. With an idle worker and the shipped seed, that cutoff would select insertion index 1 and displace **three** jobs (Atlas, Vale, Juno), not four:

```text
start(0) = t+0s   <= t+18s
start(1) = t+11s  <= t+18s   ← latest eligible
start(2) = t+20s  >  t+18s
```

Compensation at 18s would be `0.00696 + 0.00432 + 0.00372 = 0.015 NEAR`; fee `0.00015`; total `0.01515 NEAR`. Mira would not move.

The shipped scenario runner uses **5 seconds**:

```text
start(0) = t+0s   <= t+5s   ← latest eligible
start(1) = t+11s  >  t+5s
```

That selects index 0 and displaces all four, which is why the demo and the quality gate say "four credits". The contract rule is identical; only the input cutoff differs.

The full step function for the shipped seed:

| `latest_start_at` | Displaced | Total |
| ---: | ---: | ---: |
| 5 s | 4 | `0.0202404` |
| 11–18 s | 3 | `0.01515` |
| 20–22 s | 2 | `0.0081204` |
| 34 s (the deadline itself) | 2 | `0.0081204` |

At 34 s the urgent job's own finish must still be `<= 34s`; inserting behind all four would start at 42s and finish at 54s, so the deadline — not the cutoff — is binding and the latest feasible insertion still displaces two. **Four is never a deadline-only result.**

The manual Priority ticket defaults to 18s. If you create a fifth urgent job behind the four queued jobs and quote it at 18s, it will show three displaced; lower the slider to 5s to get four. If you select one of the four standby jobs, there is no job ahead of it to displace, so the quote is a no-op. Use **Run the live scenario** for the four-job moment, or create a fifth job and set the slider to 5s.

Before recording or submitting, run the scenario and read the displaced count from the screen. Do not claim four if the UI shows three.

## 10. Failure modes and mitigations

| Failure mode | What can go wrong | Current control | Residual risk / mitigation |
| --- | --- | --- | --- |
| **Fake bookings / queue spam** | A job occupies a slot and never does useful work; a spammer fills the queue | Reward + bond escrowed; cancellation costs 25% (100% if expedited); queue limit 64 in local mode | **Missed jobs are refunded in full, including bond.** A no-show can recover its bond after timeout. No Sybil resistance. Production: forfeit part of the bond on timeout, charge a submission fee, cap active jobs per account, or allowlist. |
| **Deadline griefing** | A front job sets a deadline so tight that any displacement breaks it, blocking buyers; or a long job blocks the worker | Quote refuses any displacement that breaks a deadline; buyer can choose a later insertion | A job owner controls its own deadline and can create an unjumpable front slot. No forced sale, no cap on duration or deadline slack. The buyer's only recourse is a later slot or no purchase. |
| **Operator collusion / censorship** | Operator delays starts, favors a buyer, or refuses to complete; operator attests a hash for work not done | `start_next` starts the head only; on-time payment requires completion; owner can cancel while queued; anyone can `claim_timeout`; auditor checks in the demo | The operator is trusted for liveness and artifact attestation. No slashing, no multiple operators, no on-chain verification of work quality. A delayed job can miss its deadline even though the purchase was safe. Production: staking/slashing, multiple attestors, TEE or commit-reveal. |
| **Ask manipulation / holdout** | Owner raises `ask_per_sec` after the buyer quotes; front job sets an extreme ask | `max_spend` caps the total; the contract recomputes at execution; a higher ask that exceeds the cap reverts; UI re-quotes | If the cap is loose, the buyer can overpay relative to the displayed quote. No ask-change delay or commit-reveal. UI defaults `max_spend` to the quote total, which makes a last-second raise revert rather than overcharge. |
| **Front-running / stale quote** | Another purchase changes the queue before the buyer's transaction lands; the quote no longer holds | The contract recomputes; `latest_start_at` and `max_spend` reject a changed trade; the UI can re-quote | No privacy or MEV protection. A transaction may revert; the buyer must re-quote. Public testnet only. |
| **Reentrancy on withdrawal** | A recipient re-enters `withdraw_credit` and drains credits | Pull payments; debit the credit before scheduling the transfer; no callback method; no cross-contract call | Must be verified in the Rust code and tests. The local ledger is not exposed to reentrancy. |
| **Integer overflow** | `ask * duration`, compensation sums, or fee multiplication overflow `u128` | `overflow-checks = true` in the release profile; checked arithmetic required; duration bounded to 120s in local mode; contract tests for overflow | A contract path that uses unchecked arithmetic or casts would be unsafe. Verify `checked_mul`/`checked_add` and test near-max values. |
| **Pause abuse** | Owner pauses forever, freezing new work | Owner-only pause; cancel/complete/fail/timeout/withdraw remain available | A malicious owner can freeze new jobs indefinitely. No time limit, multisig, or timelock. Testnet only. |
| **Leaked operator key** | Attacker starts/completes/fails jobs, griefs owners | Operator can be rotated by the owner; pause; operator cannot withdraw user credits | Until rotation, the attacker can grief. Testnet only; do not use real value. |
| **Leaked owner/admin key** | Attacker changes operator, treasury, fee, or pauses | Testnet deployer key only; keys are git-ignored; `.env` mode 600 | A compromised owner key controls configuration. No mainnet, no real funds. Production: multisig, hardware wallet, timelock. |
| **Leaked treasury key** | Fees are diverted | Treasury is separate from user escrow; only the fee balance is at risk | Fee balance is small in the demo. Testnet only. |
| **Time boundary / rounding** | Off-by-one at the deadline; fee dust; display truncation | Integer yocto; inclusive comparisons; fee floor; parity tests | The contract uses seconds and the app uses milliseconds. Test exact `deadline` and `latest_start_at` boundaries. The UI may display four decimals; the ledger keeps exact values. |
| **Storage deposit** | Job and priority records stay on chain; if the contract paid for them, spam could drain its storage balance | Callers pay for their own records on the deployed contract: `submit_job` takes a fixed non-refundable 0.0125 NEAR storage deposit on top of `reward + bond`; `request_priority` takes `0.003 + 0.003 × displaced` NEAR. Each method measures the bytes it wrote and panics if they exceed the deposit. `total_escrow` stays exactly `reward + bond`. | **Disclosed shortfalls:** C1 — 1–3 displaced jobs with 64-byte accounts can exceed the priority deposit by a few bytes; C2 — the largest terminal job record can exceed its deposit by ~0.00014 NEAR. C3 — a failed native payout does not automatically restore the credit. The capped root-state vectors (`queue`, `activity`, 128 each) are backed by the contract balance; that cost is bounded. See `docs/SECURITY.md`. |
| **Artifact quality** | The worker's output is treated as an independent analysis | Deterministic extraction from the submitted text/CSV; structural checks; no external LLM | The output can be wrong if the input is misleading. It is a decision aid, not an audit or a diagnosis. Three task types only. |
| **No timeout incentive** | Nobody calls `claim_timeout`; a late job sits | Anyone can call; the demo operator/auditor does | No keeper bounty. A rational third party may not spend gas to settle someone else's job. Production: small timeout reward. |
| **Local API exposure** | Anyone on the network can mutate the demo, claim credits, or run the scenario | CORS allowlist; 256kb body limit; 240 mutations/min/IP; optional `x-operator-token`; read-only mode; default bind is `127.0.0.1` | Auth is off by default. Docker/compose opts in to `0.0.0.0`; set `QUEUE_OPERATOR_TOKEN` there. CORS is not authorization. Not multi-tenant. |
| **RPC / proof outage** | The testnet proof cannot be generated or refreshed; the console shows stale proof | Local mode works offline; `/api/onchain` returns `deployed: false` if no proof; proof is read-only | No on-chain demo during an RPC outage. Label it; do not fake a hash. |

## 11. Contract behaviours worth knowing

The TypeScript scheduler and local engine implement the rules above. The deployed Rust contract at `market.queue-demo.testnet` implements the on-chain side; 37 contract tests pass on the current tree. Verify these specifics before making a stronger claim:

1. **`fail_job` refund policy.** The contract sets `FAILED`, refunds reward + bond to the owner, records `failure_hash`, and increments `stats.failed`. The local engine does the same.
2. **Pause semantics.** The contract blocks `submit_job`, `set_move_ask`, `request_priority`, and `start_next` while paused, but keeps `cancel_job`, `complete_job`, `fail_job`, `claim_timeout`, and `withdraw_credit` available. The pause test covers this.
3. **Excess priority deposit is a credit.** `request_priority` adds `deposit - total` to the requester's credit; it does not transfer the excess in the same receipt. The requester calls `withdraw_credit`. The local console models the purchase but not a wallet deposit; the UI now says the excess becomes a withdrawable credit.
4. **Storage — paid by the caller.** Fixed non-refundable deposits (job 0.0125 NEAR; priority 0.003 + 0.003 × displaced NEAR), checked against measured `storage_usage`. Read them with the `get_storage_deposits` view. The local console does not model storage; it is a chain-only cost.
5. **Fee cap and rounding.** `MAX_FEE_BPS = 1_000` (10%), and `set_fee_bps` rejects above it. The demo is 100 bps (1%). Fee is `compensation * fee_bps / 10_000`, integer floor. Do not describe the fee cap as 100%.
6. **Ask snapshot.** `request_priority` recomputes the quote at execution time; it does not honor a stored quote. `max_spend` is the protection against a last-second ask raise. A raise above the cap reverts; a raise below a loose cap can overpay relative to the displayed quote.
7. **Time boundary.** The contract uses `start <= latest_start_at`, `finish <= deadline_at`, and displaced `new_finish <= deadline_at`. The TypeScript app uses milliseconds and converts; test exact boundaries.
8. **Withdrawal order.** `withdraw_credit` removes the credit before scheduling the transfer; a second withdrawal returns zero. The test `test_withdraw_credit_zeroes_first_and_prevents_double_spend` passes.
9. **Overflow.** The contract uses checked add/sub/mul helpers and `overflow-checks = true`; tests cover compensation overflow. Do not replace them with raw arithmetic.
10. **Testnet proof.** `data/onchain-proof.json` has `ok: true`, contract ID, deploy/priority/start/complete/withdraw hashes, four displaced, four credits, `DONE`, and `finished_at <= deadline_at`. Verify the hashes on `testnet.nearblocks.io`; the proof is only as good as the RPC that produced it.
11. **Deployment metadata.** `data/deploy.json` contains only public fields and `/api/onchain` projects an allowlist. `npm run verify:secrets` scans the public tree, and `scripts/package.sh` scans the release archive before writing it.
12. **Verification fixture.** The API test accepts either a real deployment record or an honest pending state, so it stays valid with and without `data/onchain-proof.json`.

Treat the contract as **experimental, testnet-only, and not audited**. The local demo is a faithful rehearsal of the specified rules, not a substitute for contract verification.
