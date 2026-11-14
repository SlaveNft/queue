# QUEUE — product specification

Status: implementation specification for the hackathon build. This document describes the product as built in this repository. It is not a claim that every item is production-ready.

- **Product:** QUEUE — a paid slot market for a single FIFO agent-work queue.
- **Tracks:** `swarms` (primary), `agents`.
- **Network:** NEAR testnet only. No mainnet, no NEAR Intents, no cross-chain settlement.
- **Settlement:** native NEAR escrow in the Rust contract; a local settlement ledger in the console.
- **Audit status:** not audited.

## 1. Problem and product

A single owned worker processes agent jobs in FIFO order. FIFO is simple, but it cannot express urgency: one long job makes every later job late, even when the queue has enough total slack to absorb a jump.

QUEUE lets a queued job buy an earlier position from the jobs ahead of it. The jobs that move are not collateral damage:

- Each displaced job moves back by exactly the urgent job's duration.
- Each is paid its published per-second ask for that delay.
- Each must still meet its own **stated** deadline; otherwise the whole purchase is refused.
- The requester pays a fixed protocol fee on compensation and can cap the total with `max_spend`.
- Displaced owners receive pull-payment credits.

The product is a **posted-price market**, not an auction. Slot holders publish asks; buyers choose a latest-start cutoff and a budget. They do not bid against each other in rounds.

## 2. Goals and success criteria

| Goal | Success criterion |
| --- | --- |
| One complete, reproducible demo | A judge can run a 17-second scenario and see four paid displacements, one on-time artifact, four claimable credits, and zero displaced-deadline breaks. |
| Exact economics | Every amount is integer yoctoNEAR; the TypeScript scheduler and Rust contract agree on displacement, compensation, fee, and feasibility. |
| Deadline safety | No accepted purchase moves a displaced job past its **stated** deadline. Infeasible quotes do not change state. |
| Real work | The worker computes a Markdown artifact from the submitted input and records its SHA-256. No lorem ipsum, no hard-coded success. |
| Honest settlement | The console labels local ledger rows as local; testnet proof is read from a real proof file and never invented. |
| Reproducibility | `npm install && npm run dev` works; `npm run verify` is the single verification command. |

## 3. Roles

| Role | Who | Capabilities |
| --- | --- | --- |
| **Job owner / slot holder** | An agent with a queued job | Submit a job; set its ask while queued; cancel while queued; withdraw credits |
| **Urgent requester** | A job owner buying priority | Quote a jump; buy it with a latest-start cutoff and max spend |
| **Operator** | The single worker account | `start_next`; `complete_job`; `fail_job`; run the deterministic worker |
| **Auditor** | A read-only verifier in the demo | Check artifact SHA-256, delivery time, and payment events; no write authority |
| **Treasury** | Fee recipient | Receives the protocol fee and cancellation bond penalties; no job authority |
| **Contract owner** | Deployer/admin | Set operator, treasury, fee; pause; no user-credit withdrawal |
| **Observer / judge** | Anyone with the repo | Run the demo, read state, inspect the ledger, run verification |

The local API has no user authentication. These roles are **demo roles**, not enforced multi-tenant identities. The contract enforces its own access control with NEAR account IDs.

## 4. Functional requirements

### 4.1 Jobs and queue

- **FR-01 Submit.** A job owner submits `title`, `task`, `brief`, `input`, `durationSec`, `deadlineInSec`, `rewardNear`, `bondNear`, and `askPerSecNear`. The server validates limits and stores exact yocto.
- **FR-02 Escrow.** A job's `reward + bond` is escrowed. In the local ledger this is an accounting entry; in the contract the caller attaches `storage deposit + reward + bond`. The contract stores `bond = attached - storage - reward`, which must be positive. `reward + bond` is tracked separately from storage.
- **FR-03 FIFO.** Queued jobs run in submission order unless a priority purchase reorders them. One job runs at a time.
- **FR-04 Projection.** The UI shows `projectedStartAt`, `projectedFinishAt`, position, deadline, ask/sec, and status for every queued job.
- **FR-05 Ask.** A queued owner can change `askPerSec`. The ask is the price to move that job back by one second.
- **FR-06 Cancel.** A queued owner can cancel. Reward is refunded; 25% of the bond goes to treasury and 75% is refunded. If the job was expedited, 100% of the bond goes to treasury. A running job cannot be cancelled.
- **FR-07 Limits.** Local mode enforces: title 3–90 chars, brief 3–600 chars, input ≤20,000 chars, duration 1–120s, deadline 5–3,600s, reward 0.001–1 NEAR, bond 0.001–1 NEAR, ask ≤0.01 NEAR/s, queue ≤64.

