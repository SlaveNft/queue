# QUEUE — security

**Status: not audited. Testnet only. Do not use with real funds.**

> **Key handling.** Public metadata contains only account IDs and public keys. Signing keys live exclusively in `.env` and `.testnet/` (git-ignored, mode 600/700). `GET /api/onchain` projects only public fields, and `data/onchain-proof.json` contains no keys. The release scan (`npm run verify:secrets`, `scripts/package.sh`) checks this on every build.

This document is a threat model and a candid review of the current build, not a security guarantee. It separates controls that are implemented and inspectable in this repository from controls that are specified for the Rust contract and must be verified against the contract source and tests.

## 1. Scope and assets

In scope:

- The local ledger engine and worker (`packages/ledger`) and the API in front of it (`apps/server`). The hosted console runs the same engine inside the visitor's browser tab: it has no backend, stores nothing and holds no keys, so its only inputs are the visitor's own.
- The shared scheduler and money code (`packages/core`).
- The web console (`apps/web`).
- The Rust contract (`contracts/queue`), testnet only.
- The deploy and on-chain proof scripts (`scripts/`).

Assets:

1. Escrowed `reward + bond` for each job.
2. Displaced-owner compensation credits.
3. Treasury fees and cancellation penalties.
4. Queue order and deadline guarantees (service integrity).
5. Operator and admin authority.
6. Testnet keys and deployment metadata.
7. Local demo state and generated artifacts.

Non-assets: there is no mainnet deployment, no stablecoin balance, no NEAR Intents integration, no production custody, and no user PII beyond demo handles.

## 2. Trust boundaries

| Boundary | Trusted | Not trusted |
| --- | --- | --- |
| Browser ↔ local API | Same-origin console; optional operator token | Any other origin; the API has no user auth by default |
| Local API ↔ engine | In-process calls; validated JSON | Client-supplied `ownerId`/`agentId` can act as any demo role |
| Engine ↔ SQLite | Local file; single writer | Filesystem access; no encryption at rest |
| CLI ↔ NEAR testnet | RPC responses and the signer keys in `.env`/`.testnet` | Public RPC availability; testnet finality assumptions |
| Contract ↔ users | NEAR account signatures; contract access control | Malicious owners, buyers, operators, and spam |
| Operator ↔ work quality | The operator's attestation of the artifact hash | The contract does not verify useful work |
| Admin ↔ config | The contract owner key | A leaked or malicious owner key |

The local console is a **demo control plane**. The operator and owner checks in the UI are not security boundaries; the API accepts any of the five demo `ownerId` values and any `agentId` for withdrawal. The contract is the only place where account-based authorization is enforced.

## 3. Threat model