### 4.2 Priority purchase

- **FR-08 Quote.** `GET /api/quote?jobId=…&latestStartInSec=…` returns `QuoteView`: `jobId`, `now`, `latestStartAt`, `insertIndex`, projected start/finish, compensation, fee, total, displaced list, `feasible`, `reason`, and `checks`.
- **FR-09 Latest feasible insertion.** The quote chooses the largest insertion index whose projected start is `<= latestStartAt` and whose own finish is `<=` the urgent deadline. This minimizes displaced jobs and compensation (P2 in `docs/RESEARCH.md`).
- **FR-10 Deadline protection.** Every displaced job's `newFinishAt` must be `<=` its **stated** deadline. If any would break, `feasible: false` and no state change.
- **FR-11 Compensation.** Each displaced job is paid `askPerSec * urgent.durationSec`, exactly, in yocto. `compensation = Σ`; `fee = floor(compensation * feeBps / 10_000)`; `total = compensation + fee`. The contract-side attached amount is **storage-inclusive**: `submit_job` requires `attached = JOB_STORAGE_DEPOSIT + reward + bond`; `request_priority` requires `attached >= PRIORITY_STORAGE_BASE + PRIORITY_STORAGE_PER_DISPLACED * displaced + total`. Local mode has no deposit.
- **FR-12 Budget and owner.** The requester supplies `maxSpendNear`. If `total > maxSpend`, the purchase is rejected and nothing moves. Only the job's owner may call `request_priority`; a third-party purchase is rejected. In the contract, the attached deposit must cover storage + `total`; excess is credited to the requester for withdrawal, not transferred in the same receipt.
- **FR-13 Atomicity.** A purchase either reorders the queue, credits every displaced owner, charges the fee, and marks the urgent job expedited, or it changes nothing.
- **FR-14 No-op.** A job that already meets its cutoff with zero displaced jobs needs no purchase; the quote marks it infeasible/no-op and the contract **refuses** a zero-displacement `request_priority` rather than marking the job expedited for free.

### 4.3 Work and settlement

- **FR-15 Start.** `start_next` starts the head. If the head is past its deadline, mark it missed and refund reward + bond.
- **FR-16 Complete on time.** `complete_job(jobId, artifactHash)` pays the reward to the operator, returns the bond to the owner, records the hash, and sets `DONE`.
- **FR-17 Complete late.** A late completion sets `MISSED`, refunds reward + bond to the owner, and still records the artifact hash. The operator is not paid.
- **FR-18 Failure.** `fail_job(jobId, reasonHash)` is operator-only. The contract sets `FAILED`, records the failure hash, refunds reward + bond to the owner, and increments `stats.failed`. The local engine does the same on an execution error and counts the job in `stats.failed`.
- **FR-19 Timeout.** Anyone can `claim_timeout` an overdue queued or running job; it becomes `MISSED` with reward + bond refunded. There is no keeper bounty.
- **FR-20 Credits.** Displaced owners have pull-payment credits. The local UI shows `Credits owed`; `Withdraw` zeroes the local credit. The contract transfers the credit and clears it.
- **FR-21 Pause.** The contract owner can pause new work. Pause blocks `submit_job`, `request_priority`, `set_move_ask`, and `start_next`; it never blocks exit paths (`cancel_job`, `complete_job`, `fail_job`, `claim_timeout`, `withdraw_credit`).