| ID | Threat | Impact | Control | Residual risk | Status |
| --- | --- | --- | --- | --- | --- |
| S1 | **Fake bookings / queue spam.** A job occupies a slot, never does useful work, and is timed out. | Queue time consumed; honest jobs delayed; buyer cannot jump cheaply. | Reward + bond escrow; cancellation costs 25% (100% if expedited); queue limit 64 local / 128 contract; validation. | **Missed jobs are refunded in full, including the bond.** A no-show can recover the bond after timeout. No Sybil resistance; testnet accounts are free. | Partial; accepted for testnet |
| S2 | **Deadline griefing / holdout.** A front job sets a deadline so tight that any displacement breaks it, or a high ask that makes the purchase infeasible. | Buyer cannot buy the front slot; urgent job may miss. | Quote checks every displaced deadline; `max_spend` caps the price; buyer can choose a later insertion. | No forced sale, no ask cap, no deadline-slack rule, no duration cap beyond local validation. A front job can hold out. | Accepted; documented |
| S3 | **Operator collusion / censorship.** Operator delays starts, favors a buyer, refuses to complete, or attests a hash for work not done. | Deadlines missed; buyer pays for a slot that does not deliver; work quality unverified. | `start_next` starts the head only; on-time payment requires completion; owner can cancel while queued; anyone can `claim_timeout`; demo auditor checks hash/time. | Operator is trusted for liveness and artifact attestation. No slashing, no multi-operator, no on-chain work verification. | Accepted; trusted-operator design |
| S4 | **Fake completion / artifact quality.** Operator submits a hash for an unrelated or low-quality artifact. | Owner pays reward for useless output; on-chain hash looks valid. | Local worker computes from input; auditor checks SHA-256 and deadline; artifact Markdown is shown. | On-chain, the hash is an attestation, not a proof of quality. Deterministic extraction can be wrong if the input is misleading. | Partial; local verification only |
| S5 | **Reentrancy on withdrawal.** A contract recipient re-enters `withdraw_credit` before the first transfer settles. | Double withdrawal; credit drain. | Pull payments; credit removed before scheduling transfer; no callback method; no cross-contract call. | The test `test_withdraw_credit_zeroes_first_and_prevents_double_spend` passes. Keep the ordering if the code changes. | Implemented; tested |
| S6 | **Integer overflow.** `ask * duration`, compensation sums, or fee multiplication overflow `u128`. | Wrong payment; panic; locked funds. | `overflow-checks = true` in the release profile; checked `u128` helpers; local duration ≤120s; contract overflow test. | The test `test_overflow_guard_in_compensation` passes. Do not replace checked helpers with raw arithmetic. | Implemented; tested |
| S7 | **Pause abuse.** Owner pauses forever or pauses new work. | No new jobs or starts; an existing job can still be settled. | Owner-only pause; `cancel_job`, `complete_job`, `fail_job`, `claim_timeout`, and `withdraw_credit` remain available while paused. | New work can still be frozen indefinitely by a malicious owner. No multisig or timelock. Testnet only. | Implemented; tested |
| S8 | **Leaked operator key.** Attacker starts/completes/fails jobs. | Griefing; false completion; missed deadlines. | Operator can be rotated by owner; pause; operator cannot withdraw user credits. | Until rotation, the attacker can act as operator. Testnet keys only. | Admin control; accepted |
| S9 | **Key material in public metadata.** A deploy record or API response that carried a signing key would hand it to every reader. | Agent keys could sign submits/withdrawals. | The deploy script writes account IDs and public keys only; `/api/onchain` projects an allowlist; the secret scan runs in `npm run verify` and before the release archive is written. | `data/deploy.json`, `data/onchain-proof.json`, and `/api/onchain` contain zero `secretKey` fields. Keep the projection if the schema changes. | Controlled; checked on every release |
| S10 | **Ask manipulation / last-second raise.** Owner raises `ask_per_sec` after the buyer quotes. | Buyer overpays or transaction reverts. | Contract recomputes at execution; `max_spend` caps the total; UI defaults `max_spend` to the quote total. | A loose cap can overpay; a tight cap reverts. No ask-change delay or commit-reveal. | Partial |
| S11 | **Front-running / stale quote.** Another purchase changes the queue before the buyer's transaction lands. | Quote no longer holds; revert; different displacement set. | Contract recomputes; `latest_start_at` and `max_spend` reject a changed trade; UI re-quotes. | No privacy or MEV protection. Public testnet. | Accepted; testnet |
| S12 | **Local API exposure / CSRF.** Anyone who can reach 8789 can act as any demo agent, claim any credit, or run/reset the scenario. | Demo state tampering; false credits; griefing. | CORS allowlist; JSON body limit; rate limit; optional `x-operator-token`; read-only mode; default bind is `127.0.0.1`; Docker/compose opts in to `0.0.0.0`. | Auth is off by default even on localhost. CORS is not authorization. No CSRF token. Do not expose the port without a proxy, TLS, and a token. | Accepted; do not expose |
| S13 | **XSS / artifact injection.** Job input contains Markdown/HTML that executes in the console. | Session compromise; fake UI. | `react-markdown` without `rehype-raw` (raw HTML is not rendered); no `dangerouslySetInnerHTML`; input length limit; React escapes text. | Links and Markdown features should be tested; no CSP header in the local API; the console is a demo. | Partial; verify |
| S14 | **DoS via body, queue, or SSE.** Large body, queue spam, or many SSE clients exhaust the server. | API unavailable during the demo. | 256kb JSON limit; queue limit 64; 240 mutations/min/IP; SSE heartbeat 15s; single process. | GET endpoints are not rate-limited; SSE connections are not capped; SQLite is single-writer. Local only. | Partial |
| S15 | **Storage drain.** Job and priority records stay on chain forever. If the contract paid for them, anyone could submit and cancel 1-yocto jobs (or reorder their own zero-ask jobs for free) until the contract balance could no longer back its storage, and every write would then fail. | Contract-wide denial of service. | Callers pay for their own records. **Deployed v1:** `submit_job` charges a non-refundable `JOB_STORAGE_DEPOSIT` (0.0125 NEAR) on top of `reward + bond`; `request_priority` charges `0.003 + 0.003 × displaced` NEAR on top of `total`. Both methods measure `env::storage_usage()` and panic if the bytes written exceed the deposit. A purchase that displaces nobody is refused. Tests: `test_storage_deposit_is_required_and_not_escrow`, `test_priority_storage_deposit_covers_worst_case_accounts`. | **Partial; C1/C2 disclosed.** The deposit covers the common case but not every allowed record (see S15a). The root-state `queue` and `activity` vectors are capped (128 each) and still backed by the contract balance; that cost is bounded. | Partial; C1/C2 disclosed |
| S15a | **Storage-deposit shortfall (C1, C2).** C1: a 1-displaced purchase with 64-byte accounts writes 614 bytes against a 600-byte deposit, so a quote can be `feasible` while `request_priority` panics; 1/2/3 displaced need 651/932/1213 bytes. C2: the largest terminal job record is 1,264 map bytes against 1,250 paid, a ~0.00014 NEAR permanent subsidy per maximum-size job. | A valid purchase is unavailable; slow storage subsidy; not an immediate drain. | Measured with a mock-state harness; both are disclosed here and in `docs/SPEC.md`. The live wasm is unchanged by this release. | Use the current `get_storage_deposits` values and avoid 64-byte account IDs for small displacements until a deposit fix ships. Do not call the issue fixed on the live contract. | Partial; disclosed |
| S16 | **Third-party priority griefing.** `request_priority` accepted any caller, so a stranger could flip `expedited` on someone else's job (free when the jobs ahead ask 0) and make that owner's cancellation forfeit 100% of the bond instead of 25%. | Victim loses 75% of the bond. | `request_priority` requires `predecessor == job.owner`. Test: `test_only_owner_can_buy_priority`. | – | Resolved |
| S16a | **Failed native payout (C3).** A direct transfer to a deleted or rejecting account fails after state is committed: the job is terminal, the credit is zero, and the returned funds sit in the contract without automatically restoring the recipient's claim. | Recipient loses the payout path until manual intervention; events can imply a completed withdrawal before the receipt settles. | State-before-transfer ordering; pull-payment credits; no callback method today. | **Not fully resolved.** A production version needs a private payout callback that restores the credit on failure, plus receipt-level tests. Testnet only. | Partial; disclosed |
| S16b | **Time boundary / rounding.** Off-by-one at the deadline; fee dust; display truncation. | Wrong on-time/missed classification; tiny accounting differences. | Integer yocto; inclusive comparisons (`<=`); fee floor; parity tests. | Contract uses seconds, app uses milliseconds. Test exact boundaries. UI shows up to eight decimals; exact yocto stays in state. | Partial; test required |
| S17 | **Testnet RPC / proof integrity.** RPC outage or a stale proof file makes the demo look on-chain when it is not. | False claim; judge cannot verify. | `/api/onchain` reads public proof files; if absent, returns `deployed: false`; proof script writes only after checks pass. | A committed proof can become stale; it is not re-verified on page load. No mainnet. | Partial; disclose |
| S18 | **Supply chain.** Malicious or vulnerable npm/cargo dependency. | Code execution; data loss. | Lockfiles; CI; no secrets in the repo; limited dependencies. | No `npm audit`/`cargo audit` gate; no reproducible-build verification. | Accepted; testnet |
| S19 | **SQLite tampering / corruption.** Local snapshot edited or corrupted. | False state; demo failure. | Single-writer WAL; JSON snapshot; reset and reseed. | No encryption, no authentication, no backup. Local only. | Accepted |
| S20 | **No timeout incentive.** Nobody calls `claim_timeout` for an overdue job. | Job sits; owner waits. | Anyone can call; demo operator/auditor does. | No keeper bounty; a rational third party may not pay gas. | Accepted; documented |

## 4. Controls implemented in this repository

### 4.1 Scheduler and money (`packages/core`)

- **Exact integer money.** `formatNear`/`parseNear` use `bigint`; no floats in money paths. `bpsOf` uses integer division (fee floor).
- **Deadline safety.** `quotePriority` rejects any displacement whose `newFinishAt > deadlineAt`; it also checks the urgent job's own deadline.
- **Latest feasible insertion.** The quote iterates from the urgent job's position down and picks the largest eligible index.
- **Compensation exactness.** `askPerSecYocto * urgent.durationSec` with `bigint`; the displaced list carries the exact amount and slack.
- **Invariant checks surfaced to the UI.** `checks[]` includes cutoff, own deadline, displaced deadlines, and compensation explicitness.
- **Tests.** `packages/core/test/scheduler.test.ts` covers FIFO projection, running-job blocking, no-op quote, latest index, exact compensation, deadline protection, infeasible cutoff, own-deadline rejection, running-job start, reorder, and money parsing/formatting.

### 4.2 Local server (`apps/server`)

- **Validation.** Zod schemas for job creation, priority purchase, and ask changes; explicit limits in `packages/ledger/src/limits.ts`.
- **Status and ownership checks.** The engine rejects non-queued jobs, a busy worker, an empty queue, unknown agents, and non-positive withdrawals. Local role checks are demo-level, not authentication.
- **Budget check.** `buyPriority` rejects `maxSpend < total` with `402 BUDGET_TOO_LOW` before mutating state.
- **Atomic mutation.** The engine applies the reorder, credits, stats, and ledger events in one synchronous method; a thrown error leaves the prior state.
- **Cancellation rules.** `expedited ? 0 : 75%` bond refund; the remainder is the bond fee. The reward is refunded.
- **Credits.** `withdraw` zeroes the credit before returning; a second withdrawal fails with `NO_CREDIT`.
- **Persistence.** SQLite snapshot with WAL; reset clears timers and reseeds. Recovery logs a running job on restart.
- **HTTP hardening.** `x-powered-by` disabled; `x-content-type-options: nosniff`; `x-frame-options: DENY`; `referrer-policy: no-referrer`; `permissions-policy`; CORS allowlist; 256kb JSON limit; 240 mutations/min/IP; optional `x-operator-token`; `QUEUE_READ_ONLY`.
- **Error handling.** Zod and engine errors return structured JSON; unknown errors return a generic 500 without a stack trace; request IDs are returned.
- **Tests.** `apps/server/test/engine.test.ts` and `apps/server/test/api.test.ts` cover seed, validation, four-credit purchase, budget rejection, cancellation, real artifact, single withdrawal, persistence, health/state, invalid job, quote/buy/withdraw, not-deployed proof, metrics, and JSON 404.