### 4.4 Console and proof

- **FR-22 Live state.** The console reads one server snapshot over SSE (`GET /api/events`), with polling fallback. It never mutates the queue locally after an action except for a pending button state.
- **FR-23 Local labeling.** Local mode is labelled **Local ledger** / **Local settlement ledger** in the nav, hero, credits, and ledger. Local rows are never presented as blockchain transactions.
- **FR-24 Real worker.** The worker computes an artifact from `job.input` for one of three tasks: `incident-triage`, `csv-audit`, `launch-brief`. It records a SHA-256 and structural checks.
- **FR-25 Artifact view.** The UI shows the artifact Markdown, hash, duration, and checks; the API serves it at `GET /api/artifacts/:id` and `GET /api/jobs/:id/artifact`.
- **FR-26 Demo scenario.** `POST /api/demo/run` resets and runs the board-call scenario. `POST /api/demo/reset` returns to standby. The scenario runs on real wall-clock.
- **FR-27 Proof.** `GET /api/onchain` reads `data/onchain-proof.json` / `data/deploy.json` if present. If absent, it returns `deployed: false` with a note. The UI never invents a contract ID or hash.
- **FR-28 Testnet proof path.** `npm run deploy:testnet` deploys the contract; `npm run demo:onchain` submits **five jobs** (four seed + urgent), buys priority, starts, completes with a real artifact hash, runs the four displaced jobs, and **withdraws all four credits**; it then runs the refusal episode (two more jobs, one failed purchase) and writes the proof only if every check passes. The current proof is real: `market.queue-demo.testnet`, 27 proof txs, four displaced and paid, 7/7 on time, four withdrawals, one refusal.
- **FR-29 Errors.** API errors are `{ ok: false, error: string, code?: string }` with 4xx/5xx. The UI displays the server error; it does not hide it behind a generic success.
- **FR-30 Accessibility.** Keyboard focus visible; buttons have accessible names; form errors announced; reduced motion respected; usable at 390px and 1440px.

## 5. State machine

```text
                    priority purchase (stays QUEUED, expedited=true)
                                   │
                                   ▼
  submit ──► QUEUED ──start_next──► RUNNING ──complete_job(on time)──► DONE
               │                      │
               │                      ├──complete_job(late)──────────► MISSED
               │                      ├──claim_timeout(overdue)──────► MISSED
               │                      └──fail_job────────────────────► FAILED
               │
               ├──cancel_job──────────► CANCELLED
               └──claim_timeout(overdue)──► MISSED
```

| From | Event | To | Notes |
| --- | --- | --- | --- |
| — | `submit_job` | `QUEUED` | Escrows reward + bond; appends to queue |
| `QUEUED` | `request_priority` | `QUEUED` | Reorders; `expedited=true`; credits displaced owners; no status change |
| `QUEUED` | `set_move_ask` | `QUEUED` | Owner-only; no status change |
| `QUEUED` | `cancel_job` | `CANCELLED` | Reward refunded; 25%/100% bond penalty |
| `QUEUED` | `start_next` | `RUNNING` | Head only; operator-only |
| `QUEUED` | `start_next` after deadline | `MISSED` | Reward + bond refunded |
| `QUEUED` | `claim_timeout` after deadline | `MISSED` | Anyone; reward + bond refunded |
| `RUNNING` | `complete_job` on time | `DONE` | Reward to operator; bond to owner; hash stored |
| `RUNNING` | `complete_job` late | `MISSED` | Reward + bond refunded; hash stored |
| `RUNNING` | `claim_timeout` after deadline | `MISSED` | Anyone; reward + bond refunded |
| `RUNNING` | `fail_job` | `FAILED` | Operator-only; full reward + bond refund; failure hash recorded |
| Terminal | any mutation | — | Must fail |

`DONE`, `MISSED`, `CANCELLED`, and `FAILED` are terminal. A job cannot be started twice, completed before it starts, cancelled while running, or settled twice.