### 4.3 Web console (`apps/web`)

- **No invented live data.** The console reads the server snapshot; when the API is offline it shows "API not running" and the exact start command, not a fake queue.
- **Local labeling.** The nav, hero, credits, and ledger distinguish "Local ledger" from "NEAR testnet".
- **Server is the source of truth.** Actions refresh from the API; the UI does not optimistically mutate the queue.
- **Markdown rendering.** `react-markdown` with `remark-gfm`, no `rehype-raw`, no `dangerouslySetInnerHTML`. Raw HTML in an artifact is not rendered as HTML.
- **Accessibility.** Buttons have labels, forms have labels, errors use `role="alert"`, focus styles and reduced-motion handling are in the stylesheet.

### 4.4 Contract (`contracts/queue`) — implemented, testnet, not audited

The contract is the on-chain settlement layer. It is live at `market.queue-demo.testnet`. The following controls are implemented and covered by the 37-test suite:

- **Account-based access control.** Owner-only `set_operator`, `set_treasury`, `set_fee_bps`, `set_paused`; operator-only `start_next`, `complete_job`, `fail_job`; owner-only `cancel_job`, `set_move_ask`, `request_priority`; self-only `withdraw_credit`.
- **FIFO start.** `start_next` starts the head; it does not accept an arbitrary job ID.
- **Deadline checks.** The quote recomputes and rejects any purchase that breaks a displaced deadline or the urgent deadline.
- **Budget and deposit checks.** `total <= max_spend`; `deposit >= total`; excess is credited to the requester for withdrawal. Only the job owner may buy, and the non-refundable storage deposit is required on top of `total`.
- **Pull payments.** Displaced owners have credits; `withdraw_credit` removes the credit before scheduling the transfer.
- **Checked arithmetic.** `overflow-checks = true` in the release profile; checked `u128` helpers; overflow test present.
- **No built-in upgrade API — but FullAccess can redeploy.** There is no `upgrade` or `migrate` method in the Rust interface, so a bug fix requires redeploying the wasm. The deployed account retains a **FullAccess** key: it can replace the wasm (state is preserved; a layout change needs a migration) and can move the account balance independently of the contract's Rust access control. There is no multisig or timelock. Testnet only.
- **Pause.** Pause blocks new obligations (`submit_job`, `request_priority`, `set_move_ask`, `start_next`) but keeps exits open (`cancel_job`, `complete_job`, `fail_job`, `claim_timeout`, `withdraw_credit`). A malicious owner can still freeze new work; there is no multisig or timelock.
- **Storage.** Callers pay a non-refundable storage deposit on top of escrow and priority totals; storage is **not** paid from job escrow. The deployed values are 0.0125 NEAR per job and 0.003 + 0.003 × displaced NEAR per purchase; read `get_storage_deposits` rather than hard-coding them. The contract balance only backs the capped root vectors (`queue`, `activity`); it is not a general subsidy. The deploy script funds the account for that bounded cost and there is no automatic top-up. C1/C2 are disclosed in S15a.

The contract suite covers submit/escrow, FIFO, quote no-op, displacement/compensation, deadline protection, budget rejection, infeasible latest start, reorder/credits/refund, expedited cancellation, normal cancellation, start/complete, late refund, timeout, pause, access control, overflow, solvency, and double-withdrawal. It is still **not audited**.

### 4.5 Contract v3 (`contracts/queue-v3`) — implemented, testnet, not audited

Live at `market5.queue-demo.testnet` (rules and on-chain proof: [`V3.md`](V3.md)). It keeps the v2 controls and changes these threats:

| Threat | v3 control | Residual |
| --- | --- | --- |
| S3 operator delays or censors | **Stake and liability.** A job that was on schedule when admitted (or after its own purchase) and then misses or fails is paid its priority spend plus its reward from the operator's stake. No new submission or purchase is accepted while the stake is below the minimum or the operator has been silent for 180 s. Refusing a queued job (`reject_job`) returns its escrow and, from the stake, its priority spend. | The penalty is capped by the stake. The operator can still choose which promises to break if it accepts paying for them. |
| S4 fake completion | **Model jobs settle only with the model's verified signature** (`complete_job` refuses them). Operator-verified jobs are chosen by the submitter. | The pinned key's TEE origin is checked off chain before pinning. Operator-verified jobs still trust the operator's artifact. |
| S7 / admin key | **24 h timelock** on operator, treasury, fee, minimum stake, model key and code upgrades (`propose` → `execute_proposal` / `execute_upgrade`, anyone executes, owner can cancel). Pause stays immediate and only stops new work. A new operator does not inherit the old operator's stake (it is returned to the old operator), and the operator cannot be replaced while a job is queued or running. | The timelock covers the contract's methods only. The contract account still holds a test FullAccess key; its holder can redeploy the code directly, outside the timelock, and the current build was installed that way. Removing the key is irreversible and has not been done. |
| S8 leaked operator key | Unstaking waits 24 h, pays only the operator account, and is refused while any job is queued or running. | An attacker with the key can fail jobs; the penalties go to the users, from the operator's stake. |
| Stake extraction through a refusal | A buyer could pass its own second job, have the buying job refused, keep the compensation and get the price back from the stake. **Only accounts the operator approved can submit** wherever a stake backs the queue (`allow_clients`); a stranger is refused before escrow, storage or a purchase. | Two approved accounts acting together can still do it; the operator chooses and removes its clients. Compensation is capped by what is left of the stake, which is a floor (0.5 NEAR), not a reserve per job. |
| S10 last-second raise | **Ask raises take effect 30 s later**; cuts are immediate; quotes use the ask in force. | A slot holder who expects demand can still raise early. |
| S15 / S15a storage | Deposits are measured as in v2 (1,700 bytes per job, 600 + 300 per displaced job) and **refunded whole** by `release_job`: the deposits are credited to the owner (the owner any time, anyone after 7 days), less only the bytes that stay in the contract. The one-time "request answered" marker stays, so a signed answer can never settle a second job. | Kept back: the marker's bytes (about 0.001 NEAR, model-settled jobs only) and any balance key the job or its purchase had to create. The activity log is a fixed ring of 128 entries paid for by the contract account, not by jobs. |