Pause is global, not a job status. It blocks new obligations but leaves all exit paths available: cancel, complete, fail, timeout, and withdrawal. A malicious owner can still freeze new work; there is no multisig or timelock.

## 6. Contract interface

Amounts are yoctoNEAR (`U128` in JSON). Contract times are Unix seconds; the app uses milliseconds and converts at the boundary.

### 6.1 Methods

| Method | Caller | Payable | Auth | Effect | Rejects when |
| --- | --- | --- | --- | --- | --- |
| `new(owner_id, operator_id, treasury_id, fee_bps)` | Deployer | no | once | Initializes config | Already initialized; `fee_bps > 1_000` (10%) |
| `submit_job(title, input_hash, input_uri, duration_secs, deadline_secs, reward, ask_per_sec)` | Any account | yes | owner = predecessor | Creates a job; escrows reward + bond; returns `u64` ID. Attached must be `JOB_STORAGE_DEPOSIT + reward + bond` (deployed contract: 0.0125 NEAR storage) | Invalid duration/deadline/amounts; attached too low; queue full; paused |
| `set_move_ask(job_id, ask_per_sec)` | Job owner | no | owner | Updates the published ask | Not owner; not queued; paused |
| `cancel_job(job_id)` | Job owner | no | owner | Cancels a queued job; refunds reward; 25% or 100% bond penalty | Not owner; not queued; paused |
| `quote_priority(job_id, latest_start_at)` | Anyone | no | view | Returns `QuoteView`; no state change; same rule as `get_quote` | Job not queued |
| `request_priority(job_id, latest_start_at, max_spend)` | **Job owner only** | yes | owner | Recomputes quote; reorders; credits displaced owners; fee to treasury; credits excess deposit to requester. A zero-displacement purchase is refused | Infeasible; zero displaced; `total > max_spend`; deposit < storage + total; not owner; not queued; paused |
| `get_storage_deposits()` | Anyone | no | view | Returns the non-refundable job/priority storage deposits as yocto strings | — |
| `start_next()` | Operator | no | operator | Starts the head; returns job ID | Worker busy; queue empty; paused |
| `complete_job(job_id, artifact_hash)` | Operator | no | operator | Settles the running job on time or late | Not operator; not running; wrong job; paused |
| `fail_job(job_id, reason_hash)` | Operator | no | operator | Marks the running job `FAILED`; refunds reward + bond; records failure hash | Not operator; not running; wrong job; paused |
| `claim_timeout(job_id)` | Anyone | no | anyone | Marks an overdue queued/running job missed; refunds | Not overdue; already terminal |
| `withdraw_credit()` | Credited account | no | self | Transfers the caller's credit; clears it | No credit; allowed while paused |
| `set_operator(account_id)` | Contract owner | no | owner | Updates operator | Not owner |
| `set_treasury(account_id)` | Contract owner | no | owner | Updates treasury | Not owner |
| `set_fee_bps(fee_bps)` | Contract owner | no | owner | Updates fee | Not owner; `> 1_000` (10%) |
| `set_paused(paused)` | Contract owner | no | owner | Pauses/unpauses | Not owner |

**Bond derivation.** The `submit_job` signature exposes `reward` but not `bond`; the caller attaches `JOB_STORAGE_DEPOSIT + reward + bond`. The contract requires `attached > storage + reward` (a positive bond) and stores `bond = attached - storage - reward`. The test `test_submit_escrows_fifo_and_positions` asserts this.

**Contract limits.** `MAX_QUEUE = 128`, `MAX_ACTIVITY = 128`, title 1–120 chars, `input_hash` 1–128 bytes, `input_uri` 0–256 bytes, duration 1–86,400s, deadline 1–604,800s, reward > 0, bond > 0, `MAX_MOVE_RECORDS = 32`, and `fee_bps <= 1_000` (10%). The local server has tighter demo limits (§4.1).

**Admin authority is broader than the methods suggest.** There is no built-in upgrade or migrate API, but the deployed contract account retains a **FullAccess** key. That key can redeploy a new wasm (state is preserved; a changed layout needs a migration) and can move the account balance independently of the contract's Rust access control. There is no multisig or timelock. Testnet only; see [`docs/SECURITY.md`](SECURITY.md).