New surfaces v3 adds, and why they are safe:

- **Penalty farming.** An agent can submit jobs that are on schedule and hope the operator falls behind; that is the liability working as intended. The operator's defences are to keep to the schedule or to reject a job before it starts (which costs it only the job's priority spend).
- **A late job passed again.** A job already projected to miss cannot block a purchase. It was going to miss anyway; it is still paid its ask, and if it was promised the stake pays it.
- **Releases by strangers.** After 7 days anyone may release a finished record; the refund always goes to the job's owner.
- **Upgrades by anyone.** `execute_upgrade` deploys only code whose sha256 a proposal named and whose timelock has passed; the code is the call's input.
- **Unbounded proposals.** Only the owner can propose; each proposal is stored until executed or cancelled.

## 5. Test coverage

| Area | Evidence | Status |
| --- | --- | --- |
| Scheduler projection, quote, deadline safety, exact compensation | `packages/core/test/scheduler.test.ts` | Present |
| Engine seed, purchase, budget, cancel, artifact, withdraw, persistence | `apps/server/test/engine.test.ts` | Present |
| API health/state, validation, quote/buy/withdraw, proof, metrics, 404 | `apps/server/test/api.test.ts` | Present |
| Full local scenario | `npm run verify` (17s scenario, `audit.passed`) | Passes |
| Contract escrow, reorder, cancellation, timeout, pause, access, overflow | `contracts/queue` suite | **37 tests pass on this tree** |
| Real testnet proof | `data/onchain-proof.json` (`ok: true`, 27 txs, four displaced and paid, 7/7 on time, four withdrawals, one refusal) | Present; `npm run verify:onchain` re-checks it against the live chain |
| TypeScript/Rust parity (v2) | Differential test: seeded random histories recorded from the TypeScript rules are replayed against the contract, comparing every quote, refusal, queue order, balance and job status (`npm run test:parity`) | Present: 20 histories, 1,284 steps, all agree; a 300-history run (24,866 steps) agrees too |
| Web accessibility/responsive | Playwright checks at 1440×900 and 390×844; no horizontal overflow; web test script | Passes; manual re-check before recording |
| Secret scan | `data/deploy.json`, `data/onchain-proof.json`, `/api/onchain`; release archive scan in `scripts/package.sh` | **PASS on the public JSON; zero `secretKey` fields** |
| Invariant testing (v2) | Property-based test (`proptest`): random histories of valid actions; after every step escrow and credits match the open jobs and balances, the contract never owes more than it received, no purchase makes a job that was on time late, payments equal the quote, and every quote matches the rule worked out independently from the public queue | Present: 48 histories per `cargo test`; a 600-history run passes |
| Mutation testing (v2) | `cargo-mutants` on the contract's money, deadline and queue functions | 92 of 95 viable mutants caught; the 3 survivors are equivalent. See [`docs/TESTING.md`](TESTING.md) |
| Planted bugs (v2) | Eight rules broken one at a time in a temporary copy of the contract (`npm run test:planted-bugs`) | 8 of 8 caught by the unit tests, by the invariants and by the differential test, each on its own |
| Dependency advisories (v2) | `cargo audit` (RustSec) | One unmaintained crate in the wasm build (`wee_alloc`, via near-sdk's default features); two findings in test-only dependencies. See [`docs/TESTING.md`](TESTING.md) |
| Invariant testing and parity (v3) | The v2 invariants plus stake, rejection, release and liveness actions; stake accounting, refundable storage and exact penalties checked after every step. Simulator replay with `QUEUE_SIM_RULES=v3` (`npm run test:parity-v3`) | Present: 48 histories per `cargo test`; 30 histories, 2,224 steps agree |
| Coverage-guided fuzzing, formal verification, sandbox (near-workspaces) tests | None | **Not present** |
| External audit | None | **Not audited** |

Current counts on this tree: **13 core, 8 ledger, 34 server, 9 web, 8 client, 17 season** tests pass; **37 v1, 62 v2 and 95 v3 contract tests** pass. Run `npm run verify` on the submission commit for the authoritative output.

## 6. Audit status

QUEUE is **not audited**.

- No third-party security review.
- No formal verification.
- No coverage-guided fuzzing campaign (the random-history invariant tests are in [`docs/TESTING.md`](TESTING.md)).
- No bug bounty.
- No mainnet deployment.

What a production version would need before handling real value:

1. An external audit of the Rust contract, including storage accounting, reentrancy, overflow, access control, and pause semantics.
2. Invariant/fuzz tests for conservation, deadline safety, and double-settlement.
3. A storage-deposit design that covers C1/C2 for every allowed record and does not silently reduce escrow; a private payout callback for C3.
4. Operator accountability beyond v3's stake: multiple attestors or a verifiable compute path for non-model work.
5. Sybil resistance and anti-spam pricing; a bond that is actually forfeited on no-show.
6. A multisig owner on top of v3's timelock, the FullAccess key removed, key rotation and incident response.
7. Monitoring, alerting, and a published incident process.
8. Legal/compliance review for custody, fees, and any real-world use.

Until then: **testnet only, demo value only, no production custody.**

## 7. Key management

- `.env` and `.testnet/` are git-ignored. The deploy script writes `.env` with mode `600` and `.testnet/` with mode `700`.
- `data/deploy.json` is public metadata only: account IDs, public keys, wasm hash, deploy tx. It contains no secret keys.
- Never commit a private key, seed phrase, or live RPC credential. The public proof file `data/onchain-proof.json` contains no keys.
- `QUEUE_OPERATOR_TOKEN` is an API demo token, not a NEAR key. It is optional; set it when the API is reachable by anyone else.
- The operator key can start/complete/fail jobs. The treasury key can move fees. The owner key can reconfigure and pause. The contract account also has a **FullAccess** key that can redeploy the wasm and move the account balance; treat it as the highest-value testnet secret. Keep the roles separate.
- If a key leaks: pause the contract if possible, rotate the operator/treasury, stop the API, and redeploy the testnet contract. Testnet funds are not valuable, but the demo can be griefed.
- CI does not receive secrets. Do not add deploy keys to GitHub Actions for the hackathon build.

## 8. Secure demo checklist

Before recording or hosting:

- [ ] `QUEUE_HOST=127.0.0.1` unless you deliberately need remote access.
- [ ] `QUEUE_OPERATOR_TOKEN` set if the API is reachable by anyone else.
- [ ] `QUEUE_READ_ONLY=1` for a public read-only demo.
- [ ] No `.env`, `.testnet/`, `data/queue.db*`, or private keys in `git status`.
- [ ] `data/deploy.json` has no `secretKey` fields (verified: zero).
- [ ] `/api/onchain` returns only public fields (scoped scan of the proof/deploy JSON; `scripts/package.sh` also scans the release archive for key material).
- [ ] The browser network tab shows no key material when the Proof section loads.
- [ ] `npm run verify` passes; contract tests pass; wasm builds.
- [ ] The UI says "Local ledger" for local rows and "NEAR testnet" only with real proof.
- [ ] No contract ID or tx hash is typed by hand; it comes from `data/deploy.json` / `data/onchain-proof.json`.
- [ ] The demo does not claim audit, mainnet, NEAR Intents, real users, or revenue.
- [ ] If hosted, put a reverse proxy with TLS and auth in front; do not expose the operator endpoints.

## 9. Reporting a vulnerability

This is a hackathon testnet project with no bug bounty. If you find a security issue, open a private security advisory on the public repository (GitHub Security tab) or contact the team lead through the contact listed in the submission. Do not post exploitable details publicly before the judging window. There is no mainnet deployment and no real funds at risk, but the demo and testnet accounts can still be disrupted.