**Deployed build.** The live proof belongs to the wasm `26kAJ…`, and `npm run build:contract` on this tree reproduces that hash. Read `get_storage_deposits` from the live contract before quoting deposit values.

### 6.2 Views

| View | Returns |
| --- | --- |
| `get_config()` | `ConfigView`: owner, operator, treasury, fee_bps, paused |
| `get_job(job_id)` | `JobView`: all job fields, status, expedited, priority, moves, artifact hash, projected start/finish, position |
| `get_queue()` | `Vec<JobView>` in queue order |
| `get_quote(job_id, latest_start_at)` | Alias of `quote_priority` |
| `get_priority(priority_id)` | `PriorityView`: id, job, time, insert index, compensation, fee, total, cutoff, displaced |
| `get_credit(account_id)` | `U128` credit |
| `get_stats()` | `StatsView`: submitted, completed, missed, cancelled, running, queued, moves, total priority, compensation, fees, on-time bps |
| `get_activity(limit)` | `Vec<ActivityView>` |
| `get_storage_deposits()` | `{ job, priority_base, priority_per_displaced }` in yocto strings; on the deployed contract `0.0125 / 0.003 / 0.003 NEAR` |

`JobView` must expose enough for the UI: `id`, `owner`, `title`, `input_hash`, `input_uri`, `duration_secs`, `deadline_at`, `submitted_at`, `reward`, `bond`, `ask_per_sec`, `status` (`QUEUED|RUNNING|DONE|MISSED|CANCELLED|FAILED`), `expedited`, `priority_id`, `priority_spend`, `moved_compensation`, `started_at`, `finished_at`, `artifact_hash`, `moves`, `projected_start_at`, `projected_finish_at`, `position`.

`QuoteView`: `job_id`, `now`, `latest_start_at`, `insert_index`, `projected_start_at`, `projected_finish_at`, `compensation`, `fee`, `total`, `displaced[]`, `feasible`, `reason`, `checks[]`. `DisplacedView`: `job_id`, `owner`, `amount`, `delay_secs`, `new_finish_at`, `deadline_at`, `slack_secs`. `checks`: `key`, `label`, `ok`, `detail`.

## 7. HTTP API

Default base: `http://localhost:8789`. The web dev server proxies `/api` from `http://localhost:4178`. All responses are JSON except SSE and Prometheus text.

| Method | Path | Request | Response | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/api/health` | — | `{ ok, version, build, mode, uptimeSec, db }` | Liveness |
| `GET` | `/api/version` | — | `{ ok, version, build, node, mode, schemaVersion }` | Build metadata |
| `GET` | `/api/state` | — | `{ ok, state: QueueState }` | Full snapshot |
| `GET` | `/api/quote` | `jobId`, `latestStartInSec` | `{ ok, quote }` | Clamps `latestStartAt` to `deadline - duration` |
| `POST` | `/api/jobs` | Job body (below) | `201 { ok, job }` | Validates limits |
| `POST` | `/api/jobs/:id/priority` | `{ latestStartInSec, maxSpendNear }` | `{ ok, quote, priority, job, state }` | Atomic; `402` if budget low, `409` if infeasible |
| `POST` | `/api/jobs/:id/move-ask` | `{ askPerSecNear }` | `{ ok, job }` | Owner in the UI; local API has no auth |
| `POST` | `/api/jobs/:id/cancel` | — | `{ ok, job }` | 25%/100% bond rules |
| `POST` | `/api/operator/start` | — | `{ ok, job, missed, state }` | Starts head; worker auto-completes |
| `POST` | `/api/credits/:agentId/withdraw` | — | `{ ok, amountYocto, credits, state }` | Local ledger only |
| `POST` | `/api/demo/run` | — | `202 { ok, scenario, state }` | Resets and runs |
| `POST` | `/api/demo/reset` | — | `{ ok, state }` | Returns to standby |
| `GET` | `/api/artifacts/:id` | — | `{ ok, artifact }` | Artifact by ID |
| `GET` | `/api/jobs/:id/artifact` | — | `{ ok, artifact }` | Artifact by job |
| `GET` | `/api/onchain` | — | `{ ok, deployed, deploy?, proof? }` or `{ ok, deployed: false, note }` | Reads proof files; returns a public allowlist only (no secret keys) |
| `GET` | `/api/events` | — | SSE `event: snapshot` | Snapshot on connect, on every mutation, heartbeat every 15s |
| `GET` | `/api/metrics` | — | Prometheus text | Counters and gauges |

Job body:

```json
{
  "ownerId": "kestrel",
  "task": "incident-triage",
  "title": "Board brief now",
  "brief": "Deliver the incident brief before the board call.",
  "input": "…",
  "durationSec": 12,
  "deadlineInSec": 35,
  "rewardNear": "0.02",
  "bondNear": "0.015",
  "askPerSecNear": "0.0006"
}
```

`ownerId` is one of `kestrel`, `mira`, `atlas`, `vale`, `juno`; `task` is one of `incident-triage`, `csv-audit`, `launch-brief`.

Errors:

```json
{ "ok": false, "error": "Budget 0.001 NEAR is below the quote 0.0202 NEAR.", "code": "BUDGET_TOO_LOW" }
```

Observed codes: `VALIDATION`, `BAD_AMOUNT`, `JOB_NOT_FOUND`, `NOT_QUEUED`, `INFEASIBLE`, `NO_PURCHASE_NEEDED`, `BUDGET_TOO_LOW`, `BAD_BUDGET`, `WORKER_BUSY`, `QUEUE_EMPTY`, `AGENT_NOT_FOUND`, `NO_CREDIT`, `RATE_LIMIT`, `READ_ONLY`, `UNAUTHORIZED`, `NOT_FOUND`, `INTERNAL`. The UI displays `error`; codes are for clients and tests.

Security/limits: CORS allowlist for localhost:4178/5173 plus `QUEUE_WEB_ORIGIN`; 256kb JSON body; `x-content-type-options`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `permissions-policy`; 240 mutations/min/IP; optional `x-operator-token`; optional read-only mode. The API has no user auth by default and binds `127.0.0.1`; Docker/compose opts in to `0.0.0.0`. Do not expose it without a proxy and auth.

## 8. Data model

### 8.1 Job

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | `J-1001` style |
| `seq` | number | Monotonic |
| `title`, `brief`, `input` | string | Validated lengths |
| `task` | enum | `incident-triage`, `csv-audit`, `launch-brief` |
| `ownerId`, `ownerAccount` | string | Demo agent ID; testnet account label |
| `durationSec` | number | 1–120 local |
| `submittedAt`, `deadlineAt` | number | Unix ms in TS; seconds in contract |
| `rewardYocto`, `bondYocto`, `askPerSecYocto` | string | Exact integer strings |
| `status` | enum | `queued`, `running`, `done`, `missed`, `cancelled`, `failed` |
| `expedited` | boolean | Bought priority |
| `priorityId`, `prioritySpendYocto` | string? | Purchase record |
| `movedCompensationYocto` | string | Sum received for being displaced |
| `startedAt`, `finishedAt` | number? | Unix ms |
| `artifactId`, `artifactHash` | string? | SHA-256 |
| `moves` | `MoveRecord[]` | `byJobId`, `amountYocto`, `delaySec`, `at` |
| `projectedStartAt`, `projectedFinishAt` | number? | Derived in `QueueState` |
| `position` | number? | Derived queue position |

### 8.2 Quote, priority, credit, artifact

- **Quote:** `jobId`, `now`, `latestStartAt`, `insertIndex`, `projectedStartAt`, `projectedFinishAt`, `compensationYocto`, `feeYocto`, `totalYocto`, `displaced[]`, `feasible`, `reason`, `checks[]`.
- **PriorityRecord:** `id`, `jobId`, `at`, `insertIndex`, `compensationYocto`, `feeYocto`, `totalYocto`, `latestStartAt`, `displaced[]`.
- **Credit:** `Record<agentId, yoctoString>` in the local state; contract `get_credit(account_id)`.
- **Artifact:** `id`, `jobId`, `title`, `markdown`, `sha256`, `createdAt`, `durationMs`, `checks[]` (`key`, `label`, `ok`, `detail`).
- **LedgerEvent:** `id`, `at`, `type`, `actor`, `summary`, `jobId?`, `amountYocto?`, `meta?`.
- **Scenario:** `id`, `name`, `status`, `phase`, `startedAt?`, `finishedAt?`, `steps[]`.
- **Network:** `mode` (`local`/`testnet`), `label`, `contractId?`, `explorer?`, `blockHeight?`, `note`.
- **QueueState:** `schemaVersion: 1`, `sessionId`, `mode`, `now`, `service`, `agents`, `running`, `queue`, `recent`, `credits`, `stats`, `activity`, `scenario`, `network`.

### 8.3 Persistence

- Local server: SQLite `snapshot` table with a single row (`id = 1`, `json`, `updated_at`) plus WAL. Runtime DB: `data/queue.db` (git-ignored).
- Testnet proof: `data/deploy.json` (deployment metadata), `data/onchain-proof.json` (public scenario proof), `data/onchain-artifact.md` (artifact). `data/deploy.json` is public metadata only; signing keys live in `.env`/`.testnet`. `GET /api/onchain` projects an allowlist. The proof file contains no keys.
- Keys: `.env` (mode 600) and `.testnet/` (mode 700), both git-ignored. Never commit.

## 9. Local and testnet modes

| | Local console | Testnet proof path |
| --- | --- | --- |
| Trigger | `npm run dev` | `npm run deploy:testnet`, `npm run demo:onchain` |
| Settlement | Local settlement ledger; no tokens move | Native NEAR escrow; real transactions |
| State source | SQLite + SSE | Contract views + `data/onchain-proof.json` |
| Label | "Local ledger" / "Local settlement ledger" | "NEAR testnet" only when proof exists |
| Auth | None by default; optional operator token | Testnet keys in `.env` / `.testnet/` |
| Risk | Demo only; do not expose | Testnet only; not audited |
| Current state | Local rehearsal | Live at `market.queue-demo.testnet`; proof `ok: true` |

The console does **not** sign testnet transactions from the browser. The on-chain proof is produced by the CLI and displayed read-only. The contract is live; if the proof file is missing or stale, say the proof is unavailable and do not substitute a local row for a transaction.

## 10. Non-functional requirements

- **Exact money.** No floats in money paths. `formatNear`/`parseNear` use integer yocto; the contract uses `u128`.
- **Parity.** The scheduler and contract return the same displacement set, compensation, fee, and feasibility. Equivalent unit tests exist on both sides; there is no single cross-language property test yet. Do not overclaim formal parity.
- **Determinism.** The worker is deterministic for a given input; no external LLM or API key is required. If an LLM is added later, it must be disclosed and must not be required for the demo.
- **Reproducibility.** `npm install`, `npm run dev`, `npm run verify` work from a clean checkout.
- **Observability.** SSE snapshots, an append-only ledger, `/api/metrics`, and request IDs.
- **Security.** Security headers, body limit, CORS allowlist, rate limit, optional token, read-only mode, no secrets in the repo.
- **Accessibility.** Keyboard, focus, labels, errors, reduced motion, 390px mobile.
- **Testnet only.** No mainnet deployment. No NEAR Intents. No production custody.

## 11. Non-goals

QUEUE is **not**:

- A multi-worker or distributed scheduler.
- A general-purpose job marketplace or freelance platform.
- An auction, bidding war, or continuous priority-fee market.
- A reputation, Sybil-resistance, identity, or dispute-resolution system.
- A privacy system, TEE, or confidential-compute product.
- An LLM agent framework; the demo worker is deterministic.
- A token, stablecoin, or cross-chain product.
- A mainnet deployment or a production custody service.
- A multi-tenant SaaS with user accounts, billing, or an SLA.
- An insurance product for missed deadlines.

## 12. Decisions and disclosed limits

1. **Bond derivation.** `submit_job` requires `attached > reward` and stores `bond = attached - reward`. The contract test asserts it.
2. **`fail_job` refund policy.** The contract refunds reward + bond, sets `FAILED`, and records the failure hash. The local engine does the same and counts the job in `stats.failed`.
3. **Pause semantics.** Pause blocks new obligations (`submit_job`, `set_move_ask`, `request_priority`, `start_next`) but keeps `cancel_job`, `complete_job`, `fail_job`, `claim_timeout`, and `withdraw_credit` available. There is no multisig/timelock against a malicious owner freezing new work.
4. **Storage is caller-paid.** Callers pay a non-refundable storage deposit on top of escrow: job 0.0125 NEAR; priority 0.003 + 0.003 × displaced NEAR. `reward + bond` stays separate. The disclosed edge cases (C1, C2, C3) are in [`SECURITY.md`](SECURITY.md).
5. **Ask snapshot.** `request_priority` recomputes the quote at execution time. `max_spend` is the only protection against a last-second raise. Excess deposit is credited for withdrawal, not refunded in the same receipt.
6. **Testnet deployment.** `market.queue-demo.testnet` is live; `data/onchain-proof.json` has `ok: true`, 27 proof txs, four displaced and paid, 7/7 on time, four withdrawals, and one real refused jump. `npm run verify:onchain` re-checks it.
7. **The console is local by design.** The ledger reports `mode: "local"` and the console does not sign testnet transactions. The testnet proof is a CLI path. The console is not an on-chain client.
8. **No timeout incentive.** `claim_timeout` is permissionless but has no keeper bounty.
9. **Scenario cutoff.** The scripted scenario uses a 5 s latest-start cutoff, so all four jobs are displaced. The manual ticket defaults to 18 s (three displaced); a deadline-only cutoff (20–34 s) displaces two. See [`RESULTS.md`](RESULTS.md).
10. **Test counts.** `cargo test` passes **37 v1, 62 v2 and 95 v3 contract tests** on this tree; the TypeScript suites pass **13 core + 8 ledger + 34 server + 9 web + 8 client + 17 season** tests and the production build passes.
11. **Deployment metadata.** `data/deploy.json` contains only public fields; `/api/onchain` projects an allowlist; `npm run verify:secrets` scans the public tree and `scripts/package.sh` scans the release archive before writing it.

## 13. Acceptance criteria

- [ ] `npm install && npm run dev` starts the API on 8789 and the console on 4178.
- [ ] `npm run verify` exits 0, including the 17-second scenario and `audit.passed`.
- [ ] The scenario produces four credits, one `DONE` job, a 64-character artifact SHA-256, zero displaced-deadline violations, and a coherent ledger.
- [ ] The live testnet proof has `ok: true`, 27 proof txs, four displaced and paid, 7/7 on time, four cleared withdrawals, and one real refused jump (Episode A 5/5, Episode B 2/2).
- [ ] A quote with a deadline-breaking displacement is infeasible and changes no state.
- [ ] A purchase with `maxSpend < total` is rejected and changes no state.
- [ ] Normal cancellation refunds reward + 75% bond and sends 25% to treasury.
- [ ] Expedited cancellation refunds reward and sends 100% bond to treasury.
- [ ] A late completion is `MISSED` with reward + bond refunded and the artifact hash recorded.
- [ ] `claim_timeout` settles an overdue job; a second settlement fails.
- [ ] Pause blocks new work but keeps cancel/complete/fail/timeout/withdraw available.
- [ ] The UI has no console errors at 1440×900 and 390×844.
- [ ] Contract IDs and tx hashes come from `data/onchain-proof.json` / `data/deploy.json`; no hand-typed or invented values.
- [ ] README, LICENSE, Q-015 disclosure, and docs are present; no secrets are committed; `data/deploy.json` and `/api/onchain` contain only public fields.
